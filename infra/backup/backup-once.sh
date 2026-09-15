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
#
# 报告的是「停在哪一步」而不是 $BASH_COMMAND：后者是**展开后**的命令行，而这个脚本
# `export PGPASSWORD=...`，把一条会失败的赋值或回显发出去就等于把数据库口令贴进
# 一个 HTTP 请求体。步骤名是人写的，因此也是安全的。
STEP='启动'
notify_failure() {
  # 缺脚本 / 缺签名密钥时 notify-alert.sh 自己会打一行「跳过」再退 0，所以这里
  # 不需要再判断一遍；`|| true` 兜住的是它**发不出去**的那条路。
  [ -x /usr/local/bin/notify-alert.sh ] || return 0
  /usr/local/bin/notify-alert.sh backup critical "备份失败" "$TS" "$*" backup-failed || true
}
# 两条路都要走，因为它们的覆盖面不重叠：
#   - ERR trap 接住的是没被 `|| die` 挡住的失败（pg_dump、restic、age…）；
#   - die() 自己调用，因为 `exit` 不触发 ERR trap，而 `[ -f x ] || die` 这种
#     `||` 列表里 trap 也不触发。少了这一半，说得最清楚的那些失败反而是沉默的。
trap 'notify_failure "停在「$STEP」（第 $LINENO 行）"' ERR

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }
die() { log "FATAL: $*"; notify_failure "停在「$STEP」：$*"; exit 1; }

mkdir -p "$DIR"

# ── 1. 数据库。nice 让出 CPU：备份是「可以慢慢做」的活（手册 2.4）。──
STEP='第 1 步 pg_dump'
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
STEP='第 2 步 校验 dump'
log "校验 dump 可读性"
pg_restore --list "$DUMP" > /dev/null || die "dump 校验失败：$DUMP 不可读，视为备份失败"
TOC_ENTRIES=$(pg_restore --list "$DUMP" | grep -c '^[0-9]' || true)
[ "$TOC_ENTRIES" -gt 0 ] || die "dump 目录为空：$DUMP 里没有任何对象"

