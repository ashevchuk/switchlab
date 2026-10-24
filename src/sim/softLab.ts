/**
 * Soft Lab — optional behavioral eval for heavy digital-lab chips.
 *
 * When enabled, flatten() leaves matching chip instances opaque and solver.ts
 * drives their ports from truth tables / edge-triggered state (same idea as
 * RAM). Soft Lab off expands all hierarchical transistor defs. Dive-in while
 * Soft Lab is on auto force-expands ChipDefs on the nav path *and* Soft Lab
 * descendants nested under them (see syncSoftExpandForDivePath) so internals
 * show live levels that match the Soft exterior.
 */

import { bumpStructureVersion } from './Circuit.js';
import type { ChipInstanceComponent, Level } from './types.js';

export type SoftLabState = {
  model: string;
  lastClk: 0 | 1 | 'Z';
  /** Sequential bit storage (0/1). Length depends on the model. */
  q: Uint8Array;
};

const SOFT_LAB_LS_KEY = 'switchlab.softLab.v1';

let softLabEnabled = true;

/** Def names forced to transistor-expand this session (Soft Lab still on). */
const softExpandForced = new Set<string>();
/** Subset of softExpandForced that dive-in armed automatically (released on leave). */
const softExpandAutoDive = new Set<string>();

export function isSoftLabEnabled(): boolean {
  return softLabEnabled;
}

export function setSoftLabEnabled(on: boolean): void {
  if (softLabEnabled === on) return;
  softLabEnabled = on;
  bumpStructureVersion();
}

/**
 * Soft Lab → Gates hand-off: sequential soft chips power up floating (Z) in
 * silicon, and with Clear already released they never leave Z. For a few
 * solver steps after Soft Lab turns off (or a cold load with Soft Lab already
 * off), force each such chip's `q*` low (and `qn*` high) so capacitive hold
 * seeds a legal power-on state — without touching the user's CLR/WE toggles
 * or machine RAM/ROM.
 *
 * Skips combinatorial soft models (`q.length === 0`) and SOFT_RAM16 (no
 * silicon body). Does not affect Soft Run / buildZ80Cpu / RamComponent.
 *
 * Arm via {@link armSoftLabToGatesPor} (needs {@link softLabNeedsGatesPor}).
 */
const porLowPinIds = new Set<string>();
const porHighPinIds = new Set<string>();
let porStepsLeft = 0;

const POR_STEPS = 8;

function isPorQPin(name: string): boolean {
  return name === 'q' || name === 'sout' || /^q\d+$/.test(name);
}

function isPorQnPin(name: string): boolean {
  return name === 'qn' || /^qn\d+$/.test(name);
}

/**
 * Arm one-shot POR for top-level Soft Lab sequential instances.
 * Prefer existing `softState`; with a `library`, also match by ChipDef name
 * (cold reload with Soft Lab already off — no softState yet).
 * If `onlyDefNames` is set, only chips whose def name is in that set are armed
 * (dive-in auto-expand of one ChipDef).
 */
export function armSoftLabToGatesPor(
  circuit: {
    components: Map<
      string,
      {
        kind: string;
        defId?: string;
        softState?: SoftLabState;
        pins?: Record<string, { id: string }>;
      }
    >;
  },
  library?: { has(id: string): boolean; get(id: string): { name: string } },
  onlyDefNames?: ReadonlySet<string> | null,
): void {
  porLowPinIds.clear();
  porHighPinIds.clear();
  for (const c of circuit.components.values()) {
    if (c.kind !== 'chip' || !c.pins) continue;
    const defName =
      library && c.defId && library.has(c.defId) ? library.get(c.defId).name : undefined;
    if (onlyDefNames && (!defName || !onlyDefNames.has(defName))) continue;
    let eligible = false;
    if (c.softState && c.softState.q.length > 0 && c.softState.model !== 'SOFT_RAM16') {
      eligible = true;
      c.softState.q.fill(0);
    } else if (defName) {
      eligible = softLabNeedsGatesPor(defName);
    }
    if (!eligible) continue;
    for (const [name, pin] of Object.entries(c.pins)) {
      if (isPorQPin(name)) porLowPinIds.add(pin.id);
      else if (isPorQnPin(name)) porHighPinIds.add(pin.id);
    }
  }
  porStepsLeft = porLowPinIds.size > 0 || porHighPinIds.size > 0 ? POR_STEPS : 0;
}

