import { CHIP_INSTANCE_WIDTH, chipBodyWidth, chipBoxHeight, chipInstanceHeight, BUS_PASS_BODY_W, BUS_SWITCH_BODY_W, ramPortCount, romPortCount } from '../sim/library.js';
import type { Circuit } from '../sim/Circuit.js';
import type { BusPassComponent, BusSwitchComponent, Component, Pin, Point, Wire } from '../sim/types.js';
import { routeEscapeChannel } from './routeChannel.js';

export const GRID = 10;

/** Axis-aligned obstacle box for wire routing. */
export type Aabb = { minX: number; minY: number; maxX: number; maxY: number };

export function snap(p: Point, step: number = GRID): Point {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Preferred leave/arrive direction for a pin (schematic exit). */
export type RouteDir = 'N' | 'S' | 'E' | 'W';

/**
 * A row (`axis: 'h'`, y = coord, x ∈ [lo, hi]) or column (`axis: 'v'`) that a
 * not-yet-routed wire will need to leave/enter its pin. Running along it is
 * penalized so an earlier wire does not steal a later pin's approach.
 */
export interface RouteLane {
  axis: 'h' | 'v';
  coord: number;
  lo: number;
  hi: number;
}

/** Options for schematic orthogonal routing (KiCad/Logisim-style patterns). */
export interface RouteOpts {
  obstacles?: Aabb[];
  /**
   * Bodies of the wire's own endpoint components (excluded from `obstacles` so
   * pin stubs may leave them). The channel router still keeps its search out of
   * them, so a route never crosses its own package to reach a pin's back side.
   */
  hostObstacles?: Aabb[];
  /** Direction the wire should leave the start point (away from component body). */
  startDir?: RouteDir | null;
  /** Direction the wire should leave the end pin — arrival travel is opposite. */
  endDir?: RouteDir | null;
  /** Other polylines; H×V crossings are penalized (same-net overlap is fine). */
  avoidCrossings?: Point[][];
  /**
   * Other polylines; colinear parallel overlap is penalized so fanouts take
   * distinct channels. Only used during tidy/commit — never on the draw path.
   */
  avoidOverlap?: Point[][];
  /** Same-net polylines — overlapping them is rewarded (bus bundling). */
  preferAlong?: Point[][];
  /** Pin approach lanes of wires still waiting to be routed (channel router). */
  reservedLanes?: RouteLane[];
  /** Ribbon rail (x for E↔W, y for N↕S) assigned by the tidy pass (channel router). */
  preferRail?: number;
  /**
   * `channel` = escape-then-A* (tidy/commit). Default `pattern` = L/Z catalog
   * (rubber-band draw — cheap and stable while dragging).
   */
  router?: 'pattern' | 'channel';
}

/**
 * Infer pin exit direction: away from the component body center.
 * MOSFET gate (left of body) → W; drain (above) → N; chip left stack → W.
 * Near-corner stack pins prefer the side (H) exit so routes don't leave along
 * the package face into the body.
 * Returns null when the pin sits on the body center (no meaningful exit).
 */
export function pinExitDir(pinPos: Point, bodyPos: Point): RouteDir | null {
  const dx = pinPos.x - bodyPos.x;
  const dy = pinPos.y - bodyPos.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 0.5 && ay < 0.5) return null;
  if (ax >= ay) return dx >= 0 ? 'E' : 'W';
  // Corner of a side stack: still leave horizontally off the package edge.
  if (ax >= ay * 0.45) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

/**
 * Exit dir for routing, or null for isotropic nodes (junction / label) that
 * must not force an approach side — otherwise tidy creates overshoot loops.
 */
export function pinRouteDir(
  pinPos: Point,
  comp: { kind: string; pos: Point } | null | undefined,
): RouteDir | null {
  if (!comp) return null;
  if (comp.kind === 'junction' || comp.kind === 'label') return null;
  // Package pins sit only on the left and right stacks; guessing from the aspect of a tall
  // package would send its top and bottom pins out vertically along the pin column.
  if (comp.kind === 'chip' || comp.kind === 'ram' || comp.kind === 'rom') {
    const dx = pinPos.x - comp.pos.x;
    if (Math.abs(dx) >= 0.5) return dx > 0 ? 'E' : 'W';
  }
  return pinExitDir(pinPos, comp.pos);
}

function oppositeDir(d: RouteDir): RouteDir {
  return d === 'N' ? 'S' : d === 'S' ? 'N' : d === 'E' ? 'W' : 'E';
}

function segmentDir(a: Point, b: Point): RouteDir | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

function stepDir(p: Point, dir: RouteDir, dist: number): Point {
  switch (dir) {
    case 'N':
      return { x: p.x, y: p.y - dist };
    case 'S':
      return { x: p.x, y: p.y + dist };
    case 'E':
      return { x: p.x + dist, y: p.y };
    case 'W':
      return { x: p.x - dist, y: p.y };
  }
}

/** Orthogonal polyline between two points — single L-corner (schematic style). */
export function orthogonalPoints(a: Point, b: Point): Point[] {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return [a, b];
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (dx >= dy) return [a, { x: b.x, y: a.y }, b];
  return [a, { x: a.x, y: b.y }, b];
}

/**
 * Deterministic interior corners for a pin→pin wire (no maze / body avoid).
 * Facing comes from pin exit dirs; `lane` fans parallel exits by one GRID.
 * Returns waypoints only (excludes endpoints).
 */
export function orthoCorners(
  p1: Point,
  p2: Point,
  startDir: RouteDir | null,
  endDir: RouteDir | null,
  lane = 0,
): Point[] {
  const h1 = isHorizFacing(startDir, p1, p2);
  const h2 = isHorizFacing(endDir, p2, p1);
  const off = lane * GRID;
  if (h1 && h2) {
    const mx = Math.round(((p1.x + p2.x) / 2 + off) / GRID) * GRID;
    return [
      { x: mx, y: p1.y },
      { x: mx, y: p2.y },
    ];
  }
  if (!h1 && !h2) {
    const my = Math.round(((p1.y + p2.y) / 2 + off) / GRID) * GRID;
    return [
      { x: p1.x, y: my },
      { x: p2.x, y: my },
    ];
  }
  if (h1) {
    const x = Math.round((p2.x + off) / GRID) * GRID;
    return [
      { x, y: p1.y },
      { x, y: p2.y },
    ];
  }
  const y = Math.round((p2.y + off) / GRID) * GRID;
  return [
    { x: p1.x, y },
    { x: p2.x, y },
  ];
}

/** E/W = horizontal exit; unknown dirs fall back to the longer pin span. */
function isHorizFacing(dir: RouteDir | null, from: Point, to: Point): boolean {
  if (dir === 'E' || dir === 'W') return true;
  if (dir === 'N' || dir === 'S') return false;
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
}

/**
 * Lane index among wires that already touch `fromPinId` (0 = first bus mate).
 * Call before inserting the new wire so the count matches parallel-exit lane indexing.
 */
export function wireLaneOf(circuit: Circuit, fromPinId: string): number {
  let idx = 0;
  for (const w of circuit.wires.values()) {
    if (w.a === fromPinId || w.b === fromPinId) idx += 1;
  }
  return idx;
}

function hvPoints(a: Point, b: Point): Point[] {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return [a, b];
  return [a, { x: b.x, y: a.y }, b];
}

function vhPoints(a: Point, b: Point): Point[] {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return [a, b];
  return [a, { x: a.x, y: b.y }, b];
}

function hvhPoints(a: Point, b: Point, midX?: number): Point[] {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return [a, b];
  const mx = midX ?? (a.x + b.x) / 2;
  return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
}

function vhvPoints(a: Point, b: Point, midY?: number): Point[] {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return [a, b];
  const my = midY ?? (a.y + b.y) / 2;
  return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
}

function pathLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
  }
  return len;
}

