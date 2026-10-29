import { softLabDriveOutputs } from './softLab.js';
import type { SoftLabState } from './softLab.js';
import type { Level } from './types.js';

/**
 * The ordered solver engine.
 *
 * A tick evaluates only the groups whose inputs changed, in an order that follows
 * the gate dependency graph. The static channel-connected groups of nets are the
 * nodes (plus one node per RAM/ROM/Soft Lab device and one for supply hubs); an
 * edge runs from the group of a transistor's gate net to the group of its channel.
 * The graph has real loops (registers), so groups are ranked by a depth-first
 * reverse postorder: on the acyclic part a group is evaluated once per tick, after
 * the groups that drive its gates, and an edge that points backwards just makes the
 * later group evaluate again. A priority queue of dirty groups drives the tick and
 * each group commits in place.
 *
 * Inside a group the local components are built by walking conducting channels.
 * Nets with a constant driver and a large fan-out (the supplies) are "hubs": the
 * walk never passes through one, and a component that touches hubs is tied to
 * them. A hub forces only what its own drivers force, so a group tied to both
 * levels, or driven both ways, reads `Z` and is flagged `contended` on its own.
 *
 * A group may be evaluated `maxEvaluations` times per tick; one that needs more
 * keeps its pending work for the next tick and the tick is reported unsettled.
 *
 * Not handled here (the caller uses the dense solver): Soft to Gates POR overrides.
 */

export interface SolverTransistor {
  isN: boolean;
  gate: number;
  drain: number;
  source: number;
}

export interface SolverRam {
  oe: number;
  /** -1 for ROM. */
  we: number;
  addr: number[];
  data: number[];
  mem: { bytes: Uint8Array };
}

export interface SolverSoftChip {
  model: string;
  state: SoftLabState;
  pinNet: Record<string, number | undefined>;
  pinNames: string[];
}

export interface SolverStructure {
  netIds: string[];
  indexOf: Map<string, number>;
  transistors: SolverTransistor[];
  ramIdx: SolverRam[];
  softChips: SolverSoftChip[];
  /** `fixed` drivers (Sources) keep their value for the life of the structure. */
  driverPins: { netIdx: number; comp: { value: 0 | 1 }; fixed?: boolean }[];
}

export interface SolverRelaxed {
  levelOf: Map<string, Level>;
  contended: Set<string>;
  settled: boolean;
  iterations: number;
  levelAt: (netIdx: number) => Level;
}

const ZERO = 0;
const ONE = 1;
const Z = 2;
const LEVELS: Level[] = [0, 1, 'Z'];
const HISTORY_WINDOW = 16;
const WINDOW_FLIP_LIMIT = 5;
const NO_VALUE = 255;
/** Fewer channel connections than this and a driven net is cheaper to walk than to track. */
const HUB_MIN_DEGREE = 32;
/** Hub membership is a bit mask in an Int32. */
const MAX_HUBS = 30;

/**
 * Read-only `Map<netId, Level>` over a snapshot of one tick's levels. Building a
 * real Map of every net on every tick cost a quarter of the Z80 tick; callers
 * only look nets up by id, so the snapshot is a typed array copy plus the shared
 * id to index table.
 */
export class LevelView extends Map<string, Level> {
  constructor(
    private readonly indexOf: Map<string, number>,
    private readonly codes: Uint8Array,
  ) {
    super();
  }

  override get(netId: string): Level | undefined {
    const index = this.indexOf.get(netId);
    return index === undefined ? undefined : LEVELS[this.codes[index]!];
  }

  override has(netId: string): boolean {
    return this.indexOf.has(netId);
  }

  override get size(): number {
    return this.indexOf.size;
  }

  override set(): never {
    throw new Error('A solver level snapshot is read-only');
  }

  override delete(): never {
    throw new Error('A solver level snapshot is read-only');
  }

  override clear(): never {
    throw new Error('A solver level snapshot is read-only');
  }

  override *entries(): MapIterator<[string, Level]> {
    for (const [netId, index] of this.indexOf) yield [netId, LEVELS[this.codes[index]!]!];
  }

  override *keys(): MapIterator<string> {
    yield* this.indexOf.keys();
  }

  override *values(): MapIterator<Level> {
    for (const index of this.indexOf.values()) yield LEVELS[this.codes[index]!]!;
  }

  override [Symbol.iterator](): MapIterator<[string, Level]> {
    return this.entries();
  }

  override forEach(callback: (level: Level, netId: string, map: Map<string, Level>) => void): void {
    for (const [netId, level] of this.entries()) callback(level, netId, this);
  }
}

