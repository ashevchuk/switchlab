/**
 * Soft Z80 interpreter for MachineRunner Run — behavioral, same trade-off as
 * RamComponent / TTY. Drives the shared `ram.bytes` so the panel sees results
 * immediately. Not transistor-accurate timing; gate-level Step still uses
 * the real circuit.
 *
 * Unprefixed subset for the command ROM, plus CB / ED / DD / FD prefixes.
 */

import { KEY_DATA, KEY_STATUS } from './memoryMap.js';

export interface SoftZ80State {
  a: number;
  f: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
  a2: number;
  f2: number;
  b2: number;
  c2: number;
  d2: number;
  e2: number;
  h2: number;
  l2: number;
  ix: number;
  iy: number;
  i: number;
  r: number;
  iff1: boolean;
  iff2: boolean;
  /** Frames until IFF enable after EI (Z80: enables after the following instruction). */
  eiDelay: number;
  im: 0 | 1 | 2;
  sp: number;
  pc: number;
  halted: boolean;
}

export interface SoftMemHooks {
  clearOnReadKeys?: boolean;
  /** Override KEY_DATA for clear-on-read (64K CP/M map). */
  keyDataAddr?: number;
  /** Override KEY_STATUS for clear-on-read (64K CP/M map). */
  keyStatusAddr?: number;
  portIn?: (port: number) => number;
  portOut?: (port: number, val: number) => void;
  /**
   * When true, IN re-executes (blocking I/O). Used for z80pack CONDAT so
   * BIOS CONIN waits for a key instead of returning NUL.
   */
  portInBlock?: (port: number) => boolean;
  /**
   * Soft CP/M host trap: if set and returns true, the instruction at PC was
   * handled in host (BDOS/CCP) — do not fetch/execute.
   */
  hostTrap?: (cpu: SoftZ80State, ram: Uint8Array) => boolean;
  /**
   * Truncate PC/SP/memory addresses to `2^addrBits` — matches `buildZ80Cpu`
   * parity harnesses (addrBits=7 → 128-byte RAM).
   */
  addrBits?: number;
  /** When true, ignore writes to 0000–3FFF (Spectrum ROM). */
  romProtect?: boolean;
  /**
   * Optional full memory map (Spectrum MMU). When set, overrides flat `ram[]`
   * and `romProtect` for CPU memory access.
   */
  memRead?: (addr: number) => number;
  memWrite?: (addr: number, v: number) => void;
  /** Level-sensitive IRQ line (Spectrum ULA frame). Cleared when accepted. */
  irqPending?: () => boolean;
  /**
   * Optional shared progress counter — `softRun` stores the current step index
   * / budget here (one property store per instruction) so I/O hooks can derive
   * an intra-frame position without a per-instruction callback.
   */
  progress?: { n: number; max: number };
  /** Clear IRQ after IM1/IM2 vector taken. */
  clearIrq?: () => void;
  /**
   * Byte placed on the data bus during INTACK (IM 0 / IM 2 low vector byte).
   * Spectrum ULA floats 0xFF — default when unset.
   */
  irqBusByte?: () => number;
  /**
   * Soft INTACK wait burn — Spectrum-style ~2 wait states before the push.
   * Gate models the same window as PHASE0 ack + PHASE1 wait (IORQ∧M1 pins).
   */
  intAckWaits?: (n: number) => void;
}

const FLAG_C = 0x01;
const FLAG_N = 0x02;
const FLAG_P = 0x04;
const FLAG_X = 0x08;
const FLAG_H = 0x10;
const FLAG_Y = 0x20;
const FLAG_Z = 0x40;
const FLAG_S = 0x80;

/** Undocumented X/Y (bits 3/5) mirrored from a result byte. */
function xyFrom(f: number, b: number): number {
  return (f & ~(FLAG_X | FLAG_Y)) | (b & FLAG_X) | (b & FLAG_Y);
}

type IndexReg = 'ix' | 'iy' | null;

export function createSoftZ80(sp = 0xdff): SoftZ80State {
  return {
    a: 0,
    f: 0,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    h: 0,
    l: 0,
    a2: 0,
    f2: 0,
    b2: 0,
    c2: 0,
    d2: 0,
    e2: 0,
    h2: 0,
    l2: 0,
    ix: 0,
    iy: 0,
    i: 0,
    r: 0,
    iff1: false,
    iff2: false,
    eiDelay: 0,
    im: 0,
    sp: sp & 0xffff,
    pc: 0,
    halted: false,
  };
}

function u8(n: number): number {
  return n & 0xff;
}
function u16(n: number): number {
  return n & 0xffff;
}
function s8(n: number): number {
  return n & 0x80 ? n - 256 : n;
}

function addrMask(hooks?: SoftMemHooks): number {
  return hooks?.addrBits != null ? (1 << hooks.addrBits) - 1 : 0xffff;
}
function uAddr(n: number, hooks?: SoftMemHooks): number {
  return n & addrMask(hooks);
}

function parity(n: number): boolean {
  let x = n & 0xff;
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return (x & 1) === 0;
}

function setSZP(f: number, n: number): number {
  n = u8(n);
  f = (f & ~(FLAG_S | FLAG_Z | FLAG_P)) | (n & FLAG_S) | (n === 0 ? FLAG_Z : 0) | (parity(n) ? FLAG_P : 0);
  return f;
}

function memRead(ram: Uint8Array, addr: number, hooks?: SoftMemHooks): number {
  addr = uAddr(addr, hooks);
  if (hooks?.memRead) return hooks.memRead(addr) & 0xff;
  const v = (ram[addr] ?? 0) & 0xff;
  const keyData = hooks?.keyDataAddr ?? KEY_DATA;
  const keyStatus = hooks?.keyStatusAddr ?? KEY_STATUS;
  if (hooks?.clearOnReadKeys && addr === keyData) {
    ram[keyStatus] = 0;
  }
  return v;
}