function bendCount(pts: Point[]): number {
  return Math.max(0, pts.length - 2);
}

/** True if an axis-aligned segment crosses the interior of `box` (with padding). */
function segmentHitsAabb(a: Point, b: Point, box: Aabb, pad = 1): boolean {
  const minX = box.minX - pad;
  const maxX = box.maxX + pad;
  const minY = box.minY - pad;
  const maxY = box.maxY + pad;
  if (Math.abs(a.y - b.y) < 0.5) {
    const y = a.y;
    if (y <= minY || y >= maxY) return false;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return x0 < maxX && x1 > minX;
  }
  if (Math.abs(a.x - b.x) < 0.5) {
    const x = a.x;
    if (x <= minX || x >= maxX) return false;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return y0 < maxY && y1 > minY;
  }
  return false;
}

export function pathHitsObstacles(pts: Point[], obstacles: Aabb[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    for (const box of obstacles) {
      if (segmentHitsAabb(a, b, box)) return true;
    }
  }
  return false;
}

function countPathCrossings(path: Point[], others: Point[][]): number {
  if (!others.length || path.length < 2) return 0;
  return findWireCrossings([path, ...others]).length;
}

function dirPenalty(pts: Point[], startDir?: RouteDir | null, endDir?: RouteDir | null): number {
  let pen = 0;
  if (startDir && pts.length >= 2) {
    const d = segmentDir(pts[0]!, pts[1]!);
    if (d && d !== startDir) pen += 50;
  }
  if (endDir && pts.length >= 2) {
    const d = segmentDir(pts[pts.length - 2]!, pts[pts.length - 1]!);
    // Arrive into the pin from free space: travel opposite the pin's exit dir.
    if (d && d !== oppositeDir(endDir)) pen += 50;
  }
  return pen;
}

/**
 * Penalize trunks on the body side of the *destination* pin.
 * Left-stack (exit W): long verticals must stay at x <= pin.x - GRID (free space).
 * Right-stack (exit E): long verticals must stay at x >= pin.x + GRID.
 */
function sideKeepoutPenalty(pts: Point[], _startDir?: RouteDir | null, endDir?: RouteDir | null): number {
  if (pts.length < 2 || !endDir) return 0;
  let pen = 0;
  const clear = GRID;
  const end = pts[pts.length - 1]!;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span < clear - 0.5) continue; // ignore tiny stubs into the pin
    const vert = Math.abs(a.x - b.x) < 0.5;
    const horiz = Math.abs(a.y - b.y) < 0.5;
    if (vert) {
      const x = a.x;
      if (endDir === 'W' && x > end.x - clear + 0.5) pen += 80 + Math.max(0, x - (end.x - clear));
      if (endDir === 'E' && x < end.x + clear - 0.5) pen += 80 + Math.max(0, end.x + clear - x);
      if (endDir === 'N' && a.y > end.y - clear + 0.5) pen += 40;
      if (endDir === 'S' && a.y < end.y + clear - 0.5) pen += 40;
    }
    if (horiz) {
      const y = a.y;
      if (endDir === 'N' && y > end.y - clear + 0.5) pen += 80 + Math.max(0, y - (end.y - clear));
      if (endDir === 'S' && y < end.y + clear - 0.5) pen += 80 + Math.max(0, end.y + clear - y);
    }
  }
  // Last elbow must sit in free space outside the pin column.
  const pre = pts[pts.length - 2]!;
  if (endDir === 'W' && pre.x > end.x - clear + 0.5) pen += 120;
  if (endDir === 'E' && pre.x < end.x + clear - 0.5) pen += 120;
  if (endDir === 'N' && pre.y > end.y - clear + 0.5) pen += 120;
  if (endDir === 'S' && pre.y < end.y + clear - 0.5) pen += 120;
  return pen;
}

type PathScore = {
  hits: boolean;
  bends: number;
  len: number;
  cross: number;
  dir: number;
  overlap: number;
  along: number;
  /** Vertical/horizontal trunks that sit on the wrong side of a pin (through a body). */
  side: number;
};

