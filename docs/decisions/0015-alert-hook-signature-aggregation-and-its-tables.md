# 0015：`/hooks/alert` 的签名要签什么、聚合窗口怎么翻滚，以及它两张表从哪来

- 日期：2026-09-15
- 状态：open（工程侧已按本节实现并在真 PG + 真容器上实测，说明书本身没改）
- 关联章节：`01-后端说明书.md` 第 5.8 节（运维钩子接口表）、第 8.1 节（错误码表）、第 8.2 节（限流，末段那个「告警接口的限流要特别说明」）；`03-AI运维手册.md` 第 7.1 节（L1 外部探活 → webhook（HMAC）→ `/hooks/alert` → 运维群）、第 10.2 节（交付验证方式：「手动 curl 一条告警到 `/hooks/alert` → 确认 `#运维告警` 群收到」）
- 关联代码：`apps/server/src/ops/`（`hmac.ts` / `alert-message.ts` / `alert-repository.ts` / `alert-service.ts` / `hooks-routes.ts` / `presence-drift.ts`）、`infra/db/migrations/0003_alert_idempotency_and_aggregation.sql`、`packages/contracts/src/index.ts`、`infra/backup/notify-alert.sh`
- 前置：`0007` 第四节（限流的三处说明书未定项，其中就点名了 `/hooks/alert` 缺表）、`0006`（outbox 与孤儿行——告警消息走的是同一条 outbox）、`0011`（`/internal/metrics`：presence 漂移现在是告警而不是日志）

## 先说清楚说明书给了什么

5.8 那一行给了六件事：路径、`HMAC 签名（无登录态）`、入参六个字段、返回 `{messageId}`、调用方（Uptime Kuma / 巡检脚本）、落点（`#运维告警` 群）。8.2 末段又补了两条要求：

> **此时后端必须能承受，否则"告警把系统压垮"会成为二次故障**。所以 `/hooks/alert` 除了限流，还有幂等（`idempotencyKey`）与聚合（同 `(source, title)` 在 5 分钟内合并为一条计数消息）。

**「HMAC 签名」四个字之外没有任何一项是可直接实现的**：签名的字符串是什么、头叫什么、容许多大时间差、幂等命中时返回什么、聚合窗口是翻滚还是滑动、窗口状态存在哪张表。下面八节就是这八个空缺，每一个都按说明书的意图补齐，不改写原文。

## 一：签名签的是 `timestamp + "\n" + rawBody`

```
x-alert-timestamp: 1789435064                  # 秒，十位以内
x-alert-signature: sha256=<hex>                # HMAC-SHA256(secret, "1789435064\n" + <请求体原始字节>)
```

- **±300 秒**的容忍（`SIGNATURE_SKEW_SECONDS`）。没有它，重放窗口就是无限的：签过一次的有效 body 可以永远重放。带上它，一个被抓到的请求在五分钟后就只是一条 401。
- **签的是原始字节，不是解析后的对象**。这一条决定了路由的形状：Fastify 默认的 JSON parser 会把 body 变成对象，`{"a": 1}` 与 `{"a":1}` 解析后相同而字节不同，重序列化签不上。所以 `/hooks/*` 注册在自己的 `app.register` 作用域里，用 `addContentTypeParser('application/json', { parseAs: 'string' })` 把原文留在手里、自己 `JSON.parse`，同时把原文塞进一个 `WeakMap`（键是 parser 回调的第一个参数，即 request 本身）。**不动全局 parser**：全站的 JSON 解析路径不该为了一个端点改成字符串。
- 解析失败必须还是 400。默认 parser 对坏 JSON 答 400，自定义的要是不设 `err.statusCode` 就变成 500——一个花括号打错的运维收到 500，会花一晚去查一个不存在的服务故障。
- `crypto.timingSafeEqual` 在两边长度不等时**抛异常**而不是返回 false，所以先比长度。头重复出现（`x-alert-timestamp: a, b`）按畸形处理而不是取第一个：一个能控制头顺序的中间层不该有机会挑一个参与签名的值。
- 401 在**限流之前**判。未签名的洪水不该花掉已签名客户端的配额——这条是 8.2「后端必须能承受」最直接的那一层。

## 二：窗口是翻滚的，命中计数与等级都归零；窗口内等级只升不降

`opened_at` 起算，距它不足 5 分钟的命中并入本窗口，超过就开新窗口（`EXPIRE_WINDOW` 再 `UPSERT_WINDOW`）。

