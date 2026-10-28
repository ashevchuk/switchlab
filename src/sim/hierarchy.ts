import type { ChipDef, ChipLibrary } from './ChipLibrary.js';
import { bumpStructureVersion, Circuit, currentStructureVersion, GLOBAL_NET_NAMES, nextId } from './Circuit.js';
import { makeChipInstance, makeInput, makePort, makeProbe, makeSource, pinSidesFromDef } from './library.js';
import { tidyLibraryCircuit } from './labelWires.js';
import { orthoWaypoints } from './wireRoute.js';
import { importChipDef, serializeChipDef } from './serialize.js';
import { applyPinLayout } from './orientation.js';
import type {
  ButtonComponent,
  BusSwitchComponent,
  ChipInstanceComponent,
  ClockComponent,
  Component,
  InputComponent,
  Pin,
  Point,
  PortComponent,
  SourceComponent,
} from './types.js';
import {
  ensureSoftState,
  hasSoftLabModel,
  isSoftExpandForced,
  isSoftLabEnabled,
  softLabModelKey,
} from './softLab.js';

export interface FoldResult {
  def: ChipDef;
  instance: ChipInstanceComponent;
}

const UNFOLD_ID_PREFIX: Record<Component['kind'], string> = {
  transistor: 't',
  source: 'src',
  input: 'in',
  button: 'btn',
  switch: 'sw',
  led: 'led',
  sevenseg: '7seg',
  clock: 'clk',
  analyzer: 'la',
  busprobe: 'bus',
  busswitch: 'bsw',
  buspass: 'bpass',
  tty: 'tty',
  probe: 'probe',
  label: 'lbl',
  junction: 'junc',
  port: 'port',
  chip: 'chip',
  ram: 'ram',
  rom: 'rom',
};

/**
 * Convenience wrapper around fold() for building a ChipDef entirely in
 * code (used by blocks.ts, and by the hierarchy/fold test suite) instead
 * of via the UI's Ctrl+G.
 *
 * fold() only turns a net into a port if it *crosses the selection
 * boundary* (see fold()'s own doc comment) — a freshly-wired gate's
 * exposed pins have no such crossing wire yet, so nothing would become a
 * port. This wires each of `exposedPins` to a throwaway Input (for an
 * input pin) or Probe (for an output pin) left *outside* the selection —
 * forcing that net to cross the boundary, in the given order — then folds
 * everything else in `scratch` and discards the stubs along with it.
 */
export function foldExposing(
  scratch: Circuit,
  name: string,
  library: ChipLibrary,
  exposedPins: { pin: Pin; isOutput: boolean; portName?: string }[],
  opts?: { labelize?: boolean },
): ChipDef {
  const stubIds = new Set<string>();
  for (const { pin, isOutput } of exposedPins) {
    if (isOutput) {
      const stub = makeProbe(scratch);
      stubIds.add(stub.id);
      scratch.addWire(pin.id, stub.pins.in.id);
    } else {
      const stub = makeInput(scratch, 0);
      stubIds.add(stub.id);
      scratch.addWire(stub.pins.out.id, pin.id);
    }
  }
  const guts = new Set<string>();
  for (const id of scratch.components.keys()) if (!stubIds.has(id)) guts.add(id);
  const def = fold(scratch, guts, name, library, { x: 0, y: 0 }).def;

  // Give ports readable names (in/out/a/b/…) instead of p0/p1 from fold().
  const nets = def.circuit.computeNets();
  let inIdx = 0;
  let outIdx = 0;
  const inputCount = exposedPins.filter((e) => !e.isOutput).length;
  const outputCount = exposedPins.filter((e) => e.isOutput).length;
  for (const exp of exposedPins) {
    let want = exp.portName;
    if (!want) {
      if (exp.isOutput) {
        want = outputCount <= 1 ? 'out' : `out${outIdx}`;
        outIdx++;
      } else {
        want = inputCount <= 1 ? 'in' : (['a', 'b', 'c', 'd', 'e', 'f'][inIdx] ?? `in${inIdx}`);
        inIdx++;
      }
    }
    const net = nets.netOf.get(exp.pin.id);
    if (!net) continue;
    for (const c of def.circuit.components.values()) {
      if (c.kind !== 'port') continue;
      if (nets.netOf.get(c.pins.io.id) !== net) continue;
      if (c.name === want) {
        c.dir = exp.isOutput ? 'out' : 'in';
        break;
      }
      const idx = def.ports.indexOf(c.name);
      if (idx >= 0) def.ports[idx] = want;
      c.name = want;
      c.dir = exp.isOutput ? 'out' : 'in';
      break;
    }
  }

  // Mid/high library cells: replace interconnect spaghetti with net labels.
  // CMOS primitives (NOT/NAND/NOR) pass labelize:false so G/D/S wires stay.
  stripOrphanRailArtifacts(def.circuit);
  if (opts?.labelize !== false) {
    tidyLibraryCircuit(def.circuit);
  } else {
    layoutCmosPrimitivePorts(def);
  }
  return def;
}

/**
 * Scratch circuits always get VCC/GND Sources for CMOS builders. Gate-layer
 * composites (XOR = 4× NAND chips, …) never touch those rails — power lives
 * inside the nested chips — so the Sources become floating schematic junk.
 * Drop Sources/labels whose rail net has no real load (transistor, chip, …).
 */
function stripOrphanRailArtifacts(circuit: Circuit): void {
  const pinOwner = new Map<string, { id: string; kind: string }>();
  for (const c of circuit.components.values()) {
    for (const p of Object.values(c.pins) as Pin[]) {
      pinOwner.set(p.id, { id: c.id, kind: c.kind });
    }
  }
  const nets = circuit.computeNets();
  const netHasLoad = (netId: string | undefined): boolean => {
    if (!netId) return false;
    for (const [pinId, nid] of nets.netOf) {
      if (nid !== netId) continue;
      const owner = pinOwner.get(pinId);
      if (!owner) continue;
      if (owner.kind === 'source' || owner.kind === 'label' || owner.kind === 'port') continue;
      return true;
    }
    return false;
  };

  for (const c of [...circuit.components.values()]) {
    if (c.kind === 'source') {
      if (!netHasLoad(nets.netOf.get(c.pins.out.id))) circuit.removeComponent(c.id);
    } else if (c.kind === 'label' && (c.name === 'VCC' || c.name === 'GND')) {
      if (!netHasLoad(nets.netOf.get(c.pins.net.id))) circuit.removeComponent(c.id);
    }
  }
}

