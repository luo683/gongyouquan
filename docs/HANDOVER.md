# 交接文档：工友圈

- 编写日期：2026-09-13
- 适用仓库：`E:\工友圈`（远端 `git@github.com:luo683/gongyouquan.git`）
- 交接起点：`feat/contracts-foundation` 分支，本文件所在提交即当前进度点
- 设计真源：`docs/specs/` 下三份说明书（**不要改原文**，矛盾走 `docs/decisions/`）

---

## 1. 一句话现状

后端骨架和 `auth`、`groups` 两个垂直切片已经落地并有测试覆盖；`0001_init.sql` 已在 **真实 PostgreSQL 17.11** 上建库通过、迁移重复执行验证为 no-op（见 `docs/decisions/0005`）。业务只完成了很小一部分，当前仍**不可部署、不可演示**——缺的是 messages/sync/tasks、前端与运维，不再是数据库。

---

## 2. 仓库、分支与远端

| 项 | 值 |
|---|---|
| 默认分支 | `main`（停在基线 `a322610`，尚未合并任何开发提交） |
| 开发分支 | `feat/contracts-foundation`（领先 `main` 8 个提交以上） |
| 标签 | `m0-foundation` → `a322610`（仓库基线） |
| 远端 | `origin` = `git@github.com:luo683/gongyouquan.git`，SSH，账号 `luo683` |
| Git 身份 | `user.name=luo683`，`user.email=3012390263@qq.com` |
| 提交约定 | `type(scope): summary`；一次提交只做一件可验证的事；不使用 `--force` |