# ── 3. 秘密（加密后一起走）。理由见手册 4.3：没有 RESTIC_PASSWORD 就无法解密
#       任何异地备份，所以「加密备份密钥而不备份密钥本身」等于备份了一堆随机数据。──
STEP='第 3 步 age 加密 .env'
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
STEP='第 4 步 restic 上传'
OFFSITE="skipped"
RESTIC_SNAP=""
RESTIC_TIME=""
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  # 这个分支里**没有**退回本地的出口。原来 `command -v restic` 是 `if` 条件的一部分，
  # 所以「配了 RESTIC_REPOSITORY 但镜像里没有 restic」会一路掉进 ALLOW_LOCAL_ONLY，
  # 日志里只留一行警告。运维看到的配置是「异地已配」，实际副本只在这台机器上——
  # 这比从来没配过更危险，因为它看起来是覆盖了的。
  command -v restic > /dev/null 2>&1 \
    || die "配置了 RESTIC_REPOSITORY 但镜像里没有 restic —— 不会退回本地副本"
  : "${RESTIC_PASSWORD:?RESTIC_REPOSITORY 已设置但 RESTIC_PASSWORD 没有}"
  export RESTIC_PASSWORD

  # 不替你 `restic init`。对着一个拼错的路径 init 会**成功**，然后把每天的备份
  # 写进一个谁都不会去恢复的空目录，并且每天打一个绿色的勾。init 是人的决定。
  # （实测未 init 时 restic 自己以 10 退出，消息是 "Is the repository located at
  #   ...?" —— 没有这一行的话，那 10 就是运维能拿到的全部信息。）
  restic cat config > /dev/null 2>&1 \
    || die "restic 仓库不存在或未初始化：$RESTIC_REPOSITORY —— 核对路径与凭据后手动执行 restic init"

  log "restic 上传"
  # --json 最后那条 summary 带 snapshot_id。取它不是为了好看：下面要用它反查仓库，
  # 确认「restic 退出 0」真的等价于「异地存在一个可列出的快照」。
  RESTIC_SNAP=$(restic backup --json --tag db "$DUMP" "$GLOBALS" \
    | sed -n 's/.*"snapshot_id": *"\([0-9a-f]*\)".*/\1/p' | tail -1)
  [ -n "$RESTIC_SNAP" ] || die "restic 没有回报 db 快照的 id，无法确认异地副本存在"
  restic snapshots "$RESTIC_SNAP" > /dev/null 2>&1 \
    || die "restic 回报了快照 $RESTIC_SNAP，但仓库里查不到它"
  RESTIC_TIME=$(restic snapshots --latest 1 --json --tag db \
    | sed -n 's/.*"time": *"\([^"]*\)".*/\1/p' | head -1)

  if [ -n "$ENV_BACKUP" ]; then
    restic backup --tag secrets "$ENV_BACKUP" > /dev/null
  else
    # 手册 4.3 的理由：RESTIC_PASSWORD 丢了，所有异地备份永久无法解密。所以「数据
    # 传上去了、密钥没传」是一个必须说话的状态，不是可选优化。
    log "警告：本次没有 .env 密文可上传，异地只有数据没有密钥（缺 age 或 recipient 公钥）"
  fi

  # 附件卷没挂上时，备份仍然会「成功」，而附件从不在任何一份副本里。
  [ -d "$UPLOADS_DIR" ] || die "UPLOADS_DIR=$UPLOADS_DIR 不存在 —— 附件卷没有挂上，不会当成备份成功"
  restic backup --tag uploads "$UPLOADS_DIR" > /dev/null
  # caddy 是这条栈里唯一真正可选的一项：现在根本没有 caddy 服务，所以目录不存在
  # 是预期状态而不是配置错误。用 if 而不是 `&&`，是为了不让「这里到底会不会让
  # 脚本退出」取决于 set -e 对短路 AND 列表的例外规则。
  if [ -d /caddy-data ]; then
    restic backup --tag caddy /caddy-data > /dev/null
  fi

  # ★ `--group-by tag` 是这条命令唯一正确的分组方式。restic 默认按 host,paths 分组，
  #   而 dump 的文件名里带时间戳，于是每晚的快照**各成一组、每组只有它自己**，
  #   「keep 7 daily」一个都删不掉，仓库无限增长。实测：同一仓库同一策略
  #   （--tag db --keep-daily 1）不加 --group-by 时保留 2 个、删 0 个，加上才删 1 个。
  #   手册 8.2 那一行缺这个参数，所以照抄它的脚本永远不会真正回收空间。
  # 保留分两档，因为手册 8.1 与 8.2/6.12 给的数字互相矛盾，见 docs/decisions/0014。
  restic forget --tag db      --group-by tag --keep-daily 14 --keep-weekly 8  --keep-monthly 6 > /dev/null
  restic forget --tag secrets --group-by tag --keep-daily 14 --keep-weekly 8  --keep-monthly 6 > /dev/null
  restic forget --tag uploads --group-by tag --keep-daily 7  --keep-weekly 4  --keep-monthly 6 > /dev/null
  restic forget --tag caddy   --group-by tag --keep-daily 7  --keep-weekly 4  --keep-monthly 6 > /dev/null
  restic prune
  OFFSITE="restic"
elif [ "${ALLOW_LOCAL_ONLY:-0}" = "1" ]; then
  log "警告：未配置 restic，ALLOW_LOCAL_ONLY=1 —— 本次只有本地副本，服务器报废即丢失"
  OFFSITE="local-only"
else
  die "未配置 RESTIC_REPOSITORY。本地副本不是备份策略；确认要只留本地请显式设 ALLOW_LOCAL_ONLY=1"
fi

# ── 5. 成功标志。巡检项 20 读这个文件的 mtime，项 21 读它指向的 dump。──
STEP='第 5 步 写成功标志'
cat > "$DIR/last_success.json" <<EOF
{
  "ts": "$(date -Iseconds)",
  "dump": "$(basename "$DUMP")",
  "globals": "$(basename "$GLOBALS")",
  "db_bytes": $(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP"),
  "toc_entries": $TOC_ENTRIES,
  "offsite": "$OFFSITE",
  "restic_snapshot": "$RESTIC_SNAP",
  "restic_time": "$RESTIC_TIME",
  "env_backed_up": $([ -n "$ENV_BACKUP" ] && echo true || echo false),
  "pg_version": "$(pg_dump --version | head -1)"
}
EOF
log "写入 $DIR/last_success.json"

# ── 6. 清理本地暂存（异地已有副本；本地只留 3 天）──
STEP='第 6 步 清理本地暂存'
find "$DIR" -name 'db_*.dump'       -mtime +"$LOCAL_RETENTION_DAYS" -delete
find "$DIR" -name 'globals_*.sql.gz' -mtime +"$LOCAL_RETENTION_DAYS" -delete
find "$DIR" -name 'env-backup.age'   -mtime +"$LOCAL_RETENTION_DAYS" -delete

log "备份完成：$DUMP（$TOC_ENTRIES 个对象，异地=$OFFSITE）"
