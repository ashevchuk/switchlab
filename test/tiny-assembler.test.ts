import { describe, expect, it } from 'vitest';
import { assembleTiny } from '../src/machine/tinyAssembler.js';

describe('assembleTiny', () => {
  it('assembles every instruction to its opcode byte', () => {
    const source = 'LDI 1\nADI 2\nANI 3\nORI 4\nXRI 5\nSTORE 6\nLOAD 7\nJMP 8\nOUT';
    const result = assembleTiny(source);
    expect(result.errors).toEqual([]);
    expect([...result.bytes]).toEqual([0x01, 0x22, 0x43, 0x64, 0x85, 0xa6, 0xc7, 0xe8, 0xf0]);
  });

  it('assembles the blinker with a label, comments, hex operands and any letter case', () => {
    const source = ['start: ldi 0x01   ; on', 'out', 'xri 1', 'OUT', 'jmp start'].join('\n');
    expect([...assembleTiny(source).bytes]).toEqual([0x01, 0xf0, 0x81, 0xf0, 0xe0]);
  });

  it('resolves labels relative to the origin', () => {
    const result = assembleTiny('LDI 1\nhere: OUT\nJMP here', 0);
    expect([...result.bytes]).toEqual([0x01, 0xf0, 0xe1]);
    expect([...assembleTiny('here: OUT\nJMP here', 4).bytes]).toEqual([0xf0, 0xe4]);
    expect(assembleTiny('here: OUT\nJMP here', 20).errors).toContain('line 2: here is out of range (max 15)');
  });

  it.each([
    ['LDI 32', 'line 1: 32 is out of range (max 31)'],
    ['JMP 16', 'line 1: 16 is out of range (max 15)'],
    ['LDI', 'line 1: LDI needs an operand'],
    ['OUT 1', 'line 1: OUT takes no operand'],
    ['NOP', 'line 1: unknown mnemonic NOP'],
    ['JMP nowhere', 'line 1: unknown label nowhere'],
    ['a: OUT\na: OUT', 'line 2: duplicate label a'],
  ])('reports %j', (source, message) => {
    const result = assembleTiny(source);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(message);
  });
});