/**
 * Park boundary ports around a CMOS / gate-layer schematic like a real sheet:
 * inputs on the left, outputs on the right, spaced so labels never overlap.
 * Anchors are transistors and nested chip instances. Unused scratch rail
 * Sources are stripped before this runs (see stripOrphanRailArtifacts).
 *
 * Important: do NOT snap every input to the first pin on its net — for NAND
 * both A and B hit parallel PMOS gates at the same Y and glue into "IN a/b".
 * Prefer N-MOSFET gate Y (series stack has distinct rows), then enforce a
 * minimum vertical pitch in port-list order.
 */
export function relayoutCmosPrimitivePorts(def: ChipDef): void {
  layoutCmosPrimitivePorts(def);
}

function layoutCmosPrimitivePorts(def: ChipDef): void {
  const anchors = [...def.circuit.components.values()].filter(
    (c) => c.kind === 'transistor' || c.kind === 'chip',
  );
  if (anchors.length === 0) return;

  const PORT_MIN_PITCH = 72;
  const PORT_EDGE = 110;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of anchors) {
    minX = Math.min(minX, t.pos.x);
    maxX = Math.max(maxX, t.pos.x);
    minY = Math.min(minY, t.pos.y);
    maxY = Math.max(maxY, t.pos.y);
  }
  const hasChips = anchors.some((c) => c.kind === 'chip');
  if (hasChips) {
    maxX += 48;
    minX -= 48;
  }

  const nets = def.circuit.computeNets();
  const isOutPort = (name: string, dir?: string): boolean => {
    if (dir === 'out') return true;
    if (dir === 'in') return false;
    return (
      name === 'out' ||
      name.startsWith('out') ||
      name === 'sum' ||
      name === 'cout' ||
      name === 'co' ||
      name === 'sout' ||
      name === 'q' ||
      name === 'qn' ||
      /^q\d+$/.test(name) ||
      /^qn\d+$/.test(name) ||
      /^sum\d+$/.test(name) ||
      /^y\d+$/.test(name) ||
      /^s\d+$/.test(name)
    );
  };
  const portDir = (name: string): string | undefined => {
    for (const c of def.circuit.components.values()) {
      if (c.kind === 'port' && c.name === name) return c.dir;
    }
    return undefined;
  };
  const inputPorts = def.ports.filter((n) => !isOutPort(n, portDir(n)));
  const outputPorts = def.ports.filter((n) => isOutPort(n, portDir(n)));

  /** Attach Y: leftmost gate on the net (short hop from left ports). */
  const preferredAttachY = (netId: string | undefined): number | undefined => {
    if (!netId) return undefined;
    let bestY: number | undefined;
    let bestX = Infinity;
    for (const c of def.circuit.components.values()) {
      if (c.kind !== 'transistor') continue;
      const g = c.pins.gate;
      if (nets.netOf.get(g.id) !== netId) continue;
      if (g.pos.x < bestX - 0.5 || (Math.abs(g.pos.x - bestX) < 0.5 && (bestY === undefined || g.pos.y < bestY))) {
        bestX = g.pos.x;
        bestY = g.pos.y;
      }
    }
    if (bestY !== undefined) return bestY;
    for (const c of def.circuit.components.values()) {
      if (c.kind === 'port' || c.kind === 'source' || c.kind === 'label') continue;
      for (const p of Object.values(c.pins) as Pin[]) {
        if (nets.netOf.get(p.id) === netId) return p.pos.y;
      }
    }
    return undefined;
  };

  /** Keep port-list order; use hints when already spaced, else even spread. */
  const spacedYs = (
    names: string[],
    fallbackLo: number,
    fallbackHi: number,
  ): number[] => {
    const n = names.length;
    if (n === 0) return [];
    const hints = names.map((name) => {
      for (const c of def.circuit.components.values()) {
        if (c.kind === 'port' && c.name === name) {
          return preferredAttachY(nets.netOf.get(c.pins.io.id));
        }
      }
      return undefined;
    });
    const usable =
      hints.every((y) => y !== undefined) &&
      hints.every((y, i) =>
        hints.every(
          (z, j) => i === j || Math.abs((y as number) - (z as number)) >= PORT_MIN_PITCH * 0.85,
        ),
      );
    if (usable) return hints as number[];

    const span = Math.max(
      fallbackHi - fallbackLo,
      PORT_MIN_PITCH * Math.max(n - 1, 1),
    );
    const mid = (fallbackLo + fallbackHi) / 2;
    if (n === 1) return [mid];
    const top = mid - span / 2;
    return Array.from({ length: n }, (_, i) => top + (i * span) / (n - 1));
  };

  const inYs = spacedYs(inputPorts, minY, maxY);
  const outYs = spacedYs(outputPorts, minY, maxY);

  for (const c of def.circuit.components.values()) {
    if (c.kind !== 'port') continue;
    const isOut = isOutPort(c.name, c.dir);
    if (isOut) {
      const idx = outputPorts.indexOf(c.name);
      const y = outYs[idx >= 0 ? idx : 0] ?? (minY + maxY) / 2;
      c.pos = { x: maxX + PORT_EDGE, y };
      c.dir = 'out';
    } else {
      const idx = inputPorts.indexOf(c.name);
      const y = inYs[idx >= 0 ? idx : 0] ?? (minY + maxY) / 2;
      c.pos = { x: minX - PORT_EDGE, y };
      c.dir = 'in';
    }
    c.pins.io.pos = { x: c.pos.x, y: c.pos.y };
  }

  // After moving ports, rebuild ortho stubs that touch a port — otherwise a
  // leftover HVH path from the old (glued) seat can loop around the sheet.
  const pinOf = new Map<string, Pin>();
  const ownerOf = new Map<string, { kind: string }>();
  for (const c of def.circuit.components.values()) {
    for (const p of Object.values(c.pins) as Pin[]) {
      pinOf.set(p.id, p);
      ownerOf.set(p.id, c);
    }
  }
  for (const w of def.circuit.wires.values()) {
    const pa = pinOf.get(w.a);
    const pb = pinOf.get(w.b);
    if (!pa || !pb) continue;
    const touchesPort =
      ownerOf.get(w.a)?.kind === 'port' || ownerOf.get(w.b)?.kind === 'port';
    if (!touchesPort) continue;
    w.waypoints = orthoWaypoints(pa.pos, pb.pos);
  }
}