function code(level: Level | undefined): number {
  return level === 0 ? ZERO : level === 1 ? ONE : Z;
}

/** Level a forced-driver mask resolves to: bit0 = forced 0, bit1 = forced 1. */
function forcedLevel(mask: number): number {
  return mask === 1 ? ZERO : mask === 2 ? ONE : Z;
}

class Engine {
  readonly n: number;
  private readonly hubNets: number[] = [];
  /** Nets named VCC or GND are driven even when no source is wired to them. */
  private readonly implicitRails: number[] = [];
  private readonly hubOf: Int8Array;
  private readonly tIsN: Uint8Array;
  private readonly tGate: Int32Array;
  private readonly tDrain: Int32Array;
  private readonly tSource: Int32Array;
  private readonly gatedStart: Int32Array;
  private readonly gatedList: Int32Array;
  private readonly chanStart: Int32Array;
  private readonly chanList: Int32Array;

  private readonly cur: Uint8Array;
  private readonly conducts: Uint8Array;
  private readonly drv: Uint8Array;
  private readonly drvNew: Uint8Array;
  private readonly ext: Uint8Array;
  private readonly extCount0: Int32Array;
  private readonly extCount1: Int32Array;
  private readonly extStamp: Int32Array;
  private externalStamp = 0;
  /** RAM/ROM devices first, then Soft Lab chips. */
  private readonly deviceCount: number;
  private readonly deviceInputStart: Int32Array;
  private readonly deviceInputList: Int32Array;
  private readonly deviceDirty: Uint8Array;
  private readonly deviceNets: number[][] = [];
  private readonly deviceBits: number[][] = [];
  /** Drivers that can change between ticks, and the nets they sit on. */
  private readonly liveDrivers: SolverStructure['driverPins'];
  private readonly liveDrivenNets: Int32Array;
  /** What the fixed drivers and the implicit VCC/GND nets force, by net. */
  private readonly fixedDrv: Uint8Array;

  // Hub bookkeeping: which nets are tied to each hub, and what the hub's own drivers force.
  private readonly att: Int32Array;
  private readonly contrib: Uint8Array;
  private readonly cnt0: Int32Array;
  private readonly cnt1: Int32Array;
  private readonly list: Int32Array[] = [];
  private readonly pos: Int32Array;
  private readonly len: Int32Array;
  private readonly hubForced: Uint8Array;
  private readonly lastValue: Uint8Array;
  private readonly lastContended: Uint8Array;

  private readonly contFlag: Uint8Array;
  private readonly contSet = new Set<number>();

  private readonly visit: Int32Array;
  private stamp = 0;
  private readonly chgStamp: Int32Array;
  private readonly nxt: Uint8Array;
  private changed: number[] = [];

  private readonly hist: Uint8Array;
  private readonly histLen: Uint8Array;
  private readonly histStart: Uint8Array;
  private readonly flips: Uint8Array;
  private readonly gaveUp: Uint8Array;
  private readonly histTick: Int32Array;
  private tickNo = 0;

  // Scheduling: nodes are the static channel-connected groups, then the devices, then one node for hubs.
  private cccOf!: Int32Array;
  private cccCount = 0;
  private hubNode = 0;
  private nodeRank!: Int32Array;
  private nodeAtKey!: Int32Array;
  private heap!: Int32Array;
  private heapSize = 0;
  private queued!: Uint8Array;
  private seedHead!: Int32Array;
  private seedNext!: Int32Array;
  private seedFlag!: Uint8Array;
  private evalCount!: Int32Array;
  private deferred: number[] = [];
  private deferredFlag!: Uint8Array;

  lastLevelOf: Map<string, Level> | null = null;

