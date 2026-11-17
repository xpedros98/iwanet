import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Galaxy } from '../../api';
import { DevPerf } from '../../dev/Perf';
import { Background } from './Background';
import { UserStars } from './UserStars';
import { YourStar } from './YourStar';
import { prefersReducedMotion } from './util';
import { Navigation, type NavHandle, type PointerState } from './Navigation';
import { Picker } from './Picker';

const FADE_SECONDS = 0.9;

/**
 * Values every material reads, shared as the SAME uniform objects: updating
 * them once per frame updates every material, whatever the star count.
 */
export type FrameUniforms = {
  uTime: { value: number };
  uPixelRatio: { value: number };
  uScale: { value: number };
  uFade: { value: number };
  /** 0 with reduced motion, else 1 */
  pulse: number;
  /** Caps a point size (CSS px) to what this GPU can draw at pixel ratio 2. */
  maxPointPx: (css: number) => number;
};

export function GalaxyScene({ galaxy, userId, nav }: { galaxy: Galaxy; userId: number; nav: React.Ref<NavHandle> }) {
  const navRef = useRef<NavHandle | null>(null);
  const pointer = useMemo<PointerState>(() => ({ inside: false, x: 0, dragging: false, hovering: false }), []);
  const setNav = (h: NavHandle | null) => {
    navRef.current = h;
    if (typeof nav === 'function') nav(h);
    else if (nav) nav.current = h;
  };
  const onSelect = useCallback((i: number) => navRef.current?.flyTo(i), []);
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
      pulse: prefersReducedMotion() ? 0 : 1,
      maxPointPx: (css) => Math.min(css, (maxDevice ?? 64) / 2),
    };
  }, [gl]);

  // Compile every shader before the first visible frame, then start the fade.
  // Without this, the first frame that uses a new material stalls while the
  // GPU driver compiles it.
  const fadeStart = useRef(-1);
  useLayoutEffect(() => {
    gl.compile(scene, camera);
    fadeStart.current = -1; // set on the next frame, after compilation
  }, [gl, scene, camera, galaxy]);

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1); // a background tab must not cause a jump
    frame.uTime.value += delta;
    frame.uPixelRatio.value = state.gl.getPixelRatio();
    const cam = state.camera as THREE.PerspectiveCamera;
    // CSS pixels per world unit at distance 1: size_px = size × uScale / distance
    frame.uScale.value = state.size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));

    if (fadeStart.current < 0) fadeStart.current = frame.uTime.value;
    const t = Math.min(1, (frame.uTime.value - fadeStart.current) / FADE_SECONDS);
    frame.uFade.value = t * t * (3 - 2 * t); // smoothstep
  });

  const mine = galaxy.ids.indexOf(userId);
  const myPos = useMemo<[number, number, number] | null>(
    () => (mine >= 0 ? [galaxy.positions[mine * 3]!, galaxy.positions[mine * 3 + 1]!, galaxy.positions[mine * 3 + 2]!] : null),
    [galaxy, mine],
  );

  return (
    <>
      <color attach="background" args={['#04050a']} />
      <Background shape={galaxy.shape} frame={frame} />
      <UserStars galaxy={galaxy} frame={frame} />
      {myPos && <YourStar position={myPos} frame={frame} />}
      <Navigation ref={setNav} galaxy={galaxy} myPos={myPos} pointer={pointer} />
      <Picker galaxy={galaxy} frame={frame} onSelect={onSelect} pointer={pointer} />
      <DevPerf />
    </>
  );
}

