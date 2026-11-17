/**
 * Galaxy layout: turns users + friendships into 3D star positions.
 *
 *   1. Circles       Louvain community detection → colour index + arm
 *   2. Spiral seed   each circle sits together on its arm; join time
 *                    sets the distance from the centre
 *   3. Forces        friends attract, close stars push apart,
 *                    an anchor pulls each star back to its seed
 *   4. Stability     start from the previous positions, limit movement
 *
 * Pure computation: no database access here (see layoutJob.ts).
 */
import {
  forceLink,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type SimNode,
} from 'd3-force-3d';
import { UndirectedGraph } from 'graphology';
import { createRequire } from 'node:module';

// graphology-communities-louvain is CommonJS-only (module.exports = fn) while its
// type file declares an ES default export, which TypeScript can't reconcile here.
// Load it with require() and state the one signature used.
const louvain = createRequire(import.meta.url)('graphology-communities-louvain') as (
  graph: UndirectedGraph,
  options?: { rng?: () => number; resolution?: number },
) => Record<string, number>;

export type LayoutInput = {
  /** User ids in join order (oldest first). */
  ids: number[];
  /** Friendship pairs [a, b], each once. */
  links: [number, number][];
  /** Positions from the previous run, by user id. */
  previous: Map<number, [number, number, number]>;
};

export type StarOut = { id: number; x: number; y: number; z: number; color: number; size: number };

// ------------------------------------------------------------ parameters
export const ARMS = 2;
export const TURNS = 1.1; // how far each arm winds around the centre
const BASE_RADIUS = 10; // galaxy radius at 20 users (scene units)
const WARM_ALPHA = 0.3; // starting "temperature" when most stars already have positions
const MAX_MOVE = 0.15; // max movement per run for existing stars, as a fraction of the radius

/** Force settings; overridable for tuning experiments. */
export const DEFAULT_FORCES = {
  ticks: 150, // simulation steps (300 measured no better on the quality checks, at twice the time)
  resolution: 1, // Louvain resolution: higher = smaller, tighter friend circles
  circleSpread: 0.35, // 0 = a circle's members share one spot on the arm, 1 = each at its own join time
  linkStrength: 0.25, // pull between friends
  linkDistance: 0.12, // rest length of a friendship, as a fraction of the radius
  minGap: 0.04, // stars closer than this (fraction of the radius) push apart
  separate: 0.5, // strength of that push
  anchor: 0.15, // pull back to the spiral seed, in the disc plane (0.06 let friendships erase the spiral)
  anchorY: 0.3, // pull back to the disc (keeps it flat)
};
export type Forces = typeof DEFAULT_FORCES;

/** Galaxy radius grows with the cube root of user count: 20 → 10, 2,000 → ~46. */
export function galaxyRadius(n: number): number {
  return BASE_RADIUS * Math.cbrt(Math.max(n, 20) / 20);
}

// Deterministic per-user random numbers, so a user's seed position (and thus
// the layout) is the same on every run.
function rngFor(id: number): () => number {
  let s = Math.imul(id, 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal random value (sum of 3 uniforms), mean 0, about ±1. */
const gauss = (r: () => number) => r() + r() + r() - 1.5;

type Node = SimNode & { id: number; sx: number; sy: number; sz: number; px?: number; py?: number; pz?: number };

/**
 * Keeps stars from overlapping: any two closer than `gap` push apart.
 * Replaces d3's forceManyBody + forceCollide, which measured 5.8 s and 3.3 s
 * for 2,000 stars × 300 ticks. A uniform grid with cell size = gap means each
 * star only checks the 27 cells around it: roughly linear in star count.
 */
function separation(nodes: Node[], gap: number, strength: number) {
  const cells = new Map<number, number[]>();
  // Cell coordinates are clamped to ±511 and packed into 10 bits each, so the
  // key stays a small exact integer (< 2^30). 511 cells = 20 galaxy radii, far
  // beyond any star; clamping only merges cells out there.
  const cell = (v: number) => Math.max(-511, Math.min(511, Math.floor(v / gap))) + 512;
  const key = (ix: number, iy: number, iz: number) => (ix * 1024 + iy) * 1024 + iz;
  const gap2 = gap * gap;

  return (alpha: number) => {
    cells.clear();
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i]!;
      const k = key(cell(p.x!), cell(p.y!), cell(p.z!));
      const list = cells.get(k);
      if (list) list.push(i);
      else cells.set(k, [i]);
    }
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i]!;
      const cx = cell(p.x!), cy = cell(p.y!), cz = cell(p.z!);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = cells.get(key(cx + dx, cy + dy, cz + dz));
            if (!list) continue;
            for (const j of list) {
              if (j <= i) continue; // each pair once
              const q = nodes[j]!;
              const ex = q.x! - p.x!, ey = q.y! - p.y!, ez = q.z! - p.z!;
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 >= gap2 || d2 === 0) continue;
              const d = Math.sqrt(d2);
              const push = ((gap - d) / d) * strength * alpha * 0.5;
              p.vx! -= ex * push; p.vy! -= ey * push; p.vz! -= ez * push;
              q.vx! += ex * push; q.vy! += ey * push; q.vz! += ez * push;
            }
          }
    }
  };
}

