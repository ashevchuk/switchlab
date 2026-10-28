import { describe, expect, it } from 'vitest';
import { hexRowWindow } from '../src/ui/MemoryEditor.js';

describe('hexRowWindow', () => {
  it('starts at the top for an unscrolled view', () => {
    expect(hexRowWindow(0, 160, 256)).toMatchObject({ first: 0 });
  });

  it('keeps the first visible row inside the memory when the scroll position is stale', () => {
    // Scrolled far down a 4 KB RAM, then a 16-byte RAM (one row) is attached.
    const w = hexRowWindow(40 * 16, 160, 1);
    expect(w.first).toBe(0);
    expect(w.count).toBe(1);
  });

  it('always lists at least one row, never a negative count', () => {
    for (const total of [1, 2, 5, 256]) {
      for (const scroll of [0, 5, 1000, 100000]) {
        const w = hexRowWindow(scroll, 160, total);
        expect(w.count, `total=${total} scroll=${scroll}`).toBeGreaterThanOrEqual(1);
        expect(w.first + w.count).toBeLessThanOrEqual(total);
      }
    }
  });
});
