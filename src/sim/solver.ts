import { Circuit, currentStructureVersion } from './Circuit.js';
import { KEY_DATA, KEY_STATUS } from '../machine/memoryMap.js';
import {
  ensureSoftState,
  softLabCommitEdges,
  softLabDriveOutputs,
  fillSoftLabPorMasks,
  softLabPorActive,
  tickSoftLabPor,
} from './softLab.js';
import type { SoftLabState } from './softLab.js';
import { adoptLevelOf, eventRelax } from './eventSolver.js';
import type {
  ChipInstanceComponent,
  Level,
  NetMap,
  RamComponent,
  RomComponent,
  SimState,
} from './types.js';

/**
 * Switch-level relaxation solver.
 *
 * This is the "Real" engine: it does not treat any gate as a black box.
 * Every transistor is either conducting or not, based on its gate net's
 * *current* resolved level; conducting transistors tie their drain and
 * source nets together into one group. Any such group that is driven by
 * exactly one distinct forced level (from a `source` or `input` component,
 * VCC/GND included — they are just fixed sources) takes that level; a group
 * driven by two conflicting forced levels is a short, flagged as
 * `contended` rather than modeled as an analog voltage, which is outside
 * this simulator's scope.
 *
 * Because a transistor's own conduction can depend on a net whose value
 * depends on that same transistor (feedback — every latch is built this
 * way), one pass is not enough: we iterate, feeding each pass's resolved
 * levels back in as the next pass's gate inputs, until the whole netlist
 * stops changing (a fixpoint) or `maxIterations` is hit.
 *
 * A net with no forced driver in its group keeps its previous value — this
 * models the parasitic capacitance that lets a floating CMOS node
 * "remember" the last level it was driven to, which is exactly how an SR
 * latch built from cross-coupled transistors holds state with no dedicated
 * memory primitive. "Previous value" means a majority vote among every
 * group member's own remembered level, not an arbitrary member's — see the
 * fallback's own comment below for why a naive pick reliably corrupts a
 * live signal's history the first time an always-floating, never-driven
 * net happens to merge into its group.
 *
 * A group driven by two conflicting forced levels is `contended`, and
 * *always* resolves to `Z` immediately, never a vote — an actual short is
 * exactly the case a vote must not rescue with a concrete guess: this
 * project's own `ram.test.ts` and stub-ROM decoder tests both depend on
 * genuine contention reading as `Z` (0) on every single pass, not
 * whichever value's history happens to be more entrenched.
 *
 * RamComponent (see types.ts) is the one deliberate exception to "every
 * active device is a transistor" — see "Real RAM" in ARCHITECTURE.md for
 * why. Soft Lab chips (softLab.ts) are a second: when Soft Lab is on,
 * flatten keeps opaque labcell instances and this solver drives their
 * ports from behavioral models.
 *
 * Its read side plugs into this same per-iteration force-resolution as
 * an *additional conditional driver*, exactly like a transistor's
 * conduction: recomputed every pass from the current levels, because
 * whether it's actually driving (its `oe`) may itself still be settling.
 * Its write side (`applyRamWrites`) is fundamentally different — a `clk`
 * rising edge is a *fact about this tick relative to the previous one*, not
 * something a within-tick relaxation pass can discover — so it runs once,
 * after the loop below has already settled, comparing `prev`'s levels to
 * this call's final ones, and directly mutates the RAM component's own
 * `bytes` (the only side effect anywhere in this file; everything else
 * here computes a new SimState without touching the circuit).
 *
 * Hot-path shape: nets are indexed once per `step()` into dense parallel
 * arrays (levels, driver bitmasks, Int32Array union-find). Transistor pin
 * → net lookups happen once up front, not once per relaxation pass — on a
 * ~67k-transistor Z80 composite that alone was the difference between
 * ~670ms/tick and something tests can finish in a tolerable time.
 *
 * Across ticks on an unchanged netlist (the common case: flatten +
 * computeNets both hit their structure-version caches, only Input values
 * flip), the transistor/RAM index and union-find scratch buffers are
 * reused via a per-Circuit WeakMap — rebuilding ~67k pin→net lookups every
 * tick was still a measurable fraction of step time after the dense-array
 * rewrite. Driver bitmasks are refreshed every tick (Inputs change). When
 * the caller threads the previous `SimState` straight back in (harness /
 * editor tick loops), seeding `cur[]` also skips ~34k `Map.get`s by copying
 * the dense levels retained alongside that Map's identity.
 */

