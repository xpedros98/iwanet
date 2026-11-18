import { Router } from 'express';
import { all, one, tx, GALAXY_VERSION_SQL } from './db.js';
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

const STARS_SQL = `SELECT s.user_id AS id, u.username AS name, s.x, s.y, s.z, s.color, s.size
  FROM stars s JOIN users u ON u.id = s.user_id
  ORDER BY s.user_id`;
const LINKS_SQL = `SELECT f.user_id AS a, f.friend_id AS b
  FROM friendships f
  JOIN stars sa ON sa.user_id = f.user_id
  JOIN stars sb ON sb.user_id = f.friend_id
  WHERE f.user_id < f.friend_id`;

type StarRow = { id: number; name: string; x: number; y: number; z: number; color: number; size: number };

// The serialized body for the current version. Every visitor gets the same
// galaxy, so it is built once per layout run and reused for every request.
let cache: { version: number; body: string } | null = null;
// A build in progress, shared by requests that arrive while it runs.
let building: Promise<{ version: number; body: string }> | null = null;

async function currentVersion(): Promise<number> {
  return (await one<{ value: number }>(GALAXY_VERSION_SQL))!.value;
}

function build(): Promise<{ version: number; body: string }> {
  // One snapshot (REPEATABLE READ), so the version and the rows match even if
  // the layout worker commits a new run in between.
  return tx(async (c) => {
    const version = (await one<{ value: number }>(GALAXY_VERSION_SQL, [], c))!.value;
    const stars = await all<StarRow>(STARS_SQL, [], c);
    const links = await all<{ a: number; b: number }>(LINKS_SQL, [], c);

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
  }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

galaxyRouter.get('/galaxy', requireAuth, async (req, res) => {
  const version = await currentVersion();
  // Logged-in content: browsers may cache it but must revalidate every time.
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', `"galaxy-${version}"`);
  // Unchanged since the browser's copy → empty 304, no further database reads.
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  if (!cache || cache.version < version) {
    building ??= build().finally(() => (building = null));
    const built = await building;
    if (!cache || built.version > cache.version) cache = built;
  }
  // If the layout committed between the two reads, label the body with its real version.
  if (cache.version !== version) res.set('ETag', `"galaxy-${cache.version}"`);
  res.type('json').send(cache.body);
});
