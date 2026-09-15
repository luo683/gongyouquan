import type { AlertHook, AlertSeverity, MessageDto } from '@gongyouquan/contracts';
import type { QueryClient } from '../db/migrate.js';
import { insertSystemMessage, rewriteMessageBody, withSession } from '../messages/repository.js';
import { renderAlertMessage } from './alert-message.js';

type Row = Record<string, unknown>;

/**
 * Spec 03 line 1585: "同 (source, title) 在 5 分钟内合并为一条计数消息".
 * Named rather than inlined because the SQL below asks for it as an interval and a
 * typo in a string literal is a silent change to how loud the system is.
 */
export const AGGREGATION_WINDOW = '5 minutes';

export type AlertRecord =
  | { kind: 'created'; message: MessageDto }
  | { kind: 'aggregated'; message: MessageDto }
  | { kind: 'replayed'; messageId: string | null };

export type AlertRepository = {
  record(input: AlertHook & { groupId: string }): Promise<AlertRecord>;
};

function stamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Two statements, not one. A single `INSERT ... ON CONFLICT DO UPDATE` can express
 * the rollover, but only by repeating the expiry predicate in a CASE per column -
 * and the first version of this did exactly that and then forgot the one column
 * that mattered most, so a rolled-over window kept counting from the old total and
 * printed "×7" on a line that had seen two alerts.
 *
 * Both run inside the caller's transaction, so the window row is still the lock
 * that serialises concurrent deliveries of the same (source, title).
 */
const EXPIRE_WINDOW = `
  UPDATE alert_windows
     SET opened_at = now(),
         -- 0, not 1: the upsert below adds the hit that is arriving right now.
         hit_count = 0,
         message_id = NULL,
         first_detail = NULL,
         -- The arriving alert is this window's first hit, so it starts at this
         -- alert's level. Leaving the old maximum behind would stamp 【critical】 on
         -- every line for the rest of the table's life: a backup that failed once at
         -- 03:00 and has since recovered would still be reading as critical at noon,
         -- which is how an ops channel gets muted.
         severity = $3::ops_severity
   WHERE agg_key = $1
     AND opened_at < now() - $2::interval`;

const UPSERT_WINDOW = `
  INSERT INTO alert_windows (agg_key, source, title, severity, hit_count, first_detail, message_id, opened_at, last_seen_at)
  VALUES ($1, $2, $3, $4::ops_severity, 1, $5, NULL, now(), now())
  ON CONFLICT (agg_key) DO UPDATE SET
    hit_count    = alert_windows.hit_count + 1,
    last_seen_at = now(),
    -- Highest seen wins. An info arriving after a critical must not put the ops
    -- group back to looking calm.
    severity     = CASE WHEN EXCLUDED.severity > alert_windows.severity
                        THEN EXCLUDED.severity ELSE alert_windows.severity END
  RETURNING id, source, title, severity, hit_count, opened_at, last_seen_at, message_id, first_detail`;

/**
 * One alert becomes one transaction, and the shape of it is the whole design:
 *
 *   1. claim the idempotency key   - INSERT ... ON CONFLICT DO NOTHING
 *   2. open or join the window     - EXPIRE_WINDOW, then the window upsert
 *   3. post or amend the message   - the only step that allocates a seq
 *   4. pin the event to its window and message
 *
 * Step 1 comes first so a replay costs nothing: it returns before touching the
 * counter or the message stream. Step 2 is what makes the window a lock as much as
 * a record - two concurrent first alerts for the same (source, title) collide on
 * alert_windows' unique key, the loser waits for the winner to COMMIT, then
 * re-evaluates its DO UPDATE against the committed row and sees the message_id the
 * winner just set. That is why steps 2 and 3 have to share a transaction: split
 * them and two racing deliveries each post their own line, which is precisely the
 * duplicate this feature exists to prevent.
 */
export function createAlertRepository(database: QueryClient): AlertRepository {
  return {
    async record(input) {
      // Reversible by construction: the contract bounds source to a label charset
      // and title to one line, so the separator cannot appear in either half.
      const aggKey = `${input.source}\n${input.title}`;
      return withSession(database, async (session): Promise<AlertRecord> => {
        await session.query('BEGIN');
        try {
          const claimed = await session.query<Row>(
            `INSERT INTO alert_events (idempotency_key, severity, fingerprint, detail)
             VALUES ($1, $2::ops_severity, $3, $4)
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING id`,
            [input.idempotencyKey, input.severity, input.fingerprint ?? null, input.detail ?? null],
          );
          const eventId = claimed.rows[0]?.id;

          if (eventId === undefined || eventId === null) {
            // Someone else already claimed this key. Return the message id *they*
            // were given, not whichever line the window is on now - a sender
            // retrying must be able to match the answer against its own log. The
            // COALESCE is for the case where that line has since been deleted:
            // the window's current one is still the message about this alert.
            const prior = await session.query<Row>(
              `SELECT COALESCE(e.message_id, w.message_id) AS message_id
                 FROM alert_events e
                 LEFT JOIN alert_windows w ON w.id = e.window_id
                WHERE e.idempotency_key = $1`,
              [input.idempotencyKey],
            );
            await session.query('COMMIT');
            const known = prior.rows[0]?.message_id;
            return { kind: 'replayed', messageId: known == null ? null : String(known) };
          }

          await session.query(EXPIRE_WINDOW, [aggKey, AGGREGATION_WINDOW, input.severity]);
          const landed = await session.query<Row>(UPSERT_WINDOW, [
            aggKey,
            input.source,
            input.title,
            input.severity,
            input.detail ?? null,
          ]);
          const window = landed.rows[0];
          if (!window) throw new Error('ALERT_WINDOW_WRITE_FAILED');

          const rendered = renderAlertMessage({
            source: String(window.source),
            title: String(window.title),
            severity: String(window.severity) as AlertSeverity,
            hitCount: Number(window.hit_count),
            openedAt: stamp(window.opened_at),
            lastSeenAt: stamp(window.last_seen_at),
            // The window keeps the first detail, not the latest. Two failures that
            // share a title usually share a cause, and the first one is the one
            // that was there when the situation began.
            detail: window.first_detail == null ? null : String(window.first_detail),
            fingerprint: input.fingerprint ?? null,
          });

          const existingMessageId = window.message_id == null ? null : String(window.message_id);
          let message: MessageDto | null = null;
          let kind: 'created' | 'aggregated' = 'created';

          if (existingMessageId !== null) {
            message = await rewriteMessageBody(session, {
              messageId: existingMessageId,
              body: rendered.body,
              meta: rendered.meta,
            });
            kind = 'aggregated';
          }

          // Either no line yet, or the one the window pointed at was deleted
          // (alert_windows.message_id is ON DELETE SET NULL). Both need a new post,
          // and the rewrite branch above returns null when the row is gone.
          if (message === null) {
            message = await insertSystemMessage(session, {
              groupId: input.groupId,
              body: rendered.body,
              meta: rendered.meta,
            });
            kind = 'created';
            await session.query('UPDATE alert_windows SET message_id = $2 WHERE id = $1', [
              window.id,
              message.id,
            ]);
          }

          await session.query(
            `UPDATE alert_events SET window_id = $2, message_id = $3 WHERE id = $1`,
            [eventId, window.id, message.id],
          );
          await session.query('COMMIT');
          return { kind, message };
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },
  };
}
