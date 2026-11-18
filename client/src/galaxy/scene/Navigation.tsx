import { CameraControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { shownPosition, type FrameUniforms, type Glide } from './GalaxyScene';
import { damp, prefersReducedMotion } from './util';
import type { Activity } from './Pacer';

const FLY_SECONDS = 2.5; // a flight settles within this (smoothTime 0.6 → ~1% left after 2 s)
const IDLE_SECONDS = 0.1; // after a drag, the slow drift eases back in this soon (longer looks like a freeze)
const FLING_DECAY = 1.8; // 1/s: momentum after a drag halves every ~0.4 s
const FLING_MAX = 3; // rad/s: a very fast flick doesn't spin wildly
const FLING_MIN = 0.02; // rad/s: below this the momentum is over
const DRIFT_RAMP = 3; // seconds to ease the drift in
const DRIFT_SPEED = 0.012; // rad/s ≈ one turn every 9 minutes
const EDGE_SPEED = 0.7; // rad/s at the very edge of the screen
const EDGE_ZONE = 0.08; // fraction of the width, each side
const HOVER_DRIFT = 0.5; // drift keeps going while a star is hovered, at half speed (the star stays under the cursor for a few seconds)

/** Mouse state shared with Picker (it owns the listeners). */
export type PointerState = {
  inside: boolean;
  x: number;
  dragging: boolean;
  hovering: boolean;
  /** star whose friendships are highlighted (hovered, else selected), or -1 */
  highlight: number;
};
export type NavHandle = { flyTo: (index: number) => void; flyHome: () => void };

/**
 * Camera: drei's CameraControls (camera-controls). Its smoothing is computed
 * from the frame time, so drag, zoom and flights feel the same at 60 and 144 Hz
 * (OrbitControls' damping is per frame, so it is faster on faster screens).
 *
 * Also: the intro flight, click-to-fly, a slow idle drift, turning at the
 * screen edges, and following the focused star while it glides after a live
 * update. All of it is at most one camera update per frame.
 */
export function Navigation({
  glide,
  mine,
  frame,
  pointer,
  activity,
  scripted = false,
  ref,
}: {
  glide: Glide;
  /** index of your star, or -1 if it has no position yet */
  mine: number;
  frame: FrameUniforms;
  pointer: PointerState;
  activity: Activity;
  /** the benchmark drives the camera: no intro, drift, edge turning or follow */
  scripted?: boolean;
  ref: Ref<NavHandle>;
}) {
  const controls = useRef<ComponentRef<typeof CameraControls>>(null);
  const size = useThree((s) => s.size);
  const R = glide.galaxy.shape.radius;
  const reduced = useMemo(prefersReducedMotion, []);
  const motion = useRef({
    lastActivity: 0,
    flyingUntil: 0,
    speed: 0,
    // Momentum: angular velocity measured while dragging (rad/s), carried on after release.
    vel: { az: 0, polar: 0 },
    fling: { az: 0, polar: 0 },
    prev: { az: 0, polar: 0, dragging: false },
  });
  const now = () => performance.now() / 1000;

  // The star the camera is looking at (user id), followed while stars glide.
  const focus = useRef<{ id: number; last: THREE.Vector3; valid: boolean }>({ id: -1, last: new THREE.Vector3(), valid: false });
  const tmp = useMemo(() => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), c: new THREE.Vector3(), e: new THREE.Vector3() }), []);

  /** Home view: just outside your star, looking a little toward the centre. */
  const homeView = () => {
    if (mine < 0) return { pos: [0, R * 1.45, R * 1.25], look: [0, 0, 0] };
    const t = shownPosition(glide, frame.uGlide.value, mine, new THREE.Vector3());
    const out = new THREE.Vector3(t.x, 0, t.z);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
    out.normalize();
    const pos = t.clone().addScaledVector(out, R * 0.55).add(new THREE.Vector3(0, R * 0.3, 0));
    return { pos: pos.toArray(), look: t.clone().multiplyScalar(0.75).toArray() };
  };

  /** driftAfter: the drift resumes as soon as the flight lands (no idle pause). */
  const fly = (pos: number[], look: number[], focusIndex: number, driftAfter = false) => {
    const c = controls.current;
    if (!c) return;
    const m = motion.current;
    m.speed = 0; // a rotate() during the flight would cut its rotation short
    m.fling.az = m.fling.polar = 0;
    m.flyingUntil = now() + FLY_SECONDS;
    m.lastActivity = driftAfter ? m.flyingUntil - IDLE_SECONDS : now();
    activity.wake(FLY_SECONDS);
    focus.current.id = focusIndex >= 0 ? glide.galaxy.ids[focusIndex]! : -1;
    focus.current.valid = false;
    void c.setLookAt(pos[0]!, pos[1]!, pos[2]!, look[0]!, look[1]!, look[2]!, !reduced);
  };

  const flyHome = (driftAfter = false) => {
    const h = homeView();
    fly(h.pos, h.look, mine, driftAfter);
  };

  useImperativeHandle(ref, () => ({
    flyHome: () => flyHome(),
    // Keep the current viewing direction, come in close to the star.
    flyTo: (i) => {
      const c = controls.current;
      if (!c) return;
      const star = shownPosition(glide, frame.uGlide.value, i, new THREE.Vector3());
      const dir = c.getPosition(new THREE.Vector3()).sub(c.getTarget(new THREE.Vector3()));
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1);
      dir.normalize().multiplyScalar(R * 0.2);
      fly(star.clone().add(dir).toArray(), star.toArray(), i);
    },
  }));

  // Intro, once: the whole galaxy from above, then (after the fade-in) fly
  // home. Touching the controls before that cancels the flight.
  const introDone = useRef(false);
  useLayoutEffect(() => {
    const c = controls.current;
    if (!c) return;
    void c.setLookAt(0, R * 1.45, R * 1.25, 0, 0, 0, false);
    // Start "already idle", so the drift eases in from the very first frame.
    motion.current.lastActivity = now() - IDLE_SECONDS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (scripted) introDone.current = true;
    else if (mine >= 0) {
      introDone.current = true;
      if (reduced) {
        const h = homeView();
        void c.setLookAt(h.pos[0]!, h.pos[1]!, h.pos[2]!, h.look[0]!, h.look[1]!, h.look[2]!, false);
        focus.current.id = glide.galaxy.ids[mine]!;
      } else timer = setTimeout(() => flyHome(true), 1200);
    }
    const onStart = () => {
      activity.wake(0.5);
      clearTimeout(timer);
      motion.current.speed = 0;
      motion.current.fling.az = motion.current.fling.polar = 0; // grabbing stops the spin
      motion.current.lastActivity = now();
    };
    // 'control' fires for drags AND for the mouse wheel (the wheel sends no
    // 'controlstart'). Only a drag pauses the drift: zooming is not steering.
    const onActivity = () => {
      if (pointer.dragging) motion.current.lastActivity = now();
      activity.wake(0.5);
    };
    c.addEventListener('controlstart', onStart);
    c.addEventListener('control', onActivity);
    return () => {
      clearTimeout(timer);
      c.removeEventListener('controlstart', onStart);
      c.removeEventListener('control', onActivity);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A user who has just registered has no star until the layout runs (~1 s).
  // When it appears in a live update, fly to it once.
  useEffect(() => {
    if (mine >= 0 && !introDone.current) {
      introDone.current = true;
      setTimeout(() => flyHome(true), 600); // let the birth animation start first
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine]);

  // Runs after CameraControls' own update (priority -1).
  useFrame((_, rawDelta) => {
    const c = controls.current;
    if (!c || scripted) return;
    const delta = Math.min(rawDelta, 0.1);
    const m = motion.current;
    const t = now();

    // Still smoothing toward where the user sent it (zoom, drag inertia,
    // flight)? Then full frame rate. The drift never counts: it rotates with
    // no transition, so the camera is always AT its end position.
    const eps = (R * 1e-4) ** 2;
    if (
      c.getPosition(tmp.c, false).distanceToSquared(c.getPosition(tmp.e, true)) > eps ||
      c.getTarget(tmp.c, false).distanceToSquared(c.getTarget(tmp.e, true)) > eps
    )
      activity.wake(0.15);

    // Follow the focused star while it glides: shift camera and target by
    // the star's movement this frame, so it stays where it is on screen.
    const f = focus.current;
    const i = f.id >= 0 ? glide.index.get(f.id) : undefined;
    if (i !== undefined) {
      shownPosition(glide, frame.uGlide.value, i, tmp.p);
      if (f.valid && t >= m.flyingUntil && !tmp.p.equals(f.last)) {
        tmp.c.subVectors(tmp.p, f.last);
        c.getPosition(tmp.t).add(tmp.c);
        const px = tmp.t.x, py = tmp.t.y, pz = tmp.t.z;
        c.getTarget(tmp.t).add(tmp.c);
        void c.setLookAt(px, py, pz, tmp.t.x, tmp.t.y, tmp.t.z, false);
      }
      f.last.copy(tmp.p);
      f.valid = true;
    }

    // ---- momentum: measure the drag's angular speed; keep it going after release
    const az = c.azimuthAngle, polar = c.polarAngle;
    if (pointer.dragging && delta > 0) {
      const k = damp(20, delta); // average over the last ~50 ms of the drag
      m.vel.az += ((az - m.prev.az) / delta - m.vel.az) * k;
      m.vel.polar += ((polar - m.prev.polar) / delta - m.vel.polar) * k;
    } else if (m.prev.dragging && !reduced) {
      const clamp = (v: number) => Math.max(-FLING_MAX, Math.min(FLING_MAX, v));
      m.fling.az = clamp(m.vel.az);
      m.fling.polar = clamp(m.vel.polar);
      m.vel.az = m.vel.polar = 0;
    }
    m.prev.az = az;
    m.prev.polar = polar;
    m.prev.dragging = pointer.dragging;

    if (reduced || t < m.flyingUntil) return;
    let target = 0;
    if (pointer.inside && !pointer.dragging) {
      const zone = Math.max(40, size.width * EDGE_ZONE);
      if (pointer.x < zone) target = -EDGE_SPEED * ((zone - pointer.x) / zone) ** 2;
      else if (pointer.x > size.width - zone) target = EDGE_SPEED * ((pointer.x - (size.width - zone)) / zone) ** 2;
    }
    if (target !== 0) {
      m.lastActivity = t;
      activity.wake(0.2); // edge turning is fast enough to need full frame rate
    }
    else if (t - m.lastActivity > IDLE_SECONDS)
      target = DRIFT_SPEED * Math.min(1, (t - m.lastActivity - IDLE_SECONDS) / DRIFT_RAMP) * (pointer.hovering ? HOVER_DRIFT : 1);

    m.speed += (target - m.speed) * damp(5, delta); // ease speed changes over ~0.2 s
    // Faster than the drift (edge turning, or easing out of it): full frame rate.
    if (Math.abs(m.speed) > DRIFT_SPEED * 1.01) activity.wake(0.15);
    let flingAz = 0, flingPolar = 0;
    if (!pointer.dragging && Math.hypot(m.fling.az, m.fling.polar) > FLING_MIN) {
      flingAz = m.fling.az;
      flingPolar = m.fling.polar;
      const decay = Math.exp(-FLING_DECAY * delta);
      m.fling.az *= decay;
      m.fling.polar *= decay;
      activity.wake(0.15);
    }
    const turn = (m.speed + flingAz) * delta;
    // camera-controls: positive polar rotate moves the camera down (polar angle grows).
    // Never while dragging: a rotate without transition would cut the drag's own smoothing short.
    if (!pointer.dragging && (Math.abs(turn) > 1e-7 || flingPolar !== 0)) void c.rotate(turn, flingPolar * delta, false);
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.6}
      draggingSmoothTime={0.05} // low: the camera follows the hand closely (higher feels like input lag)
      minDistance={0.4}
      maxDistance={R * 4}
      dollyToCursor
    />
  );
}
