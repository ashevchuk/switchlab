import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * Thin IM1 IRQ — EI/DI (with soft-parity EI delay), IM 1, INT→RST 38h, RETI.
 *
 * EI delay: IFF enables on PHASE2 of the instruction that *follows* EI
 * (soft `eiDelay` parity — INT cannot interrupt that following instruction).
 */
describe('buildZ80Cpu — thin IM1 IRQ', () => {
  it('EI delay then INT forces RST 38h; RETI restores IFF1 from IFF2', () => {
    const ADDR_BITS = 7;
    const SP0 = 0x60;
    const PROGRAM = (() => {
      const bytes = new Uint8Array(1 << ADDR_BITS);
      bytes.set([0xed, 0x56], 0); // IM 1
      bytes.set([0xfb], 2); // EI
      bytes.set([0x00], 3); // NOP — runs with IFF still off at FETCH
      bytes.set([0x3e, 0x99], 4); // LD A,0x99 — return target after RETI
      bytes.set([0x06, 0x42], 0x38); // ISR
      bytes.set([0xed, 0x4d], 0x3a); // RETI
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

    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.im1)).toBe(0);

    h.runInstruction(); // IM 1
    expect(h.readReg(h.cpu.im1)).toBe(1);
    expect(h.readReg(h.cpu.pc)).toBe(2);

    // INT during EI must not steal the following NOP (IFF still off at its FETCH).
    h.intInput.value = 1;
    h.runInstruction(); // EI
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.pc)).toBe(3);

    h.runInstruction(); // NOP — IFF commits mid-instr; wrap PHASE0 accepts INT
    expect(h.readReg(h.cpu.iff1)).toBe(0); // cleared on accept
    expect(h.readReg(h.cpu.ir)).toBe(0xff);
    expect(h.readReg(h.cpu.pc)).toBe(4); // intServing holds PHASE1 advance

    h.intInput.value = 0;
    h.runInstruction(); // finish RST 38h

    expect(h.readReg(h.cpu.pc)).toBe(0x38);
    expect(h.readReg(h.cpu.iff2)).toBe(0);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(4); // return address, low byte
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0); // high byte

    h.runInstruction(); // LD B,0x42
    expect(h.readReg(h.cpu.rB.q)).toBe(0x42);

    h.runInstruction(); // RETI
    expect(h.readReg(h.cpu.pc)).toBe(4);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0);
    expect(h.readReg(h.cpu.iff1)).toBe(0);

    h.runInstruction(); // LD A,0x99
    expect(h.readReg(h.cpu.a)).toBe(0x99);
    expect(h.readReg(h.cpu.pc)).toBe(6);
  });

  it('DI clears IFF; INT is ignored while disabled', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0xed, 0x56], 0);
      bytes.set([0xfb], 2);
      bytes.set([0x00], 3); // NOP — completes EI delay
      bytes.set([0xf3], 4); // DI
      bytes.set([0x3e, 0x11], 5);
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction(); // IM 1
    h.runInstruction(); // EI
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    h.runInstruction(); // NOP — IFF commits
    expect(h.readReg(h.cpu.iff1)).toBe(1);

    h.runInstruction(); // DI
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.iff2)).toBe(0);

    h.intInput.value = 1;
    h.runInstruction(); // LD A,0x11
    h.intInput.value = 0;
    expect(h.readReg(h.cpu.a)).toBe(0x11);
    expect(h.readReg(h.cpu.pc)).toBe(7);
  });

  it('HALT latches halted; INT wakes', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0xed, 0x56], 0);
      bytes.set([0xfb], 2);
      bytes.set([0x00], 3);
      bytes.set([0x76], 4); // HALT
      bytes.set([0x06, 0x42], 0x38);
      bytes.set([0xed, 0x4d], 0x3a);
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM, 7, (cpu, seedReg) => {
      seedReg(cpu.sp, 0x60, 7);
    });

    h.runInstruction(); // IM 1
    h.runInstruction(); // EI
    h.runInstruction(); // NOP → IFF on
    expect(h.readReg(h.cpu.iff1)).toBe(1);
    expect(h.readReg(h.cpu.halted)).toBe(0);

    h.runInstruction(); // HALT
    expect(h.readReg(h.cpu.halted)).toBe(1);
    expect(h.readReg(h.cpu.pc)).toBe(5);

    h.intInput.value = 1;
    h.runInstruction(); // accept INT, clear halted
    expect(h.readReg(h.cpu.halted)).toBe(0);
    expect(h.readReg(h.cpu.ir)).toBe(0xff);
  });
});
