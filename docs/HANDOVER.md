# 交接文档：工友圈

- 编写日期：2026-09-15（`/hooks/alert` 落地、`notify-alert.sh` 有了签名发送方之后更新；同日更早一次更新写的是备份异地那一段的第一次真跑，上一版重写于 2026-09-14 深夜，替换同日那份被 mojibake 损坏且已过期的版本）
- 适用仓库：`E:\工友圈`（远端 `git@github.com:luo683/gongyouquan.git`）
- 交接起点：`feat/contracts-foundation` 分支，`HEAD = 0f5435b`，工作区干净
- 设计真源：`docs/specs/` 下三份说明书（**不要改原文**，矛盾与缺口走 `docs/decisions/`）

---

## 1. 一句话现状

后端骨架与 `auth / groups / members / messages / sync` 五个垂直切片均已落地，并已在**真实 PostgreSQL 17.11** 上跑通、固化成集成测试；**已读回执、typing、presence（含在线快照）、@提及四条都已两侧打通**；`sync:hello` 已接通，服务端 `contractVersion` 现在真的会到浏览器；浏览器端（React + Vite）可真聊、未读徽标会消、成员管理可逐条点通、能 @ 人并收到「@我」列表。运维闭环起步：`/internal/metrics` 已按「只报能真实测到的」实现；`infra/backup/` 五个脚本 + `Dockerfile` 已在 compose 里接成 `backup` 服务，由 supercronic 调度、`backup-health.sh` 做新鲜度探活；**恢复演练不是文档而是真跑过**——本轮跑的是「从 restic 仓库里取回来的那一份」，七道检查全绿，外加五条各自以 1 退出的负向用例。**`backup-once.sh` 的异地那一段（restic）也是这一轮第一次被执行**：之前 `RESTIC_REPOSITORY` 一直是空的，所以那四行从来没被检验过——跑通之后发现手册 8.2 的 `restic forget` 缺 `--group-by tag`，而 dump 文件名带时间戳使每晚快照各成一组，**保留策略实际上一个都删不掉**（双向实测），连同另外四处偏离一起登记在 `decisions/0014`。部署栈的密钥已改成必填插值，缺任何一个 `docker compose config` 直接拒绝解析（见 `decisions/0012`）；备份容器与手册之间的三处出入登记在 `decisions/0013`。**告警终于有落点了**：`POST /api/v1/hooks/alert` 做 HMAC 验签、幂等键与 5 分钟聚合窗口，命中后把一行告警经 outbox 发进系统群；`infra/backup/notify-alert.sh` 是它的第一个（也是目前唯一一个）发送方，`backup-once.sh` 那条 `ERR` trap 从此指向一个真实存在的文件，`presence.onDrift` 也不再只打 `console.error`。**签名的取舍全部登记在 `decisions/0015`**，其中第五节是一个没有解决的缺口：7.1 设想的 Uptime Kuma 签不出这个名。**三道闸门本地全绿（236 用例），且 `/hooks/alert` 是真在跑起来的栈上验过的**，不是 dry run。**仍不可对外部署**——缺的是 `tasks / files / search` 三个整块未动的模块（`ops` 已经不是，但它只有 `/hooks/alert` 这一条路，审批闭环与 outbox worker 都还没有）、Electron 外壳、systemd / `opsctl`。**数据库、核心收发链路、以及「备份到底能不能恢复」这一条不再是阻塞项**；备份还缺的两件都不是代码：一个不在同一台机器上的 restic 仓库，和一把私钥放在机器外的 age 密钥。

---

## 2. 仓库、分支与远端

| 项 | 值 |
|---|---|
| 默认分支 | `main`（停在基线 `a322610`，尚未合并任何开发提交） |
| 开发分支 | `feat/contracts-foundation`，**领先 `main` 65 个提交**（本文档自身的更新紧随其后，单独一个 docs 提交） |
| 当前 HEAD | `0f5435b docs(decisions): 0015, what "HMAC 签名" has to mean before it can be coded` |
| 标签 | `m0-foundation` → `a322610`（仓库基线） |
| 远端 | `origin` = `git@github.com:luo683/gongyouquan.git`，SSH，账号 `luo683` |
| Git 身份 | `user.name=luo683`，`user.email=3012390263@qq.com` |
| 提交约定 | `type(scope): summary`；一次提交只做一件可验证的事；不使用 `--force` |

基线之后 65 个提交（旧→新，最后五条是本轮补的）：

```text
3464abd feat(contracts): add shared transport schemas
1deca38 fix(repo): forward recursive pnpm flags correctly
59067d9 feat(server): add health and readiness probes
6a04e96 feat(server): validate startup environment
ab7a4c0 feat(server): add socket runtime bootstrap
7361672 feat(server): add runtime and database foundation
015fde8 feat(auth): add invite login and refresh rotation
0ac2666 feat(groups): add membership guards and group crud
c88068c fix(contracts): add error codes the server mapping can emit
051eb26 docs: add project handover
a256498 test(server): run auth and groups SQL against a real PostgreSQL
5fc4a12 ci: verify feature branches and add a real PostgreSQL job
c82d4f8 docs: register what the first real-database run contradicted
80c8fab docs: retire the database blocker from the handover and README
1dcec86 feat(db): load migrations from the folder and stamp messages with updated_at
06e1842 feat(contracts): describe the messages and sync wire format
93f78f7 docs: register the messages/sync contract gaps
3237b30 refactor(http): let an error carry machine-readable details
a053c57 test(server): one shared fixture harness for the real-database suites
2d495ce feat(server): write, edit and revoke messages against the real database
8aa9f82 docs: record the outbox orphan trap and the two revoke rows
10817c7 fix(server): answer 201 on a completed registration
a4a241b feat(server): sync watermarks, replay and read positions
bd1f69e test(server): two real clients chat over a real database
9d4953e docs: bring the handover and README up to the sync module
3422e91 feat(http): token bucket limiter with an injectable clock
71d749f feat(server): enforce the spec 8.2 limits and add logout-all
7557df0 test(server): cover logout-all and a refresh storm against the real database
6331c70 docs: record the rate limiting trade-offs and a bug the gate missed
08f5a71 feat(web): a browser client that actually talks to the backend
0276ecb docs: record that the browser client now exists
f975363 chore(lint): give the repo a linter that can actually fail it
f6d5637 feat(deploy): one command from empty volume to two people chatting
7124e7d docs: mark rate limiting and the local deploy path as done, and name what is not
7d4f25b feat(server): member management and invite codes, cell by cell from spec 3.4
2ab03f8 fix(web): clear the unread badge when a room is opened
543e432 docs: rewrite the handover against the tree as it actually stands
3f7124c feat(server): read receipts in two tiers, per spec 4.4.3
1ccf126 docs: bring the handover up to the receipts slice
645bc9f feat(web): member management the server already supported
7ac2b9c docs: record the member panel and the two things it cost to find
b6736d2 feat(web): show read receipts, paying for each tier only when it is earned
be37bef docs: record the receipts display policy and the createGroup half-open room
de27a8d feat(server): typing relay and presence per spec 4.6
c2e2bab docs: register the typing and presence gaps, and correct the cold-start story
a533923 feat: wire the sync:hello handshake and put a presence snapshot in it
3bbc7f5 feat: @mentions end to end, with the leak they could have caused closed
7add47d docs: register the mention gaps and close out the sync:hello fork
2237856 feat(server): /internal/metrics, reporting only what can be measured
8f7aa11 docs: register what /internal/metrics deliberately does not report
4d1eda1 feat(infra): backup scripts, with the restore drill run against a real dump
314d098 docs: put the real health-check intervals in the metrics decision
0d152f9 docs: bring the handover up to the ops loop, including what the drill proved
2af1026 feat(deploy): secrets become required, so the stack cannot boot on a committed value
60d7455 docs: register that the manual's secret recipe cannot produce a usable DATABASE_URL
5dd2822 feat(backup): the backup container, with the drill run against a restored database
1f2ecd1 docs(decisions): 0013, the manual's backup service cannot back up its own secrets
b94796c docs: bring the handover up to the backup container, with what the first run said
f025c5e docs(decisions): 0014, the manual's restic forget line never removes anything
31b1dde fix(backup): make the restic leg verify, prune and refuse instead of pretending
92a6cb8 docs: bring the handover up to the restic leg, with what the first run said
b10d61b feat(ops): /hooks/alert, so an alert finally has somewhere to land
1bbbc6d fix(deploy): a blank optional variable means unset, which is all compose can send
b06b26e feat(backup): notify-alert.sh, so a failed backup says so out loud
0f5435b docs(decisions): 0015, what "HMAC 签名" has to mean before it can be coded
```

---

## 3. 目录结构

```text
工友圈/
├── apps/server/            后端单进程服务（Fastify + Socket.IO）
│   ├── src/auth/           邀请码注册、登录、refresh 轮换、logout / logout-all
│   ├── src/groups/         群 CRUD + 成员管理（members*.ts / member-routes.ts）
│   ├── src/messages/       写入、编辑、撤回、历史分页、回执、@提及、bus 广播
│   ├── src/sync/           水位、补投、读位点
│   ├── src/ops/            `/hooks/alert`：HMAC 验签、聚合窗口、告警消息渲染
│   ├── src/http/           错误封装、Bearer 鉴权、令牌桶限流
│   ├── src/db/             连接池（含 `stats()`）、迁移加载器、advisory-lock 幂等迁移
│   ├── src/presence.ts     在线状态内存映射 + 30 秒兜底扫描（4.6）
│   ├── src/metrics.ts      `/internal/metrics` 采集器（4.7），4.7 表里 `broadcastMs` 刻意不实现
│   ├── src/cli/create-admin.ts   首个账号引导（一次性）
│   ├── src/runtime.ts      单进程装配 + Socket.IO 线
│   └── tests/              27 个测试文件（含 integration/ 与 e2e/）
├── apps/web/               浏览器端（React + Vite + TS），复用 contracts schema
│   └── src/{App.tsx,api.ts,copy.ts,syncStore.ts,main.tsx,styles.css}
├── packages/contracts/     共享契约（Zod schema + 类型），前后端唯一真源
├── infra/db/               docker-compose.yml（dev PG）+ migrations/（0001-0003）
├── infra/deploy/           docker-compose.yml + Caddyfile + 两个 Dockerfile + .env.example + gen-secrets.sh
├── infra/backup/           Dockerfile + backup-once.sh / backup-loop.sh / restore-drill.sh / backup-health.sh / notify-alert.sh
├── docs/specs/             三份说明书原件（01-后端 / 02-前端 / 03-AI运维）
├── docs/decisions/         矛盾与缺口登记（0001-0015）
├── eslint.config.js        根级 ESLint（flat config），lint 现为真实闸门
└── .github/workflows/      CI（见 §7）
```

`infra/backup/` 五个脚本都已经有镜像与 compose 服务了（`backup`，由 supercronic 调度，见 §4 运维闭环）。**唯一还差真东西的是 `notify-alert.sh` 的外部发送方**：它自己就是一个能签名的调用方，而 7.1 设想的 Uptime Kuma 签不出这个名（见 `decisions/0015` 第五节）。

---

## 4. 已经做到的

### 契约层 `packages/contracts`

- ID 一律字符串、时间戳必须带时区偏移（`apiTimestampSchema`）
- 游标分页 `cursorPageSchema`、补投分页 `syncPageSchema`（两者形状不同，别混用）
- 统一错误包装 `errorEnvelopeSchema` + 错误码枚举
- auth 请求 schema、群组 DTO（含 `unreadCount` 限界 `[0,100]`，100 是「99+」哨兵）
- messages / sync 线格式：`messageDtoSchema`（含 `updatedAt`，即 4.3.4 覆盖依据）、`messageSendResultSchema`（用 `deduplicated` 统一 WS 与 HTTP 的 ack 形状）、`syncHello / syncReady / syncPull / messageSyncPage`、读位点与已读回执、`wsErrorPayload`
- `clientMsgId` 在契约层就要求 UUID（原来只 `min(1)`，会让幂等键形同虚设）
- 已读回执：`messageReceiptsQuerySchema` 的 `detail` 用 `z.enum(['0','1'])` 再 transform 成数字，**没有**用 `z.coerce.number()`——coerce 会把畸形输入静默变成 `0`，等于替客户端猜意图，一个坏客户端会永远「成功」
- typing / presence：`typingSignalSchema`（客户端→服务端，就一个 `groupId`）、`typingEventSchema`（服务端→客户端，带 `userId`）、`syncReadySchema` 里的 `online: z.array(entityIdSchema)` **是必填**——少了它「无人在我群里在线」和「服务端没告诉我」这两种情况在 UI 上就分不开，而后者恰恰是 4.6 禁止画成离线的那种
- @提及：`mentionDtoSchema`（说明书从未定义过这个对象，见 `decisions/0010` 第一节）、`mentionQuerySchema`（`unreadOnly` / 跨群 `cursor` / `limit` 上限 100）