export function softLabPorActive(): boolean {
  return porStepsLeft > 0;
}

/** Pin id → forced level while POR is active; null if this pin is not forced. */
export function softLabPorPinLevel(pinId: string): 0 | 1 | null {
  if (porStepsLeft <= 0) return null;
  if (porLowPinIds.has(pinId)) return 0;
  if (porHighPinIds.has(pinId)) return 1;
  return null;
}

/**
 * Fill dense POR override masks (parallel to solver net indices).
 * Only walks the small POR pin sets — not the whole netlist.
 */
export function fillSoftLabPorMasks(
  netOf: Map<string, string>,
  indexOf: Map<string, number>,
  porLow: Uint8Array,
  porHigh: Uint8Array,
): void {
  porLow.fill(0);
  porHigh.fill(0);
  if (porStepsLeft <= 0) return;
  for (const pinId of porLowPinIds) {
    const net = netOf.get(pinId);
    if (!net) continue;
    const idx = indexOf.get(net);
    if (idx !== undefined) porLow[idx] = 1;
  }
  for (const pinId of porHighPinIds) {
    const net = netOf.get(pinId);
    if (!net) continue;
    const idx = indexOf.get(net);
    if (idx !== undefined) porHigh[idx] = 1;
  }
}

/** Call once at the end of each solver `step` while POR may be active. */
export function tickSoftLabPor(): void {
  if (porStepsLeft <= 0) return;
  porStepsLeft -= 1;
  if (porStepsLeft <= 0) {
    porLowPinIds.clear();
    porHighPinIds.clear();
  }
}

/** Test helper — drop any in-flight Soft→Gates POR. */
export function clearSoftLabPor(): void {
  porStepsLeft = 0;
  porLowPinIds.clear();
  porHighPinIds.clear();
}

/** When Soft Lab is on, force this ChipDef.name to expand to transistors. */
export function setSoftExpandForced(defName: string, forced: boolean): void {
  const before = softExpandForced.has(defName);
  if (forced) softExpandForced.add(defName);
  else {
    softExpandForced.delete(defName);
    softExpandAutoDive.delete(defName);
  }
  if (before !== forced) bumpStructureVersion();
}

export function isSoftExpandForced(defName: string): boolean {
  return softExpandForced.has(defName);
}

export function clearSoftExpandForced(): void {
  if (softExpandForced.size === 0 && softExpandAutoDive.size === 0) return;
  softExpandForced.clear();
  softExpandAutoDive.clear();
  bumpStructureVersion();
}

/**
 * Soft Lab defs nested under `defName` (and their soft children). Used so a
 * dive into COUNTER4 also expands T_FF guts — otherwise Soft-opaque children
 * hide live levels on deeper dive (MUX2 / gates).
 */
function collectSoftLabDescendants(
  defName: string,
  library: {
    findByName(name: string): { circuit: { components: Map<string, { kind: string; defId?: string }> } } | undefined;
    has(id: string): boolean;
    get(id: string): { name: string };
  },
  into: Set<string>,
): void {
  const def = library.findByName(defName);
  if (!def) return;
  for (const c of def.circuit.components.values()) {
    if (c.kind !== 'chip' || !c.defId || !library.has(c.defId)) continue;
    const childName = library.get(c.defId).name;
    if (!softLabModelKey(childName)) continue;
    if (into.has(childName)) continue;
    into.add(childName);
    collectSoftLabDescendants(childName, library, into);
  }
}

/**
 * Keep Soft Lab chip defs on the dive path transistor-expanded so internals
 * show live levels that match Soft Lab’s exterior behavior. Also expands Soft
 * Lab descendants nested under those defs (COUNTER4 → T_FF). Manual
 * force-expand (inspector) is preserved. Released when leaving the path.
 * @returns `{ newly, released }` — newly auto-forced defs (for POR) and
 * Soft models released when leaving the dive path (stale softState wipe).
 */