function orthoOverlapLength(a0: Point, a1: Point, b0: Point, b1: Point): number {
  const aH = Math.abs(a0.y - a1.y) < 0.5;
  const bH = Math.abs(b0.y - b1.y) < 0.5;
  if (aH !== bH) return 0;
  if (aH) {
    if (Math.abs(a0.y - b0.y) > 0.5) return 0;
    const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
    const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
    return Math.max(0, hi - lo);
  }
  if (Math.abs(a0.x - b0.x) > 0.5) return 0;
  const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
  const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
  return Math.max(0, hi - lo);
}

/** Total colinear overlap length between `path` and `others`. */
export function pathOverlapLength(path: Point[], others: Point[][]): number {
  if (!others.length || path.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a0 = path[i]!;
    const a1 = path[i + 1]!;
    for (const other of others) {
      for (let j = 0; j < other.length - 1; j++) {
        total += orthoOverlapLength(a0, a1, other[j]!, other[j + 1]!);
      }
    }
  }
  return total;
}

function nearPoint(a: Point, b: Point, eps = 0.5): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

/**
 * Drop paths that share an endpoint with `from`/`to` (junction splices).
 * Those may legally occupy the same trunk; treating them as avoidOverlap
 * forces U-shaped overshoots around the node.
 */
export function excludePathsSharingEndpoint(
  paths: Point[][],
  from: Point,
  to: Point,
): Point[][] {
  return paths.filter((path) => {
    if (path.length < 1) return true;
    const a = path[0]!;
    const b = path[path.length - 1]!;
    return !(nearPoint(a, from) || nearPoint(a, to) || nearPoint(b, from) || nearPoint(b, to));
  });
}

/**
 * Approach lanes a pin→pin wire will need: from each pin, along its exit
 * axis, back to the midpoint of the pair. Earlier-routed wires that run along
 * these rows/columns force the later wire into a stair or a shared trunk.
 */
export function wireApproachLanes(
  a: Point,
  aDir: RouteDir | null | undefined,
  b: Point,
  bDir: RouteDir | null | undefined,
): RouteLane[] {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const out: RouteLane[] = [];
  for (const [pin, dir, other] of [
    [a, aDir, b],
    [b, bDir, a],
  ] as const) {
    if (!dir) continue;
    if (dir === 'E' || dir === 'W') {
      // Partner must lie ahead of the pin, else the exit row is not an approach.
      if ((other.x - pin.x) * (dir === 'E' ? 1 : -1) <= 0.5) continue;
      out.push({ axis: 'h', coord: pin.y, lo: Math.min(pin.x, mid.x), hi: Math.max(pin.x, mid.x) });
    } else {
      if ((other.y - pin.y) * (dir === 'S' ? 1 : -1) <= 0.5) continue;
      out.push({ axis: 'v', coord: pin.x, lo: Math.min(pin.y, mid.y), hi: Math.max(pin.y, mid.y) });
    }
  }
  return out;
}

function alongBonus(path: Point[], along: Point[][]): number {
  return pathOverlapLength(path, along);
}

/** Occupied vertical / horizontal trunk coordinates from existing routes. */
function occupiedTrunks(others: Point[][]): { xs: Set<number>; ys: Set<number> } {
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const path of others) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= GRID - 0.5) {
        xs.add(Math.round(a.x / GRID) * GRID);
      }
      if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) >= GRID - 0.5) {
        ys.add(Math.round(a.y / GRID) * GRID);
      }
    }
  }
  return { xs, ys };
}

function scorePath(
  cand: Point[],
  obstacles: Aabb[],
  opts: RouteOpts,
): PathScore {
  let overlap = opts.avoidOverlap?.length ? pathOverlapLength(cand, opts.avoidOverlap) : 0;
  const along = opts.preferAlong?.length ? alongBonus(cand, opts.preferAlong) : 0;
  if (along > 0) overlap = Math.max(0, overlap - along);
  return {
    hits: pathHitsObstacles(cand, obstacles),
    bends: bendCount(cand),
    len: pathLength(cand),
    cross: opts.avoidCrossings?.length ? countPathCrossings(cand, opts.avoidCrossings) : 0,
    dir: dirPenalty(cand, opts.startDir, opts.endDir),
    overlap,
    along,
    side: sideKeepoutPenalty(cand, opts.startDir, opts.endDir),
  };
}

function betterScore(a: PathScore, b: PathScore): boolean {
  if (a.hits !== b.hits) return !a.hits;
  // Through-body / wrong-side trunks first — readable pin approach.
  if (a.side !== b.side) return a.side < b.side;
  // Stacked trunks are worse than an extra bend (BUF8 pin-column VH problem).
  if (a.overlap !== b.overlap) return a.overlap < b.overlap;
  if (a.dir !== b.dir) return a.dir < b.dir;
  if (a.bends !== b.bends) return a.bends < b.bends;
  if (a.cross !== b.cross) return a.cross < b.cross;
  if (a.along !== b.along) return a.along > b.along;
  return a.len < b.len - 0.5;
}

function pickBestPath(candidates: Point[][], obstacles: Aabb[], opts: RouteOpts): Point[] {
  let best: Point[] | null = null;
  let bestSc: PathScore | null = null;
  for (const cand of candidates) {
    const sc = scorePath(cand, obstacles, opts);
    if (!best || !bestSc || betterScore(sc, bestSc)) {
      best = cand;
      bestSc = sc;
    }
  }
  return best ?? candidates[0]!;
}

