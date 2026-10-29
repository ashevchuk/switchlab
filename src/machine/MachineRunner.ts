import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import { makeInput, makeLabel, wire } from '../sim/library.js';
import type { InputComponent, LedComponent, ChipInstanceComponent, Pin, RamComponent } from '../sim/types.js';
import { createSoftDevices, type SoftDevices } from './softDevices.js';
import { createSoftZ80, softRun, softStep, type SoftMemHooks, type SoftZ80State } from './softZ80.js';
import { softIoLayoutForAddrBits } from './memoryMap.js';
import { ensureSoftState, softLabModelKey } from '../sim/softLab.js';
import { SpectrumUla } from './spectrum/ula.js';
import { isSna128 } from './spectrum/sna.js';
import { peekZ80Model } from './spectrum/z80snap.js';
import type { SpectrumTape } from './spectrum/tap.js';
import { SCR_SIZE } from './spectrum/scr.js';
import { SpectrumMmu, type SpectrumModel } from './spectrum/mmu.js';
import { AyAudio } from './spectrum/ay8912.js';
import { ContendedStub, ExpansionStub, type TrdInfo } from './spectrum/expansions.js';
import { SpectrumWorkerHost } from './spectrum/SpectrumWorkerHost.js';
import {
  SPECTRUM_OPS_PER_FRAME as ENGINE_OPS,
  type SpectrumTurbo as EngineTurbo,
} from './spectrum/engine.js';

type TickFn = () => void;

/**
 * Connect two pins via same-named local labels (short stubs) instead of a
 * drawn point-to-point wire — keeps the top-level canvas readable after
 * the Z80 folds into one chip while Inputs stay outside.
 */
function tieByLabel(circuit: Circuit, name: string, a: Pin, b: Pin): void {
  const la = makeLabel(circuit, name, { x: a.pos.x + 8, y: a.pos.y });
  wire(circuit, a, la.pins.net);
  const lb = makeLabel(circuit, name, { x: b.pos.x + 8, y: b.pos.y });
  wire(circuit, b, lb.pins.net);
}

/**
 * Run modes:
 * - soft: behavioral interpreter on ram.bytes (default — usable TTY)
 * - slow/normal/turbo/free: transistor MachineRunner with a per-frame time budget
 */
export type RunSpeed = 'soft' | 'slow' | 'normal' | 'turbo' | 'free';

/** Soft interpreter instructions per animation frame (generic / CP/M). */
export const SOFT_OPS_PER_FRAME = 8000;

/** Soft ops/frame for Spectrum (BASIC boot needs more throughput). */
export const SPECTRUM_OPS_PER_FRAME = ENGINE_OPS;

/** Soft Spectrum speed multipliers (ops/frame = SPECTRUM_OPS_PER_FRAME * mult). */
export type SpectrumTurbo = EngineTurbo;

/** Max wall-clock ms of gate-level phases per animation frame. */
/** The control FSM takes this many phases per Z80 instruction. */
const GATE_PHASES_PER_INSTRUCTION = 10;

export const GATE_BUDGET_MS = 12;

/** Wider wall-clock budget for free-running gate speed (one frame may burn more CPU). */
export const FREE_BUDGET_MS = 50;

/** Cap on FSM phases per frame when using gate speeds (time budget usually hits first). */
export const PHASES_PER_FRAME: Record<Exclude<RunSpeed, 'soft'>, number> = {
  slow: 2,
  normal: 10,
  turbo: 40,
  free: 400,
};

/**
 * Soft auto-clock / soft interpreter for a placed Z80CPU.
 * Gate path wires Input drivers like the test harness; soft path runs
 * softZ80 against the shared RamComponent.bytes.
 */
export class MachineRunner {
  private circuit: Circuit | null = null;
  private cpu: Z80Cpu | null = null;
  private ram: RamComponent | null = null;
  private tick: TickFn | null = null;
  private inputIds: string[] = [];
  private reset!: InputComponent;
  private aReset!: InputComponent;
  private gatePhasesSinceBoot = 0;
  private boundaryPc: number | null = null;
  /** Called after every tenth gate phase, when the CPU is between two instructions. */
  onInstructionBoundary: (() => void) | null = null;
  /** The Spectrum Worker hung and was replaced ('restarted') or abandoned ('stopped'). */
  onSpectrumWorkerRecovery: ((outcome: 'restarted' | 'stopped') => void) | null = null;
  private dataClk!: InputComponent;
  private phaseClk!: InputComponent;
  private fsmLoad!: InputComponent;
  private seedWes: InputComponent[] = [];
  private booted = false;
  private soft: SoftZ80State | null = null;
  private devices: SoftDevices = createSoftDevices();
  /** Soft ZX Spectrum ULA — when set, softHooks use FE + IRQ (+ 7FFD via MMU). */
  spectrum: SpectrumUla | null = null;
  /** Soft Spectrum memory map (48 or 128). */
  spectrumMmu: SpectrumMmu | null = null;
  /** Mounted .TAP/.TZX for LD-BYTES flash-load (Spectrum mode). */
  spectrumTape: SpectrumTape | null = null;
  /** Soft contended-access counter + wait budget. */
  get contended(): ContendedStub {
    return this.spectrumHost?.engine.contended ?? this._contended;
  }
  private readonly _contended = new ContendedStub();
  /** +2A / DivMMC port stubs. */
  get expansion(): ExpansionStub {
    return this.spectrumHost?.engine.expansion ?? this._expansion;
  }
  private readonly _expansion = new ExpansionStub();
  /** Mounted .TRD image. */
  get trdDisk(): TrdInfo | null {
    return this.spectrumHost?.engine.trdDisk ?? this._trdDisk;
  }
  private _trdDisk: TrdInfo | null = null;
  /** Soft PC breakpoint — freeze Run when PC matches (null = off). */
  get breakpointPc(): number | null {
    return this.spectrumHost?.engine.breakpointPc ?? this._breakpointPc;
  }
  private _breakpointPc: number | null = null;
  /** Set when breakpoint fired this tick. */
  get breakpointHit(): boolean {
    return this.spectrumHost?.engine.breakpointHit ?? this._breakpointHit;
  }
  set breakpointHit(v: boolean) {
    if (this.spectrumHost) this.spectrumHost.engine.breakpointHit = v;
    this._breakpointHit = v;
  }
  private _breakpointHit = false;
  /** Break-on-write address. */
  get breakWriteAddr(): number | null {
    return this.spectrumHost?.engine.breakWriteAddr ?? null;
  }
  /** Spectrum engine + optional Worker host. */
  spectrumHost: SpectrumWorkerHost | null = null;

