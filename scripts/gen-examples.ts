/**
 * Build demo project JSON files under examples/.
 * Run: npx vite-node scripts/gen-examples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import {
  buildNot,
  buildXor,
  makeAnalyzer,
  makeBusProbe,
  makeBusSwitch,
  makeButton,
  makeChipInstance,
  makeClock,
  makeInput,
  makeLed,
  makeProbe,
  makeRom,
  makeSevenSeg,
  makeSource,
  wire,
} from '../src/sim/library.js';
import { serializeProject, serializeSlimStdcells, type SerializedProject } from '../src/sim/serialize.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
mkdirSync(outDir, { recursive: true });

/** Project JSON with only chip defs referenced from the top circuit (easy to edit). */
function serializeUsed(top: Circuit, library: ChipLibrary): SerializedProject {
  const full = serializeProject(top, library);
  const used = new Set<string>();
  const visitCircuit = (circuit: Circuit): void => {
    for (const c of circuit.components.values()) {
      if (c.kind !== 'chip') continue;
      if (used.has(c.defId)) continue;
      used.add(c.defId);
      visitCircuit(library.get(c.defId).circuit);
    }
  };
  visitCircuit(top);
  return { ...full, chipDefs: full.chipDefs.filter((d) => used.has(d.id)) };
}

function emptyLib(): ChipLibrary {
  const library = new ChipLibrary();
  seedStandardCells(library);
  return library;
}

function write(name: string, top: Circuit, library: ChipLibrary): void {
  const path = join(outDir, `${name}.json`);
  const data = serializeUsed(top, library);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', path, `(${data.chipDefs.length} chip defs)`);
}

/** Lab demos: omit stdcell bodies; instances carry defName for load-time rebind. */
function writeLab(name: string, top: Circuit, library: ChipLibrary): void {
  const path = join(outDir, `${name}.json`);
  const data = serializeSlimStdcells(top, library);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', path, `(${data.chipDefs.length} chip defs, slim)`);
}

/** Button → CMOS inverter → LED + probe (transistor-level). */
function cmosInverter(): void {
  const library = emptyLib();
  const c = new Circuit();
  makeSource(c, 1, { x: 60, y: 40 });
  makeSource(c, 0, { x: 60, y: 160 });
  const btn = makeButton(c, { x: 140, y: 100 }, 'toggle');
  const inv = buildNot(c, { x: 260, y: 70 });
  const led = makeLed(c, { x: 420, y: 100 }, 'out');
  const probe = makeProbe(c, { x: 420, y: 160 }, 'out');
  wire(c, btn.pins.out, inv.in);
  wire(c, inv.out, led.pins.in);
  wire(c, inv.out, probe.pins.in);
  write('cmos-inverter', c, library);
}

/** Two toggles → Library NAND chip → LED. */
function nandGate(): void {
  const library = emptyLib();
  const def = library.findByName('NAND')!;
  const c = new Circuit();
  const a = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 120, y: 140 }, 'toggle');
  const chip = makeChipInstance(c, def, { x: 280, y: 100 });
  const led = makeLed(c, { x: 440, y: 100 }, 'nand');
  wire(c, a.pins.out, chip.pins.a!);
  wire(c, b.pins.out, chip.pins.b!);
  wire(c, chip.pins.out!, led.pins.in);
  write('nand-gate', c, library);
}

/** Half adder from Library cell + LEDs for sum / carry. */
function halfAdder(): void {
  const library = emptyLib();
  const def = library.findByName('HALF_ADDER')!;
  const c = new Circuit();
  const a = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 120, y: 140 }, 'toggle');
  const chip = makeChipInstance(c, def, { x: 280, y: 100 });
  const sum = makeLed(c, { x: 460, y: 60 }, 'sum');
  const cout = makeLed(c, { x: 460, y: 140 }, 'cout');
  wire(c, a.pins.out, chip.pins.a!);
  wire(c, b.pins.out, chip.pins.b!);
  wire(c, chip.pins.sum!, sum.pins.in);
  wire(c, chip.pins.cout!, cout.pins.in);
  write('half-adder', c, library);
}

