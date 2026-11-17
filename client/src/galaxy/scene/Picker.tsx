import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Galaxy } from '../../api';
import type { FrameUniforms } from './GalaxyScene';
import type { PointerState } from './Navigation';
import { STAR_MAX_PX, STAR_MIN_PX, STAR_WORLD_SIZE } from './UserStars';

const CLICK_MOVE_PX = 6; // more movement than this between press and release = a drag, not a click
const CLICK_MS = 500;
const MOUSE_RADIUS = 10; // minimum hit radius in CSS px (small stars stay easy to hit)
const TOUCH_RADIUS = 22; // fingers are less precise

/**
 * Hover and click on user stars, in screen space.
 *
 * Each star is projected to the screen and tested against the size it is
 * actually drawn at (the same formula as the star shader). three.js's Points
 * raycast uses a fixed world-space size instead, which does not match stars
 * whose on-screen size is clamped in pixels.
 *
 * Cost: one loop over the stars (about 20 multiply-adds each, no allocation),
 * only on frames where the mouse is over the canvas, plus once per click.
 *
 * The name label is a plain DOM element moved with a CSS transform: no React
 * re-render per frame, and text is only rewritten when the star changes.
 */
export function Picker({
  galaxy,
  frame,
  onSelect,
  pointer,
}: {
  galaxy: Galaxy;
  frame: FrameUniforms;
  onSelect: (index: number) => void;
  pointer: PointerState;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const st = useRef({ x: 0, y: 0, inside: false, hovered: -1, selected: -1, shown: -1, downX: 0, downY: 0, downT: 0 });
  const label = useRef<HTMLDivElement | null>(null);
  const vp = useMemo(() => new THREE.Matrix4(), []);
  const out = useMemo(() => ({ x: 0, y: 0, px: 0 }), []);
  const maxPx = useMemo(() => frame.maxPointPx(STAR_MAX_PX), [frame]);

  /** Screen position and drawn size of star i; false if it is behind the camera. */
  const project = (i: number): boolean => {
    const e = vp.elements;
    const v = camera.matrixWorldInverse.elements;
    const p = galaxy.positions;
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    if (w <= 0.01) return false;
    out.x = ((e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) / w * 0.5 + 0.5) * size.width;
    out.y = (0.5 - (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) / w * 0.5) * size.height;
    const depth = -(v[2]! * x + v[6]! * y + v[10]! * z + v[14]!);
    out.px = Math.min(maxPx, Math.max(STAR_MIN_PX, (galaxy.sizes[i]! * STAR_WORLD_SIZE * frame.uScale.value) / depth));
    return true;
  };

  const updateMatrices = () => {
    camera.updateMatrixWorld();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  };

  /** The star under (px, py), or -1. The closest one relative to its hit radius wins. */
  const pick = (px: number, py: number, minRadius: number): number => {
    let best = -1;
    let bestScore = 1;
    for (let i = 0; i < galaxy.count; i++) {
      if (!project(i)) continue;
      const dx = out.x - px, dy = out.y - py;
      const r = Math.max(out.px * 0.3, minRadius); // the bright part is ~60% of the sprite
      const score = (dx * dx + dy * dy) / (r * r);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  };

  useEffect(() => {
    const div = document.createElement('div');
    div.className = 'galaxy-hover';
    div.style.display = 'none';
    document.body.appendChild(div);
    label.current = div;

    const el = gl.domElement;
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return; // no hover on touch screens
      [st.current.x, st.current.y] = local(e);
      st.current.inside = true;
      pointer.inside = true;
      pointer.x = st.current.x;
    };
    const leave = () => {
      st.current.inside = false;
      pointer.inside = false;
      pointer.dragging = false;
    };
    const down = (e: PointerEvent) => {
      [st.current.downX, st.current.downY] = local(e);
      st.current.downT = performance.now();
      pointer.dragging = true;
    };
    const up = (e: PointerEvent) => {
      pointer.dragging = false;
      const [x, y] = local(e);
      const s = st.current;
      if (Math.hypot(x - s.downX, y - s.downY) > CLICK_MOVE_PX || performance.now() - s.downT > CLICK_MS) return;
      updateMatrices();
      const i = pick(x, y, e.pointerType === 'mouse' ? MOUSE_RADIUS : TOUCH_RADIUS);
      s.selected = i; // clicking empty space clears the selection
      if (i >= 0) onSelect(i);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.style.cursor = '';
      div.remove();
    };
    // pick/project read refs and stable objects only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, galaxy, onSelect]);

  // Runs after the camera controls (they use priority -1), before rendering.
  useFrame(() => {
    const s = st.current;
    const div = label.current;
    if (!div) return;
    updateMatrices();

    const hovered = s.inside ? pick(s.x, s.y, MOUSE_RADIUS) : -1;
    if (hovered !== s.hovered) {
      s.hovered = hovered;
      pointer.hovering = hovered >= 0;
      gl.domElement.style.cursor = hovered >= 0 ? 'pointer' : '';
    }

    // Hover wins; otherwise keep showing the star you clicked (works on touch too).
    const show = hovered >= 0 ? hovered : s.selected;
    if (show < 0 || !project(show)) {
      if (s.shown !== -1) div.style.display = 'none';
      s.shown = -1;
      return;
    }
    if (show !== s.shown) {
      div.textContent = galaxy.names[show]!; // textContent: names are never parsed as HTML
      div.style.display = '';
      s.shown = show;
    }
    const lift = out.px * 0.3 + 6;
    div.style.transform = `translate(${out.x.toFixed(1)}px, ${(out.y - lift).toFixed(1)}px) translate(-50%, -100%)`;
  });

  return null;
}
