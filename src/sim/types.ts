// Core data model for the transistor-level circuit simulator.
//
// The simulator works at the switch level: every net (a maximal group of
// electrically connected pins) carries a logic Level. Transistors are the
// only active devices — everything else (gates, latches, registers, a CPU)
// is built by wiring transistors together from the bottom up.

/** Logic level of a net. 'Z' means floating / not driven by anything. */
export type Level = 0 | 1 | 'Z';

export type TransistorType = 'N' | 'P';

export type ComponentKind =
  | 'transistor'
  | 'source' // fixed driver: VCC (1) or GND (0)
  | 'input' // user-toggleable driver, e.g. a switch
  | 'button' // lab pushbutton: momentary pulse or toggle
  | 'switch' // SPST pass: closed merges in↔out into one net
  | 'led' // lab indicator — sink only, like probe with a glow
  | 'sevenseg' // 7-segment display — sense pins a..g (+ optional dp)
  | 'clock' // configurable pulse generator (continuous or one-shot)
  | 'analyzer' // multi-channel logic analyzer instrument (sense pins)
  | 'busprobe' // multi-bit sense bus with hex/dec/bin decode on canvas
  | 'busswitch' // writable multi-bit DIP/hex bus driver (b0.. outputs)
  | 'buspass' // N SPST passes: closed bit i merges aᵢ↔bᵢ
  | 'tty' // machine TTY / soft console instrument (opens dialog)
  | 'probe' // read-only display of a net's value, no electrical effect
  | 'label' // named net tie point (same name => same net, see Circuit)
  | 'junction' // solder-dot / T-junction node (single pin; wires meet here)
  | 'port' // a chip's internal boundary marker, see hierarchy.ts fold()
  | 'chip' // an instance of a reusable ChipDef, see ChipLibrary.ts
  | 'ram' // behavioral read/write memory — see solver.ts's "RAM" section
  | 'rom'; // behavioral read-only memory (OE-gated, no write port)

export interface Point {
  x: number;
  y: number;
}

/** A pin belongs to exactly one component and is a node in the wiring graph. */
export interface Pin {
  id: string; // globally unique: `${componentId}:${pinName}`
  componentId: string;
  name: string; // e.g. 'gate' | 'drain' | 'source' | 'out' | 'a'
  pos: Point; // absolute canvas position, used for rendering & hit-testing
}

export interface TransistorComponent {
  id: string;
  kind: 'transistor';
  type: TransistorType;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: {
    gate: Pin;
    drain: Pin;
    source: Pin;
  };
}

export interface SourceComponent {
  id: string;
  kind: 'source';
  value: 0 | 1; // VCC = 1, GND = 0
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin };
}

export interface InputComponent {
  id: string;
  kind: 'input';
  value: 0 | 1;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin };
}

/**
 * Lab pushbutton.
 * Momentary: stays 1 while the mouse button is held (Editor); optional
 * `holdFrames` decay remains for scripted/legacy pulses.
 * Toggle: click flips `value`.
 */
export interface ButtonComponent {
  id: string;
  kind: 'button';
  mode: 'momentary' | 'toggle';
  value: 0 | 1;
  /** Remaining high frames while auto-pulsing (legacy / scripted). */
  holdFrames: number;
  /** Legacy auto-pulse length when `holdFrames` is set without pointer hold. */
  pulseFrames: number;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin };
}

/**
 * SPST pass-through switch. When `closed`, `in` and `out` share one net
 * (Circuit.computeNets unions them). Open = electrically separate. Not a driver.
 * `toggle` (default): click flips closed. `momentary`: closed while mouse held.
 */
export interface SwitchComponent {
  id: string;
  kind: 'switch';
  mode: 'momentary' | 'toggle';
  closed: boolean;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { in: Pin; out: Pin };
}

/** Lab LED — electrically a probe; drawn as a glowing indicator. */
export interface LedComponent {
  id: string;
  kind: 'led';
  label?: string;
  color: string; // CSS color for the "on" glow
  /**
   * Host override (soft machine PORT_LAB_LED). Soft Run skips transistor
   * step; when set, the LED glows from this flag and soft-canvas resolve
   * paints the LED net (see makeSoftCanvasResolve).
   */
  forceOn?: boolean;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { in: Pin };
}

/**
 * Common-cathode 7-segment glyph. Electrically sense-only (like LED/probe):
 * each pin lights its segment when driven high. Optional decimal-point pin.
 */
export interface SevenSegComponent {
  id: string;
  kind: 'sevenseg';
  hasDp: boolean;
  color: string; // CSS color for lit segments
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  /** a..g and optionally dp */
  pins: Record<string, Pin>;
}

/** Configurable pulse generator — continuous square wave or one-shot pulse. */
export interface ClockComponent {
  id: string;
  kind: 'clock';
  /** continuous: free-run while `running`; oneshot: fire pulseWidth frames on click/TRIG↑. */
  mode: 'continuous' | 'oneshot';
  value: 0 | 1;
  running: boolean;
  /** Full period in animation frames (high+low). Min 2. Used in continuous mode. */
  periodFrames: number;
  /** Frames spent high (1 .. periodFrames-1 continuous; pulse width in oneshot). */
  dutyFrames: number;
  /** Phase counter 0 .. periodFrames-1 (continuous). */
  phase: number;
  /** Remaining high frames while emitting a one-shot pulse. */
  holdFrames: number;
  /** Last sampled TRIG level — rising-edge detect for oneshot / start. */
  lastTrig: 0 | 1 | 'Z';
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin; trig: Pin };
}

