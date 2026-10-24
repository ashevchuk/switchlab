/**
 * Multi-channel logic analyzer bound to AnalyzerComponent sense pins.
 * Samples every armed analyzer on the circuit; the floating dialog shows
 * the device last opened via dblclick.
 */

import type { Circuit } from '../sim/Circuit.js';
import type { AnalyzerComponent, Level, NetMap } from '../sim/types.js';
import { FloatingWindow } from './FloatingWindow.js';

export type Sample = 0 | 1 | 'Z';

const MAX_SAMPLES = 4096;
const ROW_H = 28;
const LABEL_W = 72;
/** Horizontal scale: CSS pixels per sample (not "fit all"). */
const MIN_PX_PER_SAMPLE = 0.35;
const MAX_PX_PER_SAMPLE = 32;
const DEFAULT_PX_PER_SAMPLE = 3;

interface Capture {
  samples: Sample[][];
  write: number;
  count: number;
}

function channelLabel(device: AnalyzerComponent, ch: number): string {
  return device.channelLabels?.[ch]?.trim() || `ch${ch}`;
}

function edgeFired(
  prev: Sample | undefined,
  next: Sample,
  edge: AnalyzerComponent['triggerEdge'],
): boolean {
  if (prev !== 0 && prev !== 1) return false;
  if (next !== 0 && next !== 1) return false;
  if (edge === 'rise') return prev === 0 && next === 1;
  if (edge === 'fall') return prev === 1 && next === 0;
  return prev !== next;
}

