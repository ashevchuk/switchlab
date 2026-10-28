import type { RamComponent } from '../sim/types.js';
import type { MachineRunner, RunSpeed, SpectrumTurbo } from '../machine/MachineRunner.js';
import {
  BMP_HEIGHT,
  BMP_WIDTH,
  CONSOLE_COLS,
  CONSOLE_ROWS,
  CONSOLE_SIZE,
  FB_COLS,
  FB_ROWS,
  FB_SIZE,
  requiresMachineMap,
  softIoLayoutForRam,
} from '../machine/memoryMap.js';
import { assemble, bytesToHexPrompt } from '../machine/assembler.js';
import { compileBasic } from '../machine/basic.js';
import { BASIC_DEMO_SOURCE, BASIC_ORIGIN, loadBasicRom } from '../machine/basicRom.js';
import { bootCpmSoft, bootRealCpm, mountCpmDriveB } from '../machine/cpm/boot.js';
import { loadCpm22DiskImage } from '../machine/cpm/cpm22Disk.js';
import { loadRogueDiskImage } from '../machine/cpm/rogueDisk.js';
import { mapBrowserKeyToSpectrum } from '../machine/spectrum/ula.js';
import {
  renderSpectrumFrame,
  SPEC_FRAME_H,
  SPEC_FRAME_W,
  spectrumFlashPhase,
} from '../machine/spectrum/video.js';
import { loadHexAt, parseHex, parseHexBlob, runSoftCommand } from '../machine/softConsole.js';
import { injectKey } from '../machine/tty.js';
import { saveSpectrumSession } from '../machine/spectrumSession.js';
import { FloatingWindow } from './FloatingWindow.js';
import { SpectrumKeyboard } from './SpectrumKeyboard.js';
import { SpectrumJoystick, joyMatrixKeys } from './SpectrumJoystick.js';
import { spectrumDemoHint } from './spectrumDemoHints.js';
import { formatSpectrumRegs } from './spectrumRegs.js';
import {
  decodeSpectrumGame,
  SPECTRUM_GAMES,
  findSpectrumGame,
  type SpectrumGameEntry,
} from '../machine/spectrum/gamesData.js';
import { describeTapBlock } from '../machine/spectrum/tap.js';
import { waitForSpectrumBasicInputReady, waitForSpectrumScreenReady } from '../machine/spectrum/ready.js';

const CELL_W = 9;
const CELL_H = 15;
const PAD = 6;
const BMP_SCALE = 2;
const BMP_GAP = 6;
const SPEC_SCALE = 2;

/**
 * Floating TTY + soft command/load console. Run/Pause/Step drive a
 * MachineRunner auto-clock. Opened by dblclick on a TTY component.
 */
export class MachinePanel {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private readonly canvasWrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly specCanvas: HTMLCanvasElement;
  private readonly specCtx: CanvasRenderingContext2D;
  private readonly specPlaceholder: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly outEl: HTMLElement;
  private readonly cmdInput: HTMLInputElement;
  private readonly loadAddr: HTMLInputElement;
  private readonly loadHex: HTMLTextAreaElement;
  private readonly asmSource: HTMLTextAreaElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly specTurboSel: HTMLSelectElement;
  private readonly specModelEl: HTMLElement;
  private readonly btnRun: HTMLButtonElement;
  private readonly btnPause: HTMLButtonElement;
  private readonly btnStep: HTMLButtonElement;
  private readonly btnReboot: HTMLButtonElement;
  private ram: RamComponent | null = null;
  private runner: MachineRunner | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Open the floating I/O map viewer (wired from main). */
  onOpenIoMap: (() => void) | null = null;

  private readonly bmpTmp: HTMLCanvasElement = document.createElement('canvas');
  private bmpTmpCtx!: CanvasRenderingContext2D;
  private resizeObserver: ResizeObserver | null = null;
  /** Main-thread render target when no engine picture is available (legacy path). */
  private readonly specRgba = new Uint8ClampedArray(SPEC_FRAME_W * SPEC_FRAME_H * 4);
  private specImage: ImageData | null = null;
  /** Dedicated 320×256 staging canvas so the console bitmap and Spectrum never resize each other. */
  private readonly specTmp: HTMLCanvasElement = document.createElement('canvas');
  private specTmpCtx!: CanvasRenderingContext2D;
  private drawnSpecSeq = -1;
  private specPlaceholderDrawn = false;
  /** Backing-store bookkeeping: reassigning canvas.width/height clears + reallocates. */
  private consoleBackW = 0;
  private consoleBackH = 0;
  private specBackW = 0;
  private specBackH = 0;
  private consoleDpr = 0;
  private specDpr = 0;
  /** What the console canvas currently shows in Spectrum mode (static banner drawn once). */
  private consoleBannerShown = false;
  /** Text (regs/health/status/tape) is refreshed at most every TEXT_INTERVAL_MS while running. */
  private lastTextMs = 0;
  private static readonly TEXT_INTERVAL_MS = 200;
  private bmpImage: ImageData | null = null;
  private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
  private readonly specKbd: SpectrumKeyboard;
  private readonly specJoy: SpectrumJoystick;
  private readonly gameSel: HTMLSelectElement;
  private readonly gameSelTab: HTMLSelectElement;
  private readonly regsEl: HTMLElement;
  private readonly watchInput: HTMLInputElement;
  private readonly bpInput: HTMLInputElement;
  private readonly tapeSel: HTMLSelectElement;
  private readonly tapeRewBtn: HTMLButtonElement;
  private readonly tapeNextBtn: HTMLButtonElement;
  private watchAddr = 0x4000;
  /**
   * Bumped to cancel in-flight `autoTypeLoadEmpty` (TAP LOAD "").
   * Reboot / new demo / detach must invalidate the previous typer or it keeps
   * injecting keys into the next session.
   */
  private autoTypeGen = 0;
  private lastTapeSig = '';
  private activeTab: 'console' | 'spectrum' = 'console';
  private wasSpectrum = false;
  private lastStatusText = '';
  private lastRegsText = '';
  private sessionCheats: { addr: number; val: number }[] = [];
  private cheatStorageKey = 'switchlab-spectrum-cheats';
  /** Optional: copy #sna= link (wired from main). */
  onCopySnaLink: (() => void) | null = null;
  private pauseTipEl: HTMLElement | null = null;
  private focusTipEl: HTMLElement | null = null;
  private healthEl: HTMLElement | null = null;
  private currentDemoId: string | null = null;
  private readonly slotStorageKey = 'switchlab-spectrum-slots-v1';
  private slotFilled = [false, false, false, false];
  private lastHealthText = '';