function memWrite(ram: Uint8Array, addr: number, v: number, hooks?: SoftMemHooks): void {
  addr = uAddr(addr, hooks);
  if (hooks?.memWrite) {
    hooks.memWrite(addr, v & 0xff);
    return;
  }
  if (hooks?.romProtect && addr < 0x4000) return;
  ram[addr] = v & 0xff;
}

function read16(ram: Uint8Array, addr: number, hooks?: SoftMemHooks): number {
  return memRead(ram, addr, hooks) | (memRead(ram, uAddr(addr + 1, hooks), hooks) << 8);
}
function write16(ram: Uint8Array, addr: number, v: number, hooks?: SoftMemHooks): void {
  memWrite(ram, addr, v & 0xff, hooks);
  memWrite(ram, uAddr(addr + 1, hooks), (v >> 8) & 0xff, hooks);
}

function getR(cpu: SoftZ80State, r: number, idx: IndexReg = null): number {
  switch (r) {
    case 0:
      return cpu.b;
    case 1:
      return cpu.c;
    case 2:
      return cpu.d;
    case 3:
      return cpu.e;
    case 4:
      if (idx === 'ix') return (cpu.ix >> 8) & 0xff;
      if (idx === 'iy') return (cpu.iy >> 8) & 0xff;
      return cpu.h;
    case 5:
      if (idx === 'ix') return cpu.ix & 0xff;
      if (idx === 'iy') return cpu.iy & 0xff;
      return cpu.l;
    case 7:
      return cpu.a;
    default:
      throw new Error('getR (HL)');
  }
}
function setR(cpu: SoftZ80State, r: number, v: number, idx: IndexReg = null): void {
  v = u8(v);
  switch (r) {
    case 0:
      cpu.b = v;
      break;
    case 1:
      cpu.c = v;
      break;
    case 2:
      cpu.d = v;
      break;
    case 3:
      cpu.e = v;
      break;
    case 4:
      if (idx === 'ix') cpu.ix = (cpu.ix & 0x00ff) | (v << 8);
      else if (idx === 'iy') cpu.iy = (cpu.iy & 0x00ff) | (v << 8);
      else cpu.h = v;
      break;
    case 5:
      if (idx === 'ix') cpu.ix = (cpu.ix & 0xff00) | v;
      else if (idx === 'iy') cpu.iy = (cpu.iy & 0xff00) | v;
      else cpu.l = v;
      break;
    case 7:
      cpu.a = v;
      break;
    default:
      throw new Error('setR (HL)');
  }
}

function hl(cpu: SoftZ80State): number {
  return (cpu.h << 8) | cpu.l;
}
function setHl(cpu: SoftZ80State, v: number): void {
  v = u16(v);
  cpu.h = v >> 8;
  cpu.l = v & 0xff;
}
function bc(cpu: SoftZ80State): number {
  return (cpu.b << 8) | cpu.c;
}
function de(cpu: SoftZ80State): number {
  return (cpu.d << 8) | cpu.e;
}
function setBc(cpu: SoftZ80State, v: number): void {
  v = u16(v);
  cpu.b = v >> 8;
  cpu.c = v & 0xff;
}
function setDe(cpu: SoftZ80State, v: number): void {
  v = u16(v);
  cpu.d = v >> 8;
  cpu.e = v & 0xff;
}

function indexAddr(cpu: SoftZ80State, idx: IndexReg): number {
  if (idx === 'ix') return cpu.ix;
  if (idx === 'iy') return cpu.iy;
  return hl(cpu);
}
function setIndex(cpu: SoftZ80State, idx: IndexReg, v: number): void {
  v = u16(v);
  if (idx === 'ix') cpu.ix = v;
  else if (idx === 'iy') cpu.iy = v;
  else setHl(cpu, v);
}

function push(cpu: SoftZ80State, ram: Uint8Array, v: number, hooks?: SoftMemHooks): void {
  cpu.sp = uAddr(cpu.sp - 2, hooks);
  write16(ram, cpu.sp, v, hooks);
}
function pop(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): number {
  const v = read16(ram, cpu.sp, hooks);
  cpu.sp = uAddr(cpu.sp + 2, hooks);
  return v;
}

function fetch(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): number {
  const b = memRead(ram, cpu.pc, hooks);
  cpu.pc = uAddr(cpu.pc + 1, hooks);
  return b;
}
function fetch16(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): number {
  const lo = fetch(cpu, ram, hooks);
  const hi = fetch(cpu, ram, hooks);
  return lo | (hi << 8);
}

function bumpR(cpu: SoftZ80State): void {
  cpu.r = (cpu.r & 0x80) | ((cpu.r + 1) & 0x7f);
}

function portIn(port: number, hooks?: SoftMemHooks): number {
  if (hooks?.portIn) return hooks.portIn(port) & 0xff;
  return 0xff;
}
function portOut(port: number, val: number, hooks?: SoftMemHooks): void {
  hooks?.portOut?.(port, val & 0xff);
}

function cond(cpu: SoftZ80State, cc: number): boolean {
  const f = cpu.f;
  switch (cc) {
    case 0:
      return (f & FLAG_Z) === 0;
    case 1:
      return (f & FLAG_Z) !== 0;
    case 2:
      return (f & FLAG_C) === 0;
    case 3:
      return (f & FLAG_C) !== 0;
    case 4:
      return (f & FLAG_P) === 0;
    case 5:
      return (f & FLAG_P) !== 0;
    case 6:
      return (f & FLAG_S) === 0;
    case 7:
      return (f & FLAG_S) !== 0;
    default:
      return false;
  }
}

