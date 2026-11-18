import { all, one, tx, BUMP_VERSION_SQL } from './db.js';
import { armFor, computeLayout, galaxyRadius, seedPosition } from './layout.js';

export type LayoutResult = { version: number; stars: number; ms: { read: number; compute: number; write: number } };

/** Reads users and friendships, computes the layout, stores it and bumps the galaxy version. */
export async function runLayout(): Promise<LayoutResult> {
  const t0 = performance.now();

  const [userRows, linkRows, starRows] = await Promise.all([
    all<{ id: number }>('SELECT id FROM users ORDER BY created_at, id'),
    all<{ a: number; b: number }>('SELECT user_id AS a, friend_id AS b FROM friendships WHERE user_id < friend_id'),
    all<{ user_id: number; x: number; y: number; z: number }>('SELECT user_id, x, y, z FROM stars'),
  ]);
  const ids = userRows.map((r) => r.id);
  const links = linkRows.map((r) => [r.a, r.b] as [number, number]);
  const previous = new Map<number, [number, number, number]>();
  for (const r of starRows) previous.set(r.user_id, [r.x, r.y, r.z]);
  const t1 = performance.now();

  const stars = computeLayout({ ids, links, previous });
  const t2 = performance.now();

  // One statement for all stars (arrays unpacked server-side): a round trip per
  // row would take seconds over the network.
  const version = await tx(async (c) => {
    await c.query(
      `INSERT INTO stars (user_id, x, y, z, color, size)
       SELECT * FROM unnest($1::int[], $2::float8[], $3::float8[], $4::float8[], $5::int[], $6::float8[])
       ON CONFLICT (user_id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z,
         color = excluded.color, size = excluded.size`,
      [
        stars.map((s) => s.id),
        stars.map((s) => s.x),
        stars.map((s) => s.y),
        stars.map((s) => s.z),
        stars.map((s) => s.color),
        stars.map((s) => s.size),
      ],
    );
    return (await one<{ value: number }>(BUMP_VERSION_SQL, [], c))!.value;
  });
  const t3 = performance.now();

  const round = (v: number) => Math.round(v * 10) / 10;
  return { version, stars: stars.length, ms: { read: round(t1 - t0), compute: round(t2 - t1), write: round(t3 - t2) } };
}

/**
 * Places a just-registered user's star AT ONCE, without the full layout
 * (0.55–0.9 s at 2,000 users, plus the scheduler's 500 ms batching), so other
 * people see it within a few hundred milliseconds. Returns the new galaxy
 * version, or null if the star already existed.
 *
 * The position is exactly the seed the layout would give this user: no
 * friends yet, so a circle of its own, at the outer end (t ≈ 1) of its arm.
 * The full layout that follows starts from there and only nudges it (the
 * browsers glide it). Colour: the next circle number, which is what the
 * layout assigns a newest one-person circle.
 */
export async function placeNewcomer(id: number): Promise<number | null> {
  const [{ n }, { next }] = (await Promise.all([
    one<{ n: number }>('SELECT count(*) AS n FROM users'),
    one<{ next: number }>('SELECT coalesce(max(color) + 1, 0) AS next FROM stars'),
  ])) as [{ n: number }, { next: number }];
  const t = (n - 0.5) / n; // the newest user
  const [x, y, z] = seedPosition(id, t, armFor(id), galaxyRadius(n));
  const round = (v: number) => Math.round(v * 100) / 100;
  return tx(async (c) => {
    const { rowCount } = await c.query(
      `INSERT INTO stars (user_id, x, y, z, color, size) VALUES ($1, $2, $3, $4, $5, 0.8)
       ON CONFLICT (user_id) DO NOTHING`,
      [id, round(x), round(y), round(z), next],
    );
    if (!rowCount) return null;
    return (await one<{ value: number }>(BUMP_VERSION_SQL, [], c))!.value;
  });
}
