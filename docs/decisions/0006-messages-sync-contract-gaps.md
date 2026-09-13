# 0006：messages / sync 契约落地时发现的缺口

- 日期：2026-09-13
- 状态：open
- 关联章节：`01-后端说明书.md` 第 4.2、4.3.2、4.3.3、4.3.4、5.4、6.4 节，第 727-752 行事件表，§10 验收表第 3、4 项
- 关联决定：`0005-real-database-findings.md`（seq 空洞与 `asOfSeq`）

## 矛盾一：`messages` 没有 `updated_at`，但 4.3.4 把它列为硬要求

第 414 行原文：

> `message:updated` 与 `message:deleted` 事件必须携带完整消息 DTO（而不是 diff），且 DTO 必须包含 `updatedAt`。

第 410 行进一步要求「应用事件时用 `updatedAt` 比较：只有事件的 `updatedAt` 大于本地已存该消息的 `updatedAt` 才覆盖」。

而 `0001_init.sql` 的 `messages` 表只有 `created_at` / `edited_at` / `deleted_at`，没有 `updated_at`；`set_updated_at()` 触发器也只挂在 `users`、`groups`、`tasks`、`task_comments`、`notification_prefs` 五张表上（第 409-413 行），`messages` 不在其中。

用 `edited_at` 代替不行：撤回不写 `edited_at`。用 `deleted_at` 代替也不行：一条消息可以先被编辑再被撤回，两个字段各自单调，但彼此不可比，客户端无法判断「这条 `message:updated` 是不是比本地的 `deleted_at` 更旧」。

**处理**：新增迁移 `0002_messages_updated_at.sql`

