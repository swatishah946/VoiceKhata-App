/**
 * Applies schema.sql (idempotent) and then every file in migrations/ once,
 * recording each in a schema_migrations table.
 *
 * Usage: npm run migrate
 */
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export async function migrate(connectionString: string, log: (m: string) => void = console.log) {
  const client = new Client({ connectionString, options: '-c timezone=UTC' });
  await client.connect();
  try {
    const root = path.join(__dirname, '..');
    await client.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    );

    const dir = path.join(root, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      log(`▶ applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    log('✅ database is up to date');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error('❌ migration failed:', err.message);
    process.exit(1);
  });
}