**不用 `last_seen_at` 判定**：滑动窗口下一条持续不断的告警会把窗口永远续下去，最后群里那一行长成「×4382」，而它本来该每 5 分钟断成一条新消息。8.2 说的「合并为一条计数消息」里的「一条」是有保质期的。

两个 bug 都是真 PG 跑出来的，都记在代码里而不是靠人记住：

1. 最初用单条 `INSERT ... ON CONFLICT DO UPDATE` 加一堆 `CASE` 表达翻滚，**忘了重置 `hit_count`**——翻滚之后从旧总数继续加，一条只见过两次告警的消息印着「×7」。
2. 翻滚时**没有重置 `severity`**，于是窗口行的历史最高级一路跟着走：凌晨 3 点 critical 一次之后，中午每条 info 也印成【critical】。窗口内取最高是对的（8.2 要的就是「最坏的那一件」），跨窗口继承是错的——一个永不回落的告警等级等于把运维群静音。

对应测试：`tests/integration/alert-hooks.test.ts` 的「opens a new message once the window is older than five minutes」与「does not carry a stale severity into the next window」，都用时间旅行（`UPDATE alert_windows SET opened_at = now() - interval '6 minutes'`）而不是睡 5 分钟。

## 三：说明书没给这两张表放哪，所以 0003 补两张

0001 里最像的两个候选都不是：

| 已有的东西 | 它实际是什么键 | 为什么不能拿来当告警幂等键 |
|---|---|---|
| `ops_requests.idempotency_key` | **人工发起的审批请求**的去重键 | 语义不同表也不同，塞进去等于让「重启服务器的请求」和「磁盘满了」共用一张状态机 |
| `ops_runs.alert_fingerprint` | agent **处理结果**的 1 小时冷却指纹 | 那是「这件事我处理过了别再派活」，不是「同一条投递我收过了」 |

于是两张表，各管一件事：`alert_windows`（一个 `(source, title)` 的当前窗口，持有一条群消息）与 `alert_events`（每一次投递一行，`UNIQUE(idempotency_key)`）。合成一张就没法表达「同一窗口内 N 次投递」，而那个计数正是消息里 `×N` 的来源。

`alert_events.window_id` 可空不是「可能没有窗口」，而是**顺序**：幂等声明必须是事务的第一条语句（抢不到 key 的重放要在碰任何窗口之前短路返回，连 seq 都不该分配），而那一步还不知道自己会落进哪个窗口。同一个事务内回填，所以提交后的行必有值。

## 四：`idempotencyKey` 必填，返回值比说明书多一个字段、少一个保证

- **必填**。5.8 把它列在入参里但没说可不可选；可选的幂等键等于默认不幂等，而 8.2 写这一句的正是要防「大量报同一件事」。发送方给不出这个键，就说明它自己都不知道自己是不是重发。
- 返回 `{messageId, deduplicated}`，比 5.8 多一个 `deduplicated`。少了它，发送方无法区分「这是我新起的一行」与「你早就收过这条了」，而这两种情况在响应上完全一样。
- `messageId` **可以为 null**：重放的那条消息可能后来被人删了（`alert_windows.message_id` 是 `ON DELETE SET NULL`），此时事件仍然记着、答案只能回一个 null。硬要回一个 id 就是编造。
- `source` 与 `title` 各自收紧（标签字符集 + 单行），因为聚合键是 `source + "\n" + title` 拼出来的：不给这个前提，`("a", "b\nc")` 与 `("a\nb", "c")` 会挤进同一个窗口。

## 五：这个签名 Uptime Kuma 算不出来——登记为缺口，不开第二条免签通道

7.1 的链路是「Uptime Kuma → webhook（HMAC）→ `/hooks/alert`」。按本节第一节的格式，**Kuma 的自定义 webhook 做不到**：它提供模板变量替换，不提供对**动态 body** 求 HMAC-SHA256 的能力，而签名的定义恰恰是 `HMAC(secret, timestamp + "\n" + body)`。

诚实的边界：**这一条没有拿真 Kuma 验证过**（本机没有部署它），能确定的是签名格式与它的模板能力之间不匹配。要接外部监控，需要的是中间加一层能算签名的转发（alertmanager 的 webhook config、或一个几百字节的 relay），而不是把 `/hooks/alert` 改成「带个 token 就行」。

