# 交接文档：工友圈

- 编写日期：2026-09-14（重写，替换 2026-09-13 那份被 mojibake 损坏且已过期的版本）
- 适用仓库：`E:\工友圈`（远端 `git@github.com:luo683/gongyouquan.git`）
- 交接起点：`feat/contracts-foundation` 分支，`HEAD = 3f7124c`，工作区干净
- 设计真源：`docs/specs/` 下三份说明书（**不要改原文**，矛盾与缺口走 `docs/decisions/`）

---

## 1. 一句话现状

后端骨架与 `auth / groups / members / messages / sync` 五个垂直切片均已落地，并已在**真实 PostgreSQL 17.11** 上跑通、固化成集成测试；**已读回执、typing、presence（含在线快照）、@提及四条都已两侧打通**；`sync:hello` 已接通，服务端 `contractVersion` 现在真的会到浏览器；浏览器端（React + Vite）可真聊、未读徽标会消、成员管理可逐条点通、能 @ 人并收到「@我」列表。`lint / typecheck / test` 三道闸门本地全绿。**仍不可对外部署**——缺的是 `tasks / files / search / ops` 模块、Electron 外壳、备份恢复演练与生产 secret 注入，**数据库与核心收发链路不再是阻塞项**。

---

## 2. 仓库、分支与远端

| 项 | 值 |
|---|---|
| 默认分支 | `main`（停在基线 `a322610`，尚未合并任何开发提交） |
| 开发分支 | `feat/contracts-foundation`，**领先 `main` 47 个提交**（本文档自身的更新紧随其后，单独一个 docs 提交） |
| 当前 HEAD | `3bbc7f5 feat: @mentions end to end, with the leak they could have caused closed` |
| 标签 | `m0-foundation` → `a322610`（仓库基线） |
| 远端 | `origin` = `git@github.com:luo683/gongyouquan.git`，SSH，账号 `luo683` |
| Git 身份 | `user.name=luo683`，`user.email=3012390263@qq.com` |
| 提交约定 | `type(scope): summary`；一次提交只做一件可验证的事；不使用 `--force` |

