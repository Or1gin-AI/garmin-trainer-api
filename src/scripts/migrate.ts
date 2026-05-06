import 'dotenv/config';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  // Resolve drizzle/ relative to this file. In dev (tsx) __dirname points
  // at src/scripts; in the prod build it points at dist/scripts. Both layouts
  // sit one level below the project root.
  const migrationsFolder = path.resolve(import.meta.dirname, '../../drizzle');
  console.log(`[migrate] migrations: ${migrationsFolder}`);
  console.log(`[migrate] db: ${url.replace(/:[^:@]+@/, ':***@')}`);

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder });
  await pool.end();

  console.log('[migrate] done');
  process.exit(0);
}

main().catch((e) => {
  console.error('[migrate] failed:', e);
  process.exit(1);
});
