import { COMMAND_ROM_BYTES } from '../../src/machine/commandRom.js';
import { MachineRunner } from '../../src/machine/MachineRunner.js';
import { ChipLibrary } from '../../src/sim/ChipLibrary.js';
import { Circuit } from '../../src/sim/Circuit.js';
import { buildMinimalCpu, buildZ80Cpu } from '../../src/sim/blocks.js';
import { flatten } from '../../src/sim/hierarchy.js';
import { makeInput, wire } from '../../src/sim/library.js';
import { initialState, step } from '../../src/sim/solver.js';
import { seedStandardCells } from '../../src/sim/stdcells.js';
import type { Level, NetMap, Pin, SimState } from '../../src/sim/types.js';

/**
 * Reproducible solver benchmarks. Every scenario drives a real circuit through
 * the same one-`step()`-per-tick loop the app uses, and records per tick the
 * solver time, iterations, how many nets changed, and a digest of every net's
 * level. The digest is taken in `netMap` order, not by net id, so it does not
 * depend on the id counter of the process and stays comparable across solvers
 * that share `computeNets`.
 */

export interface TickRecord {
  stepMs: number;
  iterations: number;
  settled: boolean;
  /** Nets whose level differs from the previous tick. */
  changed: number;
  /** Order-independent-of-ids digest of all net levels after this tick. */
  digest: number;
}

export interface BenchResult {
  scenario: string;
  ticks: number;
  buildMs: number;
  flattenMs: number;
  nets: number;
  stepMs: { total: number; mean: number; median: number; p90: number };
  iterations: { mean: number; max: number; capped: number };
  changed: { median: number; p90: number; max: number };
  /** Digest of the whole run: all per-tick digests folded together. */
  chain: string;
  finalDigest: string;
  trace: string[];
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const LEVEL_CODE: Record<string, number> = { 0: 0, 1: 1, Z: 2 };

function fold(hash: number, value: number): number {
  return Math.imul(hash ^ (value & 0xff), FNV_PRIME) >>> 0;
}

function hex(n: number): string {
  return n.toString(16).padStart(8, '0');
}

/** A circuit being stepped one solver tick at a time, with per-tick records. */
export class TickSim {
  readonly records: TickRecord[] = [];
  flattenMs = 0;
  private state: SimState = initialState();
  private netMap!: NetMap;
  private prevLevels: Level[] | undefined;
  private netCount = 0;

  constructor(
    private readonly circuit: Circuit,
    private readonly library: ChipLibrary,
  ) {}

  get nets(): number {
    return this.netCount;
  }

  /** One solver tick: flatten (cached when unchanged), computeNets, one `step`. */
  tick(): TickRecord {
    const tFlat = performance.now();
    const flat = flatten(this.circuit, this.library);
    this.netMap = flat.computeNets();
    this.flattenMs += performance.now() - tFlat;

    const t = performance.now();
    this.state = step(flat, this.netMap, this.state);
    const stepMs = performance.now() - t;

    let digest = FNV_OFFSET;
    let changed = 0;
    const levels: Level[] = [];
    let i = 0;
    for (const netId of this.netMap.pinsOf.keys()) {
      const level = this.state.levelOf.get(netId) ?? 'Z';
      levels.push(level);
      digest = fold(digest, LEVEL_CODE[String(level)] ?? 2);
      if (this.prevLevels && this.prevLevels[i] !== level) changed++;
      i++;
    }
    this.netCount = levels.length;
    this.prevLevels = levels;

    const record: TickRecord = {
      stepMs,
      iterations: this.state.iterations,
      settled: this.state.settled,
      changed,
      digest,
    };
    this.records.push(record);
    return record;
  }

  /** Level of a pin after the latest tick (`Z` when unknown). */
  level(pin: Pin): Level {
    const net = this.netMap?.netOf.get(pin.id);
    return net ? (this.state.levelOf.get(net) ?? 'Z') : 'Z';
  }

