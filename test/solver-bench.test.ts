import { describe, expect, it } from 'vitest';
import { SCENARIOS, behaviourOf, runScenario } from '../scripts/lib/solverBench.js';

const TINY = SCENARIOS.find((s) => s.name === 'tiny-cpu')!;
const TICKS = 300;

describe('solver benchmark harness', () => {
  it('reproduces the same behaviour digest on a second run in the same process', () => {
    const first = runScenario(TINY, TICKS);
    const second = runScenario(TINY, TICKS);
    expect(behaviourOf(second)).toEqual(behaviourOf(first));
  });

  it('runs a circuit that is actually executing, not a frozen one', () => {
    const result = runScenario(TINY, TICKS);
    const pcs = new Set(result.trace.map((line) => line.split(' ')[0]));
    expect(pcs.size).toBeGreaterThan(3);
    expect(result.trace.some((line) => line.endsWith('out=1'))).toBe(true);
    expect(result.iterations.capped).toBe(0);
  });

  it('measures every tick it reports', () => {
    const result = runScenario(TINY, TICKS);
    expect(result.ticks).toBe(TICKS);
    expect(result.nets).toBeGreaterThan(1000);
    expect(result.stepMs.total).toBeGreaterThan(0);
    expect(result.changed.max).toBeGreaterThan(0);
  });
});
