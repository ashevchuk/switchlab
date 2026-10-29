/**
 * Spectrum soft-run Worker entry (classic script compatible).
 * Built to dist-file/spectrum-worker.js for file:// loads.
 *
 * Timing model: the Worker owns the 50 Hz Spectrum clock. `setRunning(true)`
 * starts a self-scheduled frame loop (drift-corrected `setTimeout`) that
 * posts one `frame` message per emulated frame regardless of the main
 * thread's rAF rate, so a 60/144 Hz display neither speeds the machine up nor
 * queues stale tick requests behind a slow UI frame. The main thread only
 * consumes: latest picture for the canvas, every audio frame for the sink.
 */

import { SPEC_FRAME_H, SPEC_FRAME_W } from './video.js';
import { SpectrumEngine } from './engine.js';
import type { WorkerInMsg, WorkerOutMsg } from './workerProtocol.js';

const engine = new SpectrumEngine();

const FRAME_MS = 20;
/** Frames we are willing to run back-to-back to catch up after a stall. */
const MAX_CATCHUP = 3;
/** Beyond this lag we drop time instead of catching up (tab was hidden). */
const MAX_LAG_MS = 120;
const RGBA_BYTES = SPEC_FRAME_W * SPEC_FRAME_H * 4;

/** Recycled RGBA transfer buffers (main thread posts them back after use). */
const rgbaPool: ArrayBuffer[] = [];
const RGBA_POOL_MAX = 3;
/** Outstanding transferred pictures the main thread has not recycled yet. */
let rgbaInFlight = 0;
const RGBA_IN_FLIGHT_MAX = 2;

let loopEnabled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextDue = 0;
let videoEnabled = true;
/** Frames since the last RGBA post — drives turbo frame skip. */
let framesSinceRgba = 0;

