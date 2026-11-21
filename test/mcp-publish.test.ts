import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeInput } from '../src/sim/library.js';
import { decodeBusProbe } from '../src/sim/busProbe.js';
import { initialState, step } from '../src/sim/solver.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { appendWorkspace } from '../src/mcp/publish.js';
import { MAIN_SCOPE, Workspace } from '../src/mcp/workspace.js';

function liveProject() {
  const library = new ChipLibrary();
  seedStandardCells(library);
  return { top: new Circuit(), library };
}

function authorNandViaAnd(ws: Workspace): void {
  ws.beginChip('NAND2');
  ws.build('NAND2', {
    components: [{ name: 'g', type: 'AND' }, { name: 'i', type: 'NOT' }],
    wires: [['g.out', 'i.in']],
  });
  ws.finishChip('NAND2', [
    { name: 'a', dir: 'in', pin: 'g.a' },
    { name: 'b', dir: 'in', pin: 'g.b' },
    { name: 'out', dir: 'out', pin: 'i.out' },
  ]);
  ws.build(MAIN_SCOPE, {
    components: [
      { name: 'x', type: 'input' }, { name: 'y', type: 'input' },
      { name: 'u', type: 'NAND2' }, { name: 'q', type: 'probe' },
    ],
    wires: [['x', 'u.a'], ['y', 'u.b'], ['u.out', 'q']],
  });
}

function settledLevels(top: Circuit, library: ChipLibrary) {
  const flat = flatten(top, library);
  const nets = flat.computeNets();
  let state = initialState();
  for (let i = 0; i < 8 && (i === 0 || !state.settled); i++) state = step(flat, nets, state);
  return { nets, state };
}

