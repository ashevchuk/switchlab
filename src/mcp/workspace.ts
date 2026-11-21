import { ChipLibrary } from '../sim/ChipLibrary.js';
import type { ChipDef } from '../sim/ChipLibrary.js';
import { bumpStructureVersion, Circuit } from '../sim/Circuit.js';
import { flatten, foldExposing } from '../sim/hierarchy.js';
import { deserializeProject, resolveStdcellInstances, serializeSlimStdcells } from '../sim/serialize.js';
import {
  makeChipInstance,
  makeInput,
  makeProbe,
  makeSource,
  pinSidesFromDef,
} from '../sim/library.js';
import { initialState, step } from '../sim/solver.js';
import { layoutLayered } from './layout.js';
import { clearSoftLabStateDeep } from '../sim/softLab.js';
import { isStdcellName, seedStandardCells } from '../sim/stdcells.js';
import type { Component, Level, Pin, Point, SimState, Wire } from '../sim/types.js';

export const MAIN_SCOPE = 'main';
export const CANVAS_SCOPE = 'canvas';

const MIN_TICKS = 4;
const MAX_SETTLE_ROUNDS = 16;
const MAX_REPORTED_FAILURES = 5;
const MAX_TABLE_INPUT_BITS = 8;
const MAX_CLOCK_CYCLES = 64;
const MAX_SEQUENCE_STEPS = 64;
const GRID_COLUMNS = 10;
const GRID_PITCH = { x: 220, y: 180 };
const BUILTIN_TYPES = ['input', 'probe', 'vcc', 'gnd'] as const;

export class WorkspaceError extends Error {}

export interface ComponentSpec {
  name: string;
  type: string;
  /** Expands to `name0..name{count-1}` and registers `name` as a bus (bit 0 = LSB). */
  count?: number;
}

export interface BuildSpec {
  components?: ComponentSpec[];
  /** Each entry is [a, b, ...]: the first reference is wired to every other one. A bus on both sides pairs bit by bit; a single pin on one side fans out to every bit of a bus. */
  wires?: string[][];
}

export interface BuildResult {
  placed: string[];
  wired: number;
  warnings: string[];
}

export interface ChipPortSpec {
  name: string;
  dir: 'in' | 'out';
  /** Inner pin(s). Several pins on an input port are tied together. */
  pin: string | string[];
}

export type BusValue = { value: number | null; bits: string };
export type Reading = Level | BusValue;

export interface SimulateResult {
  outputs: Record<string, Reading>;
  warnings: string[];
}

export interface RemoveSpec {
  /** Component names, or bus names (removes the whole bus). */
  components?: string[];
  wires?: string[][];
}

export interface TraceResult {
  trace: Record<string, Reading>[];
  warnings: string[];
}

export interface TruthTable {
  rows: { in: Record<string, number>; out: Record<string, number | string> }[];
}

export interface ChipCase {
  in: Record<string, number>;
  out?: Record<string, number>;
}

export interface ChipTestResult {
  passed: number;
  total: number;
  failures: { case: number; in: Record<string, number>; expected: Record<string, number>; got: Record<string, Reading> }[];
  results?: Record<string, Reading>[];
}

export interface Description {
  components: { name: string; type: string; label?: string }[];
  buses: Record<string, string[]>;
  wires: [string, string][];
}

export interface LibraryEntry {
  name: string;
  ports: { name: string; dir: 'in' | 'out' }[];
  /** Present when the chip came from the user's canvas. */
  origin?: 'canvas';
  /** The canvas copy was edited after this chip was imported; delete_chip it and list_library again to re-import. */
  outOfDate?: true;
  /** A new version is being (or has been) built here and replaces the canvas chip on publish. */
  pendingReplace?: true;
}

/** What the canvas looked like when the sandbox copy was taken, to tell later what was edited. */
export interface CanvasBase {
  positions: Map<string, Point>;
  wires: Set<string>;
}

export interface CanvasDiff {
  base: CanvasBase;
  removedComponents: string[];
  addedComponents: Component[];
  moved: { id: string; dx: number; dy: number }[];
  removedWires: string[];
  addedWires: Wire[];
}

interface Scope {
  circuit: Circuit;
  byName: Map<string, Component>;
  buses: Map<string, string[]>;
  placedCount: number;
  state: SimState;
  /** Where the first new component goes; a sandbox copy of the canvas starts to the right of it. */
  origin: Point;
  canvasBase?: CanvasBase;
}

function newScope(): Scope {
  return { circuit: new Circuit(), byName: new Map(), buses: new Map(), placedCount: 0, state: initialState(), origin: { x: 0, y: 0 } };
}

