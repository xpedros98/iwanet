import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { GalaxyShape } from '../../api';
import { starFragment, starVertex } from './shaders';
import { damp, gauss, seededRandom } from './util';
import type { FrameUniforms } from './GalaxyScene';

const BG_STARS = 5000;
const HAZE_TEXTURE = 256; // pixels per side; small on purpose (see the cost table)

/**
 * Decorative galaxy: ~5,000 faint stars along the same spiral arms as the
 * users, plus one soft haze layer on the disc. Not clickable. Generated once
 * from a fixed seed, so it looks the same on every visit.
 *
 * Two draw calls: the points reuse the user-star shader (same GLSL, so three.js
 * compiles it once), and the haze is one textured square (switched off by the
 * Pacer on the lowest quality levels).
 */
export function Background({ shape, frame }: { shape: GalaxyShape; frame: FrameUniforms }) {
  // Built ONCE at the first radius. When the galaxy grows (radius ∝ cube root
  // of the user count), the group is scaled instead: no rebuild, no 15 ms haze
  // repaint during a live update.
  const [R0] = useState(shape.radius);
  const group = useRef<THREE.Group>(null);
  const hazeMesh = useRef<THREE.Mesh>(null);
  const hazeShown = useRef(true);
  const { arms, turns } = shape;
  const { points, pointMat, haze, hazeMat, hazeTex } = useMemo(() => {
    const R = R0;
    const rnd = seededRandom(42);

    // ---- faint stars ----------------------------------------------------
    const pos = new Float32Array(BG_STARS * 3);
    const col = new Float32Array(BG_STARS * 3);
    const size = new Float32Array(BG_STARS);
    const phase = new Float32Array(BG_STARS);
    for (let i = 0; i < BG_STARS; i++) {
      let x: number, y: number, z: number;
      if (i < BG_STARS * 0.2) {
        // central bulge
        const r = Math.abs(gauss(rnd)) * R * 0.18;
        const a = rnd() * Math.PI * 2;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = gauss(rnd) * R * 0.05;
      } else {
        // along an arm, same formula as the server's spiral seed
        const arm = i % arms;
        const t = rnd() ** 0.8;
        const a = (arm / arms) * Math.PI * 2 + t * turns * Math.PI * 2 + gauss(rnd) * 0.22;
        const r = R * (0.12 + 0.88 * t) * (1 + gauss(rnd) * 0.1);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = gauss(rnd) * R * 0.025;
      }
      pos.set([x, y, z], i * 3);
      // mostly bluish white, some warmer; dim
      const warm = rnd();
      const b = 0.25 + rnd() * 0.35;
      col.set([b * (0.75 + 0.3 * warm), b * (0.8 + 0.1 * warm), b * (1.0 - 0.25 * warm)], i * 3);
      size[i] = 0.4 + rnd() * 0.6;
      phase[i] = rnd() * Math.PI * 2;
    }
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    points.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    points.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    points.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const pointMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: {
        uTime: frame.uTime,
        uPixelRatio: frame.uPixelRatio,
        uScale: frame.uScale,
        uFade: frame.uFade,
        uBaseSize: { value: 0.12 },
        uMinPx: { value: 1.5 },
        uMaxPx: { value: frame.maxPointPx(6) },
        uPulse: { value: frame.pulse * 0.6 },
        uGlide: { value: 1 }, // background never glides
      },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });

    // ---- haze -------------------------------------------------------------
    const hazeTex = makeHazeTexture({ radius: R, arms, turns });
    const haze = new THREE.PlaneGeometry(R * 2.4, R * 2.4);
    haze.rotateX(-Math.PI / 2); // lie flat on the disc
    const hazeMat = new THREE.MeshBasicMaterial({
      map: hazeTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      opacity: 0,
    });
    return { points, pointMat, haze, hazeMat, hazeTex };
  }, [R0, arms, turns, frame]);

  useEffect(
    () => () => {
      points.dispose();
      pointMat.dispose();
      haze.dispose();
      hazeMat.dispose();
      hazeTex.dispose();
    },
    [points, pointMat, haze, hazeMat, hazeTex],
  );

  // The haze fades in with everything else (MeshBasicMaterial has no uFade uniform).
  useFrame((_, delta) => {
    hazeMat.opacity = 0.55 * frame.uFade.value;
    // Off on the lowest quality levels: no draw call, no full-screen pass.
    // Written only on change, so the benchmark's ?hide=haze is not overridden.
    if (hazeMesh.current && hazeShown.current !== frame.quality.haze) {
      hazeShown.current = frame.quality.haze;
      hazeMesh.current.visible = hazeShown.current;
    }
    const g = group.current;
    if (!g) return;
    const target = shape.radius / R0;
    if (Math.abs(g.scale.x - target) > 1e-4) g.scale.setScalar(g.scale.x + (target - g.scale.x) * damp(2, Math.min(delta, 0.1)));
  });

  return (
    <group ref={group}>
      <mesh ref={hazeMesh} name="haze" geometry={haze} material={hazeMat} frustumCulled={false} renderOrder={0} />
      <points name="background" geometry={points} material={pointMat} frustumCulled={false} renderOrder={0} />
    </group>
  );
}

/**
 * Paints the disc haze once on the CPU (256×256 pixels): a warm core plus soft
 * bluish arms that follow the spiral formula. Measured 13–17 ms on a desktop
 * CPU, once at load before the first frame; never per frame.
 */
function makeHazeTexture({ arms, turns }: GalaxyShape): THREE.CanvasTexture {
  const N = HAZE_TEXTURE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const rnd = seededRandom(7);
  const EXTENT = 1.2; // the square covers ±1.2 galaxy radii

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const x = ((px + 0.5) / N * 2 - 1) * EXTENT;
      const z = ((py + 0.5) / N * 2 - 1) * EXTENT;
      const r = Math.hypot(x, z);
      const angle = Math.atan2(z, x);

      let armDensity = 0;
      const t = (r - 0.12) / 0.88;
      if (t > -0.15 && t < 1.15) {
        for (let k = 0; k < arms; k++) {
          const expected = (k / arms) * Math.PI * 2 + t * turns * Math.PI * 2;
          let d = angle - expected;
          d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to ±π
          armDensity += Math.exp(-(d * d) / (2 * 0.32 * 0.32));
        }
      }
      const fadeOut = Math.max(0, Math.min(1, (1.1 - r) / 0.5)); // soft outer edge
      // Everything fades to pure black by r = 1.05, well inside the square
      // (±1.2): no grey can reach its edges, which showed as a faint square
      // when zoomed out. Starts at r = 0.45, so the outer glow is darker too.
      const e = Math.max(0, Math.min(1, (1.05 - r) / 0.6));
      const vignette = e * e * (3 - 2 * e);
      const core = Math.exp(-(r * r) / 0.012);
      const disc = Math.exp(-r * 2.8) * 0.25 * vignette;
      const arm = armDensity * 0.3 * fadeOut * vignette * Math.min(1, r / 0.15);
      const grain = 0.85 + rnd() * 0.3;

      const i = (py * N + px) * 4;
      // floor(): values below one step become 0 (true black), never a faint 1/255 grey
      img.data[i] = Math.min(255, Math.floor(255 * (core * 1.0 + disc * 0.7 + arm * 0.55) * grain));
      img.data[i + 1] = Math.min(255, Math.floor(255 * (core * 0.85 + disc * 0.7 + arm * 0.65) * grain));
      img.data[i + 2] = Math.min(255, Math.floor(255 * (core * 0.65 + disc * 0.9 + arm * 1.0) * grain));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