基线之后的提交序列（截至交接）：

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
```

交接之后又推进了一批（真实数据库验证 + CI 补盲），见 `git log -1 --stat` 与 `docs/decisions/0005`。

---

## 3. 目录结构

```text
工友圈/
├── apps/server/            后端单进程服务（Fastify + Socket.IO）
├── apps/web/               浏览器端（React + Vite + TS），复用 contracts 同一套 schema
│   ├── src/config/env.ts   环境变量集中校验，缺失即启动失败
│   ├── src/db/             连接池、迁移加载器、幂等迁移执行器
│   ├── src/http/           统一错误封装、Bearer 鉴权
│   ├── src/auth/           邀请码注册、登录、refresh 轮换
│   ├── src/groups/         成员守卫、群 CRUD
│   └── tests/              10 个测试文件
├── packages/contracts/     共享契约（Zod schema + 类型），前后端唯一真源
├── infra/db/migrations/    0001_init.sql（22 表 / 4 函数 / 7 触发器）
├── docs/specs/             三份说明书原件
├── docs/decisions/         矛盾与缺口登记（0001-0004）
└── .github/workflows/      CI（见第 7 节，有盲区）
```

---

## 4. 已经做到的

### 契约层 `packages/contracts`

- ID 一律字符串、时间戳必须带时区偏移（`apiTimestampSchema`）
- 游标分页 `cursorPageSchema`、补投分页 `syncPageSchema`（两者形状不同，别混用）
- 统一错误包装 `errorEnvelopeSchema` + 17 个错误码枚举
- auth 请求 schema、群组 DTO（含 `unreadCount` 限界 `[0,100]`，100 是「99+」哨兵）
- **messages / sync 线格式**：`messageDtoSchema`（含 `updatedAt`，即 4.3.4 的覆盖依据）、
  `messageSendResultSchema`（用 `deduplicated` 统一 WS 与 HTTP 的 ack 形状）、
  `syncHello` / `syncReady` / `syncPull` / `messageSyncPage`、读位点与已读回执、`wsErrorPayload`
- `clientMsgId` 在契约层就要求 UUID（原来只 `min(1)`，会让幂等键形同不存在）

### 服务端 `apps/server`

| 能力 | 位置 |
|---|---|
| `/healthz` 存活、`/readyz` 就绪（DB 未就绪 → 503 `NOT_READY`，Meili 失败不拦） | `src/health.ts` |
| 启动配置校验 | `src/config/env.ts` |
| Fastify + Socket.IO 单进程装配、幂等优雅关闭 | `src/runtime.ts` |
| Socket.IO 握手鉴权（`auth.token`，HS256） | `src/runtime.ts` |
| 连接后 `sync:hello` → `sync:ready`，只返回有权访问的群 | `src/runtime.ts` |
| PostgreSQL 连接池 + advisory lock 幂等迁移 + checksum 防篡改 | `src/db/` |
| Bearer 鉴权（过期 `TOKEN_EXPIRED`、无效 `UNAUTHENTICATED`，不查库） | `src/http/auth.ts` |
| 统一错误封装与 code→HTTP 映射 | `src/http/errors.ts` |
| 错误可携带机器可读的 `details`（`HttpError(code, details)` → `errorEnvelope`） | `src/http/errors.ts` |
| **auth**：邀请码注册（同事务消耗次数）、Argon2id、登录、refresh 轮换、旧 token 重用→整族撤销、logout | `src/auth/` |
| **groups**：建群（创建者 owner）、群列表、详情（含 `myMembership`）、成员列表、改群信息 | `src/groups/` |
| **成员管理与邀请码**：加人（被移除者复活原行）、踢人 / 退出（owner 须先转让）、改角色、转让群主（同一事务两行一起动）、邀请码增/查/撤销 | `src/groups/members*.ts` |
| 邀请码的 code **只在创建响应里出现一次**，列表接口不回显，所以读一次成员表不会泄露可用入群链接 | `src/groups/members.ts` |
| **首个账号引导**：`docker compose run --rm server node --import tsx src/cli/create-admin.ts` —— 一次性建 用户 + 系统群 + 邀请码并打印，登录自校验；重复运行会拒绝。不在启动时自动执行（理由见说明书 §11 与文件头注释） | `src/cli/create-admin.ts` |
| **一键全栈**：`docker compose -f infra/deploy/docker-compose.yml up -d` —— Postgres + API + Caddy（静态托管与 `/api`、`/socket.io` 反代），三条健康检查串成启动顺序 | `infra/deploy/` |
| **messages** 写入路径：`alloc_group_seq` 同事务发号、`(sender_id, client_msg_id)` 幂等重发、历史分页、15 分钟编辑窗与 2 分钟撤回窗（按 3.4 两行分开）、撤回留痕与 `/raw` 分级、每次变更同事务写 outbox | `src/messages/` |
| **sync**：`sync:hello` 水位（只报调用者真正在的群）、`sync:pull` 按当前状态补投（不重放事件）、`asOfSeq` 永不倒退、`read:update` 双向 `GREATEST` 位点 | `src/sync/` |
| Socket.IO 线：`sync:hello` / `sync:pull` / `message:send` / `message:edit` / `message:delete` / `read:update`；ack 一律是契约载荷或 `{error:{code,message}}` | `src/runtime.ts` |
| 提交后经 bus 广播 `message:new` / `message:updated` / `message:deleted`（完整 DTO，非 diff） | `src/messages/bus.ts` |
| **浏览器端**：邀请码注册/登录、群列表带服务端未读数、按 `sync:hello`→`sync:pull` 冷启动、发送与撤回走 socket ack、4.3.4 客户端状态机（`syncedSeq` / `pendingNew` / `eventBuffer`） | `apps/web/src/` |
| 中文文案全部由 `code` 在前端映射（`errorEnvelope.message` 只进日志）；`RATE_LIMITED` 会把等待秒数拼进提示 | `apps/web/src/copy.ts` |
| **限流**：令牌桶 + 可注入时钟；login 双维度 / register / refresh 会话族 / 发消息双维度 / 写接口兜底，429 带 `Retry-After`；`logout-all` 返回 `revokedCount` | `src/http/rate-limit.ts` |
|
 
*
*
s
y
n
c
*
*
：
`
s
y
n
c
:
h
e
l
l
o
`
 
水
位
（
只
报
调
用
者
真
正
在
的
群
）
、
`
s
y
n
c
:
p
u
l
l
`
 
按
当
前
状
态
补
投
（
不
重
放
事
件
）
、
`
a
s
O
f
S
e
q
`
 
永
不
倒
退
、
`
r
e
a
d
:
u
p
d
a
t
e
`
 
双
向
 
`
G
R
E
A
T
E
S
T
`
 
位
点
 
|
 
`
s
r
c
/
s
y
n
c
/
`
 
|


|
 
S
o
c
k
e
t
.
I
O
 
线
：
`
s
y
n
c
:
h
e
l
l
o
`
 
/
 
`
s
y
n
c
:
p
u
l
l
`
 
/
 
`
m
e
s
s
a
g
e
:
s
e
n
d
`
 
/
 
`
m
e
s
s
a
g
e
:
e
d
i
t
`
 
/
 
`
m
e
s
s
a
g
e
:
d
e
l
e
t
e
`
 
/
 
`
r
e
a
d
:
u
p
d
a
t
e
`
，
a
c
k
 
一
律
 
`
{
.
.
.
}
`
 
或
 
`
{
e
r
r
o
r
:
{
c
o
d
e
,
m
e
s
s
a
g
e
}
}
`
 
|
 
`
s
r
c
/
r
u
n
t
i
m
e
.
t
s
`
 
|


|
 
提
交
后
经
 
b
u
s
 
广
播
 
`
m
e
s
s
a
g
e
:
n
e
w
`
 
/
 
`
m
e
s
s
a
g
e
:
u
p
d
a
t
e
d
`
 
/
 
`
m
e
s
s
a
g
e
:
d
e
l
e
t
e
d
`
（
完
整
 
D
T
O
，
非
 
d
i
f
f
）
 
|
 
`
s
r
c
/
m
e
s
s
a
g
e
s
/
b
u
s
.
t
s
`
 
|

### 测试

```text
packages/contracts   4 文件 / 29 用例
apps/server         17 文件 / 107 用例（其中 57 个需要真实数据库）
apps/web             1 文件 /  9 用例（4.3.4 客户端状态机，纯逻辑无需浏览器）
合计                22 文件 / 145 用例，全绿
```

### 真实数据库闸门

`apps/server/tests/integration/database.test.ts` 是仓库里唯一会连真库的测试。
由 `INTEGRATION_DATABASE_URL` 控制：不设这个变量时那 57 个用例整体 skip（server 包内），
所以 `pnpm test` 在没有任何数据库的机器上依然全绿。跑它：

```bash
docker compose -f infra/db/docker-compose.yml up -d
INTEGRATION_DATABASE_URL="postgres://gyq:gyq_dev_pw@localhost:55432/gyq_dev" \
  pnpm --filter @gongyouquan/server test