  constructor(private readonly s: SolverStructure) {
    const n = s.netIds.length;
    this.n = n;
    const T = s.transistors.length;
    this.tIsN = new Uint8Array(T);
    this.tGate = new Int32Array(T);
    this.tDrain = new Int32Array(T);
    this.tSource = new Int32Array(T);
    const gatedCount = new Int32Array(n + 1);
    const chanCount = new Int32Array(n + 1);
    for (let t = 0; t < T; t++) {
      const x = s.transistors[t]!;
      this.tIsN[t] = x.isN ? 1 : 0;
      this.tGate[t] = x.gate;
      this.tDrain[t] = x.drain;
      this.tSource[t] = x.source;
      gatedCount[x.gate + 1]!++;
      if (x.drain !== x.source) {
        chanCount[x.drain + 1]!++;
        chanCount[x.source + 1]!++;
      }
    }
    for (let i = 0; i < n; i++) {
      gatedCount[i + 1]! += gatedCount[i]!;
      chanCount[i + 1]! += chanCount[i]!;
    }
    this.gatedStart = gatedCount;
    this.chanStart = chanCount;
    this.gatedList = new Int32Array(gatedCount[n]!);
    this.chanList = new Int32Array(chanCount[n]!);
    const gFill = new Int32Array(n);
    const cFill = new Int32Array(n);
    for (let t = 0; t < T; t++) {
      const g = this.tGate[t]!;
      this.gatedList[this.gatedStart[g]! + gFill[g]!++] = t;
      const d = this.tDrain[t]!;
      const so = this.tSource[t]!;
      if (d !== so) {
        this.chanList[this.chanStart[d]! + cFill[d]!++] = t;
        this.chanList[this.chanStart[so]! + cFill[so]!++] = t;
      }
    }

    const driven = new Uint8Array(n);
    for (const d of s.driverPins) driven[d.netIdx] = 1;
    for (let i = 0; i < n; i++) {
      if (s.netIds[i] !== 'VCC' && s.netIds[i] !== 'GND') continue;
      driven[i] = 1;
      this.implicitRails.push(i);
    }
    const degree = (i: number): number => chanCount[i + 1]! - chanCount[i]!;
    const candidates: number[] = [];
    for (let i = 0; i < n; i++) if (driven[i] && degree(i) >= HUB_MIN_DEGREE) candidates.push(i);
    candidates.sort((a, b) => degree(b) - degree(a));
    this.hubNets = candidates.slice(0, MAX_HUBS);
    this.hubOf = new Int8Array(n).fill(-1);
    this.hubNets.forEach((net, h) => (this.hubOf[net] = h));
    const K = this.hubNets.length;
    this.cnt0 = new Int32Array(K);
    this.cnt1 = new Int32Array(K);
    for (let h = 0; h < K; h++) this.list.push(new Int32Array(n));
    this.pos = new Int32Array(K * n).fill(-1);
    this.len = new Int32Array(K);
    this.hubForced = new Uint8Array(K);
    this.lastValue = new Uint8Array(K).fill(NO_VALUE);
    this.lastContended = new Uint8Array(K);

    const deviceInputs: number[][] = [];
    for (const r of s.ramIdx) deviceInputs.push([r.oe, ...(r.we >= 0 ? [r.we] : []), ...r.addr]);
    for (const sc of s.softChips) {
      deviceInputs.push(Object.values(sc.pinNet).filter((net): net is number => net !== undefined));
    }
    this.deviceCount = deviceInputs.length;
    const inputStart = new Int32Array(n + 1);
    for (const nets of deviceInputs) for (const net of new Set(nets)) inputStart[net + 1]!++;
    for (let i = 0; i < n; i++) inputStart[i + 1]! += inputStart[i]!;
    this.deviceInputStart = inputStart;
    this.deviceInputList = new Int32Array(inputStart[n]!);
    const inputFill = new Int32Array(n);
    deviceInputs.forEach((nets, device) => {
      for (const net of new Set(nets)) this.deviceInputList[inputStart[net]! + inputFill[net]!++] = device;
    });
    this.deviceDirty = new Uint8Array(this.deviceCount);
    for (let d = 0; d < this.deviceCount; d++) {
      this.deviceNets.push([]);
      this.deviceBits.push([]);
    }
    this.fixedDrv = new Uint8Array(n);
    for (const d of s.driverPins) if (d.fixed) this.fixedDrv[d.netIdx]! |= d.comp.value === 1 ? 2 : 1;
    for (const net of this.implicitRails) this.fixedDrv[net]! |= s.netIds[net] === 'VCC' ? 2 : 1;
    this.liveDrivers = s.driverPins.filter((d) => !d.fixed);
    this.liveDrivenNets = Int32Array.from(new Set(this.liveDrivers.map((d) => d.netIdx)));

    this.cur = new Uint8Array(n);
    this.conducts = new Uint8Array(T);
    this.drv = new Uint8Array(n);
    this.drvNew = new Uint8Array(n);
    this.ext = new Uint8Array(n);
    this.extCount0 = new Int32Array(n);
    this.extCount1 = new Int32Array(n);
    this.extStamp = new Int32Array(n);
    this.att = new Int32Array(n);
    this.contrib = new Uint8Array(n);
    this.contFlag = new Uint8Array(n);
    this.visit = new Int32Array(n);
    this.chgStamp = new Int32Array(n);
    this.nxt = new Uint8Array(n);
    this.hist = new Uint8Array(n * HISTORY_WINDOW);
    this.histLen = new Uint8Array(n);
    this.histStart = new Uint8Array(n);
    this.flips = new Uint8Array(n);
    this.gaveUp = new Uint8Array(n);
    this.histTick = new Int32Array(n);
    this.buildOrder();
  }

