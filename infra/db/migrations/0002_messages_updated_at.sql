-- ============================================================
-- 0002_messages_updated_at.sql
--
-- 说明书 4.3.4 把 `updatedAt` 写成契约级硬要求：
--   「`message:updated` 与 `message:deleted` 事件必须携带完整消息 DTO（而不是
--     diff），且 DTO 必须包含 `updatedAt`」
-- 乱序到达时，客户端靠「事件 updatedAt 大于本地才覆盖」判定胜负。
--
-- 但 0001_init.sql 的 messages 表只有 created_at / edited_at / deleted_at，
-- 没有 updated_at，也没有挂 set_updated_at 触发器（0001 只给 users / groups /
-- tasks / task_comments / notification_prefs 挂了）。结果是：撤回与编辑没有一
-- 个单调的、可比的时间戳可下发，4.3.4 那套幂等应用无法实现。
--
-- 已在 docs/decisions/0006 登记。迁移文件只增不改，所以修在 0002。
-- ============================================================

ALTER TABLE messages
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN messages.updated_at IS
  '行状态最后变更时间；4.3.4 事件乱序时的覆盖依据。编辑与撤回都会推进它。';

CREATE TRIGGER trg_messages_updated BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 已读回执按 (group_id, last_read_seq > ?) 统计；这一条为 4.4.3 的分级查询准备。
-- messages_group_seq_key 已经是 (group_id, seq) 唯一索引，可直接复用，故此处不再加索引。