/**
 * Rename one port of a chip definition (double-click a port while dived
 * into a chip, per the reference project's "Ports & labels: double-click to
 * rename"). This has to reach further than the single `PortComponent` being
 * renamed: `def.ports` is an ordered list of *names*, keyed on to build
 * every placed instance's `pins` record (see makeChipInstance in
 * library.ts) — so every existing instance of this def, wherever it lives,
 * needs that key renamed too, or its pin would silently vanish from view
 * under its old name.
 *
 * Wires never need touching: they reference `Pin.id`, which never changes
 * here — only the record key and the pin's own `.name` do.
 *
 * `allCircuits` must include every circuit that could contain an instance
 * of this def: the top-level circuit plus every ChipDef's own circuit
 * (an instance can live inside another chip's internals too).
 */
export function renamePort(
  library: ChipLibrary,
  allCircuits: Circuit[],
  defId: string,
  oldName: string,
  newName: string,
): boolean {
  if (newName === oldName) return true;
  const def = library.get(defId);
  if (def.ports.includes(newName)) return false; // name collision

  const idx = def.ports.indexOf(oldName);
  if (idx === -1) return false;
  def.ports[idx] = newName;

  for (const c of def.circuit.components.values()) {
    if (c.kind === 'port' && c.name === oldName) c.name = newName;
  }

  for (const circuit of allCircuits) {
    for (const c of circuit.components.values()) {
      if (c.kind !== 'chip' || c.defId !== defId) continue;
      const pin = c.pins[oldName];
      if (!pin) continue;
      pin.name = newName;
      delete c.pins[oldName];
      c.pins[newName] = pin;
      const orderIdx = c.pinOrder.indexOf(oldName);
      if (orderIdx !== -1) c.pinOrder[orderIdx] = newName;
      if (c.pinSide && oldName in c.pinSide) {
        c.pinSide[newName] = c.pinSide[oldName]!;
        delete c.pinSide[oldName];
      }
    }
  }
  // None of the mutations above go through Circuit's own tracked methods
  // (addComponent/addWire/etc, the ones that bump the shared structure
  // version for flatten()'s own cache — see hierarchy.ts's flatten()) —
  // this rewrites `.name`/`.pins` keys directly. A stale cache from before
  // a rename wouldn't break simulation (port names carry no electrical
  // meaning), but an explicit bump costs nothing for an operation this rare.
  bumpStructureVersion();
  return true;
}

/**
 * Fold a set of components (Ctrl+G in the UI) into a reusable chip: the
 * selection is cut out of `parent` into a fresh internal Circuit, registered
 * in `library`, and replaced in `parent` by one ChipInstanceComponent.
 *
 * Ports come from two sources (same ChipDef.ports list):
 * 1. Explicit `PortComponent`s already in the selection (design-in-place —
 *    place Port from the palette, wire the internals, fold without leaving
 *    stubs outside the selection).
 * 2. Any remaining net that has pins both inside and outside the selection
 *    (classic boundary-crossing fold), which gets a numbered `pN` port.
 *
 * VCC/GND are the one exception: per the reference project's spec, they're a
 * global rail available inside every chip with no explicit port ("Power flows
 * into chips over the global VCC/GND rails automatically") — so a crossing
 * VCC/GND net instead gets a fresh local `source` component wired in on the
 * inside. That makes every folded chip self-powered on its own, and flatten()
 * (below) still reunites every VCC/GND source system-wide once the whole
 * hierarchy is simulated, for free, via Circuit.computeNets()'s existing
 * global name-based merge — no extra plumbing needed.
 *
 * Known limitation: this assumes a selection's internal share of any
 * crossing net is already connected *within* the selection (by a wire that
 * itself stays fully inside). A net that would only stay connected by
 * routing back out through the unselected part of the circuit is not
 * supported — an unusual topology in practice, not worth the complexity
 * it would add here.
 */
