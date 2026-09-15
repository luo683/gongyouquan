-- ============================================================
-- 0003_alert_idempotency_and_aggregation.sql
--
-- 说明书 03 的 5.8 只写了 /hooks/alert 的进出参数，8.2 的限流表末行补了两句要求：
--   「`/hooks/alert` 除了限流，还有幂等（`idempotencyKey`）与聚合（同
--     `(source, title)` 在 5 分钟内合并为一条计数消息）」
-- 而 0001_init.sql 里没有任何一张表能承载这两条：ops_requests 的 idempotency_key
-- 是**审批请求**的键，ops_runs.alert_fingerprint 是 **agent 处理**的 1 小时冷却，
-- 两者都不是「同一条告警重复投递」的落点。缺表已在 docs/decisions/0007 第四节与
-- docs/decisions/0015 登记，迁移文件只增不改，所以补在 0003。
--
-- 两张表各管一件事，不合成一张：
--   alert_windows  一个 (source, title) 的 5 分钟窗口，持有一条群消息
--   alert_events   每一次投递（按 idempotencyKey 唯一），指向它当时所属的窗口
-- 合成一张就没法表达「同一窗口内 N 次投递」，而窗口里那条消息的计数正是从这里来的。
-- ============================================================

CREATE TABLE alert_windows (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- source 与 title 拼成的聚合键，服务端算（'$1' || E'\n' || '$2'）。换行做分隔符是有
  -- 前提的：契约把 source 限成标签字符集、title 限成单行，两半都不可能出现这个字符，
  -- 拼起来才可逆。否则 ("a", "b\nc") 与 ("a\nb", "c") 会挤进同一个窗口。
  agg_key       TEXT        NOT NULL,
  source        TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  -- 窗口内出现过最高等级。warning 后来变 critical 时，那条已经发出去的消息要跟着升级，
  -- 否则运维群里最显眼的位置留着一个「warning」，而实际已经是凌晨备份全挂。
  severity      ops_severity NOT NULL,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count     INT         NOT NULL DEFAULT 1,
  -- 窗口对应的那条群消息。删除消息不删除窗口（ON DELETE SET NULL），因为计数
  -- 归零不等于这段告警没发生过。
  message_id    BIGINT      REFERENCES messages(id) ON DELETE SET NULL,
  first_detail  TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 唯一索引即聚合锁：并发进来的两条同 (source, title) 撞在这里，输的那条改走更新分支。
CREATE UNIQUE INDEX alert_windows_key ON alert_windows (agg_key);
CREATE INDEX alert_windows_recent ON alert_windows (last_seen_at DESC);

COMMENT ON COLUMN alert_windows.opened_at IS
  '窗口起点，翻滚而不是滑动：距 opened_at 不足 5 分钟的命中并入本窗口，超过则开新窗口。'
  '用 last_seen_at 判定的话，一条持续不断的告警会把窗口永远续下去，最终群里那一行'
  '长成「×4382」，而它本来该在每 5 分钟处断成一条新消息。';

CREATE TRIGGER trg_alert_windows_updated BEFORE UPDATE ON alert_windows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alert_events (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 发送方给的去重键。partial unique 而不是普通 unique：0001 的 ops_requests 把
  -- 这一列做成了可空（人工发起的请求没有幂等键），这里不允许空所以直接 UNIQUE。
  idempotency_key TEXT        NOT NULL UNIQUE,
  -- 可空**不是**「可能没有窗口」，而是插入的时机：幂等声明必须是这个事务的第一条语句
  -- （抢不到 key 的重放要在碰任何窗口之前就短路返回，连 seq 都不该分配），
  -- 而那一步还不知道自己会落进哪个窗口。同一个事务内回填，所以提交后的行必有值。
  window_id       BIGINT      REFERENCES alert_windows(id) ON DELETE CASCADE,
  -- **当时**回给发送方的那条消息 id。不写成 window.message_id 的间接查询：窗口
  -- 过 5 分钟后会换一条新消息，重放若跟着换就会返回一个发送方从没见过的 id。
  message_id      BIGINT      REFERENCES messages(id) ON DELETE SET NULL,
  severity        ops_severity NOT NULL,
  fingerprint     TEXT,
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX alert_events_by_window ON alert_events (window_id, created_at DESC);
-- 巡检脚本要回答「这条指纹的告警多久没再出现了」，按指纹而非窗口查。
CREATE INDEX alert_events_fingerprint ON alert_events (fingerprint, created_at DESC)
  WHERE fingerprint IS NOT NULL;

COMMENT ON TABLE alert_events IS
  '/hooks/alert 的每一次投递一条，UNIQUE(idempotency_key) 即 8.2 要求的幂等；'
  '重放返回首次落下的那个 message_id，与 ops_requests 的重放语义一致。';
