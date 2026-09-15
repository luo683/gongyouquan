#!/bin/sh
# 容器健康检查 —— 巡检项 20（备份新鲜度）在这个栈里的落点。
#
# 为什么还要有这个：notify-alert.sh 现在存在了，备份失败会进 #运维告警群——但那条
# 链路本身也会坏。缺 ALERT_HMAC_SECRET、签名的密钥与 server 不一致、API 正在重启、
# SYSTEM_GROUP_ID 没配（503）——这些情况下**没有任何东西会说话**，而容器看起来一切
# 正常。healthcheck 就是这一格的兜底：它不看告警发没发出去，只看有没有一份成功的
# 备份。一个每天 03:00 跑、失败了只往容器日志里写一行的服务，和「有备份」看起来
# 一模一样——这正是手册 8.1 巡检项 21 说的「虚假的安全感」。把它挂成 Docker 的
# healthcheck，`docker compose ps` 与任何看容器状态的东西就会显出红色。
#
# POSIX sh：镜像里现在有 bash（backup-once.sh 的 pipefail 需要），但一个探活脚本不
# 该假设基座镜像多给了什么，所以它只用 busybox 一定有的东西。
#
# 阈值与 backup-loop.sh 的补跑阈值同源（26 小时 = 93600 秒）。巡检项 20 是
# 26h 警告 / 50h 严重；这里取警告那一档作为「不健康」，因为不健康只是让人看见，
# 不触发任何自动处置。

set -eu

DIR="${BACKUP_DIR:-/backups}"
MAX_AGE="${BACKUP_MAX_AGE_SECONDS:-93600}"
MARKER="$DIR/last_success.json"

if [ ! -f "$MARKER" ]; then
  printf '没有任何成功备份：%s 不存在（首次备份还没跑完，或者每次都失败）\n' "$MARKER"
  exit 1
fi

AGE=$(( $(date +%s) - $(stat -c%Y "$MARKER") ))
# 把异地模式一起报出来。巡检项 20 只看新鲜度，而「异地=local-only」的备份在服务器
# 报废的那天等于没有备份——这正是本文件开头说的虚假的安全感。
# 不因为 local-only 就返回非 0：还没配 restic 的装机第一天会拿到一个永久红色的容器，
# 而一个总是红的灯没有人读。让它可见，不让它失败。
OFFSITE=$(sed -n 's/.*"offsite": *"\([^"]*\)".*/\1/p' "$MARKER" 2>/dev/null || true)
[ -n "$OFFSITE" ] || OFFSITE='?'
# 恢复时要用的就是这个 id。放进健康输出，是为了不必为了「最新那份是哪个快照」
# 再去 cat 一次标记文件。
SNAP=$(sed -n 's/.*"restic_snapshot": *"\([^"]*\)".*/\1/p' "$MARKER" 2>/dev/null || true)

if [ "$AGE" -gt "$MAX_AGE" ]; then
  printf '上次备份已是 %s 小时前，超过 %s 小时（异地=%s）\n' "$((AGE / 3600))" "$((MAX_AGE / 3600))" "$OFFSITE"
  exit 1
fi

if [ -n "$SNAP" ]; then
  printf 'ok：上次备份 %s 小时前，异地=%s 快照=%s\n' "$((AGE / 3600))" "$OFFSITE" "$SNAP"
else
  printf 'ok：上次备份 %s 小时前，异地=%s\n' "$((AGE / 3600))" "$OFFSITE"
fi