function aluOp(cpu: SoftZ80State, y: number, val: number): void {
  const a = cpu.a;
  let res = 0;
  let f = cpu.f;
  switch (y) {
    case 0: {
      const r = a + val;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xff ? FLAG_C : 0) | (((a & 0xf) + (val & 0xf)) > 0xf ? FLAG_H : 0);
      break;
    }
    case 1: {
      const c = f & FLAG_C ? 1 : 0;
      const r = a + val + c;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xff ? FLAG_C : 0) | (((a & 0xf) + (val & 0xf) + c) > 0xf ? FLAG_H : 0);
      break;
    }
    case 2: {
      const r = a - val;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0) | (((a & 0xf) - (val & 0xf)) < 0 ? FLAG_H : 0);
      break;
    }
    case 3: {
      const c = f & FLAG_C ? 1 : 0;
      const r = a - val - c;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0) | (((a & 0xf) - (val & 0xf) - c) < 0 ? FLAG_H : 0);
      break;
    }
    case 4:
      res = a & val;
      f = (f & ~(FLAG_C | FLAG_N)) | FLAG_H;
      break;
    case 5:
      res = a ^ val;
      f = f & ~(FLAG_C | FLAG_N | FLAG_H);
      break;
    case 6:
      res = a | val;
      f = f & ~(FLAG_C | FLAG_N | FLAG_H);
      break;
    case 7: {
      const r = a - val;
      res = a;
      f = (f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0) | (((a & 0xf) - (val & 0xf)) < 0 ? FLAG_H : 0);
      f = setSZP(f, u8(r));
      cpu.f = f;
      return;
    }
  }
  cpu.a = res;
  cpu.f = setSZP(f, res);
}

function rotOp(op: number, v: number, f: number): { v: number; f: number } {
  const y = (op >> 3) & 7;
  let c = 0;
  let res = 0;
  const oldC = f & FLAG_C ? 1 : 0;
  switch (y) {
    case 0: // RLC
      c = (v >> 7) & 1;
      res = u8((v << 1) | c);
      break;
    case 1: // RRC
      c = v & 1;
      res = u8((v >> 1) | (c << 7));
      break;
    case 2: // RL
      c = (v >> 7) & 1;
      res = u8((v << 1) | oldC);
      break;
    case 3: // RR
      c = v & 1;
      res = u8((v >> 1) | (oldC << 7));
      break;
    case 4: // SLA
      c = (v >> 7) & 1;
      res = u8(v << 1);
      break;
    case 5: // SRA
      c = v & 1;
      res = u8((v >> 1) | (v & 0x80));
      break;
    case 6: // SLL (undocumented)
      c = (v >> 7) & 1;
      res = u8((v << 1) | 1);
      break;
    case 7: // SRL
      c = v & 1;
      res = u8(v >> 1);
      break;
  }
  f = setSZP(f & ~(FLAG_C | FLAG_N | FLAG_H), res);
  f = (f & ~FLAG_C) | (c ? FLAG_C : 0);
  return { v: res, f };
}

function execCb(cpu: SoftZ80State, ram: Uint8Array, op: number, ea: number | null, hooks?: SoftMemHooks): void {
  const z = op & 7;
  const y = (op >> 3) & 7;
  const x = (op >> 6) & 3;
  const val = ea !== null ? memRead(ram, ea, hooks) : getR(cpu, z);

  if (x === 0) {
    const { v, f } = rotOp(op, val, cpu.f);
    cpu.f = f;
    if (ea !== null) memWrite(ram, ea, v, hooks);
    else setR(cpu, z, v);
    return;
  }
  if (x === 1) {
    // BIT y,r
    const bit = (val >> y) & 1;
    let f = cpu.f & FLAG_C;
    f |= FLAG_H;
    f &= ~FLAG_N;
    f = (f & ~(FLAG_Z | FLAG_S | FLAG_P)) | (bit === 0 ? FLAG_Z | FLAG_P : 0) | (y === 7 && bit ? FLAG_S : 0);
    cpu.f = f;
    return;
  }
  if (x === 2) {
    // RES
    const nv = val & ~(1 << y);
    if (ea !== null) memWrite(ram, ea, nv, hooks);
    else setR(cpu, z, nv);
    return;
  }
  // SET
  const nv = val | (1 << y);
  if (ea !== null) memWrite(ram, ea, nv, hooks);
  else setR(cpu, z, nv);
}

function blockLd(cpu: SoftZ80State, ram: Uint8Array, dir: 1 | -1, repeat: boolean, hooks?: SoftMemHooks): void {
  for (;;) {
    const v = memRead(ram, hl(cpu), hooks);
    memWrite(ram, de(cpu), v, hooks);
    setHl(cpu, hl(cpu) + dir);
    setDe(cpu, de(cpu) + dir);
    setBc(cpu, bc(cpu) - 1);
    let f = cpu.f & ~(FLAG_H | FLAG_N | FLAG_P);
    if (bc(cpu) !== 0) f |= FLAG_P;
    cpu.f = f;
    if (!repeat || bc(cpu) === 0) break;
  }
}

function blockCp(cpu: SoftZ80State, ram: Uint8Array, dir: 1 | -1, repeat: boolean, hooks?: SoftMemHooks): void {
  for (;;) {
    const v = memRead(ram, hl(cpu), hooks);
    const r = u8(cpu.a - v);
    setHl(cpu, hl(cpu) + dir);
    setBc(cpu, bc(cpu) - 1);
    let f = (cpu.f & FLAG_C) | FLAG_N;
    f = setSZP(f, r);
    f = (f & ~FLAG_H) | (((cpu.a & 0xf) - (v & 0xf)) < 0 ? FLAG_H : 0);
    f = (f & ~FLAG_P) | (bc(cpu) !== 0 ? FLAG_P : 0);
    cpu.f = f;
    if (!repeat || bc(cpu) === 0 || (f & FLAG_Z)) break;
  }
}

