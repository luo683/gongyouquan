import type { QueryClient } from '../db/migrate.js';
import type { GroupRole, InviteCreatedDto, InviteDto } from '@gongyouquan/contracts';
import type { GroupMemberRecord } from './service.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => String(value);
const num = (value: unknown): number => Number(value);

function apiTime(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function timeOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : apiTime(value);
}

export type InviteRecord = InviteDto;

export type MembersRepository = {
  addMember(input: { groupId: string; userId: string; role: GroupRole; invitedBy: string }): Promise<GroupMemberRecord | null>;
  /** Soft-removes a membership. The row stays: it is the audit trail of who was in. */
  removeMember(groupId: string, userId: string, actorId: string): Promise<boolean>;
  changeRole(groupId: string, userId: string, role: GroupRole): Promise<GroupMemberRecord | null>;
  /** Owner hand-over, in one transaction: two rows change or none does. */
  transferOwnership(input: { groupId: string; fromUserId: string; toUserId: string }): Promise<boolean>;
  createInvite(input: {
    groupId: string;
    role: GroupRole;
    maxUses: number | null;
    expiresAt: Date | null;
    createdBy: string;
  }): Promise<InviteCreatedDto>;
  listInvites(groupId: string): Promise<InviteRecord[]>;
  revokeInvite(groupId: string, inviteId: string): Promise<boolean>;
  memberRole(groupId: string, userId: string): Promise<GroupRole | null>;
  liveOwnerCount(groupId: string): Promise<number>;
  memberIds(groupId: string): Promise<string[]>;
  userExists(userId: string): Promise<boolean>;
};

