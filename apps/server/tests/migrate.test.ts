import { describe, expect, it } from 'vitest';
import { runMigrations, type Migration, type QueryClient } from '../src/db/migrate.js';

type QueryCall = { text: string; values?: unknown[] };

class FakeClient implements QueryClient {
  calls: QueryCall[] = [];
  applied = new Map<string, string>();

  async query<T = { rows: unknown[] }>(text: string, values: unknown[] = []): Promise<T> {
    this.calls.push({ text, values });
    if (text.includes('SELECT id, checksum FROM schema_migrations')) {
      return { rows: [...this.applied].map(([id, checksum]) => ({ id, checksum })) } as T;
    }
    if (text.includes('SELECT pg_advisory_unlock')) return { rows: [] } as T;
    return { rows: [] } as T;
  }
}

class SessionClient extends FakeClient {
  sessionCalls = 0;

  async withSession<T>(fn: (client: QueryClient) => Promise<T>): Promise<T> {
    this.sessionCalls += 1;
    return fn(this);
  }
}

const migrations: Migration[] = [
  { id: '0001_init.sql', checksum: 'checksum-1', sql: 'CREATE TABLE example (id int);' },
];

describe('database migrations', () => {
  it('takes an advisory lock, applies a migration, and records its checksum', async () => {
    const client = new FakeClient();

    await runMigrations(client, migrations);

    expect(client.calls[0].text).toContain('pg_advisory_lock');
    expect(client.calls.some((call) => call.text === migrations[0].sql)).toBe(true);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO schema_migrations'))).toBe(true);
    expect(client.calls.at(-1)?.text).toContain('pg_advisory_unlock');
  });

  it('runs the lock and migration work on one database session when available', async () => {
    const client = new SessionClient();

    await runMigrations(client, migrations);

    expect(client.sessionCalls).toBe(1);
  });

  it('skips an already applied migration without executing its SQL again', async () => {
    const client = new FakeClient();
    client.applied.set('0001_init.sql', 'checksum-1');

    await runMigrations(client, migrations);

    expect(client.calls.some((call) => call.text === migrations[0].sql)).toBe(false);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO schema_migrations'))).toBe(false);
  });

  it('fails when a published migration checksum changes', async () => {
    const client = new FakeClient();
    client.applied.set('0001_init.sql', 'old-checksum');

    await expect(runMigrations(client, migrations)).rejects.toThrow(/checksum mismatch/);
  });
});
