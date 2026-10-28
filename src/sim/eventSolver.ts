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
  transistors: EventTransistor[];
  ramIdx: EventRam[];
  softChips: EventSoftChip[];
  driverPins: { netIdx: number; comp: { value: 0 | 1 } }[];
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
  private readonly extOld: Uint8Array;
  private extTouched: number[] = [];

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

  lastLevelOf: Map<string, Level> | null = null;

  constructor(private readonly s: EventStructure) {
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

    this.cur = new Uint8Array(n);
    this.conducts = new Uint8Array(T);
    this.drv = new Uint8Array(n);
    this.drvNew = new Uint8Array(n);
    this.ext = new Uint8Array(n);
    this.extOld = new Uint8Array(n);
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
  }

  /** Throw away all incremental state and start from `prevLevelOf`, evaluating every net. */
  private reseed(prevLevelOf: Map<string, Level>): void {
    const { n } = this;
    const ids = this.s.netIds;
    for (let i = 0; i < n; i++) this.cur[i] = code(prevLevelOf.get(ids[i]!));
    for (let t = 0; t < this.conducts.length; t++) this.conducts[t] = this.conductsNow(t);
    this.drv.fill(0);
    this.ext.fill(0);
    this.extOld.fill(0);
    this.extTouched = [];
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
    for (const t of this.hubShorts) if (this.conducts[t]) this.linkAdd(this.tHubMask[t]!);
    this.pending = [];
    for (let i = 0; i < n; i++) this.pending.push(i);
  }

  private conductsNow(t: number): number {
    const level = this.cur[this.tGate[t]!]!;
    return this.tIsN[t] ? (level === ONE ? 1 : 0) : level === ZERO ? 1 : 0;
  }

  private refreshDrivers(): void {
    const { drvNew, drv } = this;
    drvNew.fill(0);
    for (const d of this.s.driverPins) drvNew[d.netIdx]! |= d.comp.value === 1 ? 2 : 1;
    for (const net of this.implicitRails) drvNew[net]! |= this.s.netIds[net] === 'VCC' ? 2 : 1;
    for (let i = 0; i < this.n; i++) {
      if (drvNew[i] !== drv[i]) {
        drv[i] = drvNew[i]!;
        this.pending.push(i);
      }
    }
  }

  /** RAM/ROM read forces and Soft Lab chip outputs for this pass, from the levels at the start of the pass. */
  private refreshExternal(work: number[]): void {
    const { ext, extOld, cur } = this;
    const oldTouched = this.extTouched;
    for (const net of oldTouched) {
      extOld[net] = ext[net]!;
      ext[net] = 0;
    }
    const newTouched: number[] = [];
    for (const r of this.s.ramIdx) {
      if (cur[r.oe] !== ONE) continue;
      if (r.we >= 0 && cur[r.we] === ONE) continue;
      let addr = 0;
      let resolved = true;
      for (let i = 0; i < r.addr.length; i++) {
        const level = cur[r.addr[i]!]!;
        if (level !== ZERO && level !== ONE) {
          resolved = false;
          break;
        }
        if (level === ONE) addr |= 1 << i;
      }
      if (!resolved) continue;
      const byte = r.mem.bytes[addr] ?? 0;
      for (let i = 0; i < r.data.length; i++) {
        const net = r.data[i]!;
        if (ext[net] === 0) newTouched.push(net);
        ext[net]! |= ((byte >> i) & 1) === 1 ? 2 : 1;
      }
    }
    for (const sc of this.s.softChips) {
      const pinLevels: Record<string, Level> = {};
      for (const name of sc.pinNames) {
        const idx = sc.pinNet[name];
        pinLevels[name] = idx !== undefined ? LEVELS[cur[idx]!]! : 'Z';
      }
      softLabDriveOutputs(sc.model, sc.pinNet, pinLevels, sc.state, (net, bit) => {
        if (ext[net] === 0) newTouched.push(net);
        ext[net]! |= bit === 1 ? 2 : 1;
      });
    }
    for (const net of oldTouched) if (ext[net] !== extOld[net]) work.push(net);
    for (const net of newTouched) if (extOld[net] === 0) work.push(net);
    for (const net of oldTouched) extOld[net] = 0;
    this.extTouched = newTouched;
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
      for (let m = oldAtt; m !== 0; m &= m - 1) {
        const h = 31 - Math.clz32(m & -m);
        this.cnt0[h]! -= oldBits & 1;
        this.cnt1[h]! -= (oldBits >> 1) & 1;
        if (!((newAtt >> h) & 1)) this.removeFromList(h, net);
      }
      for (let m = newAtt; m !== 0; m &= m - 1) {
        const h = 31 - Math.clz32(m & -m);
        this.cnt0[h]! += newBits & 1;
        this.cnt1[h]! += (newBits >> 1) & 1;
        if (!((oldAtt >> h) & 1)) this.addToList(h, net);
      }
      if (oldAtt !== newAtt) {
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
    if (this.hubOf[net]! < 0) this.pending.push(net);
  }

  /** One synchronous pass over the dirty groups. Returns true if any net changed. */
  private pass(): boolean {
    const { cur, conducts, chanStart, chanList, tDrain, tSource, visit, hubOf } = this;
    const work = this.pending;
    this.pending = [];
    this.passNo++;
    this.refreshExternal(work);
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
        this.setNext(list[i]!, hubValue[h]!);
        this.setContended(list[i]!, hubContended[h] === 1);
      }
    }

    let begin = 0;
    for (let c = 0; c < compEnd.length; c++) {
      const end = compEnd[c]!;
      const tied = compAtt[c]!;
      const forced = compForced[c]!;
      if (tied !== 0) {
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

    // Commit, then find what the new levels disturb.
    const { nxt, changed } = this;
    for (const net of changed) cur[net] = nxt[net]!;
    for (const net of changed) {
      this.addSeed(net);
      for (let k = this.gatedStart[net]!; k < this.gatedStart[net + 1]!; k++) {
        const t = this.gatedList[k]!;
        const nowConducts = this.conductsNow(t);
        if (nowConducts === conducts[t]) continue;
        conducts[t] = nowConducts;
        const hubMask = this.tHubMask[t]!;
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
      floating[x] = 1;
      this.setNext(x, value);
      this.setContended(x, false);
    }
    // A member that gave up is left out of the next vote, which can change the value with no level changing.
    if (gaveUpNow) this.pending.push(members[begin]!);
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

  relax(prevLevelOf: Map<string, Level>, maxIterations: number): EventRelaxed {
    this.tickNo++;
    this.passNo = 0;
    if (prevLevelOf !== this.lastLevelOf) this.reseed(prevLevelOf);
    this.refreshDrivers();

    let iterations = 0;
    let changed = true;
    while (changed && iterations < maxIterations) {
      iterations++;
      changed = this.pass();
    }

    const levelOf = new Map<string, Level>();
    const ids = this.s.netIds;
    for (let i = 0; i < this.n; i++) levelOf.set(ids[i]!, LEVELS[this.cur[i]!]!);
    const contended = new Set<string>();
    for (const net of this.contSet) contended.add(ids[net]!);
    this.lastLevelOf = levelOf;
    return { levelOf, contended, settled: !changed, iterations, levelAt: (i) => LEVELS[this.cur[i] ?? Z]! };
  }

  /** In shadow mode the dense solver's Map is the one handed back to the caller; follow it. */
  adopt(levelOf: Map<string, Level>): void {
    this.lastLevelOf = levelOf;
  }
}

const engines = new WeakMap<EventStructure, Engine>();

function engineFor(structure: EventStructure): Engine {
  let engine = engines.get(structure);
  if (!engine) {
    engine = new Engine(structure);
    engines.set(structure, engine);
  }
  return engine;
}

export function eventRelax(structure: EventStructure, prevLevelOf: Map<string, Level>, maxIterations: number): EventRelaxed {
  return engineFor(structure).relax(prevLevelOf, maxIterations);
}

export function adoptLevelOf(structure: EventStructure, levelOf: Map<string, Level>): void {
  engineFor(structure).adopt(levelOf);
}