export function createMembersRepository(database: QueryClient): MembersRepository {
  const MEMBER_COLUMNS = `gm.user_id, u.username, u.display_name, gm.role, gm.joined_at`;

  /**
   * A RETURNING clause sees only the target row, so the write paths return the
   * id and read the display columns back. Reusing the joined column list there is
   valid-looking SQL that dies at run time with `missing FROM-clause entry for
   * table "gm"`.  */

  function memberFrom(row: Row): GroupMemberRecord {
    return {
      userId: str(row.user_id),
      username: str(row.username),
      displayName: str(row.display_name),
      role: str(row.role) as GroupRole,
      joinedAt: apiTime(row.joined_at),
    };
  }

  async function readMember(groupId: string, userId: string): Promise<GroupMemberRecord | null> {
    const result = await database.query<Row>(
      `SELECT ${MEMBER_COLUMNS}
         FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.removed_at IS NULL`,
      [groupId, userId],
    );
    const row = result.rows[0];
    return row ? memberFrom(row) : null;
  }

  return {
    async addMember({ groupId, userId, role, invitedBy }) {
      // Rejoining must UPDATE the existing row rather than insert: the primary key
      // is (group_id, user_id), so a second INSERT of a previously-removed member
      // collides with it. This was hit for real while writing the integration tests.
      const revived = await database.query<Row>(
        `UPDATE group_members
            SET removed_at = NULL, removed_by = NULL, role = $3, invited_by = $4, joined_at = now()
          WHERE group_id = $1 AND user_id = $2 AND removed_at IS NOT NULL
          RETURNING user_id`,
        [groupId, userId, role, invitedBy],
      );
      if (revived.rows[0]) return readMember(groupId, userId);

      const inserted = await database.query<Row>(
        `INSERT INTO group_members (group_id, user_id, role, invited_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_id, user_id) DO NOTHING
         RETURNING user_id`,
        [groupId, userId, role, invitedBy],
      );
      if (inserted.rows[0]) return readMember(groupId, userId);

      // Conflict with a live row: already a member, nothing to do.
      return readMember(groupId, userId);
    },

    async removeMember(groupId, userId, actorId) {
      const result = await database.query<Row>(
        `UPDATE group_members SET removed_at = now(), removed_by = $3
          WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL
          RETURNING user_id`,
        [groupId, userId, actorId],
      );
      return result.rows.length > 0;
    },

    async changeRole(groupId, userId, role) {
      const result = await database.query<Row>(
        `UPDATE group_members SET role = $3
          WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL
          RETURNING user_id`,
        [groupId, userId, role],
      );
      return result.rows[0] ? readMember(groupId, userId) : null;
    },

    async transferOwnership({ groupId, fromUserId, toUserId }) {
      if (!database.withSession) throw new Error('DATABASE_SESSION_REQUIRED');
      const open = database.withSession;
      const run = open as (fn: (session: QueryClient) => Promise<boolean>) => Promise<boolean>;
      return run.call(database, async (session: QueryClient) => {
        await session.query('BEGIN');
        try {
          // The single-owner partial unique index means the two writes cannot be
          // reordered safely: demote first, promote second, or the index rejects it.
          const demoted = await session.query<Row>(
            `UPDATE group_members SET role = 'admin'
              WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL AND role = 'owner'
              RETURNING user_id`,
            [groupId, fromUserId],
          );
          if (demoted.rows.length === 0) {
            await session.query('ROLLBACK');
            return false;
          }
          const promoted = await session.query<Row>(
            `UPDATE group_members SET role = 'owner'
              WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL
              RETURNING user_id`,
            [groupId, toUserId],
          );
          if (promoted.rows.length === 0) {
            await session.query('ROLLBACK');
            return false;
          }
          await session.query('COMMIT');
          return true;
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },

    async createInvite({ groupId, role, maxUses, expiresAt, createdBy }) {
      // Code shape matches what registration already accepts; uniqueness is the
      // group_invites_code_key constraint's job, and a collision is retried by the
      // caller rather than silently producing a duplicate code.
      const result = await database.query<Row>(
        `INSERT INTO group_invites (group_id, code, role, max_uses, expires_at, created_by)
         VALUES ($1, $2, $3::group_role, $4, $5, $6)
         RETURNING id, code, expires_at`,
        [groupId, generateCode(), role, maxUses, expiresAt, createdBy],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INVITE_CREATE_FAILED');
      return {
        id: str(row.id),
        code: str(row.code),
        expiresAt: timeOrNull(row.expires_at),
      };
    },

    async listInvites(groupId) {
      const result = await database.query<Row>(
        `SELECT id, role, max_uses, used_count, created_by, expires_at, revoked_at, created_at
           FROM group_invites
          WHERE group_id = $1
          ORDER BY created_at DESC`,
        [groupId],
      );
      return result.rows.map((row) => ({
        id: str(row.id),
        role: str(row.role) as GroupRole,
        maxUses: row.max_uses === null ? null : num(row.max_uses),
        usedCount: num(row.used_count),
        createdBy: str(row.created_by),
        expiresAt: timeOrNull(row.expires_at),
        revokedAt: timeOrNull(row.revoked_at),
        createdAt: apiTime(row.created_at),
      }));
    },

    async revokeInvite(groupId, inviteId) {
      const result = await database.query<Row>(
        `UPDATE group_invites SET revoked_at = now()
          WHERE id = $1 AND group_id = $2 AND revoked_at IS NULL
          RETURNING id`,
        [inviteId, groupId],
      );
      return result.rows.length > 0;
    },

    async memberRole(groupId, userId) {
      const result = await database.query<Row>(
        `SELECT role FROM group_members
          WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [groupId, userId],
      );
      const row = result.rows[0];
      return row ? (str(row.role) as GroupRole) : null;
    },

    async liveOwnerCount(groupId) {
      const result = await database.query<Row>(
        `SELECT count(*) AS c FROM group_members
          WHERE group_id = $1 AND role = 'owner' AND removed_at IS NULL`,
        [groupId],
      );
      return num(result.rows[0]?.c ?? 0);
    },

    async userExists(userId) {
      const found = await database.query<Row>('SELECT 1 AS ok FROM users WHERE id = $1', [userId]);
      return found.rows.length > 0;
    },

    async memberIds(groupId) {
      const result = await database.query<Row>(
        `SELECT user_id FROM group_members WHERE group_id = $1 AND removed_at IS NULL`,
        [groupId],
      );
      return result.rows.map((row) => str(row.user_id));
    },
  };
}

/** 12 hex chars, uppercase: readable over the phone, which is how these get shared. */
function generateCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `GYQ-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
