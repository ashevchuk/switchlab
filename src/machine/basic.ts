/**
 * Minimal BASIC → Z80 bytes for Load @ / softRun.
 *
 * Supported:
 *   line numbers, LET var=expr, PRINT items, GOTO n, END, REM
 *   IF cond THEN line  (cond: var op expr; op = <> < > <= >=)
 *   FOR var=a TO b / NEXT [var]  (nested; NEXT alone closes innermost)
 *   GOSUB n / RETURN
 *   CLS — clear text FB and reset PRINT cursor
 *   INPUT var — busy-wait KEY_STATUS / KEY_DATA (0xF00 / 0xF01)
 *   expr: + - * / with * / binding tighter; atoms = number | var
 *
 * Vars A–Z live at 0xC00 + (ord - 'A').
 * FOR TO limits are saved at FOR_LIMIT_BASE + nesting depth (0xBD0…).
 * PRINT_CURSOR at 0xBFE/0xBFF is a little-endian pointer into the text FB
 * (FB_BASE = 0xE00). The compiled program prefix initializes it once; each
 * PRINT item loads HL from the cursor, writes, INC HL, stores the cursor back
 * (so skipped PRINT under untaken IF does not reserve FB cells).
 * PRINT separators: `;` no space, `,` one space (tab-ish).
 * PRINT items may be strings, vars, or expressions (result byte written to FB).
 */

import { FB_BASE, KEY_DATA, KEY_STATUS, type SoftIoLayout } from './memoryMap.js';

/** The I/O addresses the compiled code touches; they differ between the 12-bit and 64K machine maps. */
export type BasicIo = Pick<SoftIoLayout, 'fbBase' | 'keyStatus' | 'keyData'>;

const DEFAULT_IO: BasicIo = { fbBase: FB_BASE, keyStatus: KEY_STATUS, keyData: KEY_DATA };

const VAR_BASE = 0xc00;
/** Little-endian FB write cursor (word). */
const PRINT_CURSOR = 0xbfe;
/** Per-nesting-depth storage for FOR TO limits (one byte each). */
const FOR_LIMIT_BASE = 0xbd0;
/** LD HL,FB_BASE / LD (PRINT_CURSOR),HL */
const PREFIX_SIZE = 6;

/** `io` defaults to the 12-bit machine map; a 64K machine passes its own layout (softIoLayoutForRam). */
export function compileBasic(source: string, origin = 0x200, io: BasicIo = DEFAULT_IO): Uint8Array {
  const lines = parseLines(source);
  if (lines.length === 0) return new Uint8Array(0);

  const sizes = lines.map((ln) => measureStmt(ln.stmt, io));
  const addrOf = new Map<number, number>();
  let pc = (origin + PREFIX_SIZE) & 0xffff;
  for (let i = 0; i < lines.length; i++) {
    addrOf.set(lines[i]!.num, pc);
    pc = (pc + sizes[i]!) & 0xffff;
  }

  const out: number[] = [];
  emitPrintCursorInit(out, io);
  const forStack: ForFrame[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const nextLineAddr =
      i + 1 < lines.length
        ? addrOf.get(lines[i + 1]!.num)!
        : (origin + PREFIX_SIZE + sizes.reduce((a, b) => a + b, 0)) & 0xffff;
    emitStmt(ln.stmt, out, addrOf, false, forStack, nextLineAddr, io);
  }
  if (forStack.length > 0) throw new Error('BASIC: FOR without NEXT');
  return Uint8Array.from(out);
}

interface BasicLine {
  num: number;
  stmt: string;
}

interface ForFrame {
  varName: string;
  limitAddr: number;
  loopAddr: number;
}

function parseLines(source: string): BasicLine[] {
  const lines: BasicLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    // Comments are REM only — do not strip `;` (PRINT uses it as a separator).
    const t = raw.trim();
    if (!t) continue;
    const m = /^(\d+)\s+(.+)$/.exec(t);
    if (!m) throw new Error(`BASIC: expected "N stmt", got "${t}"`);
    lines.push({ num: Number(m[1]), stmt: m[2]!.trim() });
  }
  lines.sort((a, b) => a.num - b.num);
  return lines;
}

function varAddr(name: string): number {
  const u = name.toUpperCase();
  if (!/^[A-Z]$/.test(u)) throw new Error(`BASIC: bad var '${name}'`);
  return VAR_BASE + (u.charCodeAt(0) - 0x41);
}

function emitPrintCursorInit(out: number[], io: BasicIo): void {
  out.push(0x21, io.fbBase & 0xff, (io.fbBase >> 8) & 0xff); // LD HL,fbBase
  out.push(0x22, PRINT_CURSOR & 0xff, (PRINT_CURSOR >> 8) & 0xff); // LD (PRINT_CURSOR),HL
}