export function syncSoftExpandForDivePath(
  defNamesOnPath: readonly string[],
  library?: {
    findByName(name: string): { circuit: { components: Map<string, { kind: string; defId?: string }> } } | undefined;
    has(id: string): boolean;
    get(id: string): { name: string };
  },
): { newly: string[]; released: string[] } {
  const newly: string[] = [];
  const released: string[] = [];
  if (!softLabEnabled) {
    // Soft Lab off expands everything. Drop Soft-model force-expands (auto
    // *and* orphaned) — clearing only softExpandAutoDive left names stuck in
    // softExpandForced; Soft Lab ON then kept COUNTER/T_FF as silicon with
    // floating Q (chips look dead while the clock still animates).
    clearSoftModelForceExpands();
    return { newly, released };
  }

  const onPath = new Set<string>();
  for (const name of defNamesOnPath) {
    if (softLabModelKey(name)) onPath.add(name);
  }
  if (library) {
    for (const name of [...onPath]) {
      collectSoftLabDescendants(name, library, onPath);
    }
  }

  for (const name of [...softExpandAutoDive]) {
    if (onPath.has(name)) continue;
    softExpandAutoDive.delete(name);
    if (softExpandForced.delete(name)) released.push(name);
  }

  for (const name of onPath) {
    if (softExpandForced.has(name)) continue;
    softExpandForced.add(name);
    softExpandAutoDive.add(name);
    newly.push(name);
  }

  if (released.length > 0 || newly.length > 0) bumpStructureVersion();
  return { newly, released };
}

/**
 * Drop Soft-model force-expands (auto or orphaned). Dive `syncSoftExpandForDivePath`
 * re-applies the current path afterward. Call when Soft Lab turns on so a prior
 * Soft-off-while-dived bug cannot leave COUNTER/T_FF stuck expanded.
 */
export function clearSoftModelForceExpands(): void {
  let released = false;
  for (const name of [...softExpandForced]) {
    if (!softLabModelKey(name)) continue;
    softExpandForced.delete(name);
    softExpandAutoDive.delete(name);
    released = true;
  }
  if (softExpandAutoDive.size > 0) {
    softExpandAutoDive.clear();
    released = true;
  }
  if (released) bumpStructureVersion();
}

export function loadSoftLabPreference(): boolean {
  try {
    const raw = localStorage.getItem(SOFT_LAB_LS_KEY);
    if (raw === '0' || raw === 'false') softLabEnabled = false;
    else if (raw === '1' || raw === 'true') softLabEnabled = true;
  } catch {
    /* ignore */
  }
  return softLabEnabled;
}