  constructor() {
    this.win = new FloatingWindow('TTY', 'machine-panel');
    this.win.setTitle('TTY', '80×25 VT100 · resize · 128×64 bmp');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="machine-panel-controls">
        <button type="button" data-act="run" title="Auto-clock">Run</button>
        <button type="button" data-act="pause" title="Pause auto-clock">Pause</button>
        <button type="button" data-act="step" title="One full instruction (10 phases)">Step</button>
        <button type="button" data-act="reboot" title="Reset PC via runner reboot">Reboot</button>
        <button type="button" data-act="io-map" title="Open soft machine I/O map">I/O map</button>
        <label class="machine-panel-speed">Speed
          <select data-act="speed" title="Soft = interpreter (fast TTY). Gates = transistor (slow).">
            <option value="soft" selected>Soft (fast)</option>
            <option value="slow">Gates slow</option>
            <option value="normal">Gates normal</option>
            <option value="turbo">Gates turbo</option>
            <option value="free">Gates free</option>
          </select>
        </label>
        <label class="machine-panel-speed">Spec×
          <select data-act="spec-turbo" title="Soft Spectrum ops/frame multiplier">
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
            <option value="8">8×</option>
          </select>
        </label>
        <button type="button" data-act="mute" title="Mute AY / beeper">Mute</button>
        <span class="machine-panel-status">idle</span>
      </div>
      <div class="machine-panel-tabs" role="tablist">
        <button type="button" role="tab" data-tab="console" class="is-active" aria-selected="true">Console</button>
        <button type="button" role="tab" data-tab="spectrum" aria-selected="false">Spectrum</button>
      </div>
      <div class="machine-panel-pane" data-pane="console">
        <div class="machine-panel-canvas-wrap">
          <canvas class="machine-panel-canvas" data-canvas="tty" tabindex="0" title="Click to focus; type to inject keys"></canvas>
        </div>
        <form class="machine-panel-cmd" autocomplete="off">
          <label>Cmd <input name="cmd" spellcheck="false" placeholder="host: H | M e00 8 | W 100 3e | G 200 | R" /></label>
          <button type="submit">Enter</button>
        </form>
        <div class="machine-panel-load">
          <label>Load @ <input name="addr" spellcheck="false" value="0200" size="4" /></label>
          <textarea name="hex" rows="2" spellcheck="false" placeholder="hex: 3e,41,32,00,0e ..."></textarea>
          <button type="button" data-act="load">Load hex</button>
        </div>
        <div class="machine-panel-asm">
          <textarea name="asm" rows="4" spellcheck="false">; origin = Load @ (try 0200)
LD A,'A'
LD (0xE00),A
spin:
JR spin</textarea>
          <div class="machine-panel-asm-actions">
            <button type="button" data-act="asm">Assemble → Load @</button>
            <button type="button" data-act="asm-go" title="Assemble, load, G origin, reboot">Assemble + Go</button>
            <button type="button" data-act="basic" title="Compile mini-BASIC from the text area">BASIC → Load @</button>
            <button type="button" data-act="basic-go" title="Compile BASIC, JP@0, reboot+run">BASIC + Go</button>
            <button type="button" data-act="basic-demo" title="Load demo BASIC ROM at 0000/0200 and run">Boot BASIC</button>
            <button type="button" data-act="cpm-boot" title="Real CP/M 2.2 from z80pack cpm22-1.dsk (needs addrBits=16)">Boot CP/M</button>
            <button type="button" data-act="cpm-games" title="Boot CP/M + mount rogue.dsk as B: (ROGUE-VT / WANDERER)">Boot CP/M+games</button>
            <button type="button" data-act="cpm-soft" title="Host SoftCpm stub (DIR/TYPE/HELLO) — needs addrBits=16">Boot soft stub</button>
            <button type="button" data-act="spectrum" title="Soft ZX Spectrum 48K (ROM + ULA screen) — needs addrBits=16">Boot Spectrum 48K</button>
            <button type="button" data-act="spectrum128" title="Soft ZX Spectrum 128K (banking + 128 ROM) — needs addrBits=16">Boot Spectrum 128K</button>
            <button type="button" data-act="spectrum-48basic" title="128K: page 48 BASIC ROM (7FFD bit4)">48 BASIC</button>
            <button type="button" data-act="trdos-boot" title="Page TR-DOS ROM and jump $0000">Boot TR-DOS</button>
            <button type="button" data-act="sna" title="Load 48K or 128K .SNA snapshot">Load .SNA</button>
            <button type="button" data-act="z80" title="Load .Z80 snapshot (v1/v2/v3)">Load .Z80</button>
            <button type="button" data-act="save-sna" title="Save current Spectrum as .SNA">Save .SNA</button>
            <button type="button" data-act="save-z80" title="Save current Spectrum as .Z80 v3">Save .Z80</button>
            <button type="button" data-act="copy-sna-link" title="Copy #sna= share link">Copy SNA link</button>
            <button type="button" data-act="save-png" title="Export Spectrum screen as PNG">Save PNG</button>
            <button type="button" data-act="save-scr" title="Save display file as .SCR (6912)">Save .SCR</button>
            <button type="button" data-act="tap" title="Mount .TAP for LOAD &quot;&quot; (flash-load)">Load .TAP</button>
            <button type="button" data-act="tzx" title="Mount .TZX (standard/turbo data → flash-load)">Load .TZX</button>
            <button type="button" data-act="scr" title="Load .SCR into screen">Load .SCR</button>
            <button type="button" data-act="trd" title="Mount .TRD (Beta sector R/W subset — not full WD1793)">Mount .TRD</button>
            <label class="machine-panel-game">Demo
              <select data-act="game" title="Bundled freeware TAP/SNA">
                <option value="">— pick —</option>
              </select>
            </label>
            <button type="button" data-act="load-game" title="Load selected bundled game">Load demo</button>
            <input type="file" data-file="sna" accept=".sna,application/octet-stream" hidden />
            <input type="file" data-file="z80" accept=".z80,application/octet-stream" hidden />
            <input type="file" data-file="tap" accept=".tap,application/octet-stream" hidden />
            <input type="file" data-file="tzx" accept=".tzx,application/octet-stream" hidden />
            <input type="file" data-file="scr" accept=".scr,application/octet-stream" hidden />
            <input type="file" data-file="trd" accept=".trd,application/octet-stream" hidden />
          </div>
        </div>
        <pre class="machine-panel-out"></pre>
        <div class="machine-panel-hint">Console: soft TTY / CP/M. Spectrum: SNA/Z80/TAP/TZX/SCR/TRD · Kempston/Cursor/Sinclair/WASD · TR-DOS* = Beta stub · BP/NMI.</div>
      </div>
      <div class="machine-panel-pane" data-pane="spectrum" hidden>
        <div class="spec-computer">
          <div class="spec-computer-top">
            <span class="spec-computer-brand">ZX Spectrum</span>
            <span class="spec-computer-model" data-spec-model>48K / 128K soft</span>
            <button type="button" class="spec-computer-png" data-act="save-png-tab" title="Export screen PNG">PNG</button>
            <button type="button" class="spec-computer-png" data-act="save-scr-tab" title="Export .SCR">SCR</button>
            <button type="button" class="spec-computer-png" data-act="nmi" title="NMI → $0066 (soft or gate)">NMI</button>
            <button type="button" class="spec-computer-png" data-act="step-over" title="Step over CALL/RST">Over</button>
            <span class="spec-slots" title="Quick SNA slots (F6–F9 save with Shift, F6–F9 load)">
              <button type="button" data-act="slot-1" data-slot="1" title="Slot 1 — click load · Shift+click save · F6">S1</button>
              <button type="button" data-act="slot-2" data-slot="2" title="Slot 2 — F7">S2</button>
              <button type="button" data-act="slot-3" data-slot="3" title="Slot 3 — F8">S3</button>
              <button type="button" data-act="slot-4" data-slot="4" title="Slot 4 — F9">S4</button>
            </span>
          </div>
          <div class="spec-media" title="Load images / demos without leaving Spectrum tab">
            <button type="button" data-act="sna-tab" title="Load 48K or 128K .SNA">.SNA</button>
            <button type="button" data-act="z80-tab" title="Load .Z80 snapshot">.Z80</button>
            <button type="button" data-act="tap-tab" title="Mount .TAP (flash-load)">.TAP</button>
            <button type="button" data-act="tzx-tab" title="Mount .TZX">.TZX</button>
            <button type="button" data-act="scr-tab" title="Load .SCR">.SCR</button>
            <button type="button" data-act="trd-tab" title="Mount .TRD">.TRD</button>
            <label class="spec-media-demo">Demo
              <select data-act="game-tab" title="Bundled freeware TAP/SNA">
                <option value="">—</option>
              </select>
            </label>
            <button type="button" data-act="load-game-tab" title="Load selected bundled demo">Load</button>
            <button type="button" data-act="spectrum-48basic-tab" title="128K: page 48 BASIC ROM">48 BASIC</button>
            <button type="button" data-act="trdos-boot-tab" title="Boot TR-DOS (Beta sector stub — not full WD1793)">TR-DOS*</button>
            <button type="button" data-act="save-z80-tab" title="Save current Spectrum as .Z80 v3">.Z80↓</button>
            <button type="button" data-act="copy-sna-link-tab" title="Copy #sna= share link">#sna=</button>
          </div>
          <div class="spec-computer-screen-wrap">
            <canvas class="machine-panel-canvas spec-computer-screen" data-canvas="spec" tabindex="0" title="Spectrum display — click then type, or use keys below"></canvas>
            <div class="spec-pause-tip" data-spec-pause-tip hidden>Hold Space (or any key) — BASIC PAUSE / press-any-key</div>
            <div class="spec-focus-tip" data-spec-focus-tip hidden>Click the screen — editor keys steal WASD / arrows</div>
            <div class="spec-computer-placeholder">Place Spectrum, or load .SNA / .TAP / Demo above</div>
          </div>
          <div class="spec-computer-controls">
            <div class="machine-panel-spec-kbd-host"></div>
            <div class="machine-panel-spec-joy-host"></div>
          </div>
          <div class="spec-debug">
            <label>Watch $<input data-act="watch" spellcheck="false" value="4000" size="4" title="Memory watch base (hex)" /></label>
            <label>BP $<input data-act="bp" spellcheck="false" value="" size="4" placeholder="off" title="PC breakpoint (hex); empty = off" /></label>
            <button type="button" data-act="bp-set" title="Apply breakpoint">Set BP</button>
            <button type="button" data-act="bp-clear" title="Clear breakpoint">Clear BP</button>
            <label>BW $<input data-act="bw" spellcheck="false" value="" size="4" placeholder="off" title="Break on write (hex)" /></label>
            <button type="button" data-act="bw-set" title="Apply write breakpoint">Set BW</button>
          </div>
          <div class="spec-poke">
            <label>Poke $<input data-act="poke-addr" spellcheck="false" value="0000" size="4" /></label>
            <label>=$<input data-act="poke-val" spellcheck="false" value="00" size="2" /></label>
            <button type="button" data-act="poke-go" title="Write byte">Poke</button>
            <label class="spec-preset-label">Preset
              <select data-act="poke-preset" title="Quick poke / NMI helpers">
                <option value="">—</option>
                <option value="nmi">NMI ($0066)</option>
                <option value="border0">Border black</option>
                <option value="border7">Border white</option>
                <option value="ei">Force EI (soft)</option>
                <option value="di">Force DI (soft)</option>
              </select>
            </label>
            <button type="button" data-act="poke-preset-go" title="Run selected preset">Go</button>
            <button type="button" data-act="cheat-add" title="Add poke to session cheats">+Cheat</button>
            <button type="button" data-act="cheat-apply" title="Apply all session cheats">Apply cheats</button>
            <select data-act="cheat-list" title="Session cheats"></select>
            <button type="button" data-act="cheat-del" title="Remove selected cheat">Del</button>
          </div>
          <div class="spec-health" data-spec-health>—</div>
          <div class="spec-tape">
            <span class="spec-tape-label">Tape</span>
            <select data-act="tape-pos" title="Tape block position" disabled>
              <option value="">— empty —</option>
            </select>
            <button type="button" data-act="tape-rew" title="Rewind tape to start" disabled>Rewind</button>
            <button type="button" data-act="tape-next" title="Skip to next block" disabled>Next</button>
            <button type="button" data-act="tape-pause" title="Pause flash-load">Pause</button>
            <label class="spec-tape-autostop" title="Stop Run after each loaded block"><input type="checkbox" data-act="tape-autostop" /> Auto-stop</label>
            <progress data-act="tape-prog" max="1" value="0" title="Tape progress"></progress>
            <span data-act="tape-queue">Q:0</span>
            <button type="button" data-act="tape-queue-clear" title="Clear tape queue">Clear Q</button>
          </div>
          <pre class="spec-regs" data-spec-regs>—</pre>
        </div>
      </div>
    `;
    this.canvasWrap = this.root.querySelector('.machine-panel-canvas-wrap')!;
    this.canvas = this.root.querySelector('canvas[data-canvas="tty"]')!;
    this.specCanvas = this.root.querySelector('canvas[data-canvas="spec"]')!;
    this.hint = this.root.querySelector('.machine-panel-hint')!;
    this.statusEl = this.root.querySelector('.machine-panel-status')!;
    this.outEl = this.root.querySelector('.machine-panel-out')!;
    this.cmdInput = this.root.querySelector('input[name="cmd"]')!;
    this.loadAddr = this.root.querySelector('input[name="addr"]')!;
    this.loadHex = this.root.querySelector('textarea[name="hex"]')!;
    this.asmSource = this.root.querySelector('textarea[name="asm"]')!;
    this.speedSel = this.root.querySelector('[data-act="speed"]')!;
    this.specTurboSel = this.root.querySelector('[data-act="spec-turbo"]')!;
    this.specModelEl = this.root.querySelector('[data-spec-model]')!;
    this.gameSel = this.root.querySelector('[data-act="game"]')!;
    this.gameSelTab = this.root.querySelector('[data-act="game-tab"]')!;
    this.regsEl = this.root.querySelector('[data-spec-regs]')!;
    this.pauseTipEl = this.root.querySelector('[data-spec-pause-tip]');
    this.focusTipEl = this.root.querySelector('[data-spec-focus-tip]');
    this.healthEl = this.root.querySelector('[data-spec-health]');
    this.watchInput = this.root.querySelector('[data-act="watch"]')!;
    this.bpInput = this.root.querySelector('[data-act="bp"]')!;
    this.tapeSel = this.root.querySelector('[data-act="tape-pos"]')!;
    this.tapeRewBtn = this.root.querySelector('[data-act="tape-rew"]')!;
    this.tapeNextBtn = this.root.querySelector('[data-act="tape-next"]')!;
    this.btnRun = this.root.querySelector('[data-act="run"]')!;
    this.btnPause = this.root.querySelector('[data-act="pause"]')!;
    this.btnStep = this.root.querySelector('[data-act="step"]')!;
    this.btnReboot = this.root.querySelector('[data-act="reboot"]')!;
    this.specPlaceholder = this.root.querySelector('.spec-computer-placeholder')!;
    this.specKbd = new SpectrumKeyboard(
      () => this.runner?.spectrum ?? null,
      (label, down) => {
        const h = this.runner?.spectrumHost;
        if (h) h.setKey(label, down);
        else this.runner?.spectrum?.setKey(label, down);
      },
      () => {
        void this.autoTypeLoadEmpty(false);
      },
      async (n) => {
        for (let i = 0; i < n; i++) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
      },
    );
    this.specKbd.onActivity = () => this.draw();
    this.root.querySelector('.machine-panel-spec-kbd-host')!.appendChild(this.specKbd.root);
    this.specJoy = new SpectrumJoystick({
      kempston: (bit, down) => {
        const h = this.runner?.spectrumHost;
        if (h) h.setKempston(bit, down);
        else this.runner?.spectrum?.setKempston(bit, down);
      },
      cursorKey: (label, down) => {
        const h = this.runner?.spectrumHost;
        if (h) h.setKey(label, down);
        else this.runner?.spectrum?.setKey(label, down);
      },
    });
    this.root.querySelector('.machine-panel-spec-joy-host')!.appendChild(this.specJoy.root);
    this.loadSessionCheats();
    this.root.querySelector('[data-act="io-map"]')!.addEventListener('click', () => {
      this.onOpenIoMap?.();
    });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available for MachinePanel');
    this.ctx = ctx;
    const specCtx = this.specCanvas.getContext('2d');
    if (!specCtx) throw new Error('2D canvas context is not available for Spectrum panel');
    this.specCtx = specCtx;
    this.bmpTmp.width = BMP_WIDTH;
    this.bmpTmp.height = BMP_HEIGHT;
    const bmpCtx = this.bmpTmp.getContext('2d');
    if (!bmpCtx) throw new Error('2D canvas context is not available for bitmap blit');
    this.bmpTmpCtx = bmpCtx;
    this.specTmp.width = SPEC_FRAME_W;
    this.specTmp.height = SPEC_FRAME_H;
    const specTmpCtx = this.specTmp.getContext('2d');
    if (!specTmpCtx) throw new Error('2D canvas context is not available for Spectrum blit');
    this.specTmpCtx = specTmpCtx;
    this.resizeBackingStore();

    this.canvas.addEventListener('click', () => this.canvas.focus());
    this.specCanvas.addEventListener('click', () => this.specCanvas.focus());
    for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab === 'spectrum' ? 'spectrum' : 'console'));
    }
    this.resizeObserver = new ResizeObserver(() => {
      // Layout changed (window resize, tab switch): force a full repaint.
      this.consoleBannerShown = false;
      this.drawnSpecSeq = -1;
      this.specPlaceholderDrawn = false;
      if (this.ram) this.draw(true);
    });
    this.resizeObserver.observe(this.win.root);
    this.resizeObserver.observe(this.canvasWrap);
    this.resizeObserver.observe(this.specCanvas.parentElement!);
    this.btnRun.addEventListener('click', () => {
      this.ensureMachineReadyForRun();
      this.runner?.setRunning(true);
      this.refreshControls();
    });
    this.btnPause.addEventListener('click', () => {
      this.runner?.setRunning(false);
      this.refreshControls();
    });
    this.btnStep.addEventListener('click', () => {
      this.ensureMachineReadyForRun();
      this.runner?.stepInstruction();
      this.draw();
      this.refreshControls();
    });
    this.btnReboot.addEventListener('click', () => {
      this.cancelAutoType();
      this.ensureMachineReadyForRun();
      const model = this.runner?.spectrumModel;
      this.runner?.reboot();
      this.log(model ? `reboot (Spectrum ${model}K)` : 'reboot');
      this.draw();
      this.refreshControls();
    });
    this.speedSel.addEventListener('change', () => {
      const prev = this.runner?.speed;
      const v = this.speedSel.value as RunSpeed;
      if (v !== 'soft' && this.runner && !this.runner.attachedGate) {
        this.speedSel.value = 'soft';
        this.log(
          '! Gates needs a live Z80CPU (Inputs from Place). Soft only after page reload — File → Demo → Spectrum again for Gates.',
        );
        this.refreshControls();
        return;
      }
      this.runner?.setSpeed(v);
      if (prev === 'soft' && v !== 'soft' && this.runner?.softDesynced) {
        this.runner.reboot();
        this.log('reboot (resync after soft)');
        this.draw();
      }
      this.refreshControls();
    });
    this.root.querySelector('.machine-panel-cmd')!.addEventListener('submit', (e) => {
      e.preventDefault();
      this.runCommandLine(this.cmdInput.value);
      this.cmdInput.select();
    });
    this.root.querySelector('[data-act="load"]')!.addEventListener('click', () => this.doLoadHex());
    this.root.querySelector('[data-act="asm"]')!.addEventListener('click', () => this.doAssemble(false));
    this.root.querySelector('[data-act="asm-go"]')!.addEventListener('click', () => this.doAssemble(true));
    this.root.querySelector('[data-act="basic"]')!.addEventListener('click', () => this.doBasic(false));
    this.root.querySelector('[data-act="basic-go"]')!.addEventListener('click', () => this.doBasic(true));
    this.root.querySelector('[data-act="basic-demo"]')!.addEventListener('click', () => this.doBootBasic());
    this.root.querySelector('[data-act="cpm-boot"]')!.addEventListener('click', () => this.doBootCpm(true, false));
    this.root.querySelector('[data-act="cpm-games"]')!.addEventListener('click', () => this.doBootCpm(true, true));
    this.root.querySelector('[data-act="cpm-soft"]')!.addEventListener('click', () => this.doBootCpm(false, false));
    this.root.querySelector('[data-act="spectrum"]')!.addEventListener('click', () => this.doBootSpectrum('48'));
    this.root.querySelector('[data-act="spectrum128"]')!.addEventListener('click', () => this.doBootSpectrum('128'));
    const boot48Basic = () => {
      this.runner?.setSpectrumRom48Basic(true);
      this.log('128K → 48 BASIC ROM (7FFD bit4)');
      this.refreshControls();
    };
    const bootTrdos = () => {
      try {
        this.runner?.bootSpectrumTrdos();
        this.setTab('spectrum');
        this.log(
          'Boot TR-DOS* — ROM paged @0000. Soft Beta: sector R/W + seek (not full WD1793 timing). Mount .TRD for I/O.',
        );
        this.draw();
        this.refreshControls();
      } catch (e) {
        this.log(`! ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const copySna = () => this.onCopySnaLink?.();
    for (const sel of ['[data-act="spectrum-48basic"]', '[data-act="spectrum-48basic-tab"]']) {
      this.root.querySelector(sel)!.addEventListener('click', boot48Basic);
    }
    for (const sel of ['[data-act="trdos-boot"]', '[data-act="trdos-boot-tab"]']) {
      this.root.querySelector(sel)!.addEventListener('click', bootTrdos);
    }
    for (const sel of ['[data-act="copy-sna-link"]', '[data-act="copy-sna-link-tab"]']) {
      this.root.querySelector(sel)!.addEventListener('click', copySna);
    }
    this.root.querySelector('[data-act="step-over"]')!.addEventListener('click', () => {
      this.runner?.stepSpectrumOver();
      this.draw();
      this.refreshControls();
    });
    const clickFile = (kind: string) => () => {
      (this.root.querySelector(`[data-file="${kind}"]`) as HTMLInputElement).click();
    };
    this.root.querySelector('[data-act="sna"]')!.addEventListener('click', clickFile('sna'));
    this.root.querySelector('[data-act="sna-tab"]')!.addEventListener('click', clickFile('sna'));
    this.root.querySelector('[data-act="z80"]')!.addEventListener('click', clickFile('z80'));
    this.root.querySelector('[data-act="z80-tab"]')!.addEventListener('click', clickFile('z80'));
    this.root.querySelector('[data-act="save-sna"]')!.addEventListener('click', () => this.doSaveSna());
    this.root.querySelector('[data-act="save-z80"]')!.addEventListener('click', () => this.doSaveZ80());
    this.root.querySelector('[data-act="save-z80-tab"]')!.addEventListener('click', () => this.doSaveZ80());
    this.root.querySelector('[data-act="save-png"]')!.addEventListener('click', () => this.doSavePng());
    this.root.querySelector('[data-act="save-png-tab"]')!.addEventListener('click', () => this.doSavePng());
    this.root.querySelector('[data-act="save-scr"]')!.addEventListener('click', () => this.doSaveScr());
    this.root.querySelector('[data-act="save-scr-tab"]')!.addEventListener('click', () => this.doSaveScr());
    this.root.querySelector('[data-act="nmi"]')!.addEventListener('click', () => this.doNmi());
    this.root.querySelector('[data-act="tap"]')!.addEventListener('click', clickFile('tap'));
    this.root.querySelector('[data-act="tap-tab"]')!.addEventListener('click', clickFile('tap'));
    this.root.querySelector('[data-act="tzx"]')!.addEventListener('click', clickFile('tzx'));
    this.root.querySelector('[data-act="tzx-tab"]')!.addEventListener('click', clickFile('tzx'));
    this.root.querySelector('[data-act="scr"]')!.addEventListener('click', clickFile('scr'));
    this.root.querySelector('[data-act="scr-tab"]')!.addEventListener('click', clickFile('scr'));
    this.root.querySelector('[data-act="trd"]')!.addEventListener('click', clickFile('trd'));
    this.root.querySelector('[data-act="trd-tab"]')!.addEventListener('click', clickFile('trd'));
    this.root.querySelector('[data-file="sna"]')!.addEventListener('change', (e) => {
      void this.onSpectrumFile(e, 'sna');
    });
    this.root.querySelector('[data-file="z80"]')!.addEventListener('change', (e) => {
      void this.onSpectrumFile(e, 'z80');
    });
    this.root.querySelector('[data-file="tap"]')!.addEventListener('change', (e) => {
      void this.onSpectrumFile(e, 'tap');
    });
    this.root.querySelector('[data-file="tzx"]')!.addEventListener('change', (e) => {
      void this.onSpectrumFile(e, 'tzx');
    });
    this.root.querySelector('[data-file="scr"]')!.addEventListener('change', (e) => {
      void this.onSpectrumFile(e, 'scr');
    });
    this.root.querySelector('[data-file="trd"]')!.addEventListener('change', (e) => {
      void this.onSpectrumFile(e, 'trd');
    });
    this.root.querySelector('[data-act="bp-set"]')!.addEventListener('click', () => {
      const raw = this.bpInput.value.trim();
      if (!raw) {
        this.runner?.setBreakpointPc(null);
        this.log('Breakpoint cleared');
      } else {
        const n = parseInt(raw, 16);
        if (!Number.isFinite(n)) {
          this.log('! BP needs hex address');
          return;
        }
        this.runner?.setBreakpointPc(n);
        this.log(`Breakpoint @ ${n.toString(16).padStart(4, '0')}`);
      }
      this.refreshControls();
      this.refreshSpectrumRegs();
    });
    this.root.querySelector('[data-act="bp-clear"]')!.addEventListener('click', () => {
      this.bpInput.value = '';
      this.runner?.setBreakpointPc(null);
      this.log('Breakpoint cleared');
      this.refreshControls();
      this.refreshSpectrumRegs();
    });
    this.root.querySelector('[data-act="bw-set"]')!.addEventListener('click', () => {
      const raw = (this.root.querySelector('[data-act="bw"]') as HTMLInputElement).value.trim();
      if (!raw) {
        this.runner?.setBreakWriteAddr(null);
        this.log('Write breakpoint cleared');
      } else {
        const n = parseInt(raw, 16);
        if (!Number.isFinite(n)) {
          this.log('! BW needs hex address');
          return;
        }
        this.runner?.setBreakWriteAddr(n);
        this.log(`Break-on-write @ ${n.toString(16).padStart(4, '0')}`);
      }
      this.refreshSpectrumRegs();
    });
    this.root.querySelector('[data-act="poke-go"]')!.addEventListener('click', () => this.applyPoke(false));
    this.root.querySelector('[data-act="cheat-add"]')!.addEventListener('click', () => this.applyPoke(true));
    this.root.querySelector('[data-act="cheat-apply"]')!.addEventListener('click', () => {
      for (const c of this.sessionCheats) this.runner?.pokeSpectrum(c.addr, c.val);
      this.log(`Applied ${this.sessionCheats.length} cheat(s)`);
      this.draw();
    });
    this.root.querySelector('[data-act="cheat-del"]')!.addEventListener('click', () => {
      const sel = this.root.querySelector('[data-act="cheat-list"]') as HTMLSelectElement;
      const i = Number(sel.value);
      if (!Number.isFinite(i)) return;
      this.sessionCheats.splice(i, 1);
      this.saveSessionCheats();
      this.refreshCheatList();
    });
    this.root.querySelector('[data-act="poke-preset-go"]')!.addEventListener('click', () => this.runPokePreset());
    for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-slot]'))) {
      btn.addEventListener('click', (e) => {
        const n = Number(btn.dataset.slot);
        if (!n) return;
        if (e.shiftKey) void this.saveSlot(n);
        else void this.loadSlot(n);
      });
    }
    this.refreshSlotButtons();
    this.root.querySelector('[data-act="tape-pause"]')!.addEventListener('click', () => {
      const on = !this.runner?.tapePaused;
      this.runner?.setTapePaused(!!on);
      const btn = this.root.querySelector('[data-act="tape-pause"]') as HTMLButtonElement;
      btn.textContent = on ? 'Resume' : 'Pause';
      this.log(on ? 'Tape paused' : 'Tape resumed');
    });
    this.root.querySelector('[data-act="tape-autostop"]')!.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.runner?.setTapeAutoStop(on);
    });
    this.root.querySelector('[data-act="tape-queue-clear"]')!.addEventListener('click', () => {
      this.runner?.clearSpectrumTapeQueue();
      this.refreshTapeUi(true);
      this.log('Tape queue cleared');
    });
    this.watchInput.addEventListener('change', () => {
      const n = parseInt(this.watchInput.value.trim(), 16);
      if (Number.isFinite(n)) {
        this.watchAddr = n & 0xffff;
        if (this.runner?.spectrumHost) this.runner.spectrumHost.setWatchAddr(this.watchAddr);
      }
      this.refreshSpectrumRegs();
    });
    this.tapeRewBtn.addEventListener('click', () => {
      this.runner?.rewindSpectrumTape();
      this.refreshTapeUi(true);
      this.log('Tape rewind');
    });
    this.tapeNextBtn.addEventListener('click', () => {
      this.runner?.advanceSpectrumTape();
      this.refreshTapeUi(true);
      this.log(`Tape → block ${this.runner?.spectrumTapePos ?? 0}`);
    });
    this.tapeSel.addEventListener('change', () => {
      const n = Number(this.tapeSel.value);
      if (!Number.isFinite(n)) return;
      this.runner?.seekSpectrumTape(n);
      this.refreshTapeUi(true);
    });
    this.specTurboSel.addEventListener('change', () => {
      const v = Number(this.specTurboSel.value) as SpectrumTurbo;
      this.runner?.setSpectrumTurbo(v);
      this.refreshControls();
    });
    this.root.querySelector('[data-act="mute"]')!.addEventListener('click', () => {
      const runner = this.runner;
      if (!runner) return;
      void runner.ayAudio.ensure().then(() => {
        runner.setSpectrumMuted(!runner.ayAudio.isMuted);
        this.refreshControls();
      });
    });
    for (const g of SPECTRUM_GAMES) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `${g.title} (${g.kind.toUpperCase()})`;
      opt.title = g.note;
      this.gameSel.appendChild(opt);
      this.gameSelTab.appendChild(opt.cloneNode(true) as HTMLOptionElement);
    }
    const syncGameSels = (from: HTMLSelectElement, to: HTMLSelectElement) => {
      from.addEventListener('change', () => {
        to.value = from.value;
      });
    };
    syncGameSels(this.gameSel, this.gameSelTab);
    syncGameSels(this.gameSelTab, this.gameSel);
    const loadDemo = () => {
      this.gameSel.value = this.gameSelTab.value || this.gameSel.value;
      this.gameSelTab.value = this.gameSel.value;
      void this.doLoadDemoGame();
    };
    this.root.querySelector('[data-act="load-game"]')!.addEventListener('click', loadDemo);
    this.root.querySelector('[data-act="load-game-tab"]')!.addEventListener('click', loadDemo);
  }

  private useHostConsole(): boolean {
    const d = this.runner?.softDevices;
    return !!(d && (d.realCpm || d.consoleTouched || d.cpm));
  }

  private textGeometry(): { cols: number; rows: number; size: number } {
    if (this.useHostConsole()) {
      return { cols: CONSOLE_COLS, rows: CONSOLE_ROWS, size: CONSOLE_SIZE };
    }
    return { cols: FB_COLS, rows: FB_ROWS, size: FB_SIZE };
  }

  private panelCssSize(): { cssW: number; cssH: number } {
    const { cols, rows } = this.textGeometry();
    const textW = cols * CELL_W + PAD * 2;
    const textH = rows * CELL_H + PAD * 2;
    const cssW = Math.max(textW, BMP_WIDTH * BMP_SCALE + PAD * 2);
    const cssH = textH + BMP_GAP + BMP_HEIGHT * BMP_SCALE + PAD;
    return { cssW, cssH };
  }

  private spectrumCssSize(): { cssW: number; cssH: number } {
    return {
      cssW: SPEC_FRAME_W * SPEC_SCALE + PAD * 2,
      cssH: SPEC_FRAME_H * SPEC_SCALE + PAD * 2,
    };
  }

  private resizeBackingStore(): void {
    this.ensureConsoleBacking();
    this.ensureSpecBacking();
  }

  /**
   * Size the console canvas from the *intended* CSS size, not from
   * `clientWidth` — a hidden pane reports 0 there, which used to trigger a
   * reallocation (and clear) of both canvases on every frame.
   */
  private ensureConsoleBacking(): void {
    const dpr = window.devicePixelRatio || 1;
    const { cssW, cssH } = this.panelCssSize();
    if (cssW === this.consoleBackW && cssH === this.consoleBackH && dpr === this.consoleDpr) return;
    this.consoleBackW = cssW;
    this.consoleBackH = cssH;
    this.consoleDpr = dpr;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.consoleBannerShown = false;
  }

  private ensureSpecBacking(): void {
    const dpr = window.devicePixelRatio || 1;
    const { cssW, cssH } = this.spectrumCssSize();
    if (cssW === this.specBackW && cssH === this.specBackH && dpr === this.specDpr) return;
    this.specBackW = cssW;
    this.specBackH = cssH;
    this.specDpr = dpr;
    this.specCanvas.style.width = `${cssW}px`;
    this.specCanvas.style.height = `${cssH}px`;
    this.specCanvas.width = Math.round(cssW * dpr);
    this.specCanvas.height = Math.round(cssH * dpr);
    this.specCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawnSpecSeq = -1;
    this.specPlaceholderDrawn = false;
  }

  private setTab(tab: 'console' | 'spectrum'): void {
    this.activeTab = tab;
    for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const pane of Array.from(this.root.querySelectorAll<HTMLElement>('[data-pane]'))) {
      pane.hidden = pane.dataset.pane !== tab;
    }
    this.consoleBannerShown = false;
    this.drawnSpecSeq = -1;
    this.specPlaceholderDrawn = false;
    this.runner?.setSpectrumVideoEnabled(tab === 'spectrum');
    if (tab === 'spectrum') this.specCanvas.focus();
    this.draw(true);
  }

  private log(msg: string): void {
    if (!msg) return;
    const prev = this.outEl.textContent ?? '';
    const next = prev ? `${prev}\n${msg}` : msg;
    const lines = next.split('\n');
    this.outEl.textContent = lines.slice(-24).join('\n');
  }

  private doAssemble(go: boolean): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const addr = parseHex(this.loadAddr.value);
    if (addr === null) {
      this.log('! bad Load @ address (used as asm origin)');
      return;
    }
    const result = assemble(this.asmSource.value, addr);
    if (!result.ok) {
      for (const err of result.errors) this.log(`! ${err}`);
      return;
    }
    for (const line of result.listing) this.log(line);
    this.loadHex.value = bytesToHexPrompt(result.bytes);
    const loaded = loadHexAt(this.ram.bytes, addr, [...result.bytes]);
    this.log(loaded.ok ? loaded.message : `! ${loaded.message}`);
    if (!loaded.ok) return;
    if (go) {
      const g = runSoftCommand(this.ram.bytes, `G ${addr.toString(16)}`);
      this.log(g.message);
      if (g.reboot) {
        this.runner?.reboot();
        this.runner?.setRunning(true);
      }
    }
    this.draw();
    this.refreshControls();
  }

  private doBasic(go: boolean): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const addr = parseHex(this.loadAddr.value);
    if (addr === null) {
      this.log('! bad Load @ address (used as BASIC origin)');
      return;
    }
    try {
      const bytes = compileBasic(this.asmSource.value, addr, softIoLayoutForRam(this.ram.bytes));
      this.loadHex.value = bytesToHexPrompt(bytes);
      const loaded = loadHexAt(this.ram.bytes, addr, [...bytes]);
      this.log(loaded.ok ? `BASIC ${bytes.length}B @ ${addr.toString(16)}` : `! ${loaded.message}`);
      if (!loaded.ok) return;
      if (go) {
        const g = runSoftCommand(this.ram.bytes, `G ${addr.toString(16)}`);
        this.log(g.message);
        if (g.reboot) {
          this.runner?.reboot();
          this.runner?.setRunning(true);
        }
      }
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private doBootBasic(): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    try {
      this.asmSource.value = BASIC_DEMO_SOURCE.trim() + '\n';
      this.loadAddr.value = BASIC_ORIGIN.toString(16).padStart(4, '0');
      this.runner?.setSpectrumMode(false);
      const { bytes, origin } = loadBasicRom(this.ram.bytes);
      this.loadHex.value = bytesToHexPrompt(
        this.ram.bytes.subarray(origin, origin + bytes),
      );
      this.log(`BASIC demo ${bytes}B @ ${origin.toString(16)} (JP @0000)`);
      this.runner?.reboot();
      this.runner?.setRunning(true);
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private doBootCpm(real: boolean, withGames = false): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    if (this.ram.addrBits < 16 || this.ram.bytes.length < 0x10000) {
      this.log('! Boot CP/M needs Z80 with addrBits=16 (64K RAM)');
      return;
    }
    try {
      const disk = this.runner!.softDevices.disk;
      this.runner!.setSpectrumMode(false);
      if (real) {
        bootRealCpm(this.ram.bytes, disk, loadCpm22DiskImage());
        this.runner!.softDevices.cpm = null;
        this.runner!.softDevices.realCpm = true;
        this.runner!.softDevices.clearConsole();
        if (withGames) {
          mountCpmDriveB(this.runner!.softDevices, loadRogueDiskImage());
          this.log('Real CP/M 2.2 + B: rogue.dsk — try B: then ROGUE-VT');
        } else {
          this.runner!.softDevices.disks.length = 1;
          this.log('Real CP/M 2.2 (z80pack cpm22-1.dsk) — cold boot');
        }
      } else {
        const cpm = bootCpmSoft(this.ram.bytes, disk, { seed: true });
        this.runner!.softDevices.cpm = cpm;
        this.runner!.softDevices.realCpm = false;
        this.runner!.softDevices.clearConsole();
        this.log('Soft CP/M stub: disk seeded (DIR / TYPE README / HELLO)');
      }
      this.runner?.reboot();
      this.runner?.setRunning(true);
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private applyPoke(addCheat: boolean): void {
    const addrEl = this.root.querySelector('[data-act="poke-addr"]') as HTMLInputElement;
    const valEl = this.root.querySelector('[data-act="poke-val"]') as HTMLInputElement;
    const addr = parseInt(addrEl.value.trim(), 16);
    const val = parseInt(valEl.value.trim(), 16);
    if (!Number.isFinite(addr) || !Number.isFinite(val)) {
      this.log('! Poke needs hex addr and value');
      return;
    }
    try {
      this.runner?.pokeSpectrum(addr, val);
      this.log(`POKE ${addr.toString(16).padStart(4, '0')},${val & 0xff}`);
      if (addCheat) {
        this.sessionCheats.push({ addr: addr & 0xffff, val: val & 0xff });
        this.saveSessionCheats();
        this.refreshCheatList();
      }
      this.draw();
      this.refreshSpectrumRegs();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private loadSessionCheats(): void {
    try {
      const raw = sessionStorage.getItem(this.cheatStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { addr: number; val: number }[];
      if (Array.isArray(parsed)) this.sessionCheats = parsed;
    } catch {
      /* ignore */
    }
    this.refreshCheatList();
  }

  private saveSessionCheats(): void {
    try {
      sessionStorage.setItem(this.cheatStorageKey, JSON.stringify(this.sessionCheats));
    } catch {
      /* ignore */
    }
  }

  private refreshCheatList(): void {
    const sel = this.root.querySelector('[data-act="cheat-list"]') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = '';
    this.sessionCheats.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${c.addr.toString(16).padStart(4, '0')}=${(c.val & 0xff).toString(16).padStart(2, '0')}`;
      sel.appendChild(opt);
    });
  }

  private async onSpectrumFile(
    e: Event,
    kind: 'sna' | 'tap' | 'z80' | 'tzx' | 'scr' | 'trd',
  ): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.ensurePanelRam() || !this.runner) {
      this.log('no RAM attached');
      return;
    }
    if (this.ram!.addrBits < 16 || this.ram!.bytes.length < 0x10000) {
      this.log('! Spectrum file load needs addrBits=16 (64K RAM)');
      return;
    }
    try {
      this.cancelAutoType();
      const buf = new Uint8Array(await file.arrayBuffer());
      if (kind === 'sna') {
        const { pc, border, model, port7ffd } = this.runner.loadSpectrumSna(buf);
        saveSpectrumSession({ model, demoId: null });
        this.win.setTitle('TTY', `ZX Spectrum ${model} · SNA ${file.name}`);
        this.log(
          `SNA ${file.name} (${model}): PC=${pc.toString(16).padStart(4, '0')} border=${border}` +
            (model === '128' ? ` 7FFD=${port7ffd.toString(16).padStart(2, '0')}` : '') +
            ' — Soft Run',
        );
      } else if (kind === 'z80') {
        const { pc, border, model, port7ffd, version } = this.runner.loadSpectrumZ80(buf);
        saveSpectrumSession({ model, demoId: null });
        this.win.setTitle('TTY', `ZX Spectrum ${model} · Z80 ${file.name}`);
        this.log(
          `Z80 v${version} ${file.name} (${model}): PC=${pc.toString(16).padStart(4, '0')} border=${border}` +
            (model === '128' ? ` 7FFD=${port7ffd.toString(16).padStart(2, '0')}` : '') +
            ' — Soft Run',
        );
      } else if (kind === 'scr') {
        this.runner.loadSpectrumScr(buf);
        this.log(`SCR ${file.name} → display bank`);
        this.setTab('spectrum');
        this.draw();
        this.refreshControls();
        return;
      } else if (kind === 'trd') {
        const info = this.runner.mountSpectrumTrd(buf);
        this.log(
          `TRD ${file.name}: "${info.label}" ${info.sides}-side (${info.bytes.length} bytes) — Beta sector I/O (seek/R/W; not cycle-exact)`,
        );
        this.setTab('spectrum');
        this.draw();
        this.refreshControls();
        return;
      } else if (kind === 'tzx') {
        if (this.runner.spectrumTape && this.runner.spectrumTape.remaining > 0) {
          this.runner.enqueueSpectrumTape(file.name, 'tzx', buf);
          this.log(`TZX ${file.name} queued (Q=${this.runner.spectrumTapeQueueLength})`);
          this.refreshTapeUi(true);
          return;
        }
        const { blocks, cold, warnings } = this.runner.mountSpectrumTzx(buf);
        this.win.setTitle('TTY', `ZX Spectrum · TZX ${file.name}`);
        this.log(`TZX ${file.name}: ${blocks} block(s). Auto LOAD ""…`);
        for (const w of warnings) this.log(`! ${w}`);
        this.runner.setRunning(true);
        this.setTab('spectrum');
        this.draw();
        this.refreshControls();
        this.refreshTapeUi(true);
        void this.autoTypeLoadEmpty(cold);
        return;
      } else {
        if (this.runner.spectrumTape && this.runner.spectrumTape.remaining > 0) {
          this.runner.enqueueSpectrumTape(file.name, 'tap', buf);
          this.log(`TAP ${file.name} queued (Q=${this.runner.spectrumTapeQueueLength})`);
          this.refreshTapeUi(true);
          return;
        }
        const { blocks, cold } = this.runner.mountSpectrumTap(buf);
        this.win.setTitle('TTY', `ZX Spectrum · TAP ${file.name}`);
        this.log(`TAP ${file.name}: ${blocks} block(s). Auto LOAD ""…`);
        this.runner.setRunning(true);
        this.setTab('spectrum');
        this.draw();
        this.refreshControls();
        this.refreshTapeUi(true);
        void this.autoTypeLoadEmpty(cold);
        return;
      }
      this.setTab('spectrum');
      this.draw();
      this.refreshControls();
    } catch (err) {
      this.log(`! ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async doLoadDemoGame(): Promise<void> {
    const id = this.gameSel.value || this.gameSelTab.value;
    if (!id) {
      this.log('! Pick a bundled demo first');
      return;
    }
    this.gameSel.value = id;
    this.gameSelTab.value = id;
    const ram = this.ensurePanelRam();
    if (!ram || !this.runner) {
      this.log('no RAM attached');
      return;
    }
    if (ram.addrBits < 16 || ram.bytes.length < 0x10000) {
      this.log('! Demo load needs addrBits=16 (64K RAM)');
      return;
    }
    const entry = SPECTRUM_GAMES.find((g) => g.id === id);
    if (!entry) {
      this.log(`! Unknown demo ${id}`);
      return;
    }
    try {
      await this.applyDemoGame(entry);
    } catch (err) {
      this.log(`! ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyDemoGame(entry: SpectrumGameEntry): Promise<void> {
    // Kill any prior TAP auto-LOAD so Reboot → Load demo cannot race keystrokes.
    this.cancelAutoType();
    const buf = decodeSpectrumGame(entry);
    this.currentDemoId = entry.id;
    this.applyDemoControlHints(entry.id);
    if (entry.kind === 'sna') {
      const { pc, border, model, port7ffd } = this.runner!.loadSpectrumSna(buf);
      saveSpectrumSession({ model, demoId: entry.id });
      this.win.setTitle('TTY', `ZX Spectrum ${model} · ${entry.title}`);
      this.log(
        `Demo ${entry.file} (${model}): PC=${pc.toString(16).padStart(4, '0')} border=${border}` +
          (model === '128' ? ` 7FFD=${port7ffd.toString(16).padStart(2, '0')}` : '') +
          ' — Soft Run',
      );
      this.setTab('spectrum');
      this.focusSpectrumCanvas();
      this.draw();
      this.refreshControls();
      return;
    }

    // TAP demos: prefer entry.model or 48K BASIC so LOAD "" works
    const wantModel = entry.model ?? '48';
    this.runner!.ensureSpectrumSoft(wantModel);
    const { blocks } = this.runner!.mountSpectrumTap(buf);
    saveSpectrumSession({ model: wantModel, demoId: entry.id });
    this.win.setTitle('TTY', `ZX Spectrum · ${entry.title}`);
    this.log(`Demo TAP ${entry.file}: ${blocks} block(s). Auto LOAD ""…`);
    this.runner!.setRunning(true);
    this.setTab('spectrum');
    this.focusSpectrumCanvas();
    this.draw();
    this.refreshControls();
    this.refreshTapeUi(true);
    // Always use the longer screen-ready wait: Place Spectrum may already be
    // soft-booted (wasCold=false) but still in early ROM init — typing LOAD ""
    // too early leaves the tape at block 0 (ParaZXland never reaches PAUSE).
    void this.autoTypeLoadEmpty(true);
  }

  /** Invalidate in-flight TAP auto-LOAD and release sticky Spectrum keys. */
  private cancelAutoType(): void {
    this.autoTypeGen++;
    this.specKbd.clearAll();
  }

  private applyDemoControlHints(demoId: string): void {
    const hint = spectrumDemoHint(demoId);
    this.specJoy.setMode(hint.joyMode);
    this.specJoy.setHint(hint.padHint);
  }

  /** Prefer Spectrum canvas so browser / global keys hit the ULA, not the editor. */
  focusSpectrumCanvas(): void {
    this.setTab('spectrum');
    try {
      this.specCanvas.focus({ preventScroll: true });
    } catch {
      this.specCanvas.focus();
    }
  }

  /** Wait for BASIC input loop, type LOAD ""; retry once if tape never advances. */
  private async autoTypeLoadEmpty(cold: boolean): Promise<void> {
    const gen = ++this.autoTypeGen;
    const alive = () => gen === this.autoTypeGen && !!this.runner?.isSpectrum && this.win.visible;
    if (!alive()) return;
    this.runner!.setRunning(true);
    this.log(cold ? 'Waiting for Spectrum BASIC…' : 'Waiting briefly…');
    const ready = cold
      ? await waitForSpectrumBasicInputReady(
          () => this.runner?.spectrumMmu,
          () => this.runner?.softCpu,
          {
            timeoutMs: 14_000,
            minWaitMs: 500,
            getRgba: () => this.runner?.spectrumHost?.lastFrameRgba ?? this.runner?.lastSpectrumRgba,
            model: () => this.runner?.spectrumModel,
          },
        )
      : await waitForSpectrumScreenReady(() => this.runner?.spectrumMmu, {
          timeoutMs: 3_000,
          minWaitMs: 150,
          getRgba: () => this.runner?.spectrumHost?.lastFrameRgba ?? this.runner?.lastSpectrumRgba,
        });
    if (!alive()) return;
    this.runner!.setRunning(true);
    const tapeBefore = this.runner!.spectrumTapePos;
    this.log(ready ? 'Typing LOAD ""…' : 'Typing LOAD "" (BASIC wait timed out)…');
    await this.specKbd.typeLoadEmpty();
    if (!alive()) return;
    this.draw();
    this.focusSpectrumCanvas();
    // Under heavy UI/CDP load, short key pulses can miss frames — retry once.
    const advanced = await this.waitTapeAdvanced(tapeBefore, 3_500, gen);
    if (!alive()) return;
    if (advanced || this.runner!.spectrumTapePos > tapeBefore) {
      this.focusSpectrumCanvas();
      return;
    }
    this.log('LOAD "" did not start — retrying…');
    this.specKbd.clearAll();
    this.runner!.setRunning(true);
    await sleepMs(400);
    if (!alive()) return;
    await this.specKbd.typeLoadEmpty();
    if (!alive()) return;
    this.draw();
    this.focusSpectrumCanvas();
  }

  private async waitTapeAdvanced(
    before: number,
    timeoutMs: number,
    gen?: number,
  ): Promise<boolean> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      if (gen != null && gen !== this.autoTypeGen) return false;
      if (!this.runner?.isSpectrum) return false;
      if (this.runner.spectrumTapePos > before) return true;
      await sleepMs(80);
      this.draw();
    }
    if (gen != null && gen !== this.autoTypeGen) return false;
    return (this.runner?.spectrumTapePos ?? 0) > before;
  }

  /** Public entry for `#demo=` share links and tests. */
  async loadBundledDemoById(id: string): Promise<void> {
    const entry = findSpectrumGame(id);
    if (!entry) throw new Error(`Unknown demo id: ${id}`);
    this.gameSel.value = id;
    this.gameSelTab.value = id;
    await this.applyDemoGame(entry);
  }

  private downloadBytes(data: Uint8Array, filename: string, mime: string): void {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const blob = new Blob([copy], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private doSaveSna(): void {
    if (!this.runner?.isSpectrum) {
      this.log('! Save .SNA needs an active Spectrum session');
      return;
    }
    void (async () => {
      try {
        const data = await this.runner!.saveSpectrumSna();
        const model = this.runner!.spectrumModel ?? '48';
        this.downloadBytes(data, `spectrum-${model}.sna`, 'application/octet-stream');
        this.log(`Saved ${data.length}-byte ${model}K SNA`);
      } catch (e) {
        this.log(`! ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  private doSaveZ80(): void {
    if (!this.runner?.isSpectrum) {
      this.log('! Save .Z80 needs an active Spectrum session');
      return;
    }
    void (async () => {
      try {
        const data = await this.runner!.saveSpectrumZ80();
        const model = this.runner!.spectrumModel ?? '48';
        this.downloadBytes(data, `spectrum-${model}.z80`, 'application/octet-stream');
        this.log(`Saved ${data.length}-byte ${model}K Z80 v3`);
      } catch (e) {
        this.log(`! ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  private doSavePng(): void {
    if (!this.runner?.isSpectrum) {
      this.log('! Save PNG needs an active Spectrum session');
      return;
    }
    try {
      this.drawSpectrum(true);
      const w = SPEC_FRAME_W;
      const h = SPEC_FRAME_H;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      // specTmp holds the last blit — never a Worker buffer that may have been transferred.
      ctx.drawImage(this.specTmp, 0, 0);
      const url = c.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `spectrum-${this.runner.spectrumModel ?? '48'}.png`;
      a.click();
      this.log(`Saved ${w}×${h} PNG`);
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private doSaveScr(): void {
    if (!this.runner?.isSpectrum) {
      this.log('! Save .SCR needs an active Spectrum session');
      return;
    }
    void (async () => {
      try {
        const data = await this.runner!.saveSpectrumScr();
        this.downloadBytes(
          data,
          `spectrum-${this.runner!.spectrumModel ?? '48'}.scr`,
          'application/octet-stream',
        );
        this.log(`Saved ${data.length}-byte SCR`);
      } catch (e) {
        this.log(`! ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  private doNmi(): void {
    if (!this.runner?.isSpectrum) {
      this.log('! NMI needs an active Spectrum session');
      return;
    }
    try {
      this.runner.pulseSpectrumNmi();
      this.log('NMI → $0066');
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private runPokePreset(): void {
    if (!this.runner?.isSpectrum) {
      this.log('! Preset needs an active Spectrum session');
      return;
    }
    const sel = this.root.querySelector('[data-act="poke-preset"]') as HTMLSelectElement | null;
    const v = sel?.value ?? '';
    if (!v) {
      this.log('! Pick a preset first');
      return;
    }
    if (v === 'nmi') {
      this.doNmi();
      return;
    }
    if (v === 'border0' || v === 'border7') {
      const border = v === 'border0' ? 0 : 7;
      if (this.runner.spectrum) this.runner.spectrum.border = border;
      this.log(`Border → ${border}`);
      this.draw();
      return;
    }
    const cpu = this.runner.softCpu;
    if (v === 'ei' && cpu) {
      cpu.iff1 = true;
      cpu.iff2 = true;
      cpu.eiDelay = 0;
      this.log('Soft EI (IFF=11)');
      this.refreshSpectrumRegs();
      return;
    }
    if (v === 'di' && cpu) {
      cpu.iff1 = false;
      cpu.iff2 = false;
      cpu.eiDelay = 0;
      this.log('Soft DI (IFF=00)');
      this.refreshSpectrumRegs();
      return;
    }
  }

  private slotKey(n: number): string {
    return `${this.slotStorageKey}:${n}`;
  }

  private refreshSlotButtons(): void {
    for (let i = 1; i <= 4; i++) {
      let filled = false;
      try {
        filled = !!sessionStorage.getItem(this.slotKey(i));
      } catch {
        filled = false;
      }
      this.slotFilled[i - 1] = filled;
      const btn = this.root.querySelector(`[data-slot="${i}"]`);
      btn?.classList.toggle('is-filled', filled);
      if (btn) btn.setAttribute('title', filled ? `Slot ${i} — click load · Shift+click overwrite` : `Slot ${i} empty — Shift+click save`);
    }
  }

  private async saveSlot(n: number): Promise<void> {
    if (!this.runner?.isSpectrum || n < 1 || n > 4) return;
    try {
      const data = await this.runner.saveSpectrumSna();
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < data.length; i += chunk) {
        s += String.fromCharCode(...data.subarray(i, i + chunk));
      }
      sessionStorage.setItem(this.slotKey(n), btoa(s));
      this.refreshSlotButtons();
      this.log(`Slot ${n} saved (${data.length}B SNA)`);
    } catch (e) {
      this.log(`! Slot ${n} save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async loadSlot(n: number): Promise<void> {
    if (!this.runner?.isSpectrum || n < 1 || n > 4) return;
    let b64: string | null = null;
    try {
      b64 = sessionStorage.getItem(this.slotKey(n));
    } catch {
      b64 = null;
    }
    if (!b64) {
      this.log(`! Slot ${n} empty — Shift+click S${n} to save`);
      return;
    }
    try {
      const bin = atob(b64);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const { pc, model } = this.runner.loadSpectrumSna(data);
      this.log(`Slot ${n} loaded (${model}K) PC=${pc.toString(16).padStart(4, '0')}`);
      this.setTab('spectrum');
      this.focusSpectrumCanvas();
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! Slot ${n} load: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** F6–F9 load slots; Shift+F6–F9 save. */
  handleSlotHotkey(e: KeyboardEvent): boolean {
    if (!this.runner?.isSpectrum || !this.win.visible) return false;
    const map: Record<string, number> = { F6: 1, F7: 2, F8: 3, F9: 4 };
    const n = map[e.key];
    if (!n) return false;
    e.preventDefault();
    if (e.shiftKey) void this.saveSlot(n);
    else void this.loadSlot(n);
    return true;
  }

  /** Boot soft Spectrum when 64K RAM is already attached (Place Spectrum / menu). */
  bootSpectrumMachine(model: '48' | '128' = '48'): void {
    this.doBootSpectrum(model);
  }

  private doBootSpectrum(model: '48' | '128' = '48'): void {
    const ram = this.ensurePanelRam();
    if (!ram) {
      this.log('no RAM attached');
      return;
    }
    if (ram.addrBits < 16 || ram.bytes.length < 0x10000) {
      this.log('! Boot Spectrum needs Z80 with addrBits=16 (64K RAM)');
      return;
    }
    try {
      this.cancelAutoType();
      this.runner!.ensureSpectrumSoft(model);
      this.runner!.spectrumHost?.boot(model);
      this.runner?.setRunning(true);
      saveSpectrumSession({ model, demoId: null });
      this.win.setTitle('TTY', `ZX Spectrum ${model}K · Spectrum tab`);
      this.log(
        model === '128'
          ? 'Soft Spectrum 128K — editor ROM + banking (7FFD). Spectrum tab for screen + keys.'
          : 'Soft Spectrum 48K — © ready. Spectrum tab, Enter for K, then type (e.g. P → PRINT).',
      );
      this.setTab('spectrum');
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * After project reload: soft-reattach has RAM but no Spectrum host yet.
   * Restore last model (+ optional bundled demo) from `spectrumSession`.
   */
  async restoreSpectrumSession(hint: {
    model: '48' | '128';
    demoId: string | null;
  }): Promise<void> {
    this.bootSpectrumMachine(hint.model);
    if (hint.demoId) {
      this.gameSel.value = hint.demoId;
      this.gameSelTab.value = hint.demoId;
      try {
        await this.loadBundledDemoById(hint.demoId);
      } catch (err) {
        this.log(`! restore demo: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private runCommandLine(line: string): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const result = runSoftCommand(this.ram.bytes, line);
    this.log(result.ok ? result.message || 'ok' : `! ${result.message}`);
    if (result.reboot) {
      this.runner?.reboot();
      this.runner?.setRunning(true);
    }
    this.draw();
    this.refreshControls();
  }

  private doLoadHex(): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const addr = parseHex(this.loadAddr.value);
    if (addr === null) {
      this.log('! bad load address');
      return;
    }
    const blob = parseHexBlob(this.loadHex.value);
    if (!blob) {
      this.log('! bad hex blob');
      return;
    }
    const result = loadHexAt(this.ram.bytes, addr, blob);
    this.log(result.ok ? result.message : `! ${result.message}`);
    this.draw();
  }

  bindRunner(runner: MachineRunner | null): void {
    this.runner = runner;
    if (runner) {
      this.speedSel.value = runner.speed;
    }
    this.refreshControls();
  }

  /** RAM for Soft console / Spectrum loads (panel attach or runner soft-reattach). */
  private effectiveRam(): RamComponent | null {
    return this.ram ?? this.runner?.machineRam ?? null;
  }

  /** After reload, panel.ram may be unset while runner still has machineRam. */
  private ensurePanelRam(): RamComponent | null {
    const ram = this.effectiveRam();
    if (ram && this.ram !== ram) this.ram = ram;
    return this.ram;
  }

  /**
   * Soft-reattach after page reload leaves 64K RAM without Spectrum mode —
   * ensure soft ULA before Run/Reboot so the Spectrum tab is not a dead placeholder.
   */
  private ensureMachineReadyForRun(): void {
    const ram = this.ensurePanelRam();
    if (!ram || !this.runner) return;
    if (ram.addrBits >= 16 && ram.bytes.length >= 0x10000 && !this.runner.isSpectrum && !this.runner.isPlacedMachine) {
      try {
        this.runner.ensureSpectrumSoft('48');
        this.setTab('spectrum');
      } catch (err) {
        this.log(`! ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  attach(ram: RamComponent): void {
    this.detachRamOnly();
    // Non-Spectrum demos (LED / Port TTY / Lab REG) share this panel — always
    // land on Console with a TTY title so a prior Spectrum boot does not leave
    // the Spectrum tab open over an unrelated Soft ROM.
    this.setTab('console');
    this.win.setTitle('TTY', '80×25 VT100 · resize · 128×64 bmp');
    if (!requiresMachineMap(ram.addrBits)) {
      this.hint.textContent = `Need addrBits ≥ 12 (got ${ram.addrBits}).`;
      this.win.setVisible(true);
      this.refreshControls();
      return;
    }
    this.ram = ram;
    this.keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    this.keyUpHandler = (e: KeyboardEvent) => this.onKeyUp(e);
    this.canvas.addEventListener('keydown', this.keyHandler);
    this.canvas.addEventListener('keyup', this.keyUpHandler);
    this.specCanvas.addEventListener('keydown', this.keyHandler);
    this.specCanvas.addEventListener('keyup', this.keyUpHandler);
    this.hint.textContent =
      'Console = TTY/CP/M. Spectrum tab = screen + rubber keys. Soft Run = fast.';
    this.win.setVisible(true);
    this.draw();
    this.refreshControls();
  }

  private detachRamOnly(): void {
    this.cancelAutoType();
    if (this.keyHandler) {
      this.canvas.removeEventListener('keydown', this.keyHandler);
      this.specCanvas.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    if (this.keyUpHandler) {
      this.canvas.removeEventListener('keyup', this.keyUpHandler);
      this.specCanvas.removeEventListener('keyup', this.keyUpHandler);
      this.keyUpHandler = null;
    }
    this.ram = null;
  }

  detach(): void {
    this.detachRamOnly();
    // Keep `runner` binding across project reload — only bindRunner(null) clears it.
    this.win.setVisible(false);
    this.refreshControls();
  }

  get attached(): boolean {
    return this.effectiveRam() !== null;
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
  }

  refreshControls(): void {
    this.ensurePanelRam();
    const canRun = this.runner?.attached ?? false;
    const hasRam = this.effectiveRam() !== null;
    const spec = !!(this.runner?.isSpectrum);
    if (this.wasSpectrum && !spec) {
      this.specKbd.clearAll();
      this.specJoy.clear();
    }
    this.wasSpectrum = spec;
    this.specPlaceholder.hidden = spec;
    this.root.classList.toggle('machine-panel--spectrum', spec);
    const model = this.runner?.spectrumModel;
    if (model) {
      const trdos = this.runner?.spectrumMmu?.trdosPaged ? ' · TR-DOS* (Beta stub)' : '';
      this.specModelEl.textContent = `${model}K soft${trdos}`;
    } else {
      this.specModelEl.textContent = '48K / 128K soft';
    }
    this.btnRun.disabled = !canRun;
    this.btnPause.disabled = !canRun;
    this.btnStep.disabled = !canRun;
    this.btnReboot.disabled = !canRun;
    this.speedSel.disabled = !canRun;
    this.specTurboSel.disabled = !canRun || !spec;
    if (this.runner) {
      const t = String(this.runner.spectrumTurbo);
      if (this.specTurboSel.value !== t) this.specTurboSel.value = t;
    }
    this.cmdInput.disabled = !hasRam;
    this.loadAddr.disabled = !hasRam;
    this.loadHex.disabled = !hasRam;
    this.asmSource.disabled = !hasRam;
    const muteBtn = this.root.querySelector<HTMLButtonElement>('[data-act="mute"]');
    if (muteBtn) {
      muteBtn.disabled = !spec;
      muteBtn.classList.toggle('active', !!this.runner?.ayAudio.isMuted);
      muteBtn.textContent = this.runner?.ayAudio.isMuted ? 'Unmute' : 'Mute';
    }
    if (!canRun) {
      this.writeStatus('idle');
      return;
    }
    const spd = this.runner!.speed;
    const desync = this.runner!.softDesynced && spd !== 'soft' ? ' · desync' : '';
    const soft = this.runner!.softCpu;
    const softPc =
      spd === 'soft' && soft ? ` · PC=${soft.pc.toString(16).padStart(4, '0')}` : '';
    const turbo =
      spec && this.runner!.spectrumTurbo !== 1 ? ` · ×${this.runner!.spectrumTurbo}` : '';
    const bp = this.runner!.breakpointHit
      ? ' · BP HIT'
      : this.runner!.breakpointPc != null
        ? ` · BP=${this.runner!.breakpointPc.toString(16).padStart(4, '0')}`
        : '';
    const err = this.runner!.softError ? ` · !${this.runner!.softError.slice(0, 40)}` : '';
    this.writeStatus(
      `${this.runner!.running ? 'run' : 'pause'} · ${spd}${turbo}${softPc}${desync}${bp}${err}`,
    );
    this.btnRun.classList.toggle('active', this.runner!.running);
    this.btnPause.classList.toggle('active', !this.runner!.running);
  }

  /** Avoid DOM writes every soft frame when the status string is unchanged. */
  private writeStatus(text: string): void {
    if (text === this.lastStatusText) return;
    this.lastStatusText = text;
    this.statusEl.textContent = text;
  }

  /**
   * Per-rAF refresh. Canvases only repaint when their pane is visible and
   * their content changed; the text readouts (regs, health, tape, status) are
   * rebuilt at most every `TEXT_INTERVAL_MS` while the machine runs — each of
   * those `textContent` writes costs a layout + paint of the whole panel.
   * `force` bypasses the throttle (tab switch, pause, step).
   */
  draw(force = false): void {
    if (!this.ram) return;
    if (this.activeTab === 'console') this.drawConsole();
    else this.drawSpectrum();
    const now = performance.now();
    const running = !!this.runner?.running;
    if (running && !force && now - this.lastTextMs < MachinePanel.TEXT_INTERVAL_MS) return;
    this.lastTextMs = now;
    this.refreshSpectrumRegs();
    this.updateFocusTip();
    this.updateHealthLine();
    this.refreshTapeUi(false);
    if (this.runner?.isSoft && this.runner.attached) {
      const soft = this.runner.softCpu;
      const softPc = soft ? ` · PC=${soft.pc.toString(16).padStart(4, '0')}` : '';
      const desync = this.runner.softDesynced && this.runner.speed !== 'soft' ? ' · desync' : '';
      const turbo =
        this.runner.isSpectrum && this.runner.spectrumTurbo !== 1
          ? ` · ×${this.runner.spectrumTurbo}`
          : '';
      const err = this.runner.softError ? ` · !${this.runner.softError.slice(0, 40)}` : '';
      this.writeStatus(
        `${this.runner.running ? 'run' : 'pause'} · ${this.runner.speed}${turbo}${softPc}${desync}${err}`,
      );
    }
  }

  private drawConsole(): void {
    const { ctx } = this;
    this.ensureConsoleBacking();
    const cssW = this.consoleBackW;
    const cssH = this.consoleBackH;

    if (this.runner?.isSpectrum) {
      if (this.consoleBannerShown) return;
      this.consoleBannerShown = true;
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = '#1a1f2a';
      ctx.fillRect(PAD, PAD, cssW - PAD * 2, 40);
      ctx.fillStyle = '#8b93a7';
      ctx.font = `12px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      ctx.textBaseline = 'top';
      ctx.fillText('Spectrum mode — switch to the Spectrum tab for screen + keys', PAD + 4, PAD + 12);
      return;
    }
    this.consoleBannerShown = false;
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, cssW, cssH);

    const { cols, rows, size } = this.textGeometry();
    ctx.font = `12px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';

    const bytes = this.ram!.bytes;
    const L = softIoLayoutForRam(bytes);
    const devices = this.runner?.softDevices;
    const host = this.useHostConsole();
    const fbSrc = host && devices ? devices.consoleFb : bytes;
    const fbOff = host ? 0 : L.fbBase;
    for (let i = 0; i < size; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      const code = fbSrc[fbOff + i] ?? 0;
      const ch = code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : code === 0 ? ' ' : '·';
      const x = PAD + col * CELL_W;
      const y = PAD + row * CELL_H;
      ctx.fillStyle = '#1a1f2a';
      ctx.fillRect(x, y, CELL_W - 1, CELL_H - 1);
      ctx.fillStyle = '#c8d0e0';
      ctx.fillText(ch, x + 1, y + 2);
    }

    const bmpY = PAD + rows * CELL_H + BMP_GAP;
    const bmp = this.runner?.softDevices.bitmap;
    ctx.fillStyle = '#12151c';
    ctx.fillRect(PAD, bmpY, BMP_WIDTH * BMP_SCALE, BMP_HEIGHT * BMP_SCALE);
    if (bmp) {
      if (!this.bmpImage || this.bmpImage.width !== BMP_WIDTH || this.bmpImage.height !== BMP_HEIGHT) {
        this.bmpImage = this.bmpTmpCtx.createImageData(BMP_WIDTH, BMP_HEIGHT);
      }
      const img = this.bmpImage;
      for (let i = 0; i < BMP_WIDTH * BMP_HEIGHT; i++) {
        const bit = (bmp[(i / 8) | 0]! >> (7 - (i & 7))) & 1;
        const o = i * 4;
        const v = bit ? 200 : 18;
        img.data[o] = v;
        img.data[o + 1] = bit ? 210 : 20;
        img.data[o + 2] = bit ? 230 : 28;
        img.data[o + 3] = 255;
      }
      if (this.bmpTmp.width !== BMP_WIDTH || this.bmpTmp.height !== BMP_HEIGHT) {
        this.bmpTmp.width = BMP_WIDTH;
        this.bmpTmp.height = BMP_HEIGHT;
      }
      this.bmpTmpCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.bmpTmp, PAD, bmpY, BMP_WIDTH * BMP_SCALE, BMP_HEIGHT * BMP_SCALE);
    }

    const status = bytes[L.keyStatus] ?? 0;
    const data = bytes[L.keyData] ?? 0;
    this.root.dataset.keyStatus = String(status);
    this.root.dataset.keyData = `0x${(data & 0xff).toString(16).padStart(2, '0')}`;
  }

  private refreshTapeUi(force: boolean): void {
    const tape = this.runner?.spectrumTape ?? null;
    const sig = tape
      ? `${tape.blocks.length}:${tape.pos}:${tape.blocks.map((b) => b.flag).join(',')}`
      : '';
    if (!force && sig === this.lastTapeSig) return;
    this.lastTapeSig = sig;
    const has = !!tape && tape.blocks.length > 0;
    this.tapeSel.disabled = !has;
    this.tapeRewBtn.disabled = !has;
    this.tapeNextBtn.disabled = !has || tape!.pos >= tape!.blocks.length;
    this.tapeSel.innerHTML = '';
    if (!has) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— empty —';
      this.tapeSel.appendChild(opt);
      return;
    }
    for (let i = 0; i < tape!.blocks.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = describeTapBlock(tape!.blocks[i]!, i);
      if (i === tape!.pos) opt.selected = true;
      this.tapeSel.appendChild(opt);
    }
    // Marker for "past end"
    if (tape!.pos >= tape!.blocks.length) {
      const opt = document.createElement('option');
      opt.value = String(tape!.pos);
      opt.textContent = '— end —';
      opt.selected = true;
      this.tapeSel.appendChild(opt);
    }
    const prog = this.root.querySelector('[data-act="tape-prog"]') as HTMLProgressElement | null;
    if (prog) {
      prog.max = Math.max(1, tape!.blocks.length);
      prog.value = Math.min(tape!.pos, tape!.blocks.length);
    }
    const qEl = this.root.querySelector('[data-act="tape-queue"]');
    if (qEl) qEl.textContent = `Q:${this.runner?.spectrumTapeQueueLength ?? 0}`;
  }

  private refreshSpectrumRegs(): void {
    if (!this.runner?.isSpectrum) {
      if (this.lastRegsText !== '—') {
        this.lastRegsText = '—';
        this.regsEl.textContent = '—';
      }
      return;
    }
    const text = formatSpectrumRegs(
      this.runner.softCpu,
      this.runner.spectrumMmu,
      this.runner.ayAudio.chip,
      {
        watchAddr: this.watchAddr,
        watchBytes: this.runner.spectrumHost?.lastWatchBytes,
        breakpointPc: this.runner.breakpointPc,
        breakpointHit: this.runner.breakpointHit,
        breakWriteAddr: this.runner.breakWriteAddr,
        breakWriteHit: this.runner.spectrumHost?.engine.breakWriteHit,
        contended: this.runner.contended,
        expansion: this.runner.expansion,
        trd: this.runner.trdDisk,
      },
    );
    if (text === this.lastRegsText) return;
    this.lastRegsText = text;
    this.regsEl.textContent = text;
    this.updatePauseTip();
    this.updateFocusTip();
    this.updateHealthLine();
  }

  /** Show tip when ROM PAUSE ($1F3E) / press-any-key with IFF on. */
  private updatePauseTip(): void {
    if (!this.pauseTipEl) return;
    const cpu = this.runner?.softCpu;
    const show =
      !!this.runner?.isSpectrum &&
      !!cpu &&
      cpu.iff1 &&
      (cpu.pc & 0xffff) >= 0x1f3d &&
      (cpu.pc & 0xffff) <= 0x1f4f;
    this.pauseTipEl.hidden = !show;
  }

  private updateFocusTip(): void {
    if (!this.focusTipEl) return;
    const spec =
      !!this.runner?.isSpectrum &&
      this.win.visible &&
      this.activeTab === 'spectrum' &&
      !!this.runner.running;
    const focused = document.activeElement === this.specCanvas;
    this.focusTipEl.hidden = !spec || focused;
  }

  private updateHealthLine(): void {
    if (!this.healthEl || !this.runner?.isSpectrum) {
      if (this.healthEl && this.lastHealthText !== '—') {
        this.lastHealthText = '—';
        this.healthEl.textContent = '—';
      }
      return;
    }
    const host = this.runner.spectrumHost;
    const cpu = this.runner.softCpu;
    const cont = this.runner.contended;
    const tape = this.runner.spectrumTape;
    const path = host?.usingWorker ? 'worker' : 'main';
    const im = cpu ? `IM${cpu.im}` : 'IM?';
    const iff = cpu ? `IFF=${cpu.iff1 ? 1 : 0}${cpu.iff2 ? 1 : 0}` : '';
    const halt = cpu?.halted ? ' HALT' : '';
    const contend = cont ? `contend≈${cont.hits}` : '';
    const tapePos =
      tape && tape.blocks.length
        ? `tape ${tape.pos}/${tape.blocks.length}`
        : 'tape —';
    const text = [path, im + halt, iff, contend, tapePos].filter(Boolean).join(' · ');
    if (text === this.lastHealthText) return;
    this.lastHealthText = text;
    this.healthEl.textContent = text;
  }

  /**
   * Blit the newest engine picture. Skipped when nothing new arrived since the
   * last blit (`spectrumRgbaSeq`). The engine's RGBA buffer is wrapped in an
   * `ImageData` without copying — `putImageData` is the only copy left.
   */
  private drawSpectrum(force = false): void {
    this.ensureSpecBacking();
    const cssW = this.specBackW;
    const cssH = this.specBackH;
    const ctx = this.specCtx;

    if (!this.runner?.isSpectrum || !this.runner.spectrum || !this.ram) {
      if (this.specPlaceholderDrawn && !force) return;
      this.specPlaceholderDrawn = true;
      this.drawnSpecSeq = -1;
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = '#12151c';
      ctx.fillRect(PAD, PAD, SPEC_FRAME_W * SPEC_SCALE, SPEC_FRAME_H * SPEC_SCALE);
      return;
    }
    this.specPlaceholderDrawn = false;

    const n = SPEC_FRAME_W * SPEC_FRAME_H * 4;
    const engineRgba = this.runner.lastSpectrumRgba;
    const haveEngineRgba = !!engineRgba && engineRgba.length >= n;
    const seq = this.runner.spectrumRgbaSeq;
    if (haveEngineRgba && !force && seq === this.drawnSpecSeq) return;

    let img: ImageData;
    if (haveEngineRgba) {
      const src = engineRgba!;
      // Zero-copy view (the constructor requires an exact-length clamped array).
      img = new ImageData(
        new Uint8ClampedArray(src.buffer as ArrayBuffer, src.byteOffset, n),
        SPEC_FRAME_W,
        SPEC_FRAME_H,
      );
    } else {
      const screen = this.runner.spectrumMmu?.displayBank() ?? this.ram.bytes;
      const flash = spectrumFlashPhase(performance.now());
      renderSpectrumFrame(screen, this.runner.spectrum.border, this.specRgba, flash);
      if (!this.specImage) this.specImage = new ImageData(this.specRgba, SPEC_FRAME_W, SPEC_FRAME_H);
      img = this.specImage;
    }
    if (this.drawnSpecSeq === -1) {
      // First paint after (re)size: fill the frame around the picture once.
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, cssW, cssH);
    }
    this.specTmpCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.specTmp, PAD, PAD, SPEC_FRAME_W * SPEC_SCALE, SPEC_FRAME_H * SPEC_SCALE);
    this.drawnSpecSeq = seq;
    this.runner.markSpectrumDrawn();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.applySpectrumKey(e, true)) return;
    if (!this.ram) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;

    const code = mapKey(e);
    if (code === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.runner?.softDevices) this.runner.softDevices.injectKey(this.ram.bytes, code);
    else injectKey(this.ram.bytes, code);
    this.draw();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.applySpectrumKey(e, false)) return;
  }

  /**
   * Route keys into the soft ULA while Spectrum is running.
   * Used both from canvas listeners and from window (games need keys even when
   * the circuit canvas has focus — otherwise editor hotkeys steal Q/W/O/P/Space).
   */
  handleGlobalKey(e: KeyboardEvent, down: boolean): boolean {
    if (down && this.handleSlotHotkey(e)) return true;
    return this.applySpectrumKey(e, down);
  }

  private applySpectrumKey(e: KeyboardEvent, down: boolean): boolean {
    if (!this.ram || !this.win.visible) return false;
    if (!this.runner?.isSpectrum || !this.runner.spectrum) return false;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      return false;
    }
    const label = mapBrowserKeyToSpectrum(e.key, e.code);
    if (label === null) {
      // Still claim nothing — let editor handle unknown keys
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    const host = this.runner.spectrumHost;
    const ula = this.runner.spectrum;
    const keys = Array.isArray(label) ? label : [label];
    for (const k of keys) {
      if (host) host.setKey(k, down);
      else ula.setKey(k, down);
    }

    // Mirror arrows / fire onto the active pad mode (Kempston / Cursor / Sinclair / WASD)
    const joy = (bit: 0 | 1 | 2 | 3 | 4) => {
      const mode = this.specJoy.mode;
      if (mode === 'kempston') {
        if (host) host.setKempston(bit, down);
        else ula.setKempston(bit, down);
        return;
      }
      const keys = joyMatrixKeys(mode);
      const label = keys?.[bit];
      if (!label) return;
      if (host) host.setKey(label, down);
      else ula.setKey(label, down);
    };
    if (e.code === 'ArrowRight' || e.key === 'ArrowRight') joy(0);
    else if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') joy(1);
    else if (e.code === 'ArrowDown' || e.key === 'ArrowDown') joy(2);
    else if (e.code === 'ArrowUp' || e.key === 'ArrowUp') joy(3);
    else if (e.code === 'Space' || e.key === ' ' || e.code === 'KeyZ' || e.key.toLowerCase() === 'z') {
      joy(4);
    }
    return true;
  }
}

/** Map printable keys + Enter/Backspace to a single byte. Returns null to ignore. */
export function mapKey(e: KeyboardEvent): number | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === 'Enter') return 0x0d;
  if (e.key === 'Backspace') return 0x08;
  if (e.key === 'Tab') return 0x09;
  if (e.key.length === 1) {
    const c = e.key.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return c;
  }
  return null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
