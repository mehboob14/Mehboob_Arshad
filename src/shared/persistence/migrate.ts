import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../config.js';
import { PostgresDatabase } from './postgres.js';
import type { TransactionManager, UnitOfWork } from './unit-of-work.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

export async function migrate(
  db: UnitOfWork & TransactionManager,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(MIGRATIONS_DIR + file, 'utf8');
    // Each migration is atomic: DDL in Postgres is transactional, so a failure
    // half way through leaves neither the schema nor the ledger partially moved.
    await db.withTransaction(async (uow) => {
      await uow.query(sql);
      await uow.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    log(`applied ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = new PostgresDatabase(config.DATABASE_URL);
  await migrate(db, (m) => process.stdout.write(`${m}\n`));
  await db.close();
}
