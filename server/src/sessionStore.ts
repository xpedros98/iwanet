import session from 'express-session';
import type { DatabaseSync } from 'node:sqlite';

const DAY = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY = 15 * 60 * 1000;

/** express-session store backed by the `sessions` table in the same SQLite file. */
export class SqliteStore extends session.Store {
  private q;

  constructor(db: DatabaseSync) {
    super();
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
      ),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      purge: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    // Expired rows are ignored by get(); this just keeps the table small.
    setInterval(() => this.q.purge.run(Date.now()), CLEANUP_EVERY).unref();
  }

  private static expiry(sess: session.SessionData): number {
    const e = sess.cookie?.expires;
    return e ? new Date(e).getTime() : Date.now() + DAY;
  }

  override get(sid: string, cb: (err: unknown, sess?: session.SessionData | null) => void) {
    try {
      const row = this.q.get.get(sid, Date.now()) as { sess: string } | undefined;
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  override set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void) {
    try {
      this.q.set.run(sid, JSON.stringify(sess), SqliteStore.expiry(sess));
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void) {
    try {
      this.q.touch.run(SqliteStore.expiry(sess), sid);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override destroy(sid: string, cb?: (err?: unknown) => void) {
    try {
      this.q.destroy.run(sid);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }
}
