import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { ringFragment, ringVertex } from './shaders';
import type { FrameUniforms, Glide } from './GalaxyScene';

const RING_PX = 34; // CSS pixels, constant on screen so you can always spot yourself

/** A thin pulsing ring around your own star: one point, one draw call. Glides with it. */
export function YourStar({ glide, index, frame }: { glide: Glide; index: number; frame: FrameUniforms }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: ringVertex,
        fragmentShader: ringFragment,
        uniforms: {
          uTime: frame.uTime,
          uPixelRatio: frame.uPixelRatio,
          uFade: frame.uFade,
          uGlide: frame.uGlide,
          uPx: { value: frame.maxPointPx(RING_PX) },
        },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    [frame],
  );

  const geometry = useMemo(() => {
    const k = index * 3;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(glide.galaxy.positions.slice(k, k + 3), 3));
    geometry.setAttribute('aPrev', new THREE.BufferAttribute(glide.prev.slice(k, k + 3), 3));
    return geometry;
  }, [glide, index]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  return <points name="your-star" geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}
