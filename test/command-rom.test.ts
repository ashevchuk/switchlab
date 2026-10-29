import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import {
  COMMAND_ROM_BYTES,
  commandRomFor,
  COMMAND_ROM_SOURCE,
  commandRomHexPrompt,
  loadCommandRom,
} from '../src/machine/commandRom.js';
import { assemble } from '../src/machine/assembler.js';
import { injectKey } from '../src/machine/tty.js';
import { createSoftZ80, softRun } from '../src/machine/softZ80.js';
import { CPM_FB_BASE, CPM_KEY_STATUS } from '../src/machine/memoryMap.js';
import { makeZ80Harness } from './z80Harness.js';

describe('command ROM image', () => {
  it('assembles under the line-buffer and starts with LD SP', () => {
    const r = assemble(COMMAND_ROM_SOURCE, 0);
    expect(r.errors).toEqual([]);
    expect(r.bytes.length).toBe(COMMAND_ROM_BYTES.length);
    expect(COMMAND_ROM_BYTES.length).toBeGreaterThan(200);
    expect(COMMAND_ROM_BYTES.length).toBeLessThan(0xd00);
    expect(COMMAND_ROM_BYTES[0]).toBe(0x31); // LD SP,nn
    expect(commandRomHexPrompt().startsWith('31,')).toBe(true);

    // Help + KEY_* absolute refs present in the image
    const text = String.fromCharCode(...COMMAND_ROM_BYTES);
    expect(text).toContain('H M addr');
    const hasStatus = [...COMMAND_ROM_BYTES.keys()].some(
      (i) =>
        COMMAND_ROM_BYTES[i] === 0x3a &&
        COMMAND_ROM_BYTES[i + 1] === 0x00 &&
        COMMAND_ROM_BYTES[i + 2] === 0x0f,
    );
    expect(hasStatus).toBe(true);

    const ram = new Uint8Array(4096);
    ram.fill(0xff);
    loadCommandRom(ram);
    expect(ram.subarray(0, COMMAND_ROM_BYTES.length)).toEqual(COMMAND_ROM_BYTES);
  });
});

describe('command ROM on Z80', () => {
  it('prints the prompt and echoes a key into the framebuffer', () => {
    const program = new Uint8Array(1 << MACHINE_ADDR_BITS);
    loadCommandRom(program);

    const { cpu, runInstruction } = makeZ80Harness(program, MACHINE_ADDR_BITS);
    injectKey(cpu.ram.bytes, 'A'.charCodeAt(0));

    // Cold start (SP + prompt CALL) + one echoed char — pad like machine-monitor.
    for (let i = 0; i < 120; i++) runInstruction();

    expect(cpu.ram.bytes[FB_BASE]).toBe('>'.charCodeAt(0));
    expect(cpu.ram.bytes[FB_BASE + 1]).toBe(' '.charCodeAt(0));
    expect(cpu.ram.bytes[FB_BASE + 2]).toBe('A'.charCodeAt(0));
    expect(cpu.ram.bytes[KEY_STATUS]).toBe(0);
  });
});

describe('command ROM on the 64K map', () => {
  const hasLoad = (image: Uint8Array, op: number, addr: number) =>
    [...image.keys()].some((i) => image[i] === op && image[i + 1] === (addr & 0xff) && image[i + 2] === addr >> 8);

  it('uses the 64K framebuffer and key registers, and leaves the 12-bit image alone', () => {
    const small = commandRomFor(12);
    const big = commandRomFor(16);
    expect(small).toBe(COMMAND_ROM_BYTES);
    expect(big.length).toBe(small.length);
    expect(hasLoad(small, 0x3a, KEY_STATUS)).toBe(true); // LD A,(KEY_STATUS)
    expect(hasLoad(small, 0x21, FB_BASE)).toBe(true); // LD HL,FB_BASE
    expect(hasLoad(big, 0x3a, CPM_KEY_STATUS)).toBe(true);
    expect(hasLoad(big, 0x21, CPM_FB_BASE)).toBe(true);
    expect(hasLoad(big, 0x3a, KEY_STATUS)).toBe(false);
  });

  it('loadCommandRom picks the image by RAM size', () => {
    const ram = new Uint8Array(1 << 16);
    loadCommandRom(ram);
    expect(ram.subarray(0, commandRomFor(16).length)).toEqual(commandRomFor(16));
  });

  it('prompts on the 64K framebuffer and runs a W command typed on the TTY', () => {
    const ram = new Uint8Array(1 << 16);
    loadCommandRom(ram);
    const cpu = createSoftZ80(0xdff);
    softRun(cpu, ram, 500);
    expect(ram[CPM_FB_BASE]).toBe('>'.charCodeAt(0));

    for (const ch of 'W 400 AA\r') {
      injectKey(ram, ch.charCodeAt(0));
      softRun(cpu, ram, 4000);
    }
    expect(ram[0x400]).toBe(0xaa);
    expect(ram[CPM_KEY_STATUS]).toBe(0);
  });
});
