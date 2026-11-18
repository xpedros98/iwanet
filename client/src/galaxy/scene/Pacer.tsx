import { advance, useThree } from '@react-three/fiber';
import { useEffect } from 'react';

/**
 * Rendered frames per second when nothing but breathing and the slow drift
 * moves. 60, not lower: at 20 the drift and twinkle visibly stutter, which
 * reads as the galaxy freezing whenever you stop interacting. Above 60 (on
 * 120/144 Hz screens) slow motion looks the same, so those frames are saved.
 */
export const IDLE_FPS = 60;
/**
 * Quality ladder, best first. Pixel ratio first (cost grows with its square),
 * then the haze: one textured layer that covers the whole screen when the
 * camera is inside the disc, measured as 70% of the GPU time on a software GPU
 * at ratio 1 (37 → 60 fps without it).
 */
type Level = { dpr: number; haze: boolean };
const LADDER: Level[] = [
  { dpr: 2, haze: true },
  { dpr: 1.5, haze: true },
  { dpr: 1.25, haze: true },
  { dpr: 1, haze: true },
  { dpr: 1, haze: false },
  { dpr: 0.75, haze: false },
];
const key = (l: Level) => `${l.dpr}${l.haze ? '' : '-nohaze'}`;
const STORE_KEY = 'galaxy.dpr';
const WARMUP_MS = 3000; // ignore the first seconds (shader compile, data parsing)
const WINDOW = 90; // active frames per verdict (~1.5 s at 60 Hz)
const MISSED_FACTOR = 1.5; // an interval this many refreshes long = a missed frame
const BAD_RATIO = 0.1; // > 10% missed → step down
const GOOD_RATIO = 0.02; // < 2% missed for PROBE_AFTER_S → try one step up
const PROBE_AFTER_S = 30;

/** "Something is moving": render at full rate until `until` (seconds, performance clock). */
export type Activity = {
  until: number;
  wake: (seconds: number) => void;
  /** JavaScript time of the last rendered frame, ms (read by the benchmark) */
  cpu: number;
};

export function createActivity(): Activity {
  const a: Activity = {
    until: 0,
    cpu: 0,
    wake: (s) => {
      a.until = Math.max(a.until, performance.now() / 1000 + s);
    },
  };
  return a;
}

/**
 * Drives rendering (the Canvas uses frameloop="never").
 *
 * Every display refresh it decides: render now (active, or the idle interval
 * has passed) or skip. Skipped refreshes cost a few comparisons. Animation
 * code uses the time between RENDERED frames, so motion speed is the same at
 * 20, 60 or 144 frames per second.
 *
 * It also adapts the pixel ratio: fill rate grows with its square, so it is
 * the strongest lever on a weak GPU (2 → 1.5 shades 44% fewer pixels).
 */
