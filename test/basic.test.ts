import { describe, expect, it } from 'vitest';
import { compileBasic } from '../src/machine/basic.js';
import { loadBasicRom } from '../src/machine/basicRom.js';
import { CPM_ADDR_BITS, FB_BASE, KEY_DATA, KEY_STATUS, MACHINE_ADDR_BITS, softIoLayoutForAddrBits } from '../src/machine/memoryMap.js';
import { createSoftZ80, softRun } from '../src/machine/softZ80.js';
import { injectKey } from '../src/machine/tty.js';

function runBasic(source: string, maxOps = 2000, origin = 0x200) {
  const bytes = compileBasic(source, origin);
  const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
  ram.set(bytes, origin);
  const cpu = createSoftZ80(0xdff);
  cpu.pc = origin;
  softRun(cpu, ram, maxOps, { clearOnReadKeys: true });
  return { bytes, ram, cpu };
}

describe('mini BASIC', () => {
  it('compiles a 3-line program and prints to the text FB via softRun', () => {
    const { ram, cpu, bytes } = runBasic(`
      10 PRINT "HI"
      20 LET A=33
      30 END
    `);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[bytes.length - 1]).toBe(0x76);
    expect(cpu.halted).toBe(true);
    expect(ram[FB_BASE]).toBe('H'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe('I'.charCodeAt(0));
    expect(ram[0xc00]).toBe(33);
  });

  it('supports GOTO, PRINT var, and var+number', () => {
    const { ram, cpu } = runBasic(`
      10 LET A=64
      20 LET A=A+1
      30 PRINT A
      40 GOTO 60
      50 PRINT "X"
      60 END
    `);
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(65);
    expect(ram[FB_BASE]).toBe(65);
    expect(ram[FB_BASE + 1]).toBe(0);
  });

  it('supports REM, IF THEN, and multi-item PRINT', () => {
    const { ram, cpu } = runBasic(`
      10 REM skip me
      20 LET A=5
      30 IF A=5 THEN 50
      40 PRINT "NO"
      50 PRINT "A";A
      60 PRINT "B",A
      70 END
    `);
    expect(cpu.halted).toBe(true);
    // Runtime PRINT cursor: skipped PRINT "NO" does not consume FB slots.
    expect(ram[FB_BASE]).toBe('A'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe(5);
    expect(ram[FB_BASE + 2]).toBe('B'.charCodeAt(0));
    expect(ram[FB_BASE + 3]).toBe(0x20); // comma → space
    expect(ram[FB_BASE + 4]).toBe(5);
  });

  it('supports IF comparisons <> < >', () => {
    const { ram, cpu } = runBasic(`
      10 LET A=3
      20 IF A<>2 THEN 40
      30 PRINT "X"
      40 IF A>2 THEN 60
      50 PRINT "Y"
      60 IF A<9 THEN 80
      70 PRINT "Z"
      80 PRINT "OK"
      90 END
    `);
    expect(cpu.halted).toBe(true);
    // Skipped PRINT branches leave no holes in the FB.
    expect(ram[FB_BASE]).toBe('O'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe('K'.charCodeAt(0));
  });

  it('IF skipping PRINT does not consume FB slots for skipped branch', () => {
    const { ram, cpu } = runBasic(`
      10 LET A=1
      20 IF A=1 THEN 40
      30 PRINT "SKIP"
      40 PRINT "GO"
      50 END
    `);
    expect(cpu.halted).toBe(true);
    expect(ram[FB_BASE]).toBe('G'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe('O'.charCodeAt(0));
    expect(ram[FB_BASE + 2]).toBe(0);
  });

  it('supports FOR / NEXT loops', () => {
    const { ram, cpu } = runBasic(
      `
      10 LET A=0
      20 FOR I=1 TO 3
      30 LET A=A+1
      40 NEXT I
      50 PRINT A
      60 END
      `,
      5000,
    );
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(3);
    expect(ram[FB_BASE]).toBe(3);
    expect(ram[0xc00 + ('I'.charCodeAt(0) - 65)]).toBe(3);
  });

  it('supports nested FOR / NEXT (bare NEXT closes innermost)', () => {
    const { ram, cpu } = runBasic(
      `
      10 LET A=0
      20 FOR I=1 TO 2
      30 FOR J=1 TO 3
      40 LET A=A+1
      50 NEXT
      60 NEXT I
      70 PRINT A
      80 END
      `,
      8000,
    );
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(6);
    expect(ram[FB_BASE]).toBe(6);
  });

  it('supports var+var and number-var expressions', () => {
    const { ram, cpu } = runBasic(`
      10 LET A=10
      20 LET B=3
      30 LET C=A+B
      40 LET D=20-B
      50 LET E=5+A
      60 PRINT C
      70 PRINT D
      80 PRINT E
      90 END
    `);
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00 + 2]).toBe(13); // C
    expect(ram[0xc00 + 3]).toBe(17); // D
    expect(ram[0xc00 + 4]).toBe(15); // E
    expect(ram[FB_BASE]).toBe(13);
    expect(ram[FB_BASE + 1]).toBe(17);
    expect(ram[FB_BASE + 2]).toBe(15);
  });

  it('supports INPUT via KEY_STATUS / KEY_DATA busy-wait', () => {
    const origin = 0x200;
    const bytes = compileBasic(
      `
      10 INPUT A
      20 PRINT A
      30 END
      `,
      origin,
    );
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    ram.set(bytes, origin);
    const cpu = createSoftZ80(0xdff);
    cpu.pc = origin;
    softRun(cpu, ram, 20, { clearOnReadKeys: true });
    expect(cpu.halted).toBe(false);
    injectKey(ram, 0x41);
    softRun(cpu, ram, 200, { clearOnReadKeys: true });
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(0x41);
    expect(ram[FB_BASE]).toBe(0x41);
    expect(ram[KEY_STATUS]).toBe(0);
    expect(ram[KEY_DATA]).toBe(0x41);
  });

  it('supports CLS, GOSUB/RETURN, * / and PRINT expr', () => {
    const { ram, cpu } = runBasic(
      `
      10 CLS
      20 LET A=2
      30 LET B=A*3+1
      40 GOSUB 100
      50 PRINT B
      60 END
      100 PRINT "X"
      110 RETURN
      `,
      8000,
    );
    expect(cpu.halted).toBe(true);
    expect(ram[FB_BASE]).toBe('X'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe(7);
    expect(ram[0xc00 + 1]).toBe(7); // B
  });

  it('loads BASIC demo ROM image and runs from JP @0000', () => {
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    loadBasicRom(ram);
    const cpu = createSoftZ80(0xdff);
    softRun(cpu, ram, 20000, { clearOnReadKeys: true });
    expect(cpu.halted).toBe(true);
    expect(ram[FB_BASE]).toBe('B'.charCodeAt(0));
  });
});

describe('mini BASIC on the 64K layout', () => {
  const layout = softIoLayoutForAddrBits(CPM_ADDR_BITS);

  function run64k(source: string, origin = 0x200) {
    const bytes = compileBasic(source, origin, layout);
    const ram = new Uint8Array(layout.ramSize);
    ram.set(bytes, origin);
    const cpu = createSoftZ80(layout.stackTop);
    cpu.pc = origin;
    softRun(cpu, ram, 3000, { clearOnReadKeys: true });
    return { bytes, ram, cpu };
  }

  it('keeps the 12-bit bytes unchanged when no layout is given', () => {
    const source = '10 PRINT "HI"\n20 END';
    expect([...compileBasic(source)]).toEqual([...compileBasic(source, 0x200, softIoLayoutForAddrBits(MACHINE_ADDR_BITS))]);
  });

  it('initialises the print cursor at the 64K text framebuffer', () => {
    const bytes = compileBasic('10 PRINT "HI"\n20 END', 0x200, layout);
    expect([...bytes.subarray(0, 3)]).toEqual([0x21, layout.fbBase & 0xff, layout.fbBase >> 8]);
  });

  it('prints into the 64K framebuffer, not the 12-bit one', () => {
    const { ram, cpu } = run64k('10 CLS\n20 PRINT "HI"\n30 END');
    expect(cpu.halted).toBe(true);
    expect(ram[layout.fbBase]).toBe('H'.charCodeAt(0));
    expect(ram[layout.fbBase + 1]).toBe('I'.charCodeAt(0));
    expect(ram[FB_BASE]).toBe(0);
  });

  it('reads INPUT from the 64K key registers', () => {
    const bytes = compileBasic('10 INPUT A\n20 END', 0x200, layout);
    const ram = new Uint8Array(layout.ramSize);
    ram.set(bytes, 0x200);
    injectKey(ram, 'Q'.charCodeAt(0));
    const cpu = createSoftZ80(layout.stackTop);
    cpu.pc = 0x200;
    softRun(cpu, ram, 3000, { clearOnReadKeys: true });
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe('Q'.charCodeAt(0));
  });

  it('loadBasicRom installs a demo that prints into the 64K framebuffer', () => {
    const ram = new Uint8Array(layout.ramSize);
    const { origin } = loadBasicRom(ram);
    const cpu = createSoftZ80(layout.stackTop);
    cpu.pc = 0;
    softRun(cpu, ram, 20000, { clearOnReadKeys: true });
    expect(origin).toBe(0x200);
    expect(String.fromCharCode(...ram.subarray(layout.fbBase, layout.fbBase + 8))).toBe('BASIC OK');
  });
});