function measureStmt(stmt: string, io: BasicIo): number {
  const buf: number[] = [];
  emitStmt(stmt, buf, new Map(), true, [], 0, io);
  return buf.length;
}

function emitStmt(
  stmt: string,
  out: number[],
  addrOf: Map<number, number>,
  measuring = false,
  forStack: ForFrame[] = [],
  nextLineAddr = 0,
  io: BasicIo = DEFAULT_IO,
): void {
  const u = stmt.toUpperCase();

  if (u === 'END') {
    out.push(0x76);
    return;
  }

  if (u.startsWith('REM')) return;

  if (u === 'CLS' || u.startsWith('CLS ')) {
    emitCls(out, io);
    return;
  }

  if (u === 'RETURN') {
    out.push(0xc9); // RET
    return;
  }

  if (u.startsWith('GOSUB')) {
    const n = Number(stmt.slice(5).trim());
    if (!Number.isFinite(n)) throw new Error(`BASIC: bad GOSUB '${stmt}'`);
    const tgt = measuring ? 0 : addrOf.get(n);
    if (tgt === undefined) throw new Error(`BASIC: GOSUB ${n} — missing line`);
    out.push(0xcd, tgt & 0xff, (tgt >> 8) & 0xff); // CALL tgt
    return;
  }

  if (u.startsWith('GOTO')) {
    const n = Number(stmt.slice(4).trim());
    if (!Number.isFinite(n)) throw new Error(`BASIC: bad GOTO '${stmt}'`);
    const tgt = measuring ? 0 : addrOf.get(n);
    if (tgt === undefined) throw new Error(`BASIC: GOTO ${n} — missing line`);
    out.push(0xc3, tgt & 0xff, (tgt >> 8) & 0xff);
    return;
  }

  if (u.startsWith('LET')) {
    const body = stmt.slice(3).trim();
    const eq = body.indexOf('=');
    if (eq < 0) throw new Error(`BASIC: LET needs '='`);
    const v = body.slice(0, eq).trim();
    const expr = body.slice(eq + 1).trim();
    const dest = varAddr(v);
    emitExprToA(expr, out);
    out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
    return;
  }

  if (u.startsWith('IF')) {
    emitIf(stmt, out, addrOf, measuring);
    return;
  }

  if (u.startsWith('FOR')) {
    emitFor(stmt, out, forStack, nextLineAddr, measuring);
    return;
  }

  if (u.startsWith('NEXT')) {
    emitNext(stmt, out, forStack, measuring);
    return;
  }

  if (u.startsWith('INPUT')) {
    emitInput(stmt.slice(5).trim(), out, io);
    return;
  }

  if (u.startsWith('PRINT')) {
    emitPrint(stmt.slice(5).trim(), out);
    return;
  }

  throw new Error(`BASIC: unsupported '${stmt}'`);
}

/** Clear FB with spaces (256 cells via DJNZ B=0) and reset PRINT_CURSOR. */
function emitCls(out: number[], io: BasicIo): void {
  out.push(0x21, io.fbBase & 0xff, (io.fbBase >> 8) & 0xff); // LD HL,fbBase
  out.push(0x06, 0x00); // LD B,0 → 256 iters
  out.push(0x3e, 0x20); // LD A,' '
  out.push(0x77, 0x23, 0x10, 0xfc); // LD (HL),A / INC HL / DJNZ
  out.push(0x21, io.fbBase & 0xff, (io.fbBase >> 8) & 0xff);
  out.push(0x22, PRINT_CURSOR & 0xff, (PRINT_CURSOR >> 8) & 0xff);
}