export function fold(
  parent: Circuit,
  selectedIds: Set<string>,
  name: string,
  library: ChipLibrary,
  instancePos: Point,
): FoldResult {
  if (selectedIds.size === 0) throw new Error('cannot fold an empty selection');
  for (const id of selectedIds) {
    // A folded chip's internal circuit is one shared template every
    // instance's flatten() expands from — fine for transistors (each
    // instance's *simulated* nets are still independent, per-instance-path
    // namespaced), wrong for RAM, whose actual state lives in one Uint8Array
    // by reference (see flattenLevel's own comment on why). Every instance
    // of a folded RAM chip would silently share that one array. Rather than
    // let that footgun through, RAM simply can't be folded — see
    // ARCHITECTURE.md's "Real RAM" for the reasoning.
    if (parent.components.get(id)?.kind === 'ram' || parent.components.get(id)?.kind === 'rom') {
      throw new Error('RAM/ROM cannot be folded into a chip — each instance would share the same memory. Wire it directly instead.');
    }
  }

  // Nets *before* any mutation (and before bumping) — fold needs net ids for
  // crossing wires / VCC·GND. Bumping first would only force a cold compute.
  const netMap = parent.computeNets();
  const ownerOf = new Map<string, string>();
  for (const c of parent.components.values()) {
    for (const p of Object.values(c.pins) as Pin[]) ownerOf.set(p.id, c.id);
  }
  const isSelected = (pinId: string) => selectedIds.has(ownerOf.get(pinId) ?? '');

  // Batch-move selected components with addRawComponent (no per-id bump).
  // Same for inside wires via addRawWire. One explicit bump at the end covers
  // the raw Map deletes that bypass removeComponent()/removeWire().
  const internal = new Circuit();
  for (const id of selectedIds) {
    const c = parent.components.get(id);
    if (!c) throw new Error(`selected component not found: ${id}`);
    parent.components.delete(id);
    internal.addRawComponent(c);
  }

  const ports: string[] = [];
  const portByNet = new Map<string, { name: string; ioPinId: string }>();
  const pendingOutsideWires: { outsidePinId: string; portName: string }[] = [];

  // Explicit ports in the selection become ChipDef ports as-is (palette Port
  // workflow). Sort by y so the instance pin stack matches on-canvas layout.
  const explicitPorts = [...internal.components.values()]
    .filter((c) => c.kind === 'port')
    .sort((a, b) => a.pos.y - b.pos.y || a.name.localeCompare(b.name));
  for (const port of explicitPorts) {
    let name = port.name.trim() || `p${ports.length}`;
    if (ports.includes(name)) {
      let k = 2;
      while (ports.includes(`${name}_${k}`)) k++;
      name = `${name}_${k}`;
      port.name = name;
    }
    ports.push(name);
    const netId = netMap.netOf.get(port.pins.io.id);
    if (netId && netId !== 'VCC' && netId !== 'GND') {
      portByNet.set(netId, { name, ioPinId: port.pins.io.id });
    }
  }

  // Delete while iterating — Map forbids only inserting unseen keys; deleting
  // the current entry is fine and avoids copying ~50k wires on Z80 fold.
  for (const w of parent.wires.values()) {
    const aIn = isSelected(w.a);
    const bIn = isSelected(w.b);
    if (aIn && bIn) {
      // Fully inside: moves into the chip's internals verbatim.
      parent.wires.delete(w.id);
      internal.addRawWire(w);
      continue;
    }
    if (!aIn && !bIn) continue; // fully outside the selection, untouched

    const insidePinId = aIn ? w.a : w.b;
    const outsidePinId = aIn ? w.b : w.a;
    const netId = netMap.netOf.get(insidePinId);
    parent.wires.delete(w.id);

    if (netId === 'VCC' || netId === 'GND') {
      const src = makeSource(internal, netId === 'VCC' ? 1 : 0);
      internal.addWire(insidePinId, src.pins.out.id);
      continue;
    }

    let entry = netId ? portByNet.get(netId) : undefined;
    if (!entry) {
      let i = ports.length;
      let portName = `p${i}`;
      while (ports.includes(portName)) {
        i++;
        portName = `p${i}`;
      }
      // Positive x: the canvas can't scroll to negative coordinates, so a
      // freshly-folded chip's internals must open with its ports on-screen.
      const port = makePort(internal, portName, { x: 40, y: 80 + ports.length * 40 });
      entry = { name: portName, ioPinId: port.pins.io.id };
      ports.push(portName);
      if (netId) portByNet.set(netId, entry);
    }
    // Wire *every* crossing wire's inside pin to the port, not just the
    // first — a net can fan in from several inside pins that are only
    // mutually connected via the outside world at all (before folding),
    // e.g. one external line driving several separate internal gates.
    // Skip when the crossing already lands on the port pin itself (explicit
    // Port placed on the boundary and wired outward).
    if (insidePinId !== entry.ioPinId) {
      internal.addWire(insidePinId, entry.ioPinId);
    }
    pendingOutsideWires.push({ outsidePinId, portName: entry.name });
  }

  const def: ChipDef = { id: nextId('chipdef'), name, ports, circuit: internal };
  library.register(def);

  const instance = makeChipInstance(parent, def, instancePos);
  for (const { outsidePinId, portName } of pendingOutsideWires) {
    const instancePin = instance.pins[portName];
    if (instancePin) parent.addWire(outsidePinId, instancePin.id);
  }

  bumpStructureVersion();
  return { def, instance };
}

/**
 * Soft warnings before fold — duplicate explicit port names, or ports with
 * no wire at all. Callers may confirm-or-abort; fold() itself still renames
 * duplicates with `_2` suffixes and leaves unwired ports as dangling pins.
 */
export function foldPortWarnings(parent: Circuit, selectedIds: Set<string>): string[] {
  const warnings: string[] = [];
  const ports: PortComponent[] = [];
  for (const id of selectedIds) {
    const c = parent.components.get(id);
    if (c?.kind === 'port') ports.push(c);
  }
  if (ports.length === 0) return warnings;

  const counts = new Map<string, number>();
  for (const p of ports) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n > 1) warnings.push(`Duplicate port name "${name}" (${n}×) — extras become ${name}_2…`);
  }

  const wired = new Set<string>();
  for (const w of parent.wires.values()) {
    wired.add(w.a);
    wired.add(w.b);
  }
  for (const p of ports) {
    if (!wired.has(p.pins.io.id)) warnings.push(`Port "${p.name}" has no wire`);
  }
  return warnings;
}

/**
 * Inverse of fold for one chip instance: clone the ChipDef's internal
 * circuit into `parent` (fresh ids — the def template stays shared), rewire
 * anything that was attached to the instance pins onto the matching cloned
 * ports, and delete the instance. Nested chip instances keep their defIds.
 *
 * Orientation of the instance is ignored (guts are placed unrotated around
 * the instance position).
 */
