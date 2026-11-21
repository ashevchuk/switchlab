/**
 * Replace non-local point-to-point wires with same-named net labels.
 *
 * `computeNets()` already joins every `LabelComponent` that shares a `name`
 * (same mechanism as VCC/GND). Placing a stub label beside each end of a
 * wire removes drawn spaghetti while keeping one electrical net.
 *
 * Intended for the Z80CPU parent circuit where gates are already stdcell
 * chips (NOT/NAND/…). Transistor guts inside those ChipDefs are untouched.
 */

import type { Circuit } from './Circuit.js';
import { makeLabel, wire } from './library.js';
import type { Component, Pin } from './types.js';

/**
 * World-space length at or above which a wire becomes a label pair.
 * Kept just above a pin→label stub (~8) so only true local stubs remain.
 */
export const LONG_WIRE_LABEL_THRESHOLD = 24;

function stubLabelPos(pin: Pin): { x: number; y: number } {
  // Tight to the pin — avoids a zoomed-out "noodle" of short fans off
  // tall chips (RAM_ADDR_BIT, RAM_OE_OR, …).
  return { x: pin.pos.x + 8, y: pin.pos.y };
}

/**
 * Convert every wire of length >= `minLength` into local same-named labels.
 * `alsoLabel` additionally selects shorter wires by their two end components.
 * Returns how many wires were removed.
 */
export function replaceLongWiresWithLabels(
  circuit: Circuit,
  minLength = LONG_WIRE_LABEL_THRESHOLD,
  alsoLabel?: (a: Component, b: Component) => boolean,
): number {
  const pinOf = new Map<string, Pin>();
  const ownerOf = new Map<string, Component>();
  for (const c of circuit.components.values()) {
    for (const p of Object.values(c.pins) as Pin[]) {
      pinOf.set(p.id, p);
      ownerOf.set(p.id, c);
    }
  }

  const ufParent = new Map<string, string>();
  const find = (id: string): string => {
    let p = ufParent.get(id) ?? id;
    if (!ufParent.has(id)) ufParent.set(id, id);
    while ((ufParent.get(p) ?? p) !== p) {
      const grand = ufParent.get(p) ?? p;
      ufParent.set(p, ufParent.get(grand) ?? grand);
      p = ufParent.get(p) ?? p;
    }
    return p;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) ufParent.set(ra, rb);
  };

  for (const w of circuit.wires.values()) union(w.a, w.b);

  // Prefer an existing label name already on the net (PHASE0, BUS3, …).
  const nameForRoot = new Map<string, string>();
  for (const c of circuit.components.values()) {
    if (c.kind !== 'label') continue;
    const root = find(c.pins.net.id);
    if (!nameForRoot.has(root)) nameForRoot.set(root, c.name);
  }

  let auto = 0;
  let removed = 0;
  const longWires = [...circuit.wires.values()].filter((w) => {
    const a = pinOf.get(w.a);
    const b = pinOf.get(w.b);
    if (!a || !b) return false;
    if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) >= minLength) return true;
    const oa = ownerOf.get(w.a);
    const ob = ownerOf.get(w.b);
    return alsoLabel !== undefined && oa !== undefined && ob !== undefined && alsoLabel(oa, ob);
  });

  for (const w of longWires) {
    const a = pinOf.get(w.a);
    const b = pinOf.get(w.b);
    if (!a || !b) continue;
    const oa = ownerOf.get(w.a);
    const ob = ownerOf.get(w.b);
    if (!oa || !ob) continue;

    // Two labels with the same name already join — drop the drawn wire.
    if (oa.kind === 'label' && ob.kind === 'label' && oa.name === ob.name) {
      circuit.removeWire(w.id);
      removed++;
      continue;
    }

    const root = find(w.a);
    let name = nameForRoot.get(root);
    if (!name) {
      name = `_N${auto++}`;
      nameForRoot.set(root, name);
    }

    circuit.removeWire(w.id);
    removed++;

    // Local stub on each end that isn't already this net's label pin.
    // (A far same-named label is the other presence — don't wire to it.)
    if (!(oa.kind === 'label' && oa.name === name)) {
      const lbl = makeLabel(circuit, name, stubLabelPos(a));
      wire(circuit, a, lbl.pins.net);
      pinOf.set(lbl.pins.net.id, lbl.pins.net);
      ownerOf.set(lbl.pins.net.id, lbl);
      union(a.id, lbl.pins.net.id);
    }
    if (!(ob.kind === 'label' && ob.name === name)) {
      const lbl = makeLabel(circuit, name, stubLabelPos(b));
      wire(circuit, b, lbl.pins.net);
      pinOf.set(lbl.pins.net.id, lbl.pins.net);
      ownerOf.set(lbl.pins.net.id, lbl);
      union(b.id, lbl.pins.net.id);
    }
  }

  return removed;
}

/**
 * Join a pin to a named net via a short local label stub (no long drawn wire).
 * Same electrical join as `computeNets()` name merge for LabelComponents.
 */
export function tiePinToNet(circuit: Circuit, name: string, p: Pin): void {
  const lbl = makeLabel(circuit, name, stubLabelPos(p));
  wire(circuit, p, lbl.pins.net);
}

/**
 * Post-process a folded library chip (or Stub ROM parent): turn every long
 * point-to-point wire into same-named label stubs. Call this for mid/high
 * composites (AND, XOR, MUX, ROM, …) — not for raw CMOS primitives
 * (NOT/NAND/NOR), where drawn G/D/S wires are the schematic.
 */
export function tidyLibraryCircuit(
  circuit: Circuit,
  minLength = LONG_WIRE_LABEL_THRESHOLD,
): number {
  return replaceLongWiresWithLabels(circuit, minLength);
}

/**
 * Uniformly scale component positions toward their centroid — keeps relative
 * layout, shrinks empty canvas. Pin offsets follow via `moveComponent`.
 */
export function compactCircuitLayout(circuit: Circuit, scale = 0.55): void {
  const comps = [...circuit.components.values()];
  if (comps.length === 0) return;
  let sx = 0;
  let sy = 0;
  for (const c of comps) {
    sx += c.pos.x;
    sy += c.pos.y;
  }
  const cx = sx / comps.length;
  const cy = sy / comps.length;
  for (const c of comps) {
    const nx = cx + (c.pos.x - cx) * scale;
    const ny = cy + (c.pos.y - cy) * scale;
    circuit.moveComponent(c.id, nx - c.pos.x, ny - c.pos.y);
  }
}
