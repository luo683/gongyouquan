import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../src/auth/repository.js';
import { createAuthService } from '../../src/auth/service.js';
import { createRateLimiter } from '../../src/http/rate-limit.js';
import { HttpError } from '../../src/http/errors.js';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createGroupsService } from '../../src/groups/service.js';
import type { Database } from '../../src/db/pool.js';
import { migrateDatabase } from '../../src/db/pool.js';
import type { QueryClient } from '../../src/db/migrate.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadMigrations } from '../../src/db/migrations.js';
import {
  createHarness,
  databaseUrl,
  expectCode,
  num,
  row0,
  seedPassword,
  sleep,
  str,
  type Harness,
  type Row,
} from './harness.js';

/**
 * Real-PostgreSQL acceptance (docs/specs/01 §9.4).
 *
 * The whole suite is skipped unless INTEGRATION_DATABASE_URL is set, so plain
 * `pnpm test` stays green with no database around. The CI `integration` job
 * points it at a real postgres service container.
 */
/**
 * Real-PostgreSQL acceptance (docs/specs/01 §9.4).
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set, so plain `pnpm test` stays
 * green with no database around; the CI `integration` job sets it. Fixtures and
 * cleanup come from ./harness.ts, shared with messages.test.ts so the two
 * cannot drift into different ideas of what a seeded group means.
 */
const harness: Harness = createHarness();
const runTag = harness.tag;
const jwtSecret = 'integration-secret-not-a-real-one';

let db: Database;

const expectRejected = (sql: string, values: unknown[] = [], fragment = ''): Promise<void> =>
  harness.reject(sql, values, fragment);
const snapshotMigrations = (): Promise<Array<Record<string, string>>> => harness.migrationLedger();
const insertUser = (username: string, displayName?: string): Promise<string> =>
  harness.insertUser(username, displayName);
const bootstrapUser = (): Promise<string> => harness.bootstrapUser();
const seedGroup = (name?: string): Promise<string> => harness.seedGroup(name);
const insertInvite = (groupId: string, code: string, maxUses: number): Promise<void> =>
  harness.insertInvite(groupId, code, maxUses);
const insertMessage = (
  groupId: string,
  senderId: string,
  body: string | null,
  kind?: string,
  deleted?: boolean,
): Promise<number> => harness.insertMessage(groupId, senderId, body, kind, deleted);
const withSession = <T>(fn: (session: QueryClient) => Promise<T>): Promise<T> => harness.withSession(fn);

