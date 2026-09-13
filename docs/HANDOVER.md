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
| **auth**：邀请码注册（同事务消耗次数）、Argon2id、登录、refresh 轮换、旧 token 重用→整族撤销、logout | `src/auth/` |
| **groups**：建群（创建者 owner）、群列表、详情（含 `myMembership`）、成员列表、改群信息 | `src/groups/` |

### 测试

```text
packages/contracts   4 文件 / 29 用例
apps/server         11 文件 / 56 用例（其中 19 个需要真实数据库）
合计                15 文件 / 85 用例，全绿
```

### 真实数据库闸门

`apps/server/tests/integration/database.test.ts` 是仓库里唯一会连真库的测试。
由 `INTEGRATION_DATABASE_URL` 控制：不设这个变量时那 19 个用例整体 skip，
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
2. **成员管理与邀请码接口** —— 踢人 / 加人（复活）/ 改角色 / 转让群主 / 邀请码增删查。
3. **限流**（login 双维度、register、refresh 全缺）、`logout-all`、refresh Cookie 清除响应。
4. **messages / sync / tasks / files / search / ops** —— 说明书第 4 节说消息同步占 70% 复杂度。线格式已在 `packages/contracts` 落地、由 17 个用例钉住；服务端实现（复用 `alloc_group_seq`、幂等收口、`sync:pull` + `asOfSeq`、socket 广播、编辑与撤回窗口）仍然一行没写。`tasks` / `files` / `search` / `ops` 未开始。
5. **浏览器端（React）、Electron 外壳**。
6. **部署与运维** —— Docker Compose、Caddyfile、备份、systemd、opsctl 全部未开始。
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

真实数据库闸门（不设 `INTEGRATION_DATABASE_URL` 时那 19 个用例整体 skip）：

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