本轮不为此削弱签名，因为这是栈里**唯一一个没有登录态、却能往群里写消息**的入口。仓库内现在唯一的调用方是 `infra/backup/notify-alert.sh`，它按这一节的格式发，并且实测送达。

## 六：一把事务当锁，不用 advisory lock 也不排队

并发同 `(source, title)` 的两条投递撞在 `alert_windows.agg_key` 的 unique 索引上：输的那个等赢的 COMMIT，然后对自己的 `DO UPDATE` 重新求值，看到刚写进去的 `message_id`，于是改走「更新那行」而不是「再发一条」。窗口行因此既是记录也是互斥锁。

- 不额外上 `pg_advisory_xact_lock`：效果相同，但锁的粒度从「看得见的那行」变成「一个凭空造的名字」，而且多一个谁都没法从表里看出来的失败模式。
- 不排队（Redis / 队列）：加一个组件去解决一个行锁能解决的问题，而聚合的正确性必须在**插入的那一刻**成立——排队会让「5 分钟内合并」变成「取决于消费者什么时候醒」。

实测：20 条并发投递（`Promise.all`，各自独立连接）产出**恰好一条**消息、`hit_count = 20`、20 个 seq 里只有一个被用掉（测试断言群内 `meta` 命中该 source 的消息数为 1）。

## 七：进群的那一行只带**第一条** detail

窗口保存 `first_detail`，后续命中不改它。第二个、第七个失败的完整原因只在 `alert_events.detail` 里。

理由是 8.2 自己：告警风暴时后端必须能承受，而「把七条 detail 拼在一条消息里」正是把一次故障变成一次可读性事故。代价说清楚：同标题不同原因的两次失败，群里只看得到第一次——实测的那次就是 `停在「第 1 步 pg_dump」`，而 `未配置 RESTIC_REPOSITORY` 只进了表。要看全部，`select detail from alert_events where fingerprint='backup-failed' order by id desc`。

detail 在渲染时截到 1000 字（`ALERT_DETAIL_MAX_CHARS`），契约里的 20000 是**存**的上限；`meta.alert.truncated` 说清有没有截。

## 八：两个新错误码，都不在 8.1 的表里

| 码 | 状态 | 为什么不是复用现成的 |
|---|---|---|
| `HOOK_SIGNATURE_INVALID` | 401 | 用 `UNAUTHENTICATED` 会让运维以为是登录掉了；这个端点根本没有登录态。401 而不是 403：对方没有证明任何身份，不是「有身份但没权限」 |
| `OPS_GROUP_NOT_CONFIGURED` | 503 | `NOT_FOUND` 会说成「群不存在」，而真实原因可能是 `SYSTEM_GROUP_ID` 没配。503 + `details.reason`（`env-unset` / `group-not-found`）才指得对方向；报 500 更糟，那会让运维去查代码 |

`apps/web/src/copy.ts` 里那张 `Record<ErrorCode, string>` 是穷尽的，所以两码各配一句中文——少一句不会报错，只会静默落进「出了点问题，请稍后再试」那句兜底。这是那道闸门存在的意义。

## 落点确认（10.2 那一条「手动 curl 一条告警」）

手册 10.2 要求手工验一次。本轮做的是它等价而且更强的版本：真容器、真签名、真失败。

| 事件 | 结果 |
|---|---|
| node 直发一条 info | `200 {"messageId":6,"deduplicated":false}` |
| `notify-alert.sh` 直发一条 warning（detail 含引号与反斜杠） | `200 {"messageId":7,...}`，群里 detail 逐字符回来 |
| `pg_dump` 认证失败（ERR trap） + `RESTIC_REPOSITORY` 未配（`die()`） | 两次都送达，**合并成同一行**：`【critical】备份失败 ×2 / backup · 01:19:01 → 01:19:11 UTC / 停在「第 1 步 pg_dump」（第 59 行）` |
| 故意换一把错的密钥 | 日志给 `HTTP/1.1 401`（busybox wget 不打印错误响应体，但状态行足以区分 401 / 503 / 连不上） |
| 缺 `ALERT_HMAC_SECRET` | 一行「跳过（告警不会送达）」+ 退 0，备份本身不受影响 |

上面这些消息与窗口行事后都清了（`select count(*) from messages where group_id=1` = 0），`/backups` 里没留下测试用的 dump。
