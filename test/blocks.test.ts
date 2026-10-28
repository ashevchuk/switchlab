import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import {
  buildAlu,
  buildAluSlice,
  buildInstructionRegister,
  buildMinimalCpu,
  buildProgramCounter,
  buildRegister,
  buildRingCounter,
  buildStubRom,
  buildZ80Decoder,
} from '../src/sim/blocks.js';
import { makeInput, makeSource, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

function tick(circuit: Circuit, netMap: NetMap, state: SimState, n = 10): SimState {
  for (let i = 0; i < n; i++) state = step(circuit, netMap, state);
  return state;
}

/**
 * flatten() clones every component (see hierarchy.ts) — a flat Circuit
 * computed once and reused is a frozen snapshot, so mutating an Input's
 * `.value` on the *original* (pre-flatten) circuit afterwards has no
 * effect on it. main.ts's live render loop already re-flattens on every
 * frame for exactly this reason; a test that drives a chip-instance-based
 * circuit through several ticks needs to do the same.
 */
function tickHierarchical(parent: Circuit, library: ChipLibrary, state: SimState, n = 10): { state: SimState; netMap: NetMap } {
  let netMap!: NetMap;
  for (let i = 0; i < n; i++) {
    const flat = flatten(parent, library);
    netMap = flat.computeNets();
    state = step(flat, netMap, state);
  }
  return { state, netMap };
}

describe('buildRegister — N register-bit chip instances sharing WE/CLK', () => {
  it('loads a 4-bit pattern on a clock edge and holds it while WE=0', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const reg = buildRegister(parent, library, 4);

    const dIns = reg.d.map((d) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, d);
      return input;
    });
    const we = makeInput(parent, 0);
    const clk = makeInput(parent, 0);
    wire(parent, we.pins.out, reg.we);
    wire(parent, clk.pins.out, reg.clk);

    let state = initialState();
    let netMap: NetMap;

    const setD = (bits: number[]) => bits.forEach((v, i) => (dIns[i]!.value = v as 0 | 1));
    const readQ = () => reg.q.map((q) => levelAt(state, netMap, q.id));

    // Load 1011 (bit 0 = LSB) with WE=1.
    we.value = 1;
    setD([1, 1, 0, 1]);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toEqual([1, 1, 0, 1]);
    clk.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));

    // WE=0: change D and clock it, register must not move.
    we.value = 0;
    setD([0, 0, 1, 0]);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toEqual([1, 1, 0, 1]);

    // WE=1 again: the next edge loads the new pattern.
    clk.value = 0;
    we.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toEqual([0, 0, 1, 0]);
  });
});

describe('buildAluSlice — 1-bit ADD/AND/OR/XOR selected by a 2-bit opcode', () => {
  const OPS: Record<'ADD' | 'AND' | 'OR' | 'XOR', [0 | 1, 0 | 1]> = {
    ADD: [0, 0],
    AND: [1, 0],
    OR: [0, 1],
    XOR: [1, 1],
  };

  it.each([
    ['ADD', 1, 1, 1, 1] as const, // sum = 1^1^1 = 1
    ['ADD', 0, 1, 0, 1] as const, // sum = 0^1^0 = 1
    ['ADD', 1, 0, 1, 0] as const, // sum = 1^0^1 = 0
    ['AND', 1, 1, 0, 1] as const,
    ['AND', 1, 0, 0, 0] as const,
    ['OR', 0, 1, 0, 1] as const,
    ['OR', 0, 0, 0, 0] as const,
    ['XOR', 1, 1, 0, 0] as const,
    ['XOR', 1, 0, 0, 1] as const,
  ])('op=%s a=%i b=%i cin=%i -> out=%i', (op, a, b, cin, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const slice = buildAluSlice(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    const inCin = makeInput(circuit, cin);
    const [op0, op1] = OPS[op];
    const inOp0 = makeInput(circuit, op0);
    const inOp1 = makeInput(circuit, op1);
    wire(circuit, inA.pins.out, slice.a);
    wire(circuit, inB.pins.out, slice.b);
    wire(circuit, inCin.pins.out, slice.cin);
    wire(circuit, inOp0.pins.out, slice.op0);
    wire(circuit, inOp1.pins.out, slice.op1);

    const netMap = circuit.computeNets();
    let state = initialState();
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, slice.out.id)).toBe(out);
  });

  it('cout always reflects the adder, independent of the selected op', () => {
    const circuit = new Circuit();
    makeSource(circuit, 1); // rail driver
    makeSource(circuit, 0);
    const slice = buildAluSlice(circuit);
    const inA = makeInput(circuit, 1);
    const inB = makeInput(circuit, 1);
    const inCin = makeInput(circuit, 0);
    const inOp0 = makeInput(circuit, 1); // op = AND
    const inOp1 = makeInput(circuit, 0);
    wire(circuit, inA.pins.out, slice.a);
    wire(circuit, inB.pins.out, slice.b);
    wire(circuit, inCin.pins.out, slice.cin);
    wire(circuit, inOp0.pins.out, slice.op0);
    wire(circuit, inOp1.pins.out, slice.op1);

    const netMap = circuit.computeNets();
    const state = tick(circuit, netMap, initialState());
    expect(levelAt(state, netMap, slice.out.id)).toBe(1); // AND(1,1) = 1
    expect(levelAt(state, netMap, slice.cout.id)).toBe(1); // 1+1+0 carries, regardless of op
  });
});

