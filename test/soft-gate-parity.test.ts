import { describe, expect, it } from 'vitest';
import {
  createSoftZ80,
  softStep,
  type SoftMemHooks,
  type SoftZ80State,
} from '../src/machine/softZ80.js';
import { makeZ80Harness, type Z80Harness } from './z80Harness.js';
import type { Z80Cpu } from '../src/sim/blocks.js';
import type { Pin } from '../src/sim/types.js';

/**
 * Soft vs gate register/RAM parity.
 *
 * Flag mask excludes:
 * - X (bit 3) / Y (bit 5): undocumented; soft never writes them, gate often
 *   copies them from the result byte.
 * - P/V (bit 2): soft ALU/INC/DEC uses parity; gate uses signed overflow for
 *   arithmetic. Documented bits S/Z/H/N/C are compared.
 *
 * Soft runs with `addrBits=7`; CALL/RET/RST, PUSH/POP qq and EX (SP),HL all
 * use two-byte stack words on both sides. `gateCatchUp` advances rings until
 * PC and SP match after each softStep.
 */
const FLAG_MASK = 0xd3; // S Z - H - - N C  (exclude Y=0x20, X=0x08, P/V=0x04)
const ADDR_BITS = 7;
const ADDR_MASK = (1 << ADDR_BITS) - 1;
const SP0 = 0x60;
const PARITY_HOOKS: SoftMemHooks = { addrBits: ADDR_BITS };

interface Snapshot {
  a: number;
  f: number;
  bc: number;
  de: number;
  hl: number;
  ix: number;
  iy: number;
  sp: number;
  pc: number;
  ram: number[];
}

function softSnap(cpu: SoftZ80State, ram: Uint8Array, addrs: number[]): Snapshot {
  return {
    a: cpu.a,
    f: cpu.f & FLAG_MASK,
    bc: (cpu.b << 8) | cpu.c,
    de: (cpu.d << 8) | cpu.e,
    hl: (cpu.h << 8) | cpu.l,
    ix: cpu.ix & 0xffff,
    iy: cpu.iy & 0xffff,
    sp: cpu.sp & ADDR_MASK,
    pc: cpu.pc & ADDR_MASK,
    ram: addrs.map((a) => ram[a] ?? 0),
  };
}

function gateSnap(h: Z80Harness, addrs: number[]): Snapshot {
  const { cpu, readReg } = h;
  return {
    a: readReg(cpu.a),
    f: readReg(cpu.f) & FLAG_MASK,
    bc: (readReg(cpu.rB.q) << 8) | readReg(cpu.rC.q),
    de: (readReg(cpu.rD.q) << 8) | readReg(cpu.rE.q),
    hl: (readReg(cpu.rH.q) << 8) | readReg(cpu.rL.q),
    ix: (readReg(cpu.rIXH.q) << 8) | readReg(cpu.rIXL.q),
    iy: (readReg(cpu.rIYH.q) << 8) | readReg(cpu.rIYL.q),
    sp: readReg(cpu.sp.q),
    pc: readReg(cpu.pc),
    ram: addrs.map((a) => cpu.ram.bytes[a] ?? 0),
  };
}

function expectParity(label: string, soft: Snapshot, gate: Snapshot): void {
  const fields: (keyof Snapshot)[] = ['a', 'f', 'bc', 'de', 'hl', 'ix', 'iy', 'sp', 'pc'];
  for (const k of fields) {
    expect(gate[k], `${label}: gate.${k}=${gate[k]} soft.${k}=${soft[k]}`).toBe(soft[k]);
  }
  expect(gate.ram, `${label}: RAM bytes`).toEqual(soft.ram);
}

/**
 * Advance the gate until PC and SP match soft after one softStep.
 * Prefixed / multi-ring ops may need more than one 10-phase ring.
 */
