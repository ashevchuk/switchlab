/**
 * Built-in demo projects (same JSON shape as File → Export project).
 * Source files live in /examples/*.json for easy hand-editing; regenerate
 * with `npx vite-node scripts/gen-examples.ts` after changing builders.
 */

import type { SerializedProject } from '../sim/serialize.js';
import andGate from '../../examples/and-gate.json';
import cmosInverter from '../../examples/cmos-inverter.json';
import dLatch from '../../examples/d-latch.json';
import halfAdder from '../../examples/half-adder.json';
import labAdder4 from '../../examples/lab-adder4.json';
import labAlu4 from '../../examples/lab-alu4.json';
import labAlu8 from '../../examples/lab-alu8.json';
import labAnalyzer from '../../examples/lab-analyzer.json';
import labBuf8Oe from '../../examples/lab-buf8-oe.json';
import labClkdiv from '../../examples/lab-clkdiv.json';
import labComp from '../../examples/lab-comp.json';
import labContendBus from '../../examples/lab-contend-bus.json';
import labMiniCpu from '../../examples/lab-mini-cpu.json';
import labCounter7seg from '../../examples/lab-counter-7seg.json';
import labCounterCascade from '../../examples/lab-counter-cascade.json';
import labDecoder from '../../examples/lab-decoder.json';
import labEncoder from '../../examples/lab-encoder.json';
import labJk from '../../examples/lab-jk.json';
import labLatch8 from '../../examples/lab-latch8.json';
import labMux from '../../examples/lab-mux.json';
import labPiso from '../../examples/lab-piso.json';
import labReg8 from '../../examples/lab-reg8.json';
import labShiftCounter from '../../examples/lab-shift-counter.json';
import labSipo from '../../examples/lab-sipo.json';
import labSoftRam from '../../examples/lab-soft-ram.json';
import nandGate from '../../examples/nand-gate.json';
import romViewer from '../../examples/rom-viewer.json';
import xorPulse from '../../examples/xor-pulse.json';
import { buildTinyCpuBlinkProject } from './tinyCpuBlink.js';

export type ExampleGroup = 'Basics' | 'Soft Lab' | 'Memory';

export interface ExampleProject {
  id: string;
  title: string;
  detail: string;
  /** File → Demo → Digital section heading. */
  group: ExampleGroup;
  project: SerializedProject;
}

