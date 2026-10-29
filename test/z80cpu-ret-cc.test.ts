import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11: RET cc (conditional return)', () => {
  /**
   * The cheapest of the four flag-gated `x=11` instructions to *build*
   * (see "x=11: RET cc" above — no target register, no extra `pcHold`
   * term, just one new signal widening the *existing* unconditional
   * `RET`'s own `readNow`) still needs the same proof every other one
   * did: taken really pops and jumps, not-taken really leaves `SP` and
   * `PC` alone. Four instances, same `Z`/`NZ`/`C`/`NC` pair `JP cc,nn`'s
   * and `CALL cc,nn`'s own tests already used, each inside its own real
   * `CALL`-pushed stack frame (`RET cc` popping garbage would be a
   * meaningless test) — a *taken* instance is a single instruction, self-
   * contained; a *not-taken* instance is followed by a plain unconditional
   * `RET` in the same subroutine, both proving the not-taken branch left
   * `SP` untouched (still mid-frame, one snapshot before the plain `RET`
   * unwinds it) and proving the subroutine's own flow continues normally
   * rather than derailing.
   *
   *  0: 0xAF               XOR A,A       A <- 0, F <- 0x44 (Z=1, C=0)
   *  1: 0xCD,0x40,0x00     CALL 0x40     push ret=4, PC <- 0x40, SP - 2
   *  4: 0x3E,0x11          LD A,0x11     (resumed after RET Z) A <- 0x11
   *  6: 0xCD,0x50,0x00     CALL 0x50     push ret=9, PC <- 0x50, SP - 2
   *  9: 0x3E,0x22          LD A,0x22     (resumed after the plain RET) A <- 0x22
   * 11: 0x3E,0x80          LD A,0x80     A <- 0x80
   * 13: 0x87               ADD A,A       A <- 0x00, F <- 0x45 (Z=1, C=1)
   * 14: 0xCD,0x60,0x00     CALL 0x60     push ret=17, PC <- 0x60, SP - 2
   * 17: 0x3E,0x33          LD A,0x33     (resumed after RET C) A <- 0x33
   * 19: 0xCD,0x70,0x00     CALL 0x70     push ret=22, PC <- 0x70, SP - 2
   * 22: 0x3E,0x44          LD A,0x44     (resumed after the plain RET) A <- 0x44
   * 64: 0xC8               RET Z         Z=1: taken -> pop PC <- 4, SP + 2
   * 80: 0xC0               RET NZ        Z=1: NOT taken -> fall through
   * 81: 0xC9               RET           pop PC <- 9, SP + 2
   * 96: 0xD8               RET C         C=1: taken -> pop PC <- 17, SP + 2
   *112: 0xD0               RET NC        C=1: NOT taken -> fall through
   *113: 0xC9               RET           pop PC <- 22, SP + 2
   */
  const ADDR_BITS = 8;
  const SP0 = 200;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xaf], 0);
    bytes.set([0xcd, 0x40, 0x00], 1);
    bytes.set([0x3e, 0x11], 4);
    bytes.set([0xcd, 0x50, 0x00], 6);
    bytes.set([0x3e, 0x22], 9);
    bytes.set([0x3e, 0x80], 11);
    bytes.set([0x87], 13);
    bytes.set([0xcd, 0x60, 0x00], 14);
    bytes.set([0x3e, 0x33], 17);
    bytes.set([0xcd, 0x70, 0x00], 19);
    bytes.set([0x3e, 0x44], 22);
    bytes.set([0xc8], 64);
    bytes.set([0xc0, 0xc9], 80);
    bytes.set([0xd8], 96);
    bytes.set([0xd0, 0xc9], 112);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, sp: SP0, pc: 1 }, // XOR A,A
    { a: 0x00, sp: SP0 - 2, pc: 64 }, // CALL 0x40
    { a: 0x00, sp: SP0, pc: 4 }, // RET Z — taken
    { a: 0x11, sp: SP0, pc: 6 }, // LD A,0x11
    { a: 0x11, sp: SP0 - 2, pc: 80 }, // CALL 0x50
    { a: 0x11, sp: SP0 - 2, pc: 81 }, // RET NZ — not taken, SP untouched
    { a: 0x11, sp: SP0, pc: 9 }, // RET (plain) — unwinds the frame RET NZ left alone
    { a: 0x22, sp: SP0, pc: 11 }, // LD A,0x22
    { a: 0x80, sp: SP0, pc: 13 }, // LD A,0x80
    { a: 0x00, sp: SP0, pc: 14 }, // ADD A,A
    { a: 0x00, sp: SP0 - 2, pc: 96 }, // CALL 0x60
    { a: 0x00, sp: SP0, pc: 17 }, // RET C — taken
    { a: 0x33, sp: SP0, pc: 19 }, // LD A,0x33
    { a: 0x33, sp: SP0 - 2, pc: 112 }, // CALL 0x70
    { a: 0x33, sp: SP0 - 2, pc: 113 }, // RET NC — not taken, SP untouched
    { a: 0x33, sp: SP0, pc: 22 }, // RET (plain) — unwinds the frame RET NC left alone
    { a: 0x44, sp: SP0, pc: 24 }, // LD A,0x44
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('pops and jumps when the tested condition holds, or leaves SP and PC alone when it does not', () => {
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

    // Seeded but otherwise irrelevant to this test — same "every register
    // gets a defined seed, even ones this test doesn't touch" discipline
    // every other buildZ80Cpu test in this file already follows, avoiding
    // a floating external-seed sink on B/C/D/E/H/L/SP.
    const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
    const seedReg = (reg: (typeof cpu)['rB'], value: number, width = 8) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = toBits(value, width).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, 0);
    seedReg(cpu.rC, 0);
    seedReg(cpu.rD, 0);
    seedReg(cpu.rE, 0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, 0);
    seedReg(cpu.sp, SP0, ADDR_BITS);

    let state = initialState();
    let netMap!: NetMap;
    // Same flatten-once-per-tick reasoning as the other buildZ80Cpu tests —
    // this composite is deeper still now (RET cc's own seventh mux layer,
    // retCcMux, on PC's own commit chain, and readNow's own widening to a
    // third OR term).
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
      sp: readReg(cpu.sp.q),
      pc: readReg(cpu.pc),
    });

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    pulse(dataClk); // PC/A reset, B/C/D/E/H/L/SP seeded
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    const runInstruction = () => {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (RET cc's own conditional pop, a no-op for every other opcode here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6
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
  });
});
