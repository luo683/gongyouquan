import { describe, expect, it } from 'vitest';
import { checkDatabase, getOutboxLag } from '../src/db/pool.js';
import { loadMigrations } from '../src/db/migrations.js';

describe('database foundation', () => {
  it('loads every migration in the folder, oldest first', async () => {
    const migrations = await loadMigrations();

    expect(migrations.map((m) => m.id)).toEqual([
      '0001_init.sql',
      '0002_messages_updated_at.sql',
      '0003_alert_idempotency_and_aggregation.sql',
    ]);
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

  it('gives /hooks/alert somewhere to put idempotency and aggregation', async () => {
    const [, , third] = await loadMigrations();

    expect(third?.id).toBe('0003_alert_idempotency_and_aggregation.sql');
    // 8.2 的两个词各自对应一个 UNIQUE：少了 idempotency_key 就是重复投递会各发一条，
    // 少了 agg_key 就是同一段告警永远合并不起来。
    expect(third?.sql).toContain('idempotency_key TEXT        NOT NULL UNIQUE');
    expect(third?.sql).toContain('CREATE UNIQUE INDEX alert_windows_key ON alert_windows (agg_key)');
    // 删掉那条被聚合的消息不该把窗口一起删掉：计数归零不等于没响过。
    expect(third?.sql).toContain('REFERENCES messages(id) ON DELETE SET NULL');
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