```sql
ALTER TABLE messages ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TRIGGER trg_messages_updated BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

已在真实 PG 17.11 上验证：新列有值；编辑使 `updated_at` 严格前进；撤回也使它前进（集成用例 `advances messages.updated_at on edit and on revoke`）。`0001` 之后累计 8 个触发器。

同时把 `loadMigrations()` 从「硬编码一个文件名」改成「按目录列出 `NNNN_*.sql` 并排序」。这一条是前置条件：没有它，任何后续迁移都进不了运行时。验证过两条路径——空库连跑两个迁移、以及已有 `0001` 的库增量补上 `0002`。

## 缺口二：`message:send` 的 ack 形状，WS 表和 HTTP 表不一致

第 735 行写 WS ack 是 `{message: MessageDTO}`；第 663 行写 HTTP POST 命中幂等时返回「`200` + `deduplicated: true` 与原消息」。两条没说是不是同一个对象。

**当前决定**：统一成超集 `{ message: MessageDTO, deduplicated: boolean }`，`deduplicated` 默认 `false`，WS 与 HTTP 共用。多带一个布尔字段对老客户端无害，少带一个则让 HTTP 幂等语义无处表达。

## 缺口三：`clientMsgId` 该不该在边界上就要求 UUID

DDL 里 `client_msg_id UUID`，第 5.4 行末把「重试必须复用同一个 `clientMsgId`」写成客户端硬契约。但原 `messageSendSchema` 只要求 `min(1)`——于是任何字符串都能过 Zod，然后在 `INSERT` 时被 PostgreSQL 以一句看不出所以然的类型错误打回。

**当前决定**：契约层直接收成 `z.string().uuid()`，DTO 侧同样 `z.string().uuid().nullable()`。理由是幂等键的**可复用性**属于契约而不是实现细节：如果允许 `'retry-1'` 这种一次性字符串，弱网重试时客户端只能换新键，`(sender_id, client_msg_id)` 唯一索引就形同不存在。

## 缺口四：`asOfSeq` 的定义会让客户端位点倒退

第 4.3.3 行把 `asOfSeq` 定义成两句话：items 非空时取最后一条的 `seq`；items 为空且 `hasMore = false` 时取该群当前的 `groups.last_seq`。

考虑一个真实场景：客户端本地 `syncedSeq = 108`，但因为某些原因（重装后恢复了一份偏新的本地库、或运维改过数据）服务端 `last_seq = 105`。客户端上报 `sinceSeq = 108`，服务端返回 `{items: [], asOfSeq: 105, hasMore: false}`，客户端按第 395 行「无条件推进」……`syncedSeq` 就从 108 退回 105，106-108 在本地被重新拉一遍，重复消息。

这与第 4.4.1 行读位点用的 `GREATEST` 是同一个毛病，只是发生在客户端侧。

**当前决定**：服务端返回时收敛一步——`asOfSeq = max(定义值, 请求里的 sinceSeq)`，即**永不返回比 `sinceSeq` 更小的 `asOfSeq`**。客户端「无条件相信」的规则原样保留，倒退风险由服务端吸收。这条要在 messages/sync 实现时写成用例：`sinceSeq` 高于 `last_seq` 时 `asOfSeq == sinceSeq` 且 `items` 为空。

（`0005` 矛盾一还悬着：说明书认为回滚会产生 seq 空洞，而当前 `alloc_group_seq` 不会产生。本决定不依赖那个结论——无论有没有空洞，`asOfSeq` 都按上面的规则返回。）

## 缺口五：本轮只发得出 `text` 与 `system`

`message_attachments` 需要 `files` 模块（上传、`sha256` 去重、`ref_count` 回收），`kind='task_card'` 需要 `tasks` 模块，`refMessageId` 需要写入 `message_refs` 但说明书没给这张表的写入时机与级联语义。三者都在本轮范围之外。

**当前决定**：`messages` 服务先只接受 `kind in ('text','system')` 且 `system` 只允许服务端自己产生；`attachments` / `mentions` / `refMessageId` 在 DTO 里保留字段与默认值，但写入路径暂不放行。放开时各自另立决定，不在这里预埋。

## 缺口六：`outbox.aggregate_id` 没有外键，孤儿事件会把就绪度永久钉住

`outbox` 只有一个主键约束，`aggregate_id` 上没有外键——这是对的，它本来就是多态的（message / task / comment 共用一张表），加不了外键。

但 6.9 只写了「已处理的记录保留 7 天后删除」，没有写**从未被处理、而聚合根已经消失**的行怎么办。这类行的 `processed_at` 永远是 NULL，而 `readyz` 的 lag 恰好取的就是 `MIN(created_at) WHERE processed_at IS NULL`。一条孤儿就能把 lag 钉在一个只会增长的数值上，永远降不下来。

真库上已经复现：集成测试跑完把自己造的消息删掉之后，`outbox` 留下 71 行没人认领的事件。

**当前决定**：worker 必须让每个事件都到达终态——聚合根不存在时也要置 `processed_at`（或走 `attempts++` 到上限后落 `last_error` 由清理任务收走），不能指望聚合根还在。同时清理任务的条件写成「按 `processed_at` 龄期」而不是「按聚合根是否存在」。本轮先把这条记下来，测试夹具按孤儿条件清理，实现 worker 时必须有对应的用例。

## 实现陷阱（不是矛盾，但极易写错）

撤回在 3.4 矩阵里是**两行**：

| 操作 | owner | admin | member |
|---|---|---|---|
| 撤回自己的消息（2 分钟内） | ✓ | ✓ | ✓ |
| 撤回他人的消息 | ✓ | ✓ | ✗ |

写成「moderator 就免窗口」是错的——那等于群主可以随时撤回自己三天前发的话，而普通成员两分钟后就再也撤不了。正确形式是两个分支的或：自己的消息一律受 2 分钟约束，他人消息只有管理员能碰且不受时间约束。

实现里已按此写成单条 `UPDATE` 的 WHERE，见 `apps/server/src/messages/repository.ts` 的 `applyRevoke`，并由集成用例 `(real PostgreSQL) applies the 2 minute window to your own message and exempts moderators only for others` 钉住。

同理，编辑必须同时置 `edited_at`：只改 `body` 的话，DTO 上 `editedAt` 永远是 null，前端无从显示「已编辑」。0002 加的 `updated_at` 由触发器负责，两者不是一回事——`edited_at` 是给用户看的语义时间，`updated_at` 是给客户端做覆盖判定的机制时间。
