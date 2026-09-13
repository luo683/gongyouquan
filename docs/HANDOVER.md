# 交接文档：工友圈

- 编写日期：2026-09-13
- 适用仓库：`E:\工友圈`（远端 `git@github.com:luo683/gongyouquan.git`）
- 交接起点：`feat/contracts-foundation` 分支，本文件所在提交即当前进度点
- 设计真源：`docs/specs/` 下三份说明书（**不要改原文**，矛盾走 `docs/decisions/`）

---

## 1. 一句话现状

后端骨架和 `auth`、`groups` 两个垂直切片已经落地并有测试覆盖；**数据库从未在真实 PostgreSQL 上跑过**，业务只完成了很小一部分，当前**不可部署、不可演示**。

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
```

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
packages/contracts   3 文件 / 12 用例
apps/server         10 文件 / 35 用例
合计                13 文件 / 47 用例，全绿
```

---

## 5. 还没做到的（按重要性）

1. **真实 PostgreSQL 验证** —— 迁移、DDL、auth/groups 的 SQL 都没在真库上跑过。
2. **成员管理与邀请码接口** —— 踢人 / 加人（复活）/ 改角色 / 转让群主 / 邀请码增删查。
3. **限流**（login 双维度、register、refresh 全缺）、`logout-all`、refresh Cookie 清除响应。
4. **messages / sync / tasks / files / search / ops** —— 说明书第 4 节说消息同步占 70% 复杂度，一行没写。
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

服务端启动（**需要先有可用的 PostgreSQL**）：

```bash
cp .env.example .env               # 填入 DATABASE_URL / JWT_SECRET 等
pnpm --filter @gongyouquan/server dev
```

启动即执行迁移；数据库不可用时进程会失败退出，`/readyz` 也不会假装就绪——这是刻意的（见 decisions 0002）。

---

## 7. 质量闸门与它的盲区

`.github/workflows/ci.yml`：单 job，ubuntu-latest，node 22，pnpm 9.15.9，依次跑 `check:workspace` → `lint` → `typecheck` → `test`。

三个盲区，交接后请优先处理：

1. **CI 只在 `main` 的 push 和 PR 上触发** —— `feat/*` 推上去不会跑，当前开发分支从未被 CI 验证过。
2. **CI 里没有 PostgreSQL** —— 所以「真实数据库未验证」这件事，CI 永远不会替你发现，它只会一路绿灯。
3. **`lint` 空转**（见第 5 节第 7 条）。

---

## 8. 说明书里的矛盾与我们的取舍

三份 decision 都是 `open` 状态，意味着**取舍已实现，但说明书本身还没修订**。接手后如果与产品/需求方对齐，应该回头关掉它们。

| 文件 | 关键内容 |
|---|---|
| `0001-project-baseline.md` | 基线约定（accepted）。注意：其中「lockfile 待生成」一条已过期 |
| `0002-database-spec-clarifications.md` | 5 处矛盾：DDL 执行范围、软删除 vs `ON DELETE CASCADE`、搜索索引范围、索引数量、容量估算 |
| `0003-auth-contract-clarifications.md` | `AUTH_INVALID_CREDENTIALS` 不在错误码表、邀请码 role 落点、注册事务边界 |
| `0004-groups-guards-and-archival.md` | guard 是否看归档态（224 行 vs 236 行自相矛盾）、归档群 PATCH 未定义、非成员读返回 403 还是 404 |

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
| PostgreSQL 镜像 | **拿不到** —— `registry-1.docker.io` 连接超时，`postgres:17.2-alpine` 无法拉取 |
| 本机 psql | 未安装，不在 PATH |
| Shell 路径 | 工作目录是 `\\?\E:\工友圈` 形式，个别命令会报 `EISDIR: lstat 'E:'`，换普通盘符路径可绕过 |

**结论**：真实数据库验证被网络阻塞，不是代码问题。要么解决 Docker registry 访问，要么装本地 PostgreSQL，要么在 CI 里加一个 Postgres service 容器（推荐，能顺便补上第 7 节的盲区 2）。

---

## 10. 接手后建议的第一步

1. 切到 Node 22（`nvm use 22` 或等效），消掉引擎警告。
2. 在 CI 里加 PostgreSQL service，并把 CI 触发条件扩展到 `feat/*`（第 7 节盲区 1、2）。
3. 让真实的 `0001_init.sql` 在 PG 17 上跑一次，迁移连跑两次验证第二次是 no-op —— 这是 `docs/specs/01-后端说明书.md` 第 9.4 节要求的验收，目前完全没做。
4. 补 `groups` 的成员管理写接口（说明书 3.4 权限矩阵是最容易出错的地方：admin 不能踢 owner、不能踢同级 admin、只有 owner 能改角色）。
5. 再往 `messages` 走 —— 那是说明书里复杂度最高的模块，`seq` 分配器、空洞、`asOfSeq`、补投竞态都在那里。

---

## 11. 最容易踩的坑

1. **`messages.seq` 会因事务回滚留下永久空洞**，客户端必须无条件相信 `sync:pull` 返回的 `asOfSeq`，不能要求连续。
2. **BIGINT 主键必须序列化成字符串**，前端禁止 `Number(id)`。
3. **`clientMsgId` 在重试/降级/401 重放时必须复用**，否则弱网下产生重复消息。
4. `errorEnvelope` 的 `message` 是英文、给日志看；中文文案由前端按 `code` 映射。
5. 迁移文件**只增不改**：已发布的迁移改了 checksum 会导致启动直接失败（这是故意的保护）。
6. 不要为了「跑起来方便」在 `main.ts` 里塞假的 readiness provider —— `apps/server` 的设计是数据库不可用就不能就绪。