  /** Throw away all incremental state and start from `prevLevelOf`, evaluating every net. */
  private reseed(prevLevelOf: Map<string, Level>): void {
    const { n } = this;
    const ids = this.s.netIds;
    for (let i = 0; i < n; i++) this.cur[i] = code(prevLevelOf.get(ids[i]!));
    for (let t = 0; t < this.conducts.length; t++) this.conducts[t] = this.conductsNow(t);
    this.drv.set(this.fixedDrv);
    this.ext.fill(0);
    this.extCount0.fill(0);
    this.extCount1.fill(0);
    for (let d = 0; d < this.deviceCount; d++) {
      this.deviceNets[d]!.length = 0;
      this.deviceBits[d]!.length = 0;
    }
    this.att.fill(0);
    this.contrib.fill(0);
    this.cnt0.fill(0);
    this.cnt1.fill(0);
    this.pos.fill(-1);
    this.len.fill(0);
    this.lastValue.fill(NO_VALUE);
    this.lastContended.fill(0);
    this.contFlag.fill(0);
    this.contSet.clear();
    this.heapSize = 0;
    this.queued.fill(0);
    this.seedHead.fill(-1);
    this.seedFlag.fill(0);
    this.deferred.length = 0;
    this.deferredFlag.fill(0);
    for (let i = 0; i < n; i++) this.pushSeed(i);
  }

  private conductsNow(t: number): number {
    const level = this.cur[this.tGate[t]!]!;
    return this.tIsN[t] ? (level === ONE ? 1 : 0) : level === ZERO ? 1 : 0;
  }

  private refreshDrivers(): void {
    const { drvNew, drv, fixedDrv, liveDrivenNets } = this;
    for (const net of liveDrivenNets) drvNew[net] = fixedDrv[net]!;
    for (const d of this.liveDrivers) drvNew[d.netIdx]! |= d.comp.value === 1 ? 2 : 1;
    for (const net of liveDrivenNets) {
      if (drvNew[net] !== drv[net]) {
        drv[net] = drvNew[net]!;
        this.pushSeed(net);
      }
    }
  }

  /** Memory contents and Soft Lab state change between ticks, so every device is read again at the start of a tick. */
  private markAllDevicesDirty(): void {
    for (let d = 0; d < this.deviceCount; d++) {
      this.deviceDirty[d] = 1;
      this.enqueue(this.cccCount + d);
    }
  }

  private markDevicesReading(net: number): void {
    for (let k = this.deviceInputStart[net]!; k < this.deviceInputStart[net + 1]!; k++) {
      const device = this.deviceInputList[k]!;
      if (this.deviceDirty[device]) continue;
      this.deviceDirty[device] = 1;
      this.enqueue(this.cccCount + device);
    }
  }

  /** Re-read one RAM/ROM or Soft Lab chip and seed the nets whose forced value changed. */
  private refreshDevice(device: number): void {
    this.deviceDirty[device] = 0;
    this.externalStamp++;
    const touched: number[] = [];
    const nets = this.deviceNets[device]!;
    const bits = this.deviceBits[device]!;
    for (let i = 0; i < nets.length; i++) this.changeExternal(nets[i]!, bits[i]!, -1, touched);
    nets.length = 0;
    bits.length = 0;
    const emit = (net: number, bit: 0 | 1): void => {
      nets.push(net);
      bits.push(bit);
      this.changeExternal(net, bit, 1, touched);
    };
    const ramCount = this.s.ramIdx.length;
    if (device < ramCount) this.readMemory(this.s.ramIdx[device]!, emit);
    else this.driveSoftChip(this.s.softChips[device - ramCount]!, emit);
    for (const net of touched) {
      const forced = (this.extCount0[net]! > 0 ? 1 : 0) | (this.extCount1[net]! > 0 ? 2 : 0);
      if (forced === this.ext[net]) continue;
      this.ext[net] = forced;
      this.pushSeed(net);
    }
  }

  private changeExternal(net: number, bit: number, delta: 1 | -1, touched: number[]): void {
    if (bit === 1) this.extCount1[net]! += delta;
    else this.extCount0[net]! += delta;
    if (this.extStamp[net] === this.externalStamp) return;
    this.extStamp[net] = this.externalStamp;
    touched.push(net);
  }