function gateCatchUp(h: Z80Harness, targetPc: number, targetSp: number): void {
  h.runInstruction();
  let extra = 0;
  while (h.readReg(h.cpu.pc) !== targetPc || h.readReg(h.cpu.sp.q) !== targetSp) {
    h.runInstruction();
    if (++extra > 4) {
      throw new Error(
        `gateCatchUp: gate PC=${h.readReg(h.cpu.pc)} SP=${h.readReg(h.cpu.sp.q)} ` +
          `!= soft PC=${targetPc} SP=${targetSp} after ${extra + 1} rings`,
      );
    }
  }
}

type SeedReg = (reg: { we: Pin; d: Pin[] }, value: number, width?: number) => void;

function seedDefaultRegs(cpu: Z80Cpu, seedReg: SeedReg, sp: number): void {
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
  seedReg(cpu.sp, sp, ADDR_BITS);
  seedReg(cpu.aP, 0);
  seedReg(cpu.fP, 0);
  seedReg(cpu.bP, 0);
  seedReg(cpu.cP, 0);
  seedReg(cpu.dP, 0);
  seedReg(cpu.eP, 0);
  seedReg(cpu.hP, 0);
  seedReg(cpu.lP, 0);
}

/**
 * Run the same program bytes on softZ80 and on buildZ80Cpu (via makeZ80Harness).
 * Soft runs until HALT (or maxSteps); gate catch-up follows each soft step.
 * Gate HALT (0x76) latches `halted` (MachineRunner stop-clock); PC still
 * sits past the HALT byte after fetch/increment, matching soft.
 * soft's fetch-then-halt PC.
 */
function runBoth(program: Uint8Array, ramAddrs: number[], maxSteps = 16, sp = SP0) {
  const softRam = new Uint8Array(1 << ADDR_BITS);
  softRam.set(program);
  const softCpu = createSoftZ80(sp);
  let steps = 0;
  while (steps < maxSteps && !softCpu.halted) {
    softStep(softCpu, softRam, PARITY_HOOKS);
    steps++;
  }
  expect(steps, 'soft should retire at least one instruction').toBeGreaterThan(0);
  expect(softCpu.halted, 'soft programs should end in HALT').toBe(true);

  const soft2Ram = new Uint8Array(1 << ADDR_BITS);
  soft2Ram.set(program);
  const soft2 = createSoftZ80(sp);
  const h = makeZ80Harness(Uint8Array.from(program), ADDR_BITS, (cpu, seedReg) => {
    seedDefaultRegs(cpu, seedReg, sp);
  });
  for (let i = 0; i < steps; i++) {
    softStep(soft2, soft2Ram, PARITY_HOOKS);
    gateCatchUp(h, soft2.pc & ADDR_MASK, soft2.sp & ADDR_MASK);
  }

  return {
    soft: softSnap(soft2, soft2Ram, ramAddrs),
    gate: gateSnap(h, ramAddrs),
    steps,
  };
}