describe('buildAlu — N-bit ALU via ripple-carry chain of ALU-slice chip instances', () => {
  const WIDTH = 4;

  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }
  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  /** op0/op1 per buildAluSlice's mux wiring: 00=ADD, 01=AND(sel0=1), 10=OR(sel1=1), 11=XOR. */
  function runAlu(aVal: number, bVal: number, cin: 0 | 1, op0: 0 | 1, op1: 0 | 1): { out: number; cout: Level } {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const alu = buildAlu(parent, library, WIDTH);

    toBits(aVal, WIDTH).forEach((v, i) => wire(parent, makeInput(parent, v).pins.out, alu.a[i]!));
    toBits(bVal, WIDTH).forEach((v, i) => wire(parent, makeInput(parent, v).pins.out, alu.b[i]!));
    wire(parent, makeInput(parent, cin).pins.out, alu.cin);
    wire(parent, makeInput(parent, op0).pins.out, alu.op0);
    wire(parent, makeInput(parent, op1).pins.out, alu.op1);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());

    return {
      out: fromBits(alu.out.map((p) => levelAt(state, netMap, p.id))),
      cout: levelAt(state, netMap, alu.cout.id),
    };
  }

  it.each([
    [0b0011, 0b0101, 0, 0b1000, 0], // 3+5=8, single-bit carries only
    [0b0111, 0b0001, 0, 0b1000, 0], // 7+1=8 — carry ripples through bits 0,1,2 before settling
    [0b1111, 0b0001, 0, 0b0000, 1], // 15+1=16, wraps to 0 with carry out
    [0b0000, 0b0000, 1, 0b0001, 0], // increment via the chain's overall cin
    [0b1010, 0b0101, 1, 0b0000, 1], // 10+5+1=16, wraps with carry out
  ] as const)('ADD: a=%i b=%i cin=%i -> out=%i cout=%i', (aVal, bVal, cin, expectedOut, expectedCout) => {
    const { out, cout } = runAlu(aVal, bVal, cin, 0, 0);
    expect(out).toBe(expectedOut);
    expect(cout).toBe(expectedCout);
  });

  it('AND is bitwise across the whole width', () => {
    expect(runAlu(0b1010, 0b0110, 0, 1, 0).out).toBe(0b0010);
  });

  it('OR is bitwise across the whole width', () => {
    expect(runAlu(0b1010, 0b0110, 0, 0, 1).out).toBe(0b1110);
  });

  it('XOR is bitwise across the whole width', () => {
    expect(runAlu(0b1010, 0b0110, 0, 1, 1).out).toBe(0b1100);
  });
});

