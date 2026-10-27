/**
 * Orthogonality-preserving edits of a drawn wire path (pin → corners → pin).
 * Pure functions: the caller keeps the path captured at drag start and passes
 * the snapped cursor on every move, so repeated calls never accumulate drift.
 */
import type { Point } from '../sim/types.js';
import { GRID, simplifyOrthoPath } from './geometry.js';

const EPS = 0.5;
const PIN_STUB = GRID * 2;

type Axis = 'h' | 'v';

function legAxis(a: Point, b: Point): Axis | null {
  if (Math.abs(a.y - b.y) < EPS && Math.abs(a.x - b.x) >= EPS) return 'h';
  if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) >= EPS) return 'v';
  return null;
}

/** Drop vertices where a leg runs past its own end and doubles back along the same line. */
export function dropReversals(path: Point[]): Point[] {
  const out = path.map((p) => ({ ...p }));
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      const sameX = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS;
      const sameY = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
      if (sameX || sameY) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Split the first and last leg so the part touching a pin stays put (keeping the
 * pin's exit direction) and a movable copy of the vertex sits right behind it.
 * Returns the extended path; original vertex `i` lives at index `i + 2`.
 */
function freeEnds(path: Point[]): Point[] {
  const n = path.length;
  const first = path[0]!;
  const second = path[1]!;
  const last = path[n - 1]!;
  const beforeLast = path[n - 2]!;
  const stubFrom = (pin: Point, toward: Point): Point => {
    const len = Math.hypot(toward.x - pin.x, toward.y - pin.y);
    const k = len === 0 ? 0 : Math.min(PIN_STUB, len / 2) / len;
    return { x: pin.x + (toward.x - pin.x) * k, y: pin.y + (toward.y - pin.y) * k };
  };
  const s = stubFrom(first, second);
  const t = stubFrom(last, beforeLast);
  return [first, s, { ...s }, ...path.slice(1, n - 1), { ...t }, t, last];
}

/**
 * Slide the leg `legIndex` (between `path[legIndex]` and `path[legIndex + 1]`)
 * perpendicular to itself so it passes through `target`. Neighbouring legs
 * stretch; a leg touching a pin grows a short jog so the pin exit is kept.
 */
export function dragSegment(path: Point[], legIndex: number, target: Point): Point[] {
  if (path.length < 2) return path;
  const w = freeEnds(path).map((p) => ({ ...p }));
  const j = legIndex + 2;
  const a = w[j]!;
  const b = w[j + 1]!;
  const axis = legAxis(a, b);
  if (!axis) return path;
  if (axis === 'h') a.y = b.y = target.y;
  else a.x = b.x = target.x;
  return dropReversals(simplifyOrthoPath(w));
}

/**
 * Move the interior corner `vertexIndex` to `target`; the two legs meeting there
 * stay axis-aligned by dragging their far ends' shared coordinate along.
 */
export function dragCorner(path: Point[], vertexIndex: number, target: Point): Point[] {
  if (vertexIndex < 1 || vertexIndex > path.length - 2) return path;
  const w = freeEnds(path).map((p) => ({ ...p }));
  const v = vertexIndex + 2;
  const prev = w[v - 1]!;
  const cur = w[v]!;
  const next = w[v + 1]!;
  let prevAxis = legAxis(prev, cur);
  let nextAxis = legAxis(cur, next);
  if (!prevAxis && !nextAxis) return path;
  if (!prevAxis) prevAxis = nextAxis === 'h' ? 'v' : 'h';
  if (!nextAxis) nextAxis = prevAxis === 'h' ? 'v' : 'h';
  if (prevAxis === nextAxis) return path;
  if (prevAxis === 'h') prev.y = target.y;
  else prev.x = target.x;
  if (nextAxis === 'h') next.y = target.y;
  else next.x = target.x;
  cur.x = target.x;
  cur.y = target.y;
  return dropReversals(simplifyOrthoPath(w));
}

/** Index of the leg of `path` nearest to `p`. */
export function nearestLeg(path: Point[], p: Point): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Index of the interior vertex of `path` nearest to `p`, or -1 for a straight wire. */
export function nearestCorner(path: Point[], p: Point): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 1; i < path.length - 1; i++) {
    const d = Math.hypot(path[i]!.x - p.x, path[i]!.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