describe('softZ80 vs buildZ80Cpu parity', () => {
  it('LD A,n / ADD A,n / HALT', () => {
    const program = new Uint8Array([0x3e, 0x02, 0xc6, 0x03, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('LD/ADD', soft, gate);
    expect(soft.a).toBe(5);
  });

  it('LD HL,nn / LD (HL),A / HALT', () => {
    const program = new Uint8Array([0x3e, 0xab, 0x21, 0x10, 0x00, 0x77, 0x76]);
    const { soft, gate } = runBoth(program, [0x10]);
    expectParity('LD (HL),A', soft, gate);
    expect(soft.ram[0]).toBe(0xab);
    expect(soft.hl).toBe(0x10);
  });

  it('JR relative skip / HALT', () => {
    const program = new Uint8Array([0x18, 0x02, 0x00, 0x00, 0x3e, 0x42, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('JR', soft, gate);
    expect(soft.a).toBe(0x42);
  });

  it('simple DEC A / JR NZ loop / HALT', () => {
    const program = new Uint8Array([0x3e, 0x02, 0x3d, 0x20, 0xfd, 0x76]);
    const { soft, gate, steps } = runBoth(program, [], 16);
    expect(steps).toBeGreaterThan(3);
    expectParity('JR NZ loop', soft, gate);
    expect(soft.a).toBe(0);
  });

  it('CB RLC A / HALT', () => {
    const program = new Uint8Array([0x3e, 0x81, 0xcb, 0x07, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('RLC A', soft, gate);
    expect(soft.a).toBe(0x03);
    expect(soft.f & 0x01).toBe(0x01);
  });

  it('LD BC,nn / INC BC / HALT', () => {
    const program = new Uint8Array([0x01, 0x34, 0x12, 0x03, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('INC BC', soft, gate);
    expect(soft.bc).toBe(0x1235);
  });

  it('XOR A / OR n / HALT', () => {
    const program = new Uint8Array([0xaf, 0xf6, 0x0f, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('XOR/OR', soft, gate);
    expect(soft.a).toBe(0x0f);
  });

  it('CP n / HALT', () => {
    const program = new Uint8Array([0x3e, 0x05, 0xfe, 0x06, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('CP', soft, gate);
    expect(soft.a).toBe(0x05);
    expect(soft.f & 0x40).toBe(0);
    expect(soft.f & 0x01).toBe(0x01);
    expect(soft.f & 0x02).toBe(0x02);
  });

  it('LD A,(nn) / LD (nn),A / HALT', () => {
    const program = new Uint8Array([0x3e, 0xab, 0x32, 0x40, 0x00, 0xaf, 0x3a, 0x40, 0x00, 0x76]);
    const { soft, gate } = runBoth(program, [0x40]);
    expectParity('LD (nn),A / LD A,(nn)', soft, gate);
    expect(soft.a).toBe(0xab);
    expect(soft.ram[0]).toBe(0xab);
  });

  it('AND n / XOR n / HALT', () => {
    // LD A,0xF0 / AND 0x3C / XOR 0x0F / HALT → A=0x3F
    const program = new Uint8Array([0x3e, 0xf0, 0xe6, 0x3c, 0xee, 0x0f, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('AND/XOR', soft, gate);
    expect(soft.a).toBe(0x3f);
  });

  it('LD DE,nn / DEC DE / HALT', () => {
    const program = new Uint8Array([0x11, 0x00, 0x10, 0x1b, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('DEC DE', soft, gate);
    expect(soft.de).toBe(0x0fff);
  });

  it('SCF / CCF / HALT', () => {
    const program = new Uint8Array([0x37, 0x3f, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('SCF/CCF', soft, gate);
    expect(soft.f & 0x01).toBe(0);
  });

  it('ED NEG / HALT', () => {
    // LD A,0x01 / ED NEG / HALT → A=0xFF, N set, C set
    const program = new Uint8Array([0x3e, 0x01, 0xed, 0x44, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('ED NEG', soft, gate);
    expect(soft.a).toBe(0xff);
    expect(soft.f & 0x02).toBe(0x02);
    expect(soft.f & 0x01).toBe(0x01);
  });

  it('ED LDI / HALT', () => {
    // LD BC,1 / LD DE,0x60 / LD HL,0x50 / LDI / HALT; RAM[0x50]=0x77
    const program = new Uint8Array(128);
    program.set([0x01, 0x01, 0x00, 0x11, 0x60, 0x00, 0x21, 0x50, 0x00, 0xed, 0xa0, 0x76], 0);
    program[0x50] = 0x77;
    const { soft, gate } = runBoth(program, [0x50, 0x60], 16);
    expectParity('ED LDI', soft, gate);
    expect(soft.ram[1]).toBe(0x77);
    expect(soft.hl).toBe(0x51);
    expect(soft.de).toBe(0x61);
    expect(soft.bc).toBe(0);
  });

  it('DD LD IX,nn / HALT', () => {
    const program = new Uint8Array([0xdd, 0x21, 0x34, 0x12, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('DD LD IX,nn', soft, gate);
    expect(soft.ix).toBe(0x1234);
  });

  it('DD INC IX / HALT', () => {
    const program = new Uint8Array([0xdd, 0x21, 0xff, 0x00, 0xdd, 0x23, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('DD INC IX', soft, gate);
    expect(soft.ix).toBe(0x0100);
  });

  it('PUSH BC / POP BC / HALT', () => {
    const program = new Uint8Array([0x01, 0x34, 0x12, 0xc5, 0xc1, 0x76]);
    const { soft, gate } = runBoth(program, [0x5e, 0x5f]);
    expectParity('PUSH/POP BC', soft, gate);
    expect(soft.bc).toBe(0x1234);
    expect(soft.sp).toBe(SP0);
    expect(soft.ram[0]).toBe(0x34);
    expect(soft.ram[1]).toBe(0x12);
  });

  it('CALL nn / RET / HALT', () => {
    // 0: CALL 0x10; 3: LD A,0x99; HALT; 0x10: LD A,0x42; RET
    const program = new Uint8Array(128);
    program.set([0xcd, 0x10, 0x00, 0x3e, 0x99, 0x76], 0);
    program.set([0x3e, 0x42, 0xc9], 0x10);
    const { soft, gate } = runBoth(program, [0x5f], 16);
    expectParity('CALL/RET', soft, gate);
    expect(soft.a).toBe(0x99);
    expect(soft.sp).toBe(SP0);
  });

  it('DD PUSH IX / POP IX / HALT', () => {
    const program = new Uint8Array([
      0xdd, 0x21, 0x34, 0x12, 0xdd, 0xe5, 0xdd, 0x21, 0x00, 0x00, 0xdd, 0xe1, 0x76,
    ]);
    const { soft, gate } = runBoth(program, [0x5e, 0x5f], 16);
    expectParity('DD PUSH/POP IX', soft, gate);
    expect(soft.ix).toBe(0x1234);
    expect(soft.sp).toBe(SP0);
    expect(soft.ram[0]).toBe(0x34);
    expect(soft.ram[1]).toBe(0x12);
  });

  it('CALL Z taken / RET / CALL NZ not-taken / HALT', () => {
    // XOR A (Z=1) / CALL Z,0x20 / LD A,0x11 / CALL NZ,0x30 / LD A,0x22 / HALT
    // 0x20: LD A,0x42 / RET
    // 0x30: trap (must not run)
    const program = new Uint8Array(128);
    program.set([0xaf, 0xcc, 0x20, 0x00, 0x3e, 0x11, 0xc4, 0x30, 0x00, 0x3e, 0x22, 0x76], 0);
    program.set([0x3e, 0x42, 0xc9], 0x20);
    program.set([0x3e, 0x99], 0x30);
    const { soft, gate } = runBoth(program, [], 16);
    expectParity('CALL cc', soft, gate);
    expect(soft.a).toBe(0x22);
    expect(soft.sp).toBe(SP0);
  });

  it('RET Z taken / RET NZ not-taken / HALT', () => {
    // XOR A / CALL 0x40 / LD A,0x11 / CALL 0x50 / LD A,0x22 / HALT
    // 0x40: RET Z (taken)
    // 0x50: RET NZ (not taken) / RET
    const program = new Uint8Array(128);
    program.set([0xaf, 0xcd, 0x40, 0x00, 0x3e, 0x11, 0xcd, 0x50, 0x00, 0x3e, 0x22, 0x76], 0);
    program.set([0xc8], 0x40);
    program.set([0xc0, 0xc9], 0x50);
    const { soft, gate } = runBoth(program, [], 16);
    expectParity('RET cc', soft, gate);
    expect(soft.a).toBe(0x22);
    expect(soft.sp).toBe(SP0);
  });

  it('RST 30h / RET / HALT', () => {
    // RST 30H (0xF7) → 0x30; subroutine LD A,0x42 / RET; then LD A,0x99 / HALT.
    // Skip stack RAM compare: gate may float high bits on the addrBits-wide
    // return-byte bus (soft writes a clean 8-bit return PC).
    const program = new Uint8Array(128);
    program.set([0xf7, 0x3e, 0x99, 0x76], 0);
    program.set([0x3e, 0x42, 0xc9], 0x30);
    const { soft, gate } = runBoth(program, [], 16);
    expectParity('RST 30h', soft, gate);
    expect(soft.a).toBe(0x99);
    expect(soft.sp).toBe(SP0);
  });

  it('CALL C taken / CALL NC not-taken / HALT', () => {
    // SCF / CALL C,0x20 / LD A,0x11 / CALL NC,0x30 / LD A,0x22 / HALT
    const program = new Uint8Array(128);
    program.set([0x37, 0xdc, 0x20, 0x00, 0x3e, 0x11, 0xd4, 0x30, 0x00, 0x3e, 0x22, 0x76], 0);
    program.set([0x3e, 0x42, 0xc9], 0x20);
    program.set([0x3e, 0x99], 0x30);
    const { soft, gate } = runBoth(program, [], 16);
    expectParity('CALL C/NC', soft, gate);
    expect(soft.a).toBe(0x22);
    expect(soft.sp).toBe(SP0);
  });

  it('RET C taken / RET NC not-taken / HALT', () => {
    // SCF / CALL 0x40 / LD A,0x11 / CALL 0x50 / LD A,0x22 / HALT
    const program = new Uint8Array(128);
    program.set([0x37, 0xcd, 0x40, 0x00, 0x3e, 0x11, 0xcd, 0x50, 0x00, 0x3e, 0x22, 0x76], 0);
    program.set([0xd8], 0x40);
    program.set([0xd0, 0xc9], 0x50);
    const { soft, gate } = runBoth(program, [], 16);
    expectParity('RET C/NC', soft, gate);
    expect(soft.a).toBe(0x22);
    expect(soft.sp).toBe(SP0);
  });

  it('EX (SP),HL / HALT', () => {
    // LD HL,0xBBAA / EX (SP),HL / HALT; RAM[SP]=0x11, RAM[SP+1]=0x22
    const program = new Uint8Array(128);
    program.set([0x21, 0xaa, 0xbb, 0xe3, 0x76], 0);
    program[SP0] = 0x11;
    program[SP0 + 1] = 0x22;
    const { soft, gate } = runBoth(program, [SP0, SP0 + 1], 16);
    expectParity('EX (SP),HL', soft, gate);
    expect(soft.hl).toBe(0x2211);
    expect(soft.ram[0]).toBe(0xaa);
    expect(soft.ram[1]).toBe(0xbb);
    expect(soft.sp).toBe(SP0);
  });
});

describe('softZ80 FD/ED corners (soft-only)', () => {
  it('FD LD IY,nn / ADD IY,BC', () => {
    const ram = new Uint8Array(256);
    ram.set([0xfd, 0x21, 0x00, 0x10, 0x01, 0x11, 0x00, 0xfd, 0x09, 0x76], 0);
    const cpu = createSoftZ80();
    cpu.sp = SP0;
    let guard = 0;
    while (!cpu.halted && guard++ < 64) softStep(cpu, ram, PARITY_HOOKS);
    expect(cpu.iy & 0xffff).toBe(0x1011);
    expect(cpu.halted).toBe(true);
  });

  it('ED SBC HL,BC with carry', () => {
    const ram = new Uint8Array(256);
    ram.set([0x21, 0x00, 0x01, 0x01, 0x01, 0x00, 0x37, 0xed, 0x42, 0x76], 0);
    const cpu = createSoftZ80();
    cpu.sp = SP0;
    let guard = 0;
    while (!cpu.halted && guard++ < 64) softStep(cpu, ram, PARITY_HOOKS);
    expect(((cpu.h << 8) | cpu.l) & 0xffff).toBe(0x00fe);
    expect(cpu.halted).toBe(true);
  });
});