/** IF var op expr THEN line */
function emitIf(stmt: string, out: number[], addrOf: Map<number, number>, measuring: boolean): void {
  const m = /^IF\s+(.+?)\s+THEN\s+(\d+)\s*$/i.exec(stmt);
  if (!m) throw new Error(`BASIC: bad IF '${stmt}'`);
  const cmp = parseCond(m[1]!.trim());
  const thenLine = Number(m[2]);
  const tgt = measuring ? 0 : addrOf.get(thenLine);
  if (tgt === undefined) throw new Error(`BASIC: IF THEN ${thenLine} — missing line`);

  emitExprToA(cmp.rhs, out);
  out.push(0x47); // LD B,A
  const addr = varAddr(cmp.varName);
  out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff); // LD A,(var)
  out.push(0xb8); // CP B

  switch (cmp.op) {
    case '=':
      out.push(0xca, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    case '<>':
      out.push(0xc2, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    case '<':
      out.push(0xda, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    case '>=':
      out.push(0xd2, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    case '<=':
      out.push(0xca, tgt & 0xff, (tgt >> 8) & 0xff);
      out.push(0xda, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    case '>':
      out.push(0x28, 5);
      out.push(0x38, 3);
      out.push(0xc3, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    default:
      throw new Error(`BASIC: bad IF op '${cmp.op}'`);
  }
}

function parseCond(cond: string): { varName: string; op: string; rhs: string } {
  const m = /^([A-Za-z])\s*(<>|<=|>=|=|<|>)\s*(.+)$/.exec(cond.trim());
  if (!m) throw new Error(`BASIC: bad IF condition '${cond}'`);
  return { varName: m[1]!, op: m[2]!, rhs: m[3]!.trim() };
}

function emitFor(
  stmt: string,
  out: number[],
  forStack: ForFrame[],
  nextLineAddr: number,
  measuring: boolean,
): void {
  const m = /^FOR\s+([A-Za-z])\s*=\s*(.+?)\s+TO\s+(.+)$/i.exec(stmt.trim());
  if (!m) throw new Error(`BASIC: bad FOR '${stmt}'`);
  const varName = m[1]!;
  const dest = varAddr(varName);
  const limitAddr = (FOR_LIMIT_BASE + forStack.length) & 0xffff;
  emitExprToA(m[2]!.trim(), out);
  out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
  emitExprToA(m[3]!.trim(), out);
  out.push(0x32, limitAddr & 0xff, (limitAddr >> 8) & 0xff);
  if (!measuring) {
    forStack.push({
      varName: varName.toUpperCase(),
      limitAddr,
      loopAddr: nextLineAddr,
    });
  }
}

function emitNext(stmt: string, out: number[], forStack: ForFrame[], measuring: boolean): void {
  const m = /^NEXT(?:\s+([A-Za-z]))?\s*$/i.exec(stmt.trim());
  if (!m) throw new Error(`BASIC: bad NEXT '${stmt}'`);
  let varName = (m[1] ?? 'A').toUpperCase();
  let loopAddr = 0;
  let limitAddr = 0;
  if (!measuring) {
    if (forStack.length === 0) throw new Error('BASIC: NEXT without FOR');
    if (m[1]) {
      const want = m[1]!.toUpperCase();
      let idx = -1;
      for (let i = forStack.length - 1; i >= 0; i--) {
        if (forStack[i]!.varName === want) {
          idx = i;
          break;
        }
      }
      if (idx < 0) throw new Error(`BASIC: NEXT ${want} without matching FOR`);
      const fr = forStack[idx]!;
      varName = fr.varName;
      loopAddr = fr.loopAddr;
      limitAddr = fr.limitAddr;
      forStack.length = idx;
    } else {
      const fr = forStack.pop()!;
      varName = fr.varName;
      loopAddr = fr.loopAddr;
      limitAddr = fr.limitAddr;
    }
  }
  const dest = varAddr(varName);
  out.push(0x3a, dest & 0xff, (dest >> 8) & 0xff);
  out.push(0x21, limitAddr & 0xff, (limitAddr >> 8) & 0xff);
  out.push(0xbe);
  out.push(0x28, 7);
  out.push(0x3c);
  out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
  out.push(0xc3, loopAddr & 0xff, (loopAddr >> 8) & 0xff);
}

function emitInput(varName: string, out: number[], io: BasicIo): void {
  const v = varName.trim();
  if (!/^[A-Za-z]$/.test(v)) throw new Error(`BASIC: INPUT expects var`);
  const dest = varAddr(v);
  out.push(0x3a, io.keyStatus & 0xff, (io.keyStatus >> 8) & 0xff);
  out.push(0xb7);
  out.push(0x28, 0xfa);
  out.push(0x3a, io.keyData & 0xff, (io.keyData >> 8) & 0xff);
  out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
}

function emitPrint(arg: string, out: number[]): void {
  if (!arg) return;
  const curLo = PRINT_CURSOR & 0xff;
  const curHi = (PRINT_CURSOR >> 8) & 0xff;
  for (const item of splitPrintItems(arg)) {
    if (item.kind === 'space') {
      out.push(0x2a, curLo, curHi);
      out.push(0x3e, 0x20);
      out.push(0x77);
      out.push(0x23);
      out.push(0x22, curLo, curHi);
      continue;
    }
    if (item.kind === 'str') {
      if (item.value.length === 0) continue;
      out.push(0x2a, curLo, curHi);
      for (let i = 0; i < item.value.length; i++) {
        out.push(0x3e, item.value.charCodeAt(i) & 0xff);
        out.push(0x77);
        out.push(0x23);
      }
      out.push(0x22, curLo, curHi);
      continue;
    }
    emitExprToA(item.value, out);
    out.push(0x2a, curLo, curHi);
    out.push(0x77);
    out.push(0x23);
    out.push(0x22, curLo, curHi);
  }
}

type PrintItem =
  | { kind: 'str'; value: string }
  | { kind: 'expr'; value: string }
  | { kind: 'space' };

function splitPrintItems(arg: string): PrintItem[] {
  const items: PrintItem[] = [];
  const pushExpr = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith('"')) {
      items.push({ kind: 'str', value: parseStringOnly(t) });
      return;
    }
    items.push({ kind: 'expr', value: t });
  };

  let cur = '';
  let inStr = false;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]!;
    if (c === '"') {
      inStr = !inStr;
      cur += c;
      continue;
    }
    if (!inStr && (c === ';' || c === ',')) {
      pushExpr(cur);
      cur = '';
      if (c === ',') items.push({ kind: 'space' });
      continue;
    }
    cur += c;
  }
  pushExpr(cur);
  return items;
}

function parseStringOnly(arg: string): string {
  if (!arg.startsWith('"')) throw new Error('BASIC: expected string');
  let end = 1;
  while (end < arg.length && arg[end] !== '"') end++;
  if (arg[end] !== '"') throw new Error('BASIC: unterminated string');
  const rest = arg.slice(end + 1).trim();
  if (rest !== '') throw new Error(`BASIC: junk after string: ${rest}`);
  return arg.slice(1, end);
}

function emitAtomToA(atom: string, out: number[]): void {
  const t = atom.trim();
  if (/^[A-Za-z]$/.test(t)) {
    const addr = varAddr(t);
    out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff);
    return;
  }
  const n = parseNumber(t);
  out.push(0x3e, n & 0xff);
}

