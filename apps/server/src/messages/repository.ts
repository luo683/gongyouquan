import type { MessageDto, MessageKind } from '@gongyouquan/contracts';
import type { QueryClient } from '../db/migrate.js';

type Row = Record<string, unknown>;

/**
 * One SELECT shape produces a complete MessageDto, so every read path (send
 * ack, edit ack, history page, sync page) hands back exactly what the contract
 * promises. Ids inside the aggregates are cast to text because json_agg of a
 * BIGINT emits a JSON number and the browser truncates it past 2^53.
 */
function messageColumns(a: string): string {
  return `
  ${a}.id, ${a}.group_id, ${a}.seq, ${a}.sender_id, ${a}.client_msg_id, ${a}.kind, ${a}.body,
  ${a}.task_id, ${a}.meta, ${a}.created_at, ${a}.edited_at, ${a}.deleted_at, ${a}.deleted_by,
  ${a}.updated_at,
  (SELECT coalesce(json_agg(json_build_object(
              'fileId', ma.file_id::text,
              'kind', ma.kind,
              'fileName', ma.file_name,
              'sortIndex', ma.sort_order,
              'width', ma.width,
              'height', ma.height) ORDER BY ma.sort_order), '[]'::json)
     FROM message_attachments ma WHERE ma.message_id = ${a}.id) AS attachments,
  (SELECT coalesce(json_agg(mm.mentioned_user_id::text ORDER BY mm.mentioned_user_id), '[]'::json)
     FROM message_mentions mm WHERE mm.message_id = ${a}.id) AS mentions,
  (SELECT mr.ref_message_id::text FROM message_refs mr WHERE mr.message_id = ${a}.id) AS ref_message_id`;
}

/** INSERT ... RETURNING cannot carry the aggregates, and a fresh text message genuinely has none. */
const INSERTED_COLUMNS = `
  id, group_id, seq, sender_id, client_msg_id, kind, body, task_id, meta,
  created_at, edited_at, deleted_at, deleted_by, updated_at`;

const SELECT_MESSAGE = `SELECT ${messageColumns('m')} FROM messages m`;

/**
 * QueryClient.withSession is optional so the unit-test fakes can omit it; the real
 * pool always provides one. This is the only place that unwraps it.
 */
function withSession<T>(database: QueryClient, fn: (session: QueryClient) => Promise<T>): Promise<T> {
  const open = database.withSession;
  if (!open) throw new Error('DATABASE_SESSION_REQUIRED');
  return open.call(database, fn) as Promise<T>;
}

/**
 * Every message state change writes its outbox row inside the same transaction
 * (spec 6.9): a committed message always has an event, a rolled-back one has
 * neither. `processed_at` stays NULL until the broadcaster claims it.
 */
