import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Migration } from './migrate.js';

const migrationsDirUrl = new URL('../../../../infra/db/migrations/', import.meta.url);

/** Migration ids look like `0001_init.sql`; anything else is ignored so scratch files cannot ship. */
const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9._-]+\.sql$/;

export async function loadMigrations(): Promise<Migration[]> {
  const dir = fileURLToPath(migrationsDirUrl);
  const names = (await readdir(dir)).filter((name) => MIGRATION_FILE.test(name)).sort();

  if (names.length === 0) {
    throw new Error(`no migrations found in ${dir}`);
  }

  return Promise.all(
    names.map(async (name): Promise<Migration> => {
      const sql = await readFile(`${dir}/${name}`, 'utf8');
      return {
        id: name,
        checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
        sql,
      };
    }),
  );
}
