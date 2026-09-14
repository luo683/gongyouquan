# 0011：`/internal/metrics` 的覆盖范围与两处刻意不做

- 日期：2026-09-14
- 状态：open
- 关联章节：`01-后端说明书.md` 第 4.6、4.7、9.2 节；`03-AI运维手册.md` 巡检项 12-18、剧本 1 与剧本 3
- 关联决定：`0007-rate-limiting-tradeoffs.md` 第四节（`ops` 模块未开始，告警没有落点）

4.7 的原话是：这些指标「不是『有了更好』，而是 `03-AI运维手册.md` 里若干巡检项与自愈剧本的**输入**，缺一项就等于那条巡检失效」。这句话同时决定了实现原则：**只报能真实测到的**。一个缺失的指标是一条失效的巡检；一个看起来合理但含义不对的指标，会让巡检脚本据此触发处置——那比缺失更糟。

## 一：`broadcastMs` 没有实现，巡检项 17 因此失效

4.7 列了 `broadcastMs` p50/p99（histogram），运维手册巡检项 17 用它判断「消息投递延迟」，阈值 800ms / 2000ms，处置建议是「检查是否有重活抢占 CPU」。

服务端**测不到投递延迟**。能测的只有 `io.to(room).emit(...)` 这个调用的耗时，那是**入队耗时**，不是投递——Socket.IO 的 emit 把帧交给引擎就返回了，之后经过内核缓冲、网络、对端事件循环的时间都不在其中。

把这个数字挂在 `broadcastMs` 名下，巡检项 17 会永远显示一个很小的值（入队通常微秒级），于是：

- 真正的投递延迟问题**永远不会触发告警**；
- 一旦因为别的原因触发了，处置建议会把 agent 引向「查 CPU 抢占」，而真实原因可能是网络。

**当前实现决定**：**不实现**，并在本节写清楚。要补的话只有一条诚实的路——客户端回报：让接收方对 `message:new` 回一个 ack，服务端测量「commit → ack」的往返。那要改协议、给每条广播加一次往返，代价与收益需要需求方权衡。

替代信号已经给了：**`eventLoopLagMs`**。剧本 1 用 `broadcastMs` 想回答的问题是「是不是有重活抢占 CPU」，而事件循环延迟**直接**回答这个问题，且服务端能真实测到。所以诊断能力没有丢，丢的是那个特定阈值。

## 二：输出是 JSON，不是 Prometheus 文本

4.7 的表格用了 `gauge` / `counter` / `histogram` 这些 Prometheus 词汇，但栈里**没有 Prometheus**：运维手册的巡检脚本是 `curl` + `jq`（巡检项 12 写的是「`GET /internal/metrics` → `wsConnections`」，那是取字段，不是 PromQL）。

**当前实现决定**：扁平 JSON。理由是与真实消费者一致；引入 Prometheus 文本格式就得同时引入一个 scraper，而那是 `ops` 模块的事（`0007` 第四节：`ops` 未开始）。

若将来接 Prometheus，加一个 `Accept` 分支输出文本格式即可，字段名不变。

## 三：`outboxPending` 与 `outboxLagSeconds` 必须是两个字段

两者都在 4.7 与 9.2 里出现，但含义完全不同：

| 字段 | 含义 | 谁消费 |
|---|---|---|
| `outboxPending` | `processed_at IS NULL` 的**条数** | 巡检项 18（> 500 告警，> 2000 严重），剧本 7 |
| `outboxLagSeconds` | 最老未处理事件的**年龄秒数** | `/readyz` 的 `outboxLag` |

混为一谈的后果在本地已经真实发生过：`readyz` 报 `outboxLag: 2519`，而表里只有 **2** 条待处理。2519 是 42 分钟，不是两千五百条。把年龄读成条数，会让「一条没人消费的旧事件」看起来像「大规模积压」，进而触发一次完全没有必要的 meilisearch 重启。

**当前实现决定**：两个字段都出，命名里带单位（`Seconds`）。已记进交接文档坑 17。

## 四：5xx 速率的分母排除了探针

`/healthz`、`/readyz`、`/internal/*` 不计入 `httpRequests5m`。`infra/deploy/docker-compose.yml` 里的健康检查配的是 **5s 与 10s 一次**（`interval: 5s` / `interval: 10s`），巡检脚本还要另加一轮，算进分母会把真实的错误率稀释到接近零——巡检项 15 的阈值是「> 1%/分钟」，一个每分钟 6 次的探针足以把 5% 的真实错误率压到 1% 以下。

已实测：三次 `/api` 调用加两次探针，`httpRequests5m` 正好是 **3**。

顺带一提，运维手册巡检项 15 原本是「解析 pino 日志最近 5 分钟」。直接给数比解析日志可靠（日志格式变了不会静默失效），所以这里同时给了分子与分母，巡检项 15 可以改成读 metrics 而不再解析日志。**这一条需要回头修订运维手册。**

## 五：9.2 的对账任务还没做

9.2 列了六项进程内定时对账（`groups.last_seq >= max(messages.seq)`、打回次数对账、outbox 积压、presence 泄漏、`files.ref_count` 抽样、悬挂 attachments），要求「结果写入日志与 `/internal/metrics`」。

**当前只做了 presence 泄漏那一项**（4.6 的 30 秒兜底扫描，`onDrift` 钩子），因为它是唯一不依赖未实现模块的：

| 对账项 | 状态 | 卡在哪 |
|---|---|---|
| presence 泄漏 | **已做**（`src/presence.ts` 的扫描 + `presenceDrift` 指标） | —— |
| outbox 积压 | **已做**（`outboxPending` / `outboxLagSeconds`） | —— |
| `groups.last_seq >= max(messages.seq)` | 未做 | 不卡，只是还没写；注意它是全表扫描，不能放进 metrics 抓取路径，要按小时定时跑 |
| 打回次数对账 | 未做 | `tasks` / `task_status_history` 模块未开始 |
| `files.ref_count` 抽样 | 未做 | `files` 模块未开始 |
| 悬挂 attachments | 未做 | `files` 模块未开始 |

另外 `onDrift` 目前只能 `console.error`：**告警入口在 `ops` 模块里，而那个模块还没开始**（`0007` 第四节）。等 `/hooks/*` 与 `system:notice` 落地后，这个钩子应该改成推到 `#运维告警` 群。
