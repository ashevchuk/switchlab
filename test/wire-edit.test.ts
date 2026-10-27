import { describe, expect, it } from 'vitest';
import counterLab from '../examples/lab-counter-7seg.json';
import type { Point } from '../src/sim/types.js';
import { deserializeProject } from '../src/sim/serialize.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeLed, makeTransistor } from '../src/sim/library.js';
import { Editor } from '../src/ui/Editor.js';
import { findComponentNear, pathHitsObstacles, routingObstacles, wirePolyline } from '../src/ui/geometry.js';
import { cleanRoute, dragCorner, dragSegment } from '../src/ui/wireEdit.js';

function isOrtho(path: Point[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) return false;
  }
  return true;
}

// pin(0,0) → east → down → east → pin(100,60)
const Z: Point[] = [
  { x: 0, y: 0 },
  { x: 50, y: 0 },
  { x: 50, y: 60 },
  { x: 100, y: 60 },
];

describe('dragSegment / dragCorner', () => {
  it('slides the middle leg sideways and keeps both pins', () => {
    const out = dragSegment(Z, 1, { x: 70, y: 30 });
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 70, y: 0 },
      { x: 70, y: 60 },
      { x: 100, y: 60 },
    ]);
  });

  it('keeps the pin exit direction when the leg touching the pin is dragged', () => {
    const out = dragSegment(Z, 0, { x: 30, y: 20 });
    expect(isOrtho(out)).toBe(true);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[1]!.y).toBe(0);
    expect(out[1]!.x).toBeGreaterThan(0);
    expect(out.some((p) => p.y === 20)).toBe(true);
    expect(out[out.length - 1]).toEqual({ x: 100, y: 60 });
  });

  it('returns the original path when the leg is dragged back', () => {
    expect(dragSegment(Z, 0, { x: 30, y: 0 })).toEqual(Z);
    expect(dragSegment(Z, 1, { x: 50, y: 30 })).toEqual(Z);
  });

  it('turns a straight pin-to-pin wire into a jog without moving either pin', () => {
    const straight: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const out = dragSegment(straight, 0, { x: 50, y: 20 });
    expect(isOrtho(out)).toBe(true);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 100, y: 0 });
    expect(out.some((p) => p.y === 20)).toBe(true);
  });

  it('drags a corner while both legs stay axis-aligned', () => {
    const out = dragCorner(Z, 1, { x: 70, y: 0 });
    expect(isOrtho(out)).toBe(true);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 100, y: 60 });
    expect(out.some((p) => p.x === 70)).toBe(true);
  });

  it('keeps legs orthogonal for every corner target on a grid sweep', () => {
    for (let x = -20; x <= 120; x += 10) {
      for (let y = -20; y <= 80; y += 10) {
        for (const i of [1, 2]) {
          const out = dragCorner(Z, i, { x, y });
          expect(isOrtho(out), `corner ${i} -> ${x},${y}`).toBe(true);
          expect(out[0]).toEqual({ x: 0, y: 0 });
          expect(out[out.length - 1]).toEqual({ x: 100, y: 60 });
        }
        const seg = dragSegment(Z, 1, { x, y });
        expect(isOrtho(seg), `segment -> ${x},${y}`).toBe(true);
      }
    }
  });
});

function loadEditor() {
  const { topCircuit, library } = deserializeProject(
    structuredClone(counterLab) as Parameters<typeof deserializeProject>[0],
  );
  const editor = new Editor(topCircuit, library);
  editor.tidyAllWires(false);
  return { circuit: topCircuit, editor };
}

function wireWithBends(editor: Editor) {
  const circuit = editor.circuit;
  for (const w of circuit.wires.values()) {
    const path = wirePolyline(circuit, w);
    if (path && path.length >= 4) return { wire: w, path };
  }
  throw new Error('no wire with a middle leg in the example');
}

