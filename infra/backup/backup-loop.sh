#!/bin/sh
# backup 容器的 entrypoint —— 运维手册 3.2：「备份容器不是常驻服务，而是长期运行的
# 调度器 + 按需执行一次备份」。
#
# 用 supercronic 而不是宿主 cron，是为了让备份逻辑与它的依赖（pg_dump / restic 版本）
# 打包在一起，避免宿主升级 PG 客户端导致备份脚本行为漂移。
#
# **pg_dump 的大版本必须与服务器一致**，这是这个容器存在的主要理由：跨大版本的
# dump 可能生成得出来却恢复不回去，而这种失败只在真正需要恢复的那天暴露。

set -eu

CRONTAB="${CRONTAB_FILE:-/etc/crontab.ops}"
BACKUP_HOUR="${BACKUP_HOUR:-3}"
BACKUP_MINUTE="${BACKUP_MINUTE:-0}"
LOG_FILE="${LOG_FILE:-/var/log/backup.log}"

# 调度表由环境变量生成而不是写死在镜像里：改时间不该重新构建镜像。
# >> 追加而不是覆盖，日志轮转交给宿主（手册 1.2 把日志轮转划给 agent 的 L1）。
if [ ! -f "$CRONTAB" ]; then
  cat > "$CRONTAB" <<EOF
# 每日 ${BACKUP_HOUR}:$(printf '%02d' "$BACKUP_MINUTE") 备份数据库与上传文件。
# 手册 8.1 把两者排在 03:00 与 03:40 是为了避免同时跑重活；backup-once.sh 内部是
# 串行的（先 db 后 uploads），所以一个时间槽已经满足那条约束。
${BACKUP_MINUTE} ${BACKUP_HOUR} * * * /usr/local/bin/backup-once.sh >> ${LOG_FILE} 2>&1
EOF
fi

echo "[backup-loop] 调度表 $CRONTAB:" >&2
cat "$CRONTAB" >&2

# 启动时先自检一次工具链，而不是等到凌晨三点才发现 pg_dump 不在。
#
# 每个工具各自报版本，而不是一套 `$TOOL --version`：restic 没有 `--version` 这个
# 选项（它是 `restic version` 子命令），统一拼法会让这一行日志变成
# `restic: unknown flag: --version`——而这份日志正是「工具链到底在不在」的证据，
# 它不该长得像装坏了。
for TOOL in pg_dump pg_restore restic age; do
  case "$TOOL" in
    restic) VERSION_CMD='restic version' ;;
    *)      VERSION_CMD="$TOOL --version" ;;
  esac
  if command -v "$TOOL" > /dev/null 2>&1; then
    echo "[backup-loop] $TOOL: $($VERSION_CMD 2>&1 | head -1)" >&2
  else
    # restic 与 age 缺失只在未配置异地时才是致命的，backup-once.sh 会自己判断，
    # 所以这里只警告；pg_dump 缺失则直接失败，因为没有它这个容器毫无意义。
    case "$TOOL" in
      pg_dump | pg_restore)
        echo "[backup-loop] FATAL: 缺少 $TOOL" >&2
        exit 1
        ;;
      *) echo "[backup-loop] 警告: 缺少 $TOOL（未配置异地备份时可接受）" >&2 ;;
    esac
  fi
done

# 容器启动时若发现上次备份已超过 26 小时（巡检项 20 的阈值），立刻补跑一次。
# 理由：容器可能在 03:00 那一刻正好不在运行（重启、部署窗口），而「下一次备份」
# 要等到明天——那一整天的数据是没有任何副本的。
LAST_SUCCESS="${BACKUP_DIR:-/backups}/last_success.json"
if [ -f "$LAST_SUCCESS" ]; then
  AGE_SECONDS=$(( $(date +%s) - $(stat -c%Y "$LAST_SUCCESS" 2>/dev/null || stat -f%m "$LAST_SUCCESS") ))
  if [ "$AGE_SECONDS" -gt 93600 ]; then
    echo "[backup-loop] 上次备份已是 $((AGE_SECONDS / 3600)) 小时前（>26h），立即补跑" >&2
    /usr/local/bin/backup-once.sh >> "$LOG_FILE" 2>&1 || echo "[backup-loop] 补跑失败，见 $LOG_FILE" >&2
  fi
else
  echo "[backup-loop] 找不到 $LAST_SUCCESS，首次运行，立即备份一次" >&2
  /usr/local/bin/backup-once.sh >> "$LOG_FILE" 2>&1 || echo "[backup-loop] 首次备份失败，见 $LOG_FILE" >&2
fi

echo "[backup-loop] 交给 supercronic" >&2
exec supercronic "$CRONTAB"