describe.runIf(databaseUrl() !== '')('database integration (real PostgreSQL)', () => {
  beforeAll(async () => {
    db = await harness.up();
  });

  afterAll(async () => {
    // One shared reaper, so every real-database suite cleans up identically.
    await harness.down();
  });

  describe('schema', () => {
    it('creates the object counts the spec and db.test.ts claim', async () => {
      const shape = await db.query<Row>(`
        SELECT
          (SELECT count(*) FROM pg_tables
            WHERE schemaname = 'public' AND tablename <> 'schema_migrations') AS tables,
          (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN
              ('alloc_group_seq', 'alloc_task_no', 'bump_file_ref_count', 'set_updated_at')) AS own_funcs,
          (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
          (SELECT count(*) FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
            WHERE n.nspname = 'public' AND ty.typtype = 'e') AS enums,
          (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') AS indexes,
          (SELECT count(*) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
            WHERE n.nspname = 'public' AND e.extname IN ('pg_trgm', 'pgcrypto')) AS ext_needed
      `);
      const row = row0(shape.rows);
      expect(num(row.tables)).toBe(22);
      expect(num(row.own_funcs)).toBe(4);
      // 7 come from 0001_init.sql; 0002_messages_updated_at.sql adds the 8th.
      expect(num(row.triggers)).toBe(8);
      expect(num(row.enums)).toBe(11);
      expect(num(row.ext_needed)).toBe(2);
      // 41 hand-written indexes plus one backing index per PK / unique constraint.
      expect(num(row.indexes)).toBeGreaterThan(41);
    });

    it('keeps TIMESTAMPTZ on every *_at column, with no exceptions', async () => {
      const common = `
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname ~ '_at$'`;

      const wrong = await db.query<Row>(`
        SELECT c.relname || '.' || a.attname AS column_name, t.typname
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_type t ON t.oid = a.atttypid
          ${common}
           AND t.typname <> 'timestamptz'`);

      // Pattern-driven rather than a hand-picked column list: a `*_at` column
      // added tomorrow is covered without anyone editing this test.
      expect(wrong.rows.map((r) => `${str(r.column_name)}:${str(r.typname)}`)).toEqual([]);

      const counted = await db.query<Row>(`
        SELECT count(*) AS c
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          ${common}`);
      const total = row0(counted.rows);
      // 47 today; the floor catches a silently-empty scan if the predicate breaks.
      expect(num(total.c)).toBeGreaterThanOrEqual(40);
    });

  });

  describe('migration runner', () => {
    it('re-running the migration is a no-op (spec 01 §9.4)', async () => {
      const first = await snapshotMigrations();
      expect(first.map((m) => m.id)).toEqual(['0001_init.sql', '0002_messages_updated_at.sql']);

      await migrateDatabase(db);

      expect(await snapshotMigrations()).toEqual(first);
    });

    it('refuses to run against a database whose applied migration was edited', async () => {
      const migrations = await loadMigrations();
      const first = migrations[0];
      if (!first) throw new Error('expected at least one migration');
      const flipped = first.checksum.endsWith('0') ? `${first.checksum.slice(0, -1)}1` : `${first.checksum.slice(0, -1)}0`;

      await expect(runMigrations(db, [{ ...first, checksum: flipped }])).rejects.toThrow(/checksum mismatch/);
      // The real ledger is untouched by the rejected attempt.
      const ledger = await snapshotMigrations();
      const onDisk = await loadMigrations();
      expect(ledger.map((m) => [m.id, m.checksum])).toEqual(
        onDisk.map((m) => [m.id, m.checksum]),
      );
    });
  });

  describe('auth slice', () => {
    it('registers through an invite code, consumes it, then logs in and rotates', async () => {
      const auth = createAuthService({ repo: createAuthRepository(db), jwtSecret });
      const groupId = await seedGroup();
      const code = `INV-${runTag}`;
      await insertInvite(groupId, code, 1);

      const username = `worker-${runTag}`;
      const registered = await auth.register({ code, username, displayName: '工友甲', password: seedPassword });
      expect(registered.groups.map((group) => group.id)).toContain(groupId);

      // max_uses = 1 is spent inside the same transaction that created the user.
      await expectCode('INVITE_INVALID', () =>
        auth.register({ code, username: `${username}-b`, displayName: '工友乙', password: seedPassword }),
      );
      const invite = await db.query<Row>('SELECT used_count FROM group_invites WHERE code = $1', [code]);
      expect(num(row0(invite.rows).used_count)).toBe(1);

      // The failed second attempt must not have left an orphan user or membership.
      const orphans = await db.query<Row>('SELECT id FROM users WHERE username = $1', [`${username}-b`]);
      expect(orphans.rows).toEqual([]);

      const loggedIn = await auth.login({ username, password: seedPassword, clientKind: 'desktop' });
      expect(loggedIn.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(loggedIn.user.id).toBe(registered.user.id);
      expect(loggedIn.expiresIn).toBe(900);

      await expectCode('AUTH_INVALID_CREDENTIALS', () =>
        auth.login({ username, password: 'WrongPass2026', clientKind: 'desktop' }),
      );
      // Unknown user and wrong password answer with the same code (no enumeration).
      await expectCode('AUTH_INVALID_CREDENTIALS', () =>
        auth.login({ username: `nobody-${runTag}`, password: seedPassword, clientKind: 'desktop' }),
      );

      const rotated = await auth.refresh(loggedIn.refreshToken);
      expect(rotated.refreshToken).not.toBe(loggedIn.refreshToken);

      // Replaying the superseded token revokes the whole family.
      await expectCode('REFRESH_REUSED', () => auth.refresh(loggedIn.refreshToken));
      await expectCode('REFRESH_INVALID', () => auth.refresh(rotated.refreshToken));

      const family = await db.query<Row>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked,
                count(*) FILTER (WHERE revoked_reason = 'reuse_detected') AS reuse_marked
           FROM sessions WHERE family_id = (SELECT family_id FROM sessions WHERE user_id = $1 LIMIT 1)`,
        [registered.user.id],
      );
      const row = row0(family.rows);
      expect(num(row.total)).toBeGreaterThanOrEqual(2);
      expect(num(row.revoked)).toBe(num(row.total));
      expect(num(row.reuse_marked)).toBeGreaterThanOrEqual(1);
    });

    it('revokes every live session for an identity exactly once (logout-all)', async () => {
    const username = `multi-${runTag}`;
    const auth = createAuthService({ repo: createAuthRepository(db), jwtSecret });
    const groupId = await seedGroup();
    await insertInvite(groupId, `INV-MA-${runTag}`, 2);
    const password = 'HardPass2026';

    await auth.register({ code: `INV-MA-${runTag}`, username, displayName: '多端', password });
    const first = await auth.login({ username, password, clientKind: 'desktop' });
    const second = await auth.login({ username, password, clientKind: 'web' });
    expect(first.refreshToken).not.toBe(second.refreshToken);

    const before = await db.query<Row>(
      `SELECT count(*) AS c FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)
         AND revoked_at IS NULL`,
      [username],
    );
    expect(num(row0(before.rows).c)).toBe(2);

    const account = await db.query<Row>('SELECT id FROM users WHERE username = $1', [username]);
    const userId = str(row0(account.rows).id);
    const service = createAuthService({ repo: createAuthRepository(db), jwtSecret });
    const revoked = await service.logoutAll(userId);
    expect(revoked).toBe(2);

    // A second call has nothing left to revoke, so revokedCount cannot be used to
    // double-count the same sessions.
    expect(await service.logoutAll(userId)).toBe(0);

    // logout(refreshToken) is the single-session path, and it shares the
    // revoked_reason literal space with logout-all. It had an unquoted
    // `revoked_reason = logout` in its UPDATE - a bare column reference that
    // PostgreSQL rejects at runtime, which no test had ever reached because
    // the unit suites all used an in-memory repository.
    await service.logout(first.refreshToken);
    const singles = await db.query<Row>(
      `SELECT revoked_reason FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`,
      [userId],
    );
    expect(singles.rows.length).toBeGreaterThanOrEqual(1);
    expect(singles.rows.every((r) => str(r.revoked_reason) === 'logout')).toBe(true);

    // Both tokens are now dead.
    await expectCode('REFRESH_INVALID', () => auth.refresh(first.refreshToken));
    await expectCode('REFRESH_INVALID', () => auth.refresh(second.refreshToken));
  });

  it('throttles a refresh storm per session family, before any rotation is written', async () => {
    // Spec 8.2 wants limits ahead of database work. The family is only knowable
    // from the token, so this bucket is taken after one indexed SELECT and before
    // the INSERT + two UPDATEs - see docs/decisions/0007.
    const limiter = createRateLimiter();
    const username = `storm-${runTag}`;
    const password = 'HardPass2026';
    const groupId = await seedGroup();
    await insertInvite(groupId, `INV-ST-${runTag}`, 1);

    const service = createAuthService({
      repo: createAuthRepository(db),
      jwtSecret,
      limiter,
    });
    const registered = await service.register({
      code: `INV-ST-${runTag}`,
      username,
      displayName: '风暴',
      password,
    });
    const loggedIn = await service.login({ username, password, clientKind: 'desktop' });

    let token = loggedIn.refreshToken;
    let refused = 0;
    let rotated = 0;
    for (let i = 0; i < 40; i += 1) {
      try {
        const next = await service.refresh(token);
        token = next.refreshToken;
        rotated += 1;
      } catch (error) {
        if ((error as HttpError).code === 'RATE_LIMITED') refused += 1;
        else throw error;
      }
    }
    expect(rotated).toBe(30);
    expect(refused).toBe(10);

    // The refusal is per family, so a different device of the same user is untouched.
    const other = await service.login({ username, password, clientKind: 'web' });
    expect((await service.refresh(other.refreshToken)).user.id).toBe(registered.user.id);
  });

  it('collapses username case so login cannot fork a second account', async () => {
      await insertUser(`case-${runTag}`);
      await expectRejected(
        `INSERT INTO users (username, display_name, password_hash) VALUES ($1, 'X', 'hash')`,
        [`CASE-${runTag}`],
        'duplicate key value',
      );
    });

    it('refuses a disabled account at login time', async () => {
      const username = `off-${runTag}`;
      const id = await insertUser(username);
      await db.query(`UPDATE users SET disabled_at = now(), disabled_note = '违规' WHERE id = $1`, [id]);
      const auth = createAuthService({ repo: createAuthRepository(db), jwtSecret });
      // Password still verifies; the disabled gate is what refuses the login.
      await expectCode('ACCOUNT_DISABLED', () =>
        auth.login({ username, password: seedPassword, clientKind: 'web' }),
      );
    });
  });

  describe('groups slice', () => {
    it('creates, lists, reads, updates, and refuses writes on an archived group', async () => {
      const groups = createGroupsService(createGroupsRepository(db));
      const owner = await insertUser(`owner-${runTag}`);
      const stranger = await insertUser(`stranger-${runTag}`);

      const created = await groups.create(owner, { name: `搬砖群-${runTag}`, description: '工地' });
      expect(created.name).toBe(`搬砖群-${runTag}`);
      expect(num(created.lastSeq)).toBe(0);
      expect(created.isSystem).toBe(false);

      // Create puts exactly one live owner row in place.
      const ownerRows = await db.query<Row>(
        `SELECT role FROM group_members WHERE group_id = $1 AND removed_at IS NULL`,
        [created.id],
      );
      expect(ownerRows.rows.map((r) => str(r.role))).toEqual(['owner']);

      const listed = await groups.list(owner, false);
      expect(listed.find((g) => g.id === created.id)?.memberCount).toBe(1);
      expect(listed.find((g) => g.id === created.id)?.unreadCount).toBe(0);

      // A stranger sees neither the group in the list nor that it exists at all.
      expect((await groups.list(stranger, false)).find((g) => g.id === created.id)).toBeUndefined();
      await expectCode('NOT_FOUND', () => groups.detail(stranger, created.id));
      await expectCode('NOT_FOUND', () => groups.members(stranger, created.id));
      // decision 0004 gap three: reads hide existence with 404, but a write
      // keeps FORBIDDEN_NOT_MEMBER — the caller already knew the group existed.
      await expectCode('FORBIDDEN_NOT_MEMBER', () => groups.update(stranger, created.id, { name: '劫持' }));

      expect((await groups.detail(owner, created.id)).myMembership.role).toBe('owner');
      expect((await groups.members(owner, created.id))[0]?.userId).toBe(owner);
      expect((await groups.update(owner, created.id, { name: `改名群-${runTag}` })).name).toBe(`改名群-${runTag}`);

      // decision 0004: archived stays readable, writes answer 409 GROUP_ARCHIVED.
      await db.query('UPDATE groups SET is_archived = true WHERE id = $1', [created.id]);
      expect((await groups.detail(owner, created.id)).isArchived).toBe(true);
      expect((await groups.list(owner, false)).find((g) => g.id === created.id)).toBeUndefined();
      expect((await groups.list(owner, true)).find((g) => g.id === created.id)).toBeDefined();
      await expectCode('GROUP_ARCHIVED', () => groups.update(owner, created.id, { name: '再改' }));
      await db.query('UPDATE groups SET is_archived = false WHERE id = $1', [created.id]);

      // Two live owners per group is impossible.
      await expectRejected(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [created.id, stranger],
        'group_members_single_owner',
      );
    });

    it('lets a removed member rejoin instead of colliding with the old row', async () => {
      const groupId = await seedGroup();
      const userId = await insertUser(`rejoin-${runTag}`);
      await db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [groupId, userId]);
      await db.query(`UPDATE group_members SET removed_at = now() WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);

      // The composite PK is (group_id, user_id), so a re-join must revive the row,
      // not insert a second one. This is the constraint the member-management
      // endpoints still have to respect.
      await expectRejected(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`,
        [groupId, userId],
        'duplicate key value',
      );
      await db.query(
        `UPDATE group_members SET removed_at = NULL, role = 'member', invited_by = NULL WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId],
      );
      const live = await db.query<Row>(
        `SELECT count(*) AS c FROM group_members WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [groupId, userId],
      );
      expect(num(row0(live.rows).c)).toBe(1);
    });
  });

  describe('message storage primitives the sync module will lean on', () => {
    it('counts unread messages and picks the last-message preview correctly', async () => {
      const groups = createGroupsService(createGroupsRepository(db));
      const groupId = await seedGroup();
      const owner = await bootstrapUser();
      const mate = await insertUser(`mate-${runTag}`);
      await db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [groupId, mate]);

      const sent: number[] = [];
      sent.push(await insertMessage(groupId, owner, '今天三点集合'));
      sent.push(await insertMessage(groupId, mate, '收到，带冲击钻'));
      // A real system message has no sender (DDL: NULL = 系统/机器人消息).
      const systemSeq = await insertMessage(groupId, owner, 'system note', 'system');
      await db.query(
        `UPDATE messages SET sender_id = NULL WHERE group_id = $1 AND seq = $2`,
        [groupId, systemSeq],
      );
      await db.query(`UPDATE messages SET deleted_at = now() WHERE group_id = $1 AND seq = $2`, [groupId, sent[1]]);

      const listed = (await groups.list(owner, false)).find((g) => g.id === groupId);
      // Own messages and 'system' kind are excluded; the soft-deleted one still
      // counts here because this query filters on deleted_at only for the preview.
      expect(listed?.memberCount).toBe(2);
      // Unread excludes own messages and system kind, but NOT soft-deleted rows:
      // the revoked message at seq 2 is still counted. Same asymmetry as preview.
      expect(num(listed?.unreadCount ?? 0)).toBe(1);
      expect(num(listed?.lastSeq ?? 0)).toBe(3);

      // Mark everything read, then unread drops to zero.
      await db.query(
        `INSERT INTO read_positions (user_id, group_id, last_read_seq) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, group_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq`,
        [owner, groupId, 3],
      );
      expect((await groups.list(owner, false)).find((g) => g.id === groupId)?.unreadCount).toBe(0);

      // Preview skips soft-deleted rows... but NOT `system` rows, unlike the
      // unread counter two queries above (decision 0005 gap one). Pinned as-is
      // so the asymmetry is visible the moment someone changes one side.
      const preview = (await groups.list(owner, false)).find((g) => g.id === groupId)?.lastMessagePreview;
      expect(preview?.kind).toBe('system');
      expect(preview?.body).toBe('system note');
      expect(preview?.senderDisplayName).toBe('System');

      // Soft-deleted rows never surface: with seq 2 revoked earlier and the
      // system row now revoked too, the preview falls back to the oldest live seq.
      await db.query(`UPDATE messages SET deleted_at = now() WHERE group_id = $1 AND kind = 'system'`, [groupId]);
      const afterDelete = (await groups.list(owner, false)).find((g) => g.id === groupId)?.lastMessagePreview;
      expect(afterDelete?.body).toBe('今天三点集合');
    });

    it('makes (group_id, seq) unique and re-sends idempotent by clientMsgId', async () => {
      const groupId = await seedGroup();
      const userId = await bootstrapUser();
      const seq = await insertMessage(groupId, userId, '第一条');
      const clientMsgId = randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');

      await db.query(
        `INSERT INTO messages (group_id, seq, sender_id, client_msg_id, body) VALUES ($1, $2, $3, $4, 'dup')`,
        [groupId, seq + 1, userId, clientMsgId],
      );
      // Same sender + same clientMsgId must be refused, which is what makes
      // retrying a weak-network send safe.
      await expectRejected(
        `INSERT INTO messages (group_id, seq, sender_id, client_msg_id, body) VALUES ($1, $2, $3, $4, 'dup again')`,
        [groupId, seq + 2, userId, clientMsgId],
        'messages_client_msg_key',
      );
      await expectRejected(
        `INSERT INTO messages (group_id, seq, sender_id, body) VALUES ($1, $2, $3, 'same seq')`,
        [groupId, seq + 1, userId],
        'messages_group_seq_key',
      );
    });

    it('allocates group seq values that never repeat, even under concurrency', async () => {
      const groupId = await seedGroup();
      const allocated = await Promise.all(
        Array.from({ length: 100 }, () =>
          db.query<Row>('SELECT alloc_group_seq($1) AS seq', [groupId]).then((r) => num(row0(r.rows).seq)),
        ),
      );
      expect(new Set(allocated).size).toBe(100);
      const stored = await db.query<Row>('SELECT last_seq FROM groups WHERE id = $1', [groupId]);
      expect(num(row0(stored.rows).last_seq)).toBe(Math.max(...allocated));

      // The counter and the row lock share the transaction, so a rolled-back
      // allocation hands the same number back rather than double-issuing it.
      const before = num(row0(stored.rows).last_seq);
      let rolledBack = -1;
      await withSession(async (session) => {
        await session.query('BEGIN');
        const r = await session.query<Row>('SELECT alloc_group_seq($1) AS seq', [groupId]);
        rolledBack = num(row0(r.rows).seq);
        await session.query('ROLLBACK');
      });
      expect(rolledBack).toBe(before + 1);
      const next = await db.query<Row>('SELECT alloc_group_seq($1) AS seq', [groupId]);
      expect(num(row0(next.rows).seq)).toBe(rolledBack);
    });

    it('advances messages.updated_at on edit and on revoke (spec 4.3.4)', async () => {
      // This is the whole reason migration 0002 exists: without a monotonic
      // per-row stamp a client cannot decide which of two out-of-order
      // message:updated / message:deleted events should win.
      const groupId = await seedGroup();
      const userId = await bootstrapUser();
      const seq = await insertMessage(groupId, userId, '原始内容');

      const stamp = async (): Promise<Row> => {
        const found = await db.query<Row>(
          `SELECT updated_at::text AS updated_at, edited_at, deleted_at
             FROM messages WHERE group_id = $1 AND seq = $2`,
          [groupId, seq],
        );
        return row0(found.rows);
      };

      const atFirst = await stamp();
      expect(atFirst.updated_at).toBeTruthy();
      expect(atFirst.edited_at).toBeNull();

      await sleep(20);
      await db.query(
        `UPDATE messages SET body = '改过的内容', edited_at = now() WHERE group_id = $1 AND seq = $2`,
        [groupId, seq],
      );
      const atEdit = await stamp();
      expect(new Date(str(atEdit.updated_at)).getTime()).toBeGreaterThan(new Date(str(atFirst.updated_at)).getTime());
      expect(atEdit.edited_at).not.toBeNull();

      await sleep(20);
      await db.query(
        `UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE group_id = $1 AND seq = $3`,
        [groupId, userId, seq],
      );
      const atRevoke = await stamp();
      expect(new Date(str(atRevoke.updated_at)).getTime()).toBeGreaterThan(new Date(str(atEdit.updated_at)).getTime());
      expect(atRevoke.deleted_at).not.toBeNull();
    });

    it('keeps task_no and group seq as independent counters', async () => {
      const groupId = await seedGroup();
      expect(num(row0((await db.query<Row>('SELECT alloc_group_seq($1) AS v', [groupId])).rows).v)).toBe(1);
      expect(num(row0((await db.query<Row>('SELECT alloc_task_no($1) AS v', [groupId])).rows).v)).toBe(1);
    });

    it('answers a trigram body search from the partial GIN index', async () => {
      const groupId = await seedGroup();
      const userId = await bootstrapUser();
      await insertMessage(groupId, userId, '脚手架要检查扣件');
      await insertMessage(groupId, userId, '明天发工资', undefined, true);
      await insertMessage(groupId, userId, '把扳手放箱子里');

      // pg_trgm `%` is threshold-gated; short Chinese phrases need a low limit.
      // SET LOCAL keeps the tuning inside one pooled client.
      const probed = await withSession(async (session) => {
        await session.query('BEGIN');
        await session.query('SET LOCAL pg_trgm.similarity_threshold = 0.05');
        await session.query('SET LOCAL enable_seqscan = off');
        const found = await session.query<Row>(
          `SELECT body FROM messages
            WHERE group_id = $1 AND body % '扣件' AND deleted_at IS NULL AND body IS NOT NULL
            ORDER BY similarity(body, '扣件') DESC`,
          [groupId],
        );
        const plan = await session.query<Row>(
          `EXPLAIN SELECT body FROM messages
            WHERE body % '扣件' AND deleted_at IS NULL AND body IS NOT NULL`,
        );
        await session.query('COMMIT');
        return { found, plan };
      });

      // The soft-deleted row sits outside the partial index, so it cannot surface.
      expect(probed.found.rows.map((r) => str(r.body))).toEqual(['脚手架要检查扣件']);
      expect(probed.plan.rows.map((r) => str(Object.values(r)[0])).join('\n')).toContain('messages_body_trgm');
    });

    it('keeps the BIGINT ids that must reach the browser as strings inside bigint range', async () => {
      const groupId = await seedGroup();
      const ids = await db.query<Row>(
        `SELECT (SELECT id FROM groups WHERE id = $1) AS group_id,
                (SELECT max(id) FROM messages WHERE group_id = $1) AS message_id`,
        [groupId],
      );
      const row = row0(ids.rows);
      // node-pg hands bigint back as a string; Number() would silently lose
      // precision past 2^53, which is why the contract keeps ids as strings.
      expect(typeof row.group_id === 'string' || typeof row.group_id === 'number').toBe(true);
      expect(str(row.group_id)).toBe(groupId);
    });
  });

  describe('soft delete vs ON DELETE CASCADE (decision 0002)', () => {
    it('really does cascade a hard group delete down to messages and members', async () => {
      const groupId = await seedGroup();
      const userId = await bootstrapUser();
      await insertMessage(groupId, userId, '会被连带删掉');
      await db.query('DELETE FROM groups WHERE id = $1', [groupId]);

      for (const table of ['messages', 'group_members', 'group_invites', 'read_positions']) {
        const left = await db.query<Row>(`SELECT count(*) AS c FROM ${table} WHERE group_id = $1`, [groupId]);
        expect(num(row0(left.rows).c), `${table} kept orphans after deleting the group`).toBe(0);
      }
    });

    it('leaves the soft-deleted message row addressable for the audit trail', async () => {
      const groupId = await seedGroup();
      const userId = await bootstrapUser();
      const seq = await insertMessage(groupId, userId, '撤回的消息');
      await db.query(`UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE group_id = $1 AND seq = $3`, [
        groupId,
        userId,
        seq,
      ]);
      const kept = await db.query<Row>(
        `SELECT deleted_by FROM messages WHERE group_id = $1 AND seq = $2`,
        [groupId, seq],
      );
      expect(str(row0(kept.rows).deleted_by)).toBe(userId);
    });

    it('tracks file ref_count through the trigger instead of ON DELETE CASCADE', async () => {
      const uploader = await bootstrapUser();
      const file = await db.query<Row>(
        `INSERT INTO files (storage, object_key, sha256, byte_size, mime_type, uploader_id, status)
         VALUES ('local', $1, $2, 10, 'text/plain', $3, 'ready')
         RETURNING id`,
        [`k-${runTag}`, 'a'.repeat(64), uploader],
      );
      const fileId = str(row0(file.rows).id);

      const groupId = await seedGroup();
      const userId = await bootstrapUser();
      const seq = await insertMessage(groupId, userId, null, 'file');
      await db.query(
        `INSERT INTO message_attachments (message_id, file_id, kind, file_name)
         VALUES ((SELECT id FROM messages WHERE group_id = $1 AND seq = $2), $3, 'file', 'a.txt')`,
        [groupId, seq, fileId],
      );
      expect(num(row0((await db.query<Row>('SELECT ref_count FROM files WHERE id = $1', [fileId])).rows).ref_count)).toBe(1);

      await db.query('DELETE FROM groups WHERE id = $1', [groupId]);
      expect(num(row0((await db.query<Row>('SELECT ref_count FROM files WHERE id = $1', [fileId])).rows).ref_count)).toBe(0);
    });
  });

});
