import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput } from '../src/sim/library.js';
import { EditHistory } from '../src/ui/EditHistory.js';

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
