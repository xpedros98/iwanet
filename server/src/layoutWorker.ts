// Runs in a worker thread (started by layoutScheduler.ts), so the layout's
// computation never blocks the main thread that answers requests. Importing
// db.ts here opens a separate connection pool for this thread.
import { parentPort } from 'node:worker_threads';
import { runLayout } from './layoutJob.js';

parentPort!.on('message', async () => {
  try {
    parentPort!.postMessage({ ok: true, result: await runLayout() });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.stack : String(err) });
  }
});
