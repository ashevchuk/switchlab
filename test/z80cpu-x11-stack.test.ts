import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe("buildZ80Cpu — flags, SP, PUSH/POP, RET, RST n (x=11's real subset)", () => {
  /**
   * A genuine program exercising every new piece at once: real flag
   * computation (verified by round-tripping A *and* F through the stack,
   * not just checking a bit in isolation), PUSH/POP of three different
   * register pairs (BC directly, AF carrying flags), and a real
   * subroutine call — RST 30H jumping out of the main flow, running two
   * instructions elsewhere in RAM, then RET resuming exactly where the
   * main flow left off.
   *
   *   0: 0x80  ADD A,B    A <- 0+B = 0x11; F <- Z=0,C=0,S=0,N=0,P/V=0 (ADD is
   *                       arithmetic — P/V is signed overflow here, not
   *                       parity, and 0+0x11 doesn't overflow)
   *   1: 0xF5  PUSH AF    save (A=0x11, F=0) — SP 60->58
   *   2: 0xC5  PUSH BC    save original (B=0x11, C=0x22) before it's overwritten below — SP 58->56
   *   3: 0xAF  XOR A,A    corrupt A (->0) and F (->new flags), proving POP AF restores both
   *   4: 0x42  LD B,D     corrupt B <- D (0x33)
   *   5: 0x4B  LD C,E     corrupt C <- E (0x44)
   *   6: 0xC1  POP BC     restore B,C to their original (pre-corruption) values — SP 56->58
   *   7: 0xF1  POP AF     restore A,F to their post-ADD values — SP 58->60
   *   8: 0xF7  RST 30H    push PC (=9, past this opcode) to the stack as a word, jump to 48 — SP 60->58
   *  48: 0x5F  LD E,A     (subroutine) E <- A = 0x11 — proves the jump actually landed here
   *  49: 0xC9  RET        pop the stack back into PC (=9) — SP 58->60
   *   9: 0x57  LD D,A     (main flow, resumed) D <- A = 0x11 — proves RET returned to the right place,
   *                       not just to *some* place — a wrong RET target would fetch a different opcode
   *                       here and D would end up with something other than A's own value
   *
   * D and E end up holding A's value (0x11), not their own seeded ones —
   * deliberately, so the trace can tell "control flow genuinely passed
   * through the subroutine and back" from "it didn't," not just infer it
   * from PC/SP alone.
   */
  const B0 = 0x11;
  const C0 = 0x22;
  const D0 = 0x33;
  const E0 = 0x44;
  const SP0 = 60;
  const ADDR_BITS = 6; // wide enough for a real RST target (0x30 = 48) to exist
  const PROGRAM = (() => {
    const bytes = new Uint8Array(64);
    bytes.set([0x80, 0xf5, 0xc5, 0xaf, 0x42, 0x4b, 0xc1, 0xf1, 0xf7, 0x57], 0);
    bytes.set([0x5f, 0xc9], 48);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x00, sp: 60, pc: 1 }, // ADD A,B
    { a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x00, sp: 58, pc: 2 }, // PUSH AF
    { a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x00, sp: 56, pc: 3 }, // PUSH BC
    { a: 0x00, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x44, sp: 56, pc: 4 }, // XOR A,A
    { a: 0x00, b: 0x33, c: 0x22, d: 0x33, e: 0x44, f: 0x44, sp: 56, pc: 5 }, // LD B,D
    { a: 0x00, b: 0x33, c: 0x44, d: 0x33, e: 0x44, f: 0x44, sp: 56, pc: 6 }, // LD C,E
    { a: 0x00, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x44, sp: 58, pc: 7 }, // POP BC
    { a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x00, sp: 60, pc: 8 }, // POP AF
    { a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x44, f: 0x00, sp: 58, pc: 48 }, // RST 30H (jumped!)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('runs ADD/PUSH/PUSH/XOR/LD/LD/POP/POP/RST, then a subroutine that RETs back to the right place', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildZ80Cpu(parent, library, ADDR_BITS, PROGRAM);

    const resetPulse = makeInput(parent, 1);
    wire(parent, resetPulse.pins.out, cpu.reset);
    const aResetPulse = makeInput(parent, 1);
    wire(parent, aResetPulse.pins.out, cpu.aReset);
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
    const fsmD3 = makeInput(parent, 0);
    wire(parent, fsmD3.pins.out, cpu.fsmD[3]!);
    const fsmD4 = makeInput(parent, 0);
    wire(parent, fsmD4.pins.out, cpu.fsmD[4]!);
    const fsmD5 = makeInput(parent, 0);
    wire(parent, fsmD5.pins.out, cpu.fsmD[5]!);
    const fsmD6 = makeInput(parent, 0);
    wire(parent, fsmD6.pins.out, cpu.fsmD[6]!);
    const fsmD7 = makeInput(parent, 0);
    wire(parent, fsmD7.pins.out, cpu.fsmD[7]!);
    const fsmD8 = makeInput(parent, 0);
    wire(parent, fsmD8.pins.out, cpu.fsmD[8]!);
    const fsmD9 = makeInput(parent, 0);
    wire(parent, fsmD9.pins.out, cpu.fsmD[9]!);

    const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
    const seedReg = (reg: (typeof cpu)['rB'], value: number, width = 8) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = toBits(value, width).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, B0);
    seedReg(cpu.rC, C0);
    seedReg(cpu.rD, D0);
    seedReg(cpu.rE, E0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, 0);
    seedReg(cpu.sp, SP0, ADDR_BITS);

    let state = initialState();
    let netMap!: NetMap;
    // Same reasoning as the tests above: flatten once, let step() do its
    // own deep internal relaxation instead of routing through
    // tickHierarchical's re-flatten-per-pass loop — this composite is
    // deeper still (SP's own +-1 adder, the push/pop byte-select banks,
    // flag computation) than the x=10/x=01 ones already needed this for.
    const tick = () => {
      const flat = flatten(parent, library);
      netMap = flat.computeNets();
      state = step(flat, netMap, state, 300);
    };
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readReg = (pins: Pin[]) => fromBits(pins.map((p) => levelAt(state, netMap, p.id)));
    const snapshot = (): Snapshot => ({
      a: readReg(cpu.a),
      b: readReg(cpu.rB.q),
      c: readReg(cpu.rC.q),
      d: readReg(cpu.rD.q),
      e: readReg(cpu.rE.q),
      f: readReg(cpu.f),
      sp: readReg(cpu.sp.q),
      pc: readReg(cpu.pc),
    });

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    // PC resets to 0, A resets to 0, and B/C/D/E/H/L/SP get their seeded
    // values — all on the same first pulse (IR's own capture here is
    // garbage, thrown away, same as every other buildMinimalCpu-family
    // test).
    pulse(dataClk);
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    // One instruction's worth of phase pulses: INCREMENT, EXEC1, EXEC2,
    // then FETCH the next opcode.
    const runInstruction = () => {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (a genuine no-op for this group too — see "x=00, z=1: LD dd,nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (a genuine no-op for this group too — see "x=11: CALL nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC7 (no-op — ring widen for DD/FD CB SET/RES/rot)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC8 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> FETCH (next opcode)
      pulse(dataClk);
    };

    for (const expected of EXPECTED) {
      runInstruction();
      expect(snapshot()).toEqual(expected);
    }

    // The subroutine RST 30H just jumped to: LD E,A, then RET.
    runInstruction(); // LD E,A (at address 48)
    expect(snapshot()).toEqual({ a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x11, f: 0x00, sp: 58, pc: 49 });
    runInstruction(); // RET (at address 49)
    expect(snapshot()).toEqual({ a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x11, f: 0x00, sp: 60, pc: 9 });

    // Back in the main flow, resumed exactly where RST left off.
    runInstruction(); // LD D,A (at address 9)
    expect(snapshot()).toEqual({ a: 0x11, b: 0x11, c: 0x22, d: 0x11, e: 0x11, f: 0x00, sp: 60, pc: 10 });
  });
});

