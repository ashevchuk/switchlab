import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit, bumpStructureVersion } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeSource } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';

describe('editing a Source', () => {
  it('shows up in the next tick once the structure version is bumped', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    const source = makeSource(circuit, 1);

    const read = (state = initialState()) => {
      const flat = flatten(circuit, library);
      const netMap = flat.computeNets();
      const next = step(flat, netMap, state);
      return { next, level: next.levelOf.get(netMap.netOf.get(source.pins.out.id)!) };
    };

    const high = read();
    expect(high.level).toBe(1);

    source.value = 0;
    bumpStructureVersion();
    expect(read(high.next).level).toBe(0);
  });
});
