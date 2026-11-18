import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Glide } from './GalaxyScene';
import type { Activity } from './Pacer';

/**
 * The /bench page: a fixed 20-second camera flight, the same on every device.
 *
 * Loaded as its own chunk, only on /bench: normal visitors never download it.
 *
 * Phases: settle 2 s (fade-in, shader compile) → flight 20 s at full frame rate,
 * every frame recorded → idle 5 s (frames per second the pacer allows at rest)
 * → results on screen and in window.__benchResult (read by tools/bench.mjs).
 *
 * ?hide=haze,background,lines,stars,your-star switches layers off, to see what
 * each one costs on a given device (compare the GPU time with and without).
 *
 * The camera position is a function of ELAPSED TIME, never of the frame count,
 * so the flight takes 20 s and ends at the same spot at 30, 60 or 144 Hz.
 */
const SETTLE_S = 2;
const FLIGHT_S = 20;
const IDLE_S = 5;
const CAP = 1 << 17; // frames recorded (20 s even at 6,500 fps, as with vsync off)

type Controls = { setLookAt: (px: number, py: number, pz: number, tx: number, ty: number, tz: number, smooth: boolean) => unknown };
type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export type BenchResult = {
  hidden: string[];
  stars: number;
  links: number;
  pixelRatio: number;
  canvas: string;
  gpu: string;
  refreshHz: number;
  flightSeconds: number;
  frames: number;
  fps: number;
  frameMs: { median: number; p95: number; p99: number; worst: number };
  over16: number;
  over33: number;
  missedPct: number;
  jsMs: { median: number; p95: number };
  gpuMs: { median: number; p95: number } | null;
  drawCalls: number;
  longTasks: { count: number; worstMs: number } | null;
  heapGrowthMB: number | null;
  idleFps: number;
  endCamera: number[];
};

/** Keyframes (camera, look-at) from the galaxy itself, so any galaxy gets the same kind of tour. */
function buildPath(glide: Glide) {
  const { galaxy } = glide;
  const R = galaxy.shape.radius;
  const n = galaxy.count;
  const p = galaxy.positions;

  // The biggest friend circle (most common colour): its centre.
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) counts.set(galaxy.colors[i]!, (counts.get(galaxy.colors[i]!) ?? 0) + 1);
  let big = 0, bigCount = -1;
  for (const [c, k] of counts) if (k > bigCount) [big, bigCount] = [c, k];
  const circle = new THREE.Vector3();
  let tip = 0, tipD = -1;
  for (let i = 0; i < n; i++) {
    if (galaxy.colors[i] === big) circle.add(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
    const d = p[i * 3]! ** 2 + p[i * 3 + 2]! ** 2;
    if (d > tipD) [tip, tipD] = [i, d];
  }
  if (bigCount > 0) circle.divideScalar(bigCount);
  const armTip = new THREE.Vector3(p[tip * 3], p[tip * 3 + 1], p[tip * 3 + 2]);
  const out = (v: THREE.Vector3) => {
    const o = new THREE.Vector3(v.x, 0, v.z);
    return o.lengthSq() < 1e-6 ? o.set(0, 0, 1) : o.normalize();
  };
  const side = (v: THREE.Vector3) => new THREE.Vector3(-out(v).z, 0, out(v).x);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const keys: [THREE.Vector3, THREE.Vector3][] = [
    [V(0, R * 1.45, R * 1.25), V(0, 0, 0)], // overview from above
    [V(0, R * 0.8, R * 0.9), V(0, 0, 0)], // coming in
    [circle.clone().addScaledVector(out(circle), R * 0.35).add(V(0, R * 0.2, 0)), circle.clone()], // a friend circle
    [circle.clone().addScaledVector(side(circle), R * 0.25).add(V(0, R * 0.08, 0)), circle.clone()], // inside it: biggest stars on screen
    [armTip.clone().addScaledVector(out(armTip), R * 0.4).add(V(0, R * 0.25, 0)), armTip.clone()], // an arm tip
    [V(0, R * 0.6, R * 1.6), V(0, 0, 0)], // low across the whole disc
  ];
  return {
    pos: new THREE.CatmullRomCurve3(keys.map((k) => k[0]), false, 'centripetal'),
    look: new THREE.CatmullRomCurve3(keys.map((k) => k[1]), false, 'centripetal'),
  };
}

