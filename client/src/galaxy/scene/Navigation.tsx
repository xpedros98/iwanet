import { CameraControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, type Ref, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Galaxy } from '../../api';
import { damp, prefersReducedMotion } from './util';

const FLY_SECONDS = 2.5; // a flight settles within this (smoothTime 0.6 → ~1% left after 2 s)
const IDLE_SECONDS = 4; // no interaction for this long → slow drift starts
const DRIFT_RAMP = 3; // seconds to ease the drift in
const DRIFT_SPEED = 0.012; // rad/s ≈ one turn every 9 minutes
const EDGE_SPEED = 0.7; // rad/s at the very edge of the screen
const EDGE_ZONE = 0.08; // fraction of the width, each side

/** Mouse state shared with Picker (it owns the listeners). */
export type PointerState = { inside: boolean; x: number; dragging: boolean; hovering: boolean };
export type NavHandle = { flyTo: (index: number) => void; flyHome: () => void };

/**
 * Camera: drei's CameraControls (camera-controls). Its smoothing is computed
 * from the frame time, so drag, zoom and flights feel the same at 60 and 144 Hz
 * (OrbitControls' damping is per frame, so it is faster on faster screens).
 *
 * Also: the intro flight, click-to-fly, a slow idle drift and turning at the
 * screen edges. All of it is one camera update per frame, nothing else.
 */
export function Navigation({
  galaxy,
  myPos,
  pointer,
  ref,
}: {
  galaxy: Galaxy;
  myPos: [number, number, number] | null;
  pointer: PointerState;
  ref: Ref<NavHandle>;
}) {
  const controls = useRef<ComponentRef<typeof CameraControls>>(null);
  const size = useThree((s) => s.size);
  const R = galaxy.shape.radius;
  const reduced = useMemo(prefersReducedMotion, []);
  const motion = useRef({ lastActivity: 0, flyingUntil: 0, speed: 0 });
  const now = () => performance.now() / 1000;

  // Home view: just outside your star, looking a little toward the centre.
  const home = useMemo(() => {
    if (!myPos) return { pos: [0, R * 1.45, R * 1.25], look: [0, 0, 0] };
    const t = new THREE.Vector3(...myPos);
    const out = new THREE.Vector3(t.x, 0, t.z);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
    out.normalize();
    const pos = t.clone().addScaledVector(out, R * 0.55).add(new THREE.Vector3(0, R * 0.3, 0));
    const look = t.clone().multiplyScalar(0.75);
    return { pos: pos.toArray(), look: look.toArray() };
  }, [myPos, R]);

  const fly = (pos: number[], look: number[]) => {
    const c = controls.current;
    if (!c) return;
    const m = motion.current;
    m.speed = 0; // a rotate() during the flight would cut its rotation short
    m.lastActivity = now();
    m.flyingUntil = m.lastActivity + FLY_SECONDS;
    void c.setLookAt(pos[0]!, pos[1]!, pos[2]!, look[0]!, look[1]!, look[2]!, !reduced);
  };

  useImperativeHandle(ref, () => ({
    flyHome: () => fly(home.pos, home.look),
    // Keep the current viewing direction, come in close to the star.
    flyTo: (i) => {
      const c = controls.current;
      if (!c) return;
      const p = galaxy.positions;
      const star = new THREE.Vector3(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
      const dir = c.getPosition(new THREE.Vector3()).sub(c.getTarget(new THREE.Vector3()));
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1);
      dir.normalize().multiplyScalar(R * 0.2);
      fly(star.clone().add(dir).toArray(), star.toArray());
    },
  }));

  // Intro: the whole galaxy from above, then (after the fade-in) fly home.
  // Touching the controls before that cancels the flight.
  useLayoutEffect(() => {
    const c = controls.current;
    if (!c) return;
    void c.setLookAt(0, R * 1.45, R * 1.25, 0, 0, 0, false);
    if (reduced) {
      void c.setLookAt(...(home.pos as [number, number, number]), ...(home.look as [number, number, number]), false);
      return;
    }
    motion.current.lastActivity = now();
    const timer = setTimeout(() => fly(home.pos, home.look), 1200);
    const onStart = () => {
      clearTimeout(timer);
      motion.current.speed = 0;
      motion.current.lastActivity = now();
    };
    const onActivity = () => (motion.current.lastActivity = now());
    c.addEventListener('controlstart', onStart);
    c.addEventListener('control', onActivity);
    return () => {
      clearTimeout(timer);
      c.removeEventListener('controlstart', onStart);
      c.removeEventListener('control', onActivity);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galaxy, home]);

  // Edge turning and idle drift. Runs after CameraControls' own update (priority -1).
  useFrame((_, rawDelta) => {
    const c = controls.current;
    if (!c || reduced) return;
    const delta = Math.min(rawDelta, 0.1);
    const m = motion.current;
    const t = now();
    if (t < m.flyingUntil) return;

    let target = 0;
    if (pointer.inside && !pointer.dragging) {
      const zone = Math.max(40, size.width * EDGE_ZONE);
      if (pointer.x < zone) target = -EDGE_SPEED * ((zone - pointer.x) / zone) ** 2;
      else if (pointer.x > size.width - zone) target = EDGE_SPEED * ((pointer.x - (size.width - zone)) / zone) ** 2;
    }
    if (target !== 0) m.lastActivity = t;
    else if (!pointer.hovering && t - m.lastActivity > IDLE_SECONDS)
      target = DRIFT_SPEED * Math.min(1, (t - m.lastActivity - IDLE_SECONDS) / DRIFT_RAMP);

    m.speed += (target - m.speed) * damp(5, delta); // ease speed changes over ~0.2 s
    if (Math.abs(m.speed) > 1e-5) void c.rotate(m.speed * delta, 0, false);
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.6}
      draggingSmoothTime={0.12}
      minDistance={0.4}
      maxDistance={R * 4}
      dollyToCursor
    />
  );
}