/** D latch walkthrough: D + EN buttons, Q/Qn LEDs (stdcell). Catalog: "Latch walkthrough". */
function dLatch(): void {
  const library = emptyLib();
  const def = library.findByName('D_LATCH')!;
  const c = new Circuit();
  const d = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const en = makeButton(c, { x: 120, y: 140 }, 'momentary');
  const chip = makeChipInstance(c, def, { x: 280, y: 120 });
  const q = makeLed(c, { x: 460, y: 60 }, 'Q');
  const qn = makeLed(c, { x: 460, y: 160 }, 'Qn');
  wire(c, d.pins.out, chip.pins.d!);
  wire(c, en.pins.out, chip.pins.en!);
  wire(c, chip.pins.q!, q.pins.in);
  wire(c, chip.pins.qn!, qn.pins.in);
  write('d-latch', c, library);
}

/** Tiny ROM with a greeting string; OE tied high; probes on D0–D7. */
function romDump(): void {
  const library = emptyLib();
  const c = new Circuit();
  const hello = new TextEncoder().encode('Hello!\nZ80\0');
  const rom = makeRom(c, 8, 8, hello, { x: 320, y: 180 });
  const oe = makeInput(c, 1, { x: 160, y: 300 });
  wire(c, oe.pins.out, rom.pins.oe!);
  for (let i = 0; i < 8; i++) {
    const inp = makeInput(c, 0, { x: 160, y: 40 + i * 28 });
    wire(c, inp.pins.out, rom.pins[`addr${i}`]!);
  }
  for (let i = 0; i < 8; i++) {
    const p = makeProbe(c, { x: 480, y: 60 + i * 28 }, `D${i}`);
    wire(c, rom.pins[`data${i}`]!, p.pins.in);
  }
  write('rom-viewer', c, library);
}

/** XOR from raw transistors + clocked pulse into one input (lab instruments). */
function xorPulse(): void {
  const library = emptyLib();
  const c = new Circuit();
  makeSource(c, 1, { x: 40, y: 40 });
  makeSource(c, 0, { x: 40, y: 220 });
  const a = makeButton(c, { x: 140, y: 60 }, 'toggle');
  const clk = makeClock(c, { x: 140, y: 160 }, 30);
  clk.running = true;
  const xor = buildXor(c, { x: 300, y: 80 });
  const led = makeLed(c, { x: 520, y: 120 }, 'xor');
  wire(c, a.pins.out, xor.a);
  wire(c, clk.pins.out, xor.b);
  wire(c, xor.out, led.pins.in);
  write('xor-pulse', c, library);
}

/** Nested hierarchy: AND stdcell (dive to see insides). */
function andFromLibrary(): void {
  const library = emptyLib();
  const def = library.findByName('AND')!;
  const c = new Circuit();
  const a = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 120, y: 140 }, 'toggle');
  const chip = makeChipInstance(c, def, { x: 280, y: 100 });
  const led = makeLed(c, { x: 440, y: 100 }, 'and');
  wire(c, a.pins.out, chip.pins.a!);
  wire(c, b.pins.out, chip.pins.b!);
  wire(c, chip.pins.out!, led.pins.in);
  write('and-gate', c, library);
}

/** COUNTER4 → BCD_7SEG → 7SEG with a free-running clock and sync clear. */
function labCounter7seg(): void {
  const library = emptyLib();
  const counter = library.findByName('COUNTER4')!;
  const bcd = library.findByName('BCD_7SEG')!;
  const c = new Circuit();
  const clr = makeButton(c, { x: 100, y: 80 }, 'toggle');
  clr.value = 1; // start in clear so Q leaves Z on first clocks
  const ce = makeButton(c, { x: 100, y: 140 }, 'toggle');
  ce.value = 1; // enable counting
  const load = makeButton(c, { x: 100, y: 200 }, 'toggle');
  load.value = 0;
  const clk = makeClock(c, { x: 100, y: 280 }, 24);
  clk.running = true;
  const cnt = makeChipInstance(c, counter, { x: 280, y: 180 });
  const dec = makeChipInstance(c, bcd, { x: 520, y: 180 });
  const seg = makeSevenSeg(c, { x: 760, y: 180 });
  wire(c, clr.pins.out, cnt.pins.clr!);
  wire(c, ce.pins.out, cnt.pins.ce!);
  wire(c, load.pins.out, cnt.pins.load!);
  wire(c, clk.pins.out, cnt.pins.clk!);
  for (let i = 0; i < 4; i++) {
    const d = makeButton(c, { x: 100, y: 340 + i * 40 }, 'toggle');
    d.value = 0;
    wire(c, d.pins.out, cnt.pins[`d${i}`]!);
  }
  for (let i = 0; i < 4; i++) wire(c, cnt.pins[`q${i}`]!, dec.pins[`d${i}`]!);
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const) {
    wire(c, dec.pins[s]!, seg.pins[s]!);
  }
  writeLab('lab-counter-7seg', c, library);
  // Keep legacy filename as an alias for older links / tests.
  writeLab('lab-shift-counter', c, library);
}

