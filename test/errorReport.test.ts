import { describe, expect, it } from 'vitest';
import { describeError } from '../src/ui/errorReport.js';

describe('describeError', () => {
  it('keeps the message and names the source', () => {
    const r = describeError(new Error('boom'), 'frame');
    expect(r.message).toBe('boom');
    expect(r.title).toBe('The editor hit an error');
    expect(r.hint).toMatch(/autosaved/);
  });

  it('advises a reboot for a machine error and says the circuit is untouched', () => {
    const r = describeError('Illegal opcode', 'machine');
    expect(r.title).toBe('The machine stopped');
    expect(r.hint).toMatch(/Reboot/);
    expect(r.hint).toMatch(/untouched/);
  });

  it('recognises a full browser storage', () => {
    const err = new Error('The quota has been exceeded');
    err.name = 'QuotaExceededError';
    expect(describeError(err, 'script').hint).toMatch(/Export project/);
  });

  it('recognises stack overflow and memory exhaustion', () => {
    expect(describeError(new RangeError('Maximum call stack size exceeded'), 'frame').hint).toMatch(/nests too deeply/);
    expect(describeError(new RangeError('Invalid array length'), 'frame').hint).toMatch(/too large/);
  });

  it('gives the same key to the same problem and different keys to different ones', () => {
    expect(describeError(new Error('a'), 'frame').key).toBe(describeError(new Error('a'), 'frame').key);
    expect(describeError(new Error('a'), 'frame').key).not.toBe(describeError(new Error('b'), 'frame').key);
    expect(describeError(new Error('a'), 'frame').key).not.toBe(describeError(new Error('a'), 'machine').key);
  });

  it('accepts non-Error values and caps a long message', () => {
    expect(describeError(undefined, 'promise').message).toBe('undefined');
    expect(describeError('x'.repeat(1000), 'promise').message).toHaveLength(300);
  });
});