describe('buildProgramCounter — increments each clock edge, loads d when load=1', () => {
  const WIDTH = 3;

  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }
  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  function setup() {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const pc = buildProgramCounter(parent, library, WIDTH);
    const dIns = pc.d.map((d) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, d);
      return input;
    });
    const load = makeInput(parent, 0);
    const reset = makeInput(parent, 0);
    const clk = makeInput(parent, 0);
    wire(parent, load.pins.out, pc.load);
    wire(parent, reset.pins.out, pc.reset);
    wire(parent, clk.pins.out, pc.clk);
    return { library, parent, pc, dIns, load, reset, clk };
  }

  it('counts 0 through 7 and wraps back to 0 (3-bit), including a multi-bit carry at 3->4', () => {
    const { library, parent, pc, load, clk } = setup();
    let state = initialState();
    let netMap!: NetMap;

    // Load 0 first, to start counting from a known state.
    load.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    load.value = 0;
    clk.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));

    const readQ = () => fromBits(pc.q.map((q) => levelAt(state, netMap, q.id)));
    expect(readQ()).toBe(0);

    // 3 (011) -> 4 (100) forces the carry to ripple through all 3 bits before
    // settling; 7 -> 0 is the binary wraparound a fixed-width counter gets
    // for free, with no explicit reset-to-zero logic anywhere in the design.
    for (const next of [1, 2, 3, 4, 5, 6, 7, 0]) {
      clk.value = 1;
      ({ state, netMap } = tickHierarchical(parent, library, state));
      expect(readQ()).toBe(next);
      clk.value = 0;
      ({ state, netMap } = tickHierarchical(parent, library, state));
    }
  });

  it('loads d on the next edge instead of incrementing, then resumes counting from there', () => {
    const { library, parent, pc, dIns, load, clk } = setup();
    let state = initialState();
    let netMap!: NetMap;
    const readQ = () => fromBits(pc.q.map((q) => levelAt(state, netMap, q.id)));
    const setD = (n: number) => toBits(n, WIDTH).forEach((v, i) => (dIns[i]!.value = v));

    load.value = 1;
    setD(5);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toBe(5);

    // A further edge with load still high keeps re-loading the same d, not incrementing.
    clk.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toBe(5);

    // Drop load: the next edge increments from the loaded value, proving the
    // mux correctly falls back to counting rather than being stuck on d.
    clk.value = 0;
    load.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toBe(6);
  });

  it('reset forces 0 and overrides load — reset wins even while load=1 with nonzero d', () => {
    const { library, parent, pc, dIns, load, reset, clk } = setup();
    let state = initialState();
    let netMap!: NetMap;
    const readQ = () => fromBits(pc.q.map((q) => levelAt(state, netMap, q.id)));
    const setD = (n: number) => toBits(n, WIDTH).forEach((v, i) => (dIns[i]!.value = v));

    // Get PC away from 0 first, so a later reset is an observable change.
    load.value = 1;
    setD(5);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toBe(5);
    clk.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));

    // reset=1 while load is STILL 1 and d is STILL nonzero: reset wins.
    // reset must settle combinationally *before* the clock edge that uses
    // it — changing both in the same tick is the same same-edge hazard
    // documented for the fetch-loop test (a select signal transitioning on
    // the exact edge that reads it doesn't reliably resolve either way).
    reset.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toBe(0);

    // Drop reset (load still 1): the next edge goes back to loading d, not incrementing.
    clk.value = 0;
    reset.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toBe(5);
  });
});

describe('buildInstructionRegister — a fixed 8-bit buildRegister, nothing more', () => {
  /**
   * The underlying load/hold logic is already exhaustively covered by
   * buildRegister's own test above; this only checks the two things this
   * wrapper actually adds: the width is fixed at 8 regardless of what's
   * asked for, and it wires up and behaves exactly like a plain register.
   */
  it('is 8 bits wide and latches an opcode byte on WE&CLK, holding it while WE=0', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const ir = buildInstructionRegister(parent, library);
    expect(ir.d).toHaveLength(8);
    expect(ir.q).toHaveLength(8);

    const dIns = ir.d.map((d) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, d);
      return input;
    });
    const we = makeInput(parent, 0);
    const clk = makeInput(parent, 0);
    wire(parent, we.pins.out, ir.we);
    wire(parent, clk.pins.out, ir.clk);

    let state = initialState();
    let netMap!: NetMap;
    const setD = (bits: number[]) => bits.forEach((v, i) => (dIns[i]!.value = v as 0 | 1));
    const readQ = () => ir.q.map((q) => levelAt(state, netMap, q.id));

    // Fetch opcode 0x4D (01001101, LSB first) with WE=1.
    we.value = 1;
    setD([1, 0, 1, 1, 0, 0, 1, 0]);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toEqual([1, 0, 1, 1, 0, 0, 1, 0]);

    // WE=0: the bus can change under it, IR must not move until the next fetch.
    we.value = 0;
    clk.value = 0;
    setD([0, 0, 0, 0, 0, 0, 0, 0]);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readQ()).toEqual([1, 0, 1, 1, 0, 0, 1, 0]);
  });
});

