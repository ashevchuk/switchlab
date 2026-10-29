/**
 * Spectrum / Z80 hot-path behaviour added for the browser perf pass:
 * contention window, dirty skip, AY envelope sync, Worker self-clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContendedStub } from '../src/machine/spectrum/expansions.js';
import { SpectrumEngine } from '../src/machine/spectrum/engine.js';
import { Ay8912 } from '../src/machine/spectrum/ay8912.js';
import { SpectrumWorkerHost } from '../src/machine/spectrum/SpectrumWorkerHost.js';
import { renderSpectrumFrame, SPEC_FRAME_W, SPEC_FRAME_H } from '../src/machine/spectrum/video.js';
import { createSoftZ80, softRun } from '../src/machine/softZ80.js';

describe('ContendedStub display window', () => {
  it('charges every access when no progress cursor is attached', () => {
    const c = new ContendedStub();
    c.noteAccess(0x4000);
    c.noteAccess(0x8000);
    expect(c.hits).toBe(1);
    expect(c.waitUnits).toBe(c.memCost);
    expect(c.memCost).toBe(1);
  });

  it('charges $4000–$7FFF only inside the paper area', () => {
    const c = new ContendedStub();
    c.progress = { n: 0, max: 1000 };
    c.noteAccess(0x4000);
    expect(c.hits).toBe(1);
    expect(c.waitUnits).toBe(0);

    c.progress.n = Math.floor(1000 * ((64 / 312 + 256 / 312) / 2));
    c.noteAccess(0x5fff);
    expect(c.waitUnits).toBe(c.memCost);

    c.progress.n = 999;
    c.noteAccess(0x4000);
    expect(c.waitUnits).toBe(c.memCost);
  });
});

describe('SpectrumEngine dirty skip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not re-render an unchanged display file', () => {
    // The FLASH phase comes from the wall clock; a phase flip between two frames re-renders legitimately.
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const eng = new SpectrumEngine();
    eng.audioEnabled = false;
    eng.boot('48');
    const first = eng.tickFrame(true);
    expect(first.rgbaChanged).toBe(true);
    const second = eng.tickFrame(true);
    expect(second.rgbaChanged).toBe(false);
    eng.mmu.write(0x4000, 0xff);
    const third = eng.tickFrame(true);
    expect(third.rgbaChanged).toBe(true);
  });

  it('writes into a caller-supplied buffer without aliasing engine.rgba', () => {
    const eng = new SpectrumEngine();
    eng.audioEnabled = false;
    eng.boot('48');
    const target = new Uint8Array(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    const r = eng.tickFrame(true, target);
    expect(r.rgbaChanged).toBe(true);
    expect(r.rgba).toBe(target);
  });
});

describe('Ay8912 envelope sync', () => {
  it('increments envWrites on R13 and does not retrigger when the count matches', () => {
    const ay = new Ay8912();
    ay.select(13);
    ay.writeData(0x08);
    expect(ay.envWrites).toBe(1);
    const mirror = new Ay8912();
    mirror.loadRegs(ay.regs, ay.selected, 1);
    expect(mirror.envWrites).toBe(1);
    const writes = mirror.envWrites;
    mirror.loadRegs(ay.regs, ay.selected, writes);
    expect(mirror.envWrites).toBe(writes);
    mirror.loadRegs(ay.regs, ay.selected, writes + 1);
    expect(mirror.envWrites).toBe(writes + 1);
  });
});

describe('renderSpectrumFrame Uint32 path', () => {
  it('fills a 320×256 RGBA buffer (border + paper)', () => {
    const bank = new Uint8Array(0x4000);
    bank[0] = 0xff;
    bank[0x1800] = 0x10; // blue paper, black ink
    const out = new Uint8Array(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    renderSpectrumFrame(bank, 7, out, false);
    expect(out[3]).toBe(255);
    // Paper pixel at (32,32) = first screen pixel
    const o = ((32 * SPEC_FRAME_W + 32) * 4);
    expect(out[o + 3]).toBe(255);
  });
});

describe('softRun progress cursor', () => {
  it('advances hooks.progress.n without an onStep callback', () => {
    const ram = new Uint8Array(0x10000);
    ram[0] = 0x00; // NOP
    ram[1] = 0x18;
    ram[2] = 0xfd; // JR -3 → tight loop
    const cpu = createSoftZ80(0xff00);
    cpu.pc = 0;
    const progress = { n: 0, max: 1 };
    const n = softRun(cpu, ram, 50, { progress }, null);
    expect(n).toBe(50);
    expect(progress.max).toBe(50);
    expect(progress.n).toBe(49);
  });
});

class FakeWorker {
  static last: FakeWorker | null = null;
  posted: unknown[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  constructor(_url: string | URL) {
    FakeWorker.last = this;
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    /* nop */
  }
}

