import express from 'express';
import session from 'express-session';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { SqliteStore } from './sessionStore.js';
import { authRouter } from './auth.js';
import { requestLayout } from './layoutScheduler.js';
import { galaxyRouter } from './galaxy.js';
import compression from 'compression';

const PORT = Number(process.env.PORT ?? 3001);
const isProd = process.env.NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET ?? (isProd ? undefined : 'dev-only-secret');
if (!SESSION_SECRET) throw new Error('Set SESSION_SECRET in production');

const app = express();
app.disable('x-powered-by');
// In production the app is expected to sit behind an HTTPS proxy (host, load
// balancer). Trusting the first proxy makes req.secure reflect the original
// request, so the session cookie gets its Secure flag.
if (isProd) app.set('trust proxy', 1);
// gzip responses over 1 KB (the galaxy JSON, and in production the JS bundles).
app.use(compression());
app.use(express.json({ limit: '10kb' }));

export const sessionMiddleware = session({
  name: 'sid',
  secret: SESSION_SECRET,
  store: new SqliteStore(db),
  resave: false,
  saveUninitialized: false, // no cookie or DB row until someone logs in
  rolling: true, // re-send the cookie on each response: 30 days from last visit, not from login
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto', // Secure flag whenever the request came over HTTPS
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
});
app.use('/api', sessionMiddleware);

// --- API -------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.use('/api', authRouter);
app.use('/api', galaxyRouter);

// Unknown /api routes return JSON 404 instead of falling through to the SPA.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// --- Built client (production only) ---------------------------------------
// In development the browser talks to Vite (port 5173), which proxies /api here.
if (isProd) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(here, '../../client/dist');

  // Hashed assets never change for a given file name: cache them for a year.
  app.use(
    '/assets',
    express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '1y' }),
  );
  // Everything else (index.html, favicon) must be revalidated on every visit.
  app.use(express.static(clientDist, { maxAge: 0 }));
  // Single-page app: any other GET returns index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// JSON errors instead of Express's HTML error page. Keeps 4xx from body parsing
// (malformed JSON, body too large); anything else is logged and becomes a 500.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: 'Bad request' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// A plain HTTP server, so Socket.IO can attach to the same port later (Step 8).
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (${isProd ? 'production' : 'development'})`);
  // Users without a star (for example right after "npm run reset") get one now.
  const { missing } = db
    .prepare('SELECT count(*) AS missing FROM users WHERE id NOT IN (SELECT user_id FROM stars)')
    .get() as { missing: number };
  if (missing > 0) requestLayout(`${missing} users without a star`);
});
