import session from 'express-session';
import type pg from 'pg';

const DAY = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY = 15 * 60 * 1000;

/** express-session store backed by the `sessions` table in Postgres. */
export class PgStore extends session.Store {
  constructor(private pool: pg.Pool) {
    super();
    // Expired rows are ignored by get(); this just keeps the table small.
    setInterval(() => {
      this.pool.query('DELETE FROM sessions WHERE expires <= $1', [Date.now()]).catch((err) => {
        console.error('[sessions] cleanup failed:', err.message);
      });
    }, CLEANUP_EVERY).unref();
  }

  private static expiry(sess: session.SessionData): number {
    const e = sess.cookie?.expires;
    return e ? new Date(e).getTime() : Date.now() + DAY;
  }

  override get(sid: string, cb: (err: unknown, sess?: session.SessionData | null) => void) {
    this.pool
      .query('SELECT sess FROM sessions WHERE sid = $1 AND expires > $2', [sid, Date.now()])
      .then((r) => cb(null, r.rows[0] ? JSON.parse(r.rows[0].sess) : null), cb);
  }

  override set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void) {
    this.pool
      .query(
        `INSERT INTO sessions (sid, sess, expires) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        [sid, JSON.stringify(sess), PgStore.expiry(sess)],
      )
      .then(() => cb?.(), (err) => cb?.(err));
  }

  override touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void) {
    this.pool
      .query('UPDATE sessions SET expires = $1 WHERE sid = $2', [PgStore.expiry(sess), sid])
      .then(() => cb?.(), (err) => cb?.(err));
  }

  override destroy(sid: string, cb?: (err?: unknown) => void) {
    this.pool
      .query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => cb?.(), (err) => cb?.(err));
  }
}