/** SHIFT4_SIPO serial-in → parallel LEDs. */
function labSipo(): void {
  const library = emptyLib();
  const sipo = library.findByName('SHIFT4_SIPO')!;
  const c = new Circuit();
  const sin = makeButton(c, { x: 100, y: 60 }, 'toggle');
  const clk = makeClock(c, { x: 100, y: 160 }, 20);
  clk.running = true;
  const chip = makeChipInstance(c, sipo, { x: 280, y: 140 });
  wire(c, sin.pins.out, chip.pins.sin!);
  wire(c, clk.pins.out, chip.pins.clk!);
  for (let i = 0; i < 4; i++) {
    const led = makeLed(c, { x: 480, y: 60 + i * 50 }, `q${i}`);
    wire(c, chip.pins[`q${i}`]!, led.pins.in);
  }
  writeLab('lab-sipo', c, library);
}

/** DECODER_2_4 → four LEDs from two toggles. */
function labDecoder(): void {
  const library = emptyLib();
  const dec = library.findByName('DECODER_2_4')!;
  const c = new Circuit();
  const a0 = makeButton(c, { x: 100, y: 60 }, 'toggle');
  const a1 = makeButton(c, { x: 100, y: 140 }, 'toggle');
  const en = makeButton(c, { x: 100, y: 220 }, 'toggle');
  en.value = 1;
  const chip = makeChipInstance(c, dec, { x: 280, y: 120 });
  wire(c, a0.pins.out, chip.pins.a0!);
  wire(c, a1.pins.out, chip.pins.a1!);
  wire(c, en.pins.out, chip.pins.en!);
  for (let i = 0; i < 4; i++) {
    const led = makeLed(c, { x: 480, y: 40 + i * 50 }, `y${i}`);
    wire(c, chip.pins[`y${i}`]!, led.pins.in);
  }
  writeLab('lab-decoder', c, library);
}

/** Pulse + two buttons into a logic analyzer (armed). */
function labAnalyzer(): void {
  const library = emptyLib();
  const c = new Circuit();
  const a = makeButton(c, { x: 100, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 100, y: 140 }, 'toggle');
  const clk = makeClock(c, { x: 100, y: 220 }, 16);
  clk.running = true;
  const la = makeAnalyzer(c, 3, { x: 320, y: 140 });
  la.armed = true;
  la.channelLabels = ['A', 'B', 'CLK'];
  la.triggerChannel = 2;
  la.triggerEdge = 'rise';
  wire(c, a.pins.out, la.pins.ch0!);
  wire(c, b.pins.out, la.pins.ch1!);
  wire(c, clk.pins.out, la.pins.ch2!);
  writeLab('lab-analyzer', c, library);
}

/** COMP2 magnitude compare demo. */
function labComp(): void {
  const library = emptyLib();
  const def = library.findByName('COMP2')!;
  const c = new Circuit();
  const a0 = makeButton(c, { x: 80, y: 40 }, 'toggle');
  const a1 = makeButton(c, { x: 80, y: 100 }, 'toggle');
  const b0 = makeButton(c, { x: 80, y: 180 }, 'toggle');
  const b1 = makeButton(c, { x: 80, y: 240 }, 'toggle');
  a0.value = 1;
  const chip = makeChipInstance(c, def, { x: 280, y: 140 });
  wire(c, a0.pins.out, chip.pins.a0!);
  wire(c, a1.pins.out, chip.pins.a1!);
  wire(c, b0.pins.out, chip.pins.b0!);
  wire(c, b1.pins.out, chip.pins.b1!);
  for (const [name, y] of [
    ['eq', 60],
    ['gt', 120],
    ['lt', 180],
  ] as const) {
    const led = makeLed(c, { x: 480, y }, name);
    wire(c, chip.pins[name]!, led.pins.in);
  }
  writeLab('lab-comp', c, library);
}

