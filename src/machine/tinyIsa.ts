/** Encoding of the Tiny CPU's one-byte instructions (see buildMinimalCpu). */
export const OPERAND_MNEMONICS = ['LDI', 'ADI', 'ANI', 'ORI', 'XRI', 'STORE', 'LOAD'] as const;
export const EXT_SLOT = 7;
export const OPCODE_SLOT_SHIFT = 5;
export const OPERAND_MASK = 0x1f;
export const JMP_TARGET_MASK = 0x0f;
export const JMP_OR_OUT_BIT = 0x10;
