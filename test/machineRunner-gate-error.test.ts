import { describe, expect, it } from 'vitest';
import { MachineRunner } from '../src/machine/MachineRunner.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

describe('MachineRunner gate Run', () => {
  it('stops and records the error when a gate tick throws', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const circuit = new Circuit();
    const cpu = buildZ80Cpu(circuit, library, 12, undefined, { x: 0, y: 0 });

    let broken = false;
    const runner = new MachineRunner();
    runner.attach(circuit, library, cpu, () => {
      if (broken) throw new Error('tick exploded');
    });
    runner.boot();
    runner.setSpeed('turbo');
    runner.setRunning(true);
    expect(runner.tickBudget()).toBe(true);
    expect(runner.softError).toBeNull();
    expect(runner.running).toBe(true);

    broken = true;
    expect(() => runner.tickBudget()).not.toThrow();
    expect(runner.running).toBe(false);
    expect(runner.softError).toBe('tick exploded');
  });
});