type TransistorIdx = { isN: boolean; gate: number; drain: number; source: number };
type RamIdx = {
  oe: number;
  /** -1 for ROM (no write enable — reads whenever OE=1). */
  we: number;
  addr: number[];
  data: number[];
  mem: RamComponent | RomComponent;
};
type SoftChipIdx = {
  chip: ChipInstanceComponent;
  model: string;
  state: SoftLabState;
  pinNet: Record<string, number | undefined>;
  pinNames: string[];
};

type StepStructureCache = {
  structureVersion: number;
  netMap: NetMap;
  netIds: string[];
  indexOf: Map<string, number>;
  transistors: TransistorIdx[];
  ramIdx: RamIdx[];
  rams: RamComponent[];
  softChips: SoftChipIdx[];
  driverPins: { netIdx: number; comp: { value: 0 | 1 }; fixed?: boolean }[];
  parent: Int32Array;
  rootOf: Int32Array;
  head: Int32Array;
  link: Int32Array;
  ramMask: Uint8Array;
  softMask: Uint8Array;
  driverMask: Uint8Array;
  /** Soft Lab → Gates POR overrides (1 = force this net index). */
  porLow: Uint8Array;
  porHigh: Uint8Array;
  hist: Level[];
  histLen: Uint8Array;
  histStart: Uint8Array;
  transitionsInWindow: Uint8Array;
  gaveUp: Uint8Array;
  cur: Level[];
  nxt: Level[];
  /** Identity of the `levelOf` Map last returned from `step` on this cache. */
  lastLevelOf: Map<string, Level> | null;
  /** Dense copy of that Map's levels, parallel to `netIds`. */
  lastLevels: Level[];
};

const stepStructureCache = new WeakMap<Circuit, StepStructureCache>();
const HISTORY_WINDOW = 16;
const WINDOW_FLIP_LIMIT = 5;

