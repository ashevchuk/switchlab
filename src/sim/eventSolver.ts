import { softLabDriveOutputs } from './softLab.js';
import type { SoftLabState } from './softLab.js';
import type { Level } from './types.js';

/**
 * Event-driven version of the relaxation in solver.ts.
 *
 * It is the same synchronous (Jacobi) iteration, but each pass only evaluates
 * the groups whose inputs changed in the pass before. Starting from the same
 * levels it must reach the same levels in the same number of passes, the same
 * `settled` flag and the same `contended` set as the dense solver; shadow mode
 * checks that on every tick.
 *
 * The dense solver merges nets through every conducting transistor, supplies
 * included. A supply net with thousands of pull-ups would make every pass walk
 * one huge group, so nets with a constant driver and a large fan-out are "hubs":
 * a local component is built by walking conducting channels but never through a
 * hub, and a component that touches hubs is tied to them. Each hub keeps counts
 * of the forced values its tied nets contribute. Hubs joined by a conducting path
 * form one class, and a class forced both ways makes every net tied to it `Z`,
 * exactly as the single merged group does in the dense solver.
 *
 * Not handled here (the caller falls back to the dense solver): Soft to Gates
 * POR overrides.
 */

export interface EventTransistor {
  isN: boolean;
  gate: number;
  drain: number;
  source: number;
}

export interface EventRam {
  oe: number;
  /** -1 for ROM. */
  we: number;
  addr: number[];
  data: number[];
  mem: { bytes: Uint8Array };
}

export interface EventSoftChip {
  model: string;
  state: SoftLabState;
  pinNet: Record<string, number | undefined>;
  pinNames: string[];
}

export interface EventStructure {
  netIds: string[];
  indexOf: Map<string, number>;
  transistors: EventTransistor[];
  ramIdx: EventRam[];
  softChips: EventSoftChip[];
  /** `fixed` drivers (Sources) keep their value for the life of the structure. */
  driverPins: { netIdx: number; comp: { value: 0 | 1 }; fixed?: boolean }[];
}

export interface EventRelaxed {
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
  private readonly tHubMask: Int32Array;
  private readonly tIsN: Uint8Array;
  private readonly tGate: Int32Array;
  private readonly tDrain: Int32Array;
  private readonly tSource: Int32Array;
  private readonly gatedStart: Int32Array;
  private readonly gatedList: Int32Array;
  private readonly chanStart: Int32Array;
  private readonly chanList: Int32Array;
  private readonly hubShorts: Int32Array;

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
  private dirtyDevices: number[] = [];
  private readonly deviceNets: number[][] = [];
  private readonly deviceBits: number[][] = [];
  /** Drivers that can change between ticks, and the nets they sit on. */
  private readonly liveDrivers: EventStructure['driverPins'];
  private readonly liveDrivenNets: Int32Array;
  /** What the fixed drivers and the implicit VCC/GND nets force, by net. */
  private readonly fixedDrv: Uint8Array;

  // Hub bookkeeping: which nets are tied to each hub, and what they force on it.
  private readonly att: Int32Array;
  private readonly contrib: Uint8Array;
  private readonly cnt0: Int32Array;
  private readonly cnt1: Int32Array;
  private readonly list: Int32Array[] = [];
  private readonly pos: Int32Array;
  private readonly len: Int32Array;
  /** Reference counts of the hub sets that some net or conducting channel joins (two or more hubs). */
  private readonly links = new Map<number, number>();
  private linksDirty = true;
  private readonly hubClass: Int8Array;
  private readonly classBits: Uint8Array;
  private readonly hubValue: Uint8Array;
  private readonly hubContended: Uint8Array;
  private readonly lastValue: Uint8Array;
  private readonly lastContended: Uint8Array;

  private readonly contFlag: Uint8Array;
  private readonly contSet = new Set<number>();

  private pending: number[] = [];
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
  /** Pass of the last history entry, so passes that skipped a floating net can be replayed. */
  private readonly lastPass: Int32Array;
  /** 1 while the net's group is held by capacitance (the dense solver records history for it on every pass). */
  private readonly floating: Uint8Array;
  private passNo = 0;
  private tickNo = 0;

