import { lazy, Suspense, useEffect, useState } from 'react';
import { getMe, logout, type User } from './api';
import { LoginPage } from './login/LoginPage';

// The galaxy (three.js, React Three Fiber) is a separate chunk. It is only
// downloaded after login, or in idle time while the login page is open.
const loadGalaxy = () => import('./galaxy/GalaxyPage');
const GalaxyPage = lazy(loadGalaxy);

export function App() {
  // undefined = still asking the server, null = logged out
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return null; // one quick request; a blank white page is fine

  if (user === null) return <LoginPage onLoggedIn={setUser} prefetch={loadGalaxy} />;

  return (
    <Suspense fallback={<div className="galaxy-loading" />}>
      <GalaxyPage
        user={user}
        bench={location.pathname === '/bench'} // the benchmark flight (scene/Bench.tsx)
        onLogout={async () => {
          await logout().catch(() => {});
          setUser(null);
        }}
      />
    </Suspense>
  );
}
