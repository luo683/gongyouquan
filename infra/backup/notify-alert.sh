#!/usr/bin/env bash
# 工友圈 备份 —— 手册 8.2 第 4 步：失败要说话，而且是说到人看的地方。
#
# backup-once.sh 的 ERR trap 调的就是这个脚本（在它是新镜像之前，那个路径在容器里
# 并不存在，所以「备份失败」唯一的可见落点是 healthcheck 变红）。
#
# 一条铁律：**通知不能反过来搞坏被通知的那件事**。调用点是
# `notify-alert.sh ... || true`，本脚本自己也不设 `set -e`——一个要报告故障的
# 脚本中途被自己的故障打死，是这条链路上最坏的结果。退出码只用于「人来看」：
# 配置缺失而跳过时退 0（没发生任何失败），真的发不出去时退 1。
#
# 用法：
#   notify-alert.sh <source> <severity> <title> <idempotency-key> [detail] [fingerprint]
#
# 环境变量：
#   ALERT_URL         默认 http://server:3000/api/v1/hooks/alert
#   ALERT_HMAC_SECRET 与 server 端同一个密钥；空则跳过（签不了名，发出去也是 401）
#   ALERT_TIMEOUT     单次请求的读超时秒数，默认 10

: "${ALERT_URL:=http://server:3000/api/v1/hooks/alert}"
: "${ALERT_TIMEOUT:=10}"

log() { printf '[%s] notify-alert: %s\n' "$(date -Iseconds)" "$*" >&2; }

SOURCE="${1:-}"
SEVERITY="${2:-}"
TITLE="${3:-}"
KEY="${4:-}"
DETAIL="${5:-}"
FINGERPRINT="${6:-}"

if [ -z "$SOURCE" ] || [ -z "$SEVERITY" ] || [ -z "$TITLE" ] || [ -z "$KEY" ]; then
  # Usage error, not a delivery failure: the caller's bug must not look like an
  # outage in the log someone reads at 03:00.
  log "用法：notify-alert.sh <source> <severity> <title> <idempotency-key> [detail] [fingerprint] —— 跳过"
  exit 0
fi

if [ -z "${ALERT_HMAC_SECRET:-}" ]; then
  log "ALERT_HMAC_SECRET 未设置，无法签名，跳过（告警不会送达）"
  exit 0
fi
if ! command -v openssl > /dev/null 2>&1; then
  # The base image has no openssl binary; the Dockerfile installs it for exactly
  # this. If it ever goes missing, saying so beats a silent, unsigned 401 forever.
  log "镜像里没有 openssl，无法签名，跳过（告警不会送达）"
  exit 0
fi

# 契约把 title 限成单行（说明书 4.3.4 之外，它还是聚合键的一半），所以这里把换行
# 压成空格而不是转义：转义后的 JSON 合法，解出来却带 \n，会被服务端判成非法请求。
one_line() {
  local s=${1-}
  s=${s//$'\r'/ }
  printf '%s' "${s//$'\n'/ }"
}

# JSON 字符串转义。顺序是有意的：反斜杠必须第一个换，否则后面每次替换插入的 `\`
# 又会被再转一遍。控制字符用 tr 先删掉——它们没法安全转义（\u0000 在 JSON 里就不是
# 一个合法字符），而一条日志里的 NUL 不该变成「告警发不出去」。
json_escape() {
  local s
  s=$(printf '%s' "${1-}" | tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

TS=$(date +%s)
TITLE_JSON=$(one_line "$TITLE")
DETAIL_JSON=$(json_escape "$DETAIL")
KEY_JSON=$(json_escape "$KEY")
SOURCE_JSON=$(json_escape "$SOURCE")
FP_JSON=$(json_escape "$FINGERPRINT")

# 字段各归各，逗号由 IFS 负责。手写模板在这里翻过车：fingerprint 一给就拼出
# `...,,"fingerprint":"x""detail":...`（title 后面那个逗号与 FP_FIELD 自带的逗号撞成
# 两个，而它自己结尾又少一个）。可选字段以后只会越来越多，这里不该再考验人的眼神。
fields="\"source\":\"$SOURCE_JSON\""
fields="$fields,\"severity\":\"$SEVERITY\""
fields="$fields,\"title\":\"$TITLE_JSON\""
fields="$fields,\"detail\":\"$DETAIL_JSON\""
fields="$fields,\"idempotencyKey\":\"$KEY_JSON\""
if [ -n "$FP_JSON" ]; then
  fields="$fields,\"fingerprint\":\"$FP_JSON\""
fi
BODY="{$fields}"

# Body 只构造一次，签名与发送用的是**同一串字节**：这里多一次 printf 或少一个换行，
# 结果就是一次永远对不上的 HMAC，而这种 bug 只会在第一次真故障那天出现。
SIGNATURE=$(printf '%s\n%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$ALERT_HMAC_SECRET" -hex | awk '{print $NF}')

# 两次尝试用**同一份字节**（同一个 key、同一个时间戳、同一个签名）。这正是允许重试的
# 理由：服务端认 idempotencyKey，所以第二次要么落进同一行计数，要么被判为重放，
# 无论哪种都不会在群里出现两条「备份失败」。换 key 重试才会造成重复告警。
attempt() {
  wget -q -T "$ALERT_TIMEOUT" -t 1 -O - \
    --header "content-type: application/json" \
    --header "x-alert-timestamp: $TS" \
    --header "x-alert-signature: sha256=$SIGNATURE" \
    --post-data "$BODY" \
    "$ALERT_URL" 2>&1
}

RESPONSE=$(attempt)
RC=$?
if [ $RC -ne 0 ]; then
  sleep 3
  RESPONSE=$(attempt)
  RC=$?
fi

if [ $RC -ne 0 ]; then
  # Whatever the failure was, the line that matters is that the alert did not land:
  # a backup that failed *and* could not say so is the one nobody finds out about.
  log "发送失败（wget 退出 $RC，url=$ALERT_URL）：$RESPONSE"
  exit 1
fi

log "已送达 $ALERT_URL：$RESPONSE"
exit 0