  private readMemory(r: SolverRam, emit: (net: number, bit: 0 | 1) => void): void {
    const { cur } = this;
    if (cur[r.oe] !== ONE) return;
    if (r.we >= 0 && cur[r.we] === ONE) return;
    let addr = 0;
    for (let i = 0; i < r.addr.length; i++) {
      const level = cur[r.addr[i]!]!;
      if (level !== ZERO && level !== ONE) return;
      if (level === ONE) addr |= 1 << i;
    }
    const byte = r.mem.bytes[addr] ?? 0;
    for (let i = 0; i < r.data.length; i++) emit(r.data[i]!, ((byte >> i) & 1) as 0 | 1);
  }

  private driveSoftChip(sc: SolverSoftChip, emit: (net: number, bit: 0 | 1) => void): void {
    const pinLevels: Record<string, Level> = {};
    for (const name of sc.pinNames) {
      const idx = sc.pinNet[name];
      pinLevels[name] = idx !== undefined ? LEVELS[this.cur[idx]!]! : 'Z';
    }
    softLabDriveOutputs(sc.model, sc.pinNet, pinLevels, sc.state, emit);
  }

  private addToList(h: number, net: number): void {
    this.pos[h * this.n + net] = this.len[h]!;
    this.list[h]![this.len[h]!++] = net;
  }

  private removeFromList(h: number, net: number): void {
    const list = this.list[h]!;
    const base = h * this.n;
    const at = this.pos[base + net]!;
    const lastNet = list[--this.len[h]!]!;
    list[at] = lastNet;
    this.pos[base + lastNet] = at;
    this.pos[base + net] = -1;
  }

  /** Re-derive which hubs `net` is tied to; a hub net also keeps its own forcing up to date. */
  private retie(net: number, newAtt: number): number {
    const oldAtt = this.att[net]!;
    const newBits = this.drv[net]! | this.ext[net]!;
    const hub = this.hubOf[net]!;
    if (hub >= 0) {
      const oldBits = this.contrib[net]!;
      this.cnt0[hub]! += (newBits & 1) - (oldBits & 1);
      this.cnt1[hub]! += ((newBits >> 1) & 1) - ((oldBits >> 1) & 1);
    }
    for (let m = oldAtt & ~newAtt; m !== 0; m &= m - 1) this.removeFromList(31 - Math.clz32(m & -m), net);
    for (let m = newAtt & ~oldAtt; m !== 0; m &= m - 1) this.addToList(31 - Math.clz32(m & -m), net);
    this.att[net] = newAtt;
    this.contrib[net] = newBits;
    return newBits;
  }

  private setContended(net: number, flag: boolean): void {
    if (flag) {
      if (!this.contFlag[net]) {
        this.contFlag[net] = 1;
        this.contSet.add(net);
      }
    } else if (this.contFlag[net]) {
      this.contFlag[net] = 0;
      this.contSet.delete(net);
    }
  }

  private setNext(net: number, value: number): void {
    if (this.cur[net] === value) return;
    if (this.chgStamp[net] !== this.stamp) {
      this.chgStamp[net] = this.stamp;
      this.changed.push(net);
    }
    this.nxt[net] = value;
  }

  /** Rebuild the local components around `work`, re-tie them to the hubs and compute their next values. */
  private evaluate(work: number[]): void {
    const { conducts, chanStart, chanList, tDrain, tSource, visit, hubOf } = this;
    this.stamp++;
    this.changed = [];

    // Phase A: rebuild the local components around the dirty nets and re-tie them to the hubs.
    const members: number[] = [];
    const compEnd: number[] = [];
    const compForced: number[] = [];
    const compAtt: number[] = [];
    for (const seed of work) {
      const hub = hubOf[seed]!;
      if (hub >= 0) {
        this.retie(seed, 1 << hub);
        continue;
      }
      if (visit[seed] === this.stamp) continue;
      const start = members.length;
      visit[seed] = this.stamp;
      members.push(seed);
      let tied = 0;
      for (let q = start; q < members.length; q++) {
        const u = members[q]!;
        for (let k = chanStart[u]!; k < chanStart[u + 1]!; k++) {
          const t = chanList[k]!;
          if (!conducts[t]) continue;
          const v = tDrain[t] === u ? tSource[t]! : tDrain[t]!;
          const vHub = hubOf[v]!;
          if (vHub >= 0) tied |= 1 << vHub;
          else if (visit[v] !== this.stamp) {
            visit[v] = this.stamp;
            members.push(v);
          }
        }
      }
      let forced = 0;
      for (let q = start; q < members.length; q++) forced |= this.retie(members[q]!, tied);
      compEnd.push(members.length);
      compForced.push(forced);
      compAtt.push(tied);
    }

    // Phase B: a hub's own value, then each component from its hubs, its forced drivers or a hold vote.
    const { hubForced, lastValue, lastContended } = this;
    for (let h = 0; h < hubForced.length; h++) {
      const forced = (this.cnt0[h]! > 0 ? 1 : 0) | (this.cnt1[h]! > 0 ? 2 : 0);
      hubForced[h] = forced;
      const value = forcedLevel(forced);
      const contended = forced === 3 ? 1 : 0;
      if (value === lastValue[h] && contended === lastContended[h]) continue;
      lastValue[h] = value;
      lastContended[h] = contended;
      const list = this.list[h]!;
      for (let i = 0; i < this.len[h]!; i++) {
        const net = list[i]!;
        if (hubOf[net]! < 0) {
          this.addSeed(net);
        } else {
          this.setNext(net, value);
          this.setContended(net, contended === 1);
        }
      }
    }

    let begin = 0;
    for (let c = 0; c < compEnd.length; c++) {
      const end = compEnd[c]!;
      const tied = compAtt[c]!;
      let forced = compForced[c]!;
      for (let m = tied; m !== 0; m &= m - 1) forced |= hubForced[31 - Math.clz32(m & -m)]!;
      if (forced !== 0) {
        const value = forcedLevel(forced);
        for (let q = begin; q < end; q++) {
          this.setNext(members[q]!, value);
          this.setContended(members[q]!, forced === 3);
        }
      } else {
        this.holdVote(members, begin, end);
      }
      begin = end;
    }
  }

