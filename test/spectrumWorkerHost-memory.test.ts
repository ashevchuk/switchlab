import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpectrumWorkerHost } from '../src/machine/spectrum/SpectrumWorkerHost.js';

class FakeWorker {
  static last: FakeWorker | null = null;
  posted: { type: string }[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: { type: string }): void {
    this.posted.push(msg);
  }
  terminate(): void {}
}

describe('SpectrumWorkerHost.getMemory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { href: 'http://localhost/' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks the Worker and resolves with the bytes it sends back', async () => {
    const host = new SpectrumWorkerHost();
    host.start();
    const pending = host.getMemory();
    expect(FakeWorker.last!.posted.map((m) => m.type)).toContain('getMemory');
    const ram = new Uint8Array(0x10000);
    ram[0x8000] = 0xf3;
    FakeWorker.last!.onmessage!({ data: { type: 'memory', ram: ram.buffer } });
    const memory = await pending;
    expect(memory).toHaveLength(0x10000);
    expect(memory[0x8000]).toBe(0xf3);
  });

  it('rejects when the Worker never answers', async () => {
    const host = new SpectrumWorkerHost();
    host.start();
    const pending = host.getMemory(1000);
    const outcome = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1100);
    await outcome;
  });

  it('refuses a second request while one is pending', async () => {
    const host = new SpectrumWorkerHost();
    host.start();
    const first = host.getMemory(1000);
    const settled = first.catch(() => undefined);
    await expect(host.getMemory()).rejects.toThrow(/already pending/);
    await vi.advanceTimersByTimeAsync(1100);
    await settled;
  });

  it('reads the in-page engine when there is no Worker', async () => {
    const host = new SpectrumWorkerHost();
    host.boot('48');
    const memory = await host.getMemory();
    expect(memory).toHaveLength(0x10000);
    expect(memory[0]).toBe(0xf3); // ROM starts with DI
  });
});