export function unfold(
  parent: Circuit,
  instanceId: string,
  library: ChipLibrary,
): { ids: string[] } {
  const inst = parent.components.get(instanceId);
  if (!inst || inst.kind !== 'chip') throw new Error('unfold: not a chip instance');
  const def = library.get(inst.defId);

  // Detach parent wires that touch the instance; remember outside ends per port.
  const externalByPort = new Map<string, string[]>();
  for (const w of [...parent.wires.values()]) {
    const aInst = w.a.startsWith(`${instanceId}:`);
    const bInst = w.b.startsWith(`${instanceId}:`);
    if (aInst === bInst) continue;
    const instPinId = aInst ? w.a : w.b;
    const outsidePinId = aInst ? w.b : w.a;
    let portName: string | undefined;
    for (const p of Object.values(inst.pins) as Pin[]) {
      if (p.id === instPinId) {
        portName = p.name;
        break;
      }
    }
    parent.removeWire(w.id);
    if (!portName) continue;
    const list = externalByPort.get(portName) ?? [];
    list.push(outsidePinId);
    externalByPort.set(portName, list);
  }

  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (const c of def.circuit.components.values()) {
    sumX += c.pos.x;
    sumY += c.pos.y;
    n++;
  }
  const dx = n > 0 ? inst.pos.x - sumX / n : inst.pos.x;
  const dy = n > 0 ? inst.pos.y - sumY / n : inst.pos.y;

  const pinMap = new Map<string, string>();
  const newIds: string[] = [];
  const portIoByName = new Map<string, string>();

  for (const c of def.circuit.components.values()) {
    const newId = nextId(UNFOLD_ID_PREFIX[c.kind]);
    newIds.push(newId);
    const clone = structuredClone(c) as Component;
    clone.id = newId;
    clone.pos = { x: c.pos.x + dx, y: c.pos.y + dy };
    for (const p of Object.values(clone.pins) as Pin[]) {
      const oldId = p.id;
      const pinName = oldId.includes(':') ? oldId.slice(oldId.indexOf(':') + 1) : p.name;
      p.id = `${newId}:${pinName}`;
      p.componentId = newId;
      p.pos = { x: p.pos.x + dx, y: p.pos.y + dy };
      pinMap.set(oldId, p.id);
    }
    if (clone.kind === 'port') {
      clone.dir = clone.dir ?? 'inout';
      portIoByName.set(clone.name, clone.pins.io.id);
    }
    if (clone.kind === 'ram' || clone.kind === 'rom') {
      clone.bytes = Uint8Array.from(c.kind === 'ram' || c.kind === 'rom' ? c.bytes : []);
    }
    parent.addComponent(clone);
  }

  for (const w of def.circuit.wires.values()) {
    const a = pinMap.get(w.a);
    const b = pinMap.get(w.b);
    if (!a || !b) continue;
    parent.addWire(
      a,
      b,
      w.waypoints?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    );
  }

  for (const [portName, outsidePins] of externalByPort) {
    const ioId = portIoByName.get(portName);
    if (!ioId) continue;
    // Resolve positions for orthogonal routing after components are placed.
    let portPos: Point | undefined;
    for (const c of parent.components.values()) {
      for (const p of Object.values(c.pins) as Pin[]) {
        if (p.id === ioId) {
          portPos = p.pos;
          break;
        }
      }
      if (portPos) break;
    }
    for (const outsidePinId of outsidePins) {
      let outsidePos: Point | undefined;
      for (const c of parent.components.values()) {
        for (const p of Object.values(c.pins) as Pin[]) {
          if (p.id === outsidePinId) {
            outsidePos = p.pos;
            break;
          }
        }
        if (outsidePos) break;
      }
      const mid =
        portPos && outsidePos ? orthoWaypoints(outsidePos, portPos) : undefined;
      parent.addWire(outsidePinId, ioId, mid);
    }
  }

  parent.removeComponent(instanceId);
  bumpStructureVersion();
  return { ids: newIds };
}

/**
 * Clone a ChipDef into a fresh library entry and retarget `inst` to it so
 * subsequent dive-edits do not mutate other instances of the original def.
 */
export function forkChipInstance(library: ChipLibrary, inst: ChipInstanceComponent): ChipDef {
  const def = library.get(inst.defId);
  const bundle = serializeChipDef(def, library);
  const forked = importChipDef(bundle, library);
  forked.name = `${def.name}_copy`;
  forked.revision = 0;
  inst.defId = forked.id;
  inst.defRevision = 0;
  inst.pinSide = pinSidesFromDef(forked);
  applyPinLayout(inst);
  bumpStructureVersion();
  return forked;
}

interface FlatLevel {
  components: Component[];
  wires: { id: string; a: string; b: string }[];
  liveValuePairs: LiveValuePair[];
}

/**
 * `SourceComponent.value`/`InputComponent.value` are the one other piece of
 * runtime-mutable state besides RAM's own `.bytes` (see flattenLevel's own
 * comment on that) — a toggleable input's whole reason to exist is getting
 * flipped between ticks, by direct field assignment (`input.value = 1`),
 * never through a Circuit method, so it never bumps the structure version
 * and never invalidates flatten()'s own cache (correctly — flipping an
 * input doesn't change the *netlist*, only what's forced onto one of its
 * existing nets). A cached flat clone's own `.value` copy, though, is
 * frozen at whatever it was the moment that clone was built — every pair
 * collected here exists so a cache *hit* can still cheaply re-copy each
 * clone's `.value` from its original before handing the result back,
 * rather than serving a stale toggle forever.
 */
interface LiveValuePair {
  original: SourceComponent | InputComponent | ButtonComponent | ClockComponent | BusSwitchComponent;
  clone: SourceComponent | InputComponent | ButtonComponent | ClockComponent | BusSwitchComponent;
}

/**
 * Recursively expand every chip instance in `top` into its transistor-level
 * guts, producing one flat Circuit that solver.ts can simulate completely
 * unchanged — hierarchy is purely a structural/editing convenience, nothing
 * about the solver needs to know chips exist.
 *
 * Every id gets namespaced per instance path (`${instanceId}/${...}`, deep
 * for nested chips) so that two instances of the same ChipDef get fully
 * independent internal nets — essential, since a ChipDef's `circuit` is
 * shared by every instance for *editing*, but each instance's *simulated*
 * state must not be shared. The one deliberate exception: a port's `io`
 * pin is aliased onto the exact pin id the instance already uses for that
 * port at the level above, so wires drawn to the instance resolve straight
 * through with no extra step. VCC/GND sources are never namespaced
 * specially at all — see the note on fold() above for why that is exactly
 * the global-rail behavior we want.
 */
