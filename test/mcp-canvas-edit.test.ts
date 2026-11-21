import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeChipInstance, makeInput, makeProbe, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { applyCanvasEdits } from '../src/mcp/publish.js';
import { CANVAS_SCOPE, Workspace } from '../src/mcp/workspace.js';

/** The user's own circuit: a switch, an inverter and a probe, built by hand rather than through the agent. */
function userCanvas() {
  const library = new ChipLibrary();
  seedStandardCells(library);
  const top = new Circuit();
  const sw = makeInput(top, 0, { x: 0, y: 0 });
  const inv = makeChipInstance(top, library.findByName('NOT')!, { x: 200, y: 0 });
  const probe = makeProbe(top, { x: 400, y: 0 }, 'result');
  wire(top, sw.pins.out, inv.pins.in!);
  wire(top, inv.pins.out!, probe.pins.in);
  const [w1, w2] = [...top.wires.values()] as unknown as [{ id: string }, { id: string }];
  return { library, top, sw, inv, probe, w1, w2 };
}

function liveProbe(top: Circuit, library: ChipLibrary, probeId: string): number | string | undefined {
  const flat = flatten(top, library);
  const nets = flat.computeNets();
  let state = initialState();
  for (let i = 0; i < 6; i++) state = step(flat, nets, state);
  return state.levelOf.get(nets.netOf.get(`${probeId}:in`)!);
}