/** Append L/Z pattern candidates between two points (and escape stubs). */
function collectPatternCandidates(a: Point, b: Point, opts: RouteOpts): Point[][] {
  const aligned = Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5;
  const candidates: Point[][] = [];
  const step = GRID;
  const trunks = opts.avoidOverlap?.length ? occupiedTrunks(opts.avoidOverlap) : null;

  if (aligned) {
    candidates.push([a, b]);
    if (Math.abs(a.y - b.y) < 0.5) {
      for (let k = 1; k <= 10; k++) {
        for (const sign of [1, -1] as const) {
          const my = a.y + sign * step * k;
          candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
        }
      }
    } else {
      for (let k = 1; k <= 10; k++) {
        for (const sign of [1, -1] as const) {
          const mx = a.x + sign * step * k;
          candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
        }
      }
    }
  } else {
    candidates.push(hvPoints(a, b), vhPoints(a, b));
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    candidates.push(hvhPoints(a, b, midX), vhvPoints(a, b, midY));
    for (let k = 1; k <= 10; k++) {
      for (const sign of [1, -1] as const) {
        candidates.push(hvhPoints(a, b, midX + sign * step * k));
        candidates.push(vhvPoints(a, b, midY + sign * step * k));
      }
    }
  }

  // Free mid-channels: when avoiding overlap, prefer trunks not already used.
  // Cap the scan so long spans stay cheap (tidy/commit only, but still).
  if (trunks) {
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const maxFree = 12;
    let addedX = 0;
    for (let k = 0; k <= 20 && addedX < maxFree; k++) {
      for (const sign of k === 0 ? [0] : ([1, -1] as const)) {
        if (k === 0 && sign !== 0) continue;
        const sx = Math.round((midX + sign * step * k) / step) * step;
        if (sx <= Math.min(a.x, b.x) || sx >= Math.max(a.x, b.x)) continue;
        if (trunks.xs.has(sx)) continue;
        if (Math.abs(sx - a.x) < 0.5 || Math.abs(sx - b.x) < 0.5) continue;
        candidates.push(hvhPoints(a, b, sx));
        addedX++;
        if (addedX >= maxFree) break;
      }
    }
    let addedY = 0;
    for (let k = 0; k <= 20 && addedY < maxFree; k++) {
      for (const sign of k === 0 ? [0] : ([1, -1] as const)) {
        if (k === 0 && sign !== 0) continue;
        const sy = Math.round((midY + sign * step * k) / step) * step;
        if (sy <= Math.min(a.y, b.y) || sy >= Math.max(a.y, b.y)) continue;
        if (trunks.ys.has(sy)) continue;
        if (Math.abs(sy - a.y) < 0.5 || Math.abs(sy - b.y) < 0.5) continue;
        candidates.push(vhvPoints(a, b, sy));
        addedY++;
        if (addedY >= maxFree) break;
      }
    }
    // Longer escape stubs so the vertical run sits off the pin column.
    for (const len of [step * 4, step * 5, step * 6]) {
      if (opts.startDir) {
        const s = stepDir(a, opts.startDir, len);
        candidates.push(simplifyOrthoPath([a, s, ...hvhPoints(s, b).slice(1)]));
        candidates.push(simplifyOrthoPath([a, s, ...vhPoints(s, b).slice(1)]));
      }
      if (opts.endDir) {
        const pre = stepDir(b, oppositeDir(opts.endDir), len);
        candidates.push(simplifyOrthoPath([...hvPoints(a, pre).slice(0, -1), pre, b]));
        candidates.push(simplifyOrthoPath([...vhPoints(a, pre).slice(0, -1), pre, b]));
      }
      if (opts.startDir && opts.endDir) {
        const s = stepDir(a, opts.startDir, len);
        const e = stepDir(b, opts.endDir, len);
        const mid = Math.round(((s.x + e.x) / 2) / step) * step;
        if (!trunks.xs.has(mid) && Math.abs(mid - a.x) > 0.5 && Math.abs(mid - b.x) > 0.5) {
          candidates.push(simplifyOrthoPath([a, s, { x: mid, y: s.y }, { x: mid, y: e.y }, e, b]));
        }
      }
    }
  }

  // Escape stubs: leave in startDir / approach via endDir, then L/Z.
  const stubLens = [GRID, GRID * 2, GRID * 3];
  if (opts.startDir) {
    for (const len of stubLens) {
      const s = stepDir(a, opts.startDir, len);
      for (const mid of [hvPoints(s, b), vhPoints(s, b)]) {
        candidates.push([a, ...mid.slice(1)]);
      }
    }
  }
  if (opts.endDir) {
    // Approach from free space: last stub sits opposite exit, then into pin.
    const approach = oppositeDir(opts.endDir);
    for (const len of stubLens) {
      const e = stepDir(b, opts.endDir, len); // out from pin along exit
      for (const mid of [hvPoints(a, e), vhPoints(a, e)]) {
        candidates.push([...mid.slice(0, -1), e, b]);
      }
      // Also: route to a point along approach side
      const pre = stepDir(b, approach, len);
      for (const mid of [hvPoints(a, pre), vhPoints(a, pre)]) {
        candidates.push([...mid.slice(0, -1), pre, b]);
      }
    }
  }
  if (opts.startDir && opts.endDir) {
    for (const len of stubLens) {
      const s = stepDir(a, opts.startDir, len);
      const e = stepDir(b, opts.endDir, len);
      candidates.push(simplifyOrthoPath([a, s, ...hvPoints(s, e).slice(1, -1), e, b]));
      candidates.push(simplifyOrthoPath([a, s, ...vhPoints(s, e).slice(1, -1), e, b]));
    }
  }

  return candidates;
}

function routeSegmentSmart(a: Point, b: Point, opts: RouteOpts): Point[] {
  const obstacles = opts.obstacles ?? [];

  if (opts.router === 'channel') {
    const channelled = routeEscapeChannel({
      from: a,
      to: b,
      obstacles,
      hostObstacles: opts.hostObstacles,
      startDir: opts.startDir,
      endDir: opts.endDir,
      avoidOverlap: opts.avoidOverlap,
      avoidCrossings: opts.avoidCrossings,
      preferAlong: opts.preferAlong,
      reservedLanes: opts.reservedLanes,
      preferRail: opts.preferRail,
    });
    // Trust the maze (it blocks inflated interiors). Do not re-check with the
    // pattern pad=1 hit test — pins sit on package edges and would false-positive.
    if (channelled.length >= 2) return simplifyOrthoPath(channelled);
  }

  const candidates = collectPatternCandidates(a, b, opts);
  let best = pickBestPath(candidates, obstacles, opts);
  // Pattern catalog failed to clear bodies → maze-route on the grid.
  if (obstacles.length > 0 && pathHitsObstacles(best, obstacles)) {
    const star = routeAStar(a, b, obstacles, GRID);
    if (star?.length) best = pickBestPath([best, star], obstacles, opts);
  }
  return simplifyOrthoPath(best);
}

