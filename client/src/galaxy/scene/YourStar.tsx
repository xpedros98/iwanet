import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { ringFragment, ringVertex } from './shaders';
import type { FrameUniforms } from './GalaxyScene';

const RING_PX = 34; // CSS pixels, constant on screen so you can always spot yourself

/** A thin pulsing ring around your own star: one point, one draw call. */
export function YourStar({ position, frame }: { position: [number, number, number]; frame: FrameUniforms }) {
  const { geometry, material } = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position), 3));
    const material = new THREE.ShaderMaterial({
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      uniforms: {
        uTime: frame.uTime,
        uPixelRatio: frame.uPixelRatio,
        uFade: frame.uFade,
        uPx: { value: frame.maxPointPx(RING_PX) },
      },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    return { geometry, material };
  }, [position, frame]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}