/** JK flip-flop toggle demo. */
function labJk(): void {
  const library = emptyLib();
  const def = library.findByName('JK_FF')!;
  const c = new Circuit();
  const j = makeButton(c, { x: 100, y: 60 }, 'toggle');
  const k = makeButton(c, { x: 100, y: 140 }, 'toggle');
  j.value = 1;
  k.value = 1;
  const clk = makeClock(c, { x: 100, y: 220 }, 20);
  clk.running = true;
  const chip = makeChipInstance(c, def, { x: 300, y: 140 });
  wire(c, j.pins.out, chip.pins.j!);
  wire(c, k.pins.out, chip.pins.k!);
  wire(c, clk.pins.out, chip.pins.clk!);
  const qLed = makeLed(c, { x: 480, y: 100 }, 'q');
  const qnLed = makeLed(c, { x: 480, y: 180 }, 'qn');
  wire(c, chip.pins.q!, qLed.pins.in);
  wire(c, chip.pins.qn!, qnLed.pins.in);
  writeLab('lab-jk', c, library);
}

/** SHIFT4_PISO parallel load → serial out. */
function labPiso(): void {
  const library = emptyLib();
  const def = library.findByName('SHIFT4_PISO')!;
  const c = new Circuit();
  const load = makeButton(c, { x: 80, y: 40 }, 'toggle');
  load.value = 1;
  const clk = makeClock(c, { x: 80, y: 120 }, 18);
  clk.running = true;
  const chip = makeChipInstance(c, def, { x: 300, y: 160 });
  wire(c, load.pins.out, chip.pins.load!);
  wire(c, clk.pins.out, chip.pins.clk!);
  for (let i = 0; i < 4; i++) {
    const d = makeButton(c, { x: 80, y: 200 + i * 50 }, 'toggle');
    d.value = i % 2 === 0 ? 1 : 0;
    wire(c, d.pins.out, chip.pins[`d${i}`]!);
  }
  const sout = makeLed(c, { x: 520, y: 160 }, 'sout');
  wire(c, chip.pins.q3!, sout.pins.in);
  writeLab('lab-piso', c, library);
}

/** MUX8_1 select demo. */
function labMux(): void {
  const library = emptyLib();
  const def = library.findByName('MUX8_1')!;
  const c = new Circuit();
  const chip = makeChipInstance(c, def, { x: 360, y: 200 });
  for (let i = 0; i < 8; i++) {
    const inp = makeButton(c, { x: 80, y: 40 + i * 40 }, 'toggle');
    inp.value = i === 3 ? 1 : 0;
    wire(c, inp.pins.out, chip.pins[`in${i}`]!);
  }
  const sel0 = makeButton(c, { x: 80, y: 380 }, 'toggle');
  const sel1 = makeButton(c, { x: 80, y: 440 }, 'toggle');
  const sel2 = makeButton(c, { x: 80, y: 500 }, 'toggle');
  sel0.value = 1;
  sel1.value = 1; // select in3
  wire(c, sel0.pins.out, chip.pins.sel0!);
  wire(c, sel1.pins.out, chip.pins.sel1!);
  wire(c, sel2.pins.out, chip.pins.sel2!);
  const out = makeLed(c, { x: 560, y: 200 }, 'out');
  wire(c, chip.pins.out!, out.pins.in);
  writeLab('lab-mux', c, library);
}

/** CLK_DIV16 divide-by-16 pulse. */
function labClkdiv(): void {
  const library = emptyLib();
  const def = library.findByName('CLK_DIV16')!;
  const c = new Circuit();
  const clr = makeButton(c, { x: 100, y: 80 }, 'toggle');
  clr.value = 1;
  const clk = makeClock(c, { x: 100, y: 180 }, 8);
  clk.running = true;
  const chip = makeChipInstance(c, def, { x: 300, y: 140 });
  wire(c, clr.pins.out, chip.pins.clr!);
  wire(c, clk.pins.out, chip.pins.clk!);
  const led = makeLed(c, { x: 500, y: 140 }, 'out');
  wire(c, chip.pins.out!, led.pins.in);
  writeLab('lab-clkdiv', c, library);
}