function adcSbcHl(cpu: SoftZ80State, addend: number, adc: boolean): void {
  const c = cpu.f & FLAG_C ? 1 : 0;
  const a = hl(cpu);
  let r: number;
  let f: number;
  if (adc) {
    r = a + addend + c;
    f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xffff ? FLAG_C : 0);
    f = (f & ~FLAG_H) | (((a & 0xfff) + (addend & 0xfff) + c) > 0xfff ? FLAG_H : 0);
  } else {
    r = a - addend - c;
    f = (cpu.f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0);
    f = (f & ~FLAG_H) | (((a & 0xfff) - (addend & 0xfff) - c) < 0 ? FLAG_H : 0);
  }
  const res = u16(r);
  setHl(cpu, res);
  f = (f & ~(FLAG_S | FLAG_Z | FLAG_P)) | (res & 0x8000 ? FLAG_S : 0) | (res === 0 ? FLAG_Z : 0);
  // rough overflow into P
  const overflow = adc
    ? ((a ^ res) & (addend ^ res) & 0x8000) !== 0
    : ((a ^ addend) & (a ^ res) & 0x8000) !== 0;
  f = (f & ~FLAG_P) | (overflow ? FLAG_P : 0);
  cpu.f = f;
}

function execEd(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): void {
  const op = fetch(cpu, ram, hooks);
  bumpR(cpu);

  // IN r,(C) / OUT (C),r — r≠6; also IN A,(C)/OUT (C),A as r=7
  if ((op & 0xc7) === 0x40) {
    const y = (op >> 3) & 7;
    if (y === 6) throw new Error(`soft Z80: ED 0x${op.toString(16)} unsupported`);
    const v = portIn(bc(cpu), hooks);
    setR(cpu, y, v);
    cpu.f = setSZP(cpu.f & ~(FLAG_N | FLAG_H), v);
    return;
  }
  if ((op & 0xc7) === 0x41) {
    const y = (op >> 3) & 7;
    if (y === 6) throw new Error(`soft Z80: ED 0x${op.toString(16)} unsupported`);
    portOut(bc(cpu), getR(cpu, y), hooks);
    return;
  }

  // SBC/ADC HL,rr
  if ((op & 0xcf) === 0x42) {
    const p = (op >> 4) & 3;
    const addend = p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? hl(cpu) : cpu.sp;
    adcSbcHl(cpu, addend, false);
    return;
  }
  if ((op & 0xcf) === 0x4a) {
    const p = (op >> 4) & 3;
    const addend = p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? hl(cpu) : cpu.sp;
    adcSbcHl(cpu, addend, true);
    return;
  }

  // LD (nn),dd / LD dd,(nn)
  if ((op & 0xcf) === 0x43) {
    const nn = fetch16(cpu, ram, hooks);
    const p = (op >> 4) & 3;
    const v = p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? hl(cpu) : cpu.sp;
    write16(ram, nn, v, hooks);
    return;
  }
  if ((op & 0xcf) === 0x4b) {
    const nn = fetch16(cpu, ram, hooks);
    const v = read16(ram, nn, hooks);
    const p = (op >> 4) & 3;
    if (p === 0) setBc(cpu, v);
    else if (p === 1) setDe(cpu, v);
    else if (p === 2) setHl(cpu, v);
    else cpu.sp = v;
    return;
  }

  // NEG (and undocumented aliases)
  if ((op & 0xc7) === 0x44) {
    const a = cpu.a;
    const r = u8(-a);
    cpu.a = r;
    let f = FLAG_N | (a !== 0 ? FLAG_C : 0) | ((a & 0xf) !== 0 ? FLAG_H : 0);
    f = setSZP(f, r);
    f = (f & ~FLAG_P) | (a === 0x80 ? FLAG_P : 0);
    cpu.f = f;
    return;
  }

  // RETN (45/55/65/75) — restore IFF1 from IFF2
  if ((op & 0xc7) === 0x45) {
    cpu.pc = uAddr(pop(cpu, ram, hooks), hooks);
    cpu.iff1 = cpu.iff2;
    return;
  }
  // RETI (4D/5D/6D/7D)
  if ((op & 0xc7) === 0x4d) {
    cpu.pc = uAddr(pop(cpu, ram, hooks), hooks);
    return;
  }

  // IM 0/1/2
  if (op === 0x46 || op === 0x66) {
    cpu.im = 0;
    return;
  }
  if (op === 0x56 || op === 0x76) {
    cpu.im = 1;
    return;
  }
  if (op === 0x5e || op === 0x7e) {
    cpu.im = 2;
    return;
  }

  // LD I,A / LD R,A / LD A,I / LD A,R
  if (op === 0x47) {
    cpu.i = cpu.a;
    return;
  }
  if (op === 0x4f) {
    cpu.r = cpu.a;
    return;
  }
  if (op === 0x57) {
    cpu.a = cpu.i;
    let f = cpu.f & FLAG_C;
    f = setSZP(f, cpu.a);
    f &= ~(FLAG_H | FLAG_N);
    f = (f & ~FLAG_P) | (cpu.iff2 ? FLAG_P : 0);
    cpu.f = f;
    return;
  }
  if (op === 0x5f) {
    cpu.a = cpu.r;
    let f = cpu.f & FLAG_C;
    f = setSZP(f, cpu.a);
    f &= ~(FLAG_H | FLAG_N);
    f = (f & ~FLAG_P) | (cpu.iff2 ? FLAG_P : 0);
    cpu.f = f;
    return;
  }

  // RRD / RLD
  if (op === 0x67) {
    const addr = hl(cpu);
    const m = memRead(ram, addr, hooks);
    const a = cpu.a;
    memWrite(ram, addr, ((a & 0x0f) << 4) | (m >> 4), hooks);
    cpu.a = (a & 0xf0) | (m & 0x0f);
    cpu.f = setSZP(cpu.f & ~(FLAG_H | FLAG_N), cpu.a);
    return;
  }
  if (op === 0x6f) {
    const addr = hl(cpu);
    const m = memRead(ram, addr, hooks);
    const a = cpu.a;
    memWrite(ram, addr, ((m << 4) & 0xf0) | (a & 0x0f), hooks);
    cpu.a = (a & 0xf0) | ((m >> 4) & 0x0f);
    cpu.f = setSZP(cpu.f & ~(FLAG_H | FLAG_N), cpu.a);
    return;
  }

  // Block transfers / compares
  if (op === 0xa0) {
    blockLd(cpu, ram, 1, false, hooks);
    return;
  }
  if (op === 0xa8) {
    blockLd(cpu, ram, -1, false, hooks);
    return;
  }
  if (op === 0xb0) {
    blockLd(cpu, ram, 1, true, hooks);
    return;
  }
  if (op === 0xb8) {
    blockLd(cpu, ram, -1, true, hooks);
    return;
  }
  if (op === 0xa1) {
    blockCp(cpu, ram, 1, false, hooks);
    return;
  }
  if (op === 0xa9) {
    blockCp(cpu, ram, -1, false, hooks);
    return;
  }
  if (op === 0xb1) {
    blockCp(cpu, ram, 1, true, hooks);
    return;
  }
  if (op === 0xb9) {
    blockCp(cpu, ram, -1, true, hooks);
    return;
  }

  throw new Error(`soft Z80: unknown ED opcode 0x${op.toString(16)}`);
}