/**
 * Orthogonal A* on a coarse GRID. Endpoints stay exact; interior corners
 * snap to the grid. Returns null when no path exists in the search window.
 */
export function routeAStar(
  a: Point,
  b: Point,
  obstacles: Aabb[],
  step: number = GRID,
): Point[] | null {
  const margin = step * 16;
  const minX = Math.floor((Math.min(a.x, b.x) - margin) / step) * step;
  const maxX = Math.ceil((Math.max(a.x, b.x) + margin) / step) * step;
  const minY = Math.floor((Math.min(a.y, b.y) - margin) / step) * step;
  const maxY = Math.ceil((Math.max(a.y, b.y) + margin) / step) * step;
  const cols = Math.floor((maxX - minX) / step) + 1;
  const rows = Math.floor((maxY - minY) / step) + 1;
  if (cols < 2 || rows < 2 || cols * rows > 12_000) return null;

  const blocked = new Uint8Array(cols * rows);
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const x = minX + ix * step;
      const y = minY + iy * step;
      for (const box of obstacles) {
        if (x > box.minX && x < box.maxX && y > box.minY && y < box.maxY) {
          blocked[iy * cols + ix] = 1;
          break;
        }
      }
    }
  }

  const clampCell = (p: Point): { ix: number; iy: number } => ({
    ix: Math.max(0, Math.min(cols - 1, Math.round((p.x - minX) / step))),
    iy: Math.max(0, Math.min(rows - 1, Math.round((p.y - minY) / step))),
  });
  const start = clampCell(a);
  const goal = clampCell(b);
  // Allow standing on endpoint cells even if they sit inside exclude-host boxes.
  blocked[start.iy * cols + start.ix] = 0;
  blocked[goal.iy * cols + goal.ix] = 0;

  const key = (ix: number, iy: number) => iy * cols + ix;
  const gScore = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const open: { ix: number; iy: number; f: number }[] = [];
  const startK = key(start.ix, start.iy);
  gScore[startK] = 0;
  open.push({
    ix: start.ix,
    iy: start.iy,
    f: Math.abs(goal.ix - start.ix) + Math.abs(goal.iy - start.iy),
  });

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  while (open.length) {
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[bestI]!.f) bestI = i;
    }
    const cur = open.splice(bestI, 1)[0]!;
    if (cur.ix === goal.ix && cur.iy === goal.iy) {
      const cells: Point[] = [];
      let k = key(cur.ix, cur.iy);
      while (k >= 0) {
        const ix = k % cols;
        const iy = (k / cols) | 0;
        cells.push({ x: minX + ix * step, y: minY + iy * step });
        k = came[k]!;
      }
      cells.reverse();
      // Exact endpoints + grid interior.
      const path = simplifyOrthoPath([a, ...cells.slice(1, -1), b]);
      if (!pathHitsObstacles(path, obstacles) || path.length >= 2) return path;
      return path;
    }
    const ck = key(cur.ix, cur.iy);
    for (const [dx, dy] of dirs) {
      const nix = cur.ix + dx;
      const niy = cur.iy + dy;
      if (nix < 0 || niy < 0 || nix >= cols || niy >= rows) continue;
      const nk = key(nix, niy);
      if (blocked[nk]) continue;
      const tent = gScore[ck]! + 1;
      if (tent >= gScore[nk]!) continue;
      came[nk] = ck;
      gScore[nk] = tent;
      const f = tent + Math.abs(goal.ix - nix) + Math.abs(goal.iy - niy);
      open.push({ ix: nix, iy: niy, f });
    }
  }
  return null;
}

/** Drop duplicate and strictly-between colinear interior points on an orthogonal polyline. */
export function simplifyOrthoPath(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [{ ...pts[0]! }];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = out[out.length - 1]!;
    if (Math.abs(p.x - prev.x) < 0.5 && Math.abs(p.y - prev.y) < 0.5) continue;
    out.push({ ...p });
  }
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      if (isStrictlyBetweenOnOrtho(a, b, c)) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pruneOrthoSpurs(out);
}

/**
 * Remove a→b→a reverse spurs (e.g. pin approach that overshoots then returns).
 * These show up as short "tails" with a waypoint knob next to the pin.
 */
export function pruneOrthoSpurs(pts: Point[]): Point[] {
  if (pts.length < 3) return pts;
  const out = pts.map((p) => ({ ...p }));
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 0; i < out.length - 2; i++) {
      const a = out[i]!;
      const c = out[i + 2]!;
      if (Math.abs(a.x - c.x) < 0.5 && Math.abs(a.y - c.y) < 0.5) {
        out.splice(i + 1, 2); // drop spur tip and duplicate return point
        changed = true;
        break;
      }
    }
  }
  // Collapse any new colinear runs without re-entering spur pruning.
  if (out.length <= 2) return out;
  const flat: Point[] = [{ ...out[0]! }];
  for (let i = 1; i < out.length; i++) {
    const p = out[i]!;
    const prev = flat[flat.length - 1]!;
    if (Math.abs(p.x - prev.x) < 0.5 && Math.abs(p.y - prev.y) < 0.5) continue;
    flat.push({ ...p });
  }
  let ch = true;
  while (ch && flat.length > 2) {
    ch = false;
    for (let i = 1; i < flat.length - 1; i++) {
      if (isStrictlyBetweenOnOrtho(flat[i - 1]!, flat[i]!, flat[i + 1]!)) {
        flat.splice(i, 1);
        ch = true;
        break;
      }
    }
  }
  return flat;
}

/** True when b is on the axis-aligned segment a–c (inclusive), not an overshoot past either end. */
function isStrictlyBetweenOnOrtho(a: Point, b: Point, c: Point): boolean {
  const sameX =
    Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5 && Math.abs(a.x - c.x) < 0.5;
  if (sameX) {
    const lo = Math.min(a.y, c.y);
    const hi = Math.max(a.y, c.y);
    return b.y >= lo - 0.5 && b.y <= hi + 0.5;
  }
  const sameY =
    Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5 && Math.abs(a.y - c.y) < 0.5;
  if (sameY) {
    const lo = Math.min(a.x, c.x);
    const hi = Math.max(a.x, c.x);
    return b.x >= lo - 0.5 && b.x <= hi + 0.5;
  }
  return false;
}