### 服务端 `apps/server`

| 能力 | 位置 |
|---|---|
| `/healthz` 存活、`/readyz` 就绪（DB 未就绪 → 503 `NOT_READY`，Meili 失败不拦） | `src/health.ts` |
| 启动配置校验（`parseEnv`，缺关键变量即启动失败） | `src/config/env.ts` |
| Fastify + Socket.IO 单进程装配、幂等优雅关闭、握手鉴权（`auth.token`，HS256） | `src/runtime.ts` |
| PostgreSQL 连接池 + advisory-lock 幂等迁移 + checksum 防篡改；迁移按目录 `NNNN_*.sql` 排序加载 | `src/db/` |
| Bearer 鉴权（过期 `TOKEN_EXPIRED`、无效 `UNAUTHENTICATED`，不查库） | `src/http/auth.ts` |
| 统一错误封装、code→HTTP 映射、`HttpError(code, details)` 携带机器可读 details | `src/http/errors.ts` |
| 令牌桶限流 + 可注入时钟（login 双维度 / register / refresh 会话族 / 发消息双维度 / 写接口兜底，429 带 `Retry-After`） | `src/http/rate-limit.ts` |
| **auth**：邀请码注册（同事务消耗次数）、Argon2id、登录、refresh 轮换、旧 token 重用→整族撤销、logout、logout-all（返回 `revokedCount`） | `src/auth/` |
| **groups**：建群（创建者 owner）、群列表（`includeArchived` 默认 false）、详情（含 `myMembership`）、成员列表、改群信息 | `src/groups/routes.ts` |
| **成员管理与邀请码**：加人（被移除者复活原行）、踢人 / 退出（owner 须先转让）、改角色、转让群主（同事务两行一起动）、邀请码增/查/撤销；code 只在创建响应出现一次 | `src/groups/members*.ts`、`member-routes.ts` |
| **messages**：`alloc_group_seq` 同事务发号、`(sender_id, client_msg_id)` 幂等重发、历史分页、15 分钟编辑窗 / 2 分钟撤回窗（按 3.4 两行分开）、撤回留痕与 `/raw` 分级、每次变更同事务写 outbox；提交后经 bus 广播 `message:new/updated/deleted`（完整 DTO，非 diff） | `src/messages/`、`bus.ts` |
| **已读回执**：`?detail=0` 只付 `{readCount, totalMembers}`，`detail=1` 才多一次 `users` JOIN 付名单（4.4.3 的分级）；两侧都排除发送者、都只算 `removed_at IS NULL` 的成员；`:gid` 与消息实际所属群不符时**先于**成员判定返回 404，不可用来探测别群消息 id；排除发送者用 `IS DISTINCT FROM` 而非 `<>`，因为系统消息 `sender_id` 为 NULL，`<> NULL` 会把所有行过滤掉、静默报 0/0。取舍见 `decisions/0008` | `src/messages/repository.ts` `receipts()` |
| **sync**：`sync:hello` 水位（只报调用者真正在的群）、`sync:pull` 按当前状态补投（不重放事件）、`asOfSeq` 永不倒退、`read:update` 双向 `GREATEST` 位点 | `src/sync/` |
| **presence / typing**：在线状态只放进程内存（`Map<userId, Set<socketId>>`，不落库，4.6），多端只在集合**变空**时广播离线；`disconnect` 里**同步第一行**移除（放在 `await` 之后会在断开期间仍算在线、并向死连接广播）；30 秒兜底扫描**先量漂移再清理**（清理会修好泄漏，事后量就永远是干净的，探针等于没有）；`typing:*` 转发到房间且排除发送者，转发前查 `socket.rooms` —— 因为 `socket.to(room)` 不管发送者在不在房间里都投递 | `src/presence.ts`、`src/runtime.ts` |
| **@提及**：`mentions` 由客户端给 id（服务端**校验**而不解析 body：去重、丢自己、丢非成员、上限 50），与消息同事务写 `message_mentions`（含冗余 `group_id` + `seq`，6.6 要求单索引可答「@我未读」）；提交后经 bus 的**个人通道**推 `mention:new` 到 `user:{uid}`；`GET /me/mentions` 跨群、游标是 messageId、`unread` 由 `mentions_read_seq` 在 SQL 里派生。**撤回消息的正文在这个列表里被置 null**，否则会绕过 `/raw` 的 owner/admin 门禁。取舍见 `decisions/0010` | `src/messages/`、`bus.ts` |
| **`/internal/metrics`（4.7）**：抓一次即得 `wsConnections / presenceMapSize / presenceSocketCount / presenceDrift`、`pgPoolTotal/Idle/Waiting`、`outboxPending`（条数）与 `outboxLagSeconds`（年龄，**两个字段不能合一**，见 `decisions/0011` 第三节）、`heapUsed`、`eventLoopLagMs`、`http5xxCount5m / httpRequests5m / http5xxRate5m`、`syncPullRequests`、`contractVersion`。守卫是「loopback 直接放行，其余必须带 `INTERNAL_METRICS_TOKEN`」——因为巡检与 Docker 健康检查本来就从 loopback 与容器网发起。`onResponse` 钩子把 `/healthz`、`/readyz`、`/internal/*` **排除在 5xx 分母之外**（`infra/deploy/docker-compose.yml` 里的健康检查是 5s 与 10s 一次，算进去会把真实错误率稀释到接近零）。**`broadcastMs` 刻意不做**：服务端只能测到 `io.to().emit()` 的**入队**耗时，把它挂在投递延迟名下会让巡检项 17 永不告警、一旦告警又把 agent 引向错误的处置方向；替代信号是 `eventLoopLagMs`。取舍全文见 `decisions/0011` | `src/metrics.ts`、`src/runtime.ts` |
| **`/hooks/alert`（`ops` 的第一条路）**：守卫是**签名**而不是 Bearer，所以要的是**原始字节**——Fastify 默认的 JSON 解析给出对象，而签名没法对「重新序列化」的结果校验（空白、键序、`\u` 转义过一轮 parse/stringify 就变了）。因此这个作用域自己 `addContentTypeParser('application/json', {parseAs:'string'})` 并用 `WeakMap` 按 request 存原文（**注册在子实例上而不是 `app`**：换掉根的解析器会连带改变其他所有路由对畸形 JSON 的回答）。检查按**代价顺序**而非契约顺序：验签 → 限流 → schema，反过来则签不出的人还能先花掉那 120/分钟——而 8.2 要求正是出事那一刻这个入口得活着。命中后走「一条事务 = 一次告警」：领幂等键 → 过期旧窗口 → UPSERT `alert_windows` → 发帖或改写 → 回填 `alert_events`。窗口是 **5 分钟翻滚**（`opened_at` 锚定，不是滑动，否则持续告警会永不到期），**滚动时 severity 一并重置**（否则一次 03:00 失败、之后已恢复的备份会到中午还挂着 `【critical】`，这就是运维群被静音的方式）。幂等键**必填**，重复投递返回 `deduplicated: true`；`messageId` 可空（还没落消息的窗口就是空）。聚合结果经 outbox 变成系统群里的一行 `【severity】标题 ×N / 来源 · 时间窗 / detail`。取舍全文见 `decisions/0015` | `src/ops/`（`hmac.ts`、`hooks-routes.ts`、`alert-repository.ts`、`alert-service.ts`、`alert-message.ts`、`presence-drift.ts`） |
| **告警渲染**：一行正文 = 标题（多次则 `×N`）+ 来源与 UTC 时间窗 + `first_detail`（**只有第一条** detail 进运维群，其余留在表里）。时间戳解析不了时**原样打印**而不是 `NaN:NaN:NaN`——那行坏消息是这整条链路上唯一告诉人出了什么事的东西，它不该长得像另一个 bug。detail 超长按显示截断并在 meta 里标 `truncated`（全文不存） | `src/ops/alert-message.ts` |
| **`presence.onDrift` 接上告警**：漂移不再只打 `console.error`，而是 `ingest` 一条 `presence-sweep` / warning / 指纹 `presence-drift` 的告警；**告警失败绝不能把巡检弄崩**，所以是 `.catch(onError)`，而 `onError` 默认才退回 console | `src/ops/presence-drift.ts`、`src/main.ts` |
| Socket.IO 线：`sync:hello / sync:pull / message:send / message:edit / message:delete / read:update / typing:start / typing:stop`；出站另有 `presence:updated`、`typing:*`（带 `userId`）、`read:updated`（群房间）与 `mention:new`（**个人房间 `user:{uid}`**，758 行）；ack 一律是契约载荷或 `{error:{code,message}}`，`typing:*` 按 739 行**没有 ack** | `src/runtime.ts` |
| **首个账号引导**：`docker compose run --rm server node --import tsx src/cli/create-admin.ts` —— 一次性建 用户 + 系统群 + 邀请码并打印，登录自校验；重复运行拒绝；不在启动时自动执行 | `src/cli/create-admin.ts` |

**已注册的 HTTP 路由**（`/api/v1` 前缀，除 health / auth / `hooks` 外均需 Bearer——`hooks` 的凭据是签名，它比 Bearer 更严：没有登录态可借用）：

```text
GET    /healthz, /readyz
POST   /auth/register, /auth/login, /auth/refresh, /auth/logout, /auth/logout-all
POST   /hooks/alert                       (HMAC 签名，无登录态；限流 120/分钟整桶共享)
POST   /groups                         GET /groups, /groups/:gid, /groups/:gid/members
PATCH  /groups/:gid
POST   /groups/:gid/members            PATCH /groups/:gid/members/:uid   DELETE 同路径
POST   /groups/:gid/invites            GET /groups/:gid/invites          DELETE /groups/:gid/invites/:iid
POST   /groups/:gid/messages           GET /groups/:gid/messages
GET    /groups/:gid/messages/:mid/receipts        (?detail=0|1，4.4.3 分级)
GET    /me/mentions                               (?unreadOnly=1&cursor=，跨群)
PATCH  /messages/:mid                  DELETE /messages/:mid             GET /messages/:mid/raw
GET    /groups/:gid/sync, /groups/:gid/sync-state    POST /groups/:gid/read

# 不在 /api/v1 前缀下、也不走 Bearer：守卫是「loopback 放行 / 其余需 INTERNAL_METRICS_TOKEN」
GET    /internal/metrics
```

### 浏览器端 `apps/web`

- 邀请码注册 / 登录、群列表带服务端未读数
- **冷启动按 4.3.2 走 `sync:hello`→`sync:ready`→`sync:pull`**：连上即发 hello（带各群本地水位，从 ref 镜像读，重连时才是「现在」的群而不是登录时那批），`sync:ready` 过 `syncReadySchema` 校验后落水位、补投、存在线快照、记下 `contractVersion`。ack 只用来报错，不重复处理载荷——它与 `sync:ready` 是同一份数据，两边都处理会把水位应用两次。（此前客户端**从不发 hello**，`sync:ready` 是死代码、版本守卫从未生效，见 `decisions/0009` 第三节，已接通）
- **契约版本只显示、不比对**：客户端没有构建期算出的 contracts hash 可比（§5 第 7 条），所以侧栏如实展示服务端下发的值。编一个假常量去 diff 只会「看起来像守卫而永不触发」，比没有守卫更坏
- **「@我」**：输入框上方是一排成员 chip（点选即插入 `@名字` 到草稿并记下 id），发送时带 `mentions`；侧栏「@我」入口带会话内计数，展开是跨群列表（群名 + 谁 + 正文 + 未读标记），点一条跳到那个群。**刻意不从正文里解析 `@名字`**：显示名不唯一，名字不是身份
- **在线标记**：成员面板里每人一枚「在线」标签，种子来自 `sync:ready` 的快照、之后由 `presence:updated` 增量维护，所以刷新后立刻就是对的，而不是要等谁碰巧重连
- 发送与撤回走 socket ack；4.3.4 客户端状态机（`syncedSeq / pendingNew / eventBuffer`）抽成纯模块 `syncStore.ts`，有 9 个无浏览器单测
- **「谁正在输入」**：输入时节流发 `typing:start`（3 秒一次），停顿 3 秒或发送即发 `typing:stop`；收到的每条 start 各自带一个 6 秒 TTL——739 行说这些信号可丢，中途消失的人永远不会发 stop，没有 TTL 就会一直挂着。页脚显示「某某 正在输入…」
- 中文文案全部由 `code` 在前端映射（`copy.ts`，`errorEnvelope.message` 只进日志）；`RATE_LIMITED` 把等待秒数拼进提示；角色名（群主/管理员/成员）也在 `copy.ts`
- **成员管理面板**（房间右上角「成员 N」展开第三栏）：成员列表带角色徽标、按 ID 加人（可选角色）、移出群、设为/取消管理员、转让群主、邀请码生成（可选角色与次数）/列表/撤销、退出本群。移出与转让是**两步内联确认**（不用 `window.confirm`，理由同 `window.prompt`）。按钮显隐按调用者自己的角色收敛，而角色是从成员列表里找到自己推出来的——`GET /groups/:gid` 虽然返回 `myMembership`，但契约里没有这个字段的 schema
- **已读回执展示**：自己发的消息下挂一枚安静的「已读到 N/M」chip，滚进可见区才由 `IntersectionObserver` 拉聚合档（`detail=0`）并缓存，点开才付名单档（`detail=1`）；`read:updated` 到达时按**缓存里已有的档位**重取（一律用 0 会让正展开的名单凭空消失）。文案是「已读到」而非「已读」——4.4.4 要求，位点会追认。`totalMembers` 为 0 时整个 chip 不渲染。展示策略是说明书明确交给产品侧的，取舍见 `decisions/0008` 第五节
- 侧栏内联「新建群」表单（不是 `window.prompt`）；建群后走 `chooseGroup` 而不是直接 `setSelected`，否则新房间是半开的（成员面板还显示上一个群的人、不加入 socket 房间、不收历史与补投）
- 所有响应过 Zod schema；BIGINT id 全程字符串，前端无 `Number(id)`
- **但 `api.ts` 本身一条测试都没有**：web 的 9 个用例只覆盖 `syncStore.ts`（纯模块，`environment: 'node'`，没有 jsdom）。所以下面坑 15 那个缺陷能一路活到有人在真浏览器里点一次才暴露——**闸门全绿不等于前端能用**
- **刻意没有**「已登录用户凭邀请码入群」输入框：说明书 3.1 第 209 行把邀请码定义为**注册时**消耗，无任何接口让已有账号兑换，加了只会必然报错

