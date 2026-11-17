import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Galaxy } from '../../api';
import { lineFragment, lineVertex, starFragment, starVertex } from './shaders';
import { PALETTE } from './util';
import type { FrameUniforms } from './GalaxyScene';

// Shared with Picker.tsx so hover tests match what is drawn exactly.
export const STAR_WORLD_SIZE = 0.55; // glow diameter of a size-1 star, in scene units
export const STAR_MIN_PX = 3;
export const STAR_MAX_PX = 56;
const LINE_OPACITY = 0.22;

/**
 * The user stars (one Points) and friendship lines (one LineSegments).
 * Both geometries use the SAME position and colour BufferAttributes, so the
 * positions exist once on the GPU and the lines always end exactly on the
 * stars. Lines are an index buffer into those positions (the `links` pairs).
 */
export function UserStars({ galaxy, frame }: { galaxy: Galaxy; frame: FrameUniforms }) {
  const { stars, lines, starMat, lineMat } = useMemo(() => {
    const n = galaxy.count;
    const color = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      color.set(PALETTE[galaxy.colors[i]! % PALETTE.length]!, i * 3);
      phase[i] = ((galaxy.ids[i]! * 2654435761) >>> 0) / 4294967296 * Math.PI * 2; // from the user id
    }
    const position = new THREE.BufferAttribute(galaxy.positions, 3);
    const aColor = new THREE.BufferAttribute(color, 3);

    const stars = new THREE.BufferGeometry();
    stars.setAttribute('position', position);
    stars.setAttribute('aColor', aColor);
    stars.setAttribute('aSize', new THREE.BufferAttribute(galaxy.sizes, 1));
    stars.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', position); // shared, not copied
    lines.setAttribute('aColor', aColor);
    // 16-bit indexes while they fit (half the memory), else 32-bit.
    const index = n < 65536 ? Uint16Array.from(galaxy.links) : galaxy.links;
    lines.setIndex(new THREE.BufferAttribute(index, 1));

    const starMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: {
        uTime: frame.uTime,
        uPixelRatio: frame.uPixelRatio,
        uScale: frame.uScale,
        uFade: frame.uFade,
        uBaseSize: { value: STAR_WORLD_SIZE },
        uMinPx: { value: STAR_MIN_PX },
        uMaxPx: { value: frame.maxPointPx(STAR_MAX_PX) },
        uPulse: { value: frame.pulse },
      },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const lineMat = new THREE.ShaderMaterial({
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
      uniforms: { uOpacity: { value: 0 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    return { stars, lines, starMat, lineMat };
  }, [galaxy, frame]);

  useEffect(
    () => () => {
      stars.dispose();
      lines.dispose();
      starMat.dispose();
      lineMat.dispose();
    },
    [stars, lines, starMat, lineMat],
  );

  // Lines fade in with the stars.
  useFrame(() => {
    lineMat.uniforms.uOpacity!.value = LINE_OPACITY * frame.uFade.value;
  });

  return (
    <>
      {/* Culling off: always on screen in practice, and Step 8 moves stars in the shader. */}
      <lineSegments geometry={lines} material={lineMat} frustumCulled={false} renderOrder={1} />
      <points geometry={stars} material={starMat} frustumCulled={false} renderOrder={2} />
    </>
  );
}