/** Multi-channel logic analyzer — each `chN` pin is one sense channel. */
export interface AnalyzerComponent {
  id: string;
  kind: 'analyzer';
  channelCount: number;
  armed: boolean;
  /** Optional display names per channel (default `chN`). */
  channelLabels?: string[];
  /** Channel index that gates capture, or null for free-run. */
  triggerChannel: number | null;
  triggerEdge: 'rise' | 'fall' | 'either';
  /** Last sampled levels (for edge detect); length === channelCount. */
  lastSample?: (0 | 1 | 'Z')[];
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  /** ch0 .. ch{channelCount-1} */
  pins: Record<string, Pin>;
}

/** Multi-bit bus probe — sense pins `b0` (LSB) … `b{n-1}`; canvas shows decoded value. */
export interface BusProbeComponent {
  id: string;
  kind: 'busprobe';
  bitWidth: number;
  /** How to print the decoded unsigned value on the body. */
  radix: 'hex' | 'dec' | 'bin';
  label?: string;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  /** b0 .. b{bitWidth-1} */
  pins: Record<string, Pin>;
}

/**
 * Writable multi-bit DIP bus switch — drives `b0` (LSB) … `b{n-1}` from
 * `value` like a bank of Inputs.
 * `toggle` (default): paddle click flips that bit; readout click steps value.
 * `momentary`: paddle held drives that bit high until release.
 */
export interface BusSwitchComponent {
  id: string;
  kind: 'busswitch';
  mode: 'momentary' | 'toggle';
  bitWidth: number;
  /** Unsigned value; only the low `bitWidth` bits are driven. */
  value: number;
  radix: 'hex' | 'dec' | 'bin';
  label?: string;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  /** b0 .. b{bitWidth-1} — output drivers */
  pins: Record<string, Pin>;
}

/**
 * Bank of SPST pass switches. Bit *i* of `closed` merges pins `a{i}` ↔ `b{i}`
 * into one net when set. Not a driver (unlike `busswitch`).
 * `toggle` (default): paddle click flips that bit. `momentary`: bit closed while held.
 */
export interface BusPassComponent {
  id: string;
  kind: 'buspass';
  mode: 'momentary' | 'toggle';
  bitWidth: number;
  /** Bitmask: bit i closed ⇒ aᵢ connected to bᵢ. */
  closed: number;
  label?: string;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  /** a0..a{n-1}, b0..b{n-1} */
  pins: Record<string, Pin>;
}

/** Machine TTY / console instrument — dblclick opens the floating console. */
export interface TtyComponent {
  id: string;
  kind: 'tty';
  /** Linked RAM id (machine map); null until bound. */
  ramId: string | null;
  pos: Point;
  pins: Record<string, Pin>;
}

export interface ProbeComponent {
  id: string;
  kind: 'probe';
  label?: string;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { in: Pin };
}

export interface LabelComponent {
  id: string;
  kind: 'label';
  name: string; // nets sharing the same label name are electrically joined
  pos: Point;
  pins: { net: Pin };
}

/**
 * Solder-dot / T-junction — a single pin where wires meet (TC-style node).
 * Electrically just a shared pin; drawn as a small filled square on the net.
 */
export interface JunctionComponent {
  id: string;
  kind: 'junction';
  pos: Point;
  pins: { net: Pin };
}

/**
 * A chip's boundary marker. Ports don't exist as physical hardware — they
 * only mark, inside a ChipDef's internal circuit, which internal pin a
 * given external instance pin corresponds to. flatten() (hierarchy.ts)
 * consumes them and drops them from the simulated netlist entirely.
 *
 * `dir` is editorial (IN/OUT marker in the editor); electrically every port
 * is still a bidirectional `io` pin.
 */
export type PortDir = 'in' | 'out' | 'inout';

export interface PortComponent {
  id: string;
  kind: 'port';
  name: string; // matches one entry of the owning ChipDef's `ports` list
  /** Editor-facing direction; omitted/legacy loads as `'inout'`. */
  dir: PortDir;
  pos: Point;
  pins: { io: Pin };
}

/**
 * One placed instance of a reusable chip (see ChipLibrary.ts). Its pins are
 * dynamic — one per port the folded ChipDef exposes — unlike every other
 * component kind here, which has a fixed, named pin set.
 */
