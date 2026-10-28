import type { AssembleResult } from './assembler.js';
import { EXT_SLOT, JMP_OR_OUT_BIT, JMP_TARGET_MASK, OPCODE_SLOT_SHIFT, OPERAND_MASK, OPERAND_MNEMONICS } from './tinyIsa.js';

interface SourceLine {
  lineNo: number;
  mnemonic: string;
  operand: string | undefined;
}

const LABEL = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;
const NUMBER = /^(0x[0-9a-f]+|\d+)$/i;

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Assembler for the Tiny CPU: `LDI 1`, `OUT`, `loop: JMP loop`, `; comments`. */
export function assembleTiny(source: string, origin = 0): AssembleResult {
  const errors: string[] = [];
  const labels = new Map<string, number>();
  const lines: SourceLine[] = [];

  source.split('\n').forEach((raw, i) => {
    const lineNo = i + 1;
    let text = raw.replace(/;.*$/, '').trim();
    const label = LABEL.exec(text);
    if (label) {
      if (labels.has(label[1]!)) errors.push(`line ${lineNo}: duplicate label ${label[1]}`);
      labels.set(label[1]!, origin + lines.length);
      text = label[2]!.trim();
    }
    if (text === '') return;
    const [mnemonic, operand, extra] = text.split(/\s+/);
    if (extra !== undefined) errors.push(`line ${lineNo}: too many operands`);
    lines.push({ lineNo, mnemonic: mnemonic!.toUpperCase(), operand });
  });

  const resolve = (line: SourceLine, max: number): number | null => {
    if (line.operand === undefined) {
      errors.push(`line ${line.lineNo}: ${line.mnemonic} needs an operand`);
      return null;
    }
    const value = NUMBER.test(line.operand) ? Number(line.operand) : labels.get(line.operand);
    if (value === undefined) {
      errors.push(`line ${line.lineNo}: unknown label ${line.operand}`);
      return null;
    }
    if (value > max) {
      errors.push(`line ${line.lineNo}: ${line.operand} is out of range (max ${max})`);
      return null;
    }
    return value;
  };

  const bytes: number[] = [];
  const listing: string[] = [];
  lines.forEach((line, i) => {
    let opcode: number | null = null;
    const slot = OPERAND_MNEMONICS.indexOf(line.mnemonic as (typeof OPERAND_MNEMONICS)[number]);
    if (slot >= 0) {
      const operand = resolve(line, OPERAND_MASK);
      if (operand !== null) opcode = (slot << OPCODE_SLOT_SHIFT) | operand;
    } else if (line.mnemonic === 'JMP') {
      const target = resolve(line, JMP_TARGET_MASK);
      if (target !== null) opcode = (EXT_SLOT << OPCODE_SLOT_SHIFT) | target;
    } else if (line.mnemonic === 'OUT') {
      if (line.operand !== undefined) errors.push(`line ${line.lineNo}: OUT takes no operand`);
      else opcode = (EXT_SLOT << OPCODE_SLOT_SHIFT) | JMP_OR_OUT_BIT;
    } else {
      errors.push(`line ${line.lineNo}: unknown mnemonic ${line.mnemonic}`);
    }
    bytes.push(opcode ?? 0);
    listing.push(`${hex2(origin + i).padStart(4, '0')}  ${hex2(opcode ?? 0)}  ${line.mnemonic}${line.operand === undefined ? '' : ` ${line.operand}`}`);
  });

  return { ok: errors.length === 0, bytes: Uint8Array.from(bytes), errors, listing, origin };
}