  /**
   * True for a machine the user placed or booted in a non-Spectrum mode, false for
   * a 64K session restored after a page reload. Run/Reboot only revives a Spectrum
   * for the restored kind.
   */
  isPlacedMachine = false;
  /** Last transferable RGBA from worker/engine (for blit). */
  lastSpectrumRgba: Uint8Array | null = null;
  /** AY + Web Audio (created lazily on first Spectrum frame with sound). */
  readonly ayAudio = new AyAudio();
  /** Soft Spectrum speed multiplier. */
  spectrumTurbo: SpectrumTurbo = 1;
  /** Draw every Nth frame when turbo > 1 (1 = every frame). */
  spectrumFrameSkip = 1;
  private spectrumFrameCounter = 0;
  /** Gate FSM seed deferred while Soft is the active speed. */
  private gateBootPending = false;
  /** True after soft Run has diverged from gate-level PC/regs. */
  softDesynced = false;
  /** Last soft interpreter error (cleared on reboot/boot). */
  softError: string | null = null;
  running = false;
  speed: RunSpeed = 'soft';
  /** Optional gate-level pin reader (from last settle) for halt detection. */
  private readPin: ((pin: Pin) => 0 | 1 | 'Z') | null = null;

  /** Soft Run / Reboot / Load demo need RAM; gate CPU is optional after restore. */
  get attached(): boolean {
    return this.ram !== null;
  }

  /** True when a transistor Z80CPU is wired for Gates speeds. */
  get attachedGate(): boolean {
    return this.circuit !== null && this.cpu !== null && this.tick !== null;
  }

  /** Machine RAM when attached (for I/O map / soft console). */
  get machineRam(): RamComponent | null {
    return this.ram;
  }

  /** Soft CPU when attached (Spectrum engine CPU when in Spectrum mode). */
  get softCpu(): SoftZ80State | null {
    return this.spectrumHost?.engine.cpu ?? this.soft;
  }

  get softDevices(): SoftDevices {
    return this.devices;
  }

  /** Canvas LED driven by soft PORT_LAB_LED (bit0). */
  private labLed: LedComponent | null = null;
  /** Drive Input wired to labLed (Gates path); Soft uses forceOn. */
  private labLedDrive: InputComponent | null = null;
  /** Soft Run host probes — paint IORQ / ioWrite / ioRead / M1 without flatten. */
  private softIorqProbe: InputComponent | null = null;
  private softIoWriteProbe: InputComponent | null = null;
  private softIoReadProbe: InputComponent | null = null;
  private softM1Probe: InputComponent | null = null;
  /** Latched Soft I/O strobes for the current soft instruction. */
  private softIorqPulse = false;
  private softIoWritePulse = false;
  private softIoReadPulse = false;
  private softM1Pulse = false;
  /** Previous gate ioWrite/ioRead levels for rising-edge SoftDevices capture. */
  private lastGateIoWrite = 0;
  private lastGateIoRead = 0;
  /** Soft Lab REG4/REG8 bound to PORT_LAB_REG. */
  private labReg: ChipInstanceComponent | null = null;
  /** Soft Lab COUNTER4 bound to PORT_LAB_COUNTER. */
  private labCounter: ChipInstanceComponent | null = null;
  private library: ChipLibrary | null = null;

  /** True when a lab LED, Soft I/O probe, or Soft Lab chip is bound. */
  get hasLabLed(): boolean {
    return (
      this.labLed !== null ||
      this.labReg !== null ||
      this.labCounter !== null ||
      this.softIorqProbe !== null ||
      this.softIoWriteProbe !== null ||
      this.softIoReadProbe !== null ||
      this.softM1Probe !== null
    );
  }

  /**
   * Bind a canvas LED (+ optional Input) to SoftDevices.labLed / PORT_LAB_LED.
   * Soft Run sets `led.forceOn` and `drive.value` so soft-canvas resolve
   * paints the wire; Gates uses the Input through the transistor step.
   */
  bindLabLed(led: LedComponent, drive?: InputComponent | null): void {
    if (this.labLed && this.labLed !== led) this.labLed.forceOn = false;
    this.labLed = led;
    this.labLedDrive = drive ?? null;
    this.syncLabPeripherals();
  }

  unbindLabLed(): void {
    if (this.labLed) this.labLed.forceOn = false;
    this.labLed = null;
    this.labLedDrive = null;
  }

  /**
   * Bind top-level Inputs that Soft Run pulses on portIn/portOut / fetch (M1).
   * Not electrically tied into the folded Z80CPU bus drivers — host paint only
   * (same semantic names as ChipDef ports for Soft canvas).
   */
  bindSoftIoProbes(opts: {
    iorq?: InputComponent | null;
    ioWrite?: InputComponent | null;
    ioRead?: InputComponent | null;
    m1?: InputComponent | null;
  }): void {
    this.softIorqProbe = opts.iorq ?? null;
    this.softIoWriteProbe = opts.ioWrite ?? null;
    this.softIoReadProbe = opts.ioRead ?? null;
    this.softM1Probe = opts.m1 ?? null;
    this.syncSoftIoProbes();
  }

  unbindSoftIoProbes(): void {
    for (const p of [
      this.softIorqProbe,
      this.softIoWriteProbe,
      this.softIoReadProbe,
      this.softM1Probe,
    ]) {
      if (p) p.value = 0;
    }
    this.softIorqProbe = null;
    this.softIoWriteProbe = null;
    this.softIoReadProbe = null;
    this.softM1Probe = null;
    this.softIorqPulse = false;
    this.softIoWritePulse = false;
    this.softIoReadPulse = false;
    this.softM1Pulse = false;
  }

  bindLabReg(chip: ChipInstanceComponent): void {
    this.labReg = chip;
    this.syncLabPeripherals();
  }

  bindLabCounter(chip: ChipInstanceComponent): void {
    this.labCounter = chip;
    this.syncLabPeripherals();
  }