function getStepStructure(circuit: Circuit, netMap: NetMap): StepStructureCache {
  const version = currentStructureVersion();
  const hit = stepStructureCache.get(circuit);
  if (hit && hit.structureVersion === version && hit.netMap === netMap) return hit;

  const netIds = [...netMap.pinsOf.keys()];
  const n = netIds.length;
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(netIds[i]!, i);

  const transistors: TransistorIdx[] = [];
  const rams: RamComponent[] = [];
  const ramIdx: RamIdx[] = [];
  const softChips: SoftChipIdx[] = [];
  const driverPins: { netIdx: number; comp: { value: 0 | 1 }; fixed?: boolean }[] = [];

  for (const c of circuit.components.values()) {
    if (c.kind === 'source' || c.kind === 'input' || c.kind === 'button' || c.kind === 'clock') {
      const net = netMap.netOf.get(c.pins.out.id);
      if (!net) continue;
      const i = indexOf.get(net);
      if (i === undefined) continue;
      driverPins.push({ netIdx: i, comp: c, fixed: c.kind === 'source' });
    } else if (c.kind === 'busswitch') {
      for (let bit = 0; bit < c.bitWidth; bit++) {
        const p = c.pins[`b${bit}`];
        if (!p) continue;
        const net = netMap.netOf.get(p.id);
        if (!net) continue;
        const i = indexOf.get(net);
        if (i === undefined) continue;
        const bitIdx = bit;
        const switchComp = c;
        driverPins.push({
          netIdx: i,
          comp: {
            get value(): 0 | 1 {
              return ((switchComp.value >> bitIdx) & 1) as 0 | 1;
            },
          },
        });
      }
    } else if (c.kind === 'transistor') {
      const gate = indexOf.get(netMap.netOf.get(c.pins.gate.id)!);
      const drain = indexOf.get(netMap.netOf.get(c.pins.drain.id)!);
      const source = indexOf.get(netMap.netOf.get(c.pins.source.id)!);
      if (gate === undefined || drain === undefined || source === undefined) continue;
      transistors.push({ isN: c.type === 'N', gate, drain, source });
    } else if (c.kind === 'chip' && c.softModel && c.softState) {
      const pinNet: Record<string, number | undefined> = {};
      const pinNames: string[] = [];
      for (const [name, pin] of Object.entries(c.pins)) {
        pinNames.push(name);
        const net = netMap.netOf.get(pin.id);
        pinNet[name] = net !== undefined ? indexOf.get(net) : undefined;
      }
      softChips.push({
        chip: c,
        model: c.softModel,
        state: ensureSoftState(c, c.softModel),
        pinNet,
        pinNames,
      });
    } else if (c.kind === 'ram') {
      rams.push(c);
      const oeNet = netMap.netOf.get(c.pins.oe!.id);
      const weNet = netMap.netOf.get(c.pins.we!.id);
      const oe = oeNet !== undefined ? indexOf.get(oeNet) : undefined;
      const we = weNet !== undefined ? indexOf.get(weNet) : undefined;
      if (oe === undefined || we === undefined) continue;
      const addr: number[] = [];
      const data: number[] = [];
      let ok = true;
      for (let i = 0; i < c.addrBits; i++) {
        const net = netMap.netOf.get(c.pins[`addr${i}`]!.id);
        const idx = net !== undefined ? indexOf.get(net) : undefined;
        if (idx === undefined) {
          ok = false;
          break;
        }
        addr.push(idx);
      }
      for (let i = 0; i < c.dataBits; i++) {
        const net = netMap.netOf.get(c.pins[`data${i}`]!.id);
        const idx = net !== undefined ? indexOf.get(net) : undefined;
        if (idx === undefined) {
          ok = false;
          break;
        }
        data.push(idx);
      }
      if (ok) ramIdx.push({ oe, we, addr, data, mem: c });
    } else if (c.kind === 'rom') {
      const oeNet = netMap.netOf.get(c.pins.oe!.id);
      const oe = oeNet !== undefined ? indexOf.get(oeNet) : undefined;
      if (oe === undefined) continue;
      const addr: number[] = [];
      const data: number[] = [];
      let ok = true;
      for (let i = 0; i < c.addrBits; i++) {
        const net = netMap.netOf.get(c.pins[`addr${i}`]!.id);
        const idx = net !== undefined ? indexOf.get(net) : undefined;
        if (idx === undefined) {
          ok = false;
          break;
        }
        addr.push(idx);
      }
      for (let i = 0; i < c.dataBits; i++) {
        const net = netMap.netOf.get(c.pins[`data${i}`]!.id);
        const idx = net !== undefined ? indexOf.get(net) : undefined;
        if (idx === undefined) {
          ok = false;
          break;
        }
        data.push(idx);
      }
      if (ok) ramIdx.push({ oe, we: -1, addr, data, mem: c });
    }
  }

  const built: StepStructureCache = {
    structureVersion: version,
    netMap,
    netIds,
    indexOf,
    transistors,
    ramIdx,
    rams,
    softChips,
    driverPins,
    parent: new Int32Array(n),
    rootOf: new Int32Array(n),
    head: new Int32Array(n),
    link: new Int32Array(n),
    ramMask: new Uint8Array(n),
    softMask: new Uint8Array(n),
    driverMask: new Uint8Array(n),
    porLow: new Uint8Array(n),
    porHigh: new Uint8Array(n),
    hist: new Array<Level>(n * HISTORY_WINDOW),
    histLen: new Uint8Array(n),
    histStart: new Uint8Array(n),
    transitionsInWindow: new Uint8Array(n),
    gaveUp: new Uint8Array(n),
    cur: new Array(n),
    nxt: new Array(n),
    lastLevelOf: null,
    lastLevels: new Array(n),
  };
  stepStructureCache.set(circuit, built);
  return built;
}

/** Result of relaxing one tick, before the post-settle side effects. */
export interface Relaxed {
  levelOf: Map<string, Level>;
  contended: Set<string>;
  settled: boolean;
  iterations: number;
  /** Level of the net with this index (parallel to `getStepStructure(...).netIds`). */
  levelAt: (netIdx: number) => Level;
}

export type SolverEngine = 'jacobi' | 'event' | 'shadow' | 'ordered' | 'shadow-ordered';

let engine: SolverEngine = 'event';
if (typeof process !== 'undefined') {
  const requested = process.env.SOLVER_ENGINE;
  if (
    requested === 'jacobi' ||
    requested === 'event' ||
    requested === 'shadow' ||
    requested === 'ordered' ||
    requested === 'shadow-ordered'
  ) {
    engine = requested;
  }
}

export function setSolverEngine(next: SolverEngine): void {
  engine = next;
}

export function step(
  circuit: Circuit,
  netMap: NetMap,
  prev: SimState,
  maxIterations = 64,
): SimState {
  const cache = getStepStructure(circuit, netMap);
  return finishTick(cache, netMap, prev, relax(cache, netMap, prev, maxIterations));
}

/** POR overrides force nets; only the dense solver models them. */
function relax(cache: StepStructureCache, netMap: NetMap, prev: SimState, maxIterations: number): Relaxed {
  if (engine === 'jacobi' || softLabPorActive()) {
    return jacobiRelax(cache, netMap, prev, maxIterations);
  }
  if (engine === 'event') return eventRelax(cache, prev.levelOf, maxIterations);
  if (engine === 'ordered') return eventRelax(cache, prev.levelOf, maxIterations, true);
  if (engine === 'shadow-ordered') return shadowOrderedRelax(cache, prev, netMap, maxIterations);
  const fast = eventRelax(cache, prev.levelOf, maxIterations);
  const dense = jacobiRelax(cache, netMap, prev, maxIterations);
  assertSameRelaxation(cache, fast, dense);
  adoptLevelOf(cache, dense.levelOf);
  return dense;
}