function needsIndexDisp(op: number): boolean {
  if ((op & 0xc7) === 0x06 && ((op >> 3) & 7) === 6) return true; // LD (HL),n
  if ((op & 0xc0) === 0x40 && op !== 0x76) {
    const y = (op >> 3) & 7;
    const z = op & 7;
    if (y === 6 || z === 6) return true;
  }
  if ((op & 0xc0) === 0x80 && (op & 7) === 6) return true;
  if (((op & 0xc7) === 0x04 || (op & 0xc7) === 0x05) && ((op >> 3) & 7) === 6) return true;
  return false;
}

function execOpcode(
  cpu: SoftZ80State,
  ram: Uint8Array,
  op: number,
  hooks: SoftMemHooks | undefined,
  idx: IndexReg,
): boolean {
  // After DD/FD, CB is handled by caller before this.

  // NOP
  if (op === 0x00) return true;
  if (op === 0x76) {
    if (idx) throw new Error(`soft Z80: HALT after ${idx.toUpperCase()} prefix unsupported`);
    cpu.halted = true;
    return false;
  }

  // Prefixed: index register pair ops that replace HL
  if (idx && (op & 0xcf) === 0x01 && ((op >> 4) & 3) === 2) {
    setIndex(cpu, idx, fetch16(cpu, ram, hooks));
    return true;
  }
  if (idx && op === 0x22) {
    write16(ram, fetch16(cpu, ram, hooks), indexAddr(cpu, idx), hooks);
    return true;
  }
  if (idx && op === 0x2a) {
    setIndex(cpu, idx, read16(ram, fetch16(cpu, ram, hooks), hooks));
    return true;
  }
  if (idx && (op === 0x23 || op === 0x2b)) {
    const d = op === 0x23 ? 1 : -1;
    setIndex(cpu, idx, indexAddr(cpu, idx) + d);
    return true;
  }
  if (idx && (op & 0xcf) === 0x09) {
    const p = (op >> 4) & 3;
    const a = indexAddr(cpu, idx);
    const addend =
      p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? a : cpu.sp;
    const r = a + addend;
    const res = u16(r);
    let f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xffff ? FLAG_C : 0);
    f = (f & ~FLAG_H) | (((a & 0xfff) + (addend & 0xfff)) > 0xfff ? FLAG_H : 0);
    cpu.f = xyFrom(f, res >> 8);
    setIndex(cpu, idx, res);
    return true;
  }
  if (idx && op === 0xf9) {
    cpu.sp = uAddr(indexAddr(cpu, idx), hooks);
    return true;
  }
  if (idx && op === 0xe9) {
    cpu.pc = uAddr(indexAddr(cpu, idx), hooks);
    return true;
  }
  if (idx && (op === 0xe5 || op === 0xe1)) {
    if (op === 0xe5) push(cpu, ram, indexAddr(cpu, idx), hooks);
    else setIndex(cpu, idx, pop(cpu, ram, hooks));
    return true;
  }
  if (idx && op === 0xe3) {
    const t = read16(ram, cpu.sp, hooks);
    write16(ram, cpu.sp, indexAddr(cpu, idx), hooks);
    setIndex(cpu, idx, t);
    return true;
  }

  // Displacement for (IX+d)/(IY+d)
  let ea: number | null = null;
  if (idx && needsIndexDisp(op)) {
    const disp = s8(fetch(cpu, ram, hooks));
    ea = u16(indexAddr(cpu, idx) + disp);
  }

  // Hot path: Z80 x-field jump table. LD (x=1) and ALU (x=2) are the bulk of
  // Spectrum BASIC / game inner loops — two integer compares beat a 200-line if-chain.
  const x = (op >> 6) & 3;
  if (x === 1) {
    if (op === 0x76) {
      if (idx) throw new Error(`soft Z80: HALT after ${idx.toUpperCase()} prefix unsupported`);
      cpu.halted = true;
      return false;
    }
    const y = (op >> 3) & 7;
    const z = op & 7;
    if (idx && (y === 6 || z === 6)) {
      const val = z === 6 ? memRead(ram, ea!, hooks) : getR(cpu, z, null);
      if (y === 6) memWrite(ram, ea!, val, hooks);
      else setR(cpu, y, val, null);
      return true;
    }
    const val = z === 6 ? memRead(ram, hl(cpu), hooks) : getR(cpu, z, idx);
    if (y === 6) memWrite(ram, hl(cpu), val, hooks);
    else setR(cpu, y, val, idx);
    return true;
  }
  if (x === 2) {
    const y = (op >> 3) & 7;
    const z = op & 7;
    const val = z === 6 ? memRead(ram, idx ? ea! : hl(cpu), hooks) : getR(cpu, z, idx);
    aluOp(cpu, y, val);
    return true;
  }

  // ALU A,n
  if ((op & 0xc7) === 0xc6) {
    aluOp(cpu, (op >> 3) & 7, fetch(cpu, ram, hooks));
    return true;
  }

  // LD r,n
  if ((op & 0xc7) === 0x06) {
    const y = (op >> 3) & 7;
    if (idx && y === 6) {
      // LD (IX+d),n — n follows displacement already consumed
      memWrite(ram, ea!, fetch(cpu, ram, hooks), hooks);
      return true;
    }
    const n = fetch(cpu, ram, hooks);
    if (y === 6) memWrite(ram, hl(cpu), n, hooks);
    else setR(cpu, y, n, idx);
    return true;
  }

  // INC/DEC r / (HL)
  if ((op & 0xc7) === 0x04 || (op & 0xc7) === 0x05) {
    const y = (op >> 3) & 7;
    const inc = (op & 0xc7) === 0x04;
    let v = y === 6 ? memRead(ram, idx ? ea! : hl(cpu), hooks) : getR(cpu, y, idx);
    const old = v;
    v = u8(inc ? v + 1 : v - 1);
    if (y === 6) memWrite(ram, idx ? ea! : hl(cpu), v, hooks);
    else setR(cpu, y, v, idx);
    let f = cpu.f & FLAG_C;
    f = setSZP(f, v);
    f = (f & ~FLAG_N) | (inc ? 0 : FLAG_N);
    f = (f & ~FLAG_H) | ((inc ? (old & 0xf) === 0xf : (old & 0xf) === 0) ? FLAG_H : 0);
    cpu.f = f;
    return true;
  }

  // INC/DEC rr (unprefixed HL, or BC/DE/SP always)
  if ((op & 0xcf) === 0x03 || (op & 0xcf) === 0x0b) {
    const p = (op >> 4) & 3;
    const inc = (op & 0xcf) === 0x03;
    const d = inc ? 1 : -1;
    if (p === 0) setBc(cpu, bc(cpu) + d);
    else if (p === 1) setDe(cpu, de(cpu) + d);
    else if (p === 2) {
      if (idx) setIndex(cpu, idx, indexAddr(cpu, idx) + d);
      else setHl(cpu, hl(cpu) + d);
    } else cpu.sp = uAddr(cpu.sp + d, hooks);
    return true;
  }

  // LD rr,nn
  if ((op & 0xcf) === 0x01) {
    const nn = fetch16(cpu, ram, hooks);
    const p = (op >> 4) & 3;
    if (p === 0) setBc(cpu, nn);
    else if (p === 1) setDe(cpu, nn);
    else if (p === 2) {
      if (idx) setIndex(cpu, idx, nn);
      else setHl(cpu, nn);
    } else cpu.sp = uAddr(nn, hooks);
    return true;
  }

  // ADD HL,rr (or ADD IX/IY,rr handled above for idx)
  if ((op & 0xcf) === 0x09) {
    const p = (op >> 4) & 3;
    const a = hl(cpu);
    const addend = p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? a : cpu.sp;
    const r = a + addend;
    const res = u16(r);
    let f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xffff ? FLAG_C : 0);
    f = (f & ~FLAG_H) | (((a & 0xfff) + (addend & 0xfff)) > 0xfff ? FLAG_H : 0);
    cpu.f = xyFrom(f, res >> 8);
    setHl(cpu, res);
    return true;
  }

  // JR e / JR cc,e / DJNZ
  if (op === 0x18 || op === 0x10 || (op & 0xe7) === 0x20) {
    const e = s8(fetch(cpu, ram, hooks));
    let take = op === 0x18;
    if (op === 0x10) {
      cpu.b = u8(cpu.b - 1);
      take = cpu.b !== 0;
    } else if (op !== 0x18) {
      take = cond(cpu, (op >> 3) & 3);
    }
    if (take) cpu.pc = uAddr(cpu.pc + e, hooks);
    return true;
  }

  // JP nn / JP cc,nn
  if (op === 0xc3 || (op & 0xc7) === 0xc2) {
    const nn = fetch16(cpu, ram, hooks);
    if (op === 0xc3 || cond(cpu, (op >> 3) & 7)) cpu.pc = uAddr(nn, hooks);
    return true;
  }

  // CALL nn / CALL cc,nn
  if (op === 0xcd || (op & 0xc7) === 0xc4) {
    const nn = fetch16(cpu, ram, hooks);
    if (op === 0xcd || cond(cpu, (op >> 3) & 7)) {
      push(cpu, ram, cpu.pc, hooks);
      cpu.pc = uAddr(nn, hooks);
    }
    return true;
  }

  // RET / RET cc
  if (op === 0xc9 || (op & 0xc7) === 0xc0) {
    if (op === 0xc9 || cond(cpu, (op >> 3) & 7)) cpu.pc = uAddr(pop(cpu, ram, hooks), hooks);
    return true;
  }

  // PUSH/POP qq
  if ((op & 0xcf) === 0xc5 || (op & 0xcf) === 0xc1) {
    const p = (op >> 4) & 3;
    const isPush = (op & 0xcf) === 0xc5;
    if (isPush) {
      const v =
        p === 0
          ? bc(cpu)
          : p === 1
            ? de(cpu)
            : p === 2
              ? idx
                ? indexAddr(cpu, idx)
                : hl(cpu)
              : (cpu.a << 8) | cpu.f;
      push(cpu, ram, v, hooks);
    } else {
      const v = pop(cpu, ram, hooks);
      if (p === 0) setBc(cpu, v);
      else if (p === 1) setDe(cpu, v);
      else if (p === 2) {
        if (idx) setIndex(cpu, idx, v);
        else setHl(cpu, v);
      } else {
        cpu.a = v >> 8;
        cpu.f = v & 0xff;
      }
    }
    return true;
  }

  // JP (HL)
  if (op === 0xe9) {
    cpu.pc = uAddr(hl(cpu), hooks);
    return true;
  }
  // LD SP,HL
  if (op === 0xf9) {
    cpu.sp = uAddr(hl(cpu), hooks);
    return true;
  }
  // EX DE,HL
  if (op === 0xeb) {
    const t = de(cpu);
    setDe(cpu, hl(cpu));
    setHl(cpu, t);
    return true;
  }
  // EX (SP),HL
  if (op === 0xe3) {
    const t = read16(ram, cpu.sp, hooks);
    write16(ram, cpu.sp, hl(cpu), hooks);
    setHl(cpu, t);
    return true;
  }
  // EXX
  if (op === 0xd9) {
    let t = cpu.b;
    cpu.b = cpu.b2;
    cpu.b2 = t;
    t = cpu.c;
    cpu.c = cpu.c2;
    cpu.c2 = t;
    t = cpu.d;
    cpu.d = cpu.d2;
    cpu.d2 = t;
    t = cpu.e;
    cpu.e = cpu.e2;
    cpu.e2 = t;
    t = cpu.h;
    cpu.h = cpu.h2;
    cpu.h2 = t;
    t = cpu.l;
    cpu.l = cpu.l2;
    cpu.l2 = t;
    return true;
  }
  // EX AF,AF'
  if (op === 0x08) {
    const ta = cpu.a;
    const tf = cpu.f;
    cpu.a = cpu.a2;
    cpu.f = cpu.f2;
    cpu.a2 = ta;
    cpu.f2 = tf;
    return true;
  }
  // DI / EI — EI enables IFF only after the *next* instruction completes.
  if (op === 0xf3) {
    cpu.iff1 = false;
    cpu.iff2 = false;
    cpu.eiDelay = 0;
    return true;
  }
  if (op === 0xfb) {
    cpu.eiDelay = 2;
    return true;
  }

  // LD A,(BC)/(DE) / LD (BC)/(DE),A
  if (op === 0x0a) {
    cpu.a = memRead(ram, bc(cpu), hooks);
    return true;
  }
  if (op === 0x1a) {
    cpu.a = memRead(ram, de(cpu), hooks);
    return true;
  }
  if (op === 0x02) {
    memWrite(ram, bc(cpu), cpu.a, hooks);
    return true;
  }
  if (op === 0x12) {
    memWrite(ram, de(cpu), cpu.a, hooks);
    return true;
  }

  // LD A,(nn) / LD (nn),A
  if (op === 0x3a) {
    cpu.a = memRead(ram, fetch16(cpu, ram, hooks), hooks);
    return true;
  }
  if (op === 0x32) {
    memWrite(ram, fetch16(cpu, ram, hooks), cpu.a, hooks);
    return true;
  }
  // LD HL,(nn) / LD (nn),HL
  if (op === 0x2a) {
    setHl(cpu, read16(ram, fetch16(cpu, ram, hooks), hooks));
    return true;
  }
  if (op === 0x22) {
    write16(ram, fetch16(cpu, ram, hooks), hl(cpu), hooks);
    return true;
  }

  // RRCA / RLCA / RRA / RLA — H/N cleared; X/Y from A after rotate; S/Z/P hold
  if (op === 0x0f) {
    const c = cpu.a & 1;
    cpu.a = u8((cpu.a >> 1) | (c << 7));
    cpu.f = xyFrom((cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0), cpu.a);
    return true;
  }
  if (op === 0x07) {
    const c = (cpu.a >> 7) & 1;
    cpu.a = u8((cpu.a << 1) | c);
    cpu.f = xyFrom((cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0), cpu.a);
    return true;
  }
  if (op === 0x1f) {
    const c = cpu.a & 1;
    const oldC = cpu.f & FLAG_C ? 1 : 0;
    cpu.a = u8((cpu.a >> 1) | (oldC << 7));
    cpu.f = xyFrom((cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0), cpu.a);
    return true;
  }
  if (op === 0x17) {
    const c = (cpu.a >> 7) & 1;
    const oldC = cpu.f & FLAG_C ? 1 : 0;
    cpu.a = u8((cpu.a << 1) | oldC);
    cpu.f = xyFrom((cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0), cpu.a);
    return true;
  }

  // SCF / CCF / CPL / DAA — X/Y from A (after ~ for CPL; unchanged for SCF/CCF)
  if (op === 0x37) {
    cpu.f = xyFrom((cpu.f & ~(FLAG_N | FLAG_H)) | FLAG_C, cpu.a);
    return true;
  }
  if (op === 0x3f) {
    // H ← old C before toggle; N ← 0; C ← ~C
    const oldC = cpu.f & FLAG_C;
    cpu.f = xyFrom((cpu.f & ~(FLAG_N | FLAG_H | FLAG_C)) | (oldC ? FLAG_H : 0) | (oldC ? 0 : FLAG_C), cpu.a);
    return true;
  }
  if (op === 0x2f) {
    cpu.a = u8(~cpu.a);
    cpu.f = xyFrom(cpu.f | FLAG_N | FLAG_H, cpu.a);
    return true;
  }
  if (op === 0x27) return true;

  // RST
  if ((op & 0xc7) === 0xc7) {
    push(cpu, ram, cpu.pc, hooks);
    cpu.pc = uAddr(op & 0x38, hooks);
    return true;
  }

  // IN A,(n) / OUT (n),A
  if (op === 0xdb) {
    const n = fetch(cpu, ram, hooks);
    const port = (cpu.a << 8) | n;
    if (hooks?.portInBlock?.(port)) {
      // Blocking device (z80pack CONDAT): re-execute IN until data ready.
      cpu.pc = uAddr(cpu.pc - 2, hooks);
      return true;
    }
    cpu.a = portIn(port, hooks);
    return true;
  }
  if (op === 0xd3) {
    const n = fetch(cpu, ram, hooks);
    portOut((cpu.a << 8) | n, cpu.a, hooks);
    return true;
  }

  if (idx) {
    throw new Error(
      `soft Z80: unsupported ${idx.toUpperCase()} opcode 0x${op.toString(16)} — use gate Step`,
    );
  }
  throw new Error(`soft Z80: unimplemented opcode 0x${op.toString(16)} at PC`);
}

