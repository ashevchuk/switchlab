/**
 * Sets wires that run side by side, closer than a gap, apart. Works on drawn orthogonal
 * paths; only interior legs move (the leg at a pin is shared by every wire leaving it).
 */
import type { Point } from '../sim/types.js';
import { simplifyOrthoPath } from './geometry.js';
import { WIRE_GAP } from './laneSnap.js';
import { dragSegment } from './wireEdit.js';

const CLOSER_THAN = WIRE_GAP - 1;
const MIN_SHARED = 6;
const LEAVE = 0.5;
const MAX_PASSES = 80;

interface Piece {
  wire: string;
  leg: number;
  range: [number, number];
  /** x of a vertical leg, y of a horizontal one. */
  at: number;
  vertical: boolean;
}

function interiorPieces(wire: string, path: Point[]): Piece[] {
  const pieces: Piece[] = [];
  for (let leg = 1; leg <= path.length - 3; leg++) {
    const a = path[leg]!;
    const b = path[leg + 1]!;
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const range: [number, number] = vertical
      ? [Math.min(a.y, b.y), Math.max(a.y, b.y)]
      : [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    pieces.push({ wire, leg, range, at: vertical ? a.x : a.y, vertical });
  }
  return pieces;
}

type Overlap = [Piece, Piece];

export function findOverlaps(
  paths: Map<string, Point[]>,
  sameNet: (a: string, b: string) => boolean,
): Overlap[] {
  const pieces = [...paths].flatMap(([wire, path]) => interiorPieces(wire, simplifyOrthoPath(path)));
  const found: Overlap[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const p = pieces[i]!;
      const q = pieces[j]!;
      if (p.wire === q.wire || p.vertical !== q.vertical || sameNet(p.wire, q.wire)) continue;
      if (Math.abs(p.at - q.at) > CLOSER_THAN) continue;
      if (Math.min(p.range[1], q.range[1]) - Math.max(p.range[0], q.range[0]) < MIN_SHARED) continue;
      found.push([p, q]);
    }
  }
  return found;
}

function groupOf(first: Overlap, overlaps: Overlap[]): Piece[] {
  const key = (p: Piece) => `${p.wire}#${p.leg}`;
  const members = new Map([
    [key(first[0]), first[0]],
    [key(first[1]), first[1]],
  ]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, q] of overlaps) {
      if (p.vertical !== first[0].vertical) continue;
      if (members.has(key(p)) !== members.has(key(q))) {
        members.set(key(p), p);
        members.set(key(q), q);
        grew = true;
      }
    }
  }
  return [...members.values()];
}

/** New drawn path for every wire that had to move, and how many overlaps could not be resolved. */
export function spreadOverlaps(
  paths: Map<string, Point[]>,
  sameNet: (a: string, b: string) => boolean,
): { moved: Map<string, Point[]>; remaining: number } {
  const current = new Map([...paths].map(([id, p]) => [id, simplifyOrthoPath(p)]));
  const moved = new Map<string, Point[]>();
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const overlaps = findOverlaps(current, sameNet);
    if (overlaps.length === 0) break;
    const group = groupOf(overlaps[0]!, overlaps).sort(
      (p, q) => p.at - q.at || p.range[0] - q.range[0] || p.wire.localeCompare(q.wire),
    );
    const centre = group.reduce((sum, p) => sum + p.at, 0) / group.length;
    const before = new Map(current);
    const movedBefore = new Map(moved);
    const touched = new Set<string>();
    group.forEach((piece, i) => {
      if (touched.has(piece.wire)) return;
      const value = centre + (i - (group.length - 1) / 2) * WIRE_GAP;
      if (Math.abs(piece.at - value) < LEAVE) return;
      const path = current.get(piece.wire)!;
      const target = piece.vertical ? { x: value, y: 0 } : { x: 0, y: value };
      const next = dragSegment(path, piece.leg, target);
      current.set(piece.wire, next);
      moved.set(piece.wire, next);
      touched.add(piece.wire);
    });
    if (findOverlaps(current, sameNet).length >= overlaps.length) {
      for (const [id, path] of before) current.set(id, path);
      moved.clear();
      for (const [id, path] of movedBefore) moved.set(id, path);
      break;
    }
  }
  return { moved, remaining: findOverlaps(current, sameNet).length };
}