describe('editing the canvas', () => {
  it('shows the user circuit by ids, with labels and wires, and simulates it without touching the canvas', () => {
    const { library, top, sw, inv, probe } = userCanvas();
    const ws = new Workspace(() => library);
    expect(ws.openCanvas(top)).toEqual({ components: 3, wires: 2 });
    const described = ws.describe(CANVAS_SCOPE);
    expect(described.components).toEqual([
      { name: sw.id, type: 'input' },
      { name: inv.id, type: 'NOT' },
      { name: probe.id, type: 'probe', label: 'result' },
    ]);
    expect(described.wires).toHaveLength(2);
    expect(ws.simulate(CANVAS_SCOPE, { [sw.id]: 1 }).outputs[probe.id]).toBe(0);
    expect(sw.value).toBe(0);
    expect(top.components.size).toBe(3);
  });

  it('applies only the difference and leaves untouched components as the same objects', () => {
    const { library, top, sw, inv, probe, w1, w2 } = userCanvas();
    const ws = new Workspace(() => library);
    ws.openCanvas(top);
    ws.remove(CANVAS_SCOPE, { wires: [[`${inv.id}.out`, probe.id]] });
    ws.build(CANVAS_SCOPE, {
      components: [{ name: 'second', type: 'NOT' }],
      wires: [[`${inv.id}.out`, 'second.in'], ['second.out', probe.id]],
    });
    expect(ws.simulate(CANVAS_SCOPE, { [sw.id]: 1 }).outputs[probe.id]).toBe(1);

    const result = applyCanvasEdits(top, library, ws);

    expect(result).toMatchObject({ addedComponents: 1, removedComponents: 0, movedComponents: 0, addedWires: 2, removedWires: 1 });
    expect(top.components.get(sw.id)).toBe(sw);
    expect(top.components.get(inv.id)).toBe(inv);
    expect(top.components.get(probe.id)).toBe(probe);
    expect(top.wires.has(w1.id)).toBe(true);
    expect(top.wires.has(w2.id)).toBe(false);
    const added = [...top.components.values()].find((c) => c.kind === 'chip' && c.id !== inv.id);
    expect(added).toMatchObject({ kind: 'chip', defId: library.findByName('NOT')!.id });
    expect(added!.pos.x).toBeGreaterThan(400);

    sw.value = 1;
    expect(liveProbe(top, library, probe.id)).toBe(1);
  });

  it('removes and moves components on the canvas', () => {
    const { library, top, sw, inv, probe } = userCanvas();
    const ws = new Workspace(() => library);
    ws.openCanvas(top);
    const pinBefore = { ...sw.pins.out.pos };
    ws.move(CANVAS_SCOPE, [sw.id], 100, -40);
    ws.remove(CANVAS_SCOPE, { components: [inv.id] });
    expect(sw.pos).toEqual({ x: 0, y: 0 });

    const result = applyCanvasEdits(top, library, ws);

    expect(result).toMatchObject({ removedComponents: 1, movedComponents: 1, removedWires: 2 });
    expect(sw.pos).toEqual({ x: 100, y: -40 });
    expect(sw.pins.out.pos).toEqual({ x: pinBefore.x + 100, y: pinBefore.y - 40 });
    expect(top.components.has(inv.id)).toBe(false);
    expect(top.components.has(probe.id)).toBe(true);
    expect(top.wires.size).toBe(0);
  });

  it('refuses to apply, and changes nothing, when the canvas was edited after it was opened', () => {
    const { library, top, sw, inv } = userCanvas();
    const ws = new Workspace(() => library);
    ws.openCanvas(top);
    ws.build(CANVAS_SCOPE, { components: [{ name: 'extra', type: 'NOT' }] });
    top.moveComponent(inv.id, 10, 0);
    expect(() => applyCanvasEdits(top, library, ws)).toThrow(/canvas was changed after open_canvas; nothing was applied/);
    expect(top.components.size).toBe(3);
    expect(sw.pos).toEqual({ x: 0, y: 0 });
    ws.openCanvas(top);
    expect(ws.describe(CANVAS_SCOPE).components).toHaveLength(3);
  });

  it('keeps the sandbox and the canvas separate objects, and measures later edits from the last apply', () => {
    const { library, top } = userCanvas();
    const ws = new Workspace(() => library);
    ws.openCanvas(top);
    ws.build(CANVAS_SCOPE, { components: [{ name: 'extra', type: 'input' }] });
    applyCanvasEdits(top, library, ws);
    const onCanvas = [...top.components.values()].find((c) => c.kind === 'input' && c.id !== [...top.components.keys()][0])!;

    const xBefore = onCanvas.pos.x;
    ws.move(CANVAS_SCOPE, ['extra'], 500, 0);
    expect(onCanvas.pos.x).toBe(xBefore);
    expect(applyCanvasEdits(top, library, ws)).toMatchObject({ addedComponents: 0, movedComponents: 1 });
    expect(onCanvas.pos.x).toBe(xBefore + 500);
    expect(applyCanvasEdits(top, library, ws)).toMatchObject({ addedComponents: 0, movedComponents: 0, removedComponents: 0 });

    ws.remove(CANVAS_SCOPE, { components: ['extra'] });
    expect(applyCanvasEdits(top, library, ws)).toMatchObject({ removedComponents: 1 });
    expect(top.components.size).toBe(3);
  });

  it('registers a chip the agent authored when it is placed on the canvas', () => {
    const { library, top, probe } = userCanvas();
    const ws = new Workspace(() => library);
    ws.beginChip('DOUBLE_INV');
    ws.build('DOUBLE_INV', { components: [{ name: 'a', type: 'NOT' }, { name: 'b', type: 'NOT' }], wires: [['a.out', 'b.in']] });
    ws.finishChip('DOUBLE_INV', [{ name: 'in', dir: 'in', pin: 'a.in' }, { name: 'out', dir: 'out', pin: 'b.out' }]);
    ws.openCanvas(top);
    ws.build(CANVAS_SCOPE, { components: [{ name: 'd', type: 'DOUBLE_INV' }], wires: [['d.out', probe.id]] });

    const result = applyCanvasEdits(top, library, ws);

    expect(result.chips).toEqual(['DOUBLE_INV']);
    expect(library.findByName('DOUBLE_INV')).toBeDefined();
    const copy = [...top.components.values()].find((c) => c.kind === 'chip' && library.get(c.defId).name === 'DOUBLE_INV');
    expect(copy).toBeDefined();
  });

  it('warns only about the pins of what was just added, and will not clear the mirrored canvas', () => {
    const { library, top } = userCanvas();
    const ws = new Workspace(() => library);
    ws.openCanvas(top);
    const built = ws.build(CANVAS_SCOPE, { components: [{ name: 'loose', type: 'NOT' }] });
    expect(built.warnings).toEqual(['loose.in is not connected', 'loose.out is not connected']);
    expect(() => ws.clear(CANVAS_SCOPE)).toThrow(/mirrors the user's canvas/);
  });

  it('needs open_canvas and an attached canvas', () => {
    const { library, top } = userCanvas();
    expect(() => applyCanvasEdits(top, library, new Workspace(() => library))).toThrow(/call open_canvas first/);
    expect(() => new Workspace().openCanvas(top)).toThrow(/no canvas is attached/);
  });
});