### 部署 `infra/deploy`

- **密钥全部必填，仓库里一个口令都没有了**。起法：`cp infra/deploy/.env.example infra/deploy/.env` → `infra/deploy/gen-secrets.sh` → `docker compose -f infra/deploy/docker-compose.yml up -d --build`（**这台机器上 `--build` 不可用**，见 §11 坑 25；本机验证过的一键块在 §9 本节末）。栈现在是四个服务：`db` / `server` / `web` / `backup`。compose 里五个密钥（`POSTGRES_USER/DB` 与 `POSTGRES_PASSWORD` / `JWT_SECRET` / `MEILI_MASTER_KEY` / `ALERT_HMAC_SECRET` / `RESTIC_PASSWORD`）都是 `${VAR:?…}`，缺任何一个 `docker compose config` **拒绝解析**（实测：`error while interpolating services.db.environment.POSTGRES_PASSWORD: required variable POSTGRES_PASSWORD is missing a value`）。`:?` 对**空值同样报错**，所以 `.env.example` 里那五把钥匙是留空的——复制了没生成就必然起不来
- `gen-secrets.sh` 逐把校验字符集与长度、数一遍五把确实互不相同、**拒绝覆盖已存在的 `.env`**。为什么是脚本不是一段说明：见 `decisions/0012` 第五节
- **整套栈在注入的密钥下真跑通过**（2026-09-14）：`/readyz` healthy（就绪判定要求真连上库，所以这条同时证明了插值出来的 `DATABASE_URL` 能用）、`create-admin` 建号并自校验登录、`POST /auth/login` 出 token、带 token 的 `GET /groups` 返回系统群、不带 token 401。**旧的 `db/01-set-password.sql` 已删除**（它声称的理由在当前镜像上复现不出来，而它实际做的事是把凭据写进仓库；见 `decisions/0012` 第三节）
- **换密钥对已有数据卷无效**——`POSTGRES_PASSWORD` 只在空数据目录时被应用一次。本机默认项目那个已有卷已按 `ALTER USER` 轮换（容器内 psql 走 localhost trust 行，所以不需要旧密码），换完 `up -d` 全绿；**别的项目/机器上重做这件事时，直接 `up` 会得到一个 28P01 且报错不提「卷是旧的」**
- Caddy 只反代 `/api/*`、`/socket.io/*`、`/healthz`、`/readyz`，**`/internal/*` 不在其中**，所以 metrics 天然只存在于容器网内——这一点是上面那个 loopback 守卫成立的前提。**但「不在其中」的表现不是 404 而是 200**：`GET :8080/internal/metrics` 落到 SPA 的 `try_files … /index.html` 兜底，返回 200 + 395 字节 HTML。body 里没有指标，可**任何用 `curl -f` 或只看状态码的巡检都会把它读成「能访问」**。守卫另一侧也实测过：从 db 容器访问 `server:3000/internal/metrics` → **403**，从 server 容器自己访问 `127.0.0.1:3000` → 200 + JSON。所以巡检脚本必须 `docker exec` 进 server 容器里跑，或者带上 `INTERNAL_METRICS_TOKEN`
- `create-admin` 在容器里的可用命令要带 `--workdir`：镜像的 `WORKDIR` 是 `/app` 而 `tsx` 只装在 `apps/server` 下，所以 `docker compose run --rm server node --import tsx src/cli/create-admin.ts`（本文档旧版的写法）报的是 `Cannot find package 'tsx' imported from /app/`。验证过的写法：`docker compose -f infra/deploy/docker-compose.yml run --rm --workdir /app/apps/server server node --import tsx src/cli/create-admin.ts --username <名>`（Git Bash 下要加 `MSYS_NO_PATHCONV=1`，见 §11 坑 21）
- **compose 只能把「没填的可选项」传成空字符串，所以服务端必须把 `""` 当未设置。** `SERVER: '${SYSTEM_GROUP_ID:-}'` 这种写法在变量没填时传的是**空串而不是缺席**，而 zod 的 `z.string().min(1).optional()` 会拒空串 → 进程**启动即失败**。现在四个可选项（`SYSTEM_GROUP_ID` / `OPS_APPROVER_GROUP_ID` / `CONTRACT_VERSION` / `INTERNAL_METRICS_TOKEN`）过一层 `blankToUndefined`。**必填的那几把钥匙刻意没有这层**：那里空值必须继续报错（见上面的 `:?`），把「没填」和「填了个空」统一成一条错误路径正是必填的意义所在。**这个不对称是刻意的，不是漏改**——判定标准是「这个变量缺席时服务还能不能有意义地跑」。附带效果：`SYSTEM_GROUP_ID` 现在真的能设了，也就是 `/hooks/alert` 有一条能落进系统群的消息（此前它是必填的 `min(1)`，compose 又只能传空串，等于**在生产栈里根本设不了**）

### 运维闭环 `infra/backup`（手册 8.1-8.3）

- **`backup-once.sh`** —— 手册 8.2 的实现：`nice -n 19 pg_dump -Fc -Z6` + `pg_dumpall --globals-only | gzip`，然后**必须** `pg_restore --list` 通过且 TOC 条目数 > 0 才算成功（「只生成文件不算备份」）。`.env` 只在有 age 公钥时加密带走，**否则跳过而不是明文落盘**。异地未配置时**直接失败退出**，除非显式 `ALLOW_LOCAL_ONLY=1`——一个只会写本地的脚本在服务器报废那天等于没有备份。成功后写 `last_success.json`（巡检项 20 读它的 mtime，项 21 读它指向的 dump），本地暂存留 3 天
  - **失败现在会说话**：每步开头改 `STEP=`，`ERR` trap 报「停在「第 N 步 …」（第 X 行）」，六个步骤各有名字。**`die()` 也单独通知一次**，因为 `exit 1` 不触发 `ERR`、而 `|| die …` 里的命令失败同样不触发——不补这一句的话，本轮修的那两类失败（dump 校验不过、restic 仓库不存在）恰好都是走 `die` 的，也就是最需要说话的那两类。用 `$LINENO` 而不是 `$BASH_COMMAND`：后者是**已展开**的命令行，而 `export PGPASSWORD="$POSTGRES_PASSWORD"` 是脚本里的一行，展开出来就是把数据库口令打进一条会发到运维群的告警里
- **`restore-drill.sh`** —— 手册 8.3 的实现，**刻意写成 POSIX sh**：stock `postgres:17-alpine` 里有 psql / pg_restore / createdb 但**没有 bash**，而这个脚本最自然的执行位置就是那个临时容器内部。七道检查，**退出码就是结论**（不打印一堆数字让人自己判断）：dump 可读性（放在恢复**之前**，恢复一个坏 dump 会得到半个数据库，那比恢复失败更难发现）、核心表可查、行数下限、最新 10 条**文本**消息正文非空、引用完整性（悬挂 attachments / mentions / memberships）、`schema_migrations` 非空（否则恢复出来的库启动时会重跑迁移、可能与已恢复的结构冲突）、`alloc_group_seq` 可调用。**七道全部是致命的**，只有全局对象恢复是警告——它在 `--no-owner` 路径上本来就不被依赖。目标库已存在则**拒绝执行**——对着有数据的库演练分不清哪些行是恢复出来的。`pg_restore` 的输出不再丢进 `/dev/null`：失败时打末尾 25 行，因为这个脚本最常见的执行场景是「服务器已经没了，对着异地副本试一次」，那时报错文本是唯一线索
  - **本轮修掉的两处**：3.3 原先把「正文为空」当截断证据，但 `messages.body` 在 `0001_init.sql:150` 就是可空的（`image / file / system / task_card` 没有正文）——**第一张图片就会把演练判成失败**，而一个总是指控错了的演练下次真出事时没人当真；现在限定 `kind = 'text' AND deleted_at IS NULL`。3.6 原先失败时打一行「需人工确认」却**仍无条件 ok**——没有人在读那行警告，退出码才是结论
