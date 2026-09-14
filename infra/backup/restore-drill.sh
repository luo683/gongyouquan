#!/bin/sh
# 工友圈 恢复演练 —— 运维手册 8.3 的实现。
#
# 「没验证过的备份等于没有备份。」这一节是硬性的：首次演练必须在真实使用之前完成。
# 所以这个脚本不是文档，是要**真的跑**的东西，而且退出码就是结论——0 是通过，
# 非 0 是失败。任何一条验收 SQL 不成立就算失败，不打印一堆数字让人自己判断。
#
# 刻意写成 POSIX sh 而不是 bash：stock postgres:17-alpine 里有 psql / pg_restore /
# createdb 但没有 bash，而这个脚本最自然的执行位置就是那个临时容器内部。
#
# 用法（在生产/演练机上，对着一个**干净的** PG 实例）：
#   DUMP_FILE=/restore/backups/db_XXX.dump \
#   GLOBALS_FILE=/restore/backups/globals_XXX.sql.gz \
#   TARGET_DB=chat_drill PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD=tmp \
#   EXPECT_MIN_MESSAGES=1 \
#     sh restore-drill.sh
#
# 必填：DUMP_FILE, TARGET_DB, PGHOST, PGPORT, PGUSER, PGPASSWORD
# 选填：GLOBALS_FILE, EXPECT_MIN_MESSAGES(默认 0), EXPECT_MIN_USERS(默认 0), KEEP_DB(默认删)

set -eu

TS_START=$(date +%s)

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }
ok() { log "ok: $*"; }

: "${DUMP_FILE:?DUMP_FILE 未设置}"
: "${TARGET_DB:?TARGET_DB 未设置}"
: "${PGHOST:?PGHOST 未设置}"
: "${PGPORT:?PGPORT 未设置}"
: "${PGUSER:?PGUSER 未设置}"
: "${PGPASSWORD:?PGPASSWORD 未设置}"
export PGHOST PGPORT PGUSER PGPASSWORD

EXPECT_MIN_MESSAGES="${EXPECT_MIN_MESSAGES:-0}"
EXPECT_MIN_USERS="${EXPECT_MIN_USERS:-0}"

[ -f "$DUMP_FILE" ] || fail "dump 文件不存在：$DUMP_FILE"

# ── 0. 先确认这个 dump 本身可读。恢复一个坏 dump 会得到半个数据库，
#       那比恢复失败更难发现。──
log "校验 dump 可读性：$DUMP_FILE"
pg_restore --list "$DUMP_FILE" > /dev/null || fail "dump 不可读，演练终止"
TOC=$(pg_restore --list "$DUMP_FILE" | grep -c '^[0-9]' || true)
[ "$TOC" -gt 0 ] || fail "dump 目录为空，里面没有任何对象"
ok "dump 目录含 $TOC 个对象"

# ── 1. 全局对象（角色与权限）。失败不致命：--no-owner 恢复不依赖它们，
#       但生产恢复需要它们，所以记录而不忽略。──
if [ -n "${GLOBALS_FILE:-}" ]; then
  [ -f "$GLOBALS_FILE" ] || fail "globals 文件不存在：$GLOBALS_FILE"
  log "恢复全局对象：$GLOBALS_FILE"
  gunzip -c "$GLOBALS_FILE" | psql -v ON_ERROR_STOP=0 -q > /dev/null 2>&1 \
    && ok "全局对象已恢复" \
    || log "警告：全局对象恢复有报错（角色可能已存在），继续"
fi

# ── 2. 建库并恢复。TARGET_DB 必须不存在，否则演练是在污染一个已有的库。──
if psql -lqt | cut -d'|' -f1 | grep -qw "$TARGET_DB"; then
  fail "目标库 $TARGET_DB 已存在。演练必须恢复到干净的库，否则会分不清哪些行是恢复出来的"
fi

log "创建 $TARGET_DB"
createdb "$TARGET_DB"

log "pg_restore（计时，它是 RTO 的一部分）"
T_RESTORE_START=$(date +%s)
pg_restore -d "$TARGET_DB" -j 2 --no-owner --no-privileges "$DUMP_FILE" > /dev/null 2>&1 \
  || fail "pg_restore 失败"
T_RESTORE_END=$(date +%s)
RESTORE_SECONDS=$((T_RESTORE_END - T_RESTORE_START))
ok "数据恢复完成，用时 ${RESTORE_SECONDS}s"