基线之后 47 个提交（旧→新）：

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
```

---

## 3. 目录结构

```text
工友圈/
├── apps/server/            后端单进程服务（Fastify + Socket.IO）
│   ├── src/auth/           邀请码注册、登录、refresh 轮换、logout / logout-all
│   ├── src/groups/         群 CRUD + 成员管理（members*.ts / member-routes.ts）
│   ├── src/messages/       写入、编辑、撤回、历史分页、bus 广播
│   ├── src/sync/           水位、补投、读位点
│   ├── src/http/           错误封装、Bearer 鉴权、令牌桶限流
│   ├── src/db/             连接池、迁移加载器、advisory-lock 幂等迁移
│   ├── src/presence.ts     在线状态内存映射 + 30 秒兜底扫描（4.6）
│   ├── src/cli/create-admin.ts   首个账号引导（一次性）
│   ├── src/runtime.ts      单进程装配 + Socket.IO 线
│   └── tests/              22 个测试文件（含 integration/ 与 e2e/）
├── apps/web/               浏览器端（React + Vite + TS），复用 contracts schema
│   └── src/{App.tsx,api.ts,copy.ts,syncStore.ts,main.tsx}
├── packages/contracts/     共享契约（Zod schema + 类型），前后端唯一真源
├── infra/db/               docker-compose.yml（dev PG）+ migrations/（0001,0002）
├── infra/deploy/           docker-compose.yml + Caddyfile + 两个 Dockerfile（一键全栈）
├── docs/specs/             三份说明书原件（01-后端 / 02-前端 / 03-AI运维）
├── docs/decisions/         矛盾与缺口登记（0001-0007）
├── eslint.config.js        根级 ESLint（flat config），lint 现已是真实闸门
└── .github/workflows/      CI（见 §7）
```

---

## 4. 已经做到的

### 契约层 `packages/contracts`

- ID 一律字符串、时间戳必须带时区偏移（`apiTimestampSchema`）
- 游标分页 `cursorPageSchema`、补投分页 `syncPageSchema`（两者形状不同，别混用）
- 统一错误包装 `errorEnvelopeSchema` + 错误码枚举
- auth 请求 schema、群组 DTO（含 `unreadCount` 限界 `[0,100]`，100 是「99+」哨兵）
- messages / sync 线格式：`messageDtoSchema`（含 `updatedAt`，即 4.3.4 覆盖依据）、`messageSendResultSchema`（用 `deduplicated` 统一 WS 与 HTTP 的 ack 形状）、`syncHello / syncReady / syncPull / messageSyncPage`、读位点与已读回执、`wsErrorPayload`
- `clientMsgId` 在契约层就要求 UUID（原来只 `min(1)`，会让幂等键形同虚设）

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
| Socket.IO 线：`sync:hello / sync:pull / message:send / message:edit / message:delete / read:update / typing:start / typing:stop`；出站另有 `presence:updated`、`typing:*`（带 `userId`）、`read:updated`（群房间）与 `mention:new`（**个人房间 `user:{uid}`**，758 行）；ack 一律是契约载荷或 `{error:{code,message}}`，`typing:*` 按 739 行**没有 ack** | `src/runtime.ts` |
| **首个账号引导**：`docker compose run --rm server node --import tsx src/cli/create-admin.ts` —— 一次性建 用户 + 系统群 + 邀请码并打印，登录自校验；重复运行拒绝；不在启动时自动执行 | `src/cli/create-admin.ts` |

**已注册的 HTTP 路由**（`/api/v1` 前缀，除 health/auth 外均需 Bearer）：

```text
GET    /healthz, /readyz
POST   /auth/register, /auth/login, /auth/refresh, /auth/logout, /auth/logout-all
POST   /groups                         GET /groups, /groups/:gid, /groups/:gid/members
PATCH  /groups/:gid
POST   /groups/:gid/members            PATCH /groups/:gid/members/:uid   DELETE 同路径
POST   /groups/:gid/invites            GET /groups/:gid/invites          DELETE /groups/:gid/invites/:iid
POST   /groups/:gid/messages           GET /groups/:gid/messages
GET    /groups/:gid/messages/:mid/receipts        (?detail=0|1，4.4.3 分级)
GET    /me/mentions                               (?unreadOnly=1&cursor=，跨群)
PATCH  /messages/:mid                  DELETE /messages/:mid             GET /messages/:mid/raw
GET    /groups/:gid/sync, /groups/:gid/sync-state    POST /groups/:gid/read
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

- `docker compose -f infra/deploy/docker-compose.yml up -d` —— Postgres + API + Caddy（静态托管与 `/api`、`/socket.io` 反代），三条健康检查串成启动顺序，含 `create-admin` 引导
- **口令是开发值，不能带上公网**

### 测试与质量闸门（2026-09-14 本地实测）

