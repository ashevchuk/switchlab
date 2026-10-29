import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11: CALL cc,nn (conditional subroutine call)', () => {
  /**
   * The proof this instruction needs is the union of its two parents':
   * "x=11: JP cc,nn"'s own proof (jumps when the condition holds, falls
   * through — correctly, not by accident — when it doesn't) AND "x=11:
   * CALL nn"'s own proof (the *existing* RET mechanism can pop back
   * whatever CALL cc,nn pushed). Two condition pairs, same as "x=11: JP
   * cc,nn"'s own test (`Z`/`NZ` off one `XOR`, `C`/`NC` off one `ADD` —
   * the other 4 conditions share the identical one-hot select tree,
   * argued sufficient there and not re-litigated here), but each *taken*
   * instance here goes all the way through a real CALL -> subroutine ->
   * RET -> resume round trip, `SP` checked dipping by exactly two and
   * recovering exactly back — not just "landed at the right address" the
   * way a bare `JP cc,nn` proof stops at.
   *
   * The ordering itself is the proof for the *not-taken* half, deliberately
   * without a dedicated "wrong path" trap the way `JP cc,nn`'s own test
   * used one: whatever this project's snapshot-per-instruction discipline
   * already used everywhere else. `CALL cc,nn`'s own fall-through address
   * is architecturally *identical* to its own return address (both are
   * "PC after this instruction's 3 bytes") — a trap byte placed there
   * would misfire on the correct taken-then-RET path too, since both
   * legitimately execute whatever comes right after this instruction.
   * What actually distinguishes them is *when*: a wrongly-not-taken bug
   * shows up in the very next snapshot (immediately after the CALL cc,nn
   * instruction itself, before any subroutine could have run); a
   * correctly-taken call reaches that same address only several
   * instructions later, after the subroutine's own snapshot and RET's own
   * snapshot already proved it ran. Trap bytes are still used for the
   * "wrongly taken when it shouldn't be" direction (`0x32`/`0x3C`,
   * genuinely unreachable if the condition test is correct), since that
   * failure mode diverts to an address nothing else ever legitimately
   * visits.
   *
   *  0: 0xAF               XOR A,A       A <- 0, F <- 0x44 (Z=1, C=0)
   *  1: 0xCC,0x28,0x00     CALL Z,0x28   Z=1: taken -> push ret=4, PC <- 0x28, SP - 2
   *  4: 0x3E,0x22          LD A,0x22     (resumed after RET) A <- 0x22
   *  6: 0xC4,0x32,0x00     CALL NZ,0x32  Z=1 (still, LD doesn't touch flags): NOT taken -> fall through
   *  9: 0x3E,0x33          LD A,0x33     A <- 0x33
   * 11: 0x87               ADD A,A       A <- 0x66, F <- 0x04 (Z=0, C=0)
   * 12: 0xDC,0x3C,0x00     CALL C,0x3C   C=0: NOT taken -> fall through
   * 15: 0x3E,0x55          LD A,0x55     A <- 0x55
   * 17: 0xD4,0x46,0x00     CALL NC,0x46  C=0: taken -> push ret=20, PC <- 0x46, SP - 2
   * 20: 0x3E,0x66          LD A,0x66     (resumed after RET) A <- 0x66
   * 40: 0x3E,0x11          LD A,0x11     (subroutine 1) A <- 0x11 — proves CALL Z landed here
   * 42: 0xC9               RET           pop PC back to 4, SP + 2
   * 50: 0x3E,0xEE          LD A,0xEE     (trap — reached only if CALL NZ wrongly jumped)
   * 60: 0x3E,0xEE          LD A,0xEE     (trap — reached only if CALL C wrongly jumped)
   * 70: 0x3E,0x77          LD A,0x77     (subroutine 2) A <- 0x77 — proves CALL NC landed here
   * 72: 0xC9               RET           pop PC back to 20, SP + 2
   */
  const ADDR_BITS = 7;
  const SP0 = 100;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0xcc, 0x28, 0x00], 1);
    bytes.set([0x3e, 0x22], 4);
    bytes.set([0xc4, 0x32, 0x00], 6);
    bytes.set([0x3e, 0x33], 9);
    bytes.set([0x87], 11);
    bytes.set([0xdc, 0x3c, 0x00], 12);
    bytes.set([0x3e, 0x55], 15);
    bytes.set([0xd4, 0x46, 0x00], 17);
    bytes.set([0x3e, 0x66], 20);
    bytes.set([0x3e, 0x11], 40);
    bytes.set([0xc9], 42);
    bytes.set([0x3e, 0xee], 50);
    bytes.set([0x3e, 0xee], 60);
    bytes.set([0x3e, 0x77], 70);
    bytes.set([0xc9], 72);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, sp: SP0, pc: 1 }, // XOR A,A
    { a: 0x00, sp: SP0 - 2, pc: 40 }, // CALL Z,0x28 — taken
    { a: 0x11, sp: SP0 - 2, pc: 42 }, // LD A,0x11 (subroutine 1)
    { a: 0x11, sp: SP0, pc: 4 }, // RET — back to right after CALL Z's own 3 bytes
    { a: 0x22, sp: SP0, pc: 6 }, // LD A,0x22 (resumed main flow)
    { a: 0x22, sp: SP0, pc: 9 }, // CALL NZ,0x32 — not taken, fell through, no push
    { a: 0x33, sp: SP0, pc: 11 }, // LD A,0x33
    { a: 0x66, sp: SP0, pc: 12 }, // ADD A,A
    { a: 0x66, sp: SP0, pc: 15 }, // CALL C,0x3C — not taken, fell through, no push
    { a: 0x55, sp: SP0, pc: 17 }, // LD A,0x55
    { a: 0x55, sp: SP0 - 2, pc: 70 }, // CALL NC,0x46 — taken
    { a: 0x77, sp: SP0 - 2, pc: 72 }, // LD A,0x77 (subroutine 2)
    { a: 0x77, sp: SP0, pc: 20 }, // RET — back to right after CALL NC's own 3 bytes
    { a: 0x66, sp: SP0, pc: 22 }, // LD A,0x66 (resumed main flow)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('calls, runs the subroutine, and RETs back — or leaves SP and PC alone — depending on the tested condition', () => {
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
    // this composite is deeper still now (callCcTarget's own holding
    // register and its write-back, a sixth mux layer on PC's own
    // retMux/rstMux/jpMux/callMux/jpCcMux chain, and CALL cc,nn's own
    // conditional return-address push reusing stackWriteNow's entire
    // apparatus a fourth time).
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
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (conditional push — a no-op unless this is a taken CALL cc,nn)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (conditional jump — same condition)
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
