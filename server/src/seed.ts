/**
 * Fills the database with generated test users and friendships.
 *
 *   npm run seed                      20 users (refuses if users already exist)
 *   npm run seed -- --users 2000      another size (2,000 = the design limit, for performance tests)
 *   npm run reset                     empty all tables, then seed
 *   npm run reset -- --users 100000
 *
 * Every account's password is "test". A "demo" account is always user 1.
 * Output is deterministic: the same --users and --seed give the same data,
 * so benchmarks are comparable between runs.
 */
import { statSync } from 'node:fs';
import { db, DB_PATH } from './db.js';
import { hashPassword } from './password.js';

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const N = Number(arg('users') ?? 20);
const SEED = Number(arg('seed') ?? 1);
const RESET = args.includes('--reset');

if (!Number.isInteger(N) || N < 1 || N > 2_000_000) {
  console.error('--users must be an integer between 1 and 2,000,000');
  process.exit(1);
}

// ---------------------------------------------------------- tuning constants
// Two profiles: a small community (up to 2,000 users, the design limit: circles
// of close friends) and a large one for load testing beyond it.
const SMALL = N <= 2_000;
const YEARS = 2; // join dates spread over this many years, ending now
const WINDOW = SMALL ? 50 : 2_000; // friend groups form among users who joined close together
const GROUP_MIN = SMALL ? 4 : 20;
const GROUP_MAX = SMALL ? 7 : 200;
const DEGREE_MIN = SMALL ? 2 : 5; // target friends per user, log-uniform between these
const DEGREE_MAX = SMALL ? 6 : 50;
const IN_GROUP = 0.8; // share of friendships made inside the user's group
const ATTEMPTS = 20; // tries to find a valid partner before giving up on that edge