  unbindLabPeripherals(): void {
    this.unbindLabLed();
    this.unbindSoftIoProbes();
    this.labReg = null;
    this.labCounter = null;
  }

  /** Mirror SoftDevices → LED forceOn / Soft Lab softState.q / Soft I/O probes. */
  syncLabPeripherals(): boolean {
    let changed = this.syncLabLed();
    if (this.syncSoftLabQ(this.labReg, this.devices.labReg, ['REG4', 'REG8'])) changed = true;
    if (this.syncSoftLabQ(this.labCounter, this.devices.labCounter & 0x0f, ['COUNTER4'])) changed = true;
    if (this.syncSoftIoProbes()) changed = true;
    return changed;
  }

  /** @deprecated use syncLabPeripherals */
  syncLabLed(): boolean {
    if (!this.labLed) return false;
    const on = (this.devices.labLed & 1) === 1;
    let changed = false;
    if (this.labLed.forceOn !== on) {
      this.labLed.forceOn = on;
      changed = true;
    }
    if (this.labLedDrive && this.labLedDrive.value !== (on ? 1 : 0)) {
      this.labLedDrive.value = on ? 1 : 0;
      changed = true;
    }
    return changed;
  }

  private syncSoftIoProbes(): boolean {
    let changed = false;
    const apply = (probe: InputComponent | null, on: boolean): void => {
      if (!probe) return;
      const v = on ? 1 : 0;
      if (probe.value !== v) {
        probe.value = v;
        changed = true;
      }
    };
    apply(this.softIorqProbe, this.softIorqPulse);
    apply(this.softIoWriteProbe, this.softIoWritePulse);
    apply(this.softIoReadProbe, this.softIoReadPulse);
    apply(this.softM1Probe, this.softM1Pulse);
    return changed;
  }

  /** Clear Soft I/O strobes before the next soft instruction. */
  private clearSoftIoPulses(): void {
    this.softIorqPulse = false;
    this.softIoWritePulse = false;
    this.softIoReadPulse = false;
    this.softM1Pulse = false;
  }

  private syncSoftLabQ(
    chip: ChipInstanceComponent | null,
    value: number,
    models: string[],
  ): boolean {
    if (!chip || !this.library || !chip.defId || !this.library.has(chip.defId)) return false;
    const key = softLabModelKey(this.library.get(chip.defId).name);
    if (!key || !models.includes(key)) return false;
    const st = ensureSoftState(chip, key);
    let changed = false;
    for (let i = 0; i < st.q.length; i++) {
      const b = ((value >> i) & 1) as 0 | 1;
      if (st.q[i] !== b) {
        st.q[i] = b;
        changed = true;
      }
    }
    return changed;
  }

  get isSpectrum(): boolean {
    return this.spectrum !== null && this.spectrumMmu !== null;
  }

  get spectrumModel(): SpectrumModel | null {
    return this.spectrumMmu?.model ?? null;
  }

  /** Enter or leave soft Spectrum mode (clears CP/M host traps when enabling). */
  setSpectrumMode(on: boolean, model: SpectrumModel = '48'): void {
    if (on) {
      if (!this.spectrumHost) {
        const host = new SpectrumWorkerHost();
        this.spectrumHost = host;
        host.start();
        host.onError = (m) => {
          this.softError = m;
        };
        host.onWorkerRecovery = (outcome) => {
          if (outcome === 'stopped') this.running = false;
          this.onSpectrumWorkerRecovery?.(outcome);
        };
        // Frames arrive on the Worker's 50 Hz clock; audio is queued the
        // moment a frame exists so a slow/absent rAF never starves the sink.
        host.onFrame = (frame) => {
          if (frame.rgbaChanged && frame.rgba.length) this.lastSpectrumRgba = frame.rgba;
          if (frame.breakpointHit || frame.breakWriteHit || !frame.running) this.running = false;
          if (frame.audio) this.ayAudio.playSamples(frame.audio);
        };
        host.setAudioSampleRate(this.ayAudio.sampleRate);
        host.setAudioEnabled(!this.ayAudio.isMuted);
        this.ayAudio.onSampleRate = (rate) => this.spectrumHost?.setAudioSampleRate(rate);
      }
      this.spectrumHost.boot(model);
      this.spectrum = this.spectrumHost.engine.ula;
      this.spectrumMmu = this.spectrumHost.engine.mmu;
      this.soft = this.spectrumHost.engine.cpu;
      this.spectrumTape = this.spectrumHost.engine.tape;
      this.devices.cpm = null;
      this.devices.realCpm = false;
      this.isPlacedMachine = false;
      void this.ayAudio.ensure();
    } else {
      this.isPlacedMachine = true;
      this.spectrumHost?.stop();
      this.spectrumHost = null;
      this.ayAudio.onSampleRate = null;
      this.spectrum = null;
      this.spectrumMmu = null;
      this.spectrumTape = null;
      this._trdDisk = null;
      this._breakpointPc = null;
      this._breakpointHit = false;
      this._contended.reset();
      this._expansion.reset();
      this.lastSpectrumRgba = null;
      this.ayAudio.reset();
    }
  }

  /** Ensure Spectrum mode + ROM + soft CPU; does not clear RAM banks unless mode changes. */
  /** Returns true when a Spectrum was started from power-up here, false when one was already running. */
  ensureSpectrumSoft(model: SpectrumModel = '48'): boolean {
    if (!this.ram || this.ram.bytes.length < 0x10000) {
      throw new Error('Spectrum needs 64K RAM (addrBits=16)');
    }
    const needNew =
      !this.spectrumHost ||
      !this.spectrum ||
      !this.spectrumMmu ||
      this.spectrumMmu.model !== model;
    if (needNew) {
      this.setSpectrumMode(true, model);
    }
    if (!this.booted || !this.soft) {
      this.booted = false;
      this.boot();
    }
    if (this.spectrumHost) {
      this.soft = this.spectrumHost.engine.cpu;
      this.spectrum = this.spectrumHost.engine.ula;
      this.spectrumMmu = this.spectrumHost.engine.mmu;
      this.spectrumTape = this.spectrumHost.engine.tape;
    } else if (!this.soft) {
      this.soft = createSoftZ80(this.softStackTop());
    }
    return needNew;
  }

