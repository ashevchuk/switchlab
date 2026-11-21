import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/mcp/workspace.js';
import type { ChipPortSpec } from '../src/mcp/workspace.js';

const range = (n: number) => [...Array(n).keys()];

function authorAdder(ws: Workspace, name: string, bits: number): void {
  ws.beginChip(name);
  ws.build(name, {
    components: [{ name: 'fa', type: 'FULL_ADDER', count: bits }, { name: 'gnd', type: 'gnd' }],
    wires: [
      ['gnd', 'fa0.cin'],
      ...range(bits - 1).map((i) => [`fa${i}.cout`, `fa${i + 1}.cin`] as [string, string]),
    ],
  });
  ws.finishChip(name, [
    ...range(bits).flatMap((i): ChipPortSpec[] => [
      { name: `a${i}`, dir: 'in', pin: `fa${i}.a` },
      { name: `b${i}`, dir: 'in', pin: `fa${i}.b` },
      { name: `s${i}`, dir: 'out', pin: `fa${i}.sum` },
    ]),
    { name: 'cout', dir: 'out', pin: `fa${bits - 1}.cout` },
  ]);
}

/** Array multiplier: AND matrix plus one n-bit adder row per extra multiplier bit. */
function authorMultiplier(ws: Workspace, name: string, adder: string, bits: number): void {
  ws.beginChip(name);
  const ands = range(bits).flatMap((i) => range(bits).map((j) => ({ name: `and_${i}_${j}`, type: 'AND' })));
  const rows = range(bits - 1).map((k) => ({ name: `row${k + 1}`, type: adder }));
  const wires: [string, string][] = [];
  for (let i = 1; i < bits; i++) {
    for (const k of range(bits)) {
      const shifted =
        k < bits - 1
          ? i === 1
            ? `and_0_${k + 1}.out`
            : `row${i - 1}.s${k + 1}`
          : i === 1
            ? 'gnd'
            : `row${i - 1}.cout`;
      wires.push([shifted, `row${i}.a${k}`], [`and_${i}_${k}.out`, `row${i}.b${k}`]);
    }
  }
  ws.build(name, { components: [...ands, ...rows, { name: 'gnd', type: 'gnd' }], wires });

  const ports: ChipPortSpec[] = [
    ...range(bits).map((j): ChipPortSpec => ({
      name: `a${j}`,
      dir: 'in',
      pin: range(bits).map((i) => `and_${i}_${j}.a`),
    })),
    ...range(bits).map((i): ChipPortSpec => ({
      name: `b${i}`,
      dir: 'in',
      pin: range(bits).map((j) => `and_${i}_${j}.b`),
    })),
    { name: 'p0', dir: 'out', pin: 'and_0_0.out' },
    ...range(bits - 1).map((k): ChipPortSpec => ({ name: `p${k + 1}`, dir: 'out', pin: `row${k + 1}.s0` })),
    ...range(bits - 1).map((k): ChipPortSpec => ({ name: `p${bits + k}`, dir: 'out', pin: `row${bits - 1}.s${k + 1}` })),
    { name: `p${2 * bits - 1}`, dir: 'out', pin: `row${bits - 1}.cout` },
  ];
  ws.finishChip(name, ports);
}

function sampleOperands(bits: number): [number, number][] {
  const max = 2 ** bits - 1;
  const fixed: [number, number][] = [[0, 0], [max, max], [1, max], [max, 1], [13, 17], [max, 0], [0, max], [128, 2]];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % (max + 1);
  };
  return [...fixed.filter(([a, b]) => a <= max && b <= max), ...range(40).map((): [number, number] => [next(), next()])];
}

describe('Workspace: hierarchical multiplier', () => {
  it.each([4, 8])('builds and verifies a %i-bit multiplier from authored chips', (bits) => {
    const ws = new Workspace();
    authorAdder(ws, `ADD${bits}`, bits);
    authorMultiplier(ws, `MUL${bits}`, `ADD${bits}`, bits);
    const cases = sampleOperands(bits).map(([a, b]) => ({ in: { a, b }, out: { p: a * b } }));
    const result = ws.testChip(`MUL${bits}`, cases);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(cases.length);
  });
});
