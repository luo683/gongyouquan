# 交接文档：工友圈

- 编写日期：2026-09-14（重写，替换 2026-09-13 那份被 mojibake 损坏且已过期的版本）
- 适用仓库：`E:\工友圈`（远端 `git@github.com:luo683/gongyouquan.git`）
- 交接起点：`feat/contracts-foundation` 分支，`HEAD = 7d4f25b`，另有 1 处未提交的前端改动（见 §4 末）
- 设计真源：`docs/specs/` 下三份说明书（**不要改原文**，矛盾与缺口走 `docs/decisions/`）

---

## 1. 一句话现状

后端骨架与 `auth / groups / members / messages / sync` 五个垂直切片均已落地，并已在**真实 PostgreSQL 17.11** 上跑通、固化成集成测试；浏览器端（React + Vite）可与后端真聊。`lint / typecheck / test` 三道闸门本地全绿。**仍不可对外部署**——缺的是 `tasks / files / search / ops` 模块、Electron 外壳、成员管理界面、备份恢复演练与生产 secret 注入，**数据库与核心收发链路不再是阻塞项**。

---

## 2. 仓库、分支与远端

| 项 | 值 |
|---|---|
| 默认分支 | `main`（停在基线 `a322610`，尚未合并任何开发提交） |
| 开发分支 | `feat/contracts-foundation`，**领先 `main` 35 个提交**，领先 `origin/feat/contracts-foundation` 25 个（即本地有 25 个提交未 push） |
| 当前 HEAD | `7d4f25b feat(server): member management and invite codes, cell by cell from spec 3.4` |
| 标签 | `m0-foundation` → `a322610`（仓库基线） |
| 远端 | `origin` = `git@github.com:luo683/gongyouquan.git`，SSH，账号 `luo683` |
| Git 身份 | `user.name=luo683`，`user.email=3012390263@qq.com` |
| 提交约定 | `type(scope): summary`；一次提交只做一件可验证的事；不使用 `--force` |