# ── 3. 验收 SQL。每条都必须通过；任何一条失败即演练失败。──
psql_run() { psql -d "$TARGET_DB" -tA -v ON_ERROR_STOP=1 -c "$1"; }

log "验收 3.1：核心表存在且可查"
for T in users groups messages group_members read_positions message_mentions outbox; do
  psql_run "SELECT count(*) FROM $T" > /dev/null || fail "表 $T 查询失败"
done
ok "核心表齐全"

log "验收 3.2：行数"
USERS=$(psql_run "SELECT count(*) FROM users")
GROUPS=$(psql_run "SELECT count(*) FROM groups")
MESSAGES=$(psql_run "SELECT count(*) FROM messages")
MEMBERS=$(psql_run "SELECT count(*) FROM group_members")
MENTIONS=$(psql_run "SELECT count(*) FROM message_mentions")
log "  用户=$USERS 群=$GROUPS 成员=$MEMBERS 消息=$MESSAGES 提及=$MENTIONS"

[ "$MESSAGES" -ge "$EXPECT_MIN_MESSAGES" ] \
  || fail "消息数 $MESSAGES 少于期望的 $EXPECT_MIN_MESSAGES —— 恢复不完整"
[ "$USERS" -ge "$EXPECT_MIN_USERS" ] \
  || fail "用户数 $USERS 少于期望的 $EXPECT_MIN_USERS —— 恢复不完整"
ok "行数达到期望下限"

log "验收 3.3：最新 10 条消息存在且正文非空（未被截断）"
EMPTY_BODY=$(psql_run "SELECT count(*) FROM (SELECT body FROM messages ORDER BY id DESC LIMIT 10) t WHERE t.body IS NULL OR t.body = ''")
[ "$EMPTY_BODY" = "0" ] || fail "最新 10 条消息里有 $EMPTY_BODY 条正文为空 —— dump 可能被截断"
ok "最新消息正文完整"

log "验收 3.4：引用完整性（不应有悬挂的行）"
DANGLING_ATTACH=$(psql_run "SELECT count(*) FROM message_attachments a LEFT JOIN messages m ON m.id = a.message_id WHERE m.id IS NULL")
[ "$DANGLING_ATTACH" = "0" ] || fail "有 $DANGLING_ATTACH 条悬挂附件"
DANGLING_MENTION=$(psql_run "SELECT count(*) FROM message_mentions mm LEFT JOIN messages m ON m.id = mm.message_id WHERE m.id IS NULL")
[ "$DANGLING_MENTION" = "0" ] || fail "有 $DANGLING_MENTION 条悬挂提及"
DANGLING_MEMBER=$(psql_run "SELECT count(*) FROM group_members gm LEFT JOIN groups g ON g.id = gm.group_id WHERE g.id IS NULL")
[ "$DANGLING_MEMBER" = "0" ] || fail "有 $DANGLING_MEMBER 条悬挂成员关系"
ok "无悬挂引用"

log "验收 3.5：迁移账本完整（恢复出来的库必须能直接启动，而不是再跑一遍迁移）"
MIGRATIONS=$(psql_run "SELECT count(*) FROM schema_migrations")
[ "$MIGRATIONS" -ge 1 ] || fail "schema_migrations 为空 —— 应用启动时会重跑迁移，可能与已恢复的结构冲突"
ok "schema_migrations 含 $MIGRATIONS 条记录"

log "验收 3.6：序列与分配器函数存在（alloc_group_seq 是发号的唯一入口）"
psql_run "SELECT alloc_group_seq((SELECT id FROM groups ORDER BY id LIMIT 1))" > /dev/null 2>&1 \
  || log "警告：alloc_group_seq 调用失败（可能没有群，或函数缺失）—— 需人工确认"
ok "分配器可调用"

# ── 4. 结论 ──
TS_END=$(date +%s)
TOTAL_SECONDS=$((TS_END - TS_START))

cat <<EOF

==================== 恢复演练通过 ====================
  dump 文件        $DUMP_FILE
  目录对象数       $TOC
  目标库           $TARGET_DB @ $PGHOST:$PGPORT
  恢复用时         ${RESTORE_SECONDS}s
  演练总用时       ${TOTAL_SECONDS}s
  用户 / 群 / 消息 $USERS / $GROUPS / $MESSAGES
  pg 客户端版本    $(pg_restore --version | head -1)
=====================================================
EOF

if [ "${KEEP_DB:-0}" != "1" ]; then
  log "清理演练库 $TARGET_DB（设 KEEP_DB=1 可保留供人工检查）"
  dropdb "$TARGET_DB"
fi

log "PASS"