/**
 * Cached per top-level Circuit, keyed on the shared structural-version
 * counter (see Circuit.ts's bumpStructureVersion/currentStructureVersion):
 * flatten() is called once per tick — every animation frame in the live
 * app (see main.ts's frame()), once per pulse() in every buildZ80Cpu test
 * — and its own cost (cloning every component, recursively
 * through the whole hierarchy) had nothing to do with whether anything
 * actually changed since the last call. The overwhelming majority of
 * calls, in both the live app and every test, happen between edits, not
 * during one: toggling an input, pulsing a clock, or just letting
 * requestAnimationFrame tick idly never touches a single wire or
 * component. This cache turns every one of those into a WeakMap lookup
 * and a version-number comparison, at the cost of one wrong assumption
 * this file must never make: that the version bumped by flatten()'s own
 * output-building (`out`'s components/wires) could safely be told apart
 * from a version bump caused by an actual user edit somewhere in `top`'s
 * hierarchy. It can't, cheaply — so `out` is built entirely from
 * addRawComponent()/addRawWire(), which don't bump the counter at all,
 * exactly the reason those two exist.
 */
const flattenCache = new WeakMap<
  Circuit,
  { version: number; softLab: boolean; result: Circuit; liveValuePairs: LiveValuePair[] }
>();

/**
 * Fully-expanded ChipDef flatten at prefix `''`, keyed by the def's own
 * `circuit` + structureVersion. Multiple instances of the same def (the
 * common case inside a folded Z80: thousands of identical gate chips)
 * rebase this template with `nsPrefix` instead of re-walking nested chips.
 */
const chipDefFlatCache = new WeakMap<Circuit, { version: number; softLab: boolean; flat: FlatLevel }>();
/** How many times flattenChipDef has been asked to expand this def.circuit. */
const chipDefFlatRequestCount = new WeakMap<Circuit, number>();

export function flatten(top: Circuit, library: ChipLibrary): Circuit {
  const version = currentStructureVersion();
  const softLab = isSoftLabEnabled();
  const cached = flattenCache.get(top);
  if (cached && cached.version === version && cached.softLab === softLab) {
    // The netlist itself hasn't changed, but a toggleable input's own
    // `.value` — the one piece of state this version check can't see (see
    // LiveValuePair's own doc comment) — might have, since the caller's
    // very last tick. Cheap regardless: a handful of pairs, not a
    // clone of the whole hierarchy.
    for (const { original, clone } of cached.liveValuePairs) {
      clone.value = original.value;
      if (original.kind === 'clock' && clone.kind === 'clock') {
        clone.running = original.running;
        clone.phase = original.phase;
        clone.holdFrames = original.holdFrames;
        clone.mode = original.mode;
        clone.periodFrames = original.periodFrames;
        clone.dutyFrames = original.dutyFrames;
      }
      if (original.kind === 'button' && clone.kind === 'button') {
        clone.holdFrames = original.holdFrames;
        clone.mode = original.mode;
      }
    }
    return cached.result;
  }

  const { components, wires, liveValuePairs } = flattenLevel(top, library, '');
  const out = new Circuit();
  for (const c of components) out.addRawComponent(c);
  for (const w of wires) out.addRawWire(w);

  flattenCache.set(top, { version, softLab, result: out, liveValuePairs });
  return out;
}

/** Clone a Pin; only the four own fields — no prototype / exotic junk. */
function clonePin(p: Pin): Pin {
  return { id: p.id, componentId: p.componentId, name: p.name, pos: { x: p.pos.x, y: p.pos.y } };
}

function clonePinsRecord(pins: Record<string, Pin>): Record<string, Pin> {
  const out: Record<string, Pin> = Object.create(null);
  for (const key in pins) {
    const p = pins[key];
    if (p) out[key] = clonePin(p);
  }
  return out;
}

/**
 * Fast structural clone for flatten. Prefer this over `structuredClone`:
 * for ~200k transistor-level components the latter dominates cold flatten
 * (copies far more than the simulator needs). RAM `.bytes` is aliased on
 * purpose — same contract the old structuredClone + re-point path had.
 */
