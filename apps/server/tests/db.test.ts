import { describe, expect, it } from 'vitest';
import { checkDatabase, getOutboxLag } from '../src/db/pool.js';
import { loadMigrations } from '../src/db/migrations.js';

describe('database foundation', () => {
  it('loads the complete initial migration from the repository', async () => {
    const [migration] = await loadMigrations();

    expect(migration.id).toBe('0001_init.sql');
    expect(migration.sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(migration.sql.match(/CREATE TABLE /g)).toHaveLength(22);
    expect(migration.sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(4);
    expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
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