/** ADDER4: hex bus switches → sum LEDs + busprobe (ribbon-friendly). */
function labAdder4(): void {
  const library = emptyLib();
  const def = library.findByName('ADDER4')!;
  const c = new Circuit();
  const chip = makeChipInstance(c, def, { x: 400, y: 200 });
  const cin = makeButton(c, { x: 80, y: 20 }, 'toggle');
  cin.value = 0;
  wire(c, cin.pins.out, chip.pins.cin!);
  const swA = makeBusSwitch(c, 4, { x: 80, y: 120 }, 'hex', 0x5);
  const swB = makeBusSwitch(c, 4, { x: 80, y: 280 }, 'hex', 0x3);
  for (let i = 0; i < 4; i++) {
    wire(c, swA.pins[`b${i}`]!, chip.pins[`a${i}`]!);
    wire(c, swB.pins[`b${i}`]!, chip.pins[`b${i}`]!);
  }
  const bus = makeBusProbe(c, 4, { x: 640, y: 160 });
  for (let i = 0; i < 4; i++) {
    wire(c, chip.pins[`sum${i}`]!, bus.pins[`b${i}`]!);
    const led = makeLed(c, { x: 640, y: 280 + i * 40 }, `s${i}`);
    wire(c, chip.pins[`sum${i}`]!, led.pins.in);
  }
  const cout = makeLed(c, { x: 640, y: 460 }, 'cout');
  wire(c, chip.pins.cout!, cout.pins.in);
  writeLab('lab-adder4', c, library);
}

/** Two COUNTER4 cascaded via co→ce. */
function labCounterCascade(): void {
  const library = emptyLib();
  const def = library.findByName('COUNTER4')!;
  const c = new Circuit();
  const clr = makeButton(c, { x: 80, y: 60 }, 'toggle');
  clr.value = 1;
  const ce = makeButton(c, { x: 80, y: 120 }, 'toggle');
  ce.value = 1;
  const load = makeButton(c, { x: 80, y: 180 }, 'toggle');
  load.value = 0;
  const clk = makeClock(c, { x: 80, y: 260 }, 12);
  clk.running = true;
  const low = makeChipInstance(c, def, { x: 280, y: 160 });
  const high = makeChipInstance(c, def, { x: 520, y: 160 });
  wire(c, clr.pins.out, low.pins.clr!);
  wire(c, clr.pins.out, high.pins.clr!);
  wire(c, ce.pins.out, low.pins.ce!);
  wire(c, load.pins.out, low.pins.load!);
  wire(c, load.pins.out, high.pins.load!);
  wire(c, clk.pins.out, low.pins.clk!);
  wire(c, clk.pins.out, high.pins.clk!);
  wire(c, low.pins.co!, high.pins.ce!);
  for (let i = 0; i < 4; i++) {
    wire(c, makeButton(c, { x: 80, y: 320 + i * 36 }, 'toggle').pins.out, low.pins[`d${i}`]!);
    wire(c, makeButton(c, { x: 80, y: 480 + i * 36 }, 'toggle').pins.out, high.pins[`d${i}`]!);
  }
  for (let i = 0; i < 4; i++) {
    const ledL = makeLed(c, { x: 720, y: 40 + i * 40 }, `q${i}`);
    const ledH = makeLed(c, { x: 720, y: 220 + i * 40 }, `q${i + 4}`);
    wire(c, low.pins[`q${i}`]!, ledL.pins.in);
    wire(c, high.pins[`q${i}`]!, ledH.pins.in);
  }
  writeLab('lab-counter-cascade', c, library);
}

/** BUF8 with oe gate. */
function labBuf8Oe(): void {
  const library = emptyLib();
  const def = library.findByName('BUF8')!;
  const c = new Circuit();
  const oe = makeButton(c, { x: 80, y: 20 }, 'toggle');
  oe.value = 1;
  const chip = makeChipInstance(c, def, { x: 320, y: 200 });
  wire(c, oe.pins.out, chip.pins.oe!);
  for (let i = 0; i < 8; i++) {
    const inp = makeButton(c, { x: 80, y: 60 + i * 40 }, 'toggle');
    inp.value = i < 4 ? 1 : 0;
    wire(c, inp.pins.out, chip.pins[`in${i}`]!);
    const led = makeLed(c, { x: 560, y: 60 + i * 40 }, `out${i}`);
    wire(c, chip.pins[`out${i}`]!, led.pins.in);
  }
  writeLab('lab-buf8-oe', c, library);
}

/** LATCH8 transparent latch. */
function labLatch8(): void {
  const library = emptyLib();
  const def = library.findByName('LATCH8')!;
  const c = new Circuit();
  const en = makeButton(c, { x: 80, y: 20 }, 'toggle');
  en.value = 1;
  const chip = makeChipInstance(c, def, { x: 320, y: 200 });
  wire(c, en.pins.out, chip.pins.en!);
  for (let i = 0; i < 8; i++) {
    const d = makeButton(c, { x: 80, y: 60 + i * 40 }, 'toggle');
    d.value = i % 2;
    wire(c, d.pins.out, chip.pins[`d${i}`]!);
    const led = makeLed(c, { x: 560, y: 60 + i * 40 }, `q${i}`);
    wire(c, chip.pins[`q${i}`]!, led.pins.in);
  }
  writeLab('lab-latch8', c, library);
}