export function persistSoftLabPreference(): void {
  try {
    localStorage.setItem(SOFT_LAB_LS_KEY, softLabEnabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Clear Soft Lab sequential state on chip instances in a circuit. */
export function clearSoftLabState(circuit: { components: Map<string, { kind: string; softState?: SoftLabState }> }): void {
  let cleared = false;
  for (const c of circuit.components.values()) {
    if (c.kind === 'chip' && c.softState) {
      delete c.softState;
      cleared = true;
    }
  }
  if (cleared) bumpStructureVersion();
}

/**
 * Clear softState on the top circuit and every library ChipDef. Dive-in
 * force-expand freezes Soft sequential state; without this, leaving a dive
 * (or Soft↔Gates) can resume Soft with a stale lastClk and Q that never
 * track the live clock again.
 */
export function clearSoftLabStateDeep(
  circuit: { components: Map<string, { kind: string; softState?: SoftLabState }> },
  library?: { list(): Iterable<{ circuit: { components: Map<string, { kind: string; softState?: SoftLabState }> } }> },
): void {
  let cleared = false;
  const wipe = (c: { components: Map<string, { kind: string; softState?: SoftLabState }> }) => {
    for (const comp of c.components.values()) {
      if (comp.kind === 'chip' && comp.softState) {
        delete comp.softState;
        cleared = true;
      }
    }
  };
  wipe(circuit);
  if (library) {
    for (const def of library.list()) wipe(def.circuit);
  }
  if (cleared) bumpStructureVersion();
}

/** Canonical model keys that Soft Lab can evaluate. */
const MODEL_BITS: Record<string, number> = {
  SR_LATCH: 1,
  JK_FF: 1,
  T_FF: 1,
  REG4: 4,
  REG8: 8,
  SHIFT4_SIPO: 4,
  SHIFT8_SIPO: 8,
  SHIFT4_PISO: 4,
  SHIFT8_PISO: 8,
  COUNTER4: 4,
  COUNTER8: 8,
  LATCH8: 8,
  CLK_DIV2: 1,
  CLK_DIV16: 4,
  // combinatorial — q unused / length 0
  DECODER_2_4: 0,
  DECODER_3_8: 0,
  ENCODER_8_3: 0,
  COMP2: 0,
  COMP4: 0,
  BCD_7SEG: 0,
  BUF8: 0,
  INV8: 0,
  MUX8_1: 0,
  DEMUX_1_8: 0,
  HALF_ADDER: 0,
  FULL_ADDER: 0,
  ADDER4: 0,
  ADDER8: 0,
  ALU4: 0,
  ALU8: 0,
  /** Soft 16×8 RAM (q holds 16 bytes); wraps real RAM when expanded. */
  SOFT_RAM16: 16,
  // 74xx alias soft models (opaque wrappers only — not bare NAND/D_FF/…)
  '7400': 0,
  '7404': 0,
  '7408': 0,
  '7432': 0,
  '7486': 0,
  '7474': 1,
  '74157_1': 0,
};

const ALIAS_TO_MODEL: Record<string, string> = {
  SIPO8: 'SHIFT8_SIPO',
  PISO8: 'SHIFT8_PISO',
  '74161': 'COUNTER4',
  '74164': 'SHIFT8_SIPO',
  '74165': 'SHIFT8_PISO',
  '74138': 'DECODER_3_8',
  '74139': 'DECODER_2_4',
  '74373': 'LATCH8',
  '74374': 'REG8',
  '7447': 'BCD_7SEG',
};

export function softLabModelKey(chipName: string): string | null {
  if (MODEL_BITS[chipName] !== undefined) return chipName;
  if (ALIAS_TO_MODEL[chipName]) return ALIAS_TO_MODEL[chipName]!;
  // Dive forks: COUNTER4_copy / COUNTER4_copy_2 → same Soft model as the original.
  const fork = /^(.*)_copy(?:_\d+)?$/.exec(chipName);
  if (fork?.[1]) return softLabModelKey(fork[1]);
  return null;
}

export function hasSoftLabModel(chipName: string): boolean {
  return softLabModelKey(chipName) != null;
}

/**
 * True when Soft Lab is on and this ChipDef is currently Soft-opaque (not
 * dive/inspector force-expanded). Used for the canvas SOFT badge.
 */
export function softLabShowsBadge(defName: string): boolean {
  return isSoftLabEnabled() && hasSoftLabModel(defName) && !isSoftExpandForced(defName);
}

/** True for Soft Lab models that hold sequential bits (eligible for Gates POR). */
export function softLabNeedsGatesPor(chipName: string): boolean {
  const key = softLabModelKey(chipName);
  if (!key || key === 'SOFT_RAM16') return false;
  return (MODEL_BITS[key] ?? 0) > 0;
}

export function ensureSoftState(chip: ChipInstanceComponent, model: string): SoftLabState {
  const bits = MODEL_BITS[model] ?? 0;
  const q = chip.softState?.q;
  const qOk = q instanceof Uint8Array && q.length === bits;
  if (!chip.softState || chip.softState.model !== model || !qOk) {
    chip.softState = {
      model,
      lastClk: 0,
      q: new Uint8Array(bits),
    };
  }
  return chip.softState;
}

function bit(levels: Record<string, Level>, name: string, defaultVal: 0 | 1 = 0): 0 | 1 {
  const v = levels[name];
  if (v === 0 || v === 1) return v;
  return defaultVal;
}

function rising(prev: 0 | 1 | 'Z', cur: Level): boolean {
  return prev !== 1 && cur === 1;
}

const SEG_MAP: Record<number, number> = {
  // bit0=a … bit6=g
  0: 0b0111111,
  1: 0b0000110,
  2: 0b1011011,
  3: 0b1001111,
  4: 0b1100110,
  5: 0b1101101,
  6: 0b1111101,
  7: 0b0000111,
  8: 0b1111111,
  9: 0b1101111,
};

/**
 * Drive output nets for one Soft Lab chip (relaxation pass).
 * Returns list of { netIdx, bit } forced levels — caller ORs into softMask.
 */
export function softLabDriveOutputs(
  model: string,
  pinNet: Record<string, number | undefined>,
  levels: Record<string, Level>,
  state: SoftLabState,
  force: (netIdx: number, bit: 0 | 1) => void,
): void {
  const out = (name: string, v: 0 | 1) => {
    const idx = pinNet[name];
    if (idx !== undefined) force(idx, v);
  };

  switch (model) {
    case 'SR_LATCH': {
      const s = bit(levels, 's');
      const r = bit(levels, 'r');
      if (s && !r) state.q[0] = 1;
      else if (r && !s) state.q[0] = 0;
      // both 1: hold (avoid illegal race in soft model)
      const q = state.q[0]! as 0 | 1;
      out('q', q);
      out('qn', (q ^ 1) as 0 | 1);
      return;
    }
    case 'JK_FF':
    case 'T_FF': {
      const q = state.q[0]! as 0 | 1;
      out('q', q);
      out('qn', (q ^ 1) as 0 | 1);
      return;
    }
    case 'CLK_DIV2':
      out('out', state.q[0]! as 0 | 1);
      return;
    case 'CLK_DIV16':
      out('out', state.q[3]! as 0 | 1);
      return;
    case 'REG4':
    case 'REG8':
    case 'SHIFT4_SIPO':
    case 'SHIFT8_SIPO':
    case 'LATCH8': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      return;
    }
    case 'COUNTER4': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      const v = state.q[0]! | (state.q[1]! << 1) | (state.q[2]! << 2) | (state.q[3]! << 3);
      const clr = bit(levels, 'clr');
      const ce = bit(levels, 'ce', 1);
      out('co', v === 15 && ce && !clr ? 1 : 0);
      return;
    }
    case 'COUNTER8': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      let v = 0;
      for (let i = 0; i < 8; i++) v |= (state.q[i]! & 1) << i;
      const clr = bit(levels, 'clr');
      const ce = bit(levels, 'ce', 1);
      out('co', v === 255 && ce && !clr ? 1 : 0);
      return;
    }
    case 'SHIFT4_PISO':
    case 'SHIFT8_PISO': {
      for (let i = 0; i < state.q.length; i++) out(`q${i}`, state.q[i]! as 0 | 1);
      out('sout', state.q[state.q.length - 1]! as 0 | 1);
      return;
    }
    case 'DECODER_2_4':
    case 'DECODER_3_8': {
      const bits = model === 'DECODER_2_4' ? 2 : 3;
      const en = bit(levels, 'en', 1);
      const n = 1 << bits;
      if (!en) {
        for (let i = 0; i < n; i++) out(`y${i}`, 0);
        return;
      }
      let addr = 0;
      for (let i = 0; i < bits; i++) if (bit(levels, `a${i}`)) addr |= 1 << i;
      for (let i = 0; i < n; i++) out(`y${i}`, i === addr ? 1 : 0);
      return;
    }
    case 'ENCODER_8_3': {
      let idx = 0;
      let found = false;
      for (let i = 7; i >= 0; i--) {
        if (bit(levels, `in${i}`)) {
          idx = i;
          found = true;
          break;
        }
      }
      out('y0', found && idx & 1 ? 1 : 0);
      out('y1', found && idx & 2 ? 1 : 0);
      out('y2', found && idx & 4 ? 1 : 0);
      return;
    }
    case 'COMP2':
    case 'COMP4': {
      const n = model === 'COMP2' ? 2 : 4;
      let a = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        if (bit(levels, `a${i}`)) a |= 1 << i;
        if (bit(levels, `b${i}`)) b |= 1 << i;
      }
      out('eq', a === b ? 1 : 0);
      out('gt', a > b ? 1 : 0);
      out('lt', a < b ? 1 : 0);
      return;
    }
    case 'BCD_7SEG': {
      let d = 0;
      for (let i = 0; i < 4; i++) if (bit(levels, `d${i}`)) d |= 1 << i;
      const seg = d <= 9 ? SEG_MAP[d]! : 0; // blank invalid BCD
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
      for (let i = 0; i < 7; i++) out(names[i]!, (seg >> i) & 1 ? 1 : 0);
      return;
    }
    case 'BUF8':
      // Only drive when oe=1; otherwise leave Z (tri-state).
      if (bit(levels, 'oe', 1) !== 1) return;
      for (let i = 0; i < 8; i++) out(`out${i}`, bit(levels, `in${i}`));
      return;
    case 'INV8':
      for (let i = 0; i < 8; i++) out(`out${i}`, (bit(levels, `in${i}`) ^ 1) as 0 | 1);
      return;
    case 'MUX8_1': {
      const sel =
        bit(levels, 'sel0') | (bit(levels, 'sel1') << 1) | (bit(levels, 'sel2') << 2);
      out('out', bit(levels, `in${sel}`));
      return;
    }
    case 'DEMUX_1_8': {
      const sel =
        bit(levels, 'sel0') | (bit(levels, 'sel1') << 1) | (bit(levels, 'sel2') << 2);
      const d = bit(levels, 'in');
      for (let i = 0; i < 8; i++) out(`y${i}`, i === sel ? d : 0);
      return;
    }
    case 'HALF_ADDER': {
      const a = bit(levels, 'a');
      const b = bit(levels, 'b');
      out('sum', (a ^ b) as 0 | 1);
      out('cout', (a & b) as 0 | 1);
      return;
    }
    case 'FULL_ADDER': {
      const a = bit(levels, 'a');
      const b = bit(levels, 'b');
      const cin = bit(levels, 'cin');
      out('sum', (a ^ b ^ cin) as 0 | 1);
      out('cout', ((a & b) | (a & cin) | (b & cin)) as 0 | 1);
      return;
    }
    case 'ADDER4':
    case 'ADDER8': {
      const n = model === 'ADDER4' ? 4 : 8;
      let cin = bit(levels, 'cin');
      for (let i = 0; i < n; i++) {
        const a = bit(levels, `a${i}`);
        const b = bit(levels, `b${i}`);
        out(`sum${i}`, (a ^ b ^ cin) as 0 | 1);
        cin = ((a & b) | (a & cin) | (b & cin)) as 0 | 1;
      }
      out('cout', cin);
      return;
    }
    case 'ALU4':
    case 'ALU8': {
      // op: 00=add, 01=sub, 10=and, 11=or
      const n = model === 'ALU8' ? 8 : 4;
      const op0 = bit(levels, 'op0');
      const op1 = bit(levels, 'op1');
      if (!op1) {
        let cin: 0 | 1 = op0 ? 1 : 0; // sub: cin=1
        for (let i = 0; i < n; i++) {
          const a = bit(levels, `a${i}`);
          const bRaw = bit(levels, `b${i}`);
          const b = (op0 ? (bRaw ^ 1) : bRaw) as 0 | 1;
          out(`s${i}`, (a ^ b ^ cin) as 0 | 1);
          cin = ((a & b) | (a & cin) | (b & cin)) as 0 | 1;
        }
        out('cout', cin);
      } else if (!op0) {
        for (let i = 0; i < n; i++) out(`s${i}`, (bit(levels, `a${i}`) & bit(levels, `b${i}`)) as 0 | 1);
        out('cout', 0);
      } else {
        for (let i = 0; i < n; i++) out(`s${i}`, (bit(levels, `a${i}`) | bit(levels, `b${i}`)) as 0 | 1);
        out('cout', 0);
      }
      return;
    }
    case 'SOFT_RAM16': {
      // Continuous OE-gated read onto data0..7 (write is edge-committed).
      let addr = 0;
      for (let i = 0; i < 4; i++) addr |= bit(levels, `addr${i}`) << i;
      const byte = state.q[addr & 15] ?? 0;
      if (bit(levels, 'oe') === 1) {
        for (let i = 0; i < 8; i++) out(`data${i}`, ((byte >> i) & 1) as 0 | 1);
      }
      return;
    }
    case '7400': // NAND
      out('out', ((bit(levels, 'a') & bit(levels, 'b')) ^ 1) as 0 | 1);
      return;
    case '7404': // NOT
      out('out', (bit(levels, 'in') ^ 1) as 0 | 1);
      return;
    case '7408': // AND
      out('out', (bit(levels, 'a') & bit(levels, 'b')) as 0 | 1);
      return;
    case '7432': // OR
      out('out', (bit(levels, 'a') | bit(levels, 'b')) as 0 | 1);
      return;
    case '7486': // XOR
      out('out', (bit(levels, 'a') ^ bit(levels, 'b')) as 0 | 1);
      return;
    case '7474': {
      const q = state.q[0]! as 0 | 1;
      out('q', q);
      out('qn', (q ^ 1) as 0 | 1);
      return;
    }
    case '74157_1': {
      // MUX2: sel picks in0/in1
      out('out', bit(levels, bit(levels, 'sel') ? 'in1' : 'in0'));
      return;
    }
    default:
      return;
  }
}