/** Ticks the ordered engine was checked against, and ticks the dense reference could not settle. */
export const shadowOrderedStats = { compared: 0, skipped: 0, historyDependent: 0 };
const SHADOW_SETTLE_LIMIT = 4096;

/**
 * The ordered engine reaches the fixpoint in a different order than the dense one,
 * so only the settled result is comparable: the reference runs with a cap high
 * enough to settle, and a tick the reference cannot settle is not compared.
 */
function shadowOrderedRelax(cache: StepStructureCache, prev: SimState, netMap: NetMap, maxIterations: number): Relaxed {
  const fast = eventRelax(cache, prev.levelOf, maxIterations, true);
  const dense = jacobiRelax(cache, netMap, prev, SHADOW_SETTLE_LIMIT);
  if (!dense.settled) {
    shadowOrderedStats.skipped++;
    adoptLevelOf(cache, null, true);
    return dense;
  }
  shadowOrderedStats.compared++;
  assertSameRelaxation(cache, fast, dense, false);
  adoptLevelOf(cache, dense.levelOf, true);
  return dense;
}

const MISMATCH_REPORT_LIMIT = 8;

/**
 * Differences between the two engines that a floating node explains. A node in a group with
 * no forced driver holds whatever charge the transients left, which depends on evaluation
 * order; whatever that node gates, or is connected to, may then differ too. A difference
 * nothing upstream explains is a real divergence.
 */
function explainedByFloatingNodes(cache: StepStructureCache, dense: Relaxed, differing: Set<number>): Set<number> {
  const { netIds, transistors, driverMask, ramMask, softMask } = cache;
  const n = netIds.length;
  const touching: number[][] = Array.from({ length: n }, () => []);
  transistors.forEach((t, k) => {
    const level = dense.levelAt(t.gate);
    if (!(t.isN ? level === 1 : level === 0) || t.drain === t.source) return;
    touching[t.drain]!.push(k);
    touching[t.source]!.push(k);
  });
  const groupOf = new Int32Array(n).fill(-1);
  const groups: number[][] = [];
  const forcedGroup: boolean[] = [];
  for (let start = 0; start < n; start++) {
    if (groupOf[start]! >= 0) continue;
    const id = groups.length;
    const members = [start];
    groupOf[start] = id;
    let forced = false;
    for (let q = 0; q < members.length; q++) {
      const x = members[q]!;
      if (driverMask[x]! | ramMask[x]! | softMask[x]!) forced = true;
      for (const k of touching[x]!) {
        const t = transistors[k]!;
        const y = t.drain === x ? t.source : t.drain;
        if (groupOf[y]! < 0) {
          groupOf[y] = id;
          members.push(y);
        }
      }
    }
    groups.push(members);
    forcedGroup.push(forced);
  }
  const gatesOfGroup: number[][] = groups.map(() => []);
  for (const t of transistors) gatesOfGroup[groupOf[t.drain]!]!.push(t.gate);

  const explained = new Set<number>();
  const taintedGroups = new Set<number>();
  for (const i of differing) {
    if (forcedGroup[groupOf[i]!]) continue;
    explained.add(i);
    taintedGroups.add(groupOf[i]!);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of differing) {
      if (explained.has(i)) continue;
      const group = groupOf[i]!;
      if (taintedGroups.has(group) || gatesOfGroup[group]!.some((gate) => explained.has(gate))) {
        for (const member of groups[group]!) if (differing.has(member)) explained.add(member);
        taintedGroups.add(group);
        grew = true;
      }
    }
  }
  return explained;
}

