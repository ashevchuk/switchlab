import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { makeBusSwitch, makeChipInstance } from '../src/sim/library.js';
import { Editor } from '../src/ui/Editor.js';
import { LAB_CURRICULUM } from '../src/ui/LabCurriculum.js';

describe('Lab course checklist data', () => {
  it('has checklist items on ALU / mini-CPU steps', () => {
    const alu = LAB_CURRICULUM.find((s) => s.id === 'lab-alu4');
    const mini = LAB_CURRICULUM.find((s) => s.id === 'lab-mini-cpu');
    expect(alu?.checklist?.length).toBeGreaterThan(2);
    expect(mini?.checklist?.length).toBeGreaterThan(2);
  });
});

describe('Lab course steps', () => {
  it('each step names an example in the catalog', async () => {
    const { EXAMPLE_PROJECTS } = await import('../src/examples/catalog.js');
    const catalogIds = new Set(EXAMPLE_PROJECTS.map((e) => e.id));
    expect(LAB_CURRICULUM.filter((s) => !catalogIds.has(s.id)).map((s) => s.id)).toEqual([]);
  });
});

describe('Ribbon bus switch → chip', () => {
  it('wires b0.. to a0.. on ADDER4', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const circuit = new Circuit();
    const editor = new Editor(circuit, library);
    const sw = makeBusSwitch(circuit, 4, { x: 40, y: 100 }, 'hex', 0xa);
    const chip = makeChipInstance(circuit, library.findByName('ADDER4')!, { x: 280, y: 120 });
    editor.selectedIds.clear();
    editor.selectedIds.add(sw.id);
    editor.selectedIds.add(chip.id);
    expect(editor.canRibbonBusSwitch()).toBe(true);
    const n = editor.wireBusSwitchToHost(false);
    expect(n).toBe(4);
    const nets = circuit.computeNets();
    for (let i = 0; i < 4; i++) {
      const a = nets.netOf.get(sw.pins[`b${i}`]!.id);
      const b = nets.netOf.get(chip.pins[`a${i}`]!.id);
      expect(a).toBe(b);
    }
    expect(editor.wireBusSwitchToHost(false)).toBe(0);
  });
});
