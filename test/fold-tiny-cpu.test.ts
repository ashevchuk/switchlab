import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { placeTinyCpu, tinyCpuForRam, tinyPcPins } from '../src/sim/foldTinyCpu.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeInput, makeRam, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

/** LDI 1; OUT; XRI 1; OUT; JMP 0 — OUT0 toggles forever. */
const BLINK_PROGRAM = Uint8Array.of(0x01, 0xf0, 0x81, 0xf0, 0xe0);
const RESET_CYCLES = 2;
const CYCLES = 30;
/** OUT0 sampled after each full CLK cycle; undefined until the first OUT has run. */
const EXPECTED_OUT0 = [
  ...Array<undefined>(7).fill(undefined),
  ...Array(6).fill(1),
  ...Array(9).fill(0),
  ...Array(6).fill(1),
  ...Array(2).fill(0),
];

function tickHierarchical(parent: Circuit, library: ChipLibrary, state: SimState, n = 10): { state: SimState; netMap: NetMap } {
  let netMap!: NetMap;
  for (let i = 0; i < n; i++) {
    const flat = flatten(parent, library);
    netMap = flat.computeNets();
    state = step(flat, netMap, state);
  }
  return { state, netMap };
}

describe('placeTinyCpu — folded Tiny CPU', () => {
  it('exposes a named interface and named sub-blocks', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const { chip } = placeTinyCpu(parent, library, 4, BLINK_PROGRAM);

    const top = library.get(chip.defId);
    expect(top.name).toBe('TinyCPU');
    for (const port of ['CLK', 'RESET', 'PC0', 'PC3', 'OUT0', 'OUT7', 'ADDR0', 'ADDR3', 'DATA0', 'DATA7', 'WE', 'OE']) {
      expect(top.ports, port).toContain(port);
    }

    const anonymousPorts = library
      .list()
      .filter((def) => def.name.startsWith('Tiny'))
      .flatMap((def) => def.ports.filter((p) => /^p\d+$/.test(p)).map((p) => `${def.name}.${p}`));
    expect(anonymousPorts).toEqual([]);

    const blockNames = [...top.circuit.components.values()]
      .filter((c) => c.kind === 'chip')
      .map((c) => library.get(c.defId).name)
      .sort();
    expect(blockNames).toEqual(['TinyACC', 'TinyALU', 'TinyControl', 'TinyFSM', 'TinyIR', 'TinyOUT', 'TinyPC']);
  });

  it('runs the blink program from CLK and RESET alone', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const { chip } = placeTinyCpu(parent, library, 4, BLINK_PROGRAM);
    const clk = makeInput(parent, 1);
    const reset = makeInput(parent, 1);
    wire(parent, clk.pins.out, chip.pins.CLK!);
    wire(parent, reset.pins.out, chip.pins.RESET!);

    let state = initialState();
    let netMap!: NetMap;
    const tick = () => ({ state, netMap } = tickHierarchical(parent, library, state));
    const out0: (Level | undefined)[] = [];
    const pcs = new Set<number>();
    const readPc = () => tinyPcPins(chip).reduce((sum, pin, i) => sum + (levelAt(state, netMap, pin.id) === 1 ? 1 << i : 0), 0);
    tick();
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      if (cycle === RESET_CYCLES) reset.value = 0;
      clk.value = 0;
      tick();
      clk.value = 1;
      tick();
      out0.push(levelAt(state, netMap, chip.pins.OUT0!.id));
      pcs.add(readPc());
    }

    // PC advances before an instruction executes, so JMP at address 4 is seen with PC = 5.
    expect(pcs).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(out0.slice(EXPECTED_OUT0.findIndex((v) => v !== undefined))).toEqual(EXPECTED_OUT0.filter((v) => v !== undefined));
  });
});

describe('tinyCpuForRam', () => {
  it('finds the chip wired to its RAM and ignores any other RAM', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const { chip, ram } = placeTinyCpu(parent, library, 4, BLINK_PROGRAM);
    const otherRam = makeRam(parent, 4, 8);

    expect(tinyCpuForRam(parent, library, ram)).toBe(chip);
    expect(tinyCpuForRam(parent, library, otherRam)).toBeUndefined();
  });
});

describe('Tiny CPU blinker example', () => {
  it('loads from the catalog and blinks OUT0 once RESET is released', async () => {
    const { EXAMPLE_PROJECTS } = await import('../src/examples/catalog.js');
    const { deserializeProject, resolveStdcellInstances } = await import('../src/sim/serialize.js');
    const { seedStandardCells } = await import('../src/sim/stdcells.js');
    const example = EXAMPLE_PROJECTS.find((e) => e.id === 'tiny-cpu-blink')!;
    const { topCircuit, library } = deserializeProject(example.project);
    seedStandardCells(library);
    resolveStdcellInstances(topCircuit, library);

    const parts = [...topCircuit.components.values()];
    const clk = parts.find((c) => c.kind === 'clock')!;
    const reset = parts.find((c) => c.kind === 'button')!;
    const led = parts.find((c) => c.kind === 'led')!;
    if (clk.kind !== 'clock' || reset.kind !== 'button' || led.kind !== 'led') throw new Error('example is missing its clock, button or LED');
    expect(reset.value).toBe(1);

    let state = initialState();
    let netMap!: NetMap;
    const tick = () => ({ state, netMap } = tickHierarchical(topCircuit, library, state));
    const ledLevels: Level[] = [];
    tick();
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      if (cycle === RESET_CYCLES) reset.value = 0;
      clk.value = 0;
      tick();
      clk.value = 1;
      tick();
      ledLevels.push(levelAt(state, netMap, led.pins.in.id));
    }

    expect(ledLevels).toContain(1);
    expect(ledLevels.slice(EXPECTED_OUT0.findIndex((v) => v !== undefined))).toEqual(EXPECTED_OUT0.filter((v) => v !== undefined));
  });
});