describe('SpectrumWorkerHost self-clock', () => {
  const OrigWorker = globalThis.Worker;

  beforeEach(() => {
    FakeWorker.last = null;
    // @ts-expect-error test double
    globalThis.Worker = FakeWorker;
    if (typeof location === 'undefined') {
      // @ts-expect-error jsdom-ish
      globalThis.location = { href: 'http://localhost/dist-file/index.html' };
    }
  });

  afterEach(() => {
    globalThis.Worker = OrigWorker;
  });

  it('starts the Worker loop via setRunning and does not post tick from rAF', () => {
    const host = new SpectrumWorkerHost();
    expect(host.start()).toBe(true);
    const w = FakeWorker.last!;
    w.posted.length = 0;
    host.setRunning(true);
    expect(w.posted).toEqual([{ type: 'setRunning', on: true }]);
    w.posted.length = 0;
    const frame = host.tick(true);
    expect(frame).toBeNull();
    expect(w.posted.every((m) => (m as { type: string }).type === 'setRunning')).toBe(true);
    expect(w.posted.some((m) => (m as { type: string }).type === 'tick')).toBe(false);
  });

  it('recycles the previous RGBA after onFrame has observed the new one', () => {
    const host = new SpectrumWorkerHost();
    host.start();
    const w = FakeWorker.last!;
    const seen: Uint8Array[] = [];
    host.onFrame = (f) => {
      if (f.rgbaChanged) seen.push(f.rgba);
    };
    const a = new ArrayBuffer(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    const b = new ArrayBuffer(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    const base = {
      type: 'frame' as const,
      ayRegs: new ArrayBuffer(16),
      aySelected: 0,
      ayEnvWrites: 0,
      tStates: 69888,
      beeperStart: false,
      beeperTransitions: [],
      breakpointHit: false,
      breakWriteHit: false,
      running: true,
      tapePos: 0,
      tapeBlocks: 0,
      contendedWaits: 0,
      contendedHits: 0,
      pc: 0,
      sp: 0,
      a: 0,
      f: 0,
      b: 0,
      c: 0,
      d: 0,
      e: 0,
      h: 0,
      l: 0,
      ix: 0,
      iy: 0,
      i: 0,
      r: 0,
      im: 1 as const,
      iff1: false,
      iff2: false,
      halted: false,
      model: '48' as const,
      trdosPaged: false,
      port7ffd: 0x20,
      watchAddr: 0x4000,
      watchBytes: new ArrayBuffer(64),
      border: 7,
      softError: null,
      frameSeq: 1,
    };
    w.onmessage?.({ data: { ...base, rgba: a, frameSeq: 1 } } as MessageEvent);
    expect(seen[0]!.buffer).toBe(a);
    w.posted.length = 0;
    w.onmessage?.({ data: { ...base, rgba: b, frameSeq: 2, ayRegs: new ArrayBuffer(16), watchBytes: new ArrayBuffer(64) } } as MessageEvent);
    expect(seen[1]!.buffer).toBe(b);
    const rec = w.posted.find((m) => (m as { type: string }).type === 'recycleRgba') as
      | { type: string; buf: ArrayBuffer }
      | undefined;
    expect(rec?.buf).toBe(a);
  });
});
