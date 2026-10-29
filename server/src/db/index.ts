import { Pool, PoolClient, types } from 'pg';
import { config } from '../config';

// TIMESTAMP (without time zone) columns are stored in UTC (we force the session
// timezone below). Parse them as UTC; by default node-postgres parses them as the
// *server's local* time, which silently shifts dates when running in IST.
types.setTypeParser(1114, (s: string) => new Date(s.replace(' ', 'T') + 'Z'));

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  options: '-c timezone=UTC',
});

pool.on('error', (err) => {
  // An idle client died (e.g. Supabase restarted). The pool replaces it on the
  // next query, so log instead of crashing the whole process as before.
  console.error('❌ Unexpected error on idle PostgreSQL client:', err.message);
});

/**
 * Run `fn` inside BEGIN/COMMIT. Anything thrown rolls the whole thing back,
 * so a ledger update can never be half-applied.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type Queryable = Pick<PoolClient, 'query'>;

export default pool;
