# 工友圈

工友圈是一个面向小团队的群聊与群内任务协作系统。

## 当前状态

后端基础与第一批业务切片已在 `feat/contracts-foundation` 分支推进：

- 三份完整设计说明书已固化在 `docs/specs/`，矛盾与缺口登记在 `docs/decisions/`
- `packages/contracts`：ID/时间/分页/错误/auth/groups 契约与测试
- `apps/server`：`/healthz`、`/readyz`、启动配置校验、Fastify + Socket.IO 单进程入口、
  PostgreSQL 连接池与幂等迁移执行器（`infra/db/migrations/0001_init.sql`，来自说明书 6.2+6.5）
- `auth` 切片：邀请码注册、登录、Argon2id、refresh 轮换与重用检测、HttpOnly refresh Cookie、Bearer 鉴权
- `groups` 切片：群创建/列表/详情/成员查询/群信息修改，`FORBIDDEN_NOT_MEMBER` 与 `FORBIDDEN_ROLE`
  分离，归档群读放行、写 `409 GROUP_ARCHIVED`
- 尚未接入：成员管理写接口、邀请码管理、messages/sync/tasks、浏览器端、Electron、部署与运维
- 真实 PostgreSQL 验证**已完成**（PG 17.11）：建库、迁移连跑两次为 no-op、checksum 防篡改、auth/groups 的 SQL 真跑，
  固化为 `apps/server/tests/integration/database.test.ts`（18 个用例，由 `INTEGRATION_DATABASE_URL` 开关；不设则该文件整体 skip）
- 本地起库：`docker compose -f infra/db/docker-compose.yml up -d`（宿主端口 55432；镜像走 daocloud 源，Docker Hub 在本机不可达）
- 真库首跑暴露的 6 条矛盾与缺口登记在 `docs/decisions/0005`，其中一条推翻说明书 4.2 关于 seq 空洞的论断
- 仍未接入部署与运维，**不要把它当作可部署版本**

## 目录约定

```text
apps/server       后端单进程服务
apps/web          浏览器端
apps/desktop      Electron 外壳
packages/contracts 共享接口与数据契约
infra              数据库、Docker、Caddy 与 AI 运维模板
docs/specs        完整设计说明书
docs/decisions    设计决策与矛盾登记
```

## 开发原则

1. 三份说明书是设计真源；发现矛盾时新增 decision，不直接改写原文。
2. 业务代码遵循测试先行：先写一个能正确失败的测试，再写最小实现。
3. `main` 只保留可验证状态；日常工作使用 `feat/*`、`fix/*`、`chore/*` 分支。
4. 不提交 `.env`、Token、私钥、数据库数据、上传文件和构建产物。
5. 不使用 `git push --force`。

## 常用命令

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

锁文件已存在；CI 用 `pnpm install --frozen-lockfile` 复现同一依赖树。`pnpm test` / `pnpm typecheck` 会自动先构建 `packages/contracts`（见 `pretest` / `pretypecheck` 钩子）。服务端本地启动需要先有 PostgreSQL（见 `docs/decisions/0002-database-spec-clarifications.md` 的验证状态）。

## Git 提交约定

提交格式：`type(scope): summary`

示例：

```text
chore(repo): initialize workspace
feat(contracts): add auth schemas
fix(messages): preserve sync cursor across reconnect
```

里程碑标签：`m0-foundation`、`m1-alpha`。