function snapshotCanvas(circuit: Circuit): CanvasBase {
  return {
    positions: new Map([...circuit.components.values()].map((c) => [c.id, { x: c.pos.x, y: c.pos.y }])),
    wires: new Set(circuit.wires.keys()),
  };
}

function levelChar(level: Level): string {
  return level === 'Z' ? 'Z' : String(level);
}

function bitsToValue(levels: Level[]): BusValue {
  const bits = [...levels].reverse().map(levelChar).join('');
  const defined = levels.every((l) => l !== 'Z');
  const value = defined ? levels.reduce<number>((acc, l, i) => acc + (l === 1 ? 2 ** i : 0), 0) : null;
  return { value, bits };
}

/** Groups port names `a0..aN-1` (contiguous from 0, at least two) into buses. */
function portBuses(names: string[]): Map<string, string[]> {
  const byPrefix = new Map<string, Map<number, string>>();
  for (const name of names) {
    const m = /^(.*?)(\d+)$/.exec(name);
    if (!m || m[1] === '') continue;
    const bitsOfPrefix = byPrefix.get(m[1]!) ?? new Map<number, string>();
    bitsOfPrefix.set(Number(m[2]), name);
    byPrefix.set(m[1]!, bitsOfPrefix);
  }
  const buses = new Map<string, string[]>();
  for (const [prefix, bitsOfPrefix] of byPrefix) {
    if (bitsOfPrefix.size < 2) continue;
    const ordered: string[] = [];
    for (let i = 0; i < bitsOfPrefix.size; i++) {
      const bit = bitsOfPrefix.get(i);
      if (!bit) break;
      ordered.push(bit);
    }
    if (ordered.length === bitsOfPrefix.size) buses.set(prefix, ordered);
  }
  return buses;
}

function chipPortDirs(def: ChipDef): { name: string; dir: 'in' | 'out' }[] {
  const sides = pinSidesFromDef(def);
  return def.ports.map((name) => ({ name, dir: sides[name] === 1 ? 'out' : 'in' }));
}

/**
 * A sandbox of named circuits sharing one chip library. The model builds and
 * verifies here without touching the user's canvas; chips finished in a scope
 * become placeable in every other scope.
 */
export class Workspace {
  readonly library = new ChipLibrary();
  private readonly scopes = new Map<string, Scope>([[MAIN_SCOPE, newScope()]]);
  private readonly importedIds = new Set<string>();
  /** Canvas chips being rebuilt in place, by name, with the canvas revision they started from. */
  private readonly replacing = new Map<string, { id: string; baseRevision: number }>();

  /** `canvasLibrary` gives access to the chips on the user's canvas; they become usable here, under the same ids. */
  constructor(private readonly canvasLibrary?: () => ChipLibrary) {
    seedStandardCells(this.library);
  }

  scopeNames(): string[] {
    return [...this.scopes.keys()];
  }

  mainCircuit(): Circuit {
    return this.scope(MAIN_SCOPE).circuit;
  }

