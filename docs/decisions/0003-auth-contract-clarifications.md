# 0003：认证契约缺口登记

- 日期：2026-09-13
- 状态：open
- 关联章节：`01-后端说明书.md` 第 3.2、5.1、8.1 节

## 记录一：统一认证错误码表缺少 `AUTH_INVALID_CREDENTIALS`

第 3.2 节明确要求用户名不存在和密码错误使用同一个错误码 `AUTH_INVALID_CREDENTIALS`，用于防止账号枚举；第 8.1 节的统一错误码表没有列出它。

**当前实现决定**：登录失败统一返回 `401 AUTH_INVALID_CREDENTIALS`，不区分用户不存在、密码错误或大小写不同的用户名。后续若整理完整错误码表，应保留该 code，不改变现有客户端分支语义。

## 记录二：邀请码 `role` 的注册落点

说明书明确邀请码包含 `role`，注册成功后加入邀请码所属群，但没有用单独一句明确“注册得到的群成员角色直接取邀请码 role”。

**当前实现决定**：注册事务把邀请码的 `role` 写入新建的 `group_members.role`；默认邀请码角色仍为 `member`。如果产品需要限制邀请码只能产生 member，必须另立 decision 并修改契约测试。

## 记录三：注册事务边界

说明书明确注册要同时完成：创建用户、加入邀请码所属群、消耗 `used_count`，但没有在接口章节明确写出事务要求。

**当前实现决定**：这三步在同一 PostgreSQL session 和事务中执行。任一步失败都回滚，避免出现邀请码已消耗但用户未加入群，或用户已创建但次数未消耗的中间状态。

## 当前实现范围

已实现并测试：

- 邀请码注册与一次性消耗
- 用户名大小写不敏感
- Argon2id 密码哈希与校验
- desktop/web 登录响应差异
- web HttpOnly refresh Cookie
- refresh 轮换
- 旧 refresh 重用后整 family 撤销
- logout 撤销当前 session
- 统一错误包装和 requestId

尚未实现：

- IP/用户名/family 限流
- `logout-all`
- 真实 PostgreSQL auth 集成测试
- refresh Cookie 的清除响应
