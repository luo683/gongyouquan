import type { MessageDto, ReadPositionDto } from '@gongyouquan/contracts';
import type { QueryClient } from '../db/migrate.js';
import type { MessageRepository } from '../messages/repository.js';

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value);
const str = (value: unknown): string => String(value);

/** Everything a client needs in order to know where it stands in one group. */
export type Watermark = {
  groupId: string;
  lastSeq: number;
  myLastReadSeq: number;
  myMentionsReadSeq: number;
};

export type SyncPage = {
  items: MessageDto[];
  asOfSeq: number;
  hasMore: boolean;
};

export type SyncRepository = {
  /** Only groups the user is currently a member of come back; strangers get []. */
  watermarks(userId: string, groupIds: string[]): Promise<Watermark[]>;
  watermark(groupId: string, userId: string): Promise<Watermark | null>;
  pullAfter(groupId: string, sinceSeq: number, limit: number): Promise<SyncPage>;
  advancePosition(
    groupId: string,
    userId: string,
    lastReadSeq: number | undefined,
    mentionsReadSeq: number | undefined,
  ): Promise<ReadPositionDto>;
};

export function createSyncRepository(database: QueryClient, messages: MessageRepository): SyncRepository {
  /**
   * Membership is joined into every read on purpose. A stranger asking for a
   * watermark must get an empty answer, not a leaked last_seq and not a 500.
   *
   * This string deliberately ends with a WHERE clause. It used to end with the
   * LEFT JOIN's ON, and callers appended `AND g.id = ...` on the assumption it
   * filtered groups - it silently filtered the join instead, so watermarks()
   * returned EVERY group the user is in and watermark() answered with whichever
   * came first. A member of group A asking about group B therefore passed the
   * membership check for B and was handed B's messages.
   */
  const WATERMARK_SELECT = `
    SELECT g.id AS group_id, g.last_seq,
           COALESCE(rp.last_read_seq, 0) AS last_read_seq,
           COALESCE(rp.mentions_read_seq, 0) AS mentions_read_seq
      FROM groups g
      JOIN group_members gm
        ON gm.group_id = g.id AND gm.user_id = $1 AND gm.removed_at IS NULL
      LEFT JOIN read_positions rp
        ON rp.group_id = g.id AND rp.user_id = $1
     WHERE true`;

  function toWatermark(row: Row): Watermark {
    return {
      groupId: str(row.group_id),
      lastSeq: num(row.last_seq),
      myLastReadSeq: num(row.last_read_seq),
      myMentionsReadSeq: num(row.mentions_read_seq),
    };
  }

  return {
    async watermarks(userId, groupIds) {
      if (groupIds.length === 0) return [];
      const result = await database.query<Row>(`${WATERMARK_SELECT} AND g.id = ANY($2::bigint[])`, [
        userId,
        groupIds,
      ]);
      return result.rows.map(toWatermark);
    },

    async watermark(groupId, userId) {
      const result = await database.query<Row>(`${WATERMARK_SELECT} AND g.id = $2`, [userId, groupId]);
      const row = result.rows[0];
      return row ? toWatermark(row) : null;
    },

    async pullAfter(groupId, sinceSeq, limit) {
      const page = await messages.listAfter({ groupId, sinceSeq, limit });
      const last = page.items[page.items.length - 1];
      const current = await database.query<Row>('SELECT last_seq FROM groups WHERE id = $1', [groupId]);
      const groupLastSeq = num(current.rows[0]?.last_seq ?? 0);

      /**
       * asOfSeq is the server's answer, never something the client computes
       * (spec 4.3.3) - and it never moves backwards. On an empty page we return
       * max(groups.last_seq, sinceSeq): a client whose local watermark already
       * outran the server (restored backup, an ops change, our own rollback
       * semantics) must not be walked back and shown messages it has applied.
       * docs/decisions/0006 gap four.
       */
      const asOfSeq = last ? last.seq : Math.max(groupLastSeq, sinceSeq);
      return { items: page.items, asOfSeq, hasMore: page.hasMore };
    },

    async advancePosition(groupId, userId, lastReadSeq, mentionsReadSeq) {
      // GREATEST is the whole rule (spec 4.4.1): a desktop that already read to
      // 500 must not be dragged back by a phone reporting 480 late. Unspecified
      // halves fall back to the stored value rather than to 0.
      const result = await database.query<Row>(
        `INSERT INTO read_positions (user_id, group_id, last_read_seq, mentions_read_seq, updated_at)
         VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), now())
         ON CONFLICT (user_id, group_id) DO UPDATE
            SET last_read_seq     = GREATEST(read_positions.last_read_seq, COALESCE($3, read_positions.last_read_seq)),
                mentions_read_seq = GREATEST(read_positions.mentions_read_seq, COALESCE($4, read_positions.mentions_read_seq)),
                updated_at        = now()
         RETURNING last_read_seq, mentions_read_seq`,
        [userId, groupId, lastReadSeq ?? null, mentionsReadSeq ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new Error('READ_POSITION_UPSERT_FAILED');
      return { lastReadSeq: num(row.last_read_seq), mentionsReadSeq: num(row.mentions_read_seq) };
    },
  };
}