function normalizeRouteArg(obstaclesOrOpts?: Aabb[] | RouteOpts): RouteOpts {
  if (!obstaclesOrOpts) return {};
  if (Array.isArray(obstaclesOrOpts)) return { obstacles: obstaclesOrOpts };
  return obstaclesOrOpts;
}

/**
 * Expand explicit waypoints into an orthogonal path (each leg H or V).
 * Pass obstacles as `Aabb[]` (legacy) or `RouteOpts` for pin-exit-aware
 * pattern routing (L/Z + escape stubs, scored by bends / exit / crossings).
 */
export function routeWirePoints(raw: Point[], obstaclesOrOpts?: Aabb[] | RouteOpts): Point[] {
  if (raw.length < 2) return raw;
  const opts = normalizeRouteArg(obstaclesOrOpts);
  const hasSmart =
    (opts.obstacles?.length ?? 0) > 0 ||
    opts.startDir != null ||
    opts.endDir != null ||
    (opts.avoidCrossings?.length ?? 0) > 0 ||
    (opts.avoidOverlap?.length ?? 0) > 0 ||
    (opts.preferAlong?.length ?? 0) > 0 ||
    opts.router === 'channel';

  if (!hasSmart) {
    const out: Point[] = [raw[0]!];
    for (let i = 1; i < raw.length; i++) {
      const prev = out[out.length - 1]!;
      const next = raw[i]!;
      const seg = orthogonalPoints(prev, next);
      for (let j = 1; j < seg.length; j++) out.push(seg[j]!);
    }
    return simplifyOrthoPath(out);
  }

  // Single hop with full pin/obstacle context.
  if (raw.length === 2) {
    return routeSegmentSmart(raw[0]!, raw[1]!, opts);
  }

  // Multi-waypoint: smart only on first/last legs (pin exits); middle stays L.
  const out: Point[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1]!;
    const next = raw[i]!;
    const legOpts: RouteOpts = {
      obstacles: opts.obstacles,
      avoidCrossings: opts.avoidCrossings,
      startDir: i === 1 ? opts.startDir : null,
      endDir: i === raw.length - 1 ? opts.endDir : null,
    };
    const seg =
      legOpts.startDir || legOpts.endDir || (legOpts.obstacles?.length ?? 0) > 0
        ? routeSegmentSmart(prev, next, legOpts)
        : orthogonalPoints(prev, next);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]!);
  }
  return simplifyOrthoPath(out);
}


/**
 * Body AABBs of chips / RAM / ROM / buttons / 7seg for obstacle-aware routing.
 * Pass `excludeIds` for the wire's endpoint hosts so stubs may enter those bodies.
 */
/** Body AABBs of just `ids` — the endpoint hosts left out of `routingObstacles`. */
export function hostBodyObstacles(circuit: Circuit, ids: ReadonlySet<string>): Aabb[] {
  const others = new Set<string>();
  for (const id of circuit.components.keys()) if (!ids.has(id)) others.add(id);
  return routingObstacles(circuit, others);
}

export function routingObstacles(circuit: Circuit, excludeIds?: ReadonlySet<string>): Aabb[] {
  const out: Aabb[] = [];
  for (const c of circuit.components.values()) {
    if (excludeIds?.has(c.id)) continue;
    let hw: number;
    let hh: number;
    switch (c.kind) {
      case 'chip':
        hw = chipBodyWidth(c) / 2;
        hh = chipBoxHeight(c) / 2;
        break;
      case 'ram':
        hw = CHIP_INSTANCE_WIDTH / 2;
        hh = chipInstanceHeight(ramPortCount(c)) / 2;
        break;
      case 'rom':
        hw = CHIP_INSTANCE_WIDTH / 2;
        hh = chipInstanceHeight(romPortCount(c)) / 2;
        break;
      case 'button':
        hw = 17;
        hh = 15;
        break;
      case 'sevenseg':
        hw = 28;
        hh = 40;
        break;
      case 'clock':
        hw = 22;
        hh = 18;
        break;
      default:
        continue;
    }
    const inset = 2;
    out.push({
      minX: c.pos.x - hw + inset,
      minY: c.pos.y - hh + inset,
      maxX: c.pos.x + hw - inset,
      maxY: c.pos.y + hh - inset,
    });
  }
  return out;
}

/** H↔V crossings between orthogonal polylines (schematic junction dots). */
export function findWireCrossings(paths: Point[][]): Point[] {
  type Seg = { x1: number; y1: number; x2: number; y2: number; horiz: boolean };
  const segs: Seg[] = [];
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) continue;
      const horiz = Math.abs(a.y - b.y) < 0.5;
      segs.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        horiz,
      });
    }
  }
  const out: Point[] = [];
  const key = (p: Point) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const seen = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]!;
      const b = segs[j]!;
      if (a.horiz === b.horiz) continue;
      const h = a.horiz ? a : b;
      const v = a.horiz ? b : a;
      const y = h.y1;
      const x = v.x1;
      const hMinX = Math.min(h.x1, h.x2);
      const hMaxX = Math.max(h.x1, h.x2);
      const vMinY = Math.min(v.y1, v.y2);
      const vMaxY = Math.max(v.y1, v.y2);
      if (x <= hMinX + 0.5 || x >= hMaxX - 0.5) continue;
      if (y <= vMinY + 0.5 || y >= vMaxY - 0.5) continue;
      const p = { x, y };
      const k = key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/**
 * Solder dots for wires of one net: every point where three or more distinct
 * directions of same-net wire leave — a wire ending on another's run, or two
 * colinear wires parting ways. Pure H×V crossings (two directions each) and
 * plain corners never qualify. Cosmetic only; topology comes from the nets.
 */