/**
 * Dispatch one opcode byte (after fetch / IM0 bus sample). Shared by softStep
 * and softAcceptIrq IM0. Returns false only for HALT (softStep parity).
 */
function softExecOp(
  cpu: SoftZ80State,
  ram: Uint8Array,
  op: number,
  hooks?: SoftMemHooks,
): boolean {
  if (op === 0xcb) {
    const cb = fetch(cpu, ram, hooks);
    bumpR(cpu);
    const z = cb & 7;
    const ea = z === 6 ? hl(cpu) : null;
    execCb(cpu, ram, cb, ea, hooks);
    return true;
  }
  if (op === 0xed) {
    execEd(cpu, ram, hooks);
    return true;
  }
  if (op === 0xdd || op === 0xfd) {
    const idx: IndexReg = op === 0xdd ? 'ix' : 'iy';
    const nop = fetch(cpu, ram, hooks);
    bumpR(cpu);

    if (nop === 0xcb) {
      const d = s8(fetch(cpu, ram, hooks));
      const cb = fetch(cpu, ram, hooks);
      const ea = u16(indexAddr(cpu, idx) + d);
      if ((cb & 7) !== 6) {
        throw new Error(
          `soft Z80: ${idx.toUpperCase()} CB 0x${cb.toString(16)} non-(I${idx === 'ix' ? 'X' : 'Y'}+d) unsupported`,
        );
      }
      execCb(cpu, ram, cb, ea, hooks);
      return true;
    }
    if (nop === 0xdd || nop === 0xfd || nop === 0xed) {
      throw new Error(
        `soft Z80: nested prefix 0x${op.toString(16)} 0x${nop.toString(16)} unsupported`,
      );
    }
    return execOpcode(cpu, ram, nop, hooks, idx);
  }
  return execOpcode(cpu, ram, op, hooks, null);
}

