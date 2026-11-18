import { useFrame, useThree } from '@react-three/fiber';
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Galaxy } from '../../api';
import { DevPerf } from '../../dev/Perf';
import { Background } from './Background';
import { Navigation, type NavHandle, type PointerState } from './Navigation';
import { Pacer, createActivity } from './Pacer';
import { Picker } from './Picker';
import { UserStars } from './UserStars';
import { YourStar } from './YourStar';
import { prefersReducedMotion } from './util';

// Separate chunk, downloaded only on the /bench page.
const Bench = lazy(() => import('./Bench'));

const FADE_SECONDS = 0.9;
const GLIDE_SECONDS = 1.6;

/**
 * Values every material reads, shared as the SAME uniform objects: updating
 * them once per frame updates every material, whatever the star count.
 */
export type FrameUniforms = {
  uTime: { value: number };
  uPixelRatio: { value: number };
  uScale: { value: number };
  uFade: { value: number };
  /** Glide progress after a live update, eased, 0 → 1 (1 = at rest). */
  uGlide: { value: number };
  /** 0 with reduced motion, else 1 */
  pulse: number;
  /** quality switches set by the Pacer (Pacer.tsx) */
  quality: { haze: boolean };
  /** Caps a point size (CSS px) to what this GPU can draw at pixel ratio 2. */
  maxPointPx: (css: number) => number;
};

/**
 * Where each star of the current galaxy glides FROM (same order as
 * galaxy.positions). Shown position = mix(prev, positions, uGlide), in the
 * shaders and in the same formula on the CPU (hover, camera follow).
 */
export type Glide = {
  galaxy: Galaxy;
  prev: Float32Array;
  /** 1 for stars that are new in this version (they grow in), else 0. */
  born: Float32Array;
  /** user id → index in this galaxy's arrays */
  index: Map<number, number>;
};

/** Writes the currently shown position of star i into `out`. */
export function shownPosition(glide: Glide, g: number, i: number, out: THREE.Vector3) {
  const p = glide.galaxy.positions, q = glide.prev, k = i * 3;
  return out.set(q[k]! + (p[k]! - q[k]!) * g, q[k + 1]! + (p[k + 1]! - q[k + 1]!) * g, q[k + 2]! + (p[k + 2]! - q[k + 2]!) * g);
}

const DEFAULT_SPIN = { value: 1 };

