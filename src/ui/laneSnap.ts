/**
 * Where a dragged wire leg or corner may settle: a gap beside a component body, a gap
 * beside another wire (never on it, which would glue the two together), a pin's own
 * row or column, and the grid. Pure helpers; the editor supplies pixel tolerance.
 */
import type { Point } from '../sim/types.js';
import { GRID, type Aabb } from './geometry.js';

export type Axis = 'x' | 'y';

export interface SnapTarget {
  value: number;
  kind: 'grid' | 'body' | 'wire' | 'pin';
}

export const BODY_GAP = GRID;
export const WIRE_GAP = GRID;

/** How much closer than the grid a body/wire/pin target must be to win over it. */
const PREFERENCE = 2.5;

export function laneTargets(axis: Axis, obstacles: Aabb[], otherPaths: Point[][], pins: Point[]): SnapTarget[] {
  const targets: SnapTarget[] = [];
  for (const o of obstacles) {
    const [lo, hi] = axis === 'x' ? [o.minX, o.maxX] : [o.minY, o.maxY];
    targets.push({ value: lo - BODY_GAP, kind: 'body' }, { value: hi + BODY_GAP, kind: 'body' });
  }
  for (const path of otherPaths) {
    // Interior legs only: legs at a pin are shared by every wire leaving it.
    for (let i = 1; i < path.length - 2; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const vertical = Math.abs(a.x - b.x) < 0.5;
      if ((axis === 'x') !== vertical) continue;
      const value = axis === 'x' ? a.x : a.y;
      targets.push({ value: value - WIRE_GAP, kind: 'wire' }, { value: value + WIRE_GAP, kind: 'wire' });
    }
  }
  for (const p of pins) targets.push({ value: axis === 'x' ? p.x : p.y, kind: 'pin' });
  return targets;
}

/** `gridStep` null means free placement: only targets within tolerance pull the value. */
export function snapLane(
  value: number,
  targets: SnapTarget[],
  tolerance: number,
  gridStep: number | null,
): { value: number; target?: SnapTarget } {
  let best: { target: SnapTarget; distance: number } | undefined;
  for (const target of targets) {
    const distance = Math.abs(target.value - value);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { target, distance };
  }
  if (gridStep === null) return best ? { value: best.target.value, target: best.target } : { value };
  const grid = Math.round(value / gridStep) * gridStep;
  if (best && best.distance <= Math.abs(grid - value) + PREFERENCE) {
    return { value: best.target.value, target: best.target };
  }
  return { value: grid, target: { value: grid, kind: 'grid' } };
}
