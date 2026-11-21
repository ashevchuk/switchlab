import { describe, expect, it } from 'vitest';
import { MAIN_SCOPE, Workspace } from '../src/mcp/workspace.js';

function adder8Workspace(): Workspace {
  const ws = new Workspace();
  ws.beginChip('ADD8');
  ws.build('ADD8', {
    components: [{ name: 'fa', type: 'FULL_ADDER', count: 8 }, { name: 'gnd', type: 'gnd' }],
    wires: [['gnd', 'fa0.cin'], ...[0, 1, 2, 3, 4, 5, 6].map((i) => [`fa${i}.cout`, `fa${i + 1}.cin`])],
  });
  ws.finishChip('ADD8', [
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [
      { name: `a${i}`, dir: 'in' as const, pin: `fa${i}.a` },
      { name: `b${i}`, dir: 'in' as const, pin: `fa${i}.b` },
      { name: `s${i}`, dir: 'out' as const, pin: `fa${i}.sum` },
    ]),
    { name: 'cout', dir: 'out' as const, pin: 'fa7.cout' },
  ]);
  return ws;
}

describe('bus wiring', () => {
  it('connects whole buses with one entry each', () => {
    const ws = adder8Workspace();
    const built = ws.build(MAIN_SCOPE, {
      components: [
        { name: 'x', type: 'input', count: 8 },
        { name: 'y', type: 'input', count: 8 },
        { name: 'add', type: 'ADD8' },
        { name: 'sum', type: 'probe', count: 8 },
      ],
      wires: [['x', 'add.a'], ['y', 'add.b'], ['add.s', 'sum']],
    });
    expect(built.wired).toBe(24);
    expect(built.warnings).toEqual(['add.cout is not connected']);
    expect(ws.simulate(MAIN_SCOPE, { x: 100, y: 99 }).outputs.sum).toEqual({ value: 199, bits: '11000111' });
  });

  it('fans one pin out to every bit of a bus and to several pins', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [
        { name: 'one', type: 'vcc' },
        { name: 'q', type: 'probe', count: 3 },
        { name: 'extra', type: 'probe' },
      ],
      wires: [['one', 'q', 'extra']],
    });
    expect(ws.simulate(MAIN_SCOPE).outputs).toEqual({ q: { value: 7, bits: '111' }, extra: 1 });
  });

  it('rejects buses of different width and names both', () => {
    const ws = adder8Workspace();
    expect(() =>
      ws.build(MAIN_SCOPE, {
        components: [{ name: 'x', type: 'input', count: 4 }, { name: 'add', type: 'ADD8' }],
        wires: [['x', 'add.a']],
      }),
    ).toThrow(/bus widths differ: x has 4 bits, add\.a has 8/);
    expect(ws.mainCircuit().components.size).toBe(0);
  });
});

describe('sequential circuits', () => {
  function counterWorkspace(): Workspace {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [
        { name: 'clk', type: 'input' }, { name: 'clr', type: 'input' },
        { name: 'on', type: 'vcc' }, { name: 'off', type: 'gnd' },
        { name: 'c', type: 'COUNTER4' }, { name: 'q', type: 'probe', count: 4 },
      ],
      wires: [['clk', 'c.clk'], ['clr', 'c.clr'], ['on', 'c.ce'], ['off', 'c.load'], ['off', 'c.d'], ['c.q', 'q']],
    });
    return ws;
  }

  it('counts clock cycles and reports every cycle', () => {
    const ws = counterWorkspace();
    ws.simulate(MAIN_SCOPE, { clr: 1 });
    const { trace } = ws.simulateClock(MAIN_SCOPE, 'clk', 5, { clr: 0 });
    expect(trace.map((t) => (t.q as { value: number }).value)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps state between simulate calls and forgets it on power cycle', () => {
    const ws = counterWorkspace();
    ws.simulate(MAIN_SCOPE, { clr: 1, clk: 0 });
    ws.simulate(MAIN_SCOPE, { clr: 0 });
    ws.simulate(MAIN_SCOPE, { clk: 1 });
    expect(ws.simulate(MAIN_SCOPE, { clk: 0 }).outputs.q).toEqual({ value: 1, bits: '0001' });
    ws.powerCycle(MAIN_SCOPE);
    expect((ws.simulate(MAIN_SCOPE, { clk: 0 }).outputs.q as { value: number | null }).value).not.toBe(1);
  });

  it('captures a D flip-flop on the rising edge only', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'd', type: 'input' }, { name: 'clk', type: 'input' }, { name: 'f', type: 'D_FF' }, { name: 'q', type: 'probe' }],
      wires: [['d', 'f.d'], ['clk', 'f.clk'], ['f.q', 'q']],
    });
    const { trace } = ws.simulateSequence(MAIN_SCOPE, [
      { d: 1, clk: 0 }, { clk: 1 }, { d: 0, clk: 0 }, { clk: 1 },
    ]);
    expect(trace.map((t) => t.q)).toEqual(['Z', 1, 1, 0]);
  });
});