function assertSameRelaxation(cache: StepStructureCache, fast: Relaxed, dense: Relaxed, compareIterations = true): void {
  const problems: string[] = [];
  if (compareIterations && fast.iterations !== dense.iterations) problems.push(`iterations ${fast.iterations} != ${dense.iterations}`);
  if (fast.settled !== dense.settled) problems.push(`settled ${fast.settled} != ${dense.settled}`);
  // A floating node keeps whatever charge the transients left it, which depends on evaluation order.
  // The ordered engine may leave such a node (and what it feeds) undefined where the dense one kept 0/1.
  const settledMode = !compareIterations;
  const differing = new Set<number>();
  for (let i = 0; i < cache.netIds.length; i++) {
    if (fast.levelAt(i) !== dense.levelAt(i) || fast.levelOf.get(cache.netIds[i]!) !== dense.levelOf.get(cache.netIds[i]!)) {
      differing.add(i);
    }
  }
  const explained = settledMode && differing.size > 0 ? explainedByFloatingNodes(cache, dense, differing) : new Set<number>();
  let levelMismatches = 0;
  let firstMismatch = -1;
  for (const i of differing) {
    const netId = cache.netIds[i]!;
    const f = fast.levelAt(i);
    const d = dense.levelAt(i);
    if (explained.has(i)) {
      shadowOrderedStats.historyDependent++;
      continue;
    }
    if (firstMismatch < 0) firstMismatch = i;
    if (levelMismatches++ < MISMATCH_REPORT_LIMIT) {
      problems.push(`net ${netId}: event ${f} (map ${fast.levelOf.get(netId)}), dense ${d}   [neighbours print dense/event]`);
    }
  }
  if (levelMismatches > MISMATCH_REPORT_LIMIT) problems.push(`... ${levelMismatches} nets differ in total`);
  if (firstMismatch >= 0) {
    const gatesByChannelNet = new Map<number, number[]>();
    for (const t of cache.transistors) {
      for (const end of [t.drain, t.source]) {
        const list = gatesByChannelNet.get(end) ?? [];
        list.push(t.gate);
        gatesByChannelNet.set(end, list);
      }
    }
    const roots = [...differing].filter(
      (i) => !explained.has(i) && !(gatesByChannelNet.get(i) ?? []).some((gate) => differing.has(gate)),
    );
    problems.push(`  ${roots.length} unexplained differences have no differing gate near them; first: ${roots.slice(0, 5).map((i) => `${cache.netIds[i]}=${dense.levelAt(i)}/${fast.levelAt(i)}`).join(', ')}`);
    const touching = cache.transistors.filter((t) => {
      const level = dense.levelAt(t.gate);
      return (t.isN ? level === 1 : level === 0) && t.drain !== t.source;
    });
    const group = [firstMismatch];
    const inGroup = new Set(group);
    for (let q = 0; q < group.length; q++) {
      for (const t of touching) {
        const other = t.drain === group[q] ? t.source : t.source === group[q] ? t.drain : -1;
        if (other >= 0 && !inGroup.has(other)) {
          inGroup.add(other);
          group.push(other);
        }
      }
    }
    const forcedMembers = group.filter((x) => cache.driverMask[x]! | cache.ramMask[x]! | cache.softMask[x]!);
    problems.push(
      `  dense group of ${cache.netIds[firstMismatch]}: ${group.length} nets, forced by ${forcedMembers.length}` +
        ` [${forcedMembers.slice(0, 4).map((x) => `${cache.netIds[x]}=${dense.levelAt(x)}/${fast.levelAt(x)}`).join(', ')}]` +
        `, ${group.filter((x) => fast.levelAt(x) !== dense.levelAt(x)).length} members differ`,
    );
    for (const t of cache.transistors) {
      if (t.drain !== firstMismatch && t.source !== firstMismatch && t.gate !== firstMismatch) continue;
      const name = (k: number): string => `${cache.netIds[k]}=${dense.levelAt(k)}/${fast.levelAt(k)}`;
      problems.push(`  ${t.isN ? 'N' : 'P'} gate ${name(t.gate)} drain ${name(t.drain)} source ${name(t.source)}`);
    }
  }
  const sameLevel = (id: string): boolean => {
    const index = cache.indexOf.get(id);
    return index === undefined || !differing.has(index);
  };
  const onlyFast = [...fast.contended].filter((id) => !dense.contended.has(id) && sameLevel(id));
  const onlyDense = [...dense.contended].filter((id) => !fast.contended.has(id) && sameLevel(id));
  if (onlyFast.length > 0) problems.push(`contended only in event: ${onlyFast.slice(0, MISMATCH_REPORT_LIMIT).join(', ')}`);
  if (onlyDense.length > 0) problems.push(`contended only in dense: ${onlyDense.slice(0, MISMATCH_REPORT_LIMIT).join(', ')}`);
  if (problems.length > 0) throw new Error(`Event solver diverged from the dense solver:\n${problems.join('\n')}`);
}