/** REG8 clocked register. */
function labReg8(): void {
  const library = emptyLib();
  const def = library.findByName('REG8')!;
  const c = new Circuit();
  const we = makeButton(c, { x: 80, y: 20 }, 'toggle');
  we.value = 1;
  const clk = makeClock(c, { x: 80, y: 60 }, 16);
  clk.running = true;
  const chip = makeChipInstance(c, def, { x: 320, y: 220 });
  wire(c, we.pins.out, chip.pins.we!);
  wire(c, clk.pins.out, chip.pins.clk!);
  for (let i = 0; i < 8; i++) {
    const d = makeButton(c, { x: 80, y: 100 + i * 40 }, 'toggle');
    d.value = i < 3 ? 1 : 0;
    wire(c, d.pins.out, chip.pins[`d${i}`]!);
    const led = makeLed(c, { x: 560, y: 100 + i * 40 }, `q${i}`);
    wire(c, chip.pins[`q${i}`]!, led.pins.in);
  }
  writeLab('lab-reg8', c, library);
}

/** ENCODER_8_3 priority encode. */
function labEncoder(): void {
  const library = emptyLib();
  const def = library.findByName('ENCODER_8_3')!;
  const c = new Circuit();
  const chip = makeChipInstance(c, def, { x: 320, y: 200 });
  for (let i = 0; i < 8; i++) {
    const inp = makeButton(c, { x: 80, y: 40 + i * 40 }, 'toggle');
    inp.value = i === 5 ? 1 : 0;
    wire(c, inp.pins.out, chip.pins[`in${i}`]!);
  }
  for (const [name, y] of [
    ['y0', 120],
    ['y1', 180],
    ['y2', 240],
  ] as const) {
    const led = makeLed(c, { x: 560, y }, name);
    wire(c, chip.pins[name]!, led.pins.in);
  }
  writeLab('lab-encoder', c, library);
}

/** ALU4: hex bus switches for A/B + op toggles. */
function labAlu4(): void {
  const library = emptyLib();
  const def = library.findByName('ALU4')!;
  const c = new Circuit();
  const chip = makeChipInstance(c, def, { x: 400, y: 200 });
  const swA = makeBusSwitch(c, 4, { x: 80, y: 80 }, 'hex', 0x3);
  const swB = makeBusSwitch(c, 4, { x: 80, y: 240 }, 'hex', 0x1);
  for (let i = 0; i < 4; i++) {
    wire(c, swA.pins[`b${i}`]!, chip.pins[`a${i}`]!);
    wire(c, swB.pins[`b${i}`]!, chip.pins[`b${i}`]!);
  }
  const op0 = makeButton(c, { x: 80, y: 400 }, 'toggle');
  const op1 = makeButton(c, { x: 80, y: 460 }, 'toggle');
  op0.value = 0;
  op1.value = 0; // add
  wire(c, op0.pins.out, chip.pins.op0!);
  wire(c, op1.pins.out, chip.pins.op1!);
  const bus = makeBusProbe(c, 4, { x: 640, y: 120 });
  for (let i = 0; i < 4; i++) {
    wire(c, chip.pins[`s${i}`]!, bus.pins[`b${i}`]!);
    const led = makeLed(c, { x: 640, y: 240 + i * 40 }, `s${i}`);
    wire(c, chip.pins[`s${i}`]!, led.pins.in);
  }
  const cout = makeLed(c, { x: 640, y: 420 }, 'cout');
  wire(c, chip.pins.cout!, cout.pins.in);
  writeLab('lab-alu4', c, library);
}

/**
 * Mini nibble CPU: COUNTER4=PC, Soft RAM opcode, REG8=ACC, ALU4, clock.
 * Soft Lab opaque eval — curriculum finale.
 */
