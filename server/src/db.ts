import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/galaxy.db by default (works from both src/ and dist/).
export const DB_PATH = process.env.DB_PATH ?? path.resolve(here, '../galaxy.db');

export const db = new DatabaseSync(DB_PATH);

// WAL: readers never block the writer and vice versa.
// synchronous=NORMAL is safe with WAL (no corruption on crash; at worst the
// last few commits are lost on power failure) and avoids an fsync per commit.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    hash       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, friend_id)
  ) WITHOUT ROWID;

  -- One row per user, written by the layout job (layout.ts).
  -- color = friend-circle index, mapped to a palette by the client.
  CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    color INTEGER NOT NULL,
    size  REAL    NOT NULL
  );

  -- Small key/value table; galaxy_version increases on every layout run.
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) WITHOUT ROWID;
  INSERT OR IGNORE INTO meta (key, value) VALUES ('galaxy_version', 0);

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT    PRIMARY KEY,
    sess    TEXT    NOT NULL,
    expires INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
`);

// Migration for databases created before the small-scale redesign: the old
// stars table had a `tile` column (and an index on it) that is no longer used.
const starCols = db.prepare('PRAGMA table_info(stars)').all() as { name: string }[];
if (starCols.some((c) => c.name === 'tile')) {
  db.exec('DROP INDEX IF EXISTS stars_tile; ALTER TABLE stars DROP COLUMN tile;');
}

export type UserRow ={ id: number; username: string; hash: string };

// Prepared once, reused for every request.
export const users = {
  byName: db.prepare('SELECT id, username, hash FROM users WHERE username = ?'),
  byId: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  insert: db.prepare('INSERT INTO users (username, hash) VALUES (?, ?)'),
};

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}
