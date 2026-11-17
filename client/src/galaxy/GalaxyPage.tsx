import { Canvas } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { getGalaxy, type Galaxy, type User } from '../api';
import { GalaxyScene } from './scene/GalaxyScene';
import type { NavHandle } from './scene/Navigation';
import './galaxy.css';

type Props = { user: User; onLogout: () => void };

export default function GalaxyPage({ user, onLogout }: Props) {
  const [galaxy, setGalaxy] = useState<Galaxy | null>(null);
  const [error, setError] = useState('');
  const nav = useRef<NavHandle | null>(null);

  useEffect(() => {
    getGalaxy()
      .then(setGalaxy)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="galaxy">
      <Canvas
        dpr={[1, 2]} // never above 2: a ratio of 3 shades 2.25× the pixels of 2
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ fov: 55, near: 0.05, far: 500 }}
        // Continuous for now: stars pulse. Step 9 drops idle frames to ~20 per second.
        frameloop="always"
      >
        {galaxy && <GalaxyScene galaxy={galaxy} userId={user.id} nav={nav} />}
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