describe('appendWorkspace', () => {
  it('adds the circuit and its chip next to existing content, and the result simulates', () => {
    const { top, library } = liveProject();
    const keeper = makeInput(top, 1, { x: 100, y: 40 });
    const ws = new Workspace();
    authorNandViaAnd(ws);

    const result = appendWorkspace(top, library, ws);

    expect(result).toMatchObject({ placedComponents: 4, chips: ['NAND2'] });
    expect(top.components.get(keeper.id)).toBe(keeper);
    const added = [...top.components.values()].filter((c) => c.id !== keeper.id);
    const { bounds } = result;
    if (!bounds) throw new Error('publishing a circuit must report where it went');
    for (const c of added) {
      expect(c.pos.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(c.pos.x).toBeLessThanOrEqual(bounds.maxX);
      expect(c.pos.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(c.pos.y).toBeLessThanOrEqual(bounds.maxY);
    }
    expect(added.every((c) => c.pos.x >= 100 + 300)).toBe(true);
    expect(library.findByName('NAND2')).toBeDefined();

    const inputs = added.filter((c) => c.kind === 'input');
    const probe = added.find((c) => c.kind === 'probe')!;
    const read = (a: 0 | 1, b: 0 | 1) => {
      (inputs[0] as { value: 0 | 1 }).value = a;
      (inputs[1] as { value: 0 | 1 }).value = b;
      const { nets, state } = settledLevels(top, library);
      return state.levelOf.get(nets.netOf.get(probe.pins.in.id)!);
    };
    expect([read(0, 0), read(0, 1), read(1, 0), read(1, 1)]).toEqual([1, 1, 1, 0]);
  });

  it('empties the workspace main scope so a second publish cannot collide', () => {
    const { top, library } = liveProject();
    const ws = new Workspace();
    authorNandViaAnd(ws);
    appendWorkspace(top, library, ws);
    expect(() => appendWorkspace(top, library, ws)).toThrow(/main is empty/);
  });

  it('refuses a chip name already on the canvas and changes nothing', () => {
    const { top, library } = liveProject();
    const first = new Workspace();
    authorNandViaAnd(first);
    appendWorkspace(top, library, first);
    const componentsBefore = top.components.size;

    const second = new Workspace();
    authorNandViaAnd(second);
    expect(() => appendWorkspace(top, library, second)).toThrow(/already exists on the canvas: NAND2/);
    expect(top.components.size).toBe(componentsBefore);
  });

  it('names nets after the model\'s inputs and probes', () => {
    const { top, library } = liveProject();
    const ws = new Workspace();
    authorNandViaAnd(ws);
    appendWorkspace(top, library, ws);
    const labels = [...top.components.values()].filter((c) => c.kind === 'label').map((c) => (c as { name: string }).name);
    expect(labels).toEqual(expect.arrayContaining(['x', 'y']));
    expect(labels).not.toContain('q');
    expect([...top.components.values()].some((c) => c.kind === 'probe' && c.label === 'q')).toBe(true);
  });

  it('keeps two publishes that reuse the same names electrically separate', () => {
    const { top, library } = liveProject();
    const publishInverter = () => {
      const ws = new Workspace();
      ws.build(MAIN_SCOPE, {
        components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }, { name: 'q', type: 'probe' }],
        wires: [['a', 'n.in'], ['n.out', 'q']],
      });
      appendWorkspace(top, library, ws);
    };
    publishInverter();
    publishInverter();
    const inputs = [...top.components.values()].filter((c) => c.kind === 'input') as { value: 0 | 1; id: string }[];
    const probes = [...top.components.values()].filter((c) => c.kind === 'probe');
    expect(inputs).toHaveLength(2);
    inputs[0]!.value = 1;
    inputs[1]!.value = 0;
    const { nets, state } = settledLevels(top, library);
    const read = (i: number) => state.levelOf.get(nets.netOf.get(probes[i]!.pins.in.id)!);
    expect([read(0), read(1)]).toEqual([0, 1]);
    const names = [...top.components.values()].filter((c) => c.kind === 'label').map((c) => (c as { name: string }).name);
    expect(names).toContain('a_2');
  });

  it('puts at most one label on any pin, so a name is never drawn twice side by side', () => {
    const { top, library } = liveProject();
    const ws = new Workspace();
    ws.build(MAIN_SCOPE, {
      components: [
        { name: 'x', type: 'input', count: 4 }, { name: 'n', type: 'NOT', count: 4 },
        { name: 'y', type: 'probe', count: 4 }, { name: 'z', type: 'probe' }, { name: 'zin', type: 'input' },
      ],
      wires: [...Array(4).keys()].flatMap((i) => [[`x${i}`, `n${i}.in`], [`n${i}.out`, `y${i}`]]).concat([['zin', 'z']]),
    });
    appendWorkspace(top, library, ws);
    const ownerKind = (pinId: string) => top.components.get(pinId.slice(0, pinId.indexOf(':')))?.kind;
    const offenders: string[] = [];
    for (const c of top.components.values()) {
      if (c.kind === 'label') continue;
      for (const pin of Object.values(c.pins as Record<string, { id: string }>)) {
        const tied = [...top.wires.values()].filter((w) => (w.a === pin.id && ownerKind(w.b) === 'label') || (w.b === pin.id && ownerKind(w.a) === 'label'));
        if (tied.length > 1) offenders.push(`${c.kind} ${pin.id}: ${tied.length} labels`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('probe buses', () => {
    function publishInverterBus(width: number) {
      const { top, library } = liveProject();
      const ws = new Workspace();
      ws.build(MAIN_SCOPE, {
        components: [
          { name: 'x', type: 'input', count: width },
          { name: 'n', type: 'NOT', count: width },
          { name: 'y', type: 'probe', count: width },
          { name: 'single', type: 'probe' },
          { name: 'one', type: 'vcc' },
        ],
        wires: [...Array(width).keys()].flatMap((i) => [[`x${i}`, `n${i}.in`], [`n${i}.out`, `y${i}`]]).concat([['one', 'single']]),
      });
      appendWorkspace(top, library, ws);
      return { top, library };
    }

    it('become one bus probe with the bus name as its label, and single probes stay probes', () => {
      const { top } = publishInverterBus(4);
      const buses = [...top.components.values()].filter((c) => c.kind === 'busprobe');
      expect(buses).toHaveLength(1);
      expect(buses[0]).toMatchObject({ kind: 'busprobe', label: 'y', bitWidth: 4, radix: 'dec' });
      expect([...top.components.values()].filter((c) => c.kind === 'probe')).toHaveLength(1);
    });

    it('read the right value from the published circuit', () => {
      const { top, library } = publishInverterBus(4);
      const inputs = [...top.components.values()].filter((c) => c.kind === 'input') as { value: 0 | 1 }[];
      [1, 0, 1, 0].forEach((bit, i) => (inputs[i]!.value = bit as 0 | 1));
      const { nets, state } = settledLevels(top, library);
      const bus = [...top.components.values()].find((c) => c.kind === 'busprobe');
      if (bus?.kind !== 'busprobe') throw new Error('no bus probe published');
      const bits = bus.pinOrder.map((name) => ({ level: state.levelOf.get(nets.netOf.get(bus.pins[name]!.id)!) ?? 'Z', contended: false }));
      expect(decodeBusProbe(bits, 'dec')).toMatchObject({ value: 10, text: '10' });
    });

    it('name each bit net after the bus, so a label pair reads y0, y1, ...', () => {
      const { top } = publishInverterBus(4);
      const names = [...top.components.values()].filter((c) => c.kind === 'label').map((c) => (c as { name: string }).name);
      expect(names).toEqual(expect.arrayContaining(['y0', 'y1', 'y2', 'y3']));
    });

    it('are read back by name from the opened canvas', () => {
      const { top, library } = publishInverterBus(4);
      const ws = new Workspace(() => library);
      ws.openCanvas(top);
      expect(ws.simulate('canvas', { x: 5 }).outputs.y).toEqual({ value: 10, bits: '1010' });
    });

    it('leave a bus wider than the editor allows as separate probes', () => {
      const { top } = publishInverterBus(33);
      expect([...top.components.values()].filter((c) => c.kind === 'busprobe')).toHaveLength(0);
      expect([...top.components.values()].filter((c) => c.kind === 'probe')).toHaveLength(34);
    });
  });
});