/** RAM writes, key-clear on read, Soft Lab edge commits and the POR counter: exactly once per tick. */
function finishTick(cache: StepStructureCache, netMap: NetMap, prev: SimState, r: Relaxed): SimState {
  applyRamWrites(cache.rams, netMap, prev.levelOf, r.levelOf);
  applyRamKeyClearOnRead(cache.rams, netMap, r.levelOf);
  applySoftLabEdges(cache.softChips, r.levelAt);
  tickSoftLabPor();
  return { levelOf: r.levelOf, contended: r.contended, settled: r.settled, iterations: r.iterations };
}

function jacobiRelax(cache: StepStructureCache, netMap: NetMap, prev: SimState, maxIterations: number): Relaxed {
  const {
    netIds,
    transistors,
    ramIdx,
    rams,
    softChips,
    driverPins,
    parent,
    rootOf,
    head,
    link,
    ramMask,
    softMask,
    driverMask,
    hist,
    histLen,
    histStart,
    transitionsInWindow,
    gaveUp,
  } = cache;
  const n = netIds.length;

  // Dense level buffers. Encoding stays Level (0|1|'Z') — the API contract
  // — but parallel arrays beat Map.get on every net, every pass.
  let cur = cache.cur;
  let nxt = cache.nxt;
  if (prev.levelOf === cache.lastLevelOf) {
    // Same Map object this cache handed out last tick — copy densified
    // levels instead of re-walking ~34k string keys.
    const prevLevels = cache.lastLevels;
    for (let i = 0; i < n; i++) cur[i] = prevLevels[i]!;
  } else {
    for (let i = 0; i < n; i++) cur[i] = prev.levelOf.get(netIds[i]!) ?? 'Z';
  }
  // Driver bitmask per net: bit0 = forced 0, bit1 = forced 1. Both bits set
  // is a short. Inputs can flip between ticks, so this is refreshed every
  // step from the cached pin list; RAM's own conditional drive is OR'd in
  // per pass below.
  driverMask.fill(0);
  for (const d of driverPins) driverMask[d.netIdx]! |= d.comp.value === 1 ? 2 : 1;
  // Implicit global rails: a net named VCC/GND is driven even with no Source
  // on the sheet (labels alone are enough to join and power that rail).
  for (let i = 0; i < n; i++) {
    const id = netIds[i]!;
    if (id === 'VCC') driverMask[i]! |= 2;
    else if (id === 'GND') driverMask[i]! |= 1;
  }

  // Soft Lab → Gates POR: dense override masks (by net index).
  const porLow = cache.porLow;
  const porHigh = cache.porHigh;
  fillSoftLabPorMasks(netMap.netOf, cache.indexOf, porLow, porHigh);

  // Oscillation bookkeeping is per-step (same semantics as a fresh buffer).
  histLen.fill(0);
  histStart.fill(0);
  transitionsInWindow.fill(0);
  gaveUp.fill(0);

  let contendedIdx = new Set<number>();
  let iterations = 0;
  let changed = true;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };

  while (changed && iterations < maxIterations) {
    iterations += 1;

    for (let i = 0; i < n; i++) parent[i] = i;
    for (const t of transistors) {
      const gateLevel = cur[t.gate];
      const conducts = t.isN ? gateLevel === 1 : gateLevel === 0;
      if (!conducts) continue;
      const ra = find(t.drain);
      const rb = find(t.source);
      if (ra !== rb) parent[ra] = rb;
    }

    // RAM read forces for this pass — same conditional-driver role as a
    // conducting transistor, recomputed every iteration.
    ramMask.fill(0);
    for (const r of ramIdx) {
      if (cur[r.oe] !== 1) continue;
      // RAM suppresses OE drive while WE is asserted; ROM has we === -1.
      if (r.we >= 0 && cur[r.we] === 1) continue;
      let addr = 0;
      let resolved = true;
      for (let i = 0; i < r.addr.length; i++) {
        const lvl = cur[r.addr[i]!];
        if (lvl !== 0 && lvl !== 1) {
          resolved = false;
          break;
        }
        if (lvl === 1) addr |= 1 << i;
      }
      if (!resolved) continue;
      const byte = r.mem.bytes[addr] ?? 0;
      for (let i = 0; i < r.data.length; i++) {
        const bit = ((byte >> i) & 1) as 0 | 1;
        ramMask[r.data[i]!]! |= bit === 1 ? 2 : 1;
      }
    }

    // Soft Lab behavioral drives for this pass.
    softMask.fill(0);
    for (const sc of softChips) {
      const pinLevels: Record<string, Level> = {};
      for (const name of sc.pinNames) {
        const idx = sc.pinNet[name];
        pinLevels[name] = idx !== undefined ? (cur[idx] ?? 'Z') : 'Z';
      }
      softLabDriveOutputs(sc.model, sc.pinNet, pinLevels, sc.state, (netIdx, bit) => {
        softMask[netIdx]! |= bit === 1 ? 2 : 1;
      });
    }

    for (let i = 0; i < n; i++) rootOf[i] = find(i);
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const r = rootOf[i]!;
      link[i] = head[r]!;
      head[r] = i;
    }

    const nextContended = new Set<number>();
    for (let r = 0; r < n; r++) {
      let m = head[r]!;
      if (m < 0) continue;

      // Collect forced mask across the group (drivers ∪ RAM ∪ Soft Lab).
      let forced = 0;
      for (let x = m; x >= 0; x = link[x]!) {
        forced |= driverMask[x]! | ramMask[x]! | softMask[x]!;
      }

      let value: Level;
      if (forced === 1) {
        value = 0;
      } else if (forced === 2) {
        value = 1;
      } else if (forced === 3) {
        // Two genuinely conflicting drivers — unconditional Z, no vote.
        // See the long comment in the previous Map-based implementation;
        // the semantics here are identical.
        value = 'Z';
        for (let x = m; x >= 0; x = link[x]!) nextContended.add(x);
      } else {
        // forced === 0: capacitive hold via majority vote among remembered
        // non-Z members (excluding proven oscillators).
        let soleValue: Level | undefined;
        let soleCount = 0;
        let count0 = 0;
        let count1 = 0;
        let multi = false;
        for (let x = m; x >= 0; x = link[x]!) {
          if (gaveUp[x]) continue;
          const v = cur[x];
          if (v === undefined || v === 'Z') continue;
          if (!multi) {
            if (soleValue === undefined) {
              soleValue = v;
              soleCount = 1;
            } else if (v === soleValue) {
              soleCount++;
            } else {
              multi = true;
              count0 = soleValue === 0 ? soleCount : 0;
              count1 = soleValue === 1 ? soleCount : 0;
              if (v === 0) count0++;
              else count1++;
            }
          } else if (v === 0) {
            count0++;
          } else {
            count1++;
          }
        }
        if (!multi) {
          value = soleValue ?? 'Z';
        } else if (count0 > count1) {
          value = 0;
        } else if (count1 > count0) {
          value = 1;
        } else {
          value = 'Z';
        }

        // Oscillation bookkeeping — circular buffer, no Array.shift().
        for (let x = m; x >= 0; x = link[x]!) {
          const len = histLen[x]!;
          if (len > 0) {
            const lastIdx = (histStart[x]! + len - 1) % HISTORY_WINDOW;
            const prevH = hist[x * HISTORY_WINDOW + lastIdx];
            if (prevH !== undefined && prevH !== value) {
              transitionsInWindow[x]!++;
            }
          }
          if (len < HISTORY_WINDOW) {
            hist[x * HISTORY_WINDOW + ((histStart[x]! + len) % HISTORY_WINDOW)] = value;
            histLen[x] = len + 1;
          } else {
            const start = histStart[x]!;
            const evicted = hist[x * HISTORY_WINDOW + start];
            hist[x * HISTORY_WINDOW + start] = value;
            histStart[x] = (start + 1) % HISTORY_WINDOW;
            const nextOldest = hist[x * HISTORY_WINDOW + histStart[x]!];
            if (nextOldest !== undefined && evicted !== nextOldest) {
              transitionsInWindow[x] = Math.max(0, transitionsInWindow[x]! - 1);
            }
          }
          if (transitionsInWindow[x]! > WINDOW_FLIP_LIMIT) gaveUp[x] = 1;
        }
      }

      // Soft→Gates POR wins over drivers/hold so FF Q nets leave Z without
      // pulsing the user's CLR button (which would contend if forced as a driver).
      let por: Level | undefined;
      for (let x = m; x >= 0; x = link[x]!) {
        if (porLow[x]) por = 0;
        else if (porHigh[x]) por = 1;
      }
      if (por !== undefined) value = por;

      for (let x = m; x >= 0; x = link[x]!) nxt[x] = value;
    }

    changed = false;
    for (let i = 0; i < n; i++) {
      if (cur[i] !== nxt[i]) {
        changed = true;
        break;
      }
    }
    const swap = cur;
    cur = nxt;
    nxt = swap;
    contendedIdx = nextContended;
  }

  const levelOf = new Map<string, Level>();
  const lastLevels = cache.lastLevels;
  for (let i = 0; i < n; i++) {
    const v = cur[i]!;
    levelOf.set(netIds[i]!, v);
    lastLevels[i] = v;
  }
  cache.lastLevelOf = levelOf;
  const contended = new Set<string>();
  for (const i of contendedIdx) contended.add(netIds[i]!);

  return { levelOf, contended, settled: !changed, iterations, levelAt: (i) => cur[i] ?? 'Z' };
}