```text
pnpm lint        eslint .                          → 0 error（lint 已是真实闸门，不再是空转）
pnpm typecheck   3 包全过
pnpm test        contracts 31 + server 67 + web 9 = 107 通过，server 72 个真库用例 skip
真库闸门         INTEGRATION_DATABASE_URL 设上后 server 139 全过（含 72 个真库 + e2e 双人聊天）
合计             26 文件 / 179 用例，全绿
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
2. **整块未动的模块**：`tasks` / `files` / `search` / `ops`。其中 `ops` 含 `/hooks/*` 的幂等与聚合。
3. **成员管理收尾**：离职转交的批量入口、`notification_prefs`、成员列表的 `includeRemoved` 查询参数。
4. **改密接口**：`logout-all` 已实现，但目前只能由前端显式调用，没有「改密后强制全端下线」的入口。
5. **浏览器端仍缺**：Electron 外壳（`apps/desktop`）、改密入口、归档群入口。**成员管理界面与已读回执展示都已做**（真浏览器逐条点过），成员侧还差 `includeRemoved` 的历史成员视图与离职批量转交入口。
6. **部署仍缺**：备份与恢复演练（说明书 §9 要求）、systemd 单元、`opsctl`、`/internal/metrics`、告警接入、生产版 secret 注入。
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

真实数据库闸门（不设 `INTEGRATION_DATABASE_URL` 时那 57 个用例整体 skip，`pnpm test` 在无库机器上依然全绿）：

```bash
docker compose -f infra/db/docker-compose.yml up -d      # postgres:17-alpine，宿主端口 55432
INTEGRATION_DATABASE_URL="postgres://gyq:gyq_dev_pw@localhost:55432/gyq_dev" \
  pnpm --filter @gongyouquan/server test
```

PowerShell 用 `$env:INTEGRATION_DATABASE_URL="..."` 单独一行。用例跑完会清掉自己造的数据，可对同一个库反复跑。

服务端 dev 启动（**需要先有可用的 PostgreSQL**；启动即执行迁移，库不可用则进程失败退出，`/readyz` 不假装就绪——刻意设计，见 decisions 0002）。本地手工验证时的最小 env：

```bash
NODE_ENV=development PORT=3000 \
DATABASE_URL="postgres://gyq:gyq_dev_pw@localhost:55432/gyq_dev" \
JWT_SECRET="<random>" UPLOAD_DIR="./uploads" \
PUBLIC_ORIGIN="http://localhost:5173" \
MEILI_URL="http://localhost:7700" MEILI_MASTER_KEY="<random>" \
ALERT_HMAC_SECRET="<random>" CONTRACT_VERSION="dev" LOG_LEVEL=info \
pnpm --filter @gongyouquan/server dev
# 浏览器端：pnpm --filter @gongyouquan/web dev（Vite 5173，已配 /api 与 /socket.io 代理到 127.0.0.1:3000）
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

0002-0010 多为 `open` 状态：**取舍已实现，但说明书本身还没修订**。接手后若与产品/需求方对齐，应回头关掉它们。

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

几个**已拍死、改之前先看 decision** 的行为：

- 归档群：读放行，写返回 `409 GROUP_ARCHIVED`（不是 403）。guard 不看归档态。
- 非成员读群详情/成员列表：返回 `404 NOT_FOUND`，不暴露群存在性；写操作才用 `403 FORBIDDEN_*`。
- `GET /groups` 的 `includeArchived` 默认 **false**（说明书没写，这是我们的选择）。
- 登录失败统一 `AUTH_INVALID_CREDENTIALS`，不区分用户名不存在与密码错误。
- 已读回执：`readCount` 与 `totalMembers` **都**排除发送者（说明书只钉了分子，见 `0008` 一节）；`:gid` 与消息实际所属群不符时，先于成员判定返回 `404`，不用 `403`。

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

**结论**：数据库不再是阻塞项。唯一持续的小麻烦是**本机默认 Node 版本超范围**——切到上面那份 v22.23.1 即可。

**端口不一定空着**：上一轮会话留下的 dev 服务可能仍占着 3000（连同它自己的 Vite 占着 5173）。那个实例跑的是**旧代码**，`curl` 一下新加的路由就能分辨（注册了返回 401，没有返回 404）。别急着杀别人的进程——`vite.config.ts` 的代理目标和端口都能用环境变量覆盖，另起一套即可：

```bash
PORT=3100 ... pnpm --filter @gongyouquan/server dev          # 自己的后端
VITE_DEV_API_ORIGIN=http://127.0.0.1:3100 pnpm --filter @gongyouquan/web dev
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
7. 之后才往 `tasks / files / search / ops` 走——这是仅剩的四个整块未动的模块。

---

## 11. 最容易踩的坑

1. 客户端必须无条件相信 `sync:pull` 返回的 `asOfSeq`，不能要求 `seq` 连续。**真库实测**：`alloc_group_seq` 回滚会把号原样归还（计数器更新与行锁同事务），不产生空洞；100 路并发分配也互不重复、无死锁。真正让 `seq` 不连续的是群被硬删时 `ON DELETE CASCADE` 连整段消息一起清掉。详见 `docs/decisions/0005` 矛盾一与缺口四。
2. **BIGINT 主键必须序列化成字符串**，前端禁止 `Number(id)`（过 2^53 会静默丢精度）。
3. **`clientMsgId` 在重试/降级/401 重放时必须复用**，否则弱网下产生重复消息。
4. `errorEnvelope.message` 是英文、给日志看；中文文案由前端按 `code` 映射。
5. 迁移文件**只增不改**：已发布迁移改了 checksum 会导致启动直接失败（故意的保护）。加了新迁移就顺手改 `apps/server/tests/db.test.ts` 里那份迁移清单断言，否则静态检查与真库各说一套。
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
