import pg from 'pg';

// Local development: read server/.env if it exists (hosts set real env vars instead).
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('Set DATABASE_URL (Supabase → Connect → Session pooler connection string), e.g. in server/.env');
}

// count(*) and bigint columns come back as strings by default; every value
// in this app fits in a JS number, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/**
 * One connection pool per thread (the layout worker imports this file too).
 * Kept small: Supabase's free pooler allows a limited number of connections.
 */
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 5),
  // Supabase requires TLS; its pooler certificate isn't in Node's default CA list.
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

/** All rows of a query. */
export async function all<T>(sql: string, params: unknown[] = [], c: pg.Pool | pg.PoolClient = pool): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}

/** First row of a query, or undefined. */
export async function one<T>(sql: string, params: unknown[] = [], c: pg.Pool | pg.PoolClient = pool): Promise<T | undefined> {
  return (await c.query(sql, params)).rows[0] as T | undefined;
}

/** Runs fn inside a transaction on one connection; commits, or rolls back if fn throws. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(begin);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export const GALAXY_VERSION_SQL = "SELECT value FROM meta WHERE key = 'galaxy_version'";
export const BUMP_VERSION_SQL = "UPDATE meta SET value = value + 1 WHERE key = 'galaxy_version' RETURNING value";

export type UserRow = { id: number; username: string; hash: string };

export const users = {
  byName: (username: string) =>
    one<UserRow>('SELECT id, username, hash FROM users WHERE lower(username) = lower($1)', [username]),
  byId: (id: number) => one<{ id: number; username: string }>('SELECT id, username FROM users WHERE id = $1', [id]),
  insert: async (username: string, hash: string) =>
    (await one<{ id: number }>('INSERT INTO users (username, hash) VALUES ($1, $2) RETURNING id', [username, hash]))!.id,
};

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}
