import { Canvas } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { getGalaxy, watchGalaxyVersion, type Galaxy, type User } from '../api';
import { GalaxyScene } from './scene/GalaxyScene';
import type { NavHandle } from './scene/Navigation';
import './galaxy.css';

type Props = { user: User; onLogout: () => void; bench?: boolean };

export default function GalaxyPage({ user, onLogout, bench = false }: Props) {
  const [galaxy, setGalaxy] = useState<Galaxy | null>(null);
  const [error, setError] = useState('');
  const nav = useRef<NavHandle | null>(null);

  // Load the galaxy, then keep it current: the server announces each new
  // version, and we fetch only when it is newer than what we show.
  useEffect(() => {
    let shown = -1; // version on screen
    let wanted = -1; // newest version announced
    let loading = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      loading = true;
      getGalaxy()
        .then((g) => {
          if (stopped) return;
          shown = g.version;
          setGalaxy(g);
          setError('');
        })
        .catch((err: Error) => !stopped && setError(err.message))
        .finally(() => {
          loading = false;
          if (!stopped && wanted > shown) schedule(); // announced while we were loading
        });
    };
    // Random 0–300 ms delay: when many browsers are told at the same moment,
    // their requests spread out instead of arriving together.
    const schedule = () => {
      if (loading || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        load();
      }, Math.random() * 300);
    };

    load();
    const unwatch = watchGalaxyVersion((v) => {
      wanted = Math.max(wanted, v);
      if (v > shown) schedule();
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      unwatch();
    };
  }, []);

  return (
    <div className="galaxy">
      <Canvas
        dpr={[1, 2]} // start value; Pacer.tsx adapts it (never above 2: a ratio of 3 shades 2.25× the pixels of 2)
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ fov: 55, near: 0.05, far: 500 }}
        // Frames are driven by scene/Pacer.tsx: full rate while something moves,
        // 60 per second (even on faster screens) when only the breathing and slow drift remain.
        frameloop="never"
      >
        {galaxy && <GalaxyScene galaxy={galaxy} userId={user.id} nav={nav} bench={bench} />}
      </Canvas>

      <div className="galaxy-user">
        <span className="galaxy-name">{user.username}</span>
        <button type="button" onClick={() => nav.current?.flyHome()}>
          My star
        </button>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </div>

      {error && <p className="galaxy-error">Couldn't load the galaxy: {error}</p>}
    </div>
  );
}