// ------------------------------------------- deterministic random (mulberry32)
let s = SEED >>> 0;
function rand(): number {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const t0 = performance.now();
const lap = (label: string) => console.log(`${label.padEnd(34)} ${((performance.now() - t0) / 1000).toFixed(2)} s`);

// ------------------------------------------------------------ reset / guard
const existing = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
if (existing > 0 && !RESET) {
  console.error(`The database already has ${existing} users. Use "npm run reset" to start over.`);
  process.exit(1);
}

// Bulk load: data is generated consistently, so skip per-row foreign key checks,
// and skip fsync (if this crashes, just run it again).
db.exec('PRAGMA foreign_keys = OFF; PRAGMA synchronous = OFF;');

if (RESET) {
  // Emptying tables (instead of deleting the file) also works while the dev
  // server has the database open, which Windows wouldn't allow for a delete.
  db.exec(`
    BEGIN;
    DELETE FROM friendships;
    DELETE FROM stars;
    DELETE FROM sessions;
    DELETE FROM users;
    DELETE FROM sqlite_sequence WHERE name = 'users';
    COMMIT;
  `);
  // Deleted rows leave free pages behind; VACUUM gives the space back.
  // It rewrites the database, which is instant now that the tables are empty.
  db.exec('VACUUM');
  lap(`reset (removed ${existing} users)`);
}

// ------------------------------------------------------------------ users
const ADJ = ['Bright', 'Quiet', 'Swift', 'Cosmic', 'Silver', 'Golden', 'Lunar', 'Solar', 'Stellar', 'Crimson',
  'Azure', 'Amber', 'Misty', 'Frosty', 'Wild', 'Calm', 'Bold', 'Lucky', 'Happy', 'Brave', 'Gentle', 'Shiny',
  'Velvet', 'Rapid', 'Hidden', 'Polar', 'Rusty', 'Sunny', 'Stormy', 'Noble'];
const NOUN = ['Comet', 'Nova', 'Orbit', 'Pulsar', 'Quasar', 'Nebula', 'Meteor', 'Galaxy', 'Aurora', 'Photon',
  'Vega', 'Sirius', 'Atlas', 'Lyra', 'Orion', 'Rigel', 'Halo', 'Zenith', 'Ember', 'Falcon', 'Fox', 'Otter',
  'Raven', 'Wolf', 'Lynx', 'Heron', 'Cedar', 'River', 'Pixel', 'Echo'];

const hash = await hashPassword('test'); // one hash shared by all test accounts
const now = Math.floor(Date.now() / 1000);
const span = YEARS * 365 * 24 * 3600;

// Join times grow like (t/T)^2: few early users, more and more over time.
// Index i joins at T·sqrt(i/N); user 0 ("demo") is the very first.
const insertUser = db.prepare('INSERT INTO users (id, username, hash, created_at) VALUES (?, ?, ?, ?)');
db.exec('BEGIN');
for (let i = 0; i < N; i++) {
  const name = i === 0 ? 'demo' : `${ADJ[randInt(0, ADJ.length - 1)]}${NOUN[randInt(0, NOUN.length - 1)]}${i}`;
  const t = now - span + Math.floor(span * Math.sqrt(i / N));
  insertUser.run(i + 1, name, hash, t);
}
db.exec('COMMIT');
lap(`users (${N.toLocaleString('en')})`);

// ----------------------------------------------------------- friend groups
// Groups are cut from windows of users who joined close together (people tend
// to join in waves with their friends), shuffled inside each window.
const groupOf = new Int32Array(N);
const groups: Int32Array[] = [];
for (let start = 0; start < N; start += WINDOW) {
  const end = Math.min(N, start + WINDOW);
  const idx = Array.from({ length: end - start }, (_, k) => start + k);
  for (let k = idx.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [idx[k], idx[j]] = [idx[j]!, idx[k]!];
  }
  for (let p = 0; p < idx.length; ) {
    let size = randInt(GROUP_MIN, GROUP_MAX);
    if (idx.length - (p + size) < GROUP_MIN) size = idx.length - p; // no tiny leftover group
    const members = Int32Array.from(idx.slice(p, p + size));
    for (const m of members) groupOf[m] = groups.length;
    groups.push(members);
    p += size;
  }
}

// ------------------------------------------------------------- friendships
// Each user gets a target degree, log-uniform in [5, 50] (many users with few
// friends, a few with many). Users are visited in order and add friends until
// they reach their target; nobody goes above 50. Without the per-partner target
// check below, popular early users soak up edges and pile up at the cap.
const target = new Uint8Array(N);
for (let i = 0; i < N; i++) target[i] = Math.round(DEGREE_MIN * (DEGREE_MAX / DEGREE_MIN) ** rand());
const degree = new Uint16Array(N);
const seen = new Set<number>(); // undirected edge keys: min * N + max
const edges: number[] = []; // flat pairs [a, b, a, b, ...]

for (let u = 0; u < N; u++) {
  const group = groups[groupOf[u]!]!;
  let fails = 0;
  while (degree[u]! < target[u]! && fails < ATTEMPTS) {
    const v = rand() < IN_GROUP ? group[Math.floor(rand() * group.length)]! : Math.floor(rand() * N);
    const key = u < v ? u * N + v : v * N + u;
    // Prefer partners still below their own target; after half the attempts,
    // accept anyone below the hard cap so u can still reach its target.
    const cap = fails < ATTEMPTS / 2 ? target[v]! : DEGREE_MAX;
    if (v === u || degree[v]! >= cap || seen.has(key)) {
      fails++;
      continue;
    }
    seen.add(key);
    edges.push(u, v);
    degree[u]!++;
    degree[v]!++;
  }
}
lap(`friendships generated (${(edges.length / 2).toLocaleString('en')})`);

// Store both directions, so "friends of X" is a range scan on the primary key.
// Insert in primary-key order: the WITHOUT ROWID table is a B-tree keyed by
// (user_id, friend_id), and sorted inserts only ever append to it.
const directed = new Float64Array(edges.length); // key = a * N + b
for (let k = 0; k < edges.length; k += 2) {
  const a = edges[k]!, b = edges[k + 1]!;
  directed[k] = a * N + b;
  directed[k + 1] = b * N + a;
}
directed.sort();

const insertFriend = db.prepare('INSERT INTO friendships (user_id, friend_id) VALUES (?, ?)');
db.exec('BEGIN');
for (const key of directed) {
  insertFriend.run(Math.floor(key / N) + 1, (key % N) + 1);
}
db.exec('COMMIT');
lap(`friendships stored (${directed.length.toLocaleString('en')} rows)`);

// --------------------------------------------------------------- summary
db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA wal_checkpoint(TRUNCATE); ANALYZE;');

const sorted = Array.from(degree).sort((a, b) => a - b);
const pct = (q: number) => sorted[Math.min(N - 1, Math.floor(q * N))];
const mean = sorted.reduce((a, b) => a + b, 0) / N;
const sizes = groups.map((g) => g.length);
const mb = (statSync(DB_PATH).size / 1024 / 1024).toFixed(1);

console.log(`
users          ${N.toLocaleString('en')}   (login: demo / test, or any user / test)
groups         ${groups.length.toLocaleString('en')}   size ${Math.min(...sizes)}–${Math.max(...sizes)}
friends/user   min ${pct(0)}  median ${pct(0.5)}  mean ${mean.toFixed(1)}  p95 ${pct(0.95)}  max ${pct(1 - 1 / N)}
database       ${DB_PATH}  (${mb} MB)`);
lap('done');
