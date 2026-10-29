import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * NMI → $0066, IFF1 clear / IFF2 kept; RETN restores IFF1←IFF2.
 */
describe('buildZ80Cpu — NMI + RETN', () => {
  it('NMI pushes PC, jumps to $66, clears IFF1 only; RETN restores IFF1', () => {
    const ADDR_BITS = 7;
    const SP0 = 0x60;
    const PROGRAM = (() => {
      const bytes = new Uint8Array(1 << ADDR_BITS);
      bytes.set([0xfb], 0); // EI
      bytes.set([0x00], 1); // NOP — commits IFF
      bytes.set([0x3e, 0x11], 2); // LD A,0x11 — interrupted / return target
      bytes.set([0x06, 0x42], 0x66); // NMI ISR
      bytes.set([0xed, 0x45], 0x68); // RETN
      return bytes;
    })();

    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, 0);
      seedReg(cpu.rL, 0);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, 0);
      seedReg(cpu.rIYL, 0);
      seedReg(cpu.sp, SP0, ADDR_BITS);
      seedReg(cpu.aP, 0);
      seedReg(cpu.fP, 0);
      seedReg(cpu.bP, 0);
      seedReg(cpu.cP, 0);
      seedReg(cpu.dP, 0);
      seedReg(cpu.eP, 0);
      seedReg(cpu.hP, 0);
      seedReg(cpu.lP, 0);
    });

    h.runInstruction(); // EI
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    // Raise NMI before the following NOP finishes so wrap-PHASE0 sees the edge
    // (same timing window as INT in z80cpu-irq-im1.test.ts).
    h.nmiInput.value = 1;
    h.runInstruction(); // NOP — IFF commits mid-instr; wrap PHASE0 accepts NMI
    expect(h.readReg(h.cpu.iff1)).toBe(0); // cleared on NMI
    expect(h.readReg(h.cpu.iff2)).toBe(1); // kept
    expect(h.readReg(h.cpu.ir)).toBe(0x00); // forced NOP
    expect(h.readReg(h.cpu.pc)).toBe(2); // nmiServing holds PHASE1

    h.nmiInput.value = 0;
    h.runInstruction(); // finish NMI: push + jump $66

    expect(h.readReg(h.cpu.pc)).toBe(0x66);
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.iff2)).toBe(1);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(2); // return address, low byte
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0); // high byte

    h.runInstruction(); // LD B,0x42
    expect(h.readReg(h.cpu.rB.q)).toBe(0x42);

    h.runInstruction(); // RETN
    expect(h.readReg(h.cpu.pc)).toBe(2);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0);
    expect(h.readReg(h.cpu.iff1)).toBe(1);
    expect(h.readReg(h.cpu.iff2)).toBe(1);

    h.runInstruction(); // LD A,0x11
    expect(h.readReg(h.cpu.a)).toBe(0x11);
  });
});
