import { Router, type Request, type RequestHandler } from 'express';
import { users, isUniqueViolation } from './db.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './password.js';
import { announceVersion, requestLayout } from './layoutScheduler.js';
import { placeNewcomer } from './layoutJob.js';

declare module 'express-session' {
  interface SessionData {
    userId: number;
  }
}

/** Called with the session id on logout (live.ts closes that session's streams). */
export const logoutHooks: ((sessionId: string) => void)[] = [];

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
// Minimum 4 so the seeded test accounts (password "test") work. Raise before going public.
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 128;

function readCredentials(req: Request): { username: string; password: string } | string {
  const { username, password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'Username and password are required';
  }
  const name = username.trim();
  if (!USERNAME_RE.test(name)) {
    return 'Username must be 3–20 characters: letters, numbers, _ . -';
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`;
  }
  return { username: name, password };
}

/** New session id on every login, so a session id set before login can't be reused. */
function startSession(req: Request, userId: number): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    }),
  );
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session.userId == null) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  next();
};

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const creds = readCredentials(req);
  if (typeof creds === 'string') {
    res.status(400).json({ error: creds });
    return;
  }
  const hash = await hashPassword(creds.password);
  let id: number;
  try {
    id = await users.insert(creds.username, hash);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'That username is taken' });
      return;
    }
    throw err;
  }
  await startSession(req, id);
  // Visible to everyone at once, at its seed position; the full layout (worker
  // thread, the response doesn't wait for it) then settles it among the others.
  const version = await placeNewcomer(id);
  if (version !== null) announceVersion(version);
  requestLayout('new user');
  res.status(201).json({ id, username: creds.username });
});

authRouter.post('/login', async (req, res) => {
  const creds = readCredentials(req);
  if (typeof creds === 'string') {
    res.status(400).json({ error: creds });
    return;
  }
  const user = await users.byName(creds.username);
  // Always run one scrypt, so the response time doesn't reveal whether the user exists.
  const ok = await verifyPassword(creds.password, user?.hash ?? DUMMY_HASH);
  if (!user || !ok) {
    res.status(401).json({ error: 'Wrong username or password' });
    return;
  }
  await startSession(req, user.id);
  res.json({ id: user.id, username: user.username });
});

authRouter.post('/logout', (req, res, next) => {
  const sid = req.sessionID;
  req.session.destroy((err) => {
    if (err) return next(err);
    for (const hook of logoutHooks) hook(sid);
    res.clearCookie('sid');
    res.status(204).end();
  });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await users.byId(req.session.userId!);
  if (!user) {
    // The account was deleted (for example by a database reset) while the cookie lived on.
    req.session.destroy(() => res.status(401).json({ error: 'Not logged in' }));
    return;
  }
  res.json(user);
});
