import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Migration } from './migrate.js';

const initialMigrationUrl = new URL(
  '../../../../infra/db/migrations/0001_init.sql',
  import.meta.url,
);

export async function loadMigrations(): Promise<Migration[]> {
  const sql = await readFile(fileURLToPath(initialMigrationUrl), 'utf8');
  return [
    {
      id: '0001_init.sql',
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      sql,
    },
  ];
}
