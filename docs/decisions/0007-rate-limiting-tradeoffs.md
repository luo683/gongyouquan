# 0007：限流落地时的取舍

- 日期：2026-09-13
- 状态：open
- 关联章节：`01-后端说明书.md` 第 3.1、5.2、5.5、8.1、8.2 节
- 关联决定：`0003-auth-contract-clarifications.md`

## 一：refresh 的 family 维度无法「在任何数据库操作之前」检查

第 1569 行要求「限流检查必须在任何数据库操作之前，否则限流本身不省资源」。第 1573 行同时要求 `POST /auth/refresh` 按**会话 family** 限 30/分钟。

这两条在 refresh 上直接冲突：family 存在数据库里，只能拿 refresh token 哈希查一次 `sessions` 才知道。没有 token→family 的本地映射可以省掉这一跳（那等价于把会话状态复制进内存，重启即失效，且与「重用检测」的权威判定来源冲突）。

**当前实现决定**：family 桶在 `findSessionByRefreshHash` 之后、`rotateSession` 之前取。一次刷新风暴的代价因此从「1 SELECT + 1 INSERT + 2 UPDATE」降到「1 次带索引的 SELECT」。其余四个维度（login×IP、login×用户名、register×IP、发消息两维、其他写兜底）都在任何数据库操作之前，符合原文。

若需求方认为这一跳也不可接受，唯一干净的解法是把 family 编进 refresh token 本身（带签名的 payload），代价是 token 变长且轮换逻辑重写——需要另立决定。

## 二：429 的 `Retry-After` 在 WebSocket 上没有对应的载体

第 1561 行写「429 响应带 `Retry-After`」。HTTP 侧照做了（`guarded()` 检测 `RateLimitedError` 后写头）。WS 侧没有响应头这个东西，第 729-740 行的 ack 表也只写了 `{error}` 没写细节。

**当前实现决定**：WS 的 ack 返回 `{ error: { code: 'RATE_LIMITED', message, details: { retryAfterSeconds, scope } } }`，把等待时间放进 `details`，语义与 HTTP 头等价。前端两侧读同一个字段即可，不需要知道自己是哪条传输。

## 三：限流桶活在进程内存里

第 1569 行明写「单进程内用令牌桶」，与 1.x 的单进程部署一致。实现照做，并给桶表加了上界（1 万个 key，按插入序丢最冷的一半）——否则攻击者用一万个不同用户名登录就能把内存吃满，而这恰好是限流本该防的事。

需要写下来的前提是：**加副本会把每个限额乘以副本数**。真要横向扩展，桶必须搬到 PostgreSQL 或 Redis，而不是多开进程。

## 四：本轮没有实现的限额行

第 1567-1581 行的表里有五行对应的接口还不存在，因此**没有**预埋空壳限流器：

| 行 | 状态 |
|---|---|
| 文件上传 20/小时 | `files` 模块未开始 |
| 搜索 60/分钟 | `search` 模块未开始 |
| 创建任务/评论 120/小时 | `tasks` 模块未开始 |
| `/hooks/*` 120/分钟 + 幂等 + 聚合 | `ops` 模块未开始；第 1585 行关于「告警风暴本身是故障场景，此时后端必须活着」的要求一并待做 |
| 其他写接口 600/分钟兜底 | **已实现**，覆盖 group create/update、message edit/delete；`messages` 的两维单独计数 |

`typing:*` 不落库、可丢，第 739 行明确它没有 ack，因此不限流。

## 五：`/auth/logout` 与 `/auth/logout-all` 的鉴权不对称

第 622-623 行两条都标「已登录」。`logout-all` 照标加了 `requireAuth`；`logout` **保持现状**（无 preHandler），因为它以 refresh token 本身为凭据——持有 token 即证明身份，这与 3.1 节「Bearer 校验不查库」的取舍一致。

**当前实现决定**：不动 `logout`。若要严格按表格给它也加 Bearer 校验，需要先确认前端在 access token 已过期、只剩 HttpOnly refresh cookie 的场景下还能不能正常登出——那个场景下加了就会 401。留给需求方拍板。

## 六：一条真库测试抓到的既有缺陷

`revokeSession`（单会话登出路径）的 SQL 写的是 `revoked_reason = logout`，少了引号。PostgreSQL 把它当成列引用，运行时报 `column "logout" does not exist`。

它此前从未暴露，因为单元测试全部走内存假仓储，而真库套件里没有一条用例调用过 `logout()`。本轮补上 `logout-all` 用例时顺手覆盖了这条路径，并且做过反向验证：把引号改回去，套件立刻红。

**这不是新增功能的缺陷，是既有代码的缺陷**，说明「auth 切片已在真库上跑过」这句话此前的覆盖面比它听起来要窄。
