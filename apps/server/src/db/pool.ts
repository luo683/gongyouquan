import pg from 'pg';
import { loadMigrations } from './migrations.js';
import { runMigrations, type QueryClient } from './migrate.js';

const { Pool } = pg;

export type PoolStats = {
  total: number;
  idle: number;
  waiting: number;
};

export type Database = QueryClient & {
  end(): Promise<void>;
  /** 4.7's pgPoolTotal / pgPoolIdle / pgPoolWaiting. The pool already tracks these. */
  stats(): PoolStats;
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
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
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

/**
 * 4.7's `outboxPending`: how many events are waiting, as opposed to getOutboxLag's
 * answer of how old the oldest one is. The two must not be conflated - an age in
 * seconds read as a count turns one stale event into an apparent backlog of
 * thousands, and the ops manual's inspection item is about the backlog.
 */
export async function getOutboxPending(database: QueryClient): Promise<number | null> {
  try {
    const result = await database.query<{ pending: string | null }>(
      'SELECT count(*) AS pending FROM outbox WHERE processed_at IS NULL',
    );
    return Number(result.rows[0]?.pending ?? 0);
  } catch {
    return null;
  }
}