export class LogicAnalyzer {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly statusEl: HTMLElement;
  private readonly metaNote: HTMLElement;
  private readonly triggerChSel: HTMLSelectElement;
  private readonly triggerEdgeSel: HTMLSelectElement;
  private device: AnalyzerComponent | null = null;
  private readonly captures = new Map<string, Capture>();
  private onRunChange: ((running: boolean) => void) | null = null;
  /** Sample index in display order (0 … count-1), or null when unset. */
  private cursorSample: number | null = null;
  /** Second cursor (shift-click); Δt vs cursor A. */
  private cursorBSample: number | null = null;
  onCursorChange: (() => void) | null = null;
  /** CSS pixels per sample — history keeps a fixed density; pan/scroll to browse. */
  private pxPerSample = DEFAULT_PX_PER_SAMPLE;
  /** Leftmost visible sample index. */
  private hScroll = 0;
  /** When true, keep the view pinned to the newest samples while armed. */
  private followLive = true;
  /** Optional clock period (frames) for rough time readout. */
  private timebaseFrames: number | null = null;
  private panDrag: { startX: number; startScroll: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    this.win = new FloatingWindow('Logic Analyzer', 'logic-analyzer');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="la-toolbar">
        <button type="button" data-act="run" title="Arm sampling">Arm</button>
        <button type="button" data-act="pause">Pause</button>
        <button type="button" data-act="clear">Clear</button>
        <button type="button" data-act="export">CSV</button>
        <button type="button" data-act="export-vcd" title="Export IEEE-ish VCD">VCD</button>
        <button type="button" data-act="export-png" title="Export waveform PNG">PNG</button>
        <label class="la-trig">Trig
          <select data-act="trig-ch" title="Trigger channel (none = free-run)"></select>
        </label>
        <label class="la-trig">Edge
          <select data-act="trig-edge">
            <option value="rise">↑</option>
            <option value="fall">↓</option>
            <option value="either">↕</option>
          </select>
        </label>
      </div>
      <div class="la-note">Wire nets into CH pins. Wheel zoom density · drag / Shift+wheel pan · follows live unless you scroll back. Click cursor A · Shift-click B.</div>
      <canvas class="la-canvas" width="420" height="120"></canvas>
      <div class="lab-panel-status">Place Analyzer · wire channels · Arm</div>
    `;
    this.metaNote = this.root.querySelector('.la-note')!;
    this.statusEl = this.root.querySelector('.lab-panel-status')!;
    this.canvas = this.root.querySelector('.la-canvas')!;
    this.triggerChSel = this.root.querySelector('[data-act="trig-ch"]')!;
    this.triggerEdgeSel = this.root.querySelector('[data-act="trig-edge"]')!;
    this.canvas.style.width = '100%';
    this.canvas.style.flex = '1 1 auto';
    this.canvas.style.minHeight = '120px';
    this.canvas.style.cursor = 'crosshair';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context missing');
    this.ctx = ctx;

    this.root.querySelector('[data-act="run"]')!.addEventListener('click', () => this.setRunning(true));
    this.root.querySelector('[data-act="pause"]')!.addEventListener('click', () => this.setRunning(false));
    this.root.querySelector('[data-act="clear"]')!.addEventListener('click', () => this.clear());
    this.root.querySelector('[data-act="export"]')!.addEventListener('click', () => this.exportCsv());
    this.root.querySelector('[data-act="export-vcd"]')!.addEventListener('click', () => this.exportVcd());
    this.root.querySelector('[data-act="export-png"]')!.addEventListener('click', () => this.exportPng());
    this.triggerChSel.addEventListener('change', () => this.applyTriggerFromUi());
    this.triggerEdgeSel.addEventListener('change', () => this.applyTriggerFromUi());
    this.canvas.addEventListener('click', (ev) => this.onCanvasClick(ev));
    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        this.onWheel(ev);
      },
      { passive: false },
    );
    this.canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const cap = this.device ? this.ensureCapture(this.device) : null;
      if (!cap || cap.count === 0) return;
      const { visible } = this.visibleWindow(cap.count);
      if (cap.count <= visible) return;
      this.panDrag = { startX: ev.offsetX, startScroll: this.hScroll };
      this.followLive = false;
      this.canvas.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this.panDrag) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const plotW = Math.max(1, (this.canvas.clientWidth || 420) - LABEL_W - 8);
      const cap = this.device ? this.ensureCapture(this.device) : null;
      if (!cap || cap.count === 0) return;
      const { visible } = this.visibleWindow(cap.count, plotW);
      const dx = x - this.panDrag.startX;
      const dSamples = Math.round((-dx / plotW) * visible);
      this.hScroll = this.clampScroll(this.panDrag.startScroll + dSamples, cap.count, visible);
      this.draw();
    });
    window.addEventListener('mouseup', () => {
      if (!this.panDrag) return;
      this.panDrag = null;
      this.syncFollowFromScroll();
      this.updateCanvasCursor();
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.win.visible && this.device) this.draw();
    });
    this.resizeObserver.observe(this.win.root);
  }

  private plotWidth(): number {
    return Math.max(1, (this.canvas.clientWidth || 420) - LABEL_W - 8);
  }

  private updateCanvasCursor(): void {
    if (!this.device) {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const cap = this.ensureCapture(this.device);
    const { visible } = this.visibleWindow(cap.count);
    this.canvas.style.cursor = cap.count > visible ? 'grab' : 'crosshair';
  }

  private syncFollowFromScroll(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    const { start, visible } = this.visibleWindow(cap.count);
    this.followLive = start + visible >= cap.count;
  }

  get attachedDevice(): AnalyzerComponent | null {
    return this.device;
  }

  get hasCursor(): boolean {
    return this.cursorSample != null && this.device != null;
  }

  getCursorSample(): number | null {
    return this.cursorSample;
  }

  /** Levels at the time cursor for each channel of the open device. */
  getCursorLevels(): Sample[] | null {
    if (this.cursorSample == null || !this.device) return null;
    const cap = this.ensureCapture(this.device);
    if (cap.count === 0) return null;
    const s = Math.max(0, Math.min(cap.count - 1, this.cursorSample));
    const out: Sample[] = [];
    for (let ch = 0; ch < this.device.channelCount; ch++) {
      const idx = (cap.write - cap.count + s + MAX_SAMPLES) % MAX_SAMPLES;
      out.push(cap.samples[ch]![idx]!);
    }
    return out;
  }

  clearCursor(): void {
    if (this.cursorSample == null && this.cursorBSample == null) return;
    this.cursorSample = null;
    this.cursorBSample = null;
    this.draw();
    this.onCursorChange?.();
  }

  /** Optional periodFrames from a free-running clock on the circuit (rough time). */
  setTimebaseFrames(period: number | null): void {
    this.timebaseFrames = period != null && period > 0 ? period : null;
    this.updateStatus();
  }

  private visibleWindow(count: number, plotW = this.plotWidth()): { start: number; visible: number } {
    const visible = Math.max(2, Math.min(count, Math.max(2, Math.floor(plotW / this.pxPerSample))));
    if (this.followLive) {
      this.hScroll = Math.max(0, count - visible);
    }
    const start = this.clampScroll(this.hScroll, count, visible);
    return { start, visible };
  }

  private clampScroll(scroll: number, count: number, visible: number): number {
    const maxScroll = Math.max(0, count - visible);
    return Math.max(0, Math.min(maxScroll, scroll | 0));
  }

  private onWheel(ev: WheelEvent): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    if (cap.count === 0) return;
    const plotW = this.plotWidth();
    const { start, visible } = this.visibleWindow(cap.count, plotW);
    const frac =
      plotW > 0 && ev.offsetX >= LABEL_W
        ? Math.max(0, Math.min(1, (ev.offsetX - LABEL_W) / plotW))
        : 0.5;
    const focus = start + frac * (visible - 1);

    if (ev.shiftKey) {
      const step = Math.max(1, Math.round(visible * 0.1));
      this.followLive = false;
      this.hScroll = this.clampScroll(this.hScroll + (ev.deltaY > 0 ? step : -step), cap.count, visible);
      this.syncFollowFromScroll();
    } else {
      const factor = ev.deltaY > 0 ? 1 / 1.25 : 1.25;
      this.pxPerSample = Math.max(
        MIN_PX_PER_SAMPLE,
        Math.min(MAX_PX_PER_SAMPLE, this.pxPerSample * factor),
      );
      const next = this.visibleWindow(cap.count, plotW);
      this.followLive = false;
      this.hScroll = this.clampScroll(
        Math.round(focus - frac * (next.visible - 1)),
        cap.count,
        next.visible,
      );
      this.syncFollowFromScroll();
    }
    this.updateCanvasCursor();
    this.draw();
  }

  private sampleToX(s: number, start: number, visible: number, plotW: number): number {
    if (visible <= 1) return LABEL_W;
    return LABEL_W + ((s - start) / (visible - 1)) * plotW;
  }

  private onCanvasClick(ev: MouseEvent): void {
    if (!this.device || this.panDrag) return;
    const cap = this.ensureCapture(this.device);
    const plotW = this.plotWidth();
    const x = ev.offsetX;
    if (cap.count === 0 || x < LABEL_W || plotW <= 0) {
      this.cursorSample = null;
      this.cursorBSample = null;
    } else {
      const { start, visible } = this.visibleWindow(cap.count, plotW);
      const t = Math.max(0, Math.min(1, (x - LABEL_W) / plotW));
      const sample = Math.round(start + t * Math.max(0, visible - 1));
      if (ev.shiftKey) this.cursorBSample = sample;
      else this.cursorSample = sample;
    }
    this.draw();
    this.onCursorChange?.();
  }

  setOnRunChange(fn: ((running: boolean) => void) | null): void {
    this.onRunChange = fn;
  }

  private applyTriggerFromUi(): void {
    if (!this.device) return;
    const raw = this.triggerChSel.value;
    this.device.triggerChannel = raw === '' ? null : Number(raw);
    const edge = this.triggerEdgeSel.value;
    this.device.triggerEdge = edge === 'fall' || edge === 'either' ? edge : 'rise';
  }

  private syncTriggerUi(): void {
    if (!this.device) return;
    const d = this.device;
    if (d.triggerChannel === undefined) d.triggerChannel = null;
    if (!d.triggerEdge) d.triggerEdge = 'rise';
    this.triggerChSel.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'none';
    this.triggerChSel.appendChild(none);
    for (let i = 0; i < d.channelCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = channelLabel(d, i);
      this.triggerChSel.appendChild(opt);
    }
    this.triggerChSel.value = d.triggerChannel == null ? '' : String(d.triggerChannel);
    this.triggerEdgeSel.value = d.triggerEdge;
  }

  attach(device: AnalyzerComponent): void {
    this.device = device;
    if (device.triggerChannel === undefined) device.triggerChannel = null;
    if (!device.triggerEdge) device.triggerEdge = 'rise';
    if (!device.channelLabels || device.channelLabels.length !== device.channelCount) {
      device.channelLabels = Array.from({ length: device.channelCount }, (_, i) =>
        device.channelLabels?.[i] || `ch${i}`,
      );
    }
    this.syncTriggerUi();
    this.ensureCapture(device);
    this.metaNote.textContent = `${device.channelCount} channels · fixed density · scroll history · optional edge trigger`;
    this.win.setTitle('Logic Analyzer', `${device.channelCount} ch`);
    this.root.querySelector('[data-act="run"]')!.classList.toggle('active', device.armed);
    this.followLive = true;
    this.updateStatus();
    this.win.setVisible(true);
    this.updateCanvasCursor();
    this.draw();
  }

  detach(): void {
    this.device = null;
    this.cursorSample = null;
    this.cursorBSample = null;
    this.win.setVisible(false);
  }

  get isArmed(): boolean {
    return this.device?.armed === true;
  }

  /** True if any analyzer on the given circuit is armed. */
  anyArmed(circuit: Circuit): boolean {
    for (const c of circuit.components.values()) {
      if (c.kind === 'analyzer' && c.armed) return true;
    }
    return false;
  }

  setRunning(running: boolean): void {
    if (!this.device) return;
    this.device.armed = running;
    this.root.querySelector('[data-act="run"]')!.classList.toggle('active', running);
    this.updateStatus();
    this.win.setTitle('Logic Analyzer', `${this.device.channelCount} ch${running ? ' · ARM' : ''}`);
    this.onRunChange?.(running);
  }

  clearChannels(): void {
    this.captures.clear();
    this.detach();
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
  }

  private ensureCapture(device: AnalyzerComponent): Capture {
    let cap = this.captures.get(device.id);
    if (!cap || cap.samples.length !== device.channelCount) {
      cap = {
        samples: Array.from({ length: device.channelCount }, () => new Array(MAX_SAMPLES).fill('Z')),
        write: 0,
        count: 0,
      };
      this.captures.set(device.id, cap);
    }
    return cap;
  }

  clear(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    cap.write = 0;
    cap.count = 0;
    this.cursorSample = null;
    this.cursorBSample = null;
    this.pxPerSample = DEFAULT_PX_PER_SAMPLE;
    this.hScroll = 0;
    this.followLive = true;
    for (const buf of cap.samples) buf.fill('Z');
    this.device.lastSample = undefined;
    this.draw();
    this.onCursorChange?.();
  }

  private formatTime(sample: number): string {
    if (this.timebaseFrames && this.timebaseFrames > 0) {
      const frames = sample; // one LA sample ≈ one sim frame while armed
      const periods = frames / this.timebaseFrames;
      return `t=${sample} (~${periods.toFixed(2)} clk)`;
    }
    return `t=${sample}`;
  }

  private updateStatus(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    const parts: string[] = [];
    parts.push(this.device.armed ? 'armed — sampling' : 'paused');
    if (cap.count > 0) {
      parts.push(`${cap.count} samples`);
      const { start, visible } = this.visibleWindow(cap.count);
      parts.push(`${this.pxPerSample.toFixed(1)} px/samp`);
      if (cap.count > visible) {
        parts.push(this.followLive ? 'follow' : `view ${start}–${start + visible - 1}`);
      }
      if (this.cursorSample != null) parts.push(`A ${this.formatTime(this.cursorSample)}`);
      if (this.cursorBSample != null) parts.push(`B ${this.formatTime(this.cursorBSample)}`);
      if (this.cursorSample != null && this.cursorBSample != null) {
        const dSamples = this.cursorBSample - this.cursorSample;
        let delta = `Δ=${dSamples} samp`;
        if (this.timebaseFrames && this.timebaseFrames > 0) {
          const dClk = dSamples / this.timebaseFrames;
          delta += ` (${dClk.toFixed(2)} clk)`;
        }
        parts.push(delta);
      }
      if (this.timebaseFrames) {
        parts.push(`clk ${this.timebaseFrames}f`);
        // Rough Hz assuming ~60 animation frames/sec.
        const hz = 60 / this.timebaseFrames;
        parts.push(`~${hz >= 10 ? hz.toFixed(0) : hz.toFixed(1)} Hz@60fps`);
      }
    }
    this.statusEl.textContent = parts.join(' · ');
  }

  /** Sample every armed analyzer on `circuit`. */
  sampleCircuit(circuit: Circuit, netMap: NetMap, levelOf: Map<string, Level>): void {
    let drew = false;
    for (const c of circuit.components.values()) {
      if (c.kind !== 'analyzer' || !c.armed) continue;
      if (c.triggerChannel === undefined) c.triggerChannel = null;
      if (!c.triggerEdge) c.triggerEdge = 'rise';

      const levels: Sample[] = [];
      for (let i = 0; i < c.channelCount; i++) {
        const pin = c.pins[`ch${i}`];
        let sample: Sample = 'Z';
        if (pin) {
          const net = netMap.netOf.get(pin.id);
          if (net) {
            const lvl = levelOf.get(net);
            if (lvl === 0 || lvl === 1) sample = lvl;
          }
        }
        levels.push(sample);
      }

      const prev = c.lastSample;
      let take = true;
      if (c.triggerChannel != null && c.triggerChannel >= 0 && c.triggerChannel < c.channelCount) {
        const ch = c.triggerChannel;
        take = edgeFired(prev?.[ch], levels[ch]!, c.triggerEdge);
      }
      c.lastSample = levels;

      if (!take) {
        if (this.device?.id === c.id) drew = true;
        continue;
      }

      const cap = this.ensureCapture(c);
      for (let i = 0; i < c.channelCount; i++) {
        cap.samples[i]![cap.write] = levels[i]!;
      }
      cap.write = (cap.write + 1) % MAX_SAMPLES;
      if (cap.count < MAX_SAMPLES) cap.count++;
      if (this.device?.id === c.id) drew = true;
    }
    if (drew && this.win.visible) this.draw();
  }

  private draw(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    const dpr = window.devicePixelRatio || 1;
    const nCh = this.device.channelCount;
    const cssW = this.canvas.clientWidth || 420;
    const minH = Math.max(80, nCh * ROW_H + 16);
    const cssH = Math.max(minH, this.canvas.clientHeight || minH);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const ctx = this.ctx;
    ctx.fillStyle = '#0e1016';
    ctx.fillRect(0, 0, cssW, cssH);

    if (cap.count === 0) {
      ctx.fillStyle = '#6a7184';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('no samples', 12, 24);
      this.updateStatus();
      return;
    }

    const plotW = cssW - LABEL_W - 8;
    const n = cap.count;
    const { start, visible } = this.visibleWindow(n);
    const end = Math.min(n, start + visible);

    for (let ch = 0; ch < nCh; ch++) {
      const y0 = 8 + ch * ROW_H;
      ctx.fillStyle = '#9aa1b3';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(channelLabel(this.device, ch), 4, y0 + 14);

      const buf = cap.samples[ch]!;
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let s = start; s < end; s++) {
        const idx = (cap.write - n + s + MAX_SAMPLES) % MAX_SAMPLES;
        const v = buf[idx]!;
        const y = v === 1 ? y0 + 4 : v === 0 ? y0 + ROW_H - 8 : y0 + ROW_H / 2;
        const x = this.sampleToX(s, start, visible, plotW);
        if (s === start) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    if (this.cursorSample != null && n > 0) {
      this.drawCursorLine(this.cursorSample, start, end, visible, plotW, cssH, '#f5c518', 'A');
    }
    if (this.cursorBSample != null && n > 0) {
      this.drawCursorLine(this.cursorBSample, start, end, visible, plotW, cssH, '#7ee787', 'B');
    }

    // Scroll thumb whenever history overflows the view (not only when "zoomed").
    if (n > visible) {
      const barW = plotW;
      const thumbW = Math.max(8, (visible / n) * barW);
      const thumbX = LABEL_W + (start / Math.max(1, n - visible)) * (barW - thumbW);
      ctx.fillStyle = 'rgba(154, 161, 179, 0.35)';
      ctx.fillRect(LABEL_W, cssH - 4, barW, 3);
      ctx.fillStyle = this.followLive ? '#7ee787' : '#4da3ff';
      ctx.fillRect(thumbX, cssH - 4, thumbW, 3);
    }

    this.updateStatus();
  }

  private drawCursorLine(
    sample: number,
    start: number,
    end: number,
    visible: number,
    plotW: number,
    cssH: number,
    color: string,
    tag: string,
  ): void {
    const n = this.device ? this.ensureCapture(this.device).count : 0;
    const s = Math.max(0, Math.min(n - 1, sample));
    if (s < start || s >= end) return;
    const ctx = this.ctx;
    const x = this.sampleToX(s, start, visible, plotW);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, cssH - 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${tag} ${this.formatTime(s)}`, x + 4, tag === 'A' ? 12 : 24);
  }

  private exportCsv(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    if (cap.count === 0) return;
    const labels = Array.from({ length: this.device.channelCount }, (_, i) =>
      channelLabel(this.device!, i),
    );
    const lines = [`t,${labels.join(',')}`];
    for (let s = 0; s < cap.count; s++) {
      const cols = [String(s)];
      for (let ch = 0; ch < this.device.channelCount; ch++) {
        const idx = (cap.write - cap.count + s + MAX_SAMPLES) % MAX_SAMPLES;
        cols.push(String(cap.samples[ch]![idx]));
      }
      lines.push(cols.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logic-analyzer.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Simple IEEE-1364-ish VCD (1 timescale unit = 1 sample). */
  private exportVcd(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    if (cap.count === 0) return;
    const ids = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const lines: string[] = [
      '$date',
      `  ${new Date().toISOString()}`,
      '$end',
      '$version',
      '  switchlab Logic Analyzer',
      '$end',
      '$timescale 1 ns $end',
      '$scope module logic $end',
    ];
    for (let ch = 0; ch < this.device.channelCount; ch++) {
      const id = ids[ch] ?? `s${ch}`;
      const name = channelLabel(this.device, ch).replace(/\s+/g, '_');
      lines.push(`$var wire 1 ${id} ${name} $end`);
    }
    lines.push('$upscope $end', '$enddefinitions $end');

    const prev: string[] = Array(this.device.channelCount).fill('x');
    for (let s = 0; s < cap.count; s++) {
      const changes: string[] = [];
      for (let ch = 0; ch < this.device.channelCount; ch++) {
        const idx = (cap.write - cap.count + s + MAX_SAMPLES) % MAX_SAMPLES;
        const v = cap.samples[ch]![idx]!;
        const chStr = v === 1 ? '1' : v === 0 ? '0' : 'x';
        if (chStr !== prev[ch]) {
          prev[ch] = chStr;
          changes.push(`${chStr}${ids[ch] ?? `s${ch}`}`);
        }
      }
      if (s === 0 || changes.length) {
        lines.push(`#${s}`);
        for (const c of changes) lines.push(c);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logic-analyzer.vcd';
    a.click();
    URL.revokeObjectURL(url);
  }

  private exportPng(): void {
    this.draw();
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logic-analyzer.png';
    a.click();
  }
}
