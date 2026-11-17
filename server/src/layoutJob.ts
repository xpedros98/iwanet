import type { DatabaseSync } from 'node:sqlite';
import { computeLayout } from './layout.js';

export type LayoutResult = { version: number; stars: number; ms: { read: number; compute: number; write: number } };

/** Reads users and friendships, computes the layout, stores it and bumps the galaxy version. */
export function runLayout(db: DatabaseSync): LayoutResult {
  const t0 = performance.now();

  const ids = (db.prepare('SELECT id FROM users ORDER BY created_at, id').all() as { id: number }[]).map((r) => r.id);
  const links = (
    db.prepare('SELECT user_id AS a, friend_id AS b FROM friendships WHERE user_id < friend_id').all() as {
      a: number;
      b: number;
    }[]
  ).map((r) => [r.a, r.b] as [number, number]);
  const previous = new Map<number, [number, number, number]>();
  for (const r of db.prepare('SELECT user_id, x, y, z FROM stars').all() as {
    user_id: number;
    x: number;
    y: number;
    z: number;
  }[]) {
    previous.set(r.user_id, [r.x, r.y, r.z]);
  }
  const t1 = performance.now();

  const stars = computeLayout({ ids, links, previous });
  const t2 = performance.now();

  const upsert = db.prepare(
    `INSERT INTO stars (user_id, x, y, z, color, size) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z,
       color = excluded.color, size = excluded.size`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of stars) upsert.run(s.id, s.x, s.y, s.z, s.color, s.size);
    db.exec('UPDATE meta SET value = value + 1 WHERE key = \'galaxy_version\'');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const version = (db.prepare('SELECT value FROM meta WHERE key = \'galaxy_version\'').get() as { value: number }).value;
  const t3 = performance.now();

  const round = (v: number) => Math.round(v * 10) / 10;
  return { version, stars: stars.length, ms: { read: round(t1 - t0), compute: round(t2 - t1), write: round(t3 - t2) } };
}