```

PowerShell 用 `$env:INTEGRATION_DATABASE_URL="..."` 单独一行。用例跑完会把自己造的数据清干净，可以对同一个库反复跑。

---

## 5. 还没做到的（按重要性）

1. ~~真实 PostgreSQL 验证~~ **已完成**（2026-09-13）—— 建库、迁移幂等、checksum 防篡改、auth/groups 的 SQL 都已在 PG 17.11 上跑过，并固化成测试。数据库这边只剩说明书 1685 行要求的 `EXPLAIN (ANALYZE, BUFFERS)` + 几千行样例数据。
2. ~~成员管理与邀请码接口~~ **已落地**：加人（含复活）、踢人、退出、改角色、转让群主、邀请码增/查/撤销，10 个真库用例按 3.4 逐格钉。仍缺：离职转交的批量入口、`notification_prefs`、以及成员列表的 `includeRemoved` 查询参数。
3. ~~限流~~ **已落地**：login 双维度、register、refresh 会话族、发消息双维度、写接口兜底，429 带 `Retry-After`；`logout-all` 已实现。取舍见 `docs/decisions/0007`。仍缺：`/hooks/*` 的幂等与聚合（属于 `ops` 模块）、改密接口（`logout-all` 目前只能由前端显式调用）。
4. **messages / sync 已打通（服务端 + 客户端）；仍缺**：已读回执 `GET /messages/:mid/receipts`（4.4.3 的 detail 分级）、`typing:*` 与 `presence:updated`、`mention:new`、编辑/撤回窗口过期的 socket 侧对 `read:updated` 的推送、`/messages/:mid/raw` 的 HTTP 路由（service 已有）。之后是 `tasks` / `files` / `search` / `ops`。
5. **浏览器端已可用**（React + Vite，真库 + 真 socket 手工验证过一轮，且已有 新建群 / 生成邀请码 入口）。仍缺：Electron 外壳（`apps/desktop`）、改密入口、已读回执展示、归档群入口、以及成员管理界面（服务端接口齐了，界面还没做）。**注意**：界面里仍然没有「已登录用户凭邀请码入群」，那不是漏的——说明书 3.1 第 209 行把邀请码定义成**注册时**消耗的东西，没有任何接口让已有账号兑换它，加个输入框只会必然报错。
6. **部署：本地全栈已可一键起**（`infra/deploy/docker-compose.yml`：Postgres + API + Caddy 静态托管与反代，含三条健康检查与 `create-admin` 引导）。**仍缺**：备份与恢复演练（说明书 §9 要求）、systemd 单元、`opsctl`、`/internal/metrics`、告警接入、以及生产版的 secret 注入——compose 里的口令是开发值，不能带上公网。
7. **`CONTRACT_VERSION` 目前是注入的常量**，不是说明书 §7 第 4 条要求的「contracts 包 hash 前 8 位」。构建期没有计算步骤，`create-admin` 与 compose 只是把环境变量透传下去。
7. **`lint` 是空转** —— 根有 `lint` script，两个子包都没定义，`--if-present` 直接跳过。CI 里的 "lint" 步骤没有任何实际作用。

---

## 6. 命令速查

```bash
pnpm install --frozen-lockfile     # 依赖已锁定，勿随手升级
pnpm test                          # 会自动先构建 contracts（pretest 钩子）
pnpm typecheck                     # 同上（pretypecheck 钩子）
pnpm build                         # 构建 contracts（server 目前只做类型检查）
pnpm --filter @gongyouquan/server test        # 只跑服务端
pnpm --filter @gongyouquan/contracts test     # 只跑契约
```

真实数据库闸门（不设 `INTEGRATION_DATABASE_URL` 时那 57 个用例整体 skip）：

```bash
docker compose -f infra/db/docker-compose.yml up -d      # postgres:17-alpine，宿主端口 55432
INTEGRATION_DATABASE_URL="postgres://gyq:gyq_dev_pw@localhost:55432/gyq_dev" \
  pnpm --filter @gongyouquan/server test
```

服务端启动（**需要先有可用的 PostgreSQL**）：

```bash
cp .env.example .env               # 填入 DATABASE_URL / JWT_SECRET 等
pnpm --filter @gongyouquan/server dev
```

启动即执行迁移；数据库不可用时进程会失败退出，`/readyz` 也不会假装就绪——这是刻意的（见 decisions 0002）。

---

## 7. 质量闸门与它的盲区

`.github/workflows/ci.yml`：单 job，ubuntu-latest，node 22，pnpm 9.15.9，依次跑 `check:workspace` → `lint` → `typecheck` → `test`。

盲区 1、2 已修，3 仍在：

1. ~~CI 只在 `main` 触发~~ **已修** —— `push.branches` 加了 `'feat/**'`（带引号：裸 `**` 在 YAML 1.1 里有被当别名解析的风险）。
2. ~~CI 里没有 PostgreSQL~~ **已修** —— 新增 `integration` job，`needs: quality`，带 `postgres:17-alpine` service 容器与 `pg_isready` 健康检查。`INTEGRATION_DATABASE_URL` 只在这个 job 里设，`quality` 保持不联网、快、稳。
3. **`lint` 仍然空转**（见第 5 节第 7 条）—— 仓库锁定的 388 个依赖里没有任何 linter，装一个要动 `pnpm-lock.yaml`，留作独立提交。

---

## 8. 说明书里的矛盾与我们的取舍

三份 decision 都是 `open` 状态，意味着**取舍已实现，但说明书本身还没修订**。接手后如果与产品/需求方对齐，应该回头关掉它们。

| 文件 | 关键内容 |
|---|---|
| `0001-project-baseline.md` | 基线约定（accepted）。注意：其中「lockfile 待生成」一条已过期 |
| `0002-database-spec-clarifications.md` | 5 处矛盾：DDL 执行范围、软删除 vs `ON DELETE CASCADE`、搜索索引范围、索引数量、容量估算。（末节「当前验证状态」已于 2026-09-13 改写为已完成） |
| `0003-auth-contract-clarifications.md` | `AUTH_INVALID_CREDENTIALS` 不在错误码表、邀请码 role 落点、注册事务边界 |
| `0004-groups-guards-and-archival.md` | guard 是否看归档态（224 行 vs 236 行自相矛盾）、归档群 PATCH 未定义、非成员读返回 403 还是 404 |
| `0006-messages-sync-contract-gaps.md` | **`messages` 缺 `updated_at`，而 4.3.4 把它列为硬要求**（已补迁移 0002）、WS 与 HTTP 的 send ack 不一致、`clientMsgId` 该不该在边界收成 UUID、`asOfSeq` 的定义会让客户端位点倒退、本轮只发得出 text/system |
| `0005-real-database-findings.md` | 真库首跑暴露 6 条：**回滚不产生 seq 空洞（推翻说明书 4.2 与验收表第 2 项）**、未读不排除撤回消息、预览与未读对 `system` 口径不一致、硬删群连撤回留痕一起清掉、`files.uploader_id` 无级联、1685 行的计划验证仍未做 |

几个已经拍死、**改之前先看 decision** 的行为：

- 归档群：读放行，写返回 `409 GROUP_ARCHIVED`（不是 403）。guard 不看归档态。
- 非成员读群详情/成员列表：返回 `404 NOT_FOUND`，不暴露群存在性；写操作才用 `403 FORBIDDEN_*`。
- `GET /groups` 的 `includeArchived` 默认 **false**（说明书没写，这是我们的选择）。
- 登录失败统一 `AUTH_INVALID_CREDENTIALS`，不区分用户名不存在与密码错误。

---

## 9. 环境现状与阻塞

| 项 | 状态 |
|---|---|
| Node（仓库要求） | `>=22 <23` |
| Node（本机） | `v24.16.0` —— **超出范围**，每次 pnpm 调用都会刷 `Unsupported engine` 警告 |
| pnpm | 全局 11.10.0，仓库内被 `packageManager` 钉到 9.15.9（与 CI 一致） |
| Docker 引擎 | 可用（ServerVersion 29.7.2） |
| 迁移加载器 | 已从「硬编码 0001 一个文件」改成按目录列 `NNNN_*.sql` 并排序。`0002_messages_updated_at.sql` 是第一个受益者；空库全跑与老库增量补跑两条路径都已在真库上验过 |
| PostgreSQL 镜像 | 已解决 —— `registry-1.docker.io` 依旧超时，改走 `docker.m.daocloud.io` 镜像源后 `postgres:17-alpine` 已在本地（容器内是 **PG 17.11**） |
| 运行中的数据库 | `gyq-pg` 容器，宿主端口 **55432**（避开本机可能已装的 5432），由 `infra/db/docker-compose.yml` 管理 |
| 本机 psql | 未安装，不在 PATH —— 需要时用 `docker exec gyq-pg psql -U gyq -d gyq_dev` |
| Shell 路径 | 工作目录是 `\\?\E:\工友圈` 形式，个别命令会报 `EISDIR: lstat 'E:'`，换普通盘符路径可绕过 |

**结论（已更新）**：数据库不再是阻塞项。镜像换 daocloud 源即可，CI 侧已加 Postgres service 容器。现在唯一还没解决的环境问题是 **Node 版本**：本机只有 v24.16.0，仓库要求 `>=22 <23`；没有版本管理器，但 `C:/Users/ROG/AppData/Local/hermes/node22/node-v22.23.1-win-x64/` 下躺着一份现成可用的 v22.23.1。

---

## 10. 接手后建议的第一步

1. ~~CI 加 PostgreSQL service + 扩展到 `feat/*`~~ **已做**。
2. ~~真实迁移在 PG 17 上跑通、连跑两次验证第二次 no-op~~ **已做**（§9.4 那条验收），并固化成 `tests/integration/database.test.ts` 的 18 个用例。
3. 切到 Node 22（上面那条路径直接可用，或装个版本管理器），消掉 `Unsupported engine` 警告。
4. 拍板 `docs/decisions/0005` 的六条——尤其**矛盾一**：说明书 4.2 断言回滚会留下 seq 空洞，验收表第 2 项要求「构造回滚事务 → 后续 seq 有跳跃」，但真库证明当前 `alloc_group_seq` 的写法做不到这件事。`asOfSeq` 那条「基石」的验收怎么写，取决于这个决定。
5. 补 `groups` 的成员管理写接口（说明书 3.4 权限矩阵是最容易出错的地方：admin 不能踢 owner、不能踢同级 admin、只有 owner 能改角色）。集成测试已经替我们踩过一次：`group_members` 主键是 `(group_id, user_id)`，被踢成员**复活只能 UPDATE 原行**，再 INSERT 直接撞主键。
6. 再往 `messages` 走 —— 那是说明书里复杂度最高的模块，`seq` 分配器、空洞、`asOfSeq`、补投竞态都在那里。

---

## 11. 最容易踩的坑

1. 客户端必须无条件相信 `sync:pull` 返回的 `asOfSeq`，不能要求 `seq` 连续。**但原因和这份文档原来写的不一样**：真库实测 `alloc_group_seq` 回滚会把号原样归还（计数器更新与行锁同事务），不产生空洞；100 路并发分配也互不重复、无死锁。真正会让 `seq` 不连续的是群被硬删时 `ON DELETE CASCADE` 连整段消息一起清掉。详见 `docs/decisions/0005` 矛盾一与缺口四。
2. **BIGINT 主键必须序列化成字符串**，前端禁止 `Number(id)`。
3. **`clientMsgId` 在重试/降级/401 重放时必须复用**，否则弱网下产生重复消息。
4. `errorEnvelope` 的 `message` 是英文、给日志看；中文文案由前端按 `code` 映射。
5. 迁移文件**只增不改**：已发布的迁移改了 checksum 会导致启动直接失败（这是故意的保护）。加了新迁移就顺手改 `apps/server/tests/db.test.ts` 里那份迁移清单断言，否则静态检查与真库会各说一套。
6. 不要为了「跑起来方便」在 `main.ts` 里塞假的 readiness provider —— `apps/server` 的设计是数据库不可用就不能就绪。

7. **撤回是两行规则，不是一行**：`撤回自己的消息（2 分钟内）` 对 owner/admin/member 都是 ✓，`撤回他人的消息` 只有 owner/admin ✓。写成「管理员免窗口」就等于群主能撤自己三天前的话。见 `docs/decisions/0006` 末节。
8. `outbox.aggregate_id` **没有也不可能有外键**（它是多态的）。消息被删掉后事件会留下来，而 `readyz` 的 lag 取的是「最老的未处理事件」——一条孤儿就能把 lag 永久钉住。worker 必须让每个事件都到终态，见 `docs/decisions/0006` 缺口六。
9. 编辑要同时写 `edited_at`。只改 `body` 的话 `updated_at` 会被触发器推进，测试照样绿，但 `editedAt` 永远是 null，前端显示不出「已编辑」。

10. **`revoked_reason` 是字符串字面量，不是列名。** 单会话登出的 SQL 原来写成 `revoked_reason = logout`（缺引号），单元测试全绿，因为它跑在内存假仓储上；真库套件此前也没有一条用例调用 `logout()`。补 `logout-all` 时才撞上。教训是：**「切片已在真库上跑过」不等于每条 SQL 都被跑过**。
11. **一条 SELECT 拼字符串时，别忘了它到底有没有 `WHERE`**。