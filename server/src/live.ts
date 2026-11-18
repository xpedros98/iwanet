import { Router, type Response } from 'express';
import { one, GALAXY_VERSION_SQL } from './db.js';
import { logoutHooks, requireAuth } from './auth.js';
import { onGalaxyVersion } from './layoutScheduler.js';

/**
 * GET /api/live: Server-Sent Events. The server only ever says one thing,
 * "the galaxy is now version N", and the browser then fetches /api/galaxy
 * (built once per version and shared by everyone, see galaxy.ts).
 *
 * Why SSE instead of Socket.IO: the messages only go one way, and the
 * browser's built-in EventSource reconnects by itself and sends the session
 * cookie, so this needs no library on either side.
 *
 * Cost per open connection: one idle socket and one entry in a Set. A layout
 * change costs one small write per connection (~30 bytes).
 */
export const liveRouter = Router();

const clients = new Map<Response, string>(); // stream → session id
const HEARTBEAT_MS = 25_000; // keeps proxies and load balancers from closing idle streams

const message = (version: number) => `event: version\ndata: ${version}\n\n`;

liveRouter.get('/live', requireAuth, async (req, res) => {
  // Read before opening the stream, so a database error still gets a normal 500.
  const { value } = (await one<{ value: number }>(GALAXY_VERSION_SQL))!;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    // no-transform: the compression middleware skips it (gzip would buffer the stream)
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // same, for nginx if one is ever put in front
  });
  // retry: reconnect after 3 s if the connection drops. Then send the current
  // version right away, so a reconnecting browser catches up on what it missed.
  res.write(`retry: 3000\n${message(value)}`);
  clients.set(res, req.sessionID);
  req.on('close', () => clients.delete(res));
});

onGalaxyVersion((version) => {
  const msg = message(version);
  for (const res of clients.keys()) res.write(msg);
});

setInterval(() => {
  for (const res of clients.keys()) res.write(': ping\n\n'); // a comment line, ignored by EventSource
}, HEARTBEAT_MS).unref();

// On logout, end that session's streams so a logged-out tab stops receiving.
logoutHooks.push((sessionId) => {
  for (const [res, sid] of clients) if (sid === sessionId) res.end();
});

export const liveClientCount = () => clients.size;