type ExprTok = { kind: 'num' | 'var' | 'op'; value: string };

function tokenizeExpr(s: string): ExprTok[] {
  const out: ExprTok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ('+-*/'.includes(c)) {
      out.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      out.push({ kind: 'var', value: c });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9a-fA-FxXh]/.test(s[j]!)) j++;
      out.push({ kind: 'num', value: s.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`BASIC: bad expr char '${c}' in '${s}'`);
  }
  return out;
}

/** Emit expr into A. Precedence: * / over + -; left-associative. Uses B,C scratch. */
function emitExprToA(expr: string, out: number[]): void {
  const tokens = tokenizeExpr(expr.trim());
  if (tokens.length === 0) throw new Error('BASIC: empty expr');
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];

  const parseFactor = (): void => {
    const t = take();
    if (!t || t.kind === 'op') throw new Error('BASIC: expected value in expression');
    emitAtomToA(t.value, out);
  };

  const parseTerm = (): void => {
    parseFactor();
    while (peek()?.kind === 'op' && (peek()!.value === '*' || peek()!.value === '/')) {
      const op = take()!.value;
      out.push(0x47); // LD B,A
      parseFactor();
      if (op === '*') emitMulLeftBRightA(out);
      else emitDivLeftBRightA(out);
    }
  };

  const parseExpr = (): void => {
    parseTerm();
    while (peek()?.kind === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = take()!.value;
      out.push(0x47); // LD B,A
      parseTerm();
      if (op === '+') {
        out.push(0x80); // ADD A,B
      } else {
        out.push(0x4f); // LD C,A
        out.push(0x78); // LD A,B
        out.push(0x91); // SUB C
      }
    }
  };

  parseExpr();
  if (i !== tokens.length) throw new Error('BASIC: junk in expression');
}

/** A = B * A (unsigned 8-bit). Clobbers C. */
function emitMulLeftBRightA(out: number[]): void {
  out.push(0x4f); // LD C,A
  out.push(0xaf); // XOR A
  out.push(0xb1); // OR C
  out.push(0x28, 5); // JR Z,+5 → done (A=0)
  out.push(0xaf); // XOR A
  out.push(0x80); // ADD A,B
  out.push(0x0d); // DEC C
  out.push(0x20, 0xfc); // JR NZ,-4 → ADD
}

/** A = B / A. Divisor 0 → 0. Clobbers B,C. */
function emitDivLeftBRightA(out: number[]): void {
  out.push(0x4f); // LD C,A
  out.push(0xaf); // XOR A
  out.push(0xb1); // OR C
  out.push(0x28, 11); // JR Z,+11 → done (A=0)
  out.push(0x78); // LD A,B
  out.push(0x06, 0x00); // LD B,0
  out.push(0xb9); // CP C
  out.push(0x38, 4); // JR C,+4 → LD A,B
  out.push(0x91); // SUB C
  out.push(0x04); // INC B
  out.push(0x18, 0xf9); // JR -7 → CP C
  out.push(0x78); // LD A,B
}

function parseNumber(s: string): number {
  const t = s.trim().toLowerCase();
  let n: number;
  if (t.startsWith('0x')) n = parseInt(t, 16);
  else if (t.endsWith('h')) n = parseInt(t.slice(0, -1), 16);
  else n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) throw new Error(`BASIC: bad number '${s}'`);
  return n;
}