- **`backup-loop.sh`** —— backup 容器的 entrypoint：crontab 由 `BACKUP_HOUR`/`BACKUP_MINUTE` 生成而不是写死在镜像里（改时间不该重建镜像）；启动时先自检 `pg_dump / pg_restore / restic / age / openssl`（缺 pg 客户端直接 fatal，因为没它这个容器毫无意义；**restic 用 `restic version` 子命令而不是 `--version`**，统一拼法会打出 `unknown flag: --version`，让这份「工具链到底在不在」的证据日志长得像装坏了；**缺 openssl 是警告而不是 fatal**——没有它备份照样做得成，只是失败时发不出告警，为此把整条备份停掉是把「没人说话」看得比「没有备份」更重）；若 `last_success.json` 已超过 26 小时则**立即补跑**——容器可能正好在 03:00 不在运行，而「等明天那一班」意味着那一整天没有任何副本。实测启动输出：`pg_dump (PostgreSQL) 17.11` / `pg_restore 17.11` / `restic 0.18.1` / `age v1.3.1` / `OpenSSL 3.5.8 25 Aug 2026`
- **`Dockerfile`** —— 基座是 `postgres:17-alpine` 而不是「node 镜像 + postgresql-client」，理由就是手册 8.2 那句 `pg_dump` 大版本必须与服务器一致：跟着服务器同一个 tag 走，对齐是结构性的而不是需要提醒的。五个 apk 包各有独立理由（`bash` 因为 `set -euo pipefail` 的 pipefail 对 `pg_dumpall | gzip` 是承重的；**`openssl` 因为 `notify-alert.sh` 要算 HMAC-SHA256**——基座镜像有 libcrypto 但**没有 `openssl` 这个命令行**，busybox 的 wget 也没有任何 HMAC 能力，而 `/hooks/alert` 只收签名过的请求。这是五个包里唯一一个「缺了就整条失败路径静默」的：备份坏了没人说话，而且没有任何一行日志说为什么没人说；`age` 缺了会让 `.env` 静默不进备份；`supercronic` 取 apk 包而非 `curl|sh` 拉 GitHub 二进制）。镜像 424MB → 522MB。**显式 `chmod 755` 是承重的不是保险**：`git ls-files -s` 显示这几个脚本在仓库里就是 `100644`（在 Windows 工作树里 add 的，执行位从没进过 index），所以 `COPY` 进去就是不可执行的——少了那行，后果是凌晨三点 supercronic 拿到一个 `Permission denied` 写进日志没人看。**注意 `ENTRYPOINT` 已占用**：`docker run IMAGE sh -c '…'` 会把 `sh -c …` 当成**参数交给 backup-loop.sh**，于是它开始跑调度并永不退出；一次性命令必须 `--entrypoint sh`（踩过，卡了 120 秒）
- **compose 里的 `backup` 服务**（`infra/deploy/docker-compose.yml`）—— `depends_on: db: service_healthy` + `server: service_started`，挂 `uploads:ro` + `backups` 卷 + `./.env:/opt/chat/.env:ro` + `./age:/etc/age:ro`，`no-new-privileges`。环境变量新增 `ALERT_HMAC_SECRET`（与 server 同一把，签名要对得上）与 `ALERT_URL: http://server:3000/api/v1/hooks/alert`。**对 server 只要 `service_started` 而不是 `service_healthy`**：备份要的是「03:00 那一刻 server 已经在启动队列里」，而不是「此刻 `/readyz` 是绿的」——真到出事那天，最该发得出告警的恰恰是 server 半死不活的时候，把 healthcheck 设成硬门会让备份在故障时**连带**不跑。**`mem_limit: 256m` 是对手册 2.4 那个 100m 的刻意偏离**（超出部分正是 `pg_dump -Z6` 的压缩缓冲与 restic 的上传，而被 cgroup 无预警杀掉的是备份——下一个需要恢复的人只会发现副本停在三天前）；上线前按真实数据量重测。**这里有个第一轮没发现的洞**：`AGE_RECIPIENT_FILE=/etc/age/recipient.pub` 写好了却什么都没挂，于是公钥永远不存在、`.env` 永远不会被备份，而手册 4.3 说这是后果最严重的一项。改成挂**目录**而不是挂文件，是为了避开「bind mount 一个不存在的文件时 Docker 会在目标处造出空目录」那个坑（同文件 `.env` 那行的注释里已经记过一次）
- **`notify-alert.sh`** —— `/hooks/alert` 的**签名客户端**，也是 `backup-once.sh` 那条 trap 现在指向的文件。为什么它在备份目录而不是 `ops` 的某个 ts 文件里：备份容器里没有 node，而有 `openssl` 与 busybox 的 `wget`——`openssl dgst -sha256 -hmac` 与 node 的 `createHmac` 是**逐字节兼容**的（这一点单独对过：同一串输入两边算出同一个 hex），所以不必为了「能签名」往这个镜像里塞一个运行时。`printf '%s\n%s' "$TS" "$BODY" | openssl …`，签名对象是 `timestamp\nbody`，与服务端一致。几个刻意的决定：
  - **没有 `set -e`**。一个「通知别人出事了」的脚本自己因为一条 `grep` 返回非 0 而半路死掉，是最坏的一种失败——它连「我没能发出通知」都来不及说。缺参数、缺 `ALERT_HMAC_SECRET`、缺 openssl 时**直接退出 0 并打一行原因**（跳过不是失败），只有 POST 真的失败才退 1
  - **两次尝试，复用同一份签名字节**（`sleep 3` 后重发）。重签一次会得到不同的时间戳，也就等于在说「这条告警发了两次」；而 ±300 秒的容差内同一个签名可以重复用，重试要的正是「同一条」
  - **`one_line()` 把 title 里的 CR/LF 折成空格**——因为标题是聚合键的一半，一条带换行的标题会让同一个故障在窗口表里裂成两行。`json_escape()` 先 `tr -d` 控制字符、再按**反斜杠在前**的顺序替换（后反斜杠会二次转义引号）
  - **本轮在它身上翻的一次车，是跑出来的不是读出来的**：手写 JSON 模板 + 「可选字段前置一个逗号」的拼法，在给了 `fingerprint` 时拼出 `{"title":"x",,"fingerprint":"y""detail":…}`——两个逗号撞在一起、又少一个，服务端回 **400**。`bash -x … | grep BODY=` 一眼看到。现在改成把字段塞进一个变量、逗号由拼接负责。这类手拼模板的地方只会被下一个可选字段再咬一次
  - **能看到的只有状态行**：busybox 的 `wget` 会把服务端返回的 `error.code` 吞掉，日志里只有 `HTTP/1.1 401 Unauthorized` 这一行。判断过不值得为它换个客户端：401 / 503 / 连不上 三态已经足够定位（分别是密钥不匹配、系统群没配、server 没起），所以不装 curl。**这是本机验证过的边界，不是通用结论**
  - **真跑过的证据**（不是 dry run）：在跑着的栈里把 `backup-once.sh` 的 `pg_dump` 指到一个不存在的库，几秒后系统群出现这一行，`hitCount` 由并发的第二条命中合并而来 —— `【critical】备份失败 ×2` / `backup · 01:19:01 → 01:19:11 UTC` / `停在「第 1 步 pg_dump」（第 59 行）`。同一次验证里，故意换一把错的 `ALERT_HMAC_SECRET` 发出去，得到 401 且群里什么都没多
- **`backup-health.sh`** —— 巡检项 20 在这个栈里的落点。**它是第二道防线，不是唯一一道**：`notify-alert.sh` 现在真的存在了，可告警链路自己也会断——密钥不同步、server 正在重启、`SYSTEM_GROUP_ID` 没配（→ 503），这几种情况下「备份失败」这条消息发不出去而**发出失败这件事本身也没有别的出口**。healthcheck 不依赖任何对端，挂成 Docker 的，`docker compose ps` 就会显出红色。阈值 26h（与 `backup-loop.sh` 的补跑阈值同源）。输出顺带报出 `last_success.json` 里的异地模式（`ok：上次备份 0 小时前，异地=local-only`）以及 restic 快照 id——**但 local-only 不判为失败**：还没配 restic 的装机第一天会拿到一个永久红色的容器，而一个总是红的灯没有人读。让它可见，不让它失败
  - **变红这件事单独验过**：清空 `/backups` 之后 `docker inspect` 的健康日志依次记 `ExitCode 0` → `1` → `1`，输出是那行「没有任何成功备份…」。`interval: 10m` × `retries: 3`，所以**状态翻转最多要 30 分钟**，不是立刻
  - **两类失败的最坏发现时延不一样**，这决定了这两个探针各值多少：`last_success.json` 整个不见了（卷被清、被误删）→ 下一次探针就报 1，**≤10 分钟**；备份每晚都失败但**昨天那份 marker 还在**→ 只有等它过期，也就是 **26 小时 + 至多 10 分钟**才**被 healthcheck** 发现。而这第二种恰恰是 `backup-once.sh` 常规失败的样子——它现在由 `notify-alert.sh` 在**当晚**就说出来（见上一条的真跑证据），healthcheck 那条 26 小时的线因此退化成「告警链路自己也断了」时的兜底。**两道防线覆盖的是同一个洞的两种塌法，不是重复**

**演练已经真跑过，不是文档**。本轮跑的是**容器自己产出的那一份**（上一轮跑的是手工对 `gyq_dev` dump 出来的），这样演练覆盖的才是真实链路而不是它的近似：先在栈里种下真数据（`create-admin` 建 `drillboss` + 邀请码注册 `drillmate` + 三条消息 + 一次 @ 人 + 一次相同 `clientMsgId` 的重发），再由 `backup-once.sh` dump，再灌进一个一次性 `postgres:17-alpine`：

```text
PASS，exit 0：恢复 0s / 演练总 1s；TOC 202 个对象；dump 78,735 字节
用户=4 群=4 成员=6 消息=3 提及=1；核心表齐全；无悬挂引用；
schema_migrations=2（所以恢复出来的库可以直接启动）；alloc_group_seq 可调用；
pg_restore (PostgreSQL) 17.11；角色 gongyouquan 经 globals_*.sql.gz 真的落到了目标集群
（那条单独验过，因为 `--no-owner` 路径平时并不需要它，坏了也不会被人看见）
```

顺带看到的一件事（**注意它的边界**）：重发同一个 `clientMsgId` 是在**活栈上**做的，返回 `200` 且 `id` 仍是 `1`，没有产生第四行；因此 dump 里就是 3 条，恢复出来的副本也查到 3 条。**这不是「在恢复出来的库上重演了一次幂等」**——那一件事没测，也就是 `messages_client_msg_key`（`0001_init.sql:161`，一个带 `WHERE client_msg_id IS NOT NULL` 的**部分**唯一索引）在恢复后是否仍然拒绝重复插入，本轮没有证据。要测的话很简单：往 `chat_drill`（`KEEP_DB=1`）里用同一个 `(sender_id, client_msg_id)` 插两次，第二次应该以 `23505`（唯一约束）失败，而不是安静地多出第二行。

另外 `GLOBALS_FILE` 指向一个不存在的文件时是 `FAIL` 而不是跳过——这条是撞出来的，不是我设计的：那次 `docker cp` 因为 §11 坑 21 没把文件送进去，脚本拒绝了而不是默默继续，这正是应有行为。

**异地那一段（restic）本轮第一次真跑。** 在此之前 `RESTIC_REPOSITORY` 一直是空的，所以 `backup-once.sh` 每次都走 `ALLOW_LOCAL_ONLY` 分支——**8.2 第 4 步那四行从来没有被执行过，也就从来没有被检验过**。初始化一个仓库（restic 0.18.1）跑四次之后的实测：

```text
pg_dump → 202 个 TOC 对象 / 79,127 字节 / pg 17.11（与服务器同版本）
restic backup → db / secrets / uploads 三个 tag 各一个快照
restic check  → load indexes / check all packs / check snapshots,trees,and blobs → no errors
restic restore latest --tag db 取回的 dump → 与原件 sha256 逐字节相同（49a8defccdf3…），202 个对象
env-backup.age 从仓库取回 → age 解密 → 与 /opt/chat/.env 逐字节相同（2,362 字节）
★ 恢复演练跑的是「从仓库取回的那一份」而不是本地暂存那一份 → 七道全绿，PASS exit 0
  用户=4 群=4 成员=6 消息=4 提及=1
uploads 快照 → 0 B（这台机器的 uploads 卷是空的，所以「附件能进能出」这条还没有内容支撑）
```

跑通之后暴露出四个缺陷，全部登记在 `decisions/0014`：

| 缺陷 | 为什么要紧 | 现在怎么做 |
|---|---|---|
| **`restic forget` 缺 `--group-by tag`** | restic 默认按 `host,paths` 分组，而 dump 文件名带时间戳 → **每晚快照各成一组、每组只有它自己**，`keep-daily 7` 一个都删不掉，仓库无限增长。手册 8.2 那一行就缺这个参数，照抄它的脚本永远不会真正回收空间 | 四条 `forget` 全部加 `--group-by tag`；`--prune` 从每条上摘下、改成末尾一次 `restic prune` |
| `command -v restic` 挂在 `if` 条件上 | 镜像里 restic 缺失时**一路掉进 `ALLOW_LOCAL_ONLY` 分支**，只留一行「未配置 restic」的假警告；而这条栈的 `ALLOW_LOCAL_ONLY` 默认是 1，等于默认开着一条静默降级路径 | `RESTIC_REPOSITORY` 非空就只走 restic，任何前置不满足都 `die`，绝不落回本地 |
| 备份后从不确认仓库里真有这个快照 | `restic` 退出 0 被当成「异地有副本」；而巡检项 22「异地备份新鲜度」在这个栈里**根本没有数据源** | 取 `restic backup --json` 的 `snapshot_id` 反查 `restic snapshots <id>`；`last_success.json` 新增 `restic_snapshot` / `restic_time`，`backup-health.sh` 把快照 id 打进健康输出 |
| `[ -d "$UPLOADS_DIR" ] && restic backup …` | 附件卷没挂上时静默跳过，脚本照样写出成功标记 → 一个「只有数据库、没有任何附件」的**成功备份** | `UPLOADS_DIR` 不存在则 `die`；`/caddy-data` 保持可选（这条栈根本没有 caddy 服务） |

`--group-by` 那条是**双向实测**的，不是推理：同一仓库、同一 `--tag db`、同一 `--keep-daily 1`，不加 `--group-by` 打出两个「keep 1 snapshots」组、保留 2 删 0；加上则 `remove 1`。用生产档位（14/8/6）再跑 `--dry-run`：加分组是「keep 3 / remove 1」一次应用，不加分组是**四次**独立应用、删 0。

保留天数顺手也统一了，因为手册自己给的两个数对不上：**8.1 的 PostgreSQL 那一行是「异地 14 日 / 8 周 / 6 月」，而 8.2 与 6.12 都是 7/4/6**。现在按 8.1 的对象级数字分两档（db+secrets 走 14/8/6，uploads+caddy 走 7/4/6），方向是只多不少。这一条仍需拍板，见 `0014` 第二节。

负向验证因此从三条变成五条：

