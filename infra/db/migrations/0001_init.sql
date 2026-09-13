-- Extracted from docs/specs/01-后端说明书.md sections 6.2 and 6.5.
-- Do not edit in place; update the source decision and create a new migration.

CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- 搜索降级路径（中文 2 字以上可用）
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TYPE group_role      AS ENUM ('owner', 'admin', 'member');
CREATE TYPE message_kind    AS ENUM ('text', 'image', 'file', 'system', 'task_card');
CREATE TYPE task_status     AS ENUM ('pending', 'accepted', 'in_progress', 'submitted', 'done', 'cancelled');
CREATE TYPE task_priority   AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE comment_kind    AS ENUM ('comment', 'system');
CREATE TYPE review_result   AS ENUM ('approved', 'rejected');
CREATE TYPE file_storage    AS ENUM ('local', 'oss');
CREATE TYPE file_status     AS ENUM ('pending', 'ready', 'cleaned');
CREATE TYPE ops_severity    AS ENUM ('info', 'warning', 'critical');
CREATE TYPE ops_trigger     AS ENUM ('timer', 'threshold', 'manual');
CREATE TYPE ops_req_status  AS ENUM ('pending', 'approved', 'rejected', 'running', 'done', 'failed', 'expired');

-- ============================================================
-- 账号
-- ============================================================

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,          -- argon2id，格式 $argon2id$v=19$m=19456,t=2,p=1$...
  avatar_key    TEXT,
  disabled_at   TIMESTAMPTZ,                   -- 离职禁用；记录全部保留（3.2）
  disabled_note TEXT,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 登录不区分大小写；用函数索引而非 citext，避免扩展依赖
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));
CREATE INDEX users_active ON users (id) WHERE disabled_at IS NULL;

CREATE TABLE sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id          UUID        NOT NULL,     -- 轮换家族；重用检测时整族作废
  refresh_token_hash CHAR(64)    NOT NULL,     -- sha256 十六进制；不存原文
  replaced_by        UUID        REFERENCES sessions(id),
  revoked_at         TIMESTAMPTZ,
  revoked_reason     TEXT,                     -- 'logout' | 'reuse_detected' | 'password_changed' | 'admin'
  user_agent         TEXT,
  ip                 INET,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_refresh_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_family ON sessions (family_id);