/**
 * Accept a pending maskable IRQ.
 * IM 0 → execute irqBusByte as an opcode (after push); IM 1 → RST 38H;
 * IM 2 → word at (I<<8 | busByte), Spectrum bus defaults to 0xFF.
 * Leaves pending uncleared when IFF1 is off, EI delay, or unsupported mode.
 */
export function softAcceptIrq(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): boolean {
  if (!hooks?.irqPending?.()) return false;
  if (!cpu.iff1 || cpu.eiDelay > 0) return false;
  if (cpu.im !== 0 && cpu.im !== 1 && cpu.im !== 2) return false;
  cpu.halted = false;
  cpu.iff1 = false;
  cpu.iff2 = false;
  // INTACK: one R bump (M1 acknowledge) + Spectrum-style ~2 wait states, then push.
  bumpR(cpu);
  hooks?.intAckWaits?.(4);
  push(cpu, ram, cpu.pc, hooks);
  if (cpu.im === 1) {
    cpu.pc = uAddr(0x0038, hooks);
  } else if (cpu.im === 2) {
    const bus = (hooks.irqBusByte?.() ?? 0xff) & 0xff;
    const vec = uAddr(((cpu.i & 0xff) << 8) | bus, hooks);
    const lo = memRead(ram, vec, hooks);
    const hi = memRead(ram, (vec + 1) & 0xffff, hooks);
    cpu.pc = uAddr(lo | (hi << 8), hooks);
  } else {
    // IM 0: sample data bus as an inserted opcode (R already bumped above).
    const op = (hooks.irqBusByte?.() ?? 0xff) & 0xff;
    softExecOp(cpu, ram, op, hooks);
  }
  hooks.clearIrq?.();
  return true;
}

