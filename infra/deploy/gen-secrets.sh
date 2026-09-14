#!/bin/sh
# 工友圈 部署栈密钥生成 —— 运维手册 4.1 的落地。
#
#   infra/deploy/gen-secrets.sh                 # 写 infra/deploy/.env
#   infra/deploy/gen-secrets.sh /opt/chat/.env  # 或者写到别处
#
# 为什么要有这个脚本而不是「照着 .env.example 手填」：手册 4.1 给的循环是
# `>> .env` 追加，而 .env.example 里这五个键已经存在，追加会得到重复的键；
# docker compose 对重复键取最后一个，于是文件里那份带注释的说明和真正生效的值
# 分家。这里改成模板替换：键的位置、注释、顺序都不动，只把空值填上。
#
# 刻意拒绝覆盖已存在的 .env：一个会改写线上密钥的脚本，在有人「只是想再生成
# 一份」的那天会把所有凭据一起换掉，于是所有已签发的 token 与整条 refresh 族
# 同时失效，而数据库密码也变了。

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMPLATE="$HERE/.env.example"
ENV_FILE="${1:-$HERE/.env}"

die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

if [ ! -f "$TEMPLATE" ]; then die "找不到模板 $TEMPLATE"; fi
if [ -e "$ENV_FILE" ]; then
  die "$ENV_FILE 已存在。要重新生成请先自己移走它（现有密钥可能还在被线上使用）"
fi
if ! command -v openssl >/dev/null 2>&1; then die '找不到 openssl'; fi

# tr -d 不是因为 openssl 会折行（48 字节正好 64 个字符，一行放得下），而是因为
# Windows 上的 openssl 以 CRLF 结尾：一个带 \r 的密码会安静地写进 .env，在两边
# 看起来是同一个字符串，只在认证那一刻失败。
gen_b64() { openssl rand -base64 48 | tr -d '\r\n'; }
gen_hex() { openssl rand -hex 32 | tr -d '\r\n'; }

check() { # check <名字> <ERE> <值>
  NAME="$1" RE="$2" VAL="$3"
  if ! printf '%s' "$VAL" | grep -Eq "$RE"; then
    die "$NAME 不符合预期字符集 $RE（长度 ${#VAL}）"
  fi
}

# 十六进制而不是手册的 base64：这个值要拼进 DATABASE_URL，而 base64 的字母表里
# 有 `/` 与 `+`，两者都是 URI 分隔符。见 docs/decisions/0012。
POSTGRES_PASSWORD=$(gen_hex)
JWT_SECRET=$(gen_b64)
MEILI_MASTER_KEY=$(gen_b64)
ALERT_HMAC_SECRET=$(gen_b64)
RESTIC_PASSWORD=$(gen_b64)

check 'POSTGRES_PASSWORD' '^[0-9a-f]{64}$' "$POSTGRES_PASSWORD"
# `+/=` 对下面四个无害：它们从不被拼进 URL，只作为裸字符串参与签名与比较。
check 'JWT_SECRET' '^[A-Za-z0-9+/=]{64}$' "$JWT_SECRET"
check 'MEILI_MASTER_KEY' '^[A-Za-z0-9+/=]{64}$' "$MEILI_MASTER_KEY"
check 'ALERT_HMAC_SECRET' '^[A-Za-z0-9+/=]{64}$' "$ALERT_HMAC_SECRET"
check 'RESTIC_PASSWORD' '^[A-Za-z0-9+/=]{64}$' "$RESTIC_PASSWORD"

# 手册 4.1「不要用同一个密钥干两件事」。共用是复制粘贴的结果而不是决定，
# 所以这里数一遍，而不是提醒一遍。
DISTINCT=$(printf '%s\n' "$POSTGRES_PASSWORD" "$JWT_SECRET" "$MEILI_MASTER_KEY" \
  "$ALERT_HMAC_SECRET" "$RESTIC_PASSWORD" | sort -u | wc -l | tr -d ' ')
if [ "$DISTINCT" != "5" ]; then die "五个密钥只有 $DISTINCT 个不同值，拒绝写出"; fi

TMP="$ENV_FILE.tmp.$$"
umask 077
: >"$TMP"
# awk 而不是 sed：替换值里出现 `&` 会被 sed 当成「重复匹配」，而 base64 的
# `/ + =` 三个字符里至少有一个会撞上任何常见的 sed 分隔符。
awk -v PGP="$POSTGRES_PASSWORD" -v JWT="$JWT_SECRET" -v MEI="$MEILI_MASTER_KEY" \
  -v ALR="$ALERT_HMAC_SECRET" -v RES="$RESTIC_PASSWORD" '
  BEGIN {
    V["POSTGRES_PASSWORD"] = PGP; V["JWT_SECRET"] = JWT; V["MEILI_MASTER_KEY"] = MEI
    V["ALERT_HMAC_SECRET"] = ALR; V["RESTIC_PASSWORD"] = RES
  }
  {
    for (k in V) if ($0 ~ "^" k "=[ \t]*$") { print k "=" V[k]; next }
    print
  }
  ' "$TEMPLATE" >"$TMP"

# 模板与键名一旦对不上，上面那段替换会一声不响地什么都不做，交出去的还是那份
# 空密钥——所以逐个数一遍才算写完。
for NAME in POSTGRES_PASSWORD JWT_SECRET MEILI_MASTER_KEY ALERT_HMAC_SECRET RESTIC_PASSWORD; do
  if ! grep -Eq "^$NAME=.+$" "$TMP"; then
    die "$NAME 没有被填上（模板里它那一行不是独占一行的 NAME= 形式？）"
  fi
done

mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
printf '已写入 %s（0600），五个密钥各不相同\n' "$ENV_FILE" >&2
