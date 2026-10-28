import type { ChipLibrary } from './ChipLibrary.js';
import type { Circuit } from './Circuit.js';
import { buildMinimalCpu, type CpuBlocks } from './blocks.js';
import { fold, relayoutCmosPrimitivePorts, renamePort } from './hierarchy.js';
import { tidyLibraryCircuit } from './labelWires.js';
import { buildNot, CHIP_INSTANCE_WIDTH, makePort, makeSource, ramAddrPins, ramDataPins, wire } from './library.js';
import type { ChipInstanceComponent, Component, Pin, PortDir, Point, RamComponent } from './types.js';

const TINY_CPU_NAME = 'TinyCPU';

export interface PlacedTinyCpu {
  chip: ChipInstanceComponent;
  ram: RamComponent;
}

const OUTPUT_PIN_KEYS = new Set(['q', 'out', 'cout', 'phase']);
const BLOCK_COLUMNS = 4;
const BLOCK_PITCH = { x: CHIP_INSTANCE_WIDTH + 200, y: 600 };
const SUB_BLOCK_PREFIX = 'Tiny';
// Dive-in opens at the origin and the canvas cannot scroll to negative coordinates.
const DIVE_IN_ORIGIN: Point = { x: 300, y: 120 };

function addedSince(circuit: Circuit, before: ReadonlySet<string>): Set<string> {
  return new Set([...circuit.components.keys()].filter((id) => !before.has(id)));
}

function isRailNet(circuit: Circuit, pin: Pin): boolean {
  const net = circuit.computeNets().netOf.get(pin.id);
  return net === 'VCC' || net === 'GND';
}

function foldBlock(parent: Circuit, library: ChipLibrary, name: string, ids: Set<string>, pins: Record<string, Pin | Pin[]>, at: Point) {
  const selection = new Set(ids);
  for (const [key, value] of Object.entries(pins)) {
    const dir: PortDir = OUTPUT_PIN_KEYS.has(key) ? 'out' : 'in';
    const named = Array.isArray(value) ? value.map((pin, i) => [`${key}${i}`, pin] as const) : ([[key, value]] as const);
    for (const [portName, pin] of named) {
      if (isRailNet(parent, pin)) continue;
      const port = makePort(parent, portName, { x: at.x - 40, y: at.y }, dir);
      wire(parent, port.pins.io, pin);
      selection.add(port.id);
    }
  }
  return fold(parent, selection, SUB_BLOCK_PREFIX + name, library, at);
}

function shiftCircuit(circuit: Circuit, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const c of circuit.components.values()) circuit.moveComponent(c.id, dx, dy);
  for (const w of circuit.wires.values()) {
    if (w.waypoints) w.waypoints = w.waypoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}

/**
 * Slide a folded chip's internals to the origin so dive-in finds them on
 * screen. Only chips and transistors define the extent: fold() parks its local
 * rail sources at (0, 0), which would otherwise anchor the minimum there.
 */
function moveInternalsToOrigin(circuit: Circuit): void {
  const anchors = [...circuit.components.values()].filter((c) => c.kind === 'chip' || c.kind === 'transistor');
  if (anchors.length === 0) return;
  shiftCircuit(circuit, DIVE_IN_ORIGIN.x - Math.min(...anchors.map((c) => c.pos.x)), DIVE_IN_ORIGIN.y - Math.min(...anchors.map((c) => c.pos.y)));
  for (const c of circuit.components.values()) {
    if (c.kind === 'source') circuit.moveComponent(c.id, DIVE_IN_ORIGIN.x - 80 - c.pos.x, DIVE_IN_ORIGIN.y - 40 - c.pos.y);
  }
}

/** Port columns can extend above the schematic; the canvas cannot scroll to negative coordinates. */
function keepOnCanvas(circuit: Circuit): void {
  const comps = [...circuit.components.values()];
  if (comps.length === 0) return;
  const margin = 60;
  shiftCircuit(circuit, Math.max(0, margin - Math.min(...comps.map((c) => c.pos.x))), Math.max(0, margin - Math.min(...comps.map((c) => c.pos.y))));
}

/** Name an anonymous port after the chip pin or port it is wired to outside. */
function nameFromNeighbour(parent: Circuit, library: ChipLibrary, folded: ReturnType<typeof fold>): void {
  const ownerOf = new Map<string, Component>();
  for (const c of parent.components.values()) {
    for (const p of Object.values(c.pins) as Pin[]) ownerOf.set(p.id, c);
  }
  for (const portName of [...folded.def.ports]) {
    if (!/^p\d+$/.test(portName)) continue;
    const pinId = folded.instance.pins[portName]!.id;
    for (const w of parent.wires.values()) {
      if (w.a !== pinId && w.b !== pinId) continue;
      const other = ownerOf.get(w.a === pinId ? w.b : w.a);
      const otherPin = other && (Object.values(other.pins) as Pin[]).find((p) => p.id === (w.a === pinId ? w.b : w.a));
      if (!other || !otherPin) continue;
      const base = other.kind === 'chip' ? `${library.get(other.defId).name.replace(SUB_BLOCK_PREFIX, '')}_${otherPin.name}` : other.kind === 'port' ? other.name : other.kind === 'ram' ? otherPin.name.toUpperCase() : undefined;
      if (base !== undefined && renamePort(library, [parent], folded.def.id, portName, base)) break;
    }
  }
}

