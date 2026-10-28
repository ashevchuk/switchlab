import { afterEach, describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeInput } from '../src/sim/library.js';
import { initialState, setSolverEngine, step } from '../src/sim/solver.js';
import type { NetMap, SimState } from '../src/sim/types.js';

function tick(circuit: Circuit, library: ChipLibrary, state: SimState): { state: SimState; netMap: NetMap } {
  const flat = flatten(circuit, library);
  const netMap = flat.computeNets();
  return { state: step(flat, netMap, state), netMap };
}

describe('event solver level snapshot', () => {
  afterEach(() => setSolverEngine('event'));

  it('is a read-only Map that keeps each tick as it was', () => {
    setSolverEngine('event');
    const library = new ChipLibrary();
    const circuit = new Circuit();
    const input = makeInput(circuit, 1);

    const first = tick(circuit, library, initialState());
    const net = first.netMap.netOf.get(input.pins.out.id)!;
    input.value = 0;
    const second = tick(circuit, library, first.state);

    expect(first.state.levelOf.get(net)).toBe(1);
    expect(second.state.levelOf.get(net)).toBe(0);
    expect(second.state.levelOf).toBeInstanceOf(Map);
    expect(second.state.levelOf.size).toBe(second.netMap.pinsOf.size);
    expect(second.state.levelOf.has(net)).toBe(true);
    expect(second.state.levelOf.has('no such net')).toBe(false);
    expect(second.state.levelOf.get('no such net')).toBeUndefined();
    expect(() => second.state.levelOf.set(net, 1)).toThrow(/read-only/);
  });

  it('iterates and copies like the Map the dense solver returns', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    makeInput(circuit, 1);
    makeInput(circuit, 0);

    setSolverEngine('jacobi');
    const dense = tick(circuit, library, initialState()).state.levelOf;
    setSolverEngine('event');
    const view = tick(circuit, library, initialState()).state.levelOf;

    expect(new Map(view)).toEqual(new Map(dense));
    expect([...view.keys()]).toEqual([...dense.keys()]);
    expect([...view.values()]).toEqual([...dense.values()]);
    const seen: [string, string][] = [];
    view.forEach((level, netId) => seen.push([netId, String(level)]));
    expect(seen).toEqual([...dense].map(([netId, level]) => [netId, String(level)]));
  });
});