describe('editing a drawn wire in the editor', () => {
  it('dragging a segment keeps the wire orthogonal, pinned, and marks it manual', () => {
    const { editor } = loadEditor();
    const { wire, path } = wireWithBends(editor);
    const k = 1;
    const a = path[k]!;
    const b = path[k + 1]!;
    const grab = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    const to = horizontal ? { x: grab.x, y: grab.y + 40 } : { x: grab.x + 40, y: grab.y };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    const after = wirePolyline(editor.circuit, wire)!;
    expect(isOrtho(after)).toBe(true);
    expect(after[0]).toEqual(path[0]);
    expect(after[after.length - 1]).toEqual(path[path.length - 1]);
    expect(wire.manual).toBe(true);
  });

  it('a click without movement does not change the wire', () => {
    const { editor } = loadEditor();
    const { wire, path } = wireWithBends(editor);
    const grab = { x: (path[1]!.x + path[2]!.x) / 2, y: (path[1]!.y + path[2]!.y) / 2 };
    const before = JSON.stringify(wire.waypoints);
    editor.handleMouseDown(grab);
    editor.handleMouseUp(grab, false);
    expect(JSON.stringify(wire.waypoints)).toBe(before);
    expect(wire.manual).toBeUndefined();
  });

  it('implicit tidy keeps a still-valid manual wire and drops the flag once it is invalid', () => {
    const { circuit, editor } = loadEditor();
    const { wire, path } = wireWithBends(editor);
    const grab = { x: (path[1]!.x + path[2]!.x) / 2, y: (path[1]!.y + path[2]!.y) / 2 };
    const horizontal = Math.abs(path[1]!.y - path[2]!.y) < 0.5;
    const to = horizontal ? { x: grab.x, y: grab.y + 10 } : { x: grab.x + 10, y: grab.y };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    const shaped = JSON.stringify(wire.waypoints);

    const hostId = circuit.allPins().find((p) => p.id === wire.a)!.componentId;
    editor.selectedWireIds = new Set();
    editor.selectedIds = new Set([hostId]);
    editor.tidySelectedWires(false);
    expect(JSON.stringify(wire.waypoints)).toBe(shaped);
    expect(wire.manual).toBe(true);

    circuit.moveComponent(hostId, 10, 30);
    editor.tidySelectedWires(false);
    expect(wire.manual).toBeUndefined();
    expect(isOrtho(wirePolyline(circuit, wire)!)).toBe(true);
  });

  it('explicit tidy of the wire itself hands it back to the router', () => {
    const { editor } = loadEditor();
    const { wire, path } = wireWithBends(editor);
    const grab = { x: (path[1]!.x + path[2]!.x) / 2, y: (path[1]!.y + path[2]!.y) / 2 };
    const horizontal = Math.abs(path[1]!.y - path[2]!.y) < 0.5;
    const to = horizontal ? { x: grab.x, y: grab.y + 10 } : { x: grab.x + 10, y: grab.y };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    expect(wire.manual).toBe(true);
    editor.selectedIds = new Set();
    editor.selectedWireIds = new Set([wire.id]);
    editor.tidySelectedWires(false);
    expect(wire.manual).toBeUndefined();
  });
});