const quantile = (sorted: Float32Array | number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export default function Bench({ glide, activity }: { glide: Glide; activity: Activity }) {
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const path = useMemo(() => buildPath(glide), [glide]);

  const st = useMemo(
    () => ({
      phase: 'settle' as 'settle' | 'flight' | 'idle' | 'done',
      start: performance.now(),
      flightStart: 0,
      flightEnd: 0,
      idleStart: 0,
      idleFrames: 0,
      n: 0,
      dt: new Float32Array(CAP),
      js: new Float32Array(CAP),
      gpu: [] as number[],
      calls: 0,
      longTasks: [] as number[],
      heap0: 0,
      recording: false,
      pos: new THREE.Vector3(),
      look: new THREE.Vector3(),
    }),
    [],
  );

  const hidden = useMemo(() => (new URLSearchParams(location.search).get('hide') ?? '').split(',').filter(Boolean), []);
  useFrame(() => {
    for (const name of hidden) {
      const o = scene.getObjectByName(name);
      if (o) o.visible = false;
    }
  }, -3);

  // Full frame rate for the whole run: the pacer's idle rate is measured separately at the end.
  useEffect(() => {
    activity.until = Infinity;
    return () => void (activity.until = 0);
  }, [activity]);

  // GPU time per frame, where the browser exposes it (desktop Chrome usually does,
  // Safari and most phones do not). Wraps gl.render in a timer query.
  const timer = useMemo(() => {
    const ctx = gl.getContext() as WebGL2RenderingContext;
    const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    return ext ? { ctx, ext, pending: [] as WebGLQuery[] } : null;
  }, [gl]);
  useEffect(() => {
    if (!timer) return;
    const { ctx, ext } = timer;
    const render = gl.render;
    gl.render = function (scene, camera) {
      if (!st.recording) return render.call(this, scene, camera);
      const q = ctx.createQuery()!;
      ctx.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render.call(this, scene, camera);
      ctx.endQuery(ext.TIME_ELAPSED_EXT);
      timer.pending.push(q);
    };
    return () => void (gl.render = render);
  }, [gl, timer, st]);
  const pollGpu = () => {
    if (!timer) return;
    const { ctx, ext, pending } = timer;
    const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (pending.length && ctx.getQueryParameter(pending[0]!, ctx.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift()!;
      if (!disjoint) st.gpu.push((ctx.getQueryParameter(q, ctx.QUERY_RESULT) as number) / 1e6);
      ctx.deleteQuery(q);
    }
  };

  // Long tasks (> 50 ms on the main thread) during the flight; Chrome only.
  useEffect(() => {
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    const obs = new PerformanceObserver((list) => {
      if (st.recording) for (const e of list.getEntries()) st.longTasks.push(e.duration);
    });
    obs.observe({ type: 'longtask' });
    return () => obs.disconnect();
  }, [st]);

  const moveCamera = (u: number) => {
    const e = u * u * (3 - 2 * u); // ease in and out
    path.pos.getPoint(e, st.pos);
    path.look.getPoint(e, st.look);
    controls?.setLookAt(st.pos.x, st.pos.y, st.pos.z, st.look.x, st.look.y, st.look.z, false);
  };

  // Priority -2: before CameraControls' own update (-1), so the camera moves this frame.
  useFrame((state, delta) => {
    const now = performance.now();
    pollGpu();
    if (st.phase === 'settle') {
      moveCamera(0);
      if (now - st.start > SETTLE_S * 1000) {
        st.phase = 'flight';
        st.flightStart = now;
        st.recording = true;
        st.heap0 = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
      }
      return;
    }
    if (st.phase === 'flight') {
      const t = (now - st.flightStart) / 1000;
      if (t > 0 && st.n < CAP) {
        st.dt[st.n] = delta * 1000; // fiber's delta = time since the previous rendered frame
        st.js[st.n] = activity.cpu; // JavaScript time of the previous frame
        st.n++;
      }
      st.calls = Math.max(st.calls, state.gl.info.render.calls);
      moveCamera(Math.min(1, t / FLIGHT_S));
      if (t >= FLIGHT_S) {
        st.phase = 'idle';
        st.flightEnd = now;
        st.recording = false;
        st.idleStart = now + 500; // let the last activity wake run out first
        activity.until = 0;
        setTimeout(() => {
          st.phase = 'done';
          finish(camera.position);
        }, 500 + IDLE_S * 1000);
      }
      return;
    }
    // At rest: count frames for IDLE_S on a timer (with reduced motion there are none).
    if (st.phase === 'idle' && now >= st.idleStart && now - st.idleStart < IDLE_S * 1000) st.idleFrames++;
  }, -2);

  const finish = (cam: THREE.Vector3) => {
    pollGpu();
    const n = st.n;
    const dt = st.dt.slice(1, n).sort(); // the first entry spans the settle → flight switch
    const js = st.js.slice(2, n).sort();
    const gpu = Float32Array.from(st.gpu).sort();
    const refresh = quantile(dt, 0.1);
    const sum = dt.reduce((a, b) => a + b, 0);
    let missed = 0, over16 = 0, over33 = 0;
    for (const d of dt) {
      if (d > refresh * 1.5) missed++;
      if (d > 1000 / 60 + 0.5) over16++; // 0.5 ms of tolerance for timer jitter
      if (d > 1000 / 30 + 0.5) over33++;
    }
    const ctx = gl.getContext();
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    const heap1 = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const lt = PerformanceObserver.supportedEntryTypes?.includes('longtask') ? st.longTasks : null;
    const res: BenchResult = {
      hidden,
      stars: glide.galaxy.count,
      links: glide.galaxy.links.length / 2,
      pixelRatio: gl.getPixelRatio(),
      canvas: `${ctx.drawingBufferWidth}×${ctx.drawingBufferHeight}`,
      gpu: String(dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)),
      refreshHz: Math.round(1000 / refresh),
      flightSeconds: r2((st.flightEnd - st.flightStart) / 1000),
      frames: dt.length,
      fps: r1((dt.length / sum) * 1000),
      frameMs: { median: r2(quantile(dt, 0.5)), p95: r2(quantile(dt, 0.95)), p99: r2(quantile(dt, 0.99)), worst: r2(dt[dt.length - 1] ?? 0) },
      over16,
      over33,
      missedPct: r1((missed / Math.max(1, dt.length)) * 100),
      jsMs: { median: r2(quantile(js, 0.5)), p95: r2(quantile(js, 0.95)) },
      gpuMs: gpu.length > 10 ? { median: r2(quantile(gpu, 0.5)), p95: r2(quantile(gpu, 0.95)) } : null,
      drawCalls: st.calls,
      longTasks: lt ? { count: lt.length, worstMs: Math.round(Math.max(0, ...lt)) } : null,
      heapGrowthMB: st.heap0 ? r2((heap1 - st.heap0) / 1048576) : null,
      idleFps: r1(st.idleFrames / IDLE_S),
      endCamera: cam.toArray().map((v) => Math.round(v * 1000) / 1000),
    };
    (window as unknown as { __benchResult?: BenchResult }).__benchResult = res;
    console.info('[bench]', res);
    showPanel(res);
  };

  return null;
}

function showPanel(r: BenchResult) {
  const div = document.createElement('div');
  div.className = 'bench-panel';
  const pre = document.createElement('pre');
  pre.textContent = [
    ...(r.hidden.length ? [`hidden: ${r.hidden.join(', ')}`] : []),
    `${r.stars} stars · ${r.links} friendships · ${r.canvas} px (ratio ${r.pixelRatio}) · ~${r.refreshHz} Hz`,
    r.gpu,
    ``,
    `flight        ${r.flightSeconds} s, ${r.frames} frames, ${r.fps} fps`,
    `frame time    median ${r.frameMs.median} · p95 ${r.frameMs.p95} · p99 ${r.frameMs.p99} · worst ${r.frameMs.worst} ms`,
    `slow frames   ${r.over16} over 16.7 ms · ${r.over33} over 33 ms · ${r.missedPct}% missed refreshes`,
    `JavaScript    median ${r.jsMs.median} · p95 ${r.jsMs.p95} ms per frame`,
    `GPU           ${r.gpuMs ? `median ${r.gpuMs.median} · p95 ${r.gpuMs.p95} ms per frame` : 'not exposed by this browser'}`,
    `draw calls    ${r.drawCalls}`,
    `long tasks    ${r.longTasks ? `${r.longTasks.count} (worst ${r.longTasks.worstMs} ms)` : 'not exposed by this browser'}`,
    `heap growth   ${r.heapGrowthMB === null ? 'not exposed by this browser' : `${r.heapGrowthMB} MB during the flight`}`,
    `idle          ${r.idleFps} frames/s`,
    `end camera    ${r.endCamera.join(', ')}`,
  ].join('\n');
  const again = document.createElement('button');
  again.textContent = 'Run again';
  again.onclick = () => location.reload();
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.onclick = () => {
    const text = pre.textContent + '\n\n' + JSON.stringify(r);
    if (navigator.clipboard) void navigator.clipboard.writeText(text).then(() => (copy.textContent = 'Copied'));
    else {
      // Plain http on a phone (no clipboard API): select the text for a long-press copy.
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  };
  div.append(pre, again, copy);
  document.body.appendChild(div);
}
