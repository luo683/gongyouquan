import { describe, expect, it } from 'vitest';
import { checkDatabase, getOutboxLag } from '../src/db/pool.js';
import { loadMigrations } from '../src/db/migrations.js';

describe('database foundation', () => {
  it('loads every migration in the folder, oldest first', async () => {
    const migrations = await loadMigrations();

    expect(migrations.map((m) => m.id)).toEqual(['0001_init.sql', '0002_messages_updated_at.sql']);
    expect(migrations.every((m) => /^[a-f0-9]{64}$/.test(m.checksum))).toBe(true);
    // Ids must be unique or the ledger would overwrite itself.
    expect(new Set(migrations.map((m) => m.id)).size).toBe(migrations.length);
  });

  it('loads the complete initial migration from the repository', async () => {
    const [migration] = await loadMigrations();

    expect(migration?.id).toBe('0001_init.sql');
    expect(migration?.sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(migration?.sql.match(/CREATE TABLE /g)).toHaveLength(22);
    expect(migration?.sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(4);
    expect(migration?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('adds the updated_at column spec 4.3.4 needs but 0001 never had', async () => {
    const [, second] = await loadMigrations();

    expect(second?.id).toBe('0002_messages_updated_at.sql');
    expect(second?.sql).toContain('ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(second?.sql).toContain('CREATE TRIGGER trg_messages_updated BEFORE UPDATE ON messages');
  });

  it('reports the database as down without hiding the driver error', async () => {
    const database = { query: async () => { throw new Error('connection refused'); } };
    await expect(checkDatabase(database)).resolves.toBe('down');
  });

  it('returns null when outbox readiness cannot be checked', async () => {
    const database = { query: async () => { throw new Error('schema missing'); } };
    await expect(getOutboxLag(database)).resolves.toBeNull();
  });
});
