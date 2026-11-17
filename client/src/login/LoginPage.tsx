import { useEffect, useState, type FormEvent } from 'react';
import { login, register, type User } from '../api';
import './login.css';

type Mode = 'login' | 'register';

type Props = {
  onLoggedIn: (user: User) => void;
  /** Starts downloading the galaxy code in idle time. */
  prefetch: () => Promise<unknown>;
};

export function LoginPage({ onLoggedIn, prefetch }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Fetch the galaxy chunk once the login page is idle, so the switch after
  // login is instant without making this page slower to appear.
  useEffect(() => {
    const run = () => void prefetch().catch(() => {});
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(run, { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 1500); // Safari has no requestIdleCallback
    return () => clearTimeout(id);
  }, [prefetch]);

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setConfirm('');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const user = mode === 'login' ? await login(username, password) : await register(username, password);
      onLoggedIn(user);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <h1>Galaxy</h1>

        <div className="login-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => switchMode('login')}
          >
            Log in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            onClick={() => switchMode('register')}
          >
            Register
          </button>
        </div>

        <label>
          Username
          <input
            name="username"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {mode === 'register' && (
          <label>
            Confirm password
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}

        <p className="login-error" role="alert">
          {error}
        </p>

        <button className="login-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </main>
  );
}
