import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { initialState, step } from '../src/sim/solver.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { appendWorkspace } from '../src/mcp/publish.js';
import { MAIN_SCOPE, Workspace } from '../src/mcp/workspace.js';

function liveProject() {
  const library = new ChipLibrary();
  seedStandardCells(library);
  return { top: new Circuit(), library };
}

/** An earlier session's work: a half adder built from standard cells and published to the canvas. */
function publishHalfAdder(top: Circuit, library: ChipLibrary): void {
  const ws = new Workspace();
  ws.beginChip('HA');
  ws.build('HA', {
    components: [{ name: 'x', type: 'XOR' }, { name: 'n', type: 'AND' }],
    wires: [['x.a', 'n.a'], ['x.b', 'n.b']],
  });
  ws.finishChip('HA', [
    { name: 'a', dir: 'in', pin: ['x.a', 'n.a'] },
    { name: 'b', dir: 'in', pin: ['x.b', 'n.b'] },
    { name: 's', dir: 'out', pin: 'x.out' },
    { name: 'c', dir: 'out', pin: 'n.out' },
  ]);
  ws.build(MAIN_SCOPE, { components: [{ name: 'u', type: 'HA' }] });
  appendWorkspace(top, library, ws);
}

describe('chips from the canvas', () => {
  it('are listed, flagged as canvas chips, and usable in a new workspace', () => {
    const { top, library } = liveProject();
    publishHalfAdder(top, library);
    const ws = new Workspace(() => library);
    const ha = ws.listLibrary().find((e) => e.name === 'HA');
    expect(ha).toMatchObject({ origin: 'canvas', ports: [{ name: 'a', dir: 'in' }, { name: 'b', dir: 'in' }, { name: 's', dir: 'out' }, { name: 'c', dir: 'out' }] });
    expect(ha?.outOfDate).toBeUndefined();
    expect(ws.listLibrary().find((e) => e.name === 'AND')?.origin).toBeUndefined();
    expect(ws.truthTable('HA').rows.map((r) => [r.in.a, r.in.b, r.out.s, r.out.c])).toEqual([
      [0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 1, 0], [1, 1, 0, 1],
    ]);
  });

  it('build a larger circuit on top of a canvas chip, and publishing shares the chip instead of copying it', () => {
    const { top, library } = liveProject();
    publishHalfAdder(top, library);
    const defsBefore = library.list().length;
    const ws = new Workspace(() => library);
    ws.build(MAIN_SCOPE, {
      components: [
        { name: 'p', type: 'input' }, { name: 'q', type: 'input' },
        { name: 'h', type: 'HA' }, { name: 'sum', type: 'probe' }, { name: 'carry', type: 'probe' },
      ],
      wires: [['p', 'h.a'], ['q', 'h.b'], ['h.s', 'sum'], ['h.c', 'carry']],
    });
    expect(ws.simulate(MAIN_SCOPE, { p: 1, q: 1 }).outputs).toEqual({ sum: 0, carry: 1 });

    const published = appendWorkspace(top, library, ws);

    expect(published.chips).toEqual([]);
    expect(library.list()).toHaveLength(defsBefore);
    const haId = library.findByName('HA')!.id;
    const instances = [...top.components.values()].filter((c) => c.kind === 'chip' && c.defId === haId);
    expect(instances).toHaveLength(2);

    const inputs = [...top.components.values()].filter((c) => c.kind === 'input') as { value: 0 | 1 }[];
    inputs.forEach((i) => (i.value = 1));
    const flat = flatten(top, library);
    const nets = flat.computeNets();
    let state = initialState();
    for (let i = 0; i < 6; i++) state = step(flat, nets, state);
    const carry = [...top.components.values()].find((c) => c.kind === 'probe' && c.label === 'carry');
    if (carry?.kind !== 'probe') throw new Error('carry probe not published');
    expect(state.levelOf.get(nets.netOf.get(carry.pins.in.id)!)).toBe(1);
  });

  it('refuse a new chip under a name the canvas already uses', () => {
    const { top, library } = liveProject();
    publishHalfAdder(top, library);
    const ws = new Workspace(() => library);
    expect(() => ws.beginChip('HA')).toThrow(/name already in use: HA/);
  });

  it('are flagged out of date after an edit on the canvas, and publishing refuses until re-imported', () => {
    const { top, library } = liveProject();
    publishHalfAdder(top, library);
    const ws = new Workspace(() => library);
    ws.build(MAIN_SCOPE, { components: [{ name: 'h', type: 'HA' }] });
    library.findByName('HA')!.revision = 7;
    expect(ws.listLibrary().find((e) => e.name === 'HA')?.outOfDate).toBe(true);
    expect(() => appendWorkspace(top, library, ws)).toThrow(/edited on the canvas since it was imported: HA/);

    ws.remove(MAIN_SCOPE, { components: ['h'] });
    ws.deleteChip('HA');
    const fresh = ws.listLibrary().find((e) => e.name === 'HA');
    expect(fresh?.origin).toBe('canvas');
    expect(fresh?.outOfDate).toBeUndefined();
  });

  it('leave a workspace without a canvas working as before', () => {
    expect(new Workspace().listLibrary().some((e) => e.origin !== undefined)).toBe(false);
  });
});
