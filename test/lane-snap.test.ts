import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeLed, makeTransistor } from '../src/sim/library.js';
import { Editor } from '../src/ui/Editor.js';
import { laneTargets, snapLane } from '../src/ui/laneSnap.js';

describe('snapLane', () => {
  const other = [
    [
      { x: 0, y: 0 },
      { x: 105, y: 0 },
      { x: 105, y: 80 },
      { x: 200, y: 80 },
    ],
  ];

  it('offers a gap on each side of another wire but never its own line', () => {
    const values = laneTargets('x', [], other, []).map((t) => t.value);
    expect(values).toEqual([95, 115]);
  });

  it('beats the grid when closer to a gap target than to a grid line', () => {
    const targets = laneTargets('x', [], other, []);
    const r = snapLane(97, targets, 6, 10);
    expect(r.value).toBe(95);
    expect(r.target?.kind).toBe('wire');
  });

  it('falls back to the grid when no target is in reach', () => {
    expect(snapLane(43, laneTargets('x', [], other, []), 6, 10)).toEqual({
      value: 40,
      target: { value: 40, kind: 'grid' },
    });
  });

  it('leaves the value alone in free mode when nothing is in reach', () => {
    expect(snapLane(43, [], 6, null)).toEqual({ value: 43 });
  });

  it('puts a lane a gap outside a body', () => {
    const values = laneTargets('y', [{ minX: 0, minY: 20, maxX: 50, maxY: 60 }], [], []).map((t) => t.value);
    expect(values).toEqual([10, 70]);
  });
});

function twoLeds() {
  const circuit = new Circuit();
  const editor = new Editor(circuit, new ChipLibrary());
  const t = makeTransistor(circuit, 'N', { x: 0, y: 0 });
  const led = makeLed(circuit, { x: 300, y: -120 });
  const y = t.pins.drain.pos.y;
  const wire = circuit.addWire(t.pins.drain.id, led.pins.in.id, [
    { x: 40, y },
    { x: 40, y: -120 },
  ]);
  editor.selectedWireId = wire.id;
  return { circuit, editor, wire, midY: (y - 120) / 2 };
}

describe('dragging a wire leg', () => {
  it('moves by the distance dragged, not to the cursor (no jump on grab)', () => {
    const { editor, wire, midY } = twoLeds();
    editor.snapMode = 'free';
    editor.worldPerPixel = 0.001;
    const grab = { x: 43, y: midY };
    const to = { x: 63, y: midY };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    const xs = wire.waypoints!.map((p) => p.x);
    expect(xs).toContain(60);
    expect(xs).not.toContain(63);
  });

  it('settles a gap away from another wire and shows a guide', () => {
    const { circuit, editor, wire, midY } = twoLeds();
    const ledB = makeLed(circuit, { x: 400, y: -120 });
    const t2 = makeTransistor(circuit, 'N', { x: 0, y: 200 });
    circuit.addWire(t2.pins.drain.id, ledB.pins.in.id, [
      { x: 105, y: t2.pins.drain.pos.y },
      { x: 105, y: -120 },
    ]);
    editor.worldPerPixel = 1;
    const grab = { x: 40, y: midY };
    const to = { x: 97, y: midY };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    expect(editor.wireGuide).toEqual({ axis: 'x', value: 95 });
    editor.handleMouseUp(to, false);
    expect(wire.waypoints!.map((p) => p.x)).toContain(95);
    expect(editor.wireGuide).toBeNull();
  });

  it('Escape puts the wire back as it was grabbed', () => {
    const { editor, wire, midY } = twoLeds();
    const before = JSON.stringify(wire.waypoints);
    editor.handleMouseDown({ x: 40, y: midY });
    editor.handleMouseDrag({ x: 90, y: midY });
    expect(JSON.stringify(wire.waypoints)).not.toBe(before);
    expect(editor.cancelWireDrag()).toBe(true);
    expect(JSON.stringify(wire.waypoints)).toBe(before);
    expect(wire.manual).toBeUndefined();
  });
});
