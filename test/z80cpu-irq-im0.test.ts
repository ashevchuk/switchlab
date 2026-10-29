import { describe, expect, it } from 'vitest';
import { createSoftZ80, softAcceptIrq } from '../src/machine/softZ80.js';
import { makeZ80Harness } from './z80Harness.js';

function setIrqBus(h: ReturnType<typeof makeZ80Harness>, byte: number) {
  for (let i = 0; i < 8; i++) {
    h.irqBusInputs[i]!.value = ((byte >> i) & 1) as 0 | 1;
  }
}

describe('soft Z80 — IM 0', () => {
  it('pushes PC then executes irqBusByte as opcode (NOP)', () => {
    const cpu = createSoftZ80(0xffff);
    cpu.im = 0;
    cpu.iff1 = true;
    cpu.iff2 = true;
    cpu.pc = 0x8000;
    cpu.sp = 0xff00;
    cpu.a = 0;
    const ram = new Uint8Array(0x10000);
    let pending = true;
    expect(
      softAcceptIrq(cpu, ram, {
        irqPending: () => pending,
        clearIrq: () => {
          pending = false;
        },
        irqBusByte: () => 0x00, // NOP after soft's mandatory push
      }),
    ).toBe(true);
    expect(cpu.iff1).toBe(false);
    expect(cpu.iff2).toBe(false);
    expect(cpu.pc).toBe(0x8000);
    expect(cpu.sp).toBe(0xfefe);
    expect(ram[0xfefe]! | (ram[0xfeff]! << 8)).toBe(0x8000);
    expect(pending).toBe(false);
  });

  it('IM0 with RST 38h bus byte jumps to $38 after soft pre-push', () => {
    const cpu = createSoftZ80(0xffff);
    cpu.im = 0;
    cpu.iff1 = true;
    cpu.pc = 0x1234;
    cpu.sp = 0xff00;
    const ram = new Uint8Array(0x10000);
    softAcceptIrq(cpu, ram, {
      irqPending: () => true,
      clearIrq: () => {},
      irqBusByte: () => 0xff, // RST 38 — soft pushes once then RST pushes again
    });
    expect(cpu.pc).toBe(0x0038);
    // Two pushes: soft pre-push then RST
    expect(cpu.sp).toBe(0xfefc);
  });
});

