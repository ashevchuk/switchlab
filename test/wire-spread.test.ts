import { describe, expect, it } from 'vitest';
import type { Point } from '../src/sim/types.js';
import { findOverlaps, spreadOverlaps } from '../src/ui/wireSpread.js';

const wireAt = (x: number, y0: number, y1: number): Point[] => [
  { x: 0, y: y0 },
  { x, y: y0 },
  { x, y: y1 },
  { x: 300, y: y1 },
];

describe('spreadOverlaps', () => {
  const never = () => false;

  it('sets two wires that share a vertical lane side by side, centred on it', () => {
    const paths = new Map([
      ['a', wireAt(100, 0, 100)],
      ['b', wireAt(100, 20, 120)],
    ]);
    expect(findOverlaps(paths, never).length).toBe(1);
    const { moved, remaining } = spreadOverlaps(paths, never);
    expect(remaining).toBe(0);
    const xs = ['a', 'b'].map((id) => (moved.get(id) ?? paths.get(id)!)[1]!.x).sort((p, q) => p - q);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(10);
    expect((xs[0]! + xs[1]!) / 2).toBe(100);
  });

  it('keeps every moved path orthogonal and attached to its pins', () => {
    const paths = new Map([
      ['a', wireAt(100, 0, 100)],
      ['b', wireAt(103, 20, 120)],
      ['c', wireAt(97, 40, 140)],
    ]);
    const { moved } = spreadOverlaps(paths, never);
    for (const [id, path] of moved) {
      const orig = paths.get(id)!;
      expect(path[0]).toEqual(orig[0]);
      expect(path[path.length - 1]).toEqual(orig[orig.length - 1]);
      for (let i = 0; i < path.length - 1; i++) {
        expect(path[i]!.x === path[i + 1]!.x || path[i]!.y === path[i + 1]!.y).toBe(true);
      }
    }
  });

  it('leaves wires of the same net alone', () => {
    const paths = new Map([
      ['a', wireAt(100, 0, 100)],
      ['b', wireAt(100, 20, 120)],
    ]);
    expect(spreadOverlaps(paths, () => true).moved.size).toBe(0);
  });

  it('does nothing when wires are already a gap apart', () => {
    const paths = new Map([
      ['a', wireAt(100, 0, 100)],
      ['b', wireAt(120, 20, 120)],
    ]);
    expect(spreadOverlaps(paths, never).moved.size).toBe(0);
  });
});

describe('Editor.separateWires', () => {
  it('moves wires of different nets apart and marks them manual', async () => {
    const { Circuit } = await import('../src/sim/Circuit.js');
    const { ChipLibrary } = await import('../src/sim/ChipLibrary.js');
    const { makeLed, makeTransistor } = await import('../src/sim/library.js');
    const { Editor } = await import('../src/ui/Editor.js');
    const { wirePolyline } = await import('../src/ui/geometry.js');
    const circuit = new Circuit();
    const editor = new Editor(circuit, new ChipLibrary());
    const t1 = makeTransistor(circuit, 'N', { x: 0, y: 0 });
    const t2 = makeTransistor(circuit, 'N', { x: 0, y: 200 });
    const l1 = makeLed(circuit, { x: 300, y: -120 });
    const l2 = makeLed(circuit, { x: 400, y: -120 });
    const w1 = circuit.addWire(t1.pins.drain.id, l1.pins.in.id, [
      { x: 100, y: t1.pins.drain.pos.y },
      { x: 100, y: -120 },
    ]);
    const w2 = circuit.addWire(t2.pins.drain.id, l2.pins.in.id, [
      { x: 100, y: t2.pins.drain.pos.y },
      { x: 100, y: -120 },
    ]);
    expect(editor.separateWires()).toBeGreaterThan(0);
    const x1 = wirePolyline(circuit, w1)![1]!.x;
    const x2 = wirePolyline(circuit, w2)![1]!.x;
    expect(Math.abs(x1 - x2)).toBeGreaterThanOrEqual(10);
    expect(w1.manual || w2.manual).toBe(true);
  });
});