  /** Little-endian integer from pins; undefined while any bit is not a concrete 0/1. */
  value(pins: Pin[]): number | undefined {
    let v = 0;
    for (let i = 0; i < pins.length; i++) {
      const level = this.level(pins[i]!);
      if (level !== 0 && level !== 1) return undefined;
      if (level === 1) v |= 1 << i;
    }
    return v;
  }
}

export interface ScenarioRun {
  sim: TickSim;
  /** Advance by at least one solver tick. */
  advance(): void;
  /** Lines describing what the circuit has done so far (PC per instruction, port values, ...). */
  trace(): string[];
}

export interface Scenario {
  name: string;
  description: string;
  defaultTicks: number;
  create(): { run: ScenarioRun; buildMs: number };
}

const TINY_PROGRAM = Uint8Array.of(0x01, 0xf0, 0x81, 0xf0, 0xe0);
const TINY_HOLD_TICKS = 3;
/** Ticks with every clock low before the first pulse, so the latches see a defined low level. */
const TINY_IDLE_TICKS = 2 * TINY_HOLD_TICKS;

function tinyCpuScenario(): { run: ScenarioRun; buildMs: number } {
  const t0 = performance.now();
  const library = new ChipLibrary();
  seedStandardCells(library);
  const parent = new Circuit();
  const cpu = buildMinimalCpu(parent, library, 4, TINY_PROGRAM);
  const reset = makeInput(parent, 1);
  const dataClk = makeInput(parent, 0);
  const phaseClk = makeInput(parent, 0);
  const fsmLoad = makeInput(parent, 1);
  wire(parent, reset.pins.out, cpu.reset);
  wire(parent, dataClk.pins.out, cpu.clk);
  wire(parent, phaseClk.pins.out, cpu.phaseClk);
  wire(parent, fsmLoad.pins.out, cpu.fsmLoad);
  const fsmD = [1, 0, 0].map((v, i) => {
    const d = makeInput(parent, v as 0 | 1);
    wire(parent, d.pins.out, cpu.fsmD[i]!);
    return d;
  });
  void fsmD;
  const sim = new TickSim(parent, library);
  const buildMs = performance.now() - t0;

  // Pulse k is phase for k = 0, data for k = 1, 2, then phase/data alternately.
  const pulseKind = (k: number): 'phase' | 'data' => (k === 0 ? 'phase' : k < 3 ? 'data' : (k - 3) % 2 === 0 ? 'phase' : 'data');
  const ports: string[] = [];
  let tickIndex = -TINY_IDLE_TICKS;
  const advance = (): void => {
    if (tickIndex < 0) {
      reset.value = 1;
      fsmLoad.value = 1;
      phaseClk.value = 0;
      dataClk.value = 0;
      sim.tick();
      tickIndex++;
      return;
    }
    const pulse = Math.floor(tickIndex / (2 * TINY_HOLD_TICKS));
    const high = tickIndex % (2 * TINY_HOLD_TICKS) < TINY_HOLD_TICKS ? 1 : 0;
    const kind = pulseKind(pulse);
    reset.value = pulse < 2 ? 1 : 0;
    fsmLoad.value = pulse === 0 ? 1 : 0;
    phaseClk.value = kind === 'phase' ? high : 0;
    dataClk.value = kind === 'data' ? high : 0;
    sim.tick();
    if (tickIndex % (2 * TINY_HOLD_TICKS) === 2 * TINY_HOLD_TICKS - 1 && pulse >= 3 && pulseKind(pulse) === 'data') {
      const pc = sim.value(cpu.pc);
      const out = sim.value(cpu.out);
      ports.push(`pc=${pc ?? '?'} out=${out ?? '?'}`);
    }
    tickIndex++;
  };
  return { run: { sim, advance, trace: () => ports }, buildMs };
}

const Z80_ADDR_BITS = 12;

function z80BootScenario(): { run: ScenarioRun; buildMs: number } {
  const t0 = performance.now();
  const library = new ChipLibrary();
  seedStandardCells(library);
  const circuit = new Circuit();
  const program = new Uint8Array(1 << Z80_ADDR_BITS);
  program.set(COMMAND_ROM_BYTES);
  const cpu = buildZ80Cpu(circuit, library, Z80_ADDR_BITS, program, { x: 0, y: 0 });
  const sim = new TickSim(circuit, library);
  const runner = new MachineRunner();
  runner.attach(circuit, library, cpu, () => void sim.tick(), { readPin: (pin) => {
    const level = sim.level(pin);
    return level === 1 ? 1 : level === 0 ? 0 : 'Z';
  } });
  runner.setSpeed('turbo');
  runner.boot();
  const buildMs = performance.now() - t0;

  const pcs: string[] = [];
  let phases = 0;
  const advance = (): void => {
    runner.stepPhase();
    phases++;
    if (phases % 10 === 0) pcs.push(`pc=${(sim.value(cpu.pc) ?? 0).toString(16).padStart(4, '0')}`);
  };
  return { run: { sim, advance, trace: () => pcs }, buildMs };
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'tiny-cpu',
    description: 'Tiny CPU (blinker program) clocked like the app: 3 ticks per clock level',
    defaultTicks: 600,
    create: tinyCpuScenario,
  },
  {
    name: 'z80-boot',
    description: 'Gate-level Z80 running the command monitor ROM through MachineRunner.stepPhase (4 ticks per phase)',
    defaultTicks: 120,
    create: z80BootScenario,
  },
];

function quantile(sorted: number[], q: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function runScenario(scenario: Scenario, ticks = scenario.defaultTicks): BenchResult {
  const { run, buildMs } = scenario.create();
  const initialTicks = run.sim.records.length;
  while (run.sim.records.length - initialTicks < ticks) run.advance();
  const records = run.sim.records.slice(initialTicks);

  const stepMs = records.map((r) => r.stepMs).sort((a, b) => a - b);
  const changed = records.slice(1).map((r) => r.changed).sort((a, b) => a - b);
  const totalStep = stepMs.reduce((a, b) => a + b, 0);
  let chain = FNV_OFFSET;
  for (const r of records) for (let shift = 0; shift < 32; shift += 8) chain = fold(chain, r.digest >>> shift);
  return {
    scenario: scenario.name,
    ticks: records.length,
    buildMs: Math.round(buildMs),
    flattenMs: Math.round(run.sim.flattenMs),
    nets: run.sim.nets,
    stepMs: {
      total: Math.round(totalStep),
      mean: Number((totalStep / records.length).toFixed(2)),
      median: Number(quantile(stepMs, 0.5).toFixed(2)),
      p90: Number(quantile(stepMs, 0.9).toFixed(2)),
    },
    iterations: {
      mean: Number((records.reduce((a, r) => a + r.iterations, 0) / records.length).toFixed(1)),
      max: Math.max(...records.map((r) => r.iterations)),
      capped: records.filter((r) => !r.settled).length,
    },
    changed: { median: quantile(changed, 0.5), p90: quantile(changed, 0.9), max: changed[changed.length - 1] ?? 0 },
    chain: hex(chain),
    finalDigest: hex(records[records.length - 1]!.digest),
    trace: run.trace(),
  };
}

/** Digest fields that must not change unless the solver's behaviour changes. */
export function behaviourOf(result: BenchResult): { ticks: number; chain: string; finalDigest: string; trace: string[] } {
  return { ticks: result.ticks, chain: result.chain, finalDigest: result.finalDigest, trace: result.trace };
}
