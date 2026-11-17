import { Router } from 'express';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { ARMS, TURNS, galaxyRadius } from './layout.js';

/**
 * GET /api/galaxy: the whole galaxy in one response, as parallel arrays.
 *
 *   shape  { radius, arms, turns } of the spiral (for the decorative background)
 *   ids    user id per star            names  username per star
 *   pos    x, y, z per star (flat)     color  friend-circle index per star
 *   size   star size per star          links  friendships as pairs of
 *                                              star INDEXES (not user ids)
 *
 * Links use indexes into the arrays so the client can build line buffers
 * directly, without a map from user id to position. Each friendship appears
 * once. Users who have just registered appear after the next layout run
 * (Step 4), usually within a second.
 */
export const galaxyRouter = Router();

const q = {
  version: db.prepare("SELECT value FROM meta WHERE key = 'galaxy_version'"),
  stars: db.prepare(
    `SELECT s.user_id AS id, u.username AS name, s.x, s.y, s.z, s.color, s.size
     FROM stars s JOIN users u ON u.id = s.user_id
     ORDER BY s.user_id`,
  ),
  links: db.prepare(
    `SELECT f.user_id AS a, f.friend_id AS b
     FROM friendships f
     JOIN stars sa ON sa.user_id = f.user_id
     JOIN stars sb ON sb.user_id = f.friend_id
     WHERE f.user_id < f.friend_id`,
  ),
};

type StarRow = { id: number; name: string; x: number; y: number; z: number; color: number; size: number };

// The serialized body for the current version. Every visitor gets the same
// galaxy, so it is built once per layout run and reused for every request.
let cache: { version: number; body: string } | null = null;

function currentVersion(): number {
  return (q.version.get() as { value: number }).value;
}

function build(): { version: number; body: string } {
  // One read transaction, so the version and the rows come from the same snapshot
  // even if the layout worker commits a new run in between.
  db.exec('BEGIN');
  try {
    const version = currentVersion();
    const stars = q.stars.all() as StarRow[];
    const links = q.links.all() as { a: number; b: number }[];

    const index = new Map<number, number>();
    const ids: number[] = [], names: string[] = [], pos: number[] = [], color: number[] = [], size: number[] = [];
    stars.forEach((s, i) => {
      index.set(s.id, i);
      ids.push(s.id);
      names.push(s.name);
      pos.push(s.x, s.y, s.z);
      color.push(s.color);
      size.push(s.size);
    });
    const linkIdx: number[] = [];
    for (const l of links) linkIdx.push(index.get(l.a)!, index.get(l.b)!);

    // The spiral's shape, so the client's decorative background follows the same arms.
    const shape = { radius: Math.round(galaxyRadius(ids.length) * 100) / 100, arms: ARMS, turns: TURNS };
    return { version, body: JSON.stringify({ version, shape, ids, names, pos, color, size, links: linkIdx }) };
  } finally {
    db.exec('COMMIT');
  }
}

galaxyRouter.get('/galaxy', requireAuth, (req, res) => {
  const version = currentVersion();
  // Logged-in content: browsers may cache it but must revalidate every time.
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', `"galaxy-${version}"`);
  // Unchanged since the browser's copy → empty 304, no database reads at all.
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  if (!cache || cache.version !== version) cache = build();
  // If the layout committed between the two reads, label the body with its real version.
  if (cache.version !== version) res.set('ETag', `"galaxy-${cache.version}"`);
  res.type('json').send(cache.body);
});
