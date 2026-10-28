/**
 * Prebuilt mini-BASIC demo image for soft Z80 boot / ROM load.
 *
 * Layout (fits the 12-bit machine map):
 *   0x000  JP BASIC_ORIGIN
 *   0x200  compiled BASIC_DEMO_SOURCE
 *
 * Use loadBasicRom(ram) from the TTY panel, or paste basicRomHexPrompt()
 * into a ROM / Z80 program prompt.
 */

import { compileBasic, type BasicIo } from './basic.js';
import { MACHINE_RAM_SIZE, softIoLayoutForRam } from './memoryMap.js';

export const BASIC_ORIGIN = 0x200;

/** Demo program exercised by tests and "Boot BASIC". */
export const BASIC_DEMO_SOURCE = `
10 CLS
20 PRINT "BASIC OK"
30 LET A=2
40 LET B=A*3+1
50 PRINT B
60 GOSUB 100
70 END
100 PRINT "SUB"
110 RETURN
`;

export function buildBasicProgram(origin = BASIC_ORIGIN, io?: BasicIo): Uint8Array {
  return compileBasic(BASIC_DEMO_SOURCE, origin, io);
}

/** Full 4K image with JP @0000 and BASIC @ origin. */
export function buildBasicRomImage(origin = BASIC_ORIGIN): Uint8Array {
  const code = buildBasicProgram(origin);
  const img = new Uint8Array(MACHINE_RAM_SIZE);
  img[0] = 0xc3;
  img[1] = origin & 0xff;
  img[2] = (origin >> 8) & 0xff;
  img.set(code, origin);
  return img;
}

/** Install JP + BASIC into an existing RAM image (leaves FB/keys alone). */
export function loadBasicRom(ram: Uint8Array, origin = BASIC_ORIGIN): { bytes: number; origin: number } {
  if (ram.length < origin + 64) {
    throw new Error('BASIC ROM needs at least 12-bit RAM');
  }
  const layout = softIoLayoutForRam(ram);
  const code = buildBasicProgram(origin, layout);
  if (origin + code.length > Math.min(ram.length, layout.ioGuard)) {
    throw new Error('BASIC image overlaps KEY/reserved region');
  }
  ram[0] = 0xc3;
  ram[1] = origin & 0xff;
  ram[2] = (origin >> 8) & 0xff;
  ram.set(code, origin);
  return { bytes: code.length, origin };
}

/** Comma-hex for the Z80 place prompt / MemoryEditor paste. */
export function basicRomHexPrompt(): string {
  const img = buildBasicRomImage();
  const end = Math.max(3, BASIC_ORIGIN + buildBasicProgram().length);
  const slice = img.subarray(0, end);
  return [...slice].map((b) => b.toString(16).padStart(2, '0')).join(',');
}
