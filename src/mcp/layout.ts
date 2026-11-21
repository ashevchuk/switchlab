import type { Circuit } from '../sim/Circuit.js';
import { chipBodyWidth, chipBoxHeight } from '../sim/library.js';
import type { ChipInstanceComponent, Component, Pin } from '../sim/types.js';

const COLUMN_GAP = 160;
const ROW_GAP = 36;
const SMALL_COMPONENT = { w: 40, h: 36 };
const ORDERING_SWEEPS = 2;

function sizeOf(c: Component): { w: number; h: number } {
  if (c.kind === 'chip') return { w: chipBodyWidth(c), h: chipBoxHeight(c) };
  return SMALL_COMPONENT;
}

function drivesFrom(c: Component, pin: Pin): boolean {
  if (c.kind === 'input' || c.kind === 'source') return true;
  if (c.kind === 'chip') return (c as ChipInstanceComponent).pinSide?.[pin.name] === 1;
  return false;
}

function consumesAt(c: Component, pin: Pin): boolean {
  if (c.kind === 'probe') return true;
  if (c.kind === 'chip') return (c as ChipInstanceComponent).pinSide?.[pin.name] !== 1;
  return false;
}

/**
 * Left-to-right schematic layout following signal flow: inputs on the left,
 * probes on the right, each chip one column after the latest chip that feeds
 * it. Feedback edges are ignored for layering. Positions only; wires are
 * untouched.
 */
export function layoutLayered(circuit: Circuit): void {
  const comps = [...circuit.components.values()];
  const index = new Map(comps.map((c, i) => [c.id, i]));
  const byId = new Map(comps.map((c) => [c.id, c]));
  const succ = new Map<string, Set<string>>();
  for (const w of circuit.wires.values()) {
    const [aId, aPin] = w.a.split(':') as [string, string];
    const [bId, bPin] = w.b.split(':') as [string, string];
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b || a.id === b.id) continue;
    const pa = (a.pins as Record<string, Pin>)[aPin];
    const pb = (b.pins as Record<string, Pin>)[bPin];
    if (!pa || !pb) continue;
    let from: Component | undefined;
    let to: Component | undefined;
    if (drivesFrom(a, pa) && consumesAt(b, pb)) [from, to] = [a, b];
    else if (drivesFrom(b, pb) && consumesAt(a, pa)) [from, to] = [b, a];
    if (!from || !to || from.kind === 'source') continue;
    const set = succ.get(from.id) ?? new Set<string>();
    set.add(to.id);
    succ.set(from.id, set);
  }

  const forward = new Map<string, string[]>();
  const state = new Map<string, 1 | 2>();
  const postorder: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of succ.get(id) ?? []) {
      if (state.get(next) === 1) continue;
      forward.set(id, [...(forward.get(id) ?? []), next]);
      if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
    postorder.push(id);
  };
  for (const c of comps) if (!state.has(c.id)) visit(c.id);

  const layer = new Map<string, number>(comps.map((c) => [c.id, 0]));
  for (const id of [...postorder].reverse()) {
    for (const next of forward.get(id) ?? []) layer.set(next, Math.max(layer.get(next)!, layer.get(id)! + 1));
  }
  const nonProbeMax = Math.max(0, ...comps.filter((c) => c.kind !== 'probe').map((c) => layer.get(c.id)!));
  for (const c of comps) if (c.kind === 'probe') layer.set(c.id, nonProbeMax + 1);
  placeSourcesBesideConsumers(circuit, comps, layer);

  const minLayer = Math.min(...layer.values());
  const columns = new Map<number, Component[]>();
  for (const c of comps) {
    const l = layer.get(c.id)! - minLayer;
    columns.set(l, [...(columns.get(l) ?? []), c]);
  }
  const layerCount = Math.max(...columns.keys()) + 1;

  const predecessors = new Map<string, string[]>();
  for (const [from, tos] of forward) for (const to of tos) predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
  const row = new Map<string, number>();
  columns.forEach((col) => col.forEach((c, i) => row.set(c.id, i)));
  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep++) {
    for (let l = 1; l < layerCount; l++) {
      const col = columns.get(l) ?? [];
      const key = (c: Component): number => {
        const ps = predecessors.get(c.id) ?? [];
        return ps.length === 0 ? row.get(c.id)! : ps.reduce((sum, p) => sum + row.get(p)!, 0) / ps.length;
      };
      col.sort((a, b) => key(a) - key(b) || index.get(a.id)! - index.get(b.id)!);
      col.forEach((c, i) => row.set(c.id, i));
    }
  }

  let x = 0;
  for (let l = 0; l < layerCount; l++) {
    const col = columns.get(l) ?? [];
    const width = Math.max(SMALL_COMPONENT.w, ...col.map((c) => sizeOf(c).w));
    const height = col.reduce((sum, c) => sum + sizeOf(c).h, 0) + ROW_GAP * Math.max(0, col.length - 1);
    let y = -height / 2;
    for (const c of col) {
      const { h } = sizeOf(c);
      circuit.moveComponent(c.id, x + width / 2 - c.pos.x, y + h / 2 - c.pos.y);
      y += h + ROW_GAP;
    }
    x += width + COLUMN_GAP;
  }
}

/** Constants (vcc/gnd) sit one column before their first consumer instead of at the far left. */
function placeSourcesBesideConsumers(circuit: Circuit, comps: Component[], layer: Map<string, number>): void {
  const ownerOf = new Map<string, string>();
  for (const c of comps) for (const p of Object.values(c.pins) as Pin[]) ownerOf.set(p.id, c.id);
  for (const c of comps) {
    if (c.kind !== 'source') continue;
    const consumerLayers: number[] = [];
    for (const w of circuit.wires.values()) {
      const other = w.a.startsWith(`${c.id}:`) ? w.b : w.b.startsWith(`${c.id}:`) ? w.a : undefined;
      const owner = other === undefined ? undefined : ownerOf.get(other);
      if (owner !== undefined) consumerLayers.push(layer.get(owner)!);
    }
    layer.set(c.id, consumerLayers.length === 0 ? 0 : Math.min(...consumerLayers) - 1);
  }
}
