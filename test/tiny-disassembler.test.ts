import { describe, expect, it } from 'vitest';
import { disassembleTiny } from '../src/machine/tinyDisassembler.js';

describe('disassembleTiny', () => {
  it('decodes every slot of the Tiny CPU instruction set', () => {
    // LDI 1, ADI 2, ANI 3, ORI 4, XRI 5, STORE 6, LOAD 7, JMP 8, OUT
    const bytes = Uint8Array.of(0x01, 0x22, 0x43, 0x64, 0x85, 0xa6, 0xc7, 0xe8, 0xf0);
    expect(disassembleTiny(bytes, 0, 9).map((l) => l.text)).toEqual([
      'LDI 0x01',
      'ADI 0x02',
      'ANI 0x03',
      'ORI 0x04',
      'XRI 0x05',
      'STORE 0x06',
      'LOAD 0x07',
      'JMP 0x08',
      'OUT',
    ]);
  });

  it('tells JZ from OUT by the low nibble', () => {
    expect(disassembleTiny(Uint8Array.of(0xf0, 0xf1, 0xf4, 0xff), 0, 4).map((l) => l.text)).toEqual(['OUT', 'JZ 0x01', 'JZ 0x04', 'JZ 0x0f']);
  });

  it('lists one-byte instructions from the requested address, bounded by count and image', () => {
    const bytes = Uint8Array.of(0x01, 0xf0, 0x81, 0xf0, 0xe0);
    const lines = disassembleTiny(bytes, 2, 10);
    expect(lines.map((l) => l.addr)).toEqual([2, 3, 4]);
    expect(lines.every((l) => l.size === 1)).toBe(true);
    expect(disassembleTiny(bytes, 0, 2)).toHaveLength(2);
  });
});
