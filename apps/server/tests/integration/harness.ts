import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import argon2 from 'argon2';
import { createDatabase, migrateDatabase, type Database } from '../../src/db/pool.js';
import type { QueryClient } from '../../src/db/migrate.js';
import { loadMigrations } from '../../src/db/migrations.js';
import { HttpError } from '../../src/http/errors.js';

/**
 * Shared plumbing for the real-PostgreSQL suites.
 *
 * Everything here is gated the same way the suites are: with no
 * INTEGRATION_DATABASE_URL there is no database to talk to, so nothing in this
 * file should ever run. vitest gives each test file its own module instance, so
 * the per-run tag and the fixture ledger stay private to one file.
 */

export type Row = Record<string, unknown>;

export const num = (value: unknown): number => Number(value);
export const str = (value: unknown): string => String(value);

export function row0(rows: Row[]): Row {
  const row = rows[0];
  if (!row) throw new Error('expected at least one row');
  return row;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const databaseUrl = (): string => process.env.INTEGRATION_DATABASE_URL ?? '';

export const seedPassword = 'HardPass2026';

/** Assert the service layer rejects with exactly this contract error code. */
export async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error(`expected ${code}, but nothing was thrown`);
  expect(caught).toBeInstanceOf(HttpError);
  expect((caught as HttpError).code).toBe(code);
}

export type Harness = {
  db: Database;
  tag: string;
  up(): Promise<Database>;
  down(): Promise<void>;
  withSession<T>(fn: (session: QueryClient) => Promise<T>): Promise<T>;
  reject(sql: string, values?: unknown[], fragment?: string): Promise<void>;
  insertUser(username: string, displayName?: string): Promise<string>;
  bootstrapUser(): Promise<string>;
  seedGroup(name?: string): Promise<string>;
  insertInvite(groupId: string, code: string, maxUses: number): Promise<void>;
  insertMessage(
    groupId: string,
    senderId: string,
    body: string | null,
    kind?: string,
    deleted?: boolean,
  ): Promise<number>;
  migrationLedger(): Promise<Array<Record<string, string>>>;
};

export function createHarness(): Harness {
  const tag = randomBytes(4).toString('hex');
  let db: Database;
  let bootstrapped: string | undefined;

  function requireUrl(): string {
    const url = databaseUrl();
    if (!url) throw new Error('INTEGRATION_DATABASE_URL is not set; the harness must not be constructed');
    return url;
  }

  async function withSession<T>(fn: (session: QueryClient) => Promise<T>): Promise<T> {
    if (!db) throw new Error('harness.up() has not run yet');
    const open = db.withSession;
    if (!open) throw new Error('expected a database that can open a session');
    return open.call(db, fn) as Promise<T>;
  }

  const harness: Harness = {
    get db() {
      if (!db) throw new Error('harness.up() has not run yet');
      return db;
    },
    tag,

    async up() {
      db = createDatabase(requireUrl());
      await migrateDatabase(db);
      return db;
    },

    /**
     * Every fixture username carries this run's tag, so one pattern collects them
     * all - including rows auth.createService made on our behalf. Running against a
     * persistent instance twice in a row must give the same answer.
     */
    async down() {
      if (!db) return;
      await db.query(`DELETE FROM groups WHERE created_by IN (SELECT id FROM users WHERE username LIKE $1)`, [
        `%${tag}%`,
      ]);
      // files.uploader_id has no ON DELETE CASCADE, so an uploader cannot be
      // removed until their objects are gone. Real constraint, learned the hard way.
      await db.query(`DELETE FROM files WHERE uploader_id IN (SELECT id FROM users WHERE username LIKE $1)`, [
        `%${tag}%`,
      ]);
      // outbox has NO foreign key on aggregate_id - it is polymorphic (message /
      // task / comment), so it cannot have one. Deleting a message therefore
      // leaves its events behind, and getOutboxLag() reads the oldest unprocessed
      // row: one orphan pins the readiness lag forever. Only orphans are removed
      // here, which is exactly the shape a real reaper needs (decision 0006).
      await db.query(
        `DELETE FROM outbox o WHERE o.aggregate_type = 'message'
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = o.aggregate_id)`,
      );
      // sessions / group_members / messages hang off users and groups with CASCADE.
      await db.query(`DELETE FROM users WHERE username LIKE $1`, [`%${tag}%`]);
      await db.end();
    },

    withSession,

    async reject(sql, values = [], fragment = '') {
      let failed = false;
      try {
        await db.query(sql, values);
      } catch (error) {
        failed = true;
        if (fragment) expect(str((error as Error).message)).toContain(fragment);
      }
      expect(failed, `expected this statement to be rejected: ${sql}`).toBe(true);
    },

    async insertUser(username, displayName = '工友') {
      const hash = await argon2.hash(seedPassword, { type: argon2.argon2id });
      const inserted = await db.query<Row>(
        `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [username, displayName, hash],
      );
      return str(row0(inserted.rows).id);
    },

    async bootstrapUser() {
      if (bootstrapped) return bootstrapped;
      const username = `bootstrap-${tag}`;
      const existing = await db.query<Row>('SELECT id FROM users WHERE username = $1', [username]);
      const row = existing.rows[0];
      if (row) {
        bootstrapped = str(row.id);
        return bootstrapped;
      }
      bootstrapped = await harness.insertUser(username, '内置号');
      return bootstrapped;
    },

    async seedGroup(name) {
      const owner = await harness.bootstrapUser();
      const created = await db.query<Row>(
        `INSERT INTO groups (name, description, created_by) VALUES ($1, 'seed', $2) RETURNING id`,
        [name ?? `seed-${tag}-${randomBytes(3).toString('hex')}`, owner],
      );
      const groupId = str(row0(created.rows).id);
      await db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        groupId,
        owner,
      ]);
      return groupId;
    },

    async insertInvite(groupId, code, maxUses) {
      await db.query(
        `INSERT INTO group_invites (group_id, code, role, max_uses, created_by) VALUES ($1, $2, 'member', $3, $4)`,
        [groupId, code, maxUses, await harness.bootstrapUser()],
      );
    },

    async insertMessage(groupId, senderId, body, kind = 'text', deleted = false) {
      const allocated = await db.query<Row>('SELECT alloc_group_seq($1) AS seq', [groupId]);
      const seq = num(row0(allocated.rows).seq);
      await db.query(
        `INSERT INTO messages (group_id, seq, sender_id, kind, body, deleted_at)
         VALUES ($1, $2, $3, $4::message_kind, $5, $6)`,
        [groupId, seq, senderId, kind, body, deleted ? new Date() : null],
      );
      return seq;
    },

    async migrationLedger() {
      const result = await db.query<Row>('SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id');
      return result.rows.map((row) => ({
        id: str(row.id),
        checksum: str(row.checksum),
        applied_at: str(row.applied_at),
      }));
    },
  };

  return harness;
}

export { loadMigrations };
