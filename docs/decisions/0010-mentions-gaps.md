# 0010：@提及落地时的缺口与取舍

- 日期：2026-09-14
- 状态：open
- 关联章节：`01-后端说明书.md` 第 6.6 节、第 161 行、路由表第 637 行、事件表第 751 行、第 780 行、第 1685 行
- 关联决定：`0005-real-database-findings.md`（索引与计划验证）、`0006-messages-sync-contract-gaps.md`

## 一：说明书点名了 `MentionDTO`，却从未定义它

第 637 行只写了 `GET /me/mentions` 返回 `{items: MentionDTO[], nextCursor, hasMore}`，全文再无 `MentionDTO` 的字段定义。这一份是我们定的：

```text
messageId, groupId, groupName, seq, fromUserId, fromDisplayName, body, createdAt, unread
```

两处刻意的冗余，都不是为了省事：

- **`groupName`**：这个列表**跨群**，光一个 `groupId` 对人没有任何意义。不加它，前端要么显示一串数字，要么为每一行再去查一次群名。
- **`fromDisplayName`**：`MessageDto` 刻意不含发送者名字（5.4 只有 `lastMessagePreview` 带 `senderDisplayName`）。前端因此必须自己维护 roster 才能给气泡标名字——一个跨群列表没有 roster 可用，所以名字必须随 DTO 一起来。

`unread` 由 `seq > read_positions.mentions_read_seq` 在 SQL 里派生（6.6）。刻意不在应用层算：那需要把每个群的位点都取回来再逐条比较，而数据库一次就能做完。

## 二：mentions 是客户端给 id，还是服务端解析 body 里的 @

说明书自己在这件事上不一致：

- 第 161 行的写入流程写「**解析 body 中的 @** → INSERT message_mentions」
- 第 663 行与第 735 行的载荷里都有 `mentions?`，即**客户端直接给**

两条不可能同时成立。

**当前实现决定**：以客户端给的 `mentions: string[]` 为准（契约与路由表两处都这么写，且 `messageSendSchema` 里这个字段一直都在）。服务端**校验**而不解析：去重、丢掉发送者自己、丢掉非群成员、上限 50（3.3 的群规模上限）。

为什么不做 body 解析：显示名不唯一——schema 没有禁止两个成员叫同一个名字，而 `@张三` 到底指谁，只有正在输入的那个人知道。让服务端去猜，等于把一个身份问题伪装成字符串匹配问题。

**非成员是「丢弃」而不是「报错」**：一个 id 失效（对方在你打字期间被踢了）不应该让作者整条消息发不出去。但丢弃必须是**静默且可预测**的，所以有真库测试钉住它——`drops a mention of somebody who is not in the group`。

这一条要需求方确认，因为它决定了第 161 行是否作废。

## 三：撤回消息的正文不能从 `/me/mentions` 泄漏

这是实现时发现的一个**真实安全缺口**，不是取舍。

`/messages/:mid/raw` 把撤回消息的原文限定给 owner / admin（验收项 6）。而 `/me/mentions` 是**任何已登录用户**都能读的。如果它照直返回 `messages.body`，那么任何被 @ 过的人都能读到一条已被撤回的消息的原文——**绕过了 raw 的分级门禁**。

**当前实现决定**：SQL 里 `CASE WHEN m.deleted_at IS NULL THEN m.body ELSE NULL END`。行**仍然出现**（被告知「有人 @ 过你」和被告知「他说了什么」是两件事），但正文为 null，前端显示「（该消息已撤回）」。有专门的真库用例钉住这条。

## 四：跨群分页的游标，以及一个索引缺口

游标用 `messageId` 而不是 `seq`：**跨群时 seq 没有全局意义**（每个群各自从 1 编号），拿 seq 当游标会在群之间乱跳。

但现有索引撑不住这个查询。`message_mentions_unread ON message_mentions (mentioned_user_id, group_id, seq DESC)` 是为**单群**「@我未读」设计的，而 `/me/mentions` 是 `WHERE mentioned_user_id = $1 ORDER BY message_id DESC`——跨群、按 message_id 排。

**当前实现决定**：不加索引，只登记。理由是这个接口量级很小（一个人被 @ 的条数），且第 1685 行要求的 `EXPLAIN (ANALYZE, BUFFERS)` + 样例数据验证**整体还没做**（`0005` 缺口六）。在没有计划数据之前加索引是猜。真做了计划验证，这条要么被证明不需要，要么换成一个 `(mentioned_user_id, message_id DESC)` 的索引。

## 五：前端的「@我」计数是本地口径，不是服务端已读

侧栏那个数字由 `mention:new` 递增、打开列表时清零。它**没有**推进 `read_positions.mentions_read_seq`——那要走 `read:update` 且带 `mentionsReadSeq`，而前端目前不发。

所以这个数字的准确含义是「**自你上次打开列表以来**新增了几条」，不是服务端口径的未读数。刷新页面它会归零，而服务端的 `unread` 标记仍然是 true。

**当前实现决定**：保持现状，但**不能把它呈现成服务端的已读状态**。列表里每一行的「未读」标记来自服务端的 `unread` 字段，那个是真的；侧栏计数是会话内的。两者口径不同，界面上也没有把它们混为一谈。

若要统一，需要前端在打开列表时发一次 `read:update {mentionsReadSeq}`——但那会把「看了一眼列表」等同于「处理完了所有 @」，这个语义要产品侧确认。

## 六：send 的 ack DTO 必须重读一次

`INSERTED_COLUMNS` 上面原先有一句注释：「a fresh text message genuinely has none」（新消息没有聚合字段）。**这个假设被本轮推翻了**——mentions 就写在同一个事务里，新消息可以有聚合。

后果不是崩溃，是**静默的错误数据**：ack 返回的 `MessageDto.mentions` 是空数组，而库里明明有行。客户端按 4.3.4 把 ack 当作权威副本，于是被 @ 的消息在刷新之前显示不出提及。

**当前实现决定**：只在**确实写了 mentions 时**用 `messageColumns` 重读一次全行；没有提及的普通消息仍然走 `INSERT ... RETURNING`，不多付一次查询。

教训与 `0007` 第六节、坑 10 / 14 同源：**一句陈述现状的注释，在现状改变之后就成了陷阱**。它是被真库测试（`writes the mention rows and hands them back on the message`）抓到的，不是被 review 抓到的。