function labMiniCpu(): void {
  const library = emptyLib();
  const c = new Circuit();
  const pc = makeChipInstance(c, library.findByName('COUNTER4')!, { x: 280, y: 80 });
  const ram = makeChipInstance(c, library.findByName('SOFT_RAM16')!, { x: 280, y: 340 });
  const alu = makeChipInstance(c, library.findByName('ALU4')!, { x: 560, y: 200 });
  const acc = makeChipInstance(c, library.findByName('REG8')!, { x: 820, y: 200 });
  const clk = makeClock(c, { x: 60, y: 80 }, 16);
  clk.running = true;
  const clr = makeButton(c, { x: 60, y: 20 }, 'toggle');
  clr.value = 1;
  const ce = makeButton(c, { x: 60, y: 140 }, 'toggle');
  ce.value = 1;
  const we = makeButton(c, { x: 60, y: 420 }, 'toggle');
  we.value = 0;
  const oe = makeButton(c, { x: 140, y: 420 }, 'toggle');
  oe.value = 1; // read
  const weAcc = makeButton(c, { x: 60, y: 480 }, 'toggle');
  weAcc.value = 0;
  wire(c, clk.pins.out, pc.pins.clk!);
  wire(c, clk.pins.out, acc.pins.clk!);
  wire(c, clk.pins.out, ram.pins.clk!);
  wire(c, clr.pins.out, pc.pins.clr!);
  wire(c, ce.pins.out, pc.pins.ce!);
  wire(c, we.pins.out, ram.pins.we!);
  wire(c, oe.pins.out, ram.pins.oe!);
  wire(c, weAcc.pins.out, acc.pins.we!);
  // PC load held low
  const loadPc = makeButton(c, { x: 60, y: 180 }, 'toggle');
  loadPc.value = 0;
  wire(c, loadPc.pins.out, pc.pins.load!);
  for (let i = 0; i < 4; i++) {
    const d = makeButton(c, { x: 160, y: 20 + i * 28 }, 'toggle');
    d.value = 0;
    wire(c, d.pins.out, pc.pins[`d${i}`]!);
  }
  // PC low nibble → RAM addr
  for (let i = 0; i < 4; i++) wire(c, pc.pins[`q${i}`]!, ram.pins[`addr${i}`]!);
  // Program data bus switches (write into RAM when WE)
  const prog = makeBusSwitch(c, 8, { x: 60, y: 280 }, 'hex', 0x31);
  for (let i = 0; i < 8; i++) wire(c, prog.pins[`b${i}`]!, ram.pins[`data${i}`]!);
  // ALU: A = acc low nibble, B = RAM data low nibble, op from switches
  for (let i = 0; i < 4; i++) {
    wire(c, acc.pins[`q${i}`]!, alu.pins[`a${i}`]!);
    wire(c, ram.pins[`data${i}`]!, alu.pins[`b${i}`]!);
  }
  const op = makeBusSwitch(c, 2, { x: 60, y: 540 }, 'bin', 0);
  wire(c, op.pins.b0!, alu.pins.op0!);
  wire(c, op.pins.b1!, alu.pins.op1!);
  // ALU result → ACC d
  for (let i = 0; i < 4; i++) wire(c, alu.pins[`s${i}`]!, acc.pins[`d${i}`]!);
  for (let i = 4; i < 8; i++) {
    const gnd = makeButton(c, { x: 700, y: 40 + (i - 4) * 28 }, 'toggle');
    gnd.value = 0;
    wire(c, gnd.pins.out, acc.pins[`d${i}`]!);
  }
  const pcBus = makeBusProbe(c, 4, { x: 500, y: 40 });
  for (let i = 0; i < 4; i++) wire(c, pc.pins[`q${i}`]!, pcBus.pins[`b${i}`]!);
  const accBus = makeBusProbe(c, 8, { x: 1040, y: 200 });
  for (let i = 0; i < 8; i++) wire(c, acc.pins[`q${i}`]!, accBus.pins[`b${i}`]!);
  writeLab('lab-mini-cpu', c, library);
}

/** ALU8 byte datapath demo. */
function labAlu8(): void {
  const library = emptyLib();
  const def = library.findByName('ALU8')!;
  const c = new Circuit();
  const chip = makeChipInstance(c, def, { x: 420, y: 280 });
  for (let i = 0; i < 8; i++) {
    const a = makeButton(c, { x: 60, y: 20 + i * 36 }, 'toggle');
    a.value = i < 4 ? 1 : 0; // A=0x0F
    wire(c, a.pins.out, chip.pins[`a${i}`]!);
  }
  for (let i = 0; i < 8; i++) {
    const b = makeButton(c, { x: 60, y: 340 + i * 36 }, 'toggle');
    b.value = i === 0 || i === 1 ? 1 : 0; // B=0x03
    wire(c, b.pins.out, chip.pins[`b${i}`]!);
  }
  const op0 = makeButton(c, { x: 60, y: 660 }, 'toggle');
  const op1 = makeButton(c, { x: 60, y: 710 }, 'toggle');
  wire(c, op0.pins.out, chip.pins.op0!);
  wire(c, op1.pins.out, chip.pins.op1!);
  const probe = makeBusProbe(c, 8, { x: 700, y: 200 });
  for (let i = 0; i < 8; i++) wire(c, chip.pins[`s${i}`]!, probe.pins[`b${i}`]!);
  const cout = makeLed(c, { x: 700, y: 400 }, 'cout');
  wire(c, chip.pins.cout!, cout.pins.in);
  writeLab('lab-alu8', c, library);
}