基线之后 35 个提交（旧→新）：

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
│   ├── src/cli/create-admin.ts   首个账号引导（一次性）
│   ├── src/runtime.ts      单进程装配 + Socket.IO 线
│   └── tests/              17 个测试文件（含 integration/ 与 e2e/）
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
| **sync**：`sync:hello` 水位（只报调用者真正在的群）、`sync:pull` 按当前状态补投（不重放事件）、`asOfSeq` 永不倒退、`read:update` 双向 `GREATEST` 位点 | `src/sync/` |
| Socket.IO 线：`sync:hello / sync:pull / message:send / message:edit / message:delete / read:update`；ack 一律是契约载荷或 `{error:{code,message}}` | `src/runtime.ts` |
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
PATCH  /messages/:mid                  DELETE /messages/:mid             GET /messages/:mid/raw
GET    /groups/:gid/sync, /groups/:gid/sync-state    POST /groups/:gid/read
```

### 浏览器端 `apps/web`

- 邀请码注册 / 登录、群列表带服务端未读数、按 `sync:hello`→`sync:pull` 冷启动
- 发送与撤回走 socket ack；4.3.4 客户端状态机（`syncedSeq / pendingNew / eventBuffer`）抽成纯模块 `syncStore.ts`，有 9 个无浏览器单测
- 中文文案全部由 `code` 在前端映射（`copy.ts`，`errorEnvelope.message` 只进日志）；`RATE_LIMITED` 把等待秒数拼进提示
- 侧栏内联「新建群」表单（不是 `window.prompt`）+「生成邀请码」入口
- 所有响应过 Zod schema；BIGINT id 全程字符串，前端无 `Number(id)`
- **刻意没有**「已登录用户凭邀请码入群」输入框：说明书 3.1 第 209 行把邀请码定义为**注册时**消耗，无任何接口让已有账号兑换，加了只会必然报错

### 部署 `infra/deploy`

- `docker compose -f infra/deploy/docker-compose.yml up -d` —— Postgres + API + Caddy（静态托管与 `/api`、`/socket.io` 反代），三条健康检查串成启动顺序，含 `create-admin` 引导
- **口令是开发值，不能带上公网**

### 测试与质量闸门（2026-09-14 本地实测）

```text
pnpm lint        eslint .                          → 0 error（lint 已是真实闸门，不再是空转）
pnpm typecheck   3 包全过
pnpm test        contracts 29 + server 50 + web 9 = 88 通过，server 57 个真库用例 skip
真库闸门         INTEGRATION_DATABASE_URL 设上后 server 107 全过（含 57 个真库 + e2e 双人聊天）
合计             22 文件 / 145 用例，全绿
```

### 未提交的前端改动（**接手第一步先处理它**）

`git status` 显示 `apps/web/src/App.tsx`、`apps/web/src/styles.css` 有未提交改动。这是上一轮没收尾的「让未读徽标真的会消」的工作，本次交接已把它补完整并验证通过，但**尚未 commit**：

1. 新增 `selectedRef`（镜像 `selected` 状态）——socket 的 `message:new` handler 只注册一次，闭包读 `selected` 会过期，必须用 ref 判断「消息是否落在当前正打开的群」，是则推进读位点。
2. `chooseGroup` 里**同步**写 `selectedRef.current`（避免 await 期间到达的消息被拿旧群判断），并把补投 `pull` 改为 `await`，完成后调用 `advanceRead(groupId, syncedSeq)` —— **打开一个群即清掉它的未读徽标**。
3. `createGroup` 从 `window.prompt` 改成侧栏内联表单（自动化浏览器驱动不了模态框，且无法回显服务端拒绝原因）。

`advanceRead` 服务端是 `GREATEST` 单调的，过期调用无害；客户端用 `lastSentRead` ref 去重，避免重复 emit。验证：`pnpm --filter @gongyouquan/web typecheck / lint / test` 全过。**接手后请把这处改动 commit 掉**（建议 `fix(web): clear the unread badge when a room is opened`），否则会一直挂在工作区。

---

## 5. 还没做到的（按重要性）

1. **messages / sync 仍缺**：已读回执 `GET /messages/:mid/receipts`（4.4.3 的 detail 分级，**路由尚未注册**）、`typing:*` 与 `presence:updated`、`mention:new`、编辑/撤回窗口过期时 socket 侧对 `read:updated` 的推送。（`/messages/:mid/raw` 的 HTTP 路由**已存在**，旧文档说缺是过期的。）
2. **整块未动的模块**：`tasks` / `files` / `search` / `ops`。其中 `ops` 含 `/hooks/*` 的幂等与聚合。
3. **成员管理收尾**：离职转交的批量入口、`notification_prefs`、成员列表的 `includeRemoved` 查询参数。
4. **改密接口**：`logout-all` 已实现，但目前只能由前端显式调用，没有「改密后强制全端下线」的入口。
5. **浏览器端仍缺**：Electron 外壳（`apps/desktop`）、改密入口、已读回执展示、归档群入口、**成员管理界面**（服务端接口齐了，界面没做）。
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

0002-0007 多为 `open` 状态：**取舍已实现，但说明书本身还没修订**。接手后若与产品/需求方对齐，应回头关掉它们。

| 文件 | 关键内容 |
|---|---|
| `0001-project-baseline.md` | 基线约定（accepted）。其中「lockfile 待生成」一条已过期 |
| `0002-database-spec-clarifications.md` | 5 处矛盾：DDL 执行范围、软删除 vs `ON DELETE CASCADE`、搜索索引范围、索引数量、容量估算 |
| `0003-auth-contract-clarifications.md` | `AUTH_INVALID_CREDENTIALS` 不在错误码表、邀请码 role 落点、注册事务边界 |
| `0004-groups-guards-and-archival.md` | guard 是否看归档态（224 vs 236 行自相矛盾）、归档群 PATCH 未定义、非成员读返回 403 还是 404 |
| `0005-real-database-findings.md` | 真库首跑暴露 6 条：**回滚不产生 seq 空洞（推翻说明书 4.2 与验收表第 2 项）**、未读不排除撤回消息、预览与未读对 `system` 口径不一致、硬删群连撤回留痕一起清掉、`files.uploader_id` 无级联、1685 行计划验证仍未做 |
| `0006-messages-sync-contract-gaps.md` | messages 缺 `updated_at`（已补迁移 0002）、WS 与 HTTP 的 send ack 不一致、`clientMsgId` 该不该收成 UUID、`asOfSeq` 定义会让客户端位点倒退、本轮只发得出 text/system |
| `0007-rate-limiting-tradeoffs.md` | 限流落地取舍 |

几个**已拍死、改之前先看 decision** 的行为：

- 归档群：读放行，写返回 `409 GROUP_ARCHIVED`（不是 403）。guard 不看归档态。
- 非成员读群详情/成员列表：返回 `404 NOT_FOUND`，不暴露群存在性；写操作才用 `403 FORBIDDEN_*`。
- `GET /groups` 的 `includeArchived` 默认 **false**（说明书没写，这是我们的选择）。
- 登录失败统一 `AUTH_INVALID_CREDENTIALS`，不区分用户名不存在与密码错误。

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

---

## 10. 接手后建议的第一步

1. **把 §4 末那处未提交的前端改动 commit 掉**（已验证全绿，别让它一直挂在工作区）。
2. 切到 Node 22（§9 路径直接可用），消掉 `Unsupported engine` 警告。
3. 拍板 `docs/decisions/0005` 的六条——尤其**矛盾一**：说明书 4.2 断言回滚会留 seq 空洞、验收表第 2 项要求「构造回滚事务 → 后续 seq 有跳跃」，但真库证明当前 `alloc_group_seq` 写法做不到。`asOfSeq` 那条「基石」的验收怎么写，取决于这个决定。
4. 补 `messages` 的已读回执路由 `GET /messages/:mid/receipts`（4.4.3），再做 `typing/presence/mention`。
5. 做**成员管理界面**——服务端接口（加人/踢人/改角色/转让/邀请码）已齐且有真库测试，纯缺前端。
6. 之后才往 `tasks / files / search / ops` 走。

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
13. **socket handler 只注册一次**，任何随用户操作变化的状态（如「当前打开哪个群」）都要走 ref 镜像，不能在 handler 里读 state 闭包——会过期。本次未提交改动里的 `selectedRef` 就是为此。
