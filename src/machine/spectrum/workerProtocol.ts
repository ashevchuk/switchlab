/**
 * Message protocol between main thread and Spectrum soft-run Worker.
 */

import type { SpectrumModel } from './mmu.js';
import type { SpectrumTurbo } from './engine.js';

export type WorkerInMsg =
  | { type: 'boot'; model: SpectrumModel }
  | { type: 'bootTrdos' }
  /** Run exactly one frame now (tests / manual stepping). Normal running uses the Worker's own 50 Hz clock. */
  | { type: 'tick'; wantRgba: boolean }
  | { type: 'step' }
  | { type: 'stepOver' }
  | { type: 'nmi' }
  /** Start/stop the Worker-side 50 Hz frame loop. */
  | { type: 'setRunning'; on: boolean }
  /** Main thread hands a consumed RGBA buffer back for reuse (zero per-frame allocation). */
  | { type: 'recycleRgba'; buf: ArrayBuffer }
  /** Output rate of the main thread's AudioContext; frames carry `audio` at this rate. */
  | { type: 'setAudioSampleRate'; rate: number }
  /** Disable audio synthesis (muted) — saves ~1 ms/frame in the Worker. */
  | { type: 'setAudioEnabled'; on: boolean }
  /** Pause RGBA rendering while the Spectrum pane is hidden. */
  | { type: 'setVideoEnabled'; on: boolean }
  | { type: 'setTurbo'; turbo: SpectrumTurbo }
  | { type: 'setBreakpointPc'; pc: number | null }
  | { type: 'setBreakWriteAddr'; addr: number | null }
  | { type: 'poke'; addr: number; val: number }
  | { type: 'setKey'; label: string; down: boolean }
  | { type: 'clearKeys' }
  | { type: 'setKempston'; bit: 0 | 1 | 2 | 3 | 4; down: boolean }
  | { type: 'setWatchAddr'; addr: number }
  | { type: 'mountTap'; data: ArrayBuffer; cold?: boolean }
  | { type: 'mountTzx'; data: ArrayBuffer; cold?: boolean }
  | { type: 'mountTrd'; data: ArrayBuffer }
  | { type: 'enqueueTape'; name: string; kind: 'tap' | 'tzx'; data: ArrayBuffer }
  | { type: 'clearTapeQueue' }
  | { type: 'rewindTape' }
  | { type: 'advanceTape' }
  | { type: 'seekTape'; index: number }
  | { type: 'setTapePaused'; on: boolean }
  | { type: 'setTapeAutoStop'; on: boolean }
  | { type: 'loadSna'; data: ArrayBuffer }
  | { type: 'loadZ80'; data: ArrayBuffer }
  | { type: 'loadScr'; data: ArrayBuffer }
  | { type: 'setRom48Basic'; on: boolean }
  | { type: 'getSnapshot' }
  | { type: 'getMemory' };

export type WorkerOutMsg =
  | {
      type: 'frame';
      /** Present only when the picture changed since the previous posted frame. */
      rgba?: ArrayBuffer;
      /** One 50 Hz frame of mono Float32 samples (absent when audio is disabled). */
      audio?: ArrayBuffer;
      frameSeq: number;
      ayRegs: ArrayBuffer;
      aySelected: number;
      ayEnvWrites: number;
      tStates: number;
      beeperStart: boolean;
      beeperTransitions: { frac: number; bit: boolean }[];
      breakpointHit: boolean;
      breakWriteHit: boolean;
      running: boolean;
      tapePos: number;
      tapeBlocks: number;
      contendedWaits: number;
      contendedHits: number;
      pc: number;
      sp: number;
      a: number;
      f: number;
      b: number;
      c: number;
      d: number;
      e: number;
      h: number;
      l: number;
      ix: number;
      iy: number;
      i: number;
      r: number;
      im: 0 | 1 | 2;
      iff1: boolean;
      iff2: boolean;
      halted: boolean;
      model: SpectrumModel;
      trdosPaged: boolean;
      port7ffd: number;
      watchAddr: number;
      watchBytes: ArrayBuffer;
      border: number;
      softError: string | null;
    }
  | { type: 'snapshot'; sna: ArrayBuffer; z80: ArrayBuffer; scr: ArrayBuffer }
  /** The 64K address space as the Z80 sees it right now (ROM, paged banks and all). */
  | { type: 'memory'; ram: ArrayBuffer }
  | { type: 'mounted'; kind: string; blocks?: number; label?: string; sides?: number }
  | { type: 'error'; message: string };