  /** Make the computed values current, then find what the new levels disturb. */
  private commit(): void {
    const { cur, conducts, tDrain, tSource, nxt, changed } = this;
    for (const net of changed) cur[net] = nxt[net]!;
    for (const net of changed) {
      this.addSeed(net);
      this.markDevicesReading(net);
      for (let k = this.gatedStart[net]!; k < this.gatedStart[net + 1]!; k++) {
        const t = this.gatedList[k]!;
        const nowConducts = this.conductsNow(t);
        if (nowConducts === conducts[t]) continue;
        conducts[t] = nowConducts;
        this.addSeed(tDrain[t]!);
        this.addSeed(tSource[t]!);
      }
    }
  }

  /** A component with no forced driver keeps the majority of its members' remembered levels. */
  private holdVote(members: number[], begin: number, end: number): void {
    const { cur, gaveUp, histTick } = this;
    let count0 = 0;
    let count1 = 0;
    for (let q = begin; q < end; q++) {
      const x = members[q]!;
      if (histTick[x] !== this.tickNo) this.resetHistory(x);
      if (gaveUp[x]) continue;
      if (cur[x] === ZERO) count0++;
      else if (cur[x] === ONE) count1++;
    }
    const value = count0 > count1 ? ZERO : count1 > count0 ? ONE : Z;

    let gaveUpNow = false;
    for (let q = begin; q < end; q++) {
      const x = members[q]!;
      if (this.recordHeld(x, value)) gaveUpNow = true;
      this.setNext(x, value);
      this.setContended(x, false);
    }
    // A member that gave up is left out of the next vote, which can change the value with no level changing.
    if (gaveUpNow) this.pushSeed(members[begin]!);
  }

  /** Oscillation damper: a floating net that flips more than a few times in a short window gives up voting. */
  private recordHeld(x: number, value: number): boolean {
    const { hist, histLen, histStart, flips, gaveUp } = this;
    const base = x * HISTORY_WINDOW;
    const gaveUpBefore = gaveUp[x]!;
    const length = histLen[x]!;
    if (length > 0) {
      const lastIdx = (histStart[x]! + length - 1) % HISTORY_WINDOW;
      if (hist[base + lastIdx] !== value) flips[x]!++;
    }
    if (length < HISTORY_WINDOW) {
      hist[base + ((histStart[x]! + length) % HISTORY_WINDOW)] = value;
      histLen[x] = length + 1;
    } else {
      const start = histStart[x]!;
      const evicted = hist[base + start]!;
      hist[base + start] = value;
      histStart[x] = (start + 1) % HISTORY_WINDOW;
      const nextOldest = hist[base + histStart[x]!]!;
      if (evicted !== nextOldest) flips[x] = Math.max(0, flips[x]! - 1);
    }
    if (flips[x]! > WINDOW_FLIP_LIMIT) gaveUp[x] = 1;
    return gaveUpBefore === 0 && gaveUp[x] === 1;
  }

  private resetHistory(x: number): void {
    this.histTick[x] = this.tickNo;
    this.histLen[x] = 0;
    this.histStart[x] = 0;
    this.flips[x] = 0;
    this.gaveUp[x] = 0;
  }

