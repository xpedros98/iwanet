// Minimal types for the parts of d3-force-3d used by layout.ts (the package ships none).
declare module 'd3-force-3d' {
  export interface SimNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
  }
  export interface SimLink<N> {
    source: N | number | string;
    target: N | number | string;
  }
  type Accessor<N, T> = T | ((node: N, i: number, nodes: N[]) => T);

  export interface Force<N> {
    (alpha: number): void;
  }
  export interface Simulation<N extends SimNode> {
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(a: number): this;
    alphaDecay(d: number): this;
    velocityDecay(d: number): this;
    force(name: string, force: Force<N> | null): this;
    nodes(): N[];
  }
  export function forceSimulation<N extends SimNode>(nodes?: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;

  export interface LinkForce<N, L> extends Force<N> {
    id(fn: (node: N) => number | string): this;
    distance(d: Accessor<L, number>): this;
    strength(s: Accessor<L, number>): this;
  }
  export function forceLink<N extends SimNode, L extends SimLink<N>>(links?: L[]): LinkForce<N, L>;

  export interface ManyBodyForce<N> extends Force<N> {
    strength(s: Accessor<N, number>): this;
    distanceMax(d: number): this;
  }
  export function forceManyBody<N extends SimNode>(): ManyBodyForce<N>;

  export interface CollideForce<N> extends Force<N> {
    radius(r: Accessor<N, number>): this;
    strength(s: number): this;
  }
  export function forceCollide<N extends SimNode>(radius?: Accessor<N, number>): CollideForce<N>;

  export interface PositionForce<N> extends Force<N> {
    strength(s: Accessor<N, number>): this;
  }
  export function forceX<N extends SimNode>(x?: Accessor<N, number>): PositionForce<N>;
  export function forceY<N extends SimNode>(y?: Accessor<N, number>): PositionForce<N>;
  export function forceZ<N extends SimNode>(z?: Accessor<N, number>): PositionForce<N>;
}