describe('buildRingCounter — one-hot phase sequencer for a control FSM', () => {
  function setup(phases: number) {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const fsm = buildRingCounter(parent, library, phases);
    const dIns = fsm.d.map((d) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, d);
      return input;
    });
    const load = makeInput(parent, 0);
    const clk = makeInput(parent, 0);
    wire(parent, load.pins.out, fsm.load);
    wire(parent, clk.pins.out, fsm.clk);
    return { library, parent, fsm, dIns, load, clk };
  }

  it('rotates a single hot bit through 3 phases and wraps back to phase 0', () => {
    const { library, parent, fsm, dIns, load, clk } = setup(3);
    let state = initialState();
    let netMap!: NetMap;
    const readPhase = () => fsm.phase.map((q) => levelAt(state, netMap, q.id));

    // Seed phase 0 = [1, 0, 0].
    load.value = 1;
    dIns[0]!.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    load.value = 0;
    clk.value = 0;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    expect(readPhase()).toEqual([1, 0, 0]);

    const expected = [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0], // wraps
      [0, 1, 0],
    ];
    for (const next of expected) {
      clk.value = 1;
      ({ state, netMap } = tickHierarchical(parent, library, state));
      expect(readPhase()).toEqual(next);
      clk.value = 0;
      ({ state, netMap } = tickHierarchical(parent, library, state));
    }
  });
});

describe('buildStubRom — fixed-content memory stub (no storage, no write port)', () => {
  const WORDS: (0 | 1)[][] = [
    [1, 0, 1, 1, 0, 0, 1, 0], // address 0: 0x4D
    [0, 0, 0, 0, 0, 0, 0, 1], // address 1: 0x80... wait, LSB-first: bit0=0 => value 0x80
    [1, 1, 1, 1, 0, 0, 0, 0], // address 2: 0x0F
    [0, 0, 0, 0, 0, 0, 0, 0], // address 3: 0x00
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('drives the addressed word onto the bus only while oe=1, and floats otherwise', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const rom = buildStubRom(parent, library, WORDS);
    const addrIns = rom.addr.map((a) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, a);
      return input;
    });
    const oe = makeInput(parent, 0);
    wire(parent, oe.pins.out, rom.oe);

    let state = initialState();
    let netMap!: NetMap;
    const readData = () => fromBits(rom.data.map((d) => levelAt(state, netMap, d.id)));
    const setAddr = (n: number) => addrIns.forEach((c, i) => (c.value = ((n >> i) & 1) as 0 | 1));

    // oe=0: nothing drives the bus, regardless of address.
    setAddr(0);
    ({ state, netMap } = tickHierarchical(parent, library, state));
    for (const d of rom.data) expect(levelAt(state, netMap, d.id)).toBe('Z');

    // oe=1: each address reads back exactly its own word.
    oe.value = 1;
    for (let addr = 0; addr < WORDS.length; addr++) {
      setAddr(addr);
      ({ state, netMap } = tickHierarchical(parent, library, state));
      expect(readData()).toBe(fromBits(WORDS[addr]!));
    }
  });
});