  /** Load a 48K or 128K .SNA snapshot and start soft Run. */
  loadSpectrumSna(data: Uint8Array): {
    pc: number;
    border: number;
    model: SpectrumModel;
    port7ffd: number;
  } {
    this.ensureSpectrumSoft(isSna128(data) ? '128' : '48');
    const result = this.spectrumHost!.loadSna(data);
    this.soft = this.spectrumHost!.engine.cpu;
    this.spectrum = this.spectrumHost!.engine.ula;
    this.spectrumMmu = this.spectrumHost!.engine.mmu;
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    void this.ayAudio.ensure();
    return result;
  }

  /** Load a .Z80 snapshot (v1/v2/v3) and start soft Run. */
  loadSpectrumZ80(data: Uint8Array): {
    pc: number;
    border: number;
    model: SpectrumModel;
    port7ffd: number;
    version: 1 | 2 | 3;
  } {
    const model = peekZ80Model(data);
    this.ensureSpectrumSoft(model);
    const result = this.spectrumHost!.loadZ80(data);
    this.soft = this.spectrumHost!.engine.cpu;
    this.spectrum = this.spectrumHost!.engine.ula;
    this.spectrumMmu = this.spectrumHost!.engine.mmu;
    this.spectrumHost!.syncAyTo(this.ayAudio.chip);
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    void this.ayAudio.ensure();
    return result;
  }

  private liveMemoryPending = false;

  /**
   * Copy the Spectrum's live address space into the placed RAM so the memory window can show it.
   * Soft only: at Gates speed that RAM is what the transistor Z80 executes from.
   * Returns false when nothing was refreshed (no Spectrum, Gates speed, or a request in flight).
   */
  async refreshLiveMemory(): Promise<boolean> {
    if (!this.spectrumHost || !this.isSoft || !this.ram || this.ram.bytes.length < 0x10000) return false;
    if (this.liveMemoryPending) return false;
    this.liveMemoryPending = true;
    try {
      const memory = await this.spectrumHost.getMemory();
      if (!this.isSoft || !this.ram) return false; // the user switched to Gates while we waited
      this.ram.bytes.set(memory);
      return true;
    } finally {
      this.liveMemoryPending = false;
    }
  }

  /** Serialize current Spectrum state as .SNA bytes (live Worker when active). */
  async saveSpectrumSna(): Promise<Uint8Array> {
    if (!this.spectrumHost) throw new Error('No Spectrum machine to save');
    const snap = await this.spectrumHost.getSnapshot();
    return snap.sna;
  }

  /** Serialize current Spectrum state as .Z80 v3 bytes (includes AY). */
  async saveSpectrumZ80(): Promise<Uint8Array> {
    if (!this.spectrumHost) throw new Error('No Spectrum machine to save');
    const snap = await this.spectrumHost.getSnapshot();
    return snap.z80;
  }

  setSpectrumTurbo(t: SpectrumTurbo): void {
    this.spectrumTurbo = t;
    this.spectrumFrameSkip = t >= 8 ? 3 : t >= 4 ? 2 : 1;
    this.spectrumHost?.setTurbo(t);
  }

  /** True if the UI should redraw the Spectrum screen this animation frame. */
  shouldDrawSpectrumFrame(): boolean {
    if (!this.isSpectrum) return true;
    return this.spectrumRgbaSeq !== this.spectrumDrawnSeq;
  }

  /** Bumps whenever a new Spectrum picture is available (frame skip / static screens keep it flat). */
  get spectrumRgbaSeq(): number {
    return this.spectrumHost?.rgbaSeq ?? 0;
  }

  /** UI reports it has blitted `spectrumRgbaSeq`. */
  markSpectrumDrawn(): void {
    this.spectrumDrawnSeq = this.spectrumRgbaSeq;
  }

  private spectrumDrawnSeq = -1;

  /** Mute/unmute AY + beeper; also stops audio synthesis in the Worker while muted. */
  setSpectrumMuted(muted: boolean): void {
    this.ayAudio.setMuted(muted);
    this.spectrumHost?.setAudioEnabled(!muted);
  }

  /** Tell the engine whether anyone is looking at the picture (skips RGBA renders when hidden). */
  setSpectrumVideoEnabled(on: boolean): void {
    this.spectrumHost?.setVideoEnabled(on);
  }

  /** Mount a .TAP for BASIC `LOAD ""` (flash-load via LD-BYTES trap). */
  mountSpectrumTap(data: Uint8Array): { blocks: number; cold: boolean } {
    const cold = this.spectrum === null || !this.soft || !this.spectrumMmu;
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    const result = this.spectrumHost!.mountTap(data, cold);
    this.spectrumTape = this.spectrumHost!.engine.tape;
    this.soft = this.spectrumHost!.engine.cpu;
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    return result;
  }

  /** Mount a .TZX (standard/turbo data blocks) for flash-load. */
  mountSpectrumTzx(data: Uint8Array): { blocks: number; cold: boolean; warnings: string[] } {
    const cold = this.spectrum === null || !this.soft || !this.spectrumMmu;
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    const result = this.spectrumHost!.mountTzx(data, cold);
    this.spectrumTape = this.spectrumHost!.engine.tape;
    this.soft = this.spectrumHost!.engine.cpu;
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    return result;
  }

  /** Rewind mounted tape to block 0. */
  rewindSpectrumTape(): void {
    this.spectrumHost?.rewindTape();
    this.spectrumTape = this.spectrumHost?.engine.tape ?? null;
  }

  /** Advance tape position by one block (manual browser). */
  advanceSpectrumTape(): void {
    this.spectrumHost?.advanceTape();
  }

  /** Seek tape to a block index. */
  seekSpectrumTape(index: number): void {
    this.spectrumHost?.seekTape(index);
  }

  get spectrumTapePos(): number {
    return this.spectrumHost?.engine.tape?.pos ?? this.spectrumTape?.pos ?? 0;
  }

  get spectrumTapeBlocks(): { flag: number; length: number }[] {
    const t = this.spectrumHost?.engine.tape ?? this.spectrumTape;
    if (!t) return [];
    return t.blocks.map((b) => ({ flag: b.flag, length: b.data.length }));
  }

  setTapePaused(on: boolean): void {
    this.spectrumHost?.setTapePaused(on);
  }

  get tapePaused(): boolean {
    return this.spectrumHost?.engine.tapePaused ?? false;
  }

