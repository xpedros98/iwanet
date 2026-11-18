import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { lineFragment, lineVertex, starFragment, starVertex } from './shaders';
import { PALETTE } from './util';
import type { FrameUniforms, Glide } from './GalaxyScene';
import type { PointerState } from './Navigation';

// Shared with Picker.tsx so hover tests match what is drawn exactly.
export const STAR_WORLD_SIZE = 0.55; // glow diameter of a size-1 star, in scene units
export const STAR_MIN_PX = 3;
export const STAR_MAX_PX = 56;
const LINE_OPACITY = 0.22;
const HIGHLIGHT_OPACITY = 0.8;

/**
 * Line brightness for a given number of friendships. Lines are additive, so
 * thousands of them at full brightness bury the stars (measured: 3,890 lines
 * at 2,000 users). Full brightness up to ~60 lines, then 1/sqrt, floor 25%.
 */
export const lineOpacity = (links: number) => LINE_OPACITY * Math.min(1, Math.max(0.25, Math.sqrt(60 / Math.max(links, 1))));

/**
 * The user stars (one Points) and friendship lines (one LineSegments).
 * Both geometries use the SAME position, glide-start and colour attributes,
 * so positions exist once on the GPU and lines stay attached to gliding stars.
 *
 * Materials are created once; a live update only builds new geometry
 * (a few typed arrays, uploaded to the GPU once).
 */
export function UserStars({ glide, frame, pointer }: { glide: Glide; frame: FrameUniforms; pointer: PointerState }) {
  const { starMat, lineMat, highMat } = useMemo(() => {
    const starMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: {
        uTime: frame.uTime,
        uPixelRatio: frame.uPixelRatio,
        uScale: frame.uScale,
        uFade: frame.uFade,
        uGlide: frame.uGlide,
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
      uniforms: { uOpacity: { value: 0 }, uGlide: frame.uGlide },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const highMat = new THREE.ShaderMaterial({
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
      uniforms: { uOpacity: { value: HIGHLIGHT_OPACITY }, uGlide: frame.uGlide },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    return { starMat, lineMat, highMat };
  }, [frame]);

  const { stars, lines, high, offsets, neighbours, lineAlpha } = useMemo(() => {
    const { galaxy } = glide;
    const n = galaxy.count;
    const color = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      color.set(PALETTE[galaxy.colors[i]! % PALETTE.length]!, i * 3);
      // Each friend circle breathes together (shared phase), with a small
      // per-star offset from the user id so it looks alive, not mechanical.
      const jitter = ((galaxy.ids[i]! * 2654435761) >>> 0) / 4294967296;
      phase[i] = galaxy.colors[i]! * 2.1 + jitter * 0.6;
    }
    const position = new THREE.BufferAttribute(galaxy.positions, 3);
    const aPrev = new THREE.BufferAttribute(glide.prev, 3);
    const aBorn = new THREE.BufferAttribute(glide.born, 1);
    const aColor = new THREE.BufferAttribute(color, 3);

    const stars = new THREE.BufferGeometry();
    stars.setAttribute('position', position);
    stars.setAttribute('aPrev', aPrev);
    stars.setAttribute('aBorn', aBorn);
    stars.setAttribute('aColor', aColor);
    stars.setAttribute('aSize', new THREE.BufferAttribute(galaxy.sizes, 1));
    stars.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', position); // shared, not copied
    lines.setAttribute('aPrev', aPrev);
    lines.setAttribute('aBorn', aBorn);
    lines.setAttribute('aColor', aColor);
    // 16-bit indexes while they fit (half the memory), else 32-bit.
    const index = n < 65536 ? Uint16Array.from(galaxy.links) : galaxy.links;
    lines.setIndex(new THREE.BufferAttribute(index, 1));
    // Highlight: the friendships of ONE star, drawn bright on top. Adjacency
    // (CSR: offsets + neighbours) is built once per galaxy; on hover change only
    // that star's pairs are written into a small index buffer (degree ≤ 50).
    const L = galaxy.links;
    const offsets = new Uint32Array(n + 1);
    for (let k = 0; k < L.length; k++) offsets[L[k]! + 1]!++;
    for (let i = 0; i < n; i++) offsets[i + 1]! += offsets[i]!;
    const fill = offsets.slice(0, n);
    const neighbours = new Uint32Array(L.length);
    for (let k = 0; k < L.length; k += 2) {
      neighbours[fill[L[k]!]!++] = L[k + 1]!;
      neighbours[fill[L[k + 1]!]!++] = L[k]!;
    }
    let maxDeg = 0;
    for (let i = 0; i < n; i++) maxDeg = Math.max(maxDeg, offsets[i + 1]! - offsets[i]!);
    const high = new THREE.BufferGeometry();
    high.setAttribute('position', position);
    high.setAttribute('aPrev', aPrev);
    high.setAttribute('aBorn', aBorn);
    high.setAttribute('aColor', aColor);
    const highIndex = new THREE.BufferAttribute(n < 65536 ? new Uint16Array(Math.max(2, maxDeg * 2)) : new Uint32Array(Math.max(2, maxDeg * 2)), 1);
    highIndex.setUsage(THREE.DynamicDrawUsage);
    high.setIndex(highIndex);
    high.setDrawRange(0, 0);
    return { stars, lines, high, offsets, neighbours, lineAlpha: lineOpacity(L.length / 2) };
  }, [glide]);

  useEffect(() => () => void (stars.dispose(), lines.dispose(), high.dispose()), [stars, lines, high]);
  useEffect(() => () => void (starMat.dispose(), lineMat.dispose(), highMat.dispose()), [starMat, lineMat, highMat]);
  const highRef = useRef<THREE.LineSegments>(null);
  const shownHigh = useRef(-1);
  useEffect(() => {
    shownHigh.current = -1; // new galaxy: rebuild the highlight on the next frame
  }, [high]);

  useFrame(() => {
    // Lines fade in with the stars; dimmer while a star is highlighted.
    const h = pointer.highlight;
    lineMat.uniforms.uOpacity!.value = lineAlpha * frame.uFade.value * (h >= 0 ? 0.6 : 1);
    highMat.uniforms.uOpacity!.value = HIGHLIGHT_OPACITY * frame.uFade.value;
    if (h === shownHigh.current) return;
    shownHigh.current = h;
    const obj = highRef.current;
    if (!obj) return;
    if (h < 0) {
      obj.visible = false; // no extra draw call when nothing is highlighted
      return;
    }
    const idx = high.index!;
    const arr = idx.array as Uint16Array | Uint32Array;
    let k = 0;
    for (let e = offsets[h]!; e < offsets[h + 1]!; e++) {
      arr[k++] = h;
      arr[k++] = neighbours[e]!;
    }
    idx.clearUpdateRanges();
    idx.addUpdateRange(0, k); // upload only the pairs written
    idx.needsUpdate = true;
    high.setDrawRange(0, k);
    obj.visible = k > 0;
  });

  return (
    <>
      {/* Culling off: always on screen in practice, and positions move in the shader. */}
      <lineSegments name="lines" geometry={lines} material={lineMat} frustumCulled={false} renderOrder={1} />
      <lineSegments ref={highRef} geometry={high} material={highMat} frustumCulled={false} renderOrder={1.5} visible={false} />
      <points name="stars" geometry={stars} material={starMat} frustumCulled={false} renderOrder={2} />
    </>
  );
}
