# 0016：outbox 的 payload 当时只是一个指针，而撤回写的不是 `delete`

- 日期：2026-09-15
- 状态：open（工程侧已按本节实现并在真 PG 上用 3 条用例钉住，说明书本身没改）
- 关联章节：`01-后端说明书.md` 第 6.9 节（transactional outbox + Meilisearch + 降级，尤其「payload 必须自包含」与「索引范围」两段）、第 4.2 节第 6 步（同事务写 outbox）、第 9.2 节第 9 项（`search` 模块）；`03-AI运维手册.md` 第 12 节巡检项 18（outbox 积压）与剧本 7
- 关联代码：`apps/server/src/messages/repository.ts`（`writeOutboxEvent`）、`apps/server/tests/integration/messages.test.ts`、`infra/db/migrations/0001_init.sql`（`outbox` 与 `messages_body_trgm`）
- 前置：`0006` 缺口六（孤儿事件把 `readyz` 的 lag 永久钉住）、`0011` 第三节（`outboxPending` 是条数、`outboxLagSeconds` 是年龄，两个字段不能混）、`0015`（告警消息走的是同一条 outbox）

## 先说清楚说明书给了什么

6.9 关于**写入侧**只有两句话，各自都被违反了：

> **为什么 outbox 里的 `payload` 必须自包含**：worker 消费时**不回查 `messages` 表**。

> **索引范围**：只索引 `messages` 与 `task_comments` 的正文（`deleted_at IS NULL` 且 `kind IN ('text','task_card')`）。……撤回时向 outbox 写一条 `event_type='delete'`，worker 从索引里删掉。

`0001_init.sql:319` 那行列注释写的是 `-- 自包含索引文档，worker 不回查业务表`。也就是说建表的人知道，写代码的人没做——`writeOutboxUpsert` 往 payload 里放的是 `{messageId, groupId, seq, reason}`，一个**指针**，worker 拿到它只能回查。撤回那一路更直接：三个 reason（`send` / `edit` / `revoke`）**全部**写 `event_type='upsert'`，`revoke` 只是 payload 里换了个字段。

下面五节：两处各改了什么、为什么必须一起改、一个由我拍的默认实现、为什么 worker 仍然不是下一步、以及存量行怎么办。

## 一：自包含不只防「旧内容」，它还是索引范围的唯一数据来源

现在 payload 带 `kind`、`body`、`senderId`、`createdAt`：

```ts
{ messageId, groupId, seq, senderId, kind, body, createdAt, reason }
```

说明书给自包含的理由是**时序**（改了就索引不进去中间态）。但在真正要写 worker 的那天，还有第二个理由，而且更硬：**「索引范围」这一句要看的两个字段（`kind`、正文是否存在）本来就在 `messages` 表里**。一个不回查业务表的 worker，如果事件里不带 `kind`，就没有任何依据判断该不该索引——它只能回查，从而违反同一条规则。也就是说：**只补「不回查」而不补字段，等于没补**。这条在测试里是断言 `payload.kind === 'text'`，而不是断言「没有回查」——后者测不出来。

`body` 为 NULL 时写 JSON `null` 而不是省略键：worker 面对「这个键不存在」和「这条消息没有正文」要能区分，前者是形状问题（第五节要处理），后者是正常数据。

## 二：撤回写 `delete`，而且第一节单独落地会让事情变糟

两处的修法有顺序依赖，这是本节唯一值得记的东西。

撤回是**软删**（`UPDATE messages SET deleted_at = now()`，`body` 原地留着——`/raw` 分级还要它）。

- **改之前**：事件不带正文，worker 只能回查，而回查会看见 `deleted_at IS NOT NULL`，于是「不该索引」这个判断还是做得出来的。违反说明书，但后果被那个违反掩盖了。
- **只改第一节**：一个 `upsert` 事件会**自带**那段被撤回的正文，worker 依规则不回查，于是把它原样送进索引，而且**没有任何后续事件会来纠正**（撤回是这条消息的最后一个动作）。

所以 `delete` 不是「补一条说明书要求的事件类型」，它是第一节的前提。`event_type` 的取值集合（`upsert` | `delete`）本来就写在 `0001_init.sql:318` 的列注释里。

`delete` 的 payload 只带文档键（`{messageId, groupId, seq, reason}`，**不带 `body`**）：被撤回的正文不该再抄进第二张表。6.9 给 outbox 的 7 天保留是「已处理的记录保留 7 天后删除，便于排查为什么这条没进索引」，不是「多存一份正文的地方」。索引侧删掉它、outbox 侧不留副本，才是撤回的完整语义。

## 三：索引范围由谁裁——一个我拍的默认实现（分叉）

说明书只在 6.9 说「索引范围是 X」，没说这条规则**活在哪一层**。两条路：

- (a) writer 侧裁：`kind` 不在 `('text','task_card')` 就不写 outbox 行；
- (b) **writer 全量写，worker 按 payload 里的 `kind` 裁**（已采用）。

选 (b) 的三条理由：

1. `outbox` 是多态表（`aggregate_type` = message / task_comment 共用），「搜索索引收哪些」是**索引的属性**不是**消息的属性**。让 messages 仓储替 `search` 模块做决定，方向反了。
2. 将来改范围（把 `task_card` 排掉、或把附件说明纳入）只需要改 worker 并重建索引，不需要动写入路径、也不需要回填事件。
3. 少一处「writer 与 worker 各持一份范围常量、漂移只在搜索结果里暴露」的地方。

