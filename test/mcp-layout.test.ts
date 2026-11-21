import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { chipBodyWidth, chipBoxHeight } from '../src/sim/library.js';
import { layoutLayered } from '../src/mcp/layout.js';
import { MAIN_SCOPE, Workspace } from '../src/mcp/workspace.js';
import type { Component } from '../src/sim/types.js';

function rippleAdder(): { circuit: Circuit; ws: Workspace } {
  const ws = new Workspace();
  ws.build(MAIN_SCOPE, {
    components: [
      { name: 'x', type: 'input', count: 4 },
      { name: 'y', type: 'input', count: 4 },
      { name: 'fa', type: 'FULL_ADDER', count: 4 },
      { name: 'gnd', type: 'gnd' },
      { name: 's', type: 'probe', count: 4 },
    ],
    wires: [
      ['gnd', 'fa0.cin'],
      ...[0, 1, 2].map((i) => [`fa${i}.cout`, `fa${i + 1}.cin`]),
      ...[0, 1, 2, 3].flatMap((i) => [[`x${i}`, `fa${i}.a`], [`y${i}`, `fa${i}.b`], [`fa${i}.sum`, `s${i}`]]),
    ],
  });
  layoutLayered(ws.mainCircuit());
  return { circuit: ws.mainCircuit(), ws };
}

function box(c: Component): { x0: number; x1: number; y0: number; y1: number } {
  const w = c.kind === 'chip' ? chipBodyWidth(c) : 40;
  const h = c.kind === 'chip' ? chipBoxHeight(c) : 36;
  return { x0: c.pos.x - w / 2, x1: c.pos.x + w / 2, y0: c.pos.y - h / 2, y1: c.pos.y + h / 2 };
}

describe('layoutLayered', () => {
  it('orders columns by signal flow: inputs, then the carry chain, then probes', () => {
    const { circuit } = rippleAdder();
    const at = (kind: Component['kind']) => [...circuit.components.values()].filter((c) => c.kind === kind).map((c) => c.pos.x);
    const chainX = [...circuit.components.values()].filter((c) => c.kind === 'chip').map((c) => c.pos.x);
    expect(Math.max(...at('input'))).toBeLessThan(Math.min(...chainX));
    expect(Math.max(...chainX)).toBeLessThan(Math.min(...at('probe')));
    expect(new Set(chainX).size).toBe(4);
    const sorted = [...circuit.components.values()].filter((c) => c.kind === 'chip').sort((a, b) => a.pos.x - b.pos.x);
    expect(sorted.map((c) => (c as { pins: Record<string, unknown> }).pins.cin !== undefined)).toEqual([true, true, true, true]);
  });

  it('puts LEDs in the last column, like probes', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }, { name: 'lamp', type: 'led' }],
      wires: [['a', 'n.in'], ['n.out', 'lamp']],
    });
    layoutLayered(ws.mainCircuit());
    const x = (kind: Component['kind']) => [...ws.mainCircuit().components.values()].find((c) => c.kind === kind)!.pos.x;
    expect(x('input')).toBeLessThan(x('chip'));
    expect(x('chip')).toBeLessThan(x('led'));
  });

  it('never overlaps two components', () => {
    const { circuit } = rippleAdder();
    const boxes = [...circuit.components.values()].map(box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap, `components ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it('keeps each input bus in bit order down its column', () => {
    const { circuit, ws } = rippleAdder();
    const yOfName = new Map<string, number>();
    for (const [id, name] of ws.mainIoNames()) yOfName.set(name, circuit.components.get(id)!.pos.y);
    for (const bus of ['x', 'y']) {
      const ys = [0, 1, 2, 3].map((i) => yOfName.get(`${bus}${i}`)!);
      expect(ys, `${bus} bits`).toEqual([...ys].sort((p, q) => p - q));
    }
  });

  it('terminates on a feedback loop', () => {
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [{ name: 'a', type: 'NOT' }, { name: 'b', type: 'NOT' }],
      wires: [['a.out', 'b.in'], ['b.out', 'a.in']],
    });
    expect(() => layoutLayered(ws.mainCircuit())).not.toThrow();
  });
});
