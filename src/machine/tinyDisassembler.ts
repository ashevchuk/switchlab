import type { DisasmLine } from './disassembler.js';
import { EXT_SLOT, JMP_OR_OUT_BIT, JMP_TARGET_MASK, OPCODE_SLOT_SHIFT, OPERAND_MASK, OPERAND_MNEMONICS, OUT_OPCODE } from './tinyIsa.js';

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

function mnemonic(opcode: number): string {
  const slot = opcode >> OPCODE_SLOT_SHIFT;
  if (slot !== EXT_SLOT) return `${OPERAND_MNEMONICS[slot]} ${hex2(opcode & OPERAND_MASK)}`;
  if (!(opcode & JMP_OR_OUT_BIT)) return `JMP ${hex2(opcode & JMP_TARGET_MASK)}`;
  return opcode === OUT_OPCODE ? 'OUT' : `JZ ${hex2(opcode & JMP_TARGET_MASK)}`;
}

/** Disassembler for the Tiny CPU's one-byte instruction set (see buildMinimalCpu). */
export function disassembleTiny(bytes: Uint8Array, addr: number, count: number): DisasmLine[] {
  const lines: DisasmLine[] = [];
  for (let a = Math.max(0, addr); a < bytes.length && lines.length < count; a++) {
    lines.push({ addr: a, size: 1, bytes: [bytes[a]!], text: mnemonic(bytes[a]!) });
  }
  return lines;
}