function applySoftLabEdges(softChips: SoftChipIdx[], levelAt: (netIdx: number) => Level): void {
  for (const sc of softChips) {
    const pinLevels: Record<string, Level> = {};
    for (const name of sc.pinNames) {
      const idx = sc.pinNet[name];
      pinLevels[name] = idx !== undefined ? levelAt(idx) : 'Z';
    }
    softLabCommitEdges(sc.model, pinLevels, sc.state);
  }
}

function netLevel(netMap: NetMap, levelOf: Map<string, Level>, pinId: string): Level | undefined {
  const net = netMap.netOf.get(pinId);
  return net ? levelOf.get(net) : undefined;
}

/** The address this pass's `levelOf` resolves to, or undefined if any address bit isn't concretely 0/1 yet. */
function resolvedAddr(ram: RamComponent, netMap: NetMap, levelOf: Map<string, Level>): number | undefined {
  let addr = 0;
  for (let i = 0; i < ram.addrBits; i++) {
    const lvl = netLevel(netMap, levelOf, ram.pins[`addr${i}`]!.id);
    if (lvl !== 0 && lvl !== 1) return undefined;
    if (lvl === 1) addr |= 1 << i;
  }
  return addr;
}

/**
 * RAM's write side: a `clk` 0/unset -> 1 transition between `prev` (the
 * level going *into* this tick) and `settled` (this tick's final level) —
 * checked once, after relaxation, not per-iteration, because "did an edge
 * just happen" is a fact about two different ticks, not something a single
 * tick's own fixpoint search can discover. On such an edge, if `we=1` and
 * the address is fully resolved, this tick's settled data-pin levels are
 * captured into `bytes[addr]` — an unresolved (floating) data bit writes as
 * 0 rather than aborting the whole write, since "the bus wasn't fully
 * driven at write time" is a real, if sloppy, situation a byte array still
 * has to end up holding *some* concrete value for.
 *
 * This mutates each RamComponent's own `bytes` directly — the only place in
 * this file that mutates the circuit rather than computing a fresh SimState
 * from it. It only matters because `bytes` is the one piece of component
 * state that has to outlive a single `step()` call (see flatten()'s own
 * doc comment for why that's not automatic here).
 */
