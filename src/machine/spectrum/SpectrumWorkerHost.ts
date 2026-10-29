/**
 * Host for Spectrum soft-run Worker with main-thread SpectrumEngine fallback.
 */

import { SpectrumEngine, type SpectrumFrameResult, type SpectrumTurbo } from './engine.js';
import type { SpectrumModel } from './mmu.js';
import type { TrdInfo } from './expansions.js';
import type { WorkerInMsg, WorkerOutMsg } from './workerProtocol.js';
import { Ay8912 } from './ay8912.js';

export type SpectrumHostFrame = SpectrumFrameResult & {
  fromWorker: boolean;
};

export type SpectrumSnapshotBundle = {
  sna: Uint8Array;
  z80: Uint8Array;
  scr: Uint8Array;
};

/**
 * Prefer a dedicated Worker (`spectrum-worker.js` next to the page). Fall back
 * to an in-page SpectrumEngine when Workers are unavailable (some file:// cases).
 */
export class SpectrumWorkerHost {
  private worker: Worker | null = null;
  /** Always kept for UI sync / fallback ticks. */
  readonly engine = new SpectrumEngine();
  private useWorker = false;
  private pendingFrame: SpectrumHostFrame | null = null;
  private lastRgba: Uint8Array | null = null;
  /** Bumps whenever a new picture arrives — UI skips redundant blits. */
  rgbaSeq = 0;
  /**
   * Invoked for every emulated frame as soon as it exists (Worker message or
   * fallback tick) — independent of the display's rAF cadence. The runner
   * queues audio and mirrors run-state from here.
   */
  onFrame: ((frame: SpectrumHostFrame) => void) | null = null;
  /** Main-thread fallback pacing (50 Hz from wall-clock, not from rAF rate). */
  private fbLastMs = 0;
  private fbAccMs = 0;
  private fbFramesSinceRgba = 0;
  private static readonly FRAME_MS = 20;
  private static readonly FB_MAX_CATCHUP = 3;
  /** Last time a Worker frame arrived — used to restart a stalled 50 Hz loop. */
  private lastFrameAt = 0;
  /** A running Worker that sends no frame for this long is hung, not slow. */
  private static readonly HANG_MS = 3000;
  /** Before its first frame a fresh Worker may still be downloading its script. */
  private static readonly FIRST_FRAME_MS = 10_000;
  private workerAnswered = false;
  /** Restarts allowed inside RESTART_WINDOW_MS before the machine is stopped instead. */
  private static readonly MAX_RESTARTS = 2;
  private static readonly RESTART_WINDOW_MS = 60_000;
  private lastTickAt = 0;
  /** Unlike lastFrameAt, nudging the Worker does not refresh it: only a frame (or Run) does. */
  private lastWorkerFrameAt = 0;
  private restartTimes: number[] = [];
  private videoEnabled = true;
  /** Called after a hung Worker was replaced ('restarted') or given up on ('stopped'). */
  onWorkerRecovery: ((outcome: 'restarted' | 'stopped') => void) | null = null;
  lastWatchBytes: Uint8Array | null = null;
  /** Soft-error string from the live engine (Worker frame or main tick). */
  lastSoftError: string | null = null;
  onError: ((msg: string) => void) | null = null;
  private pendingSnapshot:
    | {
        resolve: (v: SpectrumSnapshotBundle) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;

  /** Try to start Worker; returns true if Worker path is active. */
  start(): boolean {
    if (this.worker) return this.useWorker;
    this.workerAnswered = false;
    try {
      const url = new URL('spectrum-worker.js', location.href);
      this.worker = new Worker(url.href);
      this.worker.onmessage = (ev: MessageEvent<WorkerOutMsg>) => this.onWorkerMsg(ev.data);
      this.worker.onerror = () => {
        // Worker may fail to parse/load (vite URL, file://). Fall back to main
        // thread without stamping a sticky softError on the machine panel.
        this.fallbackToMain();
      };
      this.useWorker = true;
      return true;
    } catch {
      this.fallbackToMain();
      return false;
    }
  }

  get usingWorker(): boolean {
    return this.useWorker && this.worker != null;
  }

  /** Last RGBA frame (Worker) or null when only main-thread blit is used. */
  get lastFrameRgba(): Uint8Array | null {
    return this.lastRgba;
  }

  private fallbackToMain(): void {
    this.useWorker = false;
    if (this.pendingSnapshot) {
      this.pendingSnapshot.reject(new Error('Spectrum worker stopped'));
      clearTimeout(this.pendingSnapshot.timer);
      this.pendingSnapshot = null;
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
    }
  }

  stop(): void {
    this.fallbackToMain();
  }

  /** Exposed for unit tests / diagnostics. */
  postForTest(msg: WorkerInMsg, transfer?: Transferable[]): void {
    this.post(msg, transfer);
  }

  private post(msg: WorkerInMsg, transfer?: Transferable[]): void {
    if (this.worker && this.useWorker) {
      this.worker.postMessage(msg, transfer ?? []);
    }
  }

  private onWorkerMsg(msg: WorkerOutMsg): void {
    if (msg.type === 'error') {
      this.lastSoftError = msg.message;
      this.onError?.(msg.message);
      if (this.pendingSnapshot) {
        this.pendingSnapshot.reject(new Error(msg.message));
        clearTimeout(this.pendingSnapshot.timer);
        this.pendingSnapshot = null;
      }
      return;
    }
    if (msg.type === 'snapshot') {
      if (this.pendingSnapshot) {
        clearTimeout(this.pendingSnapshot.timer);
        this.pendingSnapshot.resolve({
          sna: new Uint8Array(msg.sna),
          z80: new Uint8Array(msg.z80),
          scr: new Uint8Array(msg.scr),
        });
        this.pendingSnapshot = null;
      }
      return;
    }
    if (msg.type === 'frame') {
      let rgba = this.lastRgba;
      let recycle: ArrayBuffer | null = null;
      if (msg.rgba) {
        // Recycle the previous picture *after* onFrame so the runner can
        // snapshot it; transferring first would detach lastSpectrumRgba.
        const prev = this.lastRgba;
        rgba = new Uint8Array(msg.rgba);
        this.lastRgba = rgba;
        this.rgbaSeq++;
        if (prev && prev.byteLength === msg.rgba.byteLength && prev.buffer !== msg.rgba) {
          recycle = prev.buffer as ArrayBuffer;
        }
      }
      const cpu = this.engine.cpu;
      cpu.pc = msg.pc;
      cpu.sp = msg.sp;
      cpu.a = msg.a;
      cpu.f = msg.f;
      cpu.b = msg.b;
      cpu.c = msg.c;
      cpu.d = msg.d;
      cpu.e = msg.e;
      cpu.h = msg.h;
      cpu.l = msg.l;
      cpu.ix = msg.ix;
      cpu.iy = msg.iy;
      cpu.i = msg.i;
      cpu.r = msg.r;
      cpu.im = msg.im;
      cpu.iff1 = msg.iff1;
      cpu.iff2 = msg.iff2;
      cpu.halted = msg.halted;
      this.engine.running = msg.running;
      this.engine.breakpointHit = msg.breakpointHit;
      this.engine.breakWriteHit = msg.breakWriteHit;
      this.engine.mmu.port7ffd = msg.port7ffd;
      this.engine.mmu.trdosPaged = msg.trdosPaged;
      this.engine.contended.waitUnits = msg.contendedWaits;
      this.engine.contended.hits = msg.contendedHits;
      this.engine.ay.loadRegs(new Uint8Array(msg.ayRegs), msg.aySelected, msg.ayEnvWrites);
      this.engine.watchAddr = msg.watchAddr;
      this.lastWatchBytes = new Uint8Array(msg.watchBytes);
      this.engine.ula.border = msg.border & 7;
      this.lastSoftError = msg.softError;
      if (msg.softError) this.engine.softError = msg.softError;
      // Keep main-thread tape browser in sync with Worker flash-load progress
      if (this.engine.tape && typeof msg.tapePos === 'number') {
        this.engine.tape.seek(msg.tapePos);
      }
      const frame: SpectrumHostFrame = {
        rgba: rgba ?? new Uint8Array(0),
        rgbaChanged: !!msg.rgba,
        audio: msg.audio ? new Float32Array(msg.audio) : null,
        frameSeq: msg.frameSeq ?? 0,
        beeper: { startEar: msg.beeperStart, transitions: msg.beeperTransitions },
        ayRegs: new Uint8Array(msg.ayRegs),
        aySelected: msg.aySelected,
        ayEnvWrites: msg.ayEnvWrites ?? 0,
        tStates: msg.tStates,
        breakpointHit: msg.breakpointHit,
        breakWriteHit: msg.breakWriteHit,
        running: msg.running,
        tapePos: msg.tapePos,
        tapeBlocks: msg.tapeBlocks,
        contendedWaits: msg.contendedWaits,
        contendedHits: msg.contendedHits,
        fromWorker: true,
      };
      this.pendingFrame = frame;
      this.lastFrameAt = performance.now();
      this.lastWorkerFrameAt = this.lastFrameAt;
      this.workerAnswered = true;
      this.onFrame?.(frame);
      if (recycle) this.post({ type: 'recycleRgba', buf: recycle }, [recycle]);
    }
  }

  boot(model: SpectrumModel): void {
    this.engine.boot(model);
    this.lastSoftError = null;
    this.post({ type: 'boot', model });
  }

  bootTrdos(): void {
    this.engine.bootTrdos();
    this.post({ type: 'bootTrdos' });
  }

  setRunning(on: boolean): void {
    this.engine.running = on;
    this.fbLastMs = 0;
    this.fbAccMs = 0;
    this.lastWorkerFrameAt = on ? performance.now() : 0;
    this.post({ type: 'setRunning', on });
  }

  /** Output rate of the audio sink; frames are synthesized at this rate. */
  setAudioSampleRate(rate: number): void {
    if (!(rate > 0) || !Number.isFinite(rate)) return;
    this.engine.audioSampleRate = rate;
    this.post({ type: 'setAudioSampleRate', rate });
  }

  setAudioEnabled(on: boolean): void {
    this.engine.audioEnabled = on;
    this.post({ type: 'setAudioEnabled', on });
  }

  /** Stop rendering pictures while the Spectrum pane is hidden. */
  setVideoEnabled(on: boolean): void {
    this.videoEnabled = on;
    if (on) this.engine.invalidateRender();
    this.post({ type: 'setVideoEnabled', on });
  }

  setTurbo(t: SpectrumTurbo): void {
    this.engine.setTurbo(t);
    this.post({ type: 'setTurbo', turbo: t });
  }

  setBreakpointPc(pc: number | null): void {
    this.engine.setBreakpointPc(pc);
    this.post({ type: 'setBreakpointPc', pc });
  }

  setBreakWriteAddr(addr: number | null): void {
    this.engine.setBreakWriteAddr(addr);
    this.post({ type: 'setBreakWriteAddr', addr });
  }

  poke(addr: number, val: number): void {
    this.engine.poke(addr, val);
    this.post({ type: 'poke', addr, val });
  }

  setKey(label: string, down: boolean): void {
    this.engine.setKey(label, down);
    this.post({ type: 'setKey', label, down });
  }

  clearKeys(): void {
    this.engine.ula.clearKeys();
    this.post({ type: 'clearKeys' });
  }

  setWatchAddr(addr: number): void {
    this.engine.watchAddr = addr & 0xffff;
    this.post({ type: 'setWatchAddr', addr: addr & 0xffff });
  }

  setKempston(bit: 0 | 1 | 2 | 3 | 4, down: boolean): void {
    this.engine.setKempston(bit, down);
    this.post({ type: 'setKempston', bit, down });
  }

  step(): void {
    if (this.usingWorker) this.post({ type: 'step' });
    else this.engine.step();
  }

  stepOver(): void {
    if (this.usingWorker) this.post({ type: 'stepOver' });
    else this.engine.stepOver();
  }

  nmi(): void {
    if (this.usingWorker) this.post({ type: 'nmi' });
    else this.engine.nmi();
  }

  rewindTape(): void {
    this.engine.tape?.reset();
    this.post({ type: 'rewindTape' });
  }

  advanceTape(): void {
    this.engine.tape?.next();
    this.post({ type: 'advanceTape' });
  }

  seekTape(index: number): void {
    this.engine.tape?.seek(index);
    this.post({ type: 'seekTape', index });
  }

  setTapePaused(on: boolean): void {
    this.engine.tapePaused = on;
    this.post({ type: 'setTapePaused', on });
  }

  setTapeAutoStop(on: boolean): void {
    this.engine.tapeAutoStop = on;
    this.post({ type: 'setTapeAutoStop', on });
  }

  enqueueTape(item: { name: string; kind: 'tap' | 'tzx'; data: Uint8Array }): void {
    this.engine.enqueueTape(item);
    const buf = item.data.buffer.slice(
      item.data.byteOffset,
      item.data.byteOffset + item.data.byteLength,
    ) as ArrayBuffer;
    this.post({ type: 'enqueueTape', name: item.name, kind: item.kind, data: buf }, [buf]);
  }

  clearTapeQueue(): void {
    this.engine.clearTapeQueue();
    this.post({ type: 'clearTapeQueue' });
  }

  /**
   * Called once per display frame (rAF). Worker path: the Worker clocks itself
   * at 50 Hz and frames arrive via `onFrame`; this just hands the newest one to
   * the caller for display (or null when none arrived since the last call).
   * Fallback path: advance the in-page engine by however many 20 ms frames of
   * wall-clock elapsed (capped), so a 144 Hz display does not run the machine
   * at 288 %.
   */
  tick(wantRgba: boolean): SpectrumHostFrame | null {
    if (this.usingWorker) {
      const now = performance.now();
      // rAF stops in a background tab; the gap that follows says nothing about the Worker.
      if (this.lastTickAt !== 0 && now - this.lastTickAt > SpectrumWorkerHost.HANG_MS / 2) this.lastWorkerFrameAt = now;
      this.lastTickAt = now;
      const hangMs = this.workerAnswered ? SpectrumWorkerHost.HANG_MS : SpectrumWorkerHost.FIRST_FRAME_MS;
      if (this.engine.running && this.lastWorkerFrameAt !== 0 && now - this.lastWorkerFrameAt > hangMs) {
        this.recoverHungWorker(now);
        return null;
      }
      // Recover if the Worker loop never started (e.g. setRunning raced the
      // Worker script load, or the tab resumed with running=true).
      if (this.engine.running && this.lastFrameAt !== 0 && performance.now() - this.lastFrameAt > 400) {
        this.post({ type: 'setRunning', on: true });
        this.lastFrameAt = performance.now();
      } else if (this.engine.running && this.lastFrameAt === 0) {
        this.post({ type: 'setRunning', on: true });
        this.lastFrameAt = performance.now();
      }
      const f = this.pendingFrame;
      this.pendingFrame = null;
      return f;
    }
    const now = performance.now();
    if (this.fbLastMs === 0) this.fbLastMs = now - SpectrumWorkerHost.FRAME_MS;
    let dt = now - this.fbLastMs;
    this.fbLastMs = now;
    if (dt > SpectrumWorkerHost.FRAME_MS * 6) dt = SpectrumWorkerHost.FRAME_MS; // long stall: drop time
    this.fbAccMs += dt;
    let frames = Math.floor(this.fbAccMs / SpectrumWorkerHost.FRAME_MS);
    if (frames > SpectrumWorkerHost.FB_MAX_CATCHUP) {
      frames = SpectrumWorkerHost.FB_MAX_CATCHUP;
      this.fbAccMs = 0;
    } else {
      this.fbAccMs -= frames * SpectrumWorkerHost.FRAME_MS;
    }
    let last: SpectrumHostFrame | null = null;
    for (let i = 0; i < frames; i++) {
      this.fbFramesSinceRgba++;
      const render =
        wantRgba && i === frames - 1 && this.fbFramesSinceRgba >= Math.max(1, this.engine.frameSkip);
      const r = this.engine.tickFrame(render);
      this.lastSoftError = this.engine.softError;
      if (render) {
        this.fbFramesSinceRgba = 0;
        if (r.rgbaChanged) {
          this.lastRgba = r.rgba;
          this.rgbaSeq++;
        }
      }
      last = { ...r, fromWorker: false };
      this.onFrame?.(last);
      if (!r.running) break;
    }
    return last;
  }

  /**
   * The Worker holds the emulated RAM, so a replacement starts from a cold boot of the
   * same model with the main thread's settings; the running program is lost.
   */
  private recoverHungWorker(now: number): void {
    const model = this.engine.mmu.model || '48';
    this.restartTimes = this.restartTimes.filter((t) => now - t < SpectrumWorkerHost.RESTART_WINDOW_MS);
    const giveUp = this.restartTimes.length >= SpectrumWorkerHost.MAX_RESTARTS;
    this.restartTimes.push(now);
    this.fallbackToMain();
    this.lastFrameAt = 0;
    this.lastWorkerFrameAt = 0;
    if (giveUp) {
      this.engine.running = false;
      this.onWorkerRecovery?.('stopped');
      return;
    }
    this.start();
    this.boot(model);
    this.post({ type: 'setAudioSampleRate', rate: this.engine.audioSampleRate });
    this.post({ type: 'setAudioEnabled', on: this.engine.audioEnabled });
    this.post({ type: 'setVideoEnabled', on: this.videoEnabled });
    this.post({ type: 'setTurbo', turbo: this.engine.turbo });
    this.post({ type: 'setBreakpointPc', pc: this.engine.breakpointPc });
    this.post({ type: 'setBreakWriteAddr', addr: this.engine.breakWriteAddr });
    this.post({ type: 'setWatchAddr', addr: this.engine.watchAddr });
    this.setRunning(true);
    this.lastFrameAt = now;
    this.lastWorkerFrameAt = now;
    this.onWorkerRecovery?.('restarted');
  }

  mountTap(data: Uint8Array, cold = false) {
    const r = this.engine.mountTap(data, cold);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'mountTap', data: buf, cold }, [buf]);
    return r;
  }

  mountTzx(data: Uint8Array, cold = false) {
    const r = this.engine.mountTzx(data, cold);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'mountTzx', data: buf, cold }, [buf]);
    return r;
  }

  mountTrd(data: Uint8Array): TrdInfo {
    const trd = this.engine.mountTrd(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'mountTrd', data: buf }, [buf]);
    return trd;
  }

  loadSna(data: Uint8Array) {
    const r = this.engine.loadSna(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'loadSna', data: buf }, [buf]);
    return r;
  }

  loadZ80(data: Uint8Array) {
    const r = this.engine.loadZ80(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'loadZ80', data: buf }, [buf]);
    return r;
  }

  loadScr(data: Uint8Array): void {
    this.engine.loadScr(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'loadScr', data: buf }, [buf]);
  }

  setRom48Basic(on: boolean): void {
    this.engine.setRom48Basic(on);
    this.post({ type: 'setRom48Basic', on });
  }

  /** Snapshot from the live engine (Worker when active). */
  async getSnapshot(timeoutMs = 5_000): Promise<SpectrumSnapshotBundle> {
    if (!this.usingWorker) {
      return {
        sna: this.engine.saveSna(),
        z80: this.engine.saveZ80(),
        scr: this.engine.saveScr(),
      };
    }
    if (this.pendingSnapshot) {
      clearTimeout(this.pendingSnapshot.timer);
      this.pendingSnapshot.reject(new Error('Superseded snapshot request'));
      this.pendingSnapshot = null;
    }
    return new Promise<SpectrumSnapshotBundle>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingSnapshot) {
          this.pendingSnapshot = null;
          reject(new Error('Spectrum snapshot timeout'));
        }
      }, timeoutMs);
      this.pendingSnapshot = { resolve, reject, timer };
      this.post({ type: 'getSnapshot' });
    });
  }

  /** Mirror the live AY registers onto a display chip (envelope retriggers via write counter). */
  syncAyTo(chip: Ay8912): void {
    chip.loadRegs(this.engine.ay.regs, this.engine.ay.selected, this.engine.ay.envWrites);
  }
}