  // Ordered mode: nodes are the static channel-connected groups, then the devices, then one node for hubs.
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

  constructor(
    private readonly s: EventStructure,
    private readonly ordered = false,
  ) {
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
    this.tHubMask = new Int32Array(T);
    const shorts: number[] = [];
    for (let t = 0; t < T; t++) {
      const ha = this.hubOf[this.tDrain[t]!]!;
      const hb = this.hubOf[this.tSource[t]!]!;
      if (ha >= 0 && hb >= 0 && ha !== hb) {
        this.tHubMask[t] = (1 << ha) | (1 << hb);
        shorts.push(t);
      }
    }
    this.hubShorts = Int32Array.from(shorts);
    this.cnt0 = new Int32Array(K);
    this.cnt1 = new Int32Array(K);
    for (let h = 0; h < K; h++) this.list.push(new Int32Array(n));
    this.pos = new Int32Array(K * n).fill(-1);
    this.len = new Int32Array(K);
    this.hubClass = new Int8Array(K);
    this.classBits = new Uint8Array(K);
    this.hubValue = new Uint8Array(K);
    this.hubContended = new Uint8Array(K);
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
    this.lastPass = new Int32Array(n);
    this.floating = new Uint8Array(n);
    if (ordered) this.buildOrder();
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
    this.floating.fill(0);
    this.contFlag.fill(0);
    this.contSet.clear();
    this.links.clear();
    this.linksDirty = true;
    if (!this.ordered) for (const t of this.hubShorts) if (this.conducts[t]) this.linkAdd(this.tHubMask[t]!);
    this.pending = [];
    for (let i = 0; i < n; i++) this.pending.push(i);
    if (this.ordered) {
      this.heapSize = 0;
      this.queued.fill(0);
      this.seedHead.fill(-1);
      this.seedFlag.fill(0);
      this.deferred.length = 0;
      this.deferredFlag.fill(0);
    }
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
        this.pending.push(net);
      }
    }
  }

  /** Memory contents and Soft Lab state change between ticks, so every device is read again at the start of a tick. */
  private markAllDevicesDirty(): void {
    this.dirtyDevices = [];
    for (let d = 0; d < this.deviceCount; d++) {
      this.deviceDirty[d] = 1;
      if (this.ordered) this.enqueue(this.cccCount + d);
      else this.dirtyDevices.push(d);
    }
  }

  private markDevicesReading(net: number): void {
    for (let k = this.deviceInputStart[net]!; k < this.deviceInputStart[net + 1]!; k++) {
      const device = this.deviceInputList[k]!;
      if (this.deviceDirty[device]) continue;
      this.deviceDirty[device] = 1;
      if (this.ordered) this.enqueue(this.cccCount + device);
      else this.dirtyDevices.push(device);
    }
  }

  /** RAM/ROM read forces and Soft Lab chip outputs, re-read only for devices whose inputs changed. */
  private refreshExternal(work: number[]): void {
    const dirty = this.dirtyDevices;
    this.dirtyDevices = [];
    if (dirty.length === 0) return;
    const touched: number[] = [];
    this.externalStamp++;
    const ramCount = this.s.ramIdx.length;
    for (const device of dirty) {
      this.deviceDirty[device] = 0;
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
      if (device < ramCount) this.readMemory(this.s.ramIdx[device]!, emit);
      else this.driveSoftChip(this.s.softChips[device - ramCount]!, emit);
    }
    for (const net of touched) {
      const forced = (this.extCount0[net]! > 0 ? 1 : 0) | (this.extCount1[net]! > 0 ? 2 : 0);
      if (forced === this.ext[net]) continue;
      this.ext[net] = forced;
      work.push(net);
    }
  }

  private changeExternal(net: number, bit: number, delta: 1 | -1, touched: number[]): void {
    if (bit === 1) this.extCount1[net]! += delta;
    else this.extCount0[net]! += delta;
    if (this.extStamp[net] === this.externalStamp) return;
    this.extStamp[net] = this.externalStamp;
    touched.push(net);
  }

  private readMemory(r: EventRam, emit: (net: number, bit: 0 | 1) => void): void {
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

  private driveSoftChip(sc: EventSoftChip, emit: (net: number, bit: 0 | 1) => void): void {
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

  private linkAdd(mask: number): void {
    this.links.set(mask, (this.links.get(mask) ?? 0) + 1);
    this.linksDirty = true;
  }

  private linkRemove(mask: number): void {
    const left = this.links.get(mask)! - 1;
    if (left === 0) this.links.delete(mask);
    else this.links.set(mask, left);
    this.linksDirty = true;
  }

  /** Re-derive what `net` contributes to the hubs it is tied to. */
  private retie(net: number, newAtt: number): number {
    const oldAtt = this.att[net]!;
    const newBits = this.drv[net]! | this.ext[net]!;
    const oldBits = this.contrib[net]!;
    if (oldAtt !== 0 || newAtt !== 0) {
      // Ordered mode: a short only blanks the group that has it, so nets tied to a hub
      // never add to the hub's own forcing; only the hub net's own drivers do.
      const feedsHub = !this.ordered || this.hubOf[net]! >= 0;
      for (let m = oldAtt; m !== 0; m &= m - 1) {
        const h = 31 - Math.clz32(m & -m);
        if (feedsHub) {
          this.cnt0[h]! -= oldBits & 1;
          this.cnt1[h]! -= (oldBits >> 1) & 1;
        }
        if (!((newAtt >> h) & 1)) this.removeFromList(h, net);
      }
      for (let m = newAtt; m !== 0; m &= m - 1) {
        const h = 31 - Math.clz32(m & -m);
        if (feedsHub) {
          this.cnt0[h]! += newBits & 1;
          this.cnt1[h]! += (newBits >> 1) & 1;
        }
        if (!((oldAtt >> h) & 1)) this.addToList(h, net);
      }
      if (oldAtt !== newAtt && !this.ordered) {
        if ((oldAtt & (oldAtt - 1)) !== 0) this.linkRemove(oldAtt);
        if ((newAtt & (newAtt - 1)) !== 0) this.linkAdd(newAtt);
      }
    }
    this.att[net] = newAtt;
    this.contrib[net] = newBits;
    return newBits;
  }

  /** Join the hubs that a conducting path connects into classes. */
  private recomputeClasses(): void {
    const { hubClass } = this;
    for (let h = 0; h < hubClass.length; h++) hubClass[h] = h;
    const root = (h: number): number => {
      while (hubClass[h] !== h) h = hubClass[h]!;
      return h;
    };
    for (const mask of this.links.keys()) {
      const first = 31 - Math.clz32(mask & -mask);
      for (let m = mask & (mask - 1); m !== 0; m &= m - 1) {
        const a = root(first);
        const b = root(31 - Math.clz32(m & -m));
        if (a !== b) hubClass[a] = b;
      }
    }
    for (let h = 0; h < hubClass.length; h++) hubClass[h] = root(h);
    this.linksDirty = false;
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

  private addSeed(net: number): void {
    if (this.hubOf[net]! >= 0) return;
    if (this.ordered) this.pushSeed(net);
    else this.pending.push(net);
  }

  /** One synchronous pass over the dirty groups. Returns true if any net changed. */
  private pass(): boolean {
    const work = this.pending;
    this.pending = [];
    this.passNo++;
    this.refreshExternal(work);
    this.evaluate(work);
    return this.commit();
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

    // Phase B: values from the hub classes, forced drivers or a hold vote.
    if (this.linksDirty) this.recomputeClasses();
    const { hubClass, classBits, hubValue, hubContended, lastValue, lastContended } = this;
    const hubCount = hubClass.length;
    classBits.fill(0);
    for (let h = 0; h < hubCount; h++) {
      classBits[hubClass[h]!]! |= (this.cnt0[h]! > 0 ? 1 : 0) | (this.cnt1[h]! > 0 ? 2 : 0);
    }
    for (let h = 0; h < hubCount; h++) {
      const forced = classBits[hubClass[h]!]!;
      hubValue[h] = forcedLevel(forced);
      hubContended[h] = forced === 3 ? 1 : 0;
      if (hubValue[h] === lastValue[h] && hubContended[h] === lastContended[h]) continue;
      lastValue[h] = hubValue[h]!;
      lastContended[h] = hubContended[h]!;
      const list = this.list[h]!;
      for (let i = 0; i < this.len[h]!; i++) {
        const net = list[i]!;
        if (this.ordered && this.hubOf[net]! < 0) {
          this.addSeed(net);
          continue;
        }
        this.setNext(net, hubValue[h]!);
        this.setContended(net, hubContended[h] === 1);
      }
    }

    let begin = 0;
    for (let c = 0; c < compEnd.length; c++) {
      const end = compEnd[c]!;
      const tied = compAtt[c]!;
      const forced = compForced[c]!;
      if (tied !== 0 && this.ordered) {
        let forcedHere = forced;
        for (let m = tied; m !== 0; m &= m - 1) forcedHere |= classBits[31 - Math.clz32(m & -m)]!;
        const value = forcedLevel(forcedHere);
        for (let q = begin; q < end; q++) {
          this.setNext(members[q]!, value);
          this.setContended(members[q]!, forcedHere === 3);
        }
      } else if (tied !== 0) {
        const h = 31 - Math.clz32(tied & -tied);
        for (let q = begin; q < end; q++) {
          this.leaveFloating(members[q]!);
          this.setNext(members[q]!, hubValue[h]!);
          this.setContended(members[q]!, hubContended[h] === 1);
        }
      } else if (forced !== 0) {
        const value = forcedLevel(forced);
        for (let q = begin; q < end; q++) {
          this.leaveFloating(members[q]!);
          this.setNext(members[q]!, value);
          this.setContended(members[q]!, forced === 3);
        }
      } else {
        this.holdVote(members, begin, end);
      }
      begin = end;
    }

  }

  /** Make the computed values current, then find what the new levels disturb. Returns whether any net changed. */
  private commit(): boolean {
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
        const hubMask = this.ordered ? 0 : this.tHubMask[t]!;
        if (hubMask !== 0) {
          if (nowConducts) this.linkAdd(hubMask);
          else this.linkRemove(hubMask);
        }
        this.addSeed(tDrain[t]!);
        this.addSeed(tSource[t]!);
      }
    }
    return changed.length > 0;
  }

  /** A component with no forced driver keeps the majority of its members' remembered levels. */
  private holdVote(members: number[], begin: number, end: number): void {
    const { cur, gaveUp, floating, lastPass } = this;
    let count0 = 0;
    let count1 = 0;
    for (let q = begin; q < end; q++) {
      const x = members[q]!;
      this.replaySkippedPasses(x);
      if (gaveUp[x]) continue;
      if (cur[x] === ZERO) count0++;
      else if (cur[x] === ONE) count1++;
    }
    const value = count0 > count1 ? ZERO : count1 > count0 ? ONE : Z;

    let gaveUpNow = false;
    for (let q = begin; q < end; q++) {
      const x = members[q]!;
      if (this.appendHistory(x, value, 1)) gaveUpNow = true;
      lastPass[x] = this.passNo;
      floating[x] = this.ordered ? 0 : 1;
      this.setNext(x, value);
      this.setContended(x, false);
    }
    // A member that gave up is left out of the next vote, which can change the value with no level changing.
    if (gaveUpNow) this.requeue(members[begin]!);
  }

  /** Passes since the net's last history entry in which its held value did not change still count for the dense solver. */
  private replaySkippedPasses(x: number): void {
    if (this.histTick[x] !== this.tickNo) this.resetHistory(x);
    if (!this.floating[x]) return;
    const length = this.histLen[x]!;
    const previous = length > 0 ? this.hist[x * HISTORY_WINDOW + ((this.histStart[x]! + length - 1) % HISTORY_WINDOW)]! : this.cur[x]!;
    this.appendHistory(x, previous, this.passNo - 1 - this.lastPass[x]!);
  }

  private leaveFloating(x: number): void {
    if (this.ordered) return;
    this.replaySkippedPasses(x);
    this.floating[x] = 0;
  }

  /** Same bookkeeping as the dense solver does once per pass, `times` passes in a row with an unchanged value. */
  private appendHistory(x: number, value: number, times: number): boolean {
    const { hist, histLen, histStart, flips, gaveUp } = this;
    const base = x * HISTORY_WINDOW;
    const gaveUpBefore = gaveUp[x]!;
    for (let i = 0; i < times && i <= HISTORY_WINDOW; i++) {
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
    }
    return gaveUpBefore === 0 && gaveUp[x] === 1;
  }

  private resetHistory(x: number): void {
    this.histTick[x] = this.tickNo;
    this.lastPass[x] = 0;
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

  private requeue(net: number): void {
    if (this.ordered) this.pushSeed(net);
    else this.pending.push(net);
  }

  private relaxOrdered(prevLevelOf: Map<string, Level>, maxEvaluations: number): EventRelaxed {
    this.tickNo++;
    this.passNo = 0;
    if (prevLevelOf !== this.lastLevelOf) this.reseed(prevLevelOf);
    this.refreshDrivers();
    for (const net of this.pending) this.pushSeed(net);
    this.pending = [];
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
        if (!this.deviceDirty[device]) continue;
        this.dirtyDevices = [device];
        const touched: number[] = [];
        this.refreshExternal(touched);
        for (const net of touched) this.pushSeed(net);
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
    return this.finish(settled, mostEvaluations);
  }

  private finish(settled: boolean, iterations: number): EventRelaxed {
    const levelOf = new LevelView(this.s.indexOf, this.cur.slice());
    const ids = this.s.netIds;
    const contended = new Set<string>();
    for (const net of this.contSet) contended.add(ids[net]!);
    this.lastLevelOf = levelOf;
    return { levelOf, contended, settled, iterations, levelAt: (i) => LEVELS[this.cur[i] ?? Z]! };
  }

  relax(prevLevelOf: Map<string, Level>, maxIterations: number): EventRelaxed {
    if (this.ordered) return this.relaxOrdered(prevLevelOf, maxIterations);
    this.tickNo++;
    this.passNo = 0;
    if (prevLevelOf !== this.lastLevelOf) this.reseed(prevLevelOf);
    this.refreshDrivers();
    this.markAllDevicesDirty();

    let iterations = 0;
    let changed = true;
    while (changed && iterations < maxIterations) {
      iterations++;
      changed = this.pass();
    }

    return this.finish(!changed, iterations);
  }

  /** In shadow mode the dense solver's Map is the one handed back to the caller; follow it. */
  adopt(levelOf: Map<string, Level> | null): void {
    this.lastLevelOf = levelOf;
  }
}

const lockstepEngines = new WeakMap<EventStructure, Engine>();
const orderedEngines = new WeakMap<EventStructure, Engine>();

function engineFor(structure: EventStructure, ordered: boolean): Engine {
  const engines = ordered ? orderedEngines : lockstepEngines;
  let engine = engines.get(structure);
  if (!engine) {
    engine = new Engine(structure, ordered);
    engines.set(structure, engine);
  }
  return engine;
}

export function eventRelax(
  structure: EventStructure,
  prevLevelOf: Map<string, Level>,
  maxIterations: number,
  ordered = false,
): EventRelaxed {
  return engineFor(structure, ordered).relax(prevLevelOf, maxIterations);
}

/** Make the engine continue from `levelOf` (shared with the caller), or from scratch when null. */
export function adoptLevelOf(structure: EventStructure, levelOf: Map<string, Level> | null, ordered = false): void {
  engineFor(structure, ordered).adopt(levelOf);
}