describe('drawing a wire', () => {
  it('preview and committed wire follow the same path and avoid foreign bodies', () => {
    const { circuit, editor } = loadEditor();
    const chipPins = circuit.allPins().filter((p) => circuit.components.get(p.componentId)?.kind === 'chip');
    const commit = (a: string, b: string) =>
      (editor as unknown as { commitRoutedWire(a: string, b: string, w: Point[]): void }).commitRoutedWire(a, b, []);
    let checked = 0;
    for (let i = 0; i < chipPins.length && checked < 8; i += 5) {
      const a = chipPins[i]!;
      const b = chipPins.find((p, j) => j > i && p.componentId !== a.componentId);
      if (!b) continue;
      const preview = editor.routeNewWire(a.id, [], b.id, { x: 0, y: 0 })!;
      commit(a.id, b.id);
      const added = [...circuit.wires.values()].pop()!;
      const drawn = wirePolyline(circuit, added)!;
      expect(drawn).toEqual(preview);
      expect(isOrtho(drawn)).toBe(true);
      expect(added.manual).toBeUndefined();
      const exclude = new Set([a.componentId, b.componentId]);
      expect(pathHitsObstacles(drawn, routingObstacles(circuit, exclude))).toBe(false);
      circuit.removeWire(added.id);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('grabbing a wire near a component', () => {
  it('drags the selected wire instead of the transistor whose hit box covers the grab point', () => {
    const circuit = new Circuit();
    const editor = new Editor(circuit, new ChipLibrary());
    const t = makeTransistor(circuit, 'N', { x: 0, y: 0 });
    const led = makeLed(circuit, { x: 200, y: -120 });
    const w = circuit.addWire(t.pins.drain.id, led.pins.in.id, [
      { x: 40, y: t.pins.drain.pos.y },
      { x: 40, y: -120 },
    ]);
    const grab = { x: 20, y: t.pins.drain.pos.y };
    expect(findComponentNear(circuit, grab)?.id).toBe(t.id);

    editor.selectedWireId = w.id;
    const to = { x: 60, y: grab.y };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    expect(t.pos).toEqual({ x: 0, y: 0 });
    expect(w.manual).toBe(true);
  });
});

describe('reversals left by older drags', () => {
  it('grabbing a wire that doubles back on itself drops the tail', () => {
    const circuit = new Circuit();
    const editor = new Editor(circuit, new ChipLibrary());
    const t = makeTransistor(circuit, 'N', { x: 0, y: 0 });
    const led = makeLed(circuit, { x: 400, y: 100 });
    const y = led.pins.in.pos.y;
    const w = circuit.addWire(t.pins.drain.id, led.pins.in.id, [
      { x: 40, y: t.pins.drain.pos.y },
      { x: 40, y },
      { x: 300, y },
      { x: 260, y },
    ]);
    editor.selectedWireId = w.id;
    const grab = { x: 40, y: (t.pins.drain.pos.y + y) / 2 };
    const to = { x: 50, y: grab.y };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    const drawn = wirePolyline(circuit, w)!;
    expect(isOrtho(drawn)).toBe(true);
    for (let i = 1; i < drawn.length - 1; i++) {
      const [a, b, c] = [drawn[i - 1]!, drawn[i]!, drawn[i + 1]!];
      const colinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      expect(colinear, `colinear vertex at ${b.x},${b.y}`).toBe(false);
    }
  });
});

describe('two wires lying on top of each other', () => {
  it('still drags the selected wire, not the transistor, when an unselected wire covers it', () => {
    const circuit = new Circuit();
    const editor = new Editor(circuit, new ChipLibrary());
    const t = makeTransistor(circuit, 'N', { x: 0, y: 0 });
    const ledA = makeLed(circuit, { x: 200, y: -120 });
    const ledB = makeLed(circuit, { x: 260, y: -120 });
    const y = t.pins.drain.pos.y;
    const bends = [
      { x: 40, y },
      { x: 40, y: -120 },
    ];
    const selected = circuit.addWire(t.pins.drain.id, ledA.pins.in.id, bends);
    circuit.addWire(t.pins.drain.id, ledB.pins.in.id, bends.map((p) => ({ ...p })));
    editor.selectedWireId = selected.id;
    const grab = { x: 20, y };
    const to = { x: 60, y };
    editor.handleMouseDown(grab);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    expect(t.pos).toEqual({ x: 0, y: 0 });
    expect(selected.manual).toBe(true);
  });
});

describe('wire versus component in the hit margin', () => {
  function setup() {
    const circuit = new Circuit();
    const editor = new Editor(circuit, new ChipLibrary());
    const t = makeTransistor(circuit, 'N', { x: 0, y: 0 });
    const led = makeLed(circuit, { x: 200, y: -120 });
    const y = t.pins.drain.pos.y;
    const w = circuit.addWire(t.pins.drain.id, led.pins.in.id, [
      { x: 40, y },
      { x: 40, y: -120 },
    ]);
    return { circuit, editor, t, w, y };
  }

  it('selects an unselected wire clicked where the transistor only has hit padding', () => {
    const { editor, t, w, y } = setup();
    const p = { x: 20, y };
    expect(findComponentNear(editor.circuit, p)?.id).toBe(t.id);
    editor.handleMouseDown(p);
    editor.handleMouseUp(p, false);
    expect(editor.selectedWireId).toBe(w.id);
    expect(editor.selectedIds.size).toBe(0);
  });

  it('drags an unselected wire out of the padding without moving the transistor', () => {
    const { editor, t, w, y } = setup();
    const from = { x: 20, y };
    const to = { x: 20, y: y - 30 };
    editor.handleMouseDown(from);
    editor.handleMouseDrag(to);
    editor.handleMouseUp(to, false);
    expect(t.pos).toEqual({ x: 0, y: 0 });
    expect(w.manual).toBe(true);
  });

  it('still selects and moves the component when the pointer is inside its body', () => {
    const { editor, t } = setup();
    const p = { x: 0, y: 0 };
    editor.handleMouseDown(p);
    editor.handleMouseUp(p, false);
    expect(editor.selectedIds.has(t.id)).toBe(true);
  });
});

describe('cleanRoute', () => {
  it('collapses a stair left by an off-grid pin', () => {
    const path = [
      { x: 176, y: 76 },
      { x: 210, y: 76 },
      { x: 210, y: 80 },
      { x: 220, y: 80 },
      { x: 220, y: 130 },
      { x: 240, y: 130 },
    ];
    expect(cleanRoute(path, [])).toEqual([
      { x: 176, y: 76 },
      { x: 220, y: 76 },
      { x: 220, y: 130 },
      { x: 240, y: 130 },
    ]);
  });

  it('drops an up-then-down reversal on the same line', () => {
    const out = cleanRoute(
      [
        { x: 716, y: 124 },
        { x: 750, y: 124 },
        { x: 750, y: 120 },
        { x: 750, y: 140 },
        { x: 690, y: 140 },
      ],
      [],
    );
    expect(out).toEqual([
      { x: 716, y: 124 },
      { x: 750, y: 124 },
      { x: 750, y: 140 },
      { x: 690, y: 140 },
    ]);
  });

  it('keeps the jog when merging would run through a body', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 4 },
      { x: 60, y: 4 },
      { x: 60, y: 100 },
      { x: 80, y: 100 },
    ];
    const wall = { minX: 45, minY: -10, maxX: 55, maxY: 2 };
    expect(cleanRoute(path, [wall])).toEqual(path);
  });
});

describe('jog at the grab point', () => {
  it('puts the jog where the leg at a pin was taken hold of', () => {
    const out = dragSegment(Z, 0, { x: 30, y: 20 }, { x: 35, y: 0 });
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out).toContainEqual({ x: 35, y: 0 });
    expect(out).toContainEqual({ x: 35, y: 20 });
  });

  it('keeps a grid of straight stub when grabbed right at the pin', () => {
    const out = dragSegment(Z, 0, { x: 30, y: 20 }, { x: 2, y: 0 });
    expect(out).toContainEqual({ x: 10, y: 0 });
  });
});

describe('wire grip feedback', () => {
  function setup() {
    const circuit = new Circuit();
    const editor = new Editor(circuit, new ChipLibrary());
    const t = makeTransistor(circuit, 'N', { x: 0, y: 0 });
    const led = makeLed(circuit, { x: 200, y: -120 });
    const y = t.pins.drain.pos.y;
    circuit.addWire(t.pins.drain.id, led.pins.in.id, [
      { x: 80, y },
      { x: 80, y: -120 },
    ]);
    return { editor, y };
  }

  it('reports a vertical leg for ew-resize and a horizontal one for ns-resize', () => {
    const { editor, y } = setup();
    editor.handleMouseMove({ x: 80, y: y / 2 - 30 });
    expect(editor.wireGrip).toMatchObject({ kind: 'segment', vertical: true });
    editor.handleMouseMove({ x: 120, y: -120 });
    expect(editor.wireGrip).toMatchObject({ kind: 'segment', vertical: false });
  });

  it('reports a corner over a bend and nothing in empty space', () => {
    const { editor, y } = setup();
    editor.handleMouseMove({ x: 80, y });
    expect(editor.wireGrip).toMatchObject({ kind: 'corner' });
    editor.handleMouseMove({ x: 500, y: 500 });
    expect(editor.wireGrip).toBeNull();
  });
});