export function Pacer({
  activity,
  reduced,
  quality,
  fixedDpr,
}: {
  activity: Activity;
  reduced: boolean;
  /** shared with Background: haze on or off */
  quality: { haze: boolean };
  fixedDpr?: number;
}) {
  const get = useThree((s) => s.get);
  const setDpr = useThree((s) => s.setDpr);
  const size = useThree((s) => s.size);

  // A resize clears the canvas: draw again at once (with reduced motion there
  // would otherwise be no frame until the next interaction).
  useEffect(() => activity.wake(0.2), [activity, size]);

  useEffect(() => {
    // Levels this screen can use: its own ratio (capped at 2), then lower ones.
    const deviceMax = Math.min(window.devicePixelRatio || 1, 2);
    const levels: Level[] = [
      { dpr: deviceMax, haze: true },
      ...LADDER.filter((l) => l.dpr < deviceMax || (l.dpr === deviceMax && !l.haze)),
    ];
    let level = 0;
    // The benchmark measures one fixed pixel ratio: no adapting, nothing saved.
    if (fixedDpr) setDpr(fixedDpr);
    else try {
      const saved = localStorage.getItem(STORE_KEY);
      const i = levels.findIndex((l) => key(l) === saved);
      if (i >= 0) level = i;
    } catch {
      /* storage blocked: start at full resolution */
    }
    const apply = (reason: string) => {
      activity.wake(0.2); // a new pixel ratio resizes (and clears) the canvas
      setDpr(levels[level]!.dpr);
      quality.haze = levels[level]!.haze;
      try {
        localStorage.setItem(STORE_KEY, key(levels[level]!));
      } catch {
        /* ignore */
      }
      if (import.meta.env.DEV) console.info(`[pacer] ${key(levels[level]!)} (${reason})`);
    };
    if (!fixedDpr) {
      setDpr(levels[level]!.dpr);
      quality.haze = levels[level]!.haze;
    }

    // Display refresh interval: 10th percentile of recent rAF intervals.
    const intervals = new Float32Array(120);
    let ii = 0;
    let refresh = 1000 / 60;

    const start = performance.now();
    let raf = 0;
    let lastTick = 0;
    let lastRender = -1e9;
    let prevActive = false;
    const win = { n: 0, missed: 0, cpu: 0 };
    let goodMs = 0;
    let probed = false;
    let probing = false;
    let locked = false;
    let renders = 0; // dev statistics

    // A sensible first delta for fiber's clock (it measures from elapsedTime).
    get().clock.elapsedTime = start / 1000 - 1 / 60;

    const evaluate = (dt: number, cpu: number) => {
      win.n++;
      win.cpu += cpu;
      if (dt > refresh * MISSED_FACTOR) win.missed++;
      if (win.n < WINDOW) return;
      const ratio = win.missed / win.n;
      const cpuAvg = win.cpu / win.n;
      const span = win.n * refresh;
      win.n = win.missed = win.cpu = 0;

      if (ratio > BAD_RATIO) {
        goodMs = 0;
        if (probing) locked = true; // the step up failed: stay at the lower level from now on
        probing = false;
        // Lowering the resolution only helps when the GPU is the bottleneck,
        // not when JavaScript itself takes most of the frame.
        if (cpuAvg < refresh * 0.5 && level < levels.length - 1) {
          level++;
          apply(`${Math.round(ratio * 100)}% frames missed`);
        } else if (import.meta.env.DEV) {
          console.info(`[pacer] ${Math.round(ratio * 100)}% missed, JS ${cpuAvg.toFixed(1)} ms/frame: not a resolution problem`);
        }
      } else if (ratio < GOOD_RATIO && level > 0 && !probed && !locked) {
        goodMs += span;
        if (goodMs > PROBE_AFTER_S * 1000) {
          probed = probing = true;
          level--;
          apply('smooth for 30 s, trying one step up');
        }
      } else if (ratio < GOOD_RATIO) {
        probing = false; // a probe that survived a window is kept
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = lastTick ? now - lastTick : 0;
      lastTick = now;
      if (dt > 0 && dt < 100) {
        intervals[ii] = dt;
        ii = (ii + 1) % intervals.length;
        if (ii === 0) refresh = Array.from(intervals).sort((a, b) => a - b)[12]!;
      }

      const active = now / 1000 < activity.until;
      const idleDue = !reduced && now - lastRender >= 1000 / IDLE_FPS - refresh / 2;
      if (!active && !idleDue) {
        prevActive = false;
        return;
      }
      const t0 = performance.now();
      advance(now / 1000);
      renders++;
      const cpu = performance.now() - t0;
      activity.cpu = cpu;
      // Judge only consecutive active frames (idle frames are skipped on purpose).
      if (!fixedDpr && active && prevActive && now - start > WARMUP_MS) evaluate(dt, cpu);
      prevActive = active;
      lastRender = now;
    };
    // The first frames (fade-in) must be drawn whatever the idle policy:
    // with reduced motion nothing else would start them.
    activity.wake(0.5);
    raf = requestAnimationFrame(tick);

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__galaxyPacer = {
        dpr: () => levels[level]!.dpr,
        haze: () => quality.haze,
        renders: () => renders,
        refresh: () => refresh,
        active: () => performance.now() / 1000 < activity.until,
      };
    }
    return () => cancelAnimationFrame(raf);
  }, [get, setDpr, activity, reduced, quality, fixedDpr]);

  return null;
}
