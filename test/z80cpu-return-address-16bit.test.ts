import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * A return address is a full word on the stack, high byte at the higher address,
 * whatever the PC width: subroutines, restarts and interrupts entered from above
 * 0xFF have to return to the right place. Every test here runs on the 12-bit
 * machine and keeps its call sites in page 1 so a one-byte return address would
 * come back in page 0.
 */
const ADDR_BITS = 12;
const SP0 = 0xd00;

type Harness = ReturnType<typeof makeZ80Harness>;

function machine(program: Uint8Array): Harness {
  return makeZ80Harness(program, ADDR_BITS, (cpu, seedReg) => {
    for (const reg of [cpu.rB, cpu.rC, cpu.rD, cpu.rE, cpu.rH, cpu.rL, cpu.rIXH, cpu.rIXL, cpu.rIYH, cpu.rIYL]) seedReg(reg, 0);
    seedReg(cpu.sp, SP0, ADDR_BITS);
    for (const reg of [cpu.aP, cpu.fP, cpu.bP, cpu.cP, cpu.dP, cpu.eP, cpu.hP, cpu.lP]) seedReg(reg, 0);
  });
}

function image(parts: [number, number[]][]): Uint8Array {
  const bytes = new Uint8Array(1 << ADDR_BITS);
  for (const [at, data] of parts) bytes.set(data, at);
  return bytes;
}

const pc = (h: Harness) => h.readReg(h.cpu.pc);
const sp = (h: Harness) => h.readReg(h.cpu.sp.q);
const word = (h: Harness, at: number) => h.cpu.ram.bytes[at]! | (h.cpu.ram.bytes[at + 1]! << 8);

describe('buildZ80Cpu — return addresses are 16 bits', () => {
  it('CALL nn from page 1 pushes the whole return address and RET resumes there', () => {
    const h = machine(
      image([
        [0x0000, [0xc3, 0x00, 0x01]], // JP 0100h
        [0x0100, [0xcd, 0x00, 0x02, 0x3e, 0x42, 0x76]], // CALL 0200h ; LD A,42h ; HALT
        [0x0200, [0x06, 0x11, 0xc9]], // LD B,11h ; RET
      ]),
    );
    h.runInstruction(); // JP
    expect(pc(h)).toBe(0x100);
    h.runInstruction(); // CALL
    expect(pc(h)).toBe(0x200);
    expect(sp(h)).toBe(SP0 - 2);
    expect(word(h, SP0 - 2)).toBe(0x0103);
    h.runInstruction(); // LD B,11h
    expect(h.readReg(h.cpu.rB.q)).toBe(0x11);
    h.runInstruction(); // RET
    expect(pc(h)).toBe(0x103);
    expect(sp(h)).toBe(SP0);
    h.runInstruction(); // LD A,42h
    expect(h.readReg(h.cpu.a)).toBe(0x42);
  });

  it('RST from page 1 returns to the instruction after it', () => {
    const h = machine(
      image([
        [0x0000, [0xc3, 0x00, 0x01]], // JP 0100h
        [0x0008, [0x0e, 0x77, 0xc9]], // RST 08h target: LD C,77h ; RET
        [0x0100, [0xcf, 0x3e, 0x42]], // RST 08h ; LD A,42h
      ]),
    );
    h.runInstruction(); // JP
    h.runInstruction(); // RST 08h
    expect(pc(h)).toBe(0x08);
    expect(sp(h)).toBe(SP0 - 2);
    expect(word(h, SP0 - 2)).toBe(0x0101);
    h.runInstruction(); // LD C,77h
    h.runInstruction(); // RET
    expect(pc(h)).toBe(0x101);
    expect(sp(h)).toBe(SP0);
    expect(h.readReg(h.cpu.rC.q)).toBe(0x77);
  });

  it('CALL cc,nn pushes only when taken, and RET cc pops only when taken', () => {
    const h = machine(
      image([
        [0x0000, [0xc3, 0x00, 0x01]], // JP 0100h
        // 0100: XOR A (Z=1) ; CALL NZ,0200h (not taken) ; CALL Z,0200h (taken) ; LD A,42h
        [0x0100, [0xaf, 0xc4, 0x00, 0x02, 0xcc, 0x00, 0x02, 0x3e, 0x42]],
        // 0200: RET NZ (not taken, Z=1) ; LD B,11h ; RET Z (taken)
        [0x0200, [0xc0, 0x06, 0x11, 0xc8]],
      ]),
    );
    h.runInstruction(); // JP
    h.runInstruction(); // XOR A
    h.runInstruction(); // CALL NZ,0200h — not taken
    expect(pc(h)).toBe(0x104);
    expect(sp(h)).toBe(SP0);
    h.runInstruction(); // CALL Z,0200h — taken
    expect(pc(h)).toBe(0x200);
    expect(sp(h)).toBe(SP0 - 2);
    expect(word(h, SP0 - 2)).toBe(0x0107);
    h.runInstruction(); // RET NZ — not taken
    expect(pc(h)).toBe(0x201);
    expect(sp(h)).toBe(SP0 - 2);
    h.runInstruction(); // LD B,11h
    h.runInstruction(); // RET Z — taken
    expect(pc(h)).toBe(0x107);
    expect(sp(h)).toBe(SP0);
  });

  it('RETN and RETI restore a return address from page 1', () => {
    for (const [name, second] of [
      ['RETN', 0x45],
      ['RETI', 0x4d],
    ] as const) {
      const h = machine(
        image([
          [0x0000, [0xc3, 0x00, 0x01]], // JP 0100h
          [0x0100, [0xcd, 0x00, 0x02, 0x3e, 0x42]], // CALL 0200h ; LD A,42h
          [0x0200, [0xed, second]], // RETN / RETI
        ]),
      );
      h.runInstruction(); // JP
      h.runInstruction(); // CALL
      h.runInstruction(); // RETN / RETI
      expect(pc(h), name).toBe(0x103);
      expect(sp(h), name).toBe(SP0);
    }
  });

  it('an NMI taken in page 1 pushes the interrupted address and RETN returns to it', () => {
    const h = machine(
      image([
        [0x0000, [0xc3, 0x00, 0x01]], // JP 0100h
        [0x0100, [0xfb, 0x00, 0x3e, 0x11]], // EI ; NOP ; LD A,11h
        [0x0066, [0x06, 0x42]], // NMI routine: LD B,42h
        [0x0068, [0xed, 0x45]], // RETN
      ]),
    );
    h.runInstruction(); // JP
    h.runInstruction(); // EI
    h.nmiInput.value = 1;
    h.runInstruction(); // NOP — the NMI is accepted at the next fetch
    expect(pc(h)).toBe(0x102);
    h.nmiInput.value = 0;
    h.runInstruction(); // the NMI sequence: push, jump to 0066h
    expect(pc(h)).toBe(0x66);
    expect(sp(h)).toBe(SP0 - 2);
    expect(word(h, SP0 - 2)).toBe(0x0102);
    h.runInstruction(); // LD B,42h
    h.runInstruction(); // RETN
    expect(pc(h)).toBe(0x102);
    expect(sp(h)).toBe(SP0);
  });
});
