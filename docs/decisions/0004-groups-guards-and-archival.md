# 0004：群组权限与归档语义的缺口登记

- 日期：2026-09-13
- 状态：open
- 关联章节：`01-后端说明书.md` 第 3.3、3.4、3.6、5.3、8.1 节

## 矛盾一：GroupMemberGuard 是否检查归档（第 224 行与第 236 行相反）

第 224 行把成员判定写成「`removed_at IS NULL` **且 group 未归档**」；第 236 行又明确「`is_archived = true` 时，`GroupMemberGuard` **仍放行读操作**」，写拒绝放在 service 层。第 3.6 节表格「归档群读 ✓」、第 9.1 节「读接口正常」都支持后者。

**当前实现决定**：`requireMembership` 只看 `removed_at IS NULL`，不看归档态；归档只通过 `requireWritable` 拒绝写，返回 `409 GROUP_ARCHIVED`（409 而非 403，按第 8.1 错误码表）。建议原文第 224 行删去「且 group 未归档」。

## 缺口二：归档群的 PATCH 改群信息未列入 3.6 表格

3.6 的「写」列只枚举了消息/任务/评论/上传四项，「成员管理」单列；改群信息（PATCH `/groups/:gid`）在归档态既没被列为允许也没被列为禁止。第 647 行「归档后群只读」是唯一的宽泛依据。

**当前实现决定**：按「只读」字面处理——归档群上 PATCH 群信息同样返回 `409 GROUP_ARCHIVED`（owner/admin 也不行）。若产品希望归档群仍可改名，需新的 decision 明确放开。

## 缺口三：非成员读取群信息，403 还是 404

第 8.1 节 `NOT_FOUND` 描述为「资源不存在**或不可见**」；guard 语义又定义了 `FORBIDDEN_NOT_MEMBER`。两者对「陌生人读别人的群」重叠。

**当前实现决定**：读接口（详情、成员列表）对非成员统一返回 `404 NOT_FOUND`，不暴露群存在性；写接口（PATCH）保留 `FORBIDDEN_NOT_MEMBER`/`FORBIDDEN_ROLE` 的区分，因为写操作发起者本应知道群的存在。

## 未定义字段的契约化

说明书只给了字段名级别的约定，以下形态由 `packages/contracts` 首次定义，后续以契约为准：

1. `GroupSummaryDTO.lastMessagePreview`：`{ messageId, kind, body, senderDisplayName, createdAt } | null`；排除已软删除消息；空群为 `null`。
2. `GroupSummaryDTO.unreadCount`：限界 `[0, 100]`，100 为「99+」哨兵（第 4.4.2 节口径：排除自发与 system 消息）。
3. `myMembership`：目前只有 `{ role }`；成员管理界面需要更多字段时再扩展契约。
4. `MemberDTO`：`{ userId, username, displayName, role, joinedAt }`，按 `joined_at` 升序，不分页（群人数上限 50）。
5. `GET /groups` 的 `includeArchived` 默认值说明书未写：**当前实现默认 `false`**（归档群不出现在列表），传 `1`/`true` 才包含。

## 当前仍未覆盖

- 成员管理写接口：踢人/加人（含复活）/角色变更/转让群主/归档群主专属。
- 邀请码创建、列表、撤销（注册消费路径已由 auth 切片覆盖）。
- 真实 PostgreSQL 上的 groups 集成验证（镜像仓库网络仍不可达，同 0002）。