function applyRamWrites(rams: RamComponent[], netMap: NetMap, prev: Map<string, Level>, settled: Map<string, Level>): void {
  for (const ram of rams) {
    const prevClk = netLevel(netMap, prev, ram.pins.clk!.id) ?? 0;
    const newClk = netLevel(netMap, settled, ram.pins.clk!.id);
    if (prevClk === 1 || newClk !== 1) continue; // no rising edge this tick
    if (netLevel(netMap, settled, ram.pins.we!.id) !== 1) continue;
    const addr = resolvedAddr(ram, netMap, settled);
    if (addr === undefined) continue;

    let byte = 0;
    for (let i = 0; i < ram.dataBits; i++) {
      if (netLevel(netMap, settled, ram.pins[`data${i}`]!.id) === 1) byte |= 1 << i;
    }
    ram.bytes[addr] = byte;
  }
}

/**
 * Gate-path clear-on-read for keyboard MMIO: when OE is driving a resolved
 * read of KEY_DATA (and WE is not asserted), clear KEY_STATUS — same side
 * effect softZ80 SoftMemHooks provide. Called once after settle so address
 * flicker during relaxation does not spuriously clear.
 */
export function applyRamKeyClearOnRead(
  rams: RamComponent[],
  netMap: NetMap,
  settled: Map<string, Level>,
): void {
  for (const ram of rams) {
    if (netLevel(netMap, settled, ram.pins.oe!.id) !== 1) continue;
    if (netLevel(netMap, settled, ram.pins.we!.id) === 1) continue;
    const addr = resolvedAddr(ram, netMap, settled);
    if (addr === undefined) continue;
    clearKeyStatusOnDataRead(ram.bytes, addr);
  }
}

/**
 * If `addr` is KEY_DATA, clear KEY_STATUS in `bytes`. Exported for unit tests
 * and shared with the gate solver's post-settle MMIO hook.
 */
export function clearKeyStatusOnDataRead(bytes: Uint8Array, addr: number): void {
  if (addr !== KEY_DATA) return;
  if (KEY_STATUS >= bytes.length) return;
  bytes[KEY_STATUS] = 0;
}

export function initialState(): SimState {
  return { levelOf: new Map(), contended: new Set(), settled: true, iterations: 0 };
}
