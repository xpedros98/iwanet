/**
 * npm run layout   Recomputes all star positions now and prints quality checks.
 */
import { all, pool } from './db.js';
import { runLayout } from './layoutJob.js';
import { galaxyRadius } from './layout.js';

const r = await runLayout();
console.log(`layout v${r.version}: ${r.stars} stars`);
console.log(`time   read ${r.ms.read} ms · compute ${r.ms.compute} ms · write ${r.ms.write} ms`);

// ---- quality checks -------------------------------------------------------
type Star = { id: number; x: number; y: number; z: number; color: number };
const stars = await all<Star>('SELECT user_id AS id, x, y, z, color FROM stars ORDER BY user_id');
const byId = new Map(stars.map((s) => [s.id, s]));
const dist = (a: Star, b: Star) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// 1. Friends should be much closer to each other than random pairs.
const links = await all<{ a: number; b: number }>(
  'SELECT user_id AS a, friend_id AS b FROM friendships WHERE user_id < friend_id',
);
const friendAvg = links.reduce((s, l) => s + dist(byId.get(l.a)!, byId.get(l.b)!), 0) / Math.max(1, links.length);
let randSum = 0;
const samples = Math.min(20_000, (stars.length * (stars.length - 1)) / 2);
for (let k = 0; k < samples; k++) {
  const a = stars[(k * 7919) % stars.length]!, b = stars[(k * 104729 + 1) % stars.length]!;
  randSum += a === b ? 0 : dist(a, b);
}
const randAvg = randSum / samples;

// 2. Join order should run from the centre outwards (the spiral).
const order = (await all<{ id: number }>('SELECT id FROM users ORDER BY created_at, id')).map((u) => u.id);
const radii = order.map((id) => Math.hypot(byId.get(id)!.x, byId.get(id)!.z));
const ranks = order.map((_, i) => i);
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const corr = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db2 = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db2 += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db2 || 1);
};

// 3. Flatness: vertical spread vs. size of the disc.
const ySpread = Math.sqrt(mean(stars.map((s) => s.y * s.y)));

console.log(`
radius            ${galaxyRadius(stars.length).toFixed(1)} units (outermost star at ${Math.max(...radii).toFixed(1)})
friend circles    ${new Set(stars.map((s) => s.color)).size}
friend distance   ${friendAvg.toFixed(2)} vs random pair ${randAvg.toFixed(2)}  (ratio ${(friendAvg / randAvg).toFixed(2)}, lower = tighter circles)
join → radius     correlation ${corr(ranks, radii).toFixed(2)}  (1 = perfect centre-to-edge order)
disc thickness    ${ySpread.toFixed(2)} units RMS height`);

await pool.end();
