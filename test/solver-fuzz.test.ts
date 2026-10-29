import { afterEach, describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import {
  buildNand,
  buildNor,
  buildNot,
  buildSrLatch,
  makeInput,
  makeSource,
  makeTransistor,
  wire,
} from '../src/sim/library.js';
import { initialState, setSolverEngine, shadowOrderedStats, step } from '../src/sim/solver.js';
import type { InputComponent, Level, NetMap, Pin, SimState } from '../src/sim/types.js';

/** Small deterministic generator, so a failing seed can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Signal {
  pin: Pin;
  value: (inputs: number[]) => 0 | 1;
}

interface RandomLogic {
  circuit: Circuit;
  inputs: InputComponent[];
  gates: Signal[];
}

/** An acyclic network of CMOS NOT/NAND/NOR gates; every gate's boolean function is known. */
function randomLogic(seed: number, inputCount: number, gateCount: number): RandomLogic {
  const next = random(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  const circuit = new Circuit();
  makeSource(circuit, 1);
  makeSource(circuit, 0);
  const inputs = Array.from({ length: inputCount }, () => makeInput(circuit, 0));
  const signals: Signal[] = inputs.map((input, i) => ({ pin: input.pins.out, value: (v) => v[i] as 0 | 1 }));
  const gates: Signal[] = [];
  for (let g = 0; g < gateCount; g++) {
    const kind = pick(['not', 'nand', 'nor'] as const);
    const a = pick(signals);
    let gate: Signal;
    if (kind === 'not') {
      const cell = buildNot(circuit);
      wire(circuit, a.pin, cell.in);
      gate = { pin: cell.out, value: (v) => (1 - a.value(v)) as 0 | 1 };
    } else {
      const b = pick(signals);
      const cell = kind === 'nand' ? buildNand(circuit) : buildNor(circuit);
      wire(circuit, a.pin, cell.a);
      wire(circuit, b.pin, cell.b);
      gate =
        kind === 'nand'
          ? { pin: cell.out, value: (v) => (1 - (a.value(v) & b.value(v))) as 0 | 1 }
          : { pin: cell.out, value: (v) => (1 - (a.value(v) | b.value(v))) as 0 | 1 };
    }
    signals.push(gate);
    gates.push(gate);
  }
  return { circuit, inputs, gates };
}

function levelOfPin(netMap: NetMap, state: SimState, pin: Pin): Level {
  const net = netMap.netOf.get(pin.id);
  return net === undefined ? 'Z' : (state.levelOf.get(net) ?? 'Z');
}

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const VECTORS_PER_CIRCUIT = 6;

describe('solver on random circuits', () => {
  afterEach(() => setSolverEngine('ordered'));

  describe.each(['ordered', 'shadow-ordered'] as const)('%s engine', (engine) => {
    it.each(SEEDS)('combinational network, seed %i, matches the boolean function of every gate', (seed) => {
      setSolverEngine(engine);
      const next = random(seed * 7919);
      const inputCount = 3 + Math.floor(next() * 3);
      // Past ~16 gates VCC and GND have enough connections to be tracked as hubs.
      const gateCount = seed % 3 === 0 ? 40 + Math.floor(next() * 30) : 4 + Math.floor(next() * 14);
      const { circuit, inputs, gates } = randomLogic(seed, inputCount, gateCount);
      const netMap = circuit.computeNets();
      let state = initialState();
      for (let v = 0; v < VECTORS_PER_CIRCUIT; v++) {
        const vector = inputs.map(() => (next() < 0.5 ? 0 : 1));
        inputs.forEach((input, i) => (input.value = vector[i] as 0 | 1));
        state = step(circuit, netMap, state);
        expect(state.settled).toBe(true);
        gates.forEach((gate, g) => {
          expect(levelOfPin(netMap, state, gate.pin), `seed ${seed}, vector ${v}, gate ${g}`).toBe(gate.value(vector));
        });
      }
    });

    it.each(SEEDS.slice(0, 15))('SR latches, seed %i, remember what was last set or reset', (seed) => {
      setSolverEngine(engine);
      const next = random(seed * 104729);
      const circuit = new Circuit();
      makeSource(circuit, 1);
      makeSource(circuit, 0);
      const latchCount = 1 + Math.floor(next() * 4);
      const latches = Array.from({ length: latchCount }, () => {
        const latch = buildSrLatch(circuit);
        const set = makeInput(circuit, 1);
        const reset = makeInput(circuit, 1);
        wire(circuit, set.pins.out, latch.setPin);
        wire(circuit, reset.pins.out, latch.resetPin);
        return { latch, set, reset, expected: 0 as 0 | 1 };
      });
      const netMap = circuit.computeNets();
      let state = initialState();
      // Each latch is first set or reset on purpose; after that hold, set and reset are mixed.
      for (let step_ = 0; step_ < 8; step_++) {
        for (const l of latches) {
          const action = step_ === 0 ? (next() < 0.5 ? 'set' : 'reset') : (['hold', 'set', 'reset'] as const)[Math.floor(next() * 3)]!;
          l.set.value = action === 'set' ? 0 : 1;
          l.reset.value = action === 'reset' ? 0 : 1;
          if (action === 'set') l.expected = 1;
          if (action === 'reset') l.expected = 0;
        }
        state = step(circuit, netMap, state);
        // The latch input is active low: after the pulse the inputs return to 1 and the latch must hold.
        for (const l of latches) {
          l.set.value = 1;
          l.reset.value = 1;
        }
        state = step(circuit, netMap, state);
        expect(state.settled).toBe(true);
        for (const [i, l] of latches.entries()) {
          expect(levelOfPin(netMap, state, l.latch.q), `seed ${seed}, round ${step_}, latch ${i}`).toBe(l.expected);
          expect(levelOfPin(netMap, state, l.latch.qn)).toBe(l.expected === 1 ? 0 : 1);
        }
      }
    });

    it.each(SEEDS.slice(0, 15))('pass-gate sample and hold, seed %i, keeps the sampled value while the enable is off', (seed) => {
      setSolverEngine(engine);
      const next = random(seed * 15485863);
      const circuit = new Circuit();
      makeSource(circuit, 1);
      makeSource(circuit, 0);
      const cellCount = 1 + Math.floor(next() * 4);
      const cells = Array.from({ length: cellCount }, () => {
        const data = makeInput(circuit, 0);
        const enable = makeInput(circuit, 1);
        const pass = makeTransistor(circuit, 'N');
        const reader = buildNot(circuit);
        wire(circuit, enable.pins.out, pass.pins.gate);
        wire(circuit, data.pins.out, pass.pins.drain);
        wire(circuit, pass.pins.source, reader.in);
        return { data, enable, node: pass.pins.source, reader, held: 0 as 0 | 1 };
      });
      const netMap = circuit.computeNets();
      let state = initialState();
      for (let round = 0; round < 8; round++) {
        // Sample a random value with the enable on, then close the gate and wiggle the data.
        for (const c of cells) {
          c.held = next() < 0.5 ? 0 : 1;
          c.data.value = c.held;
          c.enable.value = 1;
        }
        state = step(circuit, netMap, state);
        for (const c of cells) c.enable.value = 0;
        state = step(circuit, netMap, state);
        for (const c of cells) c.data.value = (1 - c.held) as 0 | 1;
        state = step(circuit, netMap, state);
        expect(state.settled).toBe(true);
        for (const [i, c] of cells.entries()) {
          expect(levelOfPin(netMap, state, c.node), `seed ${seed}, round ${round}, cell ${i}`).toBe(c.held);
          expect(levelOfPin(netMap, state, c.reader.out)).toBe(c.held === 1 ? 0 : 1);
        }
      }
    });
  });

  it('checks the ordered engine against the dense one on every tick, not only on its own', () => {
    setSolverEngine('shadow-ordered');
    const before = { ...shadowOrderedStats };
    const { circuit, inputs } = randomLogic(99, 4, 30);
    const netMap = circuit.computeNets();
    let state = initialState();
    for (let v = 0; v < 8; v++) {
      inputs.forEach((input, i) => (input.value = ((v >> i) & 1) as 0 | 1));
      state = step(circuit, netMap, state);
    }
    expect(shadowOrderedStats.compared - before.compared).toBe(8);
    expect(shadowOrderedStats.skipped - before.skipped).toBe(0);
  });
});