/** Apply rising-edge / level-sensitive updates after nets settle. */
export function softLabCommitEdges(
  model: string,
  levels: Record<string, Level>,
  state: SoftLabState,
): void {
  const clk = levels.clk;
  const clkLvl: Level = clk === 0 || clk === 1 || clk === 'Z' ? clk : 'Z';

  switch (model) {
    case 'JK_FF': {
      if (rising(state.lastClk, clkLvl)) {
        const j = bit(levels, 'j');
        const k = bit(levels, 'k');
        const q = state.q[0]!;
        if (j && !k) state.q[0] = 1;
        else if (!j && k) state.q[0] = 0;
        else if (j && k) state.q[0] = q ^ 1;
      }
      break;
    }
    case 'T_FF': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr', 0) === 1) state.q[0] = 0;
        else if (bit(levels, 't') === 1) state.q[0] = state.q[0]! ^ 1;
      }
      break;
    }
    case 'REG4':
    case 'REG8': {
      const n = model === 'REG4' ? 4 : 8;
      if (rising(state.lastClk, clkLvl) && bit(levels, 'we') === 1) {
        for (let i = 0; i < n; i++) state.q[i] = bit(levels, `d${i}`);
      }
      break;
    }
    case 'SHIFT4_SIPO':
    case 'SHIFT8_SIPO': {
      const n = model.includes('4') ? 4 : 8;
      if (rising(state.lastClk, clkLvl)) {
        for (let i = n - 1; i > 0; i--) state.q[i] = state.q[i - 1]!;
        state.q[0] = bit(levels, 'sin');
      }
      break;
    }
    case 'SHIFT4_PISO':
    case 'SHIFT8_PISO': {
      const n = model.includes('4') ? 4 : 8;
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'load') === 1) {
          for (let i = 0; i < n; i++) state.q[i] = bit(levels, `d${i}`);
        } else {
          for (let i = n - 1; i > 0; i--) state.q[i] = state.q[i - 1]!;
          state.q[0] = 0;
        }
      }
      break;
    }
    case 'COUNTER4': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) {
          state.q.fill(0);
        } else if (bit(levels, 'load') === 1) {
          for (let i = 0; i < 4; i++) state.q[i] = bit(levels, `d${i}`);
        } else if (bit(levels, 'ce', 1) === 1) {
          let v = state.q[0]! | (state.q[1]! << 1) | (state.q[2]! << 2) | (state.q[3]! << 3);
          v = (v + 1) & 0xf;
          for (let i = 0; i < 4; i++) state.q[i] = (v >> i) & 1;
        }
      }
      break;
    }
    case 'COUNTER8': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) {
          state.q.fill(0);
        } else if (bit(levels, 'load') === 1) {
          for (let i = 0; i < 8; i++) state.q[i] = bit(levels, `d${i}`);
        } else if (bit(levels, 'ce', 1) === 1) {
          let v = 0;
          for (let i = 0; i < 8; i++) v |= (state.q[i]! & 1) << i;
          v = (v + 1) & 0xff;
          for (let i = 0; i < 8; i++) state.q[i] = (v >> i) & 1;
        }
      }
      break;
    }
    case '7474': {
      if (rising(state.lastClk, clkLvl)) {
        state.q[0] = bit(levels, 'd');
      }
      break;
    }
    case 'LATCH8': {
      if (bit(levels, 'en') === 1) {
        for (let i = 0; i < 8; i++) state.q[i] = bit(levels, `d${i}`);
      }
      break;
    }
    case 'CLK_DIV2': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) state.q[0] = 0;
        else state.q[0] = state.q[0]! ^ 1;
      }
      break;
    }
    case 'CLK_DIV16': {
      if (rising(state.lastClk, clkLvl)) {
        if (bit(levels, 'clr') === 1) state.q.fill(0);
        else {
          let v = state.q[0]! | (state.q[1]! << 1) | (state.q[2]! << 2) | (state.q[3]! << 3);
          v = (v + 1) & 0xf;
          for (let i = 0; i < 4; i++) state.q[i] = (v >> i) & 1;
        }
      }
      break;
    }
    case 'SOFT_RAM16': {
      if (rising(state.lastClk, clkLvl) && bit(levels, 'we') === 1) {
        let addr = 0;
        for (let i = 0; i < 4; i++) addr |= bit(levels, `addr${i}`) << i;
        let byte = 0;
        for (let i = 0; i < 8; i++) byte |= bit(levels, `data${i}`) << i;
        state.q[addr & 15] = byte & 0xff;
      }
      break;
    }
    default:
      break;
  }

  if (clkLvl === 0 || clkLvl === 1) state.lastClk = clkLvl;
  else state.lastClk = 'Z';
}