/**
 * Builds `buildMinimalCpu`, then folds it into one `TinyCPU` chip whose
 * internals are named sub-chips (PC, IR, ACC, ALU, FSM, OUT, Control).
 * The chip exposes CLK, RESET, OUT0-7 and the RAM bus (ADDR/DATA/WE/OE);
 * the RAM stays outside because a folded RAM would be shared by every instance.
 *
 * The second FSM clock is the inverse of CLK, and RESET also seeds the FSM
 * into FETCH, so a single pulse generator and a reset button run the CPU.
 */
export function placeTinyCpu(
  parent: Circuit,
  library: ChipLibrary,
  addrBits: number,
  program: Uint8Array | undefined,
  pos: Point = { x: 0, y: 0 },
): PlacedTinyCpu {
  const before = new Set(parent.components.keys());
  const blocks: CpuBlocks = new Map();
  const cpu = buildMinimalCpu(parent, library, addrBits, program, pos, blocks);
  const built = addedSince(parent, before);
  built.delete(cpu.ram.id);
  const controlIds = new Set(built);
  for (const block of blocks.values()) for (const id of block.ids) controlIds.delete(id);

  const phaseInverter = buildNot(parent, { x: pos.x - 200, y: pos.y - 200 });
  wire(parent, cpu.clk, phaseInverter.in);
  wire(parent, phaseInverter.out, cpu.phaseClk);
  wire(parent, cpu.reset, cpu.fsmLoad);
  wire(parent, makeSource(parent, 1, { x: pos.x - 200, y: pos.y - 120 }).pins.out, cpu.fsmD[0]!);
  wire(parent, makeSource(parent, 0, { x: pos.x - 200, y: pos.y - 80 }).pins.out, cpu.fsmD[1]!);
  wire(parent, makeSource(parent, 0, { x: pos.x - 200, y: pos.y - 40 }).pins.out, cpu.fsmD[2]!);

  const exposed: [string, PortDir, Pin][] = [
    ['CLK', 'in', cpu.clk],
    ['RESET', 'in', cpu.reset],
    ...cpu.pc.map((pin, i): [string, PortDir, Pin] => [`PC${i}`, 'out', pin]),
    ...cpu.out.map((pin, i): [string, PortDir, Pin] => [`OUT${i}`, 'out', pin]),
    ...ramAddrPins(cpu.ram).map((pin, i): [string, PortDir, Pin] => [`ADDR${i}`, 'out', pin]),
    // 'out' only for the pin side: inout ports sit on the left, away from the RAM.
    ...ramDataPins(cpu.ram).map((pin, i): [string, PortDir, Pin] => [`DATA${i}`, 'out', pin]),
    ['WE', 'out', cpu.ram.pins.we!],
    ['OE', 'out', cpu.ram.pins.oe!],
  ];
  exposed.forEach(([name, dir, pin], i) => {
    const port = makePort(parent, name, { x: pos.x - 400, y: pos.y + i * 40 }, dir);
    wire(parent, port.pins.io, pin);
  });

  const names = [...blocks.keys()];
  const slot = (index: number): Point => ({
    x: pos.x + (index % BLOCK_COLUMNS) * BLOCK_PITCH.x,
    y: pos.y + Math.floor(index / BLOCK_COLUMNS) * BLOCK_PITCH.y,
  });
  const folded = names.map((name, i) => foldBlock(parent, library, name, blocks.get(name)!.ids, blocks.get(name)!.pins, slot(i)));

  const control = fold(parent, controlIds, `${SUB_BLOCK_PREFIX}Control`, library, slot(names.length));
  nameFromNeighbour(parent, library, control);

  const topIds = addedSince(parent, before);
  topIds.delete(cpu.ram.id);
  const top = fold(parent, topIds, TINY_CPU_NAME, library, pos);

  for (const { def } of [...folded, control, top]) {
    moveInternalsToOrigin(def.circuit);
    relayoutCmosPrimitivePorts(def);
    tidyLibraryCircuit(def.circuit);
    keepOnCanvas(def.circuit);
  }
  parent.moveComponent(cpu.ram.id, pos.x + CHIP_INSTANCE_WIDTH + 120 - cpu.ram.pos.x, pos.y - cpu.ram.pos.y);
  return { chip: top.instance, ram: cpu.ram };
}

/** PC0..PC{n-1} pins of a placed Tiny CPU, LSB first. */
export function tinyPcPins(chip: ChipInstanceComponent): Pin[] {
  const pins: Pin[] = [];
  for (let i = 0; chip.pins[`PC${i}`]; i++) pins.push(chip.pins[`PC${i}`]!);
  return pins;
}

/** The Tiny CPU chip whose ADDR0 is wired directly to this RAM's addr0, if any. */
export function tinyCpuForRam(circuit: Circuit, library: ChipLibrary, ram: RamComponent): ChipInstanceComponent | undefined {
  const ramAddr0 = ram.pins.addr0?.id;
  if (ramAddr0 === undefined) return undefined;
  for (const c of circuit.components.values()) {
    if (c.kind !== 'chip' || !library.has(c.defId) || library.get(c.defId).name !== TINY_CPU_NAME) continue;
    const cpuAddr0 = c.pins.ADDR0?.id;
    for (const w of circuit.wires.values()) {
      if ((w.a === cpuAddr0 && w.b === ramAddr0) || (w.b === cpuAddr0 && w.a === ramAddr0)) return c;
    }
  }
  return undefined;
}
