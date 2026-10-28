/**
 * Object inspector — configure the selected component (labels, button mode,
 * pulse timing, orientation, …) without modal prompts. Multi-select shows
 * bulk rotate/mirror when every selected part is orientable.
 */

import type { Circuit } from '../sim/Circuit.js';
import { bumpStructureVersion } from '../sim/Circuit.js';
import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { renamePort } from '../sim/hierarchy.js';
import {
  applyPinLayout,
  getOrientation,
  isOrientable,
  orientSelection,
  relayoutDefInstances,
} from '../sim/orientation.js';
import { CHIP_INSTANCE_WIDTH } from '../sim/library.js';
import { firePulse } from '../sim/labTick.js';
import { hasSoftLabModel, isSoftExpandForced, isSoftLabEnabled, setSoftExpandForced } from '../sim/softLab.js';
import type { ChipInstanceComponent, Component } from '../sim/types.js';
import type { Editor } from './Editor.js';
import { FloatingWindow } from './FloatingWindow.js';

const INSPECTOR_DOCK_KEY = 'sim.inspector.docked';

function loadInspectorDocked(): boolean {
  try {
    const v = localStorage.getItem(INSPECTOR_DOCK_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* ignore */
  }
  return true; // default: pinned to the left
}

export class ObjectInspector {
  private readonly win = new FloatingWindow('Inspector', 'object-inspector');
  private readonly dockBtn: HTMLButtonElement;
  private docked = true;
  private target: Component | null = null;
  private targets: Component[] = [];
  private lastSyncedKey: string | null = null;
  private circuit: Circuit | null = null;
  private library: ChipLibrary | null = null;
  /** ChipDef id when editing inside a folded chip (for port rename). */
  private defId: string | null = null;
  private allCircuits: Circuit[] = [];
  onChange: (() => void) | null = null;
  onBeforeEdit: (() => void) | null = null;
  /** Dive into a chip instance from the inspector. */
  onDive: ((inst: ChipInstanceComponent) => void) | null = null;
  /** Add pin id(s) to the watch list (no circuit edit). */
  onWatchPins: ((pinIds: string[]) => void) | null = null;
  /** Refresh pinSide/layout/revision from the shared ChipDef. */
  onUpdateFromLibrary: ((inst: ChipInstanceComponent) => void) | null = null;
  /**
   * After Soft Lab force-expand: settle the sim and read silicon `q*` pin levels.
   * Returns bit array (0/1) aligned with softQ, or null if unavailable.
   */
  onSettleReadQ:
    | ((inst: ChipInstanceComponent, softQ: Uint8Array) => Promise<Uint8Array | null>)
    | null = null;
  /** Editor for align/distribute (multi-select). */
  editor: Editor | null = null;

  constructor() {
    this.win.setTitle('Inspector', '');
    this.win.setVisible(false);
    this.dockBtn = this.win.addTitlebarButton('Dock', 'Pin to the left edge (or undock)');
    this.dockBtn.addEventListener('click', () => this.setDocked(!this.docked));
    this.docked = loadInspectorDocked();
    this.win.onDragStart = () => {
      if (this.docked) this.setDocked(false, /*persist=*/ false);
    };
    this.win.onDragEnd = (rect) => {
      if (rect.left < 28) this.setDocked(true);
      else this.persistDocked(false);
    };
    // Apply saved dock on first paint after chrome exists.
    queueMicrotask(() => this.applyDockLayout());
    window.addEventListener('resize', () => {
      if (this.docked && this.win.visible) this.applyDockLayout();
    });
  }

  private persistDocked(docked: boolean): void {
    this.docked = docked;
    try {
      localStorage.setItem(INSPECTOR_DOCK_KEY, docked ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  setDocked(docked: boolean, persist = true): void {
    if (persist) this.persistDocked(docked);
    else this.docked = docked;
    this.applyDockLayout();
  }

  private applyDockLayout(): void {
    const root = this.win.root;
    root.classList.toggle('is-docked', this.docked);
    this.dockBtn.textContent = this.docked ? 'Undock' : 'Dock';
    this.dockBtn.title = this.docked
      ? 'Detach inspector into a floating window'
      : 'Pin inspector to the left edge';
    if (this.docked) {
      const chrome = document.getElementById('chrome');
      const top = chrome ? Math.ceil(chrome.getBoundingClientRect().bottom) : 48;
      root.style.setProperty('--inspector-dock-top', `${top}px`);
      // Keep a usable width; height is stretched by CSS (top/bottom).
      if (!root.style.width) root.style.width = '300px';
      root.style.left = '0';
      root.style.top = `${top}px`;
      root.style.bottom = '0';
      root.style.height = 'auto';
      root.style.right = 'auto';
    } else {
      root.style.bottom = 'auto';
      root.style.height = '';
      const left = parseFloat(root.style.left || '0');
      if (!root.style.left || left < 8) {
        root.style.left = '48px';
        root.style.top = '56px';
      }
    }
  }

  setContext(opts: {
    circuit: Circuit;
    library: ChipLibrary;
    defId: string | null;
    allCircuits: Circuit[];
  }): void {
    this.circuit = opts.circuit;
    this.library = opts.library;
    this.defId = opts.defId;
    this.allCircuits = opts.allCircuits;
  }

  /**
   * Show inspector for one component, a multi-selection, or hide when empty.
   */
  sync(selected: Component | Component[] | null, force = false): void {
    const list = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
    const key = list.map((c) => c.id).sort().join(',') || null;
    if (!force && key === this.lastSyncedKey) {
      this.targets = list;
      this.target = list.length === 1 ? list[0]! : null;
      if (list.length === 0) this.win.setVisible(false);
      return;
    }
    if (key !== this.lastSyncedKey) this.softDiffNote = null;
    this.lastSyncedKey = key;
    this.targets = list;
    this.target = list.length === 1 ? list[0]! : null;
    if (list.length === 0) {
      this.win.setVisible(false);
      return;
    }
    if (list.length === 1) {
      this.win.setTitle('Inspector', list[0]!.kind);
      this.render();
    } else {
      this.win.setTitle('Inspector', `${list.length} selected`);
      this.renderMulti();
    }
    this.win.setVisible(true);
    this.applyDockLayout();
  }

  /** Rebuild form for the current target (after rotate from keyboard, etc.). */
  refresh(): void {
    if (this.targets.length > 1) this.renderMulti();
    else if (this.target) this.render();
  }

  private noteEdit(): void {
    this.onBeforeEdit?.();
  }

  private changed(): void {
    this.onChange?.();
    if (this.targets.length > 1) this.renderMulti();
    else this.render();
  }

  /** Snapshot Soft q → force transistor expand → settle → bit diff UI. */
  private async runSoftSiliconDiff(c: ChipInstanceComponent, defName: string): Promise<void> {
    if (!(c.softState?.q instanceof Uint8Array) || !c.softState.q.length) {
      this.softDiffNote = 'No Soft Lab q state to compare.';
      this.sync(c, true);
      return;
    }
    const softQ = Uint8Array.from(c.softState.q);
    let softHex = 0;
    for (let i = 0; i < softQ.length; i++) softHex |= (softQ[i]! & 1) << i;
    const softHexStr = `0x${softHex.toString(16).toUpperCase()}`;

    setSoftExpandForced(defName, true);
    this.onChange?.();

    const silicon = this.onSettleReadQ ? await this.onSettleReadQ(c, softQ) : null;
    if (!silicon || silicon.length !== softQ.length) {
      this.softDiffNote = `Soft ${softHexStr} (${softQ.length}b) · expanded, but could not read silicon q pins after settle.`;
      this.sync(c, true);
      return;
    }

    let silHex = 0;
    const diffs: number[] = [];
    for (let i = 0; i < softQ.length; i++) {
      const s = softQ[i]! & 1;
      const g = silicon[i]! & 1;
      silHex |= g << i;
      if (s !== g) diffs.push(i);
    }
    const silHexStr = `0x${silHex.toString(16).toUpperCase()}`;
    this.softDiffNote =
      diffs.length === 0
        ? `Soft ${softHexStr} = silicon ${silHexStr} · match (${softQ.length}b)`
        : `Soft ${softHexStr} ≠ silicon ${silHexStr} · diff bits [${diffs.join(', ')}]`;
    this.sync(c, true);
  }

  private softDiffNote: string | null = null;

  private orientTargets(mode: 'cw' | 'ccw' | 'flipH' | 'flipV'): void {
    const comps = this.targets.filter(isOrientable);
    const circuit = this.circuit;
    if (!circuit || comps.length === 0) return;
    orientSelection(comps, mode, (c, dx, dy) => circuit.moveComponent(c.id, dx, dy));
    this.editor?.tidySelectedWires(false);
  }

  private mkBtn(label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      'background:#20242f;border:1px solid #333a48;border-radius:6px;color:#e7e9ef;padding:5px 10px;font:12px ui-monospace,monospace;cursor:pointer';
    b.addEventListener('click', () => {
      this.noteEdit();
      fn();
      this.changed();
    });
    return b;
  }

  private renderMulti(): void {
    const body = this.win.body;
    body.replaceChildren();
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';

    const orientable = this.targets.filter(isOrientable);
    const summary = document.createElement('div');
    summary.style.cssText = 'font:12px ui-monospace,monospace;color:#9aa1b3';
    summary.textContent = `${this.targets.length} parts · ${orientable.length} rotatable`;
    body.appendChild(summary);

    if (this.targets.length >= 2 && this.editor) {
      const ed = this.editor;
      const alignRow = document.createElement('div');
      alignRow.style.display = 'flex';
      alignRow.style.flexWrap = 'wrap';
      alignRow.style.gap = '6px';
      alignRow.append(
        this.mkBtn('←', 'Align left (Alt+←)', () => ed.alignSelection('x', 'min')),
        this.mkBtn('→', 'Align right (Alt+→)', () => ed.alignSelection('x', 'max')),
        this.mkBtn('↑', 'Align top (Alt+↑)', () => ed.alignSelection('y', 'min')),
        this.mkBtn('↓', 'Align bottom (Alt+↓)', () => ed.alignSelection('y', 'max')),
        this.mkBtn('↔ mid', 'Align centers X', () => ed.alignSelection('x', 'mid')),
        this.mkBtn('↕ mid', 'Align centers Y', () => ed.alignSelection('y', 'mid')),
      );
      body.appendChild(alignRow);
      if (this.targets.length >= 3) {
        const distRow = document.createElement('div');
        distRow.style.display = 'flex';
        distRow.style.flexWrap = 'wrap';
        distRow.style.gap = '6px';
        distRow.append(
          this.mkBtn('Distribute H', 'Even spacing horizontally (Alt+Shift+←/→)', () =>
            ed.distributeSelection('x'),
          ),
          this.mkBtn('Distribute V', 'Even spacing vertically (Alt+Shift+↑/↓)', () =>
            ed.distributeSelection('y'),
          ),
        );
        body.appendChild(distRow);
      }
    }

    if (orientable.length === 0) return;

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '6px';
    row.append(
      this.mkBtn('↻ 90°', 'Rotate all clockwise (R)', () => this.orientTargets('cw')),
      this.mkBtn('↺ 90°', 'Rotate all counter-clockwise (Shift+R)', () => this.orientTargets('ccw')),
      this.mkBtn('Flip H', 'Flip all horizontally (M)', () => this.orientTargets('flipH')),
      this.mkBtn('Flip V', 'Flip all vertically (Shift+M)', () => this.orientTargets('flipV')),
    );
    const hint = document.createElement('div');
    hint.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
    hint.textContent = 'bulk orient · R / Shift+R / M / Shift+M · Alt+arrows align';
    body.append(row, hint);
  }

  private render(): void {
    const c = this.target;
    if (!c) return;
    const body = this.win.body;
    body.replaceChildren();
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';

    const addRow = (label: string, el: HTMLElement) => {
      const row = document.createElement('label');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '88px 1fr';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.fontSize = '12px';
      row.style.color = '#9aa1b3';
      const lab = document.createElement('span');
      lab.textContent = label;
      row.append(lab, el);
      body.appendChild(row);
    };

    const textInput = (value: string, onCommit: (v: string) => void) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.style.cssText =
        'width:100%;box-sizing:border-box;background:#12141a;border:1px solid #303646;border-radius:6px;color:#e7e9ef;padding:5px 8px;font:12px ui-monospace,monospace';
      input.addEventListener('change', () => onCommit(input.value));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          input.blur();
        }
      });
      return input;
    };

    const numInput = (value: number, onCommit: (v: number) => void, min?: number, max?: number) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(value);
      if (min != null) input.min = String(min);
      if (max != null) input.max = String(max);
      input.style.cssText =
        'width:100%;box-sizing:border-box;background:#12141a;border:1px solid #303646;border-radius:6px;color:#e7e9ef;padding:5px 8px;font:12px ui-monospace,monospace';
      input.addEventListener('change', () => {
        const n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) return;
        onCommit(n);
      });
      return input;
    };

    const select = (value: string, options: { value: string; label: string }[], onCommit: (v: string) => void) => {
      const el = document.createElement('select');
      el.style.cssText =
        'width:100%;box-sizing:border-box;background:#12141a;border:1px solid #303646;border-radius:6px;color:#e7e9ef;padding:5px 8px;font:12px ui-monospace,monospace';
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === value) opt.selected = true;
        el.appendChild(opt);
      }
      el.addEventListener('change', () => onCommit(el.value));
      return el;
    };

    addRow('id', (() => {
      const span = document.createElement('span');
      span.style.fontFamily = 'ui-monospace, monospace';
      span.style.color = '#e7e9ef';
      span.textContent = c.id;
      return span;
    })());

    if (c.kind === 'label') {
      addRow(
        'net',
        textInput(c.name, (v) => {
          const name = v.trim();
          if (!name || name === c.name) return;
          this.noteEdit();
          c.name = name;
          this.changed();
        }),
      );
    }

    if (c.kind === 'junction') {
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin:4px 0';
      note.textContent =
        'Wire node — Delete heals the through-wire; branch stubs are removed';
      body.appendChild(note);
    }

    if (c.kind === 'port') {
      addRow(
        'name',
        textInput(c.name, (v) => {
          const name = v.trim();
          if (!name || name === c.name) return;
          this.noteEdit();
          if (this.library && this.defId) {
            const ok = renamePort(this.library, this.allCircuits, this.defId, c.name, name);
            if (!ok) {
              this.render();
              return;
            }
          } else {
            const circuit = this.editor?.circuit;
            if (circuit) {
              for (const other of circuit.components.values()) {
                if (other.kind === 'port' && other.id !== c.id && other.name === name) {
                  this.render();
                  return;
                }
              }
            }
            c.name = name;
          }
          this.changed();
        }),
      );
      addRow(
        'dir',
        select(
          c.dir ?? 'inout',
          [
            { value: 'in', label: 'in' },
            { value: 'out', label: 'out' },
            { value: 'inout', label: 'inout' },
          ],
          (v) => {
            this.noteEdit();
            c.dir = v === 'in' || v === 'out' ? v : 'inout';
            if (this.library && this.defId) {
              const def = this.library.get(this.defId);
              relayoutDefInstances(def, this.allCircuits);
            }
            this.changed();
          },
        ),
      );
    }

    if (c.kind === 'button') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'momentary', label: 'momentary (hold)' },
            { value: 'toggle', label: 'toggle' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'toggle' ? 'toggle' : 'momentary';
            c.holdFrames = 0;
            c.value = 0;
            this.changed();
          },
        ),
      );
    }

    if (c.kind === 'switch') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'toggle', label: 'toggle' },
            { value: 'momentary', label: 'momentary (hold)' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'momentary' ? 'momentary' : 'toggle';
            c.closed = false;
            bumpStructureVersion();
            this.changed();
          },
        ),
      );
      addRow(
        'closed',
        select(
          c.closed ? '1' : '0',
          [
            { value: '1', label: 'closed (on)' },
            { value: '0', label: 'open (off)' },
          ],
          (v) => {
            this.editor?.setSwitchClosed(c.id, v === '1');
            this.refresh();
          },
        ),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
      note.textContent =
        c.mode === 'momentary'
          ? 'Pass: hold to close in↔out; release opens'
          : 'Pass: click toggles closed; merges in↔out into one net';
      body.appendChild(note);
    }

    if (c.kind === 'clock') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'continuous', label: 'continuous' },
            { value: 'oneshot', label: 'oneshot' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'oneshot' ? 'oneshot' : 'continuous';
            c.running = false;
            c.holdFrames = 0;
            c.phase = 0;
            c.value = 0;
            // Allow a held-high TRIG to edge-detect on the next tick after mode change.
            c.lastTrig = 0;
            this.changed();
          },
        ),
      );
      addRow(
        'period',
        numInput(
          c.periodFrames,
          (n) => {
            this.noteEdit();
            c.periodFrames = Math.max(2, n);
            c.dutyFrames = Math.max(1, Math.min(c.periodFrames - 1, c.dutyFrames));
            this.changed();
          },
          2,
          3600,
        ),
      );
      addRow(
        'duty',
        numInput(
          c.dutyFrames,
          (n) => {
            this.noteEdit();
            c.dutyFrames = Math.max(1, Math.min(c.periodFrames - 1, n));
            this.changed();
          },
          1,
          3599,
        ),
      );
      const clkRow = document.createElement('div');
      clkRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px';
      clkRow.append(
        this.mkBtn(c.running ? 'Stop' : 'Run', 'Start / stop continuous pulse', () => {
          this.noteEdit();
          if (c.mode === 'continuous') {
            c.running = !c.running;
            if (!c.running) {
              c.value = 0;
              c.phase = 0;
            }
          } else {
            firePulse(c);
          }
          this.changed();
          this.sync(c, true);
        }),
        this.mkBtn('Fire', 'Emit one pulse (oneshot) or kick continuous', () => {
          this.noteEdit();
          firePulse(c);
          this.changed();
        }),
      );
      body.appendChild(clkRow);
    }

    if (c.kind === 'sevenseg') {
      addRow(
        'color',
        textInput(c.color, (v) => {
          if (!v.trim()) return;
          this.noteEdit();
          c.color = v.trim();
          this.changed();
        }),
      );
      addRow(
        'decimal pt',
        select(
          c.hasDp ? '1' : '0',
          [
            { value: '0', label: 'off' },
            { value: '1', label: 'on' },
          ],
          (v) => {
            this.editor?.setSevenSegHasDp(c.id, v === '1');
            this.changed();
            this.sync(c, true);
          },
        ),
      );
    }

    if (c.kind === 'led') {
      addRow(
        'label',
        textInput(c.label ?? '', (v) => {
          this.noteEdit();
          if (v.trim()) c.label = v.trim();
          else delete c.label;
          this.changed();
        }),
      );
      addRow(
        'color',
        textInput(c.color, (v) => {
          if (!v.trim()) return;
          this.noteEdit();
          c.color = v.trim();
          this.changed();
        }),
      );
    }

    if (c.kind === 'probe' || c.kind === 'busprobe' || c.kind === 'busswitch' || c.kind === 'buspass') {
      addRow(
        'label',
        textInput(c.label ?? '', (v) => {
          this.noteEdit();
          if (v.trim()) c.label = v.trim();
          else delete c.label;
          this.changed();
        }),
      );
    }

    const pinIds = Object.values(c.pins).map((p) => p.id);
    if (pinIds.length > 0 && this.onWatchPins) {
      const watchBtn = document.createElement('button');
      watchBtn.type = 'button';
      watchBtn.textContent = pinIds.length === 1 ? 'Watch pin' : 'Watch pins';
      watchBtn.title = 'Add pin(s) to the Watch List (Ctrl+W)';
      watchBtn.style.cssText =
        'background:#20242f;border:1px solid #333a48;border-radius:6px;color:#e7e9ef;padding:5px 10px;font:12px ui-monospace,monospace;cursor:pointer';
      watchBtn.addEventListener('click', () => this.onWatchPins?.(pinIds));
      body.appendChild(watchBtn);
    }

    if (c.kind === 'input' || c.kind === 'source') {
      addRow(
        'value',
        select(
          String(c.value),
          [
            { value: '0', label: '0' },
            { value: '1', label: '1' },
          ],
          (v) => {
            this.noteEdit();
            c.value = v === '1' ? 1 : 0;
            if (c.kind === 'source') bumpStructureVersion();
            this.changed();
          },
        ),
      );
    }

    if (c.kind === 'transistor') {
      addRow(
        'type',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.textContent = c.type === 'N' ? 'NMOS' : 'PMOS';
          return span;
        })(),
      );
    }

    if (c.kind === 'chip') {
      const defName = this.library?.has(c.defId) ? this.library.get(c.defId).name : c.defId;
      addRow(
        'def',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.style.fontFamily = 'ui-monospace, monospace';
          span.textContent = defName;
          return span;
        })(),
      );
      // Soft Lab live state (behavioral model + q bits).
      {
        const softOn = isSoftLabEnabled() && hasSoftLabModel(defName);
        if (softOn || c.softState) {
          addRow(
            'soft',
            (() => {
              const span = document.createElement('span');
              span.style.fontFamily = 'ui-monospace, monospace';
              if (c.softState) {
                const q = c.softState.q instanceof Uint8Array ? c.softState.q : null;
                const bits = q ? Array.from(q).join('') : '—';
                span.style.color = '#e6a23c';
                span.textContent = `${c.softState.model} · q=${bits || '—'} · softModel`;
              } else {
                span.style.color = '#9aa1b3';
                span.textContent = softOn ? 'soft model (no state yet)' : 'soft state';
              }
              return span;
            })(),
          );
          const softNote = document.createElement('div');
          softNote.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin:2px 0 6px';
          softNote.textContent = isSoftExpandForced(defName)
            ? 'Soft Lab — force-expanded to silicon (no SOFT badge)'
            : 'Soft Lab — behavioral; toggle off for silicon';
          body.appendChild(softNote);

          if (softOn && c.softState && hasSoftLabModel(defName) && !isSoftExpandForced(defName)) {
            const diverge = document.createElement('div');
            diverge.style.cssText =
              'font:11px ui-monospace,monospace;color:#1c1208;background:#e6a23c;border-radius:4px;padding:6px 8px;margin:0 0 8px';
            diverge.innerHTML =
              '<strong>Soft ≠ silicon view</strong> — q hex edits Soft Lab state only. Expand to compare gate flatten.';
            body.appendChild(diverge);
            body.appendChild(
              this.mkBtn(
                'Expand to compare silicon',
                'Force transistor expand for this ChipDef (Soft Lab stays on for other defs)',
                () => {
                  setSoftExpandForced(defName, true);
                  this.changed();
                  this.sync(c, true);
                },
              ),
            );
            const diffBtn = document.createElement('button');
            diffBtn.type = 'button';
            diffBtn.textContent = 'Diff soft vs silicon';
            diffBtn.title = 'Snapshot Soft q, force expand, settle, compare bit-for-bit';
            diffBtn.style.cssText =
              'background:#20242f;border:1px solid #333a48;border-radius:6px;color:#e7e9ef;padding:5px 10px;font:12px ui-monospace,monospace;cursor:pointer;margin:0 0 6px';
            diffBtn.addEventListener('click', () => {
              this.noteEdit();
              void this.runSoftSiliconDiff(c, defName);
            });
            body.appendChild(diffBtn);
          }

          if (this.softDiffNote) {
            const note = document.createElement('div');
            note.style.cssText =
              'font:11px ui-monospace,monospace;color:#e7e9ef;background:#1c2230;border:1px solid #3a4154;border-radius:4px;padding:6px 8px;margin:0 0 8px';
            note.textContent = this.softDiffNote;
            body.appendChild(note);
          }

          // Editable hex for sequential softState.q (registers/counters).
          if (c.softState && c.softState.q instanceof Uint8Array && c.softState.q.length > 0 && c.softState.q.length <= 16) {
            addRow(
              'q hex',
              (() => {
                const inp = document.createElement('input');
                inp.type = 'text';
                let v = 0;
                for (let i = 0; i < c.softState!.q.length; i++) v |= (c.softState!.q[i]! & 1) << i;
                const digits = Math.max(1, Math.ceil(c.softState!.q.length / 4));
                inp.value = v.toString(16).toUpperCase().padStart(digits, '0');
                inp.style.cssText =
                  'width:5em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px;font-family:ui-monospace,monospace';
                inp.addEventListener('change', () => {
                  const parsed = parseInt(inp.value.replace(/^0x/i, ''), 16);
                  if (!Number.isFinite(parsed)) return;
                  this.noteEdit();
                  const q = c.softState!.q;
                  for (let i = 0; i < q.length; i++) q[i] = (parsed >> i) & 1;
                  this.changed();
                  this.sync(c, true);
                });
                return inp;
              })(),
            );
          }

          body.appendChild(
            this.mkBtn('Reset soft state', 'Clear Soft Lab sequential state on this chip', () => {
              this.noteEdit();
              delete c.softState;
              this.changed();
              this.sync(c, true);
            }),
          );

          if (softOn && hasSoftLabModel(defName)) {
            const forced = isSoftExpandForced(defName);
            body.appendChild(
              this.mkBtn(
                forced ? 'Use Soft Lab again' : 'Force transistor expand',
                forced
                  ? 'Return this def to Soft Lab opaque eval'
                  : 'Expand this ChipDef to transistors this session (Soft Lab stays on)',
                () => {
                  setSoftExpandForced(defName, !forced);
                  this.changed();
                  this.sync(c, true);
                },
              ),
            );
          }
        }
      }
      addRow(
        'marking',
        textInput(c.marking ?? '', (v) => {
          this.editor?.setChipAppearance(c.id, { marking: v });
          this.changed();
        }),
      );
      addRow(
        'width',
        numInput(c.boxWidth ?? CHIP_INSTANCE_WIDTH, (v) => {
          this.editor?.setChipAppearance(c.id, { boxWidth: v });
          this.changed();
        }, 48, 240),
      );
      this.appendPinOrderEditor(body, c);
      const defRev = this.library?.has(c.defId) ? (this.library.get(c.defId).revision ?? 0) : 0;
      const stale = defRev !== (c.defRevision ?? 0);
      if (stale) {
        body.appendChild(
          this.mkBtn('Update from library', 'Refresh pin sides / layout and clear edited badge', () => {
            this.onUpdateFromLibrary?.(c);
            this.changed();
          }),
        );
      }
      body.appendChild(
        this.mkBtn('Dive in', 'Open chip internals (same as dblclick)', () => {
          this.onDive?.(c);
        }),
      );
    }

    if (c.kind === 'ram' || c.kind === 'rom') {
      addRow(
        'size',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.textContent = `${1 << c.addrBits}×${c.dataBits}`;
          return span;
        })(),
      );
      this.appendPinOrderEditor(body, c);
    }

    if (isOrientable(c)) {
      const { rotation, mirrorX, mirrorY } = getOrientation(c);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexWrap = 'wrap';
      row.style.gap = '6px';
      row.style.marginTop = '4px';

      row.append(
        this.mkBtn('↻ 90°', 'Rotate clockwise (R)', () => this.orientTargets('cw')),
        this.mkBtn('↺ 90°', 'Rotate counter-clockwise (Shift+R)', () => this.orientTargets('ccw')),
        this.mkBtn(mirrorX ? 'Flip H ✓' : 'Flip H', 'Flip horizontally (M)', () => this.orientTargets('flipH')),
        this.mkBtn(mirrorY ? 'Flip V ✓' : 'Flip V', 'Flip vertically (Shift+M)', () => this.orientTargets('flipV')),
      );
      const hint = document.createElement('div');
      hint.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:2px';
      const flips = [mirrorX ? 'H' : '', mirrorY ? 'V' : ''].filter(Boolean).join('+');
      hint.textContent = `orient ${rotation}°${flips ? ` · flip ${flips}` : ''} · R / Shift+R / M / Shift+M`;
      body.append(row, hint);
    }

    if (c.kind === 'analyzer') {
      addRow(
        'channels',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.textContent = String(c.channelCount);
          return span;
        })(),
      );
      this.appendPinOrderEditor(body, c);
      if (!c.channelLabels) c.channelLabels = [];
      while (c.channelLabels.length < c.channelCount) c.channelLabels.push(`ch${c.channelLabels.length}`);
      for (let i = 0; i < c.channelCount; i++) {
        const ch = i;
        addRow(
          `label ${ch}`,
          textInput(c.channelLabels[ch] ?? `ch${ch}`, (v) => {
            this.noteEdit();
            if (!c.channelLabels) c.channelLabels = [];
            c.channelLabels[ch] = v.trim() || `ch${ch}`;
            this.changed();
          }),
        );
      }
      body.appendChild(
        this.mkBtn('Add channel', 'Grow the analyzer by one sense pin', () => {
          this.editor?.addAnalyzerChannel(c.id);
          this.sync(c, true);
        }),
      );
      body.appendChild(
        this.mkBtn('Remove channel', 'Drop the highest channel (min 1)', () => {
          this.editor?.removeAnalyzerChannel(c.id);
          this.sync(c, true);
        }),
      );
      body.appendChild(
        this.mkBtn(c.armed ? 'Disarm' : 'Arm', 'Toggle analyzer sampling', () => {
          c.armed = !c.armed;
          this.sync(c, true);
        }),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
      note.textContent = c.armed ? 'armed — sampling' : 'paused · dblclick opens LA';
      body.appendChild(note);
    }

    if (c.kind === 'busprobe') {
      addRow(
        'width',
        (() => {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = '1';
          inp.max = '32';
          inp.value = String(c.bitWidth);
          inp.style.cssText = 'width:4em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          inp.addEventListener('change', () => {
            const n = parseInt(inp.value, 10);
            if (!Number.isFinite(n)) return;
            this.editor?.setBusProbeWidth(c.id, n);
            this.refresh();
          });
          return inp;
        })(),
      );
      addRow(
        'radix',
        (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          for (const r of ['hex', 'dec', 'bin'] as const) {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            if (c.radix === r) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', () => {
            this.editor?.setBusProbeRadix(c.id, sel.value as 'hex' | 'dec' | 'bin');
            this.refresh();
          });
          return sel;
        })(),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
      note.textContent = 'b0 = LSB · floating/contended → ?';
      body.appendChild(note);
    }

    if (c.kind === 'busswitch') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'toggle', label: 'toggle' },
            { value: 'momentary', label: 'momentary (hold)' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'momentary' ? 'momentary' : 'toggle';
            c.value = 0;
            this.changed();
          },
        ),
      );
      addRow(
        'width',
        (() => {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = '1';
          inp.max = '32';
          inp.value = String(c.bitWidth);
          inp.style.cssText = 'width:4em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          inp.addEventListener('change', () => {
            const n = parseInt(inp.value, 10);
            if (!Number.isFinite(n)) return;
            this.editor?.setBusSwitchWidth(c.id, n);
            this.refresh();
          });
          return inp;
        })(),
      );
      addRow(
        'radix',
        (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          for (const r of ['hex', 'dec', 'bin'] as const) {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            if (c.radix === r) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', () => {
            this.editor?.setBusSwitchRadix(c.id, sel.value as 'hex' | 'dec' | 'bin');
            this.refresh();
          });
          return sel;
        })(),
      );
      addRow(
        'value',
        (() => {
          const inp = document.createElement('input');
          inp.type = 'text';
          const digits = Math.max(1, Math.ceil(c.bitWidth / 4));
          inp.value =
            c.radix === 'hex'
              ? c.value.toString(16).toUpperCase().padStart(digits, '0')
              : c.radix === 'bin'
                ? c.value.toString(2).padStart(c.bitWidth, '0')
                : String(c.value);
          inp.style.cssText =
            'width:6em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px;font-family:ui-monospace,monospace';
          inp.addEventListener('change', () => {
            const raw = inp.value.trim().replace(/^0x/i, '').replace(/^0b/i, '');
            const base = c.radix === 'bin' ? 2 : c.radix === 'dec' ? 10 : 16;
            const parsed = parseInt(raw, base);
            if (!Number.isFinite(parsed)) return;
            this.editor?.setBusSwitchValue(c.id, parsed);
            this.refresh();
          });
          return inp;
        })(),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
      note.textContent =
        c.mode === 'momentary'
          ? 'DIP: hold paddle to drive bit high · b0 = LSB'
          : 'DIP: paddle = toggle bit · readout = +1 · b0 = LSB';
      body.appendChild(note);
    }

    if (c.kind === 'buspass') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'toggle', label: 'toggle' },
            { value: 'momentary', label: 'momentary (hold)' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'momentary' ? 'momentary' : 'toggle';
            c.closed = 0;
            bumpStructureVersion();
            this.changed();
          },
        ),
      );
      addRow(
        'width',
        (() => {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = '1';
          inp.max = '32';
          inp.value = String(c.bitWidth);
          inp.style.cssText = 'width:4em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          inp.addEventListener('change', () => {
            const n = parseInt(inp.value, 10);
            if (!Number.isFinite(n)) return;
            this.editor?.setBusPassWidth(c.id, n);
            this.refresh();
          });
          return inp;
        })(),
      );
      addRow(
        'closed',
        (() => {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = c.closed.toString(16).toUpperCase();
          inp.title = 'Hex bitmask of closed poles (bit0 = a0↔b0)';
          inp.style.cssText =
            'width:6em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px;font-family:ui-monospace,monospace';
          inp.addEventListener('change', () => {
            const raw = inp.value.trim().replace(/^0x/i, '');
            const parsed = parseInt(raw, 16);
            if (!Number.isFinite(parsed)) return;
            this.editor?.setBusPassClosed(c.id, parsed);
            this.refresh();
          });
          return inp;
        })(),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
      note.textContent =
        c.mode === 'momentary'
          ? 'Pass bank: hold paddle to close aᵢ↔bᵢ; release opens'
          : 'Pass bank: paddle = toggle pole · closed merges aᵢ↔bᵢ';
      body.appendChild(note);
    }
  }

  /** Up/down pin stack reorder for chip / RAM / ROM / analyzer. */
  private appendPinOrderEditor(
    body: HTMLElement,
    c: Component & { pinOrder?: string[]; pins: Record<string, { name: string }> },
  ): void {
    if (!c.pinOrder?.length) c.pinOrder = Object.keys(c.pins);
    const title = document.createElement('div');
    title.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
    title.textContent = 'pin order';
    body.appendChild(title);
    for (let i = 0; i < c.pinOrder.length; i++) {
      const name = c.pinOrder[i]!;
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      const lab = document.createElement('span');
      lab.style.cssText = 'flex:1;font:11px ui-monospace,monospace;color:#e7e9ef';
      lab.textContent = name;
      const up = this.mkBtn('↑', 'Move pin up in stack', () => {
        if (i <= 0) return;
        const order = c.pinOrder!;
        const tmp = order[i - 1]!;
        order[i - 1] = order[i]!;
        order[i] = tmp;
        applyPinLayout(c as Component);
      });
      const down = this.mkBtn('↓', 'Move pin down in stack', () => {
        const order = c.pinOrder!;
        if (i >= order.length - 1) return;
        const tmp = order[i + 1]!;
        order[i + 1] = order[i]!;
        order[i] = tmp;
        applyPinLayout(c as Component);
      });
      up.disabled = i === 0;
      down.disabled = i === c.pinOrder.length - 1;
      row.append(lab, up, down);
      if (c.kind === 'chip' && this.editor) {
        const ed = this.editor;
        const chipId = c.id;
        const pinName = name;
        row.append(
          this.mkBtn('L', 'Pin on left stack', () => {
            ed.setChipPinSide(chipId, pinName, -1);
          }),
          this.mkBtn('R', 'Pin on right stack', () => {
            ed.setChipPinSide(chipId, pinName, 1);
          }),
        );
      }
      body.appendChild(row);
    }
  }
}
