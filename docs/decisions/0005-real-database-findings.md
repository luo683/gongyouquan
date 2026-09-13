# 0005：真实 PostgreSQL 首次执行暴露的矛盾与缺口

- 日期：2026-09-13
- 状态：open
- 关联章节：`01-后端说明书.md` 第 4.2、4.3.3、4.4.2、5.3、6.5、9.4 节，验收表第 2、3、8 项
- 关联决定：`0002-database-spec-clarifications.md`（软删除 vs `ON DELETE CASCADE`）、`0004`（非成员读写口径）
- 证据：`apps/server/tests/integration/database.test.ts`，PostgreSQL 17.11（`postgres:17-alpine`），18 个用例

## 背景

`0001_init.sql` 第一次在真实 PostgreSQL 上执行。§9.4 要求的建库、迁移重复执行两项已通过（见文末）。执行过程中暴露出六条静态检查看不出来的问题，其中第一条直接推翻了说明书的一条核心论断。

## 矛盾一：`alloc_group_seq` 的当前写法不会产生回滚空洞（第 353 行 / 验收表第 2 项）

第 353 行断言「一个回滚的事务会留下永久空洞（`seq=105` 被分配但事务回滚，`106` 正常提交，105 从此不存在）」，验收表第 2 项要求「构造一个回滚事务 → 后续 `seq` 有跳跃」。

第 6.5 节的函数体是：

```sql
UPDATE groups SET last_seq = last_seq + 1 WHERE id = p_group_id RETURNING last_seq
```

计数器更新与行锁同属一个事务。回滚时 `last_seq` 一起回退，下一个分配者拿回同一个号；并发分配者会阻塞在这把行锁上，等前一个事务出结果才继续。**所以「105 被回滚、106 已提交」这个交错在当前的 DDL 下不可能发生。**

实测（`allocates group seq values that never repeat, even under concurrency` 用例）：

- 100 个并发 `alloc_group_seq` → 100 个互不相同的值，`groups.last_seq` 等于最大值，无死锁、无需重试（验收表第 1 项的分配部分）。
- 事务内分配到 `N+1` 后回滚 → `last_seq` 仍是 `N`，下一次分配又拿到 `N+1`。号被**归还**，没有跳。

空洞要出现，分配必须走 PostgreSQL 序列（`nextval` 故意不回滚，因此天然留空洞）或走事务外的独立连接。说明书描述的是序列的行为，DDL 写的是表计数器。

**影响面**：这不只是文档措辞问题。`asOfSeq` 机制（第 388-397 行，说明书自称「整个同步机制的基石」）存在的唯一理由就是跳过回滚空洞。如果空洞不会出现，`asOfSeq` 的语义仍然是对的（无条件相信 `sync:pull`），但验收表第 2 项**按现在的 DDL 永远写不出来**，只能改成断言「回滚不产生空洞、不重复发号」。

**当前实现决定**：不动 DDL——不重复发号是更强的保证，客户端也仍然被要求「不能假设连续」（消息被硬删时会真的不连续，见矛盾四）。建议把第 353 行改写为「`seq` 单调、不重复，但**不保证连续**：群被硬删除时整段 `seq` 会消失」，并把验收表第 2 项改为断言无重复、无死锁。若产品坚持要「回滚留空洞」的语义，需要把 `alloc_group_seq` 换成 `CREATE SEQUENCE` 方案，那是另一次决定。

## 缺口二：未读子查询不排除软删除的消息（第 4.4.2 节 / 验收表第 8 项）

第 643 行的 `GET /groups` 与第 1630 行验收项把未读口径写成三条：自己发的不计、`kind='system'` 不计、超过 100 截断。**三条里都没有撤回（`deleted_at`）这一项**。

第 5.3 节列表查询按说明书口径实现后，实测行为是：一条已被发送者撤回的消息仍然计入 `unreadCount`。用户会看到「3 条未读」，点进去只有 2 条。

**当前实现决定**：暂时保持现状（严格按说明书已写的三条口径实现，不自行加第 4 条），并由集成测试钉住 `unreadCount = 1` 这个值。改与不改都需要需求方拍板：撤回的消息到底算不算未读。

## 缺口三：`lastMessagePreview` 与未读计数对 `system` 的口径不一致

同一条 `GET /groups` 里，未读子查询带 `kind <> 'system'`，预览子查询只带 `deleted_at IS NULL`。结果：群里最后一条若是系统消息（「XX 加入了群」「任务已验收」），列表页的预览格就是这条系统提示，而不是工友最后说的话。

说明书第 643 行只写了「最后一条消息预览」，`lastMessagePreviewSchema` 里带 `kind` 字段，所以契约上允许系统消息当预览——无法从原文判定这是遗漏还是有意。

