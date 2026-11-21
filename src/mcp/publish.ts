import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Component } from '../sim/types.js';
import { deserializeProject, resolveStdcellInstances, serializeSlimStdcells } from '../sim/serialize.js';
import { replaceLongWiresWithLabels } from '../sim/labelWires.js';
import { makeLabel, wire } from '../sim/library.js';
import { layoutLayered } from './layout.js';
import { MAIN_SCOPE, WorkspaceError } from './workspace.js';
import type { Workspace } from './workspace.js';

const GAP_RIGHT_OF_EXISTING = 300;
const BOUNDS_PADDING = 80;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** Between one column step (about 180-260 units) and two (about 430+): wires reaching past the next column become labels. */
const LABEL_WIRES_LONGER_THAN = 320;
const NET_LABEL_OFFSET = 22;

/**
 * Adds the workspace's main circuit and its chips next to whatever `top`
 * already holds; nothing existing is touched. Chips that already live in
 * `library` under the same id are shared, not copied. Throws before changing
 * anything if a new chip's name is already taken, or if a shared chip was
 * edited on the canvas after the workspace copied it.
 *
 * The workspace's main scope is emptied afterwards: its component ids were
 * copied verbatim, so publishing the same content twice would collide on `top`.
 */
export function appendWorkspace(
  top: Circuit,
  library: ChipLibrary,
  workspace: Workspace,
): { placedComponents: number; chips: string[]; bounds: Bounds } {
  const loaded = deserializeProject(serializeSlimStdcells(workspace.mainCircuit(), workspace.library));
  const placedComponents = loaded.topCircuit.components.size;
  if (placedComponents === 0) throw new WorkspaceError('main is empty: build something first');

  const sharedChips = loaded.library.list().filter((def) => library.has(def.id));
  const edited = sharedChips.filter((def) => (library.get(def.id).revision ?? 0) !== (def.revision ?? 0));
  if (edited.length > 0) {
    throw new WorkspaceError(
      `chip edited on the canvas since it was imported: ${edited.map((d) => d.name).join(', ')}. delete_chip it and use list_library to import the current version.`,
    );
  }
  const userChips = loaded.library.list().filter((def) => !library.has(def.id));
  const taken = userChips.filter((def) => library.findByName(def.name));
  if (taken.length > 0) {
    throw new WorkspaceError(
      `chip name already exists on the canvas: ${taken.map((d) => d.name).join(', ')}. Build it under another name.`,
    );
  }

  layoutLayered(loaded.topCircuit);
  nameNets(loaded.topCircuit, workspace.mainIoNames());
  replaceLongWiresWithLabels(loaded.topCircuit, LABEL_WIRES_LONGER_THAN, isPlainIoWire);
  renameClashingLabels(loaded.topCircuit, top);

  const existing = [...top.components.values()];
  const dx = existing.length === 0 ? 0 : Math.max(...existing.map((c) => c.pos.x)) + GAP_RIGHT_OF_EXISTING;
  const dy = existing.length === 0 ? 0 : Math.min(...existing.map((c) => c.pos.y));
  for (const id of [...loaded.topCircuit.components.keys()]) loaded.topCircuit.moveComponent(id, dx, dy);

  for (const def of userChips) library.register(def);
  for (const c of loaded.topCircuit.components.values()) top.addComponent(c);
  for (const w of loaded.topCircuit.wires.values()) top.addRawWire(w);
  resolveStdcellInstances(top, library);

  workspace.clear(MAIN_SCOPE);
  return { placedComponents, chips: userChips.map((d) => d.name), bounds: boundsOf(loaded.topCircuit) };
}

/** Tie each named input and probe to a label of the same name so its net is readable wherever it goes. */
function nameNets(circuit: Circuit, names: Map<string, string>): void {
  for (const [id, name] of names) {
    const comp = circuit.components.get(id);
    if (!comp || (comp.kind !== 'input' && comp.kind !== 'probe')) continue;
    const pin = comp.kind === 'input' ? comp.pins.out : comp.pins.in;
    const dx = comp.kind === 'input' ? NET_LABEL_OFFSET : -NET_LABEL_OFFSET;
    const label = makeLabel(circuit, name, { x: pin.pos.x + dx, y: pin.pos.y });
    wire(circuit, pin, label.pins.net);
  }
}

/** Labels with one name are one net across the whole canvas, so a new net must not reuse a name already there. */
function renameClashingLabels(added: Circuit, top: Circuit): void {
  const taken = new Set<string>();
  for (const c of top.components.values()) if (c.kind === 'label') taken.add(c.name);
  const renamed = new Map<string, string>();
  for (const c of added.components.values()) {
    if (c.kind !== 'label' || !taken.has(c.name)) continue;
    let target = renamed.get(c.name);
    if (!target) {
      let n = 2;
      while (taken.has(`${c.name}_${n}`)) n++;
      target = `${c.name}_${n}`;
      renamed.set(c.name, target);
    }
    c.name = target;
  }
}

/** A wire between an input/probe/constant and anything else reads better as a named net than as a drawn line. */
function isPlainIoWire(a: Component, b: Component): boolean {
  const isIo = (c: Component) => c.kind === 'input' || c.kind === 'probe' || c.kind === 'source';
  return (isIo(a) || isIo(b)) && a.kind !== 'label' && b.kind !== 'label';
}

function boundsOf(circuit: Circuit): Bounds {
  const comps = [...circuit.components.values()];
  return {
    minX: Math.min(...comps.map((c) => c.pos.x)) - BOUNDS_PADDING,
    minY: Math.min(...comps.map((c) => c.pos.y)) - BOUNDS_PADDING,
    maxX: Math.max(...comps.map((c) => c.pos.x)) + BOUNDS_PADDING,
    maxY: Math.max(...comps.map((c) => c.pos.y)) + BOUNDS_PADDING,
  };
}
