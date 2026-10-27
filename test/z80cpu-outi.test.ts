import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=10, y=4, z=3: OUTI (real 0xED 0xA3)', () => {
  /**
   * The mirror image of `INI` — see "x=10, z=3: OUTI/OUTD/OTIR/OTDR" in
   * ARCHITECTURE.md. `OUT(C)<-(HL)`: a byte read from `(HL)` this time,
   * written to this project's own invented I/O port, then `HL++`, `B--`.
   * `ioWrite`/`ioPortAddr`/`ioPortDataOut` are live, transient signals —
   * real for exactly `PHASE5`, not latched into anything this test can
   * read back afterward — so, exactly like `z80cpu-in-out.test.ts`'s own
   * `OUT (n),A` case, this needs a mid-instruction checkpoint, not just
   * an end-of-instruction snapshot. Two back-to-back `OUTI`s, transferring
   * two *different* bytes (`0xAB` then `0x11` — bit 7 set, then clear) so
   * `N` reading correctly on both proves it's tracking *this* transfer's
   * own byte, not a stale leftover from the first.
   *
   * 0: 0x01,0x37,0x02  LD BC,0x0237   BC<-0x0237 (B=2, C=0x37 — the port address)
   * 3: 0x21,0x10,0x00  LD HL,0x0010   HL<-0x10
   * 6: 0xED,0xA3       OUTI           ioWrite/ioPortAddr=0x37/ioPortDataOut=0xAB at PHASE5; HL<-0x11, B<-1, N<-1, Z<-0
   * 8: 0xED,0xA3       OUTI           ioWrite/ioPortAddr=0x37/ioPortDataOut=0x11 at PHASE5; HL<-0x12, B<-0, N<-0, Z<-1
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x01, 0x37, 0x02], 0);
    bytes.set([0x21, 0x10, 0x00], 3);
    bytes.set([0xed, 0xa3], 6);
    bytes.set([0xed, 0xa3], 8);
    bytes.set([0xab], 0x10);
    bytes.set([0x11], 0x11);
    return bytes;
  })();

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('writes a byte from (HL) to the port addressed by C, advances HL, decrements B, and sets N/Z (only)', () => {
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
      const d = Array.from({ length: width }, (_, i) => ((value >> i) & 1) as 0 | 1).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, 0);
    seedReg(cpu.rC, 0);
    seedReg(cpu.rD, 0);
    seedReg(cpu.rE, 0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, 0);
    seedReg(cpu.sp, 0, ADDR_BITS);
    seedReg(cpu.aP, 0);
    seedReg(cpu.fP, 0);
    seedReg(cpu.bP, 0);
    seedReg(cpu.cP, 0);
    seedReg(cpu.dP, 0);
    seedReg(cpu.eP, 0);
    seedReg(cpu.hP, 0);
    seedReg(cpu.lP, 0);

    let state = initialState();
    let netMap!: NetMap;
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
    const readPin = (p: Pin) => levelAt(state, netMap, p.id);

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    pulse(dataClk); // PC/A reset, every register above seeded
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    const runToPhase5 = () => {
      for (let i = 0; i < 5; i++) {
        // INCREMENT, EXEC1, EXEC2, EXEC3 (PHASE4: reads (HL)), EXEC4 (PHASE5)
        pulse(phaseClk);
        pulse(dataClk);
      }
    };
    const finishInstruction = () => {
      for (let i = 0; i < 5; i++) {
        // EXEC5, EXEC6, EXEC7, EXEC8, FETCH
        pulse(phaseClk);
        pulse(dataClk);
      }
    };

    // --- LD BC,0x0237 / LD HL,0x0010 ---
    for (let i = 0; i < 20; i++) {
      pulse(phaseClk);
      pulse(dataClk);
    }
    expect(readReg(cpu.rB.q)).toBe(2);
    expect(readReg(cpu.rC.q)).toBe(0x37);
    expect(readReg(cpu.rH.q)).toBe(0);
    expect(readReg(cpu.rL.q)).toBe(0x10);
    expect(readReg(cpu.pc)).toBe(6);

    // --- OUTI #1 ---
    runToPhase5();
    expect(readPin(cpu.ioWrite)).toBe(1);
    expect(readPin(cpu.ioRead)).toBe(0);
    expect((readReg(cpu.ioPortAddr) & 0xff)).toBe(0x37);
    expect(readReg(cpu.ioPortDataOut)).toBe(0xab);
    finishInstruction();
    expect(readReg(cpu.rH.q)).toBe(0);
    expect(readReg(cpu.rL.q)).toBe(0x11);
    expect(readReg(cpu.rB.q)).toBe(1);
    expect(readReg(cpu.f)).toBe(0b00000010); // N=1 (0xAB's own bit 7), Z=0
    expect(readReg(cpu.pc)).toBe(8);

    // --- OUTI #2 ---
    runToPhase5();
    expect(readPin(cpu.ioWrite)).toBe(1);
    expect((readReg(cpu.ioPortAddr) & 0xff)).toBe(0x37);
    expect(readReg(cpu.ioPortDataOut)).toBe(0x11);
    finishInstruction();
    expect(readReg(cpu.rH.q)).toBe(0);
    expect(readReg(cpu.rL.q)).toBe(0x12);
    expect(readReg(cpu.rB.q)).toBe(0);
    expect(readReg(cpu.f)).toBe(0b01000000); // N=0 (0x11's own bit 7), Z=1 — B reached 0
    expect(readReg(cpu.pc)).toBe(10);
  });
});
