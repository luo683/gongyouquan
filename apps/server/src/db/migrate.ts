export type QueryResult<T = unknown> = { rows: T[] };

export type QueryClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  withSession?<T>(fn: (client: QueryClient) => Promise<T>): Promise<T>;
};

export type Migration = {
  id: string;
  checksum: string;
  sql: string;
  transactional?: boolean;
};

const MIGRATION_LOCK_KEY = 7_104_2026;

async function runMigrationsOnSession(client: QueryClient, migrations: Migration[]): Promise<void> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations ORDER BY id',
    );
    const appliedById = new Map(applied.rows.map((row) => [row.id, row.checksum]));

    for (const migration of migrations) {
      const existingChecksum = appliedById.get(migration.id);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`migration checksum mismatch: ${migration.id}`);
        }
        continue;
      }

      if (migration.transactional !== false) await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
          [migration.id, migration.checksum],
        );
        if (migration.transactional !== false) await client.query('COMMIT');
      } catch (error) {
        if (migration.transactional !== false) await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}

export async function runMigrations(client: QueryClient, migrations: Migration[]): Promise<void> {
  if (client.withSession) {
    await client.withSession((session) => runMigrationsOnSession(session, migrations));
    return;
  }
  await runMigrationsOnSession(client, migrations);
}
