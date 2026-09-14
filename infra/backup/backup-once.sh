#!/usr/bin/env bash
# 工友圈 备份 —— 运维手册 8.2 的实现。
#
# 在 backup 容器内执行，也可被 opsctl backup-run 触发重跑。
#
# 这个脚本的核心不是「生成一个文件」，而是**证明这个文件能用**。第 2 步的
# `pg_restore --list` 是分界线：pg_dump 成功退出只说明写出了一个文件，磁盘满、
# 写入中断、连接被切断都可能产出一个语法上存在但内容截断的 dump。巡检项 21 的
# 原话是「文件坏了比没备份更危险——它带来虚假的安全感」。
#
# 同理，异地上传未配置时**不会静默跳过**。只有显式设置 ALLOW_LOCAL_ONLY=1
# 才允许只留本地副本，而且会往 stderr 打一行警告。一个只会写本地的备份脚本，
# 在服务器报废的那天等于没有备份。

set -euo pipefail

TS=$(date +%Y%m%dT%H%M%S)
DIR="${BACKUP_DIR:-/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"
ENV_FILE="${ENV_FILE:-/opt/chat/.env}"
AGE_RECIPIENT_FILE="${AGE_RECIPIENT_FILE:-/etc/age/recipient.pub}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-3}"

# 失败时通知（走同一个告警入口）。|| true 是因为通知本身失败不该掩盖原始错误。
if [ -x /usr/local/bin/notify-alert.sh ]; then
  trap '/usr/local/bin/notify-alert.sh backup critical "备份失败" "$TS" || true' ERR
fi

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

mkdir -p "$DIR"

# ── 1. 数据库。nice 让出 CPU：备份是「可以慢慢做」的活（手册 2.4）。──
: "${PG_HOST:?PG_HOST 未设置}"
: "${POSTGRES_USER:?POSTGRES_USER 未设置}"
: "${POSTGRES_DB:?POSTGRES_DB 未设置}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD 未设置}"
export PGPASSWORD="$POSTGRES_PASSWORD"

DUMP="$DIR/db_${TS}.dump"
GLOBALS="$DIR/globals_${TS}.sql.gz"

log "pg_dump -> $DUMP"
nice -n 19 pg_dump -h "$PG_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -Z6 -f "$DUMP"

log "pg_dumpall --globals-only -> $GLOBALS"
pg_dumpall -h "$PG_HOST" -U "$POSTGRES_USER" --globals-only | gzip > "$GLOBALS"

# ── 2. ★ 校验：备份必须能列出目录才算成功（只生成文件不算）──
log "校验 dump 可读性"
pg_restore --list "$DUMP" > /dev/null || die "dump 校验失败：$DUMP 不可读，视为备份失败"
TOC_ENTRIES=$(pg_restore --list "$DUMP" | grep -c '^[0-9]' || true)
[ "$TOC_ENTRIES" -gt 0 ] || die "dump 目录为空：$DUMP 里没有任何对象"

# ── 3. 秘密（加密后一起走）。理由见手册 4.3：没有 RESTIC_PASSWORD 就无法解密
#       任何异地备份，所以「加密备份密钥而不备份密钥本身」等于备份了一堆随机数据。──
ENV_BACKUP=""
if [ -f "$ENV_FILE" ]; then
  if [ -f "$AGE_RECIPIENT_FILE" ] && command -v age >/dev/null 2>&1; then
    ENV_BACKUP="$DIR/env-backup.age"
    log "age 加密 .env -> $ENV_BACKUP"
    age -r "$(cat "$AGE_RECIPIENT_FILE")" -o "$ENV_BACKUP" "$ENV_FILE"
  else
    # 不加密就绝不落盘：一个明文的 .env 躺在备份目录里，比没有备份更糟，
    # 因为它把「服务器被入侵」扩大成「所有异地副本都含明文密钥」。
    log "警告：找不到 age 或 recipient 公钥，跳过 .env 备份（不会明文落盘）"
  fi
else
  log "警告：$ENV_FILE 不存在，跳过 .env 备份"
fi

# ── 4. 上传异地 ──
OFFSITE="skipped"
if [ -n "${RESTIC_REPOSITORY:-}" ] && command -v restic >/dev/null 2>&1; then
  : "${RESTIC_PASSWORD:?RESTIC_REPOSITORY 已设置但 RESTIC_PASSWORD 没有}"
  export RESTIC_PASSWORD
  log "restic 上传"
  restic backup --tag db      "$DUMP" "$GLOBALS"
  [ -n "$ENV_BACKUP" ] && restic backup --tag secrets "$ENV_BACKUP"
  [ -d "$UPLOADS_DIR" ] && restic backup --tag uploads "$UPLOADS_DIR"
  [ -d /caddy-data ]    && restic backup --tag caddy   /caddy-data
  restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
  OFFSITE="restic"
elif [ "${ALLOW_LOCAL_ONLY:-0}" = "1" ]; then
  log "警告：未配置 restic，ALLOW_LOCAL_ONLY=1 —— 本次只有本地副本，服务器报废即丢失"
  OFFSITE="local-only"
else
  die "未配置 RESTIC_REPOSITORY。本地副本不是备份策略；确认要只留本地请显式设 ALLOW_LOCAL_ONLY=1"
fi

# ── 5. 成功标志。巡检项 20 读这个文件的 mtime，项 21 读它指向的 dump。──
cat > "$DIR/last_success.json" <<EOF
{
  "ts": "$(date -Iseconds)",
  "dump": "$(basename "$DUMP")",
  "globals": "$(basename "$GLOBALS")",
  "db_bytes": $(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP"),
  "toc_entries": $TOC_ENTRIES,
  "offsite": "$OFFSITE",
  "env_backed_up": $([ -n "$ENV_BACKUP" ] && echo true || echo false),
  "pg_version": "$(pg_dump --version | head -1)"
}
EOF
log "写入 $DIR/last_success.json"

# ── 6. 清理本地暂存（异地已有副本；本地只留 3 天）──
find "$DIR" -name 'db_*.dump'       -mtime +"$LOCAL_RETENTION_DAYS" -delete
find "$DIR" -name 'globals_*.sql.gz' -mtime +"$LOCAL_RETENTION_DAYS" -delete
find "$DIR" -name 'env-backup.age'   -mtime +"$LOCAL_RETENTION_DAYS" -delete

log "备份完成：$DUMP（$TOC_ENTRIES 个对象，异地=$OFFSITE）"