describe('truth tables and editing', () => {
  it('lists every row of a combinational chip with bus values', () => {
    const ws = new Workspace();
    const { rows } = ws.truthTable('FULL_ADDER');
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.in.a === 1 && r.in.b === 1 && r.in.cin === 1)?.out).toEqual({ sum: 1, cout: 1 });
    expect(rows.find((r) => r.in.a === 1 && r.in.b === 0 && r.in.cin === 0)?.out).toEqual({ sum: 1, cout: 0 });
  });

  it('refuses a table that would be too large', () => {
    expect(() => adder8Workspace().truthTable('ADD8')).toThrow(/16 input bits \(max 8\)/);
  });

  it('removes components and wires so a mistake can be fixed in place', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }, { name: 'q', type: 'probe' }],
      wires: [['a', 'n.in'], ['n.out', 'q']],
    });
    expect(ws.remove(MAIN_SCOPE, { wires: [['n.out', 'q']] })).toEqual({ removedComponents: 0, removedWires: 1 });
    expect(ws.remove(MAIN_SCOPE, { components: ['n'] })).toEqual({ removedComponents: 1, removedWires: 1 });
    expect(ws.describe(MAIN_SCOPE).components.map((c) => c.name)).toEqual(['a', 'q']);
    expect(() => ws.remove(MAIN_SCOPE, { wires: [['a', 'q']] })).toThrow(/no wire between/);
  });

  it('removes a whole bus by its name', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, { components: [{ name: 'a', type: 'input', count: 4 }] });
    expect(ws.remove(MAIN_SCOPE, { components: ['a'] }).removedComponents).toBe(4);
    expect(ws.describe(MAIN_SCOPE).buses).toEqual({});
  });

  it('deletes an unused chip so its name can be reused, but not a placed or built-in one', () => {
    const ws = adder8Workspace();
    ws.build(MAIN_SCOPE, { components: [{ name: 'u', type: 'ADD8' }] });
    expect(() => ws.deleteChip('ADD8')).toThrow(/still placed/);
    ws.remove(MAIN_SCOPE, { components: ['u'] });
    ws.deleteChip('ADD8');
    expect(ws.listLibrary().some((e) => e.name === 'ADD8')).toBe(false);
    expect(() => ws.beginChip('ADD8')).not.toThrow();
    expect(() => ws.deleteChip('AND')).toThrow(/built-in/);
  });
});

describe('feedback aimed at an agent', () => {
  it('does not warn about unwired pins while a chip is being built, but reports loose ones at finish_chip', () => {
    const ws = new Workspace();
    ws.beginChip('HALF');
    const built = ws.build('HALF', { components: [{ name: 'x', type: 'XOR' }, { name: 'n', type: 'AND' }], wires: [['x.a', 'n.a']] });
    expect(built.warnings).toEqual([]);
    const finished = ws.finishChip('HALF', [
      { name: 'a', dir: 'in', pin: ['x.a', 'n.a'] },
      { name: 'b', dir: 'in', pin: 'x.b' },
      { name: 's', dir: 'out', pin: 'x.out' },
    ]);
    expect(finished.warnings).toEqual(['n.b is not connected', 'n.out is not connected']);
  });

  it('reports nothing at finish_chip when every pin is wired or exposed', () => {
    const ws = new Workspace();
    ws.beginChip('INV');
    ws.build('INV', { components: [{ name: 'n', type: 'NOT' }] });
    expect(ws.finishChip('INV', [{ name: 'in', dir: 'in', pin: 'n.in' }, { name: 'out', dir: 'out', pin: 'n.out' }]).warnings).toEqual([]);
  });

  it('tells the agent when there is nothing to read', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, { components: [{ name: 'a', type: 'input' }] });
    expect(ws.simulate(MAIN_SCOPE, { a: 1 })).toEqual({
      outputs: {},
      warnings: ['this scope has no probes or LEDs, so there is nothing to read: add some with build'],
    });
  });

  it('places LEDs and reads them like probes', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }, { name: 'lamp', type: 'led' }],
      wires: [['a', 'n.in'], ['n.out', 'lamp']],
    });
    expect(ws.simulate(MAIN_SCOPE, { a: 0 })).toEqual({ outputs: { lamp: 1 }, warnings: [] });
    expect(ws.describe(MAIN_SCOPE).components).toContainEqual({ name: 'lamp', type: 'led', label: 'lamp' });
  });

  it('warns when an input or probe is placed inside a chip under construction', () => {
    const ws = new Workspace();
    ws.beginChip('ODD');
    const built = ws.build('ODD', { components: [{ name: 'x', type: 'input' }, { name: 'n', type: 'NOT' }, { name: 'q', type: 'probe' }] });
    expect(built.warnings).toEqual([
      'x (input) inside a chip would become part of the chip. Ports are chosen at finish_chip; expose the inner pin there instead.',
      'q (probe) inside a chip would become part of the chip. Ports are chosen at finish_chip; expose the inner pin there instead.',
    ]);
  });

  it('points at begin_chip when a chip scope does not exist yet', () => {
    expect(() => new Workspace().build('MAJ3', { components: [{ name: 'a', type: 'AND' }] })).toThrow(
      /unknown scope: MAJ3\. Known: main\. A chip's scope is created by begin_chip with the chip's name\./,
    );
  });
});