/**
 * Non-maskable interrupt: push PC, clear IFF1 (keep IFF2), jump to $0066.
 * Used by Spectrum Multiface / soft NMI button.
 */
export function softNmi(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): void {
  cpu.halted = false;
  cpu.iff1 = false;
  push(cpu, ram, cpu.pc, hooks);
  cpu.pc = uAddr(0x0066, hooks);
}

/** Execute one instruction. Returns false if halted / unsupported. */
export function softStep(cpu: SoftZ80State, ram: Uint8Array, hooks?: SoftMemHooks): boolean {
  if (softAcceptIrq(cpu, ram, hooks)) return true;
  if (cpu.halted) return false;
  if (hooks?.hostTrap?.(cpu, ram)) return true;
  const op = fetch(cpu, ram, hooks);
  bumpR(cpu);
  const ok = softExecOp(cpu, ram, op, hooks);

  // EI delay: countdown hits 0 after the instruction that *followed* EI.
  if (cpu.eiDelay > 0) {
    cpu.eiDelay -= 1;
    if (cpu.eiDelay === 0) {
      cpu.iff1 = true;
      cpu.iff2 = true;
    }
  }
  return ok;
}

/**
 * Run up to `max` instructions or until halted (wakes on pending IRQ).
 * Optional `breakPc`: stop *before* executing that PC (returns early; caller freezes Run).
 */
export function softRun(
  cpu: SoftZ80State,
  ram: Uint8Array,
  max: number,
  hooks?: SoftMemHooks,
  breakPc?: number | null,
): number {
  let n = 0;
  const prog = hooks?.progress;
  if (prog) {
    prog.n = 0;
    prog.max = Math.max(1, max);
  }
  const irqPending = hooks?.irqPending;
  while (n < max) {
    if (breakPc != null && (cpu.pc & 0xffff) === (breakPc & 0xffff)) break;
    if (cpu.halted && !(irqPending?.() && cpu.iff1 && cpu.eiDelay === 0)) break;
    if (prog) prog.n = n;
    softStep(cpu, ram, hooks);
    n++;
  }
  return n;
}
