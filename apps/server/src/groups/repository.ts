import type { QueryClient } from '../db/migrate.js';
import type { GroupRole } from '@gongyouquan/contracts';
import type { LastMessagePreview } from '@gongyouquan/contracts';
import type { GroupMemberRecord, GroupRecord, GroupSummary, GroupsRepository } from './service.js';
import type { GroupMembership } from './guards.js';

type Row = Record<string, unknown>;

function toApiTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function groupFromRow(row: Row): GroupRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    isArchived: Boolean(row.is_archived),
    isSystem: Boolean(row.is_system),
    lastSeq: Number(row.last_seq),
    createdAt: toApiTime(row.created_at),
    updatedAt: toApiTime(row.updated_at),
  };
}

const GROUP_COLUMNS = 'id, name, description, is_archived, is_system, last_seq, created_at, updated_at';

export function createGroupsRepository(database: QueryClient): GroupsRepository {
  return {
    async createGroup({ name, description, ownerId }) {
      if (!database.withSession) throw new Error('DATABASE_SESSION_REQUIRED');
      return database.withSession(async (session) => {
        await session.query('BEGIN');
        try {
          const group = await session.query<Row>(
            `INSERT INTO groups (name, description, created_by)
             VALUES ($1, $2, $3)
             RETURNING ${GROUP_COLUMNS}`,
            [name, description, ownerId],
          );
          const row = group.rows[0];
          if (!row) throw new Error('GROUP_CREATE_FAILED');
          await session.query(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES ($1, $2, 'owner')`,
            [row.id, ownerId],
          );
          await session.query('COMMIT');
          return groupFromRow(row);
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },

    async listGroups(userId, includeArchived) {
      const result = await database.query<Row>(
        `SELECT g.id, g.name, g.description, g.is_archived, g.is_system, g.last_seq, g.created_at, g.updated_at,
                (SELECT count(*) FROM group_members m2
                  WHERE m2.group_id = g.id AND m2.removed_at IS NULL) AS member_count,
                COALESCE(rp.last_read_seq, 0) AS my_last_read_seq,
                (SELECT count(*) FROM (
                   SELECT 1 FROM messages msg
                    WHERE msg.group_id = g.id
                      AND msg.seq > COALESCE(rp.last_read_seq, 0)
                      AND msg.sender_id IS DISTINCT FROM $1
                      AND msg.kind <> 'system'
                    LIMIT 100
                 ) bounded_unread) AS unread_count,
                (SELECT json_build_object(
                          'messageId', lp.id,
                          'kind', lp.kind,
                          'body', lp.body,
                          'senderDisplayName', COALESCE(u.display_name, 'System'),
                          'createdAt', lp.created_at)
                   FROM messages lp
                   LEFT JOIN users u ON u.id = lp.sender_id
                  WHERE lp.group_id = g.id AND lp.deleted_at IS NULL
                  ORDER BY lp.seq DESC
                  LIMIT 1) AS last_message
           FROM groups g
           JOIN group_members gm
             ON gm.group_id = g.id AND gm.user_id = $1 AND gm.removed_at IS NULL
           LEFT JOIN read_positions rp
             ON rp.group_id = g.id AND rp.user_id = $1
          WHERE ($2 = true OR g.is_archived = false)
          ORDER BY g.updated_at DESC`,
        [userId, includeArchived],
      );
      return result.rows.map((row) => ({
        ...groupFromRow(row),
        memberCount: Number(row.member_count),
        unreadCount: Math.min(100, Number(row.unread_count)),
        myLastReadSeq: Number(row.my_last_read_seq),
        lastMessagePreview: row.last_message ? normalizePreview(row.last_message as Row) : null,
      })) satisfies GroupSummary[];
    },

    async getGroup(groupId) {
      const result = await database.query<Row>(
        `SELECT ${GROUP_COLUMNS} FROM groups WHERE id = $1`,
        [groupId],
      );
      return result.rows[0] ? groupFromRow(result.rows[0]) : null;
    },

    async getMembership(groupId, userId) {
      const result = await database.query<Row>(
        `SELECT gm.role, g.is_archived
           FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
          WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.removed_at IS NULL`,
        [groupId, userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { role: String(row.role) as GroupRole, archived: Boolean(row.is_archived) } satisfies GroupMembership;
    },

    async listMembers(groupId) {
      const result = await database.query<Row>(
        `SELECT gm.user_id, u.username, u.display_name, gm.role, gm.joined_at
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = $1 AND gm.removed_at IS NULL
          ORDER BY gm.joined_at`,
        [groupId],
      );
      return result.rows.map((row) => ({
        userId: String(row.user_id),
        username: String(row.username),
        displayName: String(row.display_name),
        role: String(row.role) as GroupRole,
        joinedAt: toApiTime(row.joined_at),
      })) satisfies GroupMemberRecord[];
    },

    async memberUserIds(groupIds) {
      if (groupIds.length === 0) return [];
      /**
       * One round trip for the whole set. listMembers is per group and carries
       * display names this caller never reads, so looping it would be N queries
       * to produce a list of ids. DISTINCT because one person in two of the
       * reported groups is still one person online.
       */
      const result = await database.query<Row>(
        `SELECT DISTINCT gm.user_id
           FROM group_members gm
          WHERE gm.group_id = ANY($1::bigint[]) AND gm.removed_at IS NULL`,
        [groupIds],
      );
      return result.rows.map((row) => String(row.user_id));
    },

    async updateGroup(groupId, input) {
      if (input.name === undefined && input.description === undefined) {
        return this.getGroup(groupId);
      }
      const result = await database.query<Row>(
        `UPDATE groups
            SET name = COALESCE($2, name),
                description = COALESCE($3, description)
          WHERE id = $1
          RETURNING ${GROUP_COLUMNS}`,
        [groupId, input.name ?? null, input.description ?? null],
      );
      return result.rows[0] ? groupFromRow(result.rows[0]) : null;
    },
  };
}

function normalizePreview(value: Row): LastMessagePreview {
  return {
    messageId: String(value.messageId),
    kind: String(value.kind) as LastMessagePreview['kind'],
    body: value.body === null || value.body === undefined ? null : String(value.body),
    senderDisplayName: String(value.senderDisplayName),
    createdAt: toApiTime(value.createdAt),
  };
}
