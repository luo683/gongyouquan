import type { MentionDto, MessageDto, MessageKind, MessageReceiptsDto } from '@gongyouquan/contracts';
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

/**
 * INSERT ... RETURNING cannot carry the aggregates. A fresh text message has no
 * attachments or refs, but it CAN have mentions now, so send() re-reads the full
 * row whenever it wrote any - see the note there.
 */
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
  send(input: { groupId: string; senderId: string; clientMsgId: string; body: string; mentions: string[] }): Promise<SendOutcome>;
  applyEdit(input: { messageId: string; actorId: string; body: string }): Promise<EditOutcome>;
  applyRevoke(input: { messageId: string; actorId: string; moderator: boolean }): Promise<RevokeOutcome>;
  listBefore(input: { groupId: string; beforeSeq: number | null; limit: number }): Promise<{ items: MessageDto[]; hasMore: boolean }>;
  listAfter(input: { groupId: string; sinceSeq: number; limit: number }): Promise<{ items: MessageDto[]; hasMore: boolean }>;
  /** 已读回执分级（spec 4.4.3）：detail=false 只付两个数，true 才多付一份名单。 */
  receipts(input: { groupId: string; senderId: string | null; seq: number; detail: boolean }): Promise<MessageReceiptsDto>;
  /** GET /me/mentions —— 跨群，游标是 messageId，`unreadOnly` 走 `mentions_read_seq`（6.6）。 */
  listMentions(input: {
    userId: string;
    unreadOnly: boolean;
    cursor: string | null;
    limit: number;
  }): Promise<{ items: MentionDto[]; hasMore: boolean }>;
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

    async send({ groupId, senderId, clientMsgId, body, mentions }) {
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

            /**
             * Same transaction as the message, so a committed message and its
             * mentions can never disagree and a rolled-back send leaves neither
             * behind. group_id and seq are denormalised on purpose: 6.6 wants
             * "@我未读" answerable from one index without joining messages.
             *
             * One set-based insert rather than a round trip per mention, and
             * ON CONFLICT DO NOTHING because the primary key is
             * (message_id, mentioned_user_id) - a client listing the same person
             * twice must not fail the whole send.
             */
            if (mentions.length > 0) {
              await session.query(
                `INSERT INTO message_mentions (message_id, mentioned_user_id, group_id, seq)
                 SELECT $1, mentioned.uid, $2, $3
                   FROM unnest($4::bigint[]) AS mentioned(uid)
                 ON CONFLICT DO NOTHING`,
                [row.id, groupId, seq, mentions],
              );
            }

            // Same transaction as the message: a committed message always has its
            // outbox event; a rolled-back one leaves neither behind (spec 6.9).
            await writeOutboxUpsert(session, row, 'send');

            /**
             * INSERT ... RETURNING cannot carry the aggregates, and the row above
             * therefore has no mentions on it. That used to be harmless - a fresh
             * text message genuinely had none - and stopped being true the moment
             * mentions are written in this same transaction. The ack is the client's
             * authoritative copy (4.3.4), so handing back a DTO that claims nobody
             * was mentioned would render that way until a reload.
             *
             * Re-read only when something was written, so the common case still
             * costs no extra query.
             */
            if (mentions.length === 0) {
              await session.query('COMMIT');
              return { kind: 'created', message: messageFromRow(row) } satisfies SendOutcome;
            }
            const full = await session.query<Row>(`${SELECT_MESSAGE} WHERE m.id = $1`, [row.id]);
            const fullRow = full.rows[0];
            if (!fullRow) throw new Error('MESSAGE_INSERT_FAILED');

            await session.query('COMMIT');
            return { kind: 'created', message: messageFromRow(fullRow) } satisfies SendOutcome;
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

    async listAfter({ groupId, sinceSeq, limit }) {
      // The replay half of the same reader: ascending from the client watermark,
      // one extra row so hasMore needs a second query. Rows come back in their
      // CURRENT state, revoked and edited included - spec 4.3.5 forbids replaying
      // events here, because an out-of-order revoke would target a message the
      // client has not seen yet and be silently dropped.
      const result = await database.query<Row>(
        `SELECT ${messageColumns('m')}
           FROM messages m
          WHERE m.group_id = $1 AND m.seq > $2
          ORDER BY m.seq ASC
          LIMIT $3`,
        [groupId, sinceSeq, limit + 1],
      );
      return {
        items: result.rows.slice(0, limit).map(messageFromRow),
        hasMore: result.rows.length > limit,
      };
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

    async receipts({ groupId, senderId, seq, detail }) {
      /**
       * Both halves go through group_members rather than counting read_positions
       * directly: a removed member's position row survives (users and groups
       * cascade, membership is a soft delete), so a bare count would keep
       * crediting someone who left the room.
       *
       * The sender is excluded from the denominator as well as the numerator.
       * Spec line 1631 only pins the numerator and the removed-member rule, so
       * this is our call: with the sender in the denominator a fully read room
       * reports 4/5 forever and "已读" can never be complete.
       *
       * The exclusion is IS DISTINCT FROM, not <>: senderId is null for system
       * and bot messages, and `user_id <> NULL` is NULL rather than true, so a
       * plain <> would drop every row and report a room nobody had read as 0/0.
       */
      const summary = await database.query<Row>(
        `SELECT
           (SELECT count(*)
              FROM group_members gm
             WHERE gm.group_id = $1 AND gm.removed_at IS NULL
               AND gm.user_id IS DISTINCT FROM $2::bigint) AS total_members,
           (SELECT count(*)
              FROM read_positions rp
              JOIN group_members gm
                ON gm.group_id = rp.group_id AND gm.user_id = rp.user_id AND gm.removed_at IS NULL
             WHERE rp.group_id = $1 AND rp.last_read_seq >= $3
               AND rp.user_id IS DISTINCT FROM $2::bigint) AS read_count`,
        [groupId, senderId, seq],
      );
      const totals = summary.rows[0];
      const readCount = Number(totals?.read_count ?? 0);
      const totalMembers = Number(totals?.total_members ?? 0);
      if (!detail) return { readCount, totalMembers };

      // The name list is the expensive tier, which is exactly why spec 4.4.3 makes
      // the client ask for it separately and only on a click. Group size is capped
      // at 50, so this is bounded at 50 rows.
      const names = await database.query<Row>(
        `SELECT gm.user_id, u.display_name, rp.last_read_seq
           FROM read_positions rp
           JOIN group_members gm
             ON gm.group_id = rp.group_id AND gm.user_id = rp.user_id AND gm.removed_at IS NULL
           JOIN users u ON u.id = rp.user_id
          WHERE rp.group_id = $1 AND rp.last_read_seq >= $3
            AND rp.user_id IS DISTINCT FROM $2::bigint
          ORDER BY rp.last_read_seq DESC, gm.user_id ASC`,
        [groupId, senderId, seq],
      );
      return {
        readCount,
        totalMembers,
        readers: names.rows.map((row) => ({
          userId: String(row.user_id),
          displayName: String(row.display_name),
          lastReadSeq: Number(row.last_read_seq),
        })),
      };
    },

    async listMentions({ userId, unreadOnly, cursor, limit }) {
      const result = await database.query<Row>(
        `SELECT mm.message_id, m.group_id, g.name AS group_name, m.seq,
                m.sender_id, COALESCE(sender.display_name, 'System') AS from_display_name,
                CASE WHEN m.deleted_at IS NULL THEN m.body ELSE NULL END AS body,
                m.created_at,
                m.seq > COALESCE(rp.mentions_read_seq, 0) AS unread
           FROM message_mentions mm
           JOIN messages m ON m.id = mm.message_id
           JOIN groups g ON g.id = m.group_id
           LEFT JOIN users sender ON sender.id = m.sender_id
           LEFT JOIN read_positions rp ON rp.group_id = m.group_id AND rp.user_id = $1
          WHERE mm.mentioned_user_id = $1
            AND ($2::boolean = false OR m.seq > COALESCE(rp.mentions_read_seq, 0))
            AND ($3::bigint IS NULL OR mm.message_id < $3)
          ORDER BY mm.message_id DESC
          LIMIT $4`,
        [userId, unreadOnly, cursor, limit + 1],
      );
      /**
       * The CASE on body is a gate, not a nicety. `/messages/:mid/raw` puts a
       * revoked message's original text behind owner/admin, and this list is
       * readable by any member - so handing the body over here would let anyone
       * read text the moderator path deliberately withholds. The row still appears,
       * because being told you were mentioned is not the same as being shown what
       * was said.
       */
      return {
        items: result.rows.slice(0, limit).map((row) => ({
          messageId: String(row.message_id),
          groupId: String(row.group_id),
          groupName: String(row.group_name),
          seq: Number(row.seq),
          fromUserId: text(row.sender_id),
          fromDisplayName: String(row.from_display_name),
          body: text(row.body),
          createdAt: stamp(row.created_at),
          unread: Boolean(row.unread),
        })),
        hasMore: result.rows.length > limit,
      };
    },
  };

  return repo;
}
