import type { QueryClient } from '../db/migrate.js';
import type { AuthRepository, AuthSession, AuthUser, GroupInvite } from './service.js';

type Database = QueryClient;

type Row = Record<string, unknown>;

function userFromRow(row: Row): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    disabledAt: row.disabled_at instanceof Date ? row.disabled_at : null,
  };
}

function sessionFromRow(row: Row): AuthSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    familyId: String(row.family_id),
    refreshTokenHash: String(row.refresh_token_hash),
    replacedBy: row.replaced_by === null ? null : String(row.replaced_by),
    revokedAt: row.revoked_at instanceof Date ? row.revoked_at : null,
    revokedReason: row.revoked_reason === null ? null : String(row.revoked_reason),
    expiresAt: new Date(String(row.expires_at)),
  };
}

export function createAuthRepository(database: Database): AuthRepository {
  return {
    async findUserByUsername(username) {
      const result = await database.query<Row>(
        `SELECT id, username, display_name, password_hash, disabled_at
           FROM users
          WHERE lower(username) = lower($1)`,
        [username],
      );
      return result.rows[0] ? userFromRow(result.rows[0]) : null;
    },

    async findUserById(id) {
      const result = await database.query<Row>(
        `SELECT id, username, display_name, password_hash, disabled_at
           FROM users
          WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? userFromRow(result.rows[0]) : null;
    },

    async registerWithInvite(input) {
      if (!database.withSession) throw new Error('DATABASE_SESSION_REQUIRED');
      return database.withSession(async (session) => {
        await session.query('BEGIN');
        try {
          const invite = await session.query<Row>(
            `UPDATE group_invites
                SET used_count = used_count + 1
              WHERE code = $1
                AND revoked_at IS NULL
                AND (expires_at IS NULL OR expires_at > now())
                AND (max_uses IS NULL OR used_count < max_uses)
              RETURNING group_id, role`,
            [input.code],
          );
          if (!invite.rows[0]) throw new Error('INVITE_INVALID');
          const user = await session.query<Row>(
            `INSERT INTO users (username, display_name, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, username, display_name, password_hash, disabled_at`,
            [input.username, input.displayName, input.passwordHash],
          );
          const row = user.rows[0];
          if (!row) throw new Error('USER_CREATE_FAILED');
          await session.query(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES ($1, $2, $3)`,
            [invite.rows[0].group_id, row.id, invite.rows[0].role],
          );
          await session.query('COMMIT');
          return {
            user: userFromRow(row),
            groups: [{ id: String(invite.rows[0].group_id), role: String(invite.rows[0].role) as GroupInvite['role'] }],
          };
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },

    async createSession(input) {
      const result = await database.query<Row>(
        `INSERT INTO sessions
          (user_id, family_id, refresh_token_hash, replaced_by, revoked_at, revoked_reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, family_id, refresh_token_hash, replaced_by, revoked_at, revoked_reason, expires_at`,
        [input.userId, input.familyId, input.refreshTokenHash, input.replacedBy, input.revokedAt, input.revokedReason, input.expiresAt],
      );
      if (!result.rows[0]) throw new Error('SESSION_CREATE_FAILED');
      return sessionFromRow(result.rows[0]);
    },

    async findSessionByRefreshHash(hash) {
      const result = await database.query<Row>(
        `SELECT id, user_id, family_id, refresh_token_hash, replaced_by, revoked_at, revoked_reason, expires_at
           FROM sessions
          WHERE refresh_token_hash = $1`,
        [hash],
      );
      return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
    },

    async rotateSession({ current, replacement, now }) {
      if (!database.withSession) throw new Error('DATABASE_SESSION_REQUIRED');
      return database.withSession(async (session) => {
        await session.query('BEGIN');
        try {
          const locked = await session.query<Row>(
            `SELECT id, user_id, family_id, refresh_token_hash, replaced_by, revoked_at, revoked_reason, expires_at
               FROM sessions WHERE id = $1 FOR UPDATE`,
            [current.id],
          );
          const row = locked.rows[0];
          if (!row) {
            await session.query('ROLLBACK');
            return { kind: 'invalid' as const };
          }
          const lockedSession = sessionFromRow(row);
          if (lockedSession.replacedBy) {
            await session.query(
              `UPDATE sessions SET revoked_at = $1, revoked_reason = 'reuse_detected'
                WHERE family_id = $2`,
              [now, lockedSession.familyId],
            );
            await session.query('COMMIT');
            return { kind: 'reused' as const };
          }
          if (lockedSession.revokedAt || lockedSession.expiresAt <= now) {
            await session.query('ROLLBACK');
            return { kind: 'invalid' as const };
          }
          const inserted = await session.query<Row>(
            `INSERT INTO sessions
              (user_id, family_id, refresh_token_hash, replaced_by, revoked_at, revoked_reason, expires_at)
             VALUES ($1, $2, $3, NULL, NULL, NULL, $4)
             RETURNING id, user_id, family_id, refresh_token_hash, replaced_by, revoked_at, revoked_reason, expires_at`,
            [replacement.userId, replacement.familyId, replacement.refreshTokenHash, replacement.expiresAt],
          );
          const newRow = inserted.rows[0];
          if (!newRow) throw new Error('SESSION_CREATE_FAILED');
          await session.query(
            `UPDATE sessions SET replaced_by = $1, revoked_at = $2, revoked_reason = 'rotated' WHERE id = $3`,
            [newRow.id, now, current.id],
          );
          await session.query('COMMIT');
          return { kind: 'rotated' as const, session: sessionFromRow(newRow) };
        } catch (error) {
          await session.query('ROLLBACK');
          throw error;
        }
      });
    },

    async revokeSession(session, now) {
      await database.query(
        `UPDATE sessions SET revoked_at = $1, revoked_reason = 'logout' WHERE id = $2`,
        [now, session.id],
      );
    },

    async revokeAllForUser(userId, now) {
      // Returns how many actually went away, which is what 5.2 promises as
      // revokedCount - and it must not re-revoke rows already revoked, or the
      // number would silently count the same session on every call.
      const result = await database.query<Row>(
        `UPDATE sessions
            SET revoked_at = $1, revoked_reason = 'logout'
          WHERE user_id = $2 AND revoked_at IS NULL
          RETURNING id`,
        [now, userId],
      );
      return result.rows.length;
    },
  };
}