export const EXAMPLE_PROJECTS: ExampleProject[] = [
  {
    id: 'cmos-inverter',
    title: 'CMOS inverter',
    detail: 'Toggle → transistor NOT → LED',
    group: 'Basics',
    project: cmosInverter as SerializedProject,
  },
  {
    id: 'nand-gate',
    title: 'NAND (library chip)',
    detail: 'Two toggles → NAND stdcell → LED',
    group: 'Basics',
    project: nandGate as SerializedProject,
  },
  {
    id: 'and-gate',
    title: 'AND (library chip)',
    detail: 'Dive into a folded stdcell',
    group: 'Basics',
    project: andGate as SerializedProject,
  },
  {
    id: 'half-adder',
    title: 'Half adder',
    detail: 'A/B → sum & carry LEDs',
    group: 'Basics',
    project: halfAdder as SerializedProject,
  },
  {
    id: 'xor-pulse',
    title: 'XOR + pulse clock',
    detail: 'Toggle ⊕ free-running Pulse → LED',
    group: 'Basics',
    project: xorPulse as SerializedProject,
  },
  {
    id: 'd-latch',
    title: 'Latch walkthrough',
    detail: 'Tutorial: D + enable → Q / Qn — toggle D, pulse E, watch Q hold',
    group: 'Basics',
    project: dLatch as SerializedProject,
  },
  {
    id: 'lab-counter-7seg',
    title: 'Counter + 7-seg',
    detail: 'COUNTER4 (ce/clr/load) → BCD_7SEG → 7SEG with free-running pulse',
    group: 'Soft Lab',
    project: labCounter7seg as SerializedProject,
  },
  {
    id: 'lab-counter-cascade',
    title: 'Cascaded counters',
    detail: 'Two COUNTER4 with co→ce ripple + LEDs',
    group: 'Soft Lab',
    project: labCounterCascade as SerializedProject,
  },
  {
    id: 'lab-clkdiv',
    title: 'Clock ÷16',
    detail: 'CLK_DIV16 from COUNTER4 q3',
    group: 'Soft Lab',
    project: labClkdiv as SerializedProject,
  },
  {
    id: 'lab-jk',
    title: 'JK flip-flop',
    detail: 'JK_FF toggle (J=K=1) with free-running clock',
    group: 'Soft Lab',
    project: labJk as SerializedProject,
  },
  {
    id: 'lab-sipo',
    title: 'SIPO shift register',
    detail: 'SHIFT4_SIPO serial-in → four LEDs',
    group: 'Soft Lab',
    project: labSipo as SerializedProject,
  },
  {
    id: 'lab-piso',
    title: 'PISO shift register',
    detail: 'SHIFT4_PISO parallel load → serial LED',
    group: 'Soft Lab',
    project: labPiso as SerializedProject,
  },
  {
    id: 'lab-shift-counter',
    title: 'Shift + counter',
    detail: 'SHIFT4_SIPO feeding COUNTER4 — Soft Lab chain',
    group: 'Soft Lab',
    project: labShiftCounter as SerializedProject,
  },
  {
    id: 'lab-reg8',
    title: 'Octal register',
    detail: 'REG8 we+clk load → q LEDs',
    group: 'Soft Lab',
    project: labReg8 as SerializedProject,
  },
  {
    id: 'lab-latch8',
    title: 'Octal latch',
    detail: 'LATCH8 transparent when en=1',
    group: 'Soft Lab',
    project: labLatch8 as SerializedProject,
  },
  {
    id: 'lab-buf8-oe',
    title: 'Octal buffer (OE)',
    detail: 'BUF8 with output-enable → LEDs',
    group: 'Soft Lab',
    project: labBuf8Oe as SerializedProject,
  },
  {
    id: 'lab-mux',
    title: '8→1 mux',
    detail: 'MUX8_1 select among eight inputs',
    group: 'Soft Lab',
    project: labMux as SerializedProject,
  },
  {
    id: 'lab-decoder',
    title: '2→4 decoder',
    detail: 'Toggles + en → DECODER_2_4 → LEDs',
    group: 'Soft Lab',
    project: labDecoder as SerializedProject,
  },
  {
    id: 'lab-encoder',
    title: '8→3 priority encoder',
    detail: 'ENCODER_8_3 highest-in wins → y2..y0',
    group: 'Soft Lab',
    project: labEncoder as SerializedProject,
  },
  {
    id: 'lab-comp',
    title: '2-bit comparator',
    detail: 'COMP2 a/b → eq / gt / lt LEDs',
    group: 'Soft Lab',
    project: labComp as SerializedProject,
  },
  {
    id: 'lab-adder4',
    title: '4-bit adder',
    detail: 'ADDER4 with hex bus switches → sum + probe',
    group: 'Soft Lab',
    project: labAdder4 as SerializedProject,
  },
  {
    id: 'lab-alu4',
    title: '4-bit ALU',
    detail: 'ALU4 with hex bus switches → s + cout',
    group: 'Soft Lab',
    project: labAlu4 as SerializedProject,
  },
  {
    id: 'lab-alu8',
    title: '8-bit ALU',
    detail: 'ALU8 byte datapath → bus probe',
    group: 'Soft Lab',
    project: labAlu8 as SerializedProject,
  },
  {
    id: 'lab-soft-ram',
    title: 'Soft RAM 16×8',
    detail: 'SOFT_RAM16 write/read with Soft Lab',
    group: 'Soft Lab',
    project: labSoftRam as SerializedProject,
  },
  {
    id: 'lab-contend-bus',
    title: 'Bus contention',
    detail: 'Two BUF8 OE fight on one bus → contended nets',
    group: 'Soft Lab',
    project: labContendBus as SerializedProject,
  },
  {
    id: 'lab-mini-cpu',
    title: 'Mini nibble CPU',
    detail: 'PC + Soft RAM + ALU4 + REG8 Soft Lab datapath',
    group: 'Soft Lab',
    project: labMiniCpu as SerializedProject,
  },
  {
    id: 'tiny-cpu-blink',
    title: 'Tiny CPU blinker',
    detail: 'Folded Tiny CPU runs LDI/OUT/XRI/OUT/JMP from RAM — release RESET, OUT0 blinks',
    group: 'Memory',
    get project() {
      return buildTinyCpuBlinkProject();
    },
  },
  {
    id: 'lab-analyzer',
    title: 'Logic analyzer',
    detail: 'Buttons + pulse into an armed LA (edge trig on CLK)',
    group: 'Soft Lab',
    project: labAnalyzer as SerializedProject,
  },
  {
    id: 'rom-viewer',
    title: 'ROM viewer',
    detail: '256×8 ROM with Hello! — dblclick to hex-edit',
    group: 'Memory',
    project: romViewer as SerializedProject,
  },
];