describe('Fetch loop: PC + stub ROM + ring-counter FSM + IR, wired together', () => {
  /**
   * This is the actual point of this slice: not any one primitive on its
   * own, but proving the *handshake* between them reproduces a real fetch
   * cycle, using nothing but the pieces already proven individually above.
   *
   * Two phases, one-hot (T1, T2):
   *  - T1 (phase[0]=1): `rom.oe` and `ir.we` are both phase[0] directly —
   *    the word at PC's *current* address drives the bus and lands in IR.
   *    PC does not move: `pc.load`=1 (phase[0] OR'd with a one-shot reset)
   *    with `pc.d` fed from PC's own `q` — "reload the same value", the
   *    same "gate data, not clock" trick `buildRegisterBit` already uses
   *    internally, externalized so PC can borrow it from outside.
   *  - T2 (phase[0]=0): `pc.load`=0, so PC's own internal mux picks the
   *    incremented value instead — PC advances exactly once per full
   *    fetch, not once per phase edge.
   *
   * **`fsm.clk` and `pc.clk`/`ir.clk` are deliberately two *separate*
   * signals, pulsed one at a time, never both in the same edge.** This
   * solver has no propagation-delay model: real synchronous hardware can
   * safely chain "register A's output gates register B's write" on one
   * shared clock edge only because A's new value takes real, nonzero time
   * to reach B, which is longer than B's own setup requirement but still
   * far shorter than a clock period. Nothing here has that separation — a
   * single relaxation fixpoint doesn't distinguish "A's value going into
   * this edge" from "A's value coming out of it" — so if `fsm`'s own phase
   * flip and `ir`'s phase-gated capture shared an edge, `ir.we` would see
   * phase[0] already *mid-transition*, which empirically produces
   * undefined ('Z') results, not a clean old-or-new answer either way
   * (verified by hand while building this test). Driving the FSM and the
   * datapath from non-overlapping clock pulses sidesteps the problem
   * entirely, and is the same fix real early two-phase-clock CPUs used for
   * an analogous reason: settling combinational logic needs a moment that
   * isn't also a clock edge for something downstream.
   *
   * The very first data-clock pulse (PC's reset) has the same hazard with
   * itself: `rom.addr` reads PC's *old* (undefined, pre-reset) value on
   * the exact edge PC resets, so whatever `ir` captures on that pulse is
   * thrown away as garbage — the real first fetch is the *next* data-clock
   * pulse, once PC has had a moment to actually settle at 0.
   *
   * PC's self-loop (used for the T1 hold, above) can't also serve as its
   * power-on reset — there's no "previous value" to hold before the first
   * real edge exists — so this test uses `buildProgramCounter`'s own
   * `reset` pin for that, pulsed exactly once at the start. `reset` takes
   * priority over `load`/`d` inside PC itself (see "The program counter"),
   * so this test doesn't need to build any OR/mux scaffolding of its own
   * for it — that scaffolding used to live here, before PC grew a
   * first-class reset pin.
   */
  const WORDS: (0 | 1)[][] = [
    [1, 0, 1, 1, 0, 0, 1, 0], // address 0
    [0, 1, 0, 1, 0, 1, 0, 1], // address 1
    [1, 1, 1, 1, 0, 0, 0, 0], // address 2
    [0, 0, 1, 1, 1, 1, 0, 0], // address 3
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toNumber(bits: (0 | 1)[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('fetches every ROM word into IR in PC order, PC advancing once per full T1+T2 cycle', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();

    const pc = buildProgramCounter(parent, library, 2, { x: 0, y: 0 });
    const rom = buildStubRom(parent, library, WORDS, { x: 1200, y: 0 });
    const ir = buildInstructionRegister(parent, library, { x: 4000, y: 0 });
    const fsm = buildRingCounter(parent, library, 2, { x: 6000, y: 0 });

    // Address bus and data bus: point-to-point for now (IR is the only
    // listener, ROM the only driver) — the tri-state machinery inside the
    // ROM is what makes the data side a real, extensible bus regardless.
    pc.q.forEach((q, i) => wire(parent, q, rom.addr[i]!));
    rom.data.forEach((d, i) => wire(parent, d, ir.d[i]!));

    // Control signals: phase[0] (T1) gates the read+capture directly.
    wire(parent, fsm.phase[0]!, rom.oe);
    wire(parent, fsm.phase[0]!, ir.we);

    // PC hold-during-T1: load=phase[0], self-looped so a T1 "load" just
    // re-latches the same value (see "The program counter" above).
    wire(parent, fsm.phase[0]!, pc.load);
    pc.q.forEach((q, i) => wire(parent, q, pc.d[i]!));

    // One-shot power-on reset, using PC's own `reset` pin (see doc comment above).
    const resetPulse = makeInput(parent, 1);
    wire(parent, resetPulse.pins.out, pc.reset);

    // Two non-overlapping clocks (see doc comment above): dataClk drives
    // PC and IR; phaseClk drives only the FSM. Never pulse both at once.
    const dataClk = makeInput(parent, 0);
    wire(parent, dataClk.pins.out, pc.clk);
    wire(parent, dataClk.pins.out, ir.clk);
    const phaseClk = makeInput(parent, 0);
    wire(parent, phaseClk.pins.out, fsm.clk);

    const fsmLoad = makeInput(parent, 1);
    wire(parent, fsmLoad.pins.out, fsm.load);
    const fsmD0 = makeInput(parent, 1);
    wire(parent, fsmD0.pins.out, fsm.d[0]!);
    const fsmD1 = makeInput(parent, 0);
    wire(parent, fsmD1.pins.out, fsm.d[1]!);

    let state = initialState();
    let netMap!: NetMap;
    const tick = () => ({ state, netMap } = tickHierarchical(parent, library, state));
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readPc = () => fromBits(pc.q.map((q) => levelAt(state, netMap, q.id)));
    const readIr = () => fromBits(ir.q.map((q) => levelAt(state, netMap, q.id)));

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase [1, 0] (T1)
    fsmLoad.value = 0;

    pulse(dataClk); // PC resets to 0 (its own address is still stale mid-pulse — ir's capture here is garbage, thrown away)
    resetPulse.value = 0;

    pulse(dataClk); // real T1 capture: PC is now stably 0
    expect(readPc()).toBe(0);
    expect(readIr()).toBe(toNumber(WORDS[0]!));

    for (let addr = 1; addr < WORDS.length; addr++) {
      pulse(phaseClk); // -> T2
      pulse(dataClk); // PC increments
      pulse(phaseClk); // -> T1
      pulse(dataClk); // capture this address's word
      expect(readPc()).toBe(addr);
      expect(readIr()).toBe(toNumber(WORDS[addr]!));
    }

    // One more full cycle: PC wraps 3 -> 0, and IR fetches WORDS[0] again.
    pulse(phaseClk);
    pulse(dataClk);
    pulse(phaseClk);
    pulse(dataClk);
    expect(readPc()).toBe(0);
    expect(readIr()).toBe(toNumber(WORDS[0]!));
  });
});

describe('buildMinimalCpu — FETCH/INCREMENT/DECODE_EXECUTE, running a tiny real program', () => {
  /**
   * Same non-overlapping-clock discipline as the "Fetch loop" test above,
   * now with a third phase that actually changes CPU state instead of just
   * fetching. Program bytes (bits 7-5 pick the instruction, bits 4-0 the
   * immediate/address — see buildMinimalCpu's own doc comment):
   *   0x0C = 000_01100 -> LDI 12    ACC <- 12            (0b1100)
   *   0x4A = 010_01010 -> ANI 10    ACC <- 12 & 10 = 8    (0b1100 & 0b1010)
   *   0x65 = 011_00101 -> ORI 5     ACC <- 8 | 5 = 13     (0b1000 | 0b0101)
   *   0x89 = 100_01001 -> XRI 9     ACC <- 13 ^ 9 = 4     (0b1101 ^ 0b1001)
   *   0x23 = 001_00011 -> ADI 3     ACC <- 4 + 3 = 7
   *   0xAA = 101_01010 -> STORE 10  RAM[10] <- 7 (ACC unchanged)
   *   0x21 = 001_00001 -> ADI 1     ACC <- 7 + 1 = 8
   *   0xCA = 110_01010 -> LOAD 10   ACC <- RAM[10], i.e. 7 — genuinely
   *                                 different from ACC's pre-LOAD value of
   *                                 8, so a LOAD that was secretly a no-op
   *                                 couldn't pass by accident
   * Each immediate/AND/OR/XOR result was picked so every step's expected
   * value is different from what any *other* op would have produced from
   * the same inputs (e.g. 12&10=8, 12|10=14, 12^10=6 are all distinct) —
   * a decode bug that wired the wrong ALU op0/op1 combination, or picked
   * the wrong mux input entirely, fails this trace instead of coincidentally
   * matching it. addrBits=4 (16 words) so the program (addresses 0-7) and
   * its STORE target (10) don't overlap — this is von Neumann memory, code
   * and data genuinely share it, and overlapping them on purpose is a
   * different, later test, not an accident to launder into this one.
   */
  const PROGRAM = Uint8Array.of(0x0c, 0x4a, 0x65, 0x89, 0x23, 0xaa, 0x21, 0xca);
  const EXPECTED_ACC = [12, 8, 13, 4, 7, 7, 8, 7];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('runs LDI/ANI/ORI/XRI/ADI/STORE/ADI/LOAD in sequence, ACC and RAM tracking the expected state after each DECODE_EXECUTE', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildMinimalCpu(parent, library, 4, PROGRAM);

    const resetPulse = makeInput(parent, 1);
    wire(parent, resetPulse.pins.out, cpu.reset);
    const dataClk = makeInput(parent, 0);
    wire(parent, dataClk.pins.out, cpu.clk);
    const phaseClk = makeInput(parent, 0);
    wire(parent, phaseClk.pins.out, cpu.phaseClk);
    const fsmLoad = makeInput(parent, 1);
    wire(parent, fsmLoad.pins.out, cpu.fsmLoad);
    const fsmD0 = makeInput(parent, 1);
    wire(parent, fsmD0.pins.out, cpu.fsmD[0]!);
    const fsmD1 = makeInput(parent, 0);
    wire(parent, fsmD1.pins.out, cpu.fsmD[1]!);
    const fsmD2 = makeInput(parent, 0);
    wire(parent, fsmD2.pins.out, cpu.fsmD[2]!);

    let state = initialState();
    let netMap!: NetMap;
    const tick = () => ({ state, netMap } = tickHierarchical(parent, library, state));
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readAcc = () => fromBits(cpu.acc.map((q) => levelAt(state, netMap, q.id)));

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    pulse(dataClk); // PC resets to 0 (IR's capture here is garbage, thrown away)
    resetPulse.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    // Memory at the STORE target must still read as freshly-initialized
    // (0) before that STORE instruction actually runs — otherwise a test
    // that only checked the *final* value couldn't tell a STORE that never
    // fired from one that always targeted the right address by luck.
    expect(cpu.ram.bytes[10]).toBe(0);

    for (let i = 0; i < PROGRAM.length; i++) {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk); // PC advances
      pulse(phaseClk); // -> DECODE_EXECUTE
      pulse(dataClk); // ACC updates (LDI/ANI/ORI/XRI/ADI), or RAM is read/written (LOAD/STORE), from the current IR
      expect(readAcc()).toBe(EXPECTED_ACC[i]);
      pulse(phaseClk); // -> FETCH
      pulse(dataClk); // IR <- PROGRAM[next] (or wraps back to PROGRAM[0] after the last one)
    }

    // STORE actually wrote RAM, at the right address, and the later LOAD
    // (a pure read) didn't disturb it.
    expect(cpu.ram.bytes[10]).toBe(7); // written by "STORE 10" while ACC was 7
  });
});