| 负向用例 | 结果 |
|---|---|
| `ALLOW_LOCAL_ONLY=0` 且没有 restic | `FATAL: 未配置 RESTIC_REPOSITORY…`，exit 1 |
| dump 截断到 3000 字节 | `FAIL: dump 不可读，演练终止`，exit 1，**在第 0 道闸门就停下、根本没尝试恢复**（上一轮用 4000 字节做过一次，本轮换 3000 重做以确保仍然咬得住） |
| `/backups` 清空后跑 healthcheck | `没有任何成功备份：…不存在`，exit 1 |
| **`RESTIC_REPOSITORY` 指向不存在的路径** | `FATAL: restic 仓库不存在或未初始化：… 核对路径与凭据后手动执行 restic init`，exit 1（**刻意不自动 init**：对着拼错的路径 init 会「成功」，然后每天把备份写进一个谁都不会去恢复的空目录。restic 自己这时退 10，外层按 `-eq 1` 判断会漏） |
| **`UPLOADS_DIR` 指向不存在的目录** | `FATAL: … 附件卷没有挂上，不会当成备份成功`，exit 1 |

两条新负向都确认了**失败没有把上一次的好标记覆盖掉**——`last_success.json` 仍然指向最后一个真正成功的 dump，这是巡检项 20 不被骗过的关键。另外验了装机第一天那条路径：把标记文件移走后重启容器，`backup-loop.sh` 在约 1 分钟内自己补跑出 `offsite: "local-only"`、`env_backed_up: true`，healthcheck 绿。

**还缺的**（本轮之后剩下的都不是工程问题）：

- **一个真的在机器外的 age 密钥。** 本轮为测通链路生成过一把（`age-keygen` 在容器里，公钥挂进 `/etc/age/recipient.pub`），验到「加密 → 从 restic 取回 → 解密 → 与 `/opt/chat/.env` 逐字节相同（2,362 字节）」。然后**连公钥、那个测试仓库、卷里所有 `env-backup.age` 一起删掉了**——留下的公钥比没有公钥更危险：`backup-once.sh` 会照常加密并报告 `env_backed_up: true`，而那份密文再也解不开（私钥当时只在容器的可写层里，重建即消失）。删掉之后重跑了降级路径确认仍然安全：`警告：找不到 age 或 recipient 公钥，跳过 .env 备份（不会明文落盘）` → `env_backed_up: false` → 在 `/backups` 里 `grep -rl "POSTGRES_PASSWORD="` 无命中。`infra/deploy/age/` 整目录在 `.gitignore` 里。真要上线，缺的是「私钥归谁、放在哪」，不是代码。
- **一个不在同一台机器上的 restic 仓库。** restic 这一段本轮已经跑通（见上），但仓库在 `/backups/restic-repo`——**和它声称要保护的那台机器一起消失**。所以 `0013` 里那句「配上 restic 仓库就删掉 `ALLOW_LOCAL_ONLY` 的 `:-1` 默认」**这一轮没有兑现，也不是忘了**：同机仓库不算异地。要删那一行需要真的指向对象存储或另一台机器的 `RESTIC_REPOSITORY`（手册 4.4 那对 `OSS_ACCESS_KEY_*`，restic 的 s3 backend 读它）。详见 `0014` 第七节。
- **告警的发送方还只有一个，而它不该是唯一一个。** `notify-alert.sh` 这一轮落地了（在镜像里、真跑通、失败当晚就说话），但它只覆盖「备份自己失败」。手册 7.1 设想的 **Uptime Kuma 签不出这个名**——它没有「对 `timestamp\nbody` 做 HMAC-SHA256 并放进 `x-alert-signature`」这种自定义能力，所以那一路要么换一个能签的调用方，要么在中间放一个转换器。这是一个**没有解决的缺口**，不是待办里的实现细节，见 `decisions/0015` 第五节。
- **附件那一段还是空的。** uploads 快照实测 0 B，因为这台机器的 uploads 卷里没有任何文件。8.3 演练要求的「从仓库恢复附件并抽查 sha256（通过率必须 100%）」因此做不了——要等 `files` 模块先存在，否则只能得到「0 个文件、通过率 100%」这种没有意义的结论。

### 测试与质量闸门（2026-09-15 本地实测）

```text
pnpm lint        eslint .                          → 0 error（lint 已是真实闸门，不再是空转）
pnpm typecheck   3 包全过
pnpm test        无库机器：contracts 31 + web 9 + server 113 通过，server 另有 83 个真库用例整片 skip（8 个文件）
真库闸门         INTEGRATION_DATABASE_URL 设上后 server 196 全过（27 文件，含真库集成与 e2e 双人聊天）
合计             32 文件 / 236 用例，全绿（2026-09-15 用 §9 那份 Node 22 复跑确认）
连续三轮 infra    改 Dockerfile 与 compose 接线、改 restic 那一段、改备份的失败通知，三道闸门各复跑一次，
                 前两轮数字一字未变——因为**它们管不到 `infra/backup/`**：那两轮改的全是 shell 脚本、Dockerfile、
                 compose 与 .gitignore，没有一个 `.ts`。那条路只能靠 §4 运维闭环里那些真跑出来的数字，
                 `pnpm test` 全绿不代表备份能用。本轮不一样：`/hooks/alert` 是真 `.ts`，
                 所以「脚本调用它」这一侧第一次同时被 `pnpm test` 和被 §4 那条 401 实测覆盖到
```

### 未读徽标与读位点（已提交 `2ab03f8`）

`api.read()` 一直存在但没人调用，未读数因此只增不减。现在两条路径都会推进位点：

1. 打开一个群：`chooseGroup` 里 `await` 完补投后调用 `advanceRead(groupId, syncedSeq)`，**进群即清掉该群徽标**。
2. 群正打开时有新消息到达：`message:new` handler 判断消息落在当前群，是则再推一次。

socket handler 只注册一次，闭包里的 `selected` 会过期，所以用 `selectedRef` 镜像；`chooseGroup` **同步**写这个 ref，避免 `await` 期间到达的消息被拿去和刚离开的群比较。`advanceRead` 服务端是 `GREATEST` 单调的，过期调用无害；客户端另有 `lastSentRead` ref 去重，避免重复 emit。

`createGroup` 同时从 `window.prompt` 改成侧栏内联表单：模态框自动化浏览器驱动不了，也没法回显服务端拒绝名称的原因。

---

## 5. 还没做到的（按重要性）

1. **messages / sync 仍缺**：编辑/撤回窗口过期时 socket 侧对 `read:updated` 的推送、以及前端推进 `mentions_read_seq` 的入口（`decisions/0010` 第五节：侧栏「@我」计数目前是**会话内**口径，不是服务端已读）。**已读回执、`typing:*`、`presence:updated`（含 `sync:ready` 里的在线快照，前端成员面板已画「在线」）、`mention:new` 均已两侧打通。**
2. **整块未动的模块**：`tasks` / `files` / `search` 三个仍是空的。**`ops` 已经不再是**，但它只落了 `/hooks/alert` 这一条路：手册 7.x 的 `/hooks/ops-report`、`/hooks/ops-request`、`/ops/requests/:rid/decision`、`/ops/requests` 都还没有，**运维请求的审批闭环（谁批、批了之后谁执行）一条都没有**；另外 `alert_windows` / `alert_events` 两张表已经有了、`/hooks/alert` 的幂等与 5 分钟聚合也已经有了，剩下的 `ops` 工作里最大的一件其实不是路由而是 **outbox worker**——现在没有任何进程把事件推到终态，所以 `processed_at` 永远为空（`readyz` 的 lag 因此单调上涨，见 §11 坑 17 与 `decisions/0006` 缺口六）。
3. **成员管理收尾**：离职转交的批量入口、`notification_prefs`、成员列表的 `includeRemoved` 查询参数。
4. **改密接口**：`logout-all` 已实现，但目前只能由前端显式调用，没有「改密后强制全端下线」的入口。
5. **浏览器端仍缺**：Electron 外壳（`apps/desktop`）、改密入口、归档群入口。**成员管理界面与已读回执展示都已做**（真浏览器逐条点过），成员侧还差 `includeRemoved` 的历史成员视图与离职批量转交入口。
6. **部署仍缺**（按「做完才能上线」的顺序）：**systemd 单元与 `opsctl`**；**告警接入的服务端与备份侧已做**（`POST /api/v1/hooks/alert` 收签名、幂等、聚合；`notify-alert.sh` 在备份镜像里，`backup-once.sh` 失败当晚就会说话；`presence.onDrift` 也不再只打 `console.error`）——**剩下的是「谁来签」**：7.1 设想的 Uptime Kuma 产不出这个 HMAC，那一路要么换调用方要么加转换器，见 `decisions/0015` 第五节；**一把私钥在机器外的 age 密钥**（公钥挂载、加密、从 restic 取回、解密回环全部验过，见 §4 运维闭环；缺的是「私钥归谁、放哪」而不是代码）；**一个不在同一台机器上的 restic 仓库**（restic 分支真跑通了，但仓库在 `/backups` 同一个卷上，不满足 8.1，所以 `ALLOW_LOCAL_ONLY` 那个 `:-1` 例外**还不能删**，见 `decisions/0014` 第七节）。**备份容器已做**：镜像 + `backup` 服务接线 + `backup-health.sh` 探活，并且恢复演练跑的是「从 restic 仓库取回来的那一份」而不是本地暂存那一份（见 §4 运维闭环）。**生产 secret 注入已做**：compose 里五把钥匙全部必填、`gen-secrets.sh` 生成并校验、整套栈在注入值下真跑通（见 §4 部署）。说明书 9.2 六项对账里还剩四项（`groups.last_seq >= max(messages.seq)`、打回次数、`files.ref_count`、悬挂 attachments，逐项卡在哪见 `decisions/0011` 第五节）。`/internal/metrics` **已做**。
7. **`CONTRACT_VERSION` 仍是注入的常量**（fallback `dev-nohash`），不是说明书 §7 第 4 条要求的「contracts 包 hash 前 8 位」；构建期没有计算步骤。
8. **数据库侧只剩**：说明书 1685 行要求的 `EXPLAIN (ANALYZE, BUFFERS)` + 几千行样例数据的计划验证（见 `docs/decisions/0005`）。

---

## 6. 命令速查

```bash
pnpm install --frozen-lockfile     # 依赖已锁定，勿随手升级
pnpm lint                          # eslint .（真实闸门）
pnpm typecheck                     # 自动先构建 contracts（pretypecheck 钩子）
pnpm test                          # 自动先构建 contracts（pretest 钩子）
pnpm --filter @gongyouquan/server test
pnpm --filter @gongyouquan/web test
```

真实数据库闸门（不设 `INTEGRATION_DATABASE_URL` 时那 72 个用例整片 skip，`pnpm test` 在无库机器上依然全绿）：

```bash
docker compose -f infra/db/docker-compose.yml up -d      # postgres:17-alpine，宿主端口 55432
INTEGRATION_DATABASE_URL="postgres://gyq:gyq_dev_pw@localhost:55432/gyq_dev" \
  pnpm --filter @gongyouquan/server test
```

PowerShell 用 `$env:INTEGRATION_DATABASE_URL="..."` 单独一行。用例跑完会清掉自己造的数据，可对同一个库反复跑。

服务端 dev 启动（**需要先有可用的 PostgreSQL**；启动即执行迁移，库不可用则进程失败退出，`/readyz` 不假装就绪——刻意设计，见 decisions 0002）。本地手工验证时的最小 env：

```bash
NODE_ENV=development PORT=3100 \
DATABASE_URL="postgres://gyq:gyq_dev_pw@localhost:55432/gyq_dev" \
JWT_SECRET="<random>" UPLOAD_DIR="./uploads" \
PUBLIC_ORIGIN="http://localhost:5173" \
MEILI_URL="http://localhost:7700" MEILI_MASTER_KEY="<random>" \
ALERT_HMAC_SECRET="<random>" CONTRACT_VERSION="dev" LOG_LEVEL=info \
INTERNAL_METRICS_TOKEN="" \
pnpm --filter @gongyouquan/server dev
# 端口用 3100 而不是 3000：见 §9 的「端口不一定空着」
# INTERNAL_METRICS_TOKEN 是可选项：不设的话只有 loopback 能读 /internal/metrics
# 浏览器端：VITE_DEV_API_ORIGIN=http://127.0.0.1:3100 pnpm --filter @gongyouquan/web dev（Vite 5173）
```

手工验一条告警（手册 10.2 那条「手动 curl 一条告警 → 确认运维群收到」）。签名对象是 `timestamp` + `\n` + 原文 body 这**一整段字节**，不是正文单独：

