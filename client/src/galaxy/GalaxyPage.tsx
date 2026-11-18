import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGalaxy, watchGalaxyVersion, type Galaxy, type User } from '../api';
import { GalaxyScene } from './scene/GalaxyScene';
import type { NavHandle } from './scene/Navigation';
import { HelpPanel } from './HelpPanel';
import './galaxy.css';

type Props = { user: User; onLogout: () => void; bench?: boolean };

// Rotation slider: 0–100, squared so the slow end has fine control.
// 25 = 1× (the default drift), 100 = 16×, 0 = stopped.
const SPIN_KEY = 'galaxy.spin';
const SPIN_DEFAULT = 25;
const spinMultiplier = (v: number) => (v / SPIN_DEFAULT) ** 2;
// The help panel opens by itself on the first visit only.
const HELP_SEEN_KEY = 'galaxy.helpSeen';
function firstVisit(): boolean {
  try {
    return localStorage.getItem(HELP_SEEN_KEY) === null;
  } catch {
    return false;
  }
}

function savedSpin(): number {
  try {
    const v = Number(localStorage.getItem(SPIN_KEY));
    return localStorage.getItem(SPIN_KEY) !== null && v >= 0 && v <= 100 ? v : SPIN_DEFAULT;
  } catch {
    return SPIN_DEFAULT;
  }
}

export default function GalaxyPage({ user, onLogout, bench = false }: Props) {
  const [galaxy, setGalaxy] = useState<Galaxy | null>(null);
  const [error, setError] = useState('');
  const nav = useRef<NavHandle | null>(null);
  const [spinValue, setSpinValue] = useState(savedSpin);
  const [helpOpen, setHelpOpen] = useState(() => !bench && firstVisit());
  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    try {
      localStorage.setItem(HELP_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);
  // Read every frame by Navigation; a plain object, so moving the slider doesn't re-render the scene.
  const spin = useMemo(() => ({ value: spinMultiplier(spinValue) }), []); // eslint-disable-line react-hooks/exhaustive-deps
  spin.value = spinMultiplier(spinValue);
  const changeSpin = (v: number) => {
    setSpinValue(v);
    try {
      localStorage.setItem(SPIN_KEY, String(v));
    } catch {
      /* storage blocked: the setting just isn't remembered */
    }
  };

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
        {galaxy && <GalaxyScene galaxy={galaxy} userId={user.id} nav={nav} bench={bench} spin={spin} />}
      </Canvas>

      <div className="galaxy-user">
        <span className="galaxy-name">{user.username}</span>
        <button type="button" onClick={() => nav.current?.flyHome()}>
          My star
        </button>
        <label className="galaxy-spin">
          Rotation
          <input
            type="range"
            min={0}
            max={100}
            value={spinValue}
            aria-valuetext={`${spinMultiplier(spinValue).toFixed(1)}× speed`}
            onChange={(e) => changeSpin(Number(e.target.value))}
            onDoubleClick={() => changeSpin(SPIN_DEFAULT)}
            title="Double-click to reset"
          />
        </label>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
        <button
          type="button"
          className="galaxy-help-btn"
          onClick={() => (helpOpen ? closeHelp() : setHelpOpen(true))}
          aria-expanded={helpOpen}
          aria-label="How to move around"
          title="How to move around"
        >
          ?
        </button>
      </div>

      {helpOpen && <HelpPanel onClose={closeHelp} />}

      {error && <p className="galaxy-error">Couldn't load the galaxy: {error}</p>}
    </div>
  );
}
