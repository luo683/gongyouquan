# 0001：项目基线与 Git 版本管理

- 日期：2026-09-13
- 状态：accepted

## 背景

`E:\工友圈` 初始为空目录，GitHub 远端 `git@github.com:luo683/gongyouquan.git` 可访问但没有提交、分支或标签。三份完整说明书原件位于 `E:\Qoder WorkSpace\team-workspace\docs\`。

## 决策

1. 使用 pnpm workspace 作为 monorepo 基础。
2. 默认分支为 `main`，只保留经过验证的状态。
3. 业务开发使用 `feat/<slice>`、`fix/<issue>`、`chore/<scope>` 分支。
4. 提交采用 `type(scope): summary` 格式，一次提交只完成一个可验证变化。
5. 首个里程碑为 `m0-foundation`：只包含规格原件、仓库规则、最小 workspace、README 与决策记录，不声称业务功能已完成。
6. 三份说明书原件复制到 `docs/specs/`，后续发现矛盾时通过新的 decision 记录，不覆盖原文。
7. `.env`、数据库数据卷、上传文件、构建产物、本机配置和凭证永不进入版本库。

## 当前未决项

- 业务依赖尚未安装，`pnpm-lock.yaml` 将在第一个真实 workspace 包加入后生成。
- 说明书中的完整 DDL 尚未在真实 PostgreSQL 实例执行验证。
- M1 的具体切片实现尚未开始。
- 部署与 AI 运维文件只在完成静态安全审查和目标服务器验证后进入发布流程。

## 验证证据

三份规格原件复制后保持原始字节与 SHA-256：

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `01-后端说明书.md` | 118023 | `8e06e8eff97a4286cc4540b83fa75a35e02b029f4469453092b66adb86571212` |
| `02-前端说明书.md` | 78312 | `ac2b59fb511b10cf41bf956d5085901d0e22a5d858a92bc01319aed325a8069c` |
| `03-AI运维手册.md` | 126331 | `56cf005407b01530cf146bb9f9d48eb799d121f3a6cfecc927bc83243ceb4a2f` |