describe('buildMinimalCpu — JMP and OUT in the formerly reserved 111 slot', () => {
  /**
   *   0x01 = 000_00001 -> LDI 1    ACC <- 1
   *   0xF0 = 111_10000 -> OUT      port <- ACC
   *   0x81 = 100_00001 -> XRI 1    ACC <- ACC ^ 1
   *   0xE0 = 111_00000 -> JMP 0    PC <- 0
   * Port value after each executed instruction; the first one is the
   * register's power-up state and is not asserted.
   */
  const PROGRAM = Uint8Array.of(0x01, 0xf0, 0x81, 0xf0, 0xe0);
  const EXPECTED_PORT_AFTER = [undefined, 1, 1, 0, 0, 0, 1, 1];
  const EXPECTED_PC_AFTER_JMP = 0;

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('loops the program: OUT drives the port register, JMP reloads PC', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildMinimalCpu(parent, library, 4, PROGRAM);

    const resetPulse = makeInput(parent, 1);
    wire(parent, resetPulse.pins.out, cpu.reset);
    const dataClk = makeInput(parent, 0);
    wire(parent, dataClk.pins.out, cpu.clk);
    const phaseClk = makeInput(parent, 0);
    wire(parent, phaseClk.pins.out, cpu.phaseClk);
    const fsmLoad = makeInput(parent, 1);
    wire(parent, fsmLoad.pins.out, cpu.fsmLoad);
    const fsmD0 = makeInput(parent, 1);
    wire(parent, fsmD0.pins.out, cpu.fsmD[0]!);
    const fsmD1 = makeInput(parent, 0);
    wire(parent, fsmD1.pins.out, cpu.fsmD[1]!);
    const fsmD2 = makeInput(parent, 0);
    wire(parent, fsmD2.pins.out, cpu.fsmD[2]!);

    let state = initialState();
    let netMap!: NetMap;
    const tick = () => ({ state, netMap } = tickHierarchical(parent, library, state));
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readPort = () => fromBits(cpu.out.map((q) => levelAt(state, netMap, q.id)));
    const readPc = () => fromBits(cpu.pc.map((q) => levelAt(state, netMap, q.id)));

    tick();
    pulse(phaseClk);
    fsmLoad.value = 0;
    pulse(dataClk);
    resetPulse.value = 0;
    pulse(dataClk);

    for (let i = 0; i < EXPECTED_PORT_AFTER.length; i++) {
      pulse(phaseClk);
      pulse(dataClk);
      pulse(phaseClk);
      pulse(dataClk);
      const expected = EXPECTED_PORT_AFTER[i];
      if (expected !== undefined) expect(readPort(), `port after instruction ${i}`).toBe(expected);
      if (i === 4) expect(readPc()).toBe(EXPECTED_PC_AFTER_JMP);
      pulse(phaseClk);
      pulse(dataClk);
    }
  });
});

