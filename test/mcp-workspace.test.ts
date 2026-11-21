import { describe, expect, it } from 'vitest';
import { MAIN_SCOPE, Workspace } from '../src/mcp/workspace.js';

function halfAdderChip(ws: Workspace): void {
  ws.beginChip('HA');
  ws.build('HA', {
    components: [
      { name: 'x', type: 'XOR' },
      { name: 'n', type: 'AND' },
    ],
    wires: [['x.a', 'n.a'], ['x.b', 'n.b']],
  });
  ws.finishChip('HA', [
    { name: 'a', dir: 'in', pin: ['x.a', 'n.a'] },
    { name: 'b', dir: 'in', pin: ['x.b', 'n.b'] },
    { name: 's', dir: 'out', pin: 'x.out' },
    { name: 'c', dir: 'out', pin: 'n.out' },
  ]);
}

describe('Workspace: building and simulating', () => {
  it('lists the seeded standard cells with port directions', () => {
    const ws = new Workspace();
    const and = ws.listLibrary().find((e) => e.name === 'AND');
    expect(and?.ports).toEqual([
      { name: 'a', dir: 'in' },
      { name: 'b', dir: 'in' },
      { name: 'out', dir: 'out' },
    ]);
  });

  it('computes a half adder from XOR and AND', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [
        { name: 'a', type: 'input' },
        { name: 'b', type: 'input' },
        { name: 'x', type: 'XOR' },
        { name: 'n', type: 'AND' },
        { name: 'sum', type: 'probe' },
        { name: 'carry', type: 'probe' },
      ],
      wires: [
        ['a', 'x.a'], ['b', 'x.b'], ['a', 'n.a'], ['b', 'n.b'],
        ['x.out', 'sum'], ['n.out', 'carry'],
      ],
    });
    const table = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([a, b]) => {
      const { outputs } = ws.simulate(MAIN_SCOPE, { a: a!, b: b! });
      return [outputs.sum, outputs.carry];
    });
    expect(table).toEqual([[0, 0], [1, 0], [1, 0], [0, 1]]);
  });

  it('reads and writes buses as integers', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [
        { name: 'a', type: 'input', count: 4 },
        { name: 'q', type: 'probe', count: 4 },
      ],
      wires: [0, 1, 2, 3].map((i) => [`a${i}`, `q${i}`] as [string, string]),
    });
    expect(ws.simulate(MAIN_SCOPE, { a: 11 }).outputs.q).toEqual({ value: 11, bits: '1011' });
  });

  it('reports an undriven probe as Z and a bus with Z as value null', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, { components: [{ name: 'q', type: 'probe', count: 2 }] });
    expect(ws.simulate(MAIN_SCOPE).outputs.q).toEqual({ value: null, bits: 'ZZ' });
  });

  it('rejects a bad pin with the list of valid pins and rolls the whole build back', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, { components: [{ name: 'keep', type: 'input' }] });
    const before = ws.mainCircuit().components.size;
    expect(() =>
      ws.build(MAIN_SCOPE, {
        components: [{ name: 'g', type: 'AND' }],
        wires: [['keep', 'g.nope']],
      }),
    ).toThrow(/no pin "nope" on g\. Pins: a, b, out/);
    expect(ws.mainCircuit().components.size).toBe(before);
    expect(ws.mainCircuit().wires.size).toBe(0);
    expect(() => ws.build(MAIN_SCOPE, { components: [{ name: 'g', type: 'AND' }] })).not.toThrow();
  });

  it('names the available types for an unknown component type', () => {
    const ws = new Workspace();
    expect(() => ws.build(MAIN_SCOPE, { components: [{ name: 'g', type: 'WIDGET' }] })).toThrow(
      /unknown type "WIDGET".*input, probe, led, vcc, gnd.*AND/,
    );
  });

  it('warns about chip pins that are left unconnected', () => {
    const ws = new Workspace();
    const { warnings } = ws.build(MAIN_SCOPE, { components: [{ name: 'g', type: 'AND' }] });
    expect(warnings).toEqual(['g.a is not connected', 'g.b is not connected', 'g.out is not connected']);
  });

  it('reads an undriven feedback loop as Z instead of failing or hanging', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'n', type: 'NOT' }, { name: 'q', type: 'probe' }],
      wires: [['n.out', 'n.in'], ['n.out', 'q']],
    });
    expect(ws.simulate(MAIN_SCOPE).outputs.q).toBe('Z');
  });
});

describe('Workspace: authoring and testing chips', () => {
  it('folds a drafted half adder into a placeable chip and verifies it', () => {
    const ws = new Workspace();
    halfAdderChip(ws);
    expect(ws.listLibrary().find((e) => e.name === 'HA')?.ports).toEqual([
      { name: 'a', dir: 'in' },
      { name: 'b', dir: 'in' },
      { name: 's', dir: 'out' },
      { name: 'c', dir: 'out' },
    ]);
    const result = ws.testChip('HA', [
      { in: { a: 0, b: 0 }, out: { s: 0, c: 0 } },
      { in: { a: 0, b: 1 }, out: { s: 1, c: 0 } },
      { in: { a: 1, b: 0 }, out: { s: 1, c: 0 } },
      { in: { a: 1, b: 1 }, out: { s: 0, c: 1 } },
    ]);
    expect(result).toEqual({ passed: 4, total: 4, failures: [] });
  });

  it('reports failing cases with expected and actual values', () => {
    const ws = new Workspace();
    halfAdderChip(ws);
    const result = ws.testChip('HA', [{ in: { a: 1, b: 1 }, out: { s: 1, c: 1 } }]);
    expect(result.passed).toBe(0);
    expect(result.failures).toEqual([
      { case: 0, in: { a: 1, b: 1 }, expected: { s: 1, c: 1 }, got: { s: 0, c: 1 } },
    ]);
  });

  it('returns raw outputs when no expectation is given', () => {
    const ws = new Workspace();
    halfAdderChip(ws);
    expect(ws.testChip('HA', [{ in: { a: 1, b: 0 } }]).results).toEqual([{ s: 1, c: 0 }]);
  });

  it('builds a 4-bit ripple adder out of the authored chip and checks every sum', () => {
    const ws = new Workspace();
    ws.beginChip('ADD4');
    ws.build('ADD4', {
      components: [
        { name: 'fa', type: 'FULL_ADDER', count: 4 },
        { name: 'gnd', type: 'gnd' },
      ],
    });
    ws.build('ADD4', {
      wires: [
        ['gnd', 'fa0.cin'],
        ...[0, 1, 2].map((i) => [`fa${i}.cout`, `fa${i + 1}.cin`] as [string, string]),
      ],
    });
    ws.finishChip('ADD4', [
      ...[0, 1, 2, 3].flatMap((i) => [
        { name: `a${i}`, dir: 'in' as const, pin: `fa${i}.a` },
        { name: `b${i}`, dir: 'in' as const, pin: `fa${i}.b` },
        { name: `s${i}`, dir: 'out' as const, pin: `fa${i}.sum` },
      ]),
      { name: 'cout', dir: 'out', pin: 'fa3.cout' },
    ]);
    const cases = [];
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) cases.push({ in: { a, b }, out: { s: (a + b) % 16, cout: (a + b) >> 4 } });
    }
    expect(ws.testChip('ADD4', cases)).toEqual({ passed: 256, total: 256, failures: [] });
  });

  it('refuses a chip name that already exists', () => {
    const ws = new Workspace();
    expect(() => ws.beginChip('AND')).toThrow(/name already in use: AND/);
  });
});
