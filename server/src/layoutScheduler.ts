import { Worker } from 'node:worker_threads';
import type { LayoutResult } from './layoutJob.js';

const DEBOUNCE_MS = 500;

// tsx runs the .ts sources in development; production runs the compiled .js.
const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

let worker: Worker | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let pending = false;
const listeners: ((r: LayoutResult) => void)[] = [];

/** Called after every successful layout run (Step 8 uses it to notify browsers). */
export function onLayoutDone(fn: (r: LayoutResult) => void) {
  listeners.push(fn);
}

/**
 * Asks for a layout recompute. Requests within 500 ms of each other share one
 * run; a request that arrives while a run is in progress triggers exactly one
 * more run afterwards, so the result always includes the latest changes.
 */
export function requestLayout(reason: string) {
  if (running) {
    pending = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    start(reason);
  }, DEBOUNCE_MS);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL(`./layoutWorker.${ext}`, import.meta.url));
  w.unref(); // don't keep the process alive just for this thread
  w.on('error', (err) => {
    console.error('[layout] worker crashed:', err);
    worker = null;
    running = false;
  });
  w.on('message', (msg: { ok: true; result: LayoutResult } | { ok: false; error: string }) => {
    running = false;
    if (msg.ok) {
      const { version, stars, ms } = msg.result;
      console.log(`[layout] v${version}: ${stars} stars in ${ms.read + ms.compute + ms.write} ms (compute ${ms.compute} ms)`);
      for (const fn of listeners) fn(msg.result);
    } else {
      console.error('[layout] failed:', msg.error);
    }
    if (pending) {
      pending = false;
      requestLayout('changes during last run');
    }
  });
  worker = w;
  return w;
}

function start(reason: string) {
  running = true;
  console.log(`[layout] starting (${reason})`);
  getWorker().postMessage('run');
}
