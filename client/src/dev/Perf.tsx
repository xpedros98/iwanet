import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';

/**
 * Development-only overlay: frame rate, frame time (average and worst in the
 * last half second), draw calls and points drawn. Built on three.js's own
 * renderer counters, with no dependency (r3f-perf was removed: it still
 * pulls in React 18 and fiber 8, which broke the app with two Reacts).
 *
 * Vite replaces import.meta.env.DEV with a constant, so in production this is
 * `() => null` and the code below is dropped from the bundle.
 */
export const DevPerf = import.meta.env.DEV ? PerfOverlay : () => null;

function PerfOverlay() {
  const gl = useThree((s) => s.gl);
  const el = useRef<HTMLDivElement | null>(null);
  const acc = useRef({ frames: 0, sum: 0, worst: 0, since: 0 });

  useEffect(() => {
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;right:8px;bottom:8px;padding:4px 8px;font:12px/1.4 ui-monospace,monospace;' +
      'color:#9fe0b0;background:rgba(0,0,0,.6);border-radius:4px;pointer-events:none;white-space:pre;z-index:10';
    document.body.appendChild(div);
    el.current = div;
    return () => div.remove();
  }, []);

  // Runs before each render; gl.info still holds the previous frame's counts.
  useFrame((state, delta) => {
    const a = acc.current;
    a.frames++;
    a.sum += delta;
    a.worst = Math.max(a.worst, delta);
    const now = state.clock.elapsedTime;
    if (now - a.since < 0.5 || !el.current) return;
    const { calls, points, lines, triangles } = gl.info.render;
    el.current.textContent =
      `${Math.round(a.frames / (now - a.since))} fps · ${((a.sum / a.frames) * 1000).toFixed(1)} ms avg · ` +
      `${(a.worst * 1000).toFixed(1)} ms worst\n${calls} draws · ${points} pts · ${lines} lines · ${triangles} tris`;
    a.frames = 0;
    a.sum = 0;
    a.worst = 0;
    a.since = now;
  });

  return null;
}
