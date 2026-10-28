import { describe, expect, it } from 'vitest';
import { followWindowStart } from '../src/ui/MemoryEditor.js';

const window = { start: 0x10, addrs: new Set([0x10, 0x11, 0x13, 0x14]) };

describe('followWindowStart', () => {
  it('starts at the PC when nothing is listed yet', () => {
    expect(followWindowStart(null, 0x42)).toBe(0x42);
  });

  it('keeps the listing in place while the PC stays on a listed instruction', () => {
    expect(followWindowStart(window, 0x10)).toBe(0x10);
    expect(followWindowStart(window, 0x13)).toBe(0x10);
    expect(followWindowStart(window, 0x14)).toBe(0x10);
  });

  it('restarts at the PC when it leaves the listing', () => {
    expect(followWindowStart(window, 0x20)).toBe(0x20);
    expect(followWindowStart(window, 0x0f)).toBe(0x0f);
  });

  it('restarts when the PC lands between listed instructions', () => {
    expect(followWindowStart(window, 0x12)).toBe(0x12);
  });
});