代价要如实写：**worker 会消费到它必须忽略的行，并且照样把 `processed_at` 置上**。于是巡检项 18、`/readyz`、`outboxPending` 量的都是「**未消费**」而不是「**未索引**」——说明书里这两个词是同一件事，在本节这个实现下不是。这是选 (b) 买的东西，不是免费的。

如果哪天改成 (a)，`delete` 事件仍然必须无条件发：撤回不是一个索引内容，是一个索引**动作**。

今天实际会被裁掉的行只有一种：`kind='system'`。它唯一的来源路径就是 `/hooks/alert` 往运维群写的那一行（`insertSystemMessage` 目前只有 `alert-repository.ts:161` 一个调用方），而 API 侧 `service.ts:109` 把非 `text` 的 kind 全挡在门外，所以 `image` / `file` 暂时进不来。**运维告警正文进不进搜索索引，是一个产品问题不是工程问题**（进了意味着成员能搜到「备份失败 ×3」；没进意味着搜不到），按 `README` 的原则 1 登记，不改原文。

## 四：worker 仍然不是下一件该做的事，`search` 才是

这一节是纠正我自己写的 `HANDOVER` §5.2 与 §10.9（两处都说过「剩下的 ops 工作里最大的一件是 outbox worker」），那句话在补完 payload 之后仍然不成立。

修完之后最容易顺手做的事，是加一个「每 N 秒把 `processed_at IS NULL` 全置上」的定时任务。**不要做**，它比现状更糟：

- 6.9 三段结构（写 → worker → Meilisearch 索引）的**第三段在这个栈里不存在**。`apps/server/src/search/` 是空的，compose 里没有 Meilisearch 服务，说明书 9.2 第 9 项整个没动。一个没有终点的 drain 只是把事件藏起来。
- 被藏起来的代价是四个信号同时变**永久绿灯**：巡检项 18（> 500 warning / > 2000 critical）、`/readyz` 的 `outboxLag`、`/internal/metrics` 的 `outboxPending` 与 `outboxLagSeconds`。今天那个单调上涨的 lag **至少是真话**（`0006` 缺口六、`HANDOVER` §11 坑 17），换成假绿灯等于把「没人消费」这件事从所有能看见它的地方抹掉。将来 Meilisearch 真接上时，不会有任何一条曲线告诉你它没在消费。
- 所以 worker 的开工条件是跟 `search` 模块**一起做**：Meilisearch 进 compose + 查询接口 + 降级路径 + worker，四件是同一件事的四半，拆开做会留下假绿灯。

一个已经付了的部分：降级路径的**数据库那一半已经在跑**——`pg_trgm` 扩展和 `messages_body_trgm` GIN 索引（`0001_init.sql:166`，谓词 `WHERE deleted_at IS NULL AND body IS NOT NULL`）随迁移 0001 就落了。`search` 剩下的成本是服务与接口，不是改表。

## 五：存量行——跑过旧 writer 的环境要回填，规则按顺序

本次只改 writer，**没有迁移**（也不该有：改已应用的迁移会被 checksum 挡下来，见 `HANDOVER` §11 坑 15）。但任何跑过旧代码的环境都会留下缺 `body`/`kind`/`createdAt` 的行，而按第一节的规则 worker 无法只凭它们判断。

1. 若 `payload->>'reason' = 'send'` 且该消息 `edited_at IS NULL AND deleted_at IS NULL` → 直接 `UPDATE payload` 成自包含形态。这是**形状回填**不是「回查」：正文在两次写之间没变过，所以「这条事件当时说了什么」仍有唯一答案。
2. 其余（改过或撤回过）→ **补发一条新事件**，别改旧行。补发是安全的，因为 6.9 明写幂等「重复消费同一 outbox 行结果相同」（文档主键 `message:id`）；而改旧行是在编造「当时说了什么」，那个答案已经没有了。旧行交给 7 天保留期删。
3. 全新部署没有这个问题。

本地部署栈上那 4 行（2026-09-14 备份与恢复演练留下的，全是 `send`、全未改动）按规则 1 回填了：

```
1|{"seq": 1, "body": "第一条：备份演练要用的正文", "kind": "text", ..., "senderId": "3", "createdAt": "2026-09-14T14:17:47.369Z", "reason": "send"}
```

回填后 `readyz` 的 `outboxLag` 仍在涨。**这是对的**：它涨的是「没有 worker」（第四节），不再是「事件形状不对」。

## 六：测试

`apps/server/tests/integration/messages.test.ts` 三条真 PG 用例，都在 `INTEGRATION_DATABASE_URL` 开关下（不设则整体 skip）：

1. 发出的正文与 `kind` 出现在 `upsert` 事件的 payload 里；
2. 编辑前后两条事件的 `body` 分别是 `第一版` 与 `第二版`（**按每次写入时的版本索引，不是按读取时**）；
3. 撤回后事件序列是 `['upsert', 'delete']`，不是一个多出来的 `upsert`。

三条都是先红后绿写的，红的失败信息分别是指向正确的原因：`expected undefined to be '塔吊十点了进场'`、`expected ['null','null'] to deeply equal ['第一版','第二版']`、`expected ['upsert','upsert'] to deeply equal ['upsert','delete']`。
