import { describe, expect, it } from 'vitest';
import { createSoftZ80, softStep } from '../src/machine/softZ80.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeTransistor, makeButton } from '../src/sim/library.js';
import { EditHistory } from '../src/ui/EditHistory.js';
import { Editor } from '../src/ui/Editor.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';

describe('soft EI delay', () => {
  it('enables IFF only after the following instruction', () => {
    const cpu = createSoftZ80();
    const ram = new Uint8Array(256);
    // EI ; NOP ; …
    ram[0] = 0xfb;
    ram[1] = 0x00;
    softStep(cpu, ram);
    expect(cpu.iff1).toBe(false);
    expect(cpu.eiDelay).toBe(1);
    softStep(cpu, ram);
    expect(cpu.iff1).toBe(true);
    expect(cpu.eiDelay).toBe(0);
  });
});

describe('edit history + clipboard', () => {
  it('undo restores deleted component', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const hist = new EditHistory();
    const ed = new Editor(c, lib);
    ed.onBeforeEdit = () => hist.checkpoint(ed.circuit);
    makeTransistor(c, 'N', { x: 0, y: 0 });
    const id = [...c.components.keys()][0]!;
    ed.selectedIds = new Set([id]);
    ed.handleDelete();
    expect(c.components.size).toBe(0);
    expect(hist.undo(c)).toBe(true);
    expect(c.components.size).toBe(1);
  });

  it('copy/paste duplicates selection', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    makeTransistor(c, 'N', { x: 0, y: 0 });
    const id = [...c.components.keys()][0]!;
    ed.selectedIds = new Set([id]);
    expect(ed.copySelection()).toBe(true);
    expect(ed.pasteClipboard()).toBe(true);
    expect(c.components.size).toBe(2);
  });

  it('skips pasting chips whose defId was wiped from the library', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    // Simulate clipboard captured before a Lab-course project reload.
    (ed as unknown as { clipboard: { components: unknown[]; wires: unknown[] } }).clipboard = {
      components: [
        {
          id: 'chip1',
          kind: 'chip',
          defId: 'chipdef1702629',
          defRevision: 0,
          pos: { x: 0, y: 0 },
          rotation: 0,
          mirrorX: false,
          mirrorY: false,
          pinOrder: [],
          pins: {},
        },
        {
          id: 't1',
          kind: 'transistor',
          type: 'N',
          pos: { x: 20, y: 0 },
          rotation: 0,
          mirrorX: false,
          mirrorY: false,
          pins: {
            gate: { id: 't1:gate', componentId: 't1', name: 'gate', pos: { x: 0, y: 0 } },
            drain: { id: 't1:drain', componentId: 't1', name: 'drain', pos: { x: 0, y: 0 } },
            source: { id: 't1:source', componentId: 't1', name: 'source', pos: { x: 0, y: 0 } },
          },
        },
      ],
      wires: [],
    };
    expect(ed.pasteClipboard()).toBe(true);
    expect([...c.components.values()].some((x) => x.kind === 'chip')).toBe(false);
    expect([...c.components.values()].some((x) => x.kind === 'transistor')).toBe(true);
  });

  it('clears sticky net tip after deleting a selected wire', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const a = makeTransistor(c, 'N', { x: 0, y: 0 });
    const b = makeTransistor(c, 'N', { x: 80, y: 0 });
    const w = c.addWire(a.pins.drain.id, b.pins.drain.id);
    ed.selectedWireId = w.id;
    ed.highlightNetOfWire(w.id);
    ed.hoveredWireId = w.id;
    expect(ed.highlightedNetId).toBeTruthy();

    ed.handleDelete();

    expect(c.wires.size).toBe(0);
    expect(ed.highlightedNetId).toBeNull();
    expect(ed.hoveredWireId).toBeNull();
    expect(ed.formatNetName(ed.netIdUnderPointer())).toBeNull();
  });

  it('collapses colinear bend knobs after a waypoint drag', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const a = makeTransistor(c, 'N', { x: 0, y: 0 });
    const b = makeTransistor(c, 'N', { x: 100, y: 0 });
    // Midpoint sits on the straight A→B run — should vanish after cleanup.
    const w = c.addWire(a.pins.drain.id, b.pins.drain.id, [
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 70, y: 30 },
      { x: 70, y: 0 },
    ]);
    ed.selectedWireId = w.id;
    // Simulate releasing a bend on the horizontal return (makes 70,0 colinear).
    ed.handleMouseDown({ x: 70, y: 0 });
    ed.handleMouseUp({ x: 70, y: 0 }, false);
    // Colinear 70,0 between 70,30 and pin B is dropped; spur at the pin gone.
    expect(w.waypoints?.some((p) => Math.abs(p.y) < 0.5 && Math.abs(p.x - 70) < 0.5)).toBeFalsy();
    expect(w.waypoints?.length).toBeGreaterThanOrEqual(1);
  });

  it('tidy after one-sided drag keeps a far-side jog when local repair wins', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    // Y-offset pins + pure-X drag: L via dest column stays bend-competitive
    // with a full rebuild, so local repair should keep the far stub.
    const left = makeButton(c, { x: 0, y: 40 });
    const right = makeButton(c, { x: 200, y: 80 });
    const w = c.addWire(left.pins.out.id, right.pins.out.id, [
      { x: 180, y: 40 },
      { x: 180, y: 80 },
    ]);
    ed.selectedIds = new Set([left.id]);
    c.moveComponent(left.id, 40, 0);
    ed.pushWiresWithDrag([left.id], 40, 0);
    expect(w.waypoints?.length).toBeGreaterThan(0);
    const farX = w.waypoints!.map((p) => p.x);
    ed.tidySelectedWires(false);
    const still = w.waypoints ?? [];
    expect(still.some((p) => farX.some((x) => Math.abs(x - p.x) < 0.5))).toBe(true);
  });

  it('mid-drag stub reflow keeps one-sided wires orthogonal', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const left = makeButton(c, { x: 0, y: 40 });
    const right = makeButton(c, { x: 200, y: 80 });
    const w = c.addWire(left.pins.out.id, right.pins.out.id, [
      { x: 180, y: 40 },
      { x: 180, y: 80 },
    ]);
    c.moveComponent(left.id, 40, 0);
    ed.pushWiresWithDrag([left.id], 40, 0);
    const raw = [left.pins.out.pos, ...(w.waypoints ?? []), right.pins.out.pos];
    expect(raw.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i]!;
      const b = raw[i + 1]!;
      const diag = Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5;
      expect(diag, `diagonal ${JSON.stringify(a)}→${JSON.stringify(b)}`).toBe(false);
    }
    // Far column should still be present mid-drag.
    expect(w.waypoints?.some((p) => Math.abs(p.x - 180) < 0.5)).toBe(true);
  });

  it('mid-drag Y move only nudges the near stub, not the far jog', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const left = makeButton(c, { x: 0, y: 40 });
    const right = makeButton(c, { x: 200, y: 80 });
    const w = c.addWire(left.pins.out.id, right.pins.out.id, [
      { x: 180, y: 40 },
      { x: 180, y: 80 },
    ]);
    c.moveComponent(left.id, 0, 30);
    ed.pushWiresWithDrag([left.id], 0, 30);
    expect(w.waypoints?.[0]).toEqual({ x: 180, y: left.pins.out.pos.y });
    expect(w.waypoints?.[1]).toEqual({ x: 180, y: 80 });
  });

  it('tidy keeps intentional ortho bends that clear bodies', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const left = makeButton(c, { x: 0, y: 40 });
    const right = makeButton(c, { x: 220, y: 40 });
    // Deliberate jog clear of both bodies (short dest approach, not a slide).
    const w = c.addWire(left.pins.out.id, right.pins.out.id, [
      { x: 200, y: 40 },
      { x: 200, y: 20 },
      { x: 236, y: 20 },
    ]);
    ed.selectedWireIds = new Set([w.id]);
    ed.tidySelectedWires(false);
    const mid = w.waypoints ?? [];
    expect(mid.some((p) => Math.abs(p.x - 200) < 0.5 && Math.abs(p.y - 20) < 0.5)).toBe(true);
  });
});
