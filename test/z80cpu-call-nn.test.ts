import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11: CALL nn (subroutine call and return)', () => {
  /**
   * The real proof this instruction needs isn't just "jumped to the right
   * place" (already covered by "x=11: JP nn") — it's "the *existing* RET
   * mechanism, built for RST long before CALL nn existed, can pop the
   * address CALL nn pushed." A genuine CALL -> subroutine -> RET -> resume
   * round trip: `SP` is checked decrementing by exactly two on the call
   * and incrementing by exactly two on the return (the return address is
   * a whole word on the stack, as on a real Z80 — return addresses above
   * 0xFF are covered by z80cpu-return-address-16bit), and the resumed main flow
   * (`LD A,0x99` at address 3, right after `CALL`'s own 3 bytes) only runs
   * — and only leaves `A` as `0x99` — if `RET` truly landed back at the
   * instruction *after* `CALL`, not merely *some* address.
   *
   *  0: 0xCD,0x10,0x00  CALL 0x0010   push return addr (3), PC <- 0x10, SP - 2
   *  3: 0x3E,0x99       LD A,0x99     (main flow, resumed after RET) A <- 0x99
   * 16: 0x3E,0x42       LD A,0x42     (subroutine) A <- 0x42 — proves the call landed here
   * 18: 0xC9            RET           pop the stack back into PC (3), SP + 2
   */
  const ADDR_BITS = 6;
  const SP0 = 32;
  const CALL_TARGET = 0x10;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(64);
    bytes.set([0xcd, 0x10, 0x00], 0);
    bytes.set([0x3e, 0x99], 3);
    bytes.set([0x3e, 0x42], CALL_TARGET);
    bytes.set([0xc9], 18);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, sp: SP0 - 2, pc: 0x10 }, // CALL 0x0010 — A untouched, SP decremented by two, PC redirected
    { a: 0x42, sp: SP0 - 2, pc: 18 }, // LD A,0x42 (the subroutine) — proves the call landed exactly here
    { a: 0x42, sp: SP0, pc: 3 }, // RET — SP back to where CALL found it, PC back to right after CALL's own 3 bytes
    { a: 0x99, sp: SP0, pc: 5 }, // LD A,0x99 (main flow, resumed) — proves RET returned to the right place, not just some place
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('pushes the return address, jumps to the subroutine, and RET pops it back to resume the right instruction', () => {
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
    // this composite is deeper still now (callTarget's own holding
    // register and its write-back, a fourth mux layer on PC's own
    // retMux/rstMux/jpMux chain, and CALL nn's own return-address push
    // reusing stackWriteNow's entire apparatus).
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
      pulse(phaseClk); // -> EXEC1 (read low byte / RET's pop of the return address's low byte, depending on the opcode)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (advance PC, a no-op for RET)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (read high byte / RET's pop of the return address's high byte)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (advance PC a second time, a no-op for RET)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (push the return address, a no-op for JP-nn-shaped instructions and RET)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (jump — CALL nn's own commit)
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
