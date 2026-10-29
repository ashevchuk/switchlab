/**
 * On-screen ZX Spectrum 40-key rubber keyboard for soft ULA matrix input.
 * Caps Shift / Symbol Shift are sticky (toggle); other keys press while held.
 */

import type { SpectrumUla } from '../machine/spectrum/ula.js';

type KeyDef = {
  /** Matrix label for SpectrumUla.setKey */
  id: string;
  label: string;
  /** Optional Symbol-Shift legend */
  sym?: string;
  /** Wider key styling */
  wide?: 'enter' | 'caps' | 'sym' | 'space';
  /** Modifier toggle (sticky) */
  sticky?: 'caps' | 'sym';
};

/** Visual layout (not matrix order) — classic Spectrum. */
const KEY_ROWS: readonly (readonly KeyDef[])[] = [
  [
    { id: '1', label: '1', sym: '!' },
    { id: '2', label: '2', sym: '@' },
    { id: '3', label: '3', sym: '#' },
    { id: '4', label: '4', sym: '$' },
    { id: '5', label: '5', sym: '%' },
    { id: '6', label: '6', sym: '&' },
    { id: '7', label: '7', sym: "'" },
    { id: '8', label: '8', sym: '(' },
    { id: '9', label: '9', sym: ')' },
    { id: '0', label: '0', sym: '_' },
  ],
  [
    { id: 'Q', label: 'Q', sym: '<=' },
    { id: 'W', label: 'W', sym: '<>' },
    { id: 'E', label: 'E', sym: '>=' },
    { id: 'R', label: 'R', sym: '<' },
    { id: 'T', label: 'T', sym: '>' },
    { id: 'Y', label: 'Y', sym: 'AND' },
    { id: 'U', label: 'U', sym: 'OR' },
    { id: 'I', label: 'I', sym: 'AT' },
    { id: 'O', label: 'O', sym: ';' },
    { id: 'P', label: 'P', sym: '"' },
  ],
  [
    { id: 'A', label: 'A', sym: 'STOP' },
    { id: 'S', label: 'S', sym: 'NOT' },
    { id: 'D', label: 'D', sym: 'STEP' },
    { id: 'F', label: 'F', sym: 'TO' },
    { id: 'G', label: 'G', sym: 'THEN' },
    { id: 'H', label: 'H', sym: '↑' },
    { id: 'J', label: 'J', sym: '-' },
    { id: 'K', label: 'K', sym: '+' },
    { id: 'L', label: 'L', sym: '=' },
    { id: 'Enter', label: 'ENTER', wide: 'enter' },
  ],
  [
    { id: 'Shift', label: 'CAPS', wide: 'caps', sticky: 'caps' },
    { id: 'Z', label: 'Z', sym: ':' },
    { id: 'X', label: 'X', sym: '£' },
    { id: 'C', label: 'C', sym: '?' },
    { id: 'V', label: 'V', sym: '/' },
    { id: 'B', label: 'B', sym: '*' },
    { id: 'N', label: 'N', sym: ',' },
    { id: 'M', label: 'M', sym: '.' },
    { id: 'Sym', label: 'SYM', wide: 'sym', sticky: 'sym' },
    { id: 'Space', label: 'SPACE', wide: 'space' },
  ],
];

const HOLD_MS = 90;
const GAP_MS = 80;
/** Longer holds for auto LOAD "" — short pulses are missed when rAF is busy/throttled. */
const AUTO_HOLD_MS = 280;
const AUTO_GAP_MS = 160;

export class SpectrumKeyboard {
  readonly root: HTMLElement;
  private capsSticky = false;
  private symSticky = false;
  private pressed = new Set<string>();
  private getUla: () => SpectrumUla | null;
  /** Optional dual-path key inject (Worker host). Falls back to getUla().setKey. */
  private setKeyFn: ((label: string, down: boolean) => void) | null = null;
  private onLoadEmpty: (() => void) | null = null;
  /** Called after matrix changes so the panel can redraw. */
  onActivity: (() => void) | null = null;

