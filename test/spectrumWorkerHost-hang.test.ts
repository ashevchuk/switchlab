import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpectrumWorkerHost } from '../src/machine/spectrum/SpectrumWorkerHost.js';
import { describeWorkerRecovery } from '../src/ui/errorReport.js';

class FakeWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  posted: { type: string }[] = [];
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor(readonly url: string) {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { type: string }): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
}

let now = 0;

function answer(worker: FakeWorker): void {
  const frame = {
    type: 'frame', pc: 0, sp: 0, a: 0, f: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, ix: 0, iy: 0, i: 0, r: 0, im: 0,
    iff1: false, iff2: false, halted: false, running: true, breakpointHit: false, breakWriteHit: false,
    port7ffd: 0, trdosPaged: false, contendedWaits: 0, contendedHits: 0, ayRegs: new ArrayBuffer(16),
    aySelected: 0, ayEnvWrites: 0, watchAddr: 0, watchBytes: new ArrayBuffer(8), border: 0, softError: null,
    tapePos: 0, tapeBlocks: 0, beeperStart: 0, beeperTransitions: [], tStates: 0, frameSeq: 1,
  };
  (worker.onmessage as (ev: { data: unknown }) => void)({ data: frame });
}

/** Drive the host the way the runner does: one tick per display frame, 16 ms apart. */
function tickFor(host: SpectrumWorkerHost, ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    host.tick(false);
  }
}

describe('SpectrumWorkerHost hang recovery', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    now = 1000;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { href: 'http://localhost/' });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function runningHost() {
    const host = new SpectrumWorkerHost();
    expect(host.start()).toBe(true);
    host.boot('48');
    host.setRunning(true);
    const outcomes: string[] = [];
    host.onWorkerRecovery = (o) => outcomes.push(o);
    return { host, outcomes };
  }

  it('replaces a Worker that stopped sending frames and boots the same model on the new one', () => {
    const { host, outcomes } = runningHost();
    answer(FakeWorker.all[0]!);
    tickFor(host, 3500);
    expect(outcomes).toEqual(['restarted']);
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    const fresh = FakeWorker.all[1]!;
    expect(fresh.posted.map((m) => m.type)).toEqual(expect.arrayContaining(['boot', 'setRunning']));
    expect(host.engine.running).toBe(true);
    expect(host.usingWorker).toBe(true);
  });

  it('gives a fresh Worker longer than 3 s to deliver its first frame', () => {
    const { host, outcomes } = runningHost();
    tickFor(host, 3500);
    expect(outcomes).toEqual([]);
    tickFor(host, 7000);
    expect(outcomes).toEqual(['restarted']);
  });

  it('does not call a Worker hung after the page was in the background', () => {
    const { host, outcomes } = runningHost();
    tickFor(host, 100);
    now += 60_000; // rAF was suspended, so no tick for a minute
    tickFor(host, 100);
    expect(outcomes).toEqual([]);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('does not touch a paused machine', () => {
    const { host, outcomes } = runningHost();
    host.setRunning(false);
    tickFor(host, 10_000);
    expect(outcomes).toEqual([]);
  });

  it('stops the machine instead of restarting forever', () => {
    const { host, outcomes } = runningHost();
    tickFor(host, 10_500);
    tickFor(host, 10_500);
    tickFor(host, 10_500);
    expect(outcomes).toEqual(['restarted', 'restarted', 'stopped']);
    expect(host.engine.running).toBe(false);
    expect(FakeWorker.all.every((w) => w.terminated || w === FakeWorker.all[2])).toBe(true);
  });
});

describe('describeWorkerRecovery', () => {
  it('tells the user the program was lost and what to do', () => {
    const r = describeWorkerRecovery('restarted');
    expect(r.hint).toMatch(/lost/);
    expect(describeWorkerRecovery('stopped').hint).toMatch(/Reload/);
    expect(r.key).not.toBe(describeWorkerRecovery('stopped').key);
  });
});
