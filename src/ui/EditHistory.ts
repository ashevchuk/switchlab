/**
 * Undo/redo for the circuit editor — one stack per Circuit object so diving
 * into a chip keeps the parent's undo history (and vice versa).
 */

import { captureCircuit, restoreCircuit, type CircuitSnapshot } from '../sim/serialize.js';
import type { Circuit } from '../sim/Circuit.js';

const LIMIT = 60;

interface Stacks {
  undo: CircuitSnapshot[];
  redo: CircuitSnapshot[];
}

export class EditHistory {
  private byCircuit = new WeakMap<Circuit, Stacks>();

  private stacks(circuit: Circuit): Stacks {
    let s = this.byCircuit.get(circuit);
    if (!s) {
      s = { undo: [], redo: [] };
      this.byCircuit.set(circuit, s);
    }
    return s;
  }

  /** Drop undo/redo for one circuit (e.g. after replacing its contents). */
  clearCircuit(circuit: Circuit): void {
    this.byCircuit.delete(circuit);
  }

  /** Drop every stack (session reset). WeakMap can't iterate — recreate. */
  clear(): void {
    this.byCircuit = new WeakMap();
  }

  /** Call immediately before a user mutation. */
  checkpoint(circuit: Circuit): void {
    const s = this.stacks(circuit);
    s.undo.push(captureCircuit(circuit));
    if (s.undo.length > LIMIT) s.undo.shift();
    s.redo = [];
  }

  /** Forget the newest checkpoint, for an edit cancelled before it changed anything. */
  discardLast(circuit: Circuit): void {
    this.stacks(circuit).undo.pop();
  }

  canUndo(circuit: Circuit): boolean {
    return this.stacks(circuit).undo.length > 0;
  }

  canRedo(circuit: Circuit): boolean {
    return this.stacks(circuit).redo.length > 0;
  }

  undo(circuit: Circuit): boolean {
    const s = this.stacks(circuit);
    if (s.undo.length === 0) return false;
    s.redo.push(captureCircuit(circuit));
    restoreCircuit(circuit, s.undo.pop()!);
    return true;
  }

  redo(circuit: Circuit): boolean {
    const s = this.stacks(circuit);
    if (s.redo.length === 0) return false;
    s.undo.push(captureCircuit(circuit));
    restoreCircuit(circuit, s.redo.pop()!);
    return true;
  }
}
