import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11, z=3, y=2/y=3: OUT (n),A / IN A,(n)', () => {
  /**
   * This project's first opcodes to touch anything outside RAM/registers —
   * `ioPortAddr`/`ioPortDataOut`/`ioRead`/`ioWrite` are live, transient
   * outputs (real for exactly one `PHASE2`, not latched into anything),
   * so proving them right needs a mid-instruction checkpoint, not just an
   * end-of-instruction snapshot the way every other test in this file
   * gets away with. `IN A,(0x42)` is checked two ways: `ioRead`/
   * `ioPortAddr` mid-flight (proving the CPU asked for the right port,
   * not just that `A` ended up holding *some* value), and `A` itself
   * afterward, reading back a value from a fake "device" this test wires
   * to `ioPortDataIn` directly. `OUT (0x55),A` is checked entirely
   * mid-flight — `ioWrite`/`ioPortAddr`/`ioPortDataOut` all have to be
   * correct in that one instant, since nothing this simulator models
   * "remembers" an OUT afterward (that would be the fake device's own
   * job, not the CPU's).
   *
   * 0: 0xDB,0x42   IN A,(0x42)    ioRead/ioPortAddr=0x42 at PHASE2; A<-0x99 (this test's own fake device's fixed reply)
   * 2: 0x3E,0x77   LD A,0x77      A<-0x77 (a known value for OUT to send)
   * 4: 0xD3,0x55   OUT (0x55),A   ioWrite/ioPortAddr=0x55/ioPortDataOut=0x77 at PHASE2
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xdb, 0x42], 0);
    bytes.set([0x3e, 0x77], 2);
    bytes.set([0xd3, 0x55], 4);
    return bytes;
  })();

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('addresses a real I/O port and moves a byte through it, both directions', () => {
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

    // This test's own fake I/O device: a fixed 0x99 reply, wired straight
    // into ioPortDataIn — a real external driver, exactly the contract
    // Z80Cpu documents for that pin.
    const deviceReply = toBits(0x99, 8).map((bit) => makeInput(parent, bit));
    deviceReply.forEach((input, i) => wire(parent, input.pins.out, cpu.ioPortDataIn[i]!));

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

    // --- IN A,(0x42) ---
    pulse(phaseClk); // -> INCREMENT
    pulse(dataClk);
    pulse(phaseClk); // -> EXEC1 (PHASE2: reads 0x42, strobes ioRead)
    pulse(dataClk);
    expect(readPin(cpu.ioRead)).toBe(1);
    expect(readPin(cpu.ioWrite)).toBe(0);
    expect((readReg(cpu.ioPortAddr) & 0xff)).toBe(0x42);
    for (let phase = 0; phase < 8; phase++) {
      pulse(phaseClk); // EXEC2 .. EXEC8, FETCH
      pulse(dataClk);
    }
    expect(readReg(cpu.a)).toBe(0x99); // A took the fake device's own reply
    expect(readReg(cpu.pc)).toBe(2);

    // --- LD A,0x77 ---
    for (let phase = 0; phase < 10; phase++) {
      pulse(phaseClk);
      pulse(dataClk);
    }
    expect(readReg(cpu.a)).toBe(0x77);
    expect(readReg(cpu.pc)).toBe(4);

    // --- OUT (0x55),A ---
    pulse(phaseClk); // -> INCREMENT
    pulse(dataClk);
    pulse(phaseClk); // -> EXEC1 (PHASE2: reads 0x55, strobes ioWrite with A already on ioPortDataOut)
    pulse(dataClk);
    expect(readPin(cpu.ioWrite)).toBe(1);
    expect(readPin(cpu.ioRead)).toBe(0);
    expect((readReg(cpu.ioPortAddr) & 0xff)).toBe(0x55);
    expect(readReg(cpu.ioPortDataOut)).toBe(0x77);
    for (let phase = 0; phase < 8; phase++) {
      pulse(phaseClk); // EXEC2 .. EXEC8, FETCH
      pulse(dataClk);
    }
    expect(readReg(cpu.a)).toBe(0x77); // OUT never touches A
    expect(readReg(cpu.pc)).toBe(6);
  });
});
