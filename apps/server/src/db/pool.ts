import pg from 'pg';
import { loadMigrations } from './migrations.js';
import { runMigrations, type QueryClient } from './migrate.js';

const { Pool } = pg;

export type Database = QueryClient & {
  end(): Promise<void>;
};

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 20 });
  const query = async <T = unknown>(client: pg.Pool | pg.PoolClient, text: string, values?: unknown[]) =>
    (await client.query(text, values)) as unknown as { rows: T[] };
  return {
    query: (text, values) => query(pool, text, values),
    withSession: async <T>(fn: (client: QueryClient) => Promise<T>) => {
      const client = await pool.connect();
      const session: QueryClient = {
        query: (text, values) => query(client, text, values),
      };
      try {
        return await fn(session);
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

export async function migrateDatabase(database: QueryClient): Promise<void> {
  await runMigrations(database, await loadMigrations());
}

export async function checkDatabase(database: QueryClient): Promise<'up' | 'down'> {
  try {
    await database.query('SELECT 1');
    return 'up';
  } catch {
    return 'down';
  }
}

export async function getOutboxLag(database: QueryClient): Promise<number | null> {
  try {
    const result = await database.query<{ lag: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS lag
         FROM outbox
        WHERE processed_at IS NULL`,
    );
    return result.rows[0]?.lag ?? 0;
  } catch {
    return null;
  }
}