**当前实现决定**：不改动。集成测试断言预览落在 `kind='system'`、`senderDisplayName='System'` 上，任何人改动一侧口径都会立刻红。

## 缺口四：群被硬删除时，`ON DELETE CASCADE` 连撤回留痕一起物理清除

`messages.group_id ... ON DELETE CASCADE`，级联不区分 `deleted_at`。实测（`really does cascade a hard group delete` 用例）：`DELETE FROM groups` 之后，`messages`、`group_members`、`group_invites`、`read_positions` 里该群的行全部消失，包括带 `deleted_by` 的撤回消息。

这正是 `0002` 里「软删除 vs `ON DELETE CASCADE`」矛盾的具体后果：单看表设计，消息撤回是软删除、明确「留痕」；但只要上层有人真删群（运营清理、测试环境重置），留痕就没了。说明书第 3.6 节只给了「归档」，没有给「删除群」的接口，所以这条路径目前没有产品入口——危险在于 `0001_init.sql` 允许它发生。

**当前实现决定**：不在 DDL 上做手术（改级联属于 schema 变更，且迁移文件只增不改）。建议运营侧明确「群永不硬删」，并在 `ops_requests` 类型里排除删群操作。若将来必须支持删群，需要先有一张 `messages_archive` 或把外键改成 `ON DELETE RESTRICT`。

## 缺口五：`files.uploader_id` 没有级联，删用户会被自己的文件挡住

`files_uploader_id_fkey REFERENCES users(id)` 无 `ON DELETE` 动作（默认 `NO ACTION`）。实测清理阶段直接报错：

```
update or delete on table "users" violates foreign key constraint "files_uploader_id_fkey" on table "files"
```

说明书 5.x 没有「注销账号 / 删除用户」接口，第 3.4 节只有踢出群（软删 `removed_at`）。所以这暂时只是一条隐含约束：**禁用（`disabled_at`）是唯一安全的下架方式，真删用户必须先清 `files`。** 同理 `groups.created_by`、`audit_logs.actor_id`、`message_refs` 也是无级联外键。

**当前实现决定**：不动。集成测试的清理逻辑按 `files → users` 顺序删除，把这个依赖显式写在注释里。将来若做「注销账号」功能，需要新的 decision 规定文件归属转移还是连带删除。

## 缺口六：说明书第 1685 行的查询计划验收仍未完成

第 1685 行要求：对 6.7 / 6.8 / 4.4.2 / 4.4.3 / 6.9 里**每条** SQL，先插几千行样例数据，再跑 `EXPLAIN (ANALYZE, BUFFERS)` 确认走对索引。

本轮只在一张几十行的表上验证了 `4.4.2` 未读/预览这一条链路，以及 `messages_body_trgm` 部分索引能被 trigram 查询命中（`enable_seqscan = off` 下 `Index Cond: (body % '扣件')`，Recheck 里带上了 `deleted_at IS NULL`，说明部分索引的谓词匹配成功）。其余四条链路的 `ANALYZE` 级验证没有做，**不能声称本节已通过**。

顺带一条与 `0002` 矛盾四相关的观察：加上 `group_id = $1` 谓词后，规划器在小表上会放弃 `messages_body_trgm` 改用 `messages_group_seq_key`——这是基数问题不是索引设计问题，但它说明搜索类 SQL 的最终计划依赖数据量，必须按第 1685 行造样例数据才能定论。

## 已经完成的部分（§9.4）

- 真实 PostgreSQL 17.11 建库通过，`0001_init.sql` 一次执行成功，无手工改 SQL。
- 对象计数与说明书声明一致：22 表 / 4 自定义函数 / 7 触发器 / 11 枚举类型 / `pg_trgm` + `pgcrypto` 就位。
- 全部 47 个 `*_at` 列均为 `timestamptz`，无一例外（测试按 `attname ~ '_at$'` 全量扫描，不是手挑清单）。
- 迁移连跑两次：第二次 3ms 空转，`schema_migrations.applied_at` 逐字节不变。
- 篡改已应用迁移的 checksum → 启动即 `migration checksum mismatch`，保护有效。
- `auth` 与 `groups` 两个切片的 SQL 第一次真跑：邀请码消耗与事务回滚、大小写折叠的唯一索引、refresh 轮换与重用整族撤销、归档群读写分治、单群主部分唯一索引、`clientMsgId` 幂等索引、`(group_id, seq)` 唯一索引、`bump_file_ref_count` 触发器，全部按预期工作。

阻塞记录可以撤销：`registry-1.docker.io` 仍不可达，但 `postgres:17-alpine` 已通过 `docker.m.daocloud.io` 镜像源取得，并固化为 `infra/db/docker-compose.yml`；CI 侧 `integration` job 使用 `postgres:17-alpine` service 容器。