function cloneComponent(c: Component): Component {
  const pos = { x: c.pos.x, y: c.pos.y };
  switch (c.kind) {
    case 'transistor':
      return {
        id: c.id,
        kind: 'transistor',
        type: c.type,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: {
          gate: clonePin(c.pins.gate),
          drain: clonePin(c.pins.drain),
          source: clonePin(c.pins.source),
        },
      };
    case 'source':
      return {
        id: c.id,
        kind: 'source',
        value: c.value,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { out: clonePin(c.pins.out) },
      };
    case 'input':
      return {
        id: c.id,
        kind: 'input',
        value: c.value,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { out: clonePin(c.pins.out) },
      };
    case 'button':
      return {
        id: c.id,
        kind: 'button',
        mode: c.mode,
        value: c.value,
        holdFrames: c.holdFrames,
        pulseFrames: c.pulseFrames,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { out: clonePin(c.pins.out) },
      };
    case 'switch':
      return {
        id: c.id,
        kind: 'switch',
        mode: c.mode,
        closed: c.closed,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { in: clonePin(c.pins.in), out: clonePin(c.pins.out) },
      };
    case 'led':
      return {
        id: c.id,
        kind: 'led',
        ...(c.label !== undefined ? { label: c.label } : {}),
        color: c.color,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { in: clonePin(c.pins.in) },
      };
    case 'sevenseg':
      return {
        id: c.id,
        kind: 'sevenseg',
        hasDp: c.hasDp,
        color: c.color,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins: clonePinsRecord(c.pins),
      };
    case 'clock':
      return {
        id: c.id,
        kind: 'clock',
        mode: c.mode,
        value: c.value,
        running: c.running,
        periodFrames: c.periodFrames,
        dutyFrames: c.dutyFrames,
        phase: c.phase,
        holdFrames: c.holdFrames,
        lastTrig: c.lastTrig,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { out: clonePin(c.pins.out), trig: clonePin(c.pins.trig) },
      };
    case 'analyzer': {
      const pins: Record<string, Pin> = {};
      for (const [name, p] of Object.entries(c.pins)) pins[name] = clonePin(p);
      return {
        id: c.id,
        kind: 'analyzer',
        channelCount: c.channelCount,
        armed: c.armed,
        ...(c.channelLabels ? { channelLabels: [...c.channelLabels] } : {}),
        triggerChannel: c.triggerChannel ?? null,
        triggerEdge: c.triggerEdge ?? 'rise',
        ...(c.lastSample ? { lastSample: [...c.lastSample] } : {}),
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins,
      };
    }
    case 'busprobe': {
      const pins: Record<string, Pin> = {};
      for (const [name, p] of Object.entries(c.pins)) pins[name] = clonePin(p);
      return {
        id: c.id,
        kind: 'busprobe',
        bitWidth: c.bitWidth,
        radix: c.radix,
        ...(c.label !== undefined ? { label: c.label } : {}),
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins,
      };
    }
    case 'busswitch': {
      const pins: Record<string, Pin> = {};
      for (const [name, p] of Object.entries(c.pins)) pins[name] = clonePin(p);
      return {
        id: c.id,
        kind: 'busswitch',
        mode: c.mode,
        bitWidth: c.bitWidth,
        value: c.value,
        radix: c.radix,
        ...(c.label !== undefined ? { label: c.label } : {}),
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins,
      };
    }
    case 'buspass': {
      const pins: Record<string, Pin> = {};
      for (const [name, p] of Object.entries(c.pins)) pins[name] = clonePin(p);
      return {
        id: c.id,
        kind: 'buspass',
        mode: c.mode,
        bitWidth: c.bitWidth,
        closed: c.closed,
        ...(c.label !== undefined ? { label: c.label } : {}),
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins,
      };
    }
    case 'tty':
      return {
        id: c.id,
        kind: 'tty',
        ramId: c.ramId,
        pos,
        pins: {},
      };
    case 'probe':
      return {
        id: c.id,
        kind: 'probe',
        ...(c.label !== undefined ? { label: c.label } : {}),
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pins: { in: clonePin(c.pins.in) },
      };
    case 'label':
      return { id: c.id, kind: 'label', name: c.name, pos, pins: { net: clonePin(c.pins.net) } };
    case 'junction':
      return { id: c.id, kind: 'junction', pos, pins: { net: clonePin(c.pins.net) } };
    case 'port':
      return {
        id: c.id,
        kind: 'port',
        name: c.name,
        dir: c.dir ?? 'inout',
        pos,
        pins: { io: clonePin(c.pins.io) },
      };
    case 'ram':
      // Alias `.bytes` — writes must survive the next flatten (see flattenLevel).
      return {
        id: c.id,
        kind: 'ram',
        addrBits: c.addrBits,
        dataBits: c.dataBits,
        bytes: c.bytes,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins: clonePinsRecord(c.pins),
      };
    case 'rom':
      return {
        id: c.id,
        kind: 'rom',
        addrBits: c.addrBits,
        dataBits: c.dataBits,
        bytes: c.bytes,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        pins: clonePinsRecord(c.pins),
      };
    case 'chip':
      return {
        id: c.id,
        kind: 'chip',
        defId: c.defId,
        pos,
        rotation: c.rotation,
        mirrorX: c.mirrorX,
        mirrorY: c.mirrorY,
        pinOrder: [...c.pinOrder],
        ...(c.pinSide ? { pinSide: { ...c.pinSide } } : {}),
        ...(c.boxWidth !== undefined ? { boxWidth: c.boxWidth } : {}),
        ...(c.marking !== undefined ? { marking: c.marking } : {}),
        ...(c.defRevision !== undefined ? { defRevision: c.defRevision } : {}),
        // Alias Soft Lab state like RAM `.bytes` so edges survive re-flatten.
        ...(c.softState ? { softState: c.softState } : {}),
        ...(c.softModel ? { softModel: c.softModel } : {}),
        pins: clonePinsRecord(c.pins),
      };
  }
}

/**
 * Apply an instance-path prefix to a FlatLevel that was expanded at `''`
 * (or any shorter prefix). Does not mutate `src` — the ChipDef cache holds
 * the template. Label names: non-global names get the prefix; VCC/GND stay.
 */
function rebaseFlat(src: FlatLevel, prefix: string): FlatLevel {
  if (!prefix) {
    // Protect the cache: callers must not share template object identity
    // with a live flatten result.
    return rebaseFlatCopy(src);
  }
  const components: Component[] = new Array(src.components.length);
  const templateToClone = new Map<Component, Component>();
  for (let i = 0; i < src.components.length; i++) {
    const c = src.components[i]!;
    const clone = cloneComponent(c);
    clone.id = prefix + c.id;
    if (clone.kind === 'label' && !GLOBAL_NET_NAMES.has(clone.name)) {
      clone.name = prefix + clone.name;
    }
    for (const p of Object.values(clone.pins as unknown as Record<string, Pin>)) {
      p.id = prefix + p.id;
      p.componentId = clone.id;
    }
    components[i] = clone;
    templateToClone.set(c, clone);
  }
  const wires = new Array<{ id: string; a: string; b: string }>(src.wires.length);
  for (let i = 0; i < src.wires.length; i++) {
    const w = src.wires[i]!;
    wires[i] = { id: prefix + w.id, a: prefix + w.a, b: prefix + w.b };
  }
  const liveValuePairs: LiveValuePair[] = new Array(src.liveValuePairs.length);
  for (let i = 0; i < src.liveValuePairs.length; i++) {
    const { original, clone: templateClone } = src.liveValuePairs[i]!;
    liveValuePairs[i] = {
      original,
      clone: templateToClone.get(templateClone) as
        | SourceComponent
        | InputComponent
        | ButtonComponent
        | ClockComponent,
    };
  }
  return { components, wires, liveValuePairs };
}

/** Deep-enough copy with no id renaming (cache isolation when prefix is ''). */
function rebaseFlatCopy(src: FlatLevel): FlatLevel {
  const components: Component[] = new Array(src.components.length);
  const templateToClone = new Map<Component, Component>();
  for (let i = 0; i < src.components.length; i++) {
    const c = src.components[i]!;
    const clone = cloneComponent(c);
    components[i] = clone;
    templateToClone.set(c, clone);
  }
  const wires = src.wires.map((w) => ({ id: w.id, a: w.a, b: w.b }));
  const liveValuePairs: LiveValuePair[] = src.liveValuePairs.map(({ original, clone: tc }) => ({
    original,
    clone: templateToClone.get(tc) as
      | SourceComponent
      | InputComponent
      | ButtonComponent
      | ClockComponent,
  }));
  return { components, wires, liveValuePairs };
}