  /**
   * Rank the static channel-connected groups so that, on the acyclic part of the
   * circuit, a group is evaluated after the groups that drive its gates. The graph
   * has real loops (registers), so ranks come from a depth-first reverse postorder:
   * edges that point backwards simply cause the later group to be evaluated again.
   */
  private buildOrder(): void {
    const { n, s } = this;
    const { hubOf, tDrain, tSource, tGate } = this;
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    for (let t = 0; t < tDrain.length; t++) {
      const d = tDrain[t]!;
      const so = tSource[t]!;
      if (d !== so && hubOf[d]! < 0 && hubOf[so]! < 0) parent[find(d)] = find(so);
    }
    this.cccOf = new Int32Array(n).fill(-1);
    const idOfRoot = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (hubOf[i]! >= 0) continue;
      const root = find(i);
      if (idOfRoot[root]! < 0) idOfRoot[root] = this.cccCount++;
      this.cccOf[i] = idOfRoot[root]!;
    }
    const nodeCount = this.cccCount + this.deviceCount + 1;
    this.hubNode = nodeCount - 1;

    const edgeFrom: number[] = [];
    const edgeTo: number[] = [];
    const addEdge = (from: number, to: number): void => {
      if (from === to) return;
      edgeFrom.push(from);
      edgeTo.push(to);
    };
    for (let t = 0; t < tDrain.length; t++) {
      const channel = hubOf[tDrain[t]!]! < 0 ? tDrain[t]! : hubOf[tSource[t]!]! < 0 ? tSource[t]! : -1;
      const gate = tGate[t]!;
      if (channel >= 0 && hubOf[gate]! < 0) addEdge(this.cccOf[gate]!, this.cccOf[channel]!);
    }
    const ramCount = s.ramIdx.length;
    for (let d = 0; d < this.deviceCount; d++) {
      const node = this.cccCount + d;
      const inputs: number[] = d < ramCount
        ? [s.ramIdx[d]!.oe, ...(s.ramIdx[d]!.we >= 0 ? [s.ramIdx[d]!.we] : []), ...s.ramIdx[d]!.addr]
        : Object.values(s.softChips[d - ramCount]!.pinNet).filter((x): x is number => x !== undefined);
      const outputs: number[] = d < ramCount
        ? s.ramIdx[d]!.data
        : Object.values(s.softChips[d - ramCount]!.pinNet).filter((x): x is number => x !== undefined);
      for (const net of inputs) if (hubOf[net]! < 0) addEdge(this.cccOf[net]!, node);
      for (const net of outputs) if (hubOf[net]! < 0) addEdge(node, this.cccOf[net]!);
    }

    const adjStart = new Int32Array(nodeCount + 1);
    const indegree = new Int32Array(nodeCount);
    for (let e = 0; e < edgeFrom.length; e++) {
      adjStart[edgeFrom[e]! + 1]!++;
      indegree[edgeTo[e]!]!++;
    }
    for (let i = 0; i < nodeCount; i++) adjStart[i + 1]! += adjStart[i]!;
    const adj = new Int32Array(edgeFrom.length);
    const fill = new Int32Array(nodeCount);
    for (let e = 0; e < edgeFrom.length; e++) adj[adjStart[edgeFrom[e]!]! + fill[edgeFrom[e]!]!++] = edgeTo[e]!;

    const state = new Uint8Array(nodeCount);
    const postorder: number[] = [];
    const walk = (root: number): void => {
      const stackNode: number[] = [root];
      const stackNext: number[] = [adjStart[root]!];
      state[root] = 1;
      while (stackNode.length > 0) {
        const top = stackNode.length - 1;
        const v = stackNode[top]!;
        const k = stackNext[top]!;
        if (k < adjStart[v + 1]!) {
          stackNext[top] = k + 1;
          const w = adj[k]!;
          if (state[w] === 0) {
            state[w] = 1;
            stackNode.push(w);
            stackNext.push(adjStart[w]!);
          }
        } else {
          state[v] = 2;
          postorder.push(v);
          stackNode.pop();
          stackNext.pop();
        }
      }
    };
    for (let v = 0; v < nodeCount - 1; v++) if (indegree[v] === 0 && state[v] === 0) walk(v);
    for (let v = 0; v < nodeCount - 1; v++) if (state[v] === 0) walk(v);

