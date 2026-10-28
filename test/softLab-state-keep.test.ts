import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { placeTinyCpu } from '../src/sim/foldTinyCpu.js';
import { fold } from '../src/sim/hierarchy.js';
import { makeChipInstance } from '../src/sim/library.js';
import { circuitHasSoftSequentialChips } from '../src/sim/softLab.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

function seededLibrary(): ChipLibrary {
  const library = new ChipLibrary();
  seedStandardCells(library);
  return library;
}

describe('circuitHasSoftSequentialChips', () => {
  it('is false for an empty circuit', () => {
    expect(circuitHasSoftSequentialChips(new Circuit(), seededLibrary())).toBe(false);
  });

  it('is false for the gate-level Tiny CPU, whose chips hold state in gates', () => {
    const library = seededLibrary();
    const circuit = new Circuit();
    placeTinyCpu(circuit, library, 4, Uint8Array.of(0x01));
    expect(circuitHasSoftSequentialChips(circuit, library)).toBe(false);
  });

  it('is false for a combinational Soft model such as ADDER4', () => {
    const library = seededLibrary();
    const circuit = new Circuit();
    makeChipInstance(circuit, library.findByName('ADDER4')!, { x: 0, y: 0 });
    expect(circuitHasSoftSequentialChips(circuit, library)).toBe(false);
  });

  it('is true for a COUNTER4 on the sheet', () => {
    const library = seededLibrary();
    const circuit = new Circuit();
    makeChipInstance(circuit, library.findByName('COUNTER4')!, { x: 0, y: 0 });
    expect(circuitHasSoftSequentialChips(circuit, library)).toBe(true);
  });

  it('is true for a COUNTER4 nested inside a folded chip', () => {
    const library = seededLibrary();
    const circuit = new Circuit();
    const counter = makeChipInstance(circuit, library.findByName('COUNTER4')!, { x: 0, y: 0 });
    fold(circuit, new Set([counter.id]), 'WRAPPER', library, { x: 0, y: 0 });
    expect(circuitHasSoftSequentialChips(circuit, library)).toBe(true);
  });
});
