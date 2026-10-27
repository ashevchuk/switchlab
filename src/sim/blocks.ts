// Composite structures built by *using the hierarchy system itself*
// (fold()/foldExposing() + makeChipInstance() in a loop), not by wiring
// more raw transistors by hand. This is the point of hierarchy: an N-bit
// register or ALU is "one bit, folded into a chip, replicated N times and
// wired together" — the same technique already proven in
// hierarchy.test.ts's nested-fold tests, now put to actual use.

import type { ChipDef, ChipLibrary } from './ChipLibrary.js';
import { Circuit } from './Circuit.js';
import { foldExposing } from './hierarchy.js';
import {
  buildAnd,
  buildDecoder,
  buildFullAdder,
  buildHalfAdder,
  buildMux2,
  buildMux4,
  buildNand,
  buildNor,
  buildNot,
  buildOr,
  buildTriStateBuffer,
  CHIP_INSTANCE_WIDTH,
  buildXor,
  chipInstanceHeight,
  makeChipInstance,
  makeChipGatePlacer,
  makeInput,
  makeLabel,
  makeRam,
  makeSource,
  ramAddrPins,
  ramDataPins,
  railPin,
  setCircuitGatePlacer,
  tiePowerRail,
  wire,
  type CircuitGatePlacer,
  type TwoInputGate,
} from './library.js';
import { buildRegisterBit } from './sequential.js';
import { compactCircuitLayout, replaceLongWiresWithLabels, tiePinToNet, tidyLibraryCircuit } from './labelWires.js';
import type { Pin, Point, RamComponent } from './types.js';

/** Fold a 1-bit register as MUX2 + D_FF chips (dive shows gates, not FET soup). */
function makeRegisterBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const dffDef = library.findByName('D_FF');

  if (dffDef) {
    const mux = makeChipInstance(scratch, muxDef, { x: 0, y: 0 });
    const dff = makeChipInstance(scratch, dffDef, { x: 200, y: 0 });
    const muxSel = mux.pins[muxDef.ports[0]!]!;
    const muxIn0 = mux.pins[muxDef.ports[1]!]!;
    const muxIn1 = mux.pins[muxDef.ports[2]!]!;
    const muxOut = mux.pins[muxDef.ports[3]!]!;
    const dffD = dff.pins[dffDef.ports[0]!]!;
    const dffClk = dff.pins[dffDef.ports[1]!]!;
    const dffQ = dff.pins[dffDef.ports[2]!]!;
    const dffQn = dff.pins[dffDef.ports[3]!]!;
    wire(scratch, muxOut, dffD);
    wire(scratch, dffQ, muxIn0); // WE=0: hold
    return foldExposing(scratch, 'REG_BIT', library, [
      { pin: muxIn1, isOutput: false, portName: 'd' },
      { pin: muxSel, isOutput: false, portName: 'we' },
      { pin: dffClk, isOutput: false, portName: 'clk' },
      { pin: dffQ, isOutput: true, portName: 'q' },
      { pin: dffQn, isOutput: true, portName: 'qn' },
    ], { labelize: false });
  }

  // Standalone library without seedStandardCells — place via gate placer.
  const not = library.findByName('NOT') ?? makeNotChip(library);
  const nand = getNamedGateChip(library, nandChipDefs, 'NAND', (lib) =>
    makeTwoInputGateChip(lib, 'NAND', buildNand),
  );
  const and = getNamedGateChip(library, andChipDefs, 'AND', (lib) =>
    makeTwoInputGateChip(lib, 'AND', buildAnd),
  );
  const nor = getNamedGateChip(library, norChipDefs, 'NOR', (lib) =>
    makeTwoInputGateChip(lib, 'NOR', buildNor),
  );
  const or = getNamedGateChip(library, orChipDefs, 'OR', (lib) =>
    makeTwoInputGateChip(lib, 'OR', buildOr),
  );
  const dLatch = library.findByName('D_LATCH');
  setCircuitGatePlacer(
    scratch,
    makeChipGatePlacer({
      not,
      nand,
      and,
      nor,
      or,
      mux2: muxDef,
      ...(dLatch ? { dLatch } : {}),
    }),
  );
  try {
    const bit = buildRegisterBit(scratch);
    return foldExposing(scratch, 'REG_BIT', library, [
      { pin: bit.d, isOutput: false, portName: 'd' },
      { pin: bit.we, isOutput: false, portName: 'we' },
      { pin: bit.clk, isOutput: false, portName: 'clk' },
      { pin: bit.q, isOutput: true, portName: 'q' },
      { pin: bit.qn, isOutput: true, portName: 'qn' },
    ], { labelize: false });
  } finally {
    setCircuitGatePlacer(scratch, null);
  }
}

// One REG_BIT def per ChipLibrary, however many registers get built against
// it — keeps the chip palette from accumulating a duplicate-named entry
// per call, since every instance of a register is just this one chip
// placed several times over (see buildRegister below).
const registerBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getRegisterBitChip(library: ChipLibrary): ChipDef {
  let def = registerBitDefs.get(library);
  if (!def) {
    def = library.findByName('REG_BIT') ?? makeRegisterBitChip(library);
    registerBitDefs.set(library, def);
  }
  return def;
}

export interface Register {
  d: Pin[];
  q: Pin[];
  qn: Pin[];
  we: Pin;
  clk: Pin;
}

/**
 * Places `bits` instances of the (shared) 1-bit register chip into
 * `parent`, ties all their WE pins together into one net and all their CLK
 * pins together into another, and returns per-bit D/Q/QN pins for the
 * caller to wire up individually — exactly the same composable-primitive
 * shape as buildFullAdder() or buildMux2(), just assembled from chip
 * instances instead of bare transistors.
 */
export function buildRegister(parent: Circuit, library: ChipLibrary, bits: number, pos: Point = { x: 0, y: 0 }): Register {
  const def = getRegisterBitChip(library);
  const d: Pin[] = [];
  const q: Pin[] = [];
  const qn: Pin[] = [];
  let we!: Pin;
  let clk!: Pin;
  const stepY = chipInstanceHeight(def.ports.length) + 20; // box height + a visible gap between instances

  for (let i = 0; i < bits; i++) {
    const inst = makeChipInstance(parent, def, { x: pos.x, y: pos.y + i * stepY });
    const dPin = inst.pins[def.ports[0]!]!;
    const wePin = inst.pins[def.ports[1]!]!;
    const clkPin = inst.pins[def.ports[2]!]!;
    const qPin = inst.pins[def.ports[3]!]!;
    const qnPin = inst.pins[def.ports[4]!]!;
    d.push(dPin);
    q.push(qPin);
    qn.push(qnPin);
    if (i === 0) {
      we = wePin;
      clk = clkPin;
    } else {
      wire(parent, we, wePin);
      wire(parent, clk, clkPin);
    }
  }

  return { d, q, qn, we, clk };
}

export interface AluSlice {
  a: Pin;
  b: Pin;
  cin: Pin;
  op0: Pin;
  op1: Pin;
  out: Pin;
  cout: Pin;
}

/**
 * 1-bit ALU slice: a full adder plus AND/OR/XOR of the same two inputs, all
 * four results fed into a 4:1 mux selected by a 2-bit opcode — op=00 ADD,
 * 01 AND, 10 OR, 11 XOR. `cout` always reflects the adder regardless of
 * the selected op (chaining N of these — see buildAlu below — only makes
 * sense for ADD, but there's no harm wiring the carry chain unconditionally).
 */
export function buildAluSlice(circuit: Circuit, pos: Point = { x: 0, y: 0 }): AluSlice {
  const adder = buildFullAdder(circuit, pos);
  const andG = buildAnd(circuit, { x: pos.x, y: pos.y + 1400 });
  const orG = buildOr(circuit, { x: pos.x, y: pos.y + 1700 });
  const xorG = buildXor(circuit, { x: pos.x, y: pos.y + 2000 });
  const mux = buildMux4(circuit, { x: pos.x + 1500, y: pos.y + 800 });

  wire(circuit, adder.a, andG.a);
  wire(circuit, adder.a, orG.a);
  wire(circuit, adder.a, xorG.a);
  wire(circuit, adder.b, andG.b);
  wire(circuit, adder.b, orG.b);
  wire(circuit, adder.b, xorG.b);

  wire(circuit, adder.sum, mux.in0); // op 00: ADD
  wire(circuit, andG.out, mux.in1); // op 01: AND
  wire(circuit, orG.out, mux.in2); // op 10: OR
  wire(circuit, xorG.out, mux.in3); // op 11: XOR

  return { a: adder.a, b: adder.b, cin: adder.cin, op0: mux.sel0, op1: mux.sel1, out: mux.out, cout: adder.cout };
}

/** Fold ALU slice as FULL_ADDER + AND/OR/XOR + MUX4 chips (not flat FETs). */
function makeAluSliceChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);

  const faDef = library.findByName('FULL_ADDER');
  const andDef = getNamedGateChip(library, andChipDefs, 'AND', (lib) =>
    makeTwoInputGateChip(lib, 'AND', buildAnd),
  );
  const orDef = getNamedGateChip(library, orChipDefs, 'OR', (lib) =>
    makeTwoInputGateChip(lib, 'OR', buildOr),
  );
  const xorDef = getNamedGateChip(library, xorChipDefs, 'XOR', (lib) =>
    makeTwoInputGateChip(lib, 'XOR', buildXor),
  );
  const mux4Def = library.findByName('MUX4');

  if (faDef && mux4Def) {
    const fa = makeChipInstance(scratch, faDef, { x: 0, y: 0 });
    const andG = placeTwoInputChip(scratch, andDef, { x: 0, y: 200 });
    const orG = placeTwoInputChip(scratch, orDef, { x: 0, y: 320 });
    const xorG = placeTwoInputChip(scratch, xorDef, { x: 0, y: 440 });
    const mux = makeChipInstance(scratch, mux4Def, { x: 280, y: 160 });
    const faA = fa.pins[faDef.ports[0]!]!;
    const faB = fa.pins[faDef.ports[1]!]!;
    const faCin = fa.pins[faDef.ports[2]!]!;
    const faSum = fa.pins[faDef.ports[3]!]!;
    const faCout = fa.pins[faDef.ports[4]!]!;
    const sel0 = mux.pins[mux4Def.ports[0]!]!;
    const sel1 = mux.pins[mux4Def.ports[1]!]!;
    const in0 = mux.pins[mux4Def.ports[2]!]!;
    const in1 = mux.pins[mux4Def.ports[3]!]!;
    const in2 = mux.pins[mux4Def.ports[4]!]!;
    const in3 = mux.pins[mux4Def.ports[5]!]!;
    const muxOut = mux.pins[mux4Def.ports[6]!]!;
    wire(scratch, faA, andG.a);
    wire(scratch, faA, orG.a);
    wire(scratch, faA, xorG.a);
    wire(scratch, faB, andG.b);
    wire(scratch, faB, orG.b);
    wire(scratch, faB, xorG.b);
    wire(scratch, faSum, in0);
    wire(scratch, andG.out, in1);
    wire(scratch, orG.out, in2);
    wire(scratch, xorG.out, in3);
    return foldExposing(scratch, 'ALU_SLICE', library, [
      { pin: faA, isOutput: false, portName: 'a' },
      { pin: faB, isOutput: false, portName: 'b' },
      { pin: faCin, isOutput: false, portName: 'cin' },
      { pin: sel0, isOutput: false, portName: 'op0' },
      { pin: sel1, isOutput: false, portName: 'op1' },
      { pin: muxOut, isOutput: true, portName: 'out' },
      { pin: faCout, isOutput: true, portName: 'cout' },
    ], { labelize: false });
  }

  // Fallback without FULL_ADDER/MUX4 stdcells — gate-place the builders.
  const not = library.findByName('NOT') ?? makeNotChip(library);
  const nand = getNamedGateChip(library, nandChipDefs, 'NAND', (lib) =>
    makeTwoInputGateChip(lib, 'NAND', buildNand),
  );
  const nor = getNamedGateChip(library, norChipDefs, 'NOR', (lib) =>
    makeTwoInputGateChip(lib, 'NOR', buildNor),
  );
  const mux2 = getMux2Chip(library);
  setCircuitGatePlacer(
    scratch,
    makeChipGatePlacer({ not, nand, and: andDef, nor, or: orDef, xor: xorDef, mux2 }),
  );
  try {
    const slice = buildAluSlice(scratch);
    return foldExposing(scratch, 'ALU_SLICE', library, [
      { pin: slice.a, isOutput: false, portName: 'a' },
      { pin: slice.b, isOutput: false, portName: 'b' },
      { pin: slice.cin, isOutput: false, portName: 'cin' },
      { pin: slice.op0, isOutput: false, portName: 'op0' },
      { pin: slice.op1, isOutput: false, portName: 'op1' },
      { pin: slice.out, isOutput: true, portName: 'out' },
      { pin: slice.cout, isOutput: true, portName: 'cout' },
    ], { labelize: false });
  } finally {
    setCircuitGatePlacer(scratch, null);
  }
}

// One ALU_SLICE def per ChipLibrary — see the identical reasoning on
// registerBitDefs above.
const aluSliceDefs = new WeakMap<ChipLibrary, ChipDef>();
function getAluSliceChip(library: ChipLibrary): ChipDef {
  let def = aluSliceDefs.get(library);
  if (!def) {
    def = library.findByName('ALU_SLICE') ?? makeAluSliceChip(library);
    aluSliceDefs.set(library, def);
  }
  return def;
}

export interface Alu {
  a: Pin[];
  b: Pin[];
  out: Pin[];
  cin: Pin;
  cout: Pin;
  op0: Pin;
  op1: Pin;
  /** Each slice's own `cout`, LSB to MSB — `carries[bits-1] === cout`, the same pin, not a copy. Exposed so a caller can read an *interior* carry (e.g. `carries[3]`, the nibble boundary every half-carry flag on real hardware is defined by) without reaching past this interface into the chip instances `buildAlu` folded away. */
  carries: Pin[];
}

/**
 * N-bit ALU: `bits` instances of the (shared) 1-bit ALU-slice chip, ripple-
 * carry chained — each slice's `cout` wired straight into the next slice's
 * `cin`, LSB (index 0) to MSB. `op0`/`op1` are tied together across every
 * slice (the whole ALU performs one operation at a time on all bits); the
 * overall `cin`/`cout` are simply the chain's two open ends, bit 0's cin and
 * bit `bits-1`'s cout.
 *
 * For AND/OR/XOR the carry chain is along for the ride but electrically
 * inert (each slice's own cout still reflects its internal adder,
 * regardless of the selected op — see buildAluSlice's doc comment) — only
 * ADD's result actually depends on the incoming carry.
 */
export function buildAlu(parent: Circuit, library: ChipLibrary, bits: number, pos: Point = { x: 0, y: 0 }): Alu {
  const def = getAluSliceChip(library);
  const a: Pin[] = [];
  const b: Pin[] = [];
  const out: Pin[] = [];
  const carries: Pin[] = [];
  let cin!: Pin;
  let cout!: Pin;
  let op0!: Pin;
  let op1!: Pin;

  for (let i = 0; i < bits; i++) {
    const inst = makeChipInstance(parent, def, { x: pos.x + i * (CHIP_INSTANCE_WIDTH + 40), y: pos.y });
    const aPin = inst.pins[def.ports[0]!]!;
    const bPin = inst.pins[def.ports[1]!]!;
    const cinPin = inst.pins[def.ports[2]!]!;
    const op0Pin = inst.pins[def.ports[3]!]!;
    const op1Pin = inst.pins[def.ports[4]!]!;
    const outPin = inst.pins[def.ports[5]!]!;
    const coutPin = inst.pins[def.ports[6]!]!;

    a.push(aPin);
    b.push(bPin);
    out.push(outPin);

    if (i === 0) {
      cin = cinPin;
      op0 = op0Pin;
      op1 = op1Pin;
    } else {
      wire(parent, cout, cinPin); // ripple: previous slice's carry-out feeds this slice's carry-in
      wire(parent, op0, op0Pin);
      wire(parent, op1, op1Pin);
    }
    cout = coutPin;
    carries.push(coutPin);
  }

  return { a, b, out, cin, cout, op0, op1, carries };
}

/** Fold buildHalfAdder() into a reusable chip. Ports, in order: a, b, sum, cout. */
function makeHalfAdderChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);
  const not = library.findByName('NOT');
  const nand = library.findByName('NAND');
  const and = library.findByName('AND');
  const nor = library.findByName('NOR');
  const or = library.findByName('OR');
  const xor = library.findByName('XOR');
  let ha;
  if (not && nand && and && nor && or && xor) {
    setCircuitGatePlacer(scratch, makeChipGatePlacer({ not, nand, and, nor, or, xor }));
    try {
      ha = buildHalfAdder(scratch);
    } finally {
      setCircuitGatePlacer(scratch, null);
    }
  } else {
    ha = buildHalfAdder(scratch);
  }
  // Port names must match seedStandardCells / Soft Lab (`sum`/`cout`). Default
  // fold names `out0`/`out1` leave Soft Lab's HALF_ADDER model undriven, so PC
  // never increments. labelize:false keeps gate/transistor guts when expanded.
  return foldExposing(scratch, 'HALF_ADDER', library, [
    { pin: ha.a, isOutput: false, portName: 'a' },
    { pin: ha.b, isOutput: false, portName: 'b' },
    { pin: ha.sum, isOutput: true, portName: 'sum' },
    { pin: ha.cout, isOutput: true, portName: 'cout' },
  ], { labelize: false });
}

/** Fold buildMux2() into a reusable chip. Ports, in order: sel, in0, in1, out. */
function makeMux2Chip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);
  const not = library.findByName('NOT');
  const nand = library.findByName('NAND');
  const and = library.findByName('AND');
  const nor = library.findByName('NOR');
  const or = library.findByName('OR');
  let m;
  if (not && nand && and && nor && or) {
    setCircuitGatePlacer(scratch, makeChipGatePlacer({ not, nand, and, nor, or }));
    try {
      m = buildMux2(scratch);
    } finally {
      setCircuitGatePlacer(scratch, null);
    }
  } else {
    m = buildMux2(scratch);
  }
  // Names must match seedStandardCells / Soft Lab 74157_1 (sel/in0/in1/out).
  // Default fold would yield a/b/c/out and break aliasChip('74157_1','MUX2').
  return foldExposing(scratch, 'MUX2', library, [
    { pin: m.sel, isOutput: false, portName: 'sel' },
    { pin: m.in0, isOutput: false, portName: 'in0' },
    { pin: m.in1, isOutput: false, portName: 'in1' },
    { pin: m.out, isOutput: true, portName: 'out' },
  ], { labelize: false });
}

// One def each per ChipLibrary — see the identical reasoning on
// registerBitDefs above. buildProgramCounter caches its own HALF_ADDER and
// MUX2 rather than assuming seedStandardCells() already registered
// same-named ones, so it works standalone in a library that never called it.
const halfAdderDefs = new WeakMap<ChipLibrary, ChipDef>();
function getHalfAdderChip(library: ChipLibrary): ChipDef {
  let def = halfAdderDefs.get(library);
  if (!def) {
    // Prefer seedStandardCells()'s HALF_ADDER when present — same ports/order.
    def = library.findByName('HALF_ADDER') ?? makeHalfAdderChip(library);
    halfAdderDefs.set(library, def);
  }
  return def;
}
const mux2Defs = new WeakMap<ChipLibrary, ChipDef>();
function getMux2Chip(library: ChipLibrary): ChipDef {
  let def = mux2Defs.get(library);
  if (!def) {
    def = library.findByName('MUX2') ?? makeMux2Chip(library);
    mux2Defs.set(library, def);
  }
  return def;
}

/** Fold a 1-input gate (NOT) — CMOS primitive: keep schematic wires. */
function makeNotChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const g = buildNot(scratch);
  return foldExposing(scratch, 'NOT', library, [
    { pin: g.in, isOutput: false, portName: 'in' },
    { pin: g.out, isOutput: true, portName: 'out' },
  ], { labelize: false });
}

/** Fold a 2-input gate. CMOS primitives keep drawn wires (labelize:false). */
function makeTwoInputGateChip(
  library: ChipLibrary,
  name: string,
  build: (circuit: Circuit) => TwoInputGate,
): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  // XOR fallback: 4× NAND chips when NAND is already in the library.
  let g: TwoInputGate;
  if (name === 'XOR') {
    const nand = library.findByName('NAND');
    const not = library.findByName('NOT');
    const and = library.findByName('AND');
    const nor = library.findByName('NOR');
    const or = library.findByName('OR');
    if (nand && not && and && nor && or) {
      setCircuitGatePlacer(scratch, makeChipGatePlacer({ not, nand, and, nor, or }));
      try {
        g = build(scratch);
      } finally {
        setCircuitGatePlacer(scratch, null);
      }
    } else {
      g = build(scratch);
    }
  } else {
    g = build(scratch);
  }
  return foldExposing(scratch, name, library, [
    { pin: g.a, isOutput: false, portName: 'a' },
    { pin: g.b, isOutput: false, portName: 'b' },
    { pin: g.out, isOutput: true, portName: 'out' },
  ], { labelize: false });
}

const notChipDefs = new WeakMap<ChipLibrary, ChipDef>();
const nandChipDefs = new WeakMap<ChipLibrary, ChipDef>();
const andChipDefs = new WeakMap<ChipLibrary, ChipDef>();
const norChipDefs = new WeakMap<ChipLibrary, ChipDef>();
const orChipDefs = new WeakMap<ChipLibrary, ChipDef>();
const xorChipDefs = new WeakMap<ChipLibrary, ChipDef>();

function getNamedGateChip(
  library: ChipLibrary,
  cache: WeakMap<ChipLibrary, ChipDef>,
  name: string,
  make: (library: ChipLibrary) => ChipDef,
): ChipDef {
  let def = cache.get(library);
  if (!def) {
    def = library.findByName(name) ?? make(library);
    cache.set(library, def);
  }
  return def;
}

function placeTwoInputChip(circuit: Circuit, def: ChipDef, pos: Point): TwoInputGate {
  const inst = makeChipInstance(circuit, def, pos);
  return {
    a: inst.pins[def.ports[0]!]!,
    b: inst.pins[def.ports[1]!]!,
    out: inst.pins[def.ports[2]!]!,
  };
}

/** Stdcell chip placers for AND/OR/NOT/… — same netlist as transistor builders after flatten. */
function makeZ80GatePlacer(library: ChipLibrary): CircuitGatePlacer {
  const notDef = getNamedGateChip(library, notChipDefs, 'NOT', makeNotChip);
  const nandDef = getNamedGateChip(library, nandChipDefs, 'NAND', (lib) =>
    makeTwoInputGateChip(lib, 'NAND', buildNand),
  );
  const andDef = getNamedGateChip(library, andChipDefs, 'AND', (lib) =>
    makeTwoInputGateChip(lib, 'AND', buildAnd),
  );
  const norDef = getNamedGateChip(library, norChipDefs, 'NOR', (lib) =>
    makeTwoInputGateChip(lib, 'NOR', buildNor),
  );
  const orDef = getNamedGateChip(library, orChipDefs, 'OR', (lib) =>
    makeTwoInputGateChip(lib, 'OR', buildOr),
  );
  const xorDef = getNamedGateChip(library, xorChipDefs, 'XOR', (lib) =>
    makeTwoInputGateChip(lib, 'XOR', buildXor),
  );
  return makeChipGatePlacer({
    not: notDef,
    nand: nandDef,
    and: andDef,
    nor: norDef,
    or: orDef,
    xor: xorDef,
  });
}

/**
 * One address-bit of the Z80 RAM address mux cascade (same sequential
 * left-associated MUX2 override order as the former inline forEach):
 * PC → HL → SP(write) → SP(read) → BC → DE → nn → nn+1 → EX(SP) low/high →
 * LDI HL/DE → CPI HL → INI HL → OUTI HL → RRD/RLD HL → ED PC+1 → IX+d → IY+d.
 * RRD/RLD select is OR'd inside the chip (two sel ports).
 *
 * Ports (foldExposing order):
 *   sels: selHl, selStackWrite, selRead, selBc, selDe, selNnLow, selNnHigh,
 *         selExSpHlLow, selExSpHlHigh, selLdBlockRead, selLdBlockWrite,
 *         selCpBlockRead, selInBlockWrite, selOutBlockRead,
 *         selRrdRldRead, selRrdRldWrite, selEdNnPcPlus1, selIxDisp, selIyDisp,
 *         selIm2Lo, selIm2Hi
 *   data: pc, hl, bc, de, sp, nn, nnPlus1, spPlus1, pcPlus1, ixDisp, iyDisp,
 *         im2Vec, im2VecPlus1
 *   out
 */
function makeRamAddrBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const placeMux = (x: number, y: number) => {
    const inst = makeChipInstance(scratch, muxDef, { x, y });
    return {
      sel: inst.pins[muxDef.ports[0]!]!,
      in0: inst.pins[muxDef.ports[1]!]!,
      in1: inst.pins[muxDef.ports[2]!]!,
      out: inst.pins[muxDef.ports[3]!]!,
    };
  };

  const hlMux = placeMux(0, 0);
  const writeMux = placeMux(200, 0);
  wire(scratch, hlMux.out, writeMux.in0);
  const readMux = placeMux(400, 0);
  wire(scratch, writeMux.out, readMux.in0);
  const bcMux = placeMux(600, 0);
  wire(scratch, readMux.out, bcMux.in0);
  const deMux = placeMux(800, 0);
  wire(scratch, bcMux.out, deMux.in0);
  const nnLowMux = placeMux(1000, 0);
  wire(scratch, deMux.out, nnLowMux.in0);
  const nnHighMux = placeMux(1200, 0);
  wire(scratch, nnLowMux.out, nnHighMux.in0);
  const exSpHlLowMux = placeMux(1400, 0);
  wire(scratch, nnHighMux.out, exSpHlLowMux.in0);
  const exSpHlHighMux = placeMux(1600, 0);
  wire(scratch, exSpHlLowMux.out, exSpHlHighMux.in0);
  const ldBlockReadMux = placeMux(1800, 0);
  wire(scratch, exSpHlHighMux.out, ldBlockReadMux.in0);
  const ldBlockWriteMux = placeMux(2000, 0);
  wire(scratch, ldBlockReadMux.out, ldBlockWriteMux.in0);
  const cpBlockReadMux = placeMux(2200, 0);
  wire(scratch, ldBlockWriteMux.out, cpBlockReadMux.in0);
  const inBlockWriteMux = placeMux(2400, 0);
  wire(scratch, cpBlockReadMux.out, inBlockWriteMux.in0);
  const outBlockReadMux = placeMux(2600, 0);
  wire(scratch, inBlockWriteMux.out, outBlockReadMux.in0);

  // RRD/RLD sel OR — OR chip (not bare FETs) so dive stays hierarchical.
  const orDef = getNamedGateChip(library, orChipDefs, 'OR', (lib) =>
    makeTwoInputGateChip(lib, 'OR', buildOr),
  );
  const rrdRldAddrNow = placeTwoInputChip(scratch, orDef, { x: 2700, y: -40 });
  const rrdRldAddrMux = placeMux(2800, 0);
  wire(scratch, rrdRldAddrNow.out, rrdRldAddrMux.sel);
  wire(scratch, outBlockReadMux.out, rrdRldAddrMux.in0);

  const edNnPcPlus1Mux = placeMux(3000, 0);
  wire(scratch, rrdRldAddrMux.out, edNnPcPlus1Mux.in0);
  const ixDispAddrMux = placeMux(3200, 0);
  wire(scratch, edNnPcPlus1Mux.out, ixDispAddrMux.in0);
  const iyDispAddrMux = placeMux(3400, 0);
  wire(scratch, ixDispAddrMux.out, iyDispAddrMux.in0);
  // IM2 vector fetch: (I<<8)|irqBus then +1 for the high ISR byte.
  const im2LoMux = placeMux(3600, 0);
  wire(scratch, iyDispAddrMux.out, im2LoMux.in0);
  const im2HiMux = placeMux(3800, 0);
  wire(scratch, im2LoMux.out, im2HiMux.in0);

  // Shared data overrides fan out from one exposed pin each (same nets as
  // the former multi-wire of the same register bit into several mux in1s).
  wire(scratch, hlMux.in1, ldBlockReadMux.in1);
  wire(scratch, hlMux.in1, cpBlockReadMux.in1);
  wire(scratch, hlMux.in1, inBlockWriteMux.in1);
  wire(scratch, hlMux.in1, outBlockReadMux.in1);
  wire(scratch, hlMux.in1, rrdRldAddrMux.in1);
  wire(scratch, deMux.in1, ldBlockWriteMux.in1);
  wire(scratch, writeMux.in1, readMux.in1);
  wire(scratch, writeMux.in1, exSpHlLowMux.in1);

  return foldExposing(scratch, 'RAM_ADDR_BIT', library, [
    { pin: hlMux.sel, isOutput: false }, // selHl
    { pin: writeMux.sel, isOutput: false }, // selStackWrite
    { pin: readMux.sel, isOutput: false }, // selRead
    { pin: bcMux.sel, isOutput: false }, // selBc
    { pin: deMux.sel, isOutput: false }, // selDe
    { pin: nnLowMux.sel, isOutput: false }, // selNnLow
    { pin: nnHighMux.sel, isOutput: false }, // selNnHigh
    { pin: exSpHlLowMux.sel, isOutput: false }, // selExSpHlLow
    { pin: exSpHlHighMux.sel, isOutput: false }, // selExSpHlHigh
    { pin: ldBlockReadMux.sel, isOutput: false }, // selLdBlockRead
    { pin: ldBlockWriteMux.sel, isOutput: false }, // selLdBlockWrite
    { pin: cpBlockReadMux.sel, isOutput: false }, // selCpBlockRead
    { pin: inBlockWriteMux.sel, isOutput: false }, // selInBlockWrite
    { pin: outBlockReadMux.sel, isOutput: false }, // selOutBlockRead
    { pin: rrdRldAddrNow.a, isOutput: false }, // selRrdRldRead
    { pin: rrdRldAddrNow.b, isOutput: false }, // selRrdRldWrite
    { pin: edNnPcPlus1Mux.sel, isOutput: false }, // selEdNnPcPlus1
    { pin: ixDispAddrMux.sel, isOutput: false }, // selIxDisp
    { pin: iyDispAddrMux.sel, isOutput: false }, // selIyDisp
    { pin: im2LoMux.sel, isOutput: false }, // selIm2Lo
    { pin: im2HiMux.sel, isOutput: false }, // selIm2Hi
    { pin: hlMux.in0, isOutput: false }, // pc
    { pin: hlMux.in1, isOutput: false }, // hl
    { pin: bcMux.in1, isOutput: false }, // bc
    { pin: deMux.in1, isOutput: false }, // de
    { pin: writeMux.in1, isOutput: false }, // sp
    { pin: nnLowMux.in1, isOutput: false }, // nn
    { pin: nnHighMux.in1, isOutput: false }, // nnPlus1
    { pin: exSpHlHighMux.in1, isOutput: false }, // spPlus1
    { pin: edNnPcPlus1Mux.in1, isOutput: false }, // pcPlus1
    { pin: ixDispAddrMux.in1, isOutput: false }, // ixDisp
    { pin: iyDispAddrMux.in1, isOutput: false }, // iyDisp
    { pin: im2LoMux.in1, isOutput: false }, // im2Vec
    { pin: im2HiMux.in1, isOutput: false }, // im2VecPlus1
    { pin: im2HiMux.out, isOutput: true }, // out
  ]);
}

const ramAddrBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getRamAddrBitChip(library: ChipLibrary): ChipDef {
  let def = ramAddrBitDefs.get(library);
  if (!def) {
    def = makeRamAddrBitChip(library);
    ramAddrBitDefs.set(library, def);
  }
  return def;
}

/**
 * One bit of the PC write-data mux cascade (former inline forEach ~18 MUX2
 * layers): hold → RET → RST → JP → CALL → JP cc → CALL cc → RET cc → JR →
 * JP (HL) → JP (IX) → JP (IY) → LDIR/LDDR → CPIR/CPDR → INIR/INDR →
 * OTIR/OTDR → NMI → IM2 lo → IM2 hi → out.
 *
 * Ports: 18 sels, then hold + 14 override data bits, then out.
 */
function makePcCommitBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const placeMux = (x: number, y: number) => {
    const inst = makeChipInstance(scratch, muxDef, { x, y });
    return {
      sel: inst.pins[muxDef.ports[0]!]!,
      in0: inst.pins[muxDef.ports[1]!]!,
      in1: inst.pins[muxDef.ports[2]!]!,
      out: inst.pins[muxDef.ports[3]!]!,
    };
  };

  const retMux = placeMux(0, 0);
  const rstMux = placeMux(200, 0);
  wire(scratch, retMux.out, rstMux.in0);
  const jpMux = placeMux(400, 0);
  wire(scratch, rstMux.out, jpMux.in0);
  const callMux = placeMux(600, 0);
  wire(scratch, jpMux.out, callMux.in0);
  const jpCcMux = placeMux(800, 0);
  wire(scratch, callMux.out, jpCcMux.in0);
  const callCcMux = placeMux(1000, 0);
  wire(scratch, jpCcMux.out, callCcMux.in0);
  const retCcMux = placeMux(1200, 0);
  wire(scratch, callCcMux.out, retCcMux.in0);
  const jrMux = placeMux(1400, 0);
  wire(scratch, retCcMux.out, jrMux.in0);
  const jpHlMux = placeMux(1600, 0);
  wire(scratch, jrMux.out, jpHlMux.in0);
  const jpIxMux = placeMux(1800, 0);
  wire(scratch, jpHlMux.out, jpIxMux.in0);
  const jpIyMux = placeMux(2000, 0);
  wire(scratch, jpIxMux.out, jpIyMux.in0);
  const ldRepMux = placeMux(2200, 0);
  wire(scratch, jpIyMux.out, ldRepMux.in0);
  const cpRepMux = placeMux(2400, 0);
  wire(scratch, ldRepMux.out, cpRepMux.in0);
  const inRepMux = placeMux(2600, 0);
  wire(scratch, cpRepMux.out, inRepMux.in0);
  const outRepMux = placeMux(2800, 0);
  wire(scratch, inRepMux.out, outRepMux.in0);
  const nmiMux = placeMux(3000, 0);
  wire(scratch, outRepMux.out, nmiMux.in0);
  const im2LoMux = placeMux(3200, 0);
  wire(scratch, nmiMux.out, im2LoMux.in0);
  const im2HiMux = placeMux(3400, 0);
  wire(scratch, im2LoMux.out, im2HiMux.in0);

  // Shared bus / pcMinus2 fan-in (same nets as the former multi-wire taps).
  wire(scratch, retMux.in1, retCcMux.in1);
  wire(scratch, ldRepMux.in1, cpRepMux.in1);
  wire(scratch, ldRepMux.in1, inRepMux.in1);
  wire(scratch, ldRepMux.in1, outRepMux.in1);

  return foldExposing(scratch, 'PC_COMMIT_BIT', library, [
    { pin: retMux.sel, isOutput: false }, // selRet
    { pin: rstMux.sel, isOutput: false }, // selRst
    { pin: jpMux.sel, isOutput: false }, // selJp
    { pin: callMux.sel, isOutput: false }, // selCall
    { pin: jpCcMux.sel, isOutput: false }, // selJpCc
    { pin: callCcMux.sel, isOutput: false }, // selCallCc
    { pin: retCcMux.sel, isOutput: false }, // selRetCc
    { pin: jrMux.sel, isOutput: false }, // selJr
    { pin: jpHlMux.sel, isOutput: false }, // selJpHl
    { pin: jpIxMux.sel, isOutput: false }, // selJpIx
    { pin: jpIyMux.sel, isOutput: false }, // selJpIy
    { pin: ldRepMux.sel, isOutput: false }, // selLdRep
    { pin: cpRepMux.sel, isOutput: false }, // selCpRep
    { pin: inRepMux.sel, isOutput: false }, // selInRep
    { pin: outRepMux.sel, isOutput: false }, // selOutRep
    { pin: nmiMux.sel, isOutput: false }, // selNmi
    { pin: im2LoMux.sel, isOutput: false }, // selIm2Lo
    { pin: im2HiMux.sel, isOutput: false }, // selIm2Hi
    { pin: retMux.in0, isOutput: false }, // hold (pc.q)
    { pin: retMux.in1, isOutput: false }, // bus (RET / RET cc)
    { pin: rstMux.in1, isOutput: false }, // rstBit
    { pin: jpMux.in1, isOutput: false }, // jpTarget
    { pin: callMux.in1, isOutput: false }, // callTarget
    { pin: jpCcMux.in1, isOutput: false }, // jpCcTarget
    { pin: callCcMux.in1, isOutput: false }, // callCcTarget
    { pin: jrMux.in1, isOutput: false }, // jrOffset
    { pin: jpHlMux.in1, isOutput: false }, // jpHl
    { pin: jpIxMux.in1, isOutput: false }, // jpIx
    { pin: jpIyMux.in1, isOutput: false }, // jpIy
    { pin: ldRepMux.in1, isOutput: false }, // pcMinus2 (shared with block repeats)
    { pin: nmiMux.in1, isOutput: false }, // nmiBit
    { pin: im2LoMux.in1, isOutput: false }, // im2Lo
    { pin: im2HiMux.in1, isOutput: false }, // im2Hi
    { pin: im2HiMux.out, isOutput: true }, // out
  ]);
}

const pcCommitBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getPcCommitBitChip(library: ChipLibrary): ChipDef {
  let def = pcCommitBitDefs.get(library);
  if (!def) {
    def = makePcCommitBitChip(library);
    pcCommitBitDefs.set(library, def);
  }
  return def;
}

/**
 * One bit of the B..L register data mux cascade (IN r,(C) → SET/RES →
 * CB rotate → LD/POP/imm write). Same left-associated MUX2 order as the
 * former inline four-stage tree in `ldExternal`.
 *
 * Ports: selInRc, selSetRes, selCbRot, selLdWe,
 *         bus, ioIn, setResResult, cbRotResult, seed, out.
 */
function makeRegDataBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const placeMux = (x: number, y: number) => {
    const inst = makeChipInstance(scratch, muxDef, { x, y });
    return {
      sel: inst.pins[muxDef.ports[0]!]!,
      in0: inst.pins[muxDef.ports[1]!]!,
      in1: inst.pins[muxDef.ports[2]!]!,
      out: inst.pins[muxDef.ports[3]!]!,
    };
  };

  const inRcMux = placeMux(0, 0);
  const setResMux = placeMux(200, 0);
  wire(scratch, inRcMux.out, setResMux.in0);
  const cbRotMux = placeMux(400, 0);
  wire(scratch, setResMux.out, cbRotMux.in0);
  const ldMux = placeMux(600, 0);
  wire(scratch, cbRotMux.out, ldMux.in1);

  return foldExposing(scratch, 'REG_DATA_BIT', library, [
    { pin: inRcMux.sel, isOutput: false, portName: 'selInRc' },
    { pin: setResMux.sel, isOutput: false, portName: 'selSetRes' },
    { pin: cbRotMux.sel, isOutput: false, portName: 'selCbRot' },
    { pin: ldMux.sel, isOutput: false, portName: 'selLdWe' },
    { pin: inRcMux.in0, isOutput: false, portName: 'bus' },
    { pin: inRcMux.in1, isOutput: false, portName: 'ioIn' },
    { pin: setResMux.in1, isOutput: false, portName: 'setResResult' },
    { pin: cbRotMux.in1, isOutput: false, portName: 'cbRotResult' },
    { pin: ldMux.in0, isOutput: false, portName: 'seed' },
    { pin: ldMux.out, isOutput: true, portName: 'out' },
  ]);
}

const regDataBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getRegDataBitChip(library: ChipLibrary): ChipDef {
  let def = regDataBitDefs.get(library);
  if (!def) {
    def = makeRegDataBitChip(library);
    regDataBitDefs.set(library, def);
  }
  return def;
}

/**
 * One bit of wrapWithPairCommit: MUX2(sel→override else passthrough).
 * Ports: sel, passthrough, override, out.
 */
function makePairCommitBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const inst = makeChipInstance(scratch, muxDef, { x: 0, y: 0 });
  const sel = inst.pins[muxDef.ports[0]!]!;
  const passthrough = inst.pins[muxDef.ports[1]!]!;
  const override = inst.pins[muxDef.ports[2]!]!;
  const out = inst.pins[muxDef.ports[3]!]!;
  return foldExposing(scratch, 'PAIR_COMMIT_BIT', library, [
    { pin: sel, isOutput: false, portName: 'sel' },
    { pin: passthrough, isOutput: false, portName: 'passthrough' },
    { pin: override, isOutput: false, portName: 'override' },
    { pin: out, isOutput: true, portName: 'out' },
  ]);
}

const pairCommitBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getPairCommitBitChip(library: ChipLibrary): ChipDef {
  let def = pairCommitBitDefs.get(library);
  if (!def) {
    def = makePairCommitBitChip(library);
    pairCommitBitDefs.set(library, def);
  }
  return def;
}

/**
 * One bit of A's 14-deep data MUX cascade (INC/DEC → DAA → rot → EX AF → IN →
 * NEG → RRD/RLD → IN (C) → LD A,R/I → SET/RES → CB rot → BUS → reset).
 * Ports expose every sel + override; `ioIn` is shared by IN A,(n) and IN r,(C).
 */
function makeADataBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const placeMux = (x: number) => {
    const inst = makeChipInstance(scratch, muxDef, { x, y: 0 });
    return {
      sel: inst.pins[muxDef.ports[0]!]!,
      in0: inst.pins[muxDef.ports[1]!]!,
      in1: inst.pins[muxDef.ports[2]!]!,
      out: inst.pins[muxDef.ports[3]!]!,
    };
  };
  const r8 = placeMux(0);
  const daa = placeMux(200);
  wire(scratch, r8.out, daa.in0);
  const rot = placeMux(400);
  wire(scratch, daa.out, rot.in0);
  const ex = placeMux(600);
  wire(scratch, rot.out, ex.in0);
  const inn = placeMux(800);
  wire(scratch, ex.out, inn.in0);
  const neg = placeMux(1000);
  wire(scratch, inn.out, neg.in0);
  const rrd = placeMux(1200);
  wire(scratch, neg.out, rrd.in0);
  const inRc = placeMux(1400);
  wire(scratch, rrd.out, inRc.in0);
  wire(scratch, inn.in1, inRc.in1); // shared ioIn
  const ldAR = placeMux(1600);
  wire(scratch, inRc.out, ldAR.in0);
  const ldAI = placeMux(1800);
  wire(scratch, ldAR.out, ldAI.in0);
  const setRes = placeMux(2000);
  wire(scratch, ldAI.out, setRes.in0);
  const cbRot = placeMux(2200);
  wire(scratch, setRes.out, cbRot.in0);
  const bus = placeMux(2400);
  wire(scratch, cbRot.out, bus.in0);
  const reset = placeMux(2600);
  wire(scratch, bus.out, reset.in0);

  return foldExposing(scratch, 'A_DATA_BIT', library, [
    { pin: r8.sel, isOutput: false, portName: 'selIncDec' },
    { pin: daa.sel, isOutput: false, portName: 'selDaa' },
    { pin: rot.sel, isOutput: false, portName: 'selRotAcc' },
    { pin: ex.sel, isOutput: false, portName: 'selExAfAf' },
    { pin: inn.sel, isOutput: false, portName: 'selIn' },
    { pin: neg.sel, isOutput: false, portName: 'selNeg' },
    { pin: rrd.sel, isOutput: false, portName: 'selRrdRld' },
    { pin: inRc.sel, isOutput: false, portName: 'selInRc' },
    { pin: ldAR.sel, isOutput: false, portName: 'selLdAR' },
    { pin: ldAI.sel, isOutput: false, portName: 'selLdAI' },
    { pin: setRes.sel, isOutput: false, portName: 'selSetRes' },
    { pin: cbRot.sel, isOutput: false, portName: 'selCbRot' },
    { pin: bus.sel, isOutput: false, portName: 'selBus' },
    { pin: reset.sel, isOutput: false, portName: 'selReset' },
    { pin: r8.in0, isOutput: false, portName: 'alu' },
    { pin: r8.in1, isOutput: false, portName: 'r8Result' },
    { pin: daa.in1, isOutput: false, portName: 'daaResult' },
    { pin: rot.in1, isOutput: false, portName: 'rotAccResult' },
    { pin: ex.in1, isOutput: false, portName: 'apOld' },
    { pin: inn.in1, isOutput: false, portName: 'ioIn' },
    { pin: neg.in1, isOutput: false, portName: 'neg' },
    { pin: rrd.in1, isOutput: false, portName: 'rrdRldOrHold' },
    { pin: ldAR.in1, isOutput: false, portName: 'regR' },
    { pin: ldAI.in1, isOutput: false, portName: 'regI' },
    { pin: setRes.in1, isOutput: false, portName: 'setResResult' },
    { pin: cbRot.in1, isOutput: false, portName: 'cbRotResult' },
    { pin: bus.in1, isOutput: false, portName: 'bus' },
    { pin: reset.in1, isOutput: false, portName: 'reset0' },
    { pin: reset.out, isOutput: true, portName: 'out' },
  ]);
}

const aDataBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getADataBitChip(library: ChipLibrary): ChipDef {
  let def = aDataBitDefs.get(library);
  if (!def) {
    def = makeADataBitChip(library);
    aDataBitDefs.set(library, def);
  }
  return def;
}

/**
 * SP half-byte commit (LD SP,nn / ED LD SP,(nn)): inner mux picks bus vs hold,
 * outer mux picks that vs passthrough when either half writes.
 * Ports: selHold, selAny, busBit, holdQ, passthrough → out.
 */
function makeSpHalfCommitBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const fresh = makeChipInstance(scratch, muxDef, { x: 0, y: 0 });
  const outer = makeChipInstance(scratch, muxDef, { x: 200, y: 0 });
  const fSel = fresh.pins[muxDef.ports[0]!]!;
  const fIn0 = fresh.pins[muxDef.ports[1]!]!;
  const fIn1 = fresh.pins[muxDef.ports[2]!]!;
  const fOut = fresh.pins[muxDef.ports[3]!]!;
  const oSel = outer.pins[muxDef.ports[0]!]!;
  const oIn0 = outer.pins[muxDef.ports[1]!]!;
  const oIn1 = outer.pins[muxDef.ports[2]!]!;
  const oOut = outer.pins[muxDef.ports[3]!]!;
  wire(scratch, fOut, oIn1);
  return foldExposing(scratch, 'SP_HALF_COMMIT_BIT', library, [
    { pin: fSel, isOutput: false, portName: 'selHold' },
    { pin: oSel, isOutput: false, portName: 'selAny' },
    { pin: fIn0, isOutput: false, portName: 'busBit' },
    { pin: fIn1, isOutput: false, portName: 'holdQ' },
    { pin: oIn0, isOutput: false, portName: 'passthrough' },
    { pin: oOut, isOutput: true, portName: 'out' },
  ]);
}

const spHalfCommitBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getSpHalfCommitBitChip(library: ChipLibrary): ChipDef {
  let def = spHalfCommitBitDefs.get(library);
  if (!def) {
    def = makeSpHalfCommitBitChip(library);
    spHalfCommitBitDefs.set(library, def);
  }
  return def;
}

/**
 * One bit of F's flag MUX cascade. Every layer is always present; call sites
 * idle unused sels (tie GND) for bits that skip a layer.
 */
function makeFFlagBitChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const muxDef = getMux2Chip(library);
  const placeMux = (x: number) => {
    const inst = makeChipInstance(scratch, muxDef, { x, y: 0 });
    return {
      sel: inst.pins[muxDef.ports[0]!]!,
      in0: inst.pins[muxDef.ports[1]!]!,
      in1: inst.pins[muxDef.ports[2]!]!,
      out: inst.pins[muxDef.ports[3]!]!,
    };
  };
  const muxes = Array.from({ length: 20 }, (_, i) => placeMux(i * 200));
  for (let i = 1; i < muxes.length; i++) {
    wire(scratch, muxes[i - 1]!.out, muxes[i]!.in0);
  }
  const selNames = [
    'selAlu', 'selR8', 'selAddHl', 'selRotAcc', 'selDaa', 'selLdBlock', 'selCpBlock', 'selInBlock', 'selOutBlock',
    'selNeg', 'selAdcSbcHl', 'selRrdRld', 'selInRc', 'selLdAIr', 'selBitReg', 'selBitHl', 'selBitIxIy', 'selCbRot', 'selExAfAf', 'selBus',
  ];
  const freshNames = [
    'aluFresh', 'r8Fresh', 'addHlFresh', 'rotAccFresh', 'daaFresh', 'ldBlockFresh', 'cpBlockFresh', 'inBlockFresh', 'outBlockFresh',
    'negFresh', 'adcSbcHlFresh', 'rrdRldFresh', 'inRcFresh', 'ldAIrFresh', 'bitRegFresh', 'bitHlFresh', 'bitIxIyFresh', 'cbRotFresh', 'fpOld', 'busBit',
  ];
  const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [];
  for (let i = 0; i < muxes.length; i++) {
    ports.push({ pin: muxes[i]!.sel, isOutput: false, portName: selNames[i]! });
  }
  ports.push({ pin: muxes[0]!.in0, isOutput: false, portName: 'holdQ' });
  for (let i = 0; i < muxes.length; i++) {
    ports.push({ pin: muxes[i]!.in1, isOutput: false, portName: freshNames[i]! });
  }
  ports.push({ pin: muxes[muxes.length - 1]!.out, isOutput: true, portName: 'out' });
  return foldExposing(scratch, 'F_FLAG_BIT', library, ports);
}

const fFlagBitDefs = new WeakMap<ChipLibrary, ChipDef>();
function getFFlagBitChip(library: ChipLibrary): ChipDef {
  let def = fFlagBitDefs.get(library);
  if (!def) {
    def = makeFFlagBitChip(library);
    fFlagBitDefs.set(library, def);
  }
  return def;
}

/**
 * Sequential left-associated OR of `n` inputs (n>=2). Ports: i0..i{n-1}, out.
 * Scratch uses nested OR stdcell instances (no gate placer on the scratch).
 */
function makeOrNChip(library: ChipLibrary, n: number, name: string): ChipDef {
  if (n < 2) throw new Error(`makeOrNChip: n must be >= 2, got ${n}`);
  const scratch = new Circuit();
  makeSource(scratch, 1);
  makeSource(scratch, 0);
  const orDef = getNamedGateChip(library, orChipDefs, 'OR', (lib) =>
    makeTwoInputGateChip(lib, 'OR', buildOr),
  );
  const inputs: Pin[] = [];
  let stage = placeTwoInputChip(scratch, orDef, { x: 0, y: 0 });
  inputs.push(stage.a, stage.b);
  for (let i = 2; i < n; i++) {
    const next = placeTwoInputChip(scratch, orDef, { x: (i - 1) * 200, y: 0 });
    wire(scratch, stage.out, next.a);
    inputs.push(next.b);
    stage = next;
  }
  return foldExposing(scratch, name, library, [
    ...inputs.map((pin) => ({ pin, isOutput: false })),
    { pin: stage.out, isOutput: true },
  ]);
}

const orNDefs = new WeakMap<ChipLibrary, Map<number, ChipDef>>();
function getOrNChip(library: ChipLibrary, n: number, name = `OR_N_${n}`): ChipDef {
  let byN = orNDefs.get(library);
  if (!byN) {
    byN = new Map();
    orNDefs.set(library, byN);
  }
  let def = byN.get(n);
  if (!def) {
    def = makeOrNChip(library, n, name);
    byN.set(n, def);
  }
  return def;
}

export interface ProgramCounter {
  d: Pin[];
  load: Pin;
  reset: Pin;
  clk: Pin;
  q: Pin[];
}

/**
 * An N-bit program counter: a register that increments its own value every
 * clock edge, except when `load` is high (captures `d` instead) or `reset`
 * is high (forces 0, taking priority over both — a real power-on/branch-
 * misprediction reset line, not something a caller has to bolt on with its
 * own OR/mux pair every time it needs one).
 *
 * The increment is a chain of half adders (see buildHalfAdder): bit i's `b`
 * input is bit i-1's carry-out, with bit 0's carry-in tied to a constant
 * 1 — the textbook way an incrementer differs from a general adder (no
 * second operand to supply, just "count one more"). Two 2:1 muxes per bit,
 * chained, pick the final value *before* it ever reaches the register, so
 * the register's own write-enable stays tied permanently high: every clock
 * edge writes something, the muxes decide what. The inner mux picks
 * increment-vs-`d` (gated by `load`); the outer mux picks that-vs-0 (gated
 * by `reset`) — `reset` sits in front of `load`, so it wins regardless of
 * what `load`/`d` are doing, exactly like a real reset line should.
 */
export function buildProgramCounter(parent: Circuit, library: ChipLibrary, bits: number, pos: Point = { x: 0, y: 0 }): ProgramCounter {
  const haDef = getHalfAdderChip(library);
  const muxDef = getMux2Chip(library);
  const reg = buildRegister(parent, library, bits, { x: pos.x + 800, y: pos.y });

  const incVcc = makeSource(parent, 1, { x: pos.x - 100, y: pos.y - 100 }).pins.out;
  const gnd = makeSource(parent, 0, { x: pos.x - 100, y: pos.y - 60 }).pins.out;
  wire(parent, incVcc, reg.we); // the mux chain (not WE) decides increment-vs-load-vs-reset; the register always writes

  const rowStep = Math.max(chipInstanceHeight(haDef.ports.length), chipInstanceHeight(muxDef.ports.length)) + 20;
  const d: Pin[] = [];
  let carry = incVcc; // bit 0's carry-in = 1: that's the "+1"
  let load!: Pin;
  let reset!: Pin;

  for (let i = 0; i < bits; i++) {
    const ha = makeChipInstance(parent, haDef, { x: pos.x, y: pos.y + i * rowStep });
    const haA = ha.pins[haDef.ports[0]!]!;
    const haB = ha.pins[haDef.ports[1]!]!;
    const haSum = ha.pins[haDef.ports[2]!]!;
    const haCout = ha.pins[haDef.ports[3]!]!;
    wire(parent, reg.q[i]!, haA);
    wire(parent, carry, haB);
    carry = haCout;

    const loadMux = makeChipInstance(parent, muxDef, { x: pos.x + 400, y: pos.y + i * rowStep });
    const loadSel = loadMux.pins[muxDef.ports[0]!]!;
    const loadIn0 = loadMux.pins[muxDef.ports[1]!]!;
    const loadIn1 = loadMux.pins[muxDef.ports[2]!]!;
    const loadOut = loadMux.pins[muxDef.ports[3]!]!;
    wire(parent, haSum, loadIn0); // load=0: take the incremented value
    d.push(loadIn1); // load=1: take the externally supplied value

    const resetMux = makeChipInstance(parent, muxDef, { x: pos.x + 900, y: pos.y + i * rowStep });
    const resetSel = resetMux.pins[muxDef.ports[0]!]!;
    const resetIn0 = resetMux.pins[muxDef.ports[1]!]!;
    const resetIn1 = resetMux.pins[muxDef.ports[2]!]!;
    const resetOut = resetMux.pins[muxDef.ports[3]!]!;
    wire(parent, loadOut, resetIn0); // reset=0: whatever the load mux picked
    tiePowerRail(parent, 'GND', resetIn1); // reset=1: force this bit to 0
    wire(parent, resetOut, reg.d[i]!);

    if (i === 0) {
      load = loadSel;
      reset = resetSel;
    } else {
      wire(parent, load, loadSel);
      wire(parent, reset, resetSel);
    }
  }

  return { d, load, reset, clk: reg.clk, q: reg.q };
}

/**
 * The instruction register. Deliberately *not* a new primitive: an IR is
 * structurally nothing but an 8-bit `buildRegister` — load on a WE&CLK
 * edge, hold otherwise, no increment/carry logic like `buildProgramCounter`
 * needs. Giving it its own name (rather than telling every caller to
 * remember "REG, 8 bits, wired to the data bus") is the only thing this
 * function is for.
 *
 * Width is fixed at 8, not a parameter: the Z80 opcode byte is always
 * 8 bits. Multi-byte instructions (the CB/ED/DD/FD-prefixed ones) are a
 * *sequencing* concern — the control FSM runs extra fetch cycles and
 * re-loads this same 8-bit IR each time — not a width concern, so widening
 * it here would be modeling the wrong layer.
 */
export function buildInstructionRegister(parent: Circuit, library: ChipLibrary, pos: Point = { x: 0, y: 0 }): Register {
  return buildRegister(parent, library, 8, pos);
}

export interface RingCounter {
  phase: Pin[]; // one-hot: phase[i] is high exactly during state i
  load: Pin;
  d: Pin[]; // external one-hot pattern to seed, when load=1
  clk: Pin;
}

/**
 * An N-phase one-hot control-FSM sequencer: every clock edge, the single
 * high `phase` bit rotates to the next position (`phase[i]` feeds
 * `phase[i+1]`, wrapping from the last phase back to phase 0). This is the
 * "T-state counter" a multi-cycle CPU's control unit is built around —
 * structurally a `buildRegister` with each bit's next value wired from its
 * predecessor's current value instead of from a half-adder chain, so unlike
 * `buildProgramCounter` it needs no arithmetic at all, just wiring.
 *
 * Like every register-based structure here, it has no power-on reset —
 * nothing makes it start at phase 0 on its own. The caller must explicitly
 * seed a one-hot pattern (e.g. `d = [1,0,...,0]`) through one `load=1` edge
 * before relying on the rotation, the same explicit-init discipline
 * `buildProgramCounter`'s own tests already require.
 */
export function buildRingCounter(parent: Circuit, library: ChipLibrary, phases: number, pos: Point = { x: 0, y: 0 }): RingCounter {
  if (phases < 2) throw new Error('a ring counter needs at least 2 phases');
  const muxDef = getMux2Chip(library);
  const reg = buildRegister(parent, library, phases, { x: pos.x + 400, y: pos.y });

  const incVcc = makeSource(parent, 1, { x: pos.x - 100, y: pos.y - 100 }).pins.out;
  wire(parent, incVcc, reg.we); // always writes; the muxes decide rotate-vs-load

  const rowStep = chipInstanceHeight(muxDef.ports.length) + 20;
  const d: Pin[] = [];
  let load!: Pin;

  for (let i = 0; i < phases; i++) {
    const mux = makeChipInstance(parent, muxDef, { x: pos.x, y: pos.y + i * rowStep });
    const muxSel = mux.pins[muxDef.ports[0]!]!;
    const muxIn0 = mux.pins[muxDef.ports[1]!]!;
    const muxIn1 = mux.pins[muxDef.ports[2]!]!;
    const muxOut = mux.pins[muxDef.ports[3]!]!;
    const prev = (i - 1 + phases) % phases;
    wire(parent, reg.q[prev]!, muxIn0); // load=0: rotate in from the previous phase bit
    d.push(muxIn1); // load=1: externally supplied one-hot pattern
    wire(parent, muxOut, reg.d[i]!);
    if (i === 0) load = muxSel;
    else wire(parent, load, muxSel);
  }

  return { phase: reg.q, load, d, clk: reg.clk };
}

/** Fold buildTriStateBuffer() into a reusable chip. Ports, in order: a, en, out. */
function makeTriBufChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);
  const buf = buildTriStateBuffer(scratch);
  // Match seedStandardCells TRI_BUF (a/en/out); default fold would name en as b.
  return foldExposing(scratch, 'TRI_BUF', library, [
    { pin: buf.a, isOutput: false, portName: 'a' },
    { pin: buf.en, isOutput: false, portName: 'en' },
    { pin: buf.out, isOutput: true, portName: 'out' },
  ]);
}

// See the identical reasoning on registerBitDefs above: buildStubRom caches
// its own TRI_BUF rather than assuming seedStandardCells() already
// registered one, so it works standalone in a library that never called it.
const triBufDefs = new WeakMap<ChipLibrary, ChipDef>();
function getTriBufChip(library: ChipLibrary): ChipDef {
  let def = triBufDefs.get(library);
  if (!def) {
    def = library.findByName('TRI_BUF') ?? makeTriBufChip(library);
    triBufDefs.set(library, def);
  }
  return def;
}

export interface StubRom {
  addr: Pin[];
  oe: Pin; // must be 1 for `data` to be driven onto the bus at all
  data: Pin[];
}

/**
 * Fixed hand-authored "ROM": `words[i]` (LSB-first bit array) is what reading
 * address `i` returns. No storage — each bit is a constant Source through a
 * TRI_BUF gated by (decoded word select) AND `oe`.
 *
 * Layout uses net labels for decoder/OE/data fanout (no wire spaghetti).
 * Stdcell chips (AND/NOT via placer) keep the parent readable when diving.
 */
export function buildStubRom(parent: Circuit, library: ChipLibrary, words: (0 | 1)[][], pos: Point = { x: 0, y: 0 }): StubRom {
  const wordCount = words.length;
  const addrBits = Math.log2(wordCount);
  if (!Number.isInteger(addrBits) || addrBits < 1) throw new Error('buildStubRom needs a power-of-two word count of at least 2');
  const dataBits = words[0]?.length ?? 0;
  if (!words.every((w) => w.length === dataBits)) throw new Error('buildStubRom: every word must be the same width');

  makeSource(parent, 1, { x: pos.x - 200, y: pos.y - 120 });
  makeSource(parent, 0, { x: pos.x - 200, y: pos.y - 80 });

  // Place AND/NOT as library chips so Stub ROM isn't a transistor carpet.
  setCircuitGatePlacer(parent, makeZ80GatePlacer(library));
  let oe: Pin | undefined;
  const data: Pin[] = [];
  try {
    const dec = buildDecoder(parent, addrBits, { x: pos.x, y: pos.y });

    // Name each decoder line once — every word's select AND ties to the same label.
    for (let w = 0; w < wordCount; w++) {
      tiePinToNet(parent, `STUB_DEC${w}`, dec.lines[w]!);
    }

    const bufDef = getTriBufChip(library);
    const bufRowStep = chipInstanceHeight(bufDef.ports.length) + 10;

    for (let bit = 0; bit < dataBits; bit++) {
      let dataAnchor: Pin | undefined;
      for (let w = 0; w < wordCount; w++) {
        const row = w * dataBits + bit;
        const gate = buildAnd(parent, { x: pos.x + 800, y: pos.y + row * 100 });
        tiePinToNet(parent, `STUB_DEC${w}`, gate.a);
        if (!oe) {
          oe = gate.b;
          tiePinToNet(parent, 'STUB_OE', oe);
        } else {
          tiePinToNet(parent, 'STUB_OE', gate.b);
        }
        const bitValue = makeSource(parent, words[w]![bit]!, {
          x: pos.x + 1050,
          y: pos.y + row * 100 - 20,
        }).pins.out;
        const buf = makeChipInstance(parent, bufDef, {
          x: pos.x + 1150,
          y: pos.y + row * bufRowStep,
        });
        wire(parent, buf.pins[bufDef.ports[0]!]!, bitValue);
        wire(parent, buf.pins[bufDef.ports[1]!]!, gate.out);
        const bufOut = buf.pins[bufDef.ports[2]!]!;
        tiePinToNet(parent, `STUB_DATA${bit}`, bufOut);
        if (!dataAnchor) dataAnchor = bufOut;
      }
      data.push(dataAnchor!);
    }

    // Catch any leftover long legs from the decoder tree.
    tidyLibraryCircuit(parent);

    return { addr: dec.addr, oe: oe!, data };
  } finally {
    setCircuitGatePlacer(parent, null);
  }
}

export interface MinimalCpu {
  clk: Pin; // drives PC/IR/ACC — see the doc comment for why this is deliberately not the same wire as `phaseClk`
  phaseClk: Pin; // drives only the FSM's own phase register
  reset: Pin; // PC's power-on reset (see buildProgramCounter) — pulse once, before ever pulsing phaseClk/clk
  fsmLoad: Pin;
  fsmD: Pin[]; // seed the FSM to phase 0 (e.g. [1, 0, 0]) through one fsmLoad=1 phaseClk edge, before relying on it
  pc: Pin[];
  ir: Pin[];
  acc: Pin[];
  phase: Pin[]; // one-hot: phase[0]=FETCH, phase[1]=INCREMENT, phase[2]=DECODE_EXECUTE
  ram: RamComponent;
}

/**
 * A complete, if deliberately tiny, working CPU: PC + RAM + IR + an
 * accumulator + an ALU, sequenced by a 3-phase FETCH / INCREMENT /
 * DECODE_EXECUTE ring counter. This is the payoff of every earlier slice —
 * nothing here is a new kind of primitive, it's `buildProgramCounter`,
 * `makeRam`, `buildInstructionRegister`, `buildRegister`, `buildAlu`,
 * `buildTriStateBuffer` and `buildRingCounter`, wired together exactly the
 * way "A control FSM: the fetch loop" (ARCHITECTURE.md) already proved
 * works, extended with one more phase that actually *does something with*
 * the fetched instruction instead of just fetching it.
 *
 * The instruction set is a deliberately tiny, made-up 8-slot encoding —
 * not real Z80 opcodes, which need a much larger decoder this slice
 * doesn't build yet (see ARCHITECTURE.md's "Decode and execute" for why,
 * and what a real opcode decoder would need on top of this):
 *
 *   bits 7-5 = 000: LDI imm    ACC <- bits 0-4 of the instruction (0-31)
 *   bits 7-5 = 001: ADI imm    ACC <- ACC + imm
 *   bits 7-5 = 010: ANI imm    ACC <- ACC & imm
 *   bits 7-5 = 011: ORI imm    ACC <- ACC | imm
 *   bits 7-5 = 100: XRI imm    ACC <- ACC ^ imm
 *   bits 7-5 = 101: STORE addr RAM[addr] <- ACC (ACC unchanged)
 *   bits 7-5 = 110: LOAD addr  ACC <- RAM[addr]
 *   bits 7-5 = 111: reserved   no-op: neither ACC nor RAM changes
 *
 * (`ANI`/`ORI`/`XRI` follow the 8080/Z80 assembly convention for
 * "AND/OR/XOR immediate" — the one place this made-up ISA's naming
 * deliberately echoes the real one it's a toy stand-in for.) STORE and
 * LOAD's target address is encoded in the same 5 low bits the ACC-writing
 * instructions use for their immediate, so `addrBits <= 5` — a RAM wider
 * than that has addresses STORE/LOAD simply cannot reach (FETCH, which
 * addresses RAM from PC directly, has no such limit).
 *
 * Decode is a real one-hot `buildDecoder` over all 3 opcode bits, not an
 * ad hoc gate tree — past 4 instructions, no single opcode bit splits the
 * encoding cleanly anymore (5 ACC-writing instructions vs. 3 others isn't
 * a power-of-two split any one bit can express the way `bit7` used to).
 * `dec.lines[0..6]` are `isLdi`/`isAdi`/`isAni`/`isOri`/`isXri`/`isStore`/
 * `isLoad` (`lines[7]`, the reserved pattern, is never referenced by
 * name — every control signal below is built from what an instruction
 * *should* do, so the reserved pattern is inert by simply matching none of
 * them, not by being checked for and excluded). From there:
 *
 * - **ALU op-select** (`alu.op0`/`op1`, matching `buildAluSlice`'s own
 *   00=ADD/01=AND/10=OR/11=XOR): `op0 = OR(isAni, isXri)`, `op1 =
 *   OR(isOri, isXri)`. ADI needs neither line, which is exactly what
 *   "both ORs default to 0" already gives it — no separate case needed.
 * - **ACC write-enable**: `phase2 AND OR(isLdi, isAdi, isAni, isOri, isXri,
 *   isLoad)` (a 6-input OR tree, since none of these lines share a single
 *   bit the way the old 4-instruction encoding's ACC-writers did — LOAD
 *   writes ACC too, from the bus rather than the ALU/imm, and belongs in
 *   this OR exactly as much as the other five; a version of this tree that
 *   omitted it left LOAD decoding correctly, RAM driving the bus
 *   correctly, and ACC simply never latching any of it — see the note
 *   below on how that was found).
 * - **Memory access**: `memSel = OR(isStore, isLoad)`; `storeNow =
 *   isStore AND phase2` drives `ram.we`; `loadNow = isLoad AND phase2` is
 *   ORed into `ram.oe` alongside FETCH's own phase-0 read (the two never
 *   overlap: FETCH only happens in phase 0, a LOAD's read only in
 *   phase 2).
 *
 * None of this needs its own clocked phase, for the same reason
 * `buildStubRom`'s address decode doesn't: nothing needs to be *captured*
 * merely from deciding what to do, only from actually doing it during
 * DECODE_EXECUTE.
 *
 * STORE and LOAD both need RAM's address bus to carry something other
 * than "PC" during their own DECODE_EXECUTE: a per-bit 2:1 mux, selected
 * by `memSel AND phase2`, picks between `pc.q` (every other case) and the
 * instruction's own embedded target address — both instructions read that
 * address the same way, the mux doesn't need to distinguish which one is
 * asking. A bank of `buildTriStateBuffer`s drives `ACC` onto the *same*
 * shared data bus `ram.data`/`ir.d` already share for fetches, enabled
 * only by `storeNow`, so it never contests RAM's own drive (RAM drives
 * during FETCH and LOAD, ACC drives during STORE — mutually exclusive by
 * phase and opcode, never two drivers live at once, the same discipline
 * `buildStubRom`'s decoder-gated banks rely on, just gated differently).
 *
 * `ACC`'s own next value is two chained 2:1 muxes, not one wider mux —
 * three genuinely different sources can land in ACC (`imm`, the ALU's
 * already-op-selected result, or the bus) and no single decoded bit ties
 * them into a clean 2-level tree the way `(bit7, bit6)` used to for 4
 * instructions. The first mux picks `imm` (`isLdi`) vs. the ALU's result
 * (everything else that writes ACC); the second overrides that with the
 * bus's current reading whenever `isLoad`. Neither stage's output is ever
 * latched for STORE or the reserved pattern (`accWeGate` is 0 for both),
 * so what they compute in those cases doesn't matter.
 *
 * PC holds during FETCH *and* DECODE_EXECUTE (self-looped, `load` tied to
 * NOT(phase[1])) and advances only during INCREMENT — the same "gate data,
 * not clock" hold trick "A control FSM" already established, just gating
 * on two of the three phases being "not phase 1" instead of one.
 */
export function buildMinimalCpu(
  parent: Circuit,
  library: ChipLibrary,
  addrBits: number,
  program?: Uint8Array,
  pos: Point = { x: 0, y: 0 },
): MinimalCpu {
  if (addrBits > 5) throw new Error('buildMinimalCpu: STORE/LOAD encode their target address in 5 bits, so addrBits must be <= 5');
  makeSource(parent, 1, { x: pos.x - 200, y: pos.y - 400 }); // rail driver
  makeSource(parent, 0, { x: pos.x - 200, y: pos.y - 360 });

  const pc = buildProgramCounter(parent, library, addrBits, { x: pos.x, y: pos.y });
  const ram = makeRam(parent, addrBits, 8, program, { x: pos.x + 1400, y: pos.y });
  const ir = buildInstructionRegister(parent, library, { x: pos.x + 2600, y: pos.y });
  const acc = buildRegister(parent, library, 8, { x: pos.x + 4600, y: pos.y });
  const alu = buildAlu(parent, library, 8, { x: pos.x + 3400, y: pos.y + 1200 });
  const fsm = buildRingCounter(parent, library, 3, { x: pos.x, y: pos.y + 2400 });
  const muxDef = getMux2Chip(library);
  const bufDef = getTriBufChip(library);

  // FETCH (phase 0): RAM drives the bus, IR captures it. (ram.pins.oe
  // itself is wired further below, once ORed with a LOAD's own read.)
  ramDataPins(ram).forEach((p, i) => wire(parent, p, ir.d[i]!));
  wire(parent, fsm.phase[0]!, ir.we);

  // PC holds during FETCH and DECODE_EXECUTE, advances only during INCREMENT.
  const notPhase1 = buildNot(parent, { x: pos.x - 200, y: pos.y - 200 });
  wire(parent, fsm.phase[1]!, notPhase1.in);
  wire(parent, notPhase1.out, pc.load);
  pc.q.forEach((q, i) => wire(parent, q, pc.d[i]!)); // self-loop: "reload" == hold

  // Decode. Past 4 instructions, no single opcode bit cleanly splits the
  // encoding in half anymore (5 ACC-writing instructions vs. 3 others
  // isn't a power-of-two split any bit can express) — this is a genuine
  // one-hot decoder over all 3 opcode bits, `buildDecoder` (already used
  // for `buildStubRom`'s addressing), not an ad hoc AND/OR/NOT tree.
  const dec = buildDecoder(parent, 3, { x: pos.x + 3200, y: pos.y - 500 });
  wire(parent, ir.q[5]!, dec.addr[0]!);
  wire(parent, ir.q[6]!, dec.addr[1]!);
  wire(parent, ir.q[7]!, dec.addr[2]!);
  const [isLdi, isAdi, isAni, isOri, isXri, isStore, isLoad] = dec.lines; // lines[7]: reserved, unused

  // The ALU's own op0/op1 (00 ADD, 01 AND, 10 OR, 11 XOR — see
  // buildAluSlice) read straight off which arithmetic instruction decoded:
  // op0=1 for AND or XOR, op1=1 for OR or XOR. ADI needs neither line high
  // (op=00=ADD already), so it drives nothing here — the two ORs already
  // default to 0 when isAni/isOri/isXri are all 0.
  const aluOp0 = buildOr(parent, { x: pos.x + 3600, y: pos.y - 500 });
  wire(parent, isAni!, aluOp0.a);
  wire(parent, isXri!, aluOp0.b);
  wire(parent, aluOp0.out, alu.op0);
  const aluOp1 = buildOr(parent, { x: pos.x + 3600, y: pos.y - 300 });
  wire(parent, isOri!, aluOp1.a);
  wire(parent, isXri!, aluOp1.b);
  wire(parent, aluOp1.out, alu.op1);
  tiePowerRail(parent, 'GND', alu.cin);
  acc.q.forEach((q, i) => wire(parent, q, alu.a[i]!));

  // ACC writes on DECODE_EXECUTE for any of the 5 ACC-writing instructions
  // (LDI/ADI/ANI/ORI/XRI) — a 4-input OR tree, since none of them share a
  // single bit the way the old 4-instruction encoding's LDI/ADI/LOAD did.
  const accWeOr1 = buildOr(parent, { x: pos.x + 3900, y: pos.y - 500 });
  wire(parent, isLdi!, accWeOr1.a);
  wire(parent, isAdi!, accWeOr1.b);
  const accWeOr2 = buildOr(parent, { x: pos.x + 3900, y: pos.y - 400 });
  wire(parent, isAni!, accWeOr2.a);
  wire(parent, isOri!, accWeOr2.b);
  const accWeOr3 = buildOr(parent, { x: pos.x + 3900, y: pos.y - 300 }); // XRI or LOAD — the two odd ones out of a 6-way OR
  wire(parent, isXri!, accWeOr3.a);
  wire(parent, isLoad!, accWeOr3.b);
  const accWeOr12 = buildOr(parent, { x: pos.x + 4100, y: pos.y - 450 });
  wire(parent, accWeOr1.out, accWeOr12.a);
  wire(parent, accWeOr2.out, accWeOr12.b);
  const accWeRaw = buildOr(parent, { x: pos.x + 4300, y: pos.y - 400 });
  wire(parent, accWeOr12.out, accWeRaw.a);
  wire(parent, accWeOr3.out, accWeRaw.b);
  const accWeGate = buildAnd(parent, { x: pos.x + 4500, y: pos.y - 450 });
  wire(parent, fsm.phase[2]!, accWeGate.a);
  wire(parent, accWeRaw.out, accWeGate.b);
  wire(parent, accWeGate.out, acc.we);

  const memSel = buildOr(parent, { x: pos.x + 3900, y: pos.y - 100 }); // STORE or LOAD, whichever it is
  wire(parent, isStore!, memSel.a);
  wire(parent, isLoad!, memSel.b);
  const memNow = buildAnd(parent, { x: pos.x + 4100, y: pos.y - 100 }); // memSel AND phase2: either one's own execute step
  wire(parent, memSel.out, memNow.a);
  wire(parent, fsm.phase[2]!, memNow.b);
  const storeNow = buildAnd(parent, { x: pos.x + 4200, y: pos.y + 100 }); // STORE only
  wire(parent, isStore!, storeNow.a);
  wire(parent, fsm.phase[2]!, storeNow.b);
  wire(parent, storeNow.out, ram.pins.we!);
  const loadNow = buildAnd(parent, { x: pos.x + 4200, y: pos.y + 300 }); // LOAD only
  wire(parent, isLoad!, loadNow.a);
  wire(parent, fsm.phase[2]!, loadNow.b);
  const ramOe = buildOr(parent, { x: pos.x + 4500, y: pos.y + 200 }); // FETCH's own read, OR a LOAD's
  wire(parent, fsm.phase[0]!, ramOe.a);
  wire(parent, loadNow.out, ramOe.b);
  wire(parent, ramOe.out, ram.pins.oe!);

  // RAM's address bus: PC, except during a STORE or LOAD's own
  // DECODE_EXECUTE, when it's the instruction's own embedded target
  // address instead — both share the same low 5 bits, reinterpreted by
  // whichever opcode is actually using them.
  ramAddrPins(ram).forEach((p, i) => {
    const mux = makeChipInstance(parent, muxDef, { x: pos.x + 700, y: pos.y - 300 - i * 100 });
    wire(parent, memNow.out, mux.pins[muxDef.ports[0]!]!); // sel
    wire(parent, pc.q[i]!, mux.pins[muxDef.ports[1]!]!); // in0: normal — address from PC
    wire(parent, ir.q[i]!, mux.pins[muxDef.ports[2]!]!); // in1: STORE/LOAD — address embedded in the instruction
    wire(parent, mux.pins[muxDef.ports[3]!]!, p);
  });

  // ACC's own next value: imm = ir.q[0..4] with bits 5-7 forced to 0 (a
  // 5-bit immediate — 3 opcode bits leave less room than the 4-instruction
  // encoding's 6 did). Two chained 2:1 muxes, since three genuinely
  // different sources can end up in ACC and no single decoded bit ties
  // them into a clean 2-level tree the way (bit7, bit6) used to: the first
  // picks `imm` (LDI) vs the ALU's already-op-selected result (ADI/ANI/
  // ORI/XRI); the second overrides that with the shared bus's current
  // reading whenever this is a LOAD. Neither mux's output is ever latched
  // for STORE or the reserved pattern (`accWeGate` is 0 for both), so
  // what each computes for them doesn't matter.
  for (let i = 0; i < 8; i++) {
    const imm = i < 5 ? ir.q[i]! : railPin(parent, 'GND', { x: pos.x + 4000, y: pos.y + i * 100 });
    wire(parent, imm, alu.b[i]!);

    const stage1 = makeChipInstance(parent, muxDef, { x: pos.x + 4000, y: pos.y + i * 100 });
    wire(parent, isLdi!, stage1.pins[muxDef.ports[0]!]!); // sel
    wire(parent, alu.out[i]!, stage1.pins[muxDef.ports[1]!]!); // in0: ADI/ANI/ORI/XRI
    wire(parent, imm, stage1.pins[muxDef.ports[2]!]!); // in1: LDI
    const stage2 = makeChipInstance(parent, muxDef, { x: pos.x + 4700, y: pos.y + i * 100 });
    wire(parent, isLoad!, stage2.pins[muxDef.ports[0]!]!); // sel
    wire(parent, stage1.pins[muxDef.ports[3]!]!, stage2.pins[muxDef.ports[1]!]!); // in0: stage1's result
    wire(parent, ir.d[i]!, stage2.pins[muxDef.ports[2]!]!); // in1: LOAD — the freshly-read bus value
    wire(parent, stage2.pins[muxDef.ports[3]!]!, acc.d[i]!);

    // STORE: drive ACC onto the shared data bus, enabled only while storing.
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 5600, y: pos.y + i * 100 });
    wire(parent, acc.q[i]!, buf.pins[bufDef.ports[0]!]!); // a
    wire(parent, storeNow.out, buf.pins[bufDef.ports[1]!]!); // en
    wire(parent, buf.pins[bufDef.ports[2]!]!, ir.d[i]!); // out, onto the same bus ir.d/ram.data already share
  }

  // Two non-overlapping clocks — see "A control FSM: the fetch loop" for
  // why the FSM's own phase transition and the datapath registers it
  // gates can never safely share one edge in this solver.
  wire(parent, pc.clk, ir.clk);
  wire(parent, pc.clk, acc.clk);
  wire(parent, pc.clk, ram.pins.clk!);

  return { clk: pc.clk, phaseClk: fsm.clk, reset: pc.reset, fsmLoad: fsm.load, fsmD: fsm.d, pc: pc.q, ir: ir.q, acc: acc.q, phase: fsm.phase, ram };
}

export interface Z80Decoder {
  x: Pin[]; // one-hot, 4 lines — bits 7-6 as a 2-bit number
  y: Pin[]; // one-hot, 8 lines — bits 5-3 as a 3-bit number
  z: Pin[]; // one-hot, 8 lines — bits 2-0 as a 3-bit number
}

/**
 * The real Z80's own opcode decomposition — not this project's made-up
 * `buildMinimalCpu` encoding, but the canonical `xxyyyzzz` bit grouping
 * every Z80/8080 disassembler and reference (e.g. z80.info/decoding.htm)
 * decodes an opcode byte into: `x` (bits 7-6) picks which broad instruction
 * group an opcode belongs to, `y` (bits 5-3) and `z` (bits 2-0) mean
 * different things *within* each `x` group (register, ALU operation,
 * condition code, ..., depending on which group). This function does
 * exactly the field extraction and nothing else — three `buildDecoder`
 * calls (2 bits for `x`, 3 each for `y`/`z`), producing one-hot lines for
 * each field's every possible value. What those lines *mean* is entirely
 * up to the caller; `buildZ80Cpu` below wires two groups (`x=10`, the
 * ALU-on-register instructions, and `x=01`, `LD r,r'`) up to real
 * execution.
 *
 * Verified directly against real, well-known opcode bytes in
 * `blocks.test.ts` (`0x80`=`ADD A,B`, `0xA7`=`AND A`, `0xBE`=`CP (HL)`,
 * ...) rather than just against this function's own derivation — the
 * whole point of building this is that it matches real Z80 silicon, not
 * just its own internally-consistent logic.
 */
export function buildZ80Decoder(parent: Circuit, opcode: Pin[], pos: Point = { x: 0, y: 0 }): Z80Decoder {
  if (opcode.length !== 8) throw new Error('buildZ80Decoder needs an 8-bit opcode');
  makeSource(parent, 1, { x: pos.x - 200, y: pos.y - 120 }); // rail driver
  makeSource(parent, 0, { x: pos.x - 200, y: pos.y - 80 });

  const decX = buildDecoder(parent, 2, { x: pos.x, y: pos.y });
  wire(parent, opcode[6]!, decX.addr[0]!); // bit6: x's own LSB
  wire(parent, opcode[7]!, decX.addr[1]!); // bit7: x's own MSB

  const decY = buildDecoder(parent, 3, { x: pos.x, y: pos.y + 400 });
  wire(parent, opcode[3]!, decY.addr[0]!);
  wire(parent, opcode[4]!, decY.addr[1]!);
  wire(parent, opcode[5]!, decY.addr[2]!);

  const decZ = buildDecoder(parent, 3, { x: pos.x, y: pos.y + 1000 });
  wire(parent, opcode[0]!, decZ.addr[0]!);
  wire(parent, opcode[1]!, decZ.addr[1]!);
  wire(parent, opcode[2]!, decZ.addr[2]!);

  return { x: decX.lines, y: decY.lines, z: decZ.lines };
}

export interface Z80Cpu {
  clk: Pin; // drives PC/IR/A/the register file — see the doc comment for why this is deliberately not the same wire as `phaseClk`
  phaseClk: Pin; // drives only the FSM's own phase register
  reset: Pin; // PC's power-on reset — pulse once, before ever pulsing phaseClk/clk
  aReset: Pin; // A's own power-on reset (forces 0) — see the doc comment on why A needs one and PC's own reset doesn't cover it
  fsmLoad: Pin;
  fsmD: Pin[]; // seed the FSM to phase 0 (e.g. [1, 0, 0]) through one fsmLoad=1 phaseClk edge, before relying on it
  pc: Pin[];
  ir: Pin[];
  a: Pin[]; // accumulator ("A") output — its own d/we are driven internally by decoded instructions, not exposed
  rB: Register; // B/C/D/E/H/L: `d`/`we` here are a *seed* path only — LD r,r' (x=01) can now also write these internally; see the doc comment for the mux-ahead-of-d treatment that keeps the two from fighting over one sink pin
  rC: Register;
  rD: Register;
  rE: Register;
  rH: Register;
  rL: Register;
  f: Pin[]; // flags (S Z - H - P/V N C, real Z80 bit order) — driven internally by ADD/SUB/AND/XOR/OR/CP and by POP AF; see the doc comment on flags below
  aP: Register; // A' — real Z80's own shadow accumulator, same *seed*-path contract as rB..rL: external d/we seed its first value, EX AF,AF' drives it internally from then on (see "x=00: EX AF,AF'")
  fP: Register; // F' — A''s own shadow flags, identical contract
  rI: Pin[]; // I — interrupt vector base (q only); LD I,A / LD A,I (see "x=01, z=7, y=0..3"). No external seed — program `LD I,A` is the write path (avoids a floating we on every pre-existing test).
  rR: Pin[]; // R — refresh counter (q only); LD R,A / LD A,R; auto-inc on M1 (PHASE0 fetch / prefix second byte), bit7 sticky — soft bumpR parity.
  rIXH: Register; // IX high — seed-path contract like rB; DD LD IX,nn / POP IX write internally (see "DD: IX")
  rIXL: Register; // IX low — same contract
  rIYH: Register; // IY high — seed-path contract like rIXH; FD LD IY,nn / POP IY write internally (see "FD: IY")
  rIYL: Register; // IY low — same contract
  iff1: Pin[]; // IFF1 (q only) — EI-commit/DI/INT-accept/NMI-accept/RETI/RETN write it; no external seed (same contract as rI)
  iff2: Pin[]; // IFF2 (q only) — EI-commit/DI/INT-accept write it; RETI/RETN copy iff2→iff1; NMI leaves it
  im0: Pin[]; // IM 0 latch (q only) — `ED 0x46`/`0x66` sets it (clears im1/im2)
  im1: Pin[]; // IM 1 latch (q only) — `ED 0x56`/`0x76` sets it (clears im0/im2)
  im2: Pin[]; // IM 2 latch (q only) — `ED 0x5E`/`0x7E` sets it (clears im0/im1); gate accept + vector→PC
  /** HALT latch (q only) — set by opcode 0x76; cleared by INT/NMI accept / CPU_RESET. */
  halted: Pin[];
  int: Pin; // maskable-INT net (active high), driven by the internal `intDrive` Input (defaults to 0)
  intDrive: { value: 0 | 1 }; // raise/clear INT by writing `.value` (same Input contract clocks use)
  nmi: Pin; // non-maskable-INT net (active high), driven by internal `nmiDrive` (defaults to 0)
  nmiDrive: { value: 0 | 1 }; // pulse/raise NMI via `.value` (edge-sampled at PHASE0)
  /** INTACK data-bus sample for IM0/IM2; eight Inputs defaulting to 1 → 0xFF. */
  irqBusDrive: { value: 0 | 1 }[];
  bP: Register; // B'/C'/D'/E'/H'/L' — EXX's own shadow register-pair set, identical seed-path contract (see "x=11: EXX")
  cP: Register;
  dP: Register;
  eP: Register;
  hP: Register;
  lP: Register;
  sp: Register; // stack pointer — same seed-path contract as rB..rL: external d/we seed its first value, PUSH/POP/RET/RST drive it internally from then on
  phase: Pin[];
  ram: RamComponent;
  // A minimal I/O-port concept, invented for IN A,(n)/OUT (n),A (see
  // "x=11: IN A,(n) / OUT (n),A") — this simulator never needed one
  // before. `ioPortAddr`/`ioPortDataOut` are live output taps (the bus,
  // and A, respectively), valid only while `ioRead`/`ioWrite` is high;
  // `ioPortDataIn` is a genuine external sink, the identical contract
  // `Register.d` already uses — a caller's own device drives it, this file
  // never does. Port address is 16-bit Soft parity: low = bus/`n`/`C`,
  // high = `A` (imm) or `B` (IN/OUT (C) / block). Lab LED still matches low 8.
  ioPortAddr: Pin[];
  ioPortDataOut: Pin[];
  ioPortDataIn: Pin[];
  ioRead: Pin;
  ioWrite: Pin;
  /** Classical bus control (active-high): IORQ = I/O strobes ∨ INTACK window. */
  iorq: Pin;
  /** M1 ≈ opcode/prefix fetch (PHASE0 ∨ PREFIX_READ) ∨ INTACK (IORQ∧M1). */
  m1: Pin;
  /** RD ≈ RAM OE ∨ ioRead (INTACK samples without RD). */
  rd: Pin;
  /** WR ≈ RAM WE ∨ ioWrite. */
  wr: Pin;
  /** MREQ ≈ (RAM OE ∨ RAM WE) ∧ ¬IORQ. */
  mreq: Pin;
  /** Nested 4-T bus cycle busy — instruction ring held while high. */
  busBusy: Pin;
}

/**
 * A second tiny CPU, alongside `buildMinimalCpu` — this one executes real
 * Z80 opcodes, not a made-up encoding, for two opcode groups: `x=10` (the
 * ALU-operation-on-a-register group, real opcodes `0x80`-`0xBF`) and `x=01`
 * (`LD r,r'`, real opcodes `0x40`-`0x7F`, register-to-register and
 * register<->`(HL)` moves — including `HALT` at `0x76`, which latches
 * `halted` rather than pretending to be `LD (HL),(HL)`). Built from
 * exactly the same pieces `buildMinimalCpu` already proved out (PC/RAM/IR,
 * a 3-phase FETCH/INCREMENT/DECODE_EXECUTE `buildRingCounter`,
 * `buildTriStateBuffer` banks sharing one bus) plus `buildZ80Decoder` for
 * genuine `x`/`y`/`z` field extraction and a real 6-register file
 * (B/C/D/E/H/L) alongside the accumulator.
 *
 * This is deliberately a *second* composite, not a replacement for
 * `buildMinimalCpu`: the toy ISA's entire byte space is already spoken for
 * by LDI/ADI/ANI/ORI/XRI/STORE/LOAD/reserved (see "Decode and execute"),
 * and reusing those same opcode bytes for real Z80 semantics would mean
 * redesigning that whole instruction set, not adding to it. Keeping them
 * separate lets each make its own point cleanly: `buildMinimalCpu` shows
 * the FETCH/DECODE/EXECUTE *mechanism* works; this shows the same
 * mechanism decoding and executing *real* Z80 opcode bytes.
 *
 * **`x=10` (ALU-on-register) — what `y`/`z` mean:**
 *
 * ```
 * y: 000 ADD  001 ADC  010 SUB  011 SBC  100 AND  101 XOR  110 OR  111 CP
 * z: 000 B    001 C    010 D    011 E    100 H    101 L    110 (HL) 111 A
 * ```
 *
 * `ADD`/`AND`/`XOR`/`OR` map straight onto the ALU's own `op0`/`op1`
 * select (see `buildAluSlice`: 00 ADD, 01 AND, 10 OR, 11 XOR). `SUB` reuses
 * ADD's own mode (`op0=op1=0`) with the operand bitwise-inverted and
 * `cin` forced to 1 — the standard two's-complement trick, needing one XOR
 * stage ahead of the existing adder, not a new ALU mode. `ADC`/`SBC`
 * (`y=1,3` — see "x=10: ADC/SBC" below) reuse that same adder a third and
 * fourth way: `ADC` is `ADD` with `cin` fed from `F`'s own `C` instead of a
 * hardcoded 0; `SBC` is `SUB` the identical way, `cin` fed from `C`
 * inverted instead of forced to 1. Both were genuinely undoable until a
 * real flags register existed to route `C` from at all — once one did,
 * wiring them up cost nothing new: no new adder, no new op-select, just a
 * fresh `cin` source. `CP` (`y=7`) never writing `A` isn't a simplification
 * at all — real Z80 `CP` only sets flags and leaves `A` alone regardless,
 * so excluding `y=7` from what writes `A` is just correct.
 *
 * **`x=01` (`LD r,r'`) — what `y`/`z` mean:**
 *
 * ```
 * y/z (same 8-way encoding as x=10's z): 000 B  001 C  010 D  011 E
 *                                         100 H  101 L  110 (HL) 111 A
 * ```
 *
 * Here `y` is the *destination*, `z` the *source* — `LD y,z` copies `z`'s
 * value into `y`, one real move, no arithmetic. `y=110,z=110` (opcode
 * `0x76`) is the one hole in this otherwise-complete 8x8 grid: real Z80
 * silicon special-cases that exact byte as `HALT` rather than the
 * pointless "read a byte from memory and write the same byte back" a
 * literal `LD (HL),(HL)` would be. This slice matches that: `ramWriteNow`
 * (below) explicitly excludes `z=110`, and a separate `haltNow` latch
 * sets `halted` so the machine runner can stop the clock (INT-accept /
 * `CPU_RESET` clear it again).
 *
 * `LD (HL),r` is this slice's first instruction that *writes* RAM —
 * `ram.pins.we` was hardwired to `gnd` ("read-only") before this group
 * existed; it's now `ramWriteNow = AND(ldGroupNow, y=110, NOT(z=110))`.
 * `LD r,(HL)` (memory into a register) needs no new RAM-write plumbing —
 * it's a read, covered by `hlNow`, redefined below to fire whenever
 * *either* group's `z` says `(HL)`, not just `x=10`'s.
 *
 * **What's shared between the two groups:** `groupActive =
 * OR(AND(x=10,phase2), AND(x=01,phase2))` replaces the old `aluGroupNow`
 * everywhere something needs to know "one of the groups this slice
 * executes is in its own DECODE_EXECUTE right now" rather than specifically
 * the ALU one: the 7 register-source `buildTriStateBuffer` banks (a source
 * read is a source read, whether it's about to be ALU'd or just moved),
 * `hlNow`, and — critically — `ramOe`'s FETCH-term exclusion. That
 * exclusion (`AND(phase0, NOT(...))`) exists at all because of a real bug
 * found building the `x=10`-only version — a ring counter's rotation
 * transiently overlaps adjacent phase bits, and any phase-2-gated signal
 * that can drive the shared bus races RAM's own FETCH read for it unless
 * excluded (see "A real Z80 decoder" in ARCHITECTURE.md for the full
 * post-mortem) — generalizing it to `groupActive` keeps that fix covering
 * *every* bus driver this slice has, not just the one that existed when
 * the fix was first written.
 *
 * `z=110` (`(HL)`) is real Z80 memory-indirect addressing — the operand is
 * the byte at the address held in registers H and L, not a register at
 * all. Address bits `0..7` come from `L`; bits `8..addrBits-1` come from
 * `H` (same split `JP (HL)` / `ADD HL,rr` already use). When
 * `addrBits <= 8`, only `L` participates — the historical small-RAM
 * convention. `BC`/`DE` register-indirect addressing uses the same
 * low/high split (`C`/`B`, `E`/`D`).
 *
 * All eight `z` sources — six registers, `(HL)`, and `A` itself — share
 * one bus (the same `ir.d`/`ram.data` pins `buildMinimalCpu` already
 * reuses for fetches): a `buildTriStateBuffer` bank per register source,
 * each enabled by `AND(groupActive, that source's own z line)`, plus RAM's
 * own `oe` (already tri-stated) for `(HL)`. Since `z` is one-hot by
 * construction and `groupActive` is only ever true during one of these two
 * groups' own DECODE_EXECUTE, at most one driver is ever live — the
 * identical bus discipline "Buses" documents for `buildStubRom`'s
 * decoder-gated banks, reused with opcode fields standing in for a memory
 * decoder's address lines.
 *
 * **Writing a destination that isn't always `A`:** `x=10` only ever writes
 * `A`. `x=01` can write *any* of the 7 non-memory registers, decoded from
 * `y`. `B`/`C`/`D`/`E`/`H`/`L` used to have no internal writer at all —
 * their raw `d`/`we` were bare sink pins for the caller to seed directly.
 * Now that `LD r,r'` needs to write them too, each gets the same "mux
 * ahead of `d`, OR into `we`" treatment `aReset` already established for
 * `A`: a 2:1 mux per bit (`sel` = that register's own `AND(ldGroupNow,
 * y=<its line>)`, `in0` = a *new* external seed pin — what a caller now
 * sees as this `Register`'s own `d` — `in1` = the bus), and `we` =
 * `OR(external seed we, that same ld-write-enable)`. The raw
 * `buildRegister`'s own `d`/`we` are fully internal from here on — exposing
 * them directly, the way the pre-`LD` version did, would mean a caller's
 * seed wire and this new internal write path fighting over the same sink
 * pin the instant both are live, exactly the "own your sink pins" failure
 * "Buses" documents the consequence of. `A` needs its own one-shot
 * `aReset` (see the doc comment further down, next to where it's built)
 * for a reason PC's own `reset` doesn't cover: the `x=10` group reads
 * `alu.a = a.q` on every executed operation, and neither group has an
 * `LDI`-style "set from an immediate" instruction — without some way to
 * force a first real value, `A` would stay undefined forever. `A` gets an
 * analogous but distinct treatment for `LD`: a mux ahead of the *existing*
 * `alu.out`-vs-`gnd` reset mux, selecting `alu.out` vs the bus by `isLdA =
 * AND(ldGroupNow, y=111)`, with `isLdA` ORed into `a.we` alongside the ALU
 * group's own `aWe` — not a seventh copy of the register-file treatment,
 * since `A`'s `d`/`we` were never externally exposed to begin with.
 *
 * **Flags (`F`):** computed from `alu.out`/`alu.cout` for every op the
 * `x=10` group actually executes, *plus* `CP` (`y=111`) — `CP` never writes
 * `A`, but real `CP` DOES write flags (it's "subtract, discard the result,
 * keep only what it tells you"), and this is the first turn that gives it
 * anywhere to write them. `isSubtract = OR(y=010, y=111)` (SUB or CP) feeds
 * `alu.cin`/the per-bit invert exactly like the old SUB-only `isSub` did,
 * just widened. Bits, real Z80 order (`S Z - H - P/V N C`): `C` =
 * `XOR(alu.cout, isSubtract)` (adder carry for ADD, borrow-inverted for
 * SUB/CP — the standard two's-complement convention), forced 0 for
 * AND/OR/XOR (their `cout` is real but electrically meaningless — see
 * `buildAluSlice`'s own doc comment — real Z80 always clears C for logic
 * ops anyway); `Z` = NOR of all 8 `alu.out` bits; `P/V` is parity for
 * AND/OR/XOR, signed arithmetic overflow for ADD/ADC/SUB/SBC/CP — see
 * "P/V is two flags, not one" further down for the derivation; `S` =
 * `alu.out[7]`, wired straight through; `N` = `isSubtract`, straight
 * through. `H` (half-carry, bit 4) and the two undocumented bits (3/5)
 * are real now too — see "Closing the half-carry gap: H, the two
 * undocumented bits, and DAA" further down for their derivation, and for
 * `DAA` itself, added in the same pass once a genuine `H` existed to
 * read. `P/V` picking parity vs. overflow by which op ran (`pvMux`,
 * gated by the identical `cIsArith` `C`/`H` already reuse) is a later
 * addition still — see "P/V is two flags, not one" further down.
 *
 * **`x=11`: `SP`, `PUSH`/`POP`, `RET`, `RST n`.** `CALL nn`/`JP nn` (real
 * 3-byte instructions — an opcode byte plus a 16-bit immediate) aren't
 * implemented: every instruction so far is exactly one byte, and reading
 * an operand *after* the opcode needs the FETCH/INCREMENT/EXEC cycle
 * itself extended to conditionally read more bytes — a real piece of
 * follow-up work, not attempted here. `RST n` (`z=111`, target = `y*8`,
 * one of 8 fixed addresses `0x00`-`0x38`) gives the *mechanism* — push a
 * return address, jump — a real, if narrower, form to prove out first.
 *
 * `PUSH`/`POP rp` (`z=101`/`z=001`, `rp` = `y`'s own value restricted to
 * `y=000,010,100,110` selecting `BC`/`DE`/`HL`/`AF`) move a genuine 8-bit
 * *register pair* — two independent registers, e.g. `B` and `C` — through
 * memory. Since this slice's RAM has one address bus and writes one byte
 * per clock edge, moving two independently-valued bytes fundamentally
 * needs two sequential memory cycles; there is no way around this with an
 * 8-bit-wide bus, real hardware included. That's what the FSM's 4th
 * phase (`buildRingCounter(..., 4, ...)`, not 3) is for: `EXEC1`
 * (`phase[2]`, same phase `x=10`/`x=01` already use) writes/reads the
 * *high* byte (`B`/`D`/`H`/`A`), `EXEC2` (`phase[3]`, new) the *low* byte
 * (`C`/`E`/`L`/`F`) — real Z80 stack-push order, so a `POP` later reads
 * them back the same way it wrote them. `EXEC2` is a genuine no-op for
 * every `x=10`/`x=01` instruction (their own logic only ever checks
 * `phase[2]`), so this costs those instructions one "wasted" `phaseClk`
 * pulse per instruction now, uniformly — a real, documented simplification
 * (real hardware uses variable M-cycle counts per instruction; this slice
 * uses a fixed phase count per instruction for architectural simplicity).
 *
 * `RET` only ever needs `EXEC1` — not because it's a simpler mechanism,
 * but because of a scale coincidence specific to this slice: `PC` is only
 * `addrBits` wide (every test so far uses 4-6 bits, nowhere near real
 * Z80's 16), so a return address fits in *one* stack byte instead of the
 * two a real 16-bit `PC` would need. `RET` (`z=001,y=001` — the one entry
 * in `POP`'s own `z=001` column that isn't a `POP`) reads that one byte
 * off the stack straight into `PC`, on `EXEC1`. `RST n` needs *both*
 * phases, though, and NOT because the push itself is two bytes (it isn't
 * — same one-byte-PC coincidence as `RET`): it writes `PC`'s *current*
 * value (already past its own opcode — `INCREMENT` runs before `EXEC1`,
 * same as every other instruction) to the stack on `EXEC1`, then loads
 * `PC` with the fixed target on `EXEC2` — a *separate* edge from the push,
 * on purpose. The first version did both on the same `EXEC1` edge; found
 * live, that raced `PC`'s own jump against the push-data driver reading
 * `PC` for what to write, and — per the addressing doc comment below,
 * where a real write in this design always samples the fully-settled,
 * post-edge state — RAM ended up with the *jump target* pushed, not the
 * return address, so a subsequent `RET` landed right back at the `RST`
 * target instead of resuming after it.
 *
 * `SP` decrements for `PUSH`/`RST` (stack grows down), increments for
 * `POP`/`RET`, one step per `EXEC1`/`EXEC2` it's actually involved in — via
 * `spAdder`, a *second* `buildAlu` instance (width `addrBits`, not 8) in
 * permanent ADD mode with `b` fanned from one shared decrement/increment
 * control line to every bit: `b=0,cin=1` computes `SP+1`; `b`=all-1s
 * (already the complete two's-complement encoding of `-1`, needing no
 * extra `+1` on top) pairs with `cin=0` — NOT `cin=1`, which would add one
 * too many and silently wrap straight back to the original value — to
 * compute `SP-1`. Reuses the proven ripple-carry ADD path rather than
 * hand-building a fresh adder.
 *
 * Addressing the stack — both the write side (`PUSH`/`RST`) and the read
 * side (`POP`/`RET`) — uses bare `sp.q`, no adder, for either direction.
 * That this is correct for BOTH at once is a real, subtle asymmetry this
 * solver has between its one behavioral component and everything built
 * from real transistors: RAM (the deliberate non-transistor exception)
 * commits its write using the address as fully settled, by which point
 * `sp.q` already reflects its post-this-edge (new) value — exactly a
 * write's target. A real register's capture (`buildDFlipFlop`, master-
 * slave) works the opposite way — its master closes based on whatever was
 * stable *before* this edge started, not whatever the circuit eventually
 * settles to during it — so a register capturing a byte read *through*
 * `sp.q` (POP/RET) sees the *old*, not-yet-incremented value, exactly a
 * read's target. See the doc comment on the address mux itself, further
 * down, for the full derivation and the two wrong turns (a dedicated "-1"
 * adder for reads; suspecting insufficient relaxation depth) taken before
 * landing on this.
 *
 * **A bus-fight this design deliberately avoids, not one it was debugged
 * into:** `PUSH BC`'s own opcode byte has `z=101` — which, read as *this
 * slice's other* z-encoding (the one `x=10`/`x=01`'s operand bus uses),
 * means "`L`." Widening the operand bus's own enable signal
 * (`groupActive`) to also cover the stack family would let `L`'s
 * tri-state bank fire during a `PUSH`, fighting the new push-byte-select
 * banks over the same wire — so `groupActive` stays narrow (`x=10`/`x=01`
 * only, unchanged from before this turn), and a separate, wider
 * `busActive` (`groupActive` OR "the stack family is in `EXEC1`/`EXEC2`
 * right now") exists *only* to gate FETCH's own read exclusion, where the
 * question genuinely is "is anything at all touching the shared bus."
 * Within the stack family itself, the high-byte and low-byte push banks
 * (`EXEC1` vs `EXEC2`) get the identical `NOT(sibling)` structural
 * exclusion `ramOe`'s own fix (below) already established — the ring
 * counter's phase bits transiently overlap on *every* rotation, `phase[2]`
 * and `phase[3]` included, not just `phase[0]`/`phase[2]`.
 *
 * **`x=00`, `z=3`: `INC rr`/`DEC rr`.** The first `x=00` opcodes this slice
 * executes — real `0x03`/`0x0B` (`BC`), `0x13`/`0x1B` (`DE`), `0x23`/`0x2B`
 * (`HL`), `0x33`/`0x3B` (`SP`), one instruction per direction per pair,
 * `y>>1` selecting the pair and `y`'s own low bit selecting `INC` (even) vs
 * `DEC` (odd) — chosen for the same reason `RST` was chosen over `CALL nn`
 * for `x=11`: it needs no new FSM phase and no immediate-byte fetch (both
 * genuinely bigger changes — see Known Simplifications), and real Z80
 * affects *no flags at all* for this family (unlike `INC`/`DEC r`, the
 * 8-bit sibling this doesn't implement), so nothing here touches `F`.
 * Single-cycle, `EXEC1` only, same as `x=10`/`x=01` — the 16-bit result is
 * available combinationally the instant the operand is, no second phase
 * needed the way `PUSH`/`POP`'s own two *independent* bytes required one.
 *
 * `BC`/`DE`/`HL` each get their own dedicated `buildAlu` instance (width
 * 16, not 8 — `spAdder` above is the identical pattern at `addrBits` width
 * for `SP` alone) rather than sharing one muxed adder: three separate,
 * always-computing adders, gated only at the write-back stage
 * (`INCDEC_BC_NOW`/`INCDEC_DE_NOW`/`INCDEC_HL_NOW`), mirroring `spAdder`'s
 * and `alu`'s own "always compute, gate the commit" philosophy rather than
 * adding an input-selection mux that would need its own correctness check.
 * Each pair's high register (`B`/`D`/`H`) occupies bits `[8..15]`, the low
 * one (`C`/`E`/`L`) `[0..15]` — the same high/low convention `PUSH`/`POP`'s
 * own byte order already established. `b`/`cin` reuse `spAdder`'s exact
 * `-1`/`+1` trick (see above for the full derivation and the `cin`
 * off-by-one it guards against): the pair's own `DEC` `y`-line fans to
 * every `b` bit, `cin` is that line inverted.
 *
 * The write-back itself layers a *third* mux-ahead-of-`d` stage
 * (`wrapWithPairCommit`) on top of the existing LD-r,r'/POP wrapper
 * (`ldExternal`) each of `B`/`C`/`D`/`E`/`H`/`L` already has — not a
 * competing rewrite of it. The three sources (external seed, LD/POP's bus
 * capture, this pair's own `+-1`) never fire in the same cycle regardless
 * of layering order: `dec.x` one-hot decodes exactly one `x` value per
 * opcode, so `x=00`'s `INC`/`DEC rr` and `x=01`/`x=11`'s own conditions are
 * mutually exclusive by construction, the same guarantee `A`'s own
 * two-layer `aWeStage`/`aWeFinal` (above) already relies on.
 *
 * `SP` reuses `spAdder` itself rather than getting a fourth adder: `INC
 * SP`/`DEC SP` want the exact same `+-1` operation `PUSH`/`POP`/`RET`/`RST`
 * already drive it with, just for a different *reason*. `spWantDec` widens
 * the original `STACK_WRITE_NOW`-only direction control with
 * `DEC_SP_NOW` (this instruction's own explicit `DEC SP`) via a plain
 * `OR` — with `DEC_SP_NOW=0` (every `x=11` case, and every `x=00` case
 * except `DEC SP` itself) this is exactly the original signal, unchanged;
 * the two conditions can never both be `1` at once for the identical
 * one-hot-`x` reason the paragraph above gives. `spAluActive` (also an
 * `OR`, widening `stackActive` with `INCDEC_SP_NOW`) gates whether
 * `spAdder.out` actually gets written to `sp.d` — `spAdder.out` is the
 * right value either way, only whether it's committed, and why, differs.
 *
 * **`x=00`, `z=4`/`z=5`: `INC r`/`DEC r`.** `y` (not `z` — a genuine
 * departure from every other group in this file, where `z` is the operand
 * field) selects the register: `B`/`C`/`D`/`E`/`H`/`L`/`(HL)`/`A`, the same
 * encoding `x=10`'s `z` and `x=01`'s `y`/`z` already use. `z` itself just
 * picks the direction (`4`=`INC`, `5`=`DEC`). `(HL)` (`y=6`) is
 * deliberately excluded: it needs a genuine read-modify-write through RAM
 * (read the byte at `HL`, increment/decrement it, write it back) — real,
 * different machinery from anything a plain register needs, not attempted
 * here, the same way `CALL nn` stays out of `x=11`. Unlike `INC rr`/
 * `DEC rr` above, real Z80 *does* set flags for this family — `S`/`Z`/`P`
 * freshly computed, `N` = the direction itself, `C` deliberately
 * *preserved* (real Z80 never touches it here) — `H` stays unmodeled, same
 * simplification the `x=10` group's own flags already carry.
 *
 * One shared 8-bit `buildAlu` instance computes the result — not seven
 * separate ones the way `BC`/`DE`/`HL` each got their own pair adder
 * above. The difference: this group's flags need to read *one* place
 * regardless of which register is involved, so computing seven separate
 * `S`/`Z`/`P` chains (one per register, six of them thrown away every
 * single cycle) would be pure waste for zero benefit — unlike `PUSH`ing
 * `BC` vs `DE`, at most one of `B`/`C`/`D`/`E`/`H`/`L`/`A` is ever the
 * *target* of `INC r`/`DEC r` in a given cycle, so there's exactly one
 * "the" result to compute flags from. Feeding that one adder is a 7-way
 * one-hot read-select: `dec.y`'s seven relevant lines (`y=0,1,2,3,4,5,7`)
 * each `AND`ed with their register's own value, then `OR`ed together per
 * bit — safe specifically because `dec.y` is one-hot (a real decoder
 * output, not seven independently-set flags), so at most one `AND` term
 * per bit is ever `1`, and `OR`ing a single `1` among six `0`s just passes
 * it through. `b`/`cin` reuse the exact `spAdder`/pair-adder `-1`/`+1`
 * trick a final time: `isDecR8` fans to every `b` bit, `cin` is that
 * inverted.
 *
 * Write-back layers a *fourth* mux-ahead-of-`d` stage on `B`/`C`/`D`/`E`/
 * `H`/`L` (on top of `ldExternal` and the `INC rr`/`DEC rr` layer above —
 * `wrapWithPairCommit` is generic enough to reuse as-is a second time, one
 * call per register, all six reading the identical `R8RESULT0`-`R8RESULT7`
 * label safely since only one of the six ever commits per cycle) and a
 * *third* condition on `A`'s own two-layer `aWeStage`/`aWeFinal` chain (a
 * new mux ahead of `srcMux`'s own `in0`, the same shape). `F`'s own
 * per-bit mux gets an equivalent extra layer: `N`/`P`/`Z`/`S`'s "computed"
 * input becomes a small mux between the `x=10` value (default) and this
 * group's own `R8_N`/`R8_P`/`R8_Z`/`R8_S`; `C`'s own equivalent mux gets
 * `F`'s *own* `q[0]` fed back as the alternative — a hold, not a fresh
 * value, the concrete wiring of "`C` stays untouched" above.
 *
 * **`x=00`, `z=6`: `LD r,n`.** The first instruction this slice executes
 * that reads an operand *after* its own opcode byte — every prior group
 * (`x=10`/`x=01`/`x=11`/`x=00`'s own `INC`/`DEC` families) is exactly one
 * byte, decoded and acted on entirely from the opcode itself. `y` selects
 * the destination the identical way `INC r`/`DEC r` above does
 * (`B`/`C`/`D`/`E`/`H`/`L`/`(HL)`/`A`); `(HL)` (`y=6`, `LD (HL),n`) is
 * excluded for the identical reason `INC (HL)`/`DEC (HL)` are — it needs a
 * RAM *write* stacked on top of the read this mechanism already does,
 * real, different follow-up work.
 *
 * The interesting design question this instruction raises isn't *how* to
 * read a second byte — RAM addressed by `PC` already drives the bus
 * combinationally whenever `oe=1`, the identical mechanism `FETCH` itself
 * uses — it's *when*, and specifically whether it needs a fifth FSM phase.
 * It doesn't: `PHASE2`/`PHASE3` (`EXEC1`/`EXEC2` for every other group)
 * get reused here with different semantics instead. `PHASE2`
 * (`ldImm8ReadNow`) reads RAM at `PC`'s *current* value — already past the
 * opcode, since `INCREMENT` (`PHASE1`) already ran once, the same as every
 * other instruction — and writes it straight into the destination
 * register, reusing that register's *existing* "capture the bus" path
 * (`isBusToA`/`ldWe`, both widened with one more `OR` term — see below)
 * rather than adding a new mux layer, since the bus already carries the
 * right value by construction. `PHASE3` (`ldImm8AdvanceNow`) then advances
 * `PC` a *second* time, past the immediate byte, before the next `FETCH` —
 * an `OR` widening `PC`'s own hold condition (`pcHold`, was bare `PHASE1`)
 * rather than a new mux input the way `RET`/`RST` override `PC`'s *target*
 * do, since this changes *when* `PC` advances, not *what* it loads.
 *
 * Every one of these three widenings (`pcHold`, `isBusToA`, `ldWe`) is the
 * same shape: an existing `OR` gate gains one more term, and with that
 * term at `0` (every instruction except `LD r,n`) the result is
 * byte-for-byte the original signal — the same "prove it's an identity
 * when inactive" discipline `spWantDec`/`spAluActive` already established
 * for `x=00, z=3` above. `busActive` is deliberately **not** widened the
 * way `stackActive` was for `PUSH`/`POP`: that existed to track a signal
 * *spanning* `EXEC1` and `EXEC2` (two independent stack bytes), where
 * `LD r,n`'s own bus use is confined to `PHASE2` alone — structurally the
 * same single-phase shape `hlNow`'s own `(HL)` operand read already has,
 * which never needed `busActive` either, and `ldImm8ReadNow` is OR'd
 * straight into `ramOeStage` the identical way.
 *
 * `runInstruction()`-shaped test helpers elsewhere in this file (four
 * phaseClk/dataClk pulse pairs: `INCREMENT`/`EXEC1`/`EXEC2`/`FETCH`) don't
 * need to change at all to drive this two-byte instruction correctly —
 * the concrete proof this design needed no fifth phase, not just an
 * argument for why it shouldn't.
 *
 * **`x=00`, `z=1`: `LD dd,nn`.** `LD r,n`'s own reused-phase trick doesn't
 * generalize past one operand byte on its own — a *second* byte needs a
 * *second* read-then-advance cycle, and `EXEC1`/`EXEC2` are already spent
 * on the first one. This is the one place so far this project's FSM
 * actually grows past 4 phases: `buildRingCounter(..., 6, ...)`, not `4` —
 * `EXEC3`/`EXEC4` (`phase[4]`/`phase[5]`), appended *after* `EXEC2`, not
 * inserted before it, so every existing `PHASE0`-`PHASE3` label keeps its
 * exact ring position and every already-built group's timing is
 * byte-for-byte unchanged (`buildRingCounter` itself needed no change
 * either — it was already generic over any phase count `>=2`). `EXEC3`
 * mirrors `EXEC1`'s own "read, then write" shape for the *second*
 * (high) byte; `EXEC4` mirrors `EXEC2`'s own "just advance `PC`" for it.
 * Every instruction implemented so far now spends two more genuinely
 * wasted phases per cycle, the identical "fixed phase count over real
 * hardware's variable M-cycles" simplification already documented,
 * stretched further — see Known Simplifications for the concrete
 * performance cost this turned out to have, live, not just in the test
 * suite.
 *
 * `y` (even values only — `0`/`2`/`4`/`6`) selects the pair the same way
 * `INC rr`/`DEC rr` above does (`BC`/`DE`/`HL`/`SP`); the odd `y` values at
 * this same `z` are `ADD HL,rr`, not implemented, correctly inert since
 * nothing here reads those lines. Real Z80's own imm16 byte order is
 * low-byte-first in memory — `EXEC1` reads the low byte (`PC`, already
 * past the opcode) into the pair's *low* register (`C`/`E`/`L`), `EXEC3`
 * reads the high byte into the *high* one (`B`/`D`/`H`) — the identical
 * high/low convention `PUSH`/`POP`'s own byte order already established,
 * just read instead of pushed.
 *
 * For `BC`/`DE`/`HL` this needed no new mux layer at all: `C`/`E`/`L`'s
 * own low-byte-write condition, and `B`/`D`/`H`'s own high-byte-write
 * condition, each fold into that register's *existing* `ldWe` `OR`-chain
 * (`LD r,r'`/`POP`/`LD r,n`, now one term wider) as a *fourth* competing
 * source — safe for the identical reason the third (`LD r,n`) already was:
 * `dec.z` is one-hot, so `z=6` and `z=1` can never both decode the same
 * opcode. The data path was already there too (`in1 = the bus`); only the
 * enable condition is new.
 *
 * `SP` (`y=6`) can't reuse that trick: it's one monolithic `buildRegister`
 * addr-bits wide, not two independently-addressable 8-bit ones the way
 * `BC` (`B`+`C`) is, so there's no "write just the low half" the way
 * writing only `C` naturally leaves `B` untouched — `sp.we` commits every
 * bit at once, always. Solved with a *fifth* write-back layer wrapping
 * the existing `spAluActive`-gated one (mirroring `wrapWithPairCommit`'s
 * own sink-to-sink shape, hand-written here since the per-bit logic isn't
 * a single static label lookup): each of `SP`'s bits gets a small mux
 * that picks its own fresh byte (low bits from the bus during the
 * low-byte phase, high bits from the bus during the high-byte phase)
 * while *holding* — self-looping `sp.q[i]` — during the *other* phase, so
 * each of the two write edges re-commits the untouched half right back to
 * itself instead of losing it. Bits at or past `addrBits` for the high
 * byte simply don't exist — the per-bit loop stops at `addrBits`, the
 * same truncation `spAdder`'s own arithmetic already has for a narrower-
 * than-16-bit `SP` in this project's smaller test-scale instantiations.
 *
 * **`x=11`: `JP nn`.** `z=3`, `y=0` (real `0xC3`) — at the time this was
 * written, the rest of `z=3` (`EX (SP),HL`/`EX DE,HL`/`DI`/`EI`/the `CB`
 * prefix/`OUT (n),A`/`IN A,(n)`) stayed unimplemented and correctly inert,
 * since nothing here read those `y` lines yet. Since then, `EX (SP),HL`/
 * `EX DE,HL` (see "x=11: EX (SP),HL" above) and `IN A,(n)`/`OUT (n),A`
 * (see "x=11: IN A,(n) / OUT (n),A" below) all joined this column — `DI`/
 * `EI` and the `CB` prefix are the two genuinely permanent exceptions (see
 * the Known Simplifications section for why each). Reuses `LD dd,nn`'s
 * exact `PHASE2`-`PHASE4`
 * shape (read low byte, advance, read high byte) unchanged — the one
 * real difference is `PHASE5`: `LD dd,nn` advances `PC` a third time
 * there, `JP nn` *overwrites* it with the freshly-read target instead, so
 * `PHASE5` is deliberately left **out** of `pcHold`'s own `OR`-chain for
 * this one instruction (`JP_ADVANCE_NOW` only covers `PHASE3`) — with
 * `pcHold=0` during `PHASE5`, `pc.load` naturally goes to `1`, and the
 * new `jpMux` (a third layer on `retMux`/`rstMux`'s own chain, gated by
 * `JP_JUMP_NOW`) supplies the actual target.
 *
 * `PC` itself can't play the "self-loop hold, mux in the fresh bits"
 * role `SP` did for its own two-byte write, though — `SP` isn't also the
 * address something *else* needs mid-write, but `PC` is exactly that:
 * `PHASE2`'s and `PHASE4`'s own reads need `PC` to keep being the correct,
 * un-corrupted read address (`PC`, `PC+1`) while the target is still only
 * half-known. Writing a partial jump target into `PC` directly would
 * corrupt the very address the *next* read depends on. `jpTarget` — a
 * new, dedicated `addrBits`-wide `buildRegister` nothing else ever seeds
 * — takes `SP`'s exact per-bit "hold vs fresh" write-back shape instead,
 * entirely separate from `PC`, and only *that* register's settled output
 * (one full tick after both bytes have landed) becomes `jpMux`'s own
 * `in1` on `PHASE5` — the concrete reason the commit needs its own phase
 * rather than landing on the same edge as the high-byte read: a
 * register's own `q` only reflects a write on the *next* relaxation, not
 * during the same edge that committed it, so wiring `jpTarget.q` straight
 * into `PC`'s own `d` on `PHASE4` would load the *previous* target, not
 * this one.
 *
 * **`x=11`: `CALL nn`.** `z=5`, `y=1` (real `0xCD`) — `PUSH`'s own `z=5`
 * column only claims the even `y` values (`isPushValid` above), so `y=1`
 * was always free. The FSM's second real widening, `6` phases to `8`
 * (`EXEC5`/`EXEC6`, appended after `EXEC4`, the same "append, never
 * insert" rule the first widening established) — `CALL nn` needs
 * everything `JP nn` needs (read the low byte, advance, read the high
 * byte, advance — `PHASE2`-`PHASE5`, unchanged shape) *plus* two more
 * actions `JP nn` never had to: pushing the return address before
 * jumping, not just jumping. `PHASE6` pushes, `PHASE7` jumps — six real
 * `EXEC` phases altogether for this one instruction, the deepest single
 * opcode this project has built.
 *
 * The return address itself is `PC`'s own value once both advances have
 * run — already sitting there for free, since `PHASE5`'s own advance
 * (unlike `JP nn`'s, which skips it) is *kept* here specifically so `PC`
 * ends up pointing past all three bytes of this instruction, the address
 * execution should resume at.
 *
 * **The push deliberately writes one stack byte, not two — mirroring
 * `RST`'s own scale coincidence, not a new one.** A real Z80's return
 * address is 16 bits, needing two stack bytes; this project's own `RET`
 * (built for `RST`, long before this instruction existed) only ever reads
 * *one* byte back, because `PC` here is only `addrBits` wide. Pushing two
 * bytes for `CALL` while `RET` only ever pops one would silently break
 * every `CALL`-then-`RET` pair — not a limitation to route around but a
 * compatibility constraint already fixed by `RST`'s own design, so `CALL
 * nn`'s own push reuses `RST`'s exact mechanism: `stackWriteNow` (already
 * `OR(pushNow, rstNow)`) widens to a third term, `CALL_PUSH_NOW`, pulling
 * in the *entire* existing stack-write apparatus for free — `SP`'s own
 * decrement (`spWantDec` already reads the `STACK_WRITE_NOW` label this
 * feeds), RAM's write-enable (`ramWe` already includes `stackWriteNow`),
 * and RAM's own address-to-`SP` selection (`writeMux`, same label) — none
 * of it rebuilt, only a new push-*data* driver bank (mirroring `RST`'s
 * own PC-onto-the-bus bank exactly, gated by `CALL_PUSH_NOW` instead of
 * `rstNow`) needed adding.
 *
 * `callTarget` — a *second*, separate holding register from `jpTarget`,
 * not a shared, widened one — takes the identical per-bit low/high
 * write-back shape `jpTarget` already established. `JP nn` and `CALL nn`
 * are mutually exclusive by `dec.z` (`z=3` vs `z=5`), so sharing one
 * register would have been electrically safe, but a second one costs
 * nothing this project has ever rationed (component count) and means
 * this addition touches zero already-proven `JP nn` wiring — the same
 * "separate over shared-and-muxed" preference `spAdder`-style adders
 * already established elsewhere in this file. `PC`'s own commit chain
 * grows a *fourth* mux layer, `callMux` (`retMux` -> `rstMux` -> `jpMux`
 * -> `callMux` -> `pc.d`), gated by `CALL_JUMP_NOW` on `PHASE7`, `PHASE6`/
 * `PHASE7` both deliberately excluded from `pcHold` for the identical
 * reason `JP nn`'s own `PHASE5` was: `PHASE7` overwrites `PC`, and
 * `PHASE6` doesn't touch it at all.
 *
 * **`x=11`: `JP cc,nn`.** `z=2` (real `0xC2`/`0xCA`/`0xD2`/`0xDA`/`0xE2`/
 * `0xEA`/`0xF2`/`0xFA`) reuses `JP nn`'s exact `PHASE2`-`PHASE5` read/
 * advance shape unchanged — the one real difference is what `PHASE5`
 * does: `JP nn` always overwrites `PC`; here it branches on a flag test
 * instead, jumping (`JPCC_JUMP_NOW`) only if the tested condition holds,
 * otherwise just advancing `PC` a third time (`JPCC_FALLTHROUGH_NOW`,
 * `LD dd,nn`'s own `PHASE5` shape) so execution falls through to whatever
 * comes after this instruction's own 3 bytes. No FSM widening needed —
 * the ring already has every phase this instruction uses.
 *
 * `y` selects the condition the same one-hot way `INC r`/`DEC r`'s own
 * `r8Select` picks a register (see "x=00, z=4/z=5" above): real Z80's own
 * mapping is `NZ`=0, `Z`=1, `NC`=2, `C`=3, `PO`=4, `PE`=5, `P`=6, `M`=7 —
 * `P`/`M` test `F`'s own `S` bit ("plus"/"minus", i.e. sign), not to be
 * confused with `P/V`, which `PO`/`PE` ("parity odd"/"parity even") test
 * instead. The whole 8-way select is computed unconditionally off `F`'s
 * live bits — the same "always compute, gate only the commit" philosophy
 * `alu`/`spAdder`/`r8Adder` already use, cheap regardless of which
 * instruction (if any) is actually decoding.
 *
 * `jpCcTarget` — a *third* separate holding register, alongside
 * `jpTarget` and `callTarget`, not a shared, widened one — takes the
 * identical per-bit low/high write-back shape both already established.
 * `z=3`, `z=5`, and `z=2` are mutually exclusive by construction, so
 * sharing one register across all three would have been electrically
 * safe, but a third register costs nothing this project has ever
 * rationed and keeps this addition from touching any already-proven
 * `JP nn`/`CALL nn` wiring — the same preference stated twice already in
 * this doc comment, holding a third time. `PC`'s own commit chain grows
 * a *fifth* mux layer, `jpCcMux` (`retMux` -> `rstMux` -> `jpMux` ->
 * `callMux` -> `jpCcMux` -> `pc.d`), gated by `JPCC_JUMP_NOW` on `PHASE5`
 * — `pcHold` gets both `JPCC_ADVANCE_LOW_NOW` (`PHASE3`, unconditional)
 * and `JPCC_FALLTHROUGH_NOW` (`PHASE5`, the condition-*false* branch);
 * `JPCC_JUMP_NOW` (`PHASE5`, condition-*true*) deliberately stays out,
 * the same exclusion `JP nn`'s own `PHASE5` already established.
 *
 * **`x=11`: `CALL cc,nn`.** `z=4` (real `0xC4`/`0xCC`/`0xD4`/`0xDC`/
 * `0xE4`/`0xEC`/`0xF4`/`0xFC`) is the composition `CALL nn` and `JP cc,nn`
 * already set up to be trivial: `CALL nn`'s exact `PHASE2`-`PHASE5` read/
 * advance shape, reused completely UNCONDITIONALLY (both branches need
 * `PC` to end up past this instruction's own 3 bytes regardless of
 * whether the call fires, since that address is either the fall-through
 * target or the very return address about to be pushed), plus `JP cc,nn`'s
 * own `conditionTrue` line, reused directly rather than recomputed — `y`'s
 * condition encoding depends only on `dec.y` and `F`'s live bits, not
 * `dec.z`, so the identical 8-way select tree is correct for both `z=2`
 * and `z=4` without rebuilding a single gate of it. The only branch left
 * is whether `PHASE6` (push) and `PHASE7` (jump) actually do anything:
 * `CALLCC_PUSH_NOW`/`CALLCC_JUMP_NOW` are each `AND(phase, conditionTrue)`
 * directly, no separate "false" signal needed the way `JP cc,nn`'s own
 * `JPCC_FALLTHROUGH_NOW` was, since condition-false here just means
 * "push nothing, jump nowhere" — `PC` already sits at the right address
 * from `PHASE5`'s own unconditional advance, and nothing else needs an
 * explicit gate to do nothing.
 *
 * `callCcTarget` — a *fourth* separate holding register, identical shape
 * to `jpTarget`/`callTarget`/`jpCcTarget`, the same "separate over
 * shared-and-muxed" preference restated a fourth time now. `PC`'s own
 * commit chain grows a *sixth* mux layer, `callCcMux` (after `jpCcMux`),
 * gated by `CALLCC_JUMP_NOW` on `PHASE7` — `pcHold` gets both
 * `CALLCC_ADVANCE_LOW_NOW` (`PHASE3`) and `CALLCC_ADVANCE_HIGH_NOW`
 * (`PHASE5`), both unconditional; `CALLCC_PUSH_NOW`/`CALLCC_JUMP_NOW`
 * stay out entirely, the identical exclusion `CALL nn`'s own `PHASE6`/
 * `PHASE7` already established. The push itself reuses every piece of
 * `CALL nn`'s own machinery: `STACK_WRITE_NOW`'s `OR`-chain widens a
 * fourth term (already gated by `conditionTrue` inside `CALLCC_PUSH_NOW`
 * itself, so no extra condition check needed at the `OR`), and the
 * push-data driver bank is a straight copy of `CALL nn`'s own, gated by
 * `CALLCC_PUSH_NOW` instead of `CALL_PUSH_NOW` — SP decrement and the
 * RAM-write address-select follow along automatically, exactly the way
 * `CALL nn`'s own push already inherited them from `PUSH`/`RST` for free.
 *
 * **`x=11`: `RET cc`.** `z=0` (real `0xC0`/`0xC8`/`0xD0`/`0xD8`/`0xE0`/
 * `0xE8`/`0xF0`/`0xF8`) is the last of the four flag-gated `x=11`
 * instructions this project set out to build, and by far the cheapest:
 * a single-byte opcode, no operand bytes to read or advance past at all.
 * The not-taken branch needs nothing beyond `PC`'s own default `PHASE1`
 * increment — no `FALLTHROUGH` signal, no extra `pcHold` term, unlike
 * every other conditional instruction above. Reuses `JP cc,nn`'s own
 * `conditionTrue` directly, a third time now, for the identical reason
 * `CALL cc,nn` already reused it: `y`'s condition encoding depends only
 * on `dec.y` and `F`'s live bits, never on `dec.z`. `RETCC_TAKEN_NOW`
 * (`AND(isRetCcZ, PHASE2, conditionTrue)`) is the *only* new signal this
 * instruction needs — it widens the *existing* unconditional `RET`'s own
 * `readNow` (a third `OR` term, built with `popReadNow`/`retNow` long
 * before `RET cc` or `conditionTrue` existed, so the widening — and
 * `readNow`'s own real, final definition — waits until here, after both
 * exist) rather than building a parallel read path: `SP`'s own recovery
 * (`stackActive` -> `spAluActive` -> `sp.we`) and the RAM read address
 * (`READ_NOW`'s own address-mux select) both already key off `readNow`,
 * so every already-proven piece of `POP`/`RET`'s own read machinery comes
 * along for free, the identical "reuse the whole apparatus, add one
 * term" shape `CALL cc,nn`'s own push used on `STACK_WRITE_NOW`.
 *
 * No dedicated target register either — unlike `JP cc,nn`/`CALL cc,nn`,
 * whose 2-byte targets have to be held across two read phases before
 * `PC` (also the read address for those very bytes) can safely accept
 * them, `RET cc`'s target is a *single* popped byte already sitting on
 * the bus the instant it's read, the identical reason `RET`'s own
 * `retMux` never needed one either. `PC`'s own commit chain grows a
 * *seventh* mux layer, `retCcMux` (after `callCcMux`), gated by
 * `RETCC_TAKEN_NOW` — `in1` is the raw bus, not a register's `q`, `retMux`'s
 * own shape copied exactly.
 *
 * **`x=11`, `z=1`, `y=3`: `EXX`.** Real `0xD9` — the three-pair version of
 * `EX AF,AF'` (see "x=00: EX AF,AF'" above), sharing `isStackReadZ`
 * (`x=11, z=1`, already built for `RET`/`POP`) one more way. `B'`/`C'`/
 * `D'`/`E'`/`H'`/`L'` are six more plain registers, seeded externally
 * exactly like `rB`..`rL` themselves. Unlike `A`/`F`, `rB`..`rL` were
 * *already* `wrapWithPairCommit`-wrapped one or more layers deep (`LD`/
 * `POP`, `INC`/`DEC` pair, `INC`/`DEC` single, and — `B` specifically —
 * `DJNZ`), so `EXX`'s own write-back needs no bespoke per-bit mux at all:
 * one more `wrapWithPairCommit` call per register, stacked on whichever
 * layer was previously outermost, reading `B'`..`L'`'s own old value
 * (`BPOLD`..`LPOLD`) the identical way `EX AF,AF'` reads `APOLD`/`FPOLD`.
 * `B'`..`L'` themselves are wrapped the same single layer `A'`/`F'` were,
 * reading `BOLD`..`LOLD` (`rB`..`rL`'s own current bits, published
 * alongside `AOLD`/`FOLD`). Six independent register-to-register swaps on
 * one shared edge, same master-slave guarantee as the one-pair case,
 * confirmed the identical way: the regression test reverses `EXX` twice
 * in a row and checks every one of the twelve registers involved lands
 * back on its starting value, not just `B`/`C`/`D`/`E`/`H`/`L`.
 *
 * **`x=11`, `z=1`, `y=5`: `JP (HL)`, `y=7`: `LD SP,HL`.** Real `0xE9`/
 * `0xF9` — both sharing `isStackReadZ` a fourth and fifth way, both the
 * cheapest kind of jump/load this file has built: single-byte, no operand
 * read, no dedicated target register, `PHASE2` commits straight off `H`/
 * `L`'s own current bits. `JP (HL)` gets a ninth mux layer on `PC`'s own
 * chain (after `jrMux`), `in1` wired directly to `HL` (bits 0..7 from `L`,
 * 8 and up from `H` — `addrBits` is narrower than 16 in every test this
 * file has, so in practice this is just `L`, but the wiring is correct for
 * a wider one too). `LD SP,HL` gets a third layer on `SP`'s own chain
 * (after `LD SP,nn`'s own two-phase low/high wrapper), the *first* of
 * `SP`'s own layers that doesn't need a two-phase split at all — `H`/`L`
 * are both already sitting in registers simultaneously, unlike `LD SP,nn`'s
 * own sequentially-read immediate bytes.
 *
 * With `EXX`/`JP (HL)`/`LD SP,HL`, every `x=11` opcode this project set
 * out to build is in: `PUSH`/`POP`/`RET`/`RST n`/`JP nn`/`CALL nn`/
 * `JP cc,nn`/`CALL cc,nn`/`RET cc`/`EXX`/`JP (HL)`/`LD SP,HL`.
 *
 * **`x=11`, `z=3`, `y=5`: `EX DE,HL`.** Real `0xEB`, sharing `isX11Z3`
 * (`x=11, z=3`, the same condition `JP nn` above already sits on, renamed
 * from `isJpNnZ` the identical honest reason `isX0Z0`/`isJrGroupZ` were —
 * this project has never kept a label that quietly stopped describing
 * what it actually gates). Unlike `EX AF,AF'`/`EXX`, no shadow registers
 * at all: `D`/`H` and `E`/`L` are two ordinary, already-live pairs simply
 * trading places. `HOLD`/`DOLD`/`EOLD`/`LOLD` — published earlier for
 * `EXX`'s own swap — already carry exactly the values this needs (`D`'s
 * new value is `H`'s old one and vice versa, `E`'s new value is `L`'s old
 * one and vice versa), so this reuses those four labels outright: one more
 * `wrapWithPairCommit` layer per register, no new per-bit publishing at
 * all. The regression test proves the real cross-pair swap the same way
 * `EX AF,AF'`/`EXX` do — reading `D`/`E` back directly, not just `H`/`L`.
 *
 * **`x=11`, `z=3`, `y=4`: `EX (SP),HL`.** Real `0xE3` — the one member of
 * this file's whole "swap on one edge" family (`EX AF,AF'`/`EXX`/
 * `EX DE,HL` above) that swaps a register pair with *RAM* instead of
 * another register, and the only one that needs a real 4-phase
 * read-modify-write to do it: `PHASE2` reads `[SP]` into a holding
 * register, `PHASE3` reads `[SP+1]` into a second one (`exSpHlPlusOne`, a
 * *dedicated* `addrBits`-wide adder — deliberately not a tap on `spAdder`
 * itself, since this opcode never actually commits anything into `SP`,
 * only ever addresses one past it), `PHASE4` writes `L`'s own old value to
 * `[SP]` while `L` itself takes the first holding register's value on that
 * same edge, `PHASE5` mirrors that for `H`/`[SP+1]`/the second holding
 * register — four phases, well inside the existing 8-phase budget. Every
 * one of the three adjacent-phase boundaries in that sequence
 * (`PHASE2`/`PHASE3`, `PHASE3`/`PHASE4`, `PHASE4`/`PHASE5`) gets the
 * identical "later phase explicitly excludes the earlier one" fix
 * `LD (nn),HL`'s own live bug first taught this file (see "x=00, z=2"
 * above) — applied pre-emptively this time, across all three boundaries
 * at once, rather than found live a fourth (and fifth, and sixth) time.
 *
 * Found live, a genuinely new class this time — not another adjacent-phase
 * bus fight: the first cut drove `L`/`H`'s own old value onto the bus
 * straight from `REGL`/`REGH` (labels already anchored to `rL.q`/`rH.q`
 * for the operand bus and `LD (nn),HL`'s own write above), reasoning that
 * since those labels already worked for every earlier bus source, they'd
 * work here too. They don't, for a reason specific to *this* opcode: `L`/
 * `H` are *also* committing a brand-new value on this exact same edge
 * (`rLExt8`/`rHExt8` below). A register safely reads *another* register's
 * old value on a shared edge because the reader's own master latch
 * freezes at whatever it saw *before* the edge (see the `sp.q`-during-a-
 * read doc comment, "x=00: INC (HL)/DEC (HL)/LD (HL),n" above) — but a
 * bare tri-state buffer has no master latch of its own to freeze anything;
 * it just reflects whatever `rL.q`/`rH.q` settle to *within this same
 * tick*, which is the fresh value the instant the slave releases it, not
 * the pre-edge one. The bus ended up carrying the *new* `L` (the value
 * about to be written from `[SP]`) instead of the old one — `RAM` never
 * actually changed, silently, while `HL`'s own read-back looked completely
 * correct (it *was* — only the write side was broken). `oldLTemp`/
 * `oldHTemp` — two more holding registers, capturing `L`/`H` during
 * `PHASE2` (well before either one's own same-instruction write at
 * `PHASE4`/`PHASE5`) — fix it the same way every other "value must survive
 * past its own bus's next user" case in this file already does: a real
 * flip-flop's own master-slave discipline in between, not a live
 * combinational tap on a register that's about to move. `L`/`H`'s own bus
 * banks read `oldLTemp`/`oldHTemp` now, not `REGL`/`REGH` directly.
 *
 * `isX11Z3` (renamed from `isJpNnZ`, the identical honest-naming reason
 * `isX0Z0`/`isJrGroupZ` were) is `x=11, z=3` shared four ways now: `JP nn`,
 * `EX DE,HL`, and `EX (SP),HL`, with `DI`/`EI` deliberately still inert
 * (see the Known Simplifications section — this simulator has no
 * interrupt line at all, so a flip-flop nobody ever reads would be
 * decoration, not a feature) and `IN A,(n)`/`OUT (n),A` covered separately
 * (see "x=11: IN A,(n) / OUT (n),A" below) since they needed an I/O port
 * concept this file never had before either.
 *
 * **`x=11`, `z=6`: `ALU op A,n`.** Real `0xC6`/`0xCE`/`0xD6`/`0xDE`/`0xE6`/
 * `0xEE`/`0xF6`/`0xFE` (`ADD`/`ADC`/`SUB`/`SBC`/`AND`/`XOR`/`OR`/`CP A,n`)
 * — the immediate-operand twin of `x=10`'s own ALU-on-register group,
 * `isAluImm8`/`aluImm8ReadNow`/`aluImm8AdvanceNow` the exact `PHASE2`-
 * read/`PHASE3`-advance shape `LD r,n`'s own `isLdImm8` established,
 * gated by `x=11` instead of `x=00`. The genuinely interesting part is how
 * little this needed: `alu.op0`/`op1`/`cin`/`bInv` (see "x=10: ADC/SBC"
 * above) are keyed on `dec.y` alone, never `dec.x` — this column's own `y`
 * values encode the identical eight operations `x=10`'s own `y` does, and
 * `bInv`'s own operand already reads straight off the bus, unconditionally
 * — so the instant `aluImm8ReadNow` puts the freshly-read immediate byte
 * on the bus (`PC` already the default read address, no new address-mux
 * term needed), `alu.out`/`alu.cout` are *already* the right answer, zero
 * new op-select wiring. `aluAnyGroupNow` (`OR(aluGroupNow,
 * aluImm8ReadNow)`) is the one new signal this needed — `A`/`F`'s own
 * commit (`aWe`/`fWe`/`F`'s own per-bit `baseMux` sel) widens to it in
 * place of bare `aluGroupNow`; `groupActive` (the *register*-operand bus
 * enable) deliberately does not, since this opcode's operand is the
 * immediate byte RAM already put on the bus, not a register's own read.
 *
 * **`x=11`, `z=3`, `y=2`: `OUT (n),A`, `y=3`: `IN A,(n)`.** Real `0xD3`/
 * `0xDB` — the two opcodes in this file that finally needed a real I/O
 * port concept, invented from scratch here since nothing before this ever
 * touched anything outside `RAM`/registers. Kept deliberately minimal:
 * `ioPortAddr` (a live tap of the bus, valid only while `ioRead`/
 * `ioWrite` fires — the immediate byte `n`, addressed the same
 * `PHASE2`-read/`PHASE3`-advance way `ALU op A,n` above reads its own),
 * `ioPortDataOut` (a live tap of `A`, valid only while `ioWrite` fires),
 * `ioPortDataIn` (a genuine external sink — the identical contract
 * `Register.d`/`Register.we` already use, a caller's own device wires
 * *into* it, this file never drives it), and the two strobes themselves.
 * Real Z80 hardware also puts `A` on the *upper* half of a 16-bit port
 * address (`A:n`, not just `n`) — this slice only ever exposes `n`, a
 * real, documented simplification, not an oversight; building a genuine
 * peripheral to sit on the other end of these pins is explicitly out of
 * scope too — this file exposes the bus, not a keyboard controller.
 *
 * `OUT (n),A` commits at `PHASE2` itself: `n` (the address) and `A` (the
 * data) are both already stable the instant `n` lands on the bus, no
 * holding register needed the way `EX (SP),HL`'s own register-to-RAM swap
 * above did — `A` isn't also changing on this same tick for this opcode.
 * `IN A,(n)` reads at `PHASE2` too, and needs a genuinely new layer on
 * `A`'s own write mux: `in1` there *is* `ioPortDataIn[i]`'s own raw port
 * pin, not a value read off of it, so a caller's own device can drive it
 * directly. `DI`/`EI` (`y=6`/`y=7`, the two remaining `y` values in this
 * column) stay deliberately inert — see the Known Simplifications section.
 *
 * **`x=00`, `z=0`, `y=4..7`: `JR cc,e`.** Real `0x20`/`0x28`/`0x30`/`0x38`
 * — `NZ`/`Z`/`NC`/`C` only. That four-condition limit is real Z80
 * hardware, not a simplification: this `z`-column's other `y` values are
 * `NOP`/`EX AF,AF'`/`DJNZ`/`JR` (unconditional), none implemented here,
 * and `PO`/`PE`/`P`/`M` were never valid encodings for this opcode on
 * real silicon either — `isJrCcYValid` (an `OR`-fold over `y=4..7`) keeps
 * the other four `y` values in this column correctly inert rather than
 * accidentally decoding as some other instruction's own `z=0` opcode.
 * `JR cc`'s condition test reuses `JP cc,nn`'s own `F`-bit taps
 * (`notFZ`/`f.q[6]`/`notFC`/`f.q[0]`) but NOT its `conditionTrue` pin
 * directly — this opcode's own `y=4..7` encode the identical four
 * conditions at *different* `y` values than `JP cc,nn`'s own `y=0..3`
 * (real Z80's own encoding, not a choice made here), so a small, separate
 * 4-way select tree (`jrCcConditionTrue`) pairs those same `F`-bit taps
 * with this opcode's own `y` lines instead of rebuilding them.
 *
 * The real new piece this instruction needs — the reason it waited this
 * long despite reusing so much — is genuine PC-relative arithmetic:
 * `JP cc,nn` writes an absolute operand straight into `PC`; `JR cc` has to
 * *add* a signed 8-bit displacement to whatever `PC` already is. A
 * *second* `buildAlu` instance (`jrOffsetAdder`, width `addrBits`, the
 * same "dedicated adder over one shared, muxed one" preference `spAdder`
 * already established), permanently in ADD mode, `a` wired straight to
 * `pc.q`. By the phase this fires (`PHASE4`), `PHASE3`'s own advance has
 * already committed on the prior edge, so `pc.q` already equals "the
 * address right after this instruction's own 2 bytes" — exactly the base
 * a relative jump needs, with no special-cased "peek ahead" logic. `b` is
 * `jrCcOffset`'s own 8 captured bits, sign-extended up to `addrBits` (bit
 * 7 repeated into every bit above it) — correct only when `addrBits >= 8`,
 * an explicit, documented limitation this project has never needed to
 * lift rather than a silently wrong one for narrower address spaces.
 *
 * `jrCcOffset` itself is a *plain* 8-bit register, not a "hold vs fresh"
 * mux pair the way every multi-byte target in this file needs — those
 * exist because a single register captures two different byte-halves
 * across two separate `we` pulses; a displacement byte is captured
 * exactly once, so a bare `we`-gated capture (`B`/`C`/`D`/... 's own `LD
 * r,n` shape) is enough. Only one phase's worth of new decode logic
 * separates the two branches, the same economy `RET cc` already found:
 * `jrCcJumpNow` (`PHASE4`, `AND` with `jrCcConditionTrue`) is the only new
 * per-opcode signal `PC`'s commit chain needs — no `FALLTHROUGH` term,
 * since condition-false needs nothing beyond `PHASE3`'s own
 * already-unconditional advance. `PC`'s own commit chain grows an
 * *eighth* mux layer, `jrMux` (after `retCcMux`), `in1` wired to
 * `jrOffsetAdder.out` directly — a live adder output, not a register's
 * own `q`, since the sum needs no separate holding place of its own once
 * `jrCcOffset` already holds the one value that changes.
 *
 * **`x=00`, `z=0`, `y=2..3`: plain `JR e` and `DJNZ e`.** Real `0x18`
 * (`JR`, unconditional) and `0x10` (`DJNZ`) round out this `z`-column now
 * that the hard part — `jrCcOffset`/`jrOffsetAdder` — already exists.
 * Plain `JR` reuses every piece of `JR cc,e`'s own machinery unchanged,
 * minus the condition test: `jrReadNow`/`jrAdvanceNow`/`jrJumpNow` are
 * each a single `AND(isJr, PHASE_n)`, no `F`-bit tap needed since this
 * one always jumps. `isX0Z0` (renamed from `isJrCcZ`, then renamed again
 * from `isJrGroupZ` once `EX AF,AF'` — see "x=00: EX AF,AF'" below — needed
 * this exact same `x=00, z=0` condition for a `y` this file's own JR family
 * doesn't touch at all; this project has never kept a label that quietly
 * stopped describing what it actually gates) is the shared `x=00, z=0`
 * decode this, `DJNZ`, `JR cc,e`'s own, and `EX AF,AF'` all sit on top of.
 *
 * `DJNZ` needs one genuinely new piece: `djnzAdder`, a *third* dedicated
 * `buildAlu` (8 bits, `spAdder`'s own "b=all-1s, cin=0" decrement
 * encoding), computed unconditionally off `rB.q` — the same "always
 * compute, gate only the commit" shape every adder in this file already
 * uses — feeding `B`'s own decremented value into its write-back below.
 *
 * The zero-test deliberately does NOT read `djnzAdder.out` — found live:
 * by the phase the jump decision fires (`PHASE4`), `PHASE2`'s own write
 * has already committed the decrement into `rB.q`, so `djnzAdder` (which
 * recomputes "B minus one" continuously, off whatever `rB.q` currently
 * is) would silently compute "B minus one *again*" at that point, one
 * decrement too many for the *test* specifically (the committed value
 * itself was still correct) — a bug that only misfires from the second
 * loop pass onward, since the first pass's own off-by-one happens to
 * still read nonzero. `bNotZeroChain`, a separate `OR`-fold built the
 * identical way `r8ZChain` already is (stopped one step short of the
 * final `NOT`) but over `rB.q`'s own bits directly, reads the register's
 * real, already-decremented value instead. `B`'s own decremented value
 * commits through a *fourth* write-back layer (`rBExt4`,
 * `wrapWithPairCommit` again, gated by `DJNZ_DEC_NOW`) stacked on top of
 * the three `B` already had (`LD`/`POP`, `INC`/`DEC BC`, `INC`/`DEC B`) —
 * `DJNZ` hardcodes `B` specifically, never `y`-selected, so no other
 * register ever competes for this particular layer.
 *
 * `JR_READ_NOW`/`JR_ADVANCE_NOW`/`JR_JUMP_NOW` (renamed from `JRCC_*` for
 * the identical honest-naming reason `isX0Z0` was) are each a
 * straight `OR`-fold across all three variants' own per-opcode signals —
 * safe because `dec.y` one-hot means at most one of `JR cc,e`/plain
 * `JR`/`DJNZ` is ever the opcode actually decoding, never two at once.
 *
 * **`x=00`, `z=0`, `y=1`: `EX AF,AF'`.** Real `0x08` — the one other `y` in
 * this column besides `NOP` (`y=0`, needing no circuitry at all: nothing in
 * this file has ever decoded to an action for it, which *is* correct real
 * Z80 `NOP` behavior) that isn't part of the `JR` family, sharing `isX0Z0`
 * one more way. `A'`/`F'` (`aP`/`fP`) are a real shadow accumulator/flags
 * pair — two more plain 8-bit registers, seeded externally exactly like
 * `rB`..`rL`, since real hardware gives them no defined power-on value
 * either. The swap itself commits both directions on the identical edge:
 * `A`'s own write mux gains a layer selecting `aP`'s old value; `aP` itself
 * (via `wrapWithPairCommit`, built for `INC BC/DE/HL`'s own "+1 into a
 * paused pair" shape but generic enough to hand a register's raw old value
 * to instead of an adder's fresh one) commits `A`'s old value the same
 * tick. `F`/`F'` mirror this exactly, except `F`'s own write mux needs the
 * swap layer on *every* bit that reaches it (0/1/2/6/7 — bits 3/4/5 already
 * `continue` out of that loop hardwired to `gnd`, so swapping two things
 * that are always 0 needs no layer at all), not just the one or two bits
 * most earlier features touched. A true two-register swap on one shared
 * edge is a topology this file hasn't built before — every earlier
 * register-reads-another-register's-old-value case (`sp.q` during a stack
 * read, `a.q` feeding `F`'s own flags) was one-directional; the master-
 * slave discipline that makes any of those safe (see the `sp.q` doc
 * comment, "x=00: INC (HL)/DEC (HL)/LD (HL),n" above) doesn't care which
 * direction the arrow points, or how many arrows there are at once, so it
 * turned out to need nothing new — confirmed by the regression test round-
 * tripping the swap twice in a row and landing back on the original values.
 *
 * **`x=00`, `z=1`, `y` odd: `ADD HL,rr`.** Real `0x09`/`0x19`/`0x29`/
 * `0x39` (`BC`/`DE`/`HL`/`SP`) — the exact complement of `LD dd,nn`'s own
 * even-`y` opcodes at this same `z`. Implementing this surfaced a real,
 * pre-existing gap: `isLdDdNn` never checked `y`'s own parity at all, so
 * before this, `PHASE3`/`PHASE5`'s own advances fired for *any* `y` at
 * `z=1` — no register write ever committed for the odd half (nothing
 * downstream read those lines), but `PC` would have silently advanced as
 * if a fetched `ADD HL,rr` opcode had two nonexistent immediate bytes to
 * skip. Never triggered before now, since no program byte sequence had
 * ever included one of these opcodes; `isLdDdNnYValid` (even `y` only)
 * and this instruction's own `isAddHlYValid` (odd `y` only) now partition
 * every `y` value at `z=1` between exactly one of the two, none left
 * ambiguous.
 *
 * `addHlAdder` is a *fourth* dedicated `buildAlu`, 16 bits this time — a
 * genuine ripple-carry add across the full pair, not two independent
 * 8-bit ones, `a` wired to `HL`'s own current value (`rL.q` low, `rH.q`
 * high). `b` is a 4-way one-hot select among `BC`/`DE`/`HL`/`SP`'s own
 * bits, the identical shape `r8Select` already uses for INC r/DEC r's own
 * register choice, 16 lanes instead of 8. `SP` — this simulator's own
 * address-space-only register, `addrBits` wide rather than a genuine 16
 * bits — zero-extends past `addrBits`: an unsigned address, not a signed
 * offset, so zero-extension is correct here, the opposite choice from
 * `jrOffsetAdder`'s own sign-extension for a genuinely signed
 * displacement. Real Z80 leaves `S`/`Z`/`P/V` untouched for this opcode
 * and only updates the carry flag (`H` too, not tracked anywhere in this
 * project's own `F`) — a *fourth* mux layer ahead of `F`'s own bit-0
 * commit, inserted only for that one bit, gated by `ADDHL_NOW`, feeding
 * `addHlAdder.cout` in; every other flag bit never sees this layer at
 * all. `H`/`L` get a *fifth* write-back layer each (`rHExt4`/`rLExt4`,
 * `wrapWithPairCommit` again, the identical shared-commit-label shape
 * `INCDEC_HL_NOW` already established for the pair moving together).
 *
 * **`x=00`, `z=2`: indirect loads through `(BC)`/`(DE)`/`(nn)`.** Real
 * `0x02`/`0x0A`/`0x12`/`0x1A`/`0x22`/`0x2A`/`0x32`/`0x3A` — all 8 `y`
 * values are valid opcodes here, no gap. `y=0..3` (`LD (BC),A`/`LD
 * A,(BC)`/`LD (DE),A`/`LD A,(DE)`) are single-byte, committing at
 * `PHASE2` like every other 1-byte opcode in this file; `y=4..7` (`LD
 * (nn),HL`/`LD HL,(nn)`/`LD (nn),A`/`LD A,(nn)`) are 3-byte, reusing `LD
 * dd,nn`'s exact 4-phase read-low/advance/read-high/advance shape
 * (`PHASE2`-`PHASE5`) to land a fresh address in `nnAddr`, then
 * committing at `PHASE6` (`A`, one byte) or `PHASE6`+`PHASE7` (`HL`, low
 * byte first — real Z80's own convention) — the full 8-phase budget, no
 * FSM widening needed, the same fit `JR cc,e`'s own arithmetic found.
 *
 * `nnAddr` is a *fifth* dedicated holding register, the identical "hold
 * vs fresh" shape `jpTarget`/`callTarget`/`jpCcTarget`/`callCcTarget`
 * already use — needed for the same reason every one of those was: `PC`
 * is busy being the read address for `nn`'s own two bytes, so the
 * freshly-read address has to live somewhere else until the data phase
 * needs it. `nnAddrPlusOne` is a *fifth* dedicated `buildAlu` (`spAdder`'s
 * own "b=all-0s, cin=vcc" +1 encoding, `djnzAdder`'s own -1 mirrored) —
 * `LD (nn),HL`/`LD HL,(nn)` need the address one past `nn` for `HL`'s own
 * high byte.
 *
 * RAM's own address bus grows four more override layers past the
 * existing `PC`-or-`HL`-or-`SP` chain: `BC`/`DE` (this simulator's own
 * "only the low byte matters" convention `HL`'s own addressing already
 * relies on) for the register-indirect opcodes, then `nnAddr` and
 * `nnAddr + 1` for the absolute-indirect ones. `A` gets a new
 * tri-state-buffer bank onto the bus for its own three writes (`LD
 * (BC),A`/`LD (DE),A`/`LD (nn),A`, one shared enable — `dec.y` one-hot
 * means at most one ever fires); `L`/`H` get one each, separately, for
 * `LD (nn),HL`'s own low/high write phases. Reads go the other way:
 * `isBusToA` (`A`'s own "read from the bus instead of the ALU" select,
 * already widened three times before this) gets a fourth term for all
 * three of this instruction's own reads into `A`; `H`/`L` each get a
 * *sixth* write-back layer (`wrapWithPairCommit` again, `BUS` itself as
 * the value label this time, since the data comes straight off the bus
 * rather than a computed adder result).
 *
 * **`x=00`: `INC (HL)`/`DEC (HL)`/`LD (HL),n`.** Real `0x34`/`0x35`/
 * `0x36` — the `y=6` slot every earlier `x=00` group (`INC r`/`DEC r`,
 * `LD r,n`) deliberately left inert, a real RAM read-modify-write instead
 * of a register touch. `INC (HL)`/`DEC (HL)` reuse `INC r`/`DEC r`'s own
 * shared `r8Adder` rather than building a dedicated one: `r8Select`
 * grows an eighth entry, `HLMEM`, selecting `hlMemTemp` — a *sixth*
 * dedicated holding register (`jpTarget`'s own reasoning: `(HL)`'s value
 * has to survive from the read phase to the write-back phase, one phase
 * later, after the bus has moved on) — instead of a CPU register's own
 * `q`. One shared adder computing eight different sources' `±1`, not
 * nine, the identical economy that adder was built for in the first
 * place.
 *
 * The existing `incDecR8Now` (the 7-register case's own `PHASE2` commit)
 * explicitly excludes `y=6` now — `(HL)`'s own value isn't valid until a
 * whole phase later, so committing on the old shared gate would read
 * `hlMemTemp`'s stale previous contents. `HLMEM_READ_NOW` (`PHASE2`)
 * captures the read; `INCDEC_HLMEM_NOW` (`PHASE3`, explicitly excluding
 * `HLMEM_READ_NOW` — not bare `PHASE3`) commits it, both to `F`'s own
 * flags (widening `INCDEC_R8_NOW` itself with this new term) and to RAM,
 * via a plain tri-state buffer bank driving `R8RESULT0-7` onto the bus.
 * That exclusion is the identical fix `LD (nn),HL`'s own live bug already
 * taught this file — `PHASE2` (RAM driving the bus for the read) and
 * `PHASE3` (this write's own buffer driving it right back) are adjacent
 * ring positions, the same transient bus-fight risk — pre-empted here
 * instead of found live a third time.
 *
 * `LD (HL),n` needs its own *seventh* holding register, `ldHlNImm`,
 * capturing the immediate byte off the *same* bus `LD r,n`'s own
 * `ldImm8ReadNow` already makes valid at `PHASE2` (no separate read
 * needed — `z=6`'s existing read/advance shape already covers `y=6` like
 * every other `y`, only the per-register write-backs ever excluded it).
 * `ldHlNWriteNow` (`PHASE3`, explicitly excluding `ldHlNReadNow` —
 * `PHASE2`, the identical adjacent-phase exclusion applied a second time
 * in this same feature) drives `ldHlNImm` onto the bus and RAM's own
 * `we`. RAM's own address bus gets two more override terms: `(HL)`'s own
 * (`HLMEM_READ_NOW` OR'd with `INCDEC_HLMEM_NOW`) and `LD (HL),n`'s own
 * `LDHLN_WRITE_NOW` (`PHASE3`-only — its own `PHASE2` still needs `PC`,
 * to read the immediate byte itself, a genuinely mixed addressing need
 * `INC (HL)`/`DEC (HL)` never has).
 *
 * Found live, and the worst decode bug this file has hit so far: the
 * first cut forced RAM's address with the *unconditional* `isIncDecHlMem`
 * (`dec.y`/`dec.z`, no phase gate at all), reasoned as "a single-byte
 * opcode with no other RAM activity to conflict with, so holding `HL` for
 * the instruction's entire lifetime is harmless." That reasoning missed
 * that `ir.q` itself doesn't update to the *next* opcode until the exact
 * same tick `FETCH`'s own read commits — so on that shared tick,
 * `isIncDecHlMem` was still reading the *old* `ir.q` (still `INC (HL)`/
 * `DEC (HL)`), still forcing the address to `HL`, at the precise moment
 * `FETCH` needed `PC`. The fetch silently read `RAM[HL]` instead of the
 * real next opcode and captured garbage into `ir` — a corrupted decode
 * that only surfaced as a wrong `A` two full instructions later (`LD
 * A,(HL)` reading a stale value after the write it depended on had
 * already gone through correctly), which is what made this one take four
 * rounds of a standalone debug build to chase down to the actual `ir`
 * bits rather than the RAM write itself. `hlNow` (this same file's own
 * x=10/x=01 `(HL)` addressing) never had this problem because it was
 * already `PHASE2`-scoped from the start (folded into `groupActive`,
 * itself `PHASE2`-gated) — it was never "unconditional across the whole
 * instruction" to begin with. The fix gives `(HL)`'s own RMW that same
 * discipline: force the address only during the two phases that actually
 * touch RAM (`HLMEM_READ_NOW` at `PHASE2`, `INCDEC_HLMEM_NOW` at
 * `PHASE3`), not for the instruction's entire lifetime. (A second,
 * smaller slip on the way to the fix: the replacement terms were wired
 * into a new OR stage that never actually fed the final address mux,
 * `INCDEC_HLMEM_NOW`'s own branch dead-ending one node short — same
 * symptom, caught by the same regression test on the very next run.)
 */
export function buildZ80Cpu(
  parent: Circuit,
  library: ChipLibrary,
  addrBits: number,
  program?: Uint8Array,
  pos: Point = { x: 0, y: 0 },
): Z80Cpu {
  parent.beginBatch();
  // Place control-logic gates as seeded stdcell chips (AND/OR/NOT/…) instead
  // of expanding ~17k transistors at place time. Flatten still sees the same
  // transistor guts via ChipDef expansion.
  setCircuitGatePlacer(parent, makeZ80GatePlacer(library));
  try {
    return buildZ80CpuInner(parent, library, addrBits, program, pos);
  } finally {
    setCircuitGatePlacer(parent, null);
    parent.endBatch();
  }
}

function buildZ80CpuInner(
  parent: Circuit,
  library: ChipLibrary,
  addrBits: number,
  program: Uint8Array | undefined,
  pos: Point,
): Z80Cpu {
  // One Source pair drives the global VCC/GND rails. Gate primitives attach
  // power through tiePowerRail (library.ts), which reuses these Source pins
  // instead of allocating a Label stub per transistor.
  const vcc = makeSource(parent, 1, { x: pos.x - 200, y: pos.y - 400 }).pins.out;
  const gnd = makeSource(parent, 0, { x: pos.x - 200, y: pos.y - 360 }).pins.out;
  // Alias names kept so existing buildAnd/Or/... call sites that still pass
  // a nearby rail pin compile; the pins are unused for gate power now.
  const vcc2 = vcc;
  const gnd2 = gnd;
  const vcc3 = vcc;
  const gnd3 = gnd;
  const vcc4 = vcc;
  const gnd4 = gnd;
  const vcc5 = vcc;
  const gnd5 = gnd;

  const pc = buildProgramCounter(parent, library, addrBits, { x: pos.x, y: pos.y });
  const ram = makeRam(parent, addrBits, 8, program, { x: pos.x + 1400, y: pos.y });
  const ir = buildInstructionRegister(parent, library, { x: pos.x + 2600, y: pos.y });
  const a = buildRegister(parent, library, 8, { x: pos.x + 3800, y: pos.y });
  const rB = buildRegister(parent, library, 8, { x: pos.x + 5000, y: pos.y });
  const rC = buildRegister(parent, library, 8, { x: pos.x + 5000, y: pos.y + 1200 });
  const rD = buildRegister(parent, library, 8, { x: pos.x + 6200, y: pos.y });
  const rE = buildRegister(parent, library, 8, { x: pos.x + 6200, y: pos.y + 1200 });
  const rH = buildRegister(parent, library, 8, { x: pos.x + 7400, y: pos.y });
  const rL = buildRegister(parent, library, 8, { x: pos.x + 7400, y: pos.y + 1200 });
  // B'/C'/D'/E'/H'/L' — real Z80's own shadow register-pair set, `EXX`'s
  // own registers: see "x=11: EXX" below for the three-pair swap itself.
  // Same "real CPU state, built here, wired later" reasoning as `aP`/`fP`
  // above.
  const bP = buildRegister(parent, library, 8, { x: pos.x + 5000, y: pos.y + 3800 });
  const cP = buildRegister(parent, library, 8, { x: pos.x + 5000, y: pos.y + 4600 });
  const dP = buildRegister(parent, library, 8, { x: pos.x + 6200, y: pos.y + 3800 });
  const eP = buildRegister(parent, library, 8, { x: pos.x + 6200, y: pos.y + 4600 });
  const hP = buildRegister(parent, library, 8, { x: pos.x + 7400, y: pos.y + 3800 });
  const lP = buildRegister(parent, library, 8, { x: pos.x + 7400, y: pos.y + 4600 });
  const f = buildRegister(parent, library, 8, { x: pos.x + 8000, y: pos.y + 2200 });
  const sp = buildRegister(parent, library, addrBits, { x: pos.x + 8000, y: pos.y + 3000 });
  // A'/F' — real Z80's own shadow accumulator/flags pair, `EX AF,AF'`'s own
  // register: see "x=00: EX AF,AF'" below for the swap itself. Built here,
  // alongside `a`/`f`, for the identical reason every other register lives
  // here — the swap wiring (needing `wrapWithPairCommit`, defined much
  // further down) happens later, but the registers themselves are real CPU
  // state, same as anything else in this block.
  const aP = buildRegister(parent, library, 8, { x: pos.x + 3800, y: pos.y + 3800 });
  const fP = buildRegister(parent, library, 8, { x: pos.x + 8000, y: pos.y + 3800 });
  // I/R — real Z80's interrupt-vector and refresh registers. Built here
  // alongside the other CPU state; `LD I,A`/`LD R,A`/`LD A,I`/`LD A,R`
  // (see "x=01, z=7, y=0..3" below) are the only ops that touch them.
  // R auto-increments on M1 (soft bumpR parity). P/V on LD A,I/R copies IFF2.
  // I is also the high byte of the IM2 vector address (see IRQ accept).
  const regI = buildRegister(parent, library, 8, { x: pos.x + 2600, y: pos.y + 3800 });
  const regR = buildRegister(parent, library, 8, { x: pos.x + 2600, y: pos.y + 4600 });
  // IX — real Z80's first index register, as two 8-bit halves (same shape
  // as H/L). Built here alongside I/R; DD-prefixed LD IX,nn / PUSH IX /
  // POP IX (see "DD: IX" below) are the first ops that touch them.
  // IY — second index register; FD-prefixed LD IY,nn / PUSH IY / POP IY
  // (see "FD: IY" below) mirror the IX slice. (IX+d)/(IY+d) LD slice below.
  const rIXH = buildRegister(parent, library, 8, { x: pos.x + 1400, y: pos.y + 3800 });
  const rIXL = buildRegister(parent, library, 8, { x: pos.x + 1400, y: pos.y + 4600 });
  const rIYH = buildRegister(parent, library, 8, { x: pos.x + 800, y: pos.y + 3800 });
  const rIYL = buildRegister(parent, library, 8, { x: pos.x + 800, y: pos.y + 4600 });
  // IRQ/NMI state — IFF1/IFF2, IM 0/1/2 latches, HALT, EI delay arms,
  // and one-instruction "serving" latches that suppress PHASE1's PC
  // advance while INT (RST 38h / IM0 bus opcode / IM2 push+vector) or
  // NMI (push+$0066) run. INT/NMI are genuine external sinks like ioPortDataIn.
  const iff1 = buildRegister(parent, library, 1, { x: pos.x + 2000, y: pos.y + 3800 });
  const iff2 = buildRegister(parent, library, 1, { x: pos.x + 2000, y: pos.y + 4000 });
  const im0 = buildRegister(parent, library, 1, { x: pos.x + 1800, y: pos.y + 4200 });
  const im1 = buildRegister(parent, library, 1, { x: pos.x + 2000, y: pos.y + 4200 });
  const im2 = buildRegister(parent, library, 1, { x: pos.x + 2200, y: pos.y + 4200 });
  const intServing = buildRegister(parent, library, 1, { x: pos.x + 2000, y: pos.y + 4400 });
  const nmiServing = buildRegister(parent, library, 1, { x: pos.x + 2200, y: pos.y + 4400 });
  const im2Serving = buildRegister(parent, library, 1, { x: pos.x + 2400, y: pos.y + 4400 });
  // INTACK window: latched on any maskable accept; PHASE0 = ack sample,
  // PHASE1 = wait hold (PC already suppressed via irqServing). Soft burns
  // ~2 wait units for the same window. Exposed as IORQ∧M1 bus pins
  // (instruction ring stays at 10; multi-T INTACK is this PHASE0+PHASE1 nest).
  const intAckServing = buildRegister(parent, library, 1, { x: pos.x + 2100, y: pos.y + 4360 });
  // Rising-edge NMI: `nmiPrev` samples the pin every PHASE0; accept when
  // pin high and prev low (soft is an explicit pulse — same one-shot feel).
  const nmiPrev = buildRegister(parent, library, 1, { x: pos.x + 2200, y: pos.y + 4600 });
  // Soft-style one-instruction EI delay: EI arms arm1; next PHASE0 moves
  // arm1→arm2; following PHASE0 commits IFF (arm2.q from prior cycle).
  // HALT sticks until INT/NMI-accept / CPU_RESET.
  const halted = buildRegister(parent, library, 1, { x: pos.x + 2000, y: pos.y + 4800 });
  const eiArm1 = buildRegister(parent, library, 1, { x: pos.x + 2400, y: pos.y + 3800 });
  const eiArm2 = buildRegister(parent, library, 1, { x: pos.x + 2400, y: pos.y + 4000 });
  const alu = buildAlu(parent, library, 8, { x: pos.x + 3400, y: pos.y + 2400 });
  const fsm = buildRingCounter(parent, library, 10, { x: pos.x, y: pos.y + 3600 }); // FETCH/INCREMENT/EXEC1-EXEC8 — see the doc comment above ("x=11: SP, PUSH/POP, RET, RST n" for why a 4th phase exists; "x=00, z=1: LD dd,nn" for why a 5th and 6th do too; "x=11: CALL nn" for why a 7th and 8th do too; DD/FD CB SET/RES/rot (IX+d)/(IY+d) for why a 9th and 10th do too — BIT fit in 8, but read+write after op needs PHASE8 and op-advance moved to PHASE9). Widening is, again, a pure parameter change — buildRingCounter is fully generic (any N>=2), and every existing PHASE0-PHASE7 label keeps its exact ring position, the two new phases appended after EXEC6, before the wrap back to FETCH.
  // Nested 4-T bus-cycle FSM (T0–T3). Both rings share phaseClk; the
  // instruction ring is *held* via load=1 + d←phase while busBusy (no
  // gated clock — switch-level AND on clk edges is unreliable here).
  const busCycle = buildRingCounter(parent, library, 4, { x: pos.x - 500, y: pos.y + 3600 });
  const busBusyReg = buildRegister(parent, library, 1, { x: pos.x - 500, y: pos.y + 4200 });
  const phaseClkHub = makeLabel(parent, 'PCLK', { x: pos.x - 80, y: pos.y + 3550 }).pins.net;
  wire(parent, phaseClkHub, busCycle.clk);
  wire(parent, phaseClkHub, fsm.clk);
  wire(parent, phaseClkHub, busBusyReg.clk);
  tiePowerRail(parent, 'VCC', busBusyReg.we);
  const dec = buildZ80Decoder(parent, ir.q, { x: pos.x + 8600, y: pos.y });
  const muxDef = getMux2Chip(library);
  const bufDef = getTriBufChip(library);
  // load = fsmLoadExt (boot seed). busBusy tracks nested IORQ windows but
  // does *not* freeze the instruction ring yet — holding PHASE while
  // stack/register WE stay phase-gated re-fires those WE on every dataClk
  // of the nest (SP -= 4 on INTACK). Soft intAckWaits(4) + busBusy pin give
  // Soft↔gate timing parity; full ring-hold needs one-shot WE first.
  const fsmLoadOr = buildOr(parent, { x: pos.x - 200, y: pos.y + 3500 });
  tiePowerRail(parent, 'GND', fsmLoadOr.b);
  wire(parent, fsmLoadOr.out, fsm.load);
  wire(parent, fsmLoadOr.a, busCycle.load); // seed bus T0 with the same external load
  wire(parent, fsmLoadOr.a, busCycle.d[0]!); // one-hot T0 when seeding
  for (let i = 1; i < 4; i++) tiePowerRail(parent, 'GND', busCycle.d[i]!);
  const notLoadExtEarly = buildNot(parent, { x: pos.x - 280, y: pos.y + 3480 });
  wire(parent, fsmLoadOr.a, notLoadExtEarly.in);
  const holdSel = buildAnd(parent, { x: pos.x - 220, y: pos.y + 3480 });
  tiePowerRail(parent, 'GND', holdSel.a); // hold path reserved (wire busy here later)
  wire(parent, notLoadExtEarly.out, holdSel.b);
  const fsmDExt: Pin[] = [];
  for (let i = 0; i < 10; i++) {
    const holdMux = makeChipInstance(parent, muxDef, { x: pos.x - 100, y: pos.y + 3600 + i * 40 });
    wire(parent, holdSel.out, holdMux.pins[muxDef.ports[0]!]!);
    fsmDExt.push(holdMux.pins[muxDef.ports[1]!]!); // in0: external seed
    wire(parent, fsm.phase[i]!, holdMux.pins[muxDef.ports[2]!]!); // in1: hold (idle)
    wire(parent, holdMux.pins[muxDef.ports[3]!]!, fsm.d[i]!);
  }

  // This composite is dense enough (100+ internal connections, several
  // signals fanned out across the whole coordinate space — CLK to 11
  // registers, the shared bus, both decoder outputs, both EXEC phase
  // bits, SP's own value) that drawing every one of them as a literal
  // point-to-point line makes the canvas unreadable, not just cluttered.
  // `tieToLabel` drops a *local* net label beside the pin — same net via
  // Circuit.computeNets()'s "same-named label" tie (same mechanism the
  // UI's own `label` tool already exposes), short stub only. A previous
  // optimisation reused one Label pin as an anchor and wired every far
  // fanout to it — that quietly recreated the long-wire spaghetti this
  // helper exists to kill. Used below for signals with genuinely
  // long-distance or multi-destination fanout; adjacent gates a few
  // dozen units apart stay plain `wire()` calls. A final
  // `replaceLongWiresWithLabels` pass after the whole CPU is built
  // catches anything that slipped through. Safe here specifically
  // because `buildZ80Cpu` is called once per placement, not folded into
  // a chip def instantiated multiple times — flatten() namespaces
  // component *ids* per instance but not a label's own `name` string
  // (see Circuit.ts), so reusing these names *inside* a
  // multiply-instantiated chip def would wrongly tie separate
  // instances' nets together. Two `buildZ80Cpu`s placed in the same
  // project and using these same names would collide the same way — a
  // real, documented limitation, not a hidden one.
  const tieToLabel = (name: string, p: Pin, _labelPos?: Point): void => {
    // Always beside `p` — callers used to pass a shared cluster coordinate
    // that left a long stub from a far pin to that one spot.
    const lbl = makeLabel(parent, name, { x: p.pos.x + 8, y: p.pos.y });
    wire(parent, p, lbl.pins.net);
  };
  tieToLabel('CPU_RESET', pc.reset, { x: pos.x - 50, y: pos.y - 80 }); // anchor — IFF/IM1 power-on clear (far)

  // `EX AF,AF'` (see "x=00: EX AF,AF'" above) is a real *swap*, both
  // directions committing on the same edge: A gets A''s old value, A' gets
  // A's old value, simultaneously (not sequentially — there is no
  // "sequentially" at the gate level, just two master-slave flip-flops
  // each freezing at whatever the *other's* `.q` stood at before this
  // edge, the identical old-value guarantee every register-to-register
  // capture in this file already relies on — see the `sp.q`-during-a-read
  // doc comment, "x=00: INC (HL)/DEC (HL)/LD (HL),n" above, for the
  // fullest treatment of why that's safe). `AOLD`/`FOLD` publish `a`/`f`'s
  // own current bits for the swap's A'/F'-bound half; A/F's own write mux
  // (far below) reads `aP`/`fP` directly by JS reference instead of a
  // label back the other way — `aP`/`fP` were created earlier, in scope
  // for the rest of this function, unlike `wrapWithPairCommit` (needed to
  // wire A'/F' themselves), which isn't defined until much further down.
  a.q.forEach((q, i) => tieToLabel(`AOLD${i}`, q, { x: pos.x + 3800, y: pos.y + 3820 + i * 20 }));
  f.q.forEach((q, i) => tieToLabel(`FOLD${i}`, q, { x: pos.x + 8000, y: pos.y + 3820 + i * 20 }));
  // `EXX` (see "x=11: EXX" below) is the identical three-pair version of
  // the same swap — `BOLD`/`COLD`/`DOLD`/`EOLD`/`HOLD`/`LOLD` publish
  // `rB`..`rL`'s own current bits the same way `AOLD`/`FOLD` just did.
  rB.q.forEach((q, i) => tieToLabel(`BOLD${i}`, q, { x: pos.x + 5000, y: pos.y + 3820 + i * 20 }));
  rC.q.forEach((q, i) => tieToLabel(`COLD${i}`, q, { x: pos.x + 5000, y: pos.y + 4620 + i * 20 }));
  rD.q.forEach((q, i) => tieToLabel(`DOLD${i}`, q, { x: pos.x + 6200, y: pos.y + 3820 + i * 20 }));
  rE.q.forEach((q, i) => tieToLabel(`EOLD${i}`, q, { x: pos.x + 6200, y: pos.y + 4620 + i * 20 }));
  rH.q.forEach((q, i) => tieToLabel(`HOLD${i}`, q, { x: pos.x + 7400, y: pos.y + 3820 + i * 20 }));
  rL.q.forEach((q, i) => tieToLabel(`LOLD${i}`, q, { x: pos.x + 7400, y: pos.y + 4620 + i * 20 }));
  regI.q.forEach((q, i) => {
    tieToLabel(`REGI${i}`, q, { x: pos.x + 2600, y: pos.y + 3820 + i * 20 });
    tieToLabel(`IOLD${i}`, q, { x: pos.x + 2650, y: pos.y + 3820 + i * 20 });
  });
  regR.q.forEach((q, i) => {
    tieToLabel(`REGR${i}`, q, { x: pos.x + 2600, y: pos.y + 4620 + i * 20 });
    tieToLabel(`ROLD${i}`, q, { x: pos.x + 2650, y: pos.y + 4620 + i * 20 });
  });
  rIXH.q.forEach((q, i) => tieToLabel(`REGIXH${i}`, q, { x: pos.x + 1400, y: pos.y + 3820 + i * 20 }));
  rIXL.q.forEach((q, i) => tieToLabel(`REGIXL${i}`, q, { x: pos.x + 1400, y: pos.y + 4620 + i * 20 }));
  rIYH.q.forEach((q, i) => tieToLabel(`REGIYH${i}`, q, { x: pos.x + 800, y: pos.y + 3820 + i * 20 }));
  rIYL.q.forEach((q, i) => tieToLabel(`REGIYL${i}`, q, { x: pos.x + 800, y: pos.y + 4620 + i * 20 }));

  // dec.z[] and most of dec.y[] stay direct wires — every consumer sits
  // within a thousand-ish units of `dec` itself (the x=11 decode section
  // right next to it). The ALU/flags section (pos.x+2900 to +4600) is a
  // genuinely long way from `dec` (pos.x+8600) and reuses y=0..7 several
  // times each — anchored here to DECY0-7 labels once, used at every far
  // site below instead of eight separate ~5000-unit lines each redrawn for
  // every one of their several consumers. y=1/y=3 (ADC/SBC) joined the
  // other six once this file actually started executing them, not just
  // decoding them — see "x=10: ADC/SBC" below.
  [0, 1, 2, 3, 4, 5, 6, 7].forEach((k, i) => tieToLabel(`DECY${k}`, dec.y[k]!, { x: pos.x + 8500, y: pos.y - 100 - i * 40 }));

  // fsm.phase[] fans out even wider than dec.y[] does — every phase bit
  // gates decode logic scattered from pos.x-200 (PC's own hold mux) to
  // pos.x+10500 (the push/pop byte-select banks), with `fsm` itself sitting
  // at pos.x,pos.y+3600 (below everything). Anchored to PHASE0-PHASE3
  // labels once each, right here, instead of redrawing that whole spread
  // as 13 separate long lines.
  fsm.phase.forEach((p, k) => tieToLabel(`PHASE${k}`, p!, { x: pos.x + k * 100, y: pos.y + 3500 }));

  // --- IRQ / NMI accept ---------------------------------------------------
  // Maskable INT when IFF1, (IM0∨IM1∨IM2), and external `int` are high at FETCH.
  // IM1 forces IR←0xFF (RST 38h); IM0 forces IR←irqBus; IM2 forces IR←NOP
  // then push+vector-fetch via im2Serving (softAcceptIrq IM2 parity).
  // NMI is rising-edge at PHASE0: clear IFF1 only, force IR←NOP, push PC and
  // jump $0066 via nmiServing (NMI wins over INT in the same FETCH).
  const im0OrIm1 = buildOr(parent, { x: pos.x + 2000, y: pos.y + 4580 });
  wire(parent, im0.q[0]!, im0OrIm1.a);
  wire(parent, im1.q[0]!, im0OrIm1.b);
  const intModeOk = buildOr(parent, { x: pos.x + 2025, y: pos.y + 4580 });
  wire(parent, im0OrIm1.out, intModeOk.a);
  wire(parent, im2.q[0]!, intModeOk.b);
  const intIffAndIm = buildAnd(parent, { x: pos.x + 2050, y: pos.y + 4600 });
  wire(parent, iff1.q[0]!, intIffAndIm.a);
  wire(parent, intModeOk.out, intIffAndIm.b);
  const intPending = buildAnd(parent, { x: pos.x + 2100, y: pos.y + 4600 });
  wire(parent, intIffAndIm.out, intPending.a);
  // Default INT low via an internal Input — every FETCH samples this, so a
  // floating pin would be unsafe the way unused `ioPortDataIn` bits are not.
  // Callers raise it through `intDrive.value` (exposed on the return object).
  const intDrive = makeInput(parent, 0, { x: pos.x + 1950, y: pos.y + 4600 });
  wire(parent, intDrive.pins.out, intPending.b);
  const intPin = intDrive.pins.out;
  // NMI pin + edge detect (prev sampled every PHASE0).
  const nmiDrive = makeInput(parent, 0, { x: pos.x + 1950, y: pos.y + 4680 });
  const nmiPin = nmiDrive.pins.out;
  const notNmiPrev = buildNot(parent, { x: pos.x + 2050, y: pos.y + 4680 });
  wire(parent, nmiPrev.q[0]!, notNmiPrev.in);
  const nmiEdge = buildAnd(parent, { x: pos.x + 2100, y: pos.y + 4680 });
  wire(parent, nmiPin, nmiEdge.a);
  wire(parent, notNmiPrev.out, nmiEdge.b);
  const nmiAcceptNow = buildAnd(parent, { x: pos.x + 2150, y: pos.y + 4680 });
  wire(parent, nmiEdge.out, nmiAcceptNow.a);
  tieToLabel('PHASE0', nmiAcceptNow.b, { x: pos.x + 2050, y: pos.y + 4700 });
  tieToLabel('NMI_ACCEPT_NOW', nmiAcceptNow.out, { x: pos.x + 2250, y: pos.y + 4680 });
  tieToLabel('PHASE0', nmiPrev.we, { x: pos.x + 2150, y: pos.y + 4620 });
  wire(parent, nmiPin, nmiPrev.d[0]!);
  // INT accept suppressed when NMI wins this FETCH.
  const notNmiAccept = buildNot(parent, { x: pos.x + 2200, y: pos.y + 4640 });
  wire(parent, nmiAcceptNow.out, notNmiAccept.in);
  const intAcceptGate = buildAnd(parent, { x: pos.x + 2150, y: pos.y + 4620 });
  wire(parent, intPending.out, intAcceptGate.a);
  wire(parent, notNmiAccept.out, intAcceptGate.b);
  const intAcceptNow = buildAnd(parent, { x: pos.x + 2200, y: pos.y + 4600 });
  wire(parent, intAcceptGate.out, intAcceptNow.a);
  tieToLabel('PHASE0', intAcceptNow.b, { x: pos.x + 2100, y: pos.y + 4620 });
  tieToLabel('INT_ACCEPT_NOW', intAcceptNow.out, { x: pos.x + 2300, y: pos.y + 4600 });
  // Split accept: IM0/IM1 inject an opcode into IR; IM2 runs a NOP shell
  // and fetches the ISR address from RAM[(I<<8)|irqBus].
  const im01AcceptNow = buildAnd(parent, { x: pos.x + 2250, y: pos.y + 4560 });
  wire(parent, intAcceptNow.out, im01AcceptNow.a);
  wire(parent, im0OrIm1.out, im01AcceptNow.b);
  tieToLabel('IM01_ACCEPT_NOW', im01AcceptNow.out, { x: pos.x + 2350, y: pos.y + 4560 });
  const im2AcceptNow = buildAnd(parent, { x: pos.x + 2250, y: pos.y + 4540 });
  wire(parent, intAcceptNow.out, im2AcceptNow.a);
  wire(parent, im2.q[0]!, im2AcceptNow.b);
  tieToLabel('IM2_ACCEPT_NOW', im2AcceptNow.out, { x: pos.x + 2350, y: pos.y + 4540 });
  const irqAcceptAny = buildOr(parent, { x: pos.x + 2350, y: pos.y + 4640 });
  wire(parent, intAcceptNow.out, irqAcceptAny.a);
  wire(parent, nmiAcceptNow.out, irqAcceptAny.b);
  tieToLabel('IRQ_ACCEPT_ANY', irqAcceptAny.out, { x: pos.x + 2450, y: pos.y + 4640 }); // R-inc suppress, IR force
  // INTACK bus sample — eight Inputs default 1 (0xFF). Used by IM0 IR force
  // and as the low byte of the IM2 vector address.
  const irqBusDrive = Array.from({ length: 8 }, (_, i) =>
    makeInput(parent, 1, { x: pos.x + 1850, y: pos.y + 4800 + i * 20 }),
  );
  irqBusDrive.forEach((inp, i) => {
    tieToLabel(`IRQBUS${i}`, inp.pins.out, { x: pos.x + 1900, y: pos.y + 4800 + i * 20 });
  });
  // Serving latches: written every FETCH (1 on accept, else 0).
  tieToLabel('PHASE0', intServing.we, { x: pos.x + 2050, y: pos.y + 4480 });
  wire(parent, im01AcceptNow.out, intServing.d[0]!);
  tieToLabel('PHASE0', nmiServing.we, { x: pos.x + 2250, y: pos.y + 4480 });
  wire(parent, nmiAcceptNow.out, nmiServing.d[0]!);
  tieToLabel('PHASE0', im2Serving.we, { x: pos.x + 2450, y: pos.y + 4480 });
  wire(parent, im2AcceptNow.out, im2Serving.d[0]!);
  // INTACK serving: any maskable accept (IM0/1/2), not NMI.
  tieToLabel('PHASE0', intAckServing.we, { x: pos.x + 2150, y: pos.y + 4460 });
  wire(parent, intAcceptNow.out, intAckServing.d[0]!);
  tieToLabel('INTACK_NOW', intAcceptNow.out, { x: pos.x + 2400, y: pos.y + 4580 }); // PHASE0 acknowledge sample
  const intAckWait = buildAnd(parent, { x: pos.x + 2500, y: pos.y + 4460 });
  wire(parent, intAckServing.q[0]!, intAckWait.a);
  tieToLabel('PHASE1', intAckWait.b, { x: pos.x + 2400, y: pos.y + 4460 });
  tieToLabel('INTACK_WAIT', intAckWait.out, { x: pos.x + 2600, y: pos.y + 4460 }); // PHASE1 wait hold
  // IORQ∧M1 window: accept pulse ∨ PHASE0 hold after latch ∨ PHASE1 wait.
  // (After dataClk on accept, IFF1 clears so intAcceptNow drops — serving.q
  // keeps IORQ high through the rest of PHASE0.)
  const intAckPhase0Hold = buildAnd(parent, { x: pos.x + 2550, y: pos.y + 4480 });
  wire(parent, intAckServing.q[0]!, intAckPhase0Hold.a);
  tieToLabel('PHASE0', intAckPhase0Hold.b, { x: pos.x + 2450, y: pos.y + 4480 });
  const iorqIntAckA = buildOr(parent, { x: pos.x + 2600, y: pos.y + 4490 });
  wire(parent, intAcceptNow.out, iorqIntAckA.a);
  wire(parent, intAckPhase0Hold.out, iorqIntAckA.b);
  const iorqIntAck = buildOr(parent, { x: pos.x + 2650, y: pos.y + 4480 });
  wire(parent, iorqIntAckA.out, iorqIntAck.a);
  wire(parent, intAckWait.out, iorqIntAck.b);
  tieToLabel('IORQ_INTACK', iorqIntAck.out, { x: pos.x + 2750, y: pos.y + 4480 });
  const irqServingIntNmi = buildOr(parent, { x: pos.x + 2300, y: pos.y + 4440 });
  wire(parent, intServing.q[0]!, irqServingIntNmi.a);
  wire(parent, nmiServing.q[0]!, irqServingIntNmi.b);
  const irqServingAny = buildOr(parent, { x: pos.x + 2350, y: pos.y + 4440 });
  wire(parent, irqServingIntNmi.out, irqServingAny.a);
  wire(parent, im2Serving.q[0]!, irqServingAny.b);
  // Widen PC-suppress with INTACK wait / nested busBusy so the ring stays
  // held while irqBus is stable across the 4-T ack window.
  const irqOrIntAck = buildOr(parent, { x: pos.x + 2400, y: pos.y + 4420 });
  wire(parent, irqServingAny.out, irqOrIntAck.a);
  wire(parent, intAckServing.q[0]!, irqOrIntAck.b);
  const irqOrBusBusy = buildOr(parent, { x: pos.x + 2420, y: pos.y + 4420 });
  wire(parent, irqOrIntAck.out, irqOrBusBusy.a);
  wire(parent, busBusyReg.q[0]!, irqOrBusBusy.b);
  const notIntServing = buildNot(parent, { x: pos.x + 2450, y: pos.y + 4440 });
  wire(parent, irqOrBusBusy.out, notIntServing.in);
  tieToLabel('NOT_INT_SERVING', notIntServing.out, { x: pos.x + 2550, y: pos.y + 4440 }); // PC PHASE1 suppress
  tieToLabel('INT_SERVING', intServing.q[0]!, { x: pos.x + 2550, y: pos.y + 4420 });
  tieToLabel('NMI_SERVING', nmiServing.q[0]!, { x: pos.x + 2550, y: pos.y + 4400 });
  tieToLabel('IM2_SERVING', im2Serving.q[0]!, { x: pos.x + 2550, y: pos.y + 4380 });
  tieToLabel('INTACK_SERVING', intAckServing.q[0]!, { x: pos.x + 2550, y: pos.y + 4360 });
  // NMI micro-ops: PHASE2 push PC (reuse stack write + PC bus bank), PHASE3 → $0066.
  const nmiPushNow = buildAnd(parent, { x: pos.x + 2600, y: pos.y + 4400 });
  wire(parent, nmiServing.q[0]!, nmiPushNow.a);
  tieToLabel('PHASE2', nmiPushNow.b, { x: pos.x + 2500, y: pos.y + 4400 });
  tieToLabel('NMI_PUSH_NOW', nmiPushNow.out, { x: pos.x + 2700, y: pos.y + 4400 });
  const nmiJumpNow = buildAnd(parent, { x: pos.x + 2600, y: pos.y + 4360 });
  wire(parent, nmiServing.q[0]!, nmiJumpNow.a);
  tieToLabel('PHASE3', nmiJumpNow.b, { x: pos.x + 2500, y: pos.y + 4360 });
  tieToLabel('NMI_JUMP_NOW', nmiJumpNow.out, { x: pos.x + 2700, y: pos.y + 4360 });
  // IM2 micro-ops (soft pushReturn + word-at-vector): PHASE2 push PC,
  // PHASE3 read ISR lo at vec, PHASE4 read ISR hi at vec+1 into PC.
  const im2PushNow = buildAnd(parent, { x: pos.x + 2600, y: pos.y + 4320 });
  wire(parent, im2Serving.q[0]!, im2PushNow.a);
  tieToLabel('PHASE2', im2PushNow.b, { x: pos.x + 2500, y: pos.y + 4320 });
  tieToLabel('IM2_PUSH_NOW', im2PushNow.out, { x: pos.x + 2700, y: pos.y + 4320 });
  const im2ReadLoNow = buildAnd(parent, { x: pos.x + 2600, y: pos.y + 4280 });
  wire(parent, im2Serving.q[0]!, im2ReadLoNow.a);
  tieToLabel('PHASE3', im2ReadLoNow.b, { x: pos.x + 2500, y: pos.y + 4280 });
  tieToLabel('IM2_READ_LO_NOW', im2ReadLoNow.out, { x: pos.x + 2700, y: pos.y + 4280 });
  const im2ReadHiNow = buildAnd(parent, { x: pos.x + 2600, y: pos.y + 4240 });
  wire(parent, im2Serving.q[0]!, im2ReadHiNow.a);
  tieToLabel('PHASE4', im2ReadHiNow.b, { x: pos.x + 2500, y: pos.y + 4240 });
  tieToLabel('IM2_READ_HI_NOW', im2ReadHiNow.out, { x: pos.x + 2700, y: pos.y + 4240 });
  // Vector address = (I<<8)|irqBus, truncated to addrBits (I zero-extends
  // into bits above 8 when addrBits>8; bits above I's width stay GND).
  const im2VecPlusOne = buildAlu(parent, library, addrBits, { x: pos.x + 1750, y: pos.y + 5000 });
  tiePowerRail(parent, 'GND', im2VecPlusOne.op0);
  tiePowerRail(parent, 'GND', im2VecPlusOne.op1);
  tiePowerRail(parent, 'VCC', im2VecPlusOne.cin);
  for (let i = 0; i < addrBits; i++) {
    if (i < 8) {
      tieToLabel(`IRQBUS${i}`, im2VecPlusOne.a[i]!, { x: pos.x + 1650, y: pos.y + 5000 + i * 20 });
      tieToLabel(`IM2VEC${i}`, im2VecPlusOne.a[i]!, { x: pos.x + 1850, y: pos.y + 5000 + i * 20 });
    } else if (i - 8 < 8) {
      wire(parent, regI.q[i - 8]!, im2VecPlusOne.a[i]!);
      tieToLabel(`IM2VEC${i}`, im2VecPlusOne.a[i]!, { x: pos.x + 1850, y: pos.y + 5000 + i * 20 });
    } else {
      tiePowerRail(parent, 'GND', im2VecPlusOne.a[i]!);
      tieToLabel(`IM2VEC${i}`, im2VecPlusOne.a[i]!, { x: pos.x + 1850, y: pos.y + 5000 + i * 20 });
    }
    tiePowerRail(parent, 'GND', im2VecPlusOne.b[i]!);
    tieToLabel(`IM2VEC1_${i}`, im2VecPlusOne.out[i]!, { x: pos.x + 1950, y: pos.y + 5000 + i * 20 });
  }

  // --- CB/ED/DD/FD prefix bytes --------------------------------------
  // Real Z80 puts all four prefix opcodes in x=11's own z=3/z=5 columns —
  // the four y-slots this project's own PUSH rp/CALL nn/JP nn/EX(SP),HL/
  // etc. groups never claimed: `CB`=0xCB (z=3,y=1, the one z=3 slot
  // "x=11: EX DE,HL" and friends left empty), `DD`/`ED`/`FD`=0xDD/0xED/
  // 0xFD (z=5,y=3/5/7, the three z=5 slots PUSH rp's own y=0,2,4,6 and
  // CALL nn's y=1 never claimed). No new decode table needed to *find*
  // them — `dec.x[3]`/`dec.z[3]`/`dec.z[5]`/`dec.y[1,3,5,7]` are exactly
  // the same lines every other x=11 feature already reads.
  //
  // The hard part isn't detecting a prefix byte, it's what happens once
  // one's been consumed. A real Z80 prefix byte doesn't execute anything
  // itself — it's "read one more byte, and interpret THAT one through a
  // completely different table." This project already has the exact
  // mechanism a second-byte read needs: `LD r,n`'s own PHASE2-read/
  // PHASE3-advance shape (see "x=00, z=6: LD r,n" above) — reused here
  // wholesale, except the destination this second read lands in is `ir`
  // itself (recapturing IR with the *real* opcode byte, not a data
  // operand), and PC's own address is already right (PHASE1's own
  // increment already moved it past the prefix byte before PHASE2 reads
  // again — the identical "PC already the default read address, no new
  // address-mux term needed" fact every immediate-reading feature already
  // relies on).
  //
  // Once IR is recaptured, `dec.x`/`dec.y`/`dec.z` combinationally reflect
  // the REAL opcode byte's own fields from PHASE2 onward — which collides
  // head-on with every table this file already built: `0xA0` (real Z80
  // `LDI`, once ED-prefixed) decomposes to `x=10,y=4,z=0`, exactly `AND B`
  // in the plain unprefixed table this project already executes. Nothing
  // about the existing `x=10`/`x=01`/`x=00`/`x=11` group gates knows to
  // stay quiet just because the byte they're looking at arrived via a
  // prefix. `activePrefix` (below) is a real one-hot latch — CB/DD/ED/FD,
  // whichever fired, captured the instant IR is recaptured — and
  // `notPrefixActive` (its own inverted OR) becomes a fifth term ANDed
  // into all four base group gates (`isX0Group`/`isLdGroup`/`isAluGroup`/
  // `isStackGroup`, redefined below using it, in place of the bare
  // `dec.x[N]` each used to be) — every one of the hundreds of gates
  // already built *on top of* those four inherits the exclusion for free,
  // without touching one of them individually. Read at PHASE2 itself
  // (this same tick's own recapture), `activePrefix` is still whatever
  // *last* instruction's own FETCH reset it to (a real register's `.q`
  // only moves on the next edge — the master-slave guarantee this whole
  // file already leans on everywhere else) — 0, always, since FETCH
  // (PHASE0) unconditionally resets it every single instruction — so the
  // exclusion is correctly *inactive* for a prefix byte's own first-byte
  // detection, and correctly *active* starting PHASE3 of the very same
  // instruction, once the real opcode byte has actually landed in `ir`.
  //
  // Nested `DD CB d op` / `FD CB d op` are partially modeled below via
  // `ddCbMode`/`fdCbMode` (BIT y,(IX+d)/(IY+d) only this slice). A prefix
  // immediately following another (real hardware restart) is still not
  // modeled — one-shot "prefix, then real opcode" does not restart.
  const rawStackGroup = dec.x[3]!;
  const isCbPrefixZ = buildAnd(parent, { x: pos.x + 8700, y: pos.y - 4200 });
  wire(parent, rawStackGroup, isCbPrefixZ.a);
  wire(parent, dec.z[3]!, isCbPrefixZ.b);
  const isCbPrefixRaw = buildAnd(parent, { x: pos.x + 8750, y: pos.y - 4200 });
  wire(parent, isCbPrefixZ.out, isCbPrefixRaw.a);
  wire(parent, dec.y[1]!, isCbPrefixRaw.b);
  const isPrefixZ5 = buildAnd(parent, { x: pos.x + 8700, y: pos.y - 4150 });
  wire(parent, rawStackGroup, isPrefixZ5.a);
  wire(parent, dec.z[5]!, isPrefixZ5.b);
  const isDdPrefixRaw = buildAnd(parent, { x: pos.x + 8750, y: pos.y - 4150 });
  wire(parent, isPrefixZ5.out, isDdPrefixRaw.a);
  wire(parent, dec.y[3]!, isDdPrefixRaw.b);
  const isEdPrefixRaw = buildAnd(parent, { x: pos.x + 8750, y: pos.y - 4100 });
  wire(parent, isPrefixZ5.out, isEdPrefixRaw.a);
  wire(parent, dec.y[5]!, isEdPrefixRaw.b);
  const isFdPrefixRaw = buildAnd(parent, { x: pos.x + 8750, y: pos.y - 4050 });
  wire(parent, isPrefixZ5.out, isFdPrefixRaw.a);
  wire(parent, dec.y[7]!, isFdPrefixRaw.b);

  const isAnyPrefixRawStage = buildOr(parent, { x: pos.x + 8800, y: pos.y - 4175 });
  wire(parent, isCbPrefixRaw.out, isAnyPrefixRawStage.a);
  wire(parent, isDdPrefixRaw.out, isAnyPrefixRawStage.b);
  const isAnyPrefixRawStage2 = buildOr(parent, { x: pos.x + 8800, y: pos.y - 4075 });
  wire(parent, isEdPrefixRaw.out, isAnyPrefixRawStage2.a);
  wire(parent, isFdPrefixRaw.out, isAnyPrefixRawStage2.b);
  const isAnyPrefixRaw = buildOr(parent, { x: pos.x + 8850, y: pos.y - 4125 });
  wire(parent, isAnyPrefixRawStage.out, isAnyPrefixRaw.a);
  wire(parent, isAnyPrefixRawStage2.out, isAnyPrefixRaw.b);

  const prefixReadNow = buildAnd(parent, { x: pos.x + 8900, y: pos.y - 4125 });
  wire(parent, isAnyPrefixRaw.out, prefixReadNow.a);
  tieToLabel('PHASE2', prefixReadNow.b, { x: pos.x + 8800, y: pos.y - 4125 });
  tieToLabel('PREFIX_READ_NOW', prefixReadNow.out, { x: pos.x + 9000, y: pos.y - 4125 }); // anchor — ramOeFinal (far) reads this via the label; `irWe` (right below) reads it by direct wire instead, same scope

  // `activePrefix`: a real 4-bit one-hot register, not just a combinational
  // signal — it has to survive from PHASE2 (when it's written) through
  // every later phase of this same instruction, long after `ir`'s own
  // recapture has overwritten the very bits `isCbPrefixRaw`/etc read to
  // detect it. `we=OR(PHASE0, prefixReadNow)` fires on *every* instruction's
  // own FETCH (writing all-zero — no prefix, the default) as well as on a
  // genuine prefix detection (writing the real one-hot value) — the same
  // "reset by default, override on the one condition that matters" mux-
  // ahead-of-`d` shape `aReset` already established for `A`.
  const activePrefix = buildRegister(parent, library, 4, { x: pos.x + 8900, y: pos.y - 6600 });
  tieToLabel('CLK', activePrefix.clk, { x: pos.x + 8900, y: pos.y - 6620 });
  const activePrefixWe = buildOr(parent, { x: pos.x + 8950, y: pos.y - 6500 });
  tieToLabel('PHASE0', activePrefixWe.a, { x: pos.x + 8850, y: pos.y - 6500 });
  wire(parent, prefixReadNow.out, activePrefixWe.b);
  wire(parent, activePrefixWe.out, activePrefix.we);
  const prefixBits = [isCbPrefixRaw.out, isDdPrefixRaw.out, isEdPrefixRaw.out, isFdPrefixRaw.out];
  for (let i = 0; i < 4; i++) {
    const dMux = makeChipInstance(parent, muxDef, { x: pos.x + 9000, y: pos.y - 6600 + i * 100 });
    tieToLabel('PHASE0', dMux.pins[muxDef.ports[0]!]!, { x: pos.x + 8900, y: pos.y - 6600 + i * 100 }); // sel: FETCH forces the reset branch
    wire(parent, prefixBits[i]!, dMux.pins[muxDef.ports[1]!]!); // in0: the freshly-detected prefix, valid only when PHASE0=0 (i.e. this write is really prefixReadNow's)
    tiePowerRail(parent, 'GND', dMux.pins[muxDef.ports[2]!]!); // in1: FETCH's own reset-to-0
    wire(parent, dMux.pins[muxDef.ports[3]!]!, activePrefix.d[i]!);
  }
  const isCbActive = activePrefix.q[0]!;
  const isDdActive = activePrefix.q[1]!;
  const isEdActive = activePrefix.q[2]!;
  const isFdActive = activePrefix.q[3]!;
  const anyPrefixActiveStage = buildOr(parent, { x: pos.x + 9100, y: pos.y - 6550 });
  wire(parent, isCbActive, anyPrefixActiveStage.a);
  wire(parent, isDdActive, anyPrefixActiveStage.b);
  const anyPrefixActiveStage2 = buildOr(parent, { x: pos.x + 9100, y: pos.y - 6450 });
  wire(parent, isEdActive, anyPrefixActiveStage2.a);
  wire(parent, isFdActive, anyPrefixActiveStage2.b);
  const anyPrefixActive = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6500 });
  wire(parent, anyPrefixActiveStage.out, anyPrefixActive.a);
  wire(parent, anyPrefixActiveStage2.out, anyPrefixActive.b);
  const notPrefixActive = buildNot(parent, { x: pos.x + 9200, y: pos.y - 6500 });
  wire(parent, anyPrefixActive.out, notPrefixActive.in);
  tieToLabel('NOT_PREFIX_ACTIVE', notPrefixActive.out, { x: pos.x + 9250, y: pos.y - 6500 }); // anchor — isX0Group/isLdGroup/isAluGroup/isStackGroup (all far) read this
  // PC's own second advance (below) needs this true for exactly one phase,
  // PHASE3 — not the bare latch, which stays high for the rest of the
  // instruction (see the "CB/ED/DD/FD prefix bytes" doc comment above for
  // why `pc.d`'s own mux only ever wants a fresh advance pulsed once, the
  // identical shape every other multi-byte read's own `*_ADVANCE_NOW`
  // already uses).
  const prefixAdvanceNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 6450 });
  wire(parent, anyPrefixActive.out, prefixAdvanceNow.a);
  tieToLabel('PHASE3', prefixAdvanceNow.b, { x: pos.x + 9150, y: pos.y - 6450 });
  tieToLabel('PREFIX_ADVANCE_NOW', prefixAdvanceNow.out, { x: pos.x + 9350, y: pos.y - 6450 }); // anchor — PC's own advance (far) reads this
  // `isCbActive`/`isDdActive`/`isFdActive` are real, correct, individually
  // addressable signals. `isEdActive` was the first labeled (LDI); CB's
  // own first consumer is register-only `BIT y,r` (see below), so
  // `isCbActive` gets a label too. DD's first consumer is LD IX,nn /
  // PUSH IX / POP IX (below); FD's is the IY mirror (also below).
  tieToLabel('IS_ED_ACTIVE', isEdActive, { x: pos.x + 9100, y: pos.y - 6350 }); // anchor — LDI's own decode (far) reads this
  tieToLabel('IS_CB_ACTIVE', isCbActive, { x: pos.x + 9100, y: pos.y - 6330 }); // anchor — BIT y,r (near) reads this
  tieToLabel('IS_DD_ACTIVE', isDdActive, { x: pos.x + 9100, y: pos.y - 6310 }); // anchor — LD IX,nn / PUSH IX / POP IX (near+far) read this
  tieToLabel('IS_FD_ACTIVE', isFdActive, { x: pos.x + 9100, y: pos.y - 6290 }); // anchor — LD IY,nn / PUSH IY / POP IY (near+far) read this

  // DD CB / FD CB nested mode: `activePrefix` is one-hot — after DD, PHASE2
  // recaptures CB into IR and latches `isDdActive`; `isCbActive` stays 0.
  // A separate 1-bit mode latch fires at PHASE3 (IR already holds CB) so the
  // CB table can run under DD/FD without rewriting `activePrefix` on the
  // second IR-only op recapture at PHASE6. See "DD CB / FD CB" in ARCHITECTURE.md.
  const ddCbMode = buildRegister(parent, library, 1, { x: pos.x + 8900, y: pos.y - 6700 });
  tieToLabel('CLK', ddCbMode.clk, { x: pos.x + 8900, y: pos.y - 6720 });
  const ddCbModeSetNow = buildAnd(parent, { x: pos.x + 8950, y: pos.y - 6680 });
  wire(parent, isDdActive, ddCbModeSetNow.a);
  wire(parent, isCbPrefixRaw.out, ddCbModeSetNow.b);
  const ddCbModeSetPhase = buildAnd(parent, { x: pos.x + 9000, y: pos.y - 6680 });
  wire(parent, ddCbModeSetNow.out, ddCbModeSetPhase.a);
  tieToLabel('PHASE3', ddCbModeSetPhase.b, { x: pos.x + 8900, y: pos.y - 6680 });
  const ddCbModeWe = buildOr(parent, { x: pos.x + 9050, y: pos.y - 6660 });
  tieToLabel('PHASE0', ddCbModeWe.a, { x: pos.x + 8950, y: pos.y - 6660 });
  wire(parent, ddCbModeSetPhase.out, ddCbModeWe.b);
  wire(parent, ddCbModeWe.out, ddCbMode.we);
  {
    const dMux = makeChipInstance(parent, muxDef, { x: pos.x + 9100, y: pos.y - 6700 });
    tieToLabel('PHASE0', dMux.pins[muxDef.ports[0]!]!, { x: pos.x + 9000, y: pos.y - 6700 });
    wire(parent, ddCbModeSetPhase.out, dMux.pins[muxDef.ports[1]!]!);
    tiePowerRail(parent, 'GND', dMux.pins[muxDef.ports[2]!]!);
    wire(parent, dMux.pins[muxDef.ports[3]!]!, ddCbMode.d[0]!);
  }
  tieToLabel('IS_DDCB_MODE', ddCbMode.q[0]!, { x: pos.x + 9200, y: pos.y - 6700 });

  const fdCbMode = buildRegister(parent, library, 1, { x: pos.x + 8900, y: pos.y - 6800 });
  tieToLabel('CLK', fdCbMode.clk, { x: pos.x + 8900, y: pos.y - 6820 });
  const fdCbModeSetNow = buildAnd(parent, { x: pos.x + 8950, y: pos.y - 6780 });
  wire(parent, isFdActive, fdCbModeSetNow.a);
  wire(parent, isCbPrefixRaw.out, fdCbModeSetNow.b);
  const fdCbModeSetPhase = buildAnd(parent, { x: pos.x + 9000, y: pos.y - 6780 });
  wire(parent, fdCbModeSetNow.out, fdCbModeSetPhase.a);
  tieToLabel('PHASE3', fdCbModeSetPhase.b, { x: pos.x + 8900, y: pos.y - 6780 });
  const fdCbModeWe = buildOr(parent, { x: pos.x + 9050, y: pos.y - 6760 });
  tieToLabel('PHASE0', fdCbModeWe.a, { x: pos.x + 8950, y: pos.y - 6760 });
  wire(parent, fdCbModeSetPhase.out, fdCbModeWe.b);
  wire(parent, fdCbModeWe.out, fdCbMode.we);
  {
    const dMux = makeChipInstance(parent, muxDef, { x: pos.x + 9100, y: pos.y - 6800 });
    tieToLabel('PHASE0', dMux.pins[muxDef.ports[0]!]!, { x: pos.x + 9000, y: pos.y - 6800 });
    wire(parent, fdCbModeSetPhase.out, dMux.pins[muxDef.ports[1]!]!);
    tiePowerRail(parent, 'GND', dMux.pins[muxDef.ports[2]!]!);
    wire(parent, dMux.pins[muxDef.ports[3]!]!, fdCbMode.d[0]!);
  }
  tieToLabel('IS_FDCB_MODE', fdCbMode.q[0]!, { x: pos.x + 9200, y: pos.y - 6800 });

  const ddFdCbMode = buildOr(parent, { x: pos.x + 9250, y: pos.y - 6750 });
  wire(parent, ddCbMode.q[0]!, ddFdCbMode.a);
  wire(parent, fdCbMode.q[0]!, ddFdCbMode.b);
  const notDdFdCbMode = buildNot(parent, { x: pos.x + 9300, y: pos.y - 6750 });
  wire(parent, ddFdCbMode.out, notDdFdCbMode.in);
  const cbTableActiveStage = buildOr(parent, { x: pos.x + 9250, y: pos.y - 6720 });
  wire(parent, isCbActive, cbTableActiveStage.a);
  wire(parent, ddCbMode.q[0]!, cbTableActiveStage.b);
  const cbTableActive = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6720 });
  wire(parent, cbTableActiveStage.out, cbTableActive.a);
  wire(parent, fdCbMode.q[0]!, cbTableActive.b);

  // DD: LD IX,nn (real 0xDD 0x21 nn nn) — after the prefix burns PHASE2
  // (IR recapture) and PHASE3 (PREFIX_ADVANCE), the body reuses
  // unprefixed `LD dd,nn`'s own read-low/advance/read-high/advance shape
  // shifted to PHASE4-7. Decode is DD-gated on raw `dec.x`/`dec.y`/
  // `dec.z` — `NOT_PREFIX_ACTIVE` already keeps unprefixed `LD HL,nn`
  // quiet under DD, so this parallel path is the only one that fires.
  // Adjacent-phase exclusions mirror EDNN (ring-counter transient).
  const isLdIxNnX = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6280 });
  wire(parent, isDdActive, isLdIxNnX.a);
  wire(parent, dec.x[0]!, isLdIxNnX.b);
  const isLdIxNnZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 6280 });
  wire(parent, isLdIxNnX.out, isLdIxNnZ.a);
  wire(parent, dec.z[1]!, isLdIxNnZ.b);
  const isLdIxNn = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6280 });
  wire(parent, isLdIxNnZ.out, isLdIxNn.a);
  wire(parent, dec.y[4]!, isLdIxNn.b);

  const ldIxNnLowNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6280 });
  wire(parent, isLdIxNn.out, ldIxNnLowNow.a);
  tieToLabel('PHASE4', ldIxNnLowNow.b, { x: pos.x + 9250, y: pos.y - 6280 });
  tieToLabel('LDIXNN_LOW_NOW', ldIxNnLowNow.out, { x: pos.x + 9450, y: pos.y - 6280 }); // anchor — ram.oe, IXL write-back

  const ldIxNnLowAdvRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6250 });
  wire(parent, isLdIxNn.out, ldIxNnLowAdvRaw.a);
  tieToLabel('PHASE5', ldIxNnLowAdvRaw.b, { x: pos.x + 9250, y: pos.y - 6250 });
  const notLdIxNnLowNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 6265 });
  wire(parent, ldIxNnLowNow.out, notLdIxNnLowNow.in);
  const ldIxNnLowAdvanceNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 6250 });
  wire(parent, ldIxNnLowAdvRaw.out, ldIxNnLowAdvanceNow.a);
  wire(parent, notLdIxNnLowNow.out, ldIxNnLowAdvanceNow.b);
  tieToLabel('LDIXNN_LOW_ADVANCE_NOW', ldIxNnLowAdvanceNow.out, { x: pos.x + 9550, y: pos.y - 6250 }); // anchor — pcHold

  const ldIxNnHighRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6220 });
  wire(parent, isLdIxNn.out, ldIxNnHighRaw.a);
  tieToLabel('PHASE6', ldIxNnHighRaw.b, { x: pos.x + 9250, y: pos.y - 6220 });
  const notLdIxNnLowAdvNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 6235 });
  wire(parent, ldIxNnLowAdvanceNow.out, notLdIxNnLowAdvNow.in);
  const ldIxNnHighNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 6220 });
  wire(parent, ldIxNnHighRaw.out, ldIxNnHighNow.a);
  wire(parent, notLdIxNnLowAdvNow.out, ldIxNnHighNow.b);
  tieToLabel('LDIXNN_HIGH_NOW', ldIxNnHighNow.out, { x: pos.x + 9550, y: pos.y - 6220 }); // anchor — ram.oe, IXH write-back

  const ldIxNnHighAdvRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6190 });
  wire(parent, isLdIxNn.out, ldIxNnHighAdvRaw.a);
  tieToLabel('PHASE7', ldIxNnHighAdvRaw.b, { x: pos.x + 9250, y: pos.y - 6190 });
  const notLdIxNnHighNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 6205 });
  wire(parent, ldIxNnHighNow.out, notLdIxNnHighNow.in);
  const ldIxNnHighAdvanceNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 6190 });
  wire(parent, ldIxNnHighAdvRaw.out, ldIxNnHighAdvanceNow.a);
  wire(parent, notLdIxNnHighNow.out, ldIxNnHighAdvanceNow.b);
  tieToLabel('LDIXNN_HIGH_ADVANCE_NOW', ldIxNnHighAdvanceNow.out, { x: pos.x + 9550, y: pos.y - 6190 }); // anchor — pcHold

  // DD: PUSH IX (0xDD 0xE5) / POP IX (0xDD 0xE1) — HL pair shapes after
  // the prefix burns PHASE2–3, so the body sits on PHASE4–5. Parallel
  // DD-gated decode on raw `dec.x[3]` (unprefixed PUSH/POP HL stay quiet
  // under `NOT_PREFIX_ACTIVE`).
  const isDdStackX = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6150 });
  wire(parent, isDdActive, isDdStackX.a);
  wire(parent, dec.x[3]!, isDdStackX.b);
  const isPushIxZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 6150 });
  wire(parent, isDdStackX.out, isPushIxZ.a);
  wire(parent, dec.z[5]!, isPushIxZ.b);
  const isPushIx = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6150 });
  wire(parent, isPushIxZ.out, isPushIx.a);
  wire(parent, dec.y[4]!, isPushIx.b);
  const pushIxHighNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6150 });
  wire(parent, isPushIx.out, pushIxHighNow.a);
  tieToLabel('PHASE4', pushIxHighNow.b, { x: pos.x + 9250, y: pos.y - 6150 });
  tieToLabel('PUSHIX_HIGH_NOW', pushIxHighNow.out, { x: pos.x + 9450, y: pos.y - 6150 }); // anchor — stackWriteNow, IXH→bus
  const notPushIxHighNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 6130 });
  wire(parent, pushIxHighNow.out, notPushIxHighNow.in);
  const pushIxLowStage = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6120 });
  wire(parent, isPushIx.out, pushIxLowStage.a);
  tieToLabel('PHASE5', pushIxLowStage.b, { x: pos.x + 9250, y: pos.y - 6120 });
  const pushIxLowNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 6120 });
  wire(parent, pushIxLowStage.out, pushIxLowNow.a);
  wire(parent, notPushIxHighNow.out, pushIxLowNow.b);
  tieToLabel('PUSHIX_LOW_NOW', pushIxLowNow.out, { x: pos.x + 9550, y: pos.y - 6120 }); // anchor — stackWriteNow, IXL→bus

  const isPopIxZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 6090 });
  wire(parent, isDdStackX.out, isPopIxZ.a);
  wire(parent, dec.z[1]!, isPopIxZ.b);
  const isPopIx = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6090 });
  wire(parent, isPopIxZ.out, isPopIx.a);
  wire(parent, dec.y[4]!, isPopIx.b);
  const popIxLowNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6090 });
  wire(parent, isPopIx.out, popIxLowNow.a);
  tieToLabel('PHASE4', popIxLowNow.b, { x: pos.x + 9250, y: pos.y - 6090 });
  tieToLabel('POPIX_LOW_NOW', popIxLowNow.out, { x: pos.x + 9450, y: pos.y - 6090 }); // anchor — readNow, IXL write-back
  const popIxHighNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6060 });
  wire(parent, isPopIx.out, popIxHighNow.a);
  tieToLabel('PHASE5', popIxHighNow.b, { x: pos.x + 9250, y: pos.y - 6060 });
  tieToLabel('POPIX_HIGH_NOW', popIxHighNow.out, { x: pos.x + 9450, y: pos.y - 6060 }); // anchor — readNow, IXH write-back

  // FD: LD IY,nn (real 0xFD 0x21 nn nn) — mechanical mirror of DD LD IX,nn
  // above, gated on `isFdActive` instead of `isDdActive`. Same PHASE4–7
  // shape; adjacent-phase exclusions identical.
  const isLdIyNnX = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6020 });
  wire(parent, isFdActive, isLdIyNnX.a);
  wire(parent, dec.x[0]!, isLdIyNnX.b);
  const isLdIyNnZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 6020 });
  wire(parent, isLdIyNnX.out, isLdIyNnZ.a);
  wire(parent, dec.z[1]!, isLdIyNnZ.b);
  const isLdIyNn = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6020 });
  wire(parent, isLdIyNnZ.out, isLdIyNn.a);
  wire(parent, dec.y[4]!, isLdIyNn.b);

  const ldIyNnLowNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6020 });
  wire(parent, isLdIyNn.out, ldIyNnLowNow.a);
  tieToLabel('PHASE4', ldIyNnLowNow.b, { x: pos.x + 9250, y: pos.y - 6020 });
  tieToLabel('LDIYNN_LOW_NOW', ldIyNnLowNow.out, { x: pos.x + 9450, y: pos.y - 6020 }); // anchor — ram.oe, IYL write-back

  const ldIyNnLowAdvRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5990 });
  wire(parent, isLdIyNn.out, ldIyNnLowAdvRaw.a);
  tieToLabel('PHASE5', ldIyNnLowAdvRaw.b, { x: pos.x + 9250, y: pos.y - 5990 });
  const notLdIyNnLowNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 6005 });
  wire(parent, ldIyNnLowNow.out, notLdIyNnLowNow.in);
  const ldIyNnLowAdvanceNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5990 });
  wire(parent, ldIyNnLowAdvRaw.out, ldIyNnLowAdvanceNow.a);
  wire(parent, notLdIyNnLowNow.out, ldIyNnLowAdvanceNow.b);
  tieToLabel('LDIYNN_LOW_ADVANCE_NOW', ldIyNnLowAdvanceNow.out, { x: pos.x + 9550, y: pos.y - 5990 }); // anchor — pcHold

  const ldIyNnHighRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5960 });
  wire(parent, isLdIyNn.out, ldIyNnHighRaw.a);
  tieToLabel('PHASE6', ldIyNnHighRaw.b, { x: pos.x + 9250, y: pos.y - 5960 });
  const notLdIyNnLowAdvNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5975 });
  wire(parent, ldIyNnLowAdvanceNow.out, notLdIyNnLowAdvNow.in);
  const ldIyNnHighNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5960 });
  wire(parent, ldIyNnHighRaw.out, ldIyNnHighNow.a);
  wire(parent, notLdIyNnLowAdvNow.out, ldIyNnHighNow.b);
  tieToLabel('LDIYNN_HIGH_NOW', ldIyNnHighNow.out, { x: pos.x + 9550, y: pos.y - 5960 }); // anchor — ram.oe, IYH write-back

  const ldIyNnHighAdvRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5930 });
  wire(parent, isLdIyNn.out, ldIyNnHighAdvRaw.a);
  tieToLabel('PHASE7', ldIyNnHighAdvRaw.b, { x: pos.x + 9250, y: pos.y - 5930 });
  const notLdIyNnHighNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5945 });
  wire(parent, ldIyNnHighNow.out, notLdIyNnHighNow.in);
  const ldIyNnHighAdvanceNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5930 });
  wire(parent, ldIyNnHighAdvRaw.out, ldIyNnHighAdvanceNow.a);
  wire(parent, notLdIyNnHighNow.out, ldIyNnHighAdvanceNow.b);
  tieToLabel('LDIYNN_HIGH_ADVANCE_NOW', ldIyNnHighAdvanceNow.out, { x: pos.x + 9550, y: pos.y - 5930 }); // anchor — pcHold

  // FD: PUSH IY (0xFD 0xE5) / POP IY (0xFD 0xE1) — mirror of PUSH/POP IX.
  const isFdStackX = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5890 });
  wire(parent, isFdActive, isFdStackX.a);
  wire(parent, dec.x[3]!, isFdStackX.b);
  const isPushIyZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5890 });
  wire(parent, isFdStackX.out, isPushIyZ.a);
  wire(parent, dec.z[5]!, isPushIyZ.b);
  const isPushIy = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5890 });
  wire(parent, isPushIyZ.out, isPushIy.a);
  wire(parent, dec.y[4]!, isPushIy.b);
  const pushIyHighNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5890 });
  wire(parent, isPushIy.out, pushIyHighNow.a);
  tieToLabel('PHASE4', pushIyHighNow.b, { x: pos.x + 9250, y: pos.y - 5890 });
  tieToLabel('PUSHIY_HIGH_NOW', pushIyHighNow.out, { x: pos.x + 9450, y: pos.y - 5890 }); // anchor — stackWriteNow, IYH→bus
  const notPushIyHighNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5870 });
  wire(parent, pushIyHighNow.out, notPushIyHighNow.in);
  const pushIyLowStage = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5860 });
  wire(parent, isPushIy.out, pushIyLowStage.a);
  tieToLabel('PHASE5', pushIyLowStage.b, { x: pos.x + 9250, y: pos.y - 5860 });
  const pushIyLowNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5860 });
  wire(parent, pushIyLowStage.out, pushIyLowNow.a);
  wire(parent, notPushIyHighNow.out, pushIyLowNow.b);
  tieToLabel('PUSHIY_LOW_NOW', pushIyLowNow.out, { x: pos.x + 9550, y: pos.y - 5860 }); // anchor — stackWriteNow, IYL→bus

  const isPopIyZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5830 });
  wire(parent, isFdStackX.out, isPopIyZ.a);
  wire(parent, dec.z[1]!, isPopIyZ.b);
  const isPopIy = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5830 });
  wire(parent, isPopIyZ.out, isPopIy.a);
  wire(parent, dec.y[4]!, isPopIy.b);
  const popIyLowNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5830 });
  wire(parent, isPopIy.out, popIyLowNow.a);
  tieToLabel('PHASE4', popIyLowNow.b, { x: pos.x + 9250, y: pos.y - 5830 });
  tieToLabel('POPIY_LOW_NOW', popIyLowNow.out, { x: pos.x + 9450, y: pos.y - 5830 }); // anchor — readNow, IYL write-back
  const popIyHighNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5800 });
  wire(parent, isPopIy.out, popIyHighNow.a);
  tieToLabel('PHASE5', popIyHighNow.b, { x: pos.x + 9250, y: pos.y - 5800 });
  tieToLabel('POPIY_HIGH_NOW', popIyHighNow.out, { x: pos.x + 9450, y: pos.y - 5800 }); // anchor — readNow, IYH write-back

  // DD/FD HL-clone slice (no displacement): ADD IX/IY,rr; INC/DEC IX/IY;
  // JP (IX/IY); LD SP,IX/IY; EX (SP),IX/IY. Parallel decode on raw
  // `dec.x/y/z` ∧ `isDdActive`/`isFdActive` — never reopen
  // `isX0Group`/`isStackGroup` (`NOT_PREFIX_ACTIVE` kills those under
  // prefix). Prefixed bodies start at PHASE4 (prefix burns PHASE2–3).
  // Odd-y fold for ADD IX/IY,rr — same shape as isAddHlYValid (built
  // later for unprefixed ADD HL,rr); duplicated here so this cluster
  // stays next to the other DD/FD bodies.
  const isAddIxYValid1 = buildOr(parent, { x: pos.x + 9200, y: pos.y - 5760 });
  wire(parent, dec.y[1]!, isAddIxYValid1.a);
  wire(parent, dec.y[3]!, isAddIxYValid1.b);
  const isAddIxYValid2 = buildOr(parent, { x: pos.x + 9200, y: pos.y - 5730 });
  wire(parent, isAddIxYValid1.out, isAddIxYValid2.a);
  wire(parent, dec.y[5]!, isAddIxYValid2.b);
  const isAddIxYValid = buildOr(parent, { x: pos.x + 9200, y: pos.y - 5700 });
  wire(parent, isAddIxYValid2.out, isAddIxYValid.a);
  wire(parent, dec.y[7]!, isAddIxYValid.b);

  const isAddIxX = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5700 });
  wire(parent, isDdActive, isAddIxX.a);
  wire(parent, dec.x[0]!, isAddIxX.b);
  const isAddIxZ = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5700 });
  wire(parent, isAddIxX.out, isAddIxZ.a);
  wire(parent, dec.z[1]!, isAddIxZ.b);
  const isAddIxRr = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5700 });
  wire(parent, isAddIxZ.out, isAddIxRr.a);
  wire(parent, isAddIxYValid.out, isAddIxRr.b);
  const addIxNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 5700 });
  wire(parent, isAddIxRr.out, addIxNow.a);
  tieToLabel('PHASE4', addIxNow.b, { x: pos.x + 9300, y: pos.y - 5700 });
  tieToLabel('ADDIX_NOW', addIxNow.out, { x: pos.x + 9500, y: pos.y - 5700 }); // anchor — IX write-back, F C mux / we

  const isAddIyX = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5670 });
  wire(parent, isFdActive, isAddIyX.a);
  wire(parent, dec.x[0]!, isAddIyX.b);
  const isAddIyZ = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5670 });
  wire(parent, isAddIyX.out, isAddIyZ.a);
  wire(parent, dec.z[1]!, isAddIyZ.b);
  const isAddIyRr = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5670 });
  wire(parent, isAddIyZ.out, isAddIyRr.a);
  wire(parent, isAddIxYValid.out, isAddIyRr.b);
  const addIyNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 5670 });
  wire(parent, isAddIyRr.out, addIyNow.a);
  tieToLabel('PHASE4', addIyNow.b, { x: pos.x + 9300, y: pos.y - 5670 });
  tieToLabel('ADDIY_NOW', addIyNow.out, { x: pos.x + 9500, y: pos.y - 5670 }); // anchor — IY write-back, F C mux / we

  // INC/DEC IX/IY (DD/FD 0x23/0x2B) — z=3, y=4/5 (HL pair slot).
  const isIncDecIxX = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5640 });
  wire(parent, isDdActive, isIncDecIxX.a);
  wire(parent, dec.x[0]!, isIncDecIxX.b);
  const isIncDecIxZ = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5640 });
  wire(parent, isIncDecIxX.out, isIncDecIxZ.a);
  wire(parent, dec.z[3]!, isIncDecIxZ.b);
  const isIncDecIxY = buildOr(parent, { x: pos.x + 9350, y: pos.y - 5640 });
  wire(parent, dec.y[4]!, isIncDecIxY.a);
  wire(parent, dec.y[5]!, isIncDecIxY.b);
  const isIncDecIx = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 5640 });
  wire(parent, isIncDecIxZ.out, isIncDecIx.a);
  wire(parent, isIncDecIxY.out, isIncDecIx.b);
  const incDecIxNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5640 });
  wire(parent, isIncDecIx.out, incDecIxNow.a);
  tieToLabel('PHASE4', incDecIxNow.b, { x: pos.x + 9350, y: pos.y - 5640 });
  tieToLabel('INCDEC_IX_NOW', incDecIxNow.out, { x: pos.x + 9550, y: pos.y - 5640 }); // anchor — IX write-back from IXADD

  const isIncDecIyX = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5610 });
  wire(parent, isFdActive, isIncDecIyX.a);
  wire(parent, dec.x[0]!, isIncDecIyX.b);
  const isIncDecIyZ = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5610 });
  wire(parent, isIncDecIyX.out, isIncDecIyZ.a);
  wire(parent, dec.z[3]!, isIncDecIyZ.b);
  const isIncDecIy = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 5610 });
  wire(parent, isIncDecIyZ.out, isIncDecIy.a);
  wire(parent, isIncDecIxY.out, isIncDecIy.b);
  const incDecIyNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5610 });
  wire(parent, isIncDecIy.out, incDecIyNow.a);
  tieToLabel('PHASE4', incDecIyNow.b, { x: pos.x + 9350, y: pos.y - 5610 });
  tieToLabel('INCDEC_IY_NOW', incDecIyNow.out, { x: pos.x + 9550, y: pos.y - 5610 }); // anchor — IY write-back from IYADD

  // JP (IX/IY) (DD/FD 0xE9) / LD SP,IX/IY (DD/FD 0xF9) — reuse isDdStackX /
  // isFdStackX (already isDd/Fd ∧ x[3]).
  const isJpIx = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5580 });
  wire(parent, isDdStackX.out, isJpIx.a);
  wire(parent, dec.z[1]!, isJpIx.b);
  const isJpIxY = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5580 });
  wire(parent, isJpIx.out, isJpIxY.a);
  wire(parent, dec.y[5]!, isJpIxY.b);
  const jpIxNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5580 });
  wire(parent, isJpIxY.out, jpIxNow.a);
  tieToLabel('PHASE4', jpIxNow.b, { x: pos.x + 9250, y: pos.y - 5580 });
  tieToLabel('JPIX_NOW', jpIxNow.out, { x: pos.x + 9450, y: pos.y - 5580 }); // anchor — PC mux

  const isJpIy = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5550 });
  wire(parent, isFdStackX.out, isJpIy.a);
  wire(parent, dec.z[1]!, isJpIy.b);
  const isJpIyY = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5550 });
  wire(parent, isJpIy.out, isJpIyY.a);
  wire(parent, dec.y[5]!, isJpIyY.b);
  const jpIyNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5550 });
  wire(parent, isJpIyY.out, jpIyNow.a);
  tieToLabel('PHASE4', jpIyNow.b, { x: pos.x + 9250, y: pos.y - 5550 });
  tieToLabel('JPIY_NOW', jpIyNow.out, { x: pos.x + 9450, y: pos.y - 5550 }); // anchor — PC mux

  const isLdSpIx = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5520 });
  wire(parent, isDdStackX.out, isLdSpIx.a);
  wire(parent, dec.z[1]!, isLdSpIx.b);
  const isLdSpIxY = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5520 });
  wire(parent, isLdSpIx.out, isLdSpIxY.a);
  wire(parent, dec.y[7]!, isLdSpIxY.b);
  const ldSpIxNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5520 });
  wire(parent, isLdSpIxY.out, ldSpIxNow.a);
  tieToLabel('PHASE4', ldSpIxNow.b, { x: pos.x + 9250, y: pos.y - 5520 });
  tieToLabel('LDSPIX_NOW', ldSpIxNow.out, { x: pos.x + 9450, y: pos.y - 5520 }); // anchor — SP mux / we

  const isLdSpIy = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5490 });
  wire(parent, isFdStackX.out, isLdSpIy.a);
  wire(parent, dec.z[1]!, isLdSpIy.b);
  const isLdSpIyY = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5490 });
  wire(parent, isLdSpIy.out, isLdSpIyY.a);
  wire(parent, dec.y[7]!, isLdSpIyY.b);
  const ldSpIyNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5490 });
  wire(parent, isLdSpIyY.out, ldSpIyNow.a);
  tieToLabel('PHASE4', ldSpIyNow.b, { x: pos.x + 9250, y: pos.y - 5490 });
  tieToLabel('LDSPIY_NOW', ldSpIyNow.out, { x: pos.x + 9450, y: pos.y - 5490 }); // anchor — SP mux / we

  // EX (SP),IX/IY (DD/FD 0xE3) — PHASE4–7, adjacent-phase exclusions
  // (EXSPHL's PHASE2–5 shape shifted by two). Shares spLo/HiTemp,
  // oldL/HTemp, exSpHlPlusOne, and the EXSPHL addr mux layers via OR'd
  // strobes (widened far below).
  const isExSpIxZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5460 });
  wire(parent, isDdStackX.out, isExSpIxZ.a);
  wire(parent, dec.z[3]!, isExSpIxZ.b);
  const isExSpIx = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5460 });
  wire(parent, isExSpIxZ.out, isExSpIx.a);
  wire(parent, dec.y[4]!, isExSpIx.b);

  const exSpIxReadLowNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5460 });
  wire(parent, isExSpIx.out, exSpIxReadLowNow.a);
  tieToLabel('PHASE4', exSpIxReadLowNow.b, { x: pos.x + 9250, y: pos.y - 5460 });
  tieToLabel('EXSPIX_READ_LOW_NOW', exSpIxReadLowNow.out, { x: pos.x + 9450, y: pos.y - 5460 });

  const exSpIxReadHighRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5430 });
  wire(parent, isExSpIx.out, exSpIxReadHighRaw.a);
  tieToLabel('PHASE5', exSpIxReadHighRaw.b, { x: pos.x + 9250, y: pos.y - 5430 });
  const notExSpIxReadLowNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5445 });
  wire(parent, exSpIxReadLowNow.out, notExSpIxReadLowNow.in);
  const exSpIxReadHighNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5430 });
  wire(parent, exSpIxReadHighRaw.out, exSpIxReadHighNow.a);
  wire(parent, notExSpIxReadLowNow.out, exSpIxReadHighNow.b);
  tieToLabel('EXSPIX_READ_HIGH_NOW', exSpIxReadHighNow.out, { x: pos.x + 9550, y: pos.y - 5430 });

  const exSpIxWriteLowRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5400 });
  wire(parent, isExSpIx.out, exSpIxWriteLowRaw.a);
  tieToLabel('PHASE6', exSpIxWriteLowRaw.b, { x: pos.x + 9250, y: pos.y - 5400 });
  const notExSpIxReadHighNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5415 });
  wire(parent, exSpIxReadHighNow.out, notExSpIxReadHighNow.in);
  const exSpIxWriteLowNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5400 });
  wire(parent, exSpIxWriteLowRaw.out, exSpIxWriteLowNow.a);
  wire(parent, notExSpIxReadHighNow.out, exSpIxWriteLowNow.b);
  tieToLabel('EXSPIX_WRITE_LOW_NOW', exSpIxWriteLowNow.out, { x: pos.x + 9550, y: pos.y - 5400 });

  const exSpIxWriteHighRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5370 });
  wire(parent, isExSpIx.out, exSpIxWriteHighRaw.a);
  tieToLabel('PHASE7', exSpIxWriteHighRaw.b, { x: pos.x + 9250, y: pos.y - 5370 });
  const notExSpIxWriteLowNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5385 });
  wire(parent, exSpIxWriteLowNow.out, notExSpIxWriteLowNow.in);
  const exSpIxWriteHighNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5370 });
  wire(parent, exSpIxWriteHighRaw.out, exSpIxWriteHighNow.a);
  wire(parent, notExSpIxWriteLowNow.out, exSpIxWriteHighNow.b);
  tieToLabel('EXSPIX_WRITE_HIGH_NOW', exSpIxWriteHighNow.out, { x: pos.x + 9550, y: pos.y - 5370 });

  const isExSpIyZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5340 });
  wire(parent, isFdStackX.out, isExSpIyZ.a);
  wire(parent, dec.z[3]!, isExSpIyZ.b);
  const isExSpIy = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5340 });
  wire(parent, isExSpIyZ.out, isExSpIy.a);
  wire(parent, dec.y[4]!, isExSpIy.b);

  const exSpIyReadLowNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5340 });
  wire(parent, isExSpIy.out, exSpIyReadLowNow.a);
  tieToLabel('PHASE4', exSpIyReadLowNow.b, { x: pos.x + 9250, y: pos.y - 5340 });
  tieToLabel('EXSPIY_READ_LOW_NOW', exSpIyReadLowNow.out, { x: pos.x + 9450, y: pos.y - 5340 });

  const exSpIyReadHighRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5310 });
  wire(parent, isExSpIy.out, exSpIyReadHighRaw.a);
  tieToLabel('PHASE5', exSpIyReadHighRaw.b, { x: pos.x + 9250, y: pos.y - 5310 });
  const notExSpIyReadLowNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5325 });
  wire(parent, exSpIyReadLowNow.out, notExSpIyReadLowNow.in);
  const exSpIyReadHighNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5310 });
  wire(parent, exSpIyReadHighRaw.out, exSpIyReadHighNow.a);
  wire(parent, notExSpIyReadLowNow.out, exSpIyReadHighNow.b);
  tieToLabel('EXSPIY_READ_HIGH_NOW', exSpIyReadHighNow.out, { x: pos.x + 9550, y: pos.y - 5310 });

  const exSpIyWriteLowRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5280 });
  wire(parent, isExSpIy.out, exSpIyWriteLowRaw.a);
  tieToLabel('PHASE6', exSpIyWriteLowRaw.b, { x: pos.x + 9250, y: pos.y - 5280 });
  const notExSpIyReadHighNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5295 });
  wire(parent, exSpIyReadHighNow.out, notExSpIyReadHighNow.in);
  const exSpIyWriteLowNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5280 });
  wire(parent, exSpIyWriteLowRaw.out, exSpIyWriteLowNow.a);
  wire(parent, notExSpIyReadHighNow.out, exSpIyWriteLowNow.b);
  tieToLabel('EXSPIY_WRITE_LOW_NOW', exSpIyWriteLowNow.out, { x: pos.x + 9550, y: pos.y - 5280 });

  const exSpIyWriteHighRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 5250 });
  wire(parent, isExSpIy.out, exSpIyWriteHighRaw.a);
  tieToLabel('PHASE7', exSpIyWriteHighRaw.b, { x: pos.x + 9250, y: pos.y - 5250 });
  const notExSpIyWriteLowNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 5265 });
  wire(parent, exSpIyWriteLowNow.out, notExSpIyWriteLowNow.in);
  const exSpIyWriteHighNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 5250 });
  wire(parent, exSpIyWriteHighRaw.out, exSpIyWriteHighNow.a);
  wire(parent, notExSpIyWriteLowNow.out, exSpIyWriteHighNow.b);
  tieToLabel('EXSPIY_WRITE_HIGH_NOW', exSpIyWriteHighNow.out, { x: pos.x + 9550, y: pos.y - 5250 });

  // DD (IX+d) mem slice — LD r,(IX+d) / LD (IX+d),r / LD (IX+d),n /
  // INC/DEC (IX+d) / ALU A,(IX+d). Parallel decode on raw dec.x/y/z ∧
  // isDdActive — never reopen isLdGroup/isX0Group/isAluGroup
  // (NOT_PREFIX_ACTIVE kills those under DD). Prefixed bodies start at
  // PHASE4. See "DD: IX" in ARCHITECTURE.md.
  const notDdY6 = buildNot(parent, { x: pos.x + 9180, y: pos.y - 5220 });
  wire(parent, dec.y[6]!, notDdY6.in);
  const notDdZ6 = buildNot(parent, { x: pos.x + 9180, y: pos.y - 5200 });
  wire(parent, dec.z[6]!, notDdZ6.in);

  const isDdMemLdReadX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 5220 });
  wire(parent, isDdActive, isDdMemLdReadX.a);
  wire(parent, dec.x[1]!, isDdMemLdReadX.b);
  const isDdMemLdReadZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 5220 });
  wire(parent, isDdMemLdReadX.out, isDdMemLdReadZ.a);
  wire(parent, dec.z[6]!, isDdMemLdReadZ.b);
  const isDdMemLdRead = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5220 });
  wire(parent, isDdMemLdReadZ.out, isDdMemLdRead.a);
  wire(parent, notDdY6.out, isDdMemLdRead.b);
  tieToLabel('IS_DDMEMLD_READ', isDdMemLdRead.out, { x: pos.x + 9400, y: pos.y - 5220 });

  const isDdMemLdWriteX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 5190 });
  wire(parent, isDdActive, isDdMemLdWriteX.a);
  wire(parent, dec.x[1]!, isDdMemLdWriteX.b);
  const isDdMemLdWriteY = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 5190 });
  wire(parent, isDdMemLdWriteX.out, isDdMemLdWriteY.a);
  wire(parent, dec.y[6]!, isDdMemLdWriteY.b);
  const isDdMemLdWrite = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5190 });
  wire(parent, isDdMemLdWriteY.out, isDdMemLdWrite.a);
  wire(parent, notDdZ6.out, isDdMemLdWrite.b);
  tieToLabel('IS_DDMEMLD_WRITE', isDdMemLdWrite.out, { x: pos.x + 9400, y: pos.y - 5190 });

  const isDdMemLdNX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 5160 });
  wire(parent, isDdActive, isDdMemLdNX.a);
  wire(parent, dec.x[0]!, isDdMemLdNX.b);
  const isDdMemLdNZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 5160 });
  wire(parent, isDdMemLdNX.out, isDdMemLdNZ.a);
  wire(parent, dec.z[6]!, isDdMemLdNZ.b);
  const isDdMemLdN = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5160 });
  wire(parent, isDdMemLdNZ.out, isDdMemLdN.a);
  wire(parent, dec.y[6]!, isDdMemLdN.b);
  tieToLabel('IS_DDMEMLD_N', isDdMemLdN.out, { x: pos.x + 9400, y: pos.y - 5160 });

  // INC/DEC (IX+d): DD 34 d / DD 35 d — x=00, y=6, z=4/5.
  const isDdMemIncDecX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 5135 });
  wire(parent, isDdActive, isDdMemIncDecX.a);
  wire(parent, dec.x[0]!, isDdMemIncDecX.b);
  const isDdMemIncDecZ = buildOr(parent, { x: pos.x + 9240, y: pos.y - 5135 });
  wire(parent, dec.z[4]!, isDdMemIncDecZ.a);
  wire(parent, dec.z[5]!, isDdMemIncDecZ.b);
  const isDdMemIncDecXZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 5135 });
  wire(parent, isDdMemIncDecX.out, isDdMemIncDecXZ.a);
  wire(parent, isDdMemIncDecZ.out, isDdMemIncDecXZ.b);
  const isDdMemIncDec = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5135 });
  wire(parent, isDdMemIncDecXZ.out, isDdMemIncDec.a);
  wire(parent, dec.y[6]!, isDdMemIncDec.b);
  tieToLabel('IS_DDMEM_INCDEC', isDdMemIncDec.out, { x: pos.x + 9400, y: pos.y - 5135 });
  // DEC direction for shared r8Adder (isDecR8 is dead under DD).
  const isDdMemIsDec = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 5120 });
  wire(parent, isDdMemIncDec.out, isDdMemIsDec.a);
  wire(parent, dec.z[5]!, isDdMemIsDec.b);
  tieToLabel('DDMEM_IS_DEC', isDdMemIsDec.out, { x: pos.x + 9440, y: pos.y - 5120 });

  // ALU A,(IX+d): DD 86/8E/96/9E/A6/AE/B6/BE d — x=10, z=6.
  const isDdMemAlu = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 5110 });
  wire(parent, isDdActive, isDdMemAlu.a);
  wire(parent, dec.x[2]!, isDdMemAlu.b);
  const isDdMemAluZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 5110 });
  wire(parent, isDdMemAlu.out, isDdMemAluZ.a);
  wire(parent, dec.z[6]!, isDdMemAluZ.b);
  tieToLabel('IS_DDMEM_ALU', isDdMemAluZ.out, { x: pos.x + 9400, y: pos.y - 5110 });

  // Shared d-fetch / advance for all DD (IX+d) mem shapes (LD + INC/DEC + ALU).
  const isDdMemLdRw = buildOr(parent, { x: pos.x + 9340, y: pos.y - 5205 });
  wire(parent, isDdMemLdRead.out, isDdMemLdRw.a);
  wire(parent, isDdMemLdWrite.out, isDdMemLdRw.b);
  const isDdMemLdAny = buildOr(parent, { x: pos.x + 9380, y: pos.y - 5190 });
  wire(parent, isDdMemLdRw.out, isDdMemLdAny.a);
  wire(parent, isDdMemLdN.out, isDdMemLdAny.b);
  const isDdMemExtra = buildOr(parent, { x: pos.x + 9360, y: pos.y - 5125 });
  wire(parent, isDdMemIncDec.out, isDdMemExtra.a);
  wire(parent, isDdMemAluZ.out, isDdMemExtra.b);
  const isDdMemAnyBase = buildOr(parent, { x: pos.x + 9400, y: pos.y - 5155 });
  wire(parent, isDdMemLdAny.out, isDdMemAnyBase.a);
  wire(parent, isDdMemExtra.out, isDdMemAnyBase.b);
  // DD CB also needs d-fetch / advance at PHASE4–5 (op is not yet in IR).
  const isDdMemAny = buildOr(parent, { x: pos.x + 9440, y: pos.y - 5155 });
  wire(parent, isDdMemAnyBase.out, isDdMemAny.a);
  wire(parent, ddCbMode.q[0]!, isDdMemAny.b);

  const ddDispReadNow = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5220 });
  wire(parent, isDdMemAny.out, ddDispReadNow.a);
  tieToLabel('PHASE4', ddDispReadNow.b, { x: pos.x + 9320, y: pos.y - 5220 });
  tieToLabel('DDDISP_READ_NOW', ddDispReadNow.out, { x: pos.x + 9520, y: pos.y - 5220 }); // anchor — ixDisp.we, ram.oe

  const ddDispAdvRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5190 });
  wire(parent, isDdMemAny.out, ddDispAdvRaw.a);
  tieToLabel('PHASE5', ddDispAdvRaw.b, { x: pos.x + 9320, y: pos.y - 5190 });
  const notDdDispReadNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 5205 });
  wire(parent, ddDispReadNow.out, notDdDispReadNow.in);
  const ddDispAdvanceNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5190 });
  wire(parent, ddDispAdvRaw.out, ddDispAdvanceNow.a);
  wire(parent, notDdDispReadNow.out, ddDispAdvanceNow.b);
  tieToLabel('DDDISP_ADVANCE_NOW', ddDispAdvanceNow.out, { x: pos.x + 9600, y: pos.y - 5190 }); // anchor — pcHold

  // PHASE6 mem R/W @ IX+d (LD r,(IX+d) / LD (IX+d),r) — exclude PHASE5.
  const notDdDispAdvanceNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 5175 });
  wire(parent, ddDispAdvanceNow.out, notDdDispAdvanceNow.in);
  const ddMemLdReadRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5160 });
  wire(parent, isDdMemLdRead.out, ddMemLdReadRaw.a);
  tieToLabel('PHASE6', ddMemLdReadRaw.b, { x: pos.x + 9320, y: pos.y - 5160 });
  const ddMemLdReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5160 });
  wire(parent, ddMemLdReadRaw.out, ddMemLdReadNow.a);
  wire(parent, notDdDispAdvanceNow.out, ddMemLdReadNow.b);
  tieToLabel('DDMEMLD_READ_NOW', ddMemLdReadNow.out, { x: pos.x + 9600, y: pos.y - 5160 }); // anchor — ram.oe, addr, reg WE

  const ddMemLdWriteRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5130 });
  wire(parent, isDdMemLdWrite.out, ddMemLdWriteRaw.a);
  tieToLabel('PHASE6', ddMemLdWriteRaw.b, { x: pos.x + 9320, y: pos.y - 5130 });
  const ddMemLdWriteNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5130 });
  wire(parent, ddMemLdWriteRaw.out, ddMemLdWriteNow.a);
  wire(parent, notDdDispAdvanceNow.out, ddMemLdWriteNow.b);
  tieToLabel('DDMEMLD_WRITE_NOW', ddMemLdWriteNow.out, { x: pos.x + 9600, y: pos.y - 5130 }); // anchor — ram.we, addr, bus src

  // LD (IX+d),n — PHASE6 fetch n, PHASE7 write @ IX+d (+ advance past n).
  const ddMemLdNImmRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5100 });
  wire(parent, isDdMemLdN.out, ddMemLdNImmRaw.a);
  tieToLabel('PHASE6', ddMemLdNImmRaw.b, { x: pos.x + 9320, y: pos.y - 5100 });
  const ddMemLdNImmReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5100 });
  wire(parent, ddMemLdNImmRaw.out, ddMemLdNImmReadNow.a);
  wire(parent, notDdDispAdvanceNow.out, ddMemLdNImmReadNow.b);
  tieToLabel('DDMEMLDN_IMM_READ_NOW', ddMemLdNImmReadNow.out, { x: pos.x + 9600, y: pos.y - 5100 }); // anchor — ldIxDNImm.we, ram.oe

  const notDdMemLdNImmReadNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 5085 });
  wire(parent, ddMemLdNImmReadNow.out, notDdMemLdNImmReadNow.in);
  const ddMemLdNWriteRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5070 });
  wire(parent, isDdMemLdN.out, ddMemLdNWriteRaw.a);
  tieToLabel('PHASE7', ddMemLdNWriteRaw.b, { x: pos.x + 9320, y: pos.y - 5070 });
  const ddMemLdNWriteNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5070 });
  wire(parent, ddMemLdNWriteRaw.out, ddMemLdNWriteNow.a);
  wire(parent, notDdMemLdNImmReadNow.out, ddMemLdNWriteNow.b);
  tieToLabel('DDMEMLDN_WRITE_NOW', ddMemLdNWriteNow.out, { x: pos.x + 9600, y: pos.y - 5070 }); // anchor — ram.we, addr, pcHold, bus

  // INC/DEC (IX+d) — PHASE6 read → hlMemTemp @ IX+d; PHASE7 write R8RESULT
  // (unprefixed HLMEM_READ_NOW @ PHASE2 / INCDEC_HLMEM_NOW @ PHASE3, +4).
  const ddMemIncDecReadRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5045 });
  wire(parent, isDdMemIncDec.out, ddMemIncDecReadRaw.a);
  tieToLabel('PHASE6', ddMemIncDecReadRaw.b, { x: pos.x + 9320, y: pos.y - 5045 });
  const ddMemIncDecReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5045 });
  wire(parent, ddMemIncDecReadRaw.out, ddMemIncDecReadNow.a);
  wire(parent, notDdDispAdvanceNow.out, ddMemIncDecReadNow.b);
  tieToLabel('DDMEM_INCDEC_READ_NOW', ddMemIncDecReadNow.out, { x: pos.x + 9600, y: pos.y - 5045 }); // anchor — hlMemTemp.we, ram.oe, IXDISP_ADDR

  const notDdMemIncDecReadNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 5030 });
  wire(parent, ddMemIncDecReadNow.out, notDdMemIncDecReadNow.in);
  const ddMemIncDecWriteRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 5015 });
  wire(parent, isDdMemIncDec.out, ddMemIncDecWriteRaw.a);
  tieToLabel('PHASE7', ddMemIncDecWriteRaw.b, { x: pos.x + 9320, y: pos.y - 5015 });
  const ddMemIncDecWriteNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 5015 });
  wire(parent, ddMemIncDecWriteRaw.out, ddMemIncDecWriteNow.a);
  wire(parent, notDdMemIncDecReadNow.out, ddMemIncDecWriteNow.b);
  tieToLabel('DDMEM_INCDEC_WRITE_NOW', ddMemIncDecWriteNow.out, { x: pos.x + 9600, y: pos.y - 5015 }); // anchor — ram.we, R8RESULT bus, F, IXDISP_ADDR

  // ALU A,(IX+d) — PHASE6 read @ IX+d onto BUS; commit A+F (hlNow @ PHASE2 +4).
  const ddMemAluRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4990 });
  wire(parent, isDdMemAluZ.out, ddMemAluRaw.a);
  tieToLabel('PHASE6', ddMemAluRaw.b, { x: pos.x + 9320, y: pos.y - 4990 });
  const ddMemAluNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4990 });
  wire(parent, ddMemAluRaw.out, ddMemAluNow.a);
  wire(parent, notDdDispAdvanceNow.out, ddMemAluNow.b);
  tieToLabel('DDMEM_ALU_NOW', ddMemAluNow.out, { x: pos.x + 9600, y: pos.y - 4990 }); // anchor — ram.oe, IXDISP_ADDR, aluAnyGroupNow

  // IX+d address only during mem R/W phases (not during d/n fetches @ PC).
  const ddIxDispAddrRw = buildOr(parent, { x: pos.x + 9540, y: pos.y - 5145 });
  wire(parent, ddMemLdReadNow.out, ddIxDispAddrRw.a);
  wire(parent, ddMemLdWriteNow.out, ddIxDispAddrRw.b);
  const ddIxDispAddrLd = buildOr(parent, { x: pos.x + 9580, y: pos.y - 5130 });
  wire(parent, ddIxDispAddrRw.out, ddIxDispAddrLd.a);
  wire(parent, ddMemLdNWriteNow.out, ddIxDispAddrLd.b);
  const ddIxDispAddrIncDec = buildOr(parent, { x: pos.x + 9540, y: pos.y - 5030 });
  wire(parent, ddMemIncDecReadNow.out, ddIxDispAddrIncDec.a);
  wire(parent, ddMemIncDecWriteNow.out, ddIxDispAddrIncDec.b);
  const ddIxDispAddrExtra = buildOr(parent, { x: pos.x + 9580, y: pos.y - 5010 });
  wire(parent, ddIxDispAddrIncDec.out, ddIxDispAddrExtra.a);
  wire(parent, ddMemAluNow.out, ddIxDispAddrExtra.b);
  const ddIxDispAddrBase = buildOr(parent, { x: pos.x + 9620, y: pos.y - 5070 });
  wire(parent, ddIxDispAddrLd.out, ddIxDispAddrBase.a);
  wire(parent, ddIxDispAddrExtra.out, ddIxDispAddrBase.b);
  // BIT / SETRES / CBROT (IX+d) — labels produced later near isCbX*Active.
  const ddIxDispAddrBitSet = buildOr(parent, { x: pos.x + 9660, y: pos.y - 5070 });
  tieToLabel('BIT_IX_NOW', ddIxDispAddrBitSet.a, { x: pos.x + 9560, y: pos.y - 5050 });
  tieToLabel('SETRES_IX_READ_NOW', ddIxDispAddrBitSet.b, { x: pos.x + 9560, y: pos.y - 5030 });
  const ddIxDispAddrSetW = buildOr(parent, { x: pos.x + 9700, y: pos.y - 5055 });
  wire(parent, ddIxDispAddrBitSet.out, ddIxDispAddrSetW.a);
  tieToLabel('SETRES_IX_WRITE_NOW', ddIxDispAddrSetW.b, { x: pos.x + 9560, y: pos.y - 5010 });
  const ddIxDispAddrRot = buildOr(parent, { x: pos.x + 9660, y: pos.y - 4990 });
  tieToLabel('CBROT_IX_READ_NOW', ddIxDispAddrRot.a, { x: pos.x + 9560, y: pos.y - 4990 });
  tieToLabel('CBROT_IX_WRITE_NOW', ddIxDispAddrRot.b, { x: pos.x + 9560, y: pos.y - 4970 });
  const ddIxDispAddrCb = buildOr(parent, { x: pos.x + 9700, y: pos.y - 5020 });
  wire(parent, ddIxDispAddrSetW.out, ddIxDispAddrCb.a);
  wire(parent, ddIxDispAddrRot.out, ddIxDispAddrCb.b);
  const ddIxDispAddrNow = buildOr(parent, { x: pos.x + 9740, y: pos.y - 5070 });
  wire(parent, ddIxDispAddrBase.out, ddIxDispAddrNow.a);
  wire(parent, ddIxDispAddrCb.out, ddIxDispAddrNow.b);
  tieToLabel('IXDISP_ADDR_NOW', ddIxDispAddrNow.out, { x: pos.x + 9840, y: pos.y - 5070 }); // anchor — RAM addr mux

  // DD CB second IR-only op recapture @ PHASE6 (does NOT touch activePrefix).
  // Exclude PHASE5 d-advance (ring-counter transient).
  const ddCbOpReadRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4960 });
  wire(parent, ddCbMode.q[0]!, ddCbOpReadRaw.a);
  tieToLabel('PHASE6', ddCbOpReadRaw.b, { x: pos.x + 9320, y: pos.y - 4960 });
  const ddCbOpReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4960 });
  wire(parent, ddCbOpReadRaw.out, ddCbOpReadNow.a);
  wire(parent, notDdDispAdvanceNow.out, ddCbOpReadNow.b);
  tieToLabel('DDCB_OP_READ_NOW', ddCbOpReadNow.out, { x: pos.x + 9600, y: pos.y - 4960 }); // anchor — ir.we, ram.oe
  // Advance past op on PHASE9 (moved from PHASE7 — SET/RES/rot need PHASE7
  // read + PHASE8 write; BIT still commits @ PHASE7 and advances later).
  // Exclude adjacent PHASE8 write (ring-counter transient).
  const ddCbOpAdvanceRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4935 });
  wire(parent, ddCbMode.q[0]!, ddCbOpAdvanceRaw.a);
  tieToLabel('PHASE9', ddCbOpAdvanceRaw.b, { x: pos.x + 9320, y: pos.y - 4935 });
  const notDdCbPhase8Write = buildNot(parent, { x: pos.x + 9460, y: pos.y - 4945 });
  tieToLabel('DDCB_PHASE8_WRITE_ANY', notDdCbPhase8Write.in, { x: pos.x + 9320, y: pos.y - 4945 });
  const ddCbOpAdvanceNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4935 });
  wire(parent, ddCbOpAdvanceRaw.out, ddCbOpAdvanceNow.a);
  wire(parent, notDdCbPhase8Write.out, ddCbOpAdvanceNow.b);
  tieToLabel('DDCB_OP_ADVANCE_NOW', ddCbOpAdvanceNow.out, { x: pos.x + 9600, y: pos.y - 4935 }); // anchor — pcHold

  // Per-y write-back strobes for LD r,(IX+d) — parallel to ldGroupNow∧y.
  const ddMemLdWeSpecs: { y: Pin; label: string }[] = [
    { y: dec.y[0]!, label: 'DDMEMLD_WE_B_NOW' },
    { y: dec.y[1]!, label: 'DDMEMLD_WE_C_NOW' },
    { y: dec.y[2]!, label: 'DDMEMLD_WE_D_NOW' },
    { y: dec.y[3]!, label: 'DDMEMLD_WE_E_NOW' },
    { y: dec.y[4]!, label: 'DDMEMLD_WE_H_NOW' },
    { y: dec.y[5]!, label: 'DDMEMLD_WE_L_NOW' },
    { y: dec.y[7]!, label: 'DDMEMLD_WE_A_NOW' },
  ];
  ddMemLdWeSpecs.forEach(({ y, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x + 9540, y: pos.y - 5220 - i * 22 });
    wire(parent, ddMemLdReadNow.out, gate.a);
    wire(parent, y, gate.b);
    tieToLabel(label, gate.out, { x: pos.x + 9640, y: pos.y - 5220 - i * 22 });
  });

  // FD (IY+d) mem slice — mechanical mirror of DD above.
  const isFdMemLdReadX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 4860 });
  wire(parent, isFdActive, isFdMemLdReadX.a);
  wire(parent, dec.x[1]!, isFdMemLdReadX.b);
  const isFdMemLdReadZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4860 });
  wire(parent, isFdMemLdReadX.out, isFdMemLdReadZ.a);
  wire(parent, dec.z[6]!, isFdMemLdReadZ.b);
  const isFdMemLdRead = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4860 });
  wire(parent, isFdMemLdReadZ.out, isFdMemLdRead.a);
  wire(parent, notDdY6.out, isFdMemLdRead.b);
  tieToLabel('IS_FDMEMLD_READ', isFdMemLdRead.out, { x: pos.x + 9400, y: pos.y - 4860 });

  const isFdMemLdWriteX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 4830 });
  wire(parent, isFdActive, isFdMemLdWriteX.a);
  wire(parent, dec.x[1]!, isFdMemLdWriteX.b);
  const isFdMemLdWriteY = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4830 });
  wire(parent, isFdMemLdWriteX.out, isFdMemLdWriteY.a);
  wire(parent, dec.y[6]!, isFdMemLdWriteY.b);
  const isFdMemLdWrite = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4830 });
  wire(parent, isFdMemLdWriteY.out, isFdMemLdWrite.a);
  wire(parent, notDdZ6.out, isFdMemLdWrite.b);
  tieToLabel('IS_FDMEMLD_WRITE', isFdMemLdWrite.out, { x: pos.x + 9400, y: pos.y - 4830 });

  const isFdMemLdNX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 4800 });
  wire(parent, isFdActive, isFdMemLdNX.a);
  wire(parent, dec.x[0]!, isFdMemLdNX.b);
  const isFdMemLdNZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4800 });
  wire(parent, isFdMemLdNX.out, isFdMemLdNZ.a);
  wire(parent, dec.z[6]!, isFdMemLdNZ.b);
  const isFdMemLdN = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4800 });
  wire(parent, isFdMemLdNZ.out, isFdMemLdN.a);
  wire(parent, dec.y[6]!, isFdMemLdN.b);
  tieToLabel('IS_FDMEMLD_N', isFdMemLdN.out, { x: pos.x + 9400, y: pos.y - 4800 });

  const isFdMemIncDecX = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 4775 });
  wire(parent, isFdActive, isFdMemIncDecX.a);
  wire(parent, dec.x[0]!, isFdMemIncDecX.b);
  const isFdMemIncDecXZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4775 });
  wire(parent, isFdMemIncDecX.out, isFdMemIncDecXZ.a);
  wire(parent, isDdMemIncDecZ.out, isFdMemIncDecXZ.b);
  const isFdMemIncDec = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4775 });
  wire(parent, isFdMemIncDecXZ.out, isFdMemIncDec.a);
  wire(parent, dec.y[6]!, isFdMemIncDec.b);
  tieToLabel('IS_FDMEM_INCDEC', isFdMemIncDec.out, { x: pos.x + 9400, y: pos.y - 4775 });
  const isFdMemIsDec = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4760 });
  wire(parent, isFdMemIncDec.out, isFdMemIsDec.a);
  wire(parent, dec.z[5]!, isFdMemIsDec.b);
  tieToLabel('FDMEM_IS_DEC', isFdMemIsDec.out, { x: pos.x + 9440, y: pos.y - 4760 });

  const isFdMemAlu = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 4750 });
  wire(parent, isFdActive, isFdMemAlu.a);
  wire(parent, dec.x[2]!, isFdMemAlu.b);
  const isFdMemAluZ = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4750 });
  wire(parent, isFdMemAlu.out, isFdMemAluZ.a);
  wire(parent, dec.z[6]!, isFdMemAluZ.b);
  tieToLabel('IS_FDMEM_ALU', isFdMemAluZ.out, { x: pos.x + 9400, y: pos.y - 4750 });

  const isFdMemLdRw = buildOr(parent, { x: pos.x + 9340, y: pos.y - 4845 });
  wire(parent, isFdMemLdRead.out, isFdMemLdRw.a);
  wire(parent, isFdMemLdWrite.out, isFdMemLdRw.b);
  const isFdMemLdAny = buildOr(parent, { x: pos.x + 9380, y: pos.y - 4830 });
  wire(parent, isFdMemLdRw.out, isFdMemLdAny.a);
  wire(parent, isFdMemLdN.out, isFdMemLdAny.b);
  const isFdMemExtra = buildOr(parent, { x: pos.x + 9360, y: pos.y - 4765 });
  wire(parent, isFdMemIncDec.out, isFdMemExtra.a);
  wire(parent, isFdMemAluZ.out, isFdMemExtra.b);
  const isFdMemAnyBase = buildOr(parent, { x: pos.x + 9400, y: pos.y - 4795 });
  wire(parent, isFdMemLdAny.out, isFdMemAnyBase.a);
  wire(parent, isFdMemExtra.out, isFdMemAnyBase.b);
  const isFdMemAny = buildOr(parent, { x: pos.x + 9440, y: pos.y - 4795 });
  wire(parent, isFdMemAnyBase.out, isFdMemAny.a);
  wire(parent, fdCbMode.q[0]!, isFdMemAny.b);

  const fdDispReadNow = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4860 });
  wire(parent, isFdMemAny.out, fdDispReadNow.a);
  tieToLabel('PHASE4', fdDispReadNow.b, { x: pos.x + 9320, y: pos.y - 4860 });
  tieToLabel('FDDISP_READ_NOW', fdDispReadNow.out, { x: pos.x + 9520, y: pos.y - 4860 });

  const fdDispAdvRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4830 });
  wire(parent, isFdMemAny.out, fdDispAdvRaw.a);
  tieToLabel('PHASE5', fdDispAdvRaw.b, { x: pos.x + 9320, y: pos.y - 4830 });
  const notFdDispReadNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 4845 });
  wire(parent, fdDispReadNow.out, notFdDispReadNow.in);
  const fdDispAdvanceNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4830 });
  wire(parent, fdDispAdvRaw.out, fdDispAdvanceNow.a);
  wire(parent, notFdDispReadNow.out, fdDispAdvanceNow.b);
  tieToLabel('FDDISP_ADVANCE_NOW', fdDispAdvanceNow.out, { x: pos.x + 9600, y: pos.y - 4830 });

  const notFdDispAdvanceNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 4815 });
  wire(parent, fdDispAdvanceNow.out, notFdDispAdvanceNow.in);
  const fdMemLdReadRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4800 });
  wire(parent, isFdMemLdRead.out, fdMemLdReadRaw.a);
  tieToLabel('PHASE6', fdMemLdReadRaw.b, { x: pos.x + 9320, y: pos.y - 4800 });
  const fdMemLdReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4800 });
  wire(parent, fdMemLdReadRaw.out, fdMemLdReadNow.a);
  wire(parent, notFdDispAdvanceNow.out, fdMemLdReadNow.b);
  tieToLabel('FDMEMLD_READ_NOW', fdMemLdReadNow.out, { x: pos.x + 9600, y: pos.y - 4800 });

  const fdMemLdWriteRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4770 });
  wire(parent, isFdMemLdWrite.out, fdMemLdWriteRaw.a);
  tieToLabel('PHASE6', fdMemLdWriteRaw.b, { x: pos.x + 9320, y: pos.y - 4770 });
  const fdMemLdWriteNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4770 });
  wire(parent, fdMemLdWriteRaw.out, fdMemLdWriteNow.a);
  wire(parent, notFdDispAdvanceNow.out, fdMemLdWriteNow.b);
  tieToLabel('FDMEMLD_WRITE_NOW', fdMemLdWriteNow.out, { x: pos.x + 9600, y: pos.y - 4770 });

  const fdMemLdNImmRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4740 });
  wire(parent, isFdMemLdN.out, fdMemLdNImmRaw.a);
  tieToLabel('PHASE6', fdMemLdNImmRaw.b, { x: pos.x + 9320, y: pos.y - 4740 });
  const fdMemLdNImmReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4740 });
  wire(parent, fdMemLdNImmRaw.out, fdMemLdNImmReadNow.a);
  wire(parent, notFdDispAdvanceNow.out, fdMemLdNImmReadNow.b);
  tieToLabel('FDMEMLDN_IMM_READ_NOW', fdMemLdNImmReadNow.out, { x: pos.x + 9600, y: pos.y - 4740 });

  const notFdMemLdNImmReadNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 4725 });
  wire(parent, fdMemLdNImmReadNow.out, notFdMemLdNImmReadNow.in);
  const fdMemLdNWriteRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4710 });
  wire(parent, isFdMemLdN.out, fdMemLdNWriteRaw.a);
  tieToLabel('PHASE7', fdMemLdNWriteRaw.b, { x: pos.x + 9320, y: pos.y - 4710 });
  const fdMemLdNWriteNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4710 });
  wire(parent, fdMemLdNWriteRaw.out, fdMemLdNWriteNow.a);
  wire(parent, notFdMemLdNImmReadNow.out, fdMemLdNWriteNow.b);
  tieToLabel('FDMEMLDN_WRITE_NOW', fdMemLdNWriteNow.out, { x: pos.x + 9600, y: pos.y - 4710 });

  const fdMemIncDecReadRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4685 });
  wire(parent, isFdMemIncDec.out, fdMemIncDecReadRaw.a);
  tieToLabel('PHASE6', fdMemIncDecReadRaw.b, { x: pos.x + 9320, y: pos.y - 4685 });
  const fdMemIncDecReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4685 });
  wire(parent, fdMemIncDecReadRaw.out, fdMemIncDecReadNow.a);
  wire(parent, notFdDispAdvanceNow.out, fdMemIncDecReadNow.b);
  tieToLabel('FDMEM_INCDEC_READ_NOW', fdMemIncDecReadNow.out, { x: pos.x + 9600, y: pos.y - 4685 });

  const notFdMemIncDecReadNow = buildNot(parent, { x: pos.x + 9460, y: pos.y - 4670 });
  wire(parent, fdMemIncDecReadNow.out, notFdMemIncDecReadNow.in);
  const fdMemIncDecWriteRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4655 });
  wire(parent, isFdMemIncDec.out, fdMemIncDecWriteRaw.a);
  tieToLabel('PHASE7', fdMemIncDecWriteRaw.b, { x: pos.x + 9320, y: pos.y - 4655 });
  const fdMemIncDecWriteNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4655 });
  wire(parent, fdMemIncDecWriteRaw.out, fdMemIncDecWriteNow.a);
  wire(parent, notFdMemIncDecReadNow.out, fdMemIncDecWriteNow.b);
  tieToLabel('FDMEM_INCDEC_WRITE_NOW', fdMemIncDecWriteNow.out, { x: pos.x + 9600, y: pos.y - 4655 });

  const fdMemAluRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4630 });
  wire(parent, isFdMemAluZ.out, fdMemAluRaw.a);
  tieToLabel('PHASE6', fdMemAluRaw.b, { x: pos.x + 9320, y: pos.y - 4630 });
  const fdMemAluNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4630 });
  wire(parent, fdMemAluRaw.out, fdMemAluNow.a);
  wire(parent, notFdDispAdvanceNow.out, fdMemAluNow.b);
  tieToLabel('FDMEM_ALU_NOW', fdMemAluNow.out, { x: pos.x + 9600, y: pos.y - 4630 });

  const fdIyDispAddrRw = buildOr(parent, { x: pos.x + 9540, y: pos.y - 4785 });
  wire(parent, fdMemLdReadNow.out, fdIyDispAddrRw.a);
  wire(parent, fdMemLdWriteNow.out, fdIyDispAddrRw.b);
  const fdIyDispAddrLd = buildOr(parent, { x: pos.x + 9580, y: pos.y - 4770 });
  wire(parent, fdIyDispAddrRw.out, fdIyDispAddrLd.a);
  wire(parent, fdMemLdNWriteNow.out, fdIyDispAddrLd.b);
  const fdIyDispAddrIncDec = buildOr(parent, { x: pos.x + 9540, y: pos.y - 4670 });
  wire(parent, fdMemIncDecReadNow.out, fdIyDispAddrIncDec.a);
  wire(parent, fdMemIncDecWriteNow.out, fdIyDispAddrIncDec.b);
  const fdIyDispAddrExtra = buildOr(parent, { x: pos.x + 9580, y: pos.y - 4650 });
  wire(parent, fdIyDispAddrIncDec.out, fdIyDispAddrExtra.a);
  wire(parent, fdMemAluNow.out, fdIyDispAddrExtra.b);
  const fdIyDispAddrBase = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4710 });
  wire(parent, fdIyDispAddrLd.out, fdIyDispAddrBase.a);
  wire(parent, fdIyDispAddrExtra.out, fdIyDispAddrBase.b);
  const fdIyDispAddrBitSet = buildOr(parent, { x: pos.x + 9660, y: pos.y - 4710 });
  tieToLabel('BIT_IY_NOW', fdIyDispAddrBitSet.a, { x: pos.x + 9560, y: pos.y - 4690 });
  tieToLabel('SETRES_IY_READ_NOW', fdIyDispAddrBitSet.b, { x: pos.x + 9560, y: pos.y - 4670 });
  const fdIyDispAddrSetW = buildOr(parent, { x: pos.x + 9700, y: pos.y - 4695 });
  wire(parent, fdIyDispAddrBitSet.out, fdIyDispAddrSetW.a);
  tieToLabel('SETRES_IY_WRITE_NOW', fdIyDispAddrSetW.b, { x: pos.x + 9560, y: pos.y - 4650 });
  const fdIyDispAddrRot = buildOr(parent, { x: pos.x + 9660, y: pos.y - 4630 });
  tieToLabel('CBROT_IY_READ_NOW', fdIyDispAddrRot.a, { x: pos.x + 9560, y: pos.y - 4630 });
  tieToLabel('CBROT_IY_WRITE_NOW', fdIyDispAddrRot.b, { x: pos.x + 9560, y: pos.y - 4610 });
  const fdIyDispAddrCb = buildOr(parent, { x: pos.x + 9700, y: pos.y - 4660 });
  wire(parent, fdIyDispAddrSetW.out, fdIyDispAddrCb.a);
  wire(parent, fdIyDispAddrRot.out, fdIyDispAddrCb.b);
  const fdIyDispAddrNow = buildOr(parent, { x: pos.x + 9740, y: pos.y - 4710 });
  wire(parent, fdIyDispAddrBase.out, fdIyDispAddrNow.a);
  wire(parent, fdIyDispAddrCb.out, fdIyDispAddrNow.b);
  tieToLabel('IYDISP_ADDR_NOW', fdIyDispAddrNow.out, { x: pos.x + 9840, y: pos.y - 4710 });

  // FD CB second IR-only op recapture @ PHASE6 (mirror of DDCB_OP_READ_NOW).
  const fdCbOpReadRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4600 });
  wire(parent, fdCbMode.q[0]!, fdCbOpReadRaw.a);
  tieToLabel('PHASE6', fdCbOpReadRaw.b, { x: pos.x + 9320, y: pos.y - 4600 });
  const fdCbOpReadNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4600 });
  wire(parent, fdCbOpReadRaw.out, fdCbOpReadNow.a);
  wire(parent, notFdDispAdvanceNow.out, fdCbOpReadNow.b);
  tieToLabel('FDCB_OP_READ_NOW', fdCbOpReadNow.out, { x: pos.x + 9600, y: pos.y - 4600 });
  const fdCbOpAdvanceRaw = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4575 });
  wire(parent, fdCbMode.q[0]!, fdCbOpAdvanceRaw.a);
  tieToLabel('PHASE9', fdCbOpAdvanceRaw.b, { x: pos.x + 9320, y: pos.y - 4575 });
  const notFdCbPhase8Write = buildNot(parent, { x: pos.x + 9460, y: pos.y - 4585 });
  tieToLabel('FDCB_PHASE8_WRITE_ANY', notFdCbPhase8Write.in, { x: pos.x + 9320, y: pos.y - 4585 });
  const fdCbOpAdvanceNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 4575 });
  wire(parent, fdCbOpAdvanceRaw.out, fdCbOpAdvanceNow.a);
  wire(parent, notFdCbPhase8Write.out, fdCbOpAdvanceNow.b);
  tieToLabel('FDCB_OP_ADVANCE_NOW', fdCbOpAdvanceNow.out, { x: pos.x + 9600, y: pos.y - 4575 });

  const fdMemLdWeSpecs: { y: Pin; label: string }[] = [
    { y: dec.y[0]!, label: 'FDMEMLD_WE_B_NOW' },
    { y: dec.y[1]!, label: 'FDMEMLD_WE_C_NOW' },
    { y: dec.y[2]!, label: 'FDMEMLD_WE_D_NOW' },
    { y: dec.y[3]!, label: 'FDMEMLD_WE_E_NOW' },
    { y: dec.y[4]!, label: 'FDMEMLD_WE_H_NOW' },
    { y: dec.y[5]!, label: 'FDMEMLD_WE_L_NOW' },
    { y: dec.y[7]!, label: 'FDMEMLD_WE_A_NOW' },
  ];
  fdMemLdWeSpecs.forEach(({ y, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x + 9540, y: pos.y - 4860 - i * 22 });
    wire(parent, fdMemLdReadNow.out, gate.a);
    wire(parent, y, gate.b);
    tieToLabel(label, gate.out, { x: pos.x + 9640, y: pos.y - 4860 - i * 22 });
  });

  // DD/FD H→IXH / L→IXL (IYH/IYL) 8-bit remap — parallel decode, never
  // reopen isLdGroup/isX0Group/isAluGroup (NOT_PREFIX_ACTIVE kills those
  // under DD/FD). Bodies @ PHASE4 (prefix burns 2–3). Skip under
  // ddCbMode/fdCbMode; do not remap (HL)/y=6/z=6 (already (IX+d)/(IY+d)).
  // See "DD: IX" / "FD: IY" in ARCHITECTURE.md.
  const notDdCbMode = buildNot(parent, { x: pos.x + 9180, y: pos.y - 4520 });
  wire(parent, ddCbMode.q[0]!, notDdCbMode.in);
  const notFdCbMode = buildNot(parent, { x: pos.x + 9180, y: pos.y - 4500 });
  wire(parent, fdCbMode.q[0]!, notFdCbMode.in);

  const ddHl8Y45 = buildOr(parent, { x: pos.x + 9200, y: pos.y - 4520 });
  wire(parent, dec.y[4]!, ddHl8Y45.a);
  wire(parent, dec.y[5]!, ddHl8Y45.b);
  const ddHl8Z45 = buildOr(parent, { x: pos.x + 9200, y: pos.y - 4500 });
  wire(parent, dec.z[4]!, ddHl8Z45.a);
  wire(parent, dec.z[5]!, ddHl8Z45.b);
  const ddHl8Yz45 = buildOr(parent, { x: pos.x + 9240, y: pos.y - 4510 });
  wire(parent, ddHl8Y45.out, ddHl8Yz45.a);
  wire(parent, ddHl8Z45.out, ddHl8Yz45.b);

  // isDdHl8Ld = isDdActive ∧ ¬ddCbMode ∧ x[1] ∧ ¬y[6] ∧ ¬z[6] ∧ (y[4]∨y[5]∨z[4]∨z[5])
  const isDdHl8LdBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4520 });
  wire(parent, isDdActive, isDdHl8LdBase.a);
  wire(parent, notDdCbMode.out, isDdHl8LdBase.b);
  const isDdHl8LdX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4520 });
  wire(parent, isDdHl8LdBase.out, isDdHl8LdX.a);
  wire(parent, dec.x[1]!, isDdHl8LdX.b);
  const isDdHl8LdNy = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4520 });
  wire(parent, isDdHl8LdX.out, isDdHl8LdNy.a);
  wire(parent, notDdY6.out, isDdHl8LdNy.b);
  const isDdHl8LdNz = buildAnd(parent, { x: pos.x + 9380, y: pos.y - 4520 });
  wire(parent, isDdHl8LdNy.out, isDdHl8LdNz.a);
  wire(parent, notDdZ6.out, isDdHl8LdNz.b);
  const isDdHl8Ld = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4520 });
  wire(parent, isDdHl8LdNz.out, isDdHl8Ld.a);
  wire(parent, ddHl8Yz45.out, isDdHl8Ld.b);
  tieToLabel('IS_DDIX_HL8_LD', isDdHl8Ld.out, { x: pos.x + 9520, y: pos.y - 4520 });

  // isDdHl8Imm = isDdActive ∧ ¬ddCbMode ∧ x[0] ∧ z[6] ∧ (y[4]∨y[5])
  const isDdHl8ImmBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4490 });
  wire(parent, isDdActive, isDdHl8ImmBase.a);
  wire(parent, notDdCbMode.out, isDdHl8ImmBase.b);
  const isDdHl8ImmX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4490 });
  wire(parent, isDdHl8ImmBase.out, isDdHl8ImmX.a);
  wire(parent, dec.x[0]!, isDdHl8ImmX.b);
  const isDdHl8ImmZ = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4490 });
  wire(parent, isDdHl8ImmX.out, isDdHl8ImmZ.a);
  wire(parent, dec.z[6]!, isDdHl8ImmZ.b);
  const isDdHl8Imm = buildAnd(parent, { x: pos.x + 9380, y: pos.y - 4490 });
  wire(parent, isDdHl8ImmZ.out, isDdHl8Imm.a);
  wire(parent, ddHl8Y45.out, isDdHl8Imm.b);
  tieToLabel('IS_DDIX_HL8_IMM', isDdHl8Imm.out, { x: pos.x + 9520, y: pos.y - 4490 });

  // isDdHl8Inc = isDdActive ∧ ¬ddCbMode ∧ x[0] ∧ (z[4]∨z[5]) ∧ (y[4]∨y[5])
  const isDdHl8IncBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4460 });
  wire(parent, isDdActive, isDdHl8IncBase.a);
  wire(parent, notDdCbMode.out, isDdHl8IncBase.b);
  const isDdHl8IncX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4460 });
  wire(parent, isDdHl8IncBase.out, isDdHl8IncX.a);
  wire(parent, dec.x[0]!, isDdHl8IncX.b);
  const isDdHl8IncZ = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4460 });
  wire(parent, isDdHl8IncX.out, isDdHl8IncZ.a);
  wire(parent, ddHl8Z45.out, isDdHl8IncZ.b);
  const isDdHl8Inc = buildAnd(parent, { x: pos.x + 9380, y: pos.y - 4460 });
  wire(parent, isDdHl8IncZ.out, isDdHl8Inc.a);
  wire(parent, ddHl8Y45.out, isDdHl8Inc.b);
  tieToLabel('IS_DDIX_HL8_INC', isDdHl8Inc.out, { x: pos.x + 9520, y: pos.y - 4460 });
  const isDdHl8IsDec = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4445 });
  wire(parent, isDdHl8Inc.out, isDdHl8IsDec.a);
  wire(parent, dec.z[5]!, isDdHl8IsDec.b);
  tieToLabel('DDIX_HL8_IS_DEC', isDdHl8IsDec.out, { x: pos.x + 9520, y: pos.y - 4445 });

  // isDdHl8Alu = isDdActive ∧ ¬ddCbMode ∧ x[2] ∧ (z[4]∨z[5])
  const isDdHl8AluBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4430 });
  wire(parent, isDdActive, isDdHl8AluBase.a);
  wire(parent, notDdCbMode.out, isDdHl8AluBase.b);
  const isDdHl8AluX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4430 });
  wire(parent, isDdHl8AluBase.out, isDdHl8AluX.a);
  wire(parent, dec.x[2]!, isDdHl8AluX.b);
  const isDdHl8Alu = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4430 });
  wire(parent, isDdHl8AluX.out, isDdHl8Alu.a);
  wire(parent, ddHl8Z45.out, isDdHl8Alu.b);
  tieToLabel('IS_DDIX_HL8_ALU', isDdHl8Alu.out, { x: pos.x + 9520, y: pos.y - 4430 });

  // PHASE4 bodies (imm also PHASE5 advance).
  const ddIxHl8LdNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4520 });
  wire(parent, isDdHl8Ld.out, ddIxHl8LdNow.a);
  tieToLabel('PHASE4', ddIxHl8LdNow.b, { x: pos.x + 9360, y: pos.y - 4520 });
  tieToLabel('DDIX_HL8_LD_NOW', ddIxHl8LdNow.out, { x: pos.x + 9600, y: pos.y - 4520 });

  const ddIxHl8ImmReadNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4490 });
  wire(parent, isDdHl8Imm.out, ddIxHl8ImmReadNow.a);
  tieToLabel('PHASE4', ddIxHl8ImmReadNow.b, { x: pos.x + 9360, y: pos.y - 4490 });
  tieToLabel('DDIX_HL8_IMM_READ_NOW', ddIxHl8ImmReadNow.out, { x: pos.x + 9600, y: pos.y - 4490 });
  const ddIxHl8ImmAdvRaw = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4475 });
  wire(parent, isDdHl8Imm.out, ddIxHl8ImmAdvRaw.a);
  tieToLabel('PHASE5', ddIxHl8ImmAdvRaw.b, { x: pos.x + 9360, y: pos.y - 4475 });
  const notDdIxHl8ImmReadNow = buildNot(parent, { x: pos.x + 9500, y: pos.y - 4482 });
  wire(parent, ddIxHl8ImmReadNow.out, notDdIxHl8ImmReadNow.in);
  const ddIxHl8ImmAdvanceNow = buildAnd(parent, { x: pos.x + 9540, y: pos.y - 4475 });
  wire(parent, ddIxHl8ImmAdvRaw.out, ddIxHl8ImmAdvanceNow.a);
  wire(parent, notDdIxHl8ImmReadNow.out, ddIxHl8ImmAdvanceNow.b);
  tieToLabel('DDIX_HL8_IMM_ADVANCE_NOW', ddIxHl8ImmAdvanceNow.out, { x: pos.x + 9680, y: pos.y - 4475 });

  const ddIxHl8IncNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4460 });
  wire(parent, isDdHl8Inc.out, ddIxHl8IncNow.a);
  tieToLabel('PHASE4', ddIxHl8IncNow.b, { x: pos.x + 9360, y: pos.y - 4460 });
  tieToLabel('DDIX_HL8_INC_NOW', ddIxHl8IncNow.out, { x: pos.x + 9600, y: pos.y - 4460 });

  const ddIxHl8AluNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4430 });
  wire(parent, isDdHl8Alu.out, ddIxHl8AluNow.a);
  tieToLabel('PHASE4', ddIxHl8AluNow.b, { x: pos.x + 9360, y: pos.y - 4430 });
  tieToLabel('DDIX_HL8_ALU_NOW', ddIxHl8AluNow.out, { x: pos.x + 9600, y: pos.y - 4430 });

  // Dest strobes — IXH/IXL never assert onto rH/rL WE.
  const ddIxhLdNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4520 });
  wire(parent, ddIxHl8LdNow.out, ddIxhLdNow.a);
  wire(parent, dec.y[4]!, ddIxhLdNow.b);
  const ddIxlLdNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4505 });
  wire(parent, ddIxHl8LdNow.out, ddIxlLdNow.a);
  wire(parent, dec.y[5]!, ddIxlLdNow.b);
  const ddIxhImmNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4490 });
  wire(parent, ddIxHl8ImmReadNow.out, ddIxhImmNow.a);
  wire(parent, dec.y[4]!, ddIxhImmNow.b);
  const ddIxlImmNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4475 });
  wire(parent, ddIxHl8ImmReadNow.out, ddIxlImmNow.a);
  wire(parent, dec.y[5]!, ddIxlImmNow.b);
  const ddIxhBusNow = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4505 });
  wire(parent, ddIxhLdNow.out, ddIxhBusNow.a);
  wire(parent, ddIxhImmNow.out, ddIxhBusNow.b);
  const ddIxlBusNow = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4485 });
  wire(parent, ddIxlLdNow.out, ddIxlBusNow.a);
  wire(parent, ddIxlImmNow.out, ddIxlBusNow.b);
  tieToLabel('DDIXH_BUS_NOW', ddIxhBusNow.out, { x: pos.x + 9720, y: pos.y - 4505 });
  tieToLabel('DDIXL_BUS_NOW', ddIxlBusNow.out, { x: pos.x + 9720, y: pos.y - 4485 });
  const ddIxhIncNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4460 });
  wire(parent, ddIxHl8IncNow.out, ddIxhIncNow.a);
  wire(parent, dec.y[4]!, ddIxhIncNow.b);
  const ddIxlIncNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4445 });
  wire(parent, ddIxHl8IncNow.out, ddIxlIncNow.a);
  wire(parent, dec.y[5]!, ddIxlIncNow.b);
  tieToLabel('DDIXH_INC_NOW', ddIxhIncNow.out, { x: pos.x + 9720, y: pos.y - 4460 });
  tieToLabel('DDIXL_INC_NOW', ddIxlIncNow.out, { x: pos.x + 9720, y: pos.y - 4445 });

  // Non-H/L dest WE under DD HL8 LD (B/C/D/E/A) — ldGroupNow is dead.
  const ddIxHl8WeSpecs: { y: Pin; label: string }[] = [
    { y: dec.y[0]!, label: 'DDIX_HL8_WE_B_NOW' },
    { y: dec.y[1]!, label: 'DDIX_HL8_WE_C_NOW' },
    { y: dec.y[2]!, label: 'DDIX_HL8_WE_D_NOW' },
    { y: dec.y[3]!, label: 'DDIX_HL8_WE_E_NOW' },
    { y: dec.y[7]!, label: 'DDIX_HL8_WE_A_NOW' },
  ];
  ddIxHl8WeSpecs.forEach(({ y, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4420 - i * 18 });
    wire(parent, ddIxHl8LdNow.out, gate.a);
    wire(parent, y, gate.b);
    tieToLabel(label, gate.out, { x: pos.x + 9720, y: pos.y - 4420 - i * 18 });
  });

  // Source→BUS enables for remapped H/L (z=4/5) under LD + ALU.
  const ddIxHl8SrcIxhLd = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4320 });
  wire(parent, ddIxHl8LdNow.out, ddIxHl8SrcIxhLd.a);
  wire(parent, dec.z[4]!, ddIxHl8SrcIxhLd.b);
  const ddIxHl8SrcIxlLd = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4305 });
  wire(parent, ddIxHl8LdNow.out, ddIxHl8SrcIxlLd.a);
  wire(parent, dec.z[5]!, ddIxHl8SrcIxlLd.b);
  const ddIxHl8SrcIxhAlu = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4290 });
  wire(parent, ddIxHl8AluNow.out, ddIxHl8SrcIxhAlu.a);
  wire(parent, dec.z[4]!, ddIxHl8SrcIxhAlu.b);
  const ddIxHl8SrcIxlAlu = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4275 });
  wire(parent, ddIxHl8AluNow.out, ddIxHl8SrcIxlAlu.a);
  wire(parent, dec.z[5]!, ddIxHl8SrcIxlAlu.b);
  const ddIxHl8SrcIxh = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4305 });
  wire(parent, ddIxHl8SrcIxhLd.out, ddIxHl8SrcIxh.a);
  wire(parent, ddIxHl8SrcIxhAlu.out, ddIxHl8SrcIxh.b);
  const ddIxHl8SrcIxl = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4285 });
  wire(parent, ddIxHl8SrcIxlLd.out, ddIxHl8SrcIxl.a);
  wire(parent, ddIxHl8SrcIxlAlu.out, ddIxHl8SrcIxl.b);
  tieToLabel('DDIX_HL8_SRC_IXH_NOW', ddIxHl8SrcIxh.out, { x: pos.x + 9760, y: pos.y - 4305 });
  tieToLabel('DDIX_HL8_SRC_IXL_NOW', ddIxHl8SrcIxl.out, { x: pos.x + 9760, y: pos.y - 4285 });

  // FD twins — IYH/IYL.
  const isFdHl8LdBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4240 });
  wire(parent, isFdActive, isFdHl8LdBase.a);
  wire(parent, notFdCbMode.out, isFdHl8LdBase.b);
  const isFdHl8LdX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4240 });
  wire(parent, isFdHl8LdBase.out, isFdHl8LdX.a);
  wire(parent, dec.x[1]!, isFdHl8LdX.b);
  const isFdHl8LdNy = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4240 });
  wire(parent, isFdHl8LdX.out, isFdHl8LdNy.a);
  wire(parent, notDdY6.out, isFdHl8LdNy.b);
  const isFdHl8LdNz = buildAnd(parent, { x: pos.x + 9380, y: pos.y - 4240 });
  wire(parent, isFdHl8LdNy.out, isFdHl8LdNz.a);
  wire(parent, notDdZ6.out, isFdHl8LdNz.b);
  const isFdHl8Ld = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4240 });
  wire(parent, isFdHl8LdNz.out, isFdHl8Ld.a);
  wire(parent, ddHl8Yz45.out, isFdHl8Ld.b);
  tieToLabel('IS_FDIY_HL8_LD', isFdHl8Ld.out, { x: pos.x + 9520, y: pos.y - 4240 });

  const isFdHl8ImmBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4210 });
  wire(parent, isFdActive, isFdHl8ImmBase.a);
  wire(parent, notFdCbMode.out, isFdHl8ImmBase.b);
  const isFdHl8ImmX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4210 });
  wire(parent, isFdHl8ImmBase.out, isFdHl8ImmX.a);
  wire(parent, dec.x[0]!, isFdHl8ImmX.b);
  const isFdHl8ImmZ = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4210 });
  wire(parent, isFdHl8ImmX.out, isFdHl8ImmZ.a);
  wire(parent, dec.z[6]!, isFdHl8ImmZ.b);
  const isFdHl8Imm = buildAnd(parent, { x: pos.x + 9380, y: pos.y - 4210 });
  wire(parent, isFdHl8ImmZ.out, isFdHl8Imm.a);
  wire(parent, ddHl8Y45.out, isFdHl8Imm.b);
  tieToLabel('IS_FDIY_HL8_IMM', isFdHl8Imm.out, { x: pos.x + 9520, y: pos.y - 4210 });

  const isFdHl8IncBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4180 });
  wire(parent, isFdActive, isFdHl8IncBase.a);
  wire(parent, notFdCbMode.out, isFdHl8IncBase.b);
  const isFdHl8IncX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4180 });
  wire(parent, isFdHl8IncBase.out, isFdHl8IncX.a);
  wire(parent, dec.x[0]!, isFdHl8IncX.b);
  const isFdHl8IncZ = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4180 });
  wire(parent, isFdHl8IncX.out, isFdHl8IncZ.a);
  wire(parent, ddHl8Z45.out, isFdHl8IncZ.b);
  const isFdHl8Inc = buildAnd(parent, { x: pos.x + 9380, y: pos.y - 4180 });
  wire(parent, isFdHl8IncZ.out, isFdHl8Inc.a);
  wire(parent, ddHl8Y45.out, isFdHl8Inc.b);
  tieToLabel('IS_FDIY_HL8_INC', isFdHl8Inc.out, { x: pos.x + 9520, y: pos.y - 4180 });
  const isFdHl8IsDec = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 4165 });
  wire(parent, isFdHl8Inc.out, isFdHl8IsDec.a);
  wire(parent, dec.z[5]!, isFdHl8IsDec.b);
  tieToLabel('FDIY_HL8_IS_DEC', isFdHl8IsDec.out, { x: pos.x + 9520, y: pos.y - 4165 });

  const isFdHl8AluBase = buildAnd(parent, { x: pos.x + 9260, y: pos.y - 4150 });
  wire(parent, isFdActive, isFdHl8AluBase.a);
  wire(parent, notFdCbMode.out, isFdHl8AluBase.b);
  const isFdHl8AluX = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 4150 });
  wire(parent, isFdHl8AluBase.out, isFdHl8AluX.a);
  wire(parent, dec.x[2]!, isFdHl8AluX.b);
  const isFdHl8Alu = buildAnd(parent, { x: pos.x + 9340, y: pos.y - 4150 });
  wire(parent, isFdHl8AluX.out, isFdHl8Alu.a);
  wire(parent, ddHl8Z45.out, isFdHl8Alu.b);
  tieToLabel('IS_FDIY_HL8_ALU', isFdHl8Alu.out, { x: pos.x + 9520, y: pos.y - 4150 });

  const fdIyHl8LdNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4240 });
  wire(parent, isFdHl8Ld.out, fdIyHl8LdNow.a);
  tieToLabel('PHASE4', fdIyHl8LdNow.b, { x: pos.x + 9360, y: pos.y - 4240 });
  tieToLabel('FDIY_HL8_LD_NOW', fdIyHl8LdNow.out, { x: pos.x + 9600, y: pos.y - 4240 });

  const fdIyHl8ImmReadNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4210 });
  wire(parent, isFdHl8Imm.out, fdIyHl8ImmReadNow.a);
  tieToLabel('PHASE4', fdIyHl8ImmReadNow.b, { x: pos.x + 9360, y: pos.y - 4210 });
  tieToLabel('FDIY_HL8_IMM_READ_NOW', fdIyHl8ImmReadNow.out, { x: pos.x + 9600, y: pos.y - 4210 });
  const fdIyHl8ImmAdvRaw = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4195 });
  wire(parent, isFdHl8Imm.out, fdIyHl8ImmAdvRaw.a);
  tieToLabel('PHASE5', fdIyHl8ImmAdvRaw.b, { x: pos.x + 9360, y: pos.y - 4195 });
  const notFdIyHl8ImmReadNow = buildNot(parent, { x: pos.x + 9500, y: pos.y - 4202 });
  wire(parent, fdIyHl8ImmReadNow.out, notFdIyHl8ImmReadNow.in);
  const fdIyHl8ImmAdvanceNow = buildAnd(parent, { x: pos.x + 9540, y: pos.y - 4195 });
  wire(parent, fdIyHl8ImmAdvRaw.out, fdIyHl8ImmAdvanceNow.a);
  wire(parent, notFdIyHl8ImmReadNow.out, fdIyHl8ImmAdvanceNow.b);
  tieToLabel('FDIY_HL8_IMM_ADVANCE_NOW', fdIyHl8ImmAdvanceNow.out, { x: pos.x + 9680, y: pos.y - 4195 });

  const fdIyHl8IncNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4180 });
  wire(parent, isFdHl8Inc.out, fdIyHl8IncNow.a);
  tieToLabel('PHASE4', fdIyHl8IncNow.b, { x: pos.x + 9360, y: pos.y - 4180 });
  tieToLabel('FDIY_HL8_INC_NOW', fdIyHl8IncNow.out, { x: pos.x + 9600, y: pos.y - 4180 });

  const fdIyHl8AluNow = buildAnd(parent, { x: pos.x + 9460, y: pos.y - 4150 });
  wire(parent, isFdHl8Alu.out, fdIyHl8AluNow.a);
  tieToLabel('PHASE4', fdIyHl8AluNow.b, { x: pos.x + 9360, y: pos.y - 4150 });
  tieToLabel('FDIY_HL8_ALU_NOW', fdIyHl8AluNow.out, { x: pos.x + 9600, y: pos.y - 4150 });

  const fdIyhLdNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4240 });
  wire(parent, fdIyHl8LdNow.out, fdIyhLdNow.a);
  wire(parent, dec.y[4]!, fdIyhLdNow.b);
  const fdIylLdNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4225 });
  wire(parent, fdIyHl8LdNow.out, fdIylLdNow.a);
  wire(parent, dec.y[5]!, fdIylLdNow.b);
  const fdIyhImmNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4210 });
  wire(parent, fdIyHl8ImmReadNow.out, fdIyhImmNow.a);
  wire(parent, dec.y[4]!, fdIyhImmNow.b);
  const fdIylImmNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4195 });
  wire(parent, fdIyHl8ImmReadNow.out, fdIylImmNow.a);
  wire(parent, dec.y[5]!, fdIylImmNow.b);
  const fdIyhBusNow = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4225 });
  wire(parent, fdIyhLdNow.out, fdIyhBusNow.a);
  wire(parent, fdIyhImmNow.out, fdIyhBusNow.b);
  const fdIylBusNow = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4205 });
  wire(parent, fdIylLdNow.out, fdIylBusNow.a);
  wire(parent, fdIylImmNow.out, fdIylBusNow.b);
  tieToLabel('FDIYH_BUS_NOW', fdIyhBusNow.out, { x: pos.x + 9720, y: pos.y - 4225 });
  tieToLabel('FDIYL_BUS_NOW', fdIylBusNow.out, { x: pos.x + 9720, y: pos.y - 4205 });
  const fdIyhIncNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4180 });
  wire(parent, fdIyHl8IncNow.out, fdIyhIncNow.a);
  wire(parent, dec.y[4]!, fdIyhIncNow.b);
  const fdIylIncNow = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4165 });
  wire(parent, fdIyHl8IncNow.out, fdIylIncNow.a);
  wire(parent, dec.y[5]!, fdIylIncNow.b);
  tieToLabel('FDIYH_INC_NOW', fdIyhIncNow.out, { x: pos.x + 9720, y: pos.y - 4180 });
  tieToLabel('FDIYL_INC_NOW', fdIylIncNow.out, { x: pos.x + 9720, y: pos.y - 4165 });

  const fdIyHl8WeSpecs: { y: Pin; label: string }[] = [
    { y: dec.y[0]!, label: 'FDIY_HL8_WE_B_NOW' },
    { y: dec.y[1]!, label: 'FDIY_HL8_WE_C_NOW' },
    { y: dec.y[2]!, label: 'FDIY_HL8_WE_D_NOW' },
    { y: dec.y[3]!, label: 'FDIY_HL8_WE_E_NOW' },
    { y: dec.y[7]!, label: 'FDIY_HL8_WE_A_NOW' },
  ];
  fdIyHl8WeSpecs.forEach(({ y, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4140 - i * 18 });
    wire(parent, fdIyHl8LdNow.out, gate.a);
    wire(parent, y, gate.b);
    tieToLabel(label, gate.out, { x: pos.x + 9720, y: pos.y - 4140 - i * 18 });
  });

  const fdIyHl8SrcIyhLd = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4040 });
  wire(parent, fdIyHl8LdNow.out, fdIyHl8SrcIyhLd.a);
  wire(parent, dec.z[4]!, fdIyHl8SrcIyhLd.b);
  const fdIyHl8SrcIylLd = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4025 });
  wire(parent, fdIyHl8LdNow.out, fdIyHl8SrcIylLd.a);
  wire(parent, dec.z[5]!, fdIyHl8SrcIylLd.b);
  const fdIyHl8SrcIyhAlu = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 4010 });
  wire(parent, fdIyHl8AluNow.out, fdIyHl8SrcIyhAlu.a);
  wire(parent, dec.z[4]!, fdIyHl8SrcIyhAlu.b);
  const fdIyHl8SrcIylAlu = buildAnd(parent, { x: pos.x + 9580, y: pos.y - 3995 });
  wire(parent, fdIyHl8AluNow.out, fdIyHl8SrcIylAlu.a);
  wire(parent, dec.z[5]!, fdIyHl8SrcIylAlu.b);
  const fdIyHl8SrcIyh = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4025 });
  wire(parent, fdIyHl8SrcIyhLd.out, fdIyHl8SrcIyh.a);
  wire(parent, fdIyHl8SrcIyhAlu.out, fdIyHl8SrcIyh.b);
  const fdIyHl8SrcIyl = buildOr(parent, { x: pos.x + 9620, y: pos.y - 4005 });
  wire(parent, fdIyHl8SrcIylLd.out, fdIyHl8SrcIyl.a);
  wire(parent, fdIyHl8SrcIylAlu.out, fdIyHl8SrcIyl.b);
  tieToLabel('FDIY_HL8_SRC_IYH_NOW', fdIyHl8SrcIyh.out, { x: pos.x + 9760, y: pos.y - 4025 });
  tieToLabel('FDIY_HL8_SRC_IYL_NOW', fdIyHl8SrcIyl.out, { x: pos.x + 9760, y: pos.y - 4005 });

  // `isEdX2Active`/`isEdX1Active`: `isEdActive` alone says only "the
  // recaptured byte follows a real `0xED`" — it says nothing about that
  // byte's own `x` field, and `y`/`z` are independent of `x` by
  // construction (three separate bit groups of the same byte). Found
  // live while designing `NEG`'s own decode: every block-family gate
  // above (`LDI`/`LDD`/`LDIR`/`LDDR`/`CPI`/`CPD`/`CPIR`/`CPDR`/`INI`/
  // `IND`/`INIR`/`INDR`/`OUTI`/`OUTD`/`OTIR`/`OTDR`) reads only
  // `isEdActive` plus its own `y`/`z` bits, never `dec.x` — meaning a
  // genuinely invalid `ED`-prefixed byte outside real Z80's own
  // documented rows (`0xED 0x20`, say — `x=00,y=4,z=0`, the same `y`/`z`
  // `LDI` reads) would incorrectly execute as `LDI` instead of staying
  // inert the way real hardware's own documented behavior requires
  // (undocumented `ED`-prefixed bytes act as two `NOP`s). Every one of
  // those sixteen gates is retrofitted below to read `isEdX2Active`
  // (`x=10`) instead of bare `isEdActive` — the identical value real
  // Z80 hardware actually requires, just not previously checked.
  // `isEdX1Active` (`x=01`) is `NEG`'s own family's requirement,
  // designed correctly from the start.
  const isEdX2Active = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 6360 });
  wire(parent, isEdActive, isEdX2Active.a);
  wire(parent, dec.x[2]!, isEdX2Active.b);
  const isEdX1Active = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 6370 });
  wire(parent, isEdActive, isEdX1Active.a);
  wire(parent, dec.x[1]!, isEdX1Active.b);
  // CB x=00 — rotate/shift column (RLC…SRL). Same "prefix ∧ x" shape.
  // `cbTableActive` covers plain CB plus DD CB / FD CB mode (nested).
  const isCbX0Active = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 6375 });
  wire(parent, cbTableActive.out, isCbX0Active.a);
  wire(parent, dec.x[0]!, isCbX0Active.b);
  tieToLabel('IS_CB_ROT', isCbX0Active.out, { x: pos.x + 9200, y: pos.y - 6375 });
  // CB x=01 is the BIT family — same "prefix ∧ this table's x" shape ED uses.
  const isCbX1Active = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 6380 });
  wire(parent, cbTableActive.out, isCbX1Active.a);
  wire(parent, dec.x[1]!, isCbX1Active.b);
  // CB x=10 / x=11 — RES / SET.
  const isCbX2Active = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 6390 });
  wire(parent, cbTableActive.out, isCbX2Active.a);
  wire(parent, dec.x[2]!, isCbX2Active.b);
  tieToLabel('IS_CB_RES', isCbX2Active.out, { x: pos.x + 9200, y: pos.y - 6390 });
  const isCbX3Active = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 6400 });
  wire(parent, cbTableActive.out, isCbX3Active.a);
  wire(parent, dec.x[3]!, isCbX3Active.b);
  tieToLabel('IS_CB_SET', isCbX3Active.out, { x: pos.x + 9200, y: pos.y - 6400 });
  const isCbSetRes = buildOr(parent, { x: pos.x + 9200, y: pos.y - 6395 });
  wire(parent, isCbX2Active.out, isCbSetRes.a);
  wire(parent, isCbX3Active.out, isCbSetRes.b);

  // x=01 (CB): BIT y,r — register form (z≠6) and (HL) form (z=6).
  // Register: flags-only, single PHASE4 after the prefix. (HL): PHASE4
  // reads into shared `hlMemTemp`, PHASE5 commits flags — no write-back.
  // Collides with unprefixed `LD r,r'` — `NOT_PREFIX_ACTIVE` keeps that quiet.
  // Under DD CB / FD CB mode, register-form CB stays quiet (CB itself in IR
  // at PHASE4 looks like SET z=3); SET/RES/rot (HL) also gated off this slice.
  const notCbBitHl = buildNot(parent, { x: pos.x + 9200, y: pos.y - 7400 });
  wire(parent, dec.z[6]!, notCbBitHl.in);
  const isBitRegRaw = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7400 });
  wire(parent, isCbX1Active.out, isBitRegRaw.a);
  wire(parent, notCbBitHl.out, isBitRegRaw.b);
  const isBitRegNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7400 });
  wire(parent, isBitRegRaw.out, isBitRegNow.a);
  wire(parent, notDdFdCbMode.out, isBitRegNow.b);
  tieToLabel('IS_BIT_REG_NOW', isBitRegNow.out, { x: pos.x + 9300, y: pos.y - 7400 });
  const bitRegNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7420 });
  wire(parent, isBitRegNow.out, bitRegNow.a);
  tieToLabel('PHASE4', bitRegNow.b, { x: pos.x + 9250, y: pos.y - 7420 });
  tieToLabel('BIT_REG_NOW', bitRegNow.out, { x: pos.x + 9450, y: pos.y - 7420 }); // anchor — F we/layer

  const isBitHlRaw = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7440 });
  wire(parent, isCbX1Active.out, isBitHlRaw.a);
  wire(parent, dec.z[6]!, isBitHlRaw.b);
  const isBitHl = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7440 });
  wire(parent, isBitHlRaw.out, isBitHl.a);
  wire(parent, notDdFdCbMode.out, isBitHl.b);
  tieToLabel('IS_BIT_HL', isBitHl.out, { x: pos.x + 9300, y: pos.y - 7440 });
  const bitHlReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7460 });
  wire(parent, isBitHl.out, bitHlReadNow.a);
  tieToLabel('PHASE4', bitHlReadNow.b, { x: pos.x + 9250, y: pos.y - 7460 });
  tieToLabel('BIT_HL_READ_NOW', bitHlReadNow.out, { x: pos.x + 9450, y: pos.y - 7460 }); // anchor — hlMemTemp.we, ram.oe, addr=HL
  const bitHlNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7480 });
  wire(parent, isBitHl.out, bitHlNow.a);
  tieToLabel('PHASE5', bitHlNow.b, { x: pos.x + 9250, y: pos.y - 7480 });
  tieToLabel('BIT_HL_NOW', bitHlNow.out, { x: pos.x + 9450, y: pos.y - 7480 }); // anchor — F we/layer

  // DD CB / FD CB: BIT y,(IX+d)/(IY+d) — documented z=6 only. After PHASE6
  // op recapture, PHASE7 reads @ IX+d/IY+d and commits flags from BUS same
  // phase (mirror ALU A,(IX+d) @ PHASE6 — not BIT_HL's two-phase hold).
  const isDdCbBit = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7495 });
  wire(parent, ddCbMode.q[0]!, isDdCbBit.a);
  wire(parent, isCbX1Active.out, isDdCbBit.b);
  const isDdCbBitZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7495 });
  wire(parent, isDdCbBit.out, isDdCbBitZ.a);
  wire(parent, dec.z[6]!, isDdCbBitZ.b);
  const bitIxRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7495 });
  wire(parent, isDdCbBitZ.out, bitIxRaw.a);
  tieToLabel('PHASE7', bitIxRaw.b, { x: pos.x + 9200, y: pos.y - 7495 });
  const notDdCbOpReadForBit = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7485 });
  tieToLabel('DDCB_OP_READ_NOW', notDdCbOpReadForBit.in, { x: pos.x + 9220, y: pos.y - 7485 });
  const bitIxNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7495 });
  wire(parent, bitIxRaw.out, bitIxNow.a);
  wire(parent, notDdCbOpReadForBit.out, bitIxNow.b);
  tieToLabel('BIT_IX_NOW', bitIxNow.out, { x: pos.x + 9450, y: pos.y - 7495 }); // anchor — ram.oe, IXDISP, F

  const isFdCbBit = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7510 });
  wire(parent, fdCbMode.q[0]!, isFdCbBit.a);
  wire(parent, isCbX1Active.out, isFdCbBit.b);
  const isFdCbBitZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7510 });
  wire(parent, isFdCbBit.out, isFdCbBitZ.a);
  wire(parent, dec.z[6]!, isFdCbBitZ.b);
  const bitIyRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7510 });
  wire(parent, isFdCbBitZ.out, bitIyRaw.a);
  tieToLabel('PHASE7', bitIyRaw.b, { x: pos.x + 9200, y: pos.y - 7510 });
  const notFdCbOpReadForBit = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7500 });
  tieToLabel('FDCB_OP_READ_NOW', notFdCbOpReadForBit.in, { x: pos.x + 9220, y: pos.y - 7500 });
  const bitIyNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7510 });
  wire(parent, bitIyRaw.out, bitIyNow.a);
  wire(parent, notFdCbOpReadForBit.out, bitIyNow.b);
  tieToLabel('BIT_IY_NOW', bitIyNow.out, { x: pos.x + 9450, y: pos.y - 7510 }); // anchor — ram.oe, IYDISP, F

  const bitIxIyNow = buildOr(parent, { x: pos.x + 9500, y: pos.y - 7502 });
  wire(parent, bitIxNow.out, bitIxIyNow.a);
  wire(parent, bitIyNow.out, bitIxIyNow.b);
  tieToLabel('BIT_IXIY_NOW', bitIxIyNow.out, { x: pos.x + 9600, y: pos.y - 7502 }); // anchor — shared F we/layer

  // One-hot z picks B/C/D/E/H/L/A (no (HL)); y picks which bit to test.
  const bitRegSelect: { reg: Pin[]; z: Pin }[] = [
    { reg: rB.q, z: dec.z[0]! },
    { reg: rC.q, z: dec.z[1]! },
    { reg: rD.q, z: dec.z[2]! },
    { reg: rE.q, z: dec.z[3]! },
    { reg: rH.q, z: dec.z[4]! },
    { reg: rL.q, z: dec.z[5]! },
    { reg: a.q, z: dec.z[7]! },
  ];
  const bitRegByte: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    let term: Pin | null = null;
    for (let ri = 0; ri < bitRegSelect.length; ri++) {
      const { reg, z } = bitRegSelect[ri]!;
      const andGate = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 7600 + i * 80 + ri * 10 });
      wire(parent, reg[i]!, andGate.a);
      wire(parent, z, andGate.b);
      if (term === null) {
        term = andGate.out;
      } else {
        const orGate = buildOr(parent, { x: pos.x + 9550, y: pos.y - 7600 + i * 80 + ri * 10 });
        wire(parent, term, orGate.a);
        wire(parent, andGate.out, orGate.b);
        term = orGate.out;
      }
    }
    bitRegByte.push(term!);
  }
  let bitTest: Pin | null = null;
  for (let yi = 0; yi < 8; yi++) {
    const andGate = buildAnd(parent, { x: pos.x + 9600, y: pos.y - 7600 + yi * 20 });
    wire(parent, bitRegByte[yi]!, andGate.a);
    wire(parent, dec.y[yi]!, andGate.b);
    if (bitTest === null) {
      bitTest = andGate.out;
    } else {
      const orGate = buildOr(parent, { x: pos.x + 9650, y: pos.y - 7600 + yi * 20 });
      wire(parent, bitTest, orGate.a);
      wire(parent, andGate.out, orGate.b);
      bitTest = orGate.out;
    }
  }
  const bitZBit = buildNot(parent, { x: pos.x + 9700, y: pos.y - 7420 });
  wire(parent, bitTest!, bitZBit.in);
  // S is bit 7 of (r AND mask) — nonzero only when testing bit 7 and it is set.
  const bitSBit = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 7400 });
  wire(parent, bitTest!, bitSBit.a);
  wire(parent, dec.y[7]!, bitSBit.b);
  // P/V mirrors Z on BIT (undocumented-but-stable real Z80 behavior).
  const bitPBit = bitZBit.out;
  const bitXBit = bitRegByte[3]!;
  const bitYBit = bitRegByte[5]!;

  // x=10/x=11 (CB): RES y,r / SET y,r — clear or set one bit. No flags.
  // Register form: PHASE4. (HL): PHASE4 read into hlMemTemp, PHASE5 write
  // the modified byte back. Result byte published as SETRESRESULT{i}
  // after hlMemTemp exists (shared src mux: register select vs HLMEM).
  const notCbSetResHl = buildNot(parent, { x: pos.x + 9200, y: pos.y - 7500 });
  wire(parent, dec.z[6]!, notCbSetResHl.in);
  const isSetResRegRaw = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7500 });
  wire(parent, isCbSetRes.out, isSetResRegRaw.a);
  wire(parent, notCbSetResHl.out, isSetResRegRaw.b);
  const isSetResReg = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7500 });
  wire(parent, isSetResRegRaw.out, isSetResReg.a);
  wire(parent, notDdFdCbMode.out, isSetResReg.b);
  tieToLabel('IS_SETRES_REG', isSetResReg.out, { x: pos.x + 9300, y: pos.y - 7500 });
  const setResRegNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7520 });
  wire(parent, isSetResReg.out, setResRegNow.a);
  tieToLabel('PHASE4', setResRegNow.b, { x: pos.x + 9250, y: pos.y - 7520 });
  tieToLabel('SETRES_REG_NOW', setResRegNow.out, { x: pos.x + 9450, y: pos.y - 7520 });
  const setResWeSpecs: { z: Pin; label: string }[] = [
    { z: dec.z[0]!, label: 'SETRES_WE_B_NOW' },
    { z: dec.z[1]!, label: 'SETRES_WE_C_NOW' },
    { z: dec.z[2]!, label: 'SETRES_WE_D_NOW' },
    { z: dec.z[3]!, label: 'SETRES_WE_E_NOW' },
    { z: dec.z[4]!, label: 'SETRES_WE_H_NOW' },
    { z: dec.z[5]!, label: 'SETRES_WE_L_NOW' },
    { z: dec.z[7]!, label: 'SETRES_WE_A_NOW' },
  ];
  setResWeSpecs.forEach(({ z, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 7500 - i * 25 });
    wire(parent, setResRegNow.out, gate.a);
    wire(parent, z, gate.b);
    tieToLabel(label, gate.out, { x: pos.x + 9600, y: pos.y - 7500 - i * 25 });
  });

  const isSetResHlRaw = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7540 });
  wire(parent, isCbSetRes.out, isSetResHlRaw.a);
  wire(parent, dec.z[6]!, isSetResHlRaw.b);
  const isSetResHl = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7540 });
  wire(parent, isSetResHlRaw.out, isSetResHl.a);
  wire(parent, notDdFdCbMode.out, isSetResHl.b);
  tieToLabel('IS_SETRES_HL', isSetResHl.out, { x: pos.x + 9300, y: pos.y - 7540 });
  const setResHlReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7560 });
  wire(parent, isSetResHl.out, setResHlReadNow.a);
  tieToLabel('PHASE4', setResHlReadNow.b, { x: pos.x + 9250, y: pos.y - 7560 });
  tieToLabel('SETRES_HL_READ_NOW', setResHlReadNow.out, { x: pos.x + 9450, y: pos.y - 7560 });
  const setResHlWriteRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7580 });
  wire(parent, isSetResHl.out, setResHlWriteRaw.a);
  tieToLabel('PHASE5', setResHlWriteRaw.b, { x: pos.x + 9250, y: pos.y - 7580 });
  const notSetResHlReadNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 7570 });
  wire(parent, setResHlReadNow.out, notSetResHlReadNow.in);
  const setResHlWriteNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 7580 });
  wire(parent, setResHlWriteRaw.out, setResHlWriteNow.a);
  wire(parent, notSetResHlReadNow.out, setResHlWriteNow.b);
  tieToLabel('SETRES_HL_WRITE_NOW', setResHlWriteNow.out, { x: pos.x + 9550, y: pos.y - 7580 });

  // DD CB / FD CB: SET/RES y,(IX+d)/(IY+d) — documented z=6 only. PHASE7
  // read → hlMemTemp; PHASE8 write SETRESRESULT @ IX+d/IY+d. Undocumented
  // z≠6 register write-back skipped this slice.
  const isDdCbSetRes = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7720 });
  wire(parent, ddCbMode.q[0]!, isDdCbSetRes.a);
  wire(parent, isCbSetRes.out, isDdCbSetRes.b);
  const isDdCbSetResZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7720 });
  wire(parent, isDdCbSetRes.out, isDdCbSetResZ.a);
  wire(parent, dec.z[6]!, isDdCbSetResZ.b);
  const setResIxReadRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7720 });
  wire(parent, isDdCbSetResZ.out, setResIxReadRaw.a);
  tieToLabel('PHASE7', setResIxReadRaw.b, { x: pos.x + 9200, y: pos.y - 7720 });
  const notDdCbOpReadForSetRes = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7710 });
  tieToLabel('DDCB_OP_READ_NOW', notDdCbOpReadForSetRes.in, { x: pos.x + 9220, y: pos.y - 7710 });
  const setResIxReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7720 });
  wire(parent, setResIxReadRaw.out, setResIxReadNow.a);
  wire(parent, notDdCbOpReadForSetRes.out, setResIxReadNow.b);
  tieToLabel('SETRES_IX_READ_NOW', setResIxReadNow.out, { x: pos.x + 9450, y: pos.y - 7720 }); // anchor — hlMemTemp.we, ram.oe, IXDISP
  const setResIxWriteRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7740 });
  wire(parent, isDdCbSetResZ.out, setResIxWriteRaw.a);
  tieToLabel('PHASE8', setResIxWriteRaw.b, { x: pos.x + 9200, y: pos.y - 7740 });
  const notSetResIxReadNow = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7730 });
  wire(parent, setResIxReadNow.out, notSetResIxReadNow.in);
  const setResIxWriteNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7740 });
  wire(parent, setResIxWriteRaw.out, setResIxWriteNow.a);
  wire(parent, notSetResIxReadNow.out, setResIxWriteNow.b);
  tieToLabel('SETRES_IX_WRITE_NOW', setResIxWriteNow.out, { x: pos.x + 9450, y: pos.y - 7740 }); // anchor — ram.we, SETRESRESULT bus, IXDISP

  const isFdCbSetRes = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7760 });
  wire(parent, fdCbMode.q[0]!, isFdCbSetRes.a);
  wire(parent, isCbSetRes.out, isFdCbSetRes.b);
  const isFdCbSetResZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7760 });
  wire(parent, isFdCbSetRes.out, isFdCbSetResZ.a);
  wire(parent, dec.z[6]!, isFdCbSetResZ.b);
  const setResIyReadRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7760 });
  wire(parent, isFdCbSetResZ.out, setResIyReadRaw.a);
  tieToLabel('PHASE7', setResIyReadRaw.b, { x: pos.x + 9200, y: pos.y - 7760 });
  const notFdCbOpReadForSetRes = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7750 });
  tieToLabel('FDCB_OP_READ_NOW', notFdCbOpReadForSetRes.in, { x: pos.x + 9220, y: pos.y - 7750 });
  const setResIyReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7760 });
  wire(parent, setResIyReadRaw.out, setResIyReadNow.a);
  wire(parent, notFdCbOpReadForSetRes.out, setResIyReadNow.b);
  tieToLabel('SETRES_IY_READ_NOW', setResIyReadNow.out, { x: pos.x + 9450, y: pos.y - 7760 });
  const setResIyWriteRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7780 });
  wire(parent, isFdCbSetResZ.out, setResIyWriteRaw.a);
  tieToLabel('PHASE8', setResIyWriteRaw.b, { x: pos.x + 9200, y: pos.y - 7780 });
  const notSetResIyReadNow = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7770 });
  wire(parent, setResIyReadNow.out, notSetResIyReadNow.in);
  const setResIyWriteNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7780 });
  wire(parent, setResIyWriteRaw.out, setResIyWriteNow.a);
  wire(parent, notSetResIyReadNow.out, setResIyWriteNow.b);
  tieToLabel('SETRES_IY_WRITE_NOW', setResIyWriteNow.out, { x: pos.x + 9450, y: pos.y - 7780 });

  const setResCommitRegHl = buildOr(parent, { x: pos.x + 9500, y: pos.y - 7550 });
  wire(parent, setResRegNow.out, setResCommitRegHl.a);
  wire(parent, setResHlWriteNow.out, setResCommitRegHl.b);
  const setResCommitIxIy = buildOr(parent, { x: pos.x + 9520, y: pos.y - 7730 });
  wire(parent, setResIxWriteNow.out, setResCommitIxIy.a);
  wire(parent, setResIyWriteNow.out, setResCommitIxIy.b);
  const setResCommitNow = buildOr(parent, { x: pos.x + 9550, y: pos.y - 7550 });
  wire(parent, setResCommitRegHl.out, setResCommitNow.a);
  wire(parent, setResCommitIxIy.out, setResCommitNow.b);
  tieToLabel('SETRES_COMMIT_NOW', setResCommitNow.out, { x: pos.x + 9650, y: pos.y - 7550 });
  const setResMemWriteAny = buildOr(parent, { x: pos.x + 9580, y: pos.y - 7570 });
  wire(parent, setResHlWriteNow.out, setResMemWriteAny.a);
  wire(parent, setResCommitIxIy.out, setResMemWriteAny.b);
  tieToLabel('SETRES_MEM_WRITE_ANY', setResMemWriteAny.out, { x: pos.x + 9680, y: pos.y - 7570 }); // anchor — bus drive / ram.we

  // x=00 (CB): RLC/RRC/RL/RR/SLA/SRA/SLL/SRL — rotate/shift. Unlike
  // unprefixed RLCA/… these refresh S/Z/P/X/Y/H/N/C from the *result*.
  // Register: PHASE4. (HL): PHASE4 read, PHASE5 write+flags. Collides with
  // unprefixed x=00 — `NOT_PREFIX_ACTIVE` keeps that quiet.
  const notCbRotHl = buildNot(parent, { x: pos.x + 9200, y: pos.y - 7620 });
  wire(parent, dec.z[6]!, notCbRotHl.in);
  const isCbRotRegRaw = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7620 });
  wire(parent, isCbX0Active.out, isCbRotRegRaw.a);
  wire(parent, notCbRotHl.out, isCbRotRegRaw.b);
  const isCbRotReg = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7620 });
  wire(parent, isCbRotRegRaw.out, isCbRotReg.a);
  wire(parent, notDdFdCbMode.out, isCbRotReg.b);
  tieToLabel('IS_CBROT_REG', isCbRotReg.out, { x: pos.x + 9300, y: pos.y - 7620 });
  const cbRotRegNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7640 });
  wire(parent, isCbRotReg.out, cbRotRegNow.a);
  tieToLabel('PHASE4', cbRotRegNow.b, { x: pos.x + 9250, y: pos.y - 7640 });
  tieToLabel('CBROT_REG_NOW', cbRotRegNow.out, { x: pos.x + 9450, y: pos.y - 7640 });
  const cbRotWeSpecs: { z: Pin; label: string }[] = [
    { z: dec.z[0]!, label: 'CBROT_WE_B_NOW' },
    { z: dec.z[1]!, label: 'CBROT_WE_C_NOW' },
    { z: dec.z[2]!, label: 'CBROT_WE_D_NOW' },
    { z: dec.z[3]!, label: 'CBROT_WE_E_NOW' },
    { z: dec.z[4]!, label: 'CBROT_WE_H_NOW' },
    { z: dec.z[5]!, label: 'CBROT_WE_L_NOW' },
    { z: dec.z[7]!, label: 'CBROT_WE_A_NOW' },
  ];
  cbRotWeSpecs.forEach(({ z, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 7620 - i * 25 });
    wire(parent, cbRotRegNow.out, gate.a);
    wire(parent, z, gate.b);
    tieToLabel(label, gate.out, { x: pos.x + 9600, y: pos.y - 7620 - i * 25 });
  });
  const isCbRotHlRaw = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7660 });
  wire(parent, isCbX0Active.out, isCbRotHlRaw.a);
  wire(parent, dec.z[6]!, isCbRotHlRaw.b);
  const isCbRotHl = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7660 });
  wire(parent, isCbRotHlRaw.out, isCbRotHl.a);
  wire(parent, notDdFdCbMode.out, isCbRotHl.b);
  tieToLabel('IS_CBROT_HL', isCbRotHl.out, { x: pos.x + 9300, y: pos.y - 7660 });
  const cbRotHlReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7680 });
  wire(parent, isCbRotHl.out, cbRotHlReadNow.a);
  tieToLabel('PHASE4', cbRotHlReadNow.b, { x: pos.x + 9250, y: pos.y - 7680 });
  tieToLabel('CBROT_HL_READ_NOW', cbRotHlReadNow.out, { x: pos.x + 9450, y: pos.y - 7680 });
  const cbRotHlWriteRaw = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7700 });
  wire(parent, isCbRotHl.out, cbRotHlWriteRaw.a);
  tieToLabel('PHASE5', cbRotHlWriteRaw.b, { x: pos.x + 9250, y: pos.y - 7700 });
  const notCbRotHlReadNow = buildNot(parent, { x: pos.x + 9400, y: pos.y - 7690 });
  wire(parent, cbRotHlReadNow.out, notCbRotHlReadNow.in);
  const cbRotHlWriteNow = buildAnd(parent, { x: pos.x + 9450, y: pos.y - 7700 });
  wire(parent, cbRotHlWriteRaw.out, cbRotHlWriteNow.a);
  wire(parent, notCbRotHlReadNow.out, cbRotHlWriteNow.b);
  tieToLabel('CBROT_HL_WRITE_NOW', cbRotHlWriteNow.out, { x: pos.x + 9550, y: pos.y - 7700 });

  // DD CB / FD CB: RLC…SRL (IX+d)/(IY+d) — documented z=6 only. PHASE7
  // read → cbRotHold; PHASE8 write+flags. Same undocumented z≠6 skip.
  const isDdCbRot = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7800 });
  wire(parent, ddCbMode.q[0]!, isDdCbRot.a);
  wire(parent, isCbX0Active.out, isDdCbRot.b);
  const isDdCbRotZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7800 });
  wire(parent, isDdCbRot.out, isDdCbRotZ.a);
  wire(parent, dec.z[6]!, isDdCbRotZ.b);
  const cbRotIxReadRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7800 });
  wire(parent, isDdCbRotZ.out, cbRotIxReadRaw.a);
  tieToLabel('PHASE7', cbRotIxReadRaw.b, { x: pos.x + 9200, y: pos.y - 7800 });
  const notDdCbOpReadForRot = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7790 });
  tieToLabel('DDCB_OP_READ_NOW', notDdCbOpReadForRot.in, { x: pos.x + 9220, y: pos.y - 7790 });
  const cbRotIxReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7800 });
  wire(parent, cbRotIxReadRaw.out, cbRotIxReadNow.a);
  wire(parent, notDdCbOpReadForRot.out, cbRotIxReadNow.b);
  tieToLabel('CBROT_IX_READ_NOW', cbRotIxReadNow.out, { x: pos.x + 9450, y: pos.y - 7800 }); // anchor — cbRotHold.we, ram.oe, IXDISP
  const cbRotIxWriteRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7820 });
  wire(parent, isDdCbRotZ.out, cbRotIxWriteRaw.a);
  tieToLabel('PHASE8', cbRotIxWriteRaw.b, { x: pos.x + 9200, y: pos.y - 7820 });
  const notCbRotIxReadNow = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7810 });
  wire(parent, cbRotIxReadNow.out, notCbRotIxReadNow.in);
  const cbRotIxWriteNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7820 });
  wire(parent, cbRotIxWriteRaw.out, cbRotIxWriteNow.a);
  wire(parent, notCbRotIxReadNow.out, cbRotIxWriteNow.b);
  tieToLabel('CBROT_IX_WRITE_NOW', cbRotIxWriteNow.out, { x: pos.x + 9450, y: pos.y - 7820 }); // anchor — ram.we, CBROT bus, F, IXDISP

  const isFdCbRot = buildAnd(parent, { x: pos.x + 9220, y: pos.y - 7840 });
  wire(parent, fdCbMode.q[0]!, isFdCbRot.a);
  wire(parent, isCbX0Active.out, isFdCbRot.b);
  const isFdCbRotZ = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 7840 });
  wire(parent, isFdCbRot.out, isFdCbRotZ.a);
  wire(parent, dec.z[6]!, isFdCbRotZ.b);
  const cbRotIyReadRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7840 });
  wire(parent, isFdCbRotZ.out, cbRotIyReadRaw.a);
  tieToLabel('PHASE7', cbRotIyReadRaw.b, { x: pos.x + 9200, y: pos.y - 7840 });
  const notFdCbOpReadForRot = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7830 });
  tieToLabel('FDCB_OP_READ_NOW', notFdCbOpReadForRot.in, { x: pos.x + 9220, y: pos.y - 7830 });
  const cbRotIyReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7840 });
  wire(parent, cbRotIyReadRaw.out, cbRotIyReadNow.a);
  wire(parent, notFdCbOpReadForRot.out, cbRotIyReadNow.b);
  tieToLabel('CBROT_IY_READ_NOW', cbRotIyReadNow.out, { x: pos.x + 9450, y: pos.y - 7840 });
  const cbRotIyWriteRaw = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 7860 });
  wire(parent, isFdCbRotZ.out, cbRotIyWriteRaw.a);
  tieToLabel('PHASE8', cbRotIyWriteRaw.b, { x: pos.x + 9200, y: pos.y - 7860 });
  const notCbRotIyReadNow = buildNot(parent, { x: pos.x + 9320, y: pos.y - 7850 });
  wire(parent, cbRotIyReadNow.out, notCbRotIyReadNow.in);
  const cbRotIyWriteNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 7860 });
  wire(parent, cbRotIyWriteRaw.out, cbRotIyWriteNow.a);
  wire(parent, notCbRotIyReadNow.out, cbRotIyWriteNow.b);
  tieToLabel('CBROT_IY_WRITE_NOW', cbRotIyWriteNow.out, { x: pos.x + 9450, y: pos.y - 7860 });

  // Flags + register/RAM commit share this strobe (reg PHASE4, HL PHASE5,
  // IX/IY PHASE8).
  const cbRotRegHl = buildOr(parent, { x: pos.x + 9500, y: pos.y - 7670 });
  wire(parent, cbRotRegNow.out, cbRotRegHl.a);
  wire(parent, cbRotHlWriteNow.out, cbRotRegHl.b);
  const cbRotIxIy = buildOr(parent, { x: pos.x + 9520, y: pos.y - 7810 });
  wire(parent, cbRotIxWriteNow.out, cbRotIxIy.a);
  wire(parent, cbRotIyWriteNow.out, cbRotIxIy.b);
  const cbRotNow = buildOr(parent, { x: pos.x + 9550, y: pos.y - 7670 });
  wire(parent, cbRotRegHl.out, cbRotNow.a);
  wire(parent, cbRotIxIy.out, cbRotNow.b);
  tieToLabel('CBROT_NOW', cbRotNow.out, { x: pos.x + 9650, y: pos.y - 7670 });
  const cbRotMemWriteAny = buildOr(parent, { x: pos.x + 9580, y: pos.y - 7690 });
  wire(parent, cbRotHlWriteNow.out, cbRotMemWriteAny.a);
  wire(parent, cbRotIxIy.out, cbRotMemWriteAny.b);
  tieToLabel('CBROT_MEM_WRITE_ANY', cbRotMemWriteAny.out, { x: pos.x + 9680, y: pos.y - 7690 }); // anchor — memBit/hlSrc/bus/ram.we
  const cbRotMemReadIxIy = buildOr(parent, { x: pos.x + 9580, y: pos.y - 7710 });
  wire(parent, cbRotIxReadNow.out, cbRotMemReadIxIy.a);
  wire(parent, cbRotIyReadNow.out, cbRotMemReadIxIy.b);
  const cbRotMemReadAny = buildOr(parent, { x: pos.x + 9600, y: pos.y - 7700 });
  wire(parent, cbRotHlReadNow.out, cbRotMemReadAny.a);
  wire(parent, cbRotMemReadIxIy.out, cbRotMemReadAny.b);
  tieToLabel('CBROT_MEM_READ_ANY', cbRotMemReadAny.out, { x: pos.x + 9700, y: pos.y - 7700 }); // anchor — cbRotHold.we

  // PHASE8 write union for DD/FD CB op-advance exclusion (adjacent phase).
  const ddCbPhase8WriteAny = buildOr(parent, { x: pos.x + 9600, y: pos.y - 7880 });
  wire(parent, setResIxWriteNow.out, ddCbPhase8WriteAny.a);
  wire(parent, cbRotIxWriteNow.out, ddCbPhase8WriteAny.b);
  tieToLabel('DDCB_PHASE8_WRITE_ANY', ddCbPhase8WriteAny.out, { x: pos.x + 9700, y: pos.y - 7880 });
  const fdCbPhase8WriteAny = buildOr(parent, { x: pos.x + 9600, y: pos.y - 7900 });
  wire(parent, setResIyWriteNow.out, fdCbPhase8WriteAny.a);
  wire(parent, cbRotIyWriteNow.out, fdCbPhase8WriteAny.b);
  tieToLabel('FDCB_PHASE8_WRITE_ANY', fdCbPhase8WriteAny.out, { x: pos.x + 9700, y: pos.y - 7900 });

  // x=10, z=0: LDI/LDD/LDIR/LDDR (real 0xED 0xA0/0xA8/0xB0/0xB8) — real
  // Z80's own block-move family, `y=4..7` selecting which of the four:
  // `(DE)<-(HL)`, then `HL`/`DE` both `++` (`LDI`/`LDIR`) or both `--`
  // (`LDD`/`LDDR`), `BC--` always, `N`/`H` reset, `P/V<-(BC-1!=0)`, `S`/
  // `Z`/`C` untouched (the two undocumented `X`/`Y` bits *do* change on
  // real hardware too, from `A` plus the transferred byte — deliberately
  // not modeled here, a documented simplification, not an oversight, the
  // same category as `INC r`/`DEC r`'s own unmodeled `H` before "Closing
  // the half-carry gap" made that one real). `LDIR`/`LDDR` additionally
  // repeat — real Z80 re-runs the same two-byte instruction, extra machine
  // cycles and all, until `BC` reaches `0` — modeled here as `PC` landing
  // back on its own opcode instead of advancing, whenever this pass's own
  // `P/V` (`BC-1 != 0`) says there's more to copy (see the `pc` mux
  // chain's own final layer, far below).
  //
  // Decoded here, right next to `isEdActive`'s own anchor above and well
  // before the pair adders below need it, specifically so `isLdBlockNow`
  // exists in time to widen `BC`'s own pair adder's direction line a few
  // lines down — real `x=10,y=4..7,z=0` collides head-on with the plain
  // unprefixed table's own `AND B`/`XOR B`/`OR B`/`CP B` (see "The invasive
  // part" in the prefix mechanism's own doc comment above), so this reads
  // the *recaptured* `ir`'s `dec.y`/`dec.z` exactly the way that collision
  // predicts, gated by `isEdActive` to stay silent for the real
  // unprefixed four.
  const isLdiNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6300 });
  const isLdiStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6300 });
  wire(parent, isEdX2Active.out, isLdiStage.a);
  wire(parent, dec.y[4]!, isLdiStage.b);
  wire(parent, isLdiStage.out, isLdiNow.a);
  wire(parent, dec.z[0]!, isLdiNow.b);
  tieToLabel('IS_LDI_NOW', isLdiNow.out, { x: pos.x + 9150, y: pos.y - 6300 }); // anchor — isLdBlockNow just below reads this
  const isLddNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6270 });
  const isLddStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6270 });
  wire(parent, isEdX2Active.out, isLddStage.a);
  wire(parent, dec.y[5]!, isLddStage.b);
  wire(parent, isLddStage.out, isLddNow.a);
  wire(parent, dec.z[0]!, isLddNow.b);
  tieToLabel('IS_LDD_NOW', isLddNow.out, { x: pos.x + 9150, y: pos.y - 6270 });
  const isLdirNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6240 });
  const isLdirStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6240 });
  wire(parent, isEdX2Active.out, isLdirStage.a);
  wire(parent, dec.y[6]!, isLdirStage.b);
  wire(parent, isLdirStage.out, isLdirNow.a);
  wire(parent, dec.z[0]!, isLdirNow.b);
  tieToLabel('IS_LDIR_NOW', isLdirNow.out, { x: pos.x + 9150, y: pos.y - 6240 }); // anchor — isRepeatVariantNow just below reads this
  const isLddrNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6210 });
  const isLddrStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6210 });
  wire(parent, isEdX2Active.out, isLddrStage.a);
  wire(parent, dec.y[7]!, isLddrStage.b);
  wire(parent, isLddrStage.out, isLddrNow.a);
  wire(parent, dec.z[0]!, isLddrNow.b);
  tieToLabel('IS_LDDR_NOW', isLddrNow.out, { x: pos.x + 9150, y: pos.y - 6210 }); // anchor — directionIsDecNow and isRepeatVariantNow just below both read this

  // `isLdBlockNow`: any of the four — the shared condition every phase
  // gate, the holding register, the address mux, and the F-register layer
  // below all actually read (never any one of the four `is*Now` gates
  // above directly, the same "the four base group gates are what
  // everything downstream reads, not the raw `dec.x[N]` each is built
  // from" discipline this file established for `isX0Group`/etc.).
  const isLdBlockStage = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6350 });
  wire(parent, isLdiNow.out, isLdBlockStage.a);
  wire(parent, isLddNow.out, isLdBlockStage.b);
  const isLdBlockStage2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6380 });
  wire(parent, isLdirNow.out, isLdBlockStage2.a);
  wire(parent, isLddrNow.out, isLdBlockStage2.b);
  const isLdBlockNow = buildOr(parent, { x: pos.x + 9200, y: pos.y - 6365 });
  wire(parent, isLdBlockStage.out, isLdBlockNow.a);
  wire(parent, isLdBlockStage2.out, isLdBlockNow.b);
  tieToLabel('IS_LDBLOCK_NOW', isLdBlockNow.out, { x: pos.x + 9250, y: pos.y - 6365 }); // anchor — phase decode just below, RAM's own oe/we/address mux, the F-register layer, and BC's own pair adder (all far) read this

  // `directionIsDecNow`: `LDD`/`LDDR` want `HL--`/`DE--` instead of the
  // family's own default `++` — `DE`/`HL`'s own pair adders (see "x=00,
  // z=3: INC rr/DEC rr" above) already compute `+1` whenever their own
  // `DEC DE`/`DEC HL` line (`dec.y[3]`/`[5]`) reads `0`, which it always
  // does while `ir` holds any of this family's own recaptured `y=4..7` —
  // so only the *decrementing* half needs a widened direction line,
  // `LDI`/`LDIR` get their `+1` for free exactly the way plain `LDI`
  // always did.
  const directionIsDecNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6410 });
  wire(parent, isLddNow.out, directionIsDecNow.a);
  wire(parent, isLddrNow.out, directionIsDecNow.b);
  tieToLabel('LDBLOCK_DEC_DIR_NOW', directionIsDecNow.out, { x: pos.x + 9250, y: pos.y - 6410 }); // anchor — DE's and HL's own pair adder direction lines (far) read this

  // `isRepeatVariantNow`: `LDIR`/`LDDR` only — combined with `P/V`'s own
  // fresh `BC-1 != 0` value at the `pc` mux chain's own final layer, far
  // below, to decide whether this instruction lands back on its own
  // opcode instead of advancing.
  const isRepeatVariantNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6440 });
  wire(parent, isLdirNow.out, isRepeatVariantNow.a);
  wire(parent, isLddrNow.out, isRepeatVariantNow.b);
  tieToLabel('LDBLOCK_REPEAT_VARIANT_NOW', isRepeatVariantNow.out, { x: pos.x + 9250, y: pos.y - 6440 }); // anchor — the pc mux chain's own final layer (far) reads this

  // Phases: `PHASE4` reads `(HL)` into a holding register, `PHASE5` writes
  // it to `(DE)`, `PHASE6` commits `HL++`/`DE++`/`BC--`/flags (and, for
  // `LDIR`/`LDDR`, whether `PC` repeats) — three phases, not the two a
  // plain byte-move might suggest, specifically so the register commit
  // lands on a *separate* edge from both RAM phases: `HL`/`DE` still hold
  // their *old* values through the read and the write (their own pair
  // adders compute the fresh `+1`/`-1` from those old values the whole
  // time), so the address mux never needs an `EX (SP),HL`-style "old
  // value" holding register of its own — the commit simply hasn't
  // happened yet when either address is read. `PHASE2`/`PHASE3` are
  // already spent on the prefix byte's own recapture and extra `pc`
  // advance (see the prefix mechanism's own doc comment above) — this
  // opcode's own work starts one phase later than an unprefixed
  // instruction's equivalent would, the same one-phase shift every
  // prefixed instruction pays.
  const ldBlockReadNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6280 });
  wire(parent, isLdBlockNow.out, ldBlockReadNow.a);
  tieToLabel('PHASE4', ldBlockReadNow.b, { x: pos.x + 9100, y: pos.y - 6280 });
  tieToLabel('LDBLOCK_READ_NOW', ldBlockReadNow.out, { x: pos.x + 9300, y: pos.y - 6280 }); // anchor — ramOeFinal, RAM's own address mux, and ldBlockTemp's own we (all far) read this
  // The identical adjacent-ring-position bus-fight guard `EX (SP),HL`'s
  // own multi-phase sequence above already established, applied here too
  // rather than found live a fourth time.
  const ldBlockWriteRaw = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6230 });
  wire(parent, isLdBlockNow.out, ldBlockWriteRaw.a);
  tieToLabel('PHASE5', ldBlockWriteRaw.b, { x: pos.x + 9100, y: pos.y - 6230 });
  const notLdBlockReadNow = buildNot(parent, { x: pos.x + 9250, y: pos.y - 6255 });
  wire(parent, ldBlockReadNow.out, notLdBlockReadNow.in);
  const ldBlockWriteNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6230 });
  wire(parent, ldBlockWriteRaw.out, ldBlockWriteNow.a);
  wire(parent, notLdBlockReadNow.out, ldBlockWriteNow.b);
  tieToLabel('LDBLOCK_WRITE_NOW', ldBlockWriteNow.out, { x: pos.x + 9350, y: pos.y - 6230 }); // anchor — ramWeFinal, RAM's own address mux, and ldBlockTemp's own bus-driver bank (all far) read this
  const ldBlockCommitRaw = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6180 });
  wire(parent, isLdBlockNow.out, ldBlockCommitRaw.a);
  tieToLabel('PHASE6', ldBlockCommitRaw.b, { x: pos.x + 9100, y: pos.y - 6180 });
  const notLdBlockWriteNow = buildNot(parent, { x: pos.x + 9250, y: pos.y - 6205 });
  wire(parent, ldBlockWriteNow.out, notLdBlockWriteNow.in);
  const ldBlockCommitNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6180 });
  wire(parent, ldBlockCommitRaw.out, ldBlockCommitNow.a);
  wire(parent, notLdBlockWriteNow.out, ldBlockCommitNow.b);
  tieToLabel('LDBLOCK_COMMIT_NOW', ldBlockCommitNow.out, { x: pos.x + 9350, y: pos.y - 6180 }); // anchor — B/C/D/E/H/L's own write-back layers and F's own we/per-bit layer (all far) read this

  // x=10, z=1: CPI/CPD/CPIR/CPDR — see "x=10, z=1: CPI/CPD/CPIR/CPDR"
  // above. Real `x=10,y=4..7,z=1` collides with the plain unprefixed
  // table's own `AND C`/`XOR C`/`OR C`/`CP C` — the identical "recaptured
  // byte reads as a real opcode" collision the `LDI` family above already
  // established, just against `z=1`'s own register (`C`) instead of
  // `z=0`'s (`B`). Unlike that family, this one actively needs a
  // subtractor — rather than chase four *different* wrong op-selects
  // through the shared `x=10` ALU's own machinery (a different real op
  // collides for each of the four variants here), it gets its own,
  // entirely separate from that ALU — see the dedicated adder further
  // below for why that's the cheaper, safer choice.
  const isCpiNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6480 });
  const isCpiStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6480 });
  wire(parent, isEdX2Active.out, isCpiStage.a);
  wire(parent, dec.y[4]!, isCpiStage.b);
  wire(parent, isCpiStage.out, isCpiNow.a);
  wire(parent, dec.z[1]!, isCpiNow.b);
  tieToLabel('IS_CPI_NOW', isCpiNow.out, { x: pos.x + 9150, y: pos.y - 6480 }); // anchor — isCpBlockNow just below reads this
  const isCpdNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6510 });
  const isCpdStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6510 });
  wire(parent, isEdX2Active.out, isCpdStage.a);
  wire(parent, dec.y[5]!, isCpdStage.b);
  wire(parent, isCpdStage.out, isCpdNow.a);
  wire(parent, dec.z[1]!, isCpdNow.b);
  tieToLabel('IS_CPD_NOW', isCpdNow.out, { x: pos.x + 9150, y: pos.y - 6510 });
  const isCpirNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6540 });
  const isCpirStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6540 });
  wire(parent, isEdX2Active.out, isCpirStage.a);
  wire(parent, dec.y[6]!, isCpirStage.b);
  wire(parent, isCpirStage.out, isCpirNow.a);
  wire(parent, dec.z[1]!, isCpirNow.b);
  tieToLabel('IS_CPIR_NOW', isCpirNow.out, { x: pos.x + 9150, y: pos.y - 6540 }); // anchor — cpRepeatVariantNow just below reads this
  const isCpdrNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6570 });
  const isCpdrStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6570 });
  wire(parent, isEdX2Active.out, isCpdrStage.a);
  wire(parent, dec.y[7]!, isCpdrStage.b);
  wire(parent, isCpdrStage.out, isCpdrNow.a);
  wire(parent, dec.z[1]!, isCpdrNow.b);
  tieToLabel('IS_CPDR_NOW', isCpdrNow.out, { x: pos.x + 9150, y: pos.y - 6570 }); // anchor — cpDirectionIsDecNow and cpRepeatVariantNow just below both read this

  const isCpBlockStage = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6600 });
  wire(parent, isCpiNow.out, isCpBlockStage.a);
  wire(parent, isCpdNow.out, isCpBlockStage.b);
  const isCpBlockStage2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6620 });
  wire(parent, isCpirNow.out, isCpBlockStage2.a);
  wire(parent, isCpdrNow.out, isCpBlockStage2.b);
  const isCpBlockNow = buildOr(parent, { x: pos.x + 9200, y: pos.y - 6610 });
  wire(parent, isCpBlockStage.out, isCpBlockNow.a);
  wire(parent, isCpBlockStage2.out, isCpBlockNow.b);
  tieToLabel('IS_CPBLOCK_NOW', isCpBlockNow.out, { x: pos.x + 9250, y: pos.y - 6610 }); // anchor — phase decode just below, RAM's own oe/address mux, BC/HL's own pair-adder direction+commit, and the F-register layer (all far) read this

  // `cpDirectionIsDecNow`: `CPD`/`CPDR` want `HL--` instead of the
  // family's own default `++` — `HL`'s own pair adder already computes
  // `+1` whenever its own `DEC HL` line (`dec.y[5]`) reads `0`, which it
  // always does while `ir` holds any of this family's own recaptured
  // `y=4..7`, so only the *decrementing* half needs a widened direction
  // line. `DE` is never touched by this family at all — real `CPI` and
  // friends only ever move `HL`.
  const cpDirectionIsDecNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6650 });
  wire(parent, isCpdNow.out, cpDirectionIsDecNow.a);
  wire(parent, isCpdrNow.out, cpDirectionIsDecNow.b);
  tieToLabel('CPBLOCK_DEC_DIR_NOW', cpDirectionIsDecNow.out, { x: pos.x + 9250, y: pos.y - 6650 }); // anchor — HL's own pair adder direction line (far) reads this

  // `cpRepeatVariantNow`: `CPIR`/`CPDR` only — combined with `BC`'s own
  // fresh nonzero bit *and* this pass's own fresh "not equal" result, far
  // below, to decide whether this instruction lands back on its own
  // opcode instead of advancing. Real Z80 stops repeating the moment
  // *either* condition fails — `BC` reaching `0`, or a match actually
  // found — unlike `LDIR`/`LDDR`, which only ever watches `BC`.
  const cpRepeatVariantNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6680 });
  wire(parent, isCpirNow.out, cpRepeatVariantNow.a);
  wire(parent, isCpdrNow.out, cpRepeatVariantNow.b);
  tieToLabel('CPBLOCK_REPEAT_VARIANT_NOW', cpRepeatVariantNow.out, { x: pos.x + 9250, y: pos.y - 6680 }); // anchor — the CP-block repeat gate (far, built alongside the dedicated adder) reads this

  // Two phases, not three: `PHASE4` reads `(HL)` into a holding register,
  // `PHASE5` both computes `A - held` (the dedicated adder below) and
  // commits `HL+-1`/`BC--`/flags in the same phase — real Z80's own
  // timing for this family is two machine cycles, one shorter than
  // `LDI`'s three, and this matches that directly rather than padding in
  // an unused phase: there's no RAM *write* here for a commit to wait
  // out, so nothing this family owns ever drives the bus back out, and
  // the adjacent-phase bus-fight guard `LDBLOCK_WRITE_NOW` needs above
  // has nothing to guard here.
  const cpBlockReadNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6460 });
  wire(parent, isCpBlockNow.out, cpBlockReadNow.a);
  tieToLabel('PHASE4', cpBlockReadNow.b, { x: pos.x + 9100, y: pos.y - 6460 });
  tieToLabel('CPBLOCK_READ_NOW', cpBlockReadNow.out, { x: pos.x + 9300, y: pos.y - 6460 }); // anchor — ramOeFinal, RAM's own address mux, and cpBlockTemp's own we (all far) read this
  const cpBlockCommitNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6430 });
  wire(parent, isCpBlockNow.out, cpBlockCommitNow.a);
  tieToLabel('PHASE5', cpBlockCommitNow.b, { x: pos.x + 9100, y: pos.y - 6430 });
  tieToLabel('CPBLOCK_COMMIT_NOW', cpBlockCommitNow.out, { x: pos.x + 9300, y: pos.y - 6430 }); // anchor — B/C/H/L's own write-back layers, F's own we/per-bit layer, and the repeat gate (all far) read this

  // x=10, z=2: INI/IND/INIR/INDR — the third `ED`-table column, real
  // Z80's `(HL)<-IN(C)`: a byte read from this project's own invented I/O
  // port (see "x=11: IN A,(n) / OUT (n),A" below), addressed by `C` (not
  // the immediate byte `n` that family reads), written into `(HL)`, then
  // `HL+-1`, `B--`. Collides with real unprefixed `AND D`/`XOR D`/`OR D`/
  // `CP D` (`z=2` — `D`, not `B`/`C` this time), the identical
  // "recaptured byte reads as a real opcode" shape the other two
  // `ED`-table families above already establish. Real Z80 documents
  // exactly two flag bits for this whole family — see the F-register
  // layer, far below.
  const isIniNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6710 });
  const isIniStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6710 });
  wire(parent, isEdX2Active.out, isIniStage.a);
  wire(parent, dec.y[4]!, isIniStage.b);
  wire(parent, isIniStage.out, isIniNow.a);
  wire(parent, dec.z[2]!, isIniNow.b);
  tieToLabel('IS_INI_NOW', isIniNow.out, { x: pos.x + 9150, y: pos.y - 6710 });
  const isIndNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6740 });
  const isIndStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6740 });
  wire(parent, isEdX2Active.out, isIndStage.a);
  wire(parent, dec.y[5]!, isIndStage.b);
  wire(parent, isIndStage.out, isIndNow.a);
  wire(parent, dec.z[2]!, isIndNow.b);
  tieToLabel('IS_IND_NOW', isIndNow.out, { x: pos.x + 9150, y: pos.y - 6740 });
  const isInirNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6770 });
  const isInirStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6770 });
  wire(parent, isEdX2Active.out, isInirStage.a);
  wire(parent, dec.y[6]!, isInirStage.b);
  wire(parent, isInirStage.out, isInirNow.a);
  wire(parent, dec.z[2]!, isInirNow.b);
  tieToLabel('IS_INIR_NOW', isInirNow.out, { x: pos.x + 9150, y: pos.y - 6770 }); // anchor — inRepeatVariantNow just below reads this
  const isIndrNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6800 });
  const isIndrStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6800 });
  wire(parent, isEdX2Active.out, isIndrStage.a);
  wire(parent, dec.y[7]!, isIndrStage.b);
  wire(parent, isIndrStage.out, isIndrNow.a);
  wire(parent, dec.z[2]!, isIndrNow.b);
  tieToLabel('IS_INDR_NOW', isIndrNow.out, { x: pos.x + 9150, y: pos.y - 6800 }); // anchor — inDirectionIsDecNow and inRepeatVariantNow just below both read this

  const isInBlockStage = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6820 });
  wire(parent, isIniNow.out, isInBlockStage.a);
  wire(parent, isIndNow.out, isInBlockStage.b);
  const isInBlockStage2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6840 });
  wire(parent, isInirNow.out, isInBlockStage2.a);
  wire(parent, isIndrNow.out, isInBlockStage2.b);
  const isInBlockNow = buildOr(parent, { x: pos.x + 9200, y: pos.y - 6830 });
  wire(parent, isInBlockStage.out, isInBlockNow.a);
  wire(parent, isInBlockStage2.out, isInBlockNow.b);
  tieToLabel('IS_INBLOCK_NOW', isInBlockNow.out, { x: pos.x + 9250, y: pos.y - 6830 }); // anchor — phase decode just below and HL's own pair-adder direction line (far) read this

  // `inDirectionIsDecNow`: `IND`/`INDR` want `HL--` instead of the
  // family's own default `++` — the identical "only the decrementing half
  // needs a widened direction line" shape `LDD`/`LDDR`'s own
  // `directionIsDecNow` already establishes for `HL`'s own pair adder.
  const inDirectionIsDecNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6860 });
  wire(parent, isIndNow.out, inDirectionIsDecNow.a);
  wire(parent, isIndrNow.out, inDirectionIsDecNow.b);
  tieToLabel('INBLOCK_DEC_DIR_NOW', inDirectionIsDecNow.out, { x: pos.x + 9250, y: pos.y - 6860 }); // anchor — HL's own pair adder direction line (far) reads this

  // `inRepeatVariantNow`: `INIR`/`INDR` only — combined with `B`'s own
  // dedicated adder reaching nonzero, far below, to decide whether this
  // instruction lands back on its own opcode instead of advancing. Only
  // one condition to watch, unlike `CPIR`/`CPDR`'s own two — real Z80
  // stops this family purely on `B` reaching `0`, there's no "found it"
  // concept here at all.
  const inRepeatVariantNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 6890 });
  wire(parent, isInirNow.out, inRepeatVariantNow.a);
  wire(parent, isIndrNow.out, inRepeatVariantNow.b);
  tieToLabel('INBLOCK_REPEAT_VARIANT_NOW', inRepeatVariantNow.out, { x: pos.x + 9250, y: pos.y - 6890 }); // anchor — the pc mux chain's own final layer (far) reads this

  // Three phases, the identical shape `LDI`'s own family uses: `PHASE4`
  // publishes `C` onto the bus (this instruction's own `ioPortAddr`,
  // and its own `ioRead` strobe — see the I/O port's own doc comment
  // below), `PHASE5` publishes whatever the external device drove onto
  // `ioPortDataIn` in response back onto the bus for RAM's own write,
  // `PHASE6` commits `HL+-1`/`B--`/flags. RAM's own `oe` is deliberately
  // never widened for `PHASE4` — nothing needs RAM to drive the bus that
  // phase, `C`'s own tri-buf bank (far below) does instead, and letting
  // RAM's `oe` fire too would fight it for the same wire.
  const inBlockReadNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6700 });
  wire(parent, isInBlockNow.out, inBlockReadNow.a);
  tieToLabel('PHASE4', inBlockReadNow.b, { x: pos.x + 9100, y: pos.y - 6700 });
  tieToLabel('INBLOCK_READ_NOW', inBlockReadNow.out, { x: pos.x + 9300, y: pos.y - 6700 }); // anchor — C's own bus-driver bank, ioRead, and RAM's own address mux (all far) read this
  const inBlockWriteRaw = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6670 });
  wire(parent, isInBlockNow.out, inBlockWriteRaw.a);
  tieToLabel('PHASE5', inBlockWriteRaw.b, { x: pos.x + 9100, y: pos.y - 6670 });
  const notInBlockReadNow = buildNot(parent, { x: pos.x + 9250, y: pos.y - 6685 });
  wire(parent, inBlockReadNow.out, notInBlockReadNow.in);
  const inBlockWriteNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6670 });
  wire(parent, inBlockWriteRaw.out, inBlockWriteNow.a);
  wire(parent, notInBlockReadNow.out, inBlockWriteNow.b);
  tieToLabel('INBLOCK_WRITE_NOW', inBlockWriteNow.out, { x: pos.x + 9350, y: pos.y - 6670 }); // anchor — ioPortDataIn's own bus-driver bank, ramWeFinal, and RAM's own address mux (all far) read this
  const inBlockCommitRaw = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6640 });
  wire(parent, isInBlockNow.out, inBlockCommitRaw.a);
  tieToLabel('PHASE6', inBlockCommitRaw.b, { x: pos.x + 9100, y: pos.y - 6640 });
  const notInBlockWriteNow = buildNot(parent, { x: pos.x + 9250, y: pos.y - 6655 });
  wire(parent, inBlockWriteNow.out, notInBlockWriteNow.in);
  const inBlockCommitNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6640 });
  wire(parent, inBlockCommitRaw.out, inBlockCommitNow.a);
  wire(parent, notInBlockWriteNow.out, inBlockCommitNow.b);
  tieToLabel('INBLOCK_COMMIT_NOW', inBlockCommitNow.out, { x: pos.x + 9350, y: pos.y - 6640 }); // anchor — B's and HL's own write-back layers, F's own we/per-bit layer (all far) read this

  // x=10, z=3: OUTI/OUTD/OTIR/OTDR — the fourth and final `ED`-table
  // column this retrofit fills in, real Z80's `OUT(C)<-(HL)`: the exact
  // mirror image of `INI`'s own family — a byte read from `(HL)` this
  // time, written to this project's own invented I/O port, addressed by
  // `C` the identical way. `HL+-1`, `B--` (never `BC`, same reasoning as
  // `INI`'s own family). Collides with real unprefixed `AND E`/`XOR E`/
  // `OR E`/`CP E` (`z=3` — `E`, not `D`/`B`/`C` this time). `B`'s own
  // dedicated `-1` adder (`ioBAdder`, above) and its own nonzero/zero
  // bits (`IOB_NONZERO_NOW`/`IOB_Z_NOW`) are genuinely shared with `INI`'s
  // own family here — decrementing `B` is the identical operation
  // regardless of which direction the port transfer runs, so nothing new
  // is built for it, only new consumers of what already exists.
  const isOutiNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6920 });
  const isOutiStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6920 });
  wire(parent, isEdX2Active.out, isOutiStage.a);
  wire(parent, dec.y[4]!, isOutiStage.b);
  wire(parent, isOutiStage.out, isOutiNow.a);
  wire(parent, dec.z[3]!, isOutiNow.b);
  tieToLabel('IS_OUTI_NOW', isOutiNow.out, { x: pos.x + 9150, y: pos.y - 6920 });
  const isOutdNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6950 });
  const isOutdStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6950 });
  wire(parent, isEdX2Active.out, isOutdStage.a);
  wire(parent, dec.y[5]!, isOutdStage.b);
  wire(parent, isOutdStage.out, isOutdNow.a);
  wire(parent, dec.z[3]!, isOutdNow.b);
  tieToLabel('IS_OUTD_NOW', isOutdNow.out, { x: pos.x + 9150, y: pos.y - 6950 });
  const isOtirNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 6980 });
  const isOtirStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 6980 });
  wire(parent, isEdX2Active.out, isOtirStage.a);
  wire(parent, dec.y[6]!, isOtirStage.b);
  wire(parent, isOtirStage.out, isOtirNow.a);
  wire(parent, dec.z[3]!, isOtirNow.b);
  tieToLabel('IS_OTIR_NOW', isOtirNow.out, { x: pos.x + 9150, y: pos.y - 6980 }); // anchor — outRepeatVariantNow just below reads this
  const isOtdrNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 7010 });
  const isOtdrStage = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 7010 });
  wire(parent, isEdX2Active.out, isOtdrStage.a);
  wire(parent, dec.y[7]!, isOtdrStage.b);
  wire(parent, isOtdrStage.out, isOtdrNow.a);
  wire(parent, dec.z[3]!, isOtdrNow.b);
  tieToLabel('IS_OTDR_NOW', isOtdrNow.out, { x: pos.x + 9150, y: pos.y - 7010 }); // anchor — outDirectionIsDecNow and outRepeatVariantNow just below both read this

  const isOutBlockStage = buildOr(parent, { x: pos.x + 9150, y: pos.y - 7030 });
  wire(parent, isOutiNow.out, isOutBlockStage.a);
  wire(parent, isOutdNow.out, isOutBlockStage.b);
  const isOutBlockStage2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 7050 });
  wire(parent, isOtirNow.out, isOutBlockStage2.a);
  wire(parent, isOtdrNow.out, isOutBlockStage2.b);
  const isOutBlockNow = buildOr(parent, { x: pos.x + 9200, y: pos.y - 7040 });
  wire(parent, isOutBlockStage.out, isOutBlockNow.a);
  wire(parent, isOutBlockStage2.out, isOutBlockNow.b);
  tieToLabel('IS_OUTBLOCK_NOW', isOutBlockNow.out, { x: pos.x + 9250, y: pos.y - 7040 }); // anchor — phase decode just below and HL's own pair-adder direction line (far) read this

  // `outDirectionIsDecNow`: `OUTD`/`OTDR` want `HL--` instead of the
  // family's own default `++` — the identical shape `IND`/`INDR`'s own
  // `inDirectionIsDecNow` already establishes.
  const outDirectionIsDecNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 7070 });
  wire(parent, isOutdNow.out, outDirectionIsDecNow.a);
  wire(parent, isOtdrNow.out, outDirectionIsDecNow.b);
  tieToLabel('OUTBLOCK_DEC_DIR_NOW', outDirectionIsDecNow.out, { x: pos.x + 9250, y: pos.y - 7070 }); // anchor — HL's own pair adder direction line (far) reads this

  // `outRepeatVariantNow`: `OTIR`/`OTDR` only — combined with `B`'s own
  // shared nonzero bit, far below, the identical shape `INIR`/`INDR`'s
  // own `inRepeatVariantNow` already establishes, just gated by this
  // family's own `y`/`z` decode instead.
  const outRepeatVariantNow = buildOr(parent, { x: pos.x + 9150, y: pos.y - 7090 });
  wire(parent, isOtirNow.out, outRepeatVariantNow.a);
  wire(parent, isOtdrNow.out, outRepeatVariantNow.b);
  tieToLabel('OUTBLOCK_REPEAT_VARIANT_NOW', outRepeatVariantNow.out, { x: pos.x + 9250, y: pos.y - 7090 }); // anchor — the pc mux chain's own final layer (far) reads this

  // Three phases, mirroring `INI`'s own family exactly but in the
  // opposite direction: `PHASE4` reads `(HL)` into a holding register
  // (`outBlockTemp`, below — RAM's own `oe` and address mux both widen
  // for this phase, the same "RAM drives the bus" shape every earlier
  // RAM-reading feature in this file already uses), `PHASE5` publishes
  // `C` onto the bus (widening the *same* tri-state bank `INI`'s own
  // family already built for exactly this purpose — the two phases can
  // never collide, `isInBlockNow`/`isOutBlockNow` mutually exclusive by
  // `dec.z`) and `outBlockTemp`'s own held byte onto `ioPortDataOut`
  // directly (a mux ahead of `OUT (n),A`'s own `AOLD` source, far below —
  // not through the CPU's main bus at all, since `ioPortDataOut` was
  // never a bus tap to begin with), strobing `ioWrite`. `PHASE6` commits
  // `HL+-1`/`B--`/flags.
  const outBlockReadNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6910 });
  wire(parent, isOutBlockNow.out, outBlockReadNow.a);
  tieToLabel('PHASE4', outBlockReadNow.b, { x: pos.x + 9100, y: pos.y - 6910 });
  tieToLabel('OUTBLOCK_READ_NOW', outBlockReadNow.out, { x: pos.x + 9300, y: pos.y - 6910 }); // anchor — ramOeFinal, RAM's own address mux, and outBlockTemp's own we (all far) read this
  const outBlockWriteRaw = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6880 });
  wire(parent, isOutBlockNow.out, outBlockWriteRaw.a);
  tieToLabel('PHASE5', outBlockWriteRaw.b, { x: pos.x + 9100, y: pos.y - 6880 });
  const notOutBlockReadNow = buildNot(parent, { x: pos.x + 9250, y: pos.y - 6895 });
  wire(parent, outBlockReadNow.out, notOutBlockReadNow.in);
  const outBlockWriteNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6880 });
  wire(parent, outBlockWriteRaw.out, outBlockWriteNow.a);
  wire(parent, notOutBlockReadNow.out, outBlockWriteNow.b);
  tieToLabel('OUTBLOCK_WRITE_NOW', outBlockWriteNow.out, { x: pos.x + 9350, y: pos.y - 6880 }); // anchor — C's own bus-driver bank, ioPortDataOut's own mux, and ioWrite (all far) read this
  const outBlockCommitRaw = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 6850 });
  wire(parent, isOutBlockNow.out, outBlockCommitRaw.a);
  tieToLabel('PHASE6', outBlockCommitRaw.b, { x: pos.x + 9100, y: pos.y - 6850 });
  const notOutBlockWriteNow = buildNot(parent, { x: pos.x + 9250, y: pos.y - 6865 });
  wire(parent, outBlockWriteNow.out, notOutBlockWriteNow.in);
  const outBlockCommitNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 6850 });
  wire(parent, outBlockCommitRaw.out, outBlockCommitNow.a);
  wire(parent, notOutBlockWriteNow.out, outBlockCommitNow.b);
  tieToLabel('OUTBLOCK_COMMIT_NOW', outBlockCommitNow.out, { x: pos.x + 9350, y: pos.y - 6850 }); // anchor — B's and HL's own write-back layers, F's own we/per-bit layer (all far) read this

  // A holding register for the byte in flight — `(HL)`'s own value has
  // to survive from `OUTBLOCK_READ_NOW` (this tick's read) to
  // `OUTBLOCK_WRITE_NOW` (the *next* tick's publish to the port), the
  // identical "a value must outlive its own bus's next user" reasoning
  // every other holding register in this file already relies on. Built
  // here rather than alongside `ldBlockTemp`/`cpBlockTemp` (both much
  // further down) specifically so it exists as a plain JS reference by
  // the time `ioPortDataOut`'s own mux and `N`'s own flag source (both
  // also far below) need to read it directly, without a forward
  // reference through a label.
  const outBlockTemp = buildRegister(parent, library, 8, { x: pos.x + 9450, y: pos.y - 6900 });
  tieToLabel('OUTBLOCK_READ_NOW', outBlockTemp.we, { x: pos.x + 9350, y: pos.y - 6900 });
  outBlockTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x + 9400, y: pos.y - 6900 + i * 20 }));
  tieToLabel('CLK', outBlockTemp.clk, { x: pos.x + 9450, y: pos.y - 6920 });

  // x=01, z=4: NEG (real 0xED 0x44) — the first non-block `ED`-table
  // opcode this retrofit adds: `A<-0-A`, real two's-complement negation,
  // every flag bit fresh (unlike the block families above, nothing here
  // is left stale or unmodeled — real Z80 documents this instruction's
  // flags completely). Collides with real unprefixed `LD B,H` (`x=01`
  // is the entire `LD r,r'` table, `y=0` picking `B` as the destination,
  // `z=4` picking `H` as the source) — but unlike every earlier
  // collision in this file, `y` is deliberately *not* read at all: real
  // hardware executes `NEG` for *every* value of `y` in this column
  // (`0xED 0x44`, `0x4C`, `0x54`, ... all the way to `0x7C`), a real,
  // well-documented "undocumented duplicate" quirk, not a gap — so
  // `isNegNow` reads `isEdX1Active`/`dec.z[4]` only, deliberately
  // widening past `dec.y[0]` alone.
  const isNegNow = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 7130 });
  wire(parent, isEdX1Active.out, isNegNow.a);
  wire(parent, dec.z[4]!, isNegNow.b);
  tieToLabel('IS_NEG_NOW', isNegNow.out, { x: pos.x + 9150, y: pos.y - 7130 });
  // One phase, the first available one for any `ED`-prefixed opcode
  // (`PHASE2`/`PHASE3` already spent recapturing `ir` and advancing `pc`
  // — see the prefix mechanism's own doc comment above) — real `NEG`
  // commits everything (`A`, every flag bit) on this single edge, no
  // holding register or multi-phase sequencing needed at all.
  const negNow = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 7150 });
  wire(parent, isNegNow.out, negNow.a);
  tieToLabel('PHASE4', negNow.b, { x: pos.x + 9050, y: pos.y - 7150 });
  tieToLabel('NEG_NOW', negNow.out, { x: pos.x + 9250, y: pos.y - 7150 }); // anchor — A's own write mux and F's own we/per-bit layer (all far) read this

  // A dedicated `0-A` adder — the identical "isolated adder, no
  // shared-decode collision to fight" shape `cpBlockAdder`/`ioBAdder`
  // above already use, here because `alu`'s own `a` input is hardwired
  // to `A` itself (see "x=10: ADC/SBC" above) and can never be forced to
  // a constant `0` the way this instruction needs. `0-A` in two's
  // complement is `~A+1` — `a` fanned to `gnd`, `b` inverted per bit,
  // `cin` forced to `1`, the identical recipe the shared ALU's own `SUB`
  // path uses, just with a genuine `0` for the left operand instead of a
  // register.
  const negAdder = buildAlu(parent, library, 8, { x: pos.x + 9300, y: pos.y - 7300 });
  tiePowerRail(parent, 'GND', negAdder.op0);
  tiePowerRail(parent, 'GND', negAdder.op1);
  tiePowerRail(parent, 'VCC', negAdder.cin);
  for (let i = 0; i < 8; i++) {
    tiePowerRail(parent, 'GND', negAdder.a[i]!);
    const negBInv = buildNot(parent, { x: pos.x + 9250, y: pos.y - 7300 + i * 20 });
    wire(parent, a.q[i]!, negBInv.in);
    wire(parent, negBInv.out, negAdder.b[i]!);
  }
  const negSBit = negAdder.out[7]!;
  const negXBit = negAdder.out[3]!;
  const negYBit = negAdder.out[5]!;
  let negZChain: Pin = negAdder.out[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 9350, y: pos.y - 7150 + i * 20 });
    wire(parent, negZChain, orGate.a);
    wire(parent, negAdder.out[i]!, orGate.b);
    negZChain = orGate.out;
  }
  const negZBit = buildNot(parent, { x: pos.x + 9400, y: pos.y - 7130 });
  wire(parent, negZChain, negZBit.in);
  // H: the identical `NOT(carries[3])` half-borrow idiom `cpBlockAdder`'s
  // own `cpHBit` already establishes — this adder never computes
  // anything but a subtract either.
  const negHBit = buildNot(parent, { x: pos.x + 9400, y: pos.y - 7110 });
  wire(parent, negAdder.carries[3]!, negHBit.in);
  // P/V: real Z80 sets this for `NEG` on overflow alone (`A` was `0x80`,
  // the one value whose negation doesn't fit back into a signed byte) —
  // the identical `XOR(carries[6], carries[7])` overflow idiom the
  // shared ALU's own `pvOverflow` already establishes.
  const negPvBit = buildXor(parent, { x: pos.x + 9400, y: pos.y - 7090 });
  wire(parent, negAdder.carries[6]!, negPvBit.a);
  wire(parent, negAdder.carries[7]!, negPvBit.b);
  // C: real Z80 sets this whenever `A` was nonzero before the operation
  // (negating `0` borrows nothing) — a fresh 8-way OR-tree over `A`'s
  // own current bits, the identical "any bit set" idiom this file's own
  // nonzero checks already use elsewhere, just over `A` instead of `BC`
  // or `B`.
  let negCChain: Pin = a.q[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 9450, y: pos.y - 7150 + i * 20 });
    wire(parent, negCChain, orGate.a);
    wire(parent, a.q[i]!, orGate.b);
    negCChain = orGate.out;
  }
  const negCBit = negCChain;

  // x=01, z=7, y=0..3: LD I,A / LD R,A / LD A,I / LD A,R (real 0xED
  // 0x47/0x4F/0x57/0x5F). Collides with unprefixed `LD y,A`
  // (`z=7`) the same way RRD/RLD (y=4/5) does. Single PHASE4 after the
  // ED prefix: copy A→I/R, or I/R→A with S/Z/H=0/N=0/P/V←IFF2 (soft parity)
  // / X/Y from the transferred byte; C held.
  const isLdIA = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5680 });
  const isLdIAStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5680 });
  wire(parent, isEdX1Active.out, isLdIAStage.a);
  wire(parent, dec.y[0]!, isLdIAStage.b);
  wire(parent, isLdIAStage.out, isLdIA.a);
  wire(parent, dec.z[7]!, isLdIA.b);
  tieToLabel('IS_LDIA_NOW', isLdIA.out, { x: pos.x - 850, y: pos.y - 5680 });
  const isLdRA = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5700 });
  const isLdRAStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5700 });
  wire(parent, isEdX1Active.out, isLdRAStage.a);
  wire(parent, dec.y[1]!, isLdRAStage.b);
  wire(parent, isLdRAStage.out, isLdRA.a);
  wire(parent, dec.z[7]!, isLdRA.b);
  tieToLabel('IS_LDRA_NOW', isLdRA.out, { x: pos.x - 850, y: pos.y - 5700 });
  const isLdAI = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5720 });
  const isLdAIStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5720 });
  wire(parent, isEdX1Active.out, isLdAIStage.a);
  wire(parent, dec.y[2]!, isLdAIStage.b);
  wire(parent, isLdAIStage.out, isLdAI.a);
  wire(parent, dec.z[7]!, isLdAI.b);
  tieToLabel('IS_LDAI_NOW', isLdAI.out, { x: pos.x - 850, y: pos.y - 5720 });
  const isLdAR = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5740 });
  const isLdARStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5740 });
  wire(parent, isEdX1Active.out, isLdARStage.a);
  wire(parent, dec.y[3]!, isLdARStage.b);
  wire(parent, isLdARStage.out, isLdAR.a);
  wire(parent, dec.z[7]!, isLdAR.b);
  tieToLabel('IS_LDAR_NOW', isLdAR.out, { x: pos.x - 850, y: pos.y - 5740 });

  const ldIANow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5680 });
  wire(parent, isLdIA.out, ldIANow.a);
  tieToLabel('PHASE4', ldIANow.b, { x: pos.x - 950, y: pos.y - 5660 });
  tieToLabel('LDIA_NOW', ldIANow.out, { x: pos.x - 800, y: pos.y - 5680 });
  const ldRANow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5700 });
  wire(parent, isLdRA.out, ldRANow.a);
  tieToLabel('PHASE4', ldRANow.b, { x: pos.x - 950, y: pos.y - 5690 });
  tieToLabel('LDRA_NOW', ldRANow.out, { x: pos.x - 800, y: pos.y - 5700 });
  const ldAINow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5720 });
  wire(parent, isLdAI.out, ldAINow.a);
  tieToLabel('PHASE4', ldAINow.b, { x: pos.x - 950, y: pos.y - 5710 });
  tieToLabel('LDAI_NOW', ldAINow.out, { x: pos.x - 800, y: pos.y - 5720 });
  const ldARNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5740 });
  wire(parent, isLdAR.out, ldARNow.a);
  tieToLabel('PHASE4', ldARNow.b, { x: pos.x - 950, y: pos.y - 5730 });
  tieToLabel('LDAR_NOW', ldARNow.out, { x: pos.x - 800, y: pos.y - 5740 });
  const ldAIrNow = buildOr(parent, { x: pos.x - 750, y: pos.y - 5730 });
  wire(parent, ldAINow.out, ldAIrNow.a);
  wire(parent, ldARNow.out, ldAIrNow.b);
  tieToLabel('LDAIR_NOW', ldAIrNow.out, { x: pos.x - 700, y: pos.y - 5730 }); // anchor — A's we/mux + F we/layer

  // IRQ modes + RETI/RETN: `IM 0/1/2` (ED z=6) and `RETI`/`RETN` (ED z=5).
  // Soft aliases: IM0=46/66, IM1=56/76, IM2=5E/7E; RETN=(op&0xc7)==0x45,
  // RETI=(op&0xc7)==0x4D. Gate documents y=0/2/3 (+ aliases y=4/6/7) and
  // RETN y=0 / RETI y=1. Both RET* commit on PHASE4; RET* reuse RET's
  // stack-pop/PC-capture and IFF1←IFF2.
  const isImZ6 = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5780 });
  wire(parent, isEdX1Active.out, isImZ6.a);
  wire(parent, dec.z[6]!, isImZ6.b);
  const isIm0Y = buildOr(parent, { x: pos.x - 900, y: pos.y - 5760 });
  wire(parent, dec.y[0]!, isIm0Y.a);
  wire(parent, dec.y[4]!, isIm0Y.b);
  const isIm0 = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5760 });
  wire(parent, isImZ6.out, isIm0.a);
  wire(parent, isIm0Y.out, isIm0.b);
  const im0Now = buildAnd(parent, { x: pos.x - 800, y: pos.y - 5760 });
  wire(parent, isIm0.out, im0Now.a);
  tieToLabel('PHASE4', im0Now.b, { x: pos.x - 900, y: pos.y - 5740 });
  tieToLabel('IM0_NOW', im0Now.out, { x: pos.x - 750, y: pos.y - 5760 });
  const isIm1Y = buildOr(parent, { x: pos.x - 900, y: pos.y - 5780 });
  wire(parent, dec.y[2]!, isIm1Y.a);
  wire(parent, dec.y[6]!, isIm1Y.b);
  const isIm1 = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5780 });
  wire(parent, isImZ6.out, isIm1.a);
  wire(parent, isIm1Y.out, isIm1.b);
  const im1Now = buildAnd(parent, { x: pos.x - 800, y: pos.y - 5780 });
  wire(parent, isIm1.out, im1Now.a);
  tieToLabel('PHASE4', im1Now.b, { x: pos.x - 900, y: pos.y - 5760 });
  tieToLabel('IM1_NOW', im1Now.out, { x: pos.x - 750, y: pos.y - 5780 });
  const isIm2Y = buildOr(parent, { x: pos.x - 900, y: pos.y - 5800 });
  wire(parent, dec.y[3]!, isIm2Y.a);
  wire(parent, dec.y[7]!, isIm2Y.b);
  const isIm2 = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5800 });
  wire(parent, isImZ6.out, isIm2.a);
  wire(parent, isIm2Y.out, isIm2.b);
  const im2Now = buildAnd(parent, { x: pos.x - 800, y: pos.y - 5800 });
  wire(parent, isIm2.out, im2Now.a);
  tieToLabel('PHASE4', im2Now.b, { x: pos.x - 900, y: pos.y - 5780 });
  tieToLabel('IM2_NOW', im2Now.out, { x: pos.x - 750, y: pos.y - 5800 });
  const imAnyNow = buildOr(parent, { x: pos.x - 700, y: pos.y - 5770 });
  wire(parent, im0Now.out, imAnyNow.a);
  wire(parent, im1Now.out, imAnyNow.b);
  const imAnyNow2 = buildOr(parent, { x: pos.x - 650, y: pos.y - 5770 });
  wire(parent, imAnyNow.out, imAnyNow2.a);
  wire(parent, im2Now.out, imAnyNow2.b);
  tieToLabel('IM_ANY_NOW', imAnyNow2.out, { x: pos.x - 600, y: pos.y - 5770 }); // mode latch we
  const isReti = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5820 });
  const isRetiStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5820 });
  wire(parent, isEdX1Active.out, isRetiStage.a);
  wire(parent, dec.y[1]!, isRetiStage.b);
  wire(parent, isRetiStage.out, isReti.a);
  wire(parent, dec.z[5]!, isReti.b);
  const retiNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5820 });
  wire(parent, isReti.out, retiNow.a);
  tieToLabel('PHASE4', retiNow.b, { x: pos.x - 950, y: pos.y - 5800 });
  tieToLabel('RETI_NOW', retiNow.out, { x: pos.x - 800, y: pos.y - 5820 });
  const isRetn = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5840 });
  const isRetnStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5840 });
  wire(parent, isEdX1Active.out, isRetnStage.a);
  wire(parent, dec.y[0]!, isRetnStage.b);
  wire(parent, isRetnStage.out, isRetn.a);
  wire(parent, dec.z[5]!, isRetn.b);
  const retnNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5840 });
  wire(parent, isRetn.out, retnNow.a);
  tieToLabel('PHASE4', retnNow.b, { x: pos.x - 950, y: pos.y - 5820 });
  tieToLabel('RETN_NOW', retnNow.out, { x: pos.x - 800, y: pos.y - 5840 });
  const retiOrRetnNow = buildOr(parent, { x: pos.x - 750, y: pos.y - 5830 });
  wire(parent, retiNow.out, retiOrRetnNow.a);
  wire(parent, retnNow.out, retiOrRetnNow.b);
  tieToLabel('RETI_OR_RETN_NOW', retiOrRetnNow.out, { x: pos.x - 700, y: pos.y - 5830 }); // IFF1←IFF2 + pop

  // x=01, z=7, y=4/y=5: RRD/RLD (real 0xED 0x67/0x6F) — a 12-bit BCD
  // nibble rotate spanning `A`'s own low nibble and both of `(HL)`'s,
  // real Z80's own way to shift a packed-BCD digit string one position
  // without touching every byte's own high nibble. Collides with real
  // unprefixed `LD y,A` (`x=01`, `z=7` picks `A` as the source) for
  // every destination `y` picks.
  const isRrdNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5560 });
  const isRrdStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5560 });
  wire(parent, isEdX1Active.out, isRrdStage.a);
  wire(parent, dec.y[4]!, isRrdStage.b);
  wire(parent, isRrdStage.out, isRrdNow.a);
  wire(parent, dec.z[7]!, isRrdNow.b);
  tieToLabel('IS_RRD_NOW', isRrdNow.out, { x: pos.x - 850, y: pos.y - 5560 });
  const isRldNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5580 });
  const isRldStage = buildAnd(parent, { x: pos.x - 950, y: pos.y - 5580 });
  wire(parent, isEdX1Active.out, isRldStage.a);
  wire(parent, dec.y[5]!, isRldStage.b);
  wire(parent, isRldStage.out, isRldNow.a);
  wire(parent, dec.z[7]!, isRldNow.b);
  tieToLabel('IS_RLD_NOW', isRldNow.out, { x: pos.x - 850, y: pos.y - 5580 }); // anchor — the shared nibble muxes and F's own P/V-vs-parity-mux-adjacent layer (all near/far) read this
  const isRrdRldNow = buildOr(parent, { x: pos.x - 800, y: pos.y - 5570 });
  wire(parent, isRrdNow.out, isRrdRldNow.a);
  wire(parent, isRldNow.out, isRrdRldNow.b);
  tieToLabel('IS_RRDRLD_NOW', isRrdRldNow.out, { x: pos.x - 750, y: pos.y - 5570 }); // anchor — phase decode just below, RAM's own oe/we/address mux, A's own write mux, and F's own we/per-bit layer (all far) read this

  // Three phases, the identical shape `LDI`'s own family uses: `PHASE4`
  // reads `(HL)` into a holding register, `PHASE5` writes the freshly
  // rotated byte back to that *same* address (unlike `LDI`'s own family,
  // read and write share one address here, so both phases reuse a
  // single address-mux layer below rather than needing two), `PHASE6`
  // commits `A`'s own low nibble and every flag bit but `C`.
  const rrdRldReadNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5600 });
  wire(parent, isRrdRldNow.out, rrdRldReadNow.a);
  tieToLabel('PHASE4', rrdRldReadNow.b, { x: pos.x - 950, y: pos.y - 5600 });
  tieToLabel('RRDRLD_READ_NOW', rrdRldReadNow.out, { x: pos.x - 800, y: pos.y - 5600 }); // anchor — ramOeFinal, RAM's own address mux, and rrdRldTemp's own we (all far) read this
  const rrdRldWriteRaw = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5620 });
  wire(parent, isRrdRldNow.out, rrdRldWriteRaw.a);
  tieToLabel('PHASE5', rrdRldWriteRaw.b, { x: pos.x - 950, y: pos.y - 5620 });
  const notRrdRldReadNow = buildNot(parent, { x: pos.x - 800, y: pos.y - 5610 });
  wire(parent, rrdRldReadNow.out, notRrdRldReadNow.in);
  const rrdRldWriteNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5620 });
  wire(parent, rrdRldWriteRaw.out, rrdRldWriteNow.a);
  wire(parent, notRrdRldReadNow.out, rrdRldWriteNow.b);
  tieToLabel('RRDRLD_WRITE_NOW', rrdRldWriteNow.out, { x: pos.x - 700, y: pos.y - 5620 }); // anchor — ramWeFinal, RAM's own address mux, and the rotated-byte bus-driver bank (all far) read this
  const rrdRldCommitRaw = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5640 });
  wire(parent, isRrdRldNow.out, rrdRldCommitRaw.a);
  tieToLabel('PHASE6', rrdRldCommitRaw.b, { x: pos.x - 950, y: pos.y - 5640 });
  const notRrdRldWriteNow = buildNot(parent, { x: pos.x - 800, y: pos.y - 5630 });
  wire(parent, rrdRldWriteNow.out, notRrdRldWriteNow.in);
  const rrdRldCommitNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5640 });
  wire(parent, rrdRldCommitRaw.out, rrdRldCommitNow.a);
  wire(parent, notRrdRldWriteNow.out, rrdRldCommitNow.b);
  tieToLabel('RRDRLD_COMMIT_NOW', rrdRldCommitNow.out, { x: pos.x - 700, y: pos.y - 5640 }); // anchor — A's own write mux and F's own we/per-bit layer (all far) read this

  // A holding register for `(HL)`'s own byte in flight — the identical
  // "a value must outlive its own bus's next user" reasoning every
  // other holding register in this file already relies on.
  const rrdRldTemp = buildRegister(parent, library, 8, { x: pos.x - 850, y: pos.y - 5700 });
  tieToLabel('RRDRLD_READ_NOW', rrdRldTemp.we, { x: pos.x - 950, y: pos.y - 5700 });
  rrdRldTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 900, y: pos.y - 5700 + i * 20 }));
  tieToLabel('CLK', rrdRldTemp.clk, { x: pos.x - 850, y: pos.y - 5720 });

  // The rotate itself: a 4-way per-nibble-position mux, `RRD`/`RLD`
  // sharing the same three destinations (new `A` low nibble, new `(HL)`
  // high nibble, new `(HL)` low nibble) but wiring the source for each
  // one differently — `isRldNow` alone as the select is enough, since
  // the two are mutually exclusive by construction (`y=4` vs `y=5`) and
  // `RRD`'s own wiring is exactly "not `RLD`'s."
  const rrdRldNewALow: Pin[] = [];
  const rrdRldNewHlHigh: Pin[] = [];
  const rrdRldNewHlLow: Pin[] = [];
  for (let i = 0; i < 4; i++) {
    const aLowMux = makeChipInstance(parent, muxDef, { x: pos.x - 700, y: pos.y - 5700 + i * 20 });
    wire(parent, isRldNow.out, aLowMux.pins[muxDef.ports[0]!]!);
    wire(parent, rrdRldTemp.q[i]!, aLowMux.pins[muxDef.ports[1]!]!); // in0 (RRD): held (HL) low nibble
    wire(parent, rrdRldTemp.q[i + 4]!, aLowMux.pins[muxDef.ports[2]!]!); // in1 (RLD): held (HL) high nibble
    rrdRldNewALow.push(aLowMux.pins[muxDef.ports[3]!]!);

    const hlHighMux = makeChipInstance(parent, muxDef, { x: pos.x - 650, y: pos.y - 5700 + i * 20 });
    wire(parent, isRldNow.out, hlHighMux.pins[muxDef.ports[0]!]!);
    wire(parent, a.q[i]!, hlHighMux.pins[muxDef.ports[1]!]!); // in0 (RRD): old A low nibble
    wire(parent, rrdRldTemp.q[i]!, hlHighMux.pins[muxDef.ports[2]!]!); // in1 (RLD): held (HL) low nibble
    rrdRldNewHlHigh.push(hlHighMux.pins[muxDef.ports[3]!]!);

    const hlLowMux = makeChipInstance(parent, muxDef, { x: pos.x - 600, y: pos.y - 5700 + i * 20 });
    wire(parent, isRldNow.out, hlLowMux.pins[muxDef.ports[0]!]!);
    wire(parent, rrdRldTemp.q[i + 4]!, hlLowMux.pins[muxDef.ports[1]!]!); // in0 (RRD): held (HL) high nibble
    wire(parent, a.q[i]!, hlLowMux.pins[muxDef.ports[2]!]!); // in1 (RLD): old A low nibble
    rrdRldNewHlLow.push(hlLowMux.pins[muxDef.ports[3]!]!);

    tieToLabel(`RRDRLD_NEWALOW${i}`, rrdRldNewALow[i]!, { x: pos.x - 680, y: pos.y - 5700 + i * 20 }); // anchor — A's own write mux (far) reads this
    tieToLabel(`RRDRLD_NEWHL${i}`, rrdRldNewHlLow[i]!, { x: pos.x - 580, y: pos.y - 5700 + i * 20 }); // anchor — the rotated-byte bus-driver bank (far) reads this
    tieToLabel(`RRDRLD_NEWHL${i + 4}`, rrdRldNewHlHigh[i]!, { x: pos.x - 630, y: pos.y - 5700 + i * 20 }); // anchor — the rotated-byte bus-driver bank (far) reads this
  }
  // Flags: `S`/`Z`/`P` off the *new* `A`, the same "fresh, not stale"
  // treatment every real ALU-touching op in this file gives them; `H`/
  // `N` forced to `0`; `C` untouched (real Z80 leaves it alone for this
  // pair — no layer at all, the same "hold via the layer below" shape
  // this file already uses for every flag an op doesn't touch).
  const rrdRldNewAHigh = a.q.slice(4, 8);
  const rrdRldSBit = rrdRldNewAHigh[3]!;
  let rrdRldZChain: Pin = rrdRldNewALow[0]!;
  for (let i = 1; i < 4; i++) {
    const or1 = buildOr(parent, { x: pos.x - 550, y: pos.y - 5600 + i * 20 });
    wire(parent, rrdRldZChain, or1.a);
    wire(parent, rrdRldNewALow[i]!, or1.b);
    rrdRldZChain = or1.out;
  }
  for (let i = 0; i < 4; i++) {
    const or2 = buildOr(parent, { x: pos.x - 500, y: pos.y - 5600 + i * 20 });
    wire(parent, rrdRldZChain, or2.a);
    wire(parent, rrdRldNewAHigh[i]!, or2.b);
    rrdRldZChain = or2.out;
  }
  const rrdRldZBit = buildNot(parent, { x: pos.x - 450, y: pos.y - 5580 });
  wire(parent, rrdRldZChain, rrdRldZBit.in);
  let rrdRldPChain: Pin = rrdRldNewALow[0]!;
  for (let i = 1; i < 4; i++) {
    const xor1 = buildXor(parent, { x: pos.x - 550, y: pos.y - 5540 + i * 20 });
    wire(parent, rrdRldPChain, xor1.a);
    wire(parent, rrdRldNewALow[i]!, xor1.b);
    rrdRldPChain = xor1.out;
  }
  for (let i = 0; i < 4; i++) {
    const xor2 = buildXor(parent, { x: pos.x - 500, y: pos.y - 5540 + i * 20 });
    wire(parent, rrdRldPChain, xor2.a);
    wire(parent, rrdRldNewAHigh[i]!, xor2.b);
    rrdRldPChain = xor2.out;
  }
  const rrdRldPBit = buildNot(parent, { x: pos.x - 450, y: pos.y - 5520 });
  wire(parent, rrdRldPChain, rrdRldPBit.in);

  // x=01, z=0/z=1: IN r,(C) / OUT (C),r (real 0xED 0x40..0x78 / 0x41..0x79)
  // — port addressed by C, register picked by y. Collides with unprefixed
  // `LD r,B`/`LD r,C` (`z=0`/`z=1`). y=6 is real Z80's undocumented
  // `IN 0,(C)` / `OUT 0,(C)`: flags+strobe still fire, but no register is
  // written (IN) / a literal 0 is written (OUT).
  //
  // Single PHASE4 after the ED prefix (same budget NEG uses): C onto the
  // bus for `ioPortAddr`, `ioRead`/`ioWrite`, and — for IN — commit the
  // external `ioPortDataIn` byte into the destination (and F). Address and
  // data ride different nets (BUS vs raw `ioPortDataIn` / `ioPortDataOut`),
  // the identical shape `IN A,(n)` already established at PHASE2.
  const isInRcNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5450 });
  wire(parent, isEdX1Active.out, isInRcNow.a);
  wire(parent, dec.z[0]!, isInRcNow.b);
  tieToLabel('IS_INRC_NOW', isInRcNow.out, { x: pos.x - 850, y: pos.y - 5450 });
  const isOutRcNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5480 });
  wire(parent, isEdX1Active.out, isOutRcNow.a);
  wire(parent, dec.z[1]!, isOutRcNow.b);
  tieToLabel('IS_OUTRC_NOW', isOutRcNow.out, { x: pos.x - 850, y: pos.y - 5480 });

  const inRcNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5450 });
  wire(parent, isInRcNow.out, inRcNow.a);
  tieToLabel('PHASE4', inRcNow.b, { x: pos.x - 950, y: pos.y - 5450 });
  tieToLabel('INRC_NOW', inRcNow.out, { x: pos.x - 800, y: pos.y - 5450 }); // anchor — ioRead, C-onto-bus, reg we, F layer
  const outRcNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5480 });
  wire(parent, isOutRcNow.out, outRcNow.a);
  tieToLabel('PHASE4', outRcNow.b, { x: pos.x - 950, y: pos.y - 5480 });
  tieToLabel('OUTRC_NOW', outRcNow.out, { x: pos.x - 800, y: pos.y - 5480 }); // anchor — ioWrite, C-onto-bus, ioPortDataOut mux

  // Per-destination WE for IN (y≠6). y=6 still asserts INRC_NOW for the
  // port read + flags, but never lands a register write.
  const notInRcY6 = buildNot(parent, { x: pos.x - 800, y: pos.y - 5420 });
  wire(parent, dec.y[6]!, notInRcY6.in);
  const inRcRegNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5420 });
  wire(parent, inRcNow.out, inRcRegNow.a);
  wire(parent, notInRcY6.out, inRcRegNow.b);
  tieToLabel('INRC_REG_NOW', inRcRegNow.out, { x: pos.x - 700, y: pos.y - 5420 });
  const inRcWeSpecs: { y: Pin; label: string }[] = [
    { y: dec.y[0]!, label: 'INRC_WE_B_NOW' },
    { y: dec.y[1]!, label: 'INRC_WE_C_NOW' },
    { y: dec.y[2]!, label: 'INRC_WE_D_NOW' },
    { y: dec.y[3]!, label: 'INRC_WE_E_NOW' },
    { y: dec.y[4]!, label: 'INRC_WE_H_NOW' },
    { y: dec.y[5]!, label: 'INRC_WE_L_NOW' },
    { y: dec.y[7]!, label: 'INRC_WE_A_NOW' },
  ];
  inRcWeSpecs.forEach(({ y, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x - 650, y: pos.y - 5420 - i * 25 });
    wire(parent, inRcRegNow.out, gate.a);
    wire(parent, y, gate.b);
    tieToLabel(label, gate.out, { x: pos.x - 600, y: pos.y - 5420 - i * 25 });
  });

  // OUT (C),0 — y=6 forces a literal zero onto ioPortDataOut.
  const outRcZeroNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5480 });
  wire(parent, outRcNow.out, outRcZeroNow.a);
  wire(parent, dec.y[6]!, outRcZeroNow.b);
  tieToLabel('OUTRC_ZERO_NOW', outRcZeroNow.out, { x: pos.x - 700, y: pos.y - 5480 });
  const outRcBusSpecs: { y: Pin; label: string }[] = [
    { y: dec.y[0]!, label: 'OUTRC_BUS_B_NOW' },
    { y: dec.y[1]!, label: 'OUTRC_BUS_C_NOW' },
    { y: dec.y[2]!, label: 'OUTRC_BUS_D_NOW' },
    { y: dec.y[3]!, label: 'OUTRC_BUS_E_NOW' },
    { y: dec.y[4]!, label: 'OUTRC_BUS_H_NOW' },
    { y: dec.y[5]!, label: 'OUTRC_BUS_L_NOW' },
    { y: dec.y[7]!, label: 'OUTRC_BUS_A_NOW' },
  ];
  outRcBusSpecs.forEach(({ y, label }, i) => {
    const gate = buildAnd(parent, { x: pos.x - 650, y: pos.y - 5600 - i * 25 });
    wire(parent, outRcNow.out, gate.a);
    wire(parent, y, gate.b);
    tieToLabel(label, gate.out, { x: pos.x - 600, y: pos.y - 5600 - i * 25 });
  });

  // x=01, z=3: LD (nn),dd / LD dd,(nn) (real 0xED 0x43/0x53/0x63/0x73 and
  // 0x4B/0x5B/0x6B/0x7B) — absolute 16-bit load/store for BC/DE/HL/SP.
  // Collides with real unprefixed `LD y,E` (`z=3` picks `E` as the source).
  //
  // Phase budget after the ED prefix (PHASE0-3 already spent): unprefixed
  // `LD (nn),HL` needs read-low/adv/read-high/adv/write-low/write-high —
  // six phases, and only PHASE4-7 remain. Solved by collapsing the two
  // immediate-byte advances into a PC+1 address override on the high-byte
  // read (no separate advance between the two reads):
  //   PHASE4: read nn low at PC → nnAddr
  //   PHASE5: read nn high at PC+1 → nnAddr; advance PC once
  //   PHASE6: advance PC past the instruction; data low (write or read)
  //   PHASE7: data high (write or read)
  // y even = LD (nn),dd; y odd = LD dd,(nn); y>>1 picks BC/DE/HL/SP.
  const isEdLdNnDd = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5800 });
  wire(parent, isEdX1Active.out, isEdLdNnDd.a);
  wire(parent, dec.z[3]!, isEdLdNnDd.b);
  tieToLabel('IS_EDLDNNDD_NOW', isEdLdNnDd.out, { x: pos.x - 850, y: pos.y - 5800 });

  const edNnImmLowNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5830 });
  wire(parent, isEdLdNnDd.out, edNnImmLowNow.a);
  tieToLabel('PHASE4', edNnImmLowNow.b, { x: pos.x - 950, y: pos.y - 5830 });
  tieToLabel('EDNN_IMM_LOW_NOW', edNnImmLowNow.out, { x: pos.x - 800, y: pos.y - 5830 }); // anchor — ramOe, nnAddr we, nnAddr low-byte mux

  const edNnImmHighRaw = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5860 });
  wire(parent, isEdLdNnDd.out, edNnImmHighRaw.a);
  tieToLabel('PHASE5', edNnImmHighRaw.b, { x: pos.x - 950, y: pos.y - 5860 });
  const notEdNnImmLowNow = buildNot(parent, { x: pos.x - 800, y: pos.y - 5845 });
  wire(parent, edNnImmLowNow.out, notEdNnImmLowNow.in);
  const edNnImmHighNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5860 });
  wire(parent, edNnImmHighRaw.out, edNnImmHighNow.a);
  wire(parent, notEdNnImmLowNow.out, edNnImmHighNow.b);
  tieToLabel('EDNN_IMM_HIGH_NOW', edNnImmHighNow.out, { x: pos.x - 700, y: pos.y - 5860 }); // anchor — ramOe, nnAddr we, PC+1 addr mux, pcHold advance #1

  const edNnDataLowRaw = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5890 });
  wire(parent, isEdLdNnDd.out, edNnDataLowRaw.a);
  tieToLabel('PHASE6', edNnDataLowRaw.b, { x: pos.x - 950, y: pos.y - 5890 });
  const notEdNnImmHighNow = buildNot(parent, { x: pos.x - 800, y: pos.y - 5875 });
  wire(parent, edNnImmHighNow.out, notEdNnImmHighNow.in);
  const edNnDataLowNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5890 });
  wire(parent, edNnDataLowRaw.out, edNnDataLowNow.a);
  wire(parent, notEdNnImmHighNow.out, edNnDataLowNow.b);
  tieToLabel('EDNN_DATA_LOW_NOW', edNnDataLowNow.out, { x: pos.x - 700, y: pos.y - 5890 }); // anchor — data write/read low, pcHold advance #2, nnAddr data addr

  const edNnDataHighRaw = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5920 });
  wire(parent, isEdLdNnDd.out, edNnDataHighRaw.a);
  tieToLabel('PHASE7', edNnDataHighRaw.b, { x: pos.x - 950, y: pos.y - 5920 });
  const notEdNnDataLowNow = buildNot(parent, { x: pos.x - 800, y: pos.y - 5905 });
  wire(parent, edNnDataLowNow.out, notEdNnDataLowNow.in);
  const edNnDataHighNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5920 });
  wire(parent, edNnDataHighRaw.out, edNnDataHighNow.a);
  wire(parent, notEdNnDataLowNow.out, edNnDataHighNow.b);
  tieToLabel('EDNN_DATA_HIGH_NOW', edNnDataHighNow.out, { x: pos.x - 700, y: pos.y - 5920 }); // anchor — data write/read high, nnAddr+1 data addr

  // Direction: even y = store (nn),dd; odd y = load dd,(nn).
  const edNnStoreY = buildOr(parent, { x: pos.x - 900, y: pos.y - 5950 });
  wire(parent, dec.y[0]!, edNnStoreY.a);
  wire(parent, dec.y[2]!, edNnStoreY.b);
  const edNnStoreY2 = buildOr(parent, { x: pos.x - 900, y: pos.y - 5970 });
  wire(parent, edNnStoreY.out, edNnStoreY2.a);
  wire(parent, dec.y[4]!, edNnStoreY2.b);
  const edNnStoreYFold = buildOr(parent, { x: pos.x - 900, y: pos.y - 5990 });
  wire(parent, edNnStoreY2.out, edNnStoreYFold.a);
  wire(parent, dec.y[6]!, edNnStoreYFold.b);
  const edNnStoreNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5970 });
  wire(parent, isEdLdNnDd.out, edNnStoreNow.a);
  wire(parent, edNnStoreYFold.out, edNnStoreNow.b);
  tieToLabel('EDNN_STORE_NOW', edNnStoreNow.out, { x: pos.x - 800, y: pos.y - 5970 });

  const edNnLoadY = buildOr(parent, { x: pos.x - 900, y: pos.y - 6010 });
  wire(parent, dec.y[1]!, edNnLoadY.a);
  wire(parent, dec.y[3]!, edNnLoadY.b);
  const edNnLoadY2 = buildOr(parent, { x: pos.x - 900, y: pos.y - 6030 });
  wire(parent, edNnLoadY.out, edNnLoadY2.a);
  wire(parent, dec.y[5]!, edNnLoadY2.b);
  const edNnLoadYFold = buildOr(parent, { x: pos.x - 900, y: pos.y - 6050 });
  wire(parent, edNnLoadY2.out, edNnLoadYFold.a);
  wire(parent, dec.y[7]!, edNnLoadYFold.b);
  const edNnLoadNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 6030 });
  wire(parent, isEdLdNnDd.out, edNnLoadNow.a);
  wire(parent, edNnLoadYFold.out, edNnLoadNow.b);
  tieToLabel('EDNN_LOAD_NOW', edNnLoadNow.out, { x: pos.x - 800, y: pos.y - 6030 });

  // Store/load × low/high phase enables (AND with data phases).
  // The store strobes also wait for RAM's `oe` to be low: RAM drives the bus
  // for the high-immediate read one phase earlier, and `oe` falls through a
  // chain far deeper than these strobes rise, so without the wait a register
  // and RAM drive different values onto the bus.
  const ramOeIdle = buildNot(parent, { x: pos.x - 780, y: pos.y - 5935 });
  wire(parent, ram.pins.oe!, ramOeIdle.in);
  const edNnWriteLowPhase = buildAnd(parent, { x: pos.x - 760, y: pos.y - 5950 });
  wire(parent, edNnStoreNow.out, edNnWriteLowPhase.a);
  wire(parent, edNnDataLowNow.out, edNnWriteLowPhase.b);
  const edNnWriteLowNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5950 });
  wire(parent, edNnWriteLowPhase.out, edNnWriteLowNow.a);
  wire(parent, ramOeIdle.out, edNnWriteLowNow.b);
  tieToLabel('EDNN_WRITE_LOW_NOW', edNnWriteLowNow.out, { x: pos.x - 700, y: pos.y - 5950 }); // ram we + bus drivers
  const edNnWriteHighPhase = buildAnd(parent, { x: pos.x - 760, y: pos.y - 5980 });
  wire(parent, edNnStoreNow.out, edNnWriteHighPhase.a);
  wire(parent, edNnDataHighNow.out, edNnWriteHighPhase.b);
  const edNnWriteHighNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5980 });
  wire(parent, edNnWriteHighPhase.out, edNnWriteHighNow.a);
  wire(parent, ramOeIdle.out, edNnWriteHighNow.b);
  tieToLabel('EDNN_WRITE_HIGH_NOW', edNnWriteHighNow.out, { x: pos.x - 700, y: pos.y - 5980 });
  const edNnReadLowNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 6010 });
  wire(parent, edNnLoadNow.out, edNnReadLowNow.a);
  wire(parent, edNnDataLowNow.out, edNnReadLowNow.b);
  tieToLabel('EDNN_READ_LOW_NOW', edNnReadLowNow.out, { x: pos.x - 700, y: pos.y - 6010 }); // ram oe + register we
  const edNnReadHighNow = buildAnd(parent, { x: pos.x - 750, y: pos.y - 6040 });
  wire(parent, edNnLoadNow.out, edNnReadHighNow.a);
  wire(parent, edNnDataHighNow.out, edNnReadHighNow.b);
  tieToLabel('EDNN_READ_HIGH_NOW', edNnReadHighNow.out, { x: pos.x - 700, y: pos.y - 6040 });

  // Per-register bus-drive (store) and we (load) enables.
  const edNnBusC = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6070 });
  wire(parent, edNnWriteLowNow.out, edNnBusC.a);
  wire(parent, dec.y[0]!, edNnBusC.b);
  tieToLabel('EDNN_BUS_C_NOW', edNnBusC.out, { x: pos.x - 600, y: pos.y - 6070 });
  const edNnBusB = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6090 });
  wire(parent, edNnWriteHighNow.out, edNnBusB.a);
  wire(parent, dec.y[0]!, edNnBusB.b);
  tieToLabel('EDNN_BUS_B_NOW', edNnBusB.out, { x: pos.x - 600, y: pos.y - 6090 });
  const edNnBusE = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6110 });
  wire(parent, edNnWriteLowNow.out, edNnBusE.a);
  wire(parent, dec.y[2]!, edNnBusE.b);
  tieToLabel('EDNN_BUS_E_NOW', edNnBusE.out, { x: pos.x - 600, y: pos.y - 6110 });
  const edNnBusD = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6130 });
  wire(parent, edNnWriteHighNow.out, edNnBusD.a);
  wire(parent, dec.y[2]!, edNnBusD.b);
  tieToLabel('EDNN_BUS_D_NOW', edNnBusD.out, { x: pos.x - 600, y: pos.y - 6130 });
  const edNnBusL = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6150 });
  wire(parent, edNnWriteLowNow.out, edNnBusL.a);
  wire(parent, dec.y[4]!, edNnBusL.b);
  tieToLabel('EDNN_BUS_L_NOW', edNnBusL.out, { x: pos.x - 600, y: pos.y - 6150 });
  const edNnBusH = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6170 });
  wire(parent, edNnWriteHighNow.out, edNnBusH.a);
  wire(parent, dec.y[4]!, edNnBusH.b);
  tieToLabel('EDNN_BUS_H_NOW', edNnBusH.out, { x: pos.x - 600, y: pos.y - 6170 });
  const edNnBusSpLow = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6190 });
  wire(parent, edNnWriteLowNow.out, edNnBusSpLow.a);
  wire(parent, dec.y[6]!, edNnBusSpLow.b);
  tieToLabel('EDNN_BUS_SPLO_NOW', edNnBusSpLow.out, { x: pos.x - 600, y: pos.y - 6190 });
  const edNnBusSpHigh = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6210 });
  wire(parent, edNnWriteHighNow.out, edNnBusSpHigh.a);
  wire(parent, dec.y[6]!, edNnBusSpHigh.b);
  tieToLabel('EDNN_BUS_SPHI_NOW', edNnBusSpHigh.out, { x: pos.x - 600, y: pos.y - 6210 });

  const edNnWeC = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6230 });
  wire(parent, edNnReadLowNow.out, edNnWeC.a);
  wire(parent, dec.y[1]!, edNnWeC.b);
  tieToLabel('EDNN_WE_C_NOW', edNnWeC.out, { x: pos.x - 600, y: pos.y - 6230 });
  const edNnWeB = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6250 });
  wire(parent, edNnReadHighNow.out, edNnWeB.a);
  wire(parent, dec.y[1]!, edNnWeB.b);
  tieToLabel('EDNN_WE_B_NOW', edNnWeB.out, { x: pos.x - 600, y: pos.y - 6250 });
  const edNnWeE = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6270 });
  wire(parent, edNnReadLowNow.out, edNnWeE.a);
  wire(parent, dec.y[3]!, edNnWeE.b);
  tieToLabel('EDNN_WE_E_NOW', edNnWeE.out, { x: pos.x - 600, y: pos.y - 6270 });
  const edNnWeD = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6290 });
  wire(parent, edNnReadHighNow.out, edNnWeD.a);
  wire(parent, dec.y[3]!, edNnWeD.b);
  tieToLabel('EDNN_WE_D_NOW', edNnWeD.out, { x: pos.x - 600, y: pos.y - 6290 });
  const edNnWeL = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6310 });
  wire(parent, edNnReadLowNow.out, edNnWeL.a);
  wire(parent, dec.y[5]!, edNnWeL.b);
  tieToLabel('EDNN_WE_L_NOW', edNnWeL.out, { x: pos.x - 600, y: pos.y - 6310 });
  const edNnWeH = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6330 });
  wire(parent, edNnReadHighNow.out, edNnWeH.a);
  wire(parent, dec.y[5]!, edNnWeH.b);
  tieToLabel('EDNN_WE_H_NOW', edNnWeH.out, { x: pos.x - 600, y: pos.y - 6330 });
  const edNnWeSpLow = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6350 });
  wire(parent, edNnReadLowNow.out, edNnWeSpLow.a);
  wire(parent, dec.y[7]!, edNnWeSpLow.b);
  tieToLabel('EDNN_WE_SPLO_NOW', edNnWeSpLow.out, { x: pos.x - 600, y: pos.y - 6350 });
  const edNnWeSpHigh = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6370 });
  wire(parent, edNnReadHighNow.out, edNnWeSpHigh.a);
  wire(parent, dec.y[7]!, edNnWeSpHigh.b);
  tieToLabel('EDNN_WE_SPHI_NOW', edNnWeSpHigh.out, { x: pos.x - 600, y: pos.y - 6370 });

  // ir.we's own PHASE0 anchor above widens to a second term: PHASE2, but
  // only while `prefixReadNow` is genuinely high — the identical "the
  // shared bus already carries the right value by the time this fires"
  // reasoning `LDIMM8_READ_NOW` relies on for every register that reads an
  // immediate operand off it, except here the *destination* is `ir` itself.
  const irWe = buildOr(parent, { x: pos.x + 9050, y: pos.y - 4300 });
  tieToLabel('PHASE0', irWe.a, { x: pos.x + 8950, y: pos.y - 4300 });
  wire(parent, prefixReadNow.out, irWe.b);
  // DD CB / FD CB second IR-only op recapture — never touches activePrefix.we.
  const ddFdCbOpRead = buildOr(parent, { x: pos.x + 9050, y: pos.y - 4280 });
  tieToLabel('DDCB_OP_READ_NOW', ddFdCbOpRead.a, { x: pos.x + 8950, y: pos.y - 4280 });
  tieToLabel('FDCB_OP_READ_NOW', ddFdCbOpRead.b, { x: pos.x + 8950, y: pos.y - 4260 });
  const irWe2 = buildOr(parent, { x: pos.x + 9100, y: pos.y - 4300 });
  wire(parent, irWe.out, irWe2.a);
  wire(parent, ddFdCbOpRead.out, irWe2.b);
  wire(parent, irWe2.out, ir.we);

  // ir.q[3..5] (y's own real bits, not dec.y's one-hot lines — see the
  // RST-target doc comment further down for why that distinction matters)
  // only has one far consumer, RST's own PC-target mux at pos.x-200 — still
  // labeled, since `ir` itself sits all the way at pos.x+2600.
  [3, 4, 5].forEach((k) => tieToLabel(`IRQ${k}`, ir.q[k]!, { x: pos.x + 2500, y: pos.y + 40 + k * 20 }));

  // Every register's own `q` feeds a tri-state bank's *input* far away too
  // (the operand bus, one or two push-byte banks) — a second class of long
  // wire the BUS/DECY/PHASE anchors above don't touch, since those only
  // covered each bank's *output* side (onto ir.d). Anchored once per
  // register here (REGB0-7, REGC0-7, ... REGPC0-5), reused at every far
  // tri-buf .a input below instead of redrawing straight back to each
  // register's own position.
  const regAnchors: [string, Register | { q: Pin[] }, Point][] = [
    ['REGB', rB, { x: pos.x + 4900, y: pos.y - 40 }],
    ['REGC', rC, { x: pos.x + 4900, y: pos.y + 1160 }],
    ['REGD', rD, { x: pos.x + 6100, y: pos.y - 40 }],
    ['REGE', rE, { x: pos.x + 6100, y: pos.y + 1160 }],
    ['REGH', rH, { x: pos.x + 7300, y: pos.y - 40 }],
    ['REGL', rL, { x: pos.x + 7300, y: pos.y + 1160 }],
    ['REGA', a, { x: pos.x + 3700, y: pos.y - 40 }],
    ['REGF', f, { x: pos.x + 7900, y: pos.y + 2160 }],
  ];
  for (const [name, reg, p] of regAnchors) {
    reg.q.forEach((q, i) => tieToLabel(`${name}${i}`, q, { x: p.x, y: p.y - i * 20 }));
  }
  pc.q.forEach((q, i) => tieToLabel(`REGPC${i}`, q, { x: pos.x - 100, y: pos.y - 40 - i * 20 }));

  // FETCH (phase 0): RAM drives the bus; IR captures it — unless IRQ/NMI
  // accept forces IR: NMI/IM2→0x00 (NOP), IM0→irqBus, IM1→0xFF (RST 38h).
  // Priority: NMI > IM2 > IM01. The shared `BUS*` net stays on the RAM side.
  ramDataPins(ram).forEach((p, i) => {
    tieToLabel(`BUS${i}`, p, { x: pos.x + 2500, y: pos.y - 60 - i * 20 });
    // intForce: IM0 ? irqBus : VCC (IM1 RST 38h) — only IM0/IM1 accept
    const im0ForceMux = makeChipInstance(parent, muxDef, { x: pos.x + 2520, y: pos.y - 60 - i * 100 });
    tieToLabel('IM0', im0ForceMux.pins[muxDef.ports[0]!]!, { x: pos.x + 2420, y: pos.y - 60 - i * 100 });
    tiePowerRail(parent, 'VCC', im0ForceMux.pins[muxDef.ports[1]!]!); // in0: IM1 → 1
    tieToLabel(`IRQBUS${i}`, im0ForceMux.pins[muxDef.ports[2]!]!, { x: pos.x + 2420, y: pos.y - 40 - i * 100 }); // in1: IM0 bus
    const intForceMux = makeChipInstance(parent, muxDef, { x: pos.x + 2550, y: pos.y - 60 - i * 100 });
    tieToLabel('IM01_ACCEPT_NOW', intForceMux.pins[muxDef.ports[0]!]!, { x: pos.x + 2450, y: pos.y - 60 - i * 100 });
    wire(parent, p, intForceMux.pins[muxDef.ports[1]!]!); // in0: normal FETCH from RAM
    wire(parent, im0ForceMux.pins[muxDef.ports[3]!]!, intForceMux.pins[muxDef.ports[2]!]!);
    // IM2: force NOP (same shell as NMI; vector fetch is separate micro-ops)
    const im2ForceMux = makeChipInstance(parent, muxDef, { x: pos.x + 2570, y: pos.y - 60 - i * 100 });
    tieToLabel('IM2_ACCEPT_NOW', im2ForceMux.pins[muxDef.ports[0]!]!, { x: pos.x + 2470, y: pos.y - 60 - i * 100 });
    wire(parent, intForceMux.pins[muxDef.ports[3]!]!, im2ForceMux.pins[muxDef.ports[1]!]!);
    tiePowerRail(parent, 'GND', im2ForceMux.pins[muxDef.ports[2]!]!);
    // NMI wins: force 0
    const nmiForceMux = makeChipInstance(parent, muxDef, { x: pos.x + 2590, y: pos.y - 60 - i * 100 });
    tieToLabel('NMI_ACCEPT_NOW', nmiForceMux.pins[muxDef.ports[0]!]!, { x: pos.x + 2490, y: pos.y - 60 - i * 100 });
    wire(parent, im2ForceMux.pins[muxDef.ports[3]!]!, nmiForceMux.pins[muxDef.ports[1]!]!);
    tiePowerRail(parent, 'GND', nmiForceMux.pins[muxDef.ports[2]!]!);
    wire(parent, nmiForceMux.pins[muxDef.ports[3]!]!, ir.d[i]!);
  });
  // Publish IM0 latch for IR force mux (q is far from here).
  tieToLabel('IM0', im0.q[0]!, { x: pos.x + 1800, y: pos.y + 4220 });

  // Real Z80 decode: x=10 (dec.x[2]) is ALU-on-register, x=01 (dec.x[1]) is
  // LD r,r' — see the doc comment above for what each group's y/z mean.
  // Each of the four is now `AND`ed with `NOT_PREFIX_ACTIVE` (see the
  // "CB/ED/DD/FD prefix bytes" doc comment above) instead of a bare
  // `dec.x[N]` — the one change every downstream gate already built on top
  // of these four inherits for free, since none of them read `dec.x[N]`
  // directly (verified: `dec.x[` has exactly these four call sites in the
  // whole file).
  const rawAluGroup = dec.x[2]!;
  const isAluGroupGate = buildAnd(parent, { x: pos.x + 8950, y: pos.y - 220 });
  wire(parent, rawAluGroup, isAluGroupGate.a);
  tieToLabel('NOT_PREFIX_ACTIVE', isAluGroupGate.b, { x: pos.x + 8850, y: pos.y - 220 });
  const isAluGroup = isAluGroupGate.out;
  const aluGroupNow = buildAnd(parent, { x: pos.x + 9000, y: pos.y - 200 });
  wire(parent, isAluGroup, aluGroupNow.a);
  tieToLabel('PHASE2', aluGroupNow.b, { x: pos.x + 8900, y: pos.y - 200 });

  const rawLdGroup = dec.x[1]!;
  const isLdGroupGate = buildAnd(parent, { x: pos.x + 8950, y: pos.y + 130 });
  wire(parent, rawLdGroup, isLdGroupGate.a);
  tieToLabel('NOT_PREFIX_ACTIVE', isLdGroupGate.b, { x: pos.x + 8850, y: pos.y + 130 });
  const isLdGroup = isLdGroupGate.out;
  const ldGroupNow = buildAnd(parent, { x: pos.x + 9000, y: pos.y + 150 });
  wire(parent, isLdGroup, ldGroupNow.a);
  tieToLabel('PHASE2', ldGroupNow.b, { x: pos.x + 8900, y: pos.y + 150 });

  // Anything that can drive the shared bus, or that gates RAM, needs to key
  // off "one of the two groups this slice executes is decoding right now",
  // not just the ALU one anymore — see the doc comment above ("What's
  // shared between the two groups").
  const groupActive = buildOr(parent, { x: pos.x + 9150, y: pos.y - 25 });
  wire(parent, aluGroupNow.out, groupActive.a);
  wire(parent, ldGroupNow.out, groupActive.b);
  // x=00, z=3: INC BC/DE/HL/SP, DEC BC/DE/HL/SP — see the doc comment above
  // ("x=00, z=3: INC rr/DEC rr") for the full derivation. Deliberately does
  // NOT feed into groupActive/busActive above: this instruction never reads
  // or writes RAM and never touches the shared operand bus, only the
  // register file directly, so none of the bus-fight machinery those two
  // signals exist for applies here.
  const rawX0Group = dec.x[0]!;
  const isX0GroupGate = buildAnd(parent, { x: pos.x + 9050, y: pos.y - 720 });
  wire(parent, rawX0Group, isX0GroupGate.a);
  tieToLabel('NOT_PREFIX_ACTIVE', isX0GroupGate.b, { x: pos.x + 8950, y: pos.y - 720 });
  const isX0Group = isX0GroupGate.out;
  const isIncDecRr = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 700 });
  wire(parent, isX0Group, isIncDecRr.a);
  wire(parent, dec.z[3]!, isIncDecRr.b);
  const incDecRrNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 700 });
  wire(parent, isIncDecRr.out, incDecRrNow.a);
  tieToLabel('PHASE2', incDecRrNow.b, { x: pos.x + 9200, y: pos.y - 730 });

  // Pair select: y>>1 picks BC/DE/HL/SP (y=0,1 -> BC; 2,3 -> DE; 4,5 -> HL;
  // 6,7 -> SP); within each pair the odd y-line is DEC, the even one INC.
  const pairBC = buildOr(parent, { x: pos.x + 9400, y: pos.y - 850 });
  wire(parent, dec.y[0]!, pairBC.a);
  wire(parent, dec.y[1]!, pairBC.b);
  const pairDE = buildOr(parent, { x: pos.x + 9400, y: pos.y - 800 });
  wire(parent, dec.y[2]!, pairDE.a);
  wire(parent, dec.y[3]!, pairDE.b);
  const pairHL = buildOr(parent, { x: pos.x + 9400, y: pos.y - 750 });
  wire(parent, dec.y[4]!, pairHL.a);
  wire(parent, dec.y[5]!, pairHL.b);
  const pairSP = buildOr(parent, { x: pos.x + 9400, y: pos.y - 700 });
  wire(parent, dec.y[6]!, pairSP.a);
  wire(parent, dec.y[7]!, pairSP.b);

  const incDecBcNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 850 });
  wire(parent, incDecRrNow.out, incDecBcNow.a);
  wire(parent, pairBC.out, incDecBcNow.b);
  const incDecDeNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 800 });
  wire(parent, incDecRrNow.out, incDecDeNow.a);
  wire(parent, pairDE.out, incDecDeNow.b);
  const incDecHlNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 750 });
  wire(parent, incDecRrNow.out, incDecHlNow.a);
  wire(parent, pairHL.out, incDecHlNow.b);
  const incDecSpNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 700 });
  wire(parent, incDecRrNow.out, incDecSpNow.a);
  wire(parent, pairSP.out, incDecSpNow.b);
  // DEC SP specifically (not INC SP) — spAdder's own direction control
  // needs to know *which* of the two SP conditions this cycle is, unlike
  // BC/DE/HL's own pair adders below, which read dec.y[1]/[3]/[5] directly
  // since they're built right next to `dec` (no label needed there); this
  // one has to cross to spAdder's own location, hence the label.
  const decSpNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 650 });
  wire(parent, incDecRrNow.out, decSpNow.a);
  wire(parent, dec.y[7]!, decSpNow.b);

  tieToLabel('INCDEC_BC_NOW', incDecBcNow.out, { x: pos.x + 9600, y: pos.y - 850 });
  tieToLabel('INCDEC_DE_NOW', incDecDeNow.out, { x: pos.x + 9600, y: pos.y - 800 });
  tieToLabel('INCDEC_HL_NOW', incDecHlNow.out, { x: pos.x + 9600, y: pos.y - 750 });
  tieToLabel('INCDEC_SP_NOW', incDecSpNow.out, { x: pos.x + 9600, y: pos.y - 700 });
  tieToLabel('DEC_SP_NOW', decSpNow.out, { x: pos.x + 9600, y: pos.y - 650 });

  // BC/DE/HL's own +-1: three more buildAlu instances (width 16, not 8 —
  // spAdder below is the identical pattern at addrBits width for SP alone),
  // each permanently in ADD mode, its own pair's DEC y-line (dec.y[1]/[3]/
  // [5], read directly — `dec` sits right here, no label needed) fanned to
  // `b` (all-1s when set) with cin=NOT(that same line) — see spAdder's own
  // doc comment below for why b=all-1s/cin=0 computes -1 and b=0/cin=1
  // computes +1, and why getting cin backwards silently no-ops the
  // decrement (found live there once already; not repeated here). High
  // byte is bits [8..15], low byte [0..15] — B/D/H high, C/E/L low, the
  // same convention PUSH/POP's own byte order above already established.
  // Always computing regardless of which instruction is actually decoding
  // (same philosophy as spAdder, and as `alu` itself) — only the write-back
  // stage below (`wrapWithPairCommit`, gated by INCDEC_xx_NOW) decides
  // whether any of this is ever read.
  const buildPairAdder = (highRegLabel: string, lowRegLabel: string, outLabel: string, decY: Pin, adderPos: Point): void => {
    const adder = buildAlu(parent, library, 16, adderPos);
    tiePowerRail(parent, 'GND', adder.op0);
    tiePowerRail(parent, 'GND', adder.op1);
    const notDecY = buildNot(parent, { x: adderPos.x - 100, y: adderPos.y - 50 });
    wire(parent, decY, notDecY.in);
    wire(parent, notDecY.out, adder.cin);
    for (let i = 0; i < 8; i++) {
      tieToLabel(`${lowRegLabel}${i}`, adder.a[i]!, { x: adderPos.x - 150, y: adderPos.y + i * 20 });
      tieToLabel(`${highRegLabel}${i}`, adder.a[i + 8]!, { x: adderPos.x - 150, y: adderPos.y + 200 + i * 20 });
      wire(parent, decY, adder.b[i]!);
      wire(parent, decY, adder.b[i + 8]!);
      tieToLabel(`${outLabel}LO${i}`, adder.out[i]!, { x: adderPos.x + 2100, y: adderPos.y + i * 20 });
      tieToLabel(`${outLabel}HI${i}`, adder.out[i + 8]!, { x: adderPos.x + 2100, y: adderPos.y + 200 + i * 20 });
    }
  };
  // `BC`'s own pair adder needs a second way to reach `-1`: real `DEC BC`
  // (`dec.y[1]`, unprefixed) is one, the whole `LDI`/`LDD`/`LDIR`/`LDDR`
  // family's own always-a-decrement `BC--` (`isLdBlockNow` — see "x=10,
  // z=0: LDI/LDD/LDIR/LDDR" above) is the other — an `OR`, not a
  // replacement, since the two conditions are mutually exclusive by
  // construction (one reads the plain unprefixed table, the other only
  // fires with `ED` latched) but never need to be told apart here, only
  // recognized. `DE`/`HL` want `-1` only for `LDD`/`LDDR` specifically
  // (`directionIsDecNow`, the same doc comment's own derivation) —
  // `LDI`/`LDIR` get their `+1` for free, exactly what each adder already
  // computes whenever its own `DEC DE`/`DEC HL` line (`dec.y[3]`/`[5]`) is
  // 0, which it always is while `ir` holds any of this family's own
  // recaptured `y=4..7`.
  // `BC`'s own direction line needs a *third* way to reach `-1` now:
  // `CPI`/`CPD`/`CPIR`/`CPDR` (`isCpBlockNow`) decrement `BC` exactly like
  // the `LDI` family does — one more `OR` term, not a replacement, the
  // same "mutually exclusive by construction, never need to be told
  // apart" reasoning `isLdBlockNow` itself already relies on here.
  const bcDecYStage = buildOr(parent, { x: pos.x + 8800, y: pos.y - 1320 });
  wire(parent, dec.y[1]!, bcDecYStage.a);
  wire(parent, isLdBlockNow.out, bcDecYStage.b);
  const bcDecY = buildOr(parent, { x: pos.x + 8850, y: pos.y - 1320 });
  wire(parent, bcDecYStage.out, bcDecY.a);
  wire(parent, isCpBlockNow.out, bcDecY.b);
  const deDecY = buildOr(parent, { x: pos.x + 8850, y: pos.y - 920 });
  wire(parent, dec.y[3]!, deDecY.a);
  wire(parent, directionIsDecNow.out, deDecY.b);
  // `HL`'s own direction line needs a third term too: `CPD`/`CPDR`'s own
  // `cpDirectionIsDecNow` — `CPI`/`CPIR` get their `+1` for free, exactly
  // the same "default direction needs no widening" shape `LDI`/`LDIR`
  // already established for this same adder.
  const hlDecYStage = buildOr(parent, { x: pos.x + 8800, y: pos.y - 520 });
  wire(parent, dec.y[5]!, hlDecYStage.a);
  wire(parent, directionIsDecNow.out, hlDecYStage.b);
  const hlDecYStage2 = buildOr(parent, { x: pos.x + 8820, y: pos.y - 520 });
  wire(parent, hlDecYStage.out, hlDecYStage2.a);
  wire(parent, cpDirectionIsDecNow.out, hlDecYStage2.b);
  // `HL`'s own direction line needs a fourth term: `IND`/`INDR`'s own
  // `inDirectionIsDecNow` — `INI`/`INIR` get their `+1` for free, the
  // identical "default direction needs no widening" shape every earlier
  // family here already established for this same adder.
  const hlDecYStage3 = buildOr(parent, { x: pos.x + 8830, y: pos.y - 520 });
  wire(parent, hlDecYStage2.out, hlDecYStage3.a);
  wire(parent, inDirectionIsDecNow.out, hlDecYStage3.b);
  // A fifth and final term: `OUTD`/`OTDR`'s own `outDirectionIsDecNow` —
  // `OUTI`/`OTIR` get their `+1` for free, the same reasoning once more.
  const hlDecY = buildOr(parent, { x: pos.x + 8850, y: pos.y - 520 });
  wire(parent, hlDecYStage3.out, hlDecY.a);
  wire(parent, outDirectionIsDecNow.out, hlDecY.b);
  buildPairAdder('REGB', 'REGC', 'BCADD', bcDecY.out, { x: pos.x + 8900, y: pos.y - 1300 });
  buildPairAdder('REGD', 'REGE', 'DEADD', deDecY.out, { x: pos.x + 8900, y: pos.y - 900 });
  buildPairAdder('REGH', 'REGL', 'HLADD', hlDecY.out, { x: pos.x + 8900, y: pos.y - 500 });
  // DD/FD INC/DEC IX/IY — same +1/−1 recipe, `dec.y[5]` is DEC (odd);
  // always computing; write-back gated by INCDEC_IX_NOW / INCDEC_IY_NOW.
  buildPairAdder('REGIXH', 'REGIXL', 'IXADD', dec.y[5]!, { x: pos.x + 8900, y: pos.y - 100 });
  buildPairAdder('REGIYH', 'REGIYL', 'IYADD', dec.y[5]!, { x: pos.x + 8900, y: pos.y + 300 });

  // x=00, z=4/z=5: INC r/DEC r — see the doc comment above ("x=00, z=4/z=5:
  // INC r/DEC r") for the full derivation. `y` (not `z`, unlike the ALU
  // group's own operand field) selects the register: B/C/D/E/H/L/(HL)/A,
  // same encoding `x=10`'s `z` and `x=01`'s `y`/`z` already use. `(HL)`
  // (`y=6`) now gets its own real read-modify-write through RAM — see
  // "x=00: INC (HL)/DEC (HL)/LD (HL),n" above.
  const isIncR8 = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 1600 });
  wire(parent, isX0Group, isIncR8.a);
  wire(parent, dec.z[4]!, isIncR8.b);
  const isDecR8 = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 1550 });
  wire(parent, isX0Group, isDecR8.a);
  wire(parent, dec.z[5]!, isDecR8.b);
  // DD/FD INC/DEC (IX+d)/(IY+d) + HL8 IXH/IXL/IYH/IYL: isX0Group is dead
  // under prefix — OR DEC direction from parallel decode into the shared
  // r8Adder cin/b and R8_N/H path.
  const isDecR8DdFdMem = buildOr(parent, { x: pos.x + 9180, y: pos.y - 1525 });
  tieToLabel('DDMEM_IS_DEC', isDecR8DdFdMem.a, { x: pos.x + 9080, y: pos.y - 1525 });
  tieToLabel('FDMEM_IS_DEC', isDecR8DdFdMem.b, { x: pos.x + 9080, y: pos.y - 1505 });
  const isDecR8DdFdHl8 = buildOr(parent, { x: pos.x + 9180, y: pos.y - 1505 });
  tieToLabel('DDIX_HL8_IS_DEC', isDecR8DdFdHl8.a, { x: pos.x + 9080, y: pos.y - 1505 });
  tieToLabel('FDIY_HL8_IS_DEC', isDecR8DdFdHl8.b, { x: pos.x + 9080, y: pos.y - 1485 });
  const isDecR8DdFd = buildOr(parent, { x: pos.x + 9220, y: pos.y - 1515 });
  wire(parent, isDecR8DdFdMem.out, isDecR8DdFd.a);
  wire(parent, isDecR8DdFdHl8.out, isDecR8DdFd.b);
  const isDecR8Any = buildOr(parent, { x: pos.x + 9240, y: pos.y - 1535 });
  wire(parent, isDecR8.out, isDecR8Any.a);
  wire(parent, isDecR8DdFd.out, isDecR8Any.b);
  const isIncDecR8 = buildOr(parent, { x: pos.x + 9300, y: pos.y - 1575 });
  wire(parent, isIncR8.out, isIncDecR8.a);
  wire(parent, isDecR8.out, isIncDecR8.b);
  // `(HL)` (`y=6`) now gets its own real read-modify-write (see "x=00:
  // INC (HL)/DEC (HL)/LD (HL),n" above) — `incDecR8Now` (the 7-register
  // case's own commit) explicitly excludes it, since `(HL)`'s own value
  // isn't valid until a whole phase later (`hlMemTemp` has to actually
  // read RAM first); committing it early, off `hlMemTemp`'s stale
  // previous contents, would be a real bug even though it wouldn't
  // corrupt registers B/C/D/E/H/L/A themselves (none of their own
  // per-register commits below check `y=6`) — only `F`'s own flags would
  // transiently glitch, `INCDEC_HLMEM_NOW`'s own later, correct commit
  // fixing it a phase after.
  const isIncDecHlMem = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 1650 });
  wire(parent, isIncDecR8.out, isIncDecHlMem.a);
  wire(parent, dec.y[6]!, isIncDecHlMem.b);
  tieToLabel('IS_INCDEC_HLMEM', isIncDecHlMem.out, { x: pos.x + 9360, y: pos.y - 1650 }); // anchor — RAM's own address mux (far) reads this
  const notY6ForIncDecR8 = buildNot(parent, { x: pos.x + 9380, y: pos.y - 1620 });
  wire(parent, dec.y[6]!, notY6ForIncDecR8.in);
  const incDecR8Stage = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 1575 });
  wire(parent, isIncDecR8.out, incDecR8Stage.a);
  tieToLabel('PHASE2', incDecR8Stage.b, { x: pos.x + 9300, y: pos.y - 1600 });
  const incDecR8Now = buildAnd(parent, { x: pos.x + 9420, y: pos.y - 1575 });
  wire(parent, incDecR8Stage.out, incDecR8Now.a);
  wire(parent, notY6ForIncDecR8.out, incDecR8Now.b);

  // `(HL)`'s own read: `PHASE2`, capturing the bus (RAM, addressed
  // through `HL` the same way `hlNow`'s own x=10/x=01 case already
  // addresses it, widened below) into `hlMemTemp` — a *sixth* dedicated
  // holding register, the same "the bus moves on, so hold what's on it
  // now" reason every earlier target register in this file needed one.
  const hlMemReadNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 1650 });
  wire(parent, isIncDecHlMem.out, hlMemReadNow.a);
  tieToLabel('PHASE2', hlMemReadNow.b, { x: pos.x + 9300, y: pos.y - 1620 });
  const hlMemTemp = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 6200 });
  // INC/DEC (HL) read OR CB BIT (HL) read — mutually exclusive by
  // NOT_PREFIX_ACTIVE vs isCbActive; share one holding register.
  // (Former OR(hlMemReadNow, GND) identity stub removed — wire straight in.)
  const hlMemTempWe2 = buildOr(parent, { x: pos.x - 720, y: pos.y - 6220 });
  wire(parent, hlMemReadNow.out, hlMemTempWe2.a);
  tieToLabel('BIT_HL_READ_NOW', hlMemTempWe2.b, { x: pos.x - 850, y: pos.y - 6220 });
  const hlMemTempWe3 = buildOr(parent, { x: pos.x - 690, y: pos.y - 6220 });
  wire(parent, hlMemTempWe2.out, hlMemTempWe3.a);
  tieToLabel('SETRES_HL_READ_NOW', hlMemTempWe3.b, { x: pos.x - 850, y: pos.y - 6240 });
  const hlMemTempWe4 = buildOr(parent, { x: pos.x - 660, y: pos.y - 6220 });
  wire(parent, hlMemTempWe3.out, hlMemTempWe4.a);
  tieToLabel('CBROT_HL_READ_NOW', hlMemTempWe4.b, { x: pos.x - 850, y: pos.y - 6260 });
  // DD/FD INC/DEC (IX+d)/(IY+d) PHASE6 read into shared hlMemTemp.
  const hlMemTempWeDdFd = buildOr(parent, { x: pos.x - 630, y: pos.y - 6220 });
  tieToLabel('DDMEM_INCDEC_READ_NOW', hlMemTempWeDdFd.a, { x: pos.x - 850, y: pos.y - 6280 });
  tieToLabel('FDMEM_INCDEC_READ_NOW', hlMemTempWeDdFd.b, { x: pos.x - 850, y: pos.y - 6300 });
  const hlMemTempWe5 = buildOr(parent, { x: pos.x - 600, y: pos.y - 6220 });
  wire(parent, hlMemTempWe4.out, hlMemTempWe5.a);
  wire(parent, hlMemTempWeDdFd.out, hlMemTempWe5.b);
  // DD/FD CB SET/RES (IX+d)/(IY+d) PHASE7 read into shared hlMemTemp.
  const hlMemTempWeDdCb = buildOr(parent, { x: pos.x - 570, y: pos.y - 6220 });
  tieToLabel('SETRES_IX_READ_NOW', hlMemTempWeDdCb.a, { x: pos.x - 850, y: pos.y - 6320 });
  tieToLabel('SETRES_IY_READ_NOW', hlMemTempWeDdCb.b, { x: pos.x - 850, y: pos.y - 6340 });
  const hlMemTempWe6 = buildOr(parent, { x: pos.x - 540, y: pos.y - 6220 });
  wire(parent, hlMemTempWe5.out, hlMemTempWe6.a);
  wire(parent, hlMemTempWeDdCb.out, hlMemTempWe6.b);
  wire(parent, hlMemTempWe6.out, hlMemTemp.we);
  hlMemTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 6200 + i * 20 }));
  hlMemTemp.q.forEach((q, i) => tieToLabel(`HLMEM${i}`, q, { x: pos.x - 800, y: pos.y - 6180 + i * 20 })); // anchor — r8Select + BIT (HL) flags
  tieToLabel('CLK', hlMemTemp.clk, { x: pos.x - 700, y: pos.y - 6240 }); // learned from jpTarget's own missing-CLK bug, several features back — checked off explicitly, every time, no exceptions

  // BIT y,(HL) flags — same recipe as register BIT, off `HLMEM` after the
  // PHASE4 capture. X/Y mirror the memory byte's bits 3/5 (real Z80 uses
  // internal WZ here; documented simplification).
  let bitHlTest: Pin | null = null;
  for (let yi = 0; yi < 8; yi++) {
    const andGate = buildAnd(parent, { x: pos.x - 600, y: pos.y - 6400 + yi * 20 });
    tieToLabel(`HLMEM${yi}`, andGate.a, { x: pos.x - 700, y: pos.y - 6400 + yi * 20 });
    wire(parent, dec.y[yi]!, andGate.b);
    if (bitHlTest === null) {
      bitHlTest = andGate.out;
    } else {
      const orGate = buildOr(parent, { x: pos.x - 550, y: pos.y - 6400 + yi * 20 });
      wire(parent, bitHlTest, orGate.a);
      wire(parent, andGate.out, orGate.b);
      bitHlTest = orGate.out;
    }
  }
  const bitHlZBit = buildNot(parent, { x: pos.x - 500, y: pos.y - 6420 });
  wire(parent, bitHlTest!, bitHlZBit.in);
  const bitHlSBit = buildAnd(parent, { x: pos.x - 500, y: pos.y - 6400 });
  wire(parent, bitHlTest!, bitHlSBit.a);
  wire(parent, dec.y[7]!, bitHlSBit.b);
  const bitHlPBit = bitHlZBit.out;
  const bitHlXBit = hlMemTemp.q[3]!;
  const bitHlYBit = hlMemTemp.q[5]!;

  // BIT y,(IX+d)/(IY+d) flags — same recipe, off BUS while ram.oe drives
  // (IX+d)/(IY+d) at PHASE7 (same-phase commit, no hlMemTemp hold).
  let bitIxTest: Pin | null = null;
  for (let yi = 0; yi < 8; yi++) {
    const andGate = buildAnd(parent, { x: pos.x - 600, y: pos.y - 6550 + yi * 20 });
    tieToLabel(`BUS${yi}`, andGate.a, { x: pos.x - 700, y: pos.y - 6550 + yi * 20 });
    wire(parent, dec.y[yi]!, andGate.b);
    if (bitIxTest === null) {
      bitIxTest = andGate.out;
    } else {
      const orGate = buildOr(parent, { x: pos.x - 550, y: pos.y - 6550 + yi * 20 });
      wire(parent, bitIxTest, orGate.a);
      wire(parent, andGate.out, orGate.b);
      bitIxTest = orGate.out;
    }
  }
  const bitIxZBit = buildNot(parent, { x: pos.x - 500, y: pos.y - 6570 });
  wire(parent, bitIxTest!, bitIxZBit.in);
  const bitIxSBit = buildAnd(parent, { x: pos.x - 500, y: pos.y - 6550 });
  wire(parent, bitIxTest!, bitIxSBit.a);
  wire(parent, dec.y[7]!, bitIxSBit.b);
  const bitIxPBit = bitIxZBit.out;
  // X/Y from the live BUS byte (bits 3/5) — same simplification as BIT (HL).
  const bitIxXBitLabel = makeLabel(parent, 'BUS3', { x: pos.x - 500, y: pos.y - 6530 });
  const bitIxYBitLabel = makeLabel(parent, 'BUS5', { x: pos.x - 500, y: pos.y - 6510 });
  const bitIxXBit = bitIxXBitLabel.pins.net;
  const bitIxYBit = bitIxYBitLabel.pins.net;

  // SET/RES result byte — src is the z-selected register (bitRegByte) or
  // HLMEM when z=6. Force 1 on SET's y bit, 0 on RES's y bit; other bits
  // pass through. No flags.
  const setResCommitLabel = makeLabel(parent, 'SETRES_COMMIT_NOW', { x: pos.x - 400, y: pos.y - 6500 });
  for (let i = 0; i < 8; i++) {
    const srcMux = makeChipInstance(parent, muxDef, { x: pos.x - 350, y: pos.y - 6600 + i * 40 });
    wire(parent, dec.z[6]!, srcMux.pins[muxDef.ports[0]!]!);
    wire(parent, bitRegByte[i]!, srcMux.pins[muxDef.ports[1]!]!);
    wire(parent, hlMemTemp.q[i]!, srcMux.pins[muxDef.ports[2]!]!);
    const isSetBit = buildAnd(parent, { x: pos.x - 300, y: pos.y - 6600 + i * 40 });
    wire(parent, setResCommitLabel.pins.net, isSetBit.a);
    const setY = buildAnd(parent, { x: pos.x - 250, y: pos.y - 6600 + i * 40 });
    wire(parent, isCbX3Active.out, setY.a);
    wire(parent, dec.y[i]!, setY.b);
    wire(parent, setY.out, isSetBit.b);
    const isResBit = buildAnd(parent, { x: pos.x - 300, y: pos.y - 6580 + i * 40 });
    wire(parent, setResCommitLabel.pins.net, isResBit.a);
    const resY = buildAnd(parent, { x: pos.x - 250, y: pos.y - 6580 + i * 40 });
    wire(parent, isCbX2Active.out, resY.a);
    wire(parent, dec.y[i]!, resY.b);
    wire(parent, resY.out, isResBit.b);
    const notResBit = buildNot(parent, { x: pos.x - 200, y: pos.y - 6580 + i * 40 });
    wire(parent, isResBit.out, notResBit.in);
    const cleared = buildAnd(parent, { x: pos.x - 150, y: pos.y - 6600 + i * 40 });
    wire(parent, srcMux.pins[muxDef.ports[3]!]!, cleared.a);
    wire(parent, notResBit.out, cleared.b);
    const result = buildOr(parent, { x: pos.x - 100, y: pos.y - 6600 + i * 40 });
    wire(parent, cleared.out, result.a);
    wire(parent, isSetBit.out, result.b);
    tieToLabel(`SETRESRESULT${i}`, result.out, { x: pos.x - 50, y: pos.y - 6600 + i * 40 });
  }

  // CB rotate/shift result.
  // Register form: deep tree off `bitRegByte` only.
  // (HL): `cbRotHold` captures on READ; `q` fans *only* into AND(WRITE)
  // gates (`memBit`). The deep tree reads `memBit`, never `q` directly —
  // found live: any live-`we` register fanning into this deep cone freezes
  // the phase ring, while the same `q` into a dummy AND does not.
  const cbRotHold = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 6900 });
  // Single label → we (same topology as the original CBROT_HL_READ_NOW
  // direct tie). OR of HL/IX/IY reads is produced at the decode site so
  // this pin stays one hop from a label — extra OR depth here froze or
  // starved the (HL) capture (found live after ring-10 DD CB work).
  tieToLabel('CBROT_MEM_READ_ANY', cbRotHold.we, { x: pos.x - 800, y: pos.y - 6920 });
  tieToLabel('CLK', cbRotHold.clk, { x: pos.x - 700, y: pos.y - 6940 });
  cbRotHold.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 6900 + i * 20 }));
  const memBit: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const g = buildAnd(parent, { x: pos.x - 350, y: pos.y - 7000 + i * 40 });
    wire(parent, cbRotHold.q[i]!, g.a);
    tieToLabel('CBROT_MEM_WRITE_ANY', g.b, { x: pos.x - 450, y: pos.y - 7000 + i * 40 });
    memBit.push(g.out);
  }

  const buildCbRotTree = (src: Pin[], _labelPrefix: string, xBase: number): { result: Pin[]; c: Pin } => {
    const leftY = buildOr(parent, { x: xBase - 400, y: pos.y - 6980 });
    wire(parent, dec.y[0]!, leftY.a);
    wire(parent, dec.y[2]!, leftY.b);
    const leftY2 = buildOr(parent, { x: xBase - 380, y: pos.y - 6980 });
    wire(parent, leftY.out, leftY2.a);
    wire(parent, dec.y[4]!, leftY2.b);
    const isLeft = buildOr(parent, { x: xBase - 360, y: pos.y - 6980 });
    wire(parent, leftY2.out, isLeft.a);
    wire(parent, dec.y[6]!, isLeft.b);
    const rightY = buildOr(parent, { x: xBase - 400, y: pos.y - 6960 });
    wire(parent, dec.y[1]!, rightY.a);
    wire(parent, dec.y[3]!, rightY.b);
    const rightY2 = buildOr(parent, { x: xBase - 380, y: pos.y - 6960 });
    wire(parent, rightY.out, rightY2.a);
    wire(parent, dec.y[5]!, rightY2.b);
    const isRight = buildOr(parent, { x: xBase - 360, y: pos.y - 6960 });
    wire(parent, rightY2.out, isRight.a);
    wire(parent, dec.y[7]!, isRight.b);
    const cLeft = buildAnd(parent, { x: xBase - 300, y: pos.y - 6980 });
    wire(parent, isLeft.out, cLeft.a);
    wire(parent, src[7]!, cLeft.b);
    const cRight = buildAnd(parent, { x: xBase - 300, y: pos.y - 6960 });
    wire(parent, isRight.out, cRight.a);
    wire(parent, src[0]!, cRight.b);
    const c = buildOr(parent, { x: xBase - 250, y: pos.y - 6970 });
    wire(parent, cLeft.out, c.a);
    wire(parent, cRight.out, c.b);
    const result: Pin[] = [];
    for (let i = 0; i < 8; i++) {
      const prev = src[(i + 7) % 8]!;
      const next = src[(i + 1) % 8]!;
      const rlcTerm = buildAnd(parent, { x: xBase - 200, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[0]!, rlcTerm.a);
      wire(parent, prev, rlcTerm.b);
      const rrcTerm = buildAnd(parent, { x: xBase - 180, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[1]!, rrcTerm.a);
      wire(parent, next, rrcTerm.b);
      const rlTerm = buildAnd(parent, { x: xBase - 160, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[2]!, rlTerm.a);
      wire(parent, i === 0 ? f.q[0]! : prev, rlTerm.b);
      const rrTerm = buildAnd(parent, { x: xBase - 140, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[3]!, rrTerm.a);
      wire(parent, i === 7 ? f.q[0]! : next, rrTerm.b);
      const slaTerm = buildAnd(parent, { x: xBase - 120, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[4]!, slaTerm.a);
      if (i === 0) tiePowerRail(parent, 'GND', slaTerm.b);
      else wire(parent, prev, slaTerm.b);
      const sraTerm = buildAnd(parent, { x: xBase - 100, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[5]!, sraTerm.a);
      wire(parent, i === 7 ? src[7]! : next, sraTerm.b);
      const sllTerm = buildAnd(parent, { x: xBase - 80, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[6]!, sllTerm.a);
      if (i === 0) tiePowerRail(parent, 'VCC', sllTerm.b);
      else wire(parent, prev, sllTerm.b);
      const srlTerm = buildAnd(parent, { x: xBase - 60, y: pos.y - 7100 + i * 100 });
      wire(parent, dec.y[7]!, srlTerm.a);
      if (i === 7) tiePowerRail(parent, 'GND', srlTerm.b);
      else wire(parent, next, srlTerm.b);
      const s1 = buildOr(parent, { x: xBase - 40, y: pos.y - 7100 + i * 100 });
      wire(parent, rlcTerm.out, s1.a);
      wire(parent, rrcTerm.out, s1.b);
      const s2 = buildOr(parent, { x: xBase - 20, y: pos.y - 7100 + i * 100 });
      wire(parent, rlTerm.out, s2.a);
      wire(parent, rrTerm.out, s2.b);
      const s3 = buildOr(parent, { x: xBase + 0, y: pos.y - 7100 + i * 100 });
      wire(parent, slaTerm.out, s3.a);
      wire(parent, sraTerm.out, s3.b);
      const s4 = buildOr(parent, { x: xBase + 20, y: pos.y - 7100 + i * 100 });
      wire(parent, sllTerm.out, s4.a);
      wire(parent, srlTerm.out, s4.b);
      const s5 = buildOr(parent, { x: xBase + 40, y: pos.y - 7100 + i * 100 });
      wire(parent, s1.out, s5.a);
      wire(parent, s2.out, s5.b);
      const s6 = buildOr(parent, { x: xBase + 60, y: pos.y - 7100 + i * 100 });
      wire(parent, s3.out, s6.a);
      wire(parent, s4.out, s6.b);
      const final = buildOr(parent, { x: xBase + 80, y: pos.y - 7100 + i * 100 });
      wire(parent, s5.out, final.a);
      wire(parent, s6.out, final.b);
      result.push(final.out);
    }
    return { result, c: c.out };
  };

  const regTree = buildCbRotTree(bitRegByte, 'REG', pos.x);
  // Isolate `memBit` from the HL deep tree while WRITE=0 (READ/hold.we
  // high): feed the tree grounded constants instead. Attaching the deep
  // cone to `memBit` during that window freezes the phase ring even when
  // `memBit` is itself 0.
  const hlSrc: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const m = makeChipInstance(parent, muxDef, { x: pos.x + 300, y: pos.y - 7000 + i * 40 });
    tieToLabel('CBROT_MEM_WRITE_ANY', m.pins[muxDef.ports[0]!]!, { x: pos.x + 250, y: pos.y - 7000 + i * 40 });
    tiePowerRail(parent, 'GND', m.pins[muxDef.ports[1]!]!);
    wire(parent, memBit[i]!, m.pins[muxDef.ports[2]!]!);
    hlSrc.push(m.pins[muxDef.ports[3]!]!);
  }
  const hlTree = buildCbRotTree(hlSrc, 'HL', pos.x + 400);
  const cbRotResult: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const pick = makeChipInstance(parent, muxDef, { x: pos.x + 500, y: pos.y - 7100 + i * 100 });
    wire(parent, dec.z[6]!, pick.pins[muxDef.ports[0]!]!);
    wire(parent, regTree.result[i]!, pick.pins[muxDef.ports[1]!]!);
    wire(parent, hlTree.result[i]!, pick.pins[muxDef.ports[2]!]!);
    tieToLabel(`CBROTRESULT${i}`, pick.pins[muxDef.ports[3]!]!, { x: pos.x + 550, y: pos.y - 7100 + i * 100 });
    cbRotResult.push(pick.pins[muxDef.ports[3]!]!);
  }
  const cbRotCPick = makeChipInstance(parent, muxDef, { x: pos.x + 500, y: pos.y - 6970 });
  wire(parent, dec.z[6]!, cbRotCPick.pins[muxDef.ports[0]!]!);
  wire(parent, regTree.c, cbRotCPick.pins[muxDef.ports[1]!]!);
  wire(parent, hlTree.c, cbRotCPick.pins[muxDef.ports[2]!]!);
  tieToLabel('CBROT_C', cbRotCPick.pins[muxDef.ports[3]!]!, { x: pos.x + 550, y: pos.y - 6970 });
  let cbRotZChain: Pin = cbRotResult[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 560, y: pos.y - 7100 + i * 40 });
    wire(parent, cbRotZChain, orGate.a);
    wire(parent, cbRotResult[i]!, orGate.b);
    cbRotZChain = orGate.out;
  }
  const cbRotZBit = buildNot(parent, { x: pos.x + 600, y: pos.y - 7100 });
  wire(parent, cbRotZChain, cbRotZBit.in);
  tieToLabel('CBROT_Z', cbRotZBit.out, { x: pos.x + 640, y: pos.y - 7100 });
  let cbRotPChain: Pin = cbRotResult[0]!;
  for (let i = 1; i < 8; i++) {
    const xorGate = buildXor(parent, { x: pos.x + 560, y: pos.y - 7500 + i * 40 });
    wire(parent, cbRotPChain, xorGate.a);
    wire(parent, cbRotResult[i]!, xorGate.b);
    cbRotPChain = xorGate.out;
  }
  const cbRotPBit = buildNot(parent, { x: pos.x + 600, y: pos.y - 7500 });
  wire(parent, cbRotPChain, cbRotPBit.in);
  tieToLabel('CBROT_P', cbRotPBit.out, { x: pos.x + 640, y: pos.y - 7500 });
  tieToLabel('CBROT_S', cbRotResult[7]!, { x: pos.x + 640, y: pos.y - 7480 });
  tieToLabel('CBROT_X', cbRotResult[3]!, { x: pos.x + 640, y: pos.y - 7460 });
  tieToLabel('CBROT_Y', cbRotResult[5]!, { x: pos.x + 640, y: pos.y - 7440 });

  // `(HL)`'s own commit: `PHASE3`, one phase after its own read — by now
  // `hlMemTemp` already holds the fresh value (the same one-phase-later
  // timing every earlier "read into a holding register, use it next
  // phase" shape in this file relies on) — explicitly excluding
  // `hlMemReadNow` (`PHASE2`), not bare `PHASE3`: found by applying the
  // *same* fix `LD (nn),HL`'s own live bug already taught this file —
  // `PHASE2` (RAM driving the bus for the read) and `PHASE3` (this
  // instruction's own `R8RESULT`-sourced buffer driving the bus for the
  // write-back, below) are adjacent ring positions, so the identical
  // transient bus-fight risk applies here too, pre-empted this time
  // instead of found live again.
  const isIncDecHlMemPhase3 = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 1700 });
  wire(parent, isIncDecHlMem.out, isIncDecHlMemPhase3.a);
  tieToLabel('PHASE3', isIncDecHlMemPhase3.b, { x: pos.x + 9300, y: pos.y - 1670 });
  const notHlMemReadNow = buildNot(parent, { x: pos.x + 9420, y: pos.y - 1680 });
  wire(parent, hlMemReadNow.out, notHlMemReadNow.in);
  const incDecHlMemNow = buildAnd(parent, { x: pos.x + 9440, y: pos.y - 1700 });
  wire(parent, isIncDecHlMemPhase3.out, incDecHlMemNow.a);
  wire(parent, notHlMemReadNow.out, incDecHlMemNow.b);
  tieToLabel('HLMEM_READ_NOW', hlMemReadNow.out, { x: pos.x + 9450, y: pos.y - 1650 }); // anchor — ramOeStage and RAM's own address mux (far) both read this
  tieToLabel('INCDEC_HLMEM_NOW', incDecHlMemNow.out, { x: pos.x + 9460, y: pos.y - 1700 }); // anchor — ramWe/RAM's own address mux, F's own INCDEC_R8_NOW widening, and the R8RESULT-onto-bus bank (all far) read this

  const incDecR8NowFinal = buildOr(parent, { x: pos.x + 9440, y: pos.y - 1580 });
  wire(parent, incDecR8Now.out, incDecR8NowFinal.a);
  wire(parent, incDecHlMemNow.out, incDecR8NowFinal.b);
  // DD/FD INC/DEC (IX+d)/(IY+d) PHASE7 write — same F commit as INCDEC_HLMEM.
  const incDecDdFdWrite = buildOr(parent, { x: pos.x + 9420, y: pos.y - 1560 });
  tieToLabel('DDMEM_INCDEC_WRITE_NOW', incDecDdFdWrite.a, { x: pos.x + 9320, y: pos.y - 1560 });
  tieToLabel('FDMEM_INCDEC_WRITE_NOW', incDecDdFdWrite.b, { x: pos.x + 9320, y: pos.y - 1540 });
  // DD/FD INC/DEC IXH/IXL/IYH/IYL @ PHASE4 — parallel (incDecR8Now dead under prefix).
  const incDecDdFdHl8 = buildOr(parent, { x: pos.x + 9420, y: pos.y - 1540 });
  tieToLabel('DDIX_HL8_INC_NOW', incDecDdFdHl8.a, { x: pos.x + 9320, y: pos.y - 1540 });
  tieToLabel('FDIY_HL8_INC_NOW', incDecDdFdHl8.b, { x: pos.x + 9320, y: pos.y - 1520 });
  const incDecDdFdAny = buildOr(parent, { x: pos.x + 9460, y: pos.y - 1550 });
  wire(parent, incDecDdFdWrite.out, incDecDdFdAny.a);
  wire(parent, incDecDdFdHl8.out, incDecDdFdAny.b);
  const incDecR8NowFinal2 = buildOr(parent, { x: pos.x + 9480, y: pos.y - 1570 });
  wire(parent, incDecR8NowFinal.out, incDecR8NowFinal2.a);
  wire(parent, incDecDdFdAny.out, incDecR8NowFinal2.b);
  tieToLabel('INCDEC_R8_NOW', incDecR8NowFinal2.out, { x: pos.x + 9580, y: pos.y - 1570 }); // anchor — F's own mux (far away) reads this via the label

  // One shared 8-bit adder (not seven) — its own `a` is a one-hot
  // read-select (`dec.y` is a one-hot decode, so at most one AND term per
  // bit is ever 1; OR-ing them together picks that one term, the same
  // "AND-then-OR" shape `computedFlagBit`'s own per-bit mux below already
  // uses) off REGB0-7/REGC0-7/.../REGA0-7 (already-anchored labels — see
  // `regAnchors` above), rather than seven separate adders each gated only
  // at write-back the way `spAdder`/`buildPairAdder` are: unlike those,
  // this result also feeds one shared flag computation (S/Z/P/N below), and
  // duplicating that seven times for no benefit (only one register's own
  // INC/DEC is ever active at once) is exactly the complexity this
  // composite has otherwise avoided by always-compute-gate-the-commit.
  // Under DD/FD HL8 INC, H/L select is suppressed and IXH/IXL/IYH/IYL
  // feed the adder instead (never OR H with IXH).
  const ddFdHl8IncAny = buildOr(parent, { x: pos.x + 9120, y: pos.y - 1880 });
  tieToLabel('DDIX_HL8_INC_NOW', ddFdHl8IncAny.a, { x: pos.x + 9020, y: pos.y - 1880 });
  tieToLabel('FDIY_HL8_INC_NOW', ddFdHl8IncAny.b, { x: pos.x + 9020, y: pos.y - 1860 });
  const notDdFdHl8Inc = buildNot(parent, { x: pos.x + 9160, y: pos.y - 1870 });
  wire(parent, ddFdHl8IncAny.out, notDdFdHl8Inc.in);
  const regHSel = buildAnd(parent, { x: pos.x + 9180, y: pos.y - 1860 });
  wire(parent, dec.y[4]!, regHSel.a);
  wire(parent, notDdFdHl8Inc.out, regHSel.b);
  const regLSel = buildAnd(parent, { x: pos.x + 9180, y: pos.y - 1840 });
  wire(parent, dec.y[5]!, regLSel.a);
  wire(parent, notDdFdHl8Inc.out, regLSel.b);
  const r8Select: [string, Pin][] = [
    ['REGB', dec.y[0]!],
    ['REGC', dec.y[1]!],
    ['REGD', dec.y[2]!],
    ['REGE', dec.y[3]!],
    ['REGH', regHSel.out],
    ['REGL', regLSel.out],
    ['REGA', dec.y[7]!],
    ['HLMEM', dec.y[6]!], // (HL)'s own freshly-read value, not a CPU register — see "x=00: INC (HL)/DEC (HL)/LD (HL),n" above
  ];
  // Remapped INC/DEC sources — enable labels already AND y[4]/y[5].
  const r8SelectIxIy: [string, string][] = [
    ['REGIXH', 'DDIXH_INC_NOW'],
    ['REGIXL', 'DDIXL_INC_NOW'],
    ['REGIYH', 'FDIYH_INC_NOW'],
    ['REGIYL', 'FDIYL_INC_NOW'],
  ];
  const r8Adder = buildAlu(parent, library, 8, { x: pos.x + 9600, y: pos.y - 1900 });
  tiePowerRail(parent, 'GND', r8Adder.op0);
  tiePowerRail(parent, 'GND', r8Adder.op1);
  const notIsDecR8 = buildNot(parent, { x: pos.x + 9500, y: pos.y - 1950 });
  wire(parent, isDecR8Any.out, notIsDecR8.in);
  wire(parent, notIsDecR8.out, r8Adder.cin);
  for (let i = 0; i < 8; i++) {
    let term: Pin | null = null;
    for (const [regName, y] of r8Select) {
      const and = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 1900 + i * 60 });
      tieToLabel(`${regName}${i}`, and.a, { x: pos.x + 9100, y: pos.y - 1900 + i * 60 });
      wire(parent, y, and.b);
      if (term === null) {
        term = and.out;
      } else {
        const or = buildOr(parent, { x: pos.x + 9250, y: pos.y - 1900 + i * 60 });
        wire(parent, term, or.a);
        wire(parent, and.out, or.b);
        term = or.out;
      }
    }
    for (const [regName, enLabel] of r8SelectIxIy) {
      const and = buildAnd(parent, { x: pos.x + 9280, y: pos.y - 1900 + i * 60 });
      tieToLabel(`${regName}${i}`, and.a, { x: pos.x + 9180, y: pos.y - 1900 + i * 60 });
      tieToLabel(enLabel, and.b, { x: pos.x + 9180, y: pos.y - 1880 + i * 60 });
      const or = buildOr(parent, { x: pos.x + 9320, y: pos.y - 1900 + i * 60 });
      wire(parent, term!, or.a);
      wire(parent, and.out, or.b);
      term = or.out;
    }
    wire(parent, term!, r8Adder.a[i]!);
    wire(parent, isDecR8Any.out, r8Adder.b[i]!);
    tieToLabel(`R8RESULT${i}`, r8Adder.out[i]!, { x: pos.x + 9700, y: pos.y - 1900 + i * 60 });
  }

  // Flags: S/Z/P computed fresh off r8Adder.out (mirroring the ALU group's
  // own zChain/pChain/sBit below, but for this adder, not `alu`) — N is
  // just isDecR8 itself. C is deliberately NOT computed here at all: real
  // Z80 preserves C across INC/DEC r untouched, and F's own per-bit mux
  // (below) reflects that by feeding F's *own* q[0] back as this group's
  // "computed" C instead of a freshly-derived one.
  let r8ZChain: Pin = r8Adder.out[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 9800, y: pos.y - 1900 + i * 60 });
    wire(parent, r8ZChain, orGate.a);
    wire(parent, r8Adder.out[i]!, orGate.b);
    r8ZChain = orGate.out;
  }
  const r8ZBit = buildNot(parent, { x: pos.x + 9900, y: pos.y - 1400 });
  wire(parent, r8ZChain, r8ZBit.in);
  // `INC r`/`DEC r` are purely arithmetic — real Z80 never gives this
  // family a parity variant the way the main ALU group's `AND`/`XOR`/`OR`
  // get one — so `R8_P` is unconditionally signed overflow, no mux needed
  // to pick between the two the way the main ALU group's own `pvMux`
  // (further down) has to. Same `XOR(carry into the sign bit, carry out
  // of the sign bit)` identity that mux's own `pvOverflow` uses, read off
  // `r8Adder.carries` instead of `alu.carries`.
  const r8Overflow = buildXor(parent, { x: pos.x + 9950, y: pos.y - 1400 });
  wire(parent, r8Adder.carries[6]!, r8Overflow.a);
  wire(parent, r8Adder.carries[7]!, r8Overflow.b);
  tieToLabel('R8_Z', r8ZBit.out, { x: pos.x + 9900, y: pos.y - 1350 });
  tieToLabel('R8_P', r8Overflow.out, { x: pos.x + 10000, y: pos.y - 1350 });
  tieToLabel('R8_S', r8Adder.out[7]!, { x: pos.x + 9700, y: pos.y - 1300 });
  tieToLabel('R8_N', isDecR8Any.out, { x: pos.x + 9200, y: pos.y - 1300 });
  // H (bit 4) and X/Y (bits 3/5, undocumented): real Z80 sets these fresh
  // for INC r/DEC r too, not just for the x=10 ALU group — H the identical
  // `XOR(carries[3], isSubtractLike)` idiom (`isDecR8` standing in for
  // `isSubtractLike`: INC is the "ADD" direction, DEC the "SUB" one, the
  // same +1/-1-via-adder trick `r8Adder`'s own `cin`/`b` wiring above
  // already uses), X/Y a straight mirror of the result's own bits.
  const r8HRaw = buildXor(parent, { x: pos.x + 9850, y: pos.y - 1300 });
  wire(parent, r8Adder.carries[3]!, r8HRaw.a);
  wire(parent, isDecR8Any.out, r8HRaw.b);
  tieToLabel('R8_H', r8HRaw.out, { x: pos.x + 9850, y: pos.y - 1280 });
  tieToLabel('R8_X', r8Adder.out[3]!, { x: pos.x + 9750, y: pos.y - 1260 });
  tieToLabel('R8_Y', r8Adder.out[5]!, { x: pos.x + 9800, y: pos.y - 1260 });

  const incDecBNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 1200 });
  wire(parent, incDecR8Now.out, incDecBNow.a);
  wire(parent, dec.y[0]!, incDecBNow.b);
  const incDecCNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 1150 });
  wire(parent, incDecR8Now.out, incDecCNow.a);
  wire(parent, dec.y[1]!, incDecCNow.b);
  const incDecDNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 1100 });
  wire(parent, incDecR8Now.out, incDecDNow.a);
  wire(parent, dec.y[2]!, incDecDNow.b);
  const incDecENow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 1050 });
  wire(parent, incDecR8Now.out, incDecENow.a);
  wire(parent, dec.y[3]!, incDecENow.b);
  const incDecHNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 1000 });
  wire(parent, incDecR8Now.out, incDecHNow.a);
  wire(parent, dec.y[4]!, incDecHNow.b);
  const incDecLNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 950 });
  wire(parent, incDecR8Now.out, incDecLNow.a);
  wire(parent, dec.y[5]!, incDecLNow.b);
  const incDecANow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 900 });
  wire(parent, incDecR8Now.out, incDecANow.a);
  wire(parent, dec.y[7]!, incDecANow.b);
  tieToLabel('INCDEC_B_NOW', incDecBNow.out, { x: pos.x + 9600, y: pos.y - 1200 });
  tieToLabel('INCDEC_C_NOW', incDecCNow.out, { x: pos.x + 9600, y: pos.y - 1150 });
  tieToLabel('INCDEC_D_NOW', incDecDNow.out, { x: pos.x + 9600, y: pos.y - 1100 });
  tieToLabel('INCDEC_E_NOW', incDecENow.out, { x: pos.x + 9600, y: pos.y - 1050 });
  tieToLabel('INCDEC_H_NOW', incDecHNow.out, { x: pos.x + 9600, y: pos.y - 1000 });
  tieToLabel('INCDEC_L_NOW', incDecLNow.out, { x: pos.x + 9600, y: pos.y - 950 });
  tieToLabel('INCDEC_A_NOW', incDecANow.out, { x: pos.x + 9600, y: pos.y - 900 });

  // x=00, z=6: LD r,n — this slice's first instruction that reads an
  // operand *after* its own opcode byte. See the doc comment above ("x=00,
  // z=6: LD r,n") for why this needs no new FSM phase at all: PHASE2/
  // PHASE3 (already `EXEC1`/`EXEC2` for every other group) get reused here
  // with different semantics — read the operand, then advance PC past it
  // — instead of "commit, then a no-op." `(HL)` (`y=6`, `LD (HL),n`) now
  // gets its own real write, stacked on top of the read this mechanism
  // already does — see "x=00: INC (HL)/DEC (HL)/LD (HL),n" above.
  const isLdImm8 = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 2200 });
  wire(parent, isX0Group, isLdImm8.a);
  wire(parent, dec.z[6]!, isLdImm8.b);
  const ldImm8ReadNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2200 });
  wire(parent, isLdImm8.out, ldImm8ReadNow.a);
  tieToLabel('PHASE2', ldImm8ReadNow.b, { x: pos.x + 9200, y: pos.y - 2170 });
  const ldImm8AdvanceNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2150 });
  wire(parent, isLdImm8.out, ldImm8AdvanceNow.a);
  tieToLabel('PHASE3', ldImm8AdvanceNow.b, { x: pos.x + 9200, y: pos.y - 2120 });
  tieToLabel('LDIMM8_READ_NOW', ldImm8ReadNow.out, { x: pos.x + 9400, y: pos.y - 2200 }); // anchor — ramOeStage2 (above) and every register's own commit below read this

  // `LD (HL),n`'s own immediate byte: captured off the *same* bus
  // `ldImm8ReadNow`'s own read already makes valid at `PHASE2` — a
  // *seventh* dedicated holding register (`jpTarget`'s own reasoning: the
  // bus moves on to something else before the write-back phase arrives).
  // The write-back (`ldHlNWriteNow`) fires at `PHASE3` — the same phase
  // `PC`'s own advance already uses, harmless since that advance never
  // touches RAM — but explicitly excludes `ldHlNReadNow` (`PHASE2`), not
  // bare `PHASE3`: the identical adjacent-phase bus-fight this file has
  // now hit twice (`LD (nn),HL`'s own live bug, `INC (HL)`/`DEC (HL)`'s
  // own pre-empted one above) — RAM driving the bus for the read at
  // `PHASE2`, this write's own buffer driving it right back at `PHASE3`,
  // adjacent ring positions either way.
  const ldHlNReadNow = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 2250 });
  wire(parent, ldImm8ReadNow.out, ldHlNReadNow.a);
  wire(parent, dec.y[6]!, ldHlNReadNow.b);
  const ldHlNImm = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 6400 });
  wire(parent, ldHlNReadNow.out, ldHlNImm.we);
  ldHlNImm.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 6400 + i * 20 }));
  ldHlNImm.q.forEach((q, i) => tieToLabel(`LDHLNIMM${i}`, q, { x: pos.x - 800, y: pos.y - 6380 + i * 20 })); // anchor — the write-back bus-driver bank (far) reads this
  tieToLabel('CLK', ldHlNImm.clk, { x: pos.x - 700, y: pos.y - 6420 }); // learned from jpTarget's own missing-CLK bug, several features back — checked off explicitly, every time, no exceptions
  const ldHlNWriteStage = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 2300 });
  wire(parent, ldImm8AdvanceNow.out, ldHlNWriteStage.a);
  wire(parent, dec.y[6]!, ldHlNWriteStage.b);
  const notLdHlNReadNow = buildNot(parent, { x: pos.x + 9370, y: pos.y - 2270 });
  wire(parent, ldHlNReadNow.out, notLdHlNReadNow.in);
  const ldHlNWriteNow = buildAnd(parent, { x: pos.x + 9390, y: pos.y - 2300 });
  wire(parent, ldHlNWriteStage.out, ldHlNWriteNow.a);
  wire(parent, notLdHlNReadNow.out, ldHlNWriteNow.b);
  tieToLabel('LDHLN_WRITE_NOW', ldHlNWriteNow.out, { x: pos.x + 9400, y: pos.y - 2300 }); // anchor — ramWe/RAM's own address mux (both far) and ldHlNImm's own bus-driver bank (far) read this
  tieToLabel('LDIMM8_ADVANCE_NOW', ldImm8AdvanceNow.out, { x: pos.x + 9400, y: pos.y - 2150 }); // anchor — PC's own hold/advance (far) reads this

  const ldImm8BNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2300 });
  wire(parent, ldImm8ReadNow.out, ldImm8BNow.a);
  wire(parent, dec.y[0]!, ldImm8BNow.b);
  const ldImm8CNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2250 });
  wire(parent, ldImm8ReadNow.out, ldImm8CNow.a);
  wire(parent, dec.y[1]!, ldImm8CNow.b);
  const ldImm8DNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2200 });
  wire(parent, ldImm8ReadNow.out, ldImm8DNow.a);
  wire(parent, dec.y[2]!, ldImm8DNow.b);
  const ldImm8ENow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2150 });
  wire(parent, ldImm8ReadNow.out, ldImm8ENow.a);
  wire(parent, dec.y[3]!, ldImm8ENow.b);
  const ldImm8HNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2100 });
  wire(parent, ldImm8ReadNow.out, ldImm8HNow.a);
  wire(parent, dec.y[4]!, ldImm8HNow.b);
  const ldImm8LNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2050 });
  wire(parent, ldImm8ReadNow.out, ldImm8LNow.a);
  wire(parent, dec.y[5]!, ldImm8LNow.b);
  const ldImm8ANow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2000 });
  wire(parent, ldImm8ReadNow.out, ldImm8ANow.a);
  wire(parent, dec.y[7]!, ldImm8ANow.b);
  tieToLabel('LDIMM8_B_NOW', ldImm8BNow.out, { x: pos.x + 9600, y: pos.y - 2300 });
  tieToLabel('LDIMM8_C_NOW', ldImm8CNow.out, { x: pos.x + 9600, y: pos.y - 2250 });
  tieToLabel('LDIMM8_D_NOW', ldImm8DNow.out, { x: pos.x + 9600, y: pos.y - 2200 });
  tieToLabel('LDIMM8_E_NOW', ldImm8ENow.out, { x: pos.x + 9600, y: pos.y - 2150 });
  tieToLabel('LDIMM8_H_NOW', ldImm8HNow.out, { x: pos.x + 9600, y: pos.y - 2100 });
  tieToLabel('LDIMM8_L_NOW', ldImm8LNow.out, { x: pos.x + 9600, y: pos.y - 2050 });
  tieToLabel('LDIMM8_A_NOW', ldImm8ANow.out, { x: pos.x + 9600, y: pos.y - 2000 });

  // x=00, z=1, y even (q=0): LD dd,nn — this slice's first 3-byte
  // instruction, and the reason the FSM grew a 5th and 6th phase. See the
  // doc comment above ("x=00, z=1: LD dd,nn") for the full derivation.
  // `y` odd (q=1) at this same `z` is `ADD HL,rr` (see "x=00: ADD HL,rr"
  // below) — `isLdDdNnYValid` (an `OR`-fold over `y=0,2,4,6`) excludes it
  // explicitly. Found live while wiring up `ADD HL,rr`: without this
  // check, `isLdDdNn` fired for *any* `y` at `z=1`, so its own PHASE3/
  // PHASE5 advances would have fired for `ADD HL,rr` opcodes too — no
  // register write ever committed for odd `y` (nothing downstream reads
  // those lines, so THAT half of "stays correctly inert" was true), but
  // `PC` would have silently advanced twice as far as a real 1-byte `ADD
  // HL,rr` opcode should, treating it as if it had two nonexistent
  // immediate bytes to skip. Never triggered before now because no test
  // or program byte sequence had ever actually included one of these
  // opcodes.
  const isX0Z1 = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 2650 });
  wire(parent, isX0Group, isX0Z1.a);
  wire(parent, dec.z[1]!, isX0Z1.b);
  const isLdDdNnYValid1 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 2620 });
  wire(parent, dec.y[0]!, isLdDdNnYValid1.a);
  wire(parent, dec.y[2]!, isLdDdNnYValid1.b);
  const isLdDdNnYValid2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 2610 });
  wire(parent, isLdDdNnYValid1.out, isLdDdNnYValid2.a);
  wire(parent, dec.y[4]!, isLdDdNnYValid2.b);
  const isLdDdNnYValid = buildOr(parent, { x: pos.x + 9150, y: pos.y - 2605 });
  wire(parent, isLdDdNnYValid2.out, isLdDdNnYValid.a);
  wire(parent, dec.y[6]!, isLdDdNnYValid.b);
  const isLdDdNn = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 2600 });
  wire(parent, isX0Z1.out, isLdDdNn.a);
  wire(parent, isLdDdNnYValid.out, isLdDdNn.b);
  const ldDdNnLowNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2600 });
  wire(parent, isLdDdNn.out, ldDdNnLowNow.a);
  tieToLabel('PHASE2', ldDdNnLowNow.b, { x: pos.x + 9200, y: pos.y - 2570 });
  const ldDdNnLowAdvanceNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2550 });
  wire(parent, isLdDdNn.out, ldDdNnLowAdvanceNow.a);
  tieToLabel('PHASE3', ldDdNnLowAdvanceNow.b, { x: pos.x + 9200, y: pos.y - 2520 });
  const ldDdNnHighNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2500 });
  wire(parent, isLdDdNn.out, ldDdNnHighNow.a);
  tieToLabel('PHASE4', ldDdNnHighNow.b, { x: pos.x + 9200, y: pos.y - 2470 });
  const ldDdNnHighAdvanceNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2450 });
  wire(parent, isLdDdNn.out, ldDdNnHighAdvanceNow.a);
  tieToLabel('PHASE5', ldDdNnHighAdvanceNow.b, { x: pos.x + 9200, y: pos.y - 2420 });
  tieToLabel('LDDDNN_LOW_NOW', ldDdNnLowNow.out, { x: pos.x + 9400, y: pos.y - 2600 }); // anchor — ramOeStage (far) reads this
  tieToLabel('LDDDNN_HIGH_NOW', ldDdNnHighNow.out, { x: pos.x + 9400, y: pos.y - 2500 }); // anchor — ramOeStage (far) reads this
  tieToLabel('LDDDNN_LOW_ADVANCE_NOW', ldDdNnLowAdvanceNow.out, { x: pos.x + 9400, y: pos.y - 2550 }); // anchor — PC's own hold/advance (far) reads this
  tieToLabel('LDDDNN_HIGH_ADVANCE_NOW', ldDdNnHighAdvanceNow.out, { x: pos.x + 9400, y: pos.y - 2450 }); // anchor — PC's own hold/advance (far) reads this

  // Low byte -> the low register of the pair (C/E/L), high byte -> the
  // high one (B/D/H) — the same high/low convention PUSH/POP's own byte
  // order established, and real Z80's own imm16 byte order (low byte
  // first in memory). `SP` (y=6) is deliberately excluded here — it's one
  // monolithic register, not two independently-addressable ones the way
  // `BC`/`DE`/`HL` are, and gets its own write-back mechanism entirely,
  // below (see "x=00, z=1: LD dd,nn" above for why).
  const ldDdNnLowCNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2650 });
  wire(parent, ldDdNnLowNow.out, ldDdNnLowCNow.a);
  wire(parent, dec.y[0]!, ldDdNnLowCNow.b);
  const ldDdNnLowENow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2600 });
  wire(parent, ldDdNnLowNow.out, ldDdNnLowENow.a);
  wire(parent, dec.y[2]!, ldDdNnLowENow.b);
  const ldDdNnLowLNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2550 });
  wire(parent, ldDdNnLowNow.out, ldDdNnLowLNow.a);
  wire(parent, dec.y[4]!, ldDdNnLowLNow.b);
  const ldDdNnHighBNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2500 });
  wire(parent, ldDdNnHighNow.out, ldDdNnHighBNow.a);
  wire(parent, dec.y[0]!, ldDdNnHighBNow.b);
  const ldDdNnHighDNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2450 });
  wire(parent, ldDdNnHighNow.out, ldDdNnHighDNow.a);
  wire(parent, dec.y[2]!, ldDdNnHighDNow.b);
  const ldDdNnHighHNow = buildAnd(parent, { x: pos.x + 9500, y: pos.y - 2400 });
  wire(parent, ldDdNnHighNow.out, ldDdNnHighHNow.a);
  wire(parent, dec.y[4]!, ldDdNnHighHNow.b);
  tieToLabel('LDDDNN_LOW_C_NOW', ldDdNnLowCNow.out, { x: pos.x + 9600, y: pos.y - 2650 });
  tieToLabel('LDDDNN_LOW_E_NOW', ldDdNnLowENow.out, { x: pos.x + 9600, y: pos.y - 2600 });
  tieToLabel('LDDDNN_LOW_L_NOW', ldDdNnLowLNow.out, { x: pos.x + 9600, y: pos.y - 2550 });
  tieToLabel('LDDDNN_HIGH_B_NOW', ldDdNnHighBNow.out, { x: pos.x + 9600, y: pos.y - 2500 });
  tieToLabel('LDDDNN_HIGH_D_NOW', ldDdNnHighDNow.out, { x: pos.x + 9600, y: pos.y - 2450 });
  tieToLabel('LDDDNN_HIGH_H_NOW', ldDdNnHighHNow.out, { x: pos.x + 9600, y: pos.y - 2400 });

  // x=00, z=1, y odd (q=1): ADD HL,rr (real 0x09/0x19/0x29/0x39 — BC/DE/
  // HL/SP). See the doc comment above ("x=00: ADD HL,rr") for the full
  // derivation. `y` odd (`isX0Z1` shared with `LD dd,nn`'s own `z=1`
  // check above, `isAddHlYValid` an `OR`-fold over `y=1,3,5,7`) — the
  // exact complement of `LD dd,nn`'s own even-`y` gate at this same `z`,
  // so between the two, every `y` value at `z=1` is now covered by
  // exactly one of them, none left ambiguously double-decoded.
  const isAddHlYValid1 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 2350 });
  wire(parent, dec.y[1]!, isAddHlYValid1.a);
  wire(parent, dec.y[3]!, isAddHlYValid1.b);
  const isAddHlYValid2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 2320 });
  wire(parent, isAddHlYValid1.out, isAddHlYValid2.a);
  wire(parent, dec.y[5]!, isAddHlYValid2.b);
  const isAddHlYValid = buildOr(parent, { x: pos.x + 9150, y: pos.y - 2300 });
  wire(parent, isAddHlYValid2.out, isAddHlYValid.a);
  wire(parent, dec.y[7]!, isAddHlYValid.b);
  const isAddHlRr = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 2300 });
  wire(parent, isX0Z1.out, isAddHlRr.a);
  wire(parent, isAddHlYValid.out, isAddHlRr.b);
  const addHlNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2300 });
  wire(parent, isAddHlRr.out, addHlNow.a);
  tieToLabel('PHASE2', addHlNow.b, { x: pos.x + 9250, y: pos.y - 2270 }); // single-byte opcode — the same commit phase INC r/DEC r's own incDecR8Now already uses
  tieToLabel('ADDHL_NOW', addHlNow.out, { x: pos.x + 9400, y: pos.y - 2300 }); // anchor — H's and L's own fifth write-back layer (far) and F's own C-bit mux (far) both read this

  // A genuine 16-bit ripple-carry add — `addHlAdder`, a *fourth* dedicated
  // `buildAlu` (16 bits, ADD mode, `cin` tied to `gnd`), `a` wired to
  // `HL`'s own current value (`rL.q` bits 0-7, `rH.q` bits 8-15 — the same
  // low-byte/high-byte convention every 16-bit-wide value in this file
  // uses). `b` is a 4-way one-hot select among `BC`/`DE`/`HL`/`SP`'s own
  // bits, the identical shape `r8Select` already uses for INC r/DEC r's
  // own register choice, just 16 lanes wide instead of 8. `SP` (this
  // simulator's own address-space-only register, `addrBits` wide rather
  // than a genuine 16 bits) zero-extends past `addrBits` — an unsigned
  // address, not a signed offset, so zero-extension is the correct
  // choice here, unlike `jrOffsetAdder`'s own sign-extension for a
  // genuinely signed displacement. Real Z80 leaves S/Z/P/V untouched for
  // this opcode and only updates the carry flag (H too, not tracked
  // anywhere in this project's own F register) — `cout` feeds F's own
  // C-bit mux (gated by `ADDHL_NOW`) exactly the way every other
  // C-affecting operation already does, and nothing here touches S/Z/P.
  // x=01, z=2: ADC HL,rr/SBC HL,rr (real 0xED 0x4A/0x5A/0x6A/0x7A —
  // ADC — and 0xED 0x42/0x52/0x62/0x72 — SBC — BC/DE/HL/SP) — see "x=01,
  // z=2: ADC HL,rr/SBC HL,rr" above for the full derivation. Reuses this
  // same `addHlAdder` rather than building a second 16-bit adder: `y`'s
  // own parity picks `ADC` (odd) vs `SBC` (even) — `isAddHlYValid` (built
  // just above for plain `ADD HL,rr`) is exactly "y is odd", so `SBC` is
  // simply its complement, no new parity check needed. Collides with
  // real unprefixed `LD y,D` (`x=01` is the entire `LD r,r'` table,
  // `z=2` picks `D` as the source) for every destination `y` picks.
  const isAdcSbcHlNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5400 });
  wire(parent, isEdX1Active.out, isAdcSbcHlNow.a);
  wire(parent, dec.z[2]!, isAdcSbcHlNow.b);
  tieToLabel('IS_ADCSBCHL_NOW', isAdcSbcHlNow.out, { x: pos.x - 850, y: pos.y - 5400 });
  const isAdcHlNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5420 });
  wire(parent, isAdcSbcHlNow.out, isAdcHlNow.a);
  wire(parent, isAddHlYValid.out, isAdcHlNow.b);
  tieToLabel('IS_ADCHL_NOW', isAdcHlNow.out, { x: pos.x - 800, y: pos.y - 5420 });
  const notAddHlYValid = buildNot(parent, { x: pos.x - 870, y: pos.y - 5440 });
  wire(parent, isAddHlYValid.out, notAddHlYValid.in);
  const isSbcHlNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5440 });
  wire(parent, isAdcSbcHlNow.out, isSbcHlNow.a);
  wire(parent, notAddHlYValid.out, isSbcHlNow.b);
  tieToLabel('IS_SBCHL_NOW', isSbcHlNow.out, { x: pos.x - 800, y: pos.y - 5440 }); // anchor — the shared adder's own cin/b-invert and F's own N-bit (all near) read this
  // `y>>1` picks the pair (`BC`/`DE`/`HL`/`SP`) — a different selection
  // rule than plain `ADD HL,rr`'s own exact-`y`-match (that opcode's `y`
  // is always odd, one-hot per pair already), so each pair gets its own
  // fresh 2-way `y`-fold here rather than reusing `addHlPairs`'s own
  // per-pair `y` line directly.
  const isAdcSbcHlBcNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5460 });
  const bcYFold = buildOr(parent, { x: pos.x - 950, y: pos.y - 5460 });
  wire(parent, dec.y[0]!, bcYFold.a);
  wire(parent, dec.y[1]!, bcYFold.b);
  wire(parent, isAdcSbcHlNow.out, isAdcSbcHlBcNow.a);
  wire(parent, bcYFold.out, isAdcSbcHlBcNow.b);
  const isAdcSbcHlDeNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5480 });
  const deYFold = buildOr(parent, { x: pos.x - 950, y: pos.y - 5480 });
  wire(parent, dec.y[2]!, deYFold.a);
  wire(parent, dec.y[3]!, deYFold.b);
  wire(parent, isAdcSbcHlNow.out, isAdcSbcHlDeNow.a);
  wire(parent, deYFold.out, isAdcSbcHlDeNow.b);
  const isAdcSbcHlHlNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5500 });
  const hlYFold = buildOr(parent, { x: pos.x - 950, y: pos.y - 5500 });
  wire(parent, dec.y[4]!, hlYFold.a);
  wire(parent, dec.y[5]!, hlYFold.b);
  wire(parent, isAdcSbcHlNow.out, isAdcSbcHlHlNow.a);
  wire(parent, hlYFold.out, isAdcSbcHlHlNow.b);
  const isAdcSbcHlSpNow = buildAnd(parent, { x: pos.x - 900, y: pos.y - 5520 });
  const spYFold = buildOr(parent, { x: pos.x - 950, y: pos.y - 5520 });
  wire(parent, dec.y[6]!, spYFold.a);
  wire(parent, dec.y[7]!, spYFold.b);
  wire(parent, isAdcSbcHlNow.out, isAdcSbcHlSpNow.a);
  wire(parent, spYFold.out, isAdcSbcHlSpNow.b);
  // One phase, the first available one for any `ED`-prefixed opcode —
  // the identical timing `NEG` above already establishes.
  const adcSbcHlCommitNow = buildAnd(parent, { x: pos.x - 850, y: pos.y - 5540 });
  wire(parent, isAdcSbcHlNow.out, adcSbcHlCommitNow.a);
  tieToLabel('PHASE4', adcSbcHlCommitNow.b, { x: pos.x - 950, y: pos.y - 5540 });
  tieToLabel('ADCSBCHL_COMMIT_NOW', adcSbcHlCommitNow.out, { x: pos.x - 800, y: pos.y - 5540 }); // anchor — H's/L's own sixth write-back layer and F's own we/per-bit layer (all far) read this

  const addHlAdder = buildAlu(parent, library, 16, { x: pos.x - 700, y: pos.y - 5300 });
  tiePowerRail(parent, 'GND', addHlAdder.op0);
  tiePowerRail(parent, 'GND', addHlAdder.op1);
  // `cin`: `0` for plain `ADD HL,rr`, the old `C` for `ADC HL,rr`, the
  // old `C` inverted for `SBC HL,rr` — the identical `ADC`/`SBC` recipe
  // "x=10: ADC/SBC" above already establishes for the 8-bit ALU group,
  // just reused here for the 16-bit case.
  const adcHlCin = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5320 });
  wire(parent, isAdcHlNow.out, adcHlCin.a);
  wire(parent, f.q[0]!, adcHlCin.b);
  const notOldCForSbcHl = buildNot(parent, { x: pos.x - 750, y: pos.y - 5340 });
  wire(parent, f.q[0]!, notOldCForSbcHl.in);
  const sbcHlCin = buildAnd(parent, { x: pos.x - 700, y: pos.y - 5340 });
  wire(parent, isSbcHlNow.out, sbcHlCin.a);
  wire(parent, notOldCForSbcHl.out, sbcHlCin.b);
  const addHlCinFinal = buildOr(parent, { x: pos.x - 650, y: pos.y - 5330 });
  wire(parent, adcHlCin.out, addHlCinFinal.a);
  wire(parent, sbcHlCin.out, addHlCinFinal.b);
  wire(parent, addHlCinFinal.out, addHlAdder.cin);
  const addHlBcY = buildOr(parent, { x: pos.x - 620, y: pos.y - 5360 });
  wire(parent, dec.y[1]!, addHlBcY.a);
  wire(parent, isAdcSbcHlBcNow.out, addHlBcY.b);
  const addHlDeY = buildOr(parent, { x: pos.x - 620, y: pos.y - 5370 });
  wire(parent, dec.y[3]!, addHlDeY.a);
  wire(parent, isAdcSbcHlDeNow.out, addHlDeY.b);
  const addHlHlY = buildOr(parent, { x: pos.x - 620, y: pos.y - 5380 });
  wire(parent, dec.y[5]!, addHlHlY.a);
  wire(parent, isAdcSbcHlHlNow.out, addHlHlY.b);
  const addHlSpY = buildOr(parent, { x: pos.x - 620, y: pos.y - 5390 });
  wire(parent, dec.y[7]!, addHlSpY.a);
  wire(parent, isAdcSbcHlSpNow.out, addHlSpY.b);
  // HL-pair `b` slot under DD/FD: ADD IX,IX / ADD IY,IY need IX/IY as
  // the second operand when y=5, not live HL (which must stay untouched).
  const anyIxIyAddActive = buildOr(parent, { x: pos.x - 680, y: pos.y - 5410 });
  wire(parent, isDdActive, anyIxIyAddActive.a);
  wire(parent, isFdActive, anyIxIyAddActive.b);
  const notIxIyAddActive = buildNot(parent, { x: pos.x - 660, y: pos.y - 5410 });
  wire(parent, anyIxIyAddActive.out, notIxIyAddActive.in);
  const addHlPairs: { y: Pin; lowQ: Pin[]; highQ: Pin[] | null }[] = [
    { y: addHlBcY.out, lowQ: rC.q, highQ: rB.q },
    { y: addHlDeY.out, lowQ: rE.q, highQ: rD.q },
    { y: addHlHlY.out, lowQ: rL.q, highQ: rH.q }, // remuxed per-bit below for DD/FD
    { y: addHlSpY.out, lowQ: sp.q, highQ: null }, // SP: zero-extended past addrBits, no real high byte in this simulator
  ];
  for (let i = 0; i < 16; i++) {
    // `a`: HL by default; IX under DD; IY under FD — shared adder for
    // ADD HL,rr / ADD IX,rr / ADD IY,rr (and ED ADC/SBC HL still sees HL).
    const aHl = i < 8 ? rL.q[i]! : rH.q[i - 8]!;
    const aIx = i < 8 ? rIXL.q[i]! : rIXH.q[i - 8]!;
    const aIy = i < 8 ? rIYL.q[i]! : rIYH.q[i - 8]!;
    const aHlGate = buildAnd(parent, { x: pos.x - 640, y: pos.y - 5300 + i * 60 });
    wire(parent, notIxIyAddActive.out, aHlGate.a);
    wire(parent, aHl, aHlGate.b);
    const aIxGate = buildAnd(parent, { x: pos.x - 630, y: pos.y - 5300 + i * 60 });
    wire(parent, isDdActive, aIxGate.a);
    wire(parent, aIx, aIxGate.b);
    const aIyGate = buildAnd(parent, { x: pos.x - 620, y: pos.y - 5300 + i * 60 });
    wire(parent, isFdActive, aIyGate.a);
    wire(parent, aIy, aIyGate.b);
    const aIxIy = buildOr(parent, { x: pos.x - 610, y: pos.y - 5300 + i * 60 });
    wire(parent, aIxGate.out, aIxIy.a);
    wire(parent, aIyGate.out, aIxIy.b);
    const aFinal = buildOr(parent, { x: pos.x - 600, y: pos.y - 5300 + i * 60 });
    wire(parent, aHlGate.out, aFinal.a);
    wire(parent, aIxIy.out, aFinal.b);
    wire(parent, aFinal.out, addHlAdder.a[i]!);
    let term: Pin | null = null;
    addHlPairs.forEach(({ y, lowQ, highQ }, pairIdx) => {
      let bit =
        i < 8
          ? i < lowQ.length
            ? lowQ[i]!
            : railPin(parent, 'GND', { x: pos.x - 540, y: pos.y - 5300 + i * 60 })
          : highQ === null
            ? railPin(parent, 'GND', { x: pos.x - 540, y: pos.y - 5300 + i * 60 })
            : i - 8 < highQ.length
              ? highQ[i - 8]!
              : railPin(parent, 'GND', { x: pos.x - 540, y: pos.y - 5300 + i * 60 });
      // Pair slot HL (index 2): under DD use IX, under FD use IY.
      if (pairIdx === 2) {
        const bHlGate = buildAnd(parent, { x: pos.x - 590, y: pos.y - 5300 + i * 60 });
        wire(parent, notIxIyAddActive.out, bHlGate.a);
        wire(parent, bit, bHlGate.b);
        const bIxGate = buildAnd(parent, { x: pos.x - 580, y: pos.y - 5300 + i * 60 });
        wire(parent, isDdActive, bIxGate.a);
        wire(parent, aIx, bIxGate.b);
        const bIyGate = buildAnd(parent, { x: pos.x - 570, y: pos.y - 5300 + i * 60 });
        wire(parent, isFdActive, bIyGate.a);
        wire(parent, aIy, bIyGate.b);
        const bIxIy = buildOr(parent, { x: pos.x - 560, y: pos.y - 5300 + i * 60 });
        wire(parent, bIxGate.out, bIxIy.a);
        wire(parent, bIyGate.out, bIxIy.b);
        const bFinal = buildOr(parent, { x: pos.x - 550, y: pos.y - 5300 + i * 60 });
        wire(parent, bHlGate.out, bFinal.a);
        wire(parent, bIxIy.out, bFinal.b);
        bit = bFinal.out;
      }
      const and = buildAnd(parent, { x: pos.x - 540, y: pos.y - 5300 + i * 60 });
      wire(parent, y, and.a);
      wire(parent, bit, and.b);
      if (term === null) term = and.out;
      else {
        const or = buildOr(parent, { x: pos.x - 530, y: pos.y - 5300 + i * 60 });
        wire(parent, term, or.a);
        wire(parent, and.out, or.b);
        term = or.out;
      }
    });
    // `SBC HL,rr` needs its own operand inverted too — the identical
    // "invert `b` for a real subtract" shape `bInv` already establishes
    // for the 8-bit ALU group's own `SUB`/`SBC`.
    const addHlBInv = buildXor(parent, { x: pos.x - 520, y: pos.y - 5300 + i * 60 });
    wire(parent, term!, addHlBInv.a);
    wire(parent, isSbcHlNow.out, addHlBInv.b);
    wire(parent, addHlBInv.out, addHlAdder.b[i]!);
    tieToLabel(i < 8 ? `ADDHLLO${i}` : `ADDHLHI${i - 8}`, addHlAdder.out[i]!, { x: pos.x - 500, y: pos.y - 5300 + i * 60 }); // anchor — H's/L's own fifth write-back layer (far) reads this
  }
  tieToLabel('ADDHL_C', addHlAdder.cout, { x: pos.x - 400, y: pos.y - 5300 }); // anchor — F's own C-bit mux (far) reads this

  // `ADC HL,rr`/`SBC HL,rr`'s own flags — real Z80 documents every bit.
  // Plain `ADD HL,rr` refreshes C/H/N/X/Y and holds S/Z/P/V; this pair
  // refreshes the whole byte. `S`/`Z` read
  // straight off this same adder's own 16-bit result; `H` is the
  // identical half-borrow/half-carry idiom this file's own 8-bit groups
  // already use, just at the 16-bit nibble boundary (`carries[11]`,
  // carry into bit 12, not `carries[3]`); `P/V` is the identical
  // `XOR(carries[14], carries[15])` overflow idiom, just at the 16-bit
  // sign bit; `N` is `isSbcHlNow` directly (0 for `ADC`, 1 for `SBC`);
  // `C` is `XOR(cout, isSbcHlNow)` — a fresh carry for `ADC`, a
  // borrow-inverted one for `SBC`, the same convention `cBit` already
  // establishes for the 8-bit group.
  const addHlSBit = addHlAdder.out[15]!;
  let addHlZChain: Pin = addHlAdder.out[0]!;
  for (let i = 1; i < 16; i++) {
    const orGate = buildOr(parent, { x: pos.x - 450, y: pos.y - 5200 + i * 30 });
    wire(parent, addHlZChain, orGate.a);
    wire(parent, addHlAdder.out[i]!, orGate.b);
    addHlZChain = orGate.out;
  }
  const addHlZBit = buildNot(parent, { x: pos.x - 400, y: pos.y - 4700 });
  wire(parent, addHlZChain, addHlZBit.in);
  const addHlHBitRaw = buildXor(parent, { x: pos.x - 400, y: pos.y - 4680 });
  wire(parent, addHlAdder.carries[11]!, addHlHBitRaw.a);
  wire(parent, isSbcHlNow.out, addHlHBitRaw.b);
  const addHlPvBit = buildXor(parent, { x: pos.x - 400, y: pos.y - 4660 });
  wire(parent, addHlAdder.carries[14]!, addHlPvBit.a);
  wire(parent, addHlAdder.carries[15]!, addHlPvBit.b);
  const addHlCBitFresh = buildXor(parent, { x: pos.x - 400, y: pos.y - 4640 });
  wire(parent, addHlAdder.cout, addHlCBitFresh.a);
  wire(parent, isSbcHlNow.out, addHlCBitFresh.b);
  tieToLabel('ADCSBCHL_S', addHlSBit, { x: pos.x - 350, y: pos.y - 4700 });
  tieToLabel('ADCSBCHL_Z', addHlZBit.out, { x: pos.x - 350, y: pos.y - 4680 });
  tieToLabel('ADCSBCHL_H', addHlHBitRaw.out, { x: pos.x - 350, y: pos.y - 4660 });
  // Plain ADD HL/IX/IY: H is carries[11] with no SBC invert (unlike ADCSBCHL_H).
  tieToLabel('ADDHL_H', addHlAdder.carries[11]!, { x: pos.x - 350, y: pos.y - 4650 });
  tieToLabel('ADCSBCHL_PV', addHlPvBit.out, { x: pos.x - 350, y: pos.y - 4640 });
  tieToLabel('ADCSBCHL_C', addHlCBitFresh.out, { x: pos.x - 350, y: pos.y - 4620 }); // anchor — F's own per-bit layer (far) reads this, along with the four labels just above

  // x=00, z=2: indirect loads through (BC)/(DE)/(nn) — see the doc comment
  // above ("x=00: indirect loads through (BC)/(DE)/(nn)") for the full
  // derivation. All 8 `y` values are real, valid opcodes here (no gap to
  // exclude) — `y=0..3` are single-byte, register-indirect through `BC`/
  // `DE`; `y=4..7` are 3-byte, through a freshly-read absolute `nn`.
  const isX0Z2 = buildAnd(parent, { x: pos.x + 9100, y: pos.y - 5400 });
  wire(parent, isX0Group, isX0Z2.a);
  wire(parent, dec.z[2]!, isX0Z2.b);

  // y=0..3: LD (BC),A / LD A,(BC) / LD (DE),A / LD A,(DE) — single-byte,
  // committing at PHASE2, the same commit phase INC r/DEC r's own
  // incDecR8Now already uses for a 1-byte opcode.
  const isLdBcA = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 5450 });
  wire(parent, isX0Z2.out, isLdBcA.a);
  wire(parent, dec.y[0]!, isLdBcA.b);
  const ldBcANow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5450 });
  wire(parent, isLdBcA.out, ldBcANow.a);
  tieToLabel('PHASE2', ldBcANow.b, { x: pos.x + 9150, y: pos.y - 5420 });
  const isLdABc = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 5400 });
  wire(parent, isX0Z2.out, isLdABc.a);
  wire(parent, dec.y[1]!, isLdABc.b);
  const ldABcNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5400 });
  wire(parent, isLdABc.out, ldABcNow.a);
  tieToLabel('PHASE2', ldABcNow.b, { x: pos.x + 9150, y: pos.y - 5370 });
  const isLdDeA = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 5350 });
  wire(parent, isX0Z2.out, isLdDeA.a);
  wire(parent, dec.y[2]!, isLdDeA.b);
  const ldDeANow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5350 });
  wire(parent, isLdDeA.out, ldDeANow.a);
  tieToLabel('PHASE2', ldDeANow.b, { x: pos.x + 9150, y: pos.y - 5320 });
  const isLdADe = buildAnd(parent, { x: pos.x + 9150, y: pos.y - 5300 });
  wire(parent, isX0Z2.out, isLdADe.a);
  wire(parent, dec.y[3]!, isLdADe.b);
  const ldADeNow = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5300 });
  wire(parent, isLdADe.out, ldADeNow.a);
  tieToLabel('PHASE2', ldADeNow.b, { x: pos.x + 9150, y: pos.y - 5270 });
  tieToLabel('LDBCA_NOW', ldBcANow.out, { x: pos.x + 9250, y: pos.y - 5450 }); // anchor — RAM's own we/address mux and A-onto-bus bank (far) read this
  tieToLabel('LDABC_NOW', ldABcNow.out, { x: pos.x + 9250, y: pos.y - 5400 }); // anchor — RAM's own oe/address mux (far) and isBusToA's own widening (far) read this
  tieToLabel('LDDEA_NOW', ldDeANow.out, { x: pos.x + 9250, y: pos.y - 5350 }); // anchor — RAM's own we/address mux and A-onto-bus bank (far) read this
  tieToLabel('LDADE_NOW', ldADeNow.out, { x: pos.x + 9250, y: pos.y - 5300 }); // anchor — RAM's own oe/address mux (far) and isBusToA's own widening (far) read this

  // y=4..7: LD (nn),HL / LD HL,(nn) / LD (nn),A / LD A,(nn) — 3 bytes,
  // reusing `LD dd,nn`'s exact 4-phase read-low/advance/read-high/advance
  // shape (PHASE2-5) to land a fresh absolute address in `nnAddr`, then
  // committing at PHASE6 (single-byte data: `A`) or PHASE6+PHASE7
  // (2-byte data: `HL`, low byte first) — the full 8-phase budget, no FSM
  // widening needed.
  const isNnGroupStage = buildOr(parent, { x: pos.x + 9150, y: pos.y - 5500 });
  wire(parent, dec.y[4]!, isNnGroupStage.a);
  wire(parent, dec.y[5]!, isNnGroupStage.b);
  const isNnGroupStage2 = buildOr(parent, { x: pos.x + 9150, y: pos.y - 5530 });
  wire(parent, isNnGroupStage.out, isNnGroupStage2.a);
  wire(parent, dec.y[6]!, isNnGroupStage2.b);
  const isNnGroup = buildOr(parent, { x: pos.x + 9150, y: pos.y - 5560 });
  wire(parent, isNnGroupStage2.out, isNnGroup.a);
  wire(parent, dec.y[7]!, isNnGroup.b);
  const isNnZ2 = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5500 });
  wire(parent, isX0Z2.out, isNnZ2.a);
  wire(parent, isNnGroup.out, isNnZ2.b);

  const nnReadLowNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5500 });
  wire(parent, isNnZ2.out, nnReadLowNow.a);
  tieToLabel('PHASE2', nnReadLowNow.b, { x: pos.x + 9200, y: pos.y - 5470 });
  const nnAdvanceLowNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5550 });
  wire(parent, isNnZ2.out, nnAdvanceLowNow.a);
  tieToLabel('PHASE3', nnAdvanceLowNow.b, { x: pos.x + 9200, y: pos.y - 5520 });
  const nnReadHighNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5600 });
  wire(parent, isNnZ2.out, nnReadHighNow.a);
  tieToLabel('PHASE4', nnReadHighNow.b, { x: pos.x + 9200, y: pos.y - 5570 });
  const nnAdvanceHighNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5650 });
  wire(parent, isNnZ2.out, nnAdvanceHighNow.a);
  tieToLabel('PHASE5', nnAdvanceHighNow.b, { x: pos.x + 9200, y: pos.y - 5620 });
  tieToLabel('NN_READ_LOW_NOW', nnReadLowNow.out, { x: pos.x + 9350, y: pos.y - 5500 }); // anchor — ramOeStage and nnAddr's own write-back (far) read this
  tieToLabel('NN_ADVANCE_LOW_NOW', nnAdvanceLowNow.out, { x: pos.x + 9350, y: pos.y - 5550 }); // anchor — pcHold (far) reads this
  tieToLabel('NN_READ_HIGH_NOW', nnReadHighNow.out, { x: pos.x + 9350, y: pos.y - 5600 }); // anchor — ramOeStage and nnAddr's own write-back (far) read this
  tieToLabel('NN_ADVANCE_HIGH_NOW', nnAdvanceHighNow.out, { x: pos.x + 9350, y: pos.y - 5650 }); // anchor — pcHold (far) reads this

  // `nnAddr`: identical "hold vs fresh" per-bit mux shape `jpTarget`/
  // `callTarget`/etc already use — a *fifth* dedicated `addrBits`-wide
  // holding register in this family, needed for the same reason every
  // earlier one was: `PC` is busy being the read address for `nn`'s own
  // two bytes, so the freshly-read address has to live somewhere else
  // until the data phase actually needs it.
  const nnAddr = buildRegister(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 5500 });
  const nnAddrWe = buildOr(parent, { x: pos.x - 700, y: pos.y - 5800 });
  tieToLabel('NN_READ_LOW_NOW', nnAddrWe.a, { x: pos.x - 800, y: pos.y - 5800 });
  tieToLabel('NN_READ_HIGH_NOW', nnAddrWe.b, { x: pos.x - 800, y: pos.y - 5770 });
  const nnAddrWe2 = buildOr(parent, { x: pos.x - 700, y: pos.y - 5740 });
  wire(parent, nnAddrWe.out, nnAddrWe2.a);
  tieToLabel('EDNN_IMM_LOW_NOW', nnAddrWe2.b, { x: pos.x - 800, y: pos.y - 5740 });
  const nnAddrWe3 = buildOr(parent, { x: pos.x - 700, y: pos.y - 5710 });
  wire(parent, nnAddrWe2.out, nnAddrWe3.a);
  tieToLabel('EDNN_IMM_HIGH_NOW', nnAddrWe3.b, { x: pos.x - 800, y: pos.y - 5710 });
  wire(parent, nnAddrWe3.out, nnAddr.we);
  // Hold-select for each half: unprefixed high-read OR ED high-read (and
  // symmetrically for the low half) — either path writing the other half
  // must hold this one.
  const nnAddrHoldHigh = buildOr(parent, { x: pos.x - 800, y: pos.y - 5680 });
  tieToLabel('NN_READ_HIGH_NOW', nnAddrHoldHigh.a, { x: pos.x - 900, y: pos.y - 5680 });
  tieToLabel('EDNN_IMM_HIGH_NOW', nnAddrHoldHigh.b, { x: pos.x - 900, y: pos.y - 5660 });
  tieToLabel('NNADDR_HOLD_HIGH', nnAddrHoldHigh.out, { x: pos.x - 750, y: pos.y - 5680 });
  const nnAddrHoldLow = buildOr(parent, { x: pos.x - 800, y: pos.y - 5640 });
  tieToLabel('NN_READ_LOW_NOW', nnAddrHoldLow.a, { x: pos.x - 900, y: pos.y - 5640 });
  tieToLabel('EDNN_IMM_LOW_NOW', nnAddrHoldLow.b, { x: pos.x - 900, y: pos.y - 5620 });
  tieToLabel('NNADDR_HOLD_LOW', nnAddrHoldLow.out, { x: pos.x - 750, y: pos.y - 5640 });
  nnAddr.q.forEach((q, i) => {
    const freshMux = makeChipInstance(parent, muxDef, { x: pos.x - 700, y: pos.y - 5600 - i * 100 });
    if (i < 8) {
      tieToLabel('NNADDR_HOLD_HIGH', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 5600 - i * 100 }); // sel=1 (high phase): hold
      tieToLabel(`BUS${i}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 5580 - i * 100 }); // in0 (low phase): the fresh low byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (high phase): hold — self-loop
    } else {
      tieToLabel('NNADDR_HOLD_LOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 5600 - i * 100 }); // sel=1 (low phase): hold
      tieToLabel(`BUS${i - 8}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 5580 - i * 100 }); // in0 (high phase): the fresh high byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (low phase): hold — self-loop
    }
    wire(parent, freshMux.pins[muxDef.ports[3]!]!, nnAddr.d[i]!);
  });
  tieToLabel('CLK', nnAddr.clk, { x: pos.x - 700, y: pos.y - 5820 }); // learned from jpTarget's own missing-CLK bug, several features back — checked off explicitly, every time, no exceptions

  // `nnAddrPlusOne`: a *fifth* dedicated `buildAlu` (`addrBits` wide,
  // `spAdder`'s own "b=all-0s, cin=vcc" +1 encoding — the mirror image of
  // `djnzAdder`'s own -1), computed unconditionally off `nnAddr.q` —
  // `LD (nn),HL`/`LD HL,(nn)` need the address one past `nn` for `HL`'s
  // own high byte, real Z80's own low-byte-first-at-nn convention.
  const nnAddrPlusOne = buildAlu(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 6000 });
  tiePowerRail(parent, 'GND', nnAddrPlusOne.op0);
  tiePowerRail(parent, 'GND', nnAddrPlusOne.op1);
  tiePowerRail(parent, 'VCC', nnAddrPlusOne.cin);
  nnAddr.q.forEach((q, i) => {
    wire(parent, q, nnAddrPlusOne.a[i]!);
    tiePowerRail(parent, 'GND', nnAddrPlusOne.b[i]!);
  });

  const isLdNnHl = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5700 });
  wire(parent, isNnZ2.out, isLdNnHl.a);
  wire(parent, dec.y[4]!, isLdNnHl.b);
  const ldNnHlLowNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5700 });
  wire(parent, isLdNnHl.out, ldNnHlLowNow.a);
  tieToLabel('PHASE6', ldNnHlLowNow.b, { x: pos.x + 9200, y: pos.y - 5670 });
  // `ldNnHlHighNow` explicitly excludes `ldNnHlLowNow` (not bare PHASE7) —
  // found live, via a temporary debug build (standalone script, `X_DEBUG_*`
  // labels, since removed): PHASE6/PHASE7 are adjacent ring positions, so
  // the ring counter's own transient rotation artifact (both bits briefly
  // reading 1 in the same relaxation pass — the identical phenomenon
  // `pushLowNow`'s own exclusion of `pushHighNow` already documents)
  // let L-onto-bus and H-onto-bus (two DIFFERENT drivers on the SAME
  // shared bus, the first time this file has ever put two on adjacent
  // phases) both assert during that transient — a real bus fight that
  // cascaded into contention severe enough to corrupt completely
  // unrelated nets, including ones with no RAM/HL involvement at all
  // (exactly the failure mode this file's own `ramOe`/`hlNow` doc comment
  // already warned about). The fix mirrors `pushLowNow`'s own shape
  // exactly: the *later*-executing signal excludes the *earlier* one.
  const notLdNnHlLowNow = buildNot(parent, { x: pos.x + 9280, y: pos.y - 5730 });
  wire(parent, ldNnHlLowNow.out, notLdNnHlLowNow.in);
  const ldNnHlHighStage = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5750 });
  wire(parent, isLdNnHl.out, ldNnHlHighStage.a);
  tieToLabel('PHASE7', ldNnHlHighStage.b, { x: pos.x + 9200, y: pos.y - 5720 });
  const ldNnHlHighNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 5750 });
  wire(parent, ldNnHlHighStage.out, ldNnHlHighNow.a);
  wire(parent, notLdNnHlLowNow.out, ldNnHlHighNow.b);

  const isLdHlNn = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5800 });
  wire(parent, isNnZ2.out, isLdHlNn.a);
  wire(parent, dec.y[5]!, isLdHlNn.b);
  const ldHlNnLowNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5800 });
  wire(parent, isLdHlNn.out, ldHlNnLowNow.a);
  tieToLabel('PHASE6', ldHlNnLowNow.b, { x: pos.x + 9200, y: pos.y - 5770 });
  const ldHlNnHighNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5850 });
  wire(parent, isLdHlNn.out, ldHlNnHighNow.a);
  tieToLabel('PHASE7', ldHlNnHighNow.b, { x: pos.x + 9200, y: pos.y - 5820 });

  const isLdNnA = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5900 });
  wire(parent, isNnZ2.out, isLdNnA.a);
  wire(parent, dec.y[6]!, isLdNnA.b);
  const ldNnANow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5900 });
  wire(parent, isLdNnA.out, ldNnANow.a);
  tieToLabel('PHASE6', ldNnANow.b, { x: pos.x + 9200, y: pos.y - 5870 });

  const isLdANn = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 5950 });
  wire(parent, isNnZ2.out, isLdANn.a);
  wire(parent, dec.y[7]!, isLdANn.b);
  const ldANnNow = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 5950 });
  wire(parent, isLdANn.out, ldANnNow.a);
  tieToLabel('PHASE6', ldANnNow.b, { x: pos.x + 9200, y: pos.y - 5920 });

  tieToLabel('LDNNHL_LOW_NOW', ldNnHlLowNow.out, { x: pos.x + 9350, y: pos.y - 5700 }); // anchor — RAM's own we/address mux and L-onto-bus bank (far) read this
  tieToLabel('LDNNHL_HIGH_NOW', ldNnHlHighNow.out, { x: pos.x + 9350, y: pos.y - 5750 }); // anchor — RAM's own we/address mux and H-onto-bus bank (far) read this
  tieToLabel('LDHLNN_LOW_NOW', ldHlNnLowNow.out, { x: pos.x + 9350, y: pos.y - 5800 }); // anchor — RAM's own oe/address mux and L's own write-back (far) read this
  tieToLabel('LDHLNN_HIGH_NOW', ldHlNnHighNow.out, { x: pos.x + 9350, y: pos.y - 5850 }); // anchor — RAM's own oe/address mux and H's own write-back (far) read this
  tieToLabel('LDNNA_NOW', ldNnANow.out, { x: pos.x + 9350, y: pos.y - 5900 }); // anchor — RAM's own we/address mux and A-onto-bus bank (far) read this
  tieToLabel('LDANN_NOW', ldANnNow.out, { x: pos.x + 9350, y: pos.y - 5950 }); // anchor — RAM's own oe/address mux (far) and isBusToA's own widening (far) read this

  // RAM's own address-mux select signals for the indirect-load group (see
  // "x=00: indirect loads through (BC)/(DE)/(nn)" above): each is an
  // `OR`-fold over every phase that needs that particular address source,
  // read by the far-away `bcMux`/`deMux`/`nnLowMux`/`nnHighMux` override
  // layers via the label, not a ~9000-unit wire.
  const isBcAddrNow = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6050 });
  wire(parent, ldBcANow.out, isBcAddrNow.a);
  wire(parent, ldABcNow.out, isBcAddrNow.b);
  tieToLabel('LDBC_ADDR_NOW', isBcAddrNow.out, { x: pos.x + 9400, y: pos.y - 6050 });
  const isDeAddrNow = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6100 });
  wire(parent, ldDeANow.out, isDeAddrNow.a);
  wire(parent, ldADeNow.out, isDeAddrNow.b);
  tieToLabel('LDDE_ADDR_NOW', isDeAddrNow.out, { x: pos.x + 9400, y: pos.y - 6100 });
  const isNnDataAddrStage1 = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6150 });
  wire(parent, ldNnANow.out, isNnDataAddrStage1.a);
  wire(parent, ldANnNow.out, isNnDataAddrStage1.b);
  const isNnDataAddrStage2 = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6200 });
  wire(parent, isNnDataAddrStage1.out, isNnDataAddrStage2.a);
  wire(parent, ldNnHlLowNow.out, isNnDataAddrStage2.b);
  const isNnDataAddrStage3 = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6225 });
  wire(parent, isNnDataAddrStage2.out, isNnDataAddrStage3.a);
  wire(parent, ldHlNnLowNow.out, isNnDataAddrStage3.b);
  // ED LD (nn),dd / LD dd,(nn) data-low phase (see "x=01, z=3: LD (nn),dd")
  // — same nnAddr, whether writing or reading.
  const isNnDataAddrNow = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6250 });
  wire(parent, isNnDataAddrStage3.out, isNnDataAddrNow.a);
  tieToLabel('EDNN_DATA_LOW_NOW', isNnDataAddrNow.b, { x: pos.x + 9200, y: pos.y - 6250 });
  tieToLabel('NN_DATA_ADDR_NOW', isNnDataAddrNow.out, { x: pos.x + 9400, y: pos.y - 6250 });
  const isNnDataAddrPlusOneNow = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6300 });
  wire(parent, ldNnHlHighNow.out, isNnDataAddrPlusOneNow.a);
  wire(parent, ldHlNnHighNow.out, isNnDataAddrPlusOneNow.b);
  const isNnDataAddrPlusOneNow2 = buildOr(parent, { x: pos.x + 9300, y: pos.y - 6325 });
  wire(parent, isNnDataAddrPlusOneNow.out, isNnDataAddrPlusOneNow2.a);
  tieToLabel('EDNN_DATA_HIGH_NOW', isNnDataAddrPlusOneNow2.b, { x: pos.x + 9200, y: pos.y - 6325 });
  tieToLabel('NN_DATA_ADDR_PLUS_ONE_NOW', isNnDataAddrPlusOneNow2.out, { x: pos.x + 9400, y: pos.y - 6300 });

  // x=11: PUSH rp / POP rp / RET / RST n — see the doc comment above
  // ("x=11: SP, PUSH/POP, RET, RST n") for the full derivation. `rawStackGroup`
  // itself (bare `dec.x[3]`) was built way up with the CB/ED/DD/FD prefix
  // detection, which needs the *unexcluded* signal (see that doc comment
  // for why); `isStackGroup` here is the excluded one every real x=11
  // feature below reads, the same "AND with NOT_PREFIX_ACTIVE" treatment
  // `isX0Group`/`isLdGroup`/`isAluGroup` already got.
  const isStackGroupGate = buildAnd(parent, { x: pos.x + 9350, y: pos.y - 6350 });
  wire(parent, rawStackGroup, isStackGroupGate.a);
  tieToLabel('NOT_PREFIX_ACTIVE', isStackGroupGate.b, { x: pos.x + 9250, y: pos.y - 6350 });
  const isStackGroup = isStackGroupGate.out;
  const execPhaseActive = buildOr(parent, { x: pos.x + 9700, y: pos.y + 500 });
  tieToLabel('PHASE2', execPhaseActive.a, { x: pos.x + 9600, y: pos.y + 500 });
  tieToLabel('PHASE3', execPhaseActive.b, { x: pos.x + 9600, y: pos.y + 530 });

  // PUSH rp: z=101, valid only for y=000,010,100,110 (BC/DE/HL/AF) — the
  // rest of this z-column is CALL nn (y=001, implemented) and the DD/ED/FD
  // prefix bytes (y=011,101,111, detected above but never reaching PUSH's
  // own logic — see "CB/ED/DD/FD prefix bytes"); excluding the latter here
  // keeps this PUSH-specific decode from misfiring on them, same as it
  // always did before the prefix bytes had any meaning of their own.
  const pushValid1 = buildOr(parent, { x: pos.x + 9700, y: pos.y + 650 });
  wire(parent, dec.y[0]!, pushValid1.a);
  wire(parent, dec.y[2]!, pushValid1.b);
  const pushValid2 = buildOr(parent, { x: pos.x + 9700, y: pos.y + 700 });
  wire(parent, pushValid1.out, pushValid2.a);
  wire(parent, dec.y[4]!, pushValid2.b);
  const isPushValid = buildOr(parent, { x: pos.x + 9700, y: pos.y + 750 });
  wire(parent, pushValid2.out, isPushValid.a);
  wire(parent, dec.y[6]!, isPushValid.b);
  const isPushZ = buildAnd(parent, { x: pos.x + 9750, y: pos.y + 650 });
  wire(parent, isStackGroup, isPushZ.a);
  wire(parent, dec.z[5]!, isPushZ.b);
  const isPush = buildAnd(parent, { x: pos.x + 9800, y: pos.y + 650 });
  wire(parent, isPushZ.out, isPush.a);
  wire(parent, isPushValid.out, isPush.b);

  // POP rp / RET share z=001 — y=000,010,100,110 is POP, y=001 is RET.
  // y=011/101/111 are EXX / JP (HL) / LD SP,HL (implemented separately;
  // this stack-read decode deliberately excludes them).
  const readValid1 = buildOr(parent, { x: pos.x + 9700, y: pos.y + 850 });
  wire(parent, dec.y[0]!, readValid1.a);
  wire(parent, dec.y[1]!, readValid1.b);
  const readValid2 = buildOr(parent, { x: pos.x + 9700, y: pos.y + 900 });
  wire(parent, readValid1.out, readValid2.a);
  wire(parent, dec.y[2]!, readValid2.b);
  const readValid3 = buildOr(parent, { x: pos.x + 9700, y: pos.y + 950 });
  wire(parent, readValid2.out, readValid3.a);
  wire(parent, dec.y[4]!, readValid3.b);
  const isStackReadValid = buildOr(parent, { x: pos.x + 9700, y: pos.y + 1000 });
  wire(parent, readValid3.out, isStackReadValid.a);
  wire(parent, dec.y[6]!, isStackReadValid.b);
  const isStackReadZ = buildAnd(parent, { x: pos.x + 9750, y: pos.y + 850 });
  wire(parent, isStackGroup, isStackReadZ.a);
  wire(parent, dec.z[1]!, isStackReadZ.b);
  const isStackRead = buildAnd(parent, { x: pos.x + 9800, y: pos.y + 850 });
  wire(parent, isStackReadZ.out, isStackRead.a);
  wire(parent, isStackReadValid.out, isStackRead.b);

  const isRet = buildAnd(parent, { x: pos.x + 9900, y: pos.y + 850 });
  wire(parent, isStackRead.out, isRet.a);
  wire(parent, dec.y[1]!, isRet.b);
  const notIsRet = buildNot(parent, { x: pos.x + 9900, y: pos.y + 900 });
  wire(parent, isRet.out, notIsRet.in);
  const isPop = buildAnd(parent, { x: pos.x + 10000, y: pos.y + 850 });
  wire(parent, isStackRead.out, isPop.a);
  wire(parent, notIsRet.out, isPop.b);

  // RST n: z=111, every y is a real (fixed) target — no reserved slot.
  const isRst = buildAnd(parent, { x: pos.x + 9800, y: pos.y + 1100 });
  wire(parent, isStackGroup, isRst.a);
  wire(parent, dec.z[7]!, isRst.b);

  // x=11, z=6: ALU op A,n (real 0xC6/0xCE/0xD6/0xDE/0xE6/0xEE/0xF6/0xFE —
  // see "x=11: ALU op A,n" below) — the identical `PHASE2`-read/`PHASE3`-
  // advance shape `LD r,n`'s own `isLdImm8`/`ldImm8ReadNow`/
  // `ldImm8AdvanceNow` above already established, just gated by `x=11`
  // instead of `x=00`.
  const isAluImm8 = buildAnd(parent, { x: pos.x + 9200, y: pos.y + 1300 });
  wire(parent, isStackGroup, isAluImm8.a);
  wire(parent, dec.z[6]!, isAluImm8.b);
  const aluImm8ReadNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y + 1300 });
  wire(parent, isAluImm8.out, aluImm8ReadNow.a);
  tieToLabel('PHASE2', aluImm8ReadNow.b, { x: pos.x + 9200, y: pos.y + 1330 });
  tieToLabel('ALUIMM8_READ_NOW', aluImm8ReadNow.out, { x: pos.x + 9400, y: pos.y + 1300 }); // anchor — ramOeStage (far) reads this via the label; the ALU group's own commit-gate widening (aluAnyGroupNow, right below) reads aluImm8ReadNow directly, same scope, no label needed
  const aluImm8AdvanceNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y + 1350 });
  wire(parent, isAluImm8.out, aluImm8AdvanceNow.a);
  tieToLabel('PHASE3', aluImm8AdvanceNow.b, { x: pos.x + 9200, y: pos.y + 1380 });
  tieToLabel('ALUIMM8_ADVANCE_NOW', aluImm8AdvanceNow.out, { x: pos.x + 9400, y: pos.y + 1350 }); // anchor — pcHold (far) reads this

  // `A`/`F`'s own commit for ALU op A,n (see "x=11: ALU op A,n" above)
  // reuses `x=10`'s entire ALU-group machinery unchanged: `alu.op0`/`op1`/
  // `cin`/`bInv` are keyed on `dec.y` alone, never `dec.x` (see the doc
  // comment above, "x=10: ADC/SBC") — z=6's own y values encode the exact
  // same eight operations x=10's own y does — so `alu.out`/`alu.cout` are
  // *already* correct the instant `aluImm8ReadNow` puts the immediate byte
  // on the bus for `bInv` to read, with zero new op-select wiring. Only
  // the *commit* gate (`aWe`/`fWe`/`F`'s own `baseMux` sel) needs widening
  // — `aluGroupNow` alone would leave this opcode decoded but silently
  // inert, same shape ADC/SBC needed before a carry flag existed to route.
  // `groupActive` (the *register*-operand bus enable) deliberately stays
  // narrow — there is no register operand here, the bus is already
  // correctly driven by RAM instead.
  const aluAnyGroupNowStage = buildOr(parent, { x: pos.x + 9350, y: pos.y + 1250 });
  wire(parent, aluGroupNow.out, aluAnyGroupNowStage.a);
  wire(parent, aluImm8ReadNow.out, aluAnyGroupNowStage.b);
  // DD/FD ALU A,(IX+d)/(IY+d) PHASE6 + ALU A,IXH/IXL/IYH/IYL PHASE4 —
  // parallel commit (aluGroupNow dead under prefix).
  const aluDdFdMemNow = buildOr(parent, { x: pos.x + 9330, y: pos.y + 1270 });
  tieToLabel('DDMEM_ALU_NOW', aluDdFdMemNow.a, { x: pos.x + 9230, y: pos.y + 1270 });
  tieToLabel('FDMEM_ALU_NOW', aluDdFdMemNow.b, { x: pos.x + 9230, y: pos.y + 1290 });
  const aluDdFdHl8Now = buildOr(parent, { x: pos.x + 9330, y: pos.y + 1290 });
  tieToLabel('DDIX_HL8_ALU_NOW', aluDdFdHl8Now.a, { x: pos.x + 9230, y: pos.y + 1290 });
  tieToLabel('FDIY_HL8_ALU_NOW', aluDdFdHl8Now.b, { x: pos.x + 9230, y: pos.y + 1310 });
  const aluDdFdAnyNow = buildOr(parent, { x: pos.x + 9370, y: pos.y + 1280 });
  wire(parent, aluDdFdMemNow.out, aluDdFdAnyNow.a);
  wire(parent, aluDdFdHl8Now.out, aluDdFdAnyNow.b);
  const aluAnyGroupNow = buildOr(parent, { x: pos.x + 9400, y: pos.y + 1260 });
  wire(parent, aluAnyGroupNowStage.out, aluAnyGroupNow.a);
  wire(parent, aluDdFdAnyNow.out, aluAnyGroupNow.b);

  const pushNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y + 650 });
  wire(parent, isPush.out, pushNow.a);
  wire(parent, execPhaseActive.out, pushNow.b);
  // POP's own 2 register bytes need both EXEC1 and EXEC2, same as PUSH —
  // but RET, despite sharing isStackRead/z=1 with POP, is single-cycle for
  // the identical reason RST is (PC fits in one stack byte here): without
  // this split, RET's own PC-capture and SP-increment would fire a SECOND,
  // spurious time during EXEC2, off a since-incremented (wrong) address.
  const popReadNow = buildAnd(parent, { x: pos.x + 10050, y: pos.y + 800 });
  wire(parent, isPop.out, popReadNow.a);
  wire(parent, execPhaseActive.out, popReadNow.b);
  const retNow = buildAnd(parent, { x: pos.x + 10050, y: pos.y + 900 });
  wire(parent, isRet.out, retNow.a);
  tieToLabel('PHASE2', retNow.b, { x: pos.x + 9950, y: pos.y + 900 });
  // popReadNow OR retNow — widened further below (see "x=11: RET cc") once
  // `RET cc`'s own conditional pop signal exists; that widening needs
  // `conditionTrue`, itself only built later inside "x=11: JP cc,nn", so
  // the *final* `readNow` const lives down there, not here. RETI (ED 0x4D)
  // joins here as a fourth pop source — same SP+/PC-from-bus shape as RET.
  const readNowStage = buildOr(parent, { x: pos.x + 10100, y: pos.y + 850 });
  wire(parent, popReadNow.out, readNowStage.a);
  wire(parent, retNow.out, readNowStage.b);
  const readNowStageReti = buildOr(parent, { x: pos.x + 10150, y: pos.y + 850 });
  wire(parent, readNowStage.out, readNowStageReti.a);
  tieToLabel('RETI_OR_RETN_NOW', readNowStageReti.b, { x: pos.x + 10050, y: pos.y + 850 });
  const retOrRetiNow = buildOr(parent, { x: pos.x + 10100, y: pos.y + 920 });
  wire(parent, retNow.out, retOrRetiNow.a);
  tieToLabel('RETI_OR_RETN_NOW', retOrRetiNow.b, { x: pos.x + 10000, y: pos.y + 920 });
  tieToLabel('RET_OR_RETI_NOW', retOrRetiNow.out, { x: pos.x + 10200, y: pos.y + 920 }); // anchor — PC's own retMux (far)
  // RST pushes PC on EXEC1, then jumps to its fixed target on EXEC2 — NOT
  // both on the same edge. First version did both on EXEC1: the push-data
  // driver (below) reads `pc.q` combinationally, and RAM's write (like any
  // write in this design, per the addressing doc comment above) samples
  // it fully settled — by which point PC had *already* jumped, on that
  // same edge, to the RST target. RAM ended up with the *target* address
  // pushed, not the return address; a subsequent RET landed back at the
  // RST target instead of resuming after it. Splitting the push (EXEC1,
  // `rstNow`) from the jump (EXEC2, `rstJumpNow`) gives PC's own capture a
  // clean edge that nothing else is racing.
  const rstNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y + 1100 });
  wire(parent, isRst.out, rstNow.a);
  tieToLabel('PHASE2', rstNow.b, { x: pos.x + 9800, y: pos.y + 1100 });
  const rstJumpNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y + 1200 });
  wire(parent, isRst.out, rstJumpNow.a);
  tieToLabel('PHASE3', rstJumpNow.b, { x: pos.x + 9800, y: pos.y + 1200 });

  // JP nn: z=3, y=0 (real 0xC3) — see the doc comment above ("x=11: JP nn")
  // for the full derivation. z=3's other y values that this slice owns
  // (EX (SP),HL, EX DE,HL, OUT (n),A, IN A,(n), and the CB prefix detect)
  // are implemented elsewhere; DI/EI (y=6/7) now drive IFF1/IFF2 (thin
  // IM1 IRQ). Reuses `LD dd,nn`'s exact read-low/advance/read-high phase
  // shape (PHASE2-4) — the difference is entirely in PHASE5: `LD dd,nn`
  // advances `PC` a third time there, `JP nn` *overwrites* it with the
  // freshly-read target instead, so PHASE5 is deliberately left OUT of
  // `pcHold`'s own OR-chain for this instruction (unlike
  // `LDDDNN_HIGH_ADVANCE_NOW`, which *is* PHASE5-gated, but only fires
  // for `LD dd,nn`'s own opcode — one-hot `dec.z` keeps the two from
  // ever overlapping).
  const isX11Z3 = buildAnd(parent, { x: pos.x + 9200, y: pos.y - 2900 });
  wire(parent, isStackGroup, isX11Z3.a);
  wire(parent, dec.z[3]!, isX11Z3.b);
  const isDi = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 2980 });
  wire(parent, isX11Z3.out, isDi.a);
  wire(parent, dec.y[6]!, isDi.b);
  const diNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2980 });
  wire(parent, isDi.out, diNow.a);
  tieToLabel('PHASE2', diNow.b, { x: pos.x + 9200, y: pos.y - 2960 });
  tieToLabel('DI_NOW', diNow.out, { x: pos.x + 9400, y: pos.y - 2980 }); // anchor — IFF1/IFF2 clear
  const isEi = buildAnd(parent, { x: pos.x + 9250, y: pos.y - 3010 });
  wire(parent, isX11Z3.out, isEi.a);
  wire(parent, dec.y[7]!, isEi.b);
  const eiNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 3010 });
  wire(parent, isEi.out, eiNow.a);
  tieToLabel('PHASE2', eiNow.b, { x: pos.x + 9200, y: pos.y - 2990 });
  tieToLabel('EI_NOW', eiNow.out, { x: pos.x + 9400, y: pos.y - 3010 }); // anchor — eiArm1 set (IFF via EI_COMMIT)
  const isJpNn = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 2900 });
  wire(parent, isX11Z3.out, isJpNn.a);
  wire(parent, dec.y[0]!, isJpNn.b);
  const jpReadLowNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 2900 });
  wire(parent, isJpNn.out, jpReadLowNow.a);
  tieToLabel('PHASE2', jpReadLowNow.b, { x: pos.x + 9350, y: pos.y - 2870 });
  const jpAdvanceNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 2850 });
  wire(parent, isJpNn.out, jpAdvanceNow.a);
  tieToLabel('PHASE3', jpAdvanceNow.b, { x: pos.x + 9350, y: pos.y - 2820 });
  const jpReadHighNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 2800 });
  wire(parent, isJpNn.out, jpReadHighNow.a);
  tieToLabel('PHASE4', jpReadHighNow.b, { x: pos.x + 9350, y: pos.y - 2770 });
  const jpJumpNow = buildAnd(parent, { x: pos.x + 9400, y: pos.y - 2750 });
  wire(parent, isJpNn.out, jpJumpNow.a);
  tieToLabel('PHASE5', jpJumpNow.b, { x: pos.x + 9350, y: pos.y - 2720 });
  tieToLabel('JP_READ_LOW_NOW', jpReadLowNow.out, { x: pos.x + 9500, y: pos.y - 2900 }); // anchor — ramOeStage (far) and jpTarget's own write-back (far) read this
  tieToLabel('JP_ADVANCE_NOW', jpAdvanceNow.out, { x: pos.x + 9500, y: pos.y - 2850 }); // anchor — pcHold (far) reads this
  tieToLabel('JP_READ_HIGH_NOW', jpReadHighNow.out, { x: pos.x + 9500, y: pos.y - 2800 }); // anchor — ramOeStage (far) and jpTarget's own write-back (far) read this
  tieToLabel('JP_JUMP_NOW', jpJumpNow.out, { x: pos.x + 9500, y: pos.y - 2750 }); // anchor — PC's own jpMux (far) reads this

  // CALL nn: z=5, y=1 (real 0xCD) — the odd `y` at this `z`, `PUSH`'s own
  // z=5 valid set (`isPushValid` above) only covers the even ones. See the
  // doc comment above ("x=11: CALL nn") for the full derivation, including
  // why this needs a *seventh* and *eighth* phase (`isPushZ` — `x=11`,
  // `z=5` — is already built above; reused directly rather than
  // recomputed).
  const isCallNn = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 3200 });
  wire(parent, isPushZ.out, isCallNn.a);
  wire(parent, dec.y[1]!, isCallNn.b);
  const callReadLowNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3200 });
  wire(parent, isCallNn.out, callReadLowNow.a);
  tieToLabel('PHASE2', callReadLowNow.b, { x: pos.x + 9750, y: pos.y - 3170 });
  const callAdvanceLowNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3150 });
  wire(parent, isCallNn.out, callAdvanceLowNow.a);
  tieToLabel('PHASE3', callAdvanceLowNow.b, { x: pos.x + 9750, y: pos.y - 3120 });
  const callReadHighNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3100 });
  wire(parent, isCallNn.out, callReadHighNow.a);
  tieToLabel('PHASE4', callReadHighNow.b, { x: pos.x + 9750, y: pos.y - 3070 });
  const callAdvanceHighNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3050 });
  wire(parent, isCallNn.out, callAdvanceHighNow.a);
  tieToLabel('PHASE5', callAdvanceHighNow.b, { x: pos.x + 9750, y: pos.y - 3020 });
  const callPushNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3000 });
  wire(parent, isCallNn.out, callPushNow.a);
  tieToLabel('PHASE6', callPushNow.b, { x: pos.x + 9750, y: pos.y - 2970 });
  const callJumpNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 2950 });
  wire(parent, isCallNn.out, callJumpNow.a);
  tieToLabel('PHASE7', callJumpNow.b, { x: pos.x + 9750, y: pos.y - 2920 });
  tieToLabel('CALL_READ_LOW_NOW', callReadLowNow.out, { x: pos.x + 9900, y: pos.y - 3200 }); // anchor — ramOeStage and callTarget's own write-back (far) read this
  tieToLabel('CALL_ADVANCE_LOW_NOW', callAdvanceLowNow.out, { x: pos.x + 9900, y: pos.y - 3150 }); // anchor — pcHold (far) reads this
  tieToLabel('CALL_READ_HIGH_NOW', callReadHighNow.out, { x: pos.x + 9900, y: pos.y - 3100 }); // anchor — ramOeStage and callTarget's own write-back (far) read this
  tieToLabel('CALL_ADVANCE_HIGH_NOW', callAdvanceHighNow.out, { x: pos.x + 9900, y: pos.y - 3050 }); // anchor — pcHold (far) reads this
  tieToLabel('CALL_PUSH_NOW', callPushNow.out, { x: pos.x + 9900, y: pos.y - 3000 }); // anchor — stackWriteNow (below) and the return-address push-driver bank (far) read this
  tieToLabel('CALL_JUMP_NOW', callJumpNow.out, { x: pos.x + 9900, y: pos.y - 2950 }); // anchor — PC's own callMux (far) reads this

  // JP cc,nn: z=2 (real 0xC2/0xCA/0xD2/0xDA/0xE2/0xEA/0xF2/0xFA) — see the
  // doc comment above ("x=11: JP cc,nn") for the full derivation. Reuses
  // `JP nn`'s exact PHASE2-PHASE5 read/advance shape, but PHASE5 branches
  // on a flag test instead of always jumping: jump if the condition holds,
  // otherwise just advance PC a third time (`LD dd,nn`'s own PHASE5
  // shape) so execution falls through to whatever comes after this
  // instruction's own 3 bytes. A *separate* decode/target register from
  // `JP nn`'s own (`jpCcTarget`, not a widened, shared `jpTarget`) —
  // `z=3` and `z=2` are mutually exclusive by construction, so sharing
  // would have been electrically safe, but this keeps the addition from
  // touching any already-proven `JP nn` wiring, the same "separate over
  // shared-and-muxed" preference `CALL nn`'s own `callTarget` already
  // established.
  //
  // `y` selects the condition the same one-hot way `INC r`/`DEC r`'s own
  // `r8Select` above picks a register — real Z80's own condition/`y`
  // mapping: NZ=0, Z=1, NC=2, C=3, PO=4, PE=5, P=6, M=7 (`P`/`M` test `F`'s
  // `S` bit — "plus"/"minus" — not to be confused with `P/V`, `PO`/`PE`'s
  // own "parity odd"/"parity even"). Computed unconditionally off `F`'s
  // own live bits, same "always compute, gate only the commit" philosophy
  // `alu`/`spAdder`/`r8Adder` already use — cheap, and correctness doesn't
  // depend on gating it by `isJpCcZ` at all, only the commit does.
  const notFZ = buildNot(parent, { x: pos.x + 9600, y: pos.y - 3550 });
  wire(parent, f.q[6]!, notFZ.in);
  const notFC = buildNot(parent, { x: pos.x + 9600, y: pos.y - 3500 });
  wire(parent, f.q[0]!, notFC.in);
  const notFP = buildNot(parent, { x: pos.x + 9600, y: pos.y - 3450 });
  wire(parent, f.q[2]!, notFP.in);
  const notFS = buildNot(parent, { x: pos.x + 9600, y: pos.y - 3400 });
  wire(parent, f.q[7]!, notFS.in);
  const ccSelect: [Pin, Pin][] = [
    [dec.y[0]!, notFZ.out], // NZ
    [dec.y[1]!, f.q[6]!], // Z
    [dec.y[2]!, notFC.out], // NC
    [dec.y[3]!, f.q[0]!], // C
    [dec.y[4]!, notFP.out], // PO
    [dec.y[5]!, f.q[2]!], // PE
    [dec.y[6]!, notFS.out], // P
    [dec.y[7]!, f.q[7]!], // M
  ];
  let conditionTrue: Pin | null = null;
  ccSelect.forEach(([y, bit], k) => {
    const and = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 3550 + k * 50 });
    wire(parent, y, and.a);
    wire(parent, bit, and.b);
    if (conditionTrue === null) {
      conditionTrue = and.out;
    } else {
      const or = buildOr(parent, { x: pos.x + 9750, y: pos.y - 3550 + k * 50 });
      wire(parent, conditionTrue, or.a);
      wire(parent, and.out, or.b);
      conditionTrue = or.out;
    }
  });
  const notConditionTrue = buildNot(parent, { x: pos.x + 9800, y: pos.y - 3550 });
  wire(parent, conditionTrue!, notConditionTrue.in);

  const isJpCcZ = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 3700 });
  wire(parent, isStackGroup, isJpCcZ.a);
  wire(parent, dec.z[2]!, isJpCcZ.b);
  const jpCcReadLowNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3700 });
  wire(parent, isJpCcZ.out, jpCcReadLowNow.a);
  tieToLabel('PHASE2', jpCcReadLowNow.b, { x: pos.x + 9750, y: pos.y - 3670 });
  const jpCcAdvanceLowNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3650 });
  wire(parent, isJpCcZ.out, jpCcAdvanceLowNow.a);
  tieToLabel('PHASE3', jpCcAdvanceLowNow.b, { x: pos.x + 9750, y: pos.y - 3620 });
  const jpCcReadHighNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3600 });
  wire(parent, isJpCcZ.out, jpCcReadHighNow.a);
  tieToLabel('PHASE4', jpCcReadHighNow.b, { x: pos.x + 9750, y: pos.y - 3570 });
  const isJpCcPhase5 = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3550 });
  wire(parent, isJpCcZ.out, isJpCcPhase5.a);
  tieToLabel('PHASE5', isJpCcPhase5.b, { x: pos.x + 9750, y: pos.y - 3520 });
  const jpCcJumpNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 3550 });
  wire(parent, isJpCcPhase5.out, jpCcJumpNow.a);
  wire(parent, conditionTrue!, jpCcJumpNow.b);
  const jpCcFallThroughNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 3500 });
  wire(parent, isJpCcPhase5.out, jpCcFallThroughNow.a);
  wire(parent, notConditionTrue.out, jpCcFallThroughNow.b);
  tieToLabel('JPCC_READ_LOW_NOW', jpCcReadLowNow.out, { x: pos.x + 10000, y: pos.y - 3700 }); // anchor — ramOeStage and jpCcTarget's own write-back (far) read this
  tieToLabel('JPCC_ADVANCE_LOW_NOW', jpCcAdvanceLowNow.out, { x: pos.x + 10000, y: pos.y - 3650 }); // anchor — pcHold (far) reads this
  tieToLabel('JPCC_READ_HIGH_NOW', jpCcReadHighNow.out, { x: pos.x + 10000, y: pos.y - 3600 }); // anchor — ramOeStage and jpCcTarget's own write-back (far) read this
  tieToLabel('JPCC_JUMP_NOW', jpCcJumpNow.out, { x: pos.x + 10000, y: pos.y - 3550 }); // anchor — PC's own jpCcMux (far) reads this
  tieToLabel('JPCC_FALLTHROUGH_NOW', jpCcFallThroughNow.out, { x: pos.x + 10000, y: pos.y - 3500 }); // anchor — pcHold (far) reads this

  // CALL cc,nn: z=4 (real 0xC4/0xCC/0xD4/0xDC/0xE4/0xEC/0xF4/0xFC) — see
  // the doc comment above ("x=11: CALL cc,nn") for the full derivation.
  // Reuses `CALL nn`'s exact PHASE2-PHASE5 read/advance shape completely
  // unchanged and UNCONDITIONALLY — both branches need PC to end up
  // pointing past this instruction's own 3 bytes regardless of whether
  // the call actually fires, since that address is either the
  // fall-through target or the very return address about to be pushed.
  // The only branch is in PHASE6 (push) and PHASE7 (jump): `conditionTrue`
  // — reused directly from `JP cc,nn`'s own tree above, since `y`'s
  // condition encoding is identical at this `z` and depends on nothing
  // but `dec.y` and `F`'s live bits, not `dec.z` — gates both. Condition
  // false means PHASE6 pushes nothing and PHASE7 leaves PC exactly where
  // PHASE5's own unconditional advance already put it: no FALLTHROUGH
  // signal needed here at all, unlike `JP cc,nn`'s own PHASE5, because the
  // "do nothing extra" case needs no explicit gate of its own.
  const isCallCcZ = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 3850 });
  wire(parent, isStackGroup, isCallCcZ.a);
  wire(parent, dec.z[4]!, isCallCcZ.b);
  const callCcReadLowNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3850 });
  wire(parent, isCallCcZ.out, callCcReadLowNow.a);
  tieToLabel('PHASE2', callCcReadLowNow.b, { x: pos.x + 9750, y: pos.y - 3820 });
  const callCcAdvanceLowNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3800 });
  wire(parent, isCallCcZ.out, callCcAdvanceLowNow.a);
  tieToLabel('PHASE3', callCcAdvanceLowNow.b, { x: pos.x + 9750, y: pos.y - 3770 });
  const callCcReadHighNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3750 });
  wire(parent, isCallCcZ.out, callCcReadHighNow.a);
  tieToLabel('PHASE4', callCcReadHighNow.b, { x: pos.x + 9750, y: pos.y - 3720 });
  const callCcAdvanceHighNow = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3700 });
  wire(parent, isCallCcZ.out, callCcAdvanceHighNow.a);
  tieToLabel('PHASE5', callCcAdvanceHighNow.b, { x: pos.x + 9750, y: pos.y - 3670 });
  const isCallCcPhase6 = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3650 });
  wire(parent, isCallCcZ.out, isCallCcPhase6.a);
  tieToLabel('PHASE6', isCallCcPhase6.b, { x: pos.x + 9750, y: pos.y - 3620 });
  const callCcPushNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 3650 });
  wire(parent, isCallCcPhase6.out, callCcPushNow.a);
  wire(parent, conditionTrue!, callCcPushNow.b);
  const isCallCcPhase7 = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3600 });
  wire(parent, isCallCcZ.out, isCallCcPhase7.a);
  tieToLabel('PHASE7', isCallCcPhase7.b, { x: pos.x + 9750, y: pos.y - 3570 });
  const callCcJumpNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 3600 });
  wire(parent, isCallCcPhase7.out, callCcJumpNow.a);
  wire(parent, conditionTrue!, callCcJumpNow.b);
  tieToLabel('CALLCC_READ_LOW_NOW', callCcReadLowNow.out, { x: pos.x + 10000, y: pos.y - 3850 }); // anchor — ramOeStage and callCcTarget's own write-back (far) read this
  tieToLabel('CALLCC_ADVANCE_LOW_NOW', callCcAdvanceLowNow.out, { x: pos.x + 10000, y: pos.y - 3800 }); // anchor — pcHold (far) reads this
  tieToLabel('CALLCC_READ_HIGH_NOW', callCcReadHighNow.out, { x: pos.x + 10000, y: pos.y - 3750 }); // anchor — ramOeStage and callCcTarget's own write-back (far) read this
  tieToLabel('CALLCC_ADVANCE_HIGH_NOW', callCcAdvanceHighNow.out, { x: pos.x + 10000, y: pos.y - 3700 }); // anchor — pcHold (far) reads this
  tieToLabel('CALLCC_PUSH_NOW', callCcPushNow.out, { x: pos.x + 10000, y: pos.y - 3650 }); // anchor — stackWriteNow (below) and the return-address push-driver bank (far) read this
  tieToLabel('CALLCC_JUMP_NOW', callCcJumpNow.out, { x: pos.x + 10000, y: pos.y - 3600 }); // anchor — PC's own callCcMux (far) reads this

  // RET cc: z=0 (real 0xC0/0xC8/0xD0/0xD8/0xE0/0xE8/0xF0/0xF8) — see the
  // doc comment above ("x=11: RET cc") for the full derivation. The
  // simplest of the four flag-gated x=11 instructions built so far: a
  // single-byte opcode, no operand bytes to read or advance past, so the
  // not-taken branch needs nothing beyond PC's own default PHASE1
  // increment — no FALLTHROUGH signal, no extra `pcHold` term, unlike
  // every other conditional instruction in this file. Reuses `JP cc,nn`'s
  // own `conditionTrue` directly (identical y-to-condition encoding,
  // `dec.z`-independent) and the *existing* unconditional `RET`'s own
  // single-byte pop shape — no dedicated target register either, since
  // the popped byte already IS the full address, the same reason
  // `retMux` itself never needed one.
  const isRetCcZ = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 3950 });
  wire(parent, isStackGroup, isRetCcZ.a);
  wire(parent, dec.z[0]!, isRetCcZ.b);
  const isRetCcPhase2 = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 3950 });
  wire(parent, isRetCcZ.out, isRetCcPhase2.a);
  tieToLabel('PHASE2', isRetCcPhase2.b, { x: pos.x + 9750, y: pos.y - 3920 });
  const retCcTakenNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 3950 });
  wire(parent, isRetCcPhase2.out, retCcTakenNow.a);
  wire(parent, conditionTrue!, retCcTakenNow.b);
  tieToLabel('RETCC_TAKEN_NOW', retCcTakenNow.out, { x: pos.x + 10000, y: pos.y - 3950 }); // anchor — readNow's own widening (below) and PC's own retCcMux (far) both read this

  // `readNow`'s real, final definition — `readNowStageReti` (popReadNow OR
  // retNow OR retiNow, built with unconditional RET/POP/RETI long before
  // `RET cc` or `conditionTrue` existed) widens a further term here, exactly
  // the same "gated already by `conditionTrue` inside the term itself, no
  // extra check at the `OR` gate" shape `CALL cc,nn`'s own `stackWriteNow`
  // widening used. POP IX (DD E1) / POP IY (FD E1) add PHASE4/5 after
  // that — each pair side-folded then merged so neither OR input floats.
  const readNowStageCc = buildOr(parent, { x: pos.x + 10150, y: pos.y + 870 });
  wire(parent, readNowStageReti.out, readNowStageCc.a);
  tieToLabel('RETCC_TAKEN_NOW', readNowStageCc.b, { x: pos.x + 10050, y: pos.y + 870 });
  const popIxReadAny = buildOr(parent, { x: pos.x + 10200, y: pos.y + 860 });
  tieToLabel('POPIX_LOW_NOW', popIxReadAny.a, { x: pos.x + 10100, y: pos.y + 860 });
  tieToLabel('POPIX_HIGH_NOW', popIxReadAny.b, { x: pos.x + 10100, y: pos.y + 880 });
  const popIyReadAny = buildOr(parent, { x: pos.x + 10200, y: pos.y + 900 });
  tieToLabel('POPIY_LOW_NOW', popIyReadAny.a, { x: pos.x + 10100, y: pos.y + 900 });
  tieToLabel('POPIY_HIGH_NOW', popIyReadAny.b, { x: pos.x + 10100, y: pos.y + 920 });
  const popIxIyReadAny = buildOr(parent, { x: pos.x + 10250, y: pos.y + 880 });
  wire(parent, popIxReadAny.out, popIxIyReadAny.a);
  wire(parent, popIyReadAny.out, popIxIyReadAny.b);
  const readNow = buildOr(parent, { x: pos.x + 10300, y: pos.y + 870 });
  wire(parent, readNowStageCc.out, readNow.a);
  wire(parent, popIxIyReadAny.out, readNow.b);

  // x=00, z=0, y=4..7: JR cc,e (real 0x20/0x28/0x30/0x38 — NZ/Z/NC/C only,
  // a real Z80 hardware restriction: this z-column's other y values are
  // NOP/EX AF,AF'/DJNZ/JR (unconditional), none implemented, so only
  // y=4..7 get decoded here; PO/PE/P/M were never valid for this opcode on
  // real silicon either, not a simplification this project chose. See the
  // doc comment above ("x=00: JR cc,e") for the full derivation, including
  // why this needs genuine PC-relative arithmetic instead of JP cc,nn's
  // own "write the operand straight into PC" shape.
  //
  // Condition test: the *same* NZ/Z/NC/C signals `JP cc,nn`'s own tree
  // already built (`notFZ`/`f.q[6]`/`notFC`/`f.q[0]`), paired with this
  // opcode's own `y` lines instead — `y=4..7` here encode the identical
  // four conditions `JP cc,nn`'s own `y=0..3` do, just at a different `y`
  // value (real Z80's own encoding, not a choice made here), so the
  // pairing can't reuse `conditionTrue` itself, only the `F`-bit taps
  // feeding it.
  const isX0Z0 = buildAnd(parent, { x: pos.x + 9700, y: pos.y - 4050 });
  wire(parent, isX0Group, isX0Z0.a);
  wire(parent, dec.z[0]!, isX0Z0.b);
  const jrCcYValid1 = buildOr(parent, { x: pos.x + 9700, y: pos.y - 4000 });
  wire(parent, dec.y[4]!, jrCcYValid1.a);
  wire(parent, dec.y[5]!, jrCcYValid1.b);
  const jrCcYValid2 = buildOr(parent, { x: pos.x + 9700, y: pos.y - 3970 });
  wire(parent, jrCcYValid1.out, jrCcYValid2.a);
  wire(parent, dec.y[6]!, jrCcYValid2.b);
  const isJrCcYValid = buildOr(parent, { x: pos.x + 9700, y: pos.y - 3940 });
  wire(parent, jrCcYValid2.out, isJrCcYValid.a);
  wire(parent, dec.y[7]!, isJrCcYValid.b);
  const isJrCc = buildAnd(parent, { x: pos.x + 9750, y: pos.y - 4050 });
  wire(parent, isX0Z0.out, isJrCc.a);
  wire(parent, isJrCcYValid.out, isJrCc.b);

  const jrCcSelect: [Pin, Pin][] = [
    [dec.y[4]!, notFZ.out], // NZ
    [dec.y[5]!, f.q[6]!], // Z
    [dec.y[6]!, notFC.out], // NC
    [dec.y[7]!, f.q[0]!], // C
  ];
  let jrCcConditionTrue: Pin | null = null;
  jrCcSelect.forEach(([y, bit], k) => {
    const and = buildAnd(parent, { x: pos.x + 9800, y: pos.y - 4050 + k * 50 });
    wire(parent, y, and.a);
    wire(parent, bit, and.b);
    if (jrCcConditionTrue === null) {
      jrCcConditionTrue = and.out;
    } else {
      const or = buildOr(parent, { x: pos.x + 9850, y: pos.y - 4050 + k * 50 });
      wire(parent, jrCcConditionTrue, or.a);
      wire(parent, and.out, or.b);
      jrCcConditionTrue = or.out;
    }
  });

  const jrCcReadNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4050 });
  wire(parent, isJrCc.out, jrCcReadNow.a);
  tieToLabel('PHASE2', jrCcReadNow.b, { x: pos.x + 9850, y: pos.y - 4020 });
  const jrCcAdvanceNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4000 });
  wire(parent, isJrCc.out, jrCcAdvanceNow.a);
  tieToLabel('PHASE3', jrCcAdvanceNow.b, { x: pos.x + 9850, y: pos.y - 3970 });
  const isJrCcPhase4 = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 3950 });
  wire(parent, isJrCc.out, isJrCcPhase4.a);
  tieToLabel('PHASE4', isJrCcPhase4.b, { x: pos.x + 9850, y: pos.y - 3920 });
  const jrCcJumpNow = buildAnd(parent, { x: pos.x + 9950, y: pos.y - 3950 });
  wire(parent, isJrCcPhase4.out, jrCcJumpNow.a);
  wire(parent, jrCcConditionTrue!, jrCcJumpNow.b);

  // x=00, z=0, y=3: JR e (real 0x18) — unconditional. Shares `isX0Z0`
  // and every downstream piece of `JR cc,e`'s own machinery (`jrCcOffset`,
  // `jrOffsetAdder`) — reading, advancing, and jumping are identical work
  // to the conditional form, minus the condition test itself, so this is
  // a single extra AND gate per phase, nothing more. Mutually exclusive
  // with `JR cc,e`'s own `y=4..7` and `DJNZ`'s own `y=2` by construction
  // (`dec.y` one-hot), so ORing this into the same final commit signals
  // below is safe.
  const isJr = buildAnd(parent, { x: pos.x + 9750, y: pos.y - 4100 });
  wire(parent, isX0Z0.out, isJr.a);
  wire(parent, dec.y[3]!, isJr.b);
  const jrReadNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4150 });
  wire(parent, isJr.out, jrReadNow.a);
  tieToLabel('PHASE2', jrReadNow.b, { x: pos.x + 9850, y: pos.y - 4120 });
  const jrAdvanceNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4100 });
  wire(parent, isJr.out, jrAdvanceNow.a);
  tieToLabel('PHASE3', jrAdvanceNow.b, { x: pos.x + 9850, y: pos.y - 4070 });
  const jrJumpNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4050 });
  wire(parent, isJr.out, jrJumpNow.a);
  tieToLabel('PHASE4', jrJumpNow.b, { x: pos.x + 9850, y: pos.y - 4020 });

  // x=00, z=0, y=2: DJNZ e (real 0x10) — decrement B, jump only if the
  // result is nonzero. `djnzAdder` is a *third* dedicated `buildAlu`
  // instance (8 bits, the same "b=all-1s, cin=0" -1 encoding `spAdder`
  // already established for a plain decrement), computed unconditionally
  // off `rB.q`, feeding B's own fourth write-back layer (below) with the
  // decremented value.
  //
  // The zero-test is deliberately built off `rB.q` directly, NOT off
  // `djnzAdder.out` — found live: `djnzAdder` recomputes "B minus one"
  // continuously, off whatever `rB.q` currently is; by `PHASE4` (when the
  // jump-or-not decision fires), `PHASE2`'s own write has *already*
  // committed the decrement into `rB.q`, so reading `djnzAdder.out` at
  // that point silently computes "B minus one *again*" — a real, live
  // off-by-one that only misfires on the SECOND loop pass onward (B=3->2
  // tests "2-1=1, nonzero" and accidentally jumps correctly; B=2->1 tests
  // "1-1=0, zero" and wrongly stops, one iteration early, exactly the bug
  // this test file caught). `rB.q`'s own OR-fold (`bNotZeroChain`, the
  // identical shape `r8ZChain`/the ALU group's own zChain already use,
  // stopped one step short of the final `NOT`) reads the register's own
  // already-decremented value instead of re-deriving a stale one.
  const isDjnz = buildAnd(parent, { x: pos.x + 9750, y: pos.y - 4150 });
  wire(parent, isX0Z0.out, isDjnz.a);
  wire(parent, dec.y[2]!, isDjnz.b);
  const djnzAdder = buildAlu(parent, library, 8, { x: pos.x - 700, y: pos.y - 5100 });
  tiePowerRail(parent, 'GND', djnzAdder.op0);
  tiePowerRail(parent, 'GND', djnzAdder.op1);
  tiePowerRail(parent, 'GND', djnzAdder.cin);
  rB.q.forEach((q, i) => {
    wire(parent, q, djnzAdder.a[i]!);
    tiePowerRail(parent, 'VCC', djnzAdder.b[i]!);
    tieToLabel(`DJNZRESULT${i}`, djnzAdder.out[i]!, { x: pos.x - 600, y: pos.y - 5100 + i * 60 }); // anchor — B's own fourth write-back layer (far) reads this
  });
  let bNotZeroChain: Pin = rB.q[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x - 500, y: pos.y - 5100 + i * 60 });
    wire(parent, bNotZeroChain, orGate.a);
    wire(parent, rB.q[i]!, orGate.b);
    bNotZeroChain = orGate.out;
  }
  const djnzDecNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4200 });
  wire(parent, isDjnz.out, djnzDecNow.a);
  tieToLabel('PHASE2', djnzDecNow.b, { x: pos.x + 9850, y: pos.y - 4170 });
  tieToLabel('DJNZ_DEC_NOW', djnzDecNow.out, { x: pos.x + 10000, y: pos.y - 4200 }); // anchor — B's own fourth write-back layer (far) and the shared JR_READ_NOW below both read this
  const djnzAdvanceNow = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4250 });
  wire(parent, isDjnz.out, djnzAdvanceNow.a);
  tieToLabel('PHASE3', djnzAdvanceNow.b, { x: pos.x + 9850, y: pos.y - 4220 });
  const isDjnzPhase4 = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 4300 });
  wire(parent, isDjnz.out, isDjnzPhase4.a);
  tieToLabel('PHASE4', isDjnzPhase4.b, { x: pos.x + 9850, y: pos.y - 4270 });
  const djnzJumpNow = buildAnd(parent, { x: pos.x + 9950, y: pos.y - 4300 });
  wire(parent, isDjnzPhase4.out, djnzJumpNow.a);
  wire(parent, bNotZeroChain, djnzJumpNow.b);

  // `JR_READ_NOW`/`JR_ADVANCE_NOW`/`JR_JUMP_NOW` — the *real* final
  // signals every JR-family opcode's own read/advance/jump funnels into.
  // Renamed from the original `JRCC_*` names (`JR cc,e`'s own, before
  // plain `JR`/`DJNZ` existed) since these three now cover all three
  // variants — keeping the old, narrower name once it stopped being
  // accurate would be exactly the kind of misleading label this project
  // has never allowed elsewhere. Mutually exclusive by `dec.y` at every
  // term, so a straight `OR`-fold is correct, not just convenient.
  const jrReadNowStage = buildOr(parent, { x: pos.x + 10000, y: pos.y - 4100 });
  wire(parent, jrCcReadNow.out, jrReadNowStage.a);
  wire(parent, jrReadNow.out, jrReadNowStage.b);
  const jrReadNowFinal = buildOr(parent, { x: pos.x + 10050, y: pos.y - 4130 });
  wire(parent, jrReadNowStage.out, jrReadNowFinal.a);
  wire(parent, djnzDecNow.out, jrReadNowFinal.b);
  tieToLabel('JR_READ_NOW', jrReadNowFinal.out, { x: pos.x + 10100, y: pos.y - 4130 }); // anchor — ramOeStage and jrCcOffset's own WE (far) both read this
  const jrAdvanceNowStage = buildOr(parent, { x: pos.x + 10000, y: pos.y - 4150 });
  wire(parent, jrCcAdvanceNow.out, jrAdvanceNowStage.a);
  wire(parent, jrAdvanceNow.out, jrAdvanceNowStage.b);
  const jrAdvanceNowFinal = buildOr(parent, { x: pos.x + 10050, y: pos.y - 4180 });
  wire(parent, jrAdvanceNowStage.out, jrAdvanceNowFinal.a);
  wire(parent, djnzAdvanceNow.out, jrAdvanceNowFinal.b);
  tieToLabel('JR_ADVANCE_NOW', jrAdvanceNowFinal.out, { x: pos.x + 10100, y: pos.y - 4180 }); // anchor — pcHold (far) reads this
  const jrJumpNowStage = buildOr(parent, { x: pos.x + 10000, y: pos.y - 4200 });
  wire(parent, jrCcJumpNow.out, jrJumpNowStage.a);
  wire(parent, jrJumpNow.out, jrJumpNowStage.b);
  const jrJumpNowFinal = buildOr(parent, { x: pos.x + 10050, y: pos.y - 4230 });
  wire(parent, jrJumpNowStage.out, jrJumpNowFinal.a);
  wire(parent, djnzJumpNow.out, jrJumpNowFinal.b);
  tieToLabel('JR_JUMP_NOW', jrJumpNowFinal.out, { x: pos.x + 10100, y: pos.y - 4230 }); // anchor — PC's own jrMux (far) reads this

  // The displacement byte itself: a plain 8-bit register, not a "hold vs
  // fresh" mux pair the way `jpTarget`/`callTarget`/etc need — those exist
  // because a single register captures TWO different byte-halves across
  // two separate WE pulses and has to preserve whichever half isn't being
  // written that cycle; `jrCcOffset` is written exactly once, so a bare
  // `we`-gated capture (the same shape `B`/`C`/`D`/... use for `LD r,n`'s
  // own immediate byte) is all it needs.
  const jrCcOffset = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 4700 });
  tieToLabel('JR_READ_NOW', jrCcOffset.we, { x: pos.x - 800, y: pos.y - 4700 });
  jrCcOffset.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 4680 - i * 20 }));
  tieToLabel('CLK', jrCcOffset.clk, { x: pos.x - 700, y: pos.y - 4720 }); // learned from jpTarget's own missing-CLK bug, several features back — checked off explicitly, every time, no exceptions

  // PC-relative arithmetic: a *second* `buildAlu` instance (width
  // `addrBits`, the same trick `spAdder` already established for a
  // dedicated, non-shared adder), permanently in ADD mode (`op0`/`op1`
  // tied to `gnd`, `cin` tied to `gnd` — a genuine two's-complement sum,
  // not `spAdder`'s own "b=all-1s, cin=0" -1 encoding), computed
  // UNCONDITIONALLY off `pc.q`'s own *current* value — by the time
  // `PHASE4` arrives, `PHASE3`'s own advance has already committed on the
  // prior edge, so `pc.q` already equals "the address right after this
  // instruction's own 2 bytes," exactly the base a real relative jump
  // needs, without this file building any special-cased "peek ahead"
  // logic to get it. `jrCcOffset`'s own 8 bits sign-extend up to
  // `addrBits` (bit 7 repeated into every bit above it) — this only
  // produces a correct negative displacement when `addrBits >= 8`; for a
  // narrower address space this project has never actually exercised
  // that combination, an explicit, documented limitation rather than a
  // silent one (see "x=00: JR cc,e" above).
  const jrOffsetAdder = buildAlu(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 4900 });
  tiePowerRail(parent, 'GND', jrOffsetAdder.op0);
  tiePowerRail(parent, 'GND', jrOffsetAdder.op1);
  tiePowerRail(parent, 'GND', jrOffsetAdder.cin);
  for (let i = 0; i < addrBits; i++) {
    wire(parent, pc.q[i]!, jrOffsetAdder.a[i]!);
    if (i < 8) wire(parent, jrCcOffset.q[i]!, jrOffsetAdder.b[i]!);
    else wire(parent, jrCcOffset.q[7]!, jrOffsetAdder.b[i]!); // sign-extend
  }

  // (IX+d)/(IY+d) displacement capture + dedicated adders (see "DD: IX" /
  // "FD: IY"). Do NOT reuse jrOffsetAdder — its `a` is hardwired to PC.
  // Address override is phase-scoped (IXDISP_ADDR_NOW / IYDISP_ADDR_NOW),
  // never held for the whole instruction (IS_INCDEC_HLMEM live bug).
  const ixDisp = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 5450 });
  tieToLabel('DDDISP_READ_NOW', ixDisp.we, { x: pos.x - 800, y: pos.y - 5450 });
  ixDisp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 5430 - i * 20 }));
  tieToLabel('CLK', ixDisp.clk, { x: pos.x - 700, y: pos.y - 5470 });
  const ixDispAdder = buildAlu(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 5650 });
  tiePowerRail(parent, 'GND', ixDispAdder.op0);
  tiePowerRail(parent, 'GND', ixDispAdder.op1);
  tiePowerRail(parent, 'GND', ixDispAdder.cin);
  for (let i = 0; i < addrBits; i++) {
    if (i < 8) wire(parent, rIXL.q[i]!, ixDispAdder.a[i]!);
    else if (rIXH.q[i - 8]) wire(parent, rIXH.q[i - 8]!, ixDispAdder.a[i]!);
    else tiePowerRail(parent, 'GND', ixDispAdder.a[i]!);
    if (i < 8) wire(parent, ixDisp.q[i]!, ixDispAdder.b[i]!);
    else wire(parent, ixDisp.q[7]!, ixDispAdder.b[i]!); // sign-extend
    tieToLabel(`IXDISPADD${i}`, ixDispAdder.out[i]!, { x: pos.x - 600, y: pos.y - 5650 - i * 20 });
  }

  const iyDisp = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 5850 });
  tieToLabel('FDDISP_READ_NOW', iyDisp.we, { x: pos.x - 800, y: pos.y - 5850 });
  iyDisp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 5830 - i * 20 }));
  tieToLabel('CLK', iyDisp.clk, { x: pos.x - 700, y: pos.y - 5870 });
  const iyDispAdder = buildAlu(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 6050 });
  tiePowerRail(parent, 'GND', iyDispAdder.op0);
  tiePowerRail(parent, 'GND', iyDispAdder.op1);
  tiePowerRail(parent, 'GND', iyDispAdder.cin);
  for (let i = 0; i < addrBits; i++) {
    if (i < 8) wire(parent, rIYL.q[i]!, iyDispAdder.a[i]!);
    else if (rIYH.q[i - 8]) wire(parent, rIYH.q[i - 8]!, iyDispAdder.a[i]!);
    else tiePowerRail(parent, 'GND', iyDispAdder.a[i]!);
    if (i < 8) wire(parent, iyDisp.q[i]!, iyDispAdder.b[i]!);
    else wire(parent, iyDisp.q[7]!, iyDispAdder.b[i]!); // sign-extend
    tieToLabel(`IYDISPADD${i}`, iyDispAdder.out[i]!, { x: pos.x - 600, y: pos.y - 6050 - i * 20 });
  }

  // LD (IX+d),n / LD (IY+d),n immediate holding regs (ldHlNImm shape).
  const ldIxDNImm = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 6250 });
  tieToLabel('DDMEMLDN_IMM_READ_NOW', ldIxDNImm.we, { x: pos.x - 800, y: pos.y - 6250 });
  ldIxDNImm.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 6230 - i * 20 }));
  ldIxDNImm.q.forEach((q, i) => tieToLabel(`LDIXDNIMM${i}`, q, { x: pos.x - 800, y: pos.y - 6210 - i * 20 }));
  tieToLabel('CLK', ldIxDNImm.clk, { x: pos.x - 700, y: pos.y - 6270 });
  const ldIyDNImm = buildRegister(parent, library, 8, { x: pos.x - 700, y: pos.y - 6450 });
  tieToLabel('FDMEMLDN_IMM_READ_NOW', ldIyDNImm.we, { x: pos.x - 800, y: pos.y - 6450 });
  ldIyDNImm.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 800, y: pos.y - 6430 - i * 20 }));
  ldIyDNImm.q.forEach((q, i) => tieToLabel(`LDIYDNIMM${i}`, q, { x: pos.x - 800, y: pos.y - 6410 - i * 20 }));
  tieToLabel('CLK', ldIyDNImm.clk, { x: pos.x - 700, y: pos.y - 6470 });

  // `LDIR`/`LDDR`'s own repeat (see "x=10, z=0: LDI/LDD/LDIR/LDDR" above):
  // a dedicated `pcMinus2Adder`, computing `PC - 2` unconditionally off
  // `pc.q` the same "always compute, gate only the commit" way every
  // adder in this file already does. `-2` in two's complement is every
  // bit `1` except bit 0 (`0b...1110`) — the identical `b`/`cin` shape the
  // `-1` trick elsewhere in this file uses (`b` = the constant, `cin=0`),
  // just a different constant, since this needs to land back on the
  // *opcode byte itself* (`ED` then the real opcode, two bytes both
  // already advanced past), not one byte short of it.
  const pcMinus2Adder = buildAlu(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 5100 });
  tiePowerRail(parent, 'GND', pcMinus2Adder.op0);
  tiePowerRail(parent, 'GND', pcMinus2Adder.op1);
  tiePowerRail(parent, 'GND', pcMinus2Adder.cin);
  for (let i = 0; i < addrBits; i++) {
    wire(parent, pc.q[i]!, pcMinus2Adder.a[i]!);
    tiePowerRail(parent, i === 0 ? 'GND' : 'VCC', pcMinus2Adder.b[i]!);
  }

  const stackWriteNowStage = buildOr(parent, { x: pos.x + 9950, y: pos.y + 900 }); // pushNow OR rstNow — decrements SP, and is the RAM-write/address-select condition
  wire(parent, pushNow.out, stackWriteNowStage.a);
  wire(parent, rstNow.out, stackWriteNowStage.b);
  // CALL nn's own return-address push (see "x=11: CALL nn" above) needs
  // the identical decrement-SP/write-RAM-at-SP/address-select treatment —
  // a third OR term, reusing every bit of that machinery rather than
  // rebuilding any of it.
  const stackWriteNowStage2 = buildOr(parent, { x: pos.x + 10000, y: pos.y + 950 });
  wire(parent, stackWriteNowStage.out, stackWriteNowStage2.a);
  tieToLabel('CALL_PUSH_NOW', stackWriteNowStage2.b, { x: pos.x + 9900, y: pos.y + 950 });
  // CALL cc,nn's own conditional push (see "x=11: CALL cc,nn" above) needs
  // the identical treatment — a fourth OR term. Already gated by
  // `conditionTrue` inside `CALLCC_PUSH_NOW` itself, so this widening is
  // correct for both the taken and not-taken branches without any extra
  // condition check here.
  const stackWriteNowStage3 = buildOr(parent, { x: pos.x + 10050, y: pos.y + 970 });
  wire(parent, stackWriteNowStage2.out, stackWriteNowStage3.a);
  tieToLabel('CALLCC_PUSH_NOW', stackWriteNowStage3.b, { x: pos.x + 9950, y: pos.y + 970 });
  // PUSH IX (DD E5) / PUSH IY (FD E5) — PHASE4 high / PHASE5 low, each
  // pair side-folded then merged (never leave an OR input floating).
  const pushIxWriteAny = buildOr(parent, { x: pos.x + 10100, y: pos.y + 960 });
  tieToLabel('PUSHIX_HIGH_NOW', pushIxWriteAny.a, { x: pos.x + 10000, y: pos.y + 960 });
  tieToLabel('PUSHIX_LOW_NOW', pushIxWriteAny.b, { x: pos.x + 10000, y: pos.y + 980 });
  const pushIyWriteAny = buildOr(parent, { x: pos.x + 10100, y: pos.y + 1000 });
  tieToLabel('PUSHIY_HIGH_NOW', pushIyWriteAny.a, { x: pos.x + 10000, y: pos.y + 1000 });
  tieToLabel('PUSHIY_LOW_NOW', pushIyWriteAny.b, { x: pos.x + 10000, y: pos.y + 1020 });
  const pushIxIyWriteAny = buildOr(parent, { x: pos.x + 10150, y: pos.y + 980 });
  wire(parent, pushIxWriteAny.out, pushIxIyWriteAny.a);
  wire(parent, pushIyWriteAny.out, pushIxIyWriteAny.b);
  const stackWriteNow = buildOr(parent, { x: pos.x + 10200, y: pos.y + 970 });
  wire(parent, stackWriteNowStage3.out, stackWriteNow.a);
  wire(parent, pushIxIyWriteAny.out, stackWriteNow.b);
  const stackWriteNowNmi = buildOr(parent, { x: pos.x + 10250, y: pos.y + 970 });
  wire(parent, stackWriteNow.out, stackWriteNowNmi.a);
  tieToLabel('NMI_PUSH_NOW', stackWriteNowNmi.b, { x: pos.x + 10150, y: pos.y + 990 });
  const stackWriteNowIrq = buildOr(parent, { x: pos.x + 10300, y: pos.y + 970 });
  wire(parent, stackWriteNowNmi.out, stackWriteNowIrq.a);
  tieToLabel('IM2_PUSH_NOW', stackWriteNowIrq.b, { x: pos.x + 10200, y: pos.y + 990 });
  tieToLabel('STACK_WRITE_NOW', stackWriteNowIrq.out, { x: pos.x + 10350, y: pos.y + 920 }); // anchor — the far address-mux writeMux.sel below reads this via the label, not a ~9000-unit wire
  tieToLabel('READ_NOW', readNow.out, { x: pos.x + 10350, y: pos.y + 820 }); // same anchor idea for readMux.sel
  const stackActive = buildOr(parent, { x: pos.x + 10400, y: pos.y + 950 }); // anything in x=11 currently driving SP/RAM
  wire(parent, stackWriteNowIrq.out, stackActive.a);
  wire(parent, readNow.out, stackActive.b);

  // busActive: the WIDE union — anything that might be driving the shared
  // bus right now, register-operand groups or the stack family alike.
  // Deliberately kept SEPARATE from groupActive (narrow: x=10/x=01 only) —
  // see the doc comment above ("A bus-fight this design deliberately
  // avoids") for why widening groupActive itself would be the actual bug.
  const busActive = buildOr(parent, { x: pos.x + 10300, y: pos.y - 25 });
  wire(parent, groupActive.out, busActive.a);
  wire(parent, stackActive.out, busActive.b);
  // DD/FD LD (IX+d),r / (IX+d),n / INCDEC write drivers — widen busActive so FETCH
  // OE exclusion covers the PHASE7→PHASE0 wrap (n-write / INCDEC write) and PHASE6 write.
  const ddFdMemLdBusWrite = buildOr(parent, { x: pos.x + 10350, y: pos.y - 50 });
  tieToLabel('DDMEMLD_WRITE_NOW', ddFdMemLdBusWrite.a, { x: pos.x + 10250, y: pos.y - 50 });
  tieToLabel('FDMEMLD_WRITE_NOW', ddFdMemLdBusWrite.b, { x: pos.x + 10250, y: pos.y - 30 });
  const ddFdMemLdNBusWrite = buildOr(parent, { x: pos.x + 10350, y: pos.y - 10 });
  tieToLabel('DDMEMLDN_WRITE_NOW', ddFdMemLdNBusWrite.a, { x: pos.x + 10250, y: pos.y - 10 });
  tieToLabel('FDMEMLDN_WRITE_NOW', ddFdMemLdNBusWrite.b, { x: pos.x + 10250, y: pos.y + 10 });
  const ddFdMemIncDecBusWrite = buildOr(parent, { x: pos.x + 10350, y: pos.y + 30 });
  tieToLabel('DDMEM_INCDEC_WRITE_NOW', ddFdMemIncDecBusWrite.a, { x: pos.x + 10250, y: pos.y + 30 });
  tieToLabel('FDMEM_INCDEC_WRITE_NOW', ddFdMemIncDecBusWrite.b, { x: pos.x + 10250, y: pos.y + 50 });
  const ddFdMemLdBusAny = buildOr(parent, { x: pos.x + 10400, y: pos.y - 30 });
  wire(parent, ddFdMemLdBusWrite.out, ddFdMemLdBusAny.a);
  wire(parent, ddFdMemLdNBusWrite.out, ddFdMemLdBusAny.b);
  const ddFdMemBusAny = buildOr(parent, { x: pos.x + 10450, y: pos.y - 10 });
  wire(parent, ddFdMemLdBusAny.out, ddFdMemBusAny.a);
  wire(parent, ddFdMemIncDecBusWrite.out, ddFdMemBusAny.b);
  const busActiveFinal = buildOr(parent, { x: pos.x + 10500, y: pos.y - 25 });
  wire(parent, busActive.out, busActiveFinal.a);
  wire(parent, ddFdMemBusAny.out, busActiveFinal.b);

  const hlNow = buildAnd(parent, { x: pos.x + 9300, y: pos.y - 200 }); // z=6, (HL): this instruction's source operand is a memory read
  wire(parent, groupActive.out, hlNow.a);
  wire(parent, dec.z[6]!, hlNow.b);

  // LD (HL),r: destination is (HL) (y=6) — excluding z=6 keeps HALT from
  // becoming LD (HL),(HL); haltNow below latches halted instead.
  const notZ6 = buildNot(parent, { x: pos.x + 9350, y: pos.y + 350 });
  wire(parent, dec.z[6]!, notZ6.in);
  const ldWritesHl = buildAnd(parent, { x: pos.x + 9450, y: pos.y + 250 });
  wire(parent, ldGroupNow.out, ldWritesHl.a);
  wire(parent, dec.y[6]!, ldWritesHl.b);
  const ramWriteNow = buildAnd(parent, { x: pos.x + 9550, y: pos.y + 250 });
  wire(parent, ldWritesHl.out, ramWriteNow.a);
  wire(parent, notZ6.out, ramWriteNow.b);
  // HALT (0x76 = x=01,y=6,z=6): latch halted — soft parity stop-clock.
  const haltNow = buildAnd(parent, { x: pos.x + 9550, y: pos.y + 280 });
  wire(parent, ldWritesHl.out, haltNow.a);
  wire(parent, dec.z[6]!, haltNow.b);
  tieToLabel('HALT_NOW', haltNow.out, { x: pos.x + 9650, y: pos.y + 280 });
  // Side-folds for RAM WE — stay outside RAM_WE_OR and feed as single
  // inputs (same discipline as RAM_OE_OR). INC/DEC/SET/RES/CB-rot (HL),
  // EX (SP),HL/IX/IY, ED LD (nn),dd, and DD/FD mem writes are reduced
  // here; RRDRLD_WRITE_NOW remains the last term of the main OR so its
  // path depth to ram.we is unchanged.
  const hlMemWeTerms = buildOr(parent, { x: pos.x + 9550, y: pos.y + 600 });
  tieToLabel('INCDEC_HLMEM_NOW', hlMemWeTerms.a, { x: pos.x + 9450, y: pos.y + 600 });
  tieToLabel('SETRES_HL_WRITE_NOW', hlMemWeTerms.b, { x: pos.x + 9450, y: pos.y + 620 });
  const hlMemWeTerms2 = buildOr(parent, { x: pos.x + 9520, y: pos.y + 610 });
  wire(parent, hlMemWeTerms.out, hlMemWeTerms2.a);
  tieToLabel('CBROT_HL_WRITE_NOW', hlMemWeTerms2.b, { x: pos.x + 9420, y: pos.y + 630 });
  const exSpWriteLowAny = buildOr(parent, { x: pos.x + 9650, y: pos.y + 700 });
  tieToLabel('EXSPHL_WRITE_LOW_NOW', exSpWriteLowAny.a, { x: pos.x + 9550, y: pos.y + 700 });
  tieToLabel('EXSPIX_WRITE_LOW_NOW', exSpWriteLowAny.b, { x: pos.x + 9550, y: pos.y + 720 });
  const exSpWriteLowAny2 = buildOr(parent, { x: pos.x + 9680, y: pos.y + 710 });
  wire(parent, exSpWriteLowAny.out, exSpWriteLowAny2.a);
  tieToLabel('EXSPIY_WRITE_LOW_NOW', exSpWriteLowAny2.b, { x: pos.x + 9580, y: pos.y + 730 });
  const exSpWriteHighAny = buildOr(parent, { x: pos.x + 9750, y: pos.y + 750 });
  tieToLabel('EXSPHL_WRITE_HIGH_NOW', exSpWriteHighAny.a, { x: pos.x + 9650, y: pos.y + 750 });
  tieToLabel('EXSPIX_WRITE_HIGH_NOW', exSpWriteHighAny.b, { x: pos.x + 9650, y: pos.y + 770 });
  const exSpWriteHighAny2 = buildOr(parent, { x: pos.x + 9780, y: pos.y + 760 });
  wire(parent, exSpWriteHighAny.out, exSpWriteHighAny2.a);
  tieToLabel('EXSPIY_WRITE_HIGH_NOW', exSpWriteHighAny2.b, { x: pos.x + 9680, y: pos.y + 780 });
  // ED LD (nn),dd store writes (see "x=01, z=3") — folded off to the side
  // then merged *before* RRD/RLD's own term below. Found live: chaining
  // two more sequential `OR`s *after* `RRDRLD_WRITE_NOW` (the identical
  // shape that broke `ramOe` below) delayed RAM's own we enough that the
  // PHASE4/5 bus fight on RRD's own read/write window corrupted the ring
  // counter itself. Side-fold + one merge keeps RRD's path depth unchanged.
  const edNnWeAny = buildOr(parent, { x: pos.x + 10100, y: pos.y + 860 });
  tieToLabel('EDNN_WRITE_LOW_NOW', edNnWeAny.a, { x: pos.x + 10000, y: pos.y + 860 });
  tieToLabel('EDNN_WRITE_HIGH_NOW', edNnWeAny.b, { x: pos.x + 10000, y: pos.y + 880 });
  // DD/FD (IX+d)/(IY+d) LD + INCDEC writes — side-folded before RRD.
  const ddMemLdWeAny = buildOr(parent, { x: pos.x + 10250, y: pos.y + 870 });
  tieToLabel('DDMEMLD_WRITE_NOW', ddMemLdWeAny.a, { x: pos.x + 10150, y: pos.y + 870 });
  tieToLabel('DDMEMLDN_WRITE_NOW', ddMemLdWeAny.b, { x: pos.x + 10150, y: pos.y + 890 });
  const fdMemLdWeAny = buildOr(parent, { x: pos.x + 10250, y: pos.y + 910 });
  tieToLabel('FDMEMLD_WRITE_NOW', fdMemLdWeAny.a, { x: pos.x + 10150, y: pos.y + 910 });
  tieToLabel('FDMEMLDN_WRITE_NOW', fdMemLdWeAny.b, { x: pos.x + 10150, y: pos.y + 930 });
  const ddFdMemLdWeAny = buildOr(parent, { x: pos.x + 10300, y: pos.y + 890 });
  wire(parent, ddMemLdWeAny.out, ddFdMemLdWeAny.a);
  wire(parent, fdMemLdWeAny.out, ddFdMemLdWeAny.b);
  const ddFdMemIncDecWe = buildOr(parent, { x: pos.x + 10250, y: pos.y + 950 });
  tieToLabel('DDMEM_INCDEC_WRITE_NOW', ddFdMemIncDecWe.a, { x: pos.x + 10150, y: pos.y + 950 });
  tieToLabel('FDMEM_INCDEC_WRITE_NOW', ddFdMemIncDecWe.b, { x: pos.x + 10150, y: pos.y + 970 });
  const ddFdCbSetResWe = buildOr(parent, { x: pos.x + 10250, y: pos.y + 990 });
  tieToLabel('SETRES_IX_WRITE_NOW', ddFdCbSetResWe.a, { x: pos.x + 10150, y: pos.y + 990 });
  tieToLabel('SETRES_IY_WRITE_NOW', ddFdCbSetResWe.b, { x: pos.x + 10150, y: pos.y + 1010 });
  const ddFdCbRotWe = buildOr(parent, { x: pos.x + 10250, y: pos.y + 1030 });
  tieToLabel('CBROT_IX_WRITE_NOW', ddFdCbRotWe.a, { x: pos.x + 10150, y: pos.y + 1030 });
  tieToLabel('CBROT_IY_WRITE_NOW', ddFdCbRotWe.b, { x: pos.x + 10150, y: pos.y + 1050 });
  const ddFdCbMemWe = buildOr(parent, { x: pos.x + 10300, y: pos.y + 1010 });
  wire(parent, ddFdCbSetResWe.out, ddFdCbMemWe.a);
  wire(parent, ddFdCbRotWe.out, ddFdCbMemWe.b);
  const ddFdMemWeAny = buildOr(parent, { x: pos.x + 10300, y: pos.y + 920 });
  wire(parent, ddFdMemLdWeAny.out, ddFdMemWeAny.a);
  wire(parent, ddFdMemIncDecWe.out, ddFdMemWeAny.b);
  const ddFdMemWeAny2 = buildOr(parent, { x: pos.x + 10350, y: pos.y + 960 });
  wire(parent, ddFdMemWeAny.out, ddFdMemWeAny2.a);
  wire(parent, ddFdCbMemWe.out, ddFdMemWeAny2.b);
  // RAM WE OR — sequential left-associated OR of every write enable (same
  // order as the former ramWeStage…ramWeFinal4 chain). Side-folds above
  // feed as single inputs; RRDRLD_WRITE_NOW is deliberately the *last*
  // term so WE path depth for RRD/RLD stays unchanged.
  const ramWeOrDef = getOrNChip(library, 16, 'RAM_WE_OR');
  const ramWeOr = makeChipInstance(parent, ramWeOrDef, { x: pos.x + 9600, y: pos.y + 300 });
  const ramWeIn = (idx: number) => ramWeOr.pins[ramWeOrDef.ports[idx]!]!;
  wire(parent, ramWriteNow.out, ramWeIn(0));
  wire(parent, stackWriteNowIrq.out, ramWeIn(1));
  tieToLabel('LDBCA_NOW', ramWeIn(2), { x: pos.x + 9500, y: pos.y + 350 });
  tieToLabel('LDDEA_NOW', ramWeIn(3), { x: pos.x + 9500, y: pos.y + 400 });
  tieToLabel('LDNNA_NOW', ramWeIn(4), { x: pos.x + 9500, y: pos.y + 450 });
  tieToLabel('LDNNHL_LOW_NOW', ramWeIn(5), { x: pos.x + 9500, y: pos.y + 500 });
  tieToLabel('LDNNHL_HIGH_NOW', ramWeIn(6), { x: pos.x + 9500, y: pos.y + 550 });
  wire(parent, hlMemWeTerms2.out, ramWeIn(7));
  tieToLabel('LDHLN_WRITE_NOW', ramWeIn(8), { x: pos.x + 9500, y: pos.y + 650 });
  wire(parent, exSpWriteLowAny2.out, ramWeIn(9));
  wire(parent, exSpWriteHighAny2.out, ramWeIn(10));
  tieToLabel('LDBLOCK_WRITE_NOW', ramWeIn(11), { x: pos.x + 9800, y: pos.y + 800 });
  tieToLabel('INBLOCK_WRITE_NOW', ramWeIn(12), { x: pos.x + 9900, y: pos.y + 825 });
  wire(parent, edNnWeAny.out, ramWeIn(13));
  wire(parent, ddFdMemWeAny2.out, ramWeIn(14));
  tieToLabel('RRDRLD_WRITE_NOW', ramWeIn(15), { x: pos.x + 10300, y: pos.y + 850 });
  wire(parent, ramWeOr.pins[ramWeOrDef.ports[16]!]!, ram.pins.we!);

  // ramOe's FETCH term is deliberately gated by NOT(groupActive), not bare
  // phase0. A ring counter's rotation passes through a transient window
  // where the old and new phase bits both read 1 (phase0 and phase2
  // simultaneously, mid-relaxation — an expected artifact of this
  // zero-delay solver, not a bug); a bare `OR(phase0, hlNow)` would let
  // RAM start driving ir.d for the *next* fetch before the 7 operand-bus
  // tri-buf banks (gated by groupActive, one hop behind phase2's own drop)
  // have physically released it — a real, if transient, bus fight that
  // cascades into contention on the shared VCC/GND rails and corrupts
  // completely unrelated nets, phase included. Deriving the exclusion
  // straight from groupActive (rather than trusting phase0 and phase2 to
  // settle in lockstep) ties RAM's drive to the SAME signal — and thus the
  // SAME settling latency — every bus driver this slice has releases on, so
  // none of them can outrace it.
  const notBusActive = buildNot(parent, { x: pos.x + 9450, y: pos.y - 350 });
  wire(parent, busActiveFinal.out, notBusActive.in);
  const fetchRead = buildAnd(parent, { x: pos.x + 9550, y: pos.y - 300 });
  tieToLabel('PHASE0', fetchRead.a, { x: pos.x + 9450, y: pos.y - 300 });
  wire(parent, notBusActive.out, fetchRead.b);
  // INC (HL)/DEC (HL), BIT (HL), SET/RES (HL), CBROT (HL) reads — side-fold
  // so the main OE OR does not grow sequential stages. Pair the four terms
  // as two ORs then one merge (never leave an OR input floating — found live:
  // dangling `.b` stuck the fold high → addr forever = HL → every immediate
  // read returned RAM[0]/opcode).
  const hlMemReads = buildOr(parent, { x: pos.x + 9550, y: pos.y - 1200 });
  tieToLabel('HLMEM_READ_NOW', hlMemReads.a, { x: pos.x + 9450, y: pos.y - 1200 });
  tieToLabel('BIT_HL_READ_NOW', hlMemReads.b, { x: pos.x + 9450, y: pos.y - 1220 });
  const hlMemReads2 = buildOr(parent, { x: pos.x + 9520, y: pos.y - 1210 });
  tieToLabel('SETRES_HL_READ_NOW', hlMemReads2.a, { x: pos.x + 9420, y: pos.y - 1240 });
  tieToLabel('CBROT_HL_READ_NOW', hlMemReads2.b, { x: pos.x + 9420, y: pos.y - 1260 });
  const hlMemReadsAny = buildOr(parent, { x: pos.x + 9490, y: pos.y - 1220 });
  wire(parent, hlMemReads.out, hlMemReadsAny.a);
  wire(parent, hlMemReads2.out, hlMemReadsAny.b);
  // EX (SP),HL / IX / IY reads — side-folded then merged into two terms.
  const exSpReadLowAny = buildOr(parent, { x: pos.x + 9650, y: pos.y - 100 });
  tieToLabel('EXSPHL_READ_LOW_NOW', exSpReadLowAny.a, { x: pos.x + 9550, y: pos.y - 100 });
  tieToLabel('EXSPIX_READ_LOW_NOW', exSpReadLowAny.b, { x: pos.x + 9550, y: pos.y - 80 });
  const exSpReadLowAny2 = buildOr(parent, { x: pos.x + 9680, y: pos.y - 90 });
  wire(parent, exSpReadLowAny.out, exSpReadLowAny2.a);
  tieToLabel('EXSPIY_READ_LOW_NOW', exSpReadLowAny2.b, { x: pos.x + 9580, y: pos.y - 70 });
  const exSpReadHighAny = buildOr(parent, { x: pos.x + 9700, y: pos.y - 50 });
  tieToLabel('EXSPHL_READ_HIGH_NOW', exSpReadHighAny.a, { x: pos.x + 9600, y: pos.y - 50 });
  tieToLabel('EXSPIX_READ_HIGH_NOW', exSpReadHighAny.b, { x: pos.x + 9600, y: pos.y - 30 });
  const exSpReadHighAny2 = buildOr(parent, { x: pos.x + 9730, y: pos.y - 40 });
  wire(parent, exSpReadHighAny.out, exSpReadHighAny2.a);
  tieToLabel('EXSPIY_READ_HIGH_NOW', exSpReadHighAny2.b, { x: pos.x + 9630, y: pos.y - 20 });
  // ED LD (nn),dd reads — four terms folded into a side tree, then merged
  // *before* RRD/RLD. Found live chasing the RRD regression: each sequential
  // OR after RRD delayed OE enough that the PHASE4 bus fight cascaded into
  // VCC/GND contention that froze the ring at PHASE4. Side-folding EDNN and
  // keeping RRD as the *final* OE term restores the pre-EDNN path depth.
  const edNnOeImm = buildOr(parent, { x: pos.x + 10100, y: pos.y + 150 });
  tieToLabel('EDNN_IMM_LOW_NOW', edNnOeImm.a, { x: pos.x + 10000, y: pos.y + 150 });
  tieToLabel('EDNN_IMM_HIGH_NOW', edNnOeImm.b, { x: pos.x + 10000, y: pos.y + 170 });
  const edNnOeData = buildOr(parent, { x: pos.x + 10100, y: pos.y + 200 });
  tieToLabel('EDNN_READ_LOW_NOW', edNnOeData.a, { x: pos.x + 10000, y: pos.y + 200 });
  tieToLabel('EDNN_READ_HIGH_NOW', edNnOeData.b, { x: pos.x + 10000, y: pos.y + 220 });
  const edNnOeAny = buildOr(parent, { x: pos.x + 10150, y: pos.y + 175 });
  wire(parent, edNnOeImm.out, edNnOeAny.a);
  wire(parent, edNnOeData.out, edNnOeAny.b);
  // LD IX,nn / LD IY,nn's PC-relative immediate reads — side-folded like EDNN.
  const ldIxNnOe = buildOr(parent, { x: pos.x + 10250, y: pos.y + 150 });
  tieToLabel('LDIXNN_LOW_NOW', ldIxNnOe.a, { x: pos.x + 10150, y: pos.y + 150 });
  tieToLabel('LDIXNN_HIGH_NOW', ldIxNnOe.b, { x: pos.x + 10150, y: pos.y + 170 });
  const ldIyNnOe = buildOr(parent, { x: pos.x + 10250, y: pos.y + 190 });
  tieToLabel('LDIYNN_LOW_NOW', ldIyNnOe.a, { x: pos.x + 10150, y: pos.y + 190 });
  tieToLabel('LDIYNN_HIGH_NOW', ldIyNnOe.b, { x: pos.x + 10150, y: pos.y + 210 });
  const ldIxIyNnOe = buildOr(parent, { x: pos.x + 10300, y: pos.y + 170 });
  wire(parent, ldIxNnOe.out, ldIxIyNnOe.a);
  wire(parent, ldIyNnOe.out, ldIxIyNnOe.b);
  // DD/FD (IX+d)/(IY+d) mem reads — side-folded before RRD (same depth rule).
  const ddDispOe = buildOr(parent, { x: pos.x + 10400, y: pos.y + 160 });
  tieToLabel('DDDISP_READ_NOW', ddDispOe.a, { x: pos.x + 10300, y: pos.y + 160 });
  tieToLabel('DDMEMLD_READ_NOW', ddDispOe.b, { x: pos.x + 10300, y: pos.y + 180 });
  const ddMemLdNOe = buildOr(parent, { x: pos.x + 10400, y: pos.y + 200 });
  wire(parent, ddDispOe.out, ddMemLdNOe.a);
  tieToLabel('DDMEMLDN_IMM_READ_NOW', ddMemLdNOe.b, { x: pos.x + 10300, y: pos.y + 200 });
  const ddMemIncDecAluOe = buildOr(parent, { x: pos.x + 10400, y: pos.y + 220 });
  tieToLabel('DDMEM_INCDEC_READ_NOW', ddMemIncDecAluOe.a, { x: pos.x + 10300, y: pos.y + 220 });
  tieToLabel('DDMEM_ALU_NOW', ddMemIncDecAluOe.b, { x: pos.x + 10300, y: pos.y + 240 });
  const ddCbOe = buildOr(parent, { x: pos.x + 10400, y: pos.y + 260 });
  tieToLabel('DDCB_OP_READ_NOW', ddCbOe.a, { x: pos.x + 10300, y: pos.y + 260 });
  tieToLabel('BIT_IX_NOW', ddCbOe.b, { x: pos.x + 10300, y: pos.y + 280 });
  const ddCbOeSetRot = buildOr(parent, { x: pos.x + 10400, y: pos.y + 300 });
  tieToLabel('SETRES_IX_READ_NOW', ddCbOeSetRot.a, { x: pos.x + 10300, y: pos.y + 300 });
  tieToLabel('CBROT_IX_READ_NOW', ddCbOeSetRot.b, { x: pos.x + 10300, y: pos.y + 320 });
  const ddCbOeAny = buildOr(parent, { x: pos.x + 10450, y: pos.y + 280 });
  wire(parent, ddCbOe.out, ddCbOeAny.a);
  wire(parent, ddCbOeSetRot.out, ddCbOeAny.b);
  const ddMemOeAny = buildOr(parent, { x: pos.x + 10450, y: pos.y + 210 });
  wire(parent, ddMemLdNOe.out, ddMemOeAny.a);
  wire(parent, ddMemIncDecAluOe.out, ddMemOeAny.b);
  const ddMemOeAny2 = buildOr(parent, { x: pos.x + 10500, y: pos.y + 230 });
  wire(parent, ddMemOeAny.out, ddMemOeAny2.a);
  wire(parent, ddCbOeAny.out, ddMemOeAny2.b);
  const fdDispOe = buildOr(parent, { x: pos.x + 10500, y: pos.y + 160 });
  tieToLabel('FDDISP_READ_NOW', fdDispOe.a, { x: pos.x + 10400, y: pos.y + 160 });
  tieToLabel('FDMEMLD_READ_NOW', fdDispOe.b, { x: pos.x + 10400, y: pos.y + 180 });
  const fdMemLdNOe = buildOr(parent, { x: pos.x + 10500, y: pos.y + 200 });
  wire(parent, fdDispOe.out, fdMemLdNOe.a);
  tieToLabel('FDMEMLDN_IMM_READ_NOW', fdMemLdNOe.b, { x: pos.x + 10400, y: pos.y + 200 });
  const fdMemIncDecAluOe = buildOr(parent, { x: pos.x + 10500, y: pos.y + 220 });
  tieToLabel('FDMEM_INCDEC_READ_NOW', fdMemIncDecAluOe.a, { x: pos.x + 10400, y: pos.y + 220 });
  tieToLabel('FDMEM_ALU_NOW', fdMemIncDecAluOe.b, { x: pos.x + 10400, y: pos.y + 240 });
  const fdCbOe = buildOr(parent, { x: pos.x + 10500, y: pos.y + 260 });
  tieToLabel('FDCB_OP_READ_NOW', fdCbOe.a, { x: pos.x + 10400, y: pos.y + 260 });
  tieToLabel('BIT_IY_NOW', fdCbOe.b, { x: pos.x + 10400, y: pos.y + 280 });
  const fdCbOeSetRot = buildOr(parent, { x: pos.x + 10500, y: pos.y + 300 });
  tieToLabel('SETRES_IY_READ_NOW', fdCbOeSetRot.a, { x: pos.x + 10400, y: pos.y + 300 });
  tieToLabel('CBROT_IY_READ_NOW', fdCbOeSetRot.b, { x: pos.x + 10400, y: pos.y + 320 });
  const fdCbOeAny = buildOr(parent, { x: pos.x + 10550, y: pos.y + 280 });
  wire(parent, fdCbOe.out, fdCbOeAny.a);
  wire(parent, fdCbOeSetRot.out, fdCbOeAny.b);
  const fdMemOeAny = buildOr(parent, { x: pos.x + 10550, y: pos.y + 210 });
  wire(parent, fdMemLdNOe.out, fdMemOeAny.a);
  wire(parent, fdMemIncDecAluOe.out, fdMemOeAny.b);
  const fdMemOeAny2 = buildOr(parent, { x: pos.x + 10600, y: pos.y + 230 });
  wire(parent, fdMemOeAny.out, fdMemOeAny2.a);
  wire(parent, fdCbOeAny.out, fdMemOeAny2.b);
  const ddFdDispOe = buildOr(parent, { x: pos.x + 10650, y: pos.y + 180 });
  wire(parent, ddMemOeAny2.out, ddFdDispOe.a);
  wire(parent, fdMemOeAny2.out, ddFdDispOe.b);
  // DD/FD HL8 LD IXH/IXL,n — PHASE4 immediate read @ PC.
  const ddFdHl8ImmOe = buildOr(parent, { x: pos.x + 10650, y: pos.y + 170 });
  tieToLabel('DDIX_HL8_IMM_READ_NOW', ddFdHl8ImmOe.a, { x: pos.x + 10550, y: pos.y + 170 });
  tieToLabel('FDIY_HL8_IMM_READ_NOW', ddFdHl8ImmOe.b, { x: pos.x + 10550, y: pos.y + 190 });
  // RAM OE OR — sequential left-associated OR of every read enable (same
  // order as the former ramOeStage…ramOeFinal5 chain). Side-folds above feed
  // as single inputs; IM2 vector reads are last so OE path depth for earlier
  // terms stays unchanged.
  const ramOeOrDef = getOrNChip(library, 37, 'RAM_OE_OR');
  const ramOeOr = makeChipInstance(parent, ramOeOrDef, { x: pos.x + 9600, y: pos.y - 400 });
  const ramOeIn = (idx: number) => ramOeOr.pins[ramOeOrDef.ports[idx]!]!;
  wire(parent, fetchRead.out, ramOeIn(0));
  wire(parent, hlNow.out, ramOeIn(1));
  tieToLabel('LDIMM8_READ_NOW', ramOeIn(2), { x: pos.x + 9500, y: pos.y - 250 });
  tieToLabel('LDDDNN_LOW_NOW', ramOeIn(3), { x: pos.x + 9500, y: pos.y - 300 });
  tieToLabel('LDDDNN_HIGH_NOW', ramOeIn(4), { x: pos.x + 9500, y: pos.y - 350 });
  tieToLabel('JP_READ_LOW_NOW', ramOeIn(5), { x: pos.x + 9500, y: pos.y - 400 });
  tieToLabel('JP_READ_HIGH_NOW', ramOeIn(6), { x: pos.x + 9500, y: pos.y - 450 });
  tieToLabel('CALL_READ_LOW_NOW', ramOeIn(7), { x: pos.x + 9500, y: pos.y - 500 });
  tieToLabel('CALL_READ_HIGH_NOW', ramOeIn(8), { x: pos.x + 9500, y: pos.y - 550 });
  tieToLabel('JPCC_READ_LOW_NOW', ramOeIn(9), { x: pos.x + 9500, y: pos.y - 600 });
  tieToLabel('JPCC_READ_HIGH_NOW', ramOeIn(10), { x: pos.x + 9500, y: pos.y - 650 });
  tieToLabel('CALLCC_READ_LOW_NOW', ramOeIn(11), { x: pos.x + 9500, y: pos.y - 700 });
  tieToLabel('CALLCC_READ_HIGH_NOW', ramOeIn(12), { x: pos.x + 9500, y: pos.y - 750 });
  tieToLabel('JR_READ_NOW', ramOeIn(13), { x: pos.x + 9500, y: pos.y - 800 });
  tieToLabel('LDABC_NOW', ramOeIn(14), { x: pos.x + 9500, y: pos.y - 850 });
  tieToLabel('LDADE_NOW', ramOeIn(15), { x: pos.x + 9500, y: pos.y - 900 });
  tieToLabel('NN_READ_LOW_NOW', ramOeIn(16), { x: pos.x + 9500, y: pos.y - 950 });
  tieToLabel('NN_READ_HIGH_NOW', ramOeIn(17), { x: pos.x + 9500, y: pos.y - 1000 });
  tieToLabel('LDHLNN_LOW_NOW', ramOeIn(18), { x: pos.x + 9500, y: pos.y - 1050 });
  tieToLabel('LDHLNN_HIGH_NOW', ramOeIn(19), { x: pos.x + 9500, y: pos.y - 1100 });
  tieToLabel('LDANN_NOW', ramOeIn(20), { x: pos.x + 9500, y: pos.y - 1150 });
  wire(parent, hlMemReadsAny.out, ramOeIn(21));
  wire(parent, readNow.out, ramOeIn(22));
  wire(parent, exSpReadLowAny2.out, ramOeIn(23));
  wire(parent, exSpReadHighAny2.out, ramOeIn(24));
  tieToLabel('ALUIMM8_READ_NOW', ramOeIn(25), { x: pos.x + 9700, y: pos.y - 25 });
  tieToLabel('IOIMM_READ_NOW', ramOeIn(26), { x: pos.x + 9750, y: pos.y + 0 });
  tieToLabel('PREFIX_READ_NOW', ramOeIn(27), { x: pos.x + 9800, y: pos.y + 25 });
  tieToLabel('LDBLOCK_READ_NOW', ramOeIn(28), { x: pos.x + 9850, y: pos.y + 50 });
  tieToLabel('CPBLOCK_READ_NOW', ramOeIn(29), { x: pos.x + 9900, y: pos.y + 75 });
  tieToLabel('OUTBLOCK_READ_NOW', ramOeIn(30), { x: pos.x + 9950, y: pos.y + 100 });
  wire(parent, edNnOeAny.out, ramOeIn(31));
  wire(parent, ldIxIyNnOe.out, ramOeIn(32));
  wire(parent, ddFdDispOe.out, ramOeIn(33));
  wire(parent, ddFdHl8ImmOe.out, ramOeIn(34));
  tieToLabel('RRDRLD_READ_NOW', ramOeIn(35), { x: pos.x + 10650, y: pos.y + 125 });
  const im2ReadAny = buildOr(parent, { x: pos.x + 10650, y: pos.y + 145 });
  tieToLabel('IM2_READ_LO_NOW', im2ReadAny.a, { x: pos.x + 10550, y: pos.y + 145 });
  tieToLabel('IM2_READ_HI_NOW', im2ReadAny.b, { x: pos.x + 10550, y: pos.y + 165 });
  wire(parent, im2ReadAny.out, ramOeIn(36));
  wire(parent, ramOeOr.pins[ramOeOrDef.ports[37]!]!, ram.pins.oe!);

  // SP's own +-1 adder: a *second* buildAlu instance (width addrBits, not
  // 8), permanently in ADD mode, b fanned from spWantDec to every bit —
  // see the doc comment above ("x=11: SP, PUSH/POP, RET, RST n") for why
  // b=0/cin=1 computes SP+1, while b=all-1s (already the full two's-
  // complement encoding of -1, needing no extra +1 on top) pairs with
  // cin=0 to compute SP-1 — cin=1 there would silently add 1 too many,
  // wrapping straight back to SP unchanged (found live: spAdder.out read
  // right back as sp.q, every single decrement, until this was cin=0).
  //
  // spWantDec widens the original STACK_WRITE_NOW-only direction (x=11's
  // PUSH/RST) with DEC_SP_NOW (x=00 z=3 y=7's explicit DEC SP, see "x=00,
  // z=3" above) — an OR, so with DEC_SP_NOW=0 (every x=11 case, and every
  // x=00 case except DEC SP itself) this is exactly the original signal,
  // unchanged. The two can never both be 1 at once regardless: `dec.x`
  // one-hot decodes a single opcode's x value, so x=00 (DEC SP) and x=11
  // (PUSH/RST) are mutually exclusive by construction, not by this OR
  // happening to work out.
  const spAdder = buildAlu(parent, library, addrBits, { x: pos.x + 8400, y: pos.y + 3000 });
  const spWantDec = buildOr(parent, { x: pos.x + 8300, y: pos.y + 2900 });
  tieToLabel('STACK_WRITE_NOW', spWantDec.a, { x: pos.x + 8200, y: pos.y + 2900 });
  tieToLabel('DEC_SP_NOW', spWantDec.b, { x: pos.x + 8200, y: pos.y + 2930 });
  const notSpWantDec = buildNot(parent, { x: pos.x + 8300, y: pos.y + 2950 });
  wire(parent, spWantDec.out, notSpWantDec.in);
  wire(parent, notSpWantDec.out, spAdder.cin);
  tiePowerRail(parent, 'GND', spAdder.op0);
  tiePowerRail(parent, 'GND', spAdder.op1);
  sp.q.forEach((q, i) => {
    wire(parent, q, spAdder.a[i]!);
    tieToLabel(`SP_Q${i}`, q, { x: pos.x + 7900, y: pos.y + 3000 + i * 20 }); // anchor — the far address-mux write/readMux below read this via the label
  });
  spAdder.b.forEach((b, i) => wire(parent, spWantDec.out, b)); // local now — spWantDec sits right next to spAdder, no label needed for this hop

  // RAM's address bus: PC, except when this instruction reads/writes (HL)
  // (hlNow / ramWriteNow, x=10/x=01, unchanged) or the stack itself — and
  // both the write side (stackWriteNow) and the read side (readNow)
  // address with bare `sp.q`, no adder, deliberately.
  //
  // That's only correct because of a real, subtle asymmetry this solver
  // has between its one behavioral component and everything built from
  // real transistors. RAM (the deliberate non-transistor exception — see
  // "Real RAM") commits its write "once per tick," using the address as it
  // reads at full settlement — by which point `sp.q` *already* reflects
  // its post-this-edge value (SP's own capture has nothing forcing it to
  // wait), so bare `sp.q` at settle time already equals the write target.
  // An ordinary register's capture (`buildRegisterBit`/`buildDFlipFlop`,
  // real master-slave latches) works the opposite way: "the master closes
  // first, freezing at the D value it *last saw*" while CLK was still low
  // — i.e., whatever was stable *before* this edge started, not whatever
  // the rest of the circuit eventually settles to *during* it. So when a
  // register captures a byte read *through* `sp.q` (POP/RET, via RAM's
  // read forcing `ir.d`), it sees `sp.q` as it stood right before this
  // edge — the *old*, not-yet-incremented value, exactly what a read
  // needs. Two structurally different components, asked for two different
  // things (the new address for a write, the old one for a read), and
  // bare `sp.q` happens to be correct for both — not a coincidence so much
  // as the reason RAM is the one deliberate behavioral exception in this
  // whole codebase (see "Real RAM"): a real transistor-level register
  // literally cannot supply "the settled value from a still-in-progress
  // edge" the way RAM's edge-triggered write can, because nothing about
  // its own topology waits for anything else to finish.
  //
  // The debugging path here went through two wrong turns before this,
  // worth recording since they're easy to reach for again: (1) a
  // dedicated "sp.q - 1" adder for reads, reasoning from what a *settled*
  // snapshot of the whole circuit showed after the edge — which is exactly
  // the wrong reference point for what a real flip-flop actually captures;
  // (2) suspecting insufficient relaxation depth (retried at 2000
  // iterations, no change) — ruled out because the actual mechanism is
  // structural (which value a master latch freezes on), not a matter of
  // giving the solver more passes to converge.
  const addrIsHlStage = buildOr(parent, { x: pos.x + 550, y: pos.y - 400 });
  wire(parent, hlNow.out, addrIsHlStage.a);
  wire(parent, ramWriteNow.out, addrIsHlStage.b);
  // INC (HL)/DEC (HL) (see "x=00: INC (HL)/DEC (HL)/LD (HL),n" above):
  // `HLMEM_READ_NOW` (`PHASE2`) and `INCDEC_HLMEM_NOW` (`PHASE3`)
  // specifically — NOT the unconditional `IS_INCDEC_HLMEM` this used to
  // read. Found live: `IS_INCDEC_HLMEM` stays high for the whole
  // instruction, `dec.y`/`dec.z` included, which are themselves derived
  // from `ir.q` — and `ir.q` doesn't actually update to the *next*
  // opcode until the very same tick `FETCH`'s own read commits. During
  // that shared tick, this instruction's own decode (still reading the
  // *old*, pre-update `ir.q`) was still asserting `IS_INCDEC_HLMEM`,
  // forcing RAM's address to stay `HL` at the exact moment `FETCH`
  // needed it to be `PC` — the fetch silently read `RAM[HL]` instead of
  // the real next opcode, corrupting `ir` itself. `hlNow`'s own existing
  // x=10/x=01 case never had this problem because it was already
  // `PHASE2`-scoped from the start (folded into `groupActive`, itself
  // `PHASE2`-gated) — this fix just gives `(HL)`'s own RMW the identical
  // discipline: force the address only during the phases that actually
  // touch RAM, not for the instruction's entire lifetime.
  const addrIsHlStage2 = buildOr(parent, { x: pos.x + 600, y: pos.y - 420 });
  wire(parent, addrIsHlStage.out, addrIsHlStage2.a);
  // Side-fold INC/DEC (HL) / BIT (HL) / SETRES (HL) reads — all need
  // addr=HL for exactly one phase. Same floating-input trap as the OE
  // fold above: both original terms stay on the first OR.
  // Side-fold (HL) reads — same paired-OR shape as the OE fold above.
  const addrHlReads = buildOr(parent, { x: pos.x + 580, y: pos.y - 440 });
  tieToLabel('HLMEM_READ_NOW', addrHlReads.a, { x: pos.x + 480, y: pos.y - 420 });
  tieToLabel('BIT_HL_READ_NOW', addrHlReads.b, { x: pos.x + 460, y: pos.y - 440 });
  const addrHlReads2 = buildOr(parent, { x: pos.x + 560, y: pos.y - 450 });
  tieToLabel('SETRES_HL_READ_NOW', addrHlReads2.a, { x: pos.x + 440, y: pos.y - 460 });
  tieToLabel('CBROT_HL_READ_NOW', addrHlReads2.b, { x: pos.x + 420, y: pos.y - 480 });
  const addrHlReadsAny = buildOr(parent, { x: pos.x + 540, y: pos.y - 460 });
  wire(parent, addrHlReads.out, addrHlReadsAny.a);
  wire(parent, addrHlReads2.out, addrHlReadsAny.b);
  wire(parent, addrHlReadsAny.out, addrIsHlStage2.b);
  const addrIsHlStage3 = buildOr(parent, { x: pos.x + 620, y: pos.y - 430 });
  wire(parent, addrIsHlStage2.out, addrIsHlStage3.a);
  const hlMemWrites = buildOr(parent, { x: pos.x + 580, y: pos.y - 470 });
  tieToLabel('INCDEC_HLMEM_NOW', hlMemWrites.a, { x: pos.x + 480, y: pos.y - 470 });
  tieToLabel('SETRES_HL_WRITE_NOW', hlMemWrites.b, { x: pos.x + 480, y: pos.y - 490 });
  const hlMemWrites2 = buildOr(parent, { x: pos.x + 560, y: pos.y - 480 });
  wire(parent, hlMemWrites.out, hlMemWrites2.a);
  tieToLabel('CBROT_HL_WRITE_NOW', hlMemWrites2.b, { x: pos.x + 460, y: pos.y - 500 });
  wire(parent, hlMemWrites2.out, addrIsHlStage3.b);
  // `LD (HL),n`'s own write (see "x=00: INC (HL)/DEC (HL)/LD (HL),n"
  // above) needs `HL` only while it's actually writing (`PHASE4`) — its
  // own read phase (`PHASE2`) still needs `PC`, to read the immediate
  // byte itself.
  const addrIsHl = buildOr(parent, { x: pos.x + 650, y: pos.y - 440 });
  wire(parent, addrIsHlStage3.out, addrIsHl.a);
  tieToLabel('LDHLN_WRITE_NOW', addrIsHl.b, { x: pos.x + 550, y: pos.y - 440 });

  // `LDIR`/`LDDR`'s own repeat (see "x=10, z=0: LDI/LDD/LDIR/LDDR" above):
  // fires only for the two repeating variants (`LDBLOCK_REPEAT_VARIANT_NOW`),
  // only while there's still more to copy (`BLOCK_PV_NOW`, this pass's
  // own fresh `BC-1 != 0`), and only on the exact tick the register commit
  // itself lands (`LDBLOCK_COMMIT_NOW`, already correctly one-shot-per-
  // instruction — see its own doc comment above) — the identical
  // "borrow an already-phase-gated signal rather than re-derive the
  // timing from scratch" reasoning that signal's own construction used.
  const ldBlockRepeatStage = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5150 });
  tieToLabel('LDBLOCK_REPEAT_VARIANT_NOW', ldBlockRepeatStage.a, { x: pos.x - 850, y: pos.y - 5150 });
  tieToLabel('BLOCK_PV_NOW', ldBlockRepeatStage.b, { x: pos.x - 850, y: pos.y - 5130 });
  const ldBlockRepeatNow = buildAnd(parent, { x: pos.x - 700, y: pos.y - 5150 });
  wire(parent, ldBlockRepeatStage.out, ldBlockRepeatNow.a);
  tieToLabel('LDBLOCK_COMMIT_NOW', ldBlockRepeatNow.b, { x: pos.x - 800, y: pos.y - 5170 });
  tieToLabel('LDBLOCK_REPEAT_NOW', ldBlockRepeatNow.out, { x: pos.x - 650, y: pos.y - 5150 }); // anchor — pc's own mux chain (far) reads this

  // `CPIR`/`CPDR`'s own repeat (see "x=10, z=1: CPI/CPD/CPIR/CPDR" above):
  // the identical three-term shape `LDIR`/`LDDR`'s own gate just above
  // uses, plus a fourth — real Z80 stops repeating the moment `BC` hits
  // `0` *or* a match is found, unlike `LDIR`/`LDDR`, which only ever
  // watches `BC`. `CPBLOCK_NOT_FOUND_NOW` (this pass's own fresh "result
  // != 0", built alongside the dedicated adder below) is that fourth
  // term — the same signal `Z` itself is the logical complement of, read
  // here before that adder's own commit rather than after, since the
  // repeat decision needs *this* comparison's outcome, not the previous
  // instruction's leftover `Z`.
  const cpBlockRepeatStage = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5200 });
  tieToLabel('CPBLOCK_REPEAT_VARIANT_NOW', cpBlockRepeatStage.a, { x: pos.x - 850, y: pos.y - 5200 });
  tieToLabel('BLOCK_PV_NOW', cpBlockRepeatStage.b, { x: pos.x - 850, y: pos.y - 5180 });
  const cpBlockRepeatStage2 = buildAnd(parent, { x: pos.x - 700, y: pos.y - 5200 });
  wire(parent, cpBlockRepeatStage.out, cpBlockRepeatStage2.a);
  tieToLabel('CPBLOCK_NOT_FOUND_NOW', cpBlockRepeatStage2.b, { x: pos.x - 800, y: pos.y - 5220 });
  const cpBlockRepeatNow = buildAnd(parent, { x: pos.x - 650, y: pos.y - 5200 });
  wire(parent, cpBlockRepeatStage2.out, cpBlockRepeatNow.a);
  tieToLabel('CPBLOCK_COMMIT_NOW', cpBlockRepeatNow.b, { x: pos.x - 750, y: pos.y - 5220 });
  tieToLabel('CPBLOCK_REPEAT_NOW', cpBlockRepeatNow.out, { x: pos.x - 600, y: pos.y - 5200 }); // anchor — pc's own mux chain (far) reads this

  // `INIR`/`INDR`'s own repeat (see "x=10, z=2: INI/IND/INIR/INDR"
  // above): the simplest of this file's three repeat gates — only two
  // terms, since real Z80 stops this family purely on `B` reaching `0`,
  // no "found it" concept the way `CPIR`/`CPDR` also needs to watch for.
  // `IOB_NONZERO_NOW` (built alongside `B`'s own dedicated adder, far
  // below) is read forward through its own anchor label, the same
  // "built later in the file, read earlier through a label" shape
  // `BLOCK_PV_NOW` already establishes for the other two repeat gates.
  const inBlockRepeatStage = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5250 });
  tieToLabel('INBLOCK_REPEAT_VARIANT_NOW', inBlockRepeatStage.a, { x: pos.x - 850, y: pos.y - 5250 });
  tieToLabel('IOB_NONZERO_NOW', inBlockRepeatStage.b, { x: pos.x - 850, y: pos.y - 5230 });
  const inBlockRepeatNow = buildAnd(parent, { x: pos.x - 700, y: pos.y - 5250 });
  wire(parent, inBlockRepeatStage.out, inBlockRepeatNow.a);
  tieToLabel('INBLOCK_COMMIT_NOW', inBlockRepeatNow.b, { x: pos.x - 800, y: pos.y - 5270 });
  tieToLabel('INBLOCK_REPEAT_NOW', inBlockRepeatNow.out, { x: pos.x - 650, y: pos.y - 5250 }); // anchor — pc's own mux chain (far) reads this

  // `OTIR`/`OTDR`'s own repeat (see "x=10, z=3: OUTI/OUTD/OTIR/OTDR"
  // above): the identical two-term shape `INIR`/`INDR`'s own gate just
  // above uses, reading the same shared `IOB_NONZERO_NOW` (decrementing
  // `B` is the identical operation regardless of transfer direction),
  // gated by this family's own `OUTBLOCK_COMMIT_NOW` instead.
  const outBlockRepeatStage = buildAnd(parent, { x: pos.x - 750, y: pos.y - 5300 });
  tieToLabel('OUTBLOCK_REPEAT_VARIANT_NOW', outBlockRepeatStage.a, { x: pos.x - 850, y: pos.y - 5300 });
  tieToLabel('IOB_NONZERO_NOW', outBlockRepeatStage.b, { x: pos.x - 850, y: pos.y - 5280 });
  const outBlockRepeatNow = buildAnd(parent, { x: pos.x - 700, y: pos.y - 5300 });
  wire(parent, outBlockRepeatStage.out, outBlockRepeatNow.a);
  tieToLabel('OUTBLOCK_COMMIT_NOW', outBlockRepeatNow.b, { x: pos.x - 800, y: pos.y - 5320 });
  tieToLabel('OUTBLOCK_REPEAT_NOW', outBlockRepeatNow.out, { x: pos.x - 650, y: pos.y - 5300 }); // anchor — pc's own mux chain (far) reads this

  // One RAM_ADDR_BIT chip per address pin — same MUX cascade + RRD/RLD OR
  // as the former inline forEach; labels stay on the parent.
  const ramAddrBitDef = getRamAddrBitChip(library);
  ramAddrPins(ram).forEach((p, i) => {
    // 8-bit register pairs: low byte for bits 0..7, high byte for 8+.
    const hlBit =
      i < 8 ? rL.q[i]! : rH.q[i - 8] ?? railPin(parent, 'GND', { x: pos.x + 700, y: pos.y - 300 - i * 100 });
    const bcBit =
      i < 8 ? rC.q[i]! : rB.q[i - 8] ?? railPin(parent, 'GND', { x: pos.x + 1300, y: pos.y - 300 - i * 100 });
    const deBit =
      i < 8 ? rE.q[i]! : rD.q[i - 8] ?? railPin(parent, 'GND', { x: pos.x + 1500, y: pos.y - 300 - i * 100 });

    const bit = makeChipInstance(parent, ramAddrBitDef, { x: pos.x + 700, y: pos.y - 300 - i * 100 });
    const port = (idx: number) => bit.pins[ramAddrBitDef.ports[idx]!]!;
    // sels (see makeRamAddrBitChip port order)
    wire(parent, addrIsHl.out, port(0));
    tieToLabel('STACK_WRITE_NOW', port(1), { x: pos.x + 800, y: pos.y - 320 - i * 100 });
    tieToLabel('READ_NOW', port(2), { x: pos.x + 1000, y: pos.y - 320 - i * 100 });
    tieToLabel('LDBC_ADDR_NOW', port(3), { x: pos.x + 1200, y: pos.y - 320 - i * 100 });
    tieToLabel('LDDE_ADDR_NOW', port(4), { x: pos.x + 1400, y: pos.y - 320 - i * 100 });
    tieToLabel('NN_DATA_ADDR_NOW', port(5), { x: pos.x + 1600, y: pos.y - 320 - i * 100 });
    tieToLabel('NN_DATA_ADDR_PLUS_ONE_NOW', port(6), { x: pos.x + 1800, y: pos.y - 320 - i * 100 });
    tieToLabel('EXSPHL_LOW_ADDR_NOW', port(7), { x: pos.x + 2000, y: pos.y - 320 - i * 100 });
    tieToLabel('EXSPHL_HIGH_ADDR_NOW', port(8), { x: pos.x + 2200, y: pos.y - 320 - i * 100 });
    tieToLabel('LDBLOCK_READ_NOW', port(9), { x: pos.x + 2400, y: pos.y - 320 - i * 100 });
    tieToLabel('LDBLOCK_WRITE_NOW', port(10), { x: pos.x + 2600, y: pos.y - 320 - i * 100 });
    tieToLabel('CPBLOCK_READ_NOW', port(11), { x: pos.x + 2800, y: pos.y - 320 - i * 100 });
    tieToLabel('INBLOCK_WRITE_NOW', port(12), { x: pos.x + 3000, y: pos.y - 320 - i * 100 });
    tieToLabel('OUTBLOCK_READ_NOW', port(13), { x: pos.x + 3200, y: pos.y - 320 - i * 100 });
    tieToLabel('RRDRLD_READ_NOW', port(14), { x: pos.x + 3350, y: pos.y - 340 - i * 100 });
    tieToLabel('RRDRLD_WRITE_NOW', port(15), { x: pos.x + 3350, y: pos.y - 360 - i * 100 });
    tieToLabel('EDNN_IMM_HIGH_NOW', port(16), { x: pos.x + 3600, y: pos.y - 320 - i * 100 });
    tieToLabel('IXDISP_ADDR_NOW', port(17), { x: pos.x + 3800, y: pos.y - 320 - i * 100 });
    tieToLabel('IYDISP_ADDR_NOW', port(18), { x: pos.x + 4000, y: pos.y - 320 - i * 100 });
    tieToLabel('IM2_READ_LO_NOW', port(19), { x: pos.x + 4200, y: pos.y - 320 - i * 100 });
    tieToLabel('IM2_READ_HI_NOW', port(20), { x: pos.x + 4400, y: pos.y - 320 - i * 100 });
    // data
    wire(parent, pc.q[i]!, port(21));
    wire(parent, hlBit, port(22));
    wire(parent, bcBit, port(23));
    wire(parent, deBit, port(24));
    // Live SP for EX low (stable); held SP+1 for EX high after read-low capture.
    // Held SP on PHASE2 would feed a stale latch before the capture edge.
    tieToLabel(`SP_Q${i}`, port(25), { x: pos.x + 800, y: pos.y - 280 - i * 100 });
    wire(parent, nnAddr.q[i]!, port(26));
    wire(parent, nnAddrPlusOne.out[i]!, port(27));
    const exSpSp1Mux = makeChipInstance(parent, muxDef, { x: pos.x + 650, y: pos.y - 200 - i * 100 });
    tieToLabel('EXSPHL_HIGH_ADDR_NOW', exSpSp1Mux.pins[muxDef.ports[0]!]!, { x: pos.x + 550, y: pos.y - 200 - i * 100 });
    tieToLabel(`SPPLUS1_${i}`, exSpSp1Mux.pins[muxDef.ports[1]!]!, { x: pos.x + 550, y: pos.y - 180 - i * 100 });
    tieToLabel(`EXSP_HELD_SP1_${i}`, exSpSp1Mux.pins[muxDef.ports[2]!]!, { x: pos.x + 550, y: pos.y - 160 - i * 100 });
    wire(parent, exSpSp1Mux.pins[muxDef.ports[3]!]!, port(28));
    tieToLabel(`PCPLUS1_${i}`, port(29), { x: pos.x + 3600, y: pos.y - 280 - i * 100 });
    tieToLabel(`IXDISPADD${i}`, port(30), { x: pos.x + 3800, y: pos.y - 280 - i * 100 });
    tieToLabel(`IYDISPADD${i}`, port(31), { x: pos.x + 4000, y: pos.y - 280 - i * 100 });
    tieToLabel(`IM2VEC${i}`, port(32), { x: pos.x + 4200, y: pos.y - 280 - i * 100 });
    tieToLabel(`IM2VEC1_${i}`, port(33), { x: pos.x + 4400, y: pos.y - 280 - i * 100 });
    wire(parent, port(34), p);
  });

  // PC+1 ripple incrementer for ED LD (nn),dd's high-immediate address
  // (see "x=01, z=3") — a light XOR/AND chain rather than a full
  // `buildAlu`, since only +1 is ever needed here.
  {
    let carry: Pin = railPin(parent, 'VCC', { x: pos.x - 700, y: pos.y - 6400 });
    for (let i = 0; i < addrBits; i++) {
      const sum = buildXor(parent, { x: pos.x - 700, y: pos.y - 6400 - i * 40 });
      wire(parent, pc.q[i]!, sum.a);
      wire(parent, carry, sum.b);
      tieToLabel(`PCPLUS1_${i}`, sum.out, { x: pos.x - 600, y: pos.y - 6400 - i * 20 });
      if (i + 1 < addrBits) {
        const next = buildAnd(parent, { x: pos.x - 650, y: pos.y - 6420 - i * 40 });
        wire(parent, pc.q[i]!, next.a);
        wire(parent, carry, next.b);
        carry = next.out;
      }
    }
  }

  // PC holds during FETCH/EXEC1/EXEC2 by default, advances only during
  // INCREMENT, and gets overridden for RET (pop the return address off the
  // stack) or RST (jump to a fixed target after pushing one) — see the doc
  // comment above ("x=11: SP, PUSH/POP, RET, RST n"). `LD r,n`'s own
  // LDIMM8_ADVANCE_NOW (see "x=00, z=6: LD r,n" above) widens *when* PC
  // advances rather than overriding *what it loads* the way RET/RST do
  // below — an OR into the hold condition, not a new mux input — since
  // this is a second, later increment past the immediate byte, not a jump
  // to a computed target. With LDIMM8_ADVANCE_NOW=0 (every instruction
  // except `LD r,n`, always, since it's PHASE3-gated and no other group
  // uses that phase for this purpose) this is exactly the original
  // PHASE1-only condition, unchanged — except thin IM1 IRQ accept ANDs
  // PHASE1 with NOT_INT_SERVING so the pushed return address stays the
  // interrupted instruction's PC (RST 38h path reuses the rest).
  const phase1Advance = buildAnd(parent, { x: pos.x - 350, y: pos.y - 250 });
  tieToLabel('PHASE1', phase1Advance.a, { x: pos.x - 450, y: pos.y - 250 });
  tieToLabel('NOT_INT_SERVING', phase1Advance.b, { x: pos.x - 450, y: pos.y - 230 });
  // DD/FD (IX+d)/(IY+d) advances — past d (PHASE5) and past n (PHASE7).
  // Pair ORs stay outside PC_HOLD_OR; their combined out is the last term.
  const ddFdDispAdv = buildOr(parent, { x: pos.x - 250, y: pos.y - 1320 });
  tieToLabel('DDDISP_ADVANCE_NOW', ddFdDispAdv.a, { x: pos.x - 350, y: pos.y - 1320 });
  tieToLabel('FDDISP_ADVANCE_NOW', ddFdDispAdv.b, { x: pos.x - 350, y: pos.y - 1340 });
  const ddFdMemLdNAdv = buildOr(parent, { x: pos.x - 250, y: pos.y - 1360 });
  tieToLabel('DDMEMLDN_WRITE_NOW', ddFdMemLdNAdv.a, { x: pos.x - 350, y: pos.y - 1360 });
  tieToLabel('FDMEMLDN_WRITE_NOW', ddFdMemLdNAdv.b, { x: pos.x - 350, y: pos.y - 1380 });
  const ddFdCbOpAdv = buildOr(parent, { x: pos.x - 250, y: pos.y - 1400 });
  tieToLabel('DDCB_OP_ADVANCE_NOW', ddFdCbOpAdv.a, { x: pos.x - 350, y: pos.y - 1400 });
  tieToLabel('FDCB_OP_ADVANCE_NOW', ddFdCbOpAdv.b, { x: pos.x - 350, y: pos.y - 1420 });
  const ddFdHl8ImmAdv = buildOr(parent, { x: pos.x - 250, y: pos.y - 1440 });
  tieToLabel('DDIX_HL8_IMM_ADVANCE_NOW', ddFdHl8ImmAdv.a, { x: pos.x - 350, y: pos.y - 1440 });
  tieToLabel('FDIY_HL8_IMM_ADVANCE_NOW', ddFdHl8ImmAdv.b, { x: pos.x - 350, y: pos.y - 1460 });
  const ddFdPcAdvAny = buildOr(parent, { x: pos.x - 200, y: pos.y - 1340 });
  wire(parent, ddFdDispAdv.out, ddFdPcAdvAny.a);
  wire(parent, ddFdMemLdNAdv.out, ddFdPcAdvAny.b);
  const ddFdPcAdvAny2 = buildOr(parent, { x: pos.x - 150, y: pos.y - 1360 });
  wire(parent, ddFdPcAdvAny.out, ddFdPcAdvAny2.a);
  wire(parent, ddFdCbOpAdv.out, ddFdPcAdvAny2.b);
  const ddFdPcAdvAny3 = buildOr(parent, { x: pos.x - 100, y: pos.y - 1380 });
  wire(parent, ddFdPcAdvAny2.out, ddFdPcAdvAny3.a);
  wire(parent, ddFdHl8ImmAdv.out, ddFdPcAdvAny3.b);
  // PC hold OR — sequential left-associated OR of every advance term
  // (same order as the former pcHold…pcHoldFinal8 chain). Labels stay on
  // the parent; DD/FD pair reduction is the last input.
  const pcHoldOrDef = getOrNChip(library, 24, 'PC_HOLD_OR');
  const pcHoldOr = makeChipInstance(parent, pcHoldOrDef, { x: pos.x - 300, y: pos.y - 700 });
  const pcHoldIn = (idx: number) => pcHoldOr.pins[pcHoldOrDef.ports[idx]!]!;
  wire(parent, phase1Advance.out, pcHoldIn(0));
  tieToLabel('LDIMM8_ADVANCE_NOW', pcHoldIn(1), { x: pos.x - 400, y: pos.y - 220 });
  tieToLabel('LDDDNN_LOW_ADVANCE_NOW', pcHoldIn(2), { x: pos.x - 400, y: pos.y - 300 });
  tieToLabel('LDDDNN_HIGH_ADVANCE_NOW', pcHoldIn(3), { x: pos.x - 400, y: pos.y - 350 });
  tieToLabel('JP_ADVANCE_NOW', pcHoldIn(4), { x: pos.x - 400, y: pos.y - 400 });
  tieToLabel('CALL_ADVANCE_LOW_NOW', pcHoldIn(5), { x: pos.x - 400, y: pos.y - 450 });
  tieToLabel('CALL_ADVANCE_HIGH_NOW', pcHoldIn(6), { x: pos.x - 400, y: pos.y - 500 });
  tieToLabel('JPCC_ADVANCE_LOW_NOW', pcHoldIn(7), { x: pos.x - 400, y: pos.y - 550 });
  tieToLabel('JPCC_FALLTHROUGH_NOW', pcHoldIn(8), { x: pos.x - 400, y: pos.y - 600 });
  tieToLabel('CALLCC_ADVANCE_LOW_NOW', pcHoldIn(9), { x: pos.x - 400, y: pos.y - 650 });
  tieToLabel('CALLCC_ADVANCE_HIGH_NOW', pcHoldIn(10), { x: pos.x - 400, y: pos.y - 700 });
  tieToLabel('JR_ADVANCE_NOW', pcHoldIn(11), { x: pos.x - 400, y: pos.y - 750 });
  tieToLabel('NN_ADVANCE_LOW_NOW', pcHoldIn(12), { x: pos.x - 400, y: pos.y - 800 });
  tieToLabel('NN_ADVANCE_HIGH_NOW', pcHoldIn(13), { x: pos.x - 400, y: pos.y - 850 });
  tieToLabel('ALUIMM8_ADVANCE_NOW', pcHoldIn(14), { x: pos.x - 400, y: pos.y - 900 });
  tieToLabel('IOIMM_ADVANCE_NOW', pcHoldIn(15), { x: pos.x - 400, y: pos.y - 950 });
  tieToLabel('PREFIX_ADVANCE_NOW', pcHoldIn(16), { x: pos.x - 400, y: pos.y - 1000 });
  tieToLabel('EDNN_IMM_HIGH_NOW', pcHoldIn(17), { x: pos.x - 400, y: pos.y - 1050 });
  tieToLabel('EDNN_DATA_LOW_NOW', pcHoldIn(18), { x: pos.x - 400, y: pos.y - 1100 });
  tieToLabel('LDIXNN_LOW_ADVANCE_NOW', pcHoldIn(19), { x: pos.x - 400, y: pos.y - 1150 });
  tieToLabel('LDIXNN_HIGH_ADVANCE_NOW', pcHoldIn(20), { x: pos.x - 400, y: pos.y - 1200 });
  tieToLabel('LDIYNN_LOW_ADVANCE_NOW', pcHoldIn(21), { x: pos.x - 400, y: pos.y - 1250 });
  tieToLabel('LDIYNN_HIGH_ADVANCE_NOW', pcHoldIn(22), { x: pos.x - 400, y: pos.y - 1300 });
  wire(parent, ddFdPcAdvAny3.out, pcHoldIn(23));
  const pcHoldFinal8Out = pcHoldOr.pins[pcHoldOrDef.ports[24]!]!;
  const notPhase1 = buildNot(parent, { x: pos.x - 200, y: pos.y - 200 });
  wire(parent, pcHoldFinal8Out, notPhase1.in);
  wire(parent, notPhase1.out, pc.load);

  // JP nn's own target: a dedicated `addrBits`-wide holding register, not
  // a third write-back layer on `PC` itself the way `SP` got one for `LD
  // SP,nn` — `PC` (unlike `SP`) is *also* the read address for both of
  // JP nn's own operand-byte reads, so writing partial jump-target bits
  // straight into it mid-instruction would corrupt the very address the
  // *next* read needs. `jpTarget` uses the identical per-bit "hold vs
  // fresh, self-loop the untouched half" mux shape `SP`'s own `LD SP,nn`
  // write-back already established (see "x=00, z=1: LD dd,nn" above) —
  // simpler here, since nothing else ever seeds `jpTarget`, so it needs
  // no outer "external seed vs fresh" layer, just the low/high split.
  const jpTarget = buildRegister(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 1800 });
  const jpTargetWe = buildOr(parent, { x: pos.x - 700, y: pos.y - 2100 });
  tieToLabel('JP_READ_LOW_NOW', jpTargetWe.a, { x: pos.x - 800, y: pos.y - 2100 });
  tieToLabel('JP_READ_HIGH_NOW', jpTargetWe.b, { x: pos.x - 800, y: pos.y - 2070 });
  wire(parent, jpTargetWe.out, jpTarget.we);
  jpTarget.q.forEach((q, i) => {
    const freshMux = makeChipInstance(parent, muxDef, { x: pos.x - 700, y: pos.y - 1900 - i * 100 });
    if (i < 8) {
      tieToLabel('JP_READ_HIGH_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 1900 - i * 100 }); // sel=1 (high phase): hold
      tieToLabel(`BUS${i}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 1880 - i * 100 }); // in0 (low phase): the fresh low byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (high phase): hold — self-loop
    } else {
      tieToLabel('JP_READ_LOW_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 1900 - i * 100 }); // sel=1 (low phase): hold
      tieToLabel(`BUS${i - 8}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 1880 - i * 100 }); // in0 (high phase): the fresh high byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (low phase): hold — self-loop
    }
    wire(parent, freshMux.pins[muxDef.ports[3]!]!, jpTarget.d[i]!);
  });

  // CALL nn's own target (see "x=11: CALL nn" above): a *separate*
  // dedicated register from `jpTarget`, not a widened, shared one — `JP
  // nn` and `CALL nn` are mutually exclusive by `dec.z` (`z=3` vs `z=5`),
  // so sharing would have been electrically safe, but building a second
  // register instead means this addition touches zero already-proven `JP
  // nn` wiring, consistent with this file's own established preference
  // (separate `spAdder`-style adders over one shared, muxed one) wherever
  // the two costs trade off. Identical per-bit "hold vs fresh" shape.
  const callTarget = buildRegister(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 2700 });
  const callTargetWe = buildOr(parent, { x: pos.x - 700, y: pos.y - 3000 });
  tieToLabel('CALL_READ_LOW_NOW', callTargetWe.a, { x: pos.x - 800, y: pos.y - 3000 });
  tieToLabel('CALL_READ_HIGH_NOW', callTargetWe.b, { x: pos.x - 800, y: pos.y - 2970 });
  wire(parent, callTargetWe.out, callTarget.we);
  callTarget.q.forEach((q, i) => {
    const freshMux = makeChipInstance(parent, muxDef, { x: pos.x - 700, y: pos.y - 2800 - i * 100 });
    if (i < 8) {
      tieToLabel('CALL_READ_HIGH_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 2800 - i * 100 }); // sel=1 (high phase): hold
      tieToLabel(`BUS${i}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 2780 - i * 100 }); // in0 (low phase): the fresh low byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (high phase): hold — self-loop
    } else {
      tieToLabel('CALL_READ_LOW_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 2800 - i * 100 }); // sel=1 (low phase): hold
      tieToLabel(`BUS${i - 8}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 2780 - i * 100 }); // in0 (high phase): the fresh high byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (low phase): hold — self-loop
    }
    wire(parent, freshMux.pins[muxDef.ports[3]!]!, callTarget.d[i]!);
  });

  // JP cc,nn's own target (see "x=11: JP cc,nn" above) — a *third*
  // separate holding register, same shape as `jpTarget`/`callTarget`.
  const jpCcTarget = buildRegister(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 3700 });
  const jpCcTargetWe = buildOr(parent, { x: pos.x - 700, y: pos.y - 4000 });
  tieToLabel('JPCC_READ_LOW_NOW', jpCcTargetWe.a, { x: pos.x - 800, y: pos.y - 4000 });
  tieToLabel('JPCC_READ_HIGH_NOW', jpCcTargetWe.b, { x: pos.x - 800, y: pos.y - 3970 });
  wire(parent, jpCcTargetWe.out, jpCcTarget.we);
  jpCcTarget.q.forEach((q, i) => {
    const freshMux = makeChipInstance(parent, muxDef, { x: pos.x - 700, y: pos.y - 3800 - i * 100 });
    if (i < 8) {
      tieToLabel('JPCC_READ_HIGH_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 3800 - i * 100 }); // sel=1 (high phase): hold
      tieToLabel(`BUS${i}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 3780 - i * 100 }); // in0 (low phase): the fresh low byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (high phase): hold — self-loop
    } else {
      tieToLabel('JPCC_READ_LOW_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 3800 - i * 100 }); // sel=1 (low phase): hold
      tieToLabel(`BUS${i - 8}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 3780 - i * 100 }); // in0 (high phase): the fresh high byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (low phase): hold — self-loop
    }
    wire(parent, freshMux.pins[muxDef.ports[3]!]!, jpCcTarget.d[i]!);
  });

  // CALL cc,nn's own target (see "x=11: CALL cc,nn" above) — a *fourth*
  // separate holding register, same shape as `jpTarget`/`callTarget`/
  // `jpCcTarget`.
  const callCcTarget = buildRegister(parent, library, addrBits, { x: pos.x - 700, y: pos.y - 4600 });
  const callCcTargetWe = buildOr(parent, { x: pos.x - 700, y: pos.y - 4900 });
  tieToLabel('CALLCC_READ_LOW_NOW', callCcTargetWe.a, { x: pos.x - 800, y: pos.y - 4900 });
  tieToLabel('CALLCC_READ_HIGH_NOW', callCcTargetWe.b, { x: pos.x - 800, y: pos.y - 4870 });
  wire(parent, callCcTargetWe.out, callCcTarget.we);
  callCcTarget.q.forEach((q, i) => {
    const freshMux = makeChipInstance(parent, muxDef, { x: pos.x - 700, y: pos.y - 4700 - i * 100 });
    if (i < 8) {
      tieToLabel('CALLCC_READ_HIGH_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 4700 - i * 100 }); // sel=1 (high phase): hold
      tieToLabel(`BUS${i}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 4680 - i * 100 }); // in0 (low phase): the fresh low byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (high phase): hold — self-loop
    } else {
      tieToLabel('CALLCC_READ_LOW_NOW', freshMux.pins[muxDef.ports[0]!]!, { x: pos.x - 800, y: pos.y - 4700 - i * 100 }); // sel=1 (low phase): hold
      tieToLabel(`BUS${i - 8}`, freshMux.pins[muxDef.ports[1]!]!, { x: pos.x - 800, y: pos.y - 4680 - i * 100 }); // in0 (high phase): the fresh high byte bit
      wire(parent, q, freshMux.pins[muxDef.ports[2]!]!); // in1 (low phase): hold — self-loop
    }
    wire(parent, freshMux.pins[muxDef.ports[3]!]!, callCcTarget.d[i]!);
  });

  // One PC_COMMIT_BIT chip per PC bit — same MUX cascade as the former
  // inline forEach (RET→…→IM2 hi); labels stay on the parent.
  const pcCommitBitDef = getPcCommitBitChip(library);
  pc.q.forEach((q, i) => {
    const bit = makeChipInstance(parent, pcCommitBitDef, { x: pos.x - 400, y: pos.y - 300 - i * 100 });
    const port = (idx: number) => bit.pins[pcCommitBitDef.ports[idx]!]!;
    // sels
    tieToLabel('RET_OR_RETI_NOW', port(0), { x: pos.x - 500, y: pos.y - 280 - i * 100 });
    wire(parent, rstJumpNow.out, port(1));
    tieToLabel('JP_JUMP_NOW', port(2), { x: pos.x - 150, y: pos.y - 300 - i * 100 });
    tieToLabel('CALL_JUMP_NOW', port(3), { x: pos.x - 50, y: pos.y - 300 - i * 100 });
    tieToLabel('JPCC_JUMP_NOW', port(4), { x: pos.x + 50, y: pos.y - 300 - i * 100 });
    tieToLabel('CALLCC_JUMP_NOW', port(5), { x: pos.x + 150, y: pos.y - 300 - i * 100 });
    tieToLabel('RETCC_TAKEN_NOW', port(6), { x: pos.x + 250, y: pos.y - 300 - i * 100 });
    tieToLabel('JR_JUMP_NOW', port(7), { x: pos.x + 350, y: pos.y - 300 - i * 100 });
    tieToLabel('JPHL_NOW', port(8), { x: pos.x + 400, y: pos.y - 300 - i * 100 });
    tieToLabel('JPIX_NOW', port(9), { x: pos.x + 420, y: pos.y - 300 - i * 100 });
    tieToLabel('JPIY_NOW', port(10), { x: pos.x + 440, y: pos.y - 300 - i * 100 });
    tieToLabel('LDBLOCK_REPEAT_NOW', port(11), { x: pos.x + 450, y: pos.y - 300 - i * 100 });
    tieToLabel('CPBLOCK_REPEAT_NOW', port(12), { x: pos.x + 500, y: pos.y - 320 - i * 100 });
    tieToLabel('INBLOCK_REPEAT_NOW', port(13), { x: pos.x + 550, y: pos.y - 320 - i * 100 });
    tieToLabel('OUTBLOCK_REPEAT_NOW', port(14), { x: pos.x + 600, y: pos.y - 320 - i * 100 });
    tieToLabel('NMI_JUMP_NOW', port(15), { x: pos.x + 650, y: pos.y - 320 - i * 100 });
    tieToLabel('IM2_READ_LO_NOW', port(16), { x: pos.x + 700, y: pos.y - 320 - i * 100 });
    tieToLabel('IM2_READ_HI_NOW', port(17), { x: pos.x + 750, y: pos.y - 320 - i * 100 });
    // data
    wire(parent, q, port(18)); // hold
    tieToLabel(`BUS${i}`, port(19), { x: pos.x - 500, y: pos.y - 300 - i * 100 }); // bus (RET / RET cc)
    // RST target = y*8 — ir.q[3..5] for bits 3-5, else GND
    if (i < 3 || i >= 6) tiePowerRail(parent, 'GND', port(20));
    else tieToLabel(`IRQ${i}`, port(20), { x: pos.x - 300, y: pos.y - 300 - i * 100 });
    wire(parent, jpTarget.q[i]!, port(21));
    wire(parent, callTarget.q[i]!, port(22));
    wire(parent, jpCcTarget.q[i]!, port(23));
    wire(parent, callCcTarget.q[i]!, port(24));
    wire(parent, jrOffsetAdder.out[i]!, port(25));
    if (i < 8) wire(parent, rL.q[i]!, port(26));
    else if (rH.q[i - 8]) wire(parent, rH.q[i - 8]!, port(26));
    else tiePowerRail(parent, 'GND', port(26));
    if (i < 8) wire(parent, rIXL.q[i]!, port(27));
    else if (rIXH.q[i - 8]) wire(parent, rIXH.q[i - 8]!, port(27));
    else tiePowerRail(parent, 'GND', port(27));
    if (i < 8) wire(parent, rIYL.q[i]!, port(28));
    else if (rIYH.q[i - 8]) wire(parent, rIYH.q[i - 8]!, port(28));
    else tiePowerRail(parent, 'GND', port(28));
    wire(parent, pcMinus2Adder.out[i]!, port(29));
    if (i === 1 || i === 2 || i === 5 || i === 6) tiePowerRail(parent, 'VCC', port(30));
    else tiePowerRail(parent, 'GND', port(30));
    if (i < 8) {
      tieToLabel(`BUS${i}`, port(31), { x: pos.x + 700, y: pos.y - 300 - i * 100 });
      wire(parent, pc.q[i]!, port(32)); // hold lo while hi loads
    } else {
      wire(parent, pc.q[i]!, port(31)); // hold high while lo loads
      tieToLabel(`BUS${i - 8}`, port(32), { x: pos.x + 750, y: pos.y - 300 - i * 100 });
    }
    wire(parent, port(33), pc.d[i]!);
  });

  // Operand bus: shares ir.d/ram.data with FETCH (mutually exclusive by
  // phase). RAM already drives it for z=6 (wired above); every other
  // source gets its own buildTriStateBuffer bank, enabled by
  // AND(groupActive, that source's own z line) — a source read is a source
  // read whether it's about to be ALU'd (x=10) or just moved (x=01).
  // groupActive stays narrow here on purpose (x=10/x=01 only) — see the
  // doc comment above ("A bus-fight this design deliberately avoids").
  const sources: { name: string; z: Pin }[] = [
    { name: 'REGB', z: dec.z[0]! },
    { name: 'REGC', z: dec.z[1]! },
    { name: 'REGD', z: dec.z[2]! },
    { name: 'REGE', z: dec.z[3]! },
    { name: 'REGH', z: dec.z[4]! },
    { name: 'REGL', z: dec.z[5]! },
    { name: 'REGA', z: dec.z[7]! },
  ];
  sources.forEach((src, si) => {
    // Widen with DD/FD LD (IX+d),r write — ldGroupNow is dead under prefix.
    const ddFdWriteSrc = buildOr(parent, { x: pos.x + 9850, y: pos.y - 500 + si * 150 });
    tieToLabel('DDMEMLD_WRITE_NOW', ddFdWriteSrc.a, { x: pos.x + 9750, y: pos.y - 500 + si * 150 });
    tieToLabel('FDMEMLD_WRITE_NOW', ddFdWriteSrc.b, { x: pos.x + 9750, y: pos.y - 480 + si * 150 });
    // DD/FD HL8 LD: B/C/D/E/A still come from real regs; H/L remapped via
    // dedicated IXH/IXL/IYH/IYL banks below (do not enable REGH/REGL here).
    const isHlReg = src.name === 'REGH' || src.name === 'REGL';
    let srcActiveA: Pin = groupActive.out;
    let srcActiveB: Pin = ddFdWriteSrc.out;
    if (!isHlReg) {
      const ddFdHl8LdSrc = buildOr(parent, { x: pos.x + 9820, y: pos.y - 490 + si * 150 });
      tieToLabel('DDIX_HL8_LD_NOW', ddFdHl8LdSrc.a, { x: pos.x + 9720, y: pos.y - 490 + si * 150 });
      tieToLabel('FDIY_HL8_LD_NOW', ddFdHl8LdSrc.b, { x: pos.x + 9720, y: pos.y - 470 + si * 150 });
      const srcWiden = buildOr(parent, { x: pos.x + 9860, y: pos.y - 480 + si * 150 });
      wire(parent, ddFdWriteSrc.out, srcWiden.a);
      wire(parent, ddFdHl8LdSrc.out, srcWiden.b);
      srcActiveB = srcWiden.out;
    }
    const srcActive = buildOr(parent, { x: pos.x + 9880, y: pos.y - 490 + si * 150 });
    wire(parent, srcActiveA, srcActive.a);
    wire(parent, srcActiveB, srcActive.b);
    const enable = buildAnd(parent, { x: pos.x + 9900, y: pos.y - 500 + si * 150 });
    wire(parent, srcActive.out, enable.a);
    wire(parent, src.z, enable.b);
    for (let i = 0; i < 8; i++) {
      const buf = makeChipInstance(parent, bufDef, { x: pos.x + 10200, y: pos.y - 500 + si * 150 + i * 20 });
      tieToLabel(`${src.name}${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 10100, y: pos.y - 500 + si * 150 + i * 20 });
      wire(parent, enable.out, buf.pins[bufDef.ports[1]!]!);
      tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 10300, y: pos.y - 500 + si * 150 + i * 20 });
    }
  });

  // DD/FD HL8 remapped H/L sources → BUS (IXH/IXL/IYH/IYL), not REGH/REGL.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 10200, y: pos.y + 600 + i * 20 });
    tieToLabel(`REGIXH${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 10100, y: pos.y + 600 + i * 20 });
    tieToLabel('DDIX_HL8_SRC_IXH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 10100, y: pos.y + 620 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 10300, y: pos.y + 600 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 10200, y: pos.y + 750 + i * 20 });
    tieToLabel(`REGIXL${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 10100, y: pos.y + 750 + i * 20 });
    tieToLabel('DDIX_HL8_SRC_IXL_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 10100, y: pos.y + 770 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 10300, y: pos.y + 750 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 10200, y: pos.y + 900 + i * 20 });
    tieToLabel(`REGIYH${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 10100, y: pos.y + 900 + i * 20 });
    tieToLabel('FDIY_HL8_SRC_IYH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 10100, y: pos.y + 920 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 10300, y: pos.y + 900 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 10200, y: pos.y + 1050 + i * 20 });
    tieToLabel(`REGIYL${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 10100, y: pos.y + 1050 + i * 20 });
    tieToLabel('FDIY_HL8_SRC_IYL_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 10100, y: pos.y + 1070 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 10300, y: pos.y + 1050 + i * 20 });
  }

  // Stack push data: high byte first (B/D/H/A, EXEC1), low byte second
  // (C/E/L/F, EXEC2) — real Z80 stack-push order. pushLowNow explicitly
  // excludes pushHighNow (not bare phase3) for the identical ring-counter-
  // transient reason "A real Z80 decoder"'s ramOe fix documents — see the
  // doc comment above ("A bus-fight this design deliberately avoids").
  const pushHighNow = buildAnd(parent, { x: pos.x + 10500, y: pos.y + 650 });
  wire(parent, isPush.out, pushHighNow.a);
  tieToLabel('PHASE2', pushHighNow.b, { x: pos.x + 10400, y: pos.y + 650 });
  const notPushHighNow = buildNot(parent, { x: pos.x + 10600, y: pos.y + 700 });
  wire(parent, pushHighNow.out, notPushHighNow.in);
  const pushLowStage = buildAnd(parent, { x: pos.x + 10500, y: pos.y + 750 });
  wire(parent, isPush.out, pushLowStage.a);
  tieToLabel('PHASE3', pushLowStage.b, { x: pos.x + 10400, y: pos.y + 750 });
  const pushLowNow = buildAnd(parent, { x: pos.x + 10600, y: pos.y + 750 });
  wire(parent, pushLowStage.out, pushLowNow.a);
  wire(parent, notPushHighNow.out, pushLowNow.b);

  const pushPairs: { highName: string; lowName: string; y: Pin }[] = [
    { highName: 'REGB', lowName: 'REGC', y: dec.y[0]! },
    { highName: 'REGD', lowName: 'REGE', y: dec.y[2]! },
    { highName: 'REGH', lowName: 'REGL', y: dec.y[4]! },
    { highName: 'REGA', lowName: 'REGF', y: dec.y[6]! },
  ];
  pushPairs.forEach((pair, pi) => {
    const highEnable = buildAnd(parent, { x: pos.x + 10800, y: pos.y + 600 + pi * 150 });
    wire(parent, pushHighNow.out, highEnable.a);
    wire(parent, pair.y, highEnable.b);
    for (let i = 0; i < 8; i++) {
      const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 600 + pi * 150 + i * 20 });
      tieToLabel(`${pair.highName}${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 600 + pi * 150 + i * 20 });
      wire(parent, highEnable.out, buf.pins[bufDef.ports[1]!]!);
      tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 600 + pi * 150 + i * 20 });
    }

    const lowEnable = buildAnd(parent, { x: pos.x + 10800, y: pos.y + 1250 + pi * 150 });
    wire(parent, pushLowNow.out, lowEnable.a);
    wire(parent, pair.y, lowEnable.b);
    for (let i = 0; i < 8; i++) {
      const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 1250 + pi * 150 + i * 20 });
      tieToLabel(`${pair.lowName}${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 1250 + pi * 150 + i * 20 });
      wire(parent, lowEnable.out, buf.pins[bufDef.ports[1]!]!);
      tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 1250 + pi * 150 + i * 20 });
    }
  });

  // PUSH IX's own data banks (see "DD: IX") — IXH on PHASE4, IXL on
  // PHASE5, gated by the labeled strobes (no y-select; only one pair).
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 1600 + i * 20 });
    tieToLabel(`REGIXH${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 1600 + i * 20 });
    tieToLabel('PUSHIX_HIGH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 1620 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 1600 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 1750 + i * 20 });
    tieToLabel(`REGIXL${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 1750 + i * 20 });
    tieToLabel('PUSHIX_LOW_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 1770 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 1750 + i * 20 });
  }
  // PUSH IY's own data banks (see "FD: IY") — mirror of PUSH IX above.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 2100 + i * 20 });
    tieToLabel(`REGIYH${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 2100 + i * 20 });
    tieToLabel('PUSHIY_HIGH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 2120 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 2100 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 2250 + i * 20 });
    tieToLabel(`REGIYL${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 2250 + i * 20 });
    tieToLabel('PUSHIY_LOW_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 2270 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 2250 + i * 20 });
  }

  // RST's own push data: PC's current value (the return address, already
  // past RST's own opcode — INCREMENT runs before EXEC1) drives the bus
  // during rstNow, the same way a push pair's high/low byte does. Found
  // live: this bank was missing entirely on the first pass — RST correctly
  // decremented SP and picked the right RAM address (both gated only by
  // stackWriteNow/rstNow, no data source needed), so nothing *looked*
  // wrong until RET actually tried to read the pushed byte back and got
  // whatever `ir.d` had last held (stale/garbage), not PC.
  pc.q.forEach((_, i) => {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 1900 + i * 20 });
    tieToLabel(`REGPC${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 1900 + i * 20 });
    wire(parent, rstNow.out, buf.pins[bufDef.ports[1]!]!);
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 1900 + i * 20 });
  });
  // NMI push data: same PC→bus bank as RST, gated by NMI_PUSH_NOW (PHASE2
  // while nmiServing — PC still at the interrupted instruction).
  pc.q.forEach((_, i) => {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 2050 + i * 20 });
    tieToLabel(`REGPC${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 2050 + i * 20 });
    tieToLabel('NMI_PUSH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 2070 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 2050 + i * 20 });
  });
  // IM2 push data: identical PC→bus bank, gated by IM2_PUSH_NOW.
  pc.q.forEach((_, i) => {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 1970 + i * 20 });
    tieToLabel(`REGPC${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 1970 + i * 20 });
    tieToLabel('IM2_PUSH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 1990 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 1970 + i * 20 });
  });

  // CALL nn's own push data: the identical bank, gated by CALL_PUSH_NOW
  // instead of rstNow — PC's current value at that point is already the
  // return address (both operand-byte advances, PHASE3/PHASE5, already
  // ran), the same "PC is already past its own opcode" fact RST's own
  // bank above relies on.
  pc.q.forEach((_, i) => {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 2400 + i * 20 });
    tieToLabel(`REGPC${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 2400 + i * 20 });
    tieToLabel('CALL_PUSH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 2420 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 2400 + i * 20 });
  });

  // CALL cc,nn's own push data: the identical bank CALL nn's own uses,
  // gated by CALLCC_PUSH_NOW instead — PC's current value at that point is
  // already the return address, the same "PC is already past its own
  // opcode" fact RST's and CALL nn's own banks above rely on.
  pc.q.forEach((_, i) => {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 2900 + i * 20 });
    tieToLabel(`REGPC${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 2900 + i * 20 });
    tieToLabel('CALLCC_PUSH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 2920 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 2900 + i * 20 });
  });

  // Indirect loads' own write data (see "x=00: indirect loads through
  // (BC)/(DE)/(nn)" above): `A` onto the bus for `LD (BC),A`/`LD (DE),A`/
  // `LD (nn),A` (one shared enable — real Z80 never has more than one of
  // these decoding at once, `dec.y` one-hot), and `L`/`H` onto the bus,
  // separately, for `LD (nn),HL`'s own low/high write phases — the
  // identical tri-state-buffer-bank shape every other bus source in this
  // file already uses, reading `REGA`/`REGL`/`REGH`'s own already-anchored
  // labels rather than a ~11000-unit wire back to the registers themselves.
  const isAToBusNowStage = buildOr(parent, { x: pos.x + 10900, y: pos.y + 3350 });
  tieToLabel('LDBCA_NOW', isAToBusNowStage.a, { x: pos.x + 10800, y: pos.y + 3350 });
  tieToLabel('LDDEA_NOW', isAToBusNowStage.b, { x: pos.x + 10800, y: pos.y + 3380 });
  const isAToBusNow = buildOr(parent, { x: pos.x + 10950, y: pos.y + 3400 });
  wire(parent, isAToBusNowStage.out, isAToBusNow.a);
  tieToLabel('LDNNA_NOW', isAToBusNow.b, { x: pos.x + 10850, y: pos.y + 3400 });
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 3400 + i * 20 });
    tieToLabel(`REGA${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 3400 + i * 20 });
    wire(parent, isAToBusNow.out, buf.pins[bufDef.ports[1]!]!);
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 3400 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 3900 + i * 20 });
    tieToLabel(`REGL${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 3900 + i * 20 });
    tieToLabel('LDNNHL_LOW_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 3920 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 3900 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 4400 + i * 20 });
    tieToLabel(`REGH${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 4400 + i * 20 });
    tieToLabel('LDNNHL_HIGH_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 4420 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 4400 + i * 20 });
  }

  // ED LD (nn),dd store data (see "x=01, z=3") — each pair's low/high
  // register onto the bus for its own write phase. SP is published as
  // SP_Q{i} (already anchored for PUSH/POP); high byte uses bits 8+.
  const edNnBusSpecs: { label: string; regLabel: string }[] = [
    { label: 'EDNN_BUS_C_NOW', regLabel: 'REGC' },
    { label: 'EDNN_BUS_B_NOW', regLabel: 'REGB' },
    { label: 'EDNN_BUS_E_NOW', regLabel: 'REGE' },
    { label: 'EDNN_BUS_D_NOW', regLabel: 'REGD' },
    { label: 'EDNN_BUS_L_NOW', regLabel: 'REGL' },
    { label: 'EDNN_BUS_H_NOW', regLabel: 'REGH' },
  ];
  edNnBusSpecs.forEach(({ label, regLabel }, bi) => {
    for (let i = 0; i < 8; i++) {
      const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 5800 + bi * 500 + i * 20 });
      tieToLabel(`${regLabel}${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 5800 + bi * 500 + i * 20 });
      tieToLabel(label, buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 5820 + bi * 500 + i * 20 });
      tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 5800 + bi * 500 + i * 20 });
    }
  });
  for (let i = 0; i < 8; i++) {
    const bufLo = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 8800 + i * 20 });
    tieToLabel(`SP_Q${i}`, bufLo.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 8800 + i * 20 });
    tieToLabel('EDNN_BUS_SPLO_NOW', bufLo.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 8820 + i * 20 });
    tieToLabel(`BUS${i}`, bufLo.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 8800 + i * 20 });
  }
  for (let i = 0; i < 8 && i + 8 < addrBits; i++) {
    const bufHi = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 9300 + i * 20 });
    tieToLabel(`SP_Q${i + 8}`, bufHi.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 9300 + i * 20 });
    tieToLabel('EDNN_BUS_SPHI_NOW', bufHi.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 9320 + i * 20 });
    tieToLabel(`BUS${i}`, bufHi.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 9300 + i * 20 });
  }
  // When addrBits <= 8, SP high store still needs *some* driver for the
  // high-byte write phase (otherwise the bus floats); force 0s.
  if (addrBits <= 8) {
    for (let i = 0; i < 8; i++) {
      const bufHi = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 9300 + i * 20 });
      tiePowerRail(parent, 'GND', bufHi.pins[bufDef.ports[0]!]!);
      tieToLabel('EDNN_BUS_SPHI_NOW', bufHi.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 9320 + i * 20 });
      tieToLabel(`BUS${i}`, bufHi.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 9300 + i * 20 });
    }
  }

  // INC (HL)/DEC (HL) and DD/FD INC/DEC (IX+d)/(IY+d) write-back data:
  // `R8RESULT0-7` driven onto the bus for RAM's own write.
  const r8ResultDdFdEn = buildOr(parent, { x: pos.x + 10950, y: pos.y + 4900 });
  tieToLabel('DDMEM_INCDEC_WRITE_NOW', r8ResultDdFdEn.a, { x: pos.x + 10850, y: pos.y + 4900 });
  tieToLabel('FDMEM_INCDEC_WRITE_NOW', r8ResultDdFdEn.b, { x: pos.x + 10850, y: pos.y + 4920 });
  const r8ResultBusEnAny = buildOr(parent, { x: pos.x + 11000, y: pos.y + 4890 });
  tieToLabel('INCDEC_HLMEM_NOW', r8ResultBusEnAny.a, { x: pos.x + 10850, y: pos.y + 4880 });
  wire(parent, r8ResultDdFdEn.out, r8ResultBusEnAny.b);
  tieToLabel('INCDEC_MEM_WRITE_ANY', r8ResultBusEnAny.out, { x: pos.x + 11100, y: pos.y + 4890 });
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 4900 + i * 20 });
    tieToLabel(`R8RESULT${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 4900 + i * 20 });
    tieToLabel('INCDEC_MEM_WRITE_ANY', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 4920 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 4900 + i * 20 });
  }
  // SET/RES (HL)/(IX+d)/(IY+d) write-back — SETRESRESULT onto the bus.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 5100 + i * 20 });
    tieToLabel(`SETRESRESULT${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 5100 + i * 20 });
    tieToLabel('SETRES_MEM_WRITE_ANY', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 5120 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 5100 + i * 20 });
  }
  // CB rotate/shift (HL)/(IX+d)/(IY+d) write-back — CBROTRESULT onto the bus.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 5250 + i * 20 });
    tieToLabel(`CBROTRESULT${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 5250 + i * 20 });
    tieToLabel('CBROT_MEM_WRITE_ANY', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 5270 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 5250 + i * 20 });
  }

  // `LD (HL),n`'s own write-back data (see "x=00: INC (HL)/DEC (HL)/LD
  // (HL),n" above): `ldHlNImm`'s own captured immediate byte, driven onto
  // the bus for RAM's own write, gated by `LDHLN_WRITE_NOW`.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 5400 + i * 20 });
    tieToLabel(`LDHLNIMM${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 5400 + i * 20 });
    tieToLabel('LDHLN_WRITE_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 5420 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 5400 + i * 20 });
  }
  // LD (IX+d),n / LD (IY+d),n write-back — holding-reg onto bus at PHASE7.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 5550 + i * 20 });
    tieToLabel(`LDIXDNIMM${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 5550 + i * 20 });
    tieToLabel('DDMEMLDN_WRITE_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 5570 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 5550 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 11100, y: pos.y + 5700 + i * 20 });
    tieToLabel(`LDIYDNIMM${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11000, y: pos.y + 5700 + i * 20 });
    tieToLabel('FDMEMLDN_WRITE_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11000, y: pos.y + 5720 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 11200, y: pos.y + 5700 + i * 20 });
  }

  // Stack pop capture phases: low byte first (C/E/L/F, EXEC1), high byte
  // second (B/D/H/A, EXEC2) — mirrors the push order above. These gate
  // register WRITE-ENABLES, not bus drivers, so they don't need the
  // sibling-exclusion trick pushLowNow needed: a mistimed WE during a
  // purely-combinational phaseClk transient can't corrupt anything, since
  // nothing commits until the (separately, non-overlapping) dataClk edge.
  const popLowNow = buildAnd(parent, { x: pos.x + 10500, y: pos.y + 900 });
  wire(parent, isPop.out, popLowNow.a);
  tieToLabel('PHASE2', popLowNow.b, { x: pos.x + 10400, y: pos.y + 900 });
  const popHighNow = buildAnd(parent, { x: pos.x + 10500, y: pos.y + 950 });
  wire(parent, isPop.out, popHighNow.a);
  tieToLabel('PHASE3', popHighNow.b, { x: pos.x + 10400, y: pos.y + 950 });

  // ALU: op0/op1 read straight off which real operation decoded (ADD/ADC/
  // AND/XOR/OR); SUB/SBC/CP are ADD with the operand inverted (`isSubtract`
  // for SUB/CP, widened by `isSubtractLike` below to cover SBC too — CP is
  // "subtract, discard the result, keep only the flags," needing the
  // identical adder setup SUB uses; weRaw below stays SUB/SBC-inclusive but
  // CP-exclusive, since CP must never write A). `ADC`/`SBC` (x=10, y=1/3 —
  // see the doc comment above) reuse this exact adder too: `ADC` is a real
  // add, just with a fresh `cin` (the old `C`) instead of a hardcoded 0;
  // `SBC` is a real subtract the identical way SUB already is, just with
  // `cin` fed from the old `C` inverted instead of forced to 1 — found live
  // once a real carry flag existed, wiring them up turned out to be
  // exactly the "route C into cin" lift the doc comment already predicted,
  // no new adder or op-select needed.
  const isSubtract = buildOr(parent, { x: pos.x + 2900, y: pos.y + 2100 });
  tieToLabel('DECY2', isSubtract.a, { x: pos.x + 2800, y: pos.y + 2100 });
  tieToLabel('DECY7', isSubtract.b, { x: pos.x + 2800, y: pos.y + 2130 });
  // SBC needs SUB's own operand-invert too — this OR is that shared
  // condition, reused below for `bInv` and again for `N` (SBC sets N=1,
  // exactly like SUB/CP).
  const isSubtractLike = buildOr(parent, { x: pos.x + 2950, y: pos.y + 2160 });
  wire(parent, isSubtract.out, isSubtractLike.a);
  tieToLabel('DECY3', isSubtractLike.b, { x: pos.x + 2850, y: pos.y + 2160 });
  const aluOp0 = buildOr(parent, { x: pos.x + 3000, y: pos.y + 2200 });
  tieToLabel('DECY4', aluOp0.a, { x: pos.x + 2900, y: pos.y + 2200 });
  tieToLabel('DECY5', aluOp0.b, { x: pos.x + 2900, y: pos.y + 2230 });
  wire(parent, aluOp0.out, alu.op0);
  const aluOp1 = buildOr(parent, { x: pos.x + 3000, y: pos.y + 2400 });
  tieToLabel('DECY6', aluOp1.a, { x: pos.x + 2900, y: pos.y + 2400 });
  tieToLabel('DECY5', aluOp1.b, { x: pos.x + 2900, y: pos.y + 2430 });
  wire(parent, aluOp1.out, alu.op1);
  // cin: 0 for ADD/AND/XOR/OR (none of the three terms below fire), the
  // old C for ADC, 1 for SUB/CP, the old C inverted for SBC.
  const adcCin = buildAnd(parent, { x: pos.x + 2950, y: pos.y + 2250 });
  tieToLabel('DECY1', adcCin.a, { x: pos.x + 2850, y: pos.y + 2250 });
  wire(parent, f.q[0]!, adcCin.b);
  const notOldCForSbc = buildNot(parent, { x: pos.x + 2950, y: pos.y + 2270 });
  wire(parent, f.q[0]!, notOldCForSbc.in);
  const sbcCin = buildAnd(parent, { x: pos.x + 3000, y: pos.y + 2280 });
  tieToLabel('DECY3', sbcCin.a, { x: pos.x + 2900, y: pos.y + 2280 });
  wire(parent, notOldCForSbc.out, sbcCin.b);
  const cinStage = buildOr(parent, { x: pos.x + 3050, y: pos.y + 2260 });
  wire(parent, adcCin.out, cinStage.a);
  wire(parent, isSubtract.out, cinStage.b);
  const cinFinal = buildOr(parent, { x: pos.x + 3100, y: pos.y + 2265 });
  wire(parent, cinStage.out, cinFinal.a);
  wire(parent, sbcCin.out, cinFinal.b);
  wire(parent, cinFinal.out, alu.cin);
  a.q.forEach((q, i) => wire(parent, q, alu.a[i]!));
  for (let i = 0; i < 8; i++) {
    const bInv = buildXor(parent, { x: pos.x + 3200, y: pos.y + 2600 + i * 150 });
    tieToLabel(`BUS${i}`, bInv.a, { x: pos.x + 3100, y: pos.y + 2600 + i * 150 });
    wire(parent, isSubtractLike.out, bInv.b);
    wire(parent, bInv.out, alu.b[i]!);
  }

  // A writes for all 7 operations this slice now executes (ADD/ADC/SUB/
  // SBC/AND/XOR/OR) — CP (y=7) is deliberately excluded here, unlike
  // isSubtract/isSubtractLike above.
  const weOr1 = buildOr(parent, { x: pos.x + 3600, y: pos.y + 1900 });
  tieToLabel('DECY0', weOr1.a, { x: pos.x + 3500, y: pos.y + 1900 });
  tieToLabel('DECY2', weOr1.b, { x: pos.x + 3500, y: pos.y + 1930 });
  const weOr2 = buildOr(parent, { x: pos.x + 3600, y: pos.y + 2000 });
  tieToLabel('DECY4', weOr2.a, { x: pos.x + 3500, y: pos.y + 2000 });
  tieToLabel('DECY5', weOr2.b, { x: pos.x + 3500, y: pos.y + 2030 });
  const weOr3 = buildOr(parent, { x: pos.x + 3800, y: pos.y + 1950 });
  wire(parent, weOr1.out, weOr3.a);
  wire(parent, weOr2.out, weOr3.b);
  // ADC/SBC (y=1/y=3) — a fourth OR term, the two new arithmetic ops this
  // group actually executes now.
  const weOr4 = buildOr(parent, { x: pos.x + 3700, y: pos.y + 1970 });
  tieToLabel('DECY1', weOr4.a, { x: pos.x + 3600, y: pos.y + 1970 });
  tieToLabel('DECY3', weOr4.b, { x: pos.x + 3600, y: pos.y + 1990 });
  const weOr5 = buildOr(parent, { x: pos.x + 3900, y: pos.y + 1960 });
  wire(parent, weOr3.out, weOr5.a);
  wire(parent, weOr4.out, weOr5.b);
  const weRaw = buildOr(parent, { x: pos.x + 4000, y: pos.y + 1950 });
  wire(parent, weOr5.out, weRaw.a);
  tieToLabel('DECY6', weRaw.b, { x: pos.x + 3900, y: pos.y + 1950 });
  const aWe = buildAnd(parent, { x: pos.x + 4200, y: pos.y + 1950 });
  wire(parent, aluAnyGroupNow.out, aWe.a); // x=10's own ALU-on-register, or x=11's own ALU op A,n — see "x=11: ALU op A,n" above
  wire(parent, weRaw.out, aWe.b);

  // Flags (F) — see the doc comment above for the derivation of every bit.
  // Computed for the same 7 ops weRaw covers, plus CP (y=7).
  const cRaw = buildXor(parent, { x: pos.x + 3400, y: pos.y + 3200 });
  wire(parent, alu.cout, cRaw.a);
  wire(parent, isSubtractLike.out, cRaw.b);
  // C is meaningful for the 4 real arithmetic ops (ADD/ADC/SUB/SBC) plus
  // CP (SUB's own flags-only twin) — AND/XOR/OR force it to 0 instead (real
  // Z80 behavior), same as before ADC/SBC existed, just widened by one
  // more OR term (`DECY1`, ADC) beyond what `isSubtractLike` already covers
  // for SBC.
  const cIsArithStage = buildOr(parent, { x: pos.x + 3400, y: pos.y + 3280 });
  tieToLabel('DECY0', cIsArithStage.a, { x: pos.x + 3300, y: pos.y + 3280 });
  tieToLabel('DECY1', cIsArithStage.b, { x: pos.x + 3300, y: pos.y + 3300 });
  const cIsArith = buildOr(parent, { x: pos.x + 3400, y: pos.y + 3320 });
  wire(parent, cIsArithStage.out, cIsArith.a);
  wire(parent, isSubtractLike.out, cIsArith.b);
  const cBit = buildAnd(parent, { x: pos.x + 3500, y: pos.y + 3250 });
  wire(parent, cRaw.out, cBit.a);
  wire(parent, cIsArith.out, cBit.b);

  // H (half-carry, bit 4): the identical `XOR(carry, isSubtractLike)` idiom
  // `cBit` above uses for C, just read off `alu.carries[3]` (the nibble
  // boundary — carry INTO bit 4, not bit 8) instead of `alu.cout`
  // (`carries[7]`) — the one-line difference between "this flag" and "that
  // flag" real Z80 hardware itself boils down to. Gated by the identical
  // `cIsArith` (ADD/ADC/SUB/SBC/CP, y=0/1/2/3/7) for the same reason C is:
  // AND/XOR/OR's own adder-shaped `cout`/nibble-carry is real but
  // electrically meaningless for those ops (`buildAluSlice`'s own doc
  // comment again). AND/OR/XOR don't just leave H at 0 like they do C,
  // though — real Z80 hardwires AND to H=1 unconditionally (a documented
  // quirk, not a bug) and OR/XOR to H=0; `DECY4` (AND, y=4) ORed straight
  // into the final bit covers the H=1 case with no extra gating needed —
  // OR/XOR's own `hArithBit` term is already 0 (neither fires `cIsArith`),
  // so the OR alone yields 0 for them, correctly, same as C.
  const hRaw = buildXor(parent, { x: pos.x + 3450, y: pos.y + 3260 });
  wire(parent, alu.carries[3]!, hRaw.a);
  wire(parent, isSubtractLike.out, hRaw.b);
  const hArithBit = buildAnd(parent, { x: pos.x + 3550, y: pos.y + 3260 });
  wire(parent, hRaw.out, hArithBit.a);
  wire(parent, cIsArith.out, hArithBit.b);
  const hBit = buildOr(parent, { x: pos.x + 3600, y: pos.y + 3260 });
  wire(parent, hArithBit.out, hBit.a);
  tieToLabel('DECY4', hBit.b, { x: pos.x + 3500, y: pos.y + 3260 });

  // X/Y (bits 3/5, undocumented): on real silicon these just mirror the
  // result's own bits 3/5 for every one of this group's 8 ops, CP included
  // — this project mirrors that for the 7 that actually reach here through
  // `alu.out` (CP's own real-hardware quirk of sourcing X/Y from the
  // *operand* instead of the discarded result is deliberately not modeled;
  // see the doc comment above for the general "X/Y aren't chased to full
  // silicon fidelity everywhere" stance).
  const xBit = alu.out[3]!;
  const yBit = alu.out[5]!;

  let zChain: Pin = alu.out[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 3600, y: pos.y + 3400 + i * 100 });
    wire(parent, zChain, orGate.a);
    wire(parent, alu.out[i]!, orGate.b);
    zChain = orGate.out;
  }
  const zBit = buildNot(parent, { x: pos.x + 3700, y: pos.y + 4200 });
  wire(parent, zChain, zBit.in);

  let pChain: Pin = alu.out[0]!;
  for (let i = 1; i < 8; i++) {
    const xorGate = buildXor(parent, { x: pos.x + 3800, y: pos.y + 3400 + i * 100 });
    wire(parent, pChain, xorGate.a);
    wire(parent, alu.out[i]!, xorGate.b);
    pChain = xorGate.out;
  }
  const pBit = buildNot(parent, { x: pos.x + 3900, y: pos.y + 4200 });
  wire(parent, pChain, pBit.in);

  // P/V is two different flags real Z80 crams into one bit, picked by
  // which of the eight ops actually ran: parity of the result for the
  // three logic ops (AND/XOR/OR — `pBit` above, unchanged), signed
  // arithmetic overflow for the five arithmetic ones (ADD/ADC/SUB/SBC/
  // CP — `cIsArith`, the identical gate `cBit`/`hBit` already reuse).
  // Overflow itself is the classic two's-complement identity —
  // `XOR(carry into the sign bit, carry out of the sign bit)` — now buildable
  // at all only because `alu.carries` exposes an *interior* carry
  // (`carries[6]`, the carry crossing into bit 7) alongside the final one
  // (`carries[7]` === `alu.cout`), the same exposure `hBit` above needed
  // for `carries[3]`. No sign-comparison logic needed — this one XOR
  // already captures "same-signed operands producing a different-signed
  // result," the textbook overflow condition, for both `ADD` and `SUB`
  // alike (since `SUB`/`SBC`/`CP` are just `ADD` with the operand
  // inverted and `cin=1` here, the identical adder, the identical
  // formula holds unchanged).
  const pvOverflow = buildXor(parent, { x: pos.x + 3950, y: pos.y + 4230 });
  wire(parent, alu.carries[6]!, pvOverflow.a);
  wire(parent, alu.carries[7]!, pvOverflow.b);
  const pvMux = makeChipInstance(parent, muxDef, { x: pos.x + 4000, y: pos.y + 4240 });
  wire(parent, cIsArith.out, pvMux.pins[muxDef.ports[0]!]!);
  wire(parent, pBit.out, pvMux.pins[muxDef.ports[1]!]!); // in0: parity (AND/XOR/OR)
  wire(parent, pvOverflow.out, pvMux.pins[muxDef.ports[2]!]!); // in1: overflow (ADD/ADC/SUB/SBC/CP)
  const pvBit = pvMux.pins[muxDef.ports[3]!]!;

  const sBit = alu.out[7]!;
  // N: 1 for SUB/SBC/CP (isSubtractLike, SBC included), 0 for ADD/ADC/AND/
  // XOR/OR — real Z80 behavior, unchanged from before ADC/SBC existed
  // except for SBC itself now correctly setting it.
  const nBit = isSubtractLike.out;

  const fWeRaw = buildOr(parent, { x: pos.x + 4000, y: pos.y + 4300 });
  wire(parent, weRaw.out, fWeRaw.a);
  tieToLabel('DECY7', fWeRaw.b, { x: pos.x + 3900, y: pos.y + 4300 });
  const fWe = buildAnd(parent, { x: pos.x + 4200, y: pos.y + 4300 });
  wire(parent, aluAnyGroupNow.out, fWe.a); // x=10's own ALU-on-register, or x=11's own ALU op A,n — see "x=11: ALU op A,n" above
  wire(parent, fWeRaw.out, fWe.b);

  // LD A,z / POP AF's high byte / LD A,n: `isBusToA` picks the bus over
  // the ALU's own result, ahead of the existing reset mux — see the doc
  // comment above ("Writing a destination that isn't always A"). LD A,n
  // (see "x=00, z=6: LD r,n" above) widens this the same way it widens
  // `ldWe` below — a third OR term, not a new mux — since the bus already
  // carries the right value (RAM, addressed by PC, driven by
  // LDIMM8_READ_NOW) by the time this fires.
  const isLdA = buildAnd(parent, { x: pos.x + 4450, y: pos.y + 1750 });
  wire(parent, ldGroupNow.out, isLdA.a);
  tieToLabel('DECY7', isLdA.b, { x: pos.x + 4350, y: pos.y + 1750 });
  const isPopA = buildAnd(parent, { x: pos.x + 4450, y: pos.y + 1650 });
  wire(parent, popHighNow.out, isPopA.a);
  tieToLabel('DECY6', isPopA.b, { x: pos.x + 4350, y: pos.y + 1650 }); // AF pair
  const isBusToAStage = buildOr(parent, { x: pos.x + 4460, y: pos.y + 1690 });
  wire(parent, isLdA.out, isBusToAStage.a);
  wire(parent, isPopA.out, isBusToAStage.b);
  const isBusToAStage2 = buildOr(parent, { x: pos.x + 4470, y: pos.y + 1700 });
  wire(parent, isBusToAStage.out, isBusToAStage2.a);
  tieToLabel('LDIMM8_A_NOW', isBusToAStage2.b, { x: pos.x + 4370, y: pos.y + 1700 });
  // The indirect-load group's own three reads into A (see "x=00: indirect
  // loads through (BC)/(DE)/(nn)" above) — a fourth OR term, the identical
  // widen-not-replace shape every competing source for `A` in this file
  // already gets.
  const isBusToA = buildOr(parent, { x: pos.x + 4480, y: pos.y + 1710 });
  wire(parent, isBusToAStage2.out, isBusToA.a);
  const isLdABcOrDeOrNn1 = buildOr(parent, { x: pos.x + 4380, y: pos.y + 1710 });
  tieToLabel('LDABC_NOW', isLdABcOrDeOrNn1.a, { x: pos.x + 4280, y: pos.y + 1710 });
  tieToLabel('LDADE_NOW', isLdABcOrDeOrNn1.b, { x: pos.x + 4280, y: pos.y + 1740 });
  const isLdABcOrDeOrNn = buildOr(parent, { x: pos.x + 4390, y: pos.y + 1720 });
  wire(parent, isLdABcOrDeOrNn1.out, isLdABcOrDeOrNn.a);
  tieToLabel('LDANN_NOW', isLdABcOrDeOrNn.b, { x: pos.x + 4290, y: pos.y + 1720 });
  // DD/FD LD A,(IX+d)/(IY+d) + LD A,IXH/IXL/IYH/IYL — bus write-back.
  const isDdFdMemLdA = buildOr(parent, { x: pos.x + 4395, y: pos.y + 1730 });
  tieToLabel('DDMEMLD_WE_A_NOW', isDdFdMemLdA.a, { x: pos.x + 4295, y: pos.y + 1730 });
  tieToLabel('FDMEMLD_WE_A_NOW', isDdFdMemLdA.b, { x: pos.x + 4295, y: pos.y + 1750 });
  const isDdFdHl8LdA = buildOr(parent, { x: pos.x + 4395, y: pos.y + 1750 });
  tieToLabel('DDIX_HL8_WE_A_NOW', isDdFdHl8LdA.a, { x: pos.x + 4295, y: pos.y + 1750 });
  tieToLabel('FDIY_HL8_WE_A_NOW', isDdFdHl8LdA.b, { x: pos.x + 4295, y: pos.y + 1770 });
  const isDdFdLdAAny = buildOr(parent, { x: pos.x + 4405, y: pos.y + 1740 });
  wire(parent, isDdFdMemLdA.out, isDdFdLdAAny.a);
  wire(parent, isDdFdHl8LdA.out, isDdFdLdAAny.b);
  const isBusToAExtra = buildOr(parent, { x: pos.x + 4400, y: pos.y + 1725 });
  wire(parent, isLdABcOrDeOrNn.out, isBusToAExtra.a);
  wire(parent, isDdFdLdAAny.out, isBusToAExtra.b);
  wire(parent, isBusToAExtra.out, isBusToA.b);

  // A has no LDI-style instruction in the x=10 group — every one of its 5
  // executed operations reads `alu.a = a.q`, so with no way to establish
  // A's first real value, "ADD A,B" as literally the first instruction
  // would compute an undefined A plus B, forever undefined. `aReset` is the
  // same fix `buildProgramCounter` already uses for the identical problem:
  // a mux ahead of `a.d` that a one-shot external reset can override to
  // force 0, ORed into `a.we` so it can write regardless of whether a real
  // instruction happens to be decoding at the same moment. A real Z80
  // doesn't need this — `LD A,n` (in the `x=00` group this slice doesn't
  // implement) sets A directly — but *some* way to establish a first value
  // is unavoidable for any register nothing else in the design already
  // default-initializes.
  let aReset!: Pin; // established below, from the first per-bit reset mux's own sel pin
  // IN A,(n) (see "x=11: IN A,(n) / OUT (n),A" below) needs this declared
  // here, ahead of the loop that fills it — that decode block itself
  // lives much further down, well past where `wrapWithPairCommit` and the
  // rest of this composite's second half are defined.
  const ioPortDataIn: Pin[] = [];
  const aDataBitDef = getADataBitChip(library);
  for (let i = 0; i < 8; i++) {
    const bit = makeChipInstance(parent, aDataBitDef, { x: pos.x + 4450, y: pos.y + 1750 + i * 100 });
    const p = (name: string) => bit.pins[name]!;
    const y = pos.y + 1750 + i * 100;
    tieToLabel('INCDEC_A_NOW', p('selIncDec'), { x: pos.x + 4350, y });
    tieToLabel('DAA_NOW', p('selDaa'), { x: pos.x + 4360, y: y + 15 });
    tieToLabel('ROTACC_A_NOW', p('selRotAcc'), { x: pos.x + 4370, y: y + 25 });
    tieToLabel('EX_AFAF_NOW', p('selExAfAf'), { x: pos.x + 4385, y: y + 35 });
    tieToLabel('IN_NOW', p('selIn'), { x: pos.x + 4392, y: y + 40 });
    tieToLabel('NEG_NOW', p('selNeg'), { x: pos.x + 4396, y: y + 45 });
    tieToLabel('RRDRLD_COMMIT_NOW', p('selRrdRld'), { x: pos.x + 4398, y: y + 48 });
    tieToLabel('INRC_WE_A_NOW', p('selInRc'), { x: pos.x + 4399, y: y + 49 });
    tieToLabel('LDAR_NOW', p('selLdAR'), { x: pos.x + 4400, y: y + 49 });
    tieToLabel('LDAI_NOW', p('selLdAI'), { x: pos.x + 4401, y: y + 49 });
    tieToLabel('SETRES_WE_A_NOW', p('selSetRes'), { x: pos.x + 4402, y: y + 49 });
    tieToLabel('CBROT_WE_A_NOW', p('selCbRot'), { x: pos.x + 4402.5, y: y + 49 });
    wire(parent, isBusToA.out, p('selBus'));
    if (i === 0) aReset = p('selReset');
    else wire(parent, aReset, p('selReset'));

    wire(parent, alu.out[i]!, p('alu'));
    tieToLabel(`R8RESULT${i}`, p('r8Result'), { x: pos.x + 4350, y: y + 20 });
    tieToLabel(`DAARESULT${i}`, p('daaResult'), { x: pos.x + 4360, y: y + 35 });
    tieToLabel(`ROTACCRESULT${i}`, p('rotAccResult'), { x: pos.x + 4370, y: y + 45 });
    tieToLabel(`APOLD${i}`, p('apOld'), { x: pos.x + 4385, y: y + 55 });
    ioPortDataIn.push(p('ioIn'));
    wire(parent, negAdder.out[i]!, p('neg'));
    if (i < 4) {
      tieToLabel(`RRDRLD_NEWALOW${i}`, p('rrdRldOrHold'), { x: pos.x + 4398, y: y + 68 });
    } else {
      wire(parent, a.q[i]!, p('rrdRldOrHold'));
    }
    wire(parent, regR.q[i]!, p('regR'));
    wire(parent, regI.q[i]!, p('regI'));
    tieToLabel(`SETRESRESULT${i}`, p('setResResult'), { x: pos.x + 4402, y: y + 69 });
    tieToLabel(`CBROTRESULT${i}`, p('cbRotResult'), { x: pos.x + 4402.5, y: y + 69 });
    tieToLabel(`BUS${i}`, p('bus'), { x: pos.x + 4400, y: y + 50 });
    tiePowerRail(parent, 'GND', p('reset0'));
    wire(parent, p('out'), a.d[i]!);
  }
  // A WE OR — sequential left-associated OR of every A write-enable term
  // (same order as the former aWeStage…aWeFinal chain).
  const aWeOrDef = getOrNChip(library, 14, 'A_WE_OR');
  const aWeOr = makeChipInstance(parent, aWeOrDef, { x: pos.x + 4300, y: pos.y + 1950 });
  const aWeIn = (idx: number) => aWeOr.pins[aWeOrDef.ports[idx]!]!;
  wire(parent, aWe.out, aWeIn(0));
  wire(parent, isBusToA.out, aWeIn(1));
  tieToLabel('INCDEC_A_NOW', aWeIn(2), { x: pos.x + 4250, y: pos.y + 1950 });
  tieToLabel('DAA_NOW', aWeIn(3), { x: pos.x + 4270, y: pos.y + 1950 });
  tieToLabel('ROTACC_A_NOW', aWeIn(4), { x: pos.x + 4280, y: pos.y + 1950 });
  tieToLabel('EX_AFAF_NOW', aWeIn(5), { x: pos.x + 4290, y: pos.y + 1950 });
  tieToLabel('IN_NOW', aWeIn(6), { x: pos.x + 4295, y: pos.y + 1950 });
  tieToLabel('NEG_NOW', aWeIn(7), { x: pos.x + 4298, y: pos.y + 1950 });
  tieToLabel('RRDRLD_COMMIT_NOW', aWeIn(8), { x: pos.x + 4299, y: pos.y + 1950 });
  tieToLabel('INRC_WE_A_NOW', aWeIn(9), { x: pos.x + 4301, y: pos.y + 1950 });
  tieToLabel('LDAIR_NOW', aWeIn(10), { x: pos.x + 4302, y: pos.y + 1950 });
  tieToLabel('SETRES_WE_A_NOW', aWeIn(11), { x: pos.x + 4303, y: pos.y + 1950 });
  tieToLabel('CBROT_WE_A_NOW', aWeIn(12), { x: pos.x + 4303.5, y: pos.y + 1950 });
  wire(parent, aReset, aWeIn(13));
  wire(parent, aWeOr.pins[aWeOrDef.ports[14]!]!, a.we);

  // LD r,r' destinations B/C/D/E/H/L: each gets the same "mux ahead of d,
  // OR into we" treatment as A above, selecting the bus outright (never
  // the ALU — this group never touches these registers) whenever
  // AND(ldGroupNow, this register's own y line) fires — OR, now, whenever
  // AND(popLowNow/popHighNow, that register pair's own y line) fires too
  // (POP's low/high byte capture is the identical "bus into this
  // register" action LD r,r' already does, just gated by a different
  // condition — see the doc comment above). What a caller sees as this
  // Register's `d`/`we` from here on are these *new* external-seed pins,
  // not buildRegister's raw ones.
  const ldDestSpecs: { reg: Register; ldY: Pin; popPhase: ReturnType<typeof buildAnd>; popY: Pin; ldImm8Label: string; ldDdNnLabel: string; edNnWeLabel: string; inRcWeLabel: string; setResWeLabel: string; cbRotWeLabel: string; ddMemLdWeLabel: string; fdMemLdWeLabel: string; ddHl8WeLabel?: string; fdHl8WeLabel?: string }[] = [
    { reg: rB, ldY: dec.y[0]!, popPhase: popHighNow, popY: dec.y[0]!, ldImm8Label: 'LDIMM8_B_NOW', ldDdNnLabel: 'LDDDNN_HIGH_B_NOW', edNnWeLabel: 'EDNN_WE_B_NOW', inRcWeLabel: 'INRC_WE_B_NOW', setResWeLabel: 'SETRES_WE_B_NOW', cbRotWeLabel: 'CBROT_WE_B_NOW', ddMemLdWeLabel: 'DDMEMLD_WE_B_NOW', fdMemLdWeLabel: 'FDMEMLD_WE_B_NOW', ddHl8WeLabel: 'DDIX_HL8_WE_B_NOW', fdHl8WeLabel: 'FDIY_HL8_WE_B_NOW' },
    { reg: rC, ldY: dec.y[1]!, popPhase: popLowNow, popY: dec.y[0]!, ldImm8Label: 'LDIMM8_C_NOW', ldDdNnLabel: 'LDDDNN_LOW_C_NOW', edNnWeLabel: 'EDNN_WE_C_NOW', inRcWeLabel: 'INRC_WE_C_NOW', setResWeLabel: 'SETRES_WE_C_NOW', cbRotWeLabel: 'CBROT_WE_C_NOW', ddMemLdWeLabel: 'DDMEMLD_WE_C_NOW', fdMemLdWeLabel: 'FDMEMLD_WE_C_NOW', ddHl8WeLabel: 'DDIX_HL8_WE_C_NOW', fdHl8WeLabel: 'FDIY_HL8_WE_C_NOW' },
    { reg: rD, ldY: dec.y[2]!, popPhase: popHighNow, popY: dec.y[2]!, ldImm8Label: 'LDIMM8_D_NOW', ldDdNnLabel: 'LDDDNN_HIGH_D_NOW', edNnWeLabel: 'EDNN_WE_D_NOW', inRcWeLabel: 'INRC_WE_D_NOW', setResWeLabel: 'SETRES_WE_D_NOW', cbRotWeLabel: 'CBROT_WE_D_NOW', ddMemLdWeLabel: 'DDMEMLD_WE_D_NOW', fdMemLdWeLabel: 'FDMEMLD_WE_D_NOW', ddHl8WeLabel: 'DDIX_HL8_WE_D_NOW', fdHl8WeLabel: 'FDIY_HL8_WE_D_NOW' },
    { reg: rE, ldY: dec.y[3]!, popPhase: popLowNow, popY: dec.y[2]!, ldImm8Label: 'LDIMM8_E_NOW', ldDdNnLabel: 'LDDDNN_LOW_E_NOW', edNnWeLabel: 'EDNN_WE_E_NOW', inRcWeLabel: 'INRC_WE_E_NOW', setResWeLabel: 'SETRES_WE_E_NOW', cbRotWeLabel: 'CBROT_WE_E_NOW', ddMemLdWeLabel: 'DDMEMLD_WE_E_NOW', fdMemLdWeLabel: 'FDMEMLD_WE_E_NOW', ddHl8WeLabel: 'DDIX_HL8_WE_E_NOW', fdHl8WeLabel: 'FDIY_HL8_WE_E_NOW' },
    { reg: rH, ldY: dec.y[4]!, popPhase: popHighNow, popY: dec.y[4]!, ldImm8Label: 'LDIMM8_H_NOW', ldDdNnLabel: 'LDDDNN_HIGH_H_NOW', edNnWeLabel: 'EDNN_WE_H_NOW', inRcWeLabel: 'INRC_WE_H_NOW', setResWeLabel: 'SETRES_WE_H_NOW', cbRotWeLabel: 'CBROT_WE_H_NOW', ddMemLdWeLabel: 'DDMEMLD_WE_H_NOW', fdMemLdWeLabel: 'FDMEMLD_WE_H_NOW' },
    { reg: rL, ldY: dec.y[5]!, popPhase: popLowNow, popY: dec.y[4]!, ldImm8Label: 'LDIMM8_L_NOW', ldDdNnLabel: 'LDDDNN_LOW_L_NOW', edNnWeLabel: 'EDNN_WE_L_NOW', inRcWeLabel: 'INRC_WE_L_NOW', setResWeLabel: 'SETRES_WE_L_NOW', cbRotWeLabel: 'CBROT_WE_L_NOW', ddMemLdWeLabel: 'DDMEMLD_WE_L_NOW', fdMemLdWeLabel: 'FDMEMLD_WE_L_NOW' },
  ];
  const ldExternal = ldDestSpecs.map(({ reg, ldY, popPhase, popY, ldImm8Label, ldDdNnLabel, edNnWeLabel, inRcWeLabel, setResWeLabel, cbRotWeLabel, ddMemLdWeLabel, fdMemLdWeLabel, ddHl8WeLabel, fdHl8WeLabel }, ri) => {
    const ldWeRaw = buildAnd(parent, { x: pos.x + 11000, y: pos.y - 500 + ri * 300 });
    wire(parent, ldGroupNow.out, ldWeRaw.a);
    wire(parent, ldY, ldWeRaw.b);
    const popWeRaw = buildAnd(parent, { x: pos.x + 11000, y: pos.y - 450 + ri * 300 });
    wire(parent, popPhase.out, popWeRaw.a);
    wire(parent, popY, popWeRaw.b);
    // DD/FD LD r,(IX+d)/(IY+d) — side-fold before the OR-N (same as before).
    const ddFdMemLdWe = buildOr(parent, { x: pos.x + 11190, y: pos.y - 498 + ri * 300 });
    tieToLabel(ddMemLdWeLabel, ddFdMemLdWe.a, { x: pos.x + 11090, y: pos.y - 498 + ri * 300 });
    tieToLabel(fdMemLdWeLabel, ddFdMemLdWe.b, { x: pos.x + 11090, y: pos.y - 478 + ri * 300 });
    // B/C/D/E: 10 WE sources; H/L: 9 (no HL8 remap).
    const withHl8 = !!(ddHl8WeLabel && fdHl8WeLabel);
    let ddFdHl8LdWeOut: Pin | null = null;
    if (withHl8) {
      const ddFdHl8LdWe = buildOr(parent, { x: pos.x + 11210, y: pos.y - 502 + ri * 300 });
      tieToLabel(ddHl8WeLabel!, ddFdHl8LdWe.a, { x: pos.x + 11110, y: pos.y - 502 + ri * 300 });
      tieToLabel(fdHl8WeLabel!, ddFdHl8LdWe.b, { x: pos.x + 11110, y: pos.y - 482 + ri * 300 });
      ddFdHl8LdWeOut = ddFdHl8LdWe.out;
    }
    const weN = withHl8 ? 10 : 9;
    const ldWeOrDef = getOrNChip(library, weN, withHl8 ? 'LD_WE_OR_10' : 'LD_WE_OR_9');
    const ldWeOr = makeChipInstance(parent, ldWeOrDef, { x: pos.x + 11150, y: pos.y - 480 + ri * 300 });
    const ldWeIn = (idx: number) => ldWeOr.pins[ldWeOrDef.ports[idx]!]!;
    wire(parent, ldWeRaw.out, ldWeIn(0));
    wire(parent, popWeRaw.out, ldWeIn(1));
    tieToLabel(ldImm8Label, ldWeIn(2), { x: pos.x + 10950, y: pos.y - 470 + ri * 300 });
    tieToLabel(ldDdNnLabel, ldWeIn(3), { x: pos.x + 11000, y: pos.y - 475 + ri * 300 });
    tieToLabel(edNnWeLabel, ldWeIn(4), { x: pos.x + 11020, y: pos.y - 480 + ri * 300 });
    tieToLabel(inRcWeLabel, ldWeIn(5), { x: pos.x + 11040, y: pos.y - 485 + ri * 300 });
    tieToLabel(setResWeLabel, ldWeIn(6), { x: pos.x + 11060, y: pos.y - 490 + ri * 300 });
    tieToLabel(cbRotWeLabel, ldWeIn(7), { x: pos.x + 11080, y: pos.y - 495 + ri * 300 });
    wire(parent, ddFdMemLdWe.out, ldWeIn(8));
    if (ddFdHl8LdWeOut) wire(parent, ddFdHl8LdWeOut, ldWeIn(9));
    const ldWe: Pin = ldWeOr.pins[ldWeOrDef.ports[weN]!]!;

    const regDataDef = getRegDataBitChip(library);
    const extD: Pin[] = [];
    for (let i = 0; i < 8; i++) {
      const bit = makeChipInstance(parent, regDataDef, {
        x: pos.x + 11250,
        y: pos.y - 500 + ri * 300 + i * 100,
      });
      const p = (name: string) => bit.pins[name]!;
      tieToLabel(inRcWeLabel, p('selInRc'), { x: pos.x + 11150, y: pos.y - 500 + ri * 300 + i * 100 });
      tieToLabel(setResWeLabel, p('selSetRes'), { x: pos.x + 11180, y: pos.y - 500 + ri * 300 + i * 100 });
      tieToLabel(cbRotWeLabel, p('selCbRot'), { x: pos.x + 11200, y: pos.y - 500 + ri * 300 + i * 100 });
      wire(parent, ldWe, p('selLdWe'));
      tieToLabel(`BUS${i}`, p('bus'), { x: pos.x + 11150, y: pos.y - 480 + ri * 300 + i * 100 });
      wire(parent, ioPortDataIn[i]!, p('ioIn'));
      tieToLabel(`SETRESRESULT${i}`, p('setResResult'), {
        x: pos.x + 11180,
        y: pos.y - 480 + ri * 300 + i * 100,
      });
      tieToLabel(`CBROTRESULT${i}`, p('cbRotResult'), {
        x: pos.x + 11200,
        y: pos.y - 480 + ri * 300 + i * 100,
      });
      extD.push(p('seed'));
      wire(parent, p('out'), reg.d[i]!);
    }
    const weOr = buildOr(parent, { x: pos.x + 11000, y: pos.y - 400 + ri * 300 });
    wire(parent, ldWe, weOr.a);
    wire(parent, weOr.out, reg.we);

    const external: Register = { d: extD, we: weOr.b, clk: reg.clk, q: reg.q, qn: reg.qn };
    return external;
  });
  const [rBExt, rCExt, rDExt, rEExt, rHExt, rLExt] = ldExternal as [Register, Register, Register, Register, Register, Register];

  // INC BC/DE/HL and DEC BC/DE/HL's own write-back: a THIRD layer on top of
  // the LD/POP wrapper above (ldExternal), same "mux ahead of d, OR into
  // we" treatment used everywhere in this file — never simultaneously
  // active with either of the other two competing for these bytes (LD r,r'
  // / POP's own bus capture is x=01/x=11, this is x=00, `dec.x` one-hot
  // decodes exactly one), so layering rather than choosing between them is
  // safe. `inner.d`/`inner.we` here are the layer below's own *sink* pins
  // (ldExternal's `extD`/`weOr.b`) — driving into them, not reading them.
  const pairCommitBitDef = getPairCommitBitChip(library);
  const wrapWithPairCommit = (inner: Register, commitLabel: string, aluByteLabel: string, wrapPos: Point): Register => {
    const extD: Pin[] = [];
    const weOr = buildOr(parent, { x: wrapPos.x, y: wrapPos.y + 850 });
    tieToLabel(commitLabel, weOr.a, { x: wrapPos.x - 100, y: wrapPos.y + 850 });
    wire(parent, weOr.out, inner.we);
    for (let i = 0; i < 8; i++) {
      const bit = makeChipInstance(parent, pairCommitBitDef, { x: wrapPos.x, y: wrapPos.y + i * 100 });
      const p = (name: string) => bit.pins[name]!;
      tieToLabel(commitLabel, p('sel'), { x: wrapPos.x - 100, y: wrapPos.y + i * 100 });
      extD.push(p('passthrough')); // to the caller's seed one layer further down
      tieToLabel(`${aluByteLabel}${i}`, p('override'), { x: wrapPos.x - 200, y: wrapPos.y + i * 100 });
      wire(parent, p('out'), inner.d[i]!);
    }
    return { d: extD, we: weOr.b, clk: inner.clk, q: inner.q, qn: inner.qn };
  };
  const rBExt2 = wrapWithPairCommit(rBExt, 'INCDEC_BC_NOW', 'BCADDHI', { x: pos.x + 11400, y: pos.y - 500 });
  const rCExt2 = wrapWithPairCommit(rCExt, 'INCDEC_BC_NOW', 'BCADDLO', { x: pos.x + 11400, y: pos.y - 200 });
  const rDExt2 = wrapWithPairCommit(rDExt, 'INCDEC_DE_NOW', 'DEADDHI', { x: pos.x + 11400, y: pos.y + 100 });
  const rEExt2 = wrapWithPairCommit(rEExt, 'INCDEC_DE_NOW', 'DEADDLO', { x: pos.x + 11400, y: pos.y + 400 });
  const rHExt2 = wrapWithPairCommit(rHExt, 'INCDEC_HL_NOW', 'HLADDHI', { x: pos.x + 11400, y: pos.y + 700 });
  const rLExt2 = wrapWithPairCommit(rLExt, 'INCDEC_HL_NOW', 'HLADDLO', { x: pos.x + 11400, y: pos.y + 1000 });

  // x=00, z=0, y=1: EX AF,AF' (real 0x08) — a true swap, both directions
  // committing on the same edge (see the doc comment by `aP`/`fP`'s own
  // creation above for why that's safe). `wrapWithPairCommit` — built for
  // INC BC/DE/HL's own "+1 into a paused pair" shape — turns out to be
  // exactly the tool a swap needs too: it doesn't care that the "value"
  // being committed is another register's old contents rather than an
  // adder's fresh output, and `aP`/`fP` are already plain `Register`s, no
  // wrapping needed to hand them in directly.
  const isExAfAf = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 700 });
  wire(parent, isX0Z0.out, isExAfAf.a);
  tieToLabel('DECY1', isExAfAf.b, { x: pos.x + 11400, y: pos.y - 700 });
  const exAfAfNow = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 690 });
  wire(parent, isExAfAf.out, exAfAfNow.a);
  tieToLabel('PHASE2', exAfAfNow.b, { x: pos.x + 11450, y: pos.y - 690 });
  tieToLabel('EX_AFAF_NOW', exAfAfNow.out, { x: pos.x + 11600, y: pos.y - 690 }); // anchor — A's own write mux and F's own write mux (both far) read this
  const aPExt = wrapWithPairCommit(aP, 'EX_AFAF_NOW', 'AOLD', { x: pos.x + 11700, y: pos.y - 700 });
  const fPExt = wrapWithPairCommit(fP, 'EX_AFAF_NOW', 'FOLD', { x: pos.x + 11700, y: pos.y - 300 });
  // LD I,A / LD R,A (see "x=01, z=7, y=0..3") — A into I/R via the same
  // wrapWithPairCommit tool every other "commit this published byte into
  // that register" path already uses.
  const rIExt = wrapWithPairCommit(regI, 'LDIA_NOW', 'AOLD', { x: pos.x + 11850, y: pos.y - 700 });
  const rRExt = wrapWithPairCommit(regR, 'LDRA_NOW', 'AOLD', { x: pos.x + 11850, y: pos.y - 300 });
  // R M1 auto-increment (soft bumpR parity): (R & 0x80) | ((R+1) & 0x7f).
  // Fires on PHASE0 FETCH when not accepting NMI, on INT accept (thin INTACK
  // R bump), and on PREFIX_READ_NOW. NMI leaves R alone (softNmi parity).
  const notNmiAcceptForR = buildNot(parent, { x: pos.x + 11700, y: pos.y - 200 });
  tieToLabel('NMI_ACCEPT_NOW', notNmiAcceptForR.in, { x: pos.x + 11600, y: pos.y - 200 });
  const rincFetch = buildAnd(parent, { x: pos.x + 11750, y: pos.y - 180 });
  tieToLabel('PHASE0', rincFetch.a, { x: pos.x + 11650, y: pos.y - 180 });
  wire(parent, notNmiAcceptForR.out, rincFetch.b);
  const rincNow = buildOr(parent, { x: pos.x + 11800, y: pos.y - 160 });
  wire(parent, rincFetch.out, rincNow.a);
  tieToLabel('PREFIX_READ_NOW', rincNow.b, { x: pos.x + 11700, y: pos.y - 160 });
  tieToLabel('RINC_NOW', rincNow.out, { x: pos.x + 11900, y: pos.y - 160 });
  // Low 7 bits: +1 ripple; bit7 sticky from current R (carry must not enter bit7).
  let rincCin: Pin = railPin(parent, 'VCC', { x: pos.x + 11550, y: pos.y - 100 });
  for (let i = 0; i < 7; i++) {
    const ha = buildHalfAdder(parent, { x: pos.x + 11600, y: pos.y - 100 + i * 40 });
    wire(parent, regR.q[i]!, ha.a);
    wire(parent, rincCin, ha.b);
    tieToLabel(`RINC${i}`, ha.sum, { x: pos.x + 11750, y: pos.y - 100 + i * 40 });
    rincCin = ha.cout;
  }
  tieToLabel('RINC7', regR.q[7]!, { x: pos.x + 11750, y: pos.y - 100 + 7 * 40 });
  const rRExt2 = wrapWithPairCommit(rRExt, 'RINC_NOW', 'RINC', { x: pos.x + 12150, y: pos.y - 300 });
  // Hold the external-seed `we` at 0 — I/R have no seed contract (every
  // pre-existing test would otherwise leave these floating). Writes go
  // only through LDIA_NOW / LDRA_NOW / RINC_NOW.
  tiePowerRail(parent, 'GND', rIExt.we);
  tiePowerRail(parent, 'GND', rRExt2.we);
  // DD: IX write-back — LD IX,nn then POP IX, each a wrapWithPairCommit
  // layer with BUS as the value (labels BUS0..7 already exist). Seed path
  // stays on the outermost `.d`/`.we` (same contract as rB).
  const rIXHExt = wrapWithPairCommit(rIXH, 'LDIXNN_HIGH_NOW', 'BUS', { x: pos.x + 11850, y: pos.y - 1100 });
  const rIXLExt = wrapWithPairCommit(rIXL, 'LDIXNN_LOW_NOW', 'BUS', { x: pos.x + 11850, y: pos.y - 1400 });
  const rIXHExt2 = wrapWithPairCommit(rIXHExt, 'POPIX_HIGH_NOW', 'BUS', { x: pos.x + 12150, y: pos.y - 1100 });
  const rIXLExt2 = wrapWithPairCommit(rIXLExt, 'POPIX_LOW_NOW', 'BUS', { x: pos.x + 12150, y: pos.y - 1400 });
  const rIXHExt3 = wrapWithPairCommit(rIXHExt2, 'ADDIX_NOW', 'ADDHLHI', { x: pos.x + 12450, y: pos.y - 1100 });
  const rIXLExt3 = wrapWithPairCommit(rIXLExt2, 'ADDIX_NOW', 'ADDHLLO', { x: pos.x + 12450, y: pos.y - 1400 });
  const rIXHExt4 = wrapWithPairCommit(rIXHExt3, 'INCDEC_IX_NOW', 'IXADDHI', { x: pos.x + 12750, y: pos.y - 1100 });
  const rIXLExt4 = wrapWithPairCommit(rIXLExt3, 'INCDEC_IX_NOW', 'IXADDLO', { x: pos.x + 12750, y: pos.y - 1400 });
  const rIXHExt5 = wrapWithPairCommit(rIXHExt4, 'EXSPIX_WRITE_HIGH_NOW', 'SPHITEMP', { x: pos.x + 13050, y: pos.y - 1100 });
  const rIXLExt5 = wrapWithPairCommit(rIXLExt4, 'EXSPIX_WRITE_LOW_NOW', 'SPLOTEMP', { x: pos.x + 13050, y: pos.y - 1400 });
  // DD HL8: LD IXH/IXL,r / LD IXH/IXL,n from BUS; INC/DEC from R8RESULT.
  const rIXHExt6 = wrapWithPairCommit(rIXHExt5, 'DDIXH_BUS_NOW', 'BUS', { x: pos.x + 13350, y: pos.y - 1100 });
  const rIXLExt6 = wrapWithPairCommit(rIXLExt5, 'DDIXL_BUS_NOW', 'BUS', { x: pos.x + 13350, y: pos.y - 1400 });
  const rIXHExt7 = wrapWithPairCommit(rIXHExt6, 'DDIXH_INC_NOW', 'R8RESULT', { x: pos.x + 13650, y: pos.y - 1100 });
  const rIXLExt7 = wrapWithPairCommit(rIXLExt6, 'DDIXL_INC_NOW', 'R8RESULT', { x: pos.x + 13650, y: pos.y - 1400 });
  // FD: IY write-back — mirror of IX above.
  const rIYHExt = wrapWithPairCommit(rIYH, 'LDIYNN_HIGH_NOW', 'BUS', { x: pos.x + 11850, y: pos.y - 1700 });
  const rIYLExt = wrapWithPairCommit(rIYL, 'LDIYNN_LOW_NOW', 'BUS', { x: pos.x + 11850, y: pos.y - 2000 });
  const rIYHExt2 = wrapWithPairCommit(rIYHExt, 'POPIY_HIGH_NOW', 'BUS', { x: pos.x + 12150, y: pos.y - 1700 });
  const rIYLExt2 = wrapWithPairCommit(rIYLExt, 'POPIY_LOW_NOW', 'BUS', { x: pos.x + 12150, y: pos.y - 2000 });
  const rIYHExt3 = wrapWithPairCommit(rIYHExt2, 'ADDIY_NOW', 'ADDHLHI', { x: pos.x + 12450, y: pos.y - 1700 });
  const rIYLExt3 = wrapWithPairCommit(rIYLExt2, 'ADDIY_NOW', 'ADDHLLO', { x: pos.x + 12450, y: pos.y - 2000 });
  const rIYHExt4 = wrapWithPairCommit(rIYHExt3, 'INCDEC_IY_NOW', 'IYADDHI', { x: pos.x + 12750, y: pos.y - 1700 });
  const rIYLExt4 = wrapWithPairCommit(rIYLExt3, 'INCDEC_IY_NOW', 'IYADDLO', { x: pos.x + 12750, y: pos.y - 2000 });
  const rIYHExt5 = wrapWithPairCommit(rIYHExt4, 'EXSPIY_WRITE_HIGH_NOW', 'SPHITEMP', { x: pos.x + 13050, y: pos.y - 1700 });
  const rIYLExt5 = wrapWithPairCommit(rIYLExt4, 'EXSPIY_WRITE_LOW_NOW', 'SPLOTEMP', { x: pos.x + 13050, y: pos.y - 2000 });
  const rIYHExt6 = wrapWithPairCommit(rIYHExt5, 'FDIYH_BUS_NOW', 'BUS', { x: pos.x + 13350, y: pos.y - 1700 });
  const rIYLExt6 = wrapWithPairCommit(rIYLExt5, 'FDIYL_BUS_NOW', 'BUS', { x: pos.x + 13350, y: pos.y - 2000 });
  const rIYHExt7 = wrapWithPairCommit(rIYHExt6, 'FDIYH_INC_NOW', 'R8RESULT', { x: pos.x + 13650, y: pos.y - 1700 });
  const rIYLExt7 = wrapWithPairCommit(rIYLExt6, 'FDIYL_INC_NOW', 'R8RESULT', { x: pos.x + 13650, y: pos.y - 2000 });
  aP.q.forEach((q, i) => tieToLabel(`APOLD${i}`, q, { x: pos.x + 11800, y: pos.y - 700 + i * 20 })); // anchor — A's own write mux (far) reads this
  fP.q.forEach((q, i) => tieToLabel(`FPOLD${i}`, q, { x: pos.x + 11800, y: pos.y - 300 + i * 20 })); // anchor — F's own write mux (far) reads this

  // Thin IRQ: IFF1/IFF2/IM0/1/2 write-back — seed path on the exposed Register,
  // internal commits via DI/EI-commit/INT-accept/NMI-accept/RETI/RETN/IM*_NOW.
  // Mux priority for IFF1: clear (DI|INT|NMI) > EI_COMMIT=1 > RETI/RETN←IFF2 > seed.
  // IFF2 clears on DI|INT only (NMI leaves IFF2). Soft-parity EI delay unchanged.
  const notEi = buildNot(parent, { x: pos.x + 12000, y: pos.y - 1000 });
  tieToLabel('EI_NOW', notEi.in, { x: pos.x + 11900, y: pos.y - 1000 });
  const eiCommitGate = buildAnd(parent, { x: pos.x + 12050, y: pos.y - 980 });
  tieToLabel('PHASE2', eiCommitGate.a, { x: pos.x + 11950, y: pos.y - 980 });
  wire(parent, eiArm1.q[0]!, eiCommitGate.b);
  const eiCommit = buildAnd(parent, { x: pos.x + 12100, y: pos.y - 980 });
  wire(parent, eiCommitGate.out, eiCommit.a);
  wire(parent, notEi.out, eiCommit.b);
  tieToLabel('EI_COMMIT', eiCommit.out, { x: pos.x + 12200, y: pos.y - 980 });

  const eiPendingWe = buildOr(parent, { x: pos.x + 12050, y: pos.y - 940 });
  tieToLabel('PHASE2', eiPendingWe.a, { x: pos.x + 11950, y: pos.y - 940 });
  tieToLabel('DI_NOW', eiPendingWe.b, { x: pos.x + 11950, y: pos.y - 920 });
  const eiPendingWe2 = buildOr(parent, { x: pos.x + 12100, y: pos.y - 940 });
  wire(parent, eiPendingWe.out, eiPendingWe2.a);
  tieToLabel('INT_ACCEPT_NOW', eiPendingWe2.b, { x: pos.x + 12000, y: pos.y - 920 });
  wire(parent, eiPendingWe2.out, eiArm1.we);
  tieToLabel('EI_NOW', eiArm1.d[0]!, { x: pos.x + 11950, y: pos.y - 900 });

  // eiArm2 unused in this simplified delay — tie quiescent.
  tiePowerRail(parent, 'GND', eiArm2.we);
  tiePowerRail(parent, 'GND', eiArm2.d[0]!);

  // HALT latch — set on HALT_NOW; clear on INT/NMI accept / reset.
  const haltClear = buildOr(parent, { x: pos.x + 11950, y: pos.y - 860 });
  tieToLabel('IRQ_ACCEPT_ANY', haltClear.a, { x: pos.x + 11850, y: pos.y - 860 });
  tieToLabel('CPU_RESET', haltClear.b, { x: pos.x + 11850, y: pos.y - 840 });
  const haltWe = buildOr(parent, { x: pos.x + 12050, y: pos.y - 860 });
  tieToLabel('HALT_NOW', haltWe.a, { x: pos.x + 11950, y: pos.y - 860 });
  wire(parent, haltClear.out, haltWe.b);
  wire(parent, haltWe.out, halted.we);
  tieToLabel('HALT_NOW', halted.d[0]!, { x: pos.x + 11950, y: pos.y - 820 });

  const iff1Clear = buildOr(parent, { x: pos.x + 12100, y: pos.y - 900 });
  tieToLabel('DI_NOW', iff1Clear.a, { x: pos.x + 12000, y: pos.y - 900 });
  tieToLabel('IRQ_ACCEPT_ANY', iff1Clear.b, { x: pos.x + 12000, y: pos.y - 880 });
  const iff1RetiMux = makeChipInstance(parent, muxDef, { x: pos.x + 12200, y: pos.y - 900 });
  tieToLabel('RETI_OR_RETN_NOW', iff1RetiMux.pins[muxDef.ports[0]!]!, { x: pos.x + 12100, y: pos.y - 900 });
  const iff1SeedD = iff1RetiMux.pins[muxDef.ports[1]!]!; // in0: seed (or fall-through)
  wire(parent, iff2.q[0]!, iff1RetiMux.pins[muxDef.ports[2]!]!); // in1: IFF2
  const iff1EiMux = makeChipInstance(parent, muxDef, { x: pos.x + 12300, y: pos.y - 900 });
  tieToLabel('EI_COMMIT', iff1EiMux.pins[muxDef.ports[0]!]!, { x: pos.x + 12200, y: pos.y - 900 });
  wire(parent, iff1RetiMux.pins[muxDef.ports[3]!]!, iff1EiMux.pins[muxDef.ports[1]!]!);
  tiePowerRail(parent, 'VCC', iff1EiMux.pins[muxDef.ports[2]!]!);
  const iff1ClearMux = makeChipInstance(parent, muxDef, { x: pos.x + 12400, y: pos.y - 900 });
  wire(parent, iff1Clear.out, iff1ClearMux.pins[muxDef.ports[0]!]!);
  wire(parent, iff1EiMux.pins[muxDef.ports[3]!]!, iff1ClearMux.pins[muxDef.ports[1]!]!);
  tiePowerRail(parent, 'GND', iff1ClearMux.pins[muxDef.ports[2]!]!);
  wire(parent, iff1ClearMux.pins[muxDef.ports[3]!]!, iff1.d[0]!);
  const iff1We1 = buildOr(parent, { x: pos.x + 12100, y: pos.y - 820 });
  tieToLabel('DI_NOW', iff1We1.a, { x: pos.x + 12000, y: pos.y - 820 });
  tieToLabel('EI_COMMIT', iff1We1.b, { x: pos.x + 12000, y: pos.y - 800 });
  const iff1We2 = buildOr(parent, { x: pos.x + 12200, y: pos.y - 820 });
  wire(parent, iff1We1.out, iff1We2.a);
  tieToLabel('IRQ_ACCEPT_ANY', iff1We2.b, { x: pos.x + 12100, y: pos.y - 800 });
  const iff1We3 = buildOr(parent, { x: pos.x + 12300, y: pos.y - 820 });
  wire(parent, iff1We2.out, iff1We3.a);
  tieToLabel('RETI_OR_RETN_NOW', iff1We3.b, { x: pos.x + 12200, y: pos.y - 800 });
  wire(parent, iff1We3.out, iff1.we);
  tiePowerRail(parent, 'GND', iff1SeedD);

  const iff2Clear = buildOr(parent, { x: pos.x + 12100, y: pos.y - 700 });
  tieToLabel('DI_NOW', iff2Clear.a, { x: pos.x + 12000, y: pos.y - 700 });
  tieToLabel('INT_ACCEPT_NOW', iff2Clear.b, { x: pos.x + 12000, y: pos.y - 680 }); // NMI leaves IFF2
  const iff2EiMux = makeChipInstance(parent, muxDef, { x: pos.x + 12200, y: pos.y - 700 });
  tieToLabel('EI_COMMIT', iff2EiMux.pins[muxDef.ports[0]!]!, { x: pos.x + 12100, y: pos.y - 700 });
  const iff2SeedD = iff2EiMux.pins[muxDef.ports[1]!]!;
  tiePowerRail(parent, 'VCC', iff2EiMux.pins[muxDef.ports[2]!]!);
  const iff2ClearMux = makeChipInstance(parent, muxDef, { x: pos.x + 12300, y: pos.y - 700 });
  wire(parent, iff2Clear.out, iff2ClearMux.pins[muxDef.ports[0]!]!);
  wire(parent, iff2EiMux.pins[muxDef.ports[3]!]!, iff2ClearMux.pins[muxDef.ports[1]!]!);
  tiePowerRail(parent, 'GND', iff2ClearMux.pins[muxDef.ports[2]!]!);
  wire(parent, iff2ClearMux.pins[muxDef.ports[3]!]!, iff2.d[0]!);
  const iff2We1 = buildOr(parent, { x: pos.x + 12100, y: pos.y - 620 });
  tieToLabel('DI_NOW', iff2We1.a, { x: pos.x + 12000, y: pos.y - 620 });
  tieToLabel('EI_COMMIT', iff2We1.b, { x: pos.x + 12000, y: pos.y - 600 });
  const iff2We2 = buildOr(parent, { x: pos.x + 12200, y: pos.y - 620 });
  wire(parent, iff2We1.out, iff2We2.a);
  tieToLabel('INT_ACCEPT_NOW', iff2We2.b, { x: pos.x + 12100, y: pos.y - 600 });
  wire(parent, iff2We2.out, iff2.we);
  tiePowerRail(parent, 'GND', iff2SeedD);

  // IM mode latches: setting one clears the others on PHASE4 (IM_ANY_NOW).
  const im0Mux = makeChipInstance(parent, muxDef, { x: pos.x + 12200, y: pos.y - 520 });
  tieToLabel('IM0_NOW', im0Mux.pins[muxDef.ports[0]!]!, { x: pos.x + 12100, y: pos.y - 520 });
  const im0SeedD = im0Mux.pins[muxDef.ports[1]!]!;
  tiePowerRail(parent, 'VCC', im0Mux.pins[muxDef.ports[2]!]!);
  wire(parent, im0Mux.pins[muxDef.ports[3]!]!, im0.d[0]!);
  tieToLabel('IM_ANY_NOW', im0.we, { x: pos.x + 12200, y: pos.y - 500 });
  tiePowerRail(parent, 'GND', im0SeedD);

  const im1Mux = makeChipInstance(parent, muxDef, { x: pos.x + 12200, y: pos.y - 480 });
  tieToLabel('IM1_NOW', im1Mux.pins[muxDef.ports[0]!]!, { x: pos.x + 12100, y: pos.y - 480 });
  const im1SeedD = im1Mux.pins[muxDef.ports[1]!]!;
  tiePowerRail(parent, 'VCC', im1Mux.pins[muxDef.ports[2]!]!);
  wire(parent, im1Mux.pins[muxDef.ports[3]!]!, im1.d[0]!);
  tieToLabel('IM_ANY_NOW', im1.we, { x: pos.x + 12200, y: pos.y - 460 });
  tiePowerRail(parent, 'GND', im1SeedD);

  const im2Mux = makeChipInstance(parent, muxDef, { x: pos.x + 12200, y: pos.y - 440 });
  tieToLabel('IM2_NOW', im2Mux.pins[muxDef.ports[0]!]!, { x: pos.x + 12100, y: pos.y - 440 });
  const im2SeedD = im2Mux.pins[muxDef.ports[1]!]!;
  tiePowerRail(parent, 'VCC', im2Mux.pins[muxDef.ports[2]!]!);
  wire(parent, im2Mux.pins[muxDef.ports[3]!]!, im2.d[0]!);
  tieToLabel('IM_ANY_NOW', im2.we, { x: pos.x + 12200, y: pos.y - 420 });
  tiePowerRail(parent, 'GND', im2SeedD);

  // INC r/DEC r (x=00, z=4/z=5 — see the doc comment above) needs a
  // *fourth* layer on top: `wrapWithPairCommit` is generic enough to reuse
  // as-is (it doesn't know or care that this call's "pair" is really six
  // independent single-register cases sharing one label prefix,
  // `R8RESULT0`-`R8RESULT7` — the shared adder above computes into that
  // label once, and only one of these six `INCDEC_x_NOW` conditions is
  // ever 1 at a time, so all six reading the identical `R8RESULT` label is
  // safe, not a collision).
  const rBExt3 = wrapWithPairCommit(rBExt2, 'INCDEC_B_NOW', 'R8RESULT', { x: pos.x + 11700, y: pos.y - 500 });
  const rCExt3 = wrapWithPairCommit(rCExt2, 'INCDEC_C_NOW', 'R8RESULT', { x: pos.x + 11700, y: pos.y - 200 });
  const rDExt3 = wrapWithPairCommit(rDExt2, 'INCDEC_D_NOW', 'R8RESULT', { x: pos.x + 11700, y: pos.y + 100 });
  const rEExt3 = wrapWithPairCommit(rEExt2, 'INCDEC_E_NOW', 'R8RESULT', { x: pos.x + 11700, y: pos.y + 400 });
  const rHExt3 = wrapWithPairCommit(rHExt2, 'INCDEC_H_NOW', 'R8RESULT', { x: pos.x + 11700, y: pos.y + 700 });
  const rLExt3 = wrapWithPairCommit(rLExt2, 'INCDEC_L_NOW', 'R8RESULT', { x: pos.x + 11700, y: pos.y + 1000 });

  // DJNZ's own decrement (see "x=00: JR cc,e" above — DJNZ shares that
  // section) needs a *fourth* write-back layer on B alone — none of
  // C/D/E/H/L ever compete for this one, since DJNZ hardcodes B as its
  // only register, not a `y`-selected one. `djnzAdder`'s own result,
  // already computed unconditionally, only ever commits when
  // `DJNZ_DEC_NOW` actually fires.
  const rBExt4 = wrapWithPairCommit(rBExt3, 'DJNZ_DEC_NOW', 'DJNZRESULT', { x: pos.x + 12000, y: pos.y - 500 });

  // ADD HL,rr's own 16-bit result (see "x=00: ADD HL,rr" above) needs a
  // *fifth* write-back layer on H and L specifically — the same shared-
  // commit-label shape `INCDEC_HL_NOW` already established for `H`/`L`
  // moving together as one pair, just one layer further out.
  const rHExt4 = wrapWithPairCommit(rHExt3, 'ADDHL_NOW', 'ADDHLHI', { x: pos.x + 12000, y: pos.y + 700 });
  const rLExt4 = wrapWithPairCommit(rLExt3, 'ADDHL_NOW', 'ADDHLLO', { x: pos.x + 12000, y: pos.y + 1000 });

  // LD HL,(nn)'s own read (see "x=00: indirect loads through
  // (BC)/(DE)/(nn)" above) needs a *sixth* write-back layer each — `BUS`
  // itself as the value label, since the data comes straight off the bus
  // (RAM, addressed through `nnAddr`/`nnAddr + 1`), not a computed adder
  // result the way every earlier layer's own value was.
  const rHExt5 = wrapWithPairCommit(rHExt4, 'LDHLNN_HIGH_NOW', 'BUS', { x: pos.x + 12300, y: pos.y + 700 });
  const rLExt5 = wrapWithPairCommit(rLExt4, 'LDHLNN_LOW_NOW', 'BUS', { x: pos.x + 12300, y: pos.y + 1000 });

  // x=11, z=1, y=3: EXX (real 0xD9) — the identical swap `EX AF,AF'` above
  // does, three pairs at once instead of one. `isStackReadZ` (`x=11, z=1`,
  // already shared by `RET`/`POP` above) plus `y=3` is the whole decode;
  // `wrapWithPairCommit` makes the write-back side almost free this time —
  // `rB`..`rL` already sit under several of these layers each (LD/POP,
  // INC/DEC pair, INC/DEC single, and — B specifically — DJNZ), so EXX is
  // just one more layer stacked on the *current outermost* wrapper for
  // each, no bespoke per-bit mux surgery the way `A`/`F` needed (those two
  // were never wrapped in `wrapWithPairCommit` in the first place, having
  // no external-seed contract of their own until `EX AF,AF'` gave `A` one
  // indirectly through `A'`).
  const isExx = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 900 });
  wire(parent, isStackReadZ.out, isExx.a);
  tieToLabel('DECY3', isExx.b, { x: pos.x + 11400, y: pos.y - 900 });
  const exxNow = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 890 });
  wire(parent, isExx.out, exxNow.a);
  tieToLabel('PHASE2', exxNow.b, { x: pos.x + 11450, y: pos.y - 890 });
  tieToLabel('EXX_NOW', exxNow.out, { x: pos.x + 11600, y: pos.y - 890 }); // anchor — B/C/D/E/H/L's own outermost write-back layer (far) and B'/C'/D'/E'/H'/L' themselves all read this
  const bPExt = wrapWithPairCommit(bP, 'EXX_NOW', 'BOLD', { x: pos.x + 11700, y: pos.y - 900 });
  const cPExt = wrapWithPairCommit(cP, 'EXX_NOW', 'COLD', { x: pos.x + 11700, y: pos.y - 600 });
  const dPExt = wrapWithPairCommit(dP, 'EXX_NOW', 'DOLD', { x: pos.x + 11700, y: pos.y - 300 });
  const ePExt = wrapWithPairCommit(eP, 'EXX_NOW', 'EOLD', { x: pos.x + 11700, y: pos.y });
  const hPExt = wrapWithPairCommit(hP, 'EXX_NOW', 'HOLD', { x: pos.x + 11700, y: pos.y + 300 });
  const lPExt = wrapWithPairCommit(lP, 'EXX_NOW', 'LOLD', { x: pos.x + 11700, y: pos.y + 600 });
  bP.q.forEach((q, i) => tieToLabel(`BPOLD${i}`, q, { x: pos.x + 11800, y: pos.y - 900 + i * 20 })); // anchor — B's own outermost write-back layer (far) reads this
  cP.q.forEach((q, i) => tieToLabel(`CPOLD${i}`, q, { x: pos.x + 11800, y: pos.y - 600 + i * 20 }));
  dP.q.forEach((q, i) => tieToLabel(`DPOLD${i}`, q, { x: pos.x + 11800, y: pos.y - 300 + i * 20 }));
  eP.q.forEach((q, i) => tieToLabel(`EPOLD${i}`, q, { x: pos.x + 11800, y: pos.y + i * 20 }));
  hP.q.forEach((q, i) => tieToLabel(`HPOLD${i}`, q, { x: pos.x + 11800, y: pos.y + 300 + i * 20 }));
  lP.q.forEach((q, i) => tieToLabel(`LPOLD${i}`, q, { x: pos.x + 11800, y: pos.y + 600 + i * 20 }));
  const rBExt5 = wrapWithPairCommit(rBExt4, 'EXX_NOW', 'BPOLD', { x: pos.x + 12300, y: pos.y - 500 });
  const rCExt4 = wrapWithPairCommit(rCExt3, 'EXX_NOW', 'CPOLD', { x: pos.x + 12300, y: pos.y - 200 });
  const rDExt4 = wrapWithPairCommit(rDExt3, 'EXX_NOW', 'DPOLD', { x: pos.x + 12300, y: pos.y + 100 });
  const rEExt4 = wrapWithPairCommit(rEExt3, 'EXX_NOW', 'EPOLD', { x: pos.x + 12300, y: pos.y + 400 });
  const rHExt6 = wrapWithPairCommit(rHExt5, 'EXX_NOW', 'HPOLD', { x: pos.x + 12600, y: pos.y + 700 });
  const rLExt6 = wrapWithPairCommit(rLExt5, 'EXX_NOW', 'LPOLD', { x: pos.x + 12600, y: pos.y + 1000 });

  // x=11, z=1, y=5: JP (HL) (real 0xE9) — PC <- HL, single byte, no RAM
  // read at all: `PHASE2`'s own commit already has everything it needs
  // sitting in a register. y=7: LD SP,HL (real 0xF9) — SP <- HL, the
  // identical shape. Both share `isStackReadZ` a third way; the actual
  // write-back for each lives with its own destination register (`PC`'s
  // own `jpHlMux` above, `SP`'s own third layer below).
  const isJpHl = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 1100 });
  wire(parent, isStackReadZ.out, isJpHl.a);
  tieToLabel('DECY5', isJpHl.b, { x: pos.x + 11400, y: pos.y - 1100 });
  const jpHlNow = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1090 });
  wire(parent, isJpHl.out, jpHlNow.a);
  tieToLabel('PHASE2', jpHlNow.b, { x: pos.x + 11450, y: pos.y - 1090 });
  tieToLabel('JPHL_NOW', jpHlNow.out, { x: pos.x + 11600, y: pos.y - 1090 }); // anchor — PC's own write mux (far) reads this

  const isLdSpHl = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 1300 });
  wire(parent, isStackReadZ.out, isLdSpHl.a);
  tieToLabel('DECY7', isLdSpHl.b, { x: pos.x + 11400, y: pos.y - 1300 });
  const ldSpHlNow = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1290 });
  wire(parent, isLdSpHl.out, ldSpHlNow.a);
  tieToLabel('PHASE2', ldSpHlNow.b, { x: pos.x + 11450, y: pos.y - 1290 });
  tieToLabel('LDSPHL_NOW', ldSpHlNow.out, { x: pos.x + 11600, y: pos.y - 1290 }); // anchor — SP's own write mux (far) reads this

  // x=11, z=1: EX DE,HL (real 0xEB) — D<->H, E<->L, both real, already-
  // live register pairs (unlike EX AF,AF'/EXX, no shadow registers
  // needed). `HOLD`/`DOLD`/`EOLD`/`LOLD` (published earlier for EXX's own
  // swap) already carry exactly the values this needs — `D`'s own new
  // value is `H`'s old one, and vice versa — so no new per-bit labels at
  // all, just one more `wrapWithPairCommit` layer per register, reading
  // labels that already exist.
  const isExDeHl = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 1500 });
  wire(parent, isX11Z3.out, isExDeHl.a);
  tieToLabel('DECY5', isExDeHl.b, { x: pos.x + 11400, y: pos.y - 1500 });
  const exDeHlNow = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1490 });
  wire(parent, isExDeHl.out, exDeHlNow.a);
  tieToLabel('PHASE2', exDeHlNow.b, { x: pos.x + 11450, y: pos.y - 1490 });
  tieToLabel('EXDEHL_NOW', exDeHlNow.out, { x: pos.x + 11600, y: pos.y - 1490 }); // anchor — D/E/H/L's own outermost write-back layer (far) reads this
  const rDExt5 = wrapWithPairCommit(rDExt4, 'EXDEHL_NOW', 'HOLD', { x: pos.x + 12900, y: pos.y - 200 });
  const rEExt5 = wrapWithPairCommit(rEExt4, 'EXDEHL_NOW', 'LOLD', { x: pos.x + 12900, y: pos.y + 100 });
  const rHExt7 = wrapWithPairCommit(rHExt6, 'EXDEHL_NOW', 'DOLD', { x: pos.x + 12900, y: pos.y + 700 });
  const rLExt7 = wrapWithPairCommit(rLExt6, 'EXDEHL_NOW', 'EOLD', { x: pos.x + 12900, y: pos.y + 1000 });

  // x=11, z=3, y=4: EX (SP),HL (real 0xE3) — see "x=11: EX (SP),HL" below
  // for the full derivation. Real RAM read-modify-write, four phases
  // (PHASE2-PHASE5, fits the existing 8-phase budget with room to spare):
  // read [SP] into a holding register, read [SP+1] into a second one,
  // then write A''s... no, `L`'s own old value to [SP] while `L` itself
  // takes the first holding register's value, same for `H`/[SP+1]/the
  // second holding register — a register-to-RAM swap, the identical
  // "swap on one edge" master-slave guarantee `EX AF,AF'`/`EXX`/
  // `EX DE,HL` above already rely on, just with RAM standing in for one
  // side of it.
  // x=11, z=3, y=3: IN A,(n), y=2: OUT (n),A (real 0xDB/0xD3 — see "x=11:
  // IN A,(n) / OUT (n),A" below). This simulator invents its own I/O-port
  // concept from scratch here — nothing in this file has ever needed one
  // before — so the interface is deliberately minimal: `ioPortAddr` (16-bit
  // Soft parity: low = bus/`n`/`C`, high = `A` imm or `B` for (C)/block),
  // `ioPortDataOut` (a live tap of `A`, valid only while `ioWrite` fires),
  // `ioPortDataIn` (a genuinely external input pin — whatever device a
  // caller wires up there is expected to respond to `ioRead` combination-
  // ally), and the two strobes themselves.
  const isOutImm = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 2100 });
  wire(parent, isX11Z3.out, isOutImm.a);
  tieToLabel('DECY2', isOutImm.b, { x: pos.x + 11400, y: pos.y - 2100 });
  const isInImm = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 2200 });
  wire(parent, isX11Z3.out, isInImm.a);
  tieToLabel('DECY3', isInImm.b, { x: pos.x + 11400, y: pos.y - 2200 });
  const isIoImmStage = buildOr(parent, { x: pos.x + 11550, y: pos.y - 2150 });
  wire(parent, isOutImm.out, isIoImmStage.a);
  wire(parent, isInImm.out, isIoImmStage.b);
  const ioImmReadNow = buildAnd(parent, { x: pos.x + 11600, y: pos.y - 2140 });
  wire(parent, isIoImmStage.out, ioImmReadNow.a);
  tieToLabel('PHASE2', ioImmReadNow.b, { x: pos.x + 11500, y: pos.y - 2140 });
  tieToLabel('IOIMM_READ_NOW', ioImmReadNow.out, { x: pos.x + 11700, y: pos.y - 2140 }); // anchor — ramOeStage (far) reads this
  const ioImmAdvanceNow = buildAnd(parent, { x: pos.x + 11600, y: pos.y - 2180 });
  wire(parent, isIoImmStage.out, ioImmAdvanceNow.a);
  tieToLabel('PHASE3', ioImmAdvanceNow.b, { x: pos.x + 11500, y: pos.y - 2180 });
  tieToLabel('IOIMM_ADVANCE_NOW', ioImmAdvanceNow.out, { x: pos.x + 11700, y: pos.y - 2180 }); // anchor — pcHold (far) reads this

  // Nested I/O window (imm): PHASE2 arms the 4-T bus nest (addr/data +
  // strobe). PHASE3 only advances PC (IOIMM_ADVANCE_NOW) — no second IORQ.
  const outNow = buildAnd(parent, { x: pos.x + 11650, y: pos.y - 2100 });
  wire(parent, isOutImm.out, outNow.a);
  tieToLabel('PHASE2', outNow.b, { x: pos.x + 11550, y: pos.y - 2100 });
  const inNow = buildAnd(parent, { x: pos.x + 11650, y: pos.y - 2200 });
  wire(parent, isInImm.out, inNow.a);
  tieToLabel('PHASE2', inNow.b, { x: pos.x + 11550, y: pos.y - 2200 });
  tieToLabel('IN_NOW', inNow.out, { x: pos.x + 11750, y: pos.y - 2200 }); // anchor — A's own write mux (far) reads this via the label; `ioRead` in the return object reads `inNow.out` directly, same local scope
  tieToLabel('OUT_NOW', outNow.out, { x: pos.x + 11750, y: pos.y - 2100 });

  // ioPortAddr[15:0]: low 8 = BUS (n / C); high 8 = A (imm) or B ((C)/block).
  const ioPortHighFromB = buildOr(parent, { x: pos.x + 11800, y: pos.y - 2260 });
  tieToLabel('INRC_NOW', ioPortHighFromB.a, { x: pos.x + 11700, y: pos.y - 2260 });
  tieToLabel('OUTRC_NOW', ioPortHighFromB.b, { x: pos.x + 11700, y: pos.y - 2280 });
  const ioPortHighFromB2 = buildOr(parent, { x: pos.x + 11820, y: pos.y - 2260 });
  wire(parent, ioPortHighFromB.out, ioPortHighFromB2.a);
  tieToLabel('INBLOCK_READ_NOW', ioPortHighFromB2.b, { x: pos.x + 11720, y: pos.y - 2260 });
  const ioPortHighFromB3 = buildOr(parent, { x: pos.x + 11840, y: pos.y - 2260 });
  wire(parent, ioPortHighFromB2.out, ioPortHighFromB3.a);
  tieToLabel('OUTBLOCK_WRITE_NOW', ioPortHighFromB3.b, { x: pos.x + 11740, y: pos.y - 2260 });
  const ioPortAddr: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const label = makeLabel(parent, `BUS${i}`, { x: pos.x + 11850, y: pos.y - 2200 + i * 20 });
    ioPortAddr.push(label.pins.net);
  }
  for (let i = 0; i < 8; i++) {
    const hiMux = makeChipInstance(parent, muxDef, { x: pos.x + 11900, y: pos.y - 2360 + i * 20 });
    wire(parent, ioPortHighFromB3.out, hiMux.pins[muxDef.ports[0]!]!);
    tieToLabel(`REGA${i}`, hiMux.pins[muxDef.ports[1]!]!, { x: pos.x + 11800, y: pos.y - 2360 + i * 20 });
    tieToLabel(`REGB${i}`, hiMux.pins[muxDef.ports[2]!]!, { x: pos.x + 11800, y: pos.y - 2340 + i * 20 });
    ioPortAddr.push(hiMux.pins[muxDef.ports[3]!]!);
  }
  // `ioPortDataOut` was `AOLD{i}` alone before OUTI/OUTD/OTIR/OTDR
  // existed (see "x=10, z=3: OUTI/OUTD/OTIR/OTDR" above) — a mux layer
  // ahead of that source now picks `outBlockTemp`'s own held byte
  // instead whenever `OUTBLOCK_WRITE_NOW` fires, and a further layer
  // picks the y-selected register (or literal 0 for y=6) whenever
  // `OUTRC_NOW` fires (see "x=01, z=1: OUT (C),r").
  const outRcDataSpecs: { label: string; regLabel: string }[] = [
    { label: 'OUTRC_BUS_B_NOW', regLabel: 'REGB' },
    { label: 'OUTRC_BUS_C_NOW', regLabel: 'REGC' },
    { label: 'OUTRC_BUS_D_NOW', regLabel: 'REGD' },
    { label: 'OUTRC_BUS_E_NOW', regLabel: 'REGE' },
    { label: 'OUTRC_BUS_H_NOW', regLabel: 'REGH' },
    { label: 'OUTRC_BUS_L_NOW', regLabel: 'REGL' },
    { label: 'OUTRC_BUS_A_NOW', regLabel: 'REGA' },
  ];
  outRcDataSpecs.forEach(({ label, regLabel }, bi) => {
    for (let i = 0; i < 8; i++) {
      const buf = makeChipInstance(parent, bufDef, { x: pos.x + 12050, y: pos.y - 2400 + bi * 200 + i * 20 });
      tieToLabel(`${regLabel}${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 11950, y: pos.y - 2400 + bi * 200 + i * 20 });
      tieToLabel(label, buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11950, y: pos.y - 2380 + bi * 200 + i * 20 });
      tieToLabel(`OUTRCDATA${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 12150, y: pos.y - 2400 + bi * 200 + i * 20 });
    }
  });
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 12050, y: pos.y - 1000 + i * 20 });
    tiePowerRail(parent, 'GND', buf.pins[bufDef.ports[0]!]!);
    tieToLabel('OUTRC_ZERO_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 11950, y: pos.y - 980 + i * 20 });
    tieToLabel(`OUTRCDATA${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 12150, y: pos.y - 1000 + i * 20 });
  }
  const ioPortDataOut: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const label = makeLabel(parent, `AOLD${i}`, { x: pos.x + 11850, y: pos.y - 2000 + i * 20 });
    const mux = makeChipInstance(parent, muxDef, { x: pos.x + 11900, y: pos.y - 2000 + i * 20 });
    tieToLabel('OUTBLOCK_WRITE_NOW', mux.pins[muxDef.ports[0]!]!, { x: pos.x + 11800, y: pos.y - 2020 + i * 20 });
    wire(parent, label.pins.net, mux.pins[muxDef.ports[1]!]!); // in0: OUT (n),A's own A
    wire(parent, outBlockTemp.q[i]!, mux.pins[muxDef.ports[2]!]!); // in1: OUTI's own held byte from (HL)
    const outRcMux = makeChipInstance(parent, muxDef, { x: pos.x + 11950, y: pos.y - 2000 + i * 20 });
    tieToLabel('OUTRC_NOW', outRcMux.pins[muxDef.ports[0]!]!, { x: pos.x + 11850, y: pos.y - 2020 + i * 20 });
    wire(parent, mux.pins[muxDef.ports[3]!]!, outRcMux.pins[muxDef.ports[1]!]!);
    tieToLabel(`OUTRCDATA${i}`, outRcMux.pins[muxDef.ports[2]!]!, { x: pos.x + 11850, y: pos.y - 1980 + i * 20 });
    ioPortDataOut.push(outRcMux.pins[muxDef.ports[3]!]!);
  }
  // `ioPortDataIn` itself is declared much earlier (right before `A`'s own
  // per-bit write loop, far above) since that loop pushes this opcode's
  // own mux `in1` port pin into it directly — a raw external-sink pin, the
  // identical contract `Register.d`/`Register.we` already use (a caller's
  // own device wires *into* this, this file never drives it itself), not
  // something created here and driven internally.

  const isExSpHl = buildAnd(parent, { x: pos.x + 11500, y: pos.y - 1700 });
  wire(parent, isX11Z3.out, isExSpHl.a);
  tieToLabel('DECY4', isExSpHl.b, { x: pos.x + 11400, y: pos.y - 1700 });

  const exSpHlReadLowNow = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1690 });
  wire(parent, isExSpHl.out, exSpHlReadLowNow.a);
  tieToLabel('PHASE2', exSpHlReadLowNow.b, { x: pos.x + 11450, y: pos.y - 1690 });
  tieToLabel('EXSPHL_READ_LOW_NOW', exSpHlReadLowNow.out, { x: pos.x + 11600, y: pos.y - 1690 });

  // Every later phase in this same instruction explicitly excludes the one
  // right before it — the identical adjacent-ring-position bus-fight fix
  // `LD (nn),HL`'s own live bug first taught this file (see "x=00, z=2"
  // above), applied pre-emptively here across all three adjacent
  // boundaries this 4-phase sequence has, rather than found live a fourth
  // (and fifth, and sixth) time.
  const exSpHlReadHighRaw = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1650 });
  wire(parent, isExSpHl.out, exSpHlReadHighRaw.a);
  tieToLabel('PHASE3', exSpHlReadHighRaw.b, { x: pos.x + 11450, y: pos.y - 1650 });
  const notExSpHlReadLowNow = buildNot(parent, { x: pos.x + 11600, y: pos.y - 1670 });
  wire(parent, exSpHlReadLowNow.out, notExSpHlReadLowNow.in);
  const exSpHlReadHighNow = buildAnd(parent, { x: pos.x + 11650, y: pos.y - 1660 });
  wire(parent, exSpHlReadHighRaw.out, exSpHlReadHighNow.a);
  wire(parent, notExSpHlReadLowNow.out, exSpHlReadHighNow.b);
  tieToLabel('EXSPHL_READ_HIGH_NOW', exSpHlReadHighNow.out, { x: pos.x + 11700, y: pos.y - 1660 });

  const exSpHlWriteLowRaw = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1600 });
  wire(parent, isExSpHl.out, exSpHlWriteLowRaw.a);
  tieToLabel('PHASE4', exSpHlWriteLowRaw.b, { x: pos.x + 11450, y: pos.y - 1600 });
  const notExSpHlReadHighNow = buildNot(parent, { x: pos.x + 11600, y: pos.y - 1630 });
  wire(parent, exSpHlReadHighNow.out, notExSpHlReadHighNow.in);
  const exSpHlWriteLowNow = buildAnd(parent, { x: pos.x + 11650, y: pos.y - 1610 });
  wire(parent, exSpHlWriteLowRaw.out, exSpHlWriteLowNow.a);
  wire(parent, notExSpHlReadHighNow.out, exSpHlWriteLowNow.b);
  tieToLabel('EXSPHL_WRITE_LOW_NOW', exSpHlWriteLowNow.out, { x: pos.x + 11700, y: pos.y - 1610 });

  const exSpHlWriteHighRaw = buildAnd(parent, { x: pos.x + 11550, y: pos.y - 1550 });
  wire(parent, isExSpHl.out, exSpHlWriteHighRaw.a);
  tieToLabel('PHASE5', exSpHlWriteHighRaw.b, { x: pos.x + 11450, y: pos.y - 1550 });
  const notExSpHlWriteLowNow = buildNot(parent, { x: pos.x + 11600, y: pos.y - 1580 });
  wire(parent, exSpHlWriteLowNow.out, notExSpHlWriteLowNow.in);
  const exSpHlWriteHighNow = buildAnd(parent, { x: pos.x + 11650, y: pos.y - 1560 });
  wire(parent, exSpHlWriteHighRaw.out, exSpHlWriteHighNow.a);
  wire(parent, notExSpHlWriteLowNow.out, exSpHlWriteHighNow.b);
  tieToLabel('EXSPHL_WRITE_HIGH_NOW', exSpHlWriteHighNow.out, { x: pos.x + 11700, y: pos.y - 1560 });

  const exSpHlLowAddrNow = buildOr(parent, { x: pos.x + 11750, y: pos.y - 1670 });
  wire(parent, exSpHlReadLowNow.out, exSpHlLowAddrNow.a);
  wire(parent, exSpHlWriteLowNow.out, exSpHlLowAddrNow.b);
  // Widen with DD/FD EX (SP),IX/IY low phases (side-fold, then merge).
  const exSpIxLowAddr = buildOr(parent, { x: pos.x + 11780, y: pos.y - 1690 });
  tieToLabel('EXSPIX_READ_LOW_NOW', exSpIxLowAddr.a, { x: pos.x + 11680, y: pos.y - 1690 });
  tieToLabel('EXSPIX_WRITE_LOW_NOW', exSpIxLowAddr.b, { x: pos.x + 11680, y: pos.y - 1670 });
  const exSpIyLowAddr = buildOr(parent, { x: pos.x + 11780, y: pos.y - 1650 });
  tieToLabel('EXSPIY_READ_LOW_NOW', exSpIyLowAddr.a, { x: pos.x + 11680, y: pos.y - 1650 });
  tieToLabel('EXSPIY_WRITE_LOW_NOW', exSpIyLowAddr.b, { x: pos.x + 11680, y: pos.y - 1630 });
  const exSpIxIyLowAddr = buildOr(parent, { x: pos.x + 11800, y: pos.y - 1670 });
  wire(parent, exSpIxLowAddr.out, exSpIxIyLowAddr.a);
  wire(parent, exSpIyLowAddr.out, exSpIxIyLowAddr.b);
  const exSpLowAddrFinal = buildOr(parent, { x: pos.x + 11820, y: pos.y - 1670 });
  wire(parent, exSpHlLowAddrNow.out, exSpLowAddrFinal.a);
  wire(parent, exSpIxIyLowAddr.out, exSpLowAddrFinal.b);
  const exSpHlHighAddrNow = buildOr(parent, { x: pos.x + 11750, y: pos.y - 1580 });
  wire(parent, exSpHlReadHighNow.out, exSpHlHighAddrNow.a);
  wire(parent, exSpHlWriteHighNow.out, exSpHlHighAddrNow.b);
  const exSpIxHighAddr = buildOr(parent, { x: pos.x + 11780, y: pos.y - 1600 });
  tieToLabel('EXSPIX_READ_HIGH_NOW', exSpIxHighAddr.a, { x: pos.x + 11680, y: pos.y - 1600 });
  tieToLabel('EXSPIX_WRITE_HIGH_NOW', exSpIxHighAddr.b, { x: pos.x + 11680, y: pos.y - 1580 });
  const exSpIyHighAddr = buildOr(parent, { x: pos.x + 11780, y: pos.y - 1560 });
  tieToLabel('EXSPIY_READ_HIGH_NOW', exSpIyHighAddr.a, { x: pos.x + 11680, y: pos.y - 1560 });
  tieToLabel('EXSPIY_WRITE_HIGH_NOW', exSpIyHighAddr.b, { x: pos.x + 11680, y: pos.y - 1540 });
  const exSpIxIyHighAddr = buildOr(parent, { x: pos.x + 11800, y: pos.y - 1580 });
  wire(parent, exSpIxHighAddr.out, exSpIxIyHighAddr.a);
  wire(parent, exSpIyHighAddr.out, exSpIxIyHighAddr.b);
  const exSpHighAddrFinal = buildOr(parent, { x: pos.x + 11820, y: pos.y - 1580 });
  wire(parent, exSpHlHighAddrNow.out, exSpHighAddrFinal.a);
  wire(parent, exSpIxIyHighAddr.out, exSpHighAddrFinal.b);
  // Harden: LOW and HIGH cannot both assert (ring-counter transient). If both
  // raws glitch high, both finals drop → address falls to PC briefly instead
  // of double-driving the RAM address bus (the EX(SP),HL race class).
  const notExSpHighRaw = buildNot(parent, { x: pos.x + 11840, y: pos.y - 1600 });
  wire(parent, exSpHighAddrFinal.out, notExSpHighRaw.in);
  const notExSpLowRaw = buildNot(parent, { x: pos.x + 11840, y: pos.y - 1640 });
  wire(parent, exSpLowAddrFinal.out, notExSpLowRaw.in);
  const exSpLowAddrSafe = buildAnd(parent, { x: pos.x + 11860, y: pos.y - 1670 });
  wire(parent, exSpLowAddrFinal.out, exSpLowAddrSafe.a);
  wire(parent, notExSpHighRaw.out, exSpLowAddrSafe.b);
  const exSpHighAddrSafe = buildAnd(parent, { x: pos.x + 11860, y: pos.y - 1580 });
  wire(parent, exSpHighAddrFinal.out, exSpHighAddrSafe.a);
  wire(parent, notExSpLowRaw.out, exSpHighAddrSafe.b);
  tieToLabel('EXSPHL_LOW_ADDR_NOW', exSpLowAddrSafe.out, { x: pos.x + 11890, y: pos.y - 1670 }); // anchor — RAM's own address mux (far) reads this
  tieToLabel('EXSPHL_HIGH_ADDR_NOW', exSpHighAddrSafe.out, { x: pos.x + 11890, y: pos.y - 1580 }); // anchor — RAM's own address mux (far) reads this

  // `exSpHlPlusOne`: a dedicated `buildAlu` (`addrBits` wide, `spAdder`'s
  // own "b=all-0s, cin=vcc" +1 encoding, `nnAddrPlusOne`'s exact shape) —
  // deliberately its own adder, not a tap on `spAdder` itself, since this
  // opcode never commits anything into `SP` at all, only ever *addresses*
  // one past it.
  const exSpHlPlusOne = buildAlu(parent, library, addrBits, { x: pos.x + 11750, y: pos.y - 1900 });
  tiePowerRail(parent, 'GND', exSpHlPlusOne.op0);
  tiePowerRail(parent, 'GND', exSpHlPlusOne.op1);
  tiePowerRail(parent, 'VCC', exSpHlPlusOne.cin);
  sp.q.forEach((q, i) => {
    wire(parent, q, exSpHlPlusOne.a[i]!);
    tiePowerRail(parent, 'GND', exSpHlPlusOne.b[i]!);
  });
  // Hold SP / SP+1 for the EX opcode window (captured on first read-low) so
  // the address data stays stable even if the live ALU tap settles late.
  const exSpHeldSp = buildRegister(parent, library, addrBits, { x: pos.x + 11950, y: pos.y - 2100 });
  const exSpHeldSp1 = buildRegister(parent, library, addrBits, { x: pos.x + 11950, y: pos.y - 2300 });
  const exSpHeldWe = buildOr(parent, { x: pos.x + 11900, y: pos.y - 2120 });
  wire(parent, exSpHlReadLowNow.out, exSpHeldWe.a);
  const exSpHeldWe2 = buildOr(parent, { x: pos.x + 11920, y: pos.y - 2120 });
  tieToLabel('EXSPIX_READ_LOW_NOW', exSpHeldWe2.a, { x: pos.x + 11820, y: pos.y - 2120 });
  tieToLabel('EXSPIY_READ_LOW_NOW', exSpHeldWe2.b, { x: pos.x + 11820, y: pos.y - 2100 });
  wire(parent, exSpHeldWe2.out, exSpHeldWe.b);
  wire(parent, exSpHeldWe.out, exSpHeldSp.we);
  wire(parent, exSpHeldWe.out, exSpHeldSp1.we);
  sp.q.forEach((q, i) => wire(parent, q, exSpHeldSp.d[i]!));
  exSpHlPlusOne.out.forEach((o, i) => wire(parent, o, exSpHeldSp1.d[i]!));
  tieToLabel('CLK', exSpHeldSp.clk, { x: pos.x + 11950, y: pos.y - 2140 });
  tieToLabel('CLK', exSpHeldSp1.clk, { x: pos.x + 11950, y: pos.y - 2340 });
  exSpHeldSp.q.forEach((q, i) =>
    tieToLabel(`EXSP_HELD_SP${i}`, q, { x: pos.x + 12050, y: pos.y - 2100 + i * 20 }),
  );
  exSpHeldSp1.q.forEach((q, i) =>
    tieToLabel(`EXSP_HELD_SP1_${i}`, q, { x: pos.x + 12050, y: pos.y - 2300 + i * 20 }),
  );
  // Live SP+1 still published for any non-held consumers; RAM addr mux prefers held via EXSP_HELD_*.
  exSpHlPlusOne.out.forEach((o, i) => tieToLabel(`SPPLUS1_${i}`, o, { x: pos.x + 11900, y: pos.y - 1900 + i * 20 })); // anchor — RAM's own address mux (far) reads this

  // Two holding registers — `hlMemTemp`'s own reasoning: each byte read
  // has to survive from its own read phase to the *other* byte's write
  // phase, well after the bus has moved on. Shared with EX (SP),IX/IY
  // (we OR'd across HL/IX/IY read strobes).
  const spLoTemp = buildRegister(parent, library, 8, { x: pos.x + 12000, y: pos.y - 1700 });
  const spLoTempWe1 = buildOr(parent, { x: pos.x + 11950, y: pos.y - 1720 });
  wire(parent, exSpHlReadLowNow.out, spLoTempWe1.a);
  tieToLabel('EXSPIX_READ_LOW_NOW', spLoTempWe1.b, { x: pos.x + 11850, y: pos.y - 1720 });
  const spLoTempWe = buildOr(parent, { x: pos.x + 11970, y: pos.y - 1720 });
  wire(parent, spLoTempWe1.out, spLoTempWe.a);
  tieToLabel('EXSPIY_READ_LOW_NOW', spLoTempWe.b, { x: pos.x + 11870, y: pos.y - 1700 });
  wire(parent, spLoTempWe.out, spLoTemp.we);
  spLoTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x + 11950, y: pos.y - 1700 + i * 20 }));
  spLoTemp.q.forEach((q, i) => tieToLabel(`SPLOTEMP${i}`, q, { x: pos.x + 12050, y: pos.y - 1680 + i * 20 })); // anchor — L's own write-back layer (far) reads this
  tieToLabel('CLK', spLoTemp.clk, { x: pos.x + 12000, y: pos.y - 1720 });

  const spHiTemp = buildRegister(parent, library, 8, { x: pos.x + 12000, y: pos.y - 1400 });
  const spHiTempWe1 = buildOr(parent, { x: pos.x + 11950, y: pos.y - 1420 });
  wire(parent, exSpHlReadHighNow.out, spHiTempWe1.a);
  tieToLabel('EXSPIX_READ_HIGH_NOW', spHiTempWe1.b, { x: pos.x + 11850, y: pos.y - 1420 });
  const spHiTempWe = buildOr(parent, { x: pos.x + 11970, y: pos.y - 1420 });
  wire(parent, spHiTempWe1.out, spHiTempWe.a);
  tieToLabel('EXSPIY_READ_HIGH_NOW', spHiTempWe.b, { x: pos.x + 11870, y: pos.y - 1400 });
  wire(parent, spHiTempWe.out, spHiTemp.we);
  spHiTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x + 11950, y: pos.y - 1400 + i * 20 }));
  spHiTemp.q.forEach((q, i) => tieToLabel(`SPHITEMP${i}`, q, { x: pos.x + 12050, y: pos.y - 1380 + i * 20 })); // anchor — H's own write-back layer (far) reads this
  tieToLabel('CLK', spHiTemp.clk, { x: pos.x + 12000, y: pos.y - 1420 });

  // Found live: `L`/`H`'s own *old* value can't come from `REGL`/`REGH`
  // (=`rL.q`/`rH.q` directly) the way every other bus source in this file
  // reads a register — those are anchored straight to the register's own
  // `q`, and `L`/`H` are *also* committing a brand-new value on this exact
  // same edge (`rLExt8`/`rHExt8`, below). A register reading another
  // register's old value is safe (the reader's own master latch freezes at
  // whatever it saw *before* the edge — see the `sp.q`-during-a-read doc
  // comment, "x=00: INC (HL)/DEC (HL)/LD (HL),n" above) — but a bare
  // tri-state buffer has no master latch of its own to freeze anything; it
  // just reflects whatever `rL.q`/`rH.q` settle to *within this same
  // tick*, which is the fresh value the moment the slave releases it, not
  // the pre-edge one. `oldLTemp`/`oldHTemp` — two more holding registers,
  // capturing `L`/`H` during `PHASE2` (well before either one's own
  // same-instruction write at `PHASE4`/`PHASE5`) — sidestep this the same
  // way every other "value must survive past its own bus's next user" case
  // in this file already does: a real flip-flop's own master-slave
  // discipline, not a live combinational tap. Under DD/FD the same temps
  // capture IX/IY at PHASE4 instead (muxed d-inputs; never drive the bus
  // from live REGIX* while also committing IX).
  const oldLTemp = buildRegister(parent, library, 8, { x: pos.x + 12100, y: pos.y - 1750 });
  const oldTempWe1 = buildOr(parent, { x: pos.x + 12050, y: pos.y - 1770 });
  wire(parent, exSpHlReadLowNow.out, oldTempWe1.a);
  tieToLabel('EXSPIX_READ_LOW_NOW', oldTempWe1.b, { x: pos.x + 11950, y: pos.y - 1770 });
  const oldTempWe = buildOr(parent, { x: pos.x + 12070, y: pos.y - 1770 });
  wire(parent, oldTempWe1.out, oldTempWe.a);
  tieToLabel('EXSPIY_READ_LOW_NOW', oldTempWe.b, { x: pos.x + 11970, y: pos.y - 1750 });
  wire(parent, oldTempWe.out, oldLTemp.we);
  rL.q.forEach((q, i) => {
    const ixMux = makeChipInstance(parent, muxDef, { x: pos.x + 12050, y: pos.y - 1750 + i * 20 });
    tieToLabel('EXSPIX_READ_LOW_NOW', ixMux.pins[muxDef.ports[0]!]!, { x: pos.x + 11950, y: pos.y - 1750 + i * 20 });
    wire(parent, q, ixMux.pins[muxDef.ports[1]!]!); // in0: HL
    wire(parent, rIXL.q[i]!, ixMux.pins[muxDef.ports[2]!]!); // in1: IXL
    const iyMux = makeChipInstance(parent, muxDef, { x: pos.x + 12080, y: pos.y - 1750 + i * 20 });
    tieToLabel('EXSPIY_READ_LOW_NOW', iyMux.pins[muxDef.ports[0]!]!, { x: pos.x + 11980, y: pos.y - 1750 + i * 20 });
    wire(parent, ixMux.pins[muxDef.ports[3]!]!, iyMux.pins[muxDef.ports[1]!]!);
    wire(parent, rIYL.q[i]!, iyMux.pins[muxDef.ports[2]!]!);
    wire(parent, iyMux.pins[muxDef.ports[3]!]!, oldLTemp.d[i]!);
  });
  tieToLabel('CLK', oldLTemp.clk, { x: pos.x + 12100, y: pos.y - 1770 });
  const oldHTemp = buildRegister(parent, library, 8, { x: pos.x + 12100, y: pos.y - 1450 });
  wire(parent, oldTempWe.out, oldHTemp.we);
  rH.q.forEach((q, i) => {
    const ixMux = makeChipInstance(parent, muxDef, { x: pos.x + 12050, y: pos.y - 1450 + i * 20 });
    tieToLabel('EXSPIX_READ_LOW_NOW', ixMux.pins[muxDef.ports[0]!]!, { x: pos.x + 11950, y: pos.y - 1450 + i * 20 });
    wire(parent, q, ixMux.pins[muxDef.ports[1]!]!);
    wire(parent, rIXH.q[i]!, ixMux.pins[muxDef.ports[2]!]!);
    const iyMux = makeChipInstance(parent, muxDef, { x: pos.x + 12080, y: pos.y - 1450 + i * 20 });
    tieToLabel('EXSPIY_READ_LOW_NOW', iyMux.pins[muxDef.ports[0]!]!, { x: pos.x + 11980, y: pos.y - 1450 + i * 20 });
    wire(parent, ixMux.pins[muxDef.ports[3]!]!, iyMux.pins[muxDef.ports[1]!]!);
    wire(parent, rIYH.q[i]!, iyMux.pins[muxDef.ports[2]!]!);
    wire(parent, iyMux.pins[muxDef.ports[3]!]!, oldHTemp.d[i]!);
  });
  tieToLabel('CLK', oldHTemp.clk, { x: pos.x + 12100, y: pos.y - 1470 });

  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 12200, y: pos.y - 1700 + i * 20 });
    wire(parent, oldLTemp.q[i]!, buf.pins[bufDef.ports[0]!]!);
    const writeLowEn = buildOr(parent, { x: pos.x + 12150, y: pos.y - 1680 + i * 20 });
    tieToLabel('EXSPHL_WRITE_LOW_NOW', writeLowEn.a, { x: pos.x + 12050, y: pos.y - 1680 + i * 20 });
    const writeLowEn2 = buildOr(parent, { x: pos.x + 12170, y: pos.y - 1680 + i * 20 });
    tieToLabel('EXSPIX_WRITE_LOW_NOW', writeLowEn2.a, { x: pos.x + 12070, y: pos.y - 1680 + i * 20 });
    tieToLabel('EXSPIY_WRITE_LOW_NOW', writeLowEn2.b, { x: pos.x + 12070, y: pos.y - 1660 + i * 20 });
    wire(parent, writeLowEn2.out, writeLowEn.b);
    wire(parent, writeLowEn.out, buf.pins[bufDef.ports[1]!]!);
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 12300, y: pos.y - 1700 + i * 20 });
  }
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 12200, y: pos.y - 1400 + i * 20 });
    wire(parent, oldHTemp.q[i]!, buf.pins[bufDef.ports[0]!]!);
    const writeHighEn = buildOr(parent, { x: pos.x + 12150, y: pos.y - 1380 + i * 20 });
    tieToLabel('EXSPHL_WRITE_HIGH_NOW', writeHighEn.a, { x: pos.x + 12050, y: pos.y - 1380 + i * 20 });
    const writeHighEn2 = buildOr(parent, { x: pos.x + 12170, y: pos.y - 1380 + i * 20 });
    tieToLabel('EXSPIX_WRITE_HIGH_NOW', writeHighEn2.a, { x: pos.x + 12070, y: pos.y - 1380 + i * 20 });
    tieToLabel('EXSPIY_WRITE_HIGH_NOW', writeHighEn2.b, { x: pos.x + 12070, y: pos.y - 1360 + i * 20 });
    wire(parent, writeHighEn2.out, writeHighEn.b);
    wire(parent, writeHighEn.out, buf.pins[bufDef.ports[1]!]!);
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 12300, y: pos.y - 1400 + i * 20 });
  }

  const rLExt8 = wrapWithPairCommit(rLExt7, 'EXSPHL_WRITE_LOW_NOW', 'SPLOTEMP', { x: pos.x + 13200, y: pos.y + 1000 });
  const rHExt8 = wrapWithPairCommit(rHExt7, 'EXSPHL_WRITE_HIGH_NOW', 'SPHITEMP', { x: pos.x + 13200, y: pos.y + 700 });

  // x=00, z=7: RLCA/RRCA/RLA/RRA/CPL/SCF/CCF — the seven single-byte
  // accumulator/flag opcodes real Z80 puts in this column, all committing
  // at PHASE2 like every other 1-byte x=00 opcode in this file. No RAM
  // access at all for any of the seven — the FSM's own generic single-byte
  // timing (already proven by INC r/DEC r and ADD HL,rr) is all this needs.
  //
  // `DAA` (y=4, the eighth slot in this column) is now real, decoded and
  // wired below (`isDaaNow`) alongside the other seven — see "Closing the
  // half-carry gap: H, the two undocumented bits, and DAA" further down for
  // the full derivation of its correction logic and the `H`/`X`/`Y` bits it
  // reads and writes.
  const isX0Z7 = buildAnd(parent, { x: pos.x + 13000, y: pos.y + 1500 });
  wire(parent, isX0Group, isX0Z7.a);
  wire(parent, dec.z[7]!, isX0Z7.b);
  const rlcaRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1550 });
  wire(parent, isX0Z7.out, rlcaRaw.a);
  wire(parent, dec.y[0]!, rlcaRaw.b);
  const rrcaRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1600 });
  wire(parent, isX0Z7.out, rrcaRaw.a);
  wire(parent, dec.y[1]!, rrcaRaw.b);
  const rlaRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1650 });
  wire(parent, isX0Z7.out, rlaRaw.a);
  wire(parent, dec.y[2]!, rlaRaw.b);
  const rraRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1700 });
  wire(parent, isX0Z7.out, rraRaw.a);
  wire(parent, dec.y[3]!, rraRaw.b);
  const daaRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1725 });
  wire(parent, isX0Z7.out, daaRaw.a);
  wire(parent, dec.y[4]!, daaRaw.b);
  const daaNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1725 });
  wire(parent, daaRaw.out, daaNow.a);
  tieToLabel('PHASE2', daaNow.b, { x: pos.x + 13000, y: pos.y + 1725 });
  tieToLabel('DAA_NOW', daaNow.out, { x: pos.x + 13200, y: pos.y + 1725 }); // anchor — A's own write mux and F's own per-bit layer (both far) read this
  const cplRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1750 });
  wire(parent, isX0Z7.out, cplRaw.a);
  wire(parent, dec.y[5]!, cplRaw.b);
  const scfRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1800 });
  wire(parent, isX0Z7.out, scfRaw.a);
  wire(parent, dec.y[6]!, scfRaw.b);
  const ccfRaw = buildAnd(parent, { x: pos.x + 13050, y: pos.y + 1850 });
  wire(parent, isX0Z7.out, ccfRaw.a);
  wire(parent, dec.y[7]!, ccfRaw.b);

  const rlcaNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1550 });
  wire(parent, rlcaRaw.out, rlcaNow.a);
  tieToLabel('PHASE2', rlcaNow.b, { x: pos.x + 13000, y: pos.y + 1550 });
  const rrcaNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1600 });
  wire(parent, rrcaRaw.out, rrcaNow.a);
  tieToLabel('PHASE2', rrcaNow.b, { x: pos.x + 13000, y: pos.y + 1600 });
  const rlaNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1650 });
  wire(parent, rlaRaw.out, rlaNow.a);
  tieToLabel('PHASE2', rlaNow.b, { x: pos.x + 13000, y: pos.y + 1650 });
  const rraNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1700 });
  wire(parent, rraRaw.out, rraNow.a);
  tieToLabel('PHASE2', rraNow.b, { x: pos.x + 13000, y: pos.y + 1700 });
  const cplNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1750 });
  wire(parent, cplRaw.out, cplNow.a);
  tieToLabel('PHASE2', cplNow.b, { x: pos.x + 13000, y: pos.y + 1750 });
  const scfNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1800 });
  wire(parent, scfRaw.out, scfNow.a);
  tieToLabel('PHASE2', scfNow.b, { x: pos.x + 13000, y: pos.y + 1800 });
  const ccfNow = buildAnd(parent, { x: pos.x + 13100, y: pos.y + 1850 });
  wire(parent, ccfRaw.out, ccfNow.a);
  tieToLabel('PHASE2', ccfNow.b, { x: pos.x + 13000, y: pos.y + 1850 });
  tieToLabel('CPL_NOW', cplNow.out, { x: pos.x + 13200, y: pos.y + 1750 }); // anchor — F's own N-bit layer (far) reads this; A's own write mux reads `ROTACC_A_NOW`/`ROTACCRESULT{i}` instead, CPL already folded into both of those below
  tieToLabel('CCF_NOW', ccfNow.out, { x: pos.x + 13200, y: pos.y + 1850 }); // anchor — ROTACC_H (H←old C)

  // RLCA/RRCA/RLA/RRA/CPL are the only five of these seven that actually
  // touch `A` — SCF/CCF are flags-only, real Z80 never reads or writes `A`
  // for either.
  const rotOrCplStage = buildOr(parent, { x: pos.x + 13150, y: pos.y + 1600 });
  wire(parent, rlcaNow.out, rotOrCplStage.a);
  wire(parent, rrcaNow.out, rotOrCplStage.b);
  const rotOrCplStage2 = buildOr(parent, { x: pos.x + 13150, y: pos.y + 1650 });
  wire(parent, rlaNow.out, rotOrCplStage2.a);
  wire(parent, rraNow.out, rotOrCplStage2.b);
  const rotOrCplStage3 = buildOr(parent, { x: pos.x + 13200, y: pos.y + 1625 });
  wire(parent, rotOrCplStage.out, rotOrCplStage3.a);
  wire(parent, rotOrCplStage2.out, rotOrCplStage3.b);
  const rotOrCplNow = buildOr(parent, { x: pos.x + 13250, y: pos.y + 1700 });
  wire(parent, rotOrCplStage3.out, rotOrCplNow.a);
  wire(parent, cplNow.out, rotOrCplNow.b);
  tieToLabel('ROTACC_A_NOW', rotOrCplNow.out, { x: pos.x + 13300, y: pos.y + 1700 }); // anchor — A's own write mux (far) reads this

  // Every one of RLCA/RRCA/RLA/RRA touches C; CPL doesn't. New C, per op:
  // RLCA/RLA both take the OLD bit 7 of A; RRCA/RRA both take the OLD bit
  // 0. SCF forces C to 1 outright; CCF inverts the OLD C.
  const isRotLeft = buildOr(parent, { x: pos.x + 13100, y: pos.y + 1900 });
  wire(parent, rlcaNow.out, isRotLeft.a);
  wire(parent, rlaNow.out, isRotLeft.b);
  const isRotRight = buildOr(parent, { x: pos.x + 13100, y: pos.y + 1950 });
  wire(parent, rrcaNow.out, isRotRight.a);
  wire(parent, rraNow.out, isRotRight.b);
  const rotLeftC = buildAnd(parent, { x: pos.x + 13150, y: pos.y + 1900 });
  wire(parent, isRotLeft.out, rotLeftC.a);
  wire(parent, a.q[7]!, rotLeftC.b);
  const rotRightC = buildAnd(parent, { x: pos.x + 13150, y: pos.y + 1950 });
  wire(parent, isRotRight.out, rotRightC.a);
  wire(parent, a.q[0]!, rotRightC.b);
  const notOldC = buildNot(parent, { x: pos.x + 13100, y: pos.y + 2000 });
  wire(parent, f.q[0]!, notOldC.in);
  const ccfC = buildAnd(parent, { x: pos.x + 13150, y: pos.y + 2000 });
  wire(parent, ccfNow.out, ccfC.a);
  wire(parent, notOldC.out, ccfC.b);
  const rotAccCStage = buildOr(parent, { x: pos.x + 13200, y: pos.y + 1925 });
  wire(parent, rotLeftC.out, rotAccCStage.a);
  wire(parent, rotRightC.out, rotAccCStage.b);
  const rotAccCStage2 = buildOr(parent, { x: pos.x + 13200, y: pos.y + 1975 });
  wire(parent, scfNow.out, rotAccCStage2.a);
  wire(parent, ccfC.out, rotAccCStage2.b);
  const rotAccC = buildOr(parent, { x: pos.x + 13250, y: pos.y + 1950 });
  wire(parent, rotAccCStage.out, rotAccC.a);
  wire(parent, rotAccCStage2.out, rotAccC.b);
  tieToLabel('ROTACC_C', rotAccC.out, { x: pos.x + 13300, y: pos.y + 1950 }); // anchor — F's own C-bit layer (far) reads this

  // Bit 0 (C) is touched by six of these seven ops (every one but CPL);
  // bit 1 (N) is touched by all seven (0 for six of them, 1 for CPL only —
  // `cplNow` itself, already published above as `CPL_NOW`, is exactly that
  // value, so no separate "N value" label is needed); bits 2/6/7 (P/Z/S)
  // are touched by NONE of them — real Z80 leaves S/Z/P/V alone for every
  // opcode in this column, so no layer is built for those bits at all, the
  // same "hold, don't even wire a mux" treatment ADD HL,rr's own doc
  // comment above establishes for the bits it doesn't touch.
  // Found live: this used to OR in `rotAccCStage` itself (the *value*
  // `AND(isRotLeft, a.q[7]) OR AND(isRotRight, a.q[0])`) rather than a pure
  // "is one of these four active" condition — which silently zeroed this
  // select (and, through `ROTACC_N_NOW`, `F`'s entire `we`) every time the
  // *old* bit this rotate reads from happened to be 0, since `rotAccCStage`
  // is only "on" when BOTH the op is active AND that old bit is 1. `A=0x55`
  // (bit 7 = 0) into `RLCA` reproduced it directly: `F` silently kept
  // whatever `C` it already had instead of committing the fresh 0 —
  // invisible whenever the stale value happened to already look right (a
  // fresh `C=0` right after `XOR A,A` already left `C=0`), and only
  // surfaced once a *different* stale value (`SCF`/`CCF` leaving `C=1`)
  // was sitting there to be wrongly held onto. `isRotAny`, below, is the
  // condition this needed all along — activity alone, no data mixed in.
  const isRotAny = buildOr(parent, { x: pos.x + 13150, y: pos.y + 2050 });
  wire(parent, isRotLeft.out, isRotAny.a);
  wire(parent, isRotRight.out, isRotAny.b);
  const rotAccCNowStage2 = buildOr(parent, { x: pos.x + 13200, y: pos.y + 2075 });
  wire(parent, scfNow.out, rotAccCNowStage2.a);
  wire(parent, ccfNow.out, rotAccCNowStage2.b);
  const rotAccCNowFinal = buildOr(parent, { x: pos.x + 13250, y: pos.y + 2060 });
  wire(parent, isRotAny.out, rotAccCNowFinal.a); // rlca/rrca/rla/rra
  wire(parent, rotAccCNowStage2.out, rotAccCNowFinal.b); // scf/ccf
  tieToLabel('ROTACC_C_NOW', rotAccCNowFinal.out, { x: pos.x + 13300, y: pos.y + 2060 }); // anchor — F's own C-bit layer (far) reads this
  const rotAccNNow = buildOr(parent, { x: pos.x + 13150, y: pos.y + 2125 });
  wire(parent, rotAccCNowFinal.out, rotAccNNow.a); // the same six, N=0 for all of them
  wire(parent, cplNow.out, rotAccNNow.b); // CPL, N=1
  tieToLabel('ROTACC_N_NOW', rotAccNNow.out, { x: pos.x + 13300, y: pos.y + 2125 }); // anchor — F's own N-bit layer (far) reads this

  // ROTACC_H: CPL → 1; CCF → old C; else (rotates/SCF) → 0.
  const rotAccHCcf = buildAnd(parent, { x: pos.x + 13200, y: pos.y + 2145 });
  tieToLabel('CCF_NOW', rotAccHCcf.a, { x: pos.x + 13100, y: pos.y + 2145 });
  wire(parent, f.q[0]!, rotAccHCcf.b);
  const rotAccH = buildOr(parent, { x: pos.x + 13250, y: pos.y + 2145 });
  tieToLabel('CPL_NOW', rotAccH.a, { x: pos.x + 13150, y: pos.y + 2145 });
  wire(parent, rotAccHCcf.out, rotAccH.b);
  tieToLabel('ROTACC_H', rotAccH.out, { x: pos.x + 13300, y: pos.y + 2145 }); // anchor — F bit4 layer

  // ROTACC X/Y: after-transform A for rotates/CPL (ROTACC_A_NOW), else live A
  // for SCF/CCF. Published as muxed values; F layer gates on ROTACC_N_NOW.
  for (const bit of [3, 5] as const) {
    const xyMux = makeChipInstance(parent, muxDef, { x: pos.x + 13250, y: pos.y + 2160 + (bit === 3 ? 0 : 40) });
    tieToLabel('ROTACC_A_NOW', xyMux.pins[muxDef.ports[0]!]!, { x: pos.x + 13150, y: pos.y + 2160 + (bit === 3 ? 0 : 40) });
    wire(parent, a.q[bit]!, xyMux.pins[muxDef.ports[1]!]!); // in0: A unchanged (SCF/CCF)
    tieToLabel(`ROTACCRESULT${bit}`, xyMux.pins[muxDef.ports[2]!]!, { x: pos.x + 13150, y: pos.y + 2180 + (bit === 3 ? 0 : 40) }); // in1: after rotate/CPL
    tieToLabel(bit === 3 ? 'ROTACC_X' : 'ROTACC_Y', xyMux.pins[muxDef.ports[3]!]!, {
      x: pos.x + 13300,
      y: pos.y + 2160 + (bit === 3 ? 0 : 40),
    });
  }

  // Closing the half-carry gap: H, the two undocumented bits, and DAA.
  //
  // `H`/`X`/`Y` are now real for the x=10/x=11 ALU group (`hBit`/`xBit`/
  // `yBit`, built next to `cBit` above) and for INC r/DEC r (`R8_H`/`R8_X`/
  // `R8_Y`, built next to `R8_N`/`R8_P`/`R8_Z`/`R8_S` above) — and for
  // plain `ADD HL,rr` / ADD IX/IY plus the RLCA/RRCA/RLA/RRA/CPL/SCF/CCF
  // group (fresh H/X/Y; S/Z/P/V still hold). `DAA` still reads a real `H`.
  //
  // `DAA` reads `H`/`C`/`N` and `A`'s own nibbles to correct `A` back into
  // valid packed BCD after an 8-bit add or subtract. The logic below
  // mirrors the well-known, zexall-verified formulation (the same one
  // MAME's own `z80.cpp` uses), built here at gate level instead of typed
  // as an `if`:
  //
  //   loCorrect = OR(H, A&0xF > 9)     — low-nibble needs +0x06/-0x06
  //   hiCorrect = OR(C, A > 0x99)      — high-nibble needs +0x60/-0x60
  //   diff      = (loCorrect ? 0x06:0) | (hiCorrect ? 0x60:0)
  //   newA      = N ? A-diff : A+diff  — same direction the last op ran
  //   newC      = hiCorrect            — matches real silicon for BOTH
  //               directions: for N=0 it's "C or overflowed 0x99"; for N=1,
  //               `A > 0x99` is already false for any A a genuine subtract
  //               could have produced, so `hiCorrect` collapses to exactly
  //               "hold C" — one formula, no extra N-gating needed.
  //   newH      = XOR(A_before[4], A_after[4]) — did bit 4 flip during the
  //               correction? The same "real hardware defines H is defined
  //               by *a* bit-4 boundary crossing" idea `hBit` above already
  //               uses, just read off the correction's own effect instead
  //               of an adder's internal carry.
  //   newS/Z/P/X/Y — fresh off the corrected `newA`, the same derivation
  //               every other flag-writing group in this file already uses.
  //   N is unchanged (DAA never flips it — real Z80 behavior).
  //
  // `A&0xF > 9` (4-bit "nibble >= 10"): `AND(bit3, OR(bit2, bit1))` — every
  // value with bit3 set AND at least one of bit2/bit1 set is >= 0b1010.
  const nibbleGt9 = buildOr(parent, { x: pos.x + 13350, y: pos.y + 2200 });
  wire(parent, a.q[2]!, nibbleGt9.a);
  wire(parent, a.q[1]!, nibbleGt9.b);
  const nibbleGt9Bit = buildAnd(parent, { x: pos.x + 13400, y: pos.y + 2200 });
  wire(parent, a.q[3]!, nibbleGt9Bit.a);
  wire(parent, nibbleGt9.out, nibbleGt9Bit.b);
  // `A > 0x99` (a full 8-bit comparison, real hardware doesn't get to
  // assume `A` is valid BCD): computed the same way `C`/`H` read a carry
  // out of a subtraction elsewhere in this file — `A - 0x9A` via
  // add-the-inverse-plus-one (`~0x9A = 0x65`, `cin=1`), examining only the
  // final `cout` ("no borrow" = `A >= 0x9A` = `A > 0x99`). A scratch
  // `buildAlu` instance whose 8 sum outputs are never read — only its
  // `cout` — the same "harmless, this file always computes and only gates
  // the commit" discipline `r8Adder` established.
  const notNinetyNine = 0x65; // ~0x9A & 0xFF
  const gt99Cmp = buildAlu(parent, library, 8, { x: pos.x + 13450, y: pos.y + 2300 });
  tiePowerRail(parent, 'GND', gt99Cmp.op0);
  tiePowerRail(parent, 'GND', gt99Cmp.op1);
  tiePowerRail(parent, 'VCC', gt99Cmp.cin);
  for (let i = 0; i < 8; i++) {
    wire(parent, a.q[i]!, gt99Cmp.a[i]!);
    tiePowerRail(parent, (notNinetyNine >> i) & 1 ? 'VCC' : 'GND', gt99Cmp.b[i]!);
  }
  const aGt99 = gt99Cmp.cout;
  const loCorrect = buildOr(parent, { x: pos.x + 13500, y: pos.y + 2350 });
  wire(parent, f.q[4]!, loCorrect.a); // old H
  wire(parent, nibbleGt9Bit.out, loCorrect.b);
  const hiCorrect = buildOr(parent, { x: pos.x + 13500, y: pos.y + 2400 });
  wire(parent, f.q[0]!, hiCorrect.a); // old C
  wire(parent, aGt99, hiCorrect.b);
  tieToLabel('DAA_NEWC', hiCorrect.out, { x: pos.x + 13550, y: pos.y + 2400 }); // anchor — F's own C-bit layer (far) reads this

  // `daaAdder`: one more scratch `buildAlu`, ADD mode always — subtraction
  // is "add the inverted operand plus 1," the identical `bInv`/`cin`-from-
  // `isSubtractLike` shape the main ALU group's own adder above uses, just
  // with old `N` (`f.q[1]`) standing in for `isSubtractLike` (DAA reverses
  // whichever direction the *previous* op actually ran).
  const daaAdder = buildAlu(parent, library, 8, { x: pos.x + 13450, y: pos.y + 2500 });
  tiePowerRail(parent, 'GND', daaAdder.op0);
  tiePowerRail(parent, 'GND', daaAdder.op1);
  wire(parent, f.q[1]!, daaAdder.cin); // old N
  const daaDiffBit: Record<number, Pin> = { 1: loCorrect.out, 2: loCorrect.out, 5: hiCorrect.out, 6: hiCorrect.out };
  for (let i = 0; i < 8; i++) {
    wire(parent, a.q[i]!, daaAdder.a[i]!);
    const diffBit = daaDiffBit[i] ?? railPin(parent, 'GND', { x: pos.x + 13500, y: pos.y + 2550 + i * 40 });
    const diffInv = buildXor(parent, { x: pos.x + 13500, y: pos.y + 2550 + i * 40 });
    wire(parent, diffBit, diffInv.a);
    wire(parent, f.q[1]!, diffInv.b); // old N — same operand-invert `bInv` uses for SUB/SBC/CP
    wire(parent, diffInv.out, daaAdder.b[i]!);
  }
  const daaNewH = buildXor(parent, { x: pos.x + 13600, y: pos.y + 2900 });
  wire(parent, a.q[4]!, daaNewH.a);
  wire(parent, daaAdder.out[4]!, daaNewH.b);
  tieToLabel('DAA_NEWH', daaNewH.out, { x: pos.x + 13650, y: pos.y + 2900 }); // anchor — F's own H-bit layer (far) reads this
  let daaZChain: Pin = daaAdder.out[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 13600, y: pos.y + 2950 + i * 40 });
    wire(parent, daaZChain, orGate.a);
    wire(parent, daaAdder.out[i]!, orGate.b);
    daaZChain = orGate.out;
  }
  const daaZBit = buildNot(parent, { x: pos.x + 13650, y: pos.y + 3300 });
  wire(parent, daaZChain, daaZBit.in);
  let daaPChain: Pin = daaAdder.out[0]!;
  for (let i = 1; i < 8; i++) {
    const xorGate = buildXor(parent, { x: pos.x + 13650, y: pos.y + 3350 + i * 40 });
    wire(parent, daaPChain, xorGate.a);
    wire(parent, daaAdder.out[i]!, xorGate.b);
    daaPChain = xorGate.out;
  }
  const daaPBit = buildNot(parent, { x: pos.x + 13700, y: pos.y + 3650 });
  wire(parent, daaPChain, daaPBit.in);
  tieToLabel('DAA_NEWZ', daaZBit.out, { x: pos.x + 13700, y: pos.y + 3300 }); // anchor — F's own Z-bit layer (far) reads this
  tieToLabel('DAA_NEWP', daaPBit.out, { x: pos.x + 13750, y: pos.y + 3650 }); // anchor — F's own P-bit layer (far) reads this
  tieToLabel('DAA_NEWS', daaAdder.out[7]!, { x: pos.x + 13700, y: pos.y + 3700 }); // anchor — F's own S-bit layer (far) reads this
  tieToLabel('DAA_NEWX', daaAdder.out[3]!, { x: pos.x + 13700, y: pos.y + 3720 }); // anchor — F's own X-bit layer (far) reads this
  tieToLabel('DAA_NEWY', daaAdder.out[5]!, { x: pos.x + 13700, y: pos.y + 3740 }); // anchor — F's own Y-bit layer (far) reads this
  for (let i = 0; i < 8; i++) {
    tieToLabel(`DAARESULT${i}`, daaAdder.out[i]!, { x: pos.x + 13750, y: pos.y + 3760 + i * 20 }); // anchor — A's own write mux (far) reads this
  }

  // RLCA/RRCA/RLA/RRA/CPL's own fresh per-bit result — the shift/wrap
  // arithmetic for the four rotates, plain bitwise NOT for CPL. `A`'s own
  // write mux (far) picks whichever of these actually fires; SCF/CCF never
  // touch any of these (`ROTACC_A_NOW` stays 0 for both), so this loop
  // computing eight bits' worth of rotate/complement logic even while
  // SCF/CCF are executing is harmless — the "always compute, gate only the
  // commit" discipline this file has followed since `r8Adder`, not a
  // ninth exception to it.
  for (let i = 0; i < 8; i++) {
    const prevIdx = (i + 7) % 8;
    const nextIdx = (i + 1) % 8;
    const rlcaTerm = buildAnd(parent, { x: pos.x + 13350, y: pos.y + 1500 + i * 120 });
    wire(parent, rlcaNow.out, rlcaTerm.a);
    wire(parent, a.q[prevIdx]!, rlcaTerm.b);
    const rlaTerm = buildAnd(parent, { x: pos.x + 13400, y: pos.y + 1500 + i * 120 });
    wire(parent, rlaNow.out, rlaTerm.a);
    wire(parent, i === 0 ? f.q[0]! : a.q[prevIdx]!, rlaTerm.b); // bit 0 comes from the OLD carry, not a wrapped A bit
    const rrcaTerm = buildAnd(parent, { x: pos.x + 13450, y: pos.y + 1500 + i * 120 });
    wire(parent, rrcaNow.out, rrcaTerm.a);
    wire(parent, a.q[nextIdx]!, rrcaTerm.b);
    const rraTerm = buildAnd(parent, { x: pos.x + 13500, y: pos.y + 1500 + i * 120 });
    wire(parent, rraNow.out, rraTerm.a);
    wire(parent, i === 7 ? f.q[0]! : a.q[nextIdx]!, rraTerm.b); // bit 7 comes from the OLD carry, not a wrapped A bit
    const notOldABit = buildNot(parent, { x: pos.x + 13550, y: pos.y + 1500 + i * 120 });
    wire(parent, a.q[i]!, notOldABit.in);
    const cplTerm = buildAnd(parent, { x: pos.x + 13600, y: pos.y + 1500 + i * 120 });
    wire(parent, cplNow.out, cplTerm.a);
    wire(parent, notOldABit.out, cplTerm.b);
    const stage1 = buildOr(parent, { x: pos.x + 13650, y: pos.y + 1490 + i * 120 });
    wire(parent, rlcaTerm.out, stage1.a);
    wire(parent, rlaTerm.out, stage1.b);
    const stage2 = buildOr(parent, { x: pos.x + 13650, y: pos.y + 1510 + i * 120 });
    wire(parent, rrcaTerm.out, stage2.a);
    wire(parent, rraTerm.out, stage2.b);
    const stage3 = buildOr(parent, { x: pos.x + 13700, y: pos.y + 1500 + i * 120 });
    wire(parent, stage1.out, stage3.a);
    wire(parent, stage2.out, stage3.b);
    const final = buildOr(parent, { x: pos.x + 13750, y: pos.y + 1495 + i * 120 });
    wire(parent, stage3.out, final.a);
    wire(parent, cplTerm.out, final.b);
    tieToLabel(`ROTACCRESULT${i}`, final.out, { x: pos.x + 13800, y: pos.y + 1495 + i * 120 }); // anchor — A's own write mux (far) reads this
  }

  // F: every bit (0/C through 7/S, H and the two undocumented bits
  // included now — see "Closing the half-carry gap" above) comes from a
  // base hold-or-ALU-group layer (`baseMux`, below — `f.q[i]` unless
  // `aluGroupNow` is genuinely 1), then `x=00`'s own INC/DEC r computation
  // (a second layer ahead of that), then whichever further per-bit
  // overrides a given later feature needs (ADD HL,rr's own C; this file's
  // own RLCA/RRCA/RLA/RRA/CPL/SCF/CCF's C and N; DAA's own near-total
  // rewrite of everything but N — see "x=00, z=7" above for all three), or,
  // for AF's low byte, POP's own bus capture as the outermost layer of
  // all. `ADD HL,rr` and the six-op rotate/flag group still leave H/X/Y
  // exactly where the base layer put them — no new layer for those bits in
  // either group, the identical "stale, not fresh" treatment this file
  // already documents for that group's own S/Z/P.
  //
  // The INC/DEC r layer is deliberately NOT uniform across all eight bits:
  // real Z80 preserves C untouched for this instruction family (see the
  // doc comment above, "x=00, z=4/z=5"), so bit 0's own "x=00-computed"
  // value is F's *own* q[0] fed back (a hold, not a fresh computation) —
  // every other bit gets its own R8_* label (`R8_N`/`R8_P`/`R8_Z`/`R8_S`/
  // `R8_H`/`R8_X`/`R8_Y`), the fresh values `incDecR8Now`'s own doc comment
  // above derives.
  const isBusToF = buildAnd(parent, { x: pos.x + 8200, y: pos.y + 2150 });
  wire(parent, popLowNow.out, isBusToF.a);
  wire(parent, dec.y[6]!, isBusToF.b); // AF pair
  // The LD-block/CP-block family's own shared `P/V` (see "x=10, z=0:
  // LDI/LDD/LDIR/LDDR" and "x=10, z=1: CPI/CPD/CPIR/CPDR" above): 1
  // exactly when `BC-1 != 0`, i.e. exactly when *any* of its 16 bits is 1
  // — a 16-way OR tree over `BCADD`'s own already-published bits (the
  // same adder `BC`'s own write-back layer above reads, computing `BC-1`
  // right now since both families widened its direction line), built as
  // 4 levels of 2-input `OR` rather than one enormous fan-in gate this
  // library has no primitive for. Named `blockPvBit`/`BLOCK_PV_NOW`, not
  // `ldBlockPvBit`/`LDBLOCK_PV_NOW` — it stopped meaning only the LD-block
  // family the moment CP-block's own repeat condition (see the dedicated
  // adder just below) needed the identical bit for the identical reason.
  const bcaddBits: Pin[] = [];
  for (let i = 0; i < 8; i++) bcaddBits.push(makeLabel(parent, `BCADDLO${i}`, { x: pos.x + 8100, y: pos.y + 1700 + i * 20 }).pins.net);
  for (let i = 0; i < 8; i++) bcaddBits.push(makeLabel(parent, `BCADDHI${i}`, { x: pos.x + 8100, y: pos.y + 1860 + i * 20 }).pins.net);
  let orLevel = bcaddBits;
  let orDepth = 0;
  while (orLevel.length > 1) {
    const next: Pin[] = [];
    for (let i = 0; i + 1 < orLevel.length; i += 2) {
      const g = buildOr(parent, { x: pos.x + 8150 + orDepth * 50, y: pos.y + 1700 + i * 10 });
      wire(parent, orLevel[i]!, g.a);
      wire(parent, orLevel[i + 1]!, g.b);
      next.push(g.out);
    }
    orLevel = next;
    orDepth++;
  }
  const blockPvBit = orLevel[0]!;
  tieToLabel('BLOCK_PV_NOW', blockPvBit, { x: pos.x + 8100, y: pos.y + 1690 }); // anchor — the pc mux chain's own two repeat gates (far) read this

  // CPI/CPD/CPIR/CPDR's own holding register and dedicated subtractor
  // (see "x=10, z=1: CPI/CPD/CPIR/CPDR" above). The holding register is
  // the identical "a value must outlive its own bus's next user" shape
  // `ldBlockTemp` below relies on, just consumed one phase sooner (this
  // family's own commit phase, not a write phase two phases later) since
  // there's no RAM write to wait out. The subtractor is deliberately its
  // own, entirely separate `buildAlu` instance — the same "isolated
  // adder, no shared-decode collision to fight" shape `pcMinus2Adder`
  // above and `daaAdder`/`gt99Cmp` elsewhere in this file already use for
  // their own single-purpose arithmetic — rather than routed through the
  // shared `x=10` ALU: real `x=10,y=4..7,z=1` collides with `AND C`/
  // `XOR C`/`OR C`/`CP C`, a *different* wrong op-select for each of the
  // four variants, and that shared ALU's own op-select, subtract-detect,
  // `A`-write-enable, and `AND`-forces-`H`-1 quirk all read straight off
  // the very `y` bits this family recaptures — masking all four
  // collisions through that machinery would cost more gates, and more
  // risk, than giving this family a permanently-wired subtractor of its
  // own. `A` is never written (this family only ever reads it), so
  // there's no need to touch the shared ALU's own `aWe` at all — this
  // adder's result is consumed only for flags, below.
  const cpBlockTemp = buildRegister(parent, library, 8, { x: pos.x - 1400, y: pos.y - 6300 });
  tieToLabel('CPBLOCK_READ_NOW', cpBlockTemp.we, { x: pos.x - 1500, y: pos.y - 6300 });
  cpBlockTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x - 1450, y: pos.y - 6300 + i * 20 }));
  tieToLabel('CLK', cpBlockTemp.clk, { x: pos.x - 1400, y: pos.y - 6320 });
  const cpBlockAdder = buildAlu(parent, library, 8, { x: pos.x - 1300, y: pos.y - 6250 });
  tiePowerRail(parent, 'GND', cpBlockAdder.op0);
  tiePowerRail(parent, 'GND', cpBlockAdder.op1);
  tiePowerRail(parent, 'VCC', cpBlockAdder.cin);
  for (let i = 0; i < 8; i++) {
    wire(parent, a.q[i]!, cpBlockAdder.a[i]!);
    const cpBInv = buildNot(parent, { x: pos.x - 1350, y: pos.y - 6250 + i * 20 });
    wire(parent, cpBlockTemp.q[i]!, cpBInv.in);
    wire(parent, cpBInv.out, cpBlockAdder.b[i]!);
  }
  const cpSBit = cpBlockAdder.out[7]!;
  let cpZChain: Pin = cpBlockAdder.out[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x - 1250, y: pos.y - 6100 + i * 20 });
    wire(parent, cpZChain, orGate.a);
    wire(parent, cpBlockAdder.out[i]!, orGate.b);
    cpZChain = orGate.out;
  }
  tieToLabel('CPBLOCK_NOT_FOUND_NOW', cpZChain, { x: pos.x - 1200, y: pos.y - 6080 }); // anchor — the pc mux chain's own CP-block repeat gate (far, built earlier in this file) reads this
  const cpZBit = buildNot(parent, { x: pos.x - 1200, y: pos.y - 6060 });
  wire(parent, cpZChain, cpZBit.in);
  // Half-borrow: the identical `XOR(carry into bit 4, isSubtractLike)`
  // idiom the shared ALU's own `hRaw` uses, collapsed to a plain `NOT` —
  // `isSubtractLike` is always `1` here, this adder never computes
  // anything else.
  const cpHBit = buildNot(parent, { x: pos.x - 1200, y: pos.y - 6040 });
  wire(parent, cpBlockAdder.carries[3]!, cpHBit.in);
  const computedFlagBit: Record<number, Pin> = { 0: cBit.out, 1: nBit, 2: pvBit, 3: xBit, 4: hBit.out, 5: yBit, 6: zBit.out, 7: sBit };
  const r8FlagLabel: Record<number, string> = { 1: 'R8_N', 2: 'R8_P', 3: 'R8_X', 4: 'R8_H', 5: 'R8_Y', 6: 'R8_Z', 7: 'R8_S' };

  // IN r,(C) flags (see "x=01, z=0") — computed off the live
  // `ioPortDataIn` byte, the identical S/Z/P(parity)/H=0/N=0/X/Y shape
  // RRD/RLD uses off the new A. Built here (after `ioPortDataIn` is
  // filled by A's own write-mux loop) rather than next to the decode,
  // because those external-sink pins don't exist yet that early.
  const inRcSBit = ioPortDataIn[7]!;
  let inRcZChain: Pin = ioPortDataIn[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x - 1100, y: pos.y - 5450 + i * 20 });
    wire(parent, inRcZChain, orGate.a);
    wire(parent, ioPortDataIn[i]!, orGate.b);
    inRcZChain = orGate.out;
  }
  const inRcZBit = buildNot(parent, { x: pos.x - 1050, y: pos.y - 5450 });
  wire(parent, inRcZChain, inRcZBit.in);
  let inRcPChain: Pin = ioPortDataIn[0]!;
  for (let i = 1; i < 8; i++) {
    const xorGate = buildXor(parent, { x: pos.x - 1100, y: pos.y - 5600 + i * 20 });
    wire(parent, inRcPChain, xorGate.a);
    wire(parent, ioPortDataIn[i]!, xorGate.b);
    inRcPChain = xorGate.out;
  }
  const inRcPBit = buildNot(parent, { x: pos.x - 1050, y: pos.y - 5600 });
  wire(parent, inRcPChain, inRcPBit.in);

  // LD A,I / LD A,R flags (see "x=01, z=7, y=0..3") — off the source
  // register (mux I vs R by LDAR_NOW). P/V copies IFF2 (soft parity).
  const ldAIrByte: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const mux = makeChipInstance(parent, muxDef, { x: pos.x - 1200, y: pos.y - 5720 + i * 20 });
    tieToLabel('LDAR_NOW', mux.pins[muxDef.ports[0]!]!, { x: pos.x - 1300, y: pos.y - 5720 + i * 20 });
    wire(parent, regI.q[i]!, mux.pins[muxDef.ports[1]!]!);
    wire(parent, regR.q[i]!, mux.pins[muxDef.ports[2]!]!);
    ldAIrByte.push(mux.pins[muxDef.ports[3]!]!);
  }
  const ldAIrSBit = ldAIrByte[7]!;
  let ldAIrZChain: Pin = ldAIrByte[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x - 1100, y: pos.y - 5720 + i * 20 });
    wire(parent, ldAIrZChain, orGate.a);
    wire(parent, ldAIrByte[i]!, orGate.b);
    ldAIrZChain = orGate.out;
  }
  const ldAIrZBit = buildNot(parent, { x: pos.x - 1050, y: pos.y - 5720 });
  wire(parent, ldAIrZChain, ldAIrZBit.in);

  // ADD HL/IX/IY sel — shared by F_FLAG_BIT (bits that skip idle this sel).
  const addHlFSel1 = buildOr(parent, { x: pos.x + 8280, y: pos.y + 2000 });
  tieToLabel('ADDHL_NOW', addHlFSel1.a, { x: pos.x + 8180, y: pos.y + 2000 });
  tieToLabel('ADDIX_NOW', addHlFSel1.b, { x: pos.x + 8180, y: pos.y + 2020 });
  const addHlFSel = buildOr(parent, { x: pos.x + 8300, y: pos.y + 2000 });
  wire(parent, addHlFSel1.out, addHlFSel.a);
  tieToLabel('ADDIY_NOW', addHlFSel.b, { x: pos.x + 8200, y: pos.y + 2020 });

  const fFlagBitDef = getFFlagBitChip(library);
  for (let i = 0; i < 8; i++) {
    const bit = makeChipInstance(parent, fFlagBitDef, { x: pos.x + 8280, y: pos.y + 2050 + i * 100 });
    const p = (name: string) => bit.pins[name]!;
    const y = pos.y + 2050 + i * 100;
    const idle = (pin: Pin) => tiePowerRail(parent, 'GND', pin);

    wire(parent, aluAnyGroupNow.out, p('selAlu'));
    wire(parent, f.q[i]!, p('holdQ'));
    wire(parent, computedFlagBit[i]!, p('aluFresh'));

    tieToLabel('INCDEC_R8_NOW', p('selR8'), { x: pos.x + 8200, y });
    if (i === 0) wire(parent, f.q[0]!, p('r8Fresh'));
    else tieToLabel(r8FlagLabel[i]!, p('r8Fresh'), { x: pos.x + 8200, y: y + 20 });

    // ADD HL/IX/IY: bits 0,1,3,4,5
    if (i === 0 || i === 1 || i === 3 || i === 4 || i === 5) {
      wire(parent, addHlFSel.out, p('selAddHl'));
      if (i === 0) tieToLabel('ADDHL_C', p('addHlFresh'), { x: pos.x + 8250, y: y + 20 });
      else if (i === 1) idle(p('addHlFresh'));
      else if (i === 3) tieToLabel('ADDHLHI3', p('addHlFresh'), { x: pos.x + 8250, y: y + 20 });
      else if (i === 4) tieToLabel('ADDHL_H', p('addHlFresh'), { x: pos.x + 8250, y: y + 20 });
      else tieToLabel('ADDHLHI5', p('addHlFresh'), { x: pos.x + 8250, y: y + 20 });
    } else {
      idle(p('selAddHl'));
      idle(p('addHlFresh'));
    }

    // RLCA/…/SCF/CCF/CPL — C(0), N(1), H(4), X/Y(3/5)
    if (i === 0) {
      tieToLabel('ROTACC_C_NOW', p('selRotAcc'), { x: pos.x + 8260, y });
      tieToLabel('ROTACC_C', p('rotAccFresh'), { x: pos.x + 8260, y: y + 20 });
    } else if (i === 1) {
      tieToLabel('ROTACC_N_NOW', p('selRotAcc'), { x: pos.x + 8260, y });
      tieToLabel('CPL_NOW', p('rotAccFresh'), { x: pos.x + 8260, y: y + 20 });
    } else if (i === 4) {
      tieToLabel('ROTACC_N_NOW', p('selRotAcc'), { x: pos.x + 8260, y });
      tieToLabel('ROTACC_H', p('rotAccFresh'), { x: pos.x + 8260, y: y + 20 });
    } else if (i === 3 || i === 5) {
      tieToLabel('ROTACC_N_NOW', p('selRotAcc'), { x: pos.x + 8260, y });
      tieToLabel(i === 3 ? 'ROTACC_X' : 'ROTACC_Y', p('rotAccFresh'), { x: pos.x + 8260, y: y + 20 });
    } else {
      idle(p('selRotAcc'));
      idle(p('rotAccFresh'));
    }

    // DAA — all but N (1)
    if (i !== 1) {
      const daaFlagLabel: Record<number, string> = { 0: 'DAA_NEWC', 2: 'DAA_NEWP', 3: 'DAA_NEWX', 4: 'DAA_NEWH', 5: 'DAA_NEWY', 6: 'DAA_NEWZ', 7: 'DAA_NEWS' };
      tieToLabel('DAA_NOW', p('selDaa'), { x: pos.x + 8265, y });
      tieToLabel(daaFlagLabel[i]!, p('daaFresh'), { x: pos.x + 8265, y: y + 15 });
    } else {
      idle(p('selDaa'));
      idle(p('daaFresh'));
    }

    // LDI block — N/H/P bits 1,2,4
    if (i === 1 || i === 2 || i === 4) {
      tieToLabel('LDBLOCK_COMMIT_NOW', p('selLdBlock'), { x: pos.x + 8270, y });
      if (i === 2) wire(parent, blockPvBit, p('ldBlockFresh'));
      else idle(p('ldBlockFresh'));
    } else {
      idle(p('selLdBlock'));
      idle(p('ldBlockFresh'));
    }

    // CPI block — bits 1,2,4,6,7
    if (i === 1 || i === 2 || i === 4 || i === 6 || i === 7) {
      tieToLabel('CPBLOCK_COMMIT_NOW', p('selCpBlock'), { x: pos.x + 8275, y });
      const cpFreshBit: Record<number, Pin> = { 1: vcc4, 2: blockPvBit, 4: cpHBit.out, 6: cpZBit.out, 7: cpSBit };
      wire(parent, cpFreshBit[i]!, p('cpBlockFresh'));
    } else {
      idle(p('selCpBlock'));
      idle(p('cpBlockFresh'));
    }

    // INI — bits 1,6
    if (i === 1 || i === 6) {
      tieToLabel('INBLOCK_COMMIT_NOW', p('selInBlock'), { x: pos.x + 8280, y });
      if (i === 1) wire(parent, ioPortDataIn[7]!, p('inBlockFresh'));
      else tieToLabel('IOB_Z_NOW', p('inBlockFresh'), { x: pos.x + 8280, y: y + 20 });
    } else {
      idle(p('selInBlock'));
      idle(p('inBlockFresh'));
    }

    // OUTI — bits 1,6
    if (i === 1 || i === 6) {
      tieToLabel('OUTBLOCK_COMMIT_NOW', p('selOutBlock'), { x: pos.x + 8285, y });
      if (i === 1) wire(parent, outBlockTemp.q[7]!, p('outBlockFresh'));
      else tieToLabel('IOB_Z_NOW', p('outBlockFresh'), { x: pos.x + 8285, y: y + 20 });
    } else {
      idle(p('selOutBlock'));
      idle(p('outBlockFresh'));
    }

    // NEG — all bits
    tieToLabel('NEG_NOW', p('selNeg'), { x: pos.x + 8278, y });
    {
      const negFreshBit: Record<number, Pin> = { 0: negCBit, 1: vcc4, 2: negPvBit.out, 3: negXBit, 4: negHBit.out, 5: negYBit, 6: negZBit.out, 7: negSBit };
      wire(parent, negFreshBit[i]!, p('negFresh'));
    }

    // ADC/SBC HL — all bits
    tieToLabel('ADCSBCHL_COMMIT_NOW', p('selAdcSbcHl'), { x: pos.x + 8279, y });
    {
      const adcSbcHlFreshLabel: Record<number, string> = { 0: 'ADCSBCHL_C', 2: 'ADCSBCHL_PV', 3: 'ADDHLHI3', 4: 'ADCSBCHL_H', 5: 'ADDHLHI5', 6: 'ADCSBCHL_Z', 7: 'ADCSBCHL_S' };
      if (i === 1) wire(parent, isSbcHlNow.out, p('adcSbcHlFresh'));
      else tieToLabel(adcSbcHlFreshLabel[i]!, p('adcSbcHlFresh'), { x: pos.x + 8279, y: y + 20 });
    }

    // RRD/RLD — all but C
    if (i !== 0) {
      tieToLabel('RRDRLD_COMMIT_NOW', p('selRrdRld'), { x: pos.x + 8280, y });
      const rrdRldFreshBit: Record<number, Pin> = { 1: gnd4, 2: rrdRldPBit.out, 3: rrdRldNewALow[3]!, 4: gnd4, 5: rrdRldNewAHigh[1]!, 6: rrdRldZBit.out, 7: rrdRldSBit };
      wire(parent, rrdRldFreshBit[i]!, p('rrdRldFresh'));
    } else {
      idle(p('selRrdRld'));
      idle(p('rrdRldFresh'));
    }

    // IN r,(C) — all but C
    if (i !== 0) {
      tieToLabel('INRC_NOW', p('selInRc'), { x: pos.x + 8282, y });
      const inRcFreshBit: Record<number, Pin> = {
        1: gnd4, 2: inRcPBit.out, 3: ioPortDataIn[3]!, 4: gnd4, 5: ioPortDataIn[5]!, 6: inRcZBit.out, 7: inRcSBit,
      };
      wire(parent, inRcFreshBit[i]!, p('inRcFresh'));
    } else {
      idle(p('selInRc'));
      idle(p('inRcFresh'));
    }

    // LD A,I/R — all but C
    if (i !== 0) {
      tieToLabel('LDAIR_NOW', p('selLdAIr'), { x: pos.x + 8283, y });
      const ldAIrFreshBit: Record<number, Pin> = {
        1: gnd4, 2: iff2.q[0]!, 3: ldAIrByte[3]!, 4: gnd4, 5: ldAIrByte[5]!, 6: ldAIrZBit.out, 7: ldAIrSBit,
      };
      wire(parent, ldAIrFreshBit[i]!, p('ldAIrFresh'));
    } else {
      idle(p('selLdAIr'));
      idle(p('ldAIrFresh'));
    }

    // BIT reg/HL/IXIY — all but C
    if (i !== 0) {
      tieToLabel('BIT_REG_NOW', p('selBitReg'), { x: pos.x + 8284, y });
      wire(parent, ({ 1: gnd4, 2: bitPBit, 3: bitXBit, 4: vcc4, 5: bitYBit, 6: bitZBit.out, 7: bitSBit.out } as Record<number, Pin>)[i]!, p('bitRegFresh'));
      tieToLabel('BIT_HL_NOW', p('selBitHl'), { x: pos.x + 8285, y });
      wire(parent, ({ 1: gnd4, 2: bitHlPBit, 3: bitHlXBit, 4: vcc4, 5: bitHlYBit, 6: bitHlZBit.out, 7: bitHlSBit.out } as Record<number, Pin>)[i]!, p('bitHlFresh'));
      tieToLabel('BIT_IXIY_NOW', p('selBitIxIy'), { x: pos.x + 8285, y: y + 5 });
      wire(parent, ({ 1: gnd4, 2: bitIxPBit, 3: bitIxXBit, 4: vcc4, 5: bitIxYBit, 6: bitIxZBit.out, 7: bitIxSBit.out } as Record<number, Pin>)[i]!, p('bitIxIyFresh'));
    } else {
      idle(p('selBitReg')); idle(p('bitRegFresh'));
      idle(p('selBitHl')); idle(p('bitHlFresh'));
      idle(p('selBitIxIy')); idle(p('bitIxIyFresh'));
    }

    // CB rotate — all bits
    tieToLabel('CBROT_NOW', p('selCbRot'), { x: pos.x + 8286, y });
    if (i === 0) tieToLabel('CBROT_C', p('cbRotFresh'), { x: pos.x + 8286, y: y + 20 });
    else if (i === 1) idle(p('cbRotFresh'));
    else if (i === 2) tieToLabel('CBROT_P', p('cbRotFresh'), { x: pos.x + 8286, y: y + 20 });
    else if (i === 3) tieToLabel('CBROT_X', p('cbRotFresh'), { x: pos.x + 8286, y: y + 20 });
    else if (i === 4) idle(p('cbRotFresh'));
    else if (i === 5) tieToLabel('CBROT_Y', p('cbRotFresh'), { x: pos.x + 8286, y: y + 20 });
    else if (i === 6) tieToLabel('CBROT_Z', p('cbRotFresh'), { x: pos.x + 8286, y: y + 20 });
    else tieToLabel('CBROT_S', p('cbRotFresh'), { x: pos.x + 8286, y: y + 20 });

    tieToLabel('EX_AFAF_NOW', p('selExAfAf'), { x: pos.x + 8280, y: y + 10 });
    tieToLabel(`FPOLD${i}`, p('fpOld'), { x: pos.x + 8280, y: y + 25 });
    wire(parent, isBusToF.out, p('selBus'));
    tieToLabel(`BUS${i}`, p('busBit'), { x: pos.x + 8300, y });
    wire(parent, p('out'), f.d[i]!);
  }

  // ADD HL,rr / ADD IX,rr / ADD IY,rr C-bit write — side-fold stays
  // outside F_WE_OR and feeds as a single input.
  const addHlCWe1 = buildOr(parent, { x: pos.x + 8650, y: pos.y + 2220 });
  tieToLabel('ADDHL_NOW', addHlCWe1.a, { x: pos.x + 8550, y: pos.y + 2220 });
  tieToLabel('ADDIX_NOW', addHlCWe1.b, { x: pos.x + 8550, y: pos.y + 2240 });
  const addHlCWe = buildOr(parent, { x: pos.x + 8670, y: pos.y + 2220 });
  wire(parent, addHlCWe1.out, addHlCWe.a);
  tieToLabel('ADDIY_NOW', addHlCWe.b, { x: pos.x + 8570, y: pos.y + 2240 });
  // F WE OR — sequential left-associated OR of every F write-enable term
  // (same order as the former fWeStage…fWeFinal12 chain). RRDRLD_COMMIT_NOW
  // stays mid-chain; ADD HL/IX/IY side-fold is a single input.
  const fWeOrDef = getOrNChip(library, 20, 'F_WE_OR');
  const fWeOr = makeChipInstance(parent, fWeOrDef, { x: pos.x + 8500, y: pos.y + 2180 });
  const fWeIn = (idx: number) => fWeOr.pins[fWeOrDef.ports[idx]!]!;
  wire(parent, fWe.out, fWeIn(0));
  tieToLabel('INCDEC_R8_NOW', fWeIn(1), { x: pos.x + 8400, y: pos.y + 2180 });
  wire(parent, isBusToF.out, fWeIn(2));
  wire(parent, addHlCWe.out, fWeIn(3));
  tieToLabel('ROTACC_N_NOW', fWeIn(4), { x: pos.x + 8650, y: pos.y + 2230 });
  tieToLabel('EX_AFAF_NOW', fWeIn(5), { x: pos.x + 8660, y: pos.y + 2240 });
  tieToLabel('DAA_NOW', fWeIn(6), { x: pos.x + 8670, y: pos.y + 2250 });
  tieToLabel('LDBLOCK_COMMIT_NOW', fWeIn(7), { x: pos.x + 8770, y: pos.y + 2260 });
  tieToLabel('CPBLOCK_COMMIT_NOW', fWeIn(8), { x: pos.x + 8870, y: pos.y + 2270 });
  tieToLabel('INBLOCK_COMMIT_NOW', fWeIn(9), { x: pos.x + 8970, y: pos.y + 2280 });
  tieToLabel('OUTBLOCK_COMMIT_NOW', fWeIn(10), { x: pos.x + 9070, y: pos.y + 2290 });
  tieToLabel('NEG_NOW', fWeIn(11), { x: pos.x + 9170, y: pos.y + 2300 });
  tieToLabel('ADCSBCHL_COMMIT_NOW', fWeIn(12), { x: pos.x + 9270, y: pos.y + 2310 });
  tieToLabel('RRDRLD_COMMIT_NOW', fWeIn(13), { x: pos.x + 9370, y: pos.y + 2320 });
  tieToLabel('INRC_NOW', fWeIn(14), { x: pos.x + 9470, y: pos.y + 2330 });
  tieToLabel('LDAIR_NOW', fWeIn(15), { x: pos.x + 9570, y: pos.y + 2340 });
  tieToLabel('BIT_REG_NOW', fWeIn(16), { x: pos.x + 9670, y: pos.y + 2350 });
  tieToLabel('BIT_HL_NOW', fWeIn(17), { x: pos.x + 9770, y: pos.y + 2360 });
  tieToLabel('BIT_IXIY_NOW', fWeIn(18), { x: pos.x + 9820, y: pos.y + 2365 });
  tieToLabel('CBROT_NOW', fWeIn(19), { x: pos.x + 9870, y: pos.y + 2370 });
  wire(parent, fWeOr.pins[fWeOrDef.ports[20]!]!, f.we);

  // SP: same external-seed contract as B..L above — `sp.d`/`sp.we` here
  // are the caller's own sink pins, muxed ahead of the raw register the
  // same way. `spAluActive` widens the original `stackActive` (any PUSH/
  // POP/RET/RST currently in EXEC1/EXEC2) with INCDEC_SP_NOW (x=00 z=3
  // y=6/7's explicit INC/DEC SP) — spAdder.out is the right value either
  // way, only the *reason* it's being committed differs; see spWantDec's
  // own doc comment above for why the two conditions never overlap.
  const spAluActive = buildOr(parent, { x: pos.x + 8500, y: pos.y + 2850 });
  wire(parent, stackActive.out, spAluActive.a);
  tieToLabel('INCDEC_SP_NOW', spAluActive.b, { x: pos.x + 8400, y: pos.y + 2850 });
  const pairCommitSp = getPairCommitBitChip(library);
  const spHalfCommit = getSpHalfCommitBitChip(library);
  const spExtD: Pin[] = [];
  sp.q.forEach((_, i) => {
    const bit = makeChipInstance(parent, pairCommitSp, { x: pos.x + 8600, y: pos.y + 2900 + i * 100 });
    wire(parent, spAluActive.out, bit.pins.sel!);
    spExtD.push(bit.pins.passthrough!);
    wire(parent, spAdder.out[i]!, bit.pins.override!);
    wire(parent, bit.pins.out!, sp.d[i]!);
  });
  const spWeOr = buildOr(parent, { x: pos.x + 8600, y: pos.y + 3200 });
  wire(parent, spAluActive.out, spWeOr.a);
  wire(parent, spWeOr.out, sp.we);
  const spExternal: Register = { d: spExtD, we: spWeOr.b, clk: sp.clk, q: sp.q, qn: sp.qn };

  const ldDdNnLowSpNow = buildAnd(parent, { x: pos.x + 8300, y: pos.y + 3300 });
  tieToLabel('LDDDNN_LOW_NOW', ldDdNnLowSpNow.a, { x: pos.x + 8200, y: pos.y + 3300 });
  wire(parent, dec.y[6]!, ldDdNnLowSpNow.b);
  const ldDdNnHighSpNow = buildAnd(parent, { x: pos.x + 8300, y: pos.y + 3350 });
  tieToLabel('LDDDNN_HIGH_NOW', ldDdNnHighSpNow.a, { x: pos.x + 8200, y: pos.y + 3350 });
  wire(parent, dec.y[6]!, ldDdNnHighSpNow.b);
  const ldDdNnSpAnyNow = buildOr(parent, { x: pos.x + 8400, y: pos.y + 3325 });
  wire(parent, ldDdNnLowSpNow.out, ldDdNnSpAnyNow.a);
  wire(parent, ldDdNnHighSpNow.out, ldDdNnSpAnyNow.b);

  const spExtD2: Pin[] = [];
  sp.q.forEach((q, i) => {
    const bit = makeChipInstance(parent, spHalfCommit, { x: pos.x + 8500, y: pos.y + 3400 + i * 100 });
    if (i < 8) {
      wire(parent, ldDdNnHighSpNow.out, bit.pins.selHold!);
      tieToLabel(`BUS${i}`, bit.pins.busBit!, { x: pos.x + 8400, y: pos.y + 3400 + i * 100 });
    } else {
      wire(parent, ldDdNnLowSpNow.out, bit.pins.selHold!);
      tieToLabel(`BUS${i - 8}`, bit.pins.busBit!, { x: pos.x + 8400, y: pos.y + 3400 + i * 100 });
    }
    wire(parent, ldDdNnSpAnyNow.out, bit.pins.selAny!);
    wire(parent, q, bit.pins.holdQ!);
    spExtD2.push(bit.pins.passthrough!);
    wire(parent, bit.pins.out!, spExternal.d[i]!);
  });
  const spWeOr2 = buildOr(parent, { x: pos.x + 8600, y: pos.y + 3600 });
  wire(parent, ldDdNnSpAnyNow.out, spWeOr2.a);
  wire(parent, spWeOr2.out, spExternal.we);
  const spExternal2: Register = { d: spExtD2, we: spWeOr2.b, clk: spExternal.clk, q: spExternal.q, qn: spExternal.qn };

  const spExtD3: Pin[] = [];
  sp.q.forEach((_, i) => {
    const bit = makeChipInstance(parent, pairCommitSp, { x: pos.x + 8900, y: pos.y + 3700 + i * 100 });
    tieToLabel('LDSPHL_NOW', bit.pins.sel!, { x: pos.x + 8800, y: pos.y + 3700 + i * 100 });
    spExtD3.push(bit.pins.passthrough!);
    if (i < 8) wire(parent, rL.q[i]!, bit.pins.override!);
    else if (rH.q[i - 8]) wire(parent, rH.q[i - 8]!, bit.pins.override!);
    else tiePowerRail(parent, 'GND', bit.pins.override!);
    wire(parent, bit.pins.out!, spExternal2.d[i]!);
  });
  const spWeOr3 = buildOr(parent, { x: pos.x + 8900, y: pos.y + 3900 });
  tieToLabel('LDSPHL_NOW', spWeOr3.a, { x: pos.x + 8800, y: pos.y + 3900 });
  wire(parent, spWeOr3.out, spExternal2.we);
  const spExternal3: Register = { d: spExtD3, we: spWeOr3.b, clk: spExternal2.clk, q: spExternal2.q, qn: spExternal2.qn };

  const edNnSpAnyNow = buildOr(parent, { x: pos.x + 9100, y: pos.y + 4025 });
  tieToLabel('EDNN_WE_SPLO_NOW', edNnSpAnyNow.a, { x: pos.x + 8900, y: pos.y + 4000 });
  tieToLabel('EDNN_WE_SPHI_NOW', edNnSpAnyNow.b, { x: pos.x + 8900, y: pos.y + 4050 });

  const spExtD4: Pin[] = [];
  sp.q.forEach((q, i) => {
    const bit = makeChipInstance(parent, spHalfCommit, { x: pos.x + 9200, y: pos.y + 4100 + i * 100 });
    if (i < 8) {
      tieToLabel('EDNN_WE_SPHI_NOW', bit.pins.selHold!, { x: pos.x + 9100, y: pos.y + 4120 + i * 100 });
      tieToLabel(`BUS${i}`, bit.pins.busBit!, { x: pos.x + 9100, y: pos.y + 4100 + i * 100 });
    } else {
      tieToLabel('EDNN_WE_SPLO_NOW', bit.pins.selHold!, { x: pos.x + 9100, y: pos.y + 4120 + i * 100 });
      tieToLabel(`BUS${i - 8}`, bit.pins.busBit!, { x: pos.x + 9100, y: pos.y + 4100 + i * 100 });
    }
    wire(parent, edNnSpAnyNow.out, bit.pins.selAny!);
    wire(parent, q, bit.pins.holdQ!);
    spExtD4.push(bit.pins.passthrough!);
    wire(parent, bit.pins.out!, spExternal3.d[i]!);
  });
  const spWeOr4 = buildOr(parent, { x: pos.x + 9300, y: pos.y + 4300 });
  wire(parent, edNnSpAnyNow.out, spWeOr4.a);
  wire(parent, spWeOr4.out, spExternal3.we);
  const spExternal4: Register = { d: spExtD4, we: spWeOr4.b, clk: spExternal3.clk, q: spExternal3.q, qn: spExternal3.qn };

  const spExtD5: Pin[] = [];
  sp.q.forEach((_, i) => {
    const bit = makeChipInstance(parent, pairCommitSp, { x: pos.x + 9600, y: pos.y + 4400 + i * 100 });
    tieToLabel('LDSPIX_NOW', bit.pins.sel!, { x: pos.x + 9500, y: pos.y + 4400 + i * 100 });
    spExtD5.push(bit.pins.passthrough!);
    if (i < 8) wire(parent, rIXL.q[i]!, bit.pins.override!);
    else if (rIXH.q[i - 8]) wire(parent, rIXH.q[i - 8]!, bit.pins.override!);
    else tiePowerRail(parent, 'GND', bit.pins.override!);
    wire(parent, bit.pins.out!, spExternal4.d[i]!);
  });
  const spWeOr5 = buildOr(parent, { x: pos.x + 9600, y: pos.y + 4600 });
  tieToLabel('LDSPIX_NOW', spWeOr5.a, { x: pos.x + 9500, y: pos.y + 4600 });
  wire(parent, spWeOr5.out, spExternal4.we);
  const spExternal5: Register = { d: spExtD5, we: spWeOr5.b, clk: spExternal4.clk, q: spExternal4.q, qn: spExternal4.qn };

  const spExtD6: Pin[] = [];
  sp.q.forEach((_, i) => {
    const bit = makeChipInstance(parent, pairCommitSp, { x: pos.x + 9800, y: pos.y + 4700 + i * 100 });
    tieToLabel('LDSPIY_NOW', bit.pins.sel!, { x: pos.x + 9700, y: pos.y + 4700 + i * 100 });
    spExtD6.push(bit.pins.passthrough!);
    if (i < 8) wire(parent, rIYL.q[i]!, bit.pins.override!);
    else if (rIYH.q[i - 8]) wire(parent, rIYH.q[i - 8]!, bit.pins.override!);
    else tiePowerRail(parent, 'GND', bit.pins.override!);
    wire(parent, bit.pins.out!, spExternal5.d[i]!);
  });
  const spWeOr6 = buildOr(parent, { x: pos.x + 9800, y: pos.y + 4900 });
  tieToLabel('LDSPIY_NOW', spWeOr6.a, { x: pos.x + 9700, y: pos.y + 4900 });
  wire(parent, spWeOr6.out, spExternal5.we);
  const spExternal6: Register = { d: spExtD6, we: spWeOr6.b, clk: spExternal5.clk, q: spExternal5.q, qn: spExternal5.qn };

  // Two non-overlapping clocks — see "A control FSM: the fetch loop". The
  // whole register file shares this CPU's own dataClk — an 11-way fanout,
  // labeled (CLK) rather than drawn as 11 long lines back to `pc.clk`.
  tieToLabel('CLK', pc.clk, { x: pos.x, y: pos.y - 60 });
  tieToLabel('CLK', ram.pins.clk!, { x: pos.x + 1400, y: pos.y - 60 });
  tieToLabel('CLK', ir.clk, { x: pos.x + 2600, y: pos.y - 60 });
  tieToLabel('CLK', a.clk, { x: pos.x + 3800, y: pos.y - 60 });
  tieToLabel('CLK', rB.clk, { x: pos.x + 5000, y: pos.y - 60 });
  tieToLabel('CLK', rC.clk, { x: pos.x + 5000, y: pos.y + 1140 });
  tieToLabel('CLK', rD.clk, { x: pos.x + 6200, y: pos.y - 60 });
  tieToLabel('CLK', rE.clk, { x: pos.x + 6200, y: pos.y + 1140 });
  tieToLabel('CLK', rH.clk, { x: pos.x + 7400, y: pos.y - 60 });
  tieToLabel('CLK', rL.clk, { x: pos.x + 7400, y: pos.y + 1140 });
  tieToLabel('CLK', f.clk, { x: pos.x + 8000, y: pos.y + 2140 });
  tieToLabel('CLK', aP.clk, { x: pos.x + 3800, y: pos.y + 3740 }); // this exact bug, again — see "x=00: EX AF,AF'" above; caught by the test this time, not left to a live-browser surprise
  tieToLabel('CLK', fP.clk, { x: pos.x + 8000, y: pos.y + 3740 });
  tieToLabel('CLK', regI.clk, { x: pos.x + 2600, y: pos.y + 3740 }); // same checklist — see "x=01, z=7, y=0..3: LD I/R"
  tieToLabel('CLK', regR.clk, { x: pos.x + 2600, y: pos.y + 4540 });
  tieToLabel('CLK', rIXH.clk, { x: pos.x + 1400, y: pos.y + 3740 }); // same checklist — see "DD: IX"
  tieToLabel('CLK', rIXL.clk, { x: pos.x + 1400, y: pos.y + 4540 });
  tieToLabel('CLK', rIYH.clk, { x: pos.x + 800, y: pos.y + 3740 }); // same checklist — see "FD: IY"
  tieToLabel('CLK', rIYL.clk, { x: pos.x + 800, y: pos.y + 4540 });
  tieToLabel('CLK', iff1.clk, { x: pos.x + 2000, y: pos.y + 3740 }); // IRQ/NMI — same checklist, every register
  tieToLabel('CLK', iff2.clk, { x: pos.x + 2000, y: pos.y + 3940 });
  tieToLabel('CLK', im0.clk, { x: pos.x + 1800, y: pos.y + 4140 });
  tieToLabel('CLK', im1.clk, { x: pos.x + 2000, y: pos.y + 4140 });
  tieToLabel('CLK', im2.clk, { x: pos.x + 2200, y: pos.y + 4140 });
  tieToLabel('CLK', intServing.clk, { x: pos.x + 2000, y: pos.y + 4340 });
  tieToLabel('CLK', intAckServing.clk, { x: pos.x + 2100, y: pos.y + 4300 });
  tieToLabel('CLK', nmiServing.clk, { x: pos.x + 2200, y: pos.y + 4340 });
  tieToLabel('CLK', im2Serving.clk, { x: pos.x + 2400, y: pos.y + 4340 });
  tieToLabel('CLK', nmiPrev.clk, { x: pos.x + 2200, y: pos.y + 4540 });
  tieToLabel('CLK', halted.clk, { x: pos.x + 2000, y: pos.y + 4740 });
  tieToLabel('CLK', eiArm1.clk, { x: pos.x + 2400, y: pos.y + 3740 });
  tieToLabel('CLK', eiArm2.clk, { x: pos.x + 2400, y: pos.y + 3940 });
  tieToLabel('CLK', bP.clk, { x: pos.x + 5000, y: pos.y + 3740 }); // same checklist item, every time, no exceptions — see "x=11: EXX" below
  tieToLabel('CLK', cP.clk, { x: pos.x + 5000, y: pos.y + 4540 });
  tieToLabel('CLK', dP.clk, { x: pos.x + 6200, y: pos.y + 3740 });
  tieToLabel('CLK', eP.clk, { x: pos.x + 6200, y: pos.y + 4540 });
  tieToLabel('CLK', hP.clk, { x: pos.x + 7400, y: pos.y + 3740 });
  tieToLabel('CLK', lP.clk, { x: pos.x + 7400, y: pos.y + 4540 });
  tieToLabel('CLK', sp.clk, { x: pos.x + 8000, y: pos.y + 2940 });
  tieToLabel('CLK', jpTarget.clk, { x: pos.x - 700, y: pos.y - 2160 }); // found live: this was missing entirely — jpTarget's own D-flip-flops never captured anything without it, reading 'Z' forever regardless of we/d (see "x=11: JP nn" above)
  tieToLabel('CLK', callTarget.clk, { x: pos.x - 700, y: pos.y - 3060 }); // learned from jpTarget's own missing-CLK bug above — every new register in this file gets this checked off explicitly now, not assumed
  tieToLabel('CLK', jpCcTarget.clk, { x: pos.x - 700, y: pos.y - 3960 });
  tieToLabel('CLK', callCcTarget.clk, { x: pos.x - 700, y: pos.y - 4860 });

  // LDI's own register commits (see "x=10, y=4, z=0: LDI" above) — one
  // more `wrapWithPairCommit` layer on top of each of `B`/`C`/`D`/`E`/`H`/
  // `L`'s own already-longest chain, reading the *same* `BCADD`/`DEADD`/
  // `HLADD` labels `INCDEC_BC_NOW`/`INCDEC_DE_NOW`/`INCDEC_HL_NOW`'s own
  // layer already publishes above — `BC`'s own pair adder already computes
  // `-1` here (its own direction line was widened with `isLdiNow` right
  // where it's built), `DE`/`HL`'s already compute `+1` (their own
  // direction lines never see `isLdiNow` at all, so they default to `+1`
  // exactly as this instruction wants).
  const rBExt6 = wrapWithPairCommit(rBExt5, 'LDBLOCK_COMMIT_NOW', 'BCADDHI', { x: pos.x + 12600, y: pos.y - 500 });
  const rCExt5 = wrapWithPairCommit(rCExt4, 'LDBLOCK_COMMIT_NOW', 'BCADDLO', { x: pos.x + 12600, y: pos.y - 200 });
  const rDExt6 = wrapWithPairCommit(rDExt5, 'LDBLOCK_COMMIT_NOW', 'DEADDHI', { x: pos.x + 13200, y: pos.y - 200 });
  const rEExt6 = wrapWithPairCommit(rEExt5, 'LDBLOCK_COMMIT_NOW', 'DEADDLO', { x: pos.x + 13200, y: pos.y + 100 });
  const rHExt9 = wrapWithPairCommit(rHExt8, 'LDBLOCK_COMMIT_NOW', 'HLADDHI', { x: pos.x + 13500, y: pos.y + 700 });
  const rLExt9 = wrapWithPairCommit(rLExt8, 'LDBLOCK_COMMIT_NOW', 'HLADDLO', { x: pos.x + 13500, y: pos.y + 1000 });

  // CPI/CPD/CPIR/CPDR's own register commits (see "x=10, z=1:
  // CPI/CPD/CPIR/CPDR" above) — one more `wrapWithPairCommit` layer, `B`/
  // `C`/`H`/`L` only: this family decrements `BC` exactly like the
  // LD-block family, and moves `HL` (never `DE`, which this family never
  // touches at all — no layer for `D`/`E` here, unlike LDI's own six).
  const rBExt7 = wrapWithPairCommit(rBExt6, 'CPBLOCK_COMMIT_NOW', 'BCADDHI', { x: pos.x + 12700, y: pos.y - 500 });
  const rCExt6 = wrapWithPairCommit(rCExt5, 'CPBLOCK_COMMIT_NOW', 'BCADDLO', { x: pos.x + 12700, y: pos.y - 200 });
  const rHExt10 = wrapWithPairCommit(rHExt9, 'CPBLOCK_COMMIT_NOW', 'HLADDHI', { x: pos.x + 13600, y: pos.y + 700 });
  const rLExt10 = wrapWithPairCommit(rLExt9, 'CPBLOCK_COMMIT_NOW', 'HLADDLO', { x: pos.x + 13600, y: pos.y + 1000 });

  // INI's own dedicated `B-1` adder (see "x=10, y=4, z=2: INI" above) —
  // real `INI` only ever decrements `B` itself, never the `BC` pair (`C`
  // keeps addressing the same port every time this instruction repeats
  // later, via `INIR`), so the shared `BCADD` pair adder is the wrong
  // tool here — a permanently-wired `-1`, the identical "isolated adder,
  // no shared-decode collision to fight" shape `cpBlockAdder` above and
  // `pcMinus2Adder` elsewhere in this file already use.
  const ioBAdder = buildAlu(parent, library, 8, { x: pos.x + 12800, y: pos.y - 800 });
  tiePowerRail(parent, 'GND', ioBAdder.op0);
  tiePowerRail(parent, 'GND', ioBAdder.op1);
  tiePowerRail(parent, 'GND', ioBAdder.cin);
  for (let i = 0; i < 8; i++) {
    wire(parent, rB.q[i]!, ioBAdder.a[i]!);
    tiePowerRail(parent, 'VCC', ioBAdder.b[i]!); // fanned to 1: +0xFF with no carry-in, i.e. -1
    tieToLabel(`IOBRESULT${i}`, ioBAdder.out[i]!, { x: pos.x + 12900, y: pos.y - 800 + i * 20 });
  }
  // `Z`, read directly off this adder: `B` reaching `0` is exactly "none
  // of these 8 bits is 1" — the OR-tree tapped *before* its own final
  // `NOT` is "B is still nonzero," the repeat condition `INIR` will need
  // once that instruction exists.
  let ioBZChain: Pin = ioBAdder.out[0]!;
  for (let i = 1; i < 8; i++) {
    const orGate = buildOr(parent, { x: pos.x + 12950, y: pos.y - 750 + i * 20 });
    wire(parent, ioBZChain, orGate.a);
    wire(parent, ioBAdder.out[i]!, orGate.b);
    ioBZChain = orGate.out;
  }
  tieToLabel('IOB_NONZERO_NOW', ioBZChain, { x: pos.x + 13000, y: pos.y - 570 }); // anchor — INIR's own repeat gate, once it exists, reads this
  const ioBZBit = buildNot(parent, { x: pos.x + 13000, y: pos.y - 550 });
  wire(parent, ioBZChain, ioBZBit.in);
  tieToLabel('IOB_Z_NOW', ioBZBit.out, { x: pos.x + 13050, y: pos.y - 550 }); // anchor — F's own per-bit layer (near, but built earlier in this file) reads this via the label

  // `N`, real Z80's own one documented flag bit for this whole family
  // beyond `Z`: the transferred byte's own bit 7 — needs no gate at all,
  // `ioPortDataIn[7]` (the external device's own raw response, already
  // stable the instant `ioRead` strobes) *is* the value. `S`/`H`/`P/V`/`C`
  // are real Z80's own famously undocumented territory for this whole
  // family (their exact derivation was only reverse-engineered decades
  // after the official manual shipped) — left unmodeled here, the same
  // documented-simplification stance `LDI`'s own `X`/`Y` and `CPI`'s own
  // `X`/`Y` already establish, not a fresh one.
  const ioBWeMux = wrapWithPairCommit(rBExt7, 'INBLOCK_COMMIT_NOW', 'IOBRESULT', { x: pos.x + 13000, y: pos.y - 800 });
  const rBExt8 = ioBWeMux;
  const rHExt11 = wrapWithPairCommit(rHExt10, 'INBLOCK_COMMIT_NOW', 'HLADDHI', { x: pos.x + 13700, y: pos.y + 700 });
  const rLExt11 = wrapWithPairCommit(rLExt10, 'INBLOCK_COMMIT_NOW', 'HLADDLO', { x: pos.x + 13700, y: pos.y + 1000 });

  // OUTI/OUTD/OTIR/OTDR's own register commits (see "x=10, z=3:
  // OUTI/OUTD/OTIR/OTDR" above) — one more `wrapWithPairCommit` layer for
  // `B` (the same shared `IOBRESULT` labels `INI`'s own family already
  // publishes — decrementing `B` is identical either direction) and for
  // `HL` (its own pair adder already widened for this family's own
  // direction, above).
  const rBExt9 = wrapWithPairCommit(rBExt8, 'OUTBLOCK_COMMIT_NOW', 'IOBRESULT', { x: pos.x + 13100, y: pos.y - 800 });
  const rHExt12 = wrapWithPairCommit(rHExt11, 'OUTBLOCK_COMMIT_NOW', 'HLADDHI', { x: pos.x + 13800, y: pos.y + 700 });
  const rLExt12 = wrapWithPairCommit(rLExt11, 'OUTBLOCK_COMMIT_NOW', 'HLADDLO', { x: pos.x + 13800, y: pos.y + 1000 });

  // ADC HL,rr/SBC HL,rr's own register commit (see "x=01, z=2: ADC
  // HL,rr/SBC HL,rr" above) — one more `wrapWithPairCommit` layer,
  // reading the same `ADDHLHI`/`ADDHLLO` labels plain `ADD HL,rr`'s own
  // fourth layer (`rHExt4`/`rLExt4`, far above) already publishes,
  // committed on this instruction's own `ADCSBCHL_COMMIT_NOW` instead.
  const rHExt13 = wrapWithPairCommit(rHExt12, 'ADCSBCHL_COMMIT_NOW', 'ADDHLHI', { x: pos.x + 13900, y: pos.y + 700 });
  const rLExt13 = wrapWithPairCommit(rLExt12, 'ADCSBCHL_COMMIT_NOW', 'ADDHLLO', { x: pos.x + 13900, y: pos.y + 1000 });

  // `C`'s own bus-driver banks: real INI/OUTI port address, plus
  // IN r,(C)/OUT (C),r (see "x=01, z=0/z=1") — all publish C onto the bus
  // for `ioPortAddr`. One bank per enable instead of a merging `OR` chain,
  // because each family has its own timing against the driver it hands the
  // bus to or takes it from, measured in gate delays:
  //  - INI/IND: `INBLOCK_WRITE_NOW` takes the bus three delays after
  //    `INBLOCK_READ_NOW` falls, so `C` is released straight from that
  //    label, with no stage in between.
  //  - OUTI/OUTD: RAM's `oe` (driving the bus in PHASE4) lets go many
  //    delays after `OUTBLOCK_READ_NOW` falls, and that depth grows with every
  //    term added to `RAM_OE_OR`, so `C` is enabled only once `oe` is
  //    actually low.
  const cBankEnables: ((bufEnable: Pin) => void)[] = [
    (bufEnable) => tieToLabel('INBLOCK_READ_NOW', bufEnable),
  ];
  const ramOeLow = buildNot(parent, { x: pos.x + 13050, y: pos.y - 830 });
  wire(parent, ram.pins.oe!, ramOeLow.in);
  const outBlockCToBus = buildAnd(parent, { x: pos.x + 13070, y: pos.y - 830 });
  tieToLabel('OUTBLOCK_WRITE_NOW', outBlockCToBus.a, { x: pos.x + 12950, y: pos.y - 830 });
  wire(parent, ramOeLow.out, outBlockCToBus.b);
  cBankEnables.push((bufEnable) => wire(parent, outBlockCToBus.out, bufEnable));
  const blockCToBusEd = buildOr(parent, { x: pos.x + 13050, y: pos.y - 870 });
  tieToLabel('INRC_NOW', blockCToBusEd.a, { x: pos.x + 12950, y: pos.y - 870 });
  tieToLabel('OUTRC_NOW', blockCToBusEd.b, { x: pos.x + 12950, y: pos.y - 890 });
  cBankEnables.push((bufEnable) => wire(parent, blockCToBusEd.out, bufEnable));
  cBankEnables.forEach((enable, bank) => {
    const dx = bank * 400;
    for (let i = 0; i < 8; i++) {
      const buf = makeChipInstance(parent, bufDef, { x: pos.x + 13100 + dx, y: pos.y - 800 + i * 20 });
      tieToLabel(`REGC${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 13000 + dx, y: pos.y - 800 + i * 20 });
      enable(buf.pins[bufDef.ports[1]!]!);
      tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 13200 + dx, y: pos.y - 800 + i * 20 });
    }
  });
  // `ioPortDataIn`'s own bus-driver bank: the external device's own raw
  // response, published onto the bus for RAM's own write, only while
  // `INBLOCK_WRITE_NOW` fires. No holding register between this and
  // `INBLOCK_READ_NOW` — unlike `ldBlockTemp`'s own value, this one
  // never has to survive a phase it isn't itself driven on: the external
  // device is a genuine external pin, expected to hold a stable response
  // for as long as this test harness (or any real caller) keeps it wired
  // that way, not something this composite captures and republishes a
  // phase later.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 13300, y: pos.y - 800 + i * 20 });
    wire(parent, ioPortDataIn[i]!, buf.pins[bufDef.ports[0]!]!);
    tieToLabel('INBLOCK_WRITE_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 13200, y: pos.y - 780 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 13400, y: pos.y - 800 + i * 20 });
  }

  // A holding register for the byte in flight — `(HL)`'s own value has to
  // survive from `LDBLOCK_READ_NOW` (this tick's read) to
  // `LDBLOCK_WRITE_NOW` (the *next* tick's write), the identical "a value
  // must outlive its own bus's next user" reasoning every other holding
  // register in this file already relies on (`hlMemTemp`, `spLoTemp`/
  // `spHiTemp`, and friends).
  const ldBlockTemp = buildRegister(parent, library, 8, { x: pos.x + 9450, y: pos.y - 6300 });
  tieToLabel('LDBLOCK_READ_NOW', ldBlockTemp.we, { x: pos.x + 9350, y: pos.y - 6300 });
  ldBlockTemp.d.forEach((d, i) => tieToLabel(`BUS${i}`, d, { x: pos.x + 9400, y: pos.y - 6300 + i * 20 }));
  ldBlockTemp.q.forEach((q, i) => tieToLabel(`LDITEMP${i}`, q, { x: pos.x + 9500, y: pos.y - 6280 + i * 20 })); // anchor — this same bus-driver bank, right below
  tieToLabel('CLK', ldBlockTemp.clk, { x: pos.x + 9450, y: pos.y - 6320 });
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 9600, y: pos.y - 6300 + i * 20 });
    tieToLabel(`LDITEMP${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 9550, y: pos.y - 6300 + i * 20 });
    tieToLabel('LDBLOCK_WRITE_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 9550, y: pos.y - 6280 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 9700, y: pos.y - 6300 + i * 20 });
  }

  // RRD/RLD's own rotated byte, published onto the bus for RAM's own
  // write-back only while `RRDRLD_WRITE_NOW` fires — no holding register
  // needed here at all, unlike `ldBlockTemp`'s own value: the rotated
  // nibbles (`RRDRLD_NEWHL0-7`, built alongside the rotate itself, far
  // above) are already combinational off `rrdRldTemp`'s own already-held
  // byte and `A`'s own current value, stable for as long as this phase
  // lasts.
  for (let i = 0; i < 8; i++) {
    const buf = makeChipInstance(parent, bufDef, { x: pos.x + 9800, y: pos.y - 6300 + i * 20 });
    tieToLabel(`RRDRLD_NEWHL${i}`, buf.pins[bufDef.ports[0]!]!, { x: pos.x + 9700, y: pos.y - 6300 + i * 20 });
    tieToLabel('RRDRLD_WRITE_NOW', buf.pins[bufDef.ports[1]!]!, { x: pos.x + 9700, y: pos.y - 6280 + i * 20 });
    tieToLabel(`BUS${i}`, buf.pins[bufDef.ports[2]!]!, { x: pos.x + 9900, y: pos.y - 6300 + i * 20 });
  }

  // `IN A,(n)`'s own `ioRead` (see "x=11: IN A,(n) / OUT (n),A" below)
  // widens to cover `INI`'s own read strobe too (see "x=10, y=4, z=2:
  // INI" above) — a real device wired to this pin needs to know the CPU
  // is reading its port regardless of which of the two opcodes triggered
  // it.
  const ioReadFinal = buildOr(parent, { x: pos.x + 13500, y: pos.y - 2200 });
  wire(parent, inNow.out, ioReadFinal.a);
  tieToLabel('INBLOCK_READ_NOW', ioReadFinal.b, { x: pos.x + 13400, y: pos.y - 2200 });
  const ioReadFinal2 = buildOr(parent, { x: pos.x + 13550, y: pos.y - 2200 });
  wire(parent, ioReadFinal.out, ioReadFinal2.a);
  tieToLabel('INRC_NOW', ioReadFinal2.b, { x: pos.x + 13450, y: pos.y - 2200 });
  // `OUT (n),A`'s own `ioWrite` widens to cover `OUTI`'s own family's
  // write strobe too (see "x=10, z=3: OUTI/OUTD/OTIR/OTDR" above) — the
  // identical reasoning `ioRead`'s own widening just above already
  // establishes — and OUT (C),r.
  const ioWriteFinal = buildOr(parent, { x: pos.x + 13500, y: pos.y - 2100 });
  wire(parent, outNow.out, ioWriteFinal.a);
  tieToLabel('OUTBLOCK_WRITE_NOW', ioWriteFinal.b, { x: pos.x + 13400, y: pos.y - 2100 });
  const ioWriteFinal2 = buildOr(parent, { x: pos.x + 13550, y: pos.y - 2100 });
  wire(parent, ioWriteFinal.out, ioWriteFinal2.a);
  tieToLabel('OUTRC_NOW', ioWriteFinal2.b, { x: pos.x + 13450, y: pos.y - 2100 });

  // Unified IORQ: INTACK window ∪ instruction IN/OUT strobes.
  const iorqIo = buildOr(parent, { x: pos.x + 13600, y: pos.y - 2150 });
  wire(parent, ioReadFinal2.out, iorqIo.a);
  wire(parent, ioWriteFinal2.out, iorqIo.b);
  const iorqAny = buildOr(parent, { x: pos.x + 13650, y: pos.y - 2150 });
  tieToLabel('IORQ_INTACK', iorqAny.a, { x: pos.x + 13550, y: pos.y - 2150 });
  wire(parent, iorqIo.out, iorqAny.b);
  tieToLabel('IORQ', iorqAny.out, { x: pos.x + 13750, y: pos.y - 2150 });

  // Classical bus pins (active-high).
  // M1: opcode/prefix fetch ∨ INTACK (IORQ∧M1 during ack).
  const m1Fetch = buildOr(parent, { x: pos.x + 13600, y: pos.y - 2050 });
  tieToLabel('PHASE0', m1Fetch.a, { x: pos.x + 13500, y: pos.y - 2050 });
  tieToLabel('PREFIX_READ_NOW', m1Fetch.b, { x: pos.x + 13500, y: pos.y - 2030 });
  const m1Any = buildOr(parent, { x: pos.x + 13650, y: pos.y - 2050 });
  wire(parent, m1Fetch.out, m1Any.a);
  tieToLabel('IORQ_INTACK', m1Any.b, { x: pos.x + 13550, y: pos.y - 2050 });
  tieToLabel('M1', m1Any.out, { x: pos.x + 13750, y: pos.y - 2050 });

  const ramOePin = ramOeOr.pins[ramOeOrDef.ports[37]!]!;
  const ramWePin = ramWeOr.pins[ramWeOrDef.ports[16]!]!;
  const rdAny = buildOr(parent, { x: pos.x + 13600, y: pos.y - 1950 });
  wire(parent, ramOePin, rdAny.a);
  wire(parent, ioReadFinal2.out, rdAny.b);
  tieToLabel('RD', rdAny.out, { x: pos.x + 13750, y: pos.y - 1950 });

  const wrAny = buildOr(parent, { x: pos.x + 13600, y: pos.y - 1850 });
  wire(parent, ramWePin, wrAny.a);
  wire(parent, ioWriteFinal2.out, wrAny.b);
  tieToLabel('WR', wrAny.out, { x: pos.x + 13750, y: pos.y - 1850 });

  const memCycle = buildOr(parent, { x: pos.x + 13600, y: pos.y - 1750 });
  wire(parent, ramOePin, memCycle.a);
  wire(parent, ramWePin, memCycle.b);
  const notIorq = buildNot(parent, { x: pos.x + 13650, y: pos.y - 1750 });
  wire(parent, iorqAny.out, notIorq.in);
  const mreqAny = buildAnd(parent, { x: pos.x + 13700, y: pos.y - 1750 });
  wire(parent, memCycle.out, mreqAny.a);
  wire(parent, notIorq.out, mreqAny.b);
  tieToLabel('MREQ', mreqAny.out, { x: pos.x + 13800, y: pos.y - 1750 });

  // Nested 4-T bus busy: arm on any IORQ request while idle; hold until T3.
  // Instruction ring is held via load←phase while busBusy (see above).
  // Force busy←0 while the rings are being seeded (fsmLoadExt).
  tieToLabel('BUS_BUSY', busBusyReg.q[0]!, { x: pos.x - 400, y: pos.y + 4220 });
  tieToLabel('BUS_T0', busCycle.phase[0]!, { x: pos.x - 400, y: pos.y + 3620 });
  tieToLabel('BUS_T1', busCycle.phase[1]!, { x: pos.x - 400, y: pos.y + 3640 });
  tieToLabel('BUS_T2', busCycle.phase[2]!, { x: pos.x - 400, y: pos.y + 3660 });
  tieToLabel('BUS_T3', busCycle.phase[3]!, { x: pos.x - 400, y: pos.y + 3680 });
  const notBusT3 = buildNot(parent, { x: pos.x - 300, y: pos.y + 4300 });
  wire(parent, busCycle.phase[3]!, notBusT3.in);
  const notFsmLoadExt = buildNot(parent, { x: pos.x - 300, y: pos.y + 4340 });
  wire(parent, fsmLoadOr.a, notFsmLoadExt.in);
  const busKeep = buildOr(parent, { x: pos.x - 250, y: pos.y + 4280 });
  wire(parent, iorqAny.out, busKeep.a);
  wire(parent, busBusyReg.q[0]!, busKeep.b);
  const busBusyKeep = buildAnd(parent, { x: pos.x - 200, y: pos.y + 4280 });
  wire(parent, notBusT3.out, busBusyKeep.a);
  wire(parent, busKeep.out, busBusyKeep.b);
  const busBusyNext = buildAnd(parent, { x: pos.x - 150, y: pos.y + 4280 });
  wire(parent, notFsmLoadExt.out, busBusyNext.a);
  wire(parent, busBusyKeep.out, busBusyNext.b);
  wire(parent, busBusyNext.out, busBusyReg.d[0]!);

  // Kill remaining long-distance point-to-point wires (gate→gate, leftover
  // single-anchor label stubs, etc.). Stdcell ChipDefs (NOT/NAND/…) keep
  // their own short transistor wires — this only touches the parent
  // circuit where gates are already chip instances. Compact first so
  // pin/label geometry is final, then convert anything still long (a
  // pre-compact pass left a few dozen chip↔label stubs that only
  // exceeded the threshold after other pins on tall chips settled).
  compactCircuitLayout(parent, 0.55);
  // Threshold 24: keep only pin→label stubs; convert the ~40–80 unit
  // chip↔chip bundles (RAM_ADDR_BIT / RAM_OE_OR fans, AND chains) that
  // still read as "noodles" when zoomed out.
  replaceLongWiresWithLabels(parent, 24);
  replaceLongWiresWithLabels(parent, 24);

  return {
    clk: pc.clk,
    phaseClk: phaseClkHub,
    reset: pc.reset,
    aReset,
    fsmLoad: fsmLoadOr.a,
    fsmD: fsmDExt,
    pc: pc.q,
    ir: ir.q,
    a: a.q,
    rB: rBExt9,
    rC: rCExt6,
    rD: rDExt6,
    rE: rEExt6,
    rH: rHExt13,
    rL: rLExt13,
    f: f.q,
    aP: aPExt,
    fP: fPExt,
    rI: regI.q,
    rR: regR.q,
    rIXH: rIXHExt7,
    rIXL: rIXLExt7,
    rIYH: rIYHExt7,
    rIYL: rIYLExt7,
    iff1: iff1.q,
    iff2: iff2.q,
    im0: im0.q,
    im1: im1.q,
    im2: im2.q,
    halted: halted.q,
    int: intPin,
    intDrive,
    nmi: nmiPin,
    nmiDrive,
    irqBusDrive,
    bP: bPExt,
    cP: cPExt,
    dP: dPExt,
    eP: ePExt,
    hP: hPExt,
    lP: lPExt,
    sp: spExternal6,
    phase: fsm.phase,
    ram,
    ioPortAddr,
    ioPortDataOut,
    ioPortDataIn,
    ioRead: ioReadFinal2.out,
    ioWrite: ioWriteFinal2.out,
    iorq: iorqAny.out,
    m1: m1Any.out,
    rd: rdAny.out,
    wr: wrAny.out,
    mreq: mreqAny.out,
    busBusy: busBusyReg.q[0]!,
  };
}