/** Soft RAM 16×8 write/read demo. */
function labSoftRam(): void {
  const library = emptyLib();
  const def = library.findByName('SOFT_RAM16')!;
  const c = new Circuit();
  const chip = makeChipInstance(c, def, { x: 400, y: 220 });
  for (let i = 0; i < 4; i++) {
    const a = makeButton(c, { x: 60, y: 40 + i * 40 }, 'toggle');
    wire(c, a.pins.out, chip.pins[`addr${i}`]!);
  }
  for (let i = 0; i < 8; i++) {
    const d = makeButton(c, { x: 60, y: 220 + i * 36 }, 'toggle');
    d.value = i < 4 ? 1 : 0; // 0x0F
    wire(c, d.pins.out, chip.pins[`data${i}`]!);
  }
  const we = makeButton(c, { x: 60, y: 540 }, 'toggle');
  const oe = makeButton(c, { x: 60, y: 590 }, 'toggle');
  oe.value = 1;
  const clk = makeClock(c, { x: 60, y: 660 });
  clk.mode = 'continuous';
  clk.running = true;
  clk.periodFrames = 24;
  clk.dutyFrames = 12;
  wire(c, we.pins.out, chip.pins.we!);
  wire(c, oe.pins.out, chip.pins.oe!);
  wire(c, clk.pins.out, chip.pins.clk!);
  const probe = makeBusProbe(c, 8, { x: 680, y: 220 });
  for (let i = 0; i < 8; i++) wire(c, chip.pins[`data${i}`]!, probe.pins[`b${i}`]!);
  writeLab('lab-soft-ram', c, library);
}

/** Two BUF8 fighting on one bus — teach contention. */
function labContendBus(): void {
  const library = emptyLib();
  const def = library.findByName('BUF8')!;
  const c = new Circuit();
  const a = makeChipInstance(c, def, { x: 280, y: 160 });
  const b = makeChipInstance(c, def, { x: 280, y: 420 });
  for (let i = 0; i < 8; i++) {
    const ina = makeButton(c, { x: 60, y: 20 + i * 36 }, 'toggle');
    ina.value = i % 2 === 0 ? 1 : 0;
    wire(c, ina.pins.out, a.pins[`in${i}`]!);
  }
  for (let i = 0; i < 8; i++) {
    const inb = makeButton(c, { x: 60, y: 340 + i * 36 }, 'toggle');
    inb.value = i % 2 === 1 ? 1 : 0;
    wire(c, inb.pins.out, b.pins[`in${i}`]!);
  }
  const oeA = makeButton(c, { x: 60, y: 660 }, 'toggle');
  const oeB = makeButton(c, { x: 140, y: 660 }, 'toggle');
  oeA.value = 1;
  oeB.value = 1; // both enabled → contention
  wire(c, oeA.pins.out, a.pins.oe!);
  wire(c, oeB.pins.out, b.pins.oe!);
  for (let i = 0; i < 8; i++) {
    wire(c, a.pins[`out${i}`]!, b.pins[`out${i}`]!);
    const led = makeLed(c, { x: 560, y: 40 + i * 40 }, `bus${i}`);
    wire(c, a.pins[`out${i}`]!, led.pins.in);
  }
  writeLab('lab-contend-bus', c, library);
}

cmosInverter();
nandGate();
halfAdder();
dLatch();
romDump();
xorPulse();
andFromLibrary();
labCounter7seg();
labSipo();
labDecoder();
labAnalyzer();
labComp();
labJk();
labPiso();
labMux();
labClkdiv();
labAdder4();
labCounterCascade();
labBuf8Oe();
labLatch8();
labReg8();
labEncoder();
labAlu4();
labAlu8();
labSoftRam();
labContendBus();
labMiniCpu();
