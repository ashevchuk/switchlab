import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { Circuit } from '../sim/Circuit.js';
import type { Component, Wire } from '../sim/types.js';
import type { ChipDef } from '../sim/ChipLibrary.js';
import { deserializeProject, resolveStdcellInstances, serializeSlimStdcells } from '../sim/serialize.js';
import { replaceLongWiresWithLabels } from '../sim/labelWires.js';
import { makeBusProbe, makeChipInstance } from '../sim/library.js';
import { layoutLayered } from './layout.js';
import { isStdcellName } from '../sim/stdcells.js';
import { MAIN_SCOPE, WorkspaceError } from './workspace.js';
import type { CanvasBase, Workspace } from './workspace.js';

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

export interface PublishResult {
  placedComponents: number;
  chips: string[];
  replaced: string[];
  /** Where the added circuit is, when one was added. */
  bounds?: Bounds;
}

/**
 * Adds the workspace's main circuit and its chips next to whatever `top`
 * already holds; nothing existing is touched. Chips that already live in
 * `library` under the same id are shared, not copied.
 *
 * `replace` names canvas chips that were rebuilt with begin_chip replace: their
 * definitions are updated in place, so every instance follows. Everything is
 * checked before anything changes: a new chip's name must be free, a shared
 * chip must not have been edited on the canvas since the workspace copied it,
 * and a chip being replaced must still have the ports it was started from.
 *
 * The workspace's main scope is emptied afterwards: its component ids were
 * copied verbatim, so publishing the same content twice would collide on `top`.
 */
export function appendWorkspace(
  top: Circuit,
  library: ChipLibrary,
  workspace: Workspace,
  options: { replace?: string[] } = {},
): PublishResult {
  const replacements = (options.replace ?? []).map((name) => workspace.replacementOf(name));
  const replacedIds = new Set(replacements.map((r) => r.def.id));

  const holder = new Circuit();
  for (const c of workspace.mainCircuit().components.values()) holder.addRawComponent(c);
  for (const w of workspace.mainCircuit().wires.values()) holder.addRawWire(w);
  const replacementInstanceIds = replacements.map((r) => makeChipInstance(holder, r.def).id);
  const loaded = deserializeProject(serializeSlimStdcells(holder, workspace.library));
  for (const id of replacementInstanceIds) loaded.topCircuit.removeComponent(id);
  const placedComponents = loaded.topCircuit.components.size;
  if (placedComponents === 0 && replacements.length === 0) throw new WorkspaceError('main is empty: build something first');

  for (const r of replacements) {
    if (!library.has(r.def.id)) throw new WorkspaceError(`${r.name} is no longer on the canvas`);
    const live = library.get(r.def.id);
    if ((live.revision ?? 0) !== r.baseRevision) {
      throw new WorkspaceError(`${r.name} was edited on the canvas after the replacement was started; delete_chip it and begin_chip again.`);
    }
  }
  assertSharedChipsCurrent(library, loaded.library.list().filter((def) => !replacedIds.has(def.id)));
  const userChips = loaded.library.list().filter((def) => !library.has(def.id));
  assertNamesFree(library, userChips);

  for (const r of replacements) {
    const live = library.get(r.def.id);
    live.circuit = loaded.library.get(r.def.id).circuit;
    live.revision = r.def.revision;
    library.register(live);
  }
  for (const def of userChips) library.register(def);

  let bounds: Bounds | undefined;
  if (placedComponents > 0) {
    const busProbes = replaceProbeBuses(loaded.topCircuit, workspace.mainProbeBuses());
    layoutLayered(loaded.topCircuit);
    const netNames = namesOfIoNets(loaded.topCircuit, workspace.mainIoNames(), busProbes);
    replaceLongWiresWithLabels(loaded.topCircuit, LABEL_WIRES_LONGER_THAN, isPlainIoWire, netNames);
    renameClashingLabels(loaded.topCircuit, top);

    const existing = [...top.components.values()];
    const dx = existing.length === 0 ? 0 : Math.max(...existing.map((c) => c.pos.x)) + GAP_RIGHT_OF_EXISTING;
    const dy = existing.length === 0 ? 0 : Math.min(...existing.map((c) => c.pos.y));
    for (const id of [...loaded.topCircuit.components.keys()]) loaded.topCircuit.moveComponent(id, dx, dy);
    for (const c of loaded.topCircuit.components.values()) top.addComponent(c);
    for (const w of loaded.topCircuit.wires.values()) top.addRawWire(w);
    bounds = boundsOf(loaded.topCircuit);
  }
  resolveStdcellInstances(top, library);

  workspace.markReplaced(replacements.map((r) => r.name));
  workspace.clear(MAIN_SCOPE);
  return {
    placedComponents,
    chips: userChips.map((d) => d.name),
    replaced: replacements.map((r) => r.name),
    ...(bounds ? { bounds } : {}),
  };
}