/**
 * Expand one ChipDef instance at `prefix`.
 *
 * Warm path: rebase a cached fully-expanded template (prefix `''`) so
 * thousands of identical gate instances don't re-walk nested chips.
 *
 * Cold path: the first request for a given def expands directly at
 * `prefix` (one clone pass — important for a one-off folded Z80). The
 * second request builds and stores the `''` template, then rebases; later
 * requests only rebase.
 */
function flattenChipDef(def: ChipDef, library: ChipLibrary, prefix: string): FlatLevel {
  const version = currentStructureVersion();
  const softLab = isSoftLabEnabled();
  const hit = chipDefFlatCache.get(def.circuit);
  if (hit && hit.version === version && hit.softLab === softLab) {
    return rebaseFlat(hit.flat, prefix);
  }

  const prev = chipDefFlatRequestCount.get(def.circuit) ?? 0;
  const next = prev + 1;
  chipDefFlatRequestCount.set(def.circuit, next);

  if (next >= 2) {
    const template = flattenLevel(def.circuit, library, '');
    chipDefFlatCache.set(def.circuit, { version, softLab, flat: template });
    return rebaseFlat(template, prefix);
  }
  return flattenLevel(def.circuit, library, prefix);
}

function flattenLevel(circuit: Circuit, library: ChipLibrary, nsPrefix: string): FlatLevel {
  const idMap = new Map<string, string>(); // this level's original pin id -> namespaced pin id
  const outComponents: Component[] = [];
  const outWires: { id: string; a: string; b: string }[] = [];
  const outLiveValuePairs: LiveValuePair[] = [];

  for (const c of circuit.components.values()) {
    // Registered for every kind, chip instances included: sibling wires at
    // this level may target a chip instance's own (unexpanded) pins, and
    // those ids need the same namespacing as everything else here.
    for (const p of Object.values(c.pins) as Pin[]) idMap.set(p.id, nsPrefix + p.id);
  }

  for (const c of circuit.components.values()) {
    if (c.kind === 'chip') continue; // expanded in the loop below, not copied directly
    const clone = cloneComponent(c);
    // RAM `.bytes` is already aliased by cloneComponent. Writes during
    // step() must remain visible after the next flatten — see ARCHITECTURE.md
    // "Real RAM". StructuredClone used to copy the Uint8Array; we never do.
    // A Source's value is part of the netlist (it names the VCC/GND net), so editing one
    // bumps the structure version instead of being re-copied on every flatten.
    if (c.kind === 'input' || c.kind === 'button' || c.kind === 'clock' || c.kind === 'busswitch') {
      outLiveValuePairs.push({
        original: c,
        clone: clone as SourceComponent | InputComponent | ButtonComponent | ClockComponent | BusSwitchComponent,
      });
    }
    clone.id = nsPrefix + c.id;
    // Named ties (CLK, BUS0, …) would otherwise short across chip instances
    // after flatten — computeNets joins same-named labels. VCC/GND stay
    // global on purpose. Top-level (empty nsPrefix) keeps names as authored.
    if (clone.kind === 'label' && nsPrefix && !GLOBAL_NET_NAMES.has(clone.name)) {
      clone.name = `${nsPrefix}${clone.name}`;
    }
    for (const p of Object.values(clone.pins as unknown as Record<string, Pin>)) {
      p.id = idMap.get(p.id) ?? p.id;
      p.componentId = clone.id;
    }
    outComponents.push(clone);
  }

  for (const w of circuit.wires.values()) {
    outWires.push({ id: nsPrefix + w.id, a: idMap.get(w.a) ?? w.a, b: idMap.get(w.b) ?? w.b });
  }

  for (const c of circuit.components.values()) {
    if (c.kind !== 'chip') continue;
    const def = library.get(c.defId);
    const model = isSoftLabEnabled() ? softLabModelKey(def.name) : null;
    if (model && hasSoftLabModel(def.name) && !isSoftExpandForced(def.name)) {
      // Soft Lab: keep the instance opaque and evaluate in the solver.
      const clone = cloneComponent(c) as ChipInstanceComponent;
      clone.id = nsPrefix + c.id;
      for (const p of Object.values(clone.pins)) {
        p.id = idMap.get(p.id) ?? p.id;
        p.componentId = clone.id;
      }
      const state = ensureSoftState(c, model);
      clone.softState = state;
      clone.softModel = model;
      outComponents.push(clone);
      continue;
    }

    const child = flattenChipDef(def, library, `${nsPrefix}${c.id}/`);

    const portAlias = new Map<string, string>();
    for (const ic of child.components) {
      if (ic.kind !== 'port') continue;
      const externalPin = c.pins[ic.name];
      if (externalPin) portAlias.set(ic.pins.io.id, idMap.get(externalPin.id) ?? externalPin.id);
    }

    for (const ic of child.components) {
      if (ic.kind === 'port') continue; // boundary marker only, no electrical role
      outComponents.push(ic);
    }
    for (const w of child.wires) {
      outWires.push({ id: w.id, a: portAlias.get(w.a) ?? w.a, b: portAlias.get(w.b) ?? w.b });
    }
    // Keep ChipDef port pin ids on the same nets as the instance pins so dive
    // resolve(pathPrefix + port.io) paints diamonds with live levels (ports
    // themselves are stripped from the flat circuit above).
    for (const [portPinId, externalPinId] of portAlias) {
      if (portPinId === externalPinId) continue;
      outWires.push({
        id: `${nsPrefix}${c.id}/port-alias/${portPinId}`,
        a: portPinId,
        b: externalPinId,
      });
    }
    outLiveValuePairs.push(...child.liveValuePairs);
  }

  return { components: outComponents, wires: outWires, liveValuePairs: outLiveValuePairs };
}