CREATE INDEX sessions_user_alive ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE notification_prefs (
  user_id        BIGINT      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  desktop_notify BOOLEAN     NOT NULL DEFAULT true,
  notify_mention BOOLEAN     NOT NULL DEFAULT true,
  notify_task    BOOLEAN     NOT NULL DEFAULT true,
  dnd_enabled    BOOLEAN     NOT NULL DEFAULT false,
  dnd_start      TIME        NOT NULL DEFAULT '22:00',
  dnd_end        TIME        NOT NULL DEFAULT '08:00',
  dnd_timezone   TEXT        NOT NULL DEFAULT 'Asia/Shanghai',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 群
-- ============================================================

CREATE TABLE groups (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT,
  avatar_key  TEXT,
  last_seq    BIGINT      NOT NULL DEFAULT 0,   -- 消息 seq 分配器（4.2）
  task_seq    INT         NOT NULL DEFAULT 0,   -- 群内任务编号分配器
  is_archived BOOLEAN     NOT NULL DEFAULT false,
  is_system   BOOLEAN     NOT NULL DEFAULT false, -- 运维告警群等；审批权限挂在这个群的 owner/admin 上
  created_by  BIGINT      REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX groups_listable ON groups (is_archived, updated_at DESC) WHERE is_archived = false;

CREATE TABLE group_members (
  group_id   BIGINT      NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role       group_role  NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_by BIGINT      REFERENCES users(id),
  removed_at TIMESTAMPTZ,                       -- 退群/被踢是软删除；重新加入时复活本行
  removed_by BIGINT      REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_of_user ON group_members (user_id) WHERE removed_at IS NULL;
-- 每个群恰有一个群主
CREATE UNIQUE INDEX group_members_single_owner ON group_members (group_id)
  WHERE role = 'owner' AND removed_at IS NULL;

CREATE TABLE group_invites (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   BIGINT      NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  code       TEXT        NOT NULL,
  role       group_role  NOT NULL DEFAULT 'member',
  max_uses   INT,                               -- NULL = 不限次数
  used_count INT         NOT NULL DEFAULT 0,
  created_by BIGINT      NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX group_invites_code_key ON group_invites (code);
CREATE INDEX group_invites_usable ON group_invites (group_id)
  WHERE revoked_at IS NULL;

-- ============================================================
-- 文件（先建，供两套 attachments 引用）
-- ============================================================

CREATE TABLE files (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key  TEXT         NOT NULL,            -- 存储键，不含前导斜杠（防路径穿越）
  sha256      CHAR(64)     NOT NULL,
  byte_size   BIGINT       NOT NULL CHECK (byte_size > 0),
  mime_type   TEXT         NOT NULL,
  storage     file_storage NOT NULL DEFAULT 'local',
  status      file_status  NOT NULL DEFAULT 'pending',
  uploader_id BIGINT       REFERENCES users(id),
  ref_count   INT          NOT NULL DEFAULT 0,  -- 提示字段，不是清理依据（见 6.12）
  cleaned_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX files_object_key_key ON files (object_key);
CREATE INDEX files_sha ON files (sha256);
CREATE INDEX files_cleanup_scan ON files (created_at) WHERE status = 'ready';

-- ============================================================
-- 消息
-- ============================================================

CREATE TABLE messages (
  id            BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id      BIGINT       NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  seq           BIGINT       NOT NULL,
  sender_id     BIGINT       REFERENCES users(id),   -- NULL = 系统/机器人消息
  client_msg_id UUID,                                -- 客户端幂等键（4.3）
  kind          message_kind NOT NULL DEFAULT 'text',
  body          TEXT,
  task_id       BIGINT,                              -- task_card / 任务状态提示；FK 稍后补
  meta          JSONB,                               -- 卡片快照、系统消息结构化负载
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  edited_at     TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,                         -- 软删除留痕
  deleted_by    BIGINT       REFERENCES users(id)
);
-- 排序与增量拉取的唯一依据
CREATE UNIQUE INDEX messages_group_seq_key ON messages (group_id, seq);
-- 幂等去重：同一发送者同一 clientMsgId 只能有一条
CREATE UNIQUE INDEX messages_client_msg_key ON messages (sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
-- 任务卡片与任务状态提示
CREATE INDEX messages_by_task ON messages (group_id, task_id) WHERE task_id IS NOT NULL;
-- 中文搜索降级路径；体积较大，见 6.10 容量估算
CREATE INDEX messages_body_trgm ON messages USING gin (body gin_trgm_ops)
  WHERE deleted_at IS NULL AND body IS NOT NULL;

CREATE TABLE message_attachments (
  message_id BIGINT       NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id    UUID         NOT NULL REFERENCES files(id),
  kind       message_kind NOT NULL,             -- image | file
  sort_order SMALLINT     NOT NULL DEFAULT 0,
  file_name  TEXT         NOT NULL,             -- 原始文件名，仅用于展示
  thumb_key  TEXT,                              -- 缩略图对象键（图片）
  width      INT,
  height     INT,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX message_attachments_by_file ON message_attachments (file_id);

CREATE TABLE message_mentions (
  message_id        BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mentioned_user_id BIGINT      NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  group_id          BIGINT      NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  seq               BIGINT      NOT NULL,       -- 冗余：让"@我未读"能走单索引，不必 JOIN messages
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, mentioned_user_id)
);
CREATE INDEX message_mentions_unread ON message_mentions (mentioned_user_id, group_id, seq DESC);

CREATE TABLE message_refs (
  message_id     BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  ref_message_id BIGINT NOT NULL    REFERENCES messages(id) ON DELETE CASCADE,
  ref_snapshot   JSONB  NOT NULL,   -- 被引用消息的快照（发送者/摘要），原消息撤回后仍可展示
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 单层引用：一张 messages 行最多有一条 refs 记录（主键即 message_id），不做嵌套
CREATE INDEX message_refs_target ON message_refs (ref_message_id);

CREATE TABLE read_positions (
  user_id           BIGINT      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  group_id          BIGINT      NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  last_read_seq     BIGINT      NOT NULL DEFAULT 0,
  mentions_read_seq BIGINT      NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);
-- 已读回执聚合查询（"读到 seq >= X 的成员数"）
CREATE INDEX read_positions_by_group_seq ON read_positions (group_id, last_read_seq);

-- ============================================================
-- 任务
-- ============================================================

CREATE TABLE tasks (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id         BIGINT        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  task_no          INT           NOT NULL,      -- 群内编号，对用户展示为 #12
  title            TEXT          NOT NULL,
  description      TEXT,
  status           task_status   NOT NULL DEFAULT 'pending',
  priority         task_priority NOT NULL DEFAULT 'normal',
  assignee_id      BIGINT        REFERENCES users(id),   -- 指派制（3.5）
  creator_id       BIGINT        NOT NULL REFERENCES users(id),
  due_at           TIMESTAMPTZ,
  comment_count    INT           NOT NULL DEFAULT 0,     -- 看板展示用冗余计数
  attachment_count INT           NOT NULL DEFAULT 0,
  accepted_at      TIMESTAMPTZ,
  submitted_at     TIMESTAMPTZ,
  done_at          TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tasks_group_no_key ON tasks (group_id, task_no);
-- 看板：按群 + 状态，按截止时间（NULL 排最后）与优先级排序
CREATE INDEX tasks_board ON tasks (group_id, status, due_at ASC NULLS LAST, priority DESC);
-- 跨群「我的任务」（6.7）
CREATE INDEX tasks_by_assignee ON tasks (assignee_id, status, due_at ASC NULLS LAST)
  WHERE assignee_id IS NOT NULL;
-- 逾期清单
CREATE INDEX tasks_overdue ON tasks (group_id, due_at)
  WHERE status NOT IN ('done', 'cancelled') AND due_at IS NOT NULL;

-- messages.task_id 的外键（循环依赖，故在两表都建好后补）
ALTER TABLE messages
  ADD CONSTRAINT messages_task_fk FOREIGN KEY (task_id)
  REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE task_status_history (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status task_status,
  to_status   task_status NOT NULL,
  actor_id    BIGINT      REFERENCES users(id),
  reason      TEXT,                              -- 打回原因（rejected 时必填）/ 取消原因
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_history_by_task ON task_status_history (task_id, created_at);
-- 打回次数统计（6.8）
CREATE INDEX task_history_rejects ON task_status_history (to_status, created_at)
  WHERE from_status = 'submitted' AND to_status = 'in_progress';

CREATE TABLE task_acceptances (
  id           BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      BIGINT        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round_no     INT           NOT NULL,           -- 第几轮提交（从 1 起）
  submitter_id BIGINT        NOT NULL REFERENCES users(id),
  submitted_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  submit_note  TEXT,
  reviewer_id  BIGINT        REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  result       review_result,
  review_note  TEXT
);
CREATE UNIQUE INDEX task_acceptances_round_key ON task_acceptances (task_id, round_no);
CREATE INDEX task_acceptances_pending ON task_acceptances (task_id) WHERE reviewed_at IS NULL;

CREATE TABLE task_comments (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id          BIGINT       NOT NULL REFERENCES tasks(id)    ON DELETE CASCADE,
  group_id         BIGINT       NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  author_id        BIGINT       REFERENCES users(id),
  kind             comment_kind NOT NULL DEFAULT 'comment',
  body             TEXT         NOT NULL,
  progress_percent SMALLINT     CHECK (progress_percent BETWEEN 0 AND 100),
  mentioned_user_ids BIGINT[],                  -- @提及；注意与 message_mentions 的差异，见 6.6
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX task_comments_by_task ON task_comments (task_id, created_at);
CREATE INDEX task_comments_mentions ON task_comments USING gin (mentioned_user_ids)
  WHERE mentioned_user_ids IS NOT NULL;

CREATE TABLE task_comment_attachments (
  task_comment_id BIGINT       NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
  file_id         UUID         NOT NULL REFERENCES files(id),
  kind            message_kind NOT NULL,
  sort_order      SMALLINT     NOT NULL DEFAULT 0,
  file_name       TEXT         NOT NULL,
  thumb_key       TEXT,
  width           INT,
  height          INT,
  PRIMARY KEY (task_comment_id, file_id)
);
CREATE INDEX task_comment_attachments_by_file ON task_comment_attachments (file_id);

-- ============================================================
-- 搜索（transactional outbox）
-- ============================================================

CREATE TABLE outbox (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type TEXT        NOT NULL,          -- 'message' | 'task_comment'
  aggregate_id   BIGINT      NOT NULL,
  event_type     TEXT        NOT NULL,          -- 'upsert' | 'delete'
  payload        JSONB       NOT NULL,          -- 自包含索引文档，worker 不回查业务表
  attempts       INT         NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX outbox_pending ON outbox (created_at) WHERE processed_at IS NULL;

-- ============================================================
-- 审计与运维
-- ============================================================

CREATE TABLE audit_logs (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    BIGINT      REFERENCES users(id),
  actor_kind  TEXT        NOT NULL DEFAULT 'user',  -- 'user' | 'ops_bot' | 'system'
  action      TEXT        NOT NULL,                 -- 'message.delete' | 'member.role_change' | ...
  target_type TEXT,
  target_id   TEXT,
  group_id    BIGINT      REFERENCES groups(id) ON DELETE SET NULL,
  meta        JSONB,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_actor  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_by_action ON audit_logs (action, created_at DESC);
CREATE INDEX audit_by_group  ON audit_logs (group_id, created_at DESC);

CREATE TABLE ops_requests (
  id              BIGINT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin          TEXT           NOT NULL,      -- 'agent' | 'admin'
  requester_id    BIGINT         REFERENCES users(id),   -- 人工触发时为发起的管理员
  command_key     TEXT,                         -- 白名单动作键（如 'deploy'）——不是自由命令文本
  command_args    JSONB          NOT NULL DEFAULT '{}'::jsonb,
  reason          TEXT,
  evidence        JSONB,                        -- agent 的诊断依据（结构化指标）
  severity        ops_severity   NOT NULL DEFAULT 'warning',
  status          ops_req_status NOT NULL DEFAULT 'pending',
  idempotency_key TEXT,
  message_id      BIGINT         REFERENCES messages(id),  -- 群里那条带按钮的消息
  decided_by      BIGINT         REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  result          TEXT,
  expires_at      TIMESTAMPTZ,                  -- 过期未决自动置 expired，避免半夜积压的请求次日被误批
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ops_requests_idem ON ops_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ops_requests_open ON ops_requests (status, created_at)
  WHERE status IN ('pending', 'approved', 'running');

CREATE TABLE ops_runs (
  id                BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            TEXT         NOT NULL,      -- 与 agent transcript 文件名一致
  trigger           ops_trigger  NOT NULL,
  severity          ops_severity NOT NULL,
  alert_fingerprint TEXT,                       -- 冷却去重（同一指纹 1 小时内不重复处理）
  model             TEXT,
  input_tokens      INT,
  output_tokens     INT,
  cost_usd          NUMERIC(10,4),
  commands          JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- [{cmd, exit, at}]
  outcome           TEXT,                       -- 'resolved'|'needs_human'|'noop'|'failed'
  summary           TEXT,
  transcript_path   TEXT,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX ops_runs_run_key ON ops_runs (run_id);
CREATE INDEX ops_runs_recent ON ops_runs (started_at DESC);
CREATE INDEX ops_runs_fingerprint ON ops_runs (alert_fingerprint, started_at DESC);

CREATE TABLE ops_heartbeat (
  source  TEXT        PRIMARY KEY,              -- 'api' | 'worker'
  beat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 函数与触发器
-- ============================================================

-- 通用 updated_at 维护
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_users_updated            BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_groups_updated           BEFORE UPDATE ON groups           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tasks_updated            BEFORE UPDATE ON tasks            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_task_comments_updated    BEFORE UPDATE ON task_comments    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_notif_prefs_updated      BEFORE UPDATE ON notification_prefs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 消息 seq 分配器（4.2）
CREATE OR REPLACE FUNCTION alloc_group_seq(p_group_id BIGINT) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v_seq BIGINT;
BEGIN
  UPDATE groups SET last_seq = last_seq + 1 WHERE id = p_group_id RETURNING last_seq INTO v_seq;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'group % not found', p_group_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_seq;
END $$;

-- 群内任务编号分配器
CREATE OR REPLACE FUNCTION alloc_task_no(p_group_id BIGINT) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE v_no INT;
BEGIN
  UPDATE groups SET task_seq = task_seq + 1 WHERE id = p_group_id RETURNING task_seq INTO v_no;
  IF v_no IS NULL THEN
    RAISE EXCEPTION 'group % not found', p_group_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_no;
END $$;

-- 附件引用计数（提示字段；清理不依赖它，见 6.12）
CREATE OR REPLACE FUNCTION bump_file_ref_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE files SET ref_count = ref_count + 1 WHERE id = NEW.file_id;
    RETURN NEW;
  ELSE
    UPDATE files SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = OLD.file_id;
    RETURN OLD;
  END IF;
END $$;

CREATE TRIGGER trg_msg_att_ref AFTER INSERT OR DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION bump_file_ref_count();
CREATE TRIGGER trg_cmt_att_ref AFTER INSERT OR DELETE ON task_comment_attachments
  FOR EACH ROW EXECUTE FUNCTION bump_file_ref_count();