function post(msg: WorkerOutMsg, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function takeRgbaBuffer(): Uint8Array | null {
  const buf = rgbaPool.pop();
  if (buf) return new Uint8Array(buf);
  if (rgbaInFlight >= RGBA_IN_FLIGHT_MAX) return null;
  return new Uint8Array(new ArrayBuffer(RGBA_BYTES));
}

/** Run one frame and post it. Returns false when the engine stopped itself. */
function runFrame(): boolean {
  framesSinceRgba++;
  let wantRgba = videoEnabled && framesSinceRgba >= Math.max(1, engine.frameSkip);
  const target = wantRgba ? takeRgbaBuffer() : null;
  if (wantRgba && !target) wantRgba = false;
  const r = engine.tickFrame(wantRgba, target ?? undefined);
  const transfer: Transferable[] = [];
  const ay = r.ayRegs.buffer as ArrayBuffer;
  const watch = new Uint8Array(64);
  const wa = engine.watchAddr & 0xffff;
  for (let i = 0; i < 64; i++) watch[i] = engine.mmu.read((wa + i) & 0xffff);
  const cpu = engine.cpu;
  const out: WorkerOutMsg = {
    type: 'frame',
    frameSeq: r.frameSeq,
    ayRegs: ay,
    aySelected: r.aySelected,
    ayEnvWrites: r.ayEnvWrites,
    tStates: r.tStates,
    beeperStart: r.beeper.startEar,
    beeperTransitions: r.beeper.transitions,
    breakpointHit: r.breakpointHit,
    breakWriteHit: r.breakWriteHit,
    running: r.running,
    tapePos: r.tapePos,
    tapeBlocks: r.tapeBlocks,
    contendedWaits: r.contendedWaits,
    contendedHits: r.contendedHits,
    pc: cpu.pc,
    sp: cpu.sp,
    a: cpu.a,
    f: cpu.f,
    b: cpu.b,
    c: cpu.c,
    d: cpu.d,
    e: cpu.e,
    h: cpu.h,
    l: cpu.l,
    ix: cpu.ix,
    iy: cpu.iy,
    i: cpu.i,
    r: cpu.r,
    im: cpu.im,
    iff1: cpu.iff1,
    iff2: cpu.iff2,
    halted: cpu.halted,
    model: engine.mmu.model,
    trdosPaged: engine.mmu.trdosPaged,
    port7ffd: engine.mmu.port7ffd,
    watchAddr: wa,
    watchBytes: watch.buffer,
    border: engine.ula.border & 7,
    softError: engine.softError,
  };
  transfer.push(ay, watch.buffer);
  if (wantRgba) {
    framesSinceRgba = 0;
    if (r.rgbaChanged && target) {
      out.rgba = target.buffer as ArrayBuffer;
      transfer.push(target.buffer as ArrayBuffer);
      rgbaInFlight++;
    } else if (target) {
      // Nothing changed — keep the buffer for a later frame.
      if (rgbaPool.length < RGBA_POOL_MAX) rgbaPool.push(target.buffer as ArrayBuffer);
    }
  }
  if (r.audio) {
    out.audio = r.audio.buffer as ArrayBuffer;
    transfer.push(r.audio.buffer as ArrayBuffer);
  }
  post(out, transfer);
  return r.running;
}

function stopLoop(): void {
  loopEnabled = false;
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function startLoop(): void {
  if (loopEnabled) return;
  loopEnabled = true;
  nextDue = performance.now();
  scheduleNext();
}

function scheduleNext(): void {
  if (timer != null) return;
  const delay = Math.max(0, nextDue - performance.now());
  timer = setTimeout(loopTick, delay);
}

function loopTick(): void {
  timer = null;
  if (!loopEnabled) return;
  let now = performance.now();
  if (now - nextDue > MAX_LAG_MS) nextDue = now; // long stall: drop lost time
  let ran = 0;
  while (now >= nextDue && ran < MAX_CATCHUP) {
    if (!runFrame()) {
      // Breakpoint / soft error / tape auto-stop: the frame carried running=false.
      stopLoop();
      return;
    }
    nextDue += FRAME_MS;
    ran++;
    now = performance.now();
  }
  if (now >= nextDue) nextDue = now; // still behind after catch-up: resync
  scheduleNext();
}

function onMsg(ev: MessageEvent<WorkerInMsg>): void {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'boot':
        engine.boot(msg.model);
        break;
      case 'bootTrdos':
        engine.bootTrdos();
        break;
      case 'tick':
        runFrame();
        return;
      case 'step':
        engine.step();
        break;
      case 'stepOver':
        engine.stepOver();
        break;
      case 'nmi':
        engine.nmi();
        break;
      case 'setRunning':
        engine.running = msg.on;
        if (msg.on) startLoop();
        else stopLoop();
        break;
      case 'recycleRgba':
        rgbaInFlight = Math.max(0, rgbaInFlight - 1);
        if (msg.buf.byteLength === RGBA_BYTES && rgbaPool.length < RGBA_POOL_MAX) rgbaPool.push(msg.buf);
        break;
      case 'setAudioSampleRate':
        if (msg.rate > 0 && Number.isFinite(msg.rate)) engine.audioSampleRate = msg.rate;
        break;
      case 'setAudioEnabled':
        engine.audioEnabled = msg.on;
        break;
      case 'setVideoEnabled':
        videoEnabled = msg.on;
        if (msg.on) engine.invalidateRender();
        break;
      case 'setTurbo':
        engine.setTurbo(msg.turbo);
        break;
      case 'setBreakpointPc':
        engine.setBreakpointPc(msg.pc);
        break;
      case 'setBreakWriteAddr':
        engine.setBreakWriteAddr(msg.addr);
        break;
      case 'poke':
        engine.poke(msg.addr, msg.val);
        break;
      case 'setKey':
        engine.setKey(msg.label, msg.down);
        break;
      case 'clearKeys':
        engine.ula.clearKeys();
        break;
      case 'setWatchAddr':
        engine.watchAddr = msg.addr & 0xffff;
        break;
      case 'setKempston':
        engine.setKempston(msg.bit, msg.down);
        break;
      case 'mountTap': {
        const { blocks } = engine.mountTap(new Uint8Array(msg.data), !!msg.cold);
        startLoop();
        post({ type: 'mounted', kind: 'tap', blocks });
        return;
      }
      case 'mountTzx': {
        const { blocks } = engine.mountTzx(new Uint8Array(msg.data), !!msg.cold);
        startLoop();
        post({ type: 'mounted', kind: 'tzx', blocks });
        return;
      }
      case 'mountTrd': {
        const trd = engine.mountTrd(new Uint8Array(msg.data));
        post({ type: 'mounted', kind: 'trd', label: trd.label, sides: trd.sides });
        return;
      }
      case 'enqueueTape':
        engine.enqueueTape({
          name: msg.name,
          kind: msg.kind,
          data: new Uint8Array(msg.data),
        });
        break;
      case 'clearTapeQueue':
        engine.clearTapeQueue();
        break;
      case 'rewindTape':
        engine.tape?.reset();
        break;
      case 'advanceTape':
        engine.tape?.next();
        break;
      case 'seekTape':
        engine.tape?.seek(msg.index);
        break;
      case 'setTapePaused':
        engine.tapePaused = msg.on;
        break;
      case 'setTapeAutoStop':
        engine.tapeAutoStop = msg.on;
        break;
      case 'loadSna':
        engine.loadSna(new Uint8Array(msg.data));
        engine.running = true;
        startLoop();
        break;
      case 'loadZ80':
        engine.loadZ80(new Uint8Array(msg.data));
        engine.running = true;
        startLoop();
        break;
      case 'loadScr':
        engine.loadScr(new Uint8Array(msg.data));
        break;
      case 'setRom48Basic':
        engine.setRom48Basic(msg.on);
        break;
      case 'getMemory': {
        const ram = new Uint8Array(0x10000);
        for (let a = 0; a < 0x10000; a++) ram[a] = engine.mmu.read(a);
        post({ type: 'memory', ram: ram.buffer }, [ram.buffer]);
        return;
      }
      case 'getSnapshot': {
        const sna = engine.saveSna().buffer.slice(0) as ArrayBuffer;
        const z80 = engine.saveZ80().buffer.slice(0) as ArrayBuffer;
        const scr = engine.saveScr().buffer.slice(0) as ArrayBuffer;
        post({ type: 'snapshot', sna, z80, scr }, [sna, z80, scr]);
        return;
      }
      default:
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = onMsg;