describe('buildZ80Cpu — IM 0 + irqBus', () => {
  it('IM 0 + irqBus 0xFF acts like RST 38h', () => {
    const ADDR_BITS = 7;
    const SP0 = 0x60;
    const PROGRAM = (() => {
      const bytes = new Uint8Array(1 << ADDR_BITS);
      bytes.set([0xed, 0x46], 0); // IM 0
      bytes.set([0xfb], 2); // EI
      bytes.set([0x00], 3); // NOP — EI delay
      bytes.set([0x3e, 0x99], 4); // return target
      bytes.set([0x06, 0x42], 0x38); // ISR
      bytes.set([0xed, 0x4d], 0x3a); // RETI
      return bytes;
    })();

    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.sp, SP0, ADDR_BITS);
    });
    setIrqBus(h, 0xff);

    h.runInstruction(); // IM 0
    expect(h.readReg(h.cpu.im0)).toBe(1);
    expect(h.readReg(h.cpu.im1)).toBe(0);

    h.intInput.value = 1;
    h.runInstruction(); // EI
    h.runInstruction(); // NOP → accept INT, IR←0xFF
    expect(h.readReg(h.cpu.ir)).toBe(0xff);
    expect(h.readReg(h.cpu.iff1)).toBe(0);

    h.intInput.value = 0;
    h.runInstruction(); // finish RST 38h
    expect(h.readReg(h.cpu.pc)).toBe(0x38);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
  });

  it('IM 0 + irqBus 0x00 injects NOP (IFF cleared, PC held)', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0xed, 0x46], 0); // IM 0
      bytes.set([0xfb], 2);
      bytes.set([0x00], 3);
      bytes.set([0x3e, 0x55], 4); // LD A,0x55 — should run after NOP inject
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);
    setIrqBus(h, 0x00);

    h.runInstruction(); // IM 0
    h.intInput.value = 1;
    h.runInstruction(); // EI
    h.runInstruction(); // NOP → accept, IR←0x00
    expect(h.readReg(h.cpu.ir)).toBe(0x00);
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.pc)).toBe(4); // intServing held PHASE1

    h.intInput.value = 0;
    h.runInstruction(); // injected NOP body
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // LD A,0x55
    expect(h.readReg(h.cpu.a)).toBe(0x55);
  });

  it('INTACK_WAIT holds PC on PHASE1 after maskable accept', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0xed, 0x56], 0); // IM 1
      bytes.set([0xfb], 2); // EI
      bytes.set([0x00], 3); // NOP — EI delay then accept
      bytes.set([0x3e, 0xaa], 4);
      bytes.set([0xc9], 0x38); // ISR RET
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);
    h.runInstruction(); // IM 1
    h.intInput.value = 1;
    h.runInstruction(); // EI
    h.runInstruction(); // accept INT — PHASE0 INTACK_NOW, PHASE1 INTACK_WAIT
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.pc)).toBe(4); // PC held through INTACK wait
    expect(h.readReg(h.cpu.ir)).toBe(0xff); // RST 38h inject
  });

  it('IM mode latches are exclusive', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0xed, 0x46], 0); // IM 0
      bytes.set([0xed, 0x56], 2); // IM 1
      bytes.set([0xed, 0x5e], 4); // IM 2
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);
    h.runInstruction();
    expect(h.readReg(h.cpu.im0)).toBe(1);
    expect(h.readReg(h.cpu.im1)).toBe(0);
    expect(h.readReg(h.cpu.im2)).toBe(0);
    h.runInstruction();
    expect(h.readReg(h.cpu.im0)).toBe(0);
    expect(h.readReg(h.cpu.im1)).toBe(1);
    expect(h.readReg(h.cpu.im2)).toBe(0);
    h.runInstruction();
    expect(h.readReg(h.cpu.im0)).toBe(0);
    expect(h.readReg(h.cpu.im1)).toBe(0);
    expect(h.readReg(h.cpu.im2)).toBe(1);
  });

  it('IM 2 + irqBus vector pushes PC and jumps to ISR', () => {
    const ADDR_BITS = 7;
    const SP0 = 0x60;
    const VEC = 0x40;
    const ISR = 0x20;
    const PROGRAM = (() => {
      const bytes = new Uint8Array(1 << ADDR_BITS);
      bytes.set([0xed, 0x5e], 0); // IM 2
      bytes.set([0xfb], 2); // EI
      bytes.set([0x00], 3); // NOP — EI delay
      bytes.set([0x3e, 0x99], 4); // return target LD A,0x99
      bytes[VEC] = ISR; // vector lo
      bytes[VEC + 1] = 0x00; // vector hi (unused when addrBits<=8)
      bytes.set([0x06, 0x42], ISR); // ISR: LD B,0x42
      bytes.set([0xed, 0x4d], ISR + 2); // RETI
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
    setIrqBus(h, VEC); // I defaults to 0 → vector at 0x0040

    h.runInstruction(); // IM 2
    expect(h.readReg(h.cpu.im2)).toBe(1);
    expect(h.readReg(h.cpu.im0)).toBe(0);
    expect(h.readReg(h.cpu.im1)).toBe(0);

    h.intInput.value = 1;
    h.runInstruction(); // EI
    h.runInstruction(); // NOP → accept INT, IR←NOP, im2Serving
    expect(h.readReg(h.cpu.ir)).toBe(0x00);
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.pc)).toBe(4); // PHASE1 held

    h.intInput.value = 0;
    h.runInstruction(); // finish IM2: push + vector→PC
    expect(h.readReg(h.cpu.pc)).toBe(ISR);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(4); // return address, low byte
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0); // high byte

    h.runInstruction(); // LD B,0x42
    expect(h.readReg(h.cpu.rB.q)).toBe(0x42);

    h.runInstruction(); // RETI
    expect(h.readReg(h.cpu.pc)).toBe(4);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0);

    h.runInstruction(); // LD A,0x99
    expect(h.readReg(h.cpu.a)).toBe(0x99);
  });
});