export function findSameNetTees(paths: Point[][]): Point[] {
  if (paths.length < 2) return [];
  type Seg = { a: Point; b: Point };
  const vert = new Map<number, Seg[]>();
  const horiz = new Map<number, Seg[]>();
  const push = (map: Map<number, Seg[]>, key: number, seg: Seg) => {
    const list = map.get(key);
    if (list) list.push(seg);
    else map.set(key, [seg]);
  };
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) continue;
      if (Math.abs(a.x - b.x) < 0.5) push(vert, Math.round(a.x), { a, b });
      else if (Math.abs(a.y - b.y) < 0.5) push(horiz, Math.round(a.y), { a, b });
    }
  }
  const out: Point[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const p of path) {
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (seen.has(key)) continue;
      // Directions (bit 0..3 = N E S W) in which some same-net run leaves `p`.
      let dirs = 0;
      for (const s of vert.get(Math.round(p.x)) ?? []) {
        const lo = Math.min(s.a.y, s.b.y);
        const hi = Math.max(s.a.y, s.b.y);
        if (p.y < lo - 0.5 || p.y > hi + 0.5) continue;
        if (p.y > lo + 0.5) dirs |= 1; // run continues north of p
        if (p.y < hi - 0.5) dirs |= 4; // ... south
      }
      for (const s of horiz.get(Math.round(p.y)) ?? []) {
        const lo = Math.min(s.a.x, s.b.x);
        const hi = Math.max(s.a.x, s.b.x);
        if (p.x < lo - 0.5 || p.x > hi + 0.5) continue;
        if (p.x < hi - 0.5) dirs |= 2; // east
        if (p.x > lo + 0.5) dirs |= 8; // west
      }
      let count = 0;
      for (let bit = dirs; bit; bit &= bit - 1) count++;
      if (count < 3) continue;
      seen.add(key);
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

/** Nearest pin to `p` within `radius`, or undefined if none qualifies. */
export function findPinNear(circuit: Circuit, p: Point, radius = 10): Pin | undefined {
  let best: Pin | undefined;
  let bestDist = radius;
  for (const pin of circuit.allPins()) {
    const d = dist(pin.pos, p);
    if (d <= bestDist) {
      best = pin;
      bestDist = d;
    }
  }
  return best;
}

// Hit-targets are padded a few units past the drawn body on every side —
// a mouse (let alone a trackpad) is nowhere near pixel-precise, and a hit
// box that exactly matched the visual size (found by hand while chasing
// what looked like a broken drag: it wasn't, the click had just landed a
// few units outside a `source`'s tight 16x8 box) makes small parts
// frustrating to grab for a real click, not just an automated one.
const HIT_PAD = 6;

/** Half-width/half-height of a component's clickable area — a bit larger than Renderer.ts's drawn body, see HIT_PAD. */
function boundsHalfSize(c: Component): [number, number] {
  const [hw, hh] = ((): [number, number] => {
    switch (c.kind) {
      case 'chip':
        return [chipBodyWidth(c) / 2, chipBoxHeight(c) / 2];
      case 'ram':
        return [CHIP_INSTANCE_WIDTH / 2, chipInstanceHeight(ramPortCount(c)) / 2];
      case 'rom':
        return [CHIP_INSTANCE_WIDTH / 2, chipInstanceHeight(romPortCount(c)) / 2];
      case 'source':
        return [16, 8];
      case 'transistor':
        return [26, 28];
      case 'input':
      case 'button':
        return [14, 12];
      case 'clock':
        return [22, 16];
      case 'analyzer':
        return [32, Math.max(20, ((c.channelCount - 1) * 20 + 28) / 2)];
      case 'busprobe':
        return [42, Math.max(20, ((c.bitWidth - 1) * 20 + 28) / 2)];
      case 'busswitch':
        return [52, Math.max(20, ((c.bitWidth - 1) * 20 + 28) / 2)];
      case 'buspass':
        return [BUS_PASS_BODY_W / 2 + 4, Math.max(20, ((c.bitWidth - 1) * 20 + 28) / 2)];
      case 'switch':
        return [20, 12];
      case 'tty':
        return [36, 22];
      case 'probe':
      case 'led':
      case 'port':
      case 'junction':
        return [12, 12];
      case 'label':
        return [28, 14];
      case 'sevenseg':
        return [22, 30];
      default:
        return [14, 14];
    }
  })();
  return [hw + HIT_PAD, hh + HIT_PAD];
}

/**
 * Pins sit on a part's outline, so wires leave it from within the hit box. `p` counts as inside
 * the body only when it is well clear of the outline, so a wire near a pin is not mistaken for the part.
 */
const BODY_INSET = HIT_PAD + 8;

export function insideBody(c: Component, p: Point): boolean {
  const [hw, hh] = boundsHalfSize(c);
  return Math.abs(c.pos.x - p.x) <= hw - BODY_INSET && Math.abs(c.pos.y - p.y) <= hh - BODY_INSET;
}

/** Component whose drawn body contains `p`. */
export function findComponentNear(circuit: Circuit, p: Point) {
  for (const c of circuit.components.values()) {
    const [hw, hh] = boundsHalfSize(c);
    if (Math.abs(c.pos.x - p.x) <= hw && Math.abs(c.pos.y - p.y) <= hh) return c;
  }
  return undefined;
}

/** How far inward from each pin the DIP paddle sits (along the pin-side axis). */
export const BUS_SWITCH_PADDLE_INSET = 20;

export { BUS_SWITCH_BODY_W };

/**
 * Average outward direction of the pin bank (body center → pins).
 * Used so paddles stay on each pin's row under rotate/mirror.
 */
export function busSwitchSideUnit(c: BusSwitchComponent): Point {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < c.bitWidth; i++) {
    const p = c.pins[`b${i}`];
    if (!p) continue;
    sx += p.pos.x - c.pos.x;
    sy += p.pos.y - c.pos.y;
    n++;
  }
  if (n === 0) return { x: 1, y: 0 };
  sx /= n;
  sy /= n;
  const len = Math.hypot(sx, sy) || 1;
  return { x: sx / len, y: sy / len };
}

