# 工友圈

工友圈是一个面向小团队的群聊与群内任务协作系统。

## 当前状态

项目刚完成 `m0-foundation` 初始化：

- 三份完整设计说明书已固化在 `docs/specs/`
- 目标架构为 pnpm monorepo
- 后端计划采用 Node.js 22、TypeScript、Fastify、Socket.IO、PostgreSQL
- 前端计划采用 React、Vite、Ant Design，并由 Electron 承载桌面版
- 业务实现尚未开始；不要把当前仓库当作可部署版本

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

当前尚未生成 `pnpm-lock.yaml`，因此在业务依赖加入前不执行 `pnpm install --frozen-lockfile`。见 `docs/decisions/0001-project-baseline.md`。

## Git 提交约定

提交格式：`type(scope): summary`

示例：

```text
chore(repo): initialize workspace
feat(contracts): add auth schemas
fix(messages): preserve sync cursor across reconnect
```

里程碑标签：`m0-foundation`、`m1-alpha`。