async function writeOutboxUpsert(session: QueryClient, row: Row, reason: 'send' | 'edit' | 'revoke'): Promise<void> {
  await session.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
     VALUES ('message', $1, 'upsert', $2::jsonb)`,
    [
      row.id,
      JSON.stringify({
        messageId: String(row.id),
        groupId: String(row.group_id),
        seq: Number(row.seq),
        reason,
      }),
    ],
  );
}

/** PostgreSQL unique_violation - the one race we catch instead of trying to prevent. */
const UNIQUE_VIOLATION = '23505';

export const EDIT_WINDOW = '15 minutes';
export const DELETE_WINDOW = '2 minutes';

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function stamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function stampOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : stamp(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function messageFromRow(row: Row): MessageDto {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    seq: Number(row.seq),
    // null sender is a system / bot message, not a missing value.
    senderId: text(row.sender_id),
    clientMsgId: text(row.client_msg_id),
    kind: String(row.kind) as MessageKind,
    body: row.body === null || row.body === undefined ? null : String(row.body),
    taskId: text(row.task_id),
    refMessageId: text(row.ref_message_id),
    attachments: parseJson(row.attachments, []),
    mentions: parseJson(row.mentions, []),
    meta: parseJson<Record<string, unknown> | null>(row.meta, null),
    createdAt: stamp(row.created_at),
    editedAt: stampOrNull(row.edited_at),
    deletedAt: stampOrNull(row.deleted_at),
    deletedBy: text(row.deleted_by),
    updatedAt: stamp(row.updated_at),
  };
}

export type SendOutcome =
  | { kind: 'created'; message: MessageDto }
  | { kind: 'duplicate'; message: MessageDto };

export type EditOutcome =
  | { kind: 'edited'; message: MessageDto }
  | { kind: 'notFound' }
  | { kind: 'notAuthor' }
  | { kind: 'notEditTextable' }
  | { kind: 'windowExpired' };

export type RevokeOutcome =
  | { kind: 'revoked'; message: MessageDto }
  | { kind: 'alreadyRevoked' }
  | { kind: 'notFound' }
  | { kind: 'notAuthor' }
  | { kind: 'windowExpired' };

export type MessageRepository = {
  findMessage(messageId: string): Promise<MessageDto | null>;
  findByClientMsgId(senderId: string, clientMsgId: string): Promise<MessageDto | null>;
  send(input: { groupId: string; senderId: string; clientMsgId: string; body: string }): Promise<SendOutcome>;
  applyEdit(input: { messageId: string; actorId: string; body: string }): Promise<EditOutcome>;
  applyRevoke(input: { messageId: string; actorId: string; moderator: boolean }): Promise<RevokeOutcome>;
  listBefore(input: { groupId: string; beforeSeq: number | null; limit: number }): Promise<{ items: MessageDto[]; hasMore: boolean }>;
};

export function createMessagesRepository(database: QueryClient): MessageRepository {
  async function selectOne(sql: string, values: unknown[]): Promise<MessageDto | null> {
    const result = await database.query<Row>(sql, values);
    const row = result.rows[0];
    return row ? messageFromRow(row) : null;
  }

  const repo: MessageRepository = {
    findMessage(messageId) {
      return selectOne(`${SELECT_MESSAGE} WHERE m.id = $1`, [messageId]);
    },

    findByClientMsgId(senderId, clientMsgId) {
      return selectOne(`${SELECT_MESSAGE} WHERE m.sender_id = $1 AND m.client_msg_id = $2`, [senderId, clientMsgId]);
    },

    async send({ groupId, senderId, clientMsgId, body }) {
      try {
        return await withSession(database, async (session) => {
          await session.query('BEGIN');
          try {
            // The counter update and its row lock live in this transaction, which is
            // what makes per-group seq strictly monotonic with no retries (spec 4.2).
            const allocated = await session.query<Row>('SELECT alloc_group_seq($1) AS seq', [groupId]);
            const seq = allocated.rows[0]?.seq;
            if (seq === undefined || seq === null) throw new Error('SEQ_ALLOC_FAILED');

            const inserted = await session.query<Row>(
              `INSERT INTO messages (group_id, seq, sender_id, client_msg_id, kind, body)
               VALUES ($1, $2, $3, $4, 'text', $5)
               RETURNING ${INSERTED_COLUMNS}`,
              [groupId, seq, senderId, clientMsgId, body],
            );
            const row = inserted.rows[0];
            if (!row) throw new Error('MESSAGE_INSERT_FAILED');

            // Same transaction as the message: a committed message always has its
            // outbox event; a rolled-back one leaves neither behind (spec 6.9).
            await writeOutboxUpsert(session, row, 'send');

            await session.query('COMMIT');
            return { kind: 'created', message: messageFromRow(row) } satisfies SendOutcome;
          } catch (error) {
            await session.query('ROLLBACK');
            throw error;
          }
        });
      } catch (error) {
        // A retry that raced the original. The unique index on
        // (sender_id, client_msg_id) is the arbiter, so the loser returns the
        // winner's row instead of a second copy of the same words - and the seq it
        // had allocated is handed back, because the rollback is what released it.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          const existing = await repo.findByClientMsgId(senderId, clientMsgId);
          if (existing) return { kind: 'duplicate', message: existing };
        }
        throw error;
      }
    },

    async applyEdit({ messageId, actorId, body }) {

      // The window is compared against the database clock, not an app clock, so two
      // server instances can never disagree about whether 15 minutes have passed.
      return withSession(database, async (session) => {
        await session.query('BEGIN');
        try {
          const updated = await session.query<Row>(
            `UPDATE messages
                SET body = $2, edited_at = now()
              WHERE id = $1
                AND sender_id = $3
                AND kind = 'text'
                AND deleted_at IS NULL
                AND now() < created_at + interval '${EDIT_WINDOW}'
              RETURNING ${messageColumns('messages')}`,
            [messageId, body, actorId],
          );
          const row = updated.rows[0];
          if (!row) {
            await session.query('ROLLBACK');
            const reason = await database.query<Row>(
              `SELECT sender_id, kind, deleted_at FROM messages WHERE id = $1`,
              [messageId],
            );
            const current = reason.rows[0];
            if (!current) return { kind: 'notFound' } as EditOutcome;
            if (String(current.sender_id) !== actorId) return { kind: 'notAuthor' } as EditOutcome;
            if (current.kind !== 'text' || current.deleted_at !== null) return { kind: 'notEditTextable' } as EditOutcome;
            return { kind: 'windowExpired' } as EditOutcome;
          }

          await writeOutboxUpsert(session, row, 'edit');
          await session.query('COMMIT');
          return { kind: 'edited', message: messageFromRow(row) } satisfies EditOutcome;
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },

    async applyRevoke({ messageId, actorId, moderator }) {
      // Spec 3.4 is two separate rows, and collapsing them is the easy mistake:
      //   撤回自己的消息（2 分钟内）   owner ✓  admin ✓  member ✓
      //   撤回他人的消息               owner ✓  admin ✓  member ✗
      // The 2-minute window applies to your own message whatever you are - being
      // owner does not buy you extra time on yourself. The moderator flag only
      // opens the *other people* branch, and that one has no window.
      const guard = `(
          (sender_id = $2 AND now() < created_at + interval '${DELETE_WINDOW}')
          OR ($3::boolean AND sender_id <> $2))`;

      return withSession(database, async (session) => {
        await session.query('BEGIN');
        try {
          const revoked = await session.query<Row>(
            `UPDATE messages
                SET deleted_at = now(), deleted_by = $2
              WHERE id = $1
                AND ${guard}
              RETURNING ${messageColumns('messages')}`,
            [messageId, actorId, moderator],
          );
          const row = revoked.rows[0];
          if (!row) {
            await session.query('ROLLBACK');
            const reason = await database.query<Row>(
              `SELECT sender_id, deleted_at FROM messages WHERE id = $1`,
              [messageId],
            );
            const current = reason.rows[0];
            if (!current) return { kind: 'notFound' } as RevokeOutcome;
            if (current.deleted_at !== null) return { kind: 'alreadyRevoked' } as RevokeOutcome;
            if (String(current.sender_id) !== actorId) return { kind: 'notAuthor' } as RevokeOutcome;
            // Own message, not revoked, and the UPDATE still refused it: only the
            // window can explain that.
            return { kind: 'windowExpired' } as RevokeOutcome;
          }

          await writeOutboxUpsert(session, row, 'revoke');
          await session.query('COMMIT');
          return { kind: 'revoked', message: messageFromRow(row) } satisfies RevokeOutcome;
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },

    async listBefore({ groupId, beforeSeq, limit }) {
      // Newest-first fetch, ascending return: 向前翻历史 without ever reversing
      // the payload, so the client can upsert the page exactly as it arrives.
      const result = await database.query<Row>(
        `SELECT ${messageColumns('m')}
           FROM messages m
          WHERE m.group_id = $1
            AND ($2::bigint IS NULL OR m.seq < $2)
          ORDER BY m.seq DESC
          LIMIT $3`,
        [groupId, beforeSeq, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).reverse().map(messageFromRow);
      return { items, hasMore };
    },
  };

  return repo;
}