  setTapeAutoStop(on: boolean): void {
    this.spectrumHost?.setTapeAutoStop(on);
  }

  enqueueSpectrumTape(name: string, kind: 'tap' | 'tzx', data: Uint8Array): void {
    this.spectrumHost?.enqueueTape({ name, kind, data });
  }

  clearSpectrumTapeQueue(): void {
    this.spectrumHost?.clearTapeQueue();
  }

  get spectrumTapeQueueLength(): number {
    return this.spectrumHost?.engine.tapeQueue.length ?? 0;
  }

  /** Save visible display file as .SCR (6912 bytes). */
  async saveSpectrumScr(): Promise<Uint8Array> {
    if (!this.spectrumHost) throw new Error('No Spectrum machine to save');
    const snap = await this.spectrumHost.getSnapshot();
    return snap.scr;
  }

  /** Load .SCR into visible display bank. */
  loadSpectrumScr(data: Uint8Array): void {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    this.spectrumHost!.loadScr(data);
    this.softDesynced = true;
  }

  /** Mount a .TRD image (Beta Disk sector I/O). */
  mountSpectrumTrd(data: Uint8Array): TrdInfo {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '128');
    const trd = this.spectrumHost!.mountTrd(data);
    this._trdDisk = trd;
    return trd;
  }

  /** Boot TR-DOS ROM at $0000. */
  bootSpectrumTrdos(): void {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '128');
    this.spectrumHost!.bootTrdos();
    this.soft = this.spectrumHost!.engine.cpu;
    this.spectrumMmu = this.spectrumHost!.engine.mmu;
    this.running = true;
    this.spectrumHost!.setRunning(true);
  }

  /** 128K: switch to 48 BASIC ROM (bit4) or editor. */
  setSpectrumRom48Basic(on: boolean): void {
    this.spectrumHost?.setRom48Basic(on);
  }

  setBreakpointPc(pc: number | null): void {
    this._breakpointPc = pc == null ? null : pc & 0xffff;
    this._breakpointHit = false;
    this.spectrumHost?.setBreakpointPc(pc);
  }

  setBreakWriteAddr(addr: number | null): void {
    this.spectrumHost?.setBreakWriteAddr(addr);
  }

  pokeSpectrum(addr: number, val: number): void {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    this.spectrumHost!.poke(addr, val);
  }

  stepSpectrumOver(): void {
    this.spectrumHost?.stepOver();
    if (this.spectrumHost) this.soft = this.spectrumHost.engine.cpu;
  }

  /** Soft or gate NMI → $0066. */
  pulseSpectrumNmi(): void {
    if (!this.isSoft && this.cpu) {
      // Gate: rising edge sampled at PHASE0 — hold high across a couple of phases.
      this.cpu.nmiDrive.value = 1;
      this.stepPhase();
      this.stepPhase();
      this.cpu.nmiDrive.value = 0;
      return;
    }
    if (!this.spectrumHost) throw new Error('No soft CPU');
    this.spectrumHost.nmi();
    this.soft = this.spectrumHost.engine.cpu;
    this.softDesynced = true;
  }

  /** Drive gate int from Spectrum ULA irqPending; clear after accept. */
  private syncSpectrumGateInt(): void {
    if (!this.spectrum || !this.cpu || this.isSoft) return;
    const pending = this.spectrum.irqPending;
    this.cpu.intDrive.value = pending ? 1 : 0;
  }

  /** After a gate instruction, clear ULA IRQ once INT was accepted (IFF1 was on, now off). */
  private clearSpectrumIrqIfAccepted(wasPending: boolean, iff1WasOn: boolean): void {
    if (!wasPending || !iff1WasOn || !this.spectrum || !this.cpu || !this.readPin) return;
    if (this.readPin(this.cpu.iff1[0]!) === 0) {
      this.spectrum.clearIrq();
      this.cpu.intDrive.value = 0;
    }
  }

  get scrSize(): number {
    return SCR_SIZE;
  }

  private softHooks(): SoftMemHooks {
    if (this.spectrumHost && this.spectrum && this.spectrumMmu) {
      return this.spectrumHost.engine.hooks();
    }
    const ram = this.ram!;
    const dev = this.devices;
    const layout = softIoLayoutForAddrBits(ram.addrBits);
    return {
      clearOnReadKeys: true,
      addrBits: layout.addrBits,
      keyDataAddr: layout.keyData,
      keyStatusAddr: layout.keyStatus,
      portIn: (port) => {
        this.softIorqPulse = true;
        this.softIoReadPulse = true;
        return dev.portIn(ram.bytes, port);
      },
      portOut: (port, val) => {
        this.softIorqPulse = true;
        this.softIoWritePulse = true;
        return dev.portOut(ram.bytes, port, val);
      },
      portInBlock: (port) => ((port & 0xff) === 0x01 ? dev.coninWouldBlock() : false),
      hostTrap: (cpu, bytes) => {
        const cpm = dev.cpm;
        if (!cpm) return false;
        return cpm.handleTrap(cpu, bytes, dev);
      },
    };
  }

  private softStackTop(): number {
    if (this.spectrum) return 0xffff;
    return softIoLayoutForAddrBits(this.ram?.addrBits ?? 12).stackTop;
  }

  get isSoft(): boolean {
    return this.speed === 'soft';
  }

  /** Program counter of the gate-level CPU as of the last instruction boundary; null in Soft mode. */
  get gatePc(): number | null {
    return this.isSoft ? null : this.boundaryPc;
  }

  /** Between two instructions every PC bit has settled; mid-instruction the bits flip one by one. */
  private readGatePc(): number | null {
    if (!this.cpu || !this.readPin) return null;
    let pc = 0;
    for (const [i, pin] of this.cpu.pc.entries()) {
      const level = this.readPin(pin);
      if (level !== 0 && level !== 1) return null;
      pc |= level << i;
    }
    return pc;
  }

  get phasesPerFrame(): number {
    if (this.speed === 'soft') {
      if (this.spectrum) {
        return Math.max(1000, Math.floor(SPECTRUM_OPS_PER_FRAME * this.spectrumTurbo));
      }
      return SOFT_OPS_PER_FRAME;
    }
    return PHASES_PER_FRAME[this.speed];
  }

  setSpeed(speed: RunSpeed): void {
    // Soft-only sessions (post-reload) have no gate CPU — stay on soft.
    if (speed !== 'soft' && !this.attachedGate) {
      this.speed = 'soft';
      return;
    }
    const prev = this.speed;
    this.speed = speed;
    // Soft attach defers transistor boot — complete it the first time Gates is selected.
    if (prev === 'soft' && speed !== 'soft' && this.gateBootPending) {
      this.gateBootPending = false;
      this.booted = false;
      this.boot();
    }
    // Spectrum Gates: start the transistor CPU on the memory the Spectrum has right now.
    if (prev === 'soft' && speed !== 'soft' && this.isSpectrum) {
      this.loadGateRamFromLive();
    }
  }

  private gateRamPending = false;

  /**
   * One copy, at the moment of the switch: from then on the placed RAM belongs to the gate-level Z80,
   * and only the display file goes back to the emulator. Gate steps wait until the copy has arrived.
   */
  private loadGateRamFromLive(): void {
    const host = this.spectrumHost;
    if (!host || !this.ram || this.ram.bytes.length < 0x10000) return;
    this.gateRamPending = true;
    host
      .getMemory()
      .then((memory) => {
        if (this.ram && !this.isSoft) this.ram.bytes.set(memory);
      })
      // Worker unreachable: the in-page engine's cold copy is better than an empty RAM.
      .catch(() => this.mirrorSpectrumToGateRam())
      .finally(() => {
        this.gateRamPending = false;
      });
  }

  /**
   * Spectrum Gates MVP: copy MMU ROM + visible RAM into `cpu.ram.bytes` so the
   * gate Z80 fetches Spectrum memory. Soft ULA still owns video + IRQ.
   */
  mirrorSpectrumToGateRam(): void {
    if (!this.spectrumMmu || !this.ram || this.ram.bytes.length < 0x10000) return;
    this.spectrumMmu.mirrorToFlatRam(this.ram.bytes);
  }

  /**
   * After gate steps, push dirty display-file bytes back into the MMU so soft
   * ULA video can update (full FET Spectrum video is out of scope).
   */
  private writeBackSpectrumDisplayFromGateRam(): void {
    if (!this.spectrumMmu || !this.ram || this.ram.bytes.length < 0x10000) return;
    this.spectrumMmu.writeBackFromFlatRam(this.ram.bytes, 0x4000, 0x5b00);
  }

  /**
   * Wire clocks/reset/FSM seed/lean register zero-seeds beside the CPU.
   * Call `boot()` once afterward before Run/Step.
   *
   * Inputs sit in a compact grid next to RAM (not thousands of units away).
   * Connections use net labels so the post-fold top view does not grow a
   * "noodle" of Input→chip-port wires across the canvas.
   */
  attach(
    circuit: Circuit,
    library: ChipLibrary,
    cpu: Z80Cpu,
    tick: TickFn,
    opts?: { readPin?: (pin: Pin) => 0 | 1 | 'Z' },
  ): void {
    this.detach();
    this.isPlacedMachine = true;
    this.circuit = circuit;
    this.library = library;
    this.cpu = cpu;
    this.ram = cpu.ram;
    this.tick = tick;
    this.readPin = opts?.readPin ?? null;

    // Beside RAM / the eventual folded chip — old `y - 12000` parked seeds
    // far above the sprawling flat composite and became the visible spaghetti
    // once everything folded into one Z80CPU box.
    const base = { x: cpu.ram.pos.x - 360, y: cpu.ram.pos.y - 40 };
    let row = 0;
    const place = (value: 0 | 1): InputComponent => {
      const inp = makeInput(circuit, value, {
        x: base.x + (row % 6) * 44,
        y: base.y + Math.floor(row / 6) * 32,
      });
      row++;
      this.inputIds.push(inp.id);
      return inp;
    };
    let tieN = 0;
    const tie = (inp: InputComponent, pin: Pin, hint: string) => {
      tieByLabel(circuit, `RUN_${hint}_${tieN++}`, inp.pins.out, pin);
    };

    this.reset = place(1);
    tie(this.reset, cpu.reset, 'RESET');
    this.aReset = place(1);
    tie(this.aReset, cpu.aReset, 'ARESET');
    this.dataClk = place(0);
    tie(this.dataClk, cpu.clk, 'CLK');
    this.phaseClk = place(0);
    tie(this.phaseClk, cpu.phaseClk, 'PCLK');
    this.fsmLoad = place(1);
    tie(this.fsmLoad, cpu.fsmLoad, 'FSMLOAD');
    for (let i = 0; i < cpu.fsmD.length; i++) {
      const d = place(i === 0 ? 1 : 0);
      tie(d, cpu.fsmD[i]!, `FSMD${i}`);
    }

    this.seedWes = [];
    const seedReg = (reg: { we: Pin; d: Pin[] }, tag: string, width = 8) => {
      const we = place(1);
      tie(we, reg.we, `${tag}_WE`);
      this.seedWes.push(we);
      for (let i = 0; i < width; i++) {
        const bit = place(0);
        tie(bit, reg.d[i]!, `${tag}${i}`);
      }
    };

    seedReg(cpu.rB, 'B');
    seedReg(cpu.rC, 'C');
    seedReg(cpu.rD, 'D');
    seedReg(cpu.rE, 'E');
    seedReg(cpu.rH, 'H');
    seedReg(cpu.rL, 'L');
    seedReg(cpu.sp, 'SP', cpu.sp.d.length);

    this.booted = false;
    this.running = false;
    this.soft = null;
    this.devices = createSoftDevices();
    this.spectrum = null;
    this.spectrumMmu = null;
    this.spectrumTape = null;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
  }

  /**
   * Soft-only reattach after project restore / TTY open (folded canvas has
   * RAM but no live Z80Cpu handle). Enables Run / Reboot / Load demo without
   * re-placing Inputs for the gate path.
   */
  attachSoft(ram: RamComponent, opts?: { library?: ChipLibrary | null }): void {
    this.detach();
    this.circuit = null;
    this.library = opts?.library ?? null;
    this.cpu = null;
    this.ram = ram;
    this.tick = null;
    this.readPin = null;
    this.boundaryPc = null;
    this.booted = false;
    this.running = false;
    this.soft = null;
    this.devices = createSoftDevices();
    this.spectrum = null;
    this.spectrumMmu = null;
    this.spectrumTape = null;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
    this.speed = 'soft';
  }

  detach(): void {
    this.isPlacedMachine = false;
    this.running = false;
    this.booted = false;
    this.soft = null;
    this.unbindLabPeripherals();
    this.devices = createSoftDevices();
    this.spectrum = null;
    this.spectrumMmu = null;
    this.spectrumTape = null;
    this.spectrumHost?.stop();
    this.spectrumHost = null;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
    if (this.circuit) {
      for (const id of this.inputIds) this.circuit.removeComponent(id);
    }
    this.inputIds = [];
    this.seedWes = [];
    this.circuit = null;
    this.cpu = null;
    this.ram = null;
    this.tick = null;
    this.readPin = null;
    this.boundaryPc = null;
    this.library = null;
    this.lastGateIoWrite = 0;
    this.lastGateIoRead = 0;
  }

  /** Gate-level boot (FSM seed, reset, first fetch) + soft CPU reset. */
  boot(): void {
    if (this.booted) return;

    // Soft is the interactive default — skip multi-second flatten/step pulses
    // until the user actually selects a Gates speed (see setSpeed).
    // Soft-only restore has RAM but no gate CPU/tick — still boot the interpreter.
    if (this.isSoft) {
      if (!this.ram) return;
      this.booted = true;
      this.soft = createSoftZ80(this.softStackTop());
      // Keep SoftDisks + SoftCpm / realCpm across reboot so CP/M files survive.
      const prevDisks = this.devices?.disks;
      const prevCpm = this.devices?.cpm ?? null;
      const prevReal = this.devices?.realCpm ?? false;
      this.devices = createSoftDevices(prevDisks?.[0]);
      if (prevDisks) {
        for (let i = 1; i < prevDisks.length; i++) {
          if (prevDisks[i]) this.devices.setDrive(i, prevDisks[i]!);
        }
      }
      this.devices.cpm = prevCpm;
      this.devices.realCpm = prevReal;
      this.softDesynced = false;
      this.softError = null;
      this.gateBootPending = this.attachedGate;
      return;
    }

    if (!this.tick || !this.cpu) return;
    const tick = this.tick;
    const pulse = (sig: InputComponent) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };

    tick();
    pulse(this.phaseClk);
    this.fsmLoad.value = 0;
    pulse(this.dataClk);
    this.reset.value = 0;
    this.aReset.value = 0;
    for (const we of this.seedWes) we.value = 0;
    pulse(this.dataClk);
    this.booted = true;
    this.gatePhasesSinceBoot = 0;
    this.soft = createSoftZ80(this.softStackTop());
    const prevDisks = this.devices?.disks;
    const prevCpm = this.devices?.cpm ?? null;
    const prevReal = this.devices?.realCpm ?? false;
    this.devices = createSoftDevices(prevDisks?.[0]);
    if (prevDisks) {
      for (let i = 1; i < prevDisks.length; i++) {
        if (prevDisks[i]) this.devices.setDrive(i, prevDisks[i]!);
      }
    }
    this.devices.cpm = prevCpm;
    this.devices.realCpm = prevReal;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
    if (this.isSpectrum) this.mirrorSpectrumToGateRam();
  }

  /**
   * Soft/gate cold start. When Spectrum is active, reboots the Spectrum
   * engine (ROM @0000, clear tape/AY/beta) instead of creating an orphan
   * SoftZ80 that tickBudget would discard.
   */
  onReboot: (() => void) | null = null;

  reboot(): void {
    const wasRunning = this.running;
    this.running = false;
    this.onReboot?.();

    if (this.spectrumHost) {
      const model = this.spectrumMmu?.model ?? this.spectrumHost.engine.mmu.model ?? '48';
      this.spectrumHost.boot(model);
      this.soft = this.spectrumHost.engine.cpu;
      this.spectrum = this.spectrumHost.engine.ula;
      this.spectrumMmu = this.spectrumHost.engine.mmu;
      this.spectrumTape = this.spectrumHost.engine.tape;
      this.booted = true;
      this.softDesynced = true;
      this.softError = null;
      this._breakpointHit = false;
      if (wasRunning) {
        this.running = true;
        this.spectrumHost.setRunning(true);
      }
      return;
    }

    // Soft-only (post-reload): reset the interpreter against attached RAM.
    if (!this.tick || !this.cpu) {
      this.booted = false;
      this.soft = null;
      this.boot();
      if (wasRunning) this.running = true;
      return;
    }

    this.booted = false;
    this.reset.value = 1;
    this.aReset.value = 1;
    this.fsmLoad.value = 1;
    for (const we of this.seedWes) we.value = 1;
    this.dataClk.value = 0;
    this.phaseClk.value = 0;
    this.boot();
    if (wasRunning) this.running = true;
  }

  private pulse(sig: InputComponent): void {
    if (!this.tick) return;
    sig.value = 1;
    this.tick();
    sig.value = 0;
    this.tick();
  }

  /** One FSM phase on the transistor circuit (4 edges). */
  stepPhase(): void {
    if (!this.booted) this.boot();
    this.pulse(this.phaseClk);
    this.pulse(this.dataClk);
    this.syncGatePortDevices();
    if (++this.gatePhasesSinceBoot % GATE_PHASES_PER_INSTRUCTION === 0) {
      this.boundaryPc = this.readGatePc();
      this.onInstructionBoundary?.();
    }
  }

  /**
   * On rising gate `ioWrite` / `ioRead`, mirror into SoftDevices so Gates Run
   * feeds the same port TTY / lab peripherals as Soft Run.
   */
  private syncGatePortDevices(): void {
    if (!this.cpu || !this.readPin || !this.ram) return;
    const wr = this.readPin(this.cpu.ioWrite) === 1 ? 1 : 0;
    const rd = this.readPin(this.cpu.ioRead) === 1 ? 1 : 0;
    if (wr && !this.lastGateIoWrite) {
      let addr = 0;
      let data = 0;
      for (let i = 0; i < this.cpu.ioPortAddr.length; i++) {
        if (this.readPin(this.cpu.ioPortAddr[i]!) === 1) addr |= 1 << i;
      }
      for (let i = 0; i < 8; i++) {
        if (this.readPin(this.cpu.ioPortDataOut[i]!) === 1) data |= 1 << i;
      }
      this.devices.portOut(this.ram.bytes, addr, data);
    }
    if (rd && !this.lastGateIoRead) {
      let addr = 0;
      for (let i = 0; i < this.cpu.ioPortAddr.length; i++) {
        if (this.readPin(this.cpu.ioPortAddr[i]!) === 1) addr |= 1 << i;
      }
      // Side-effect ports (e.g. CONDAT / key clear); data stays on cpu.ioPortDataIn Inputs.
      void this.devices.portIn(this.ram.bytes, addr);
    }
    this.lastGateIoWrite = wr;
    this.lastGateIoRead = rd;
  }

  /** One full instruction: soft if speed=soft, else 10 gate phases. */
  stepInstruction(): void {
    if (!this.booted) this.boot();
    if (this.isSoft && this.soft && this.ram) {
      try {
        if (this.spectrumHost) {
          this.spectrumHost.step();
          this.soft = this.spectrumHost.engine.cpu;
          this.softDesynced = true;
          return;
        }
        if (this.spectrum) this.spectrum.pulseFrameIrq();
        this.clearSoftIoPulses();
        this.softM1Pulse = true; // every soft instruction begins with an M1 fetch
        softStep(this.soft, this.ram.bytes, this.softHooks());
        this.softDesynced = true;
        this.syncLabPeripherals();
        if (this.soft.halted && !this.spectrum) this.running = false;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return;
    }
    if (this.gateRamPending) return;
    const irqWasPending = !!(this.spectrum?.irqPending);
    const iff1WasOn =
      !!this.cpu && !!this.readPin && this.readPin(this.cpu.iff1[0]!) === 1;
    this.syncSpectrumGateInt();
    for (let i = 0; i < 10; i++) this.stepPhase();
    // Nested 4-T bus may hold the instruction ring — burn extra phases until idle.
    for (let guard = 0; guard < 16; guard++) {
      if (!this.cpu || !this.readPin || this.readPin(this.cpu.busBusy) !== 1) break;
      this.stepPhase();
    }
    this.clearSpectrumIrqIfAccepted(irqWasPending, iff1WasOn);
    if (this.isSpectrum) this.writeBackSpectrumDisplayFromGateRam();
    this.stopIfGateHalted();
  }

  private stopIfGateHalted(): void {
    if (!this.cpu || !this.readPin) return;
    if (this.readPin(this.cpu.halted[0]!) === 1) this.running = false;
  }

  /**
   * Advance Run for one animation frame.
   * Soft: many interpreter ops. Gate: phases until PHASES cap or GATE_BUDGET_MS.
   * Returns whether any work ran (caller should refresh TTY).
   */
  tickBudget(): boolean {
    if (!this.running || !this.booted) return false;
    if (this.isSoft && this.spectrumHost && this.spectrum) {
      try {
        // Worker path: frames are produced on the Worker's own 50 Hz clock and
        // consumed here (latest picture only). Fallback path: the host paces
        // the in-page engine from wall-clock time. Audio and run-state are
        // handled per frame in `host.onFrame`, not per rAF.
        const frame = this.spectrumHost.tick(true);
        this.spectrumFrameCounter++;
        this.soft = this.spectrumHost.engine.cpu;
        this.spectrum = this.spectrumHost.engine.ula;
        this.spectrumMmu = this.spectrumHost.engine.mmu;
        this.spectrumTape = this.spectrumHost.engine.tape;
        this.softDesynced = true;
        const rgba = this.spectrumHost.lastFrameRgba;
        if (rgba && rgba.length) this.lastSpectrumRgba = rgba;
        if (frame) this.spectrumHost.syncAyTo(this.ayAudio.chip);
        const softErr = this.spectrumHost.lastSoftError ?? this.spectrumHost.engine.softError;
        if (softErr) this.softError = softErr;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return true;
    }
    if (this.isSoft && this.soft && this.ram) {
      try {
        if (this.spectrum) {
          this.spectrum.pulseFrameIrq();
          this.spectrum.beginBeeperFrame();
        }
        this.clearSoftIoPulses();
        this.softM1Pulse = true;
        softRun(this.soft, this.ram.bytes, this.phasesPerFrame, this.softHooks(), this.breakpointPc);
        this.softDesynced = true;
        this.syncLabPeripherals();
        if (
          this.breakpointPc != null &&
          this.soft &&
          (this.soft.pc & 0xffff) === (this.breakpointPc & 0xffff)
        ) {
          this.breakpointHit = true;
          this.running = false;
        }
        if (this.spectrum) {
          this.spectrumFrameCounter++;
          this.ayAudio.playFrame(69888, this.spectrum.beeperSegments());
        }
        if (this.soft.halted && !this.spectrum) this.running = false;
        return true;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return true;
    }
    if (this.gateRamPending) return false;
    try {
      const maxPhases = PHASES_PER_FRAME[this.speed as Exclude<RunSpeed, 'soft'>];
      const budgetMs = this.speed === 'free' ? FREE_BUDGET_MS : GATE_BUDGET_MS;
      const deadline = performance.now() + budgetMs;
      let n = 0;
      if (this.spectrum) this.spectrum.pulseFrameIrq();
      let instrIrqPending = false;
      let instrIff1WasOn = false;
      while (n < maxPhases && performance.now() < deadline && this.running) {
        if (n % 10 === 0) {
          instrIrqPending = !!(this.spectrum?.irqPending);
          instrIff1WasOn =
            !!this.cpu && !!this.readPin && this.readPin(this.cpu.iff1[0]!) === 1;
          this.syncSpectrumGateInt();
        }
        this.stepPhase();
        n++;
        if (n % 10 === 0) {
          this.clearSpectrumIrqIfAccepted(instrIrqPending, instrIff1WasOn);
          this.stopIfGateHalted();
        }
      }
      if (this.isSpectrum && n > 0) this.writeBackSpectrumDisplayFromGateRam();
      this.stopIfGateHalted();
      return n > 0;
    } catch (e) {
      this.running = false;
      this.softError = e instanceof Error ? e.message : String(e);
      console.error(e);
      return true;
    }
  }

  setRunning(on: boolean): void {
    if (!this.attached) return;
    if (on && !this.booted) this.boot();
    if (on) this.breakpointHit = false;
    this.running = on;
    this.spectrumHost?.setRunning(on);
  }
}