```bash
BODY='{"source":"manual-test","severity":"warning","title":"手工一条","idempotencyKey":"probe-1","detail":"来自 §6"}'
TS=$(date +%s)
SECRET=$(grep '^ALERT_HMAC_SECRET=' infra/deploy/.env | cut -d= -f2)
SIG=$(printf '%s\n%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -s -X POST http://127.0.0.1:8080/api/v1/hooks/alert \
  -H 'content-type: application/json' \
  -H "x-alert-timestamp: $TS" -H "x-alert-signature: sha256=$SIG" \
  --data "$BODY"
# 走 8080（web/Caddy）而不是 3000：`server` 服务**没有发布任何宿主端口**，
# 而 Caddyfile 的 `handle /api/*` 会把它转给 server:3000。上面这条本机实测过：
# 换一把错密钥 → 401；换回对的 → 200 + {"messageId":"10","deduplicated":false}
# 从容器里发就别用 curl（镜像里没有），notify-alert.sh 用的是 busybox 的 wget，
# 它只打状态行、不打响应体——见 §11 坑 33
# 换一个 idempotencyKey 再发同一 source + 同一 title，才会看到 ×2 而不是新起一行
# （5 分钟翻滚窗口内）；同一个 key 重发返回的是 deduplicated: true
```

让备份真的失败一次，看它会不会说话（比上面的手工一条更接近真实路径，因为它走的是 `backup-once.sh` 的 trap）：

```bash
MSYS_NO_PATHCONV=1 docker exec gongyouquan-backup-1 sh -c \
  'PG_HOST=nonexistent /usr/local/bin/backup-once.sh'
# 期望：系统群里出现 `【critical】备份失败 ×N` + `停在「第 1 步 pg_dump」（第 X 行）`
```

---

## 7. CI 与它的盲区

`.github/workflows/ci.yml`：

- `quality` job：ubuntu-latest，node 22，pnpm 9.15.9，跑 `check:workspace` → `lint` → `typecheck` → `test`；不联网、快、稳。
- `integration` job：`needs: quality`，带 `postgres:17-alpine` service 容器与 `pg_isready` 健康检查，`INTEGRATION_DATABASE_URL` 只在这里设。
- 触发分支含 `main` 与 `'feat/**'`（带引号：裸 `**` 在 YAML 1.1 里有被当别名解析的风险）。

旧文档列的「lint 空转」「CI 只在 main 触发」「CI 里没有 PG」三条盲区**均已修**（`f975363` 引入 eslint flat config，两个子包都定义了 `lint`）。

---

## 8. 说明书里的矛盾与取舍（`docs/decisions/`）

0002-0015 多为 `open` 状态：**取舍已实现，但说明书本身还没修订**（0014 与 0015 里各有一节是「已实现但等你拍板」，另有一节是「没解决的缺口」而不是取舍，见 §10）。接手后若与产品/需求方对齐，应回头关掉它们。

| 文件 | 关键内容 |
|---|---|
| `0001-project-baseline.md` | 基线约定（accepted）。其中「lockfile 待生成」一条已过期 |
| `0002-database-spec-clarifications.md` | 5 处矛盾：DDL 执行范围、软删除 vs `ON DELETE CASCADE`、搜索索引范围、索引数量、容量估算 |
| `0003-auth-contract-clarifications.md` | `AUTH_INVALID_CREDENTIALS` 不在错误码表、邀请码 role 落点、注册事务边界 |
| `0004-groups-guards-and-archival.md` | guard 是否看归档态（224 vs 236 行自相矛盾）、归档群 PATCH 未定义、非成员读返回 403 还是 404 |
| `0005-real-database-findings.md` | 真库首跑暴露 6 条：**回滚不产生 seq 空洞（推翻说明书 4.2 与验收表第 2 项）**、未读不排除撤回消息、预览与未读对 `system` 口径不一致、硬删群连撤回留痕一起清掉、`files.uploader_id` 无级联、1685 行计划验证仍未做 |
| `0006-messages-sync-contract-gaps.md` | messages 缺 `updated_at`（已补迁移 0002）、WS 与 HTTP 的 send ack 不一致、`clientMsgId` 该不该收成 UUID、`asOfSeq` 定义会让客户端位点倒退、本轮只发得出 text/system |
| `0007-rate-limiting-tradeoffs.md` | 限流落地取舍 |
| `0008-receipts-semantics.md` | 已读回执四处规格没写死：`totalMembers` 是否排除发送者（验收项 9 只钉了分子）、`:gid` 与消息不符时的响应、系统消息 `sender_id` 为 NULL 的排除写法、撤回消息还能不能查回执；第五节是前端展示策略 |
| `0009-typing-presence-gaps.md` | 说明书**没有** server→client 的 typing 事件（只定义了客户端怎么发）、没有 presence 快照（**已按选项 A 补进 `sync:ready`**）、以及**既有缺陷：浏览器端从不发 `sync:hello`**（**已接通**），此前导致 `sync:ready` 是死代码、`contractVersion` 版本守卫从未生效 |
| `0010-mentions-gaps.md` | `MentionDTO` 说明书从未定义字段；第 161 行「解析 body 中的 @」与路由表的 `mentions?` 自相矛盾（取客户端给 id + 服务端校验）；**撤回消息正文不得从 `/me/mentions` 泄漏**（会绕过 `/raw` 门禁）；跨群游标用 messageId 且现有索引撑不住（待 1685 行的计划验证）；前端「@我」计数是会话内口径；`INSERTED_COLUMNS` 那句「新消息没有聚合」的注释被推翻，send 的 ack 必须重读 |
| `0011-metrics-coverage.md` | `/internal/metrics` 的四条取舍：**`broadcastMs` 刻意不做**（服务端只能测入队耗时，挂这个名字会让巡检项 17 永不告警、告警时又把 agent 引向错误处置；替代信号 `eventLoopLagMs`）、输出是**扁平 JSON 而非 Prometheus 文本**（栈里没有 Prometheus，巡检脚本是 `curl` + `jq`）、`outboxPending`（条数）与 `outboxLagSeconds`（年龄）**必须两个字段**、5xx 分母排除探针。第五节列了 9.2 六项对账里还剩哪四项 |
| `0012-secret-generation-and-uri.md` | 手册 4.1 的 `openssl rand -base64 48` 与手册 3.2 的 `DATABASE_URL: postgres://user:${POSTGRES_PASSWORD}@…` **合起来会坏**：base64 字母表含 `/` 与 `+`，约 87% 的生成结果至少含一个，`pg` 报 `Invalid URL`（实测）。现在 `POSTGRES_PASSWORD` 走 hex、其余四把仍 base64。另两节：`:?` 对空值也报错所以 `.env.example` 里密钥留空；`db/01-set-password.sql` 声称的理由复现不出来，故删除而不是模板化 |
| `0013-backup-service-env-mount-and-resource-gaps.md` | **手册 3.2 的 `backup` 服务实现不了手册 4.3 的要求**：4.3 要 `.env` age 加密随备份带走，而 3.2 只有 `env_file: [.env]`（注入环境、不留可读文件）+ `uploads`/`backups` 两个挂载，容器里既没有 `.env` 也没有放公钥的地方——失败方式是一行每天重复、没人读的警告。现在补了两个只读挂载，其中 `./age` **挂目录不挂文件**，因为 Docker 对「源文件不存在的 bind mount」会在目标处造空目录。另两节：`mem_limit` 用 256m 而不是 2.4 的 100m（**这个数字没有实测依据，上线前须按生产数据量重测**）；`ALLOW_LOCAL_ONLY` 是手册里没有的变量，把 8.1「本地副本不是备份策略」这条硬规则换成一处**显式、可见、配上 restic 后必须删掉**的例外 |
| `0014-restic-forget-group-by-and-retention-gaps.md` | **手册 8.2 的 `restic forget` 那一行永远不会删掉任何东西**：restic 默认按 `host,paths` 分组，而 dump 文件名带时间戳，于是每晚快照各成一组、每组只有它自己，`keep-daily 7` 一个都删不掉、仓库无限增长（**双向实测**：同一策略不加 `--group-by` 保留 2 删 0，加 `--group-by tag` 才删 1）。另五节：8.1 给 PostgreSQL 的是「异地 14 日 / 8 周 / 6 月」而 8.2 与 6.12 都是 7/4/6，**三处两不一致**，已按 8.1 的对象级数字分两档实现（只多不少）待拍板；`command -v restic` 挂在 `if` 条件上会让「配了异地但镜像里没 restic」静默退回本地；仓库不存在时**不替你 init**（对着拼错的路径 init 会「成功」，restic 自己退 10 而外层按 `-eq 1` 判断会漏）；`UPLOADS_DIR` 缺失不再静默跳过（否则「只有数据库、没有附件」也算成功备份）；巡检项 22 原本**没有数据源**，现在 `last_success.json` 记 `restic_snapshot`/`restic_time`。第七节：本轮跑通的仓库在**同机卷上，不算异地**，所以 `0013` 那条「配上 restic 就删 `ALLOW_LOCAL_ONLY`」还没到兑现的时候 |
| `0015-alert-hook-signature-aggregation-and-its-tables.md` | `/hooks/alert` 落地时**说明书没有给的东西**去哪了：①「HMAC 签名（无登录态）」必须先定成字节格式才对得上一把密钥——定稿为 `HMAC-SHA256(secret, "${timestamp}\n${rawBody}")`，头 `x-alert-timestamp` + `x-alert-signature: sha256=<hex>`，±300 秒容差，`timingSafeEqual` 前先比长度；②聚合是 **5 分钟翻滚窗口**（`opened_at` 锚定）而不是滑动，否则持续告警永不到期；**窗口滚动时 severity 必须一起重置**（不重置则一次已恢复的失败会在运维群里顶着 `【critical】` 活到永远，这是运维群被静音的标准路径）；③为什么要两张新表（`alert_events` / `alert_windows`）而不是给 `messages` 加列，以及 `alert_events.window_id` 为什么可空；④`idempotencyKey` 必填、重复投递以 `deduplicated: true` 回答、`messageId` 可空；⑤并发用**这条事务本身当互斥**（`alert_windows.agg_key` 上的唯一索引 + 行锁持到 COMMIT），而不是 advisory lock 或排队——前者的锁生命周期与数据变更不在同一个事务里，后者需要一个还没有的进程；⑥只有 `first_detail` 进运维群那一行，其余留在表里；⑦两个新错误码都不在 8.1 的表里：`HOOK_SIGNATURE_INVALID`（401，用 `UNAUTHENTICATED` 会让运维以为是登录掉了）与 `OPS_GROUP_NOT_CONFIGURED`（503 + `details.reason` 分 `env-unset` / `group-not-found`，报 `NOT_FOUND` 会说成「群不存在」而真因可能是压根没配）。**第五节是一个未解决的缺口而不是取舍**：7.1 设想的 Uptime Kuma 产不出这个签名（它没有自定义 HMAC 能力），**而这一条没有对着真实的 Kuma 验过**，措辞按此收敛 |

几个**已拍死、改之前先看 decision** 的行为：

- 归档群：读放行，写返回 `409 GROUP_ARCHIVED`（不是 403）。guard 不看归档态。
- 非成员读群详情/成员列表：返回 `404 NOT_FOUND`，不暴露群存在性；写操作才用 `403 FORBIDDEN_*`。
- `GET /groups` 的 `includeArchived` 默认 **false**（说明书没写，这是我们的选择）。
- 登录失败统一 `AUTH_INVALID_CREDENTIALS`，不区分用户名不存在与密码错误。
- 已读回执：`readCount` 与 `totalMembers` **都**排除发送者（说明书只钉了分子，见 `0008` 一节）；`:gid` 与消息实际所属群不符时，先于成员判定返回 `404`，不用 `403`。
- `/hooks/alert`：**验签先于限流**。把限流放前面看起来更省，实际是任何签不出名的人都能花掉真实发送方在出事那一刻需要的 120/分钟。已经这样定了，别按「便宜的检查先做」的直觉调回去。
- `/hooks/alert`：聚合窗口滚动时 **`severity` 一起重置**，不是一路取最大值。看似「保留最高级别更安全」，实际效果是运维群里那一行永远停在历史最高严重度上，直到有人把这个群静音。

---

## 9. 环境现状与阻塞

| 项 | 状态 |
|---|---|
| Node（仓库要求） | `>=22 <23` |
| Node（本机默认） | `v24.16.0` —— **超出范围**，每次 pnpm 调用刷 `Unsupported engine` 警告 |
| Node（可用 22） | `C:/Users/ROG/AppData/Local/hermes/node22/node-v22.23.1-win-x64/` —— 直接可用，本次交接全程用它跑闸门。把它前置到 `PATH` 即可消警告 |
| pnpm | 全局 11.x，仓库内被 `packageManager` 钉到 9.15.9（与 CI 一致） |
| Docker | 装在 `D:\Docker`（`Docker Desktop.exe`），引擎 ServerVersion 29.7.2。**daemon 不常驻**——用前先确认 `docker info` 通，不通就启动 Docker Desktop 再等就绪 |
| PostgreSQL 镜像 | `registry-1.docker.io` 超时，改走 `docker.m.daocloud.io` 镜像源；`postgres:17-alpine`（容器内 **PG 17.11**）已在本地 |
| 运行中的数据库 | `gyq-pg` 容器，宿主端口 **55432**（避开本机 5432），由 `infra/db/docker-compose.yml` 管理；带 volume `gyq-pgdata`，`down` 不丢数据，`down -v` 才丢 |
| 本机 psql | 未安装、不在 PATH —— 用 `docker exec gyq-pg psql -U gyq -d gyq_dev` |
| Shell 路径 | 工作目录可能呈 `\\?\E:\工友圈` 形式，个别命令报 `EISDIR: lstat 'E:'`，换普通盘符路径（`/e/工友圈`）可绕过 |
| `docker compose build` / `up --build` | **本机不可用**，`failed to dial gRPC: header key "x-docker-expose-session-sharedkey" contains value with non-printable ASCII characters`，在 bake 会话建立阶段就失败，一个字节都没开始编。`docker build` 同 Dockerfile 同上下文正常；A/B 见本节末。改 `COMPOSE_BAKE=false` 无效 |
| `gongyouquan-backup` 构建耗时 | 实测 `real 19m59s`，其中几乎全部是第一层 `apk add bash restic age supercronic`——**慢在 daocloud 镜像源，不在 Dockerfile**。这一层被缓存后重建只花 0.7 秒（本轮改脚本后重建过两次，都是这个数）。所以「改一行脚本要等二十分钟」是不成立的，但**全新机器第一次构建请先确信 daemon 在跑**（`docker info` 通）|
| 谁的 `.env` | `docker compose -f infra/deploy/docker-compose.yml config` 自动读的是 **`infra/deploy/.env`**（项目目录＝第一个 `-f` 文件所在目录）；而 `docker buildx bake -f 同一路径 --print` 从仓库根跑时找 **根目录 `.env`**，于是报「required variable missing」。同一个 `-f` 参数两种解释，别按其中一个的行为去推另一个 |

**结论**：数据库不再是阻塞项。两个持续的小麻烦：**本机默认 Node 版本超范围**（切到上面那份 v22.23.1 即可），以及 **`docker compose build` 在这个路径下不可用**（构建一律走 `docker build` + `up --no-build`，见本节末）。

**端口不一定空着**：上一轮会话留下的 dev 服务可能仍占着 3000（连同它自己的 Vite 占着 5173）。那个实例跑的是**旧代码**，`curl` 一下新加的路由就能分辨（注册了返回 401，没有返回 404）。别急着杀别人的进程——`vite.config.ts` 的代理目标和端口都能用环境变量覆盖，另起一套即可：

```bash
PORT=3100 ... pnpm --filter @gongyouquan/server dev          # 自己的后端
VITE_DEV_API_ORIGIN=http://127.0.0.1:3100 pnpm --filter @gongyouquan/web dev
```

**一键全栈（本机唯一可行的构建路径）**：`docker compose build` 在这台机器上跑不通，而 `docker build` 同一份 Dockerfile、同一个上下文正常。A/B 过：整棵树去掉 `node_modules` 与 `.git` 复制到 `C:\Users\ROG\gyq-ascii`（`node_modules` 本来就在 `.dockerignore` 里，对构建无影响），在那里 `docker compose -f infra/deploy/docker-compose.yml build server` 成功，回到 `E:\工友圈` 同样的命令失败——**唯一变量是路径里的中文**。报错是 buildx 在 bake 会话建立阶段拒绝一个含非 ASCII 字节的内部头，**具体是哪个字段带进去的属于 Docker Desktop 的问题，不在本项目范围内**。所以先 `docker build` 再 `up --no-build`：

```bash
cp infra/deploy/.env.example infra/deploy/.env   # 五个密钥故意留空
infra/deploy/gen-secrets.sh                      # 填上，拒绝覆盖已有 .env
docker build -f infra/deploy/Dockerfile.server -t gongyouquan-server .
docker build -f infra/deploy/Dockerfile.web    -t gongyouquan-web    .
docker build -f infra/backup/Dockerfile        -t gongyouquan-backup .
docker compose -f infra/deploy/docker-compose.yml up -d --no-build
MSYS_NO_PATHCONV=1 docker compose -f infra/deploy/docker-compose.yml run --rm \
  --workdir /app/apps/server server node --import tsx src/cli/create-admin.ts --username admin
# 已有 dbdata 卷时先轮换一次角色密码，否则后端会 28P01（见 §4 部署第 4 条）：
docker exec gongyouquan-db-1 psql -U gongyouquan -d gongyouquan -c \
  "ALTER USER gongyouquan WITH PASSWORD '$(grep ^POSTGRES_PASSWORD= infra/deploy/.env | cut -d= -f2)'"
```

**验收遗留数据**（`create-admin` + 注册产生，纯新增，可直接复用或删）：群 `验收群` id `714`（两人）与 `独人群` id `715`（只有 mate，用来验 `totalMembers=0` 时不渲染 chip）；账号 `boss`（id 771，口令 `Verify2026ok`，现为**管理员**）与 `mate`（id 772，口令 `MatePass2026`，现为**群主**）——两者是被转让过的，不是初始状态。另有一条 `BOOT-B4FA82BD6D47`（管理员 / 5 次）与一条已撤销的成员码。两个账号都在，浏览器验收不必重新造。

---

## 10. 接手后建议的第一步

1. 切到 Node 22（§9 路径直接可用），消掉 `Unsupported engine` 警告。
2. 拍板 `docs/decisions/0005` 的六条——尤其**矛盾一**：说明书 4.2 断言回滚会留 seq 空洞、验收表第 2 项要求「构造回滚事务 → 后续 seq 有跳跃」，但真库证明当前 `alloc_group_seq` 写法做不到。`asOfSeq` 那条「基石」的验收怎么写，取决于这个决定。
3. 拍板 `docs/decisions/0008` 一节：**`totalMembers` 到底排不排除发送者**。当前实现排除（全员读完显示 `n/n`），说明书验收项 9 只钉了分子。这改的是用户天天看的数字，要产品侧确认；若要改成含发送者，分子必须一起改，否则分数没有意义。
4. 拍板 `docs/decisions/0010` 第二节：**mentions 到底以客户端给的 id 为准，还是按第 161 行去解析 body 里的 @**。当前实现取前者（契约与路由表两处都这么写），第 161 行因此作废，需要确认。
5. 同文件第五节：前端要不要在打开「@我」列表时推进 `mentions_read_seq`。推了，「看了一眼」就等于「处理完了」，这个语义要产品侧认。
6. `decisions/0009` 的两条已按选项 A 落地（`sync:hello` 接通、在线快照进 `sync:ready`），可以回头关掉。
7. 上线前剩下的是**这台机器给不了的两样**：**一把 age 密钥**（在机器外面 `age-keygen -o ~/gyq.age.key`，只把 `age-keygen -y` 的结果放进 `infra/deploy/age/recipient.pub`；私钥与密文同机存放等于没加密，而**一个没有对应私钥的公钥比没有公钥更糟**——`backup-once.sh` 会照常加密、报告 `env_backed_up: true`，那份密文再也解不开）；**一个不在同一台机器上的 restic 仓库**（设上 `RESTIC_REPOSITORY` + `RESTIC_PASSWORD`，之后就该把 `ALLOW_LOCAL_ONLY=1` 这行例外声明从栈里去掉）。**restic 这一段本轮已经真跑通了**（`/backups/restic-repo`，仓库 id 与全部实测数字见 §4 运维闭环）——但它和备份暂存在同一个卷上，机器没了它也没了，**所以那句「配上 restic 就删掉例外」还没到兑现的时候**。上一轮那条「写 Dockerfile 并在 compose 里加 `backup` 服务」已完成（`5dd2822`）。换到生产环境后要按生产的 dump 重做一次演练，**而不是反过来让脚本去迁就一次已经通过的结果**。
8. 拍板 `docs/decisions/0014` 第二节：**异地到底留 14 日 / 8 周 / 6 月，还是 7 / 4 / 6**。手册 8.1 的 PostgreSQL 那一行是前者，8.2 的脚本与 6.12 的风险表都是后者，三处两不一致。当前实现按 8.1 的对象级数字分两档（数据与密钥 14/8/6，附件 7/4/6），方向是只多不少；若真实意图是一律 7/4/6，那 8.1 要改，而**能往回恢复的天数会从 14 天缩到 7 天**。
9. 之后才往 `tasks / files / search` 走——这是仅剩的三个整块未动的模块。`ops` 已经有了第一条路（`/hooks/alert` + `notify-alert.sh` + `presence.onDrift`），**下一件最该做的是 outbox worker**：`processed_at` 现在永远为空，`readyz` 的 `outboxLag` 单调上涨，一条孤儿事件能把它永久钉住（§11 坑 17 与 `decisions/0006` 缺口六）。再往后才是 `/hooks/ops-report`、`/hooks/ops-request` 与 `/ops/requests/:rid/decision` 那条审批闭环——它比路由更重，因为「批了之后谁执行」在说明书里也是没定的。

---

## 11. 最容易踩的坑

1. 客户端必须无条件相信 `sync:pull` 返回的 `asOfSeq`，不能要求 `seq` 连续。**真库实测**：`alloc_group_seq` 回滚会把号原样归还（计数器更新与行锁同事务），不产生空洞；100 路并发分配也互不重复、无死锁。真正让 `seq` 不连续的是群被硬删时 `ON DELETE CASCADE` 连整段消息一起清掉。详见 `docs/decisions/0005` 矛盾一与缺口四。
2. **BIGINT 主键必须序列化成字符串**，前端禁止 `Number(id)`（过 2^53 会静默丢精度）。
3. **`clientMsgId` 在重试/降级/401 重放时必须复用**，否则弱网下产生重复消息。
4. `errorEnvelope.message` 是英文、给日志看；中文文案由前端按 `code` 映射。
5. 迁移文件**只增不改**：已发布迁移改了 checksum 会导致启动直接失败（故意的保护）。加了新迁移就顺手改 `apps/server/tests/db.test.ts` 里那份迁移清单断言，否则静态检查与真库各说一套。**本轮的真实踩法是反过来的**：0003 已经应用到 `gyq_dev` 之后又去改它，结果**整个集成套件以 `migration checksum mismatch: 0003…` 开头、后面 83 个用例整片 skip**——看起来像「测试被跳过了」，实际是那道防篡改检查在挡。修法是删掉那两张表与 `schema_migrations` 里对应的 `0003%` 那行让 harness 重跑，**而不是去改校验和**（改校验和等于把闸门焊开，而下一个人根本不知道曾经焊过）。
6. 不要为了「跑起来方便」在 `main.ts` 里塞假的 readiness provider —— `apps/server` 的设计是数据库不可用就不能就绪。
7. **撤回是两行规则，不是一行**：`撤回自己的消息（2 分钟内）` 对 owner/admin/member 都是 ✓，`撤回他人的消息` 只有 owner/admin ✓。写成「管理员免窗口」就等于群主能撤自己三天前的话。见 `docs/decisions/0006` 末节。
8. `outbox.aggregate_id` **没有也不可能有外键**（多态）。消息被删后事件会留下，而 `readyz` 的 lag 取「最老的未处理事件」——一条孤儿就能把 lag 永久钉住。worker 必须让每个事件都到终态，见 `docs/decisions/0006` 缺口六。
9. 编辑要同时写 `edited_at`。只改 `body` 的话 `updated_at` 会被触发器推进、测试照样绿，但 `editedAt` 永远是 null，前端显示不出「已编辑」。
10. **`revoked_reason` 是字符串字面量，不是列名。** 单会话登出的 SQL 曾写成 `revoked_reason = logout`（缺引号），单测全绿因为跑在内存假仓储上。教训：**「切片已在真库上跑过」不等于每条 SQL 都被跑过**。
11. **一条 SELECT 拼字符串时，别忘了它到底有没有 `WHERE`。**
12. **`group_members` 主键是 `(group_id, user_id)`**：被踢成员复活只能 `UPDATE` 原行，再 `INSERT` 直接撞主键。
13. **socket handler 只注册一次**，任何随用户操作变化的状态（如「当前打开哪个群」）都要走 ref 镜像，不能在 handler 里读 state 闭包——会过期。`App.tsx` 里的 `selectedRef` 就是为此。
14. **可空列不能用 `<>` 比较。** `user_id <> $2` 在 `$2` 为 NULL 时结果是 NULL 而不是 true，整条 WHERE 把所有行过滤光——不报错，只返回一个看起来合理的 0。系统消息的 `sender_id` 就是可空的。用 `IS DISTINCT FROM`。第 10 条的教训在这里再次成立：**「切片在真库上跑过」不等于每条 SQL 都被跑过**，这条是靠把 `IS DISTINCT FROM` 改回 `<>`、确认对应用例变红才验证测试真的咬得住。
15. **无 body 的 DELETE 不要带 `content-type: application/json`。** Fastify 直接回 `400 FST_ERR_CTP_EMPTY_JSON_BODY`，而且那个响应体是 Fastify 自己的形状（`statusCode/code/error/message`），**不是**我们的 error envelope——于是前端 `errorEnvelopeSchema` 解析失败、code 落到 `INTERNAL_ERROR`、`copy.ts` 里没有这个键，用户看到的是兜底的「出了点问题」。一次真实写操作就这样静默地从没发生过。`api.ts` 的 `call()` 原先无条件加这个头，`removeMember` / `revokeInvite` / `revoke` 三条 DELETE 全中招；撤回因为走 socket 而没被发现。修法是有 body 才加头。**只有真在浏览器里点一次才看得出来。**
16. **验瞬时 UI 状态别用「操作完再快照」。** typing 指示器 3 秒空闲即消、TTL 6 秒，而一次工具往返比这更慢——每次都拍在它消失之后，看起来就像功能没做。正确做法是**在页面里装一个 MutationObserver 记录出现与消失的时刻**，再去触发，最后回读记录。「采样」验不了寿命比采样间隔短的东西。
17. **`readyz` 的 `outboxLag` 是「最老未处理事件的年龄秒数」，不是条数**（`EXTRACT(EPOCH FROM now() - MIN(created_at)))`）。看到 2519 别以为是两千五百条积压——那是 42 分钟。而且 `ok` 只看 `db`，lag 再大也不影响就绪判定。没有 outbox worker 之前它会一直涨。
18. **socket 事件不带 ack 回调，服务端曾经整个 handler 都不执行。** `call()` 的第一行是 `if (typeof ack !== 'function') return;`。因为 `follow()`（加入房间）就在这些 handler 里面，漏传 ack 的客户端会**静默地不收任何广播**——没有错误、没有 ack、日志里也没有。已改成「照做，只是不回 ack」，并有变异验证。教训：**一个只负责「回话」的包装函数，不该顺带决定「做不做事」**。
19. **跑闸门会把 `packages/contracts/dist` 重写一遍，Vite 可能把写坏那一刻的模块缓存住。** 症状是浏览器报 `does not provide an export named 'errorEnvelopeSchema'`、页面白屏，而磁盘上的 dist 明明是对的（`?t=` 时间戳停在了那一刻）。**光重载页面没用**，要停掉 Vite、`rm -rf apps/web/node_modules/.vite`、再重启。这一轮踩了两次。
20. **`postgres:17-alpine` 里没有 bash。** 恢复演练脚本最自然的执行位置就是这个临时容器内部，而镜像只有 `/bin/sh`（busybox）。写成 `#!/usr/bin/env bash` 的结果是 `docker exec` 报一个和备份逻辑毫无关系的错。`restore-drill.sh` 因此刻意用 POSIX sh 写（`set -eu` 而非 `set -euo pipefail`，没有 `[[`、没有 `local -n`）。
21. **Git Bash 会把 `docker cp` / `docker run` 参数里的 `/tmp/xxx` 重写成 `E:/tmp/xxx`。** MSYS 的路径转换看到「以斜杠开头的 Unix 风格路径」就去翻它，结果容器里收到一个根本不存在的 Windows 路径。加 `MSYS_NO_PATHCONV=1` 前缀，或者把路径写成容器内的绝对路径并在 `docker exec` 里引用。**症状很有欺骗性**：命令报「No such file or directory」，而那个文件在容器里明明白白存在。本轮 `docker compose run --workdir /app/apps/server` 又踩一次（报的是 `the working directory 'E:/git/Git/app/apps/server' is invalid`）。
22. **base64 生成的密码不能拼进 URI。** `openssl rand -base64 48` 里有 `/` 与 `+`，而 `DATABASE_URL: postgres://user:${POSTGRES_PASSWORD}@host/db` 是 URI——`pg` 抛 `Invalid URL`，`psql` 报 `invalid integer value "a" for connection option "port"` 或 `could not translate host name "ss"`。约 87% 的生成结果含至少一个，所以这不是边缘情况而是常态。`POSTGRES_PASSWORD` 因此改成 hex（`gen-secrets.sh`），其余四把仍 base64（它们不进 URL）。全文见 `decisions/0012` 第一节。
23. **`${VAR:?}` 只检查「有值」，不检查「值是占位符」。** 让 `docker compose config` 在缺密钥时拒绝解析，靠的是必填插值本身；如果 `.env.example` 里写的是 `JWT_SECRET=replace-me`，那把它复制过去、不改、上线，检查一声不响地通过。所以模板里五把钥匙**全是空值**（`:?` 同样拒绝空值），而 `gen-secrets.sh` 会填并拒绝覆盖。推论：任何「必填」都要问一句**没填与填错哪个更难发现**。
24. **删掉一个写死的默认值，不等于修好了。** `01-set-password.sql` 被删的理由是它把凭据写在仓库里，而它注释里那句「只靠 `POSTGRES_PASSWORD` 会得到 verifier 不匹配的角色」在当前镜像上复现不出来（见 `decisions/0012` 第三节）——**但如果那个说法在别的版本上成立，删掉它会让栈起不来，而且报错指向认证而不是指向被删的文件**。所以这次删完立刻把整套栈真跑一遍（`/readyz` healthy + 建号 + 登录 + 带 token 的请求），而不是只做 `config` 的静态检查。
25. **本机 `docker compose build` 不可用**（坑 21 那个 shell 之外的另一个路径限制）：仓库在 `E:\工友圈`，中文路径让 buildx 的 bake 会话头带上非 ASCII 字节，构建在开工前就失败。`docker build` 不受影响，所以流程是 `docker build -t <project>-<service>` 三个镜像再 `up -d --no-build`。这条只对**这台机器**成立，Linux 部署机上 `up --build` 是好的——别把它当项目缺陷去"修"。另外 `chmod 600` 在 NTFS 上不可观测（Git Bash 里 `/tmp` 中的文件怎么设都报 `644`），`gen-secrets.sh` 里那行是给部署机写的。
26. **镜像设了 `ENTRYPOINT` 之后，`docker run IMAGE sh -c '…'` 不会换掉入口程序，而是把 `sh -c '…'` 当成参数交给它**。`backup` 镜像的 entrypoint 是 `backup-loop.sh`，所以那条命令的真实行为是「开始跑调度器并且永不退出」——表现成一个毫无输出的 120 秒超时，看不出任何一层报错。一次性地用镜像里的工具要写 `docker run --entrypoint sh IMAGE -c '…'`（`docker compose run --entrypoint …` 同理）。
27. **一个没有对应私钥的 age 公钥，比没有公钥更糟**。没有公钥时 `backup-once.sh` 走的是它设计好的那条路：跳过 `.env`、打一行警告、`last_success.json` 里 `env_backed_up: false`——**看得见地没做**。挂上一个私钥已经不存在的公钥之后，它每次都成功加密、每次都报 `env_backed_up: true`，而那份密文再也解不开；错误要等到真正要恢复的那天才暴露，且那时看起来像「备份明明做了」。所以演练用的公钥必须与测试密文一起删掉。**推广**：加一个「可选依赖」的守卫时，要检查**它缺席时的那条路是否比它在场但配错时更容易发现**。
28. **可空列当非空用，第三次了**（坑 14 的同一条教训换个地方）：`restore-drill.sh` 的验收 3.3 拿 `body IS NULL OR body = ''` 当「dump 被截断」的证据，而 `messages.body` 按 `0001_init.sql:150` 就是可空的，`image / file / system / task_card` 三种消息根本没有正文——**第一张图片发出去，恢复演练就会判失败**。一个总是误报的检查比没有检查更危险，因为它教会人无视这个绿灯。顺带一条同源的坑：**命名卷不跟 `docker compose down` 一起消失**，所以 `backup-loop.sh` 那段「找不到 `last_success.json` 就首跑」的逻辑在已有卷的机器上永远不会再进那个分支——要复现首次行为必须显式 `docker volume rm <project>_backups`。
29. **`restic forget` 的默认分组会让保留策略一声不响地失效。** restic 按 `host,paths` 分组后再应用 `keep-daily`，而备份文件名里带时间戳 → 每晚的快照各成一组、每组只有它自己 → 那一个永远是「当天最后一个」→ **一个都删不掉**。手册 8.2 那一行就缺 `--group-by tag`，所以照抄它的脚本永远不会真正回收空间。它同时给出**两个方向都错**的后果：6.12 担心的「prune 删多」根本不会发生，而「对象存储账单每月翻倍」一定会。更糟的是它看起来在工作——`forget` 打一整屏表格，每行都写着 `keep 1 snapshots`。要判断它到底有没有生效，只能数它删了几个：`--dry-run` 加 `--keep-daily 1`，删 0 就是分组坏了。
30. **`set -e` 不会因为 `[ -d x ] && cmd` 左侧为假而退出**——我读 `backup-once.sh` 时断定那三行 `&&` 会在第一次真跑 restic 时当场把脚本弄死（`/caddy-data` 在本机永远不存在），写好定罪的话才去跑最小复现：`set -euo pipefail; [ -d /nope ] && restic backup x; echo after` → 打印 `after`，退出 0。POSIX 的规则是 errexit **不覆盖** `&&` 列表里「最后一个 `&&` 之前」的命令。**读出来的缺陷要先跑一次再定罪**：这一条如果直接写进文档，下一个人就会去「修」一个不存在的问题，而真正在那儿的「附件卷没挂上会静默跳过」反而没人看。改成 `if` 是为了可读，不是修 bug——那三行确实有个 bug，只是不是我以为的那个。
31. **坑 21 还有另一半：`docker cp` 主机侧的路径也会被 Windows 解析错。** `docker cp CONTAINER:/tmp/x /tmp/y` 里第二个 `/tmp/y` 交给的是 Docker 这个 Windows 进程，它按 `C:\tmp\y` 去找，报 `no such directory`——而报的是「目录」不是「权限」，很容易误以为容器侧出了问题。`MSYS_NO_PATHCONV=1` 在这里反而**帮倒忙**：它会阻止 Git Bash 把 `/e/…` 翻成 `E:\…`。可行做法是把主机侧落在仓库内的目录（`.tmp/`，已在 `.gitignore` 里），让 Git Bash 正常转换它，而容器侧的 `NAME:/abs/path` 不以斜杠开头、MSYS 本来就不会碰它。
32. **`ERR` trap 抓不到 `exit`，也抓不到 `||` 列表里失败的命令**——所以「失败时会说话」这件事，只挂 trap 是不够的。`backup-once.sh` 里 `pg_restore --list "$DUMP" > /dev/null || die "…"` 这一类失败，命令的非 0 被 `||` 吃掉了，errexit 不触发，trap 一声不响；而 `die()` 自己走 `exit 1`，同样不是 `ERR`。本轮新加的两类失败（dump 校验不过、restic 仓库不存在）**恰好全是这一类**，也就是说：如果只在 trap 上做手脚，最需要说话的那两种失败正是不会说话的两种。修法是 `die()` 里也通知一次。**同一处还有一个反向的坑**：trap 里用 `$BASH_COMMAND` 看起来最自然（「把出错那一行报出来」），但它是**已经展开**的命令行，而脚本第 53 行就是 `export PGPASSWORD="$POSTGRES_PASSWORD"` —— 展开出来就是把数据库口令写进一条会发到运维群的告警。所以报 `$LINENO` 而不报命令本身。
33. **在 shell 里手拼 JSON，第一个可选字段就会翻车。** `notify-alert.sh` 原来按「固定模板 + 可选字段各带一个前置逗号」拼，给了 `fingerprint` 时得到 `{"title":"x",,"fingerprint":"y""detail":…}`：两个逗号撞在一起、`fingerprint` 结尾又少一个，服务端回 **400 而不是 401**——这个区别本身是线索（说明签名过了、是载荷不合法）。**逗号该属于「拼接」这个动作，不该属于字段。** 现在第一个字段初始化那个字符串，后面每个字段各自 `fields="$fields,\"…\":…"` 往上追加，可选的 `fingerprint` 整条（连同它那个前导逗号）在 `if` 里，所以它不存在时不会留下悬空的分隔符。**同一条链路上另一半不好查的是客户端看不见报错体**：busybox 的 `wget` 只打状态行，`error.code` 与 `details` 全被吞掉，所以「400 还是 401」这种**状态码级别**的差异是这里能拿到的全部信息；这也是为什么值得把 401 / 503 / 连不上 三态在文档里写清楚（三态够用，就没有为它装 curl 的必要）。
