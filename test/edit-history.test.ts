import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { makeChipInstance, makeInput, makeLed } from '../src/sim/library.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { Editor } from '../src/ui/Editor.js';
import { EditHistory } from '../src/ui/EditHistory.js';
import { wirePolyline } from '../src/ui/geometry.js';

describe('EditHistory.discardLast', () => {
  it('drops the newest undo entry without touching the circuit', () => {
    const circuit = new Circuit();
    const history = new EditHistory();
    makeInput(circuit, 0, { x: 0, y: 0 });
    history.checkpoint(circuit);
    makeInput(circuit, 0, { x: 50, y: 0 });
    history.checkpoint(circuit);
    history.discardLast(circuit);
    expect(circuit.components.size).toBe(2);
    expect(history.undo(circuit)).toBe(true);
    expect(circuit.components.size).toBe(1);
    expect(history.canUndo(circuit)).toBe(false);
  });
});

describe('undoing a component move', () => {
  it('puts the pins and the wires back with the component', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const circuit = new Circuit();
    const editor = new Editor(circuit, library);
    const history = new EditHistory();
    editor.onBeforeEdit = () => history.checkpoint(circuit);
    const mux = makeChipInstance(circuit, library.findByName('MUX2')!, { x: 200, y: 100 });
    const source = makeInput(circuit, 0, { x: 0, y: 60 });
    const led = makeLed(circuit, { x: 400, y: 100 });
    circuit.addWire(source.pins.out.id, mux.pins.in0!.id);
    circuit.addWire(mux.pins.out!.id, led.pins.in.id);
    const layout = () => ({
      positions: [...circuit.components.values()].map((c) => [c.id, c.pos, Object.values(c.pins).map((p) => p.pos)]),
      routes: [...circuit.wires.values()].map((w) => wirePolyline(circuit, w)),
    });
    const before = layout();
    editor.handleMouseDown({ x: 200, y: 100 });
    editor.handleMouseDrag({ x: 230, y: 160 });
    editor.handleMouseDrag({ x: 260, y: 300 });
    editor.handleMouseUp({ x: 260, y: 300 }, false);
    expect(layout()).not.toEqual(before);
    expect(history.undo(circuit)).toBe(true);
    expect(layout()).toEqual(before);
    expect(history.redo(circuit)).toBe(true);
    expect(layout()).not.toEqual(before);
  });
});
