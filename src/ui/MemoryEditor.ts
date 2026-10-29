/**
 * Cell-based hex memory editor for RamComponent / RomComponent.
 * Includes a bottom asm / disasm split for Z80 code at `@`.
 * Pure parse/format helpers stay exported for unit tests / file I/O.
 */

import { assemble, bytesToHexPrompt, type AssembleResult } from '../machine/assembler.js';
import { disassemble, formatDisasmLine, type DisasmLine } from '../machine/disassembler.js';
import type { MemoryComponent } from '../sim/types.js';
import { FloatingWindow } from './FloatingWindow.js';

const COLS = 16;
const ROW_H = 22;
const OVERSCAN = 4;
const DISASM_COUNT = 32;

export function parseHexBlob(text: string): number[] {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16) & 0xff);
  }
  return bytes;
}

export function formatHexDump(bytes: Uint8Array, base = 0, cols = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += cols) {
    const addr = (base + i).toString(16).padStart(4, '0');
    const slice = [...bytes.subarray(i, i + cols)];
    const hex = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${addr}  ${hex.padEnd(cols * 3 - 1)}  ${ascii}`);
  }
  return lines.join('\n');
}

export function applyBytes(mem: MemoryComponent, offset: number, data: number[]): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const addr = offset + i;
    if (addr < 0 || addr >= mem.bytes.length) break;
    mem.bytes[addr] = data[i]! & 0xff;
    n++;
  }
  return n;
}

function asciiChar(b: number): string {
  return b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
}

function hexByte(b: number): string {
  return b.toString(16).padStart(2, '0');
}

/** Rows of the hex view to build for a scroll position, which is stale when a smaller memory replaces a scrolled one. */
export function hexRowWindow(scrollTop: number, viewHeight: number, totalRows: number): { first: number; count: number } {
  const first = Math.min(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN), totalRows - 1);
  const count = Math.max(1, Math.min(totalRows - first, Math.ceil(viewHeight / ROW_H) + OVERSCAN * 2));
  return { first, count };
}

interface FollowWindow {
  start: number;
  addrs: ReadonlySet<number>;
}

/** Where a Follow PC listing is (re)anchored: the PC, or address 0 when the whole memory fits in one listing. */
export function followAnchor(pc: number, memorySize: number, listingLength: number): number {
  return memorySize <= listingLength ? 0 : pc;
}

/** Where the Follow PC listing starts: unchanged while the PC is on a listed instruction, else at the anchor. */
export function followWindowStart(window: FollowWindow | null, pc: number, anchor = pc): number {
  return window?.addrs.has(pc) ? window.start : anchor;
}

export interface EditorIsa {
  name: string;
  disassemble: (bytes: Uint8Array, addr: number, count: number) => DisasmLine[];
  assemble: (source: string, origin: number) => AssembleResult;
}

export class MemoryEditor {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private mem: MemoryComponent | null = null;
  private isa: EditorIsa | null = null;
  private followWindow: FollowWindow | null = null;
  private readonly addrEl: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private readonly viewEl: HTMLElement;
  private readonly spacerEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly asmEl: HTMLTextAreaElement;
  private readonly disasmEl: HTMLElement;
  private readonly followPcEl: HTMLInputElement;
  private onChange: (() => void) | null = null;
  /** Soft machine: JP @addr + reboot/run after Assemble+Go. */
  private onGo: ((addr: number, mem: MemoryComponent) => boolean) | null = null;

  private cursor = 0;
  /** Soft PC highlight (null = off). Independent of edit cursor unless Follow PC. */
  private livePc: number | null = null;
  private notice: string | null = null;
  private readOnly = false;
  /** After typing the high nibble, wait for the low one before advancing. */
  private pendingHi: number | null = null;
  private renderPending = false;

  constructor() {
    this.win = new FloatingWindow('Memory', 'memory-editor');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="memory-editor-toolbar">
        <label>@ <input name="addr" size="4" value="0000" spellcheck="false" /></label>
        <button type="button" data-act="goto">Goto</button>
        <button type="button" data-act="reload">Reload</button>
        <button type="button" data-act="fill0">Fill 00</button>
        <button type="button" data-act="save-hex">Save .hex</button>
        <button type="button" data-act="load-file">Load file</button>
        <input type="file" data-act="file" accept=".bin,.hex,.txt,application/octet-stream" hidden />
      </div>
      <div class="hex-head" aria-hidden="true">
        <span class="hex-addr">addr</span>
        <span class="hex-bytes">${Array.from({ length: COLS }, (_, i) =>
          `<span class="hex-b">${i.toString(16)}</span>`,
        ).join('')}</span>
        <span class="hex-asc">ASCII</span>
      </div>
      <div class="hex-view" tabindex="0" role="grid" aria-label="Hex memory"></div>
      <div class="memory-asm-split">
        <div class="memory-asm-pane">
          <div class="memory-asm-label">Assemble @ (origin = toolbar address)</div>
          <textarea name="asm" class="memory-asm" rows="6" spellcheck="false" placeholder="; Z80 asm — Assemble loads at @"></textarea>
        </div>
        <div class="memory-disasm-pane">
          <div class="memory-asm-label">
            Disassembly
            <label class="memory-follow-pc" title="Scroll disasm with soft PC"><input type="checkbox" name="follow-pc" /> Follow PC</label>
          </div>
          <div class="memory-disasm" tabindex="0" role="list" aria-label="Disassembly"></div>
        </div>
      </div>
      <div class="memory-asm-actions">
        <button type="button" data-act="asm">Assemble → @</button>
        <button type="button" data-act="asm-go" title="Assemble, load, soft G @ + reboot">Assemble + Go</button>
        <button type="button" data-act="disasm">Disasm from cursor</button>
      </div>
      <div class="lab-panel-status">Select a RAM/ROM (dblclick) to edit.</div>
    `;
    this.addrEl = this.root.querySelector('input[name="addr"]')!;
    this.statusEl = this.root.querySelector('.lab-panel-status')!;
    this.viewEl = this.root.querySelector('.hex-view')!;
    this.asmEl = this.root.querySelector('textarea[name="asm"]')!;
    this.disasmEl = this.root.querySelector('.memory-disasm')!;
    this.followPcEl = this.root.querySelector('input[name="follow-pc"]')!;
    this.spacerEl = document.createElement('div');
    this.spacerEl.className = 'hex-spacer';
    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'hex-rows';
    this.viewEl.append(this.spacerEl, this.rowsEl);

    this.root.querySelector('[data-act="goto"]')!.addEventListener('click', () => this.gotoAddr());
    this.root.querySelector('[data-act="reload"]')!.addEventListener('click', () => this.refresh());
    this.root.querySelector('[data-act="fill0"]')!.addEventListener('click', () => this.fill(0));
    this.root.querySelector('[data-act="save-hex"]')!.addEventListener('click', () => this.saveHex());
    this.root.querySelector('[data-act="load-file"]')!.addEventListener('click', () => {
      (this.root.querySelector('[data-act="file"]') as HTMLInputElement).click();
    });
    this.root.querySelector('[data-act="file"]')!.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.loadFile(file);
    });
    this.root.querySelector('[data-act="asm"]')!.addEventListener('click', () => this.doAssemble(false));
    this.root.querySelector('[data-act="asm-go"]')!.addEventListener('click', () => this.doAssemble(true));
    this.root.querySelector('[data-act="disasm"]')!.addEventListener('click', () => this.refreshDisasm());
    this.addrEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.gotoAddr();
      }
    });

    this.viewEl.addEventListener('scroll', () => this.scheduleRender());
    this.viewEl.addEventListener('click', (ev) => this.onClick(ev));
    this.viewEl.addEventListener('keydown', (ev) => this.onKeyDown(ev));
    this.viewEl.addEventListener('paste', (ev) => this.onPaste(ev));
    new ResizeObserver(() => this.scheduleRender()).observe(this.viewEl);
  }

  setOnChange(fn: (() => void) | null): void {
    this.onChange = fn;
  }

  /** The hook returns false when no running machine uses this memory. */
  setOnGo(fn: ((addr: number, mem: MemoryComponent) => boolean) | null): void {
    this.onGo = fn;
  }

  /**
   * Soft PC for disasm highlight. When Follow PC is checked, also scrolls the
   * hex cursor to PC. Returns true if the highlighted line changed.
   */
  setLivePc(pc: number | null): boolean {
    const next = pc == null ? null : pc & 0xffff;
    const prev = this.livePc;
    this.livePc = next;
    if (this.followPcEl.checked && next != null && this.mem) {
      if (next !== this.cursor) this.setCursor(next, true);
      else this.refreshDisasm();
    } else if (next !== prev) {
      this.refreshDisasm();
    } else {
      this.paintPcHighlight();
    }
    return next !== prev;
  }

  /** Replace the Z80 assembler and disassembly pane with another instruction set; null restores Z80. */
  setIsa(isa: EditorIsa | null): void {
    if (isa === this.isa) return;
    this.isa = isa;
    this.asmEl.placeholder = `; ${isa?.name ?? 'Z80'} asm — Assemble loads at @`;
    this.refreshDisasm();
  }

  get memory(): MemoryComponent | null {
    return this.mem;
  }

  get attached(): boolean {
    return this.mem !== null;
  }

  attach(mem: MemoryComponent): void {
    this.mem = mem;
    this.cursor = 0;
    this.pendingHi = null;
    this.win.setTitle(mem.kind === 'rom' ? 'ROM' : 'RAM', `${1 << mem.addrBits}×${mem.dataBits}`);
    this.refresh();
    this.win.setVisible(true);
    queueMicrotask(() => this.viewEl.focus());
  }

  detach(): void {
    this.mem = null;
    this.livePc = null;
    this.rowsEl.replaceChildren();
    this.spacerEl.style.height = '0';
    this.disasmEl.replaceChildren();
    this.statusEl.textContent = 'Select a RAM/ROM (dblclick) to edit.';
    this.win.setVisible(false);
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
  }

  refresh(): void {
    if (!this.mem) return;
    this.cursor = Math.min(this.cursor, this.mem.bytes.length - 1);
    this.pendingHi = null;
    this.render(true);
    this.refreshDisasm();
    this.renderStatus();
  }

  /** A live view of memory that something else owns: every way of changing a byte is switched off. */
  setReadOnly(on: boolean): void {
    if (on === this.readOnly) return;
    this.readOnly = on;
    this.pendingHi = null;
    for (const act of ['fill0', 'load-file', 'asm', 'asm-go']) {
      (this.root.querySelector(`[data-act="${act}"]`) as HTMLButtonElement).disabled = on;
    }
  }

  /** A warning shown instead of the usual hint, e.g. when this memory is not what the machine runs on. */
  setNotice(text: string | null): void {
    if (text === this.notice) return;
    this.notice = text;
    if (this.mem) this.renderStatus();
  }

  private renderStatus(): void {
    this.statusEl.textContent =
      this.notice ?? `${this.mem!.bytes.length} bytes · click a cell, type hex · asm/disasm below`;
    this.statusEl.classList.toggle('is-warning', this.notice !== null);
  }

  private parseAddr(): number {
    const n = parseInt(this.addrEl.value.trim(), 16);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  private gotoAddr(): void {
    if (!this.mem) return;
    const addr = Math.min(this.parseAddr(), this.mem.bytes.length - 1);
    this.setCursor(addr, true);
    this.viewEl.focus();
  }

  private setCursor(addr: number, scrollIntoView: boolean): void {
    if (!this.mem) return;
    this.cursor = Math.max(0, Math.min(addr, this.mem.bytes.length - 1));
    this.pendingHi = null;
    this.addrEl.value = this.cursor.toString(16).padStart(4, '0');
    if (scrollIntoView) {
      const row = Math.floor(this.cursor / COLS);
      const top = row * ROW_H;
      const bottom = top + ROW_H;
      if (top < this.viewEl.scrollTop) this.viewEl.scrollTop = top;
      else if (bottom > this.viewEl.scrollTop + this.viewEl.clientHeight) {
        this.viewEl.scrollTop = bottom - this.viewEl.clientHeight;
      }
    }
    this.render();
    this.refreshDisasm();
  }

  private refreshDisasm(): void {
    if (!this.mem) {
      this.disasmEl.replaceChildren();
      return;
    }
    // Origin: the PC when following, else the edit cursor. A followed listing
    // stays put while the PC moves inside it, so the pane does not jump or resize.
    const following = this.followPcEl.checked && this.livePc != null;
    const origin = following
      ? followWindowStart(this.followWindow, this.livePc!, followAnchor(this.livePc!, this.mem.bytes.length, DISASM_COUNT))
      : this.cursor;
    const lines = this.isa
      ? this.isa.disassemble(this.mem.bytes, origin, DISASM_COUNT)
      : disassemble(this.mem.bytes, origin, { count: DISASM_COUNT });
    this.followWindow = following ? { start: origin, addrs: new Set(lines.map((d) => d.addr)) } : null;
    this.disasmEl.replaceChildren();
    for (const d of lines) {
      const row = document.createElement('div');
      row.className = 'memory-disasm-line';
      row.dataset.addr = String(d.addr);
      row.textContent = formatDisasmLine(d);
      row.addEventListener('click', () => this.setCursor(d.addr, true));
      this.disasmEl.appendChild(row);
    }
    this.paintPcHighlight();
  }

  private paintPcHighlight(): void {
    const pc = this.livePc;
    let matched: HTMLElement | null = null;
    for (const el of this.disasmEl.querySelectorAll('.memory-disasm-line')) {
      const row = el as HTMLElement;
      const addr = Number(row.dataset.addr);
      const on = pc != null && addr === pc;
      row.classList.toggle('is-pc', on);
      if (on) matched = row;
    }
    matched?.scrollIntoView({ block: 'nearest' });
  }

  private doAssemble(go: boolean): void {
    if (this.readOnly) return;
    if (!this.mem) {
      this.statusEl.textContent = 'No RAM/ROM attached.';
      return;
    }
    const addr = Math.min(this.parseAddr(), this.mem.bytes.length - 1);
    const result = this.isa ? this.isa.assemble(this.asmEl.value, addr) : assemble(this.asmEl.value, addr);
    if (!result.ok) {
      this.statusEl.textContent = result.errors[0] ?? 'assemble failed';
      this.disasmEl.replaceChildren();
      for (const err of result.errors) {
        const row = document.createElement('div');
        row.className = 'memory-disasm-line is-err';
        row.textContent = err;
        this.disasmEl.appendChild(row);
      }
      return;
    }
    const n = applyBytes(this.mem, addr, [...result.bytes]);
    this.pendingHi = null;
    this.setCursor(addr, true);
    this.render(true);
    this.refreshDisasm();
    this.statusEl.textContent = `assembled ${n} bytes @ ${addr.toString(16).padStart(4, '0')} (${bytesToHexPrompt(result.bytes).slice(0, 48)}${result.bytes.length > 16 ? '…' : ''})`;
    this.onChange?.();
    if (go) {
      if (this.isa) this.statusEl.textContent += ` · Go is Z80-only (${this.isa.name} bytes loaded)`;
      else if (!this.onGo?.(addr, this.mem)) this.statusEl.textContent += ' · no machine runs this memory (bytes loaded)';
    }
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.render();
    });
  }

  private render(force = false): void {
    if (!this.mem) return;
    const len = this.mem.bytes.length;
    const totalRows = Math.max(1, Math.ceil(len / COLS));
    this.spacerEl.style.height = `${totalRows * ROW_H}px`;

    const viewH = this.viewEl.clientHeight || ROW_H * 16;
    const { first, count } = hexRowWindow(this.viewEl.scrollTop, viewH, totalRows);

    // Reuse DOM rows when possible.
    while (this.rowsEl.childElementCount > count) this.rowsEl.lastElementChild!.remove();
    while (this.rowsEl.childElementCount < count) {
      const row = document.createElement('div');
      row.className = 'hex-row';
      row.setAttribute('role', 'row');
      const addr = document.createElement('span');
      addr.className = 'hex-addr';
      const bytes = document.createElement('span');
      bytes.className = 'hex-bytes';
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('span');
        cell.className = 'hex-b';
        cell.setAttribute('role', 'gridcell');
        bytes.appendChild(cell);
      }
      const asc = document.createElement('span');
      asc.className = 'hex-asc';
      for (let c = 0; c < COLS; c++) {
        const ch = document.createElement('span');
        ch.className = 'hex-a';
        asc.appendChild(ch);
      }
      row.append(addr, bytes, asc);
      this.rowsEl.appendChild(row);
    }

    const bytes = this.mem.bytes;
    for (let i = 0; i < count; i++) {
      const rowIndex = first + i;
      const row = this.rowsEl.children[i] as HTMLElement;
      row.style.transform = `translateY(${rowIndex * ROW_H}px)`;
      const base = rowIndex * COLS;
      (row.querySelector('.hex-addr') as HTMLElement).textContent = base.toString(16).padStart(4, '0');
      const hexCells = row.querySelectorAll('.hex-b');
      const ascCells = row.querySelectorAll('.hex-a');
      for (let c = 0; c < COLS; c++) {
        const addr = base + c;
        const hexEl = hexCells[c] as HTMLElement;
        const ascEl = ascCells[c] as HTMLElement;
        if (addr >= len) {
          hexEl.textContent = '';
          hexEl.removeAttribute('data-a');
          hexEl.classList.remove('sel', 'hi');
          ascEl.textContent = '';
          ascEl.removeAttribute('data-a');
          ascEl.classList.remove('sel');
          continue;
        }
        const b = bytes[addr]!;
        hexEl.textContent = hexByte(b);
        hexEl.dataset.a = String(addr);
        const onCursor = addr === this.cursor;
        hexEl.classList.toggle('sel', onCursor);
        hexEl.classList.toggle('hi', onCursor && this.pendingHi !== null);
        ascEl.textContent = asciiChar(b);
        ascEl.dataset.a = String(addr);
        ascEl.classList.toggle('sel', onCursor);
      }
    }

    if (force) void this.viewEl.offsetHeight;
  }

  private onClick(ev: MouseEvent): void {
    const t = (ev.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!t?.dataset.a) return;
    const addr = Number(t.dataset.a);
    if (!Number.isFinite(addr)) return;
    this.setCursor(addr, false);
    this.viewEl.focus();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.mem) return;
    // Keep chorded editor shortcuts (Ctrl+Z etc.) for the schematic; swallow
    // everything else so tool keys (1/2/3/w/…) do not fire while typing hex.
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const swallow = (): void => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    if (this.readOnly && (ev.key === 'Backspace' || ev.key === 'Delete' || /^[0-9a-fA-F]$/.test(ev.key))) {
      swallow();
      return;
    }

    const len = this.mem.bytes.length;
    const move = (delta: number): void => {
      swallow();
      this.setCursor(this.cursor + delta, true);
    };

    switch (ev.key) {
      case 'ArrowLeft':
        move(-1);
        return;
      case 'ArrowRight':
        move(1);
        return;
      case 'ArrowUp':
        move(-COLS);
        return;
      case 'ArrowDown':
        move(COLS);
        return;
      case 'Home':
        swallow();
        this.setCursor(ev.shiftKey ? 0 : this.cursor - (this.cursor % COLS), true);
        return;
      case 'End':
        swallow();
        this.setCursor(
          ev.shiftKey ? len - 1 : Math.min(len - 1, this.cursor - (this.cursor % COLS) + COLS - 1),
          true,
        );
        return;
      case 'PageUp':
        swallow();
        this.viewEl.scrollTop -= this.viewEl.clientHeight;
        this.setCursor(
          this.cursor - COLS * Math.max(1, Math.floor(this.viewEl.clientHeight / ROW_H)),
          true,
        );
        return;
      case 'PageDown':
        swallow();
        this.viewEl.scrollTop += this.viewEl.clientHeight;
        this.setCursor(
          this.cursor + COLS * Math.max(1, Math.floor(this.viewEl.clientHeight / ROW_H)),
          true,
        );
        return;
      case 'Tab':
        swallow();
        this.setCursor(this.cursor + (ev.shiftKey ? -1 : 1), true);
        return;
      case 'Backspace':
        swallow();
        if (this.pendingHi !== null) {
          this.pendingHi = null;
          this.render();
        } else {
          this.writeByte(this.cursor, 0);
          this.setCursor(this.cursor - 1, true);
        }
        return;
      case 'Delete':
        swallow();
        this.writeByte(this.cursor, 0);
        this.pendingHi = null;
        this.render();
        return;
      case 'Escape':
        swallow();
        this.viewEl.blur();
        return;
      default:
        break;
    }

    const ch = ev.key.length === 1 ? ev.key : '';
    if (/^[0-9a-fA-F]$/.test(ch)) {
      swallow();
      const nibble = parseInt(ch, 16);
      if (this.pendingHi === null) {
        this.pendingHi = nibble;
        const cur = this.mem.bytes[this.cursor]!;
        this.mem.bytes[this.cursor] = ((nibble << 4) | (cur & 0x0f)) & 0xff;
        this.render();
        this.refreshDisasm();
        this.onChange?.();
      } else {
        this.writeByte(this.cursor, ((this.pendingHi << 4) | nibble) & 0xff);
        this.pendingHi = null;
        this.setCursor(this.cursor + 1, true);
      }
    }
  }

  private onPaste(ev: ClipboardEvent): void {
    if (!this.mem || this.readOnly) return;
    const text = ev.clipboardData?.getData('text') ?? '';
    const data = parseHexBlob(text);
    if (data.length === 0) return;
    ev.preventDefault();
    const n = applyBytes(this.mem, this.cursor, data);
    this.pendingHi = null;
    this.setCursor(Math.min(this.mem.bytes.length - 1, this.cursor + Math.max(0, n - 1)), true);
    this.statusEl.textContent = `pasted ${n} bytes @ ${this.cursor.toString(16).padStart(4, '0')}`;
    this.onChange?.();
  }

  private writeByte(addr: number, value: number): void {
    if (!this.mem || this.readOnly || addr < 0 || addr >= this.mem.bytes.length) return;
    this.mem.bytes[addr] = value & 0xff;
    this.refreshDisasm();
    this.onChange?.();
  }

  private fill(value: number): void {
    if (!this.mem || this.readOnly) return;
    this.mem.bytes.fill(value & 0xff);
    this.pendingHi = null;
    this.render(true);
    this.refreshDisasm();
    this.statusEl.textContent = `filled with ${value.toString(16).padStart(2, '0')}`;
    this.onChange?.();
  }

  private saveHex(): void {
    if (!this.mem) return;
    const blob = new Blob([formatHexDump(this.mem.bytes)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.mem.kind}-${1 << this.mem.addrBits}.hex`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async loadFile(file: File): Promise<void> {
    if (!this.mem || this.readOnly) return;
    const buf = await file.arrayBuffer();
    const isText = /\.(hex|txt)$/i.test(file.name) || file.type.startsWith('text/');
    let data: number[];
    if (isText) {
      data = parseHexBlob(new TextDecoder().decode(buf));
    } else {
      data = [...new Uint8Array(buf)];
    }
    const n = applyBytes(this.mem, this.parseAddr(), data);
    this.refresh();
    this.statusEl.textContent = `loaded ${n} bytes from ${file.name}`;
    this.onChange?.();
  }
}