export function computeLayout({ ids, links, previous }: LayoutInput, f: Forces = DEFAULT_FORCES): StarOut[] {
  const n = ids.length;
  if (n === 0) return [];
  const R = galaxyRadius(n);

  const degree = new Map<number, number>(ids.map((id) => [id, 0]));
  const validLinks = links.filter(([a, b]) => a !== b && degree.has(a) && degree.has(b));
  for (const [a, b] of validLinks) {
    degree.set(a, degree.get(a)! + 1);
    degree.set(b, degree.get(b)! + 1);
  }

  // ---- 1. friend circles (Louvain) ---------------------------------------
  const graph = new UndirectedGraph();
  for (const id of ids) graph.addNode(id);
  for (const [a, b] of validLinks) graph.mergeEdge(a, b);
  const community = louvain(graph, { rng: rngFor(1), resolution: f.resolution });

  // Louvain's community numbers are arbitrary. Renumber circles in order of
  // their oldest member, so colours stay put when the graph barely changes.
  type Circle = { label: number; arm: number; tSum: number; count: number };
  const circles = new Map<number, Circle>();
  ids.forEach((id, i) => {
    const c = community[String(id)]!;
    let circle = circles.get(c);
    if (!circle) {
      // Arm chosen from the oldest member's id: stable while that member stays in the circle.
      circle = { label: circles.size, arm: Math.floor(rngFor(id)() * ARMS), tSum: 0, count: 0 };
      circles.set(c, circle);
    }
    circle.tSum += (i + 0.5) / n;
    circle.count++;
  });

  // ---- 2. spiral seed ----------------------------------------------------
  // A star's place along its arm mixes its own join time with its circle's
  // average, so each circle sits together: older circles near the centre.
  const nodes: Node[] = ids.map((id, i) => {
    const r = rngFor(id);
    const circle = circles.get(community[String(id)]!)!;
    const own = (i + 0.5) / n; // 0 = first user, 1 = newest
    const mean = circle.tSum / circle.count;
    const t = mean + (own - mean) * f.circleSpread;
    const angle = (circle.arm / ARMS) * 2 * Math.PI + t * TURNS * 2 * Math.PI;
    const radius = R * (0.12 + 0.88 * t);
    const spread = R * 0.06; // scatter around the arm
    const sx = Math.cos(angle) * radius + gauss(r) * spread;
    const sz = Math.sin(angle) * radius + gauss(r) * spread;
    const sy = gauss(r) * R * 0.03 * (1 - 0.6 * t); // thicker near the core
    const prev = previous.get(id);
    return prev
      ? { id, sx, sy, sz, x: prev[0], y: prev[1], z: prev[2], px: prev[0], py: prev[1], pz: prev[2] }
      : { id, sx, sy, sz, x: sx, y: sy, z: sz };
  });

  // ---- 3. forces -----------------------------------------------------------
  const simLinks = validLinks.map(([a, b]) => ({ source: a, target: b }));

  const warm = previous.size >= n * 0.5;
  const sim = forceSimulation<Node>(nodes, 3)
    .stop()
    .alpha(warm ? WARM_ALPHA : 1)
    .force(
      'link',
      forceLink<Node, { source: number; target: number }>(simLinks)
        .id((d) => d.id)
        .distance(R * f.linkDistance)
        .strength(f.linkStrength),
    )
    .force('separate', separation(nodes, R * f.minGap, f.separate))
    // The anchor keeps the spiral: strong vertically (flat disc), gentler in the plane.
    .force('ax', forceX<Node>((d) => d.sx).strength(f.anchor))
    .force('ay', forceY<Node>((d) => d.sy).strength(f.anchorY))
    .force('az', forceZ<Node>((d) => d.sz).strength(f.anchor));
  sim.tick(f.ticks);

  // ---- 4. stability + output ----------------------------------------------
  const maxMove = R * MAX_MOVE;
  let maxDeg = 1;
  for (const d of degree.values()) maxDeg = Math.max(maxDeg, d);

  return nodes.map((node) => {
    let { x = 0, y = 0, z = 0 } = node;
    if (node.px !== undefined) {
      const dx = x - node.px, dy = y - node.py!, dz = z - node.pz!;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > maxMove) {
        const k = maxMove / dist;
        x = node.px + dx * k;
        y = node.py! + dy * k;
        z = node.pz! + dz * k;
      }
    }
    const deg = degree.get(node.id) ?? 0;
    return {
      id: node.id,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      color: circles.get(community[String(node.id)]!)!.label,
      // 0.8 (no friends) … 1.4 (most friends), log scale
      size: Math.round((0.8 + (0.6 * Math.log1p(deg)) / Math.log1p(maxDeg)) * 100) / 100,
    };
  });
}