/**
 * World-space center of DIP paddle for bit `i` — same stack row as the pin,
 * inset toward the package (not lerped toward body center, which used to
 * squash all paddles into the middle).
 */
export function busSwitchPaddleCenter(c: BusSwitchComponent, bit: number): Point | null {
  const pin = c.pins[`b${bit}`];
  if (!pin) return null;
  const u = busSwitchSideUnit(c);
  return {
    x: pin.pos.x - u.x * BUS_SWITCH_PADDLE_INSET,
    y: pin.pos.y - u.y * BUS_SWITCH_PADDLE_INSET,
  };
}

/**
 * Which DIP bit paddle contains `p`, or null if the click is on the readout /
 * package body but not a paddle.
 */
export function busSwitchBitAt(c: BusSwitchComponent, p: Point, radius = 10): number | null {
  let best: number | null = null;
  let bestD = radius;
  for (let i = 0; i < c.bitWidth; i++) {
    const center = busSwitchPaddleCenter(c, i);
    if (!center) continue;
    const d = dist(p, center);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** World-space center of bus-pass paddle for pole `i` (midway aᵢ→bᵢ). */
export function busPassPaddleCenter(c: BusPassComponent, bit: number): Point | null {
  const a = c.pins[`a${bit}`];
  const b = c.pins[`b${bit}`];
  if (!a || !b) return null;
  return { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
}

/** Which bus-pass pole paddle contains `p`, or null. */
export function busPassBitAt(c: BusPassComponent, p: Point, radius = 10): number | null {
  let best: number | null = null;
  let bestD = radius;
  for (let i = 0; i < c.bitWidth; i++) {
    const center = busPassPaddleCenter(c, i);
    if (!center) continue;
    const d = dist(p, center);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Stored wire polyline (pin → waypoints → pin), before orthogonal expansion. */
export function rawWirePolyline(circuit: Circuit, wire: Wire): Point[] | undefined {
  const pinById = new Map<string, Point>();
  for (const p of circuit.allPins()) pinById.set(p.id, p.pos);
  const a = pinById.get(wire.a);
  const b = pinById.get(wire.b);
  if (!a || !b) return undefined;
  return wire.waypoints && wire.waypoints.length ? [a, ...wire.waypoints, b] : [a, b];
}

/** Drawn wire polyline — orthogonalized to match Renderer. */
export function wirePolyline(circuit: Circuit, wire: Wire): Point[] | undefined {
  const raw = rawWirePolyline(circuit, wire);
  return raw ? routeWirePoints(raw) : undefined;
}

/** Shortest distance from `p` to the segment a-b (0 when `p` projects outside the segment, clamped to an endpoint). */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Project `p` onto segment a–b; returns point + param t∈[0,1]. */
export function projectOntoSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { point: { x: a.x, y: a.y }, t: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** Nearest point on a polyline within `maxDist`, or null. */
export function nearestOnPolyline(
  poly: Point[],
  p: Point,
  maxDist: number,
): { point: Point; segIndex: number } | null {
  let best: { point: Point; segIndex: number; d: number } | null = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const { point, t: _t } = projectOntoSegment(p, poly[i]!, poly[i + 1]!);
    const d = dist(p, point);
    if (d <= maxDist && (!best || d < best.d)) best = { point, segIndex: i, d };
  }
  return best ? { point: best.point, segIndex: best.segIndex } : null;
}

/** Drop consecutive near-duplicates; return interior points (exclude endpoints). */
export function interiorWaypoints(poly: Point[]): Point[] {
  if (poly.length <= 2) return [];
  const cleaned: Point[] = [{ ...poly[0]! }];
  for (let i = 1; i < poly.length; i++) {
    const p = poly[i]!;
    const prev = cleaned[cleaned.length - 1]!;
    if (Math.abs(p.x - prev.x) < 0.5 && Math.abs(p.y - prev.y) < 0.5) continue;
    cleaned.push({ x: p.x, y: p.y });
  }
  if (cleaned.length <= 2) return [];
  return cleaned.slice(1, -1).map((q) => ({ x: q.x, y: q.y }));
}

/** Nearest *existing* bend point to `p` (a pin endpoint never counts), for grabbing one to drag. */
export function findWaypointNear(circuit: Circuit, p: Point, radius = 8): { wireId: string; index: number } | undefined {
  let best: { wireId: string; index: number } | undefined;
  let bestDist = radius;
  for (const w of circuit.wires.values()) {
    if (!w.waypoints) continue;
    w.waypoints.forEach((wp, index) => {
      const d = dist(wp, p);
      if (d <= bestDist) {
        best = { wireId: w.id, index };
        bestDist = d;
      }
    });
  }
  return best;
}

/**
 * Nearest wire *segment* to `p` within `radius`. Hit-tests the drawn
 * orthogonal path, but `insertIndex` indexes the stored waypoint list
 * (segment i of pin→waypoints→pin), so a drag still inserts a real bend.
 */
export function findWireNear(
  circuit: Circuit,
  p: Point,
  radius = 6,
  only?: ReadonlySet<string>,
): { wireId: string; insertIndex: number } | undefined {
  let best: { wireId: string; insertIndex: number } | undefined;
  let bestDist = radius;
  for (const w of circuit.wires.values()) {
    if (only && !only.has(w.id)) continue;
    const raw = rawWirePolyline(circuit, w);
    if (!raw) continue;
    for (let i = 0; i < raw.length - 1; i++) {
      const ortho = orthogonalPoints(raw[i]!, raw[i + 1]!);
      for (let j = 0; j < ortho.length - 1; j++) {
        const d = distanceToSegment(p, ortho[j]!, ortho[j + 1]!);
        if (d <= bestDist) {
          best = { wireId: w.id, insertIndex: i };
          bestDist = d;
        }
      }
    }
  }
  return best;
}

/** True when a net/pin name looks like a bus (`D[7:0]`, `label:D[7:0]`, …). */
export function isBusName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\[[^\]]+\]/.test(name);
}