/**
 * The name each net gets on the canvas, by pin: the model's name for an input, probe or LED, and `y0`, `y1`, ...
 * for the bits of a bus probe. Passed to the label pass rather than added as labels of their own, which would
 * leave two labels with one name on the same pin.
 */
function namesOfIoNets(circuit: Circuit, names: Map<string, string>, busProbes: Map<string, string>): Map<string, string> {
  const byPin = new Map<string, string>();
  for (const [id, name] of names) {
    const comp = circuit.components.get(id);
    if (comp?.kind === 'input') byPin.set(comp.pins.out.id, name);
    else if (comp?.kind === 'probe' || comp?.kind === 'led') byPin.set(comp.pins.in.id, name);
  }
  for (const [id, name] of busProbes) {
    const bus = circuit.components.get(id);
    if (bus?.kind === 'busprobe') bus.pinOrder.forEach((pinName, bit) => byPin.set(bus.pins[pinName]!.id, `${name}${bit}`));
  }
  return byPin;
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
  const isIo = (c: Component) => c.kind === 'input' || c.kind === 'probe' || c.kind === 'led' || c.kind === 'busprobe' || c.kind === 'source';
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

function assertSharedChipsCurrent(library: ChipLibrary, defs: ChipDef[]): void {
  const edited = defs.filter((def) => library.has(def.id) && (library.get(def.id).revision ?? 0) !== (def.revision ?? 0));
  if (edited.length > 0) {
    throw new WorkspaceError(
      `chip edited on the canvas since it was imported: ${edited.map((d) => d.name).join(', ')}. delete_chip it and use list_library to import the current version.`,
    );
  }
}

function assertNamesFree(library: ChipLibrary, fresh: ChipDef[]): void {
  const taken = fresh.filter((def) => library.findByName(def.name));
  if (taken.length > 0) {
    throw new WorkspaceError(
      `chip name already exists on the canvas: ${taken.map((d) => d.name).join(', ')}. Build it under another name.`,
    );
  }
}

export interface CanvasApplyResult {
  addedComponents: number;
  removedComponents: number;
  movedComponents: number;
  addedWires: number;
  removedWires: number;
  chips: string[];
  /** Where the new components went, when there are any. */
  bounds?: Bounds;
}

/** The sandbox copy only means something against the canvas it was taken from. */
function assertCanvasUnchanged(top: Circuit, base: CanvasBase): void {
  const same =
    top.components.size === base.positions.size &&
    top.wires.size === base.wires.size &&
    [...top.components.values()].every((c) => {
      const was = base.positions.get(c.id);
      return was !== undefined && was.x === c.pos.x && was.y === c.pos.y;
    }) &&
    [...top.wires.keys()].every((id) => base.wires.has(id));
  if (!same) {
    throw new WorkspaceError('the canvas was changed after open_canvas; nothing was applied. Call open_canvas again to work from the current canvas.');
  }
}

/** Places the new components, as a block laid out by signal flow, to the right of everything on the canvas. */
function layoutAdded(top: Circuit, added: Component[], wires: Wire[]): Bounds | undefined {
  if (added.length === 0) return undefined;
  const ids = new Set(added.map((c) => c.id));
  const block = new Circuit();
  added.forEach((c) => block.addRawComponent(c));
  wires.filter((w) => ids.has(w.a.split(':')[0]!) && ids.has(w.b.split(':')[0]!)).forEach((w) => block.addRawWire(w));
  layoutLayered(block);
  const live = [...top.components.values()];
  const blockMinY = Math.min(...added.map((c) => c.pos.y));
  const dx = live.length === 0 ? 0 : Math.max(...live.map((c) => c.pos.x)) + GAP_RIGHT_OF_EXISTING;
  const dy = live.length === 0 ? 0 : Math.min(...live.map((c) => c.pos.y)) - blockMinY;
  added.forEach((c) => block.moveComponent(c.id, dx, dy));
  return boundsOf(block);
}

/**
 * Carries what was edited in the `canvas` scope over to the canvas: only the difference is applied, so
 * everything the edits did not touch (RAM contents, machine links, wire routes) stays exactly as it was.
 * Refuses, before changing anything, if the canvas was edited since open_canvas.
 */
export function applyCanvasEdits(top: Circuit, library: ChipLibrary, workspace: Workspace): CanvasApplyResult {
  const diff = workspace.canvasDiff();
  assertCanvasUnchanged(top, diff.base);

  const addedChips = diff.addedComponents.filter((c) => c.kind === 'chip');
  const holder = new Circuit();
  for (const id of new Set(addedChips.map((c) => c.defId))) {
    const def = workspace.library.get(id);
    if (!isStdcellName(def.name)) makeChipInstance(holder, def);
  }
  const bundle = deserializeProject(serializeSlimStdcells(holder, workspace.library));
  assertSharedChipsCurrent(library, bundle.library.list());
  const fresh = bundle.library.list().filter((def) => !library.has(def.id));
  assertNamesFree(library, fresh);
  const liveDefId = (wsDefId: string): string => {
    if (library.has(wsDefId)) return wsDefId;
    const def = workspace.library.get(wsDefId);
    if (!isStdcellName(def.name)) return wsDefId;
    const seeded = library.findByName(def.name);
    if (!seeded) throw new WorkspaceError(`${def.name} is missing from the canvas library`);
    return seeded.id;
  };
  const targetOf = new Map(addedChips.map((c) => [c.id, liveDefId(c.defId)]));

  const bounds = layoutAdded(top, diff.addedComponents, diff.addedWires);

  for (const def of fresh) library.register(def);
  for (const id of diff.removedComponents) top.removeComponent(id);
  for (const { id, dx, dy } of diff.moved) top.moveComponent(id, dx, dy);
  for (const id of diff.removedWires) top.removeWire(id);
  for (const comp of diff.addedComponents) {
    const copy = structuredClone(comp);
    if (copy.kind === 'chip') {
      copy.defId = targetOf.get(comp.id)!;
      copy.defRevision = library.get(copy.defId).revision ?? 0;
    }
    top.addComponent(copy);
  }
  for (const w of diff.addedWires) top.addRawWire(structuredClone(w));
  resolveStdcellInstances(top, library);

  workspace.acceptCanvasApplied();
  return {
    addedComponents: diff.addedComponents.length,
    removedComponents: diff.removedComponents.length,
    movedComponents: diff.moved.length,
    addedWires: diff.addedWires.length,
    removedWires: diff.removedWires.length,
    chips: fresh.map((d) => d.name),
    ...(bounds ? { bounds } : {}),
  };
}

/**
 * A bus of probes is one bus probe on the canvas: a single readout with the decoded value, one item in the
 * watch strip, instead of one probe per bit. Returns the bus probes made, by component id, with the bus name.
 */
function replaceProbeBuses(circuit: Circuit, buses: Map<string, string[]>): Map<string, string> {
  const made = new Map<string, string>();
  for (const [name, ids] of buses) {
    const probes = ids.map((id) => circuit.components.get(id));
    if (probes.some((p) => p?.kind !== 'probe')) continue;
    const at = {
      x: probes.reduce((sum, p) => sum + p!.pos.x, 0) / probes.length,
      y: probes.reduce((sum, p) => sum + p!.pos.y, 0) / probes.length,
    };
    const bus = makeBusProbe(circuit, ids.length, at, 'dec');
    bus.label = name;
    made.set(bus.id, name);
    ids.forEach((id, bit) => {
      const probe = circuit.components.get(id);
      if (probe?.kind !== 'probe') return;
      const target = bus.pins[`b${bit}`]!;
      for (const w of circuit.wires.values()) {
        if (w.a === probe.pins.in.id) w.a = target.id;
        if (w.b === probe.pins.in.id) w.b = target.id;
      }
      circuit.removeComponent(id);
    });
  }
  return made;
}
