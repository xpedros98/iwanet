// Runs in a worker thread (started by layoutScheduler.ts), so the layout never
// blocks the main thread that answers requests. Importing db.ts here opens a
// separate SQLite connection for this thread; WAL lets both work at once.
import { parentPort } from 'node:worker_threads';
import { db } from './db.js';
import { runLayout } from './layoutJob.js';

parentPort!.on('message', () => {
  try {
    parentPort!.postMessage({ ok: true, result: runLayout(db) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.stack : String(err) });
  }
});