  /** Component id to the name the model gave it, for the inputs and probes of the main circuit. */
  mainIoNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const [name, comp] of this.scope(MAIN_SCOPE).byName) {
      if (comp.kind === 'input' || comp.kind === 'probe') names.set(comp.id, name);
    }
    return names;
  }

  listLibrary(): LibraryEntry[] {
    this.importCanvasChips();
    const live = this.canvasLibrary?.();
    return this.library.list().map((def) => {
      const entry: LibraryEntry = { name: def.name, ports: chipPortDirs(def) };
      if (this.importedIds.has(def.id)) entry.origin = 'canvas';
      if (this.replacing.get(def.name)?.id === def.id) entry.pendingReplace = true;
      else if (live?.has(def.id) && (live.get(def.id).revision ?? 0) !== (def.revision ?? 0)) entry.outOfDate = true;
      return entry;
    });
  }

  /**
   * Copies user chips from the canvas that this library lacks, keeping their ids so a
   * published circuit refers to the very same definitions. Chips already imported or
   * sharing a name with a workspace chip are left alone.
   */
  private importCanvasChips(): void {
    const live = this.canvasLibrary?.();
    if (!live) return;
    const missing = live
      .list()
      .filter((def) => !isStdcellName(def.name) && !this.library.has(def.id) && !this.library.findByName(def.name));
    if (missing.length === 0) return;
    const holder = new Circuit();
    for (const def of missing) makeChipInstance(holder, def);
    const bundle = deserializeProject(serializeSlimStdcells(holder, live));
    for (const def of bundle.library.list()) {
      if (this.library.has(def.id)) continue;
      this.library.register(def);
      this.importedIds.add(def.id);
    }
    resolveStdcellInstances(new Circuit(), this.library);
  }

  describe(scopeName: string): Description {
    const scope = this.scope(scopeName);
    const refOfPin = new Map<string, string>();
    const components: Description['components'] = [];
    for (const [name, comp] of scope.byName) {
      const pins = Object.values(comp.pins as Record<string, Pin>);
      for (const pin of pins) refOfPin.set(pin.id, pins.length === 1 ? name : `${name}.${pin.name}`);
      const type = comp.kind === 'chip' ? this.library.get(comp.defId).name : comp.kind === 'source' ? (comp.value === 1 ? 'vcc' : 'gnd') : comp.kind;
      const label = comp.kind === 'label' ? comp.name : (comp as { label?: string }).label;
      components.push(label ? { name, type, label } : { name, type });
    }
    const wires = [...scope.circuit.wires.values()].map((w): [string, string] => [refOfPin.get(w.a) ?? w.a, refOfPin.get(w.b) ?? w.b]);
    return { components, buses: Object.fromEntries(scope.buses), wires };
  }

  clear(scopeName = MAIN_SCOPE): void {
    if (this.scope(scopeName).canvasBase) {
      throw new WorkspaceError('the canvas scope mirrors the user\'s canvas: remove what you added, or call open_canvas again to start over from the current canvas');
    }
    this.scopes.set(scopeName, newScope());
  }

  /**
   * Copies the canvas into the `canvas` scope. Its components are addressed by their ids (see describe);
   * edits stay here until applied, and can be simulated like any other scope.
   */
  openCanvas(top: Circuit): { components: number; wires: number } {
    const live = this.canvasLibrary?.();
    if (!live) throw new WorkspaceError('no canvas is attached to this workspace');
    this.importCanvasChips();
    const copy = deserializeProject(serializeSlimStdcells(top, live));
    for (const def of copy.library.list()) {
      if (this.library.has(def.id)) continue;
      this.library.register(def);
      this.importedIds.add(def.id);
    }
    resolveStdcellInstances(copy.topCircuit, this.library);
    const scope = newScope();
    scope.circuit = copy.topCircuit;
    for (const comp of copy.topCircuit.components.values()) scope.byName.set(comp.id, comp);
    scope.canvasBase = snapshotCanvas(copy.topCircuit);
    const xs = [...copy.topCircuit.components.values()].map((c) => c.pos.x);
    const ys = [...copy.topCircuit.components.values()].map((c) => c.pos.y);
    if (xs.length > 0) scope.origin = { x: Math.max(...xs) + GRID_PITCH.x, y: Math.min(...ys) };
    this.scopes.set(CANVAS_SCOPE, scope);
    return { components: copy.topCircuit.components.size, wires: copy.topCircuit.wires.size };
  }

  /** What was added, removed and moved in the canvas scope since it was opened or last applied. */
  canvasDiff(): CanvasDiff {
    const scope = this.scopes.get(CANVAS_SCOPE);
    const base = scope?.canvasBase;
    if (!scope || !base) throw new WorkspaceError('call open_canvas first');
    const circuit = scope.circuit;
    const moved: CanvasDiff['moved'] = [];
    for (const comp of circuit.components.values()) {
      const was = base.positions.get(comp.id);
      if (was && (was.x !== comp.pos.x || was.y !== comp.pos.y)) moved.push({ id: comp.id, dx: comp.pos.x - was.x, dy: comp.pos.y - was.y });
    }
    return {
      base,
      removedComponents: [...base.positions.keys()].filter((id) => !circuit.components.has(id)),
      addedComponents: [...circuit.components.values()].filter((c) => !base.positions.has(c.id)),
      moved,
      removedWires: [...base.wires].filter((id) => !circuit.wires.has(id)),
      addedWires: [...circuit.wires.values()].filter((w) => !base.wires.has(w.id)),
    };
  }

  /** The canvas now matches the canvas scope: later edits are measured from here. */
  acceptCanvasApplied(): void {
    const scope = this.scope(CANVAS_SCOPE);
    scope.canvasBase = snapshotCanvas(scope.circuit);
  }

  move(scopeName: string, names: string[], dx: number, dy: number): { moved: number } {
    const scope = this.scope(scopeName);
    const comps = names.map((name) => {
      const comp = scope.byName.get(name);
      if (!comp) throw new WorkspaceError(`unknown component "${name}". Known: ${[...scope.byName.keys()].join(', ')}`);
      return comp;
    });
    comps.forEach((comp) => scope.circuit.moveComponent(comp.id, dx, dy));
    return { moved: comps.length };
  }

  build(scopeName: string, spec: BuildSpec): BuildResult {
    this.importCanvasChips();
    const scope = this.scope(scopeName);
    const addedComponents: string[] = [];
    const addedWires: string[] = [];
    const addedBuses: string[] = [];
    try {
      scope.circuit.beginBatch();
      for (const comp of spec.components ?? []) {
        addedBuses.push(...this.placeSpec(scope, comp, addedComponents));
      }
      for (const refs of spec.wires ?? []) {
        for (const [a, b] of this.pinPairs(scope, refs)) addedWires.push(scope.circuit.addWire(a.id, b.id).id);
      }
    } catch (e) {
      for (const id of addedWires) scope.circuit.removeWire(id);
      for (const name of addedComponents) {
        const comp = scope.byName.get(name);
        if (comp) scope.circuit.removeComponent(comp.id);
        scope.byName.delete(name);
      }
      for (const bus of addedBuses) scope.buses.delete(bus);
      throw e;
    } finally {
      scope.circuit.endBatch();
    }
    const onlyNew = scope.canvasBase ? new Set(addedComponents) : undefined;
    return { placed: addedComponents, wired: addedWires.length, warnings: this.unwiredChipPins(scope, onlyNew) };
  }

  simulate(scopeName: string, inputs: Record<string, number> = {}): SimulateResult {
    const scope = this.scope(scopeName);
    const { levels, warnings } = this.readProbes(scope, inputs);
    return { outputs: this.formatReadings(scope, levels), warnings };
  }

  simulateSequence(scopeName: string, steps: Record<string, number>[]): TraceResult {
    const scope = this.scope(scopeName);
    if (steps.length === 0 || steps.length > MAX_SEQUENCE_STEPS) {
      throw new WorkspaceError(`sequence needs 1..${MAX_SEQUENCE_STEPS} steps`);
    }
    const warnings = new Set<string>();
    const trace = steps.map((inputs) => {
      const read = this.readProbes(scope, inputs);
      read.warnings.forEach((w) => warnings.add(w));
      return this.formatReadings(scope, read.levels);
    });
    return { trace, warnings: [...warnings] };
  }

  /** Raises then lowers `clock` `cycles` times, reading every probe after each full cycle. */
  simulateClock(scopeName: string, clock: string, cycles: number, inputs: Record<string, number> = {}): TraceResult {
    const scope = this.scope(scopeName);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > MAX_CLOCK_CYCLES) {
      throw new WorkspaceError(`cycles must be an integer 1..${MAX_CLOCK_CYCLES}`);
    }
    if (scope.byName.get(clock)?.kind !== 'input') throw new WorkspaceError(`"${clock}" is not an input`);
    this.readProbes(scope, { ...inputs, [clock]: 0 });
    const warnings = new Set<string>();
    const trace: Record<string, Reading>[] = [];
    for (let i = 0; i < cycles; i++) {
      this.readProbes(scope, { [clock]: 1 });
      const read = this.readProbes(scope, { [clock]: 0 });
      read.warnings.forEach((w) => warnings.add(w));
      trace.push(this.formatReadings(scope, read.levels));
    }
    return { trace, warnings: [...warnings] };
  }

  /** Forgets all sequential state, as if the circuit had just been powered on. */
  powerCycle(scopeName: string): void {
    const scope = this.scope(scopeName);
    scope.state = initialState();
    clearSoftLabStateDeep(scope.circuit, this.library);
    bumpStructureVersion();
  }

  remove(scopeName: string, spec: RemoveSpec): { removedComponents: number; removedWires: number } {
    const scope = this.scope(scopeName);
    const wireIds = new Set<string>();
    for (const refs of spec.wires ?? []) {
      for (const [a, b] of this.pinPairs(scope, refs)) {
        const found = [...scope.circuit.wires.values()].find(
          (w) => (w.a === a.id && w.b === b.id) || (w.a === b.id && w.b === a.id),
        );
        if (!found) throw new WorkspaceError(`no wire between ${a.id} and ${b.id}`);
        wireIds.add(found.id);
      }
    }
    const componentNames = new Set<string>();
    for (const name of spec.components ?? []) {
      const members = scope.buses.get(name);
      if (members && !scope.byName.has(name)) members.forEach((m) => componentNames.add(m));
      else if (scope.byName.has(name)) componentNames.add(name);
      else throw new WorkspaceError(`unknown component "${name}". Known: ${[...scope.byName.keys()].join(', ')}`);
    }
    const wiresBefore = scope.circuit.wires.size;
    wireIds.forEach((id) => scope.circuit.removeWire(id));
    for (const name of componentNames) {
      scope.circuit.removeComponent(scope.byName.get(name)!.id);
      scope.byName.delete(name);
    }
    for (const [bus, members] of [...scope.buses]) {
      if (members.some((m) => componentNames.has(m))) scope.buses.delete(bus);
    }
    return { removedComponents: componentNames.size, removedWires: wiresBefore - scope.circuit.wires.size };
  }

  deleteChip(name: string): void {
    const def = this.library.findByName(name);
    if (!def) throw new WorkspaceError(`unknown chip: ${name}`);
    if (isStdcellName(name)) throw new WorkspaceError(`${name} is a built-in cell and cannot be deleted`);
    const circuits = [...[...this.scopes.values()].map((sc) => sc.circuit), ...this.library.list().map((d) => d.circuit)];
    const user = circuits.some((c) => [...c.components.values()].some((comp) => comp.kind === 'chip' && comp.defId === def.id));
    if (user) throw new WorkspaceError(`${name} is still placed somewhere; remove those instances first`);
    this.library.remove(def.id);
  }

  /**
   * Starts a chip. With `replace`, the chip is a new version of one that already lives on the canvas:
   * finish_chip then keeps its ports and swaps its contents, and publishing updates the canvas chip in place.
   */
  beginChip(name: string, replace = false): void {
    this.importCanvasChips();
    if (this.scopes.has(name)) throw new WorkspaceError(`name already in use: ${name}`);
    const existing = this.library.findByName(name);
    if (!replace) {
      if (existing) throw new WorkspaceError(`name already in use: ${name}. To rebuild the canvas chip of that name, pass replace: true.`);
    } else {
      if (!existing || !this.canvasLibrary?.().has(existing.id)) throw new WorkspaceError(`no chip named ${name} on the canvas to replace`);
      if (!this.replacing.has(name)) this.replacing.set(name, { id: existing.id, baseRevision: existing.revision ?? 0 });
    }
    this.scopes.set(name, newScope());
  }

  /** The finished replacement for a canvas chip, for publishing. */
  replacementOf(name: string): { name: string; def: ChipDef; baseRevision: number } {
    const entry = this.replacing.get(name);
    if (!entry) throw new WorkspaceError(`${name} was not started with begin_chip replace: true`);
    if (this.scopes.has(name)) throw new WorkspaceError(`${name} is not finished: call finish_chip first`);
    return { name, def: this.library.get(entry.id), baseRevision: entry.baseRevision };
  }

  markReplaced(names: string[]): void {
    names.forEach((name) => this.replacing.delete(name));
  }

  finishChip(scopeName: string, ports: ChipPortSpec[]): LibraryEntry {
    if (scopeName === MAIN_SCOPE) throw new WorkspaceError('main is not a chip scope; use begin_chip first');
    const scope = this.scope(scopeName);
    if (ports.length === 0) throw new WorkspaceError('a chip needs at least one port');
    const replacing = this.replacing.get(scopeName);
    if (replacing) return this.finishReplacement(scopeName, scope, ports, replacing.id);
    const exposed = this.resolveChipPorts(scope, ports);
    layoutLayered(scope.circuit);
    const def = foldExposing(scope.circuit, scopeName, this.library, exposed);
    this.scopes.delete(scopeName);
    return { name: def.name, ports: chipPortDirs(def) };
  }

  /** Swaps the contents of the existing chip definition, as dive-in editing does: every instance and dependent chip follows. */
  private finishReplacement(scopeName: string, scope: Scope, ports: ChipPortSpec[], id: string): LibraryEntry {
    const current = this.library.get(id);
    const want = chipPortDirs(current).map((p) => `${p.name}:${p.dir}`);
    const got = ports.map((p) => `${p.name}:${p.dir}`);
    if (want.join(',') !== got.join(',')) {
      throw new WorkspaceError(`a replacement must keep the chip's ports, in order. Expected: ${want.join(', ')}. Got: ${got.join(', ')}`);
    }
    const exposed = this.resolveChipPorts(scope, ports);
    layoutLayered(scope.circuit);
    const built = foldExposing(scope.circuit, scopeName, this.library, exposed);
    this.library.remove(built.id);
    current.circuit = built.circuit;
    current.revision = (current.revision ?? 0) + 1;
    this.library.register(current);
    this.scopes.delete(scopeName);
    return { name: current.name, ports: chipPortDirs(current) };
  }

  testChip(chipName: string, cases: ChipCase[]): ChipTestResult {
    this.importCanvasChips();
    const def = this.library.findByName(chipName);
    if (!def) throw new WorkspaceError(`unknown chip: ${chipName}`);
    const { scope, ports } = this.harness(def);
    const dirOf = new Map(ports.map((p) => [p.name, p.dir]));
    const result: ChipTestResult = { passed: 0, total: cases.length, failures: [] };
    const reportOnly = cases.every((c) => c.out === undefined);
    if (reportOnly) result.results = [];
    cases.forEach((c, index) => {
      for (const key of Object.keys(c.in)) {
        const members = scope.buses.get(key) ?? [key];
        if (members.some((m) => dirOf.get(m) !== 'in')) {
          throw new WorkspaceError(`"${key}" is not an input of ${chipName}`);
        }
      }
      const { levels } = this.readProbes(scope, c.in);
      const got = this.formatReadings(scope, levels);
      if (c.out === undefined) {
        result.results?.push(got);
        return;
      }
      const matches = Object.entries(c.out).every(([key, want]) => {
        const members = scope.buses.get(key) ?? [key];
        const missing = members.find((m) => !levels.has(m));
        if (missing) throw new WorkspaceError(`"${key}" is not an output of ${chipName}`);
        return bitsToValue(members.map((m) => levels.get(m)!)).value === want;
      });
      if (matches) result.passed += 1;
      else result.failures.push({ case: index, in: c.in, expected: c.out, got });
    });
    result.failures = result.failures.slice(0, MAX_REPORTED_FAILURES);
    return result;
  }

  /** A scratch scope holding one instance of `def` wired to an input or probe per port. */
  private harness(def: ChipDef): { scope: Scope; ports: { name: string; dir: 'in' | 'out' }[] } {
    const ports = chipPortDirs(def);
    const scope = newScope();
    const inst = makeChipInstance(scope.circuit, def, { x: 0, y: 0 });
    for (const port of ports) {
      const comp = port.dir === 'in' ? makeInput(scope.circuit, 0) : makeProbe(scope.circuit);
      scope.byName.set(port.name, comp);
      const [compPin] = Object.values(comp.pins as Record<string, Pin>);
      scope.circuit.addWire(compPin!.id, inst.pins[port.name]!.id);
    }
    for (const [prefix, members] of portBuses(ports.map((p) => p.name))) {
      scope.buses.set(prefix, members);
    }
    return { scope, ports };
  }

  /** Every input combination of a combinational chip (at most 8 input bits). */
  truthTable(chipName: string): TruthTable {
    this.importCanvasChips();
    const def = this.library.findByName(chipName);
    if (!def) throw new WorkspaceError(`unknown chip: ${chipName}`);
    const { scope, ports } = this.harness(def);
    const inputNames = ports.filter((p) => p.dir === 'in').map((p) => p.name);
    const busOf = new Map<string, string>();
    for (const [bus, members] of scope.buses) {
      if (members.every((m) => inputNames.includes(m))) members.forEach((m) => busOf.set(m, bus));
    }
    const units = new Map<string, number>();
    for (const name of inputNames) {
      const unit = busOf.get(name) ?? name;
      units.set(unit, (units.get(unit) ?? 0) + 1);
    }
    const totalBits = [...units.values()].reduce((a, b) => a + b, 0);
    if (totalBits > MAX_TABLE_INPUT_BITS) {
      throw new WorkspaceError(`${chipName} has ${totalBits} input bits (max ${MAX_TABLE_INPUT_BITS}); use test_chip with chosen cases`);
    }
    const rows: TruthTable['rows'] = [];
    for (let n = 0; n < 2 ** totalBits; n++) {
      let rest = n;
      const inputs: Record<string, number> = {};
      for (const [unit, bits] of units) {
        inputs[unit] = rest % 2 ** bits;
        rest = Math.floor(rest / 2 ** bits);
      }
      const { levels } = this.readProbes(scope, inputs);
      const out: Record<string, number | string> = {};
      for (const [name, reading] of Object.entries(this.formatReadings(scope, levels))) {
        out[name] = typeof reading === 'object' ? (reading.value ?? reading.bits) : reading;
      }
      rows.push({ in: inputs, out });
    }
    return { rows };
  }

  private formatReadings(scope: Scope, levels: Map<string, Level>): Record<string, Reading> {
    const outputs: Record<string, Reading> = {};
    const inBus = new Set<string>();
    for (const [bus, members] of scope.buses) {
      if (!members.every((m) => levels.has(m))) continue;
      members.forEach((m) => inBus.add(m));
      outputs[bus] = bitsToValue(members.map((m) => levels.get(m)!));
    }
    for (const [name, level] of levels) {
      if (!inBus.has(name)) outputs[name] = level;
    }
    return outputs;
  }

  private readProbes(scope: Scope, inputs: Record<string, number>): { levels: Map<string, Level>; warnings: string[] } {
    this.applyInputs(scope, inputs);
    const flat = flatten(scope.circuit, this.library);
    const netMap = flat.computeNets();
    let state = scope.state;
    for (let round = 0; round < MAX_SETTLE_ROUNDS && (round < MIN_TICKS || !state.settled); round++) {
      state = step(flat, netMap, state);
    }
    scope.state = state;
    if (!state.settled) {
      throw new WorkspaceError('circuit did not settle: it oscillates or has a combinational feedback loop');
    }
    const levels = new Map<string, Level>();
    const warnings: string[] = [];
    for (const [name, comp] of scope.byName) {
      if (comp.kind !== 'probe' && comp.kind !== 'led') continue;
      const net = netMap.netOf.get(comp.pins.in.id);
      if (net !== undefined && state.contended.has(net)) warnings.push(`contention on net of ${name}`);
      levels.set(name, net === undefined ? 'Z' : (state.levelOf.get(net) ?? 'Z'));
    }
    return { levels, warnings };
  }

  private scope(name: string): Scope {
    const scope = this.scopes.get(name);
    if (!scope) throw new WorkspaceError(`unknown scope: ${name}. Known: ${this.scopeNames().join(', ')}`);
    return scope;
  }

  private nextPosition(scope: Scope): Point {
    const n = scope.placedCount++;
    return { x: scope.origin.x + (n % GRID_COLUMNS) * GRID_PITCH.x, y: scope.origin.y + Math.floor(n / GRID_COLUMNS) * GRID_PITCH.y };
  }

  private placeSpec(scope: Scope, spec: ComponentSpec, placedNames: string[]): string[] {
    if (spec.count === undefined) {
      this.placeOne(scope, spec.name, spec.type);
      placedNames.push(spec.name);
      return [];
    }
    if (!Number.isInteger(spec.count) || spec.count < 1) {
      throw new WorkspaceError(`count of ${spec.name} must be a positive integer`);
    }
    if (scope.buses.has(spec.name)) throw new WorkspaceError(`name already in use: ${spec.name}`);
    const members: string[] = [];
    for (let i = 0; i < spec.count; i++) {
      const member = `${spec.name}${i}`;
      this.placeOne(scope, member, spec.type);
      placedNames.push(member);
      members.push(member);
    }
    scope.buses.set(spec.name, members);
    return [spec.name];
  }

  private placeOne(scope: Scope, name: string, type: string): void {
    if (!name || name.includes('.')) throw new WorkspaceError(`invalid component name: "${name}"`);
    if (scope.byName.has(name) || scope.buses.has(name)) throw new WorkspaceError(`name already in use: ${name}`);
    const pos = this.nextPosition(scope);
    let comp: Component;
    switch (type) {
      case 'input': comp = makeInput(scope.circuit, 0, pos); break;
      case 'probe': comp = makeProbe(scope.circuit, pos, name); break;
      case 'vcc': comp = makeSource(scope.circuit, 1, pos); break;
      case 'gnd': comp = makeSource(scope.circuit, 0, pos); break;
      default: {
        const def = this.library.findByName(type);
        if (!def) {
          const chips = this.library.list().map((d) => d.name).join(', ');
          throw new WorkspaceError(
            `unknown type "${type}". Built-in: ${BUILTIN_TYPES.join(', ')}. Chips: ${chips}`,
          );
        }
        comp = makeChipInstance(scope.circuit, def, pos);
      }
    }
    scope.byName.set(name, comp);
  }

  private expandRef(scope: Scope, ref: string): Pin[] & { isBus?: boolean } {
    const dot = ref.indexOf('.');
    const asBus = (pins: Pin[]) => Object.assign(pins, { isBus: true });
    if (dot < 0) {
      const members = scope.buses.get(ref);
      if (members && !scope.byName.has(ref)) return asBus(members.map((m) => this.resolvePin(scope, m)));
      return [this.resolvePin(scope, ref)];
    }
    const comp = scope.byName.get(ref.slice(0, dot));
    const pinName = ref.slice(dot + 1);
    if (comp?.kind === 'chip' && !(pinName in comp.pins)) {
      const members = portBuses(Object.keys(comp.pins)).get(pinName);
      if (members) return asBus(members.map((m) => (comp.pins as Record<string, Pin>)[m]!));
    }
    return [this.resolvePin(scope, ref)];
  }

  private pairUp(refA: string, a: Pin[] & { isBus?: boolean }, b: Pin[] & { isBus?: boolean }, refB: string): [Pin, Pin][] {
    if (a.isBus && b.isBus) {
      if (a.length !== b.length) {
        throw new WorkspaceError(`bus widths differ: ${refA} has ${a.length} bits, ${refB} has ${b.length}`);
      }
      return a.map((pin, i): [Pin, Pin] => [pin, b[i]!]);
    }
    if (a.isBus) return a.map((pin): [Pin, Pin] => [pin, b[0]!]);
    if (b.isBus) return b.map((pin): [Pin, Pin] => [a[0]!, pin]);
    return [[a[0]!, b[0]!]];
  }

  private pinPairs(scope: Scope, refs: string[]): [Pin, Pin][] {
    if (refs.length < 2) throw new WorkspaceError(`a wire needs at least two pin references, got ${JSON.stringify(refs)}`);
    const first = this.expandRef(scope, refs[0]!);
    return refs.slice(1).flatMap((ref) => this.pairUp(refs[0]!, first, this.expandRef(scope, ref), ref));
  }

  private resolvePin(scope: Scope, ref: string): Pin {
    const dot = ref.indexOf('.');
    const compName = dot < 0 ? ref : ref.slice(0, dot);
    const comp = scope.byName.get(compName);
    if (!comp) {
      throw new WorkspaceError(`unknown component "${compName}" in "${ref}". Known: ${[...scope.byName.keys()].join(', ')}`);
    }
    const pins = comp.pins as Record<string, Pin>;
    const names = Object.keys(pins);
    if (dot < 0) {
      if (names.length === 1) return pins[names[0]!]!;
      throw new WorkspaceError(`"${ref}" needs a pin: ${names.map((n) => `${ref}.${n}`).join(', ')}`);
    }
    const pin = pins[ref.slice(dot + 1)];
    if (!pin) {
      throw new WorkspaceError(`no pin "${ref.slice(dot + 1)}" on ${compName}. Pins: ${names.join(', ')}`);
    }
    return pin;
  }

  private applyInputs(scope: Scope, inputs: Record<string, number>): void {
    const setBit = (name: string, bit: 0 | 1) => {
      const comp = scope.byName.get(name);
      if (!comp || comp.kind !== 'input') throw new WorkspaceError(`"${name}" is not an input`);
      comp.value = bit;
    };
    for (const [key, value] of Object.entries(inputs)) {
      const members = scope.buses.get(key);
      if (!members) {
        if (value !== 0 && value !== 1) throw new WorkspaceError(`input "${key}" takes 0 or 1`);
        setBit(key, value);
        continue;
      }
      if (!Number.isInteger(value) || value < 0 || value >= 2 ** members.length) {
        throw new WorkspaceError(`bus "${key}" takes an integer 0..${2 ** members.length - 1}`);
      }
      members.forEach((m, i) => setBit(m, Math.floor(value / 2 ** i) % 2 === 1 ? 1 : 0));
    }
  }

  private unwiredChipPins(scope: Scope, only?: Set<string>): string[] {
    const wired = new Set<string>();
    for (const w of scope.circuit.wires.values()) {
      wired.add(w.a);
      wired.add(w.b);
    }
    const warnings: string[] = [];
    for (const [name, comp] of scope.byName) {
      if (only && !only.has(name)) continue;
      if (comp.kind !== 'chip' && comp.kind !== 'probe') continue;
      for (const pin of Object.values(comp.pins as Record<string, Pin>)) {
        if (!wired.has(pin.id)) warnings.push(`${comp.kind === 'chip' ? `${name}.${pin.name}` : name} is not connected`);
      }
    }
    return warnings;
  }

  private resolveChipPorts(scope: Scope, ports: ChipPortSpec[]): { pin: Pin; isOutput: boolean; portName: string }[] {
    const seen = new Set<string>();
    const exposed: { pin: Pin; isOutput: boolean; portName: string }[] = [];
    const ties: [Pin, Pin][] = [];
    for (const port of ports) {
      if (seen.has(port.name)) throw new WorkspaceError(`duplicate port name: ${port.name}`);
      seen.add(port.name);
      const refs = Array.isArray(port.pin) ? port.pin : [port.pin];
      if (refs.length === 0) throw new WorkspaceError(`port ${port.name} has no pin`);
      if (port.dir === 'out' && refs.length > 1) {
        throw new WorkspaceError(`output port ${port.name} must expose exactly one pin`);
      }
      const pins = refs.map((r) => this.resolvePin(scope, r));
      for (const extra of pins.slice(1)) ties.push([pins[0]!, extra]);
      exposed.push({ pin: pins[0]!, isOutput: port.dir === 'out', portName: port.name });
    }
    for (const [first, extra] of ties) scope.circuit.addWire(first.id, extra.id);
    return exposed;
  }
}
