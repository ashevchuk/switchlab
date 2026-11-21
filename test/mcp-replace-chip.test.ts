import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { appendWorkspace } from '../src/mcp/publish.js';
import { MAIN_SCOPE, Workspace } from '../src/mcp/workspace.js';

function liveProject() {
  const library = new ChipLibrary();
  seedStandardCells(library);
  return { top: new Circuit(), library };
}

const PORTS = [
  { name: 'a', dir: 'in' as const, pin: 'g.a' },
  { name: 'b', dir: 'in' as const, pin: 'g.b' },
  { name: 'out', dir: 'out' as const, pin: 'g.out' },
];

/** A canvas chip G whose gate type is a parameter, plus a chip WRAP that is built on it. */
function publishGate(top: Circuit, library: ChipLibrary, gate: 'AND' | 'OR'): void {
  const ws = new Workspace(() => library);
  ws.beginChip('G');
  ws.build('G', { components: [{ name: 'g', type: gate }] });
  ws.finishChip('G', PORTS);
  ws.beginChip('WRAP');
  ws.build('WRAP', { components: [{ name: 'k', type: 'G' }] });
  ws.finishChip('WRAP', [
    { name: 'x', dir: 'in', pin: 'k.a' },
    { name: 'y', dir: 'in', pin: 'k.b' },
    { name: 'z', dir: 'out', pin: 'k.out' },
  ]);
  ws.build(MAIN_SCOPE, { components: [{ name: 'u', type: 'WRAP' }] });
  appendWorkspace(top, library, ws);
}

function rebuildAsOr(ws: Workspace): void {
  ws.beginChip('G', true);
  ws.build('G', { components: [{ name: 'g', type: 'OR' }] });
  ws.finishChip('G', PORTS);
}

describe('replacing a canvas chip', () => {
  it('updates the definition in place so instances and dependent chips follow', () => {
    const { top, library } = liveProject();
    publishGate(top, library, 'AND');
    const ws = new Workspace(() => library);
    const idBefore = library.findByName('G')!.id;
    expect(ws.truthTable('WRAP').rows.map((r) => r.out.z)).toEqual([0, 0, 0, 1]);

    rebuildAsOr(ws);
    expect(ws.truthTable('G').rows.map((r) => r.out.out)).toEqual([0, 1, 1, 1]);
    expect(ws.truthTable('WRAP').rows.map((r) => r.out.z)).toEqual([0, 1, 1, 1]);
    expect(ws.listLibrary().find((e) => e.name === 'G')).toMatchObject({ pendingReplace: true });
    expect(ws.listLibrary().find((e) => e.name === 'G')?.outOfDate).toBeUndefined();

    const instancesBefore = [...top.components.values()].filter((c) => c.kind === 'chip').length;
    const result = appendWorkspace(top, library, ws, { replace: ['G'] });

    expect(result).toMatchObject({ placedComponents: 0, chips: [], replaced: ['G'] });
    expect(result.bounds).toBeUndefined();
    expect(library.findByName('G')!.id).toBe(idBefore);
    expect([...top.components.values()].filter((c) => c.kind === 'chip')).toHaveLength(instancesBefore);

    const fresh = new Workspace(() => library);
    expect(fresh.truthTable('WRAP').rows.map((r) => r.out.z)).toEqual([0, 1, 1, 1]);
    expect(fresh.listLibrary().find((e) => e.name === 'G')?.outOfDate).toBeUndefined();
  });

  it('publishes the replacement together with a circuit that uses it', () => {
    const { top, library } = liveProject();
    publishGate(top, library, 'AND');
    const ws = new Workspace(() => library);
    rebuildAsOr(ws);
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'p', type: 'input' }, { name: 'q', type: 'input' }, { name: 'u', type: 'G' }, { name: 'r', type: 'probe' }],
      wires: [['p', 'u.a'], ['q', 'u.b'], ['u.out', 'r']],
    });
    expect(ws.simulate(MAIN_SCOPE, { p: 1, q: 0 }).outputs.r).toBe(1);
    expect(appendWorkspace(top, library, ws, { replace: ['G'] })).toMatchObject({ placedComponents: 4, replaced: ['G'] });
  });

  it('refuses a replacement that changes the ports and tells what they must be', () => {
    const { top, library } = liveProject();
    publishGate(top, library, 'AND');
    const ws = new Workspace(() => library);
    ws.beginChip('G', true);
    ws.build('G', { components: [{ name: 'g', type: 'OR' }] });
    expect(() => ws.finishChip('G', [{ name: 'a', dir: 'in', pin: 'g.a' }, { name: 'out', dir: 'out', pin: 'g.out' }])).toThrow(
      /must keep the chip's ports, in order\. Expected: a:in, b:in, out:out\. Got: a:in, out:out/,
    );
    expect(ws.truthTable('G').rows.map((r) => r.out.out)).toEqual([0, 0, 0, 1]);
  });

  it('needs begin_chip replace, a canvas chip, and a finished scope', () => {
    const { top, library } = liveProject();
    publishGate(top, library, 'AND');
    const ws = new Workspace(() => library);
    expect(() => ws.beginChip('G')).toThrow(/pass replace: true/);
    expect(() => ws.beginChip('NOPE', true)).toThrow(/no chip named NOPE on the canvas to replace/);
    expect(() => ws.beginChip('AND', true)).toThrow(/no chip named AND on the canvas to replace/);
    expect(() => appendWorkspace(top, library, ws, { replace: ['G'] })).toThrow(/not started with begin_chip replace: true/);
    ws.beginChip('G', true);
    expect(() => appendWorkspace(top, library, ws, { replace: ['G'] })).toThrow(/not finished: call finish_chip first/);
  });

  it('refuses, and changes nothing, when the canvas chip was edited after the replacement started', () => {
    const { top, library } = liveProject();
    publishGate(top, library, 'AND');
    const ws = new Workspace(() => library);
    rebuildAsOr(ws);
    const live = library.findByName('G')!;
    const circuitBefore = live.circuit;
    live.revision = 5;
    expect(() => appendWorkspace(top, library, ws, { replace: ['G'] })).toThrow(/edited on the canvas after the replacement was started/);
    expect(live.circuit).toBe(circuitBefore);
  });

  it('allows a second publish after a replacement without conflicts', () => {
    const { top, library } = liveProject();
    publishGate(top, library, 'AND');
    const ws = new Workspace(() => library);
    rebuildAsOr(ws);
    appendWorkspace(top, library, ws, { replace: ['G'] });
    ws.build(MAIN_SCOPE, { components: [{ name: 'again', type: 'G' }] });
    expect(appendWorkspace(top, library, ws)).toMatchObject({ placedComponents: 1, chips: [], replaced: [] });
  });
});