export function GalaxyScene({
  galaxy,
  userId,
  nav,
  bench = false,
  spin = DEFAULT_SPIN,
}: {
  galaxy: Galaxy;
  userId: number;
  nav: React.Ref<NavHandle>;
  bench?: boolean;
  /** drift speed multiplier, read every frame (0 = no drift) */
  spin?: { value: number };
}) {
  const navRef = useRef<NavHandle | null>(null);
  const pointer = useMemo<PointerState>(() => ({ inside: false, x: 0, dragging: false, hovering: false, highlight: -1 }), []);
  const setNav = (h: NavHandle | null) => {
    navRef.current = h;
    if (typeof nav === 'function') nav(h);
    else if (nav) nav.current = h;
  };
  const onSelect = useCallback((i: number) => navRef.current?.flyTo(i), []);
  const activity = useMemo(createActivity, []);
  const reduced = useMemo(prefersReducedMotion, []);
  // Benchmark: one fixed pixel ratio (?dpr=1.5 etc., default the screen's, capped at 2).
  const fixedDpr = useMemo(
    () => (bench ? Number(new URLSearchParams(location.search).get('dpr')) || Math.min(window.devicePixelRatio || 1, 2) : undefined),
    [bench],
  );
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  const frame = useMemo<FrameUniforms>(() => {
    const ctx = gl.getContext();
    // Largest point sprite this GPU supports, in device pixels (often 1024 on
    // desktop, sometimes much smaller on phones).
    const [, maxDevice] = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    return {
      uTime: { value: 0 },
      uPixelRatio: { value: gl.getPixelRatio() },
      uScale: { value: 1 },
      uFade: { value: 0 },
      uGlide: { value: 1 },
      pulse: prefersReducedMotion() ? 0 : 1,
      quality: { haze: true },
      maxPointPx: (css) => Math.min(css, (maxDevice ?? 64) / 2),
    };
  }, [gl]);

  // ---- live updates: glide from what is on screen now to the new layout ----
  const glideState = useRef({ t: 1 }); // linear progress 0..1
  const lastGlide = useRef<Glide | null>(null);
  const glide = useMemo<Glide>(() => {
    const last = lastGlide.current;
    if (last?.galaxy === galaxy) return last;
    const n = galaxy.count;
    const prev = new Float32Array(galaxy.positions); // default: no movement
    const born = new Float32Array(n);
    const index = new Map<number, number>();
    for (let i = 0; i < n; i++) index.set(galaxy.ids[i]!, i);
    if (last) {
      // Start from where each star is SHOWN right now (also mid-glide).
      const g = frame.uGlide.value;
      const p = last.galaxy.positions, q = last.prev;
      for (let i = 0; i < n; i++) {
        const j = last.index.get(galaxy.ids[i]!);
        if (j === undefined) {
          born[i] = 1; // a new user: grows in at its final position
          continue;
        }
        for (let k = 0; k < 3; k++) prev[i * 3 + k] = q[j * 3 + k]! + (p[j * 3 + k]! - q[j * 3 + k]!) * g;
      }
      glideState.current.t = reduced ? 1 : 0;
      activity.wake(0.2);
      frame.uGlide.value = glideState.current.t;
    }
    const next = { galaxy, prev, born, index };
    lastGlide.current = next;
    return next;
  }, [galaxy, frame, activity, reduced]);

  // Compile every shader before the first visible frame, then start the fade.
  // Only once: live updates reuse the same programs (three.js caches them).
  const fadeStart = useRef(-1);
  useLayoutEffect(() => {
    gl.compile(scene, camera);
    fadeStart.current = -1;
  }, [gl, scene, camera]);

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1); // a background tab must not cause a jump
    frame.uTime.value += delta;
    frame.uPixelRatio.value = state.gl.getPixelRatio();
    const cam = state.camera as THREE.PerspectiveCamera;
    // CSS pixels per world unit at distance 1: size_px = size × uScale / distance
    frame.uScale.value = state.size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));

    if (fadeStart.current < 0) {
      fadeStart.current = frame.uTime.value;
      performance.mark('galaxy-first-frame'); // read by tools/bench.mjs (login → galaxy time)
    }
    const f = Math.min(1, (frame.uTime.value - fadeStart.current) / FADE_SECONDS);
    frame.uFade.value = f * f * (3 - 2 * f); // smoothstep

    const gs = glideState.current;
    if (gs.t < 1) {
      gs.t = Math.min(1, gs.t + delta / GLIDE_SECONDS);
      frame.uGlide.value = gs.t * gs.t * (3 - 2 * gs.t);
    }
    // Fade-in and glides are motion: full frame rate while they run.
    if (f < 1 || gs.t < 1) activity.wake(0.1);
  });

  const mine = glide.index.get(userId) ?? -1;

  return (
    <>
      <color attach="background" args={['#04050a']} />
      <Background shape={galaxy.shape} frame={frame} />
      <UserStars glide={glide} frame={frame} pointer={pointer} />
      {mine >= 0 && <YourStar glide={glide} index={mine} frame={frame} />}
      <Navigation ref={setNav} glide={glide} mine={mine} frame={frame} pointer={pointer} activity={activity} scripted={bench} spin={spin} />
      <Picker glide={glide} frame={frame} onSelect={onSelect} pointer={pointer} activity={activity} />
      <Pacer activity={activity} reduced={reduced} quality={frame.quality} fixedDpr={fixedDpr} />
      {bench && (
        <Suspense fallback={null}>
          <Bench glide={glide} activity={activity} />
        </Suspense>
      )}
      <DevPerf />
    </>
  );
}
