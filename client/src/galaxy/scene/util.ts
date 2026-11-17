/** Friend-circle colours (sRGB, written to the screen as-is by the shaders). */
export const PALETTE: [number, number, number][] = [
  [0.45, 0.68, 1.0], // blue
  [1.0, 0.68, 0.38], // amber
  [0.5, 1.0, 0.7], // mint
  [1.0, 0.52, 0.72], // pink
  [0.78, 0.6, 1.0], // violet
  [1.0, 0.92, 0.5], // yellow
  [0.45, 0.95, 1.0], // cyan
  [1.0, 0.55, 0.5], // coral
];

/** Deterministic random numbers (mulberry32), so the background is the same every visit. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal random value, mean 0, about ±1. */
export const gauss = (r: () => number) => r() + r() + r() - 1.5;

/** Exponential smoothing factor for `delta` seconds: same feel at any frame rate. */
export const damp = (k: number, delta: number) => 1 - Math.exp(-k * delta);

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