export interface ChipInstanceComponent {
  id: string;
  kind: 'chip';
  defId: string; // ChipDef.id in the ChipLibrary this circuit is edited against
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  /** Port names in stack order (same as ChipDef.ports at place time). */
  pinOrder: string[];
  /**
   * Local pin side per port name: -1 = left, +1 = right (from PortDir:
   * out → right, in/inout → left). Omitted on legacy saves ⇒ all left.
   */
  pinSide?: Record<string, -1 | 1>;
  /** Optional body width override (default CHIP_INSTANCE_WIDTH). */
  boxWidth?: number;
  /** Optional silkscreen text override (default ChipDef name). */
  marking?: string;
  /**
   * Slim lab saves: ChipDef.name when the stdcell body was omitted from
   * chipDefs. resolveStdcellInstances() rebinds defId after seedStandardCells.
   */
  defName?: string;
  /** ChipDef.revision when this instance was placed or last dived into. */
  defRevision?: number;
  /**
   * Soft Lab behavioral state (aliased across flatten like RAM `.bytes`).
   * Present when Soft Lab keeps this instance opaque instead of expanding it.
   */
  softState?: import('./softLab.js').SoftLabState;
  /** Canonical Soft Lab model key set during flatten when Soft Lab is on. */
  softModel?: string;
  pins: Record<string, Pin>; // keyed by port name
}

/**
 * A behavioral read/write memory — the one deliberate exception to "every
 * active device here is a transistor" (see ARCHITECTURE.md's "Real RAM").
 * `bytes[addr]` is read continuously onto the data pins while `oe=1` (like
 * a wide `buildTriStateBuffer` bank, just backed by a lookup instead of
 * constants); on a `clk` 0->1 edge with `we=1`, the *current* level of the
 * data pins is captured into `bytes[addr]` instead. Both are handled by
 * solver.ts, not by any transistor this component owns — it owns none.
 *
 * `pins` stays a flat `Record<string, Pin>` — `addr0..addr{N-1}`,
 * `data0..data{M-1}`, `we`, `oe`, `clk` — the same invariant every other
 * component here keeps (see hierarchy.ts's `flattenLevel`, which relies on
 * treating any component's `pins` as "a plain object of Pin values"
 * generically). `addrBits`/`dataBits` say how many of each exist; use
 * `ramAddrPins`/`ramDataPins` (library.ts) to get them back as ordered
 * arrays rather than re-deriving the naming convention at each call site.
 *
 * `bytes` is deliberately mutable, mutated in place by solver.ts on a
 * write edge, and deliberately *not* deep-cloned by hierarchy.ts's
 * flatten() (which structuredClone()s every other component every single
 * call) — a write has to survive into the *next* flatten() call, which is
 * a fresh JS object entirely, so the byte array itself, not the component
 * wrapping it, is this component's actual persistent identity. See
 * flatten()'s own doc comment for the reference-preservation this needs.
 */
export interface RamComponent {
  id: string;
  kind: 'ram';
  addrBits: number;
  dataBits: number;
  bytes: Uint8Array; // length === 2 ** addrBits; index i holds the byte at address i
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  pins: Record<string, Pin>;
}

/**
 * Behavioral read-only memory — same OE-gated read as RAM, no WE/CLK.
 * `bytes` is mutable from the MemoryEditor (load/fill) but never from the
 * solver. Same flatten aliasing rule as RamComponent.
 */
export interface RomComponent {
  id: string;
  kind: 'rom';
  addrBits: number;
  dataBits: number;
  bytes: Uint8Array;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  pins: Record<string, Pin>;
}

/** RAM or ROM — shared by MemoryEditor / pin helpers. */
export type MemoryComponent = RamComponent | RomComponent;

export type Component =
  | TransistorComponent
  | SourceComponent
  | InputComponent
  | ButtonComponent
  | SwitchComponent
  | LedComponent
  | SevenSegComponent
  | ClockComponent
  | AnalyzerComponent
  | BusProbeComponent
  | BusSwitchComponent
  | BusPassComponent
  | TtyComponent
  | ProbeComponent
  | LabelComponent
  | JunctionComponent
  | PortComponent
  | ChipInstanceComponent
  | RamComponent
  | RomComponent;

/**
 * A wire directly connects two pins. `waypoints` (if present) are purely
 * cosmetic bend points the wire is drawn passing through, in order from
 * `a` to `b` — they exist only for Renderer.ts and don't change the
 * electrical net at all: Circuit.computeNets() and solver.ts never look
 * at them, only at `a`/`b`.
 *
 * `bundleId` (if present) is cosmetic only — ribbon / bus wiring tags a
 * group so Renderer can draw a thicker trunk with fanouts.
 */
export interface Wire {
  id: string;
  a: string; // pin id
  b: string; // pin id
  waypoints?: Point[];
  /** Cosmetic bus-bundle tag from ribbon wiring; ignored electrically. */
  bundleId?: string;
  /** Route was shaped by hand; implicit re-routes (nudge, rotate, drag) leave it alone. */
  manual?: boolean;
}

/** Result of net resolution: every pin id maps to the net id it belongs to. */
export interface NetMap {
  netOf: Map<string, string>; // pinId -> netId
  pinsOf: Map<string, string[]>; // netId -> pinId[]
}

/** Simulation state: resolved level per net id, plus contention flags. */
export interface SimState {
  levelOf: Map<string, Level>;
  contended: Set<string>; // net ids where VCC and GND both drive — a short
  settled: boolean; // false if the relaxation loop hit the iteration cap
  iterations: number;
}