  constructor(
    getUla: () => SpectrumUla | null,
    setKey?: (label: string, down: boolean) => void,
    onLoadEmpty?: () => void,
  ) {
    this.getUla = getUla;
    this.setKeyFn = setKey ?? null;
    this.onLoadEmpty = onLoadEmpty ?? null;
    this.root = document.createElement('div');
    this.root.className = 'spec-kbd';
    // Lives on the Spectrum TTY tab — always visible there (do not hide/show
    // every soft frame; that used to recurse via clearAll → onActivity → draw).
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="spec-kbd-toolbar">
        <span class="spec-kbd-title">Spectrum keys</span>
        <button type="button" data-act="load-empty" title="Type LOAD &quot;&quot; + Enter">LOAD ""</button>
        <button type="button" data-act="clear" title="Release all keys / clear sticky">Clear</button>
      </div>
      <div class="spec-kbd-rows"></div>
      <div class="spec-kbd-hint">CAPS / SYM sticky · arrows = cursor · hold keys · physical keys work globally in Spectrum mode</div>
    `;
    const rowsEl = this.root.querySelector('.spec-kbd-rows')!;
    for (const row of KEY_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'spec-kbd-row';
      for (const key of row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'spec-kbd-key' + (key.wide ? ` spec-kbd-key--${key.wide}` : '');
        btn.dataset.key = key.id;
        if (key.sticky) btn.dataset.sticky = key.sticky;
        btn.innerHTML = key.sym
          ? `<span class="spec-kbd-sym">${escapeHtml(key.sym)}</span><span class="spec-kbd-main">${escapeHtml(key.label)}</span>`
          : `<span class="spec-kbd-main">${escapeHtml(key.label)}</span>`;
        btn.title = key.sym ? `${key.label} · Sym: ${key.sym}` : key.label;
        btn.addEventListener('pointerdown', (e) => this.onPointerDown(e, key));
        btn.addEventListener('pointerup', (e) => this.onPointerUp(e, key));
        btn.addEventListener('pointercancel', (e) => this.onPointerUp(e, key));
        btn.addEventListener('pointerleave', (e) => {
          if (e.buttons === 0) this.onPointerUp(e, key);
        });
        rowEl.appendChild(btn);
      }
      rowsEl.appendChild(rowEl);
    }

    this.root.querySelector('[data-act="clear"]')!.addEventListener('click', () => this.clearAll());
    this.root.querySelector('[data-act="load-empty"]')!.addEventListener('click', () => {
      if (this.onLoadEmpty) this.onLoadEmpty();
      else void this.typeLoadEmpty();
    });
    // Prevent stealing focus from canvas in a bad way — keep clicks local
    this.root.addEventListener('mousedown', (e) => e.preventDefault());
  }

  /** Optional hide; prefer leaving the kbd on the Spectrum tab always shown. */
  setVisible(show: boolean): void {
    const wasHidden = this.root.hidden;
    this.root.hidden = !show;
    if (!show && !wasHidden) this.clearAll();
  }

  private ula(): SpectrumUla | null {
    return this.getUla();
  }

  private setKey(label: string, down: boolean): void {
    if (this.setKeyFn) {
      this.setKeyFn(label, down);
      return;
    }
    this.ula()?.setKey(label, down);
  }

  private syncStickyUi(): void {
    for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.spec-kbd-key'))) {
      const sticky = btn.dataset.sticky;
      if (sticky === 'caps') btn.classList.toggle('is-sticky', this.capsSticky);
      else if (sticky === 'sym') btn.classList.toggle('is-sticky', this.symSticky);
    }
    this.root.classList.toggle('spec-kbd--sym', this.symSticky);
    this.root.classList.toggle('spec-kbd--caps', this.capsSticky);
  }

  private applyModifiers(): void {
    this.setKey('Shift', this.capsSticky || this.pressed.has('Shift'));
    this.setKey('Sym', this.symSticky || this.pressed.has('Sym'));
  }

  private press(id: string): void {
    if (!this.ula() && !this.setKeyFn) return;
    this.pressed.add(id);
    this.applyModifiers();
    if (id !== 'Shift' && id !== 'Sym') this.setKey(id, true);
    this.onActivity?.();
  }

  private release(id: string): void {
    if (!this.ula() && !this.setKeyFn) return;
    this.pressed.delete(id);
    if (id !== 'Shift' && id !== 'Sym') this.setKey(id, false);
    this.applyModifiers();
    this.onActivity?.();
  }

  clearAll(): void {
    const had =
      this.capsSticky || this.symSticky || this.pressed.size > 0 || !!this.ula() || !!this.setKeyFn;
    this.capsSticky = false;
    this.symSticky = false;
    this.pressed.clear();
    this.ula()?.clearKeys();
    // Also clear via inject path (Worker) — release common keys
    if (this.setKeyFn) {
      for (const id of [
        'Shift',
        'Sym',
        'Enter',
        'Space',
        'J',
        'P',
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
        'G',
        'H',
        'I',
        'K',
        'L',
        'M',
        'N',
        'O',
        'Q',
        'R',
        'S',
        'T',
        'U',
        'V',
        'W',
        'X',
        'Y',
        'Z',
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
      ]) {
        this.setKeyFn(id, false);
      }
    }
    this.syncStickyUi();
    // Do not call onActivity here — MachinePanel wires it to draw(), and
    // clearAll can run from refreshControls during draw (infinite recursion).
    if (had) {
      /* matrix cleared; panel redraws on its own tick */
    }
  }

  private onPointerDown(e: PointerEvent, key: KeyDef): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (key.sticky === 'caps') {
      this.capsSticky = !this.capsSticky;
      this.applyModifiers();
      this.syncStickyUi();
      this.onActivity?.();
      return;
    }
    if (key.sticky === 'sym') {
      this.symSticky = !this.symSticky;
      this.applyModifiers();
      this.syncStickyUi();
      this.onActivity?.();
      return;
    }
    (e.currentTarget as HTMLElement).classList.add('is-down');
    this.press(key.id);
  }

  private onPointerUp(e: PointerEvent, key: KeyDef): void {
    if (key.sticky) return;
    (e.currentTarget as HTMLElement).classList.remove('is-down');
    this.release(key.id);
  }

  /** Brief tap of a matrix key (with current sticky mods). */
  async tap(id: string): Promise<void> {
    this.press(id);
    await sleep(HOLD_MS);
    this.release(id);
    await sleep(GAP_MS);
  }

  /**
   * Automate LOAD "" + Enter for TAP loading.
   * Sym must be released between the two quotes — Spectrum ROM waits for a
   * fully idle matrix before accepting the next keypress.
   */
  async typeLoadEmpty(): Promise<void> {
    if (!this.ula() && !this.setKeyFn) return;
    this.clearAll();
    await sleep(AUTO_GAP_MS);
    await this.autoTap('J'); // keyword LOAD
    await this.autoTapQuote();
    await this.autoTapQuote();
    await this.autoTap('Enter');
    this.clearAll();
  }

  private async autoTap(id: string): Promise<void> {
    this.press(id);
    await sleep(AUTO_HOLD_MS);
    this.release(id);
    await sleep(AUTO_GAP_MS);
  }

  /** Sym+P for `"` then full release (Sym off) so ROM can see the next key. */
  private async autoTapQuote(): Promise<void> {
    this.symSticky = true;
    this.applyModifiers();
    this.syncStickyUi();
    await this.autoTap('P');
    this.symSticky = false;
    this.applyModifiers();
    this.syncStickyUi();
    await sleep(AUTO_GAP_MS);
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
