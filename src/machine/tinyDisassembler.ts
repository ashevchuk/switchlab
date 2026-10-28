import type { DisasmLine } from './disassembler.js';

const OPERAND_MASK = 0x1f;
const JMP_TARGET_MASK = 0x0f;
const JMP_OR_OUT_BIT = 0x10;
const OPERAND_MNEMONICS = ['LDI', 'ADI', 'ANI', 'ORI', 'XRI', 'STORE', 'LOAD'] as const;
const EXT_SLOT = 7;

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

function mnemonic(opcode: number): string {
  const slot = opcode >> 5;
  if (slot !== EXT_SLOT) return `${OPERAND_MNEMONICS[slot]} ${hex2(opcode & OPERAND_MASK)}`;
  return opcode & JMP_OR_OUT_BIT ? 'OUT' : `JMP ${hex2(opcode & JMP_TARGET_MASK)}`;
}

/** Disassembler for the Tiny CPU's one-byte instruction set (see buildMinimalCpu). */
export function disassembleTiny(bytes: Uint8Array, addr: number, count: number): DisasmLine[] {
  const lines: DisasmLine[] = [];
  for (let a = Math.max(0, addr); a < bytes.length && lines.length < count; a++) {
    lines.push({ addr: a, size: 1, bytes: [bytes[a]!], text: mnemonic(bytes[a]!) });
  }
  return lines;
}
