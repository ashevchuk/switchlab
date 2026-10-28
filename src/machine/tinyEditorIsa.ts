import { assembleTiny } from './tinyAssembler.js';
import { disassembleTiny } from './tinyDisassembler.js';

export const TINY_EDITOR_ISA = { name: 'Tiny CPU', disassemble: disassembleTiny, assemble: assembleTiny };