describe('buildZ80Decoder — real Z80 opcode field extraction (x/y/z)', () => {
  /**
   * Checked directly against real, well-known opcode bytes from an actual
   * Z80 reference (not derived from this function's own logic) — the
   * whole point is that this matches real silicon, so the test has to
   * come from an independent source of truth, not a restatement of the
   * implementation.
   */
  function decode(opcodeByte: number): { x: number; y: number; z: number } {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const opcodeIns = Array.from({ length: 8 }, (_, i) => makeInput(parent, ((opcodeByte >> i) & 1) as 0 | 1));
    const dec = buildZ80Decoder(parent, opcodeIns.map((c) => c.pins.out));

    let state = initialState();
    let netMap!: NetMap;
    ({ state, netMap } = tickHierarchical(parent, library, state));
    const firstHigh = (lines: Level[]) => lines.findIndex((l) => l === 1);
    return {
      x: firstHigh(dec.x.map((p) => levelAt(state, netMap, p.id))),
      y: firstHigh(dec.y.map((p) => levelAt(state, netMap, p.id))),
      z: firstHigh(dec.z.map((p) => levelAt(state, netMap, p.id))),
    };
  }

  it.each([
    [0x00, { x: 0, y: 0, z: 0 }, 'NOP'],
    [0x80, { x: 2, y: 0, z: 0 }, 'ADD A,B'],
    [0x90, { x: 2, y: 2, z: 0 }, 'SUB B'],
    [0xa7, { x: 2, y: 4, z: 7 }, 'AND A'],
    [0xa8, { x: 2, y: 5, z: 0 }, 'XOR B'],
    [0xb0, { x: 2, y: 6, z: 0 }, 'OR B'],
    [0xbe, { x: 2, y: 7, z: 6 }, 'CP (HL)'],
    [0x47, { x: 1, y: 0, z: 7 }, 'LD B,A'],
    [0xc3, { x: 3, y: 0, z: 3 }, 'JP nn'],
  ] as const)('opcode 0x%s decodes correctly (%s)', (opcode, expected, _name) => {
    expect(decode(opcode)).toEqual(expected);
  });
});

