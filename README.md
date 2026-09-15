# 工友圈

工友圈是一个面向小团队的群聊与群内任务协作系统。

## 当前状态

后端基础与第一批业务切片已在 `feat/contracts-foundation` 分支推进：

- 三份完整设计说明书已固化在 `docs/specs/`，矛盾与缺口登记在 `docs/decisions/`
- `packages/contracts`：ID/时间/分页/错误/auth/groups 契约与测试
- `apps/server`：`/healthz`、`/readyz`、启动配置校验、Fastify + Socket.IO 单进程入口、
  PostgreSQL 连接池与幂等迁移执行器（`infra/db/migrations/0001-0003`；0001 来自说明书 6.2+6.5，0002 补 `messages.updated_at`，0003 是 `/hooks/alert` 的幂等与聚合）
- `auth` 切片：邀请码注册、登录、Argon2id、refresh 轮换与重用检测、HttpOnly refresh Cookie、Bearer 鉴权
- `groups` 切片：群创建/列表/详情/成员查询/群信息修改，`FORBIDDEN_NOT_MEMBER` 与 `FORBIDDEN_ROLE`
  分离，归档群读放行、写 `409 GROUP_ARCHIVED`
- 已打通：`messages` 写入（发号 / 幂等重发 / 编辑与撤回窗口）、`sync` 补投与读位点、Socket.IO 实时广播，并有端到端套件用两个真客户端验证
- 浏览器端 `apps/web`（React + Vite + TS）：登录/邀请注册、群列表与未读、实时收发、撤回，所有响应都过 `packages/contracts` 的同一套 Zod schema；4.3.4 客户端状态机有 9 个纯逻辑用例
- 本地起法：`docker compose -f infra/db/docker-compose.yml up -d` → `pnpm --filter @gongyouquan/server dev` → `pnpm --filter @gongyouquan/web dev`（Vite 代理 `/api` 与 `/socket.io`）
- 已落地限流：login 双维度、register、refresh 会话族、发消息双维度、写接口兜底（429 带 `Retry-After`），取舍见 `docs/decisions/0007`
- 已落地：成员管理与邀请码（加人 / 踢人 / 退出 / 改角色 / 转让群主 + 邀请码增删查），按说明书 3.4 逐格有真库用例
- 一键全栈（密钥不再写在仓库里，必须先注入）：`cp infra/deploy/.env.example infra/deploy/.env` → `infra/deploy/gen-secrets.sh` →
  `docker compose -f infra/deploy/docker-compose.yml up -d --build`，再
  `docker compose -f infra/deploy/docker-compose.yml run --rm --workdir /app/apps/server server node --import tsx src/cli/create-admin.ts` 建首个账号
  （缺密钥时 `docker compose config` 直接拒绝解析，取舍见 `docs/decisions/0012`）
- 尚未接入：tasks/files/search、Electron（`ops` 只落了 `/hooks/alert` 这一条路，见下）。**备份已经不是一个脚本而是一个容器**：`infra/backup/Dockerfile` + compose 里的 `backup` 服务，由 supercronic 按 `BACKUP_HOUR`/`BACKUP_MINUTE` 调度，`backup-health.sh` 做「多久没有成功备份」的探活；恢复演练真跑过并通过，而且**用的不是本地那一份 dump，是从 restic 仓库里 `restore` 出来的那一份**——`pg_dump → restic → restic restore → pg_restore → 七道验收`整条链一次跑绿（数字见 `docs/HANDOVER.md` §4）
- **`ops` 已经有了第一条路**：`POST /api/v1/hooks/alert` 收 HMAC 签名（无登录态）、必填幂等键、5 分钟聚合窗口，命中后把一行告警经 outbox 发进系统群；`presence` 的计数漂移也从 `console.error` 改成了走这个入口。**备份失败从此会自己说话**：`infra/backup/notify-alert.sh` 是那个签名的 shell 客户端（`openssl dgst -hmac`，与 node 逐字节兼容），`backup-once.sh` 的 `ERR` trap 不再是死信——真跑出来的那一条是 `【critical】备份失败 ×2 / backup · 01:19:01 → 01:19:11 UTC / 停在「第 1 步 pg_dump」（第 59 行）`。签名的格式与取舍见 `docs/decisions/0015`
- 真实 PostgreSQL 验证**已完成**（PG 17.11）：建库、迁移连跑两次为 no-op、checksum 防篡改、auth/groups/messages/sync/members/receipts/mentions/**alert-hooks** 的 SQL 真跑，
  固化为 `apps/server/tests/integration/` 与 `tests/e2e/`（196 个用例分布在 27 个文件，其中 83 个在真库上；由 `INTEGRATION_DATABASE_URL` 开关，不设则整片 skip）
- 本地起库：`docker compose -f infra/db/docker-compose.yml up -d`（宿主端口 55432；镜像走 daocloud 源，Docker Hub 在本机不可达）
- 真库首跑暴露的 6 条矛盾与缺口登记在 `docs/decisions/0005`，其中一条推翻说明书 4.2 关于 seq 空洞的论断
- **不能直接对外上线**：`ops` 还缺 `/hooks/ops-report`、`/hooks/ops-request` 与 `/ops/requests/:rid/decision` 那条审批闭环，以及**一个把 outbox 事件推到终态的 worker**（`processed_at` 现在永远为空，`readyz` 的 lag 单调上涨）；还缺 systemd 单元与 `opsctl`。告警这一侧**缺的不再是落点而是发送方**：`/hooks/alert` 只收签名过的请求，而手册 7.1 设想的 Uptime Kuma 产不出这个 HMAC（未对着真 Kuma 验过，登记在 `docs/decisions/0015` 第五节）。以及这台机器给不了的两样凭据：一把**私钥放在机器外**的 age 密钥，和一个**不在同一台机器上的 restic 仓库**（restic 这一段代码已经真跑通，但验证用的仓库落在 `/backups` 同一个卷上，机器没了它也没了——所以栈里那个 `ALLOW_LOCAL_ONLY=1` 的显式例外**还没到能删的时候**，见 `docs/decisions/0014` 第七节）。Caddy 在这个栈里是 `auto_https off` 的明文 :8080

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