    this.nodeRank = new Int32Array(nodeCount);
    this.nodeAtKey = new Int32Array(nodeCount + 1);
    postorder.forEach((node, i) => {
      const rank = postorder.length - 1 - i;
      this.nodeRank[node] = rank;
      this.nodeAtKey[rank + 1] = node;
    });
    this.nodeRank[this.hubNode] = -1;
    this.nodeAtKey[0] = this.hubNode;
    this.heap = new Int32Array(nodeCount + 1);
    this.queued = new Uint8Array(nodeCount);
    this.seedHead = new Int32Array(nodeCount).fill(-1);
    this.seedNext = new Int32Array(n);
    this.seedFlag = new Uint8Array(n);
    this.evalCount = new Int32Array(nodeCount);
    this.deferredFlag = new Uint8Array(nodeCount);
  }

  private heapPush(key: number): void {
    const { heap } = this;
    let i = this.heapSize++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up]! <= key) break;
      heap[i] = heap[up]!;
      i = up;
    }
    heap[i] = key;
  }

  private heapPop(): number {
    const { heap } = this;
    const top = heap[0]!;
    const last = heap[--this.heapSize]!;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.heapSize) break;
      if (child + 1 < this.heapSize && heap[child + 1]! < heap[child]!) child++;
      if (heap[child]! >= last) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = last;
    return top;
  }

  private enqueue(node: number): void {
    if (this.queued[node]) return;
    this.queued[node] = 1;
    this.heapPush(this.nodeRank[node]! + 1);
  }

  private pushSeed(net: number): void {
    if (this.seedFlag[net]) return;
    this.seedFlag[net] = 1;
    const node = this.hubOf[net]! >= 0 ? this.hubNode : this.cccOf[net]!;
    this.seedNext[net] = this.seedHead[node]!;
    this.seedHead[node] = net;
    this.enqueue(node);
  }

  private addSeed(net: number): void {
    if (this.hubOf[net]! < 0) this.pushSeed(net);
  }

  relax(prevLevelOf: Map<string, Level>, maxEvaluations: number): SolverRelaxed {
    this.tickNo++;
    if (prevLevelOf !== this.lastLevelOf) this.reseed(prevLevelOf);
    this.refreshDrivers();
    for (const node of this.deferred) {
      this.deferredFlag[node] = 0;
      this.enqueue(node);
    }
    this.deferred.length = 0;
    this.markAllDevicesDirty();
    this.evalCount.fill(0);

    let mostEvaluations = 1;
    let settled = true;
    const { cccCount } = this;
    while (this.heapSize > 0) {
      const node = this.nodeAtKey[this.heapPop()]!;
      this.queued[node] = 0;
      if (node >= cccCount && node !== this.hubNode) {
        const device = node - cccCount;
        if (this.deviceDirty[device]) this.refreshDevice(device);
        continue;
      }
      if (node !== this.hubNode) {
        if (this.evalCount[node]! >= maxEvaluations) {
          settled = false;
          if (!this.deferredFlag[node]) {
            this.deferredFlag[node] = 1;
            this.deferred.push(node);
          }
          continue;
        }
        const count = ++this.evalCount[node]!;
        if (count > mostEvaluations) mostEvaluations = count;
      }
      const seeds: number[] = [];
      for (let net = this.seedHead[node]!; net >= 0; net = this.seedNext[net]!) {
        seeds.push(net);
        this.seedFlag[net] = 0;
      }
      this.seedHead[node] = -1;
      this.evaluate(seeds);
      this.commit();
    }

    const levelOf = new LevelView(this.s.indexOf, this.cur.slice());
    const ids = this.s.netIds;
    const contended = new Set<string>();
    for (const net of this.contSet) contended.add(ids[net]!);
    this.lastLevelOf = levelOf;
    return { levelOf, contended, settled, iterations: mostEvaluations, levelAt: (i) => LEVELS[this.cur[i] ?? Z]! };
  }

  /** In shadow mode the dense solver's Map is the one handed back to the caller; follow it. */
  adopt(levelOf: Map<string, Level> | null): void {
    this.lastLevelOf = levelOf;
  }
}

const engines = new WeakMap<SolverStructure, Engine>();

function engineFor(structure: SolverStructure): Engine {
  let engine = engines.get(structure);
  if (!engine) {
    engine = new Engine(structure);
    engines.set(structure, engine);
  }
  return engine;
}

/** One tick from `prevLevelOf`; no group is evaluated more than `maxEvaluations` times. */
export function orderedRelax(structure: SolverStructure, prevLevelOf: Map<string, Level>, maxEvaluations: number): SolverRelaxed {
  return engineFor(structure).relax(prevLevelOf, maxEvaluations);
}

/** Make the engine continue from `levelOf` (shared with the caller), or from scratch when null. */
export function adoptLevelOf(structure: SolverStructure, levelOf: Map<string, Level> | null): void {
  engineFor(structure).adopt(levelOf);
}
