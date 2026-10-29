# Architecture

A transistor-level digital circuit simulator: build gates from transistors,
gates from wires, and eventually a Z80-flavored 8-bit computer from gates —
all running in the browser, no accounts, no install.

This document covers what exists today: the simulation engine, hierarchy/
chip-folding, a canvas editor, and a transistor-level Z80-like CPU
(`buildZ80Cpu`) that executes the unprefixed opcode table, the `CB`
prefix table, the `ED` prefix table including a thin IM1 IRQ layer
(`EI`/`DI`/`IM 1`/`RETI`/maskable INT→`RST 38h`), and first `DD`/`FD`
slices (`IX`/`IY` registers, `LD IX/IY,nn`, `PUSH`/`POP IX/IY`, HL-clone
`ADD`/`INC`/`DEC`/`JP`/`LD SP`/`EX (SP)`, `(IX+d)`/`(IY+d)` LD /
`INC`/`DEC` / ALU `A,(IX+d)`, nested `DD CB`/`FD CB` BIT / SET/RES / rot
on `(IX+d)`/`(IY+d)`, and H→IXH / L→IXL (IYH/IYL) 8-bit register remap
for LD / LD n / INC/DEC / ALU `A,IXH/IXL`). A soft memory-mapped text TTY
(framebuffer + keyboard over `RamComponent.bytes`, canvas side panel), a
Z80-native command ROM in RAM (TTY `H`/`M`/`W`/`G`), and a throttled
MachineRunner auto-clock are the first machine-facing I/O layer — see
"Memory-mapped TTY (behavioral)". BASIC remains a later phase.

## Layout

```
src/sim/        Simulation core — no DOM, no rendering, fully unit-testable.
  types.ts        Data model: Pin, Component variants (incl. PortComponent /
                   ChipInstanceComponent / RamComponent — see "Real RAM"
                   below for the one behavioral, non-transistor component
                   kind here), Wire, NetMap, SimState.
  UnionFind.ts    Disjoint-set over string keys, used twice (see below).
  Circuit.ts      Flat netlist: components + wires -> resolved nets, plus
                   moveComponent() (translate a component and every one of
                   its pins by the same delta — see "Moving components"
                   below). Knows nothing about hierarchy — see hierarchy.ts
                   for that layer.
  solver.ts       The switch-level relaxation solver ("Real" engine), plus
                   RAM's own read (computeRamReadForces, per-iteration,
                   conditional, like a transistor) and write
                   (applyRamWrites, once per tick, edge-triggered) — see
                   "Real RAM" below.
  library.ts      Component factories + combinational gate builders
                   (NOT/NAND/AND/NOR/OR/XOR, buildMux2/buildMux4,
                   buildHalfAdder, buildFullAdder), plus makePort/
                   makeChipInstance. Every gate above NAND/NOR is composed
                   from smaller ones already in this file (AND = NAND+NOT,
                   XOR = 4 NANDs, a half adder = 1 XOR + 1 AND, a full adder
                   = 2 XOR + 2 AND + 1 OR, ...) — nothing here is a
                   transistor-level shortcut. Also buildTriStateBuffer (a
                   real bus driver: out=a while en=1, floats while en=0 —
                   see "Buses: tri-state drivers and contention" below),
                   buildDecoder (one-hot address decoding, same section),
                   and makeRam/ramAddrPins/ramDataPins/ramPortCount (see
                   "Real RAM" below).
  sequential.ts   Storage built from library.ts's gates: buildDLatch (level-
                   sensitive), buildDFlipFlop (edge-triggered master-slave,
                   two D-latches with complementary clocks), buildRegisterBit
                   (a D flip-flop gated on its *data* input by a write-enable
                   mux, not on its clock — see "Sequential logic" below).
  ChipLibrary.ts  ChipDef (an internal Circuit + ordered port names) and the
                   flat store of every folded chip definition.
  hierarchy.ts    fold() (Ctrl+G: cut a selection out into a reusable chip
                   — refuses a selection containing RAM, see "Real RAM"),
                   foldExposing() (fold()'s stub-wiring trick promoted to a
                   reusable helper — see blocks.ts), foldZ80CpuLeavingRam()
                   (see foldZ80.ts / "Folded Z80CPU placement"), and
                   flatten() (recursively expand every chip instance back
                   into transistors for the solver — see below; also where
                   RAM's `bytes` reference gets preserved across clones,
                   again see "Real RAM").
  foldZ80.ts      After + Z80CPU: fold the flat composite into one chip,
                   leaving RamComponent (and already-wired Inputs) on the
                   parent so Canvas redraw cost collapses.
  blocks.ts       Structures assembled *using the hierarchy system itself*
                   (fold a bit, place N instances of it) rather than more
                   raw transistors: buildRegister (N register-bit chip
                   instances sharing one WE/CLK net), buildAluSlice (a
                   1-bit ADD/AND/OR/XOR unit, op-selected by a 4:1 mux),
                   buildAlu (N ALU-slice chip instances ripple-carry chained
                   — each slice's cout wired straight into the next's cin),
                   buildProgramCounter (a buildRegister wrapped in a
                   per-bit half-adder + two chained 2:1 muxes: increments on
                   CLK, loads an external D when LOAD=1, RESET=1 forces 0
                   ahead of both — see "The program counter" below),
                   buildInstructionRegister (a fixed 8-bit
                   buildRegister, named for what it's used for — see "The
                   instruction register" below), buildRingCounter (an
                   N-phase one-hot control-FSM sequencer), buildStubRom
                   (a fixed-content, no-storage, tri-state-driven memory
                   stand-in — see "Buses..." and "A memory stub" below),
                   buildMinimalCpu (PC+RAM+IR+ACC+ALU sequenced by a
                   FETCH/INCREMENT/DECODE_EXECUTE FSM, running a tiny
                   made-up 8-slot instruction set — LDI/ADI/ANI/ORI/XRI/
                   STORE/LOAD — see "Decode and execute" below),
                   buildZ80Decoder (real `xxyyyzzz` opcode-field extraction
                   — x/y/z as one-hot line groups, no meaning assigned), and
                   buildZ80Cpu (a second, separate CPU executing real Z80
                   opcodes across `x=00`/`x=01`/`x=10`/`x=11`, plus the
                   `ED`-prefix table (block transfers, `NEG`, `ADC`/`SBC
                   HL,rr`, `RRD`/`RLD`, `LD (nn),dd`, `IN r,(C)`/`OUT (C),r`,
                   `LD I/R`, and thin IM1 IRQ — `IM 1`/`RETI`/`EI`/`DI`)
                   and the `CB` table (`BIT`, `SET`/`RES`, rotates/shifts).
                   First `DD`/`FD` slices: `IX`/`IY` + `LD IX/IY,nn` /
                   `PUSH`/`POP IX/IY` plus HL-clone ADD/INC/DEC/JP/LD SP/EX
                   plus `(IX+d)`/`(IY+d)` LD (`r,(IX+d)`, `(IX+d),r`,
                   `(IX+d),n`), `INC`/`DEC (IX+d)`, ALU `A,(IX+d)`, nested
                   `DD CB`/`FD CB` BIT / SET/RES / rot on `(IX+d)`/`(IY+d)`,
                   and H→IXH / L→IXL remap — see "DD: IX" / "FD: IY" /
                   "DD CB / FD CB" and the CB/ED/DD/FD prefix sections
                   below).
  stdcells.ts     seedStandardCells(): folds NOT/NAND/AND/NOR/OR/XOR/MUX2/
                   MUX4/HALF_ADDER/FULL_ADDER/D_LATCH/D_FF/TRI_BUF into
                   chips and registers them in a ChipLibrary — called once
                   at startup so the UI's chip palette has a full parts bin
                   immediately, the same way the reference project ships
                   one, instead of making every session refold every gate
                   from transistors by hand first.
  serialize.ts    Circuit/ChipLibrary <-> plain JSON, both directions — see
                   "Persistence" below for why whole-project and single-chip
                   import need genuinely different id strategies, and "Real
                   RAM"'s own "Persistence" subsection for the one field
                   (RamComponent.bytes) that isn't already JSON-shaped.

src/ui/         Canvas editor — thin layer on top of src/sim, swappable.
  Camera.ts       Pan/zoom: world<->screen transforms, zoomAt (cursor-
                   anchored), fit/centerOn. Pure math, no DOM.
  geometry.ts     Grid snapping, pin/component/wire hit-testing (per-kind
                   bounds, padded a few units past the drawn body — see
                   HIT_PAD — plus wires via distanceToSegment against the
                   same polyline Renderer.ts draws) — all in *world* space;
                   the camera never enters this file.
  Editor.ts       Tool state machine: place/wire (click-to-route, with bend
                   points)/select (incl. marquee multi-select, dragging one
                   or several selected components to move them together,
                   and grabbing a wire to select, kink, or drag an existing
                   bend point)/delete/dive-in/rename, hover tracking, plus a
                   chip-placement tool. handleMouseUp() is the sole click-
                   vs-drag decision point (see "Editing a drawn wire" and
                   "Moving components" below) — every Point in and out is
                   world space, main.ts does all screen<->world conversion.
  Renderer.ts     Draws the netlist under the camera transform, colored via
                   a LevelResolver callback (see "Rendering a nested level"
                   below) — chip instances and port boundary markers
                   included, with hover/selection glow and an adaptive
                   (zoom-aware) dot grid. Transistors render as IEEE-style
                   enhancement MOSFET symbols (gate plate, three channel
                   bars, substrate stub with N/P arrow tied to the source
                   bar). Wires draw as
                   rounded orthogonal polylines (HVH legs + curved corners)
                   so CMOS guts read like a schematic rather than spaghetti.
  MachinePanel.ts Soft text TTY: samples `ram.bytes[FB_BASE..]`, injects
                   keys, Run/Pause/Step/Reboot/speed, host Cmd + Load hex
                   + mini assembler — see "Memory-mapped TTY (behavioral)".

src/machine/    Soft machine map over RamComponent (not transistor devices).
  memoryMap.ts    Locked 12-bit demo layout: FB @ 0xE00 (32×8), keys @
                   0xF00/0xF01.
  tty.ts          paintCell / injectKey helpers for tests and the panel.
  monitor.ts      Legacy soft echo monitor opcode image (poll keys, CR/BS).
  commandRom.ts   Default Z80 command ROM (TTY H/M/W/G), assembled from
                   source via assembler.ts; line buf @ 0xD00, stack @ 0xDFF.
  softConsole.ts  Host panel Cmd: M/W/G/R/H + loadHexAt (JS helper; R
                   reloads command ROM).
  assembler.ts    Mini two-pass Z80 subset assembler (labels, DB/DW,
                   IX/IY/(IX+d), CB, common ED).
  MachineRunner.ts Soft Run (default): softZ80 interpreter on ram.bytes.
                   Gate speeds: time-budgeted transistor phases.
  softZ80.ts      Behavioral Z80 subset for interactive TTY (not timing-
                   accurate; gate Step still uses the real circuit).

src/main.ts     Bootstraps a Circuit + Editor + ChipLibrary + Camera, seeds a
                demo, owns the hierarchy navigation stack (dive in/out,
                breadcrumb, chip palette, auto-center on dive — see below),
                pan/zoom input (wheel, space/right-drag, a dedicated pan
                tool, on-screen zoom controls), per-tool keyboard shortcuts
                (built from each toolbar button's own `data-key` in
                index.html, so the key and its on-screen hint can't drift
                apart), arrow-key nudge for the current selection, and runs
                the requestAnimationFrame loop: optional MachineRunner
                phase budget -> flatten the *top* circuit -> step solver ->
                draw the *currently viewed* level -> sample the soft TTY
                panel when a 12-bit Z80 RAM is attached -> repeat.
                `+ Z80CPU` defaults to 12-bit address space, the Z80
                command ROM, auto-run after boot, then folds the
                transistor guts into one `Z80CPU` chip (RAM stays outside).

test/solver.test.ts      Engine correctness: NOT/NAND/AND truth tables, an
                          SR latch's feedback-held state, and short detection
                          — all built from raw transistors, nothing pre-baked.
                          buildTriStateBuffer: en=1 truth table, floats (no
                          forced driver) when en=0, holds its last driven
                          level via capacitive hold once en drops, and two
                          disagreeing enabled buffers on one net never settle
                          (contended fires on some pass, settled never does
                          — see "Buses" in the prose below for why a single
                          fixed snapshot isn't the right thing to assert).
                          buildDecoder: a 2-bit address selects exactly one
                          of 4 one-hot lines; a 1-bit address needs no AND
                          gates at all.
test/hierarchy.test.ts   fold()+flatten()+renamePort() correctness: a folded
                          NAND chip matches the raw gate's truth table, a
                          chip built from chip instances (2 levels of
                          nesting) still works, two instances of the same
                          chip def don't leak internal nets into each other,
                          renaming a port propagates to every existing
                          instance without touching any wire, and fold()
                          throws rather than folding a RAM component (see
                          "Real RAM").
test/Camera.test.ts      screenToWorld/worldToScreen round-trip, zoomAt keeps
                          the point under the cursor fixed, fit() centers and
                          scales correctly.
test/Circuit.test.ts     moveComponent translates a component and every pin
                          by the same delta, a wire between two moved
                          components still resolves to one net, an existing
                          wire's waypoints are untouched by either endpoint
                          moving, and an unknown id is a no-op.
test/geometry.test.ts    distanceToSegment against on/beside/beyond-either-
                          end cases; findWaypointNear vs. findWireNear pick
                          the right target and the right insertion index.
test/ram.test.ts         RAM read/write correctness (see "Real RAM"): reads
                          bytes[addr] while oe=1, floats while oe=0, we=1
                          suppresses RAM's own read-drive so an external bus
                          driver isn't fought, a we&clk rising edge captures
                          the bus into bytes[addr] and a held-high clk does
                          not re-write, a floating data bit commits as 0.
                          Its `tickFlatten` helper re-flattens on *every*
                          sub-tick (unlike sequential.test.ts's own `tick`,
                          which reuses one flattened Circuit) specifically
                          to prove a write survives the next flatten() call
                          — the actual bug this component's design guards
                          against, not just "the logic works once".
test/memoryMap.test.ts   Soft machine-map constants + paintCell / keyboard
                          helpers (see "Memory-mapped TTY (behavioral)").
test/machine-tty.test.ts Z80 program with addrBits=12 writes FB via
                          LD (nn),A; KEY_DATA read clears KEY_STATUS
                          (gate clear-on-read).
test/monitor.test.ts     Soft echo-monitor opcode image + loadMonitor.
test/machine-monitor.test.ts Echo monitor on addrBits=12: prompt + key
                          echo into FB, KEY_STATUS cleared.
test/command-rom.test.ts Z80 command ROM assemble + TTY H on addrBits=12.
test/soft-z80.test.ts    Soft interpreter: command ROM H/help + tiny ALU.
test/softConsole.test.ts Host M/W/G/R/H + loadHexAt (R → command ROM).
test/assembler.test.ts   Mini assembler: LD/JR/labels/DB, IX/IY/CB/ED,
                          + error cases.
test/fold-z80.test.ts    foldZ80CpuLeavingRam: RAM outside, top-level
                          component count collapses; clocks still tick.
test/serialize.test.ts   Project round-trip through a real JSON.stringify/
                          parse cycle, including a folded chip instance
                          still simulating correctly after reload; the id
                          counter advancing past everything a load reads in;
                          a chip-def bundle including its dependencies;
                          importing one into a *fresh* library with entirely
                          fresh ids, still simulating correctly; a RAM
                          component's `bytes` round-tripping as a real
                          Uint8Array (checking the JSON text itself, not
                          just the final value, since a silently-broken
                          plain object can still index correctly).
test/sequential.test.ts  Drives an actual clock/data sequence (not just a
                          single settle) to prove real sequential behavior:
                          a D-latch tracks while enabled and freezes while
                          disabled; a D flip-flop captures D only on the
                          CLK 0->1 edge and ignores it otherwise, including
                          across a falling edge; a register bit distinguishes
                          write-gating (WE=0 survives repeated clock edges
                          unchanged) from clock-gating.
test/blocks.test.ts      buildRegister: loads a 4-bit pattern on an edge,
                          holds it through further edges while WE=0, loads a
                          different pattern on the next WE=1 edge — built
                          from 4 *chip instances* of one folded register-bit,
                          not raw transistors. buildAluSlice: full ADD/AND/
                          OR/XOR op-select truth table, plus cout tracking
                          the adder regardless of which op is selected.
                          buildAlu: a 4-bit ripple-carry ADD table chosen
                          specifically to force a carry through multiple
                          internal bits before it settles (7+1=8, not just a
                          single-bit case), plus 16-bit wraparound with
                          cout=1, an increment via the chain's overall cin,
                          and bitwise AND/OR/XOR across the full width.
                          buildProgramCounter: a 3-bit full count 0->7->0
                          (forcing carry through all three bits at the
                          3->4 rollover), load-then-resume-counting to
                          prove LOAD genuinely overrides the increment, and
                          RESET forcing 0 even while LOAD=1 with a nonzero
                          D — proving RESET's priority over LOAD, not just
                          its existence.
                          buildInstructionRegister: confirms the fixed
                          8-bit width and a realistic opcode byte (0x4D)
                          latching/holding correctly — the load/hold logic
                          itself is buildRegister's test's job, not
                          re-proven here. buildRingCounter: rotates a single
                          hot bit through 3 phases and wraps back to phase
                          0. buildStubRom: the addressed word drives the
                          bus only while oe=1, floats otherwise, and every
                          address reads back its own word. The "Fetch loop"
                          describe block wires PC+ROM+ring-counter+IR into
                          an actual multi-cycle fetch, proving the
                          non-overlapping-clocks handshake described in
                          "A control FSM" in the prose below actually
                          works, not just that each piece works alone.
                          buildMinimalCpu: loads a real 8-byte LDI/ANI/
                          ORI/XRI/ADI/STORE/ADI/LOAD program into RAM and
                          drives the full FETCH/INCREMENT/DECODE_EXECUTE
                          cycle, checking ACC reads back 12, 8, 13, 4, 7,
                          7, 8, 7 in order *and* that RAM's STORE target
                          reads 0 before STORE runs and 7 only after — see
                          "Decode and execute" below for why this specific
                          program (every AND/OR/XOR pair picked so no two
                          ops could produce the same result from the same
                          inputs, a trailing LOAD whose result deliberately
                          differs from ACC's pre-LOAD value) is the
                          smallest one that can't be gotten right by
                          accident.
test/stdcells.test.ts    Places one instance of a sample of seeded chips
                          (NOT, XOR, HALF_ADDER, MUX2, FULL_ADDER, D_FF,
                          TRI_BUF — spanning different port counts and
                          in/out shapes) and checks it behaves like the raw
                          gate — this only
                          re-checks the fold's exposedPins *ordering*, since
                          the gate logic itself is already covered where
                          each builder is defined.
```

## Why two union-finds

`Circuit.computeNets()` groups *pins* into nets using the wiring topology
(which never changes while the simulation runs — it only changes when the
user edits the circuit). `solver.step()` groups *nets* into larger
conduction groups using which transistors currently conduct (which changes
every relaxation iteration, because conduction depends on gate levels that
the solver itself is solving for). Reusing the same `UnionFind` class for
both is fine; reusing the same *instance* would not be — they operate at
different granularity and different lifetimes.

## The solver

Every net has a level (`0`, `1` or `Z`). A group of nets joined by currently
conducting transistors (NMOS conducts when its gate net is `1`, PMOS when it is
`0`, a gate at `Z` conducts neither) takes its value from the forced drivers
inside it: one distinct level wins, two conflicting ones is a short (`contended`,
resolved to `Z` rather than modelled as a voltage), none means the group is
floating and keeps what its members remembered (capacitive hold, which is how an
SR latch remembers its state with no memory primitive). `step()` carries levels
from tick to tick and then, once, applies RAM writes, key-status clears and Soft
Lab edge commits. The long comment on `step()` in `src/sim/solver.ts` has the
details of the rules.

### Engines

Four implementations compute a tick; `SOLVER_ENGINE` (or `setSolverEngine`)
picks one, `ordered` is the default.

| Engine | Evaluation | Use |
|---|---|---|
| `ordered` | Priority queue over the static channel-connected groups, ranked by a depth-first reverse postorder of the gate dependency graph; groups commit in place | Default |
| `event` | Same synchronous passes as `jacobi`, but only groups whose inputs changed are recomputed | Reference that is bit-identical to `jacobi` |
| `jacobi` | Every net recomputed on every pass, all passes synchronous, at most 64 passes per tick | Original reference, also used for Soft to Gates POR ticks |
| `shadow`, `shadow-ordered` | Run `event` or `ordered` next to `jacobi` and throw with the differing nets on any divergence | Verification |

`ordered` evaluates a group once per tick on the acyclic part of a circuit and
re-evaluates groups only along real feedback, with a limit of 64 evaluations per
group per tick (`iterations` reports the largest count, `settled` is false when
a group hit the limit and its pending work is carried to the next tick). The
synchronous engines glitch their way through deep logic and, for the gate-level
Z80, often need more than 64 passes; the tick was cut off half-settled and the
half-settled state carried on, which made the Z80 run a different program than
the soft interpreter.

### Where `ordered` differs from the synchronous engines

- **A short is local.** In `jacobi` and `event` VCC and GND are ordinary nets, so
  any conducting path between them put every net tied to either rail at `Z`. In
  `ordered` the groups tied to a rail are never merged, and a group tied to both
  levels, or driven both ways, reads `Z` and is flagged `contended` on its own
  while the rest of the circuit keeps running. A momentary shoot-through in one
  gate no longer blanks the chip.
- **Storage nobody wrote stays undefined.** A latch or floating node whose
  power-up state depends on how the transients happened to interleave keeps `Z`
  in `ordered` instead of an arbitrary 0 or 1. Circuits and tests that read such
  a node must reset or seed it.
- **Bistable circuits** with more than one stable state may settle into a
  different one than `jacobi` does. Symmetric ones (for example a toggling
  flip-flop built from gates) settle instead of toggling on every pass.

`shadow-ordered` checks a settled tick against `jacobi` with a cap high enough to
settle, and accepts a difference only when a floating node upstream of it
explains it.

`Fast`/`Turbo` machine speeds are a separate matter: they set how many phases
the runner spends per animation frame and do not change what the solver computes.

## Hierarchy: fold() and flatten()

The mechanism that gets you from a NAND gate to a CPU without drowning in
wires (see `5. Chips & hierarchy` in the reference project's own help text).
Two functions in `hierarchy.ts` carry the whole feature; `solver.ts` is
completely unaware hierarchy exists.

- **`fold(parent, selectedIds, name, library, pos)`** — Ctrl+G. Cuts the
  selected components out of `parent` into a fresh internal `Circuit`,
  registers it as a `ChipDef` in the `ChipLibrary`, and replaces the
  selection in `parent` with one `ChipInstanceComponent`. A port is created
  for every *net that crosses the selection boundary* (has pins both inside
  and outside the selection) — not for every pin that looks like an
  interface, so a headless caller (see the tests) has to wire up throwaway
  stub components first if it wants specific pins exposed as ports, exactly
  as a UI user would by wiring test inputs/probes before selecting. VCC/GND
  are the deliberate exception: a crossing VCC/GND net never becomes a port;
  instead the chip gets its own local `source` component, so every folded
  chip is self-powered — see the doc comment on `fold()` for why this still
  adds up to one global VCC/GND net for the whole design once flattened.

- **`flatten(top, library)`** — recursively expands every chip instance
  (at every depth) back into the transistors/sources/etc. it's made of,
  producing one flat `Circuit` that `solver.step()` simulates unchanged.
  Every id gets namespaced per instance path (`${instanceId}/${...}`, deep
  for nested chips) so that two instances of the same `ChipDef` — whose
  `circuit` is *shared* for editing — get fully independent nets for
  *simulation*. This runs fresh every animation frame off the *top* circuit,
  regardless of which level the editor is currently showing — editing a
  `ChipDef`'s internals while dived into one instance is instantly visible
  in the live top-level simulation next frame, because `flatten()` always
  reads `library.get(defId).circuit` fresh.

### Rendering a nested level

Diving into a chip instance points the `Editor` at that `ChipDef`'s
`circuit` — but that circuit's pin ids are *local*, while the live
simulation's resolved levels are keyed by *flattened* net ids. `main.ts`'s
navigation stack (`NavFrame`) tracks a `pathPrefix` per level (the same
`${instanceId}/` scheme `flatten()` uses internally) and builds a
`LevelResolver` closure each frame — `localPinId => flatNetMap.netOf.get(pathPrefix + localPinId)` — so `Renderer.draw()` can show live colors at any
depth without knowing anything about hierarchy itself. Diving into a second
instance of the same `ChipDef` shows *that* instance's own state, not the
first one's, because the two dives accumulate different prefixes.

**Known limitation:** `fold()` assumes a selection's internal share of any
crossing net is already connected *within* the selection by some wire that
itself stays fully inside. A net that would only stay connected by routing
back out through the unselected part of the circuit isn't supported — an
unusual topology in practice, not worth the complexity it would add.

## Camera: pan, zoom, auto-center

`Camera` (in `src/ui/Camera.ts`) is deliberately the *only* place that knows
about screen coordinates at all — `x, y` is the world point centered in the
viewport, `scale` is zoom. Everything else (`Editor`, `geometry.ts`,
`hierarchy.ts`, the whole `src/sim/` tree) works purely in world space;
`main.ts` is the sole translation point, converting every mouse event with
`camera.screenToWorld()` before handing it to the `Editor`, and setting up
the canvas transform (`translate` to viewport center, `scale`, `translate`
by `-camera.x, -camera.y`) before `Renderer.draw()` draws a single thing.

- **Zoom** (mouse wheel, or the on-screen +/− buttons) calls
  `camera.zoomAt(cursorPoint, factor, ...)`, which keeps the world point
  under the cursor fixed on screen — the standard "zoom toward the mouse"
  feel, not zoom-from-corner.
- **Pan** has three equivalent triggers — a dedicated `pan` tool, holding
  Space, or a right-click drag — all funneled through one `panDrag` state
  in `main.ts` so `Editor` never has to know panning exists.
- **Auto-center on dive in/out** (`enterLevel()` in `main.ts`) calls
  `camera.centerOn(centroidOfComponents, 1)` every time the navigation stack
  changes — "auto-centered at 100%", matching the reference project's own
  dive-in behavior, computed fresh from whichever circuit is now being
  viewed (so it's correct depth-first no matter how deep the dive).

**Real bug caught live, worth remembering:** the first version of the
pan/drag wiring put the `mouseup` listener on `window` (so a drag started on
the canvas still resolves correctly even if the mouse is released outside
it — e.g. off the browser window). But `window` sees *every* mouseup on the
page, including the one from clicking a toolbar button, and a `click` on a
button fires *after* its `mouseup` — so clicking "fold" first ran the
canvas's own mouseup handling (a plain click onto empty world-space,
clearing the selection) and only then ran the button's own click handler
(`foldSelection()`, now with nothing selected — silent no-op). No error
anywhere; it just quietly didn't fold. Fixed with an explicit
`mouseDownOnCanvas` flag, set only by the canvas's own `mousedown` and
checked by the `window` `mouseup` handler before doing anything — this is
exactly the class of bug the project's standing documentation policy exists
to catch: a wrong-but-plausible result with no crash, no console error, and
no visual sign anything went wrong, caught only by actually driving the UI
end-to-end rather than trusting that a type-checked, unit-tested build must
behave correctly.

## Sequential logic: latches, flip-flops, registers

Every storage element here is built by relying on the exact same mechanism
that already makes an SR latch work: cross-coupled feedback + the solver's
capacitive hold on a floating net (see "The solver, in one paragraph"
above) — nothing sequential gets special-cased into the solver itself.

- **`buildDLatch`** (`sequential.ts`) is the textbook 4-NAND gated latch,
  built by literally reusing `buildSrLatch()`: `n1 = NAND(D, EN)` and
  `n2 = NAND(¬D, EN)` are exactly the active-low set/reset pair the SR latch
  already expects. Worked through in the doc comment; verified in
  `sequential.test.ts` by actually toggling EN and D in sequence and reading
  Q after each change, not just checking one settled state.
- **`buildDFlipFlop`** is the classic master-slave pair: a master latch
  transparent while CLK=0, a slave transparent while CLK=1, master's output
  feeding slave's input. This needs no explicit "on the edge, do X"
  sequencing code anywhere — a rising edge makes the master go opaque
  (freezing at whatever D was) in the very same relaxation pass that makes
  the slave go transparent (passing that frozen value through), purely
  because that's what the topology computes. Confirmed with a real edge
  sequence in `sequential.test.ts`: D changes while CLK is steady (high or
  low) don't move Q; a fresh D value only lands on the *next* rising edge.
- **`buildRegisterBit`** gates the flip-flop's *data* input through a 2:1
  mux (`WE=0` feeds Q back into D, so it re-latches its own value every
  tick) instead of gating the clock line. Real hardware avoids clock-gating
  for the same reason: a gated clock can glitch; a gated data input cannot.
  The test proves the distinction directly — the bit is clocked normally
  throughout, and only stops moving when WE drops, not when CLK stops.
- **`buildRegister`** and **`buildAlu`** (`blocks.ts`) are where hierarchy
  actually pays off: each folds one bit into a `ChipDef` once (cached per
  `ChipLibrary` via a `WeakMap`, so building several registers or ALUs
  doesn't clutter the chip palette with duplicate-named defs) and places N
  *instances* of it. `buildRegister` ties every WE pin into one net and
  every CLK pin into another; `buildAlu` ripple-carry chains the ALU
  slices — slice `i`'s `cout` wired straight into slice `i+1`'s `cin`,
  op0/op1 tied together across every slice so the whole width performs one
  operation at a time. Neither an 8-bit register nor an 8-bit ALU is 8x the
  hand-wired transistor count to reason about — each is N instances of
  something already proven correct once. `blocks.test.ts`'s ALU cases were
  picked specifically to exercise the chain, not just one slice in
  isolation — e.g. 7+1=8 forces a carry to ripple through three internal
  bits before the result settles, which a test that only tried single-bit
  carries could never catch a broken chain-wiring bug with.

### The program counter

`buildProgramCounter` (`blocks.ts`) is the first block built from *two*
kinds of already-proven pieces at once — a `buildHalfAdder` chain for
"+1" and a `buildRegister` for storage — rather than one gate type
ripple-chained N times like `buildAlu`. Per bit `i`:

```
reg.q[i] --+--> half-adder A          half-adder sum --> load mux in0 (load=0: incremented)
   carry --+--> half-adder B    D[i] ------------------> load mux in1 (load=1: external)
                                        load mux out --> reset mux in0 (reset=0: as above)
                                                  GND --> reset mux in1 (reset=1: force 0)
                                                              reset mux out --> reg.d[i]
```

`carry` starts at a constant-VCC pin (bit 0's half-adder carry-in), and
each half-adder's `cout` feeds the next bit's carry-in — the same
ripple-carry idea as `buildAlu`, just computing `+1` instead of a general
sum. `reg.we` is wired permanently high: the register latches on every
CLK edge regardless of `load`/`reset`, because those signals already
decide *what* value it latches (incremented, external, or forced 0) via
the mux chain ahead of `reg.d`, not *whether* it latches. That keeps the
same clock-glitch-avoidance property `buildRegisterBit` established (see
above) — no gated clock anywhere in this chip either.

`reset` is a second 2:1 mux chained *after* the load mux, not merged into
`load` with an OR: it picks between "whatever the load mux already
decided" (reset=0) and a hard-wired GND (reset=1), so `reset=1` forces the
counter to 0 regardless of what `load`/`d` are doing that same cycle — a
real reset line, not something every caller has to bolt on with its own
external OR/mux pair (an earlier version of this chip lacked `reset`
entirely, and the "Fetch loop" test below did build exactly that external
scaffolding as a workaround, before `reset` became a first-class pin here).

Both `buildHalfAdder`'s `ChipDef` and `buildMux2`'s are folded once and
cached per `ChipLibrary` via a `WeakMap` (`getHalfAdderChip`/
`getMux2Chip`), mirroring how `buildRegister`/`buildAlu` cache their own
per-bit chip — building several program counters in one session doesn't
spam the palette with duplicate `HALF_ADDER_1`, `HALF_ADDER_2`, ... defs.
The load mux and the reset mux are two separate *instances* of that same
cached `MUX2` def, not two different chips.

`blocks.test.ts` proves the increment/load behavior with a full 3-bit
count 0 -> 7 -> 0 (forcing carry to ripple through all three bits at the
3->4 rollover, the same kind of chain-wiring check `buildAlu`'s 7+1 case
exists for) and a load-then-resume-counting sequence, confirming `load`
genuinely overrides the increment rather than merely coexisting with it —
plus a dedicated `reset` test: force the counter away from 0, then raise
`reset` *while `load` is still 1 and `d` is still nonzero*, and confirm
`reset` wins.

**A same-edge race hazard, caught the same way as the fetch-loop one
below:** the first version of the `reset` test set `reset.value = 1` and
`clk.value = 1` in the same tick, and reset silently failed to take
effect — not because the mux-chain design was wrong (an isolated two-mux
chain, tested standalone, worked fine), but because `reset` was
*transitioning on the exact same edge* that was supposed to act on it,
the identical hazard the fetch-loop's non-overlapping-clocks section
documents. Fixed by letting `reset` settle for a tick with `clk` still
low *before* pulsing `clk` — the same discipline every clocked structure
in this codebase now needs to follow whenever a control signal changes
and a clock edge needs to see the result.

### The instruction register

`buildInstructionRegister` (`blocks.ts`) is deliberately the smallest
possible addition: `return buildRegister(parent, library, 8, pos);` and
nothing else. An IR has no increment logic, no carry chain, no second
mux — structurally it's a register, full stop, so it doesn't get a second
copy of `buildRegister`'s implementation with a different name slapped on
it. The whole point of the wrapper is the *name* (so `main.ts` and any
future control-FSM code can say "the IR" instead of "the register, the
one wired to the data bus, width 8") and the *fixed width*: unlike
`buildRegister`/`buildAlu`/`buildProgramCounter`, `+ IR` doesn't prompt
for a bit count, because a Z80 opcode byte is always 8 bits — asking would
just be an extra click that can only be answered one correct way.

Multi-byte instructions (the `CB`/`ED`/`DD`/`FD`-prefixed opcodes) don't
change this. They're handled by the control FSM issuing an extra fetch
cycle that re-loads this same 8-bit IR with the next byte, not by making
the register itself wider — decoding *how many* bytes an instruction takes
is sequencing logic, and belongs in the FSM (see "A control FSM: the
fetch loop" below), not in the storage element.

`blocks.test.ts` doesn't re-prove load/hold behavior here (that's
`buildRegister`'s test's job) — it only checks the two things this wrapper
actually adds: the width is fixed at 8 regardless of caller intent, and an
opcode byte latches on a WE&CLK edge and survives while WE=0, using a
realistic byte value (`0x4D`) rather than an arbitrary bit pattern.

**A lesson from writing `blocks.test.ts`, worth keeping in mind for
anything that drives a chip-instance-based circuit through multiple
ticks:** `flatten()` clones every component (see its doc comment) — call it
once and reuse the result, and it's a frozen snapshot; mutating an `Input`'s
`.value` on the original *pre-flatten* circuit afterwards has no effect on
that snapshot. `main.ts`'s live render loop already re-flattens on every
single animation frame for exactly this reason. The first version of the
register test flattened once outside its tick loop and got back `'Z'` on
every read, forever — not a solver bug, just a test not doing what the live
UI already does correctly. Fixed by re-flattening inside the loop; see
`tickHierarchical()` in `blocks.test.ts`.

## Buses: tri-state drivers and contention

`buildTriStateBuffer` (`library.ts`) is what makes a *bus* different from
an ordinary wire: several drivers can share one net, as long as at most one
has its `en` pin high at a time. `out = a` while `en=1`; while `en=0`, `out`
has no forced driver at all, so the solver's capacitive hold (see "The
solver, in one paragraph") keeps whatever level the net last saw, exactly
like a real bus wire's parasitic capacitance does. Built as two inversions
(an ordinary always-driven `buildNot`, feeding a classic 4-transistor
tri-state-inverter stage gated by `en`/`NOT(en)`) so the exposed behavior
is non-inverting — the second stage's outer pull-up/pull-down transistors
are both cut off when `en=0`, so neither VCC nor GND reaches `out` through
*any* path, regardless of `a`. No solver changes were needed for this: `Z`
was already a first-class level, and switch-level transistors already do
exactly what a real tri-state output stage does.

`buildDecoder` (`library.ts`) is the other half of "which driver gets to
talk this cycle": `bits` address inputs in, `2**bits` one-hot select lines
out, built from one `buildNot` per bit plus one `buildAnd` per extra bit
each output line needs. **It creates and returns its own address pins**
(`{ addr, lines }`), the same "build your own sink pins and hand them back"
shape every other builder in this file uses (`buildXor`, `buildFullAdder`,
`buildMux2`, ...) — it does not take an already-driven pin as a parameter.

**A real bug this shape was fixed to prevent, caught live while wiring
`buildStubRom`:** the first version of `buildDecoder` *took* `addr: Pin[]`
as a parameter and wired internal `buildNot`s to whatever was passed in.
`buildStubRom` then created its own internal `makeInput` components for
`addr` and `oe` and exposed *those inputs' own output pins* upward as its
public interface — meaning any caller who wired their own driver into
`rom.addr[i]` was adding a **second** driver on top of one that was already
there (the ROM's own internal `Input`, silently forcing 0 forever, since
the caller never gets a handle to that internal component to change its
`.value`). Both sides agreeing on 0 masked the bug completely; the moment a
test set an address bit to 1, the mismatched pair of forced drivers
corrupted `rom.oe`'s own net to `'Z'` — and `'Z'` propagates through
combinational logic just like 0 or 1 does: `AND(selected=1, oe='Z')` is
itself ambiguous (neither transistor in the pulldown network is surely on
or off), so it came out `'Z'` too, and so did every tri-state buffer it
gated, and so did the whole data bus. The failure showed up as "every
address reads back all zeros" — a symptom with no obvious link back to
"two components are fighting over the `oe` wire." Fixed by making
`buildDecoder` own its address pins and never accept a pre-driven one, and
by deriving `buildStubRom`'s exposed `oe` from a real gate's own sink pin
(the first per-word `buildAnd`'s `.b`) instead of a spare `Input`. The
general rule this confirms: **in this codebase, a "port" a caller is meant
to drive is always a bare gate/mux sink pin, never the output of a
pre-made `Input`/`Source` component** — the latter is *already* a driver,
and wiring another one on top of it is a hidden short that only announces
itself once the two disagree.

**A second, more surprising finding, from testing two disagreeing enabled
tri-state buffers on purpose:** the fight does not settle to a clean,
quiet `contended=true` and stay there — it *oscillates* forever between
`contended` and not, and the net itself reads `'Z'`, never a confidently
wrong 0 or 1. Why: VCC and GND are just ordinary nets to this solver, not
idealized zero-impedance rails immune to being merged — a real short
between them (which is exactly what two disagreeing enabled tri-state
outputs create) sets *their own* reported level to `'Z'` for that pass
too. That starves the very `buildNot` gates whose otherwise-stable output
was gating the fight, which un-shorts it; next pass those gates recover
(their real drivers, `a`/`en`, never moved), the short re-forms, and the
cycle repeats forever. `settled` never becomes `true`. This is the correct
behavior for a switch-level model with no idealized supply rails and no
concept of "this shouldn't be possible" — and it's the reason a live UI
polling `state.settled`/`state.contended` every frame (as this one does)
will visibly flag a real bus conflict as persistently unsettled, not paper
over it. `solver.test.ts`'s test for this checks that `contended` fires on
*some* pass and `settled` never does, rather than asserting one fixed
snapshot — a single-pass check would pass or fail depending on pure
iteration-count parity, which is not something worth asserting about.

The finding above describes the synchronous engines. With `ordered` a short only
blanks the group that has it (see "The solver").

`TRI_BUF` is seeded as a placeable stdcell (`stdcells.ts`) exactly like
every other gate, and is also folded independently (and cached per
`ChipLibrary`) by `buildStubRom` itself — the same accepted
duplicate-named-chip-def pattern `buildProgramCounter`'s own `HALF_ADDER`/
`MUX2` caches already established.

## A memory stub

`buildStubRom` (`blocks.ts`) is deliberately *not* small real memory: it's
a fixed, hand-authored ROM with **no storage and no write port** — every
bit of every word is wired straight from a constant `makeSource`. Building
even a few genuinely writable words from `buildRegister` would still not
be the representation real RAM needs at a realistic address-space scale
(building 64K of individually-addressable `REG_BIT` chip instances is not
a thing `flatten()`'s per-frame `structuredClone` could survive — see
"Known simplifications" below); that's a separate, later problem this
slice deliberately defers. What this slice *does* need to be real is the
**bus discipline**: `buildDecoder` produces one-hot select lines, each
word's bank of `buildTriStateBuffer` instances is gated by (its own select
line) AND `oe`, and every word's bank drives the same shared `data` bus —
at most one word is ever selected at a time, so the bus never sees the
two-driver contention described above. Swapping this stub for real,
writable RAM later should only mean replacing what drives each bank's
`buildTriStateBuffer.a` inputs (constants today, real per-bit storage
later) — the addressing and bus-sharing machinery doesn't change.

## A control FSM: the fetch loop

`buildRingCounter` (`blocks.ts`) is the sequencer a multi-cycle control
unit is built around: an N-phase one-hot "T-state counter" where the
single high `phase` bit rotates to the next position every clock edge,
wrapping from the last phase back to phase 0. Structurally it's
`buildProgramCounter` with the half-adder increment chain replaced by pure
wiring (`phase[i]`'s next value is just `phase[i-1]`'s current value) —
unlike a program counter, a phase sequencer never needs arithmetic. Like
every register-based structure here, it has no power-on reset: the caller
must seed a one-hot pattern through one `load=1` edge before relying on
the rotation, the same explicit-init discipline `buildProgramCounter`'s
own tests already require.

`blocks.test.ts`'s "Fetch loop" test wires `buildProgramCounter` +
`buildStubRom` + `buildRingCounter` + `buildInstructionRegister` together
into an actual 2-phase (T1/T2) fetch cycle — not to prove any one piece
(each is already proven above), but to prove the *handshake* between them:
T1 (`phase[0]=1`) asserts `rom.oe` and `ir.we` directly, so the word at
PC's current address lands in IR; T2 (`phase[0]=0`) leaves PC's own
increment mux free to advance it. PC's own "hold during T1" reuses
`buildRegisterBit`'s "gate data, not clock" trick, externalized: `pc.load`
is wired straight to `phase[0]`, and `pc.d` is wired straight back from
`pc.q` — "reload the same value" — rather than gating PC's own clock.

**The one genuinely new lesson from building this, worth remembering for
any future multi-register control logic:** `fsm.clk` and `pc.clk`/`ir.clk`
are two *separate* signals in this test, pulsed one at a time, never both
on the same edge. Real synchronous hardware safely chains "register A's
output gates register B's write" on one shared clock edge only because A's
new value takes real, nonzero propagation time to reach B — long enough to
satisfy B's setup requirement, but far shorter than a clock period. This
solver has no delay model at all: a single relaxation fixpoint doesn't
distinguish "A's value going into this edge" from "A's value coming out of
it." Wiring the ring counter's own `phase[0]` transition and IR's
`phase[0]`-gated capture to the *same* clock edge was tried first and
produces `'Z'` on the captured value, empirically, not a defensible
old-or-new answer either way — confirmed by hand-stepping the solver one
relaxation pass at a time, rather than assumed from Boolean-algebra
reasoning alone, which had (wrongly) predicted this specific wiring would
work. Driving the FSM and the datapath from **non-overlapping clock pulses**
(pulse the data clock, let everything settle, *then* pulse the phase
clock) sidesteps the problem entirely, and is not a workaround invented
for this simulator — it's the same fix real early two-phase-clock CPUs
(the Z80 included) used for the analogous reason that combinational logic
needs a quiet moment that isn't also somebody's clock edge. The very first
data-clock pulse (PC's reset) has this same hazard with itself — the ROM's
address is still PC's stale pre-reset value on that exact edge — so
whatever IR captures on that specific pulse is thrown away as garbage; the
real first fetch is the *next* data-clock pulse, once PC has had a moment
to settle at 0.

PC's self-loop can't also serve as its own power-on reset (there's no
"previous value" to hold before the first real edge exists), so this test
uses `buildProgramCounter`'s own `reset` pin for that, pulsed exactly once
at the start (see "The program counter" above) — an earlier version of
this test built its own external `buildOr`/`buildMux2` scaffolding for
this before `reset` became a first-class pin on PC itself.

## Real RAM

Everything up to this point — every gate, latch, register, the ALU, the PC,
the ROM stub's bus drivers — is built from nothing but transistors, exactly
as this whole project set out to do. `RamComponent` (`types.ts`) is the one
deliberate exception: a byte-addressable read/write memory backed by a
plain `Uint8Array`, read and written *behaviorally* by solver.ts rather
than simulated transistor-by-transistor. This isn't a shortcut taken
lightly — `buildStubRom`'s own doc comment already flagged it as a
"separate, later problem": building even a modest writable memory from
`REG_BIT` chip instances one address at a time (a real register per byte,
a real decoder line per byte) stops being something `flatten()`'s
per-frame `structuredClone` can survive long before it reaches a useful
size, let alone a real 64K Z80 address space. Real RAM needed a
fundamentally different representation, not a bigger version of the ROM
stub's.

### Shape

`makeRam(circuit, addrBits, dataBits = 8, initial?, pos)` (`library.ts`)
creates a component with `2 ** addrBits` bytes of storage (`dataBits` wide,
8 by default to match everything else in this project — IR, ALU, ROM
stub). `pins` stays a flat `Record<string, Pin>` — `addr0..addr{N-1}`,
`data0..data{M-1}`, `we`, `oe`, `clk` — exactly the same shape every other
component here has, on purpose: `Circuit.moveComponent`,
`hierarchy.ts`'s `flattenLevel` (its pin-renaming pass), and
`serialize.ts`'s id-notation pass all already iterate any component's
`pins` generically via `Object.values()`, assuming a flat collection of
`Pin`s. An earlier draft gave `RamComponent` a "natural"-looking shape —
`pins: { addr: Pin[], data: Pin[], we, oe, clk }` — which broke exactly
those three call sites the moment `moveComponent` tried to treat a `Pin[]`
array itself as a `Pin` and write a bogus `.pos` onto it. `ramAddrPins`/
`ramDataPins` (`library.ts`) reconstruct the ordered array view a caller
actually wants from the flat, named pins, so nothing outside those two
functions needs to know the naming convention.

### Reading and writing (solver.ts)

RAM's read side plugs into `step()`'s existing per-iteration relaxation as
an *additional conditional driver*, the same role a transistor's
conduction already plays: `computeRamReadForces` is recomputed every pass
from the current (possibly still-settling) `levelOf`, and — while `oe=1`,
`we` is not `1`, and every address bit is concretely resolved — forces
`bytes[addr]`'s bits onto the data pins, exactly like an enabled
`buildTriStateBuffer` bank would, just backed by a lookup instead of
constants. An unresolved address drives nothing that pass, same as a
tri-state buffer whose own enable/input isn't known yet. `we=1` suppressing
the read-drive (rather than the more "obvious" `oe`-only gate) is a
deliberate policy: real RAM chips document asserting `OE` and `WE`
together as invalid, and "don't fight your own write" is the least
surprising thing to do with that undefined case.

RAM's write side is fundamentally different, and lives *outside* the
relaxation loop: `applyRamWrites` runs once, after `step()`'s `while` loop
has already settled, comparing `prev`'s level for `clk` (the tick *before*
this one) against this tick's own settled level. A rising edge (not-1 ->
1) with `we=1` and a resolved address captures that tick's settled data-bus
bits into `bytes[addr]`. This can't be folded into the per-iteration
relaxation the way the read side was — "did an edge just happen" is a fact
about *two different ticks*, not something a single tick's own fixpoint
search could ever discover by iterating harder. An unresolved (floating)
data bit at write time commits as 0 rather than aborting the write or
throwing — a real chip has no such escape hatch either, and a byte array
has to end up holding some concrete value regardless.

`applyRamWrites` mutating `bytes` directly is the only side effect
anywhere in solver.ts — every other function there computes a fresh
`SimState` without touching the circuit. It's necessary here for the same
reason `Input.value` is already mutable component state living outside
`SimState`: `bytes` has to survive across ticks, and mutating the
component in place is how state generally persists in this codebase.
What's new is *who* does the mutating — normally it's external code (a
click handler, a test) changing an `Input`; here it's the solver itself,
reacting to a clock edge it detected.

### The flatten() persistence problem

`hierarchy.ts`'s `flatten()` calls `structuredClone()` on every component,
every single call — including a `RamComponent`, including one sitting
directly in the top-level circuit with no chip instances anywhere in
sight, because `main.ts`'s live render loop calls `flatten(topCircuit,
library)` unconditionally, every animation frame, regardless of whether
there's anything to expand. `structuredClone()` deep-copies a `Uint8Array`
into an independent copy, same as it does everything else — meaning a
write `applyRamWrites` makes on one frame's flattened clone would vanish
the instant the *next* frame's fresh `flatten()` call structuredClone'd a
new, still-original-valued copy from the never-mutated top-level
`RamComponent`. Byte written, byte immediately forgotten, every frame,
forever — a RAM that cannot remember anything is not RAM.

The fix: `flattenLevel` special-cases `kind === 'ram'`, saving a reference
to the *original* (pre-clone) `bytes` array before calling
`structuredClone()`, then overwriting the clone's own (independently
copied) `bytes` field with that saved reference right after. The clone and
the original now point at the *same* `Uint8Array` object — a write
`solver.ts` makes on the clone (during this frame's `step()`) is a write
to the original circuit's own component too, which the *next* `flatten()`
call will structuredClone from correctly, carrying the write forward.
`test/ram.test.ts`'s persistence test is the one that actually matters
here: it re-flattens (via a `tickFlatten` helper matching `main.ts`'s own
render-loop pattern, not the reuse-the-same-circuit `tick` helper
`sequential.test.ts` uses) on *every single sub-tick*, writes a byte,
selects a different address for a few more re-flattens, then comes back
and reads — proving the write survives real re-flattening, not just that
the read/write logic works once against a circuit that never gets cloned
away.

This reference-preservation trick is also exactly why RAM cannot be safely
folded into a reusable `ChipDef`: a folded chip's internal circuit is one
shared template every instance's own `flatten()` call expands from. For
ordinary components that's fine — each instance's *simulated* nets still
end up independent, thanks to per-instance-path id namespacing (see
"Hierarchy: fold() and flatten()" above). But every instance of a folded
RAM chip would all trace back to the *same* internal template component,
and therefore the *same* shared `Uint8Array` by reference — two instances
of "a RAM chip" would silently be one memory, not two. Rather than let
that footgun through, `fold()` throws if the selection contains a `ram`
component (`test/hierarchy.test.ts` covers this). RAM is placed directly
via its own toolbar button (`+ RAM`), wired by hand like a source or an
input, never folded, never chip-palette-listed.

### Persistence (serialize.ts)

`Uint8Array` is the one field in the entire data model that isn't already
JSON-shaped — `JSON.stringify` turns it into `{"0":1,"1":2,...}`, an
object with numeric-string keys and none of `Uint8Array`'s own methods or
`.length`, and `JSON.parse` hands that back exactly as broken. This
matters because both project export/import and single-chip export/import
round-trip through a real `JSON.stringify`/`JSON.parse`, not just an
in-memory copy. `toSerializedComponent`/`fromSerializedComponent`
(`serialize.ts`) convert `bytes` to a plain `number[]` at the boundary
(export) and back to a real `Uint8Array` (import); nothing else in either
file needs to know RAM exists. `test/serialize.test.ts` checks the
JSON text itself doesn't contain the broken shape, not just that the
final loaded value happens to look right (a `Uint8Array` that silently
became a plain object can still index correctly with `arr[5]`, so
asserting only on values read back could pass even with the bug this
guards against).

### UI

`+ RAM` (toolbar) prompts for address-bit width and places one instance at
the current view's center, the same width-prompt pattern `+ REG`/`+ ALU`/
`+ PC`/`+ FSM` use — except there's no `refreshChipPalette()` call
afterward, since RAM is a raw component, never a chip def. `Renderer.ts`
draws it as a chip-instance-shaped box (reusing `chipInstanceHeight` via a
`ramPortCount` helper, since its `pins` isn't a flat-`Object.keys().length`
shape the way a chip instance's is) in a distinct dark green, labeled
`RAM {size}x{width}`, so it doesn't read as just another folded chip at a
glance. `geometry.ts`'s hit-testing sizes its clickable box the same way.

## Memory-mapped TTY (behavioral)

Same performance rationale as Real RAM: a display or keyboard built from
gates would explode `flatten()` cost long before it was useful. The CPU
already exposes addressable `cpu.ram.bytes` and a separate port bus
(`ioPort*`); this slice uses **RAM windows**, not `IN`/`OUT`, so ordinary
`LD (nn),A` / `LD A,(nn)` drive the devices. No new `ComponentKind` —
display and keyboard are soft observers/writers of the same `Uint8Array`.

### Map (locked for the interactive machine demo, `addrBits = 12`)

| Region | Range | Size | Role |
|--------|-------|------|------|
| Program / general RAM | `0x000`–`0xDFF` | 3584 B | code + data |
| Text framebuffer | `0xE00`–`0xEFF` | 256 B | 32×8 cells, one ASCII byte each (row-major) |
| Keyboard status | `0xF00` | 1 B | `0` = empty, `1` = key waiting |
| Keyboard data | `0xF01` | 1 B | last ASCII (or mapped) code |
| Reserved | `0xF02`–`0xFFF` | rest | unused this slice |

Constants and helpers live in `src/machine/memoryMap.ts` and
`src/machine/tty.ts`. Unit tests keep their own smaller `addrBits`; only
the interactive `+ Z80CPU` path defaults to 12. Supporting that width
required wiring register-pair high bytes onto the RAM address mux when
`addrBits > 8` (`H`/`B`/`D` for bits 8+, same split `JP (HL)` already
used) — previously only the low register participated.

### Soft panel

`MachinePanel` (`src/ui/MachinePanel.ts`) owns a side-panel `<canvas>`
(not the transistor editor). Each animation frame it samples
`ram.bytes[FB_BASE .. FB_END)` and blits glyphs. When the panel is
focused, printable keys plus Enter/Backspace/Tab write `KEY_DATA` and set
`KEY_STATUS=1` (overwrite if unread — documented in the panel hint). Reading
`KEY_DATA` clears `KEY_STATUS` (soft SoftMemHooks; gate solver
`applyRamKeyClearOnRead` after a settled OE read). Explicit stores still work.

### Soft echo monitor (legacy)

`src/machine/monitor.ts` holds `MONITOR_BYTES` — a minimal poll/echo loop
(prompt `>`, CR/BS, wrap). Kept for tests and as a tiny reference image;
no longer the default `+ Z80CPU` program.

### Z80 command ROM

`src/machine/commandRom.ts` is the default boot image: real Z80 opcodes
assembled from `COMMAND_ROM_SOURCE` (via `assembler.ts`) at module load.
Layout: code @ `0000`, line buffer @ `0xD00` (32 B), stack @ `0xDFF`, FB
@ `0xE00`, keys @ `0xF00`. Typed on the **TTY canvas**:

- **H** — help string
- **M aaaa [n]** — hex dump (default 8, max 16 bytes)
- **W aaaa bb…** — poke bytes
- **G aaaa** — `JP aaaa` (leaves the monitor)

User programs should load at **≥ `0x200`** so they sit above the ROM.

### Host soft command console (panel)

The panel **Cmd** box remains a **JS helper** (`softConsole.ts`) for the
same H/M/W/G vocabulary when the Z80 is paused, plus **R** (reload
command ROM) and **Load hex @ addr** (`loadHexAt`, refuses `0xF00+`
unless allowed). Output goes to a `<pre>` under the TTY. Canvas keystrokes
always feed the Z80 ROM via `KEY_*`.

### Mini assembler (panel)

`assembler.ts` is a two-pass subset assembler (labels, `EQU`/`DEFL`,
`DB`/`DW`, common unprefixed ops this CPU runs — `LD`/`JR`/`JP`/`CALL`/
ALU/`INC`/`DEC`/stack/EX/… — plus `IX`/`IY`, `(IX+d)`/`(IY+d)`,
`IXH`/`IXL` remap, `CB` BIT/SET/RES/rot, `DD`/`FD CB` on `(IX+d)`, and
common `ED` blocks / `ADC`/`SBC HL` / `NEG` / `IM` / `RETI`). Listing lines
are always built unless `assemble(..., { listing: false })`. The panel
**Assemble → Load @** uses the Load-address box as origin, writes bytes
into RAM, and fills the hex box; **Assemble + Go** also patches `JP` at
`0000` and reboots. Still not a full commercial Z80ASM (macros, expressions,
undocumented `DD CB` `z≠6`, every `ED`/`CB` corner, etc.).

### MachineRunner auto-clock

`MachineRunner` wires `Input` drivers for `clk` / `phaseClk` / `reset` /
`aReset` / FSM seed / lean B–L+SP zero-seeds (parked far above the CPU;
IX/IY/shadows omitted to cut clutter), boots like the test harness, then
advances under UI control.

**Default speed is Soft:** `softZ80.ts` interprets unprefixed opcodes
against the shared `ram.bytes` (~8k ops/frame) so the TTY command ROM is
usable. Same performance trade-off as Real RAM / the panel — not
transistor timing. Soft Run desyncs gate-level PC/regs; **Reboot**
re-seeds both. Prefixed CB/ED/DD/FD throw in soft mode (use **Gates** +
Step).

**Gates slow/normal/turbo/free:** real circuit edges with a wall-clock
budget per animation frame (phase caps 2/10/40/400; free uses ~50ms).
Folding does not shrink the ~57k-net `step()` cost — Soft exists because
turbo-at-all-costs was unusable for interactive TTY. Soft at top level
also **defers** `flatten()` (canvas draws chip boxes with Z levels) and
defers gate FSM boot until a Gates speed is selected, so `+ Z80CPU` stays
interactive. Dive-in or Gates still pays cold `flatten()` (~1.4s once, then
cached).

**After page reload:** autosave restores the folded schematic + RAM, then
`attachSoft` rebinds Soft Run without the live `Z80Cpu` handle (seed Inputs
from the prior Place are ordinary components, not runner-owned). Soft /
Spectrum work; **Gates** stays Soft-only until File → Demo → Spectrum (or
Insert → Z80) places a new gate CPU. Spectrum soft session hints
(`switchlab.spectrumSession.v1`: model + last bundled demo id) restore ROM
boot and optionally re-Load that demo — not full MMU/tape state (use
`.SNA` / slots / `#sna=` for snapshots).

### Soft Z80 + TTY devices

`softZ80.ts` covers unprefixed opcodes plus CB/ED/DD/FD (IX/IY, block
moves, BIT/SET/RES/rot, …). Soft mem hooks: clear-on-read `KEY_DATA`,
port I/O via `SoftDevices` (TTY OUT `0x01`, keys `0x02`/`0x03`, 128×64
bitmap ports `0x20`–`0x22`). Mini BASIC (`basic.ts`) compiles LET/PRINT/
GOTO/END plus IF/FOR/NEXT/REM/INPUT and multi-item PRINT. Panel status
shows soft `PC=…`; leaving Soft while desynced auto-reboots. Soft bitmap
also overlays a small screen-fixed HUD on the transistor canvas when any
pixel is set (`main.ts` `drawSoftBitmapHud`).

### Folded Z80CPU placement (Canvas)

`buildZ80Cpu` still builds a flat composite (tests keep that path). The
interactive `+ Z80CPU` path then calls `foldZ80CpuLeavingRam`
(`src/sim/foldZ80.ts`): every placed component **except** the
`RamComponent` is folded into one `Z80CPU` chip. MachineRunner Inputs are
wired first so they become ports rather than disappearing into the chip.
Top-level `draw()` then paints one chip box + RAM + a handful of Inputs
instead of thousands of MUX/REG primitives — the Canvas 2D idle cost that
previously dominated after place.

`flatten()` namespaces non-`VCC`/`GND` label names with the chip-instance
prefix, so multiple folded chips no longer short `CLK`/`BUS*` nets. Dive-in
still shows the full transistor guts. Unit tests continue to use the
unfolded `buildZ80Cpu`.

Cold `flatten()` of a folded 12-bit Z80 (~127k components after shared-rail
place; was ~222k with per-transistor power Labels) is ~1.2s after fast
component clone + ChipDef expand cache (`hierarchy.ts`); previously ~4s via
`structuredClone`. Soft still defers flatten entirely.

**Place/fold latency (addrBits=12, `scripts/bench-flatten.mts` /
`scripts/bench-build.mts`):** build ~40–100ms after stdcell gates, label
cache, and folded control macros (`RAM_ADDR_BIT`, `PC_COMMIT_BIT`,
`PC_HOLD_OR`, `RAM_OE_OR`, `RAM_WE_OR`, `F_WE_OR`, `A_WE_OR` — RRD kept as
the final OE/WE term). Fold ~80ms on the smaller place graph. Flatten still
~1.2s for the expanded ~128k-transistor netlist.

Gate-path keyboard clear-on-read: when RAM OE samples `KEY_DATA` (0xF01),
the solver clears `KEY_STATUS` (0xF00) — same contract as soft
`SoftMemHooks`.

**Lab LED peripheral (soft bridge MVP):** `PORT_LAB_LED` (`0x40`) bit0 on
`SoftDevices.labLed`. `Insert → LED blink…` loads `ledBlinkRom.ts` (OUT
loop), places a canvas LED, and `MachineRunner.bindLabLed` mirrors the port
onto `LedComponent.forceOn`. Soft Run paints host probes `IORQ` / `IOWRITE` /
`IOREAD` / `M1` via `makeSoftCanvasResolve` (no flatten). Gates: ChipDef
`LAB_LED_DECODE` (`iorq` ∧ `wr` ∧ port `0x40` ∧ `D0`) drives the LED
(`placeLabLedGateDecode`). Folded Z80CPU exposes named bus ports `IORQ` /
`M1` / `RD` / `WR` / `MREQ` / `IOWRITE` / `IOREAD`. Nested I/O window: imm
OUT/IN assert strobes across PHASE2+PHASE3; INTACK is PHASE0+PHASE1 with
`IORQ∧M1` (instruction ring stays at 10). Soft Lab REG8/COUNTER4 remain
ordinary Library chips (ports `0x41`/`0x42` live in SoftDevices only unless
explicitly `bindLabReg` / `bindLabCounter`).

**Port TTY:** `Insert → Port TTY…` loads `portTtyRom.ts` (`OUT (01h),A`).
Soft and Gates rising `ioWrite` feed `SoftDevices` → host VT100
(`PORT_TTY_OUT` / `PORT_CONDAT`) — lab alternative to MMIO `FB_BASE`.

Gate builders no longer take unused `vcc`/`gnd` pins (`buildAnd(circuit,
pos?)`, etc.); power is always `tiePowerRail` (reuses the circuit's Source
pins when present). Soft↔gate parity covers unprefixed/CB, ED/DD, and
stack ops (PUSH/POP, CALL/RET Z/NZ/C/NC, RST, DD PUSH/POP IX, EX (SP),HL)
via multi-ring `gateCatchUp` on PC+SP; soft uses `addrBits` + `gateCallStack`
hooks so CALL/RET/RST match the gate's single-byte return stack.

### Explicitly later

Diminishing place returns: `PC_COMMIT_BIT` folded the deep PC-commit MUX
cascade (same recipe as `RAM_ADDR_BIT`). Per-register `LD_WE_OR_9` /
`LD_WE_OR_10` fold the B..L write-enable OR trees; `REG_DATA_BIT` folds the
four-deep data MUX cascade (IN r,(C) → SET/RES → CB rot → LD/POP).
`PAIR_COMMIT_BIT` folds each `wrapWithPairCommit` MUX2 layer (~86 call sites).
`A_DATA_BIT` folds A's 14-deep data MUX tower (8 instances); `SP_HALF_COMMIT_BIT`
plus `PAIR_COMMIT_BIT` fold SP's write layers; `F_FLAG_BIT` folds the F flag
cascade (8 instances, unused sels idle). Gate `ioPortAddr` is now 16-bit Soft
parity (`A:n` / `BC`); lab LED still matches low 8. A nested 4-T `busCycle`
ring + `busBusy` pin track IORQ windows (Soft `intAckWaits(4)`); freezing the
instruction ring while busy is reserved until phase-gated register WE is
one-shot (hold today would re-fire SP pushes every nest dataClk).


## Decode and execute: a tiny working CPU

`buildMinimalCpu` (`blocks.ts`) is the payoff of every earlier slice: PC +
RAM + IR + an accumulator register + an ALU, sequenced by a 3-phase
`buildRingCounter` — FETCH, INCREMENT, DECODE_EXECUTE — that actually runs
a (tiny, made-up) program instead of just fetching bytes. Nothing here is
a new kind of primitive; it's every composite this document already covers
wired together exactly the way "A control FSM: the fetch loop" proved the
non-overlapping-clock handshake works, extended with one more phase that
*does something with* the fetched instruction.

### The instruction set is deliberately not Z80

Real Z80 opcodes need a real decoder — 256 possible values, unevenly
grouped into one-byte, `CB`/`ED`/`DD`/`FD`-prefixed multi-byte, and
implicit-operand forms — which is a substantial piece of combinational
logic this slice does not build. Instead, `buildMinimalCpu` defines a
deliberately tiny encoding of its own, using its top 3 opcode bits:

```
bits 7-5 = 000: LDI imm    ACC <- bits 0-4 of the instruction  (0-31)
bits 7-5 = 001: ADI imm    ACC <- ACC + imm
bits 7-5 = 010: ANI imm    ACC <- ACC & imm
bits 7-5 = 011: ORI imm    ACC <- ACC | imm
bits 7-5 = 100: XRI imm    ACC <- ACC ^ imm
bits 7-5 = 101: STORE addr RAM[addr] <- ACC (ACC unchanged)
bits 7-5 = 110: LOAD addr  ACC <- RAM[addr]
bits 7-5 = 111, bit 4 = 0: JMP addr  PC <- bits 0-3 of the instruction
0xF0 (111_10000):          OUT       port register <- ACC
0xF1-0xFF (111_1aaaa):     JZ addr   PC <- bits 0-3 if ACC = 0, else continue
```

(`ANI`/`ORI`/`XRI` follow the 8080/Z80 assembly convention for "AND/OR/XOR
immediate" — the one place this made-up ISA's naming deliberately echoes
the real one it's a toy stand-in for.) STORE and LOAD's target address is
encoded in the same 5 low bits the ACC-writing instructions use for their
immediate, so `buildMinimalCpu` throws if asked for `addrBits > 5`: FETCH
addresses RAM from PC directly and has no such limit, but neither STORE
nor LOAD's target can reach an address wider than the field encoding it.

Decode is a real one-hot `buildDecoder` over all 3 opcode bits, not an ad
hoc gate tree like the 4-instruction version's — past 4 instructions, no
single opcode bit splits the encoding cleanly anymore (5 ACC-writing
instructions vs. 3 others isn't a power-of-two split any one bit can
express, the way `bit7` alone used to separate "ACC op" from "memory op"
cleanly for LDI/ADI vs. STORE/LOAD). `dec.lines[0..6]` name
`isLdi`/`isAdi`/`isAni`/`isOri`/`isXri`/`isStore`/`isLoad`; `lines[7]`
(`isExt`) is split by instruction bit 4 into JMP and the pair OUT/JZ, and
the pair by whether the low nibble is zero (a NOR of four bits). JMP and JZ
reload PC through a hold-or-target mux per PC bit, enabled by `jmpNow` or
`jzNow` (phase 2) ORed together; the target is 4 bits, so both reach addresses
0-15 only. JZ is taken when all 8 bits of ACC are 0 (a NOR tree on ACC), so it
cannot target address 0, whose encoding is OUT. OUT loads an 8-bit port
register from ACC. Every control signal is built from what an
instruction *should* do, so an instruction is inert for every signal
it does not drive. From there:

- **ALU op-select** (`alu.op0`/`op1`, matching `buildAluSlice`'s own
  00=ADD/01=AND/10=OR/11=XOR): `op0 = OR(isAni, isXri)`, `op1 = OR(isOri,
  isXri)`. ADI needs neither line — "both ORs default to 0" already gives
  it ADD, no separate case required.
- **ACC write-enable**: `phase2 AND OR(isLdi, isAdi, isAni, isOri, isXri,
  isLoad)` — a 6-input OR tree, since none of these lines share a single
  bit the way the 4-instruction encoding's ACC-writers did.
- **Memory access**: `memSel = OR(isStore, isLoad)`; `storeNow = isStore
  AND phase2` drives `ram.we`; `loadNow = isLoad AND phase2` is ORed into
  `ram.oe` alongside FETCH's own phase-0 read (the two never overlap:
  FETCH only happens in phase 0, a LOAD's read only in phase 2).

None of this gets its own clocked phase, on purpose: nothing needs to be
*captured* merely from deciding what to do, only from actually doing it
during DECODE_EXECUTE — the identical reasoning `buildStubRom`'s address
decode already relies on, where combinational logic settles for free
within whichever phase actually uses its result, with no dedicated cycle
spent just to "decide." A future, larger decoder might still warrant its
own phase if the decode logic gets deep enough that it can't safely settle
within one phase's non-overlapping-clock window — not needed yet, worth
remembering once it is.

### Wiring

PC's hold logic is unchanged from the 4-instruction version: `pc.load` is
`NOT(phase[1])` (a single `buildNot`, since the three phases are one-hot
— "not phase 1" and "phase 0 or phase 2" are the same signal) with `pc.d`
self-looped from `pc.q`, so PC holds during *both* FETCH and DECODE_EXECUTE
and only moves during INCREMENT.

STORE and LOAD both need RAM's address bus to briefly stop being "always
PC," exactly during their own DECODE_EXECUTE: a 2:1 mux per address bit,
selected by `memSel AND phase2`, picks between `pc.q[i]` (every other
case) and `ir.q[i]` (the instruction's own embedded target address) —
both instructions read that address the same way, so one shared mux
serves both, with no need to distinguish which is asking.

A bank of `buildTriStateBuffer`s drives `ACC` onto the *same* shared data
bus `ram.data`/`ir.d` already share for fetches, enabled only by
`storeNow`, so it never contests RAM's own drive — RAM drives during
FETCH and LOAD, ACC drives during STORE, mutually exclusive by phase and
opcode, never two drivers live at once — the same discipline
`buildStubRom`'s decoder-gated banks rely on, just gated differently.

`ACC`'s own next value is two *chained* 2:1 muxes, not one wider mux —
three genuinely different sources can land in ACC (`imm`, the ALU's
already-op-selected result, or the bus) and no single decoded bit ties
them into a clean 2-level tree the way `(bit7, bit6)` used to for 4
instructions. The first mux picks `imm` (`isLdi`) vs. the ALU's result
(everything else that writes ACC); the second overrides that with the
bus's current reading whenever `isLoad`. Neither stage's output is ever
latched for STORE, JMP or OUT (`accWeGate` is 0 for all three), so
what they compute in those cases doesn't matter.

**Three real bugs, all caught before this instruction set's test ever
passed clean:**

- The first version of this wiring never connected `ram.pins.clk` to
  anything at all — `buildProgramCounter`/`buildInstructionRegister`/
  `buildRegister` all expose their own `clk` pin for the caller to wire,
  but RAM's write path (`applyRamWrites`, see "Real RAM") needs a real
  edge on *its own* `clk` pin to detect, and nothing was providing one.
  Caught by re-reading the wiring before running anything, not by a
  failing test — a genuinely lucky catch, not a systematic one.
- Adding LOAD (to the 4-instruction version) replaced the LDI/ADI-only
  version's direct `wire(fsm.phase[0], ram.oe)` with an OR gate (`ramOe`,
  folding in `loadNow`) — but the *old* direct wire was never removed,
  leaving both wired to the same pin. Since `ramOe`'s own `a` input was
  *also* `fsm.phase[0]`, this tied the OR gate's output back onto one of
  its own inputs — a real short, not a benign redundancy, and specifically
  one that only misbehaves during a transition (both were briefly true
  *together* mid-relaxation while the ring counter was still settling into
  its next phase), which is exactly the kind of bug a single static
  settled-state check tends to miss. Symptom: the entire FSM's phase
  register — and everything downstream of it — read `'Z'` the moment the
  first `phaseClk` pulse past the initial seed fired, discovered by
  tracing signals pass-by-pass (`step(..., 1)` in a loop, the same
  technique "A control FSM"'s own non-overlapping-clock bug was diagnosed
  with) rather than guessing from the symptom alone. Fixed by deleting the
  old direct wire — `ram.oe` has exactly one driver (`ramOe.out`) now.
- Adding ANI/ORI/XRI/LOAD's 6-input ACC write-enable OR tree, the first
  version only OR'd `isLdi`/`isAdi`/`isAni`/`isOri`/`isXri` — five lines,
  forgetting that LOAD *also* writes ACC (from the bus, not the ALU/imm,
  but a write all the same). Every other signal decode produced was
  correct — `isLoad` correctly went high, `ram.oe` correctly drove the
  bus with the right byte, the address mux correctly picked the STORE'd
  address — right up until the very last step, where `acc.we` simply
  never asserted for LOAD, so ACC silently held its old value instead of
  capturing the freshly-read one. Traced by checking each signal in the
  chain one at a time, working backward from "the bus reads the right
  value but ACC doesn't" until the one boolean expression that
  structurally could not include LOAD (by construction, not by a typo in
  a single wire) turned up. The five-line version wasn't *wrong* about
  LDI/ADI/ANI/ORI/XRI — it was simply missing a sixth term, a reminder
  that "the instructions I was thinking about when I wrote this OR tree"
  and "every instruction that actually needs to be in it" can silently
  drift apart the moment a new instruction is added anywhere else in the
  same function.

### Verifying it actually runs a program, not just cycles its phases

`blocks.test.ts`'s test loads a real 8-byte program into a 16-word RAM
(`addrBits=4`) via `makeRam`'s `initial` parameter:

```
0x0C = 000_01100  LDI 12    ACC <- 12
0x4A = 010_01010  ANI 10    ACC <- 12 & 10 = 8
0x65 = 011_00101  ORI 5     ACC <- 8 | 5 = 13
0x89 = 100_01001  XRI 9     ACC <- 13 ^ 9 = 4
0x23 = 001_00011  ADI 3     ACC <- 4 + 3 = 7
0xAA = 101_01010  STORE 10  RAM[10] <- 7 (ACC unchanged)
0x21 = 001_00001  ADI 1     ACC <- 7 + 1 = 8
0xCA = 110_01010  LOAD 10   ACC <- RAM[10], i.e. 7
```

then drives the same non-overlapping `dataClk`/`phaseClk` pulse sequence
"A control FSM" established, checking ACC reads back 12, 8, 13, 4, 7, 7,
8, 7 after each DECODE_EXECUTE and, separately, that `ram.bytes[10]` is
still 0 *before* STORE runs and reads back 7 only *after*. Every
immediate/AND/OR/XOR pair was picked so each step's expected result
differs from what any *other* op would have produced from the same
inputs (12&10=8, 12|10=14, 12^10=6 are all distinct) — a decode bug that
wired the wrong ALU op0/op1 combination, or picked the wrong mux input
entirely, fails this trace instead of coincidentally matching it. The
final LOAD's expected result (7) is deliberately *different* from ACC's
value the instant before it runs (8) — a LOAD that was secretly a no-op
couldn't pass by coincidentally leaving ACC unchanged the way it could if
the loaded value happened to equal ACC's current one (the same reasoning
that caught the missing-`isLoad`-in-the-OR-tree bug above, now locked in
as a permanent regression check rather than something that had to be
rediscovered by hand each time). The program deliberately puts its STORE
target (address 10) past its own instructions (addresses 0-7) rather than
overlapping them — code and data genuinely sharing one RAM (von
Neumann-style) is real and worth eventually exercising on purpose, but
isn't what *this* test is trying to prove, so it isn't left as an
accidental side effect of a program that happened to be short.

### UI

`+ CPU` prompts for RAM address-bit width, then for program bytes (comma-
separated hex, parsed by `promptProgramBytes` in `main.ts` — unlike
`+ ROM`'s `promptRomBytes`, this doesn't round the word count up to a
power of two, since `makeRam`'s own `initial` parameter already tolerates
a program shorter than the RAM's full capacity, leaving the rest
zero-filled) and places the whole wired-together CPU at the current view's
center.

## A real Z80 decoder, and three real opcode groups executing

`buildMinimalCpu`'s own toy encoding proved the FETCH/DECODE/EXECUTE
*mechanism*; `buildZ80Decoder` and `buildZ80Cpu` (`blocks.ts`) are a
*second*, separate composite proving that same mechanism against *real* Z80
opcode bytes — not a replacement for the toy CPU (its entire byte space is
already spoken for), a demonstration that nothing about the earlier work was
made-up-ISA-specific. Three opcode groups execute for real: `x=10`
(ALU-on-register), `x=01` (`LD r,r'`), and — the newest, and by far the most
architecturally demanding — a real subset of `x=11`: flags, `SP`,
`PUSH`/`POP`, `RET`, `RST n`.

### The real decomposition: `xxyyyzzz`

Every Z80 opcode splits into three fields, per the canonical scheme (see
z80.info/decoding.htm): `x = bits[7:6]` (0-3, the broad instruction group),
`y = bits[5:3]` (0-7), `z = bits[2:0]` (0-7) — what `y`/`z` *mean* depends on
which `x` group. `buildZ80Decoder` only extracts these three fields as
one-hot line groups (three `buildDecoder` instances — 2-bit for `x`, 3-bit
each for `y`/`z` — wired straight to the right opcode bits, nothing more):

```ts
export interface Z80Decoder { x: Pin[]; y: Pin[]; z: Pin[]; }
```

It deliberately assigns no meaning to any line — that's every caller's own
job, the same separation of concerns `buildDecoder` itself already has from
whatever it addresses. `blocks.test.ts` checks this in isolation against 9
real opcode bytes (`0x00` NOP, `0x80` ADD A,B, `0x90` SUB B, `0xA7` AND A,
`0xA8` XOR B, `0xB0` OR B, `0xBE` CP (HL), `0x47` LD B,A, `0xC3` JP nn),
asserting the exact `{x, y, z}` triple each decodes to — proof the extraction
is correct independent of whether anything downstream executes those fields.

### `buildZ80Cpu`: the `x=10` group, for real

`x=10` (`dec.x[2]`) is the ALU-operation-on-a-register group — real opcodes
`0x80`-`0xBF`, `ADD`/`ADC`/`SUB`/`SBC`/`AND`/`XOR`/`OR`/`CP A,r` selected by
`y`, the register operand selected by `z` (`B C D E H L (HL) A`). Built from
exactly what `buildMinimalCpu` already proved: PC/RAM/IR, a 3-phase
`buildRingCounter`, `buildTriStateBuffer` banks sharing one bus — plus
`buildZ80Decoder` for the real field extraction and a genuine 6-register file
(B/C/D/E/H/L) alongside the accumulator (`A`). Full design detail (`ADD`/
`AND`/`XOR`/`OR` mapping straight onto `buildAluSlice`'s own `op0`/`op1`;
`SUB` reusing ADD's mode with the operand inverted and `cin` forced to 1;
`ADC`/`SBC`/`CP` decoded but not executed, for want of a flags register;
`(HL)` addressed through `L`'s own bits only, `H` never participating; the
7-source tri-buf operand bus; `A`'s own `aReset`, needed because this opcode
group has no `LDI`-equivalent to establish A's first value) lives in the doc
comment directly above `buildZ80Cpu` in `blocks.ts` — kept there rather
than duplicated here, since it's dense enough to want to stay next to the
code it explains.

### `x=01`: `LD r,r'`, added to the same composite

`x=01` (real opcodes `0x40`-`0x7F`) is straight register-to-register and
register<->`(HL)` movement, no arithmetic: `y` (destination) and `z`
(source) share `x=10`'s own 8-way register encoding. This landed in
`buildZ80Cpu` itself rather than a third composite — unlike
`buildMinimalCpu` vs. `buildZ80Cpu` (genuinely separate instruction sets,
no shared opcode space), `x=01` and `x=10` are two groups of the *same*
real Z80, sharing the decoder, the register file, the FSM, and — after this
change — the 7-source operand bus and the address-mux/`ramOe` machinery
too. Full design detail (why `y`/`z` mean destination/source here instead
of op/operand, the deliberately-inert `0x76` HALT slot, `LD (HL),r` as this
slice's first RAM *write*, the `groupActive` generalization replacing
`aluGroupNow` everywhere a signal needs to know "either group is decoding
right now," and the "mux ahead of `d`, OR into `we`" treatment 6 more
registers needed to become legal `LD` destinations) lives in the doc
comment above `buildZ80Cpu`, same as `x=10`'s.

The one new structural piece worth calling out here: **`B`/`C`/`D`/`E`/`H`/
`L` stopped being bare sink pins.** Before `LD r,r'`, nothing internal ever
wrote them, so a caller's seed wire *was* the register's own `d`/`we`. Now
that `LD r,r'` can write any of them, exposing the raw pins directly would
mean a caller's seed wire and the new internal LD-write path fighting over
one sink pin the instant both are live — the same "own your sink pins"
violation "Buses" already documents. Each of the 6 gets its own per-bit 2:1
mux (`sel` = `AND(ldGroupNow, that register's y line)`, `in0` = a *new*
external-facing seed pin, `in1` = the bus) plus a `we` OR — structurally
identical to what `aReset` already does for `A`'s reset path, just keyed by
a decoded destination instead of a one-shot external pulse. What
`Z80Cpu.rB.d`/`.we` (etc.) mean to a caller is unchanged in shape — still a
`Register`'s worth of sink pins to seed — but they're no longer the raw
`buildRegister` output underneath; that's now fully internal.

`blocks.test.ts` runs a 6-instruction program exercising every distinct
shape the group supports — `LD A,B`, `LD C,A`, `LD D,(HL)`, `LD (HL),E`, a
same-register no-op (`LD B,B`), and finally `0x76` itself — snapshotting
*every* register (plus `RAM[(HL)]`) after each step, not just whichever one
is expected to change, so a wrong-destination bug would show up as an
unexpected field moving rather than merely an expected one failing to. This
implementation passed that test, `tsc`, and the full suite on the first
attempt — genuinely, not a claim smoothed over after the fact — because it
is built almost entirely from mechanisms this composite's `x=10` work
already found and fixed real bugs in: the `groupActive`-gated `ramOe`
exclusion generalizes the exact bus-fight fix from "Two real bugs" below
instead of re-deriving it from scratch, and the destination-register mux
pattern is a direct structural copy of `aReset`'s already-proven shape. Real
new surface area (a second RAM-write path, a genuinely variable write
destination) existed here, but the *hazards* that surface area could have
hit were the ones already paid for.

### `x=11`: flags, `SP`, `PUSH`/`POP`, `RET`, `RST n`

The FSM gained a 4th phase for this — `buildRingCounter(..., 4, ...)`, not
3 — `FETCH`/`INCREMENT`/`EXEC1`/`EXEC2`. `PUSH`/`POP` move a genuine 8-bit
*register pair* (e.g. `B` and `C`, two independently-valued registers)
through memory, and with one address bus and one byte written per clock
edge, that fundamentally needs two sequential memory cycles — no way around
it, real hardware included. `EXEC1` handles the high byte (`B`/`D`/`H`/`A`),
`EXEC2` the low byte (`C`/`E`/`L`/`F`), matching real Z80 stack-push order.
`EXEC2` is a genuine no-op for `x=10`/`x=01` (their own logic only ever
checks `phase[2]`), so every instruction now costs one "wasted" `phaseClk`
pulse — a real, deliberate simplification (real hardware uses variable
M-cycle counts per instruction; this slice uses a fixed phase count for
every instruction, for architectural simplicity). `RET`/`RST n` only need
`EXEC1` for their own read/push, for a *different* reason: `PC` is only
`addrBits` wide in this slice (4-6 bits in every test so far, nowhere near
real Z80's 16), so a return address fits in one stack byte instead of two.

`SP` decrements for `PUSH`/`RST` (stack grows down), increments for
`POP`/`RET`, via `spAdder` — a *second* `buildAlu` instance (width
`addrBits`, not 8) permanently in ADD mode, `b` fanned from one shared
direction-control line to every bit. Flags (`F`) are computed from
`alu.out`/`alu.cout` for the same 5 ops `x=10` already executes, *plus*
`CP` (`y=111`) — `CP` never writes `A`, but real `CP` does write flags
("subtract, discard the result, keep only what it tells you"), and this is
the first turn giving it anywhere to write them. Real Z80 bit order (`S Z -
H - P/V N C`): `C` = adder carry for `ADD`, borrow-inverted for `SUB`/`CP`,
forced 0 for `AND`/`OR`/`XOR` (their `cout` is real but electrically
meaningless for a mode the output mux didn't select — see
`buildAluSlice`'s own doc comment); `Z` = NOR of `alu.out`; `P` = parity
(even) of `alu.out` — this implements *parity*, not the arithmetic-overflow
interpretation the same bit carries on real silicon, a deliberate
simplification; `S` = `alu.out[7]`; `N` = `isSubtract`, straight through.
`H` and the two undocumented bits aren't modeled — tied to `gnd`
unconditionally. `PUSH AF`/`POP AF` round-trip `F` through the stack
exactly like any other register pair, which is what makes flags a
genuinely *tested* feature this turn rather than merely a computed-but-
unobservable signal (nothing branches on them yet — conditional jumps
aren't in scope).

`0x76` (`y=110,z=110` in the `x=01` group, real `HALT`) stays the
deliberately inert slot "x=01: LD r,r'" above already documents. `x=11` has
its own version of this same discipline: `PUSH`/`POP`'s `z=101`/`z=001`
columns only have 4 valid `y` values each (`000,010,100,110` selecting
`BC`/`DE`/`HL`/`AF`) — the rest of those columns are `CALL nn`, `EXX`,
`JP (HL)`, `LD SP,HL`, and the `CB`/`ED`/`DD`/`FD` prefix bytes, none
implemented — so `isPushValid`/`isStackReadValid` explicitly gate on the
valid subset, keeping the rest inert by construction rather than letting
them silently corrupt `RAM`/`SP` if one's ever fetched. `RST n` has no such
gap — `z=111`, every `y` (0-7) is a real, fixed target (`y*8`,
`0x00`-`0x38`).

**Five real bugs, all found live** — this is the deepest, most
interconnected piece of circuitry this project has built, and it produced
the highest bug count of any single turn this whole session. Each is a
genuinely different failure mode, not variations on one theme:

- **A two's-complement sign error in `spAdder`'s own decrement.**
  `b`=all-1s (already the complete two's-complement encoding of `-1`) needs
  `cin=0` to compute `SP-1` — the first version used `cin=1` unconditionally
  (matching the increment case, `b=0,cin=1` for `SP+1`), which silently
  computes `SP + 0x3F + 1 = SP + 0x40 ≡ SP (mod 64)` — every decrement a
  no-op, `spAdder.out` reading right back as `sp.q`, no error, no
  contention, just a `PUSH` that never actually moved the stack pointer.
  Caught by direct inspection of the arithmetic, not a symptom trace.
- **A real timing asymmetry between RAM and every other register, found
  addressing the stack.** The first version computed a write address from
  `spAdder.out` and a read address from `sp.q` directly, reasoning from
  what a *fully settled* snapshot of the circuit showed after an edge — and
  wrote correctly (`PUSH` landed bytes in the right place) but read one
  address too far every time. The actual mechanism, per `buildDFlipFlop`'s
  own doc comment ("the master closes first, freezing at the D value it
  *last saw*" while `CLK` was still low): a real register's capture reflects
  whatever was stable *before* an edge started, not whatever the circuit
  settles to *during* it — while RAM (the deliberate non-transistor
  exception) commits its write using the address as fully settled, which
  *does* reflect the post-edge value. Two structurally different components
  asked for two different things (new address for a write, old address for
  a read) — and it turns out bare `sp.q`, wired identically into both mux
  paths, is correct for *both*, for opposite reasons. Two wrong turns
  preceded this: a dedicated `sp.q-1` adder for reads (reasoning from the
  same misleading fully-settled snapshot), and suspecting insufficient
  relaxation depth (retried at 2000 iterations — no change, ruled out,
  since the actual mechanism is structural, not a matter of more passes).
  See the doc comment on the address mux in `blocks.ts` for the full
  derivation.
- **`RST`'s own jump target used the wrong kind of decoder output.**
  `dec.y` is 8 one-hot "`y==k`" *decode* lines, not `y`'s own binary bits —
  `dec.y[i-3]` (the first version's formula for the target's bits 3-5) is a
  category error, not an off-by-one: no bit of a one-hot line ever
  reconstructs the numeric value it decoded from. Every `RST n` silently
  targeted address 0 (`dec.y[k]` for any `k` outside a narrow accidental
  range reads 0, and PC's own reset already made 0 a "plausible-looking"
  wrong answer). Fixed by reading `y`'s real bits straight off the opcode
  (`ir.q[3..5]`, `y`'s field in the `xxyyyzzz` layout) instead.
- **`RST`'s push-data driver read `PC` *after* `PC` had already jumped.**
  First version pushed and jumped in the same `EXEC1` edge — reasoning that
  nothing here depends on a memory access completing first, which is true
  of the *stack write itself*, but not of what data that write pushes. The
  push-data tri-state driver reads `pc.q` combinationally; `PC`'s own mux
  *also* updates `pc.q` on that identical edge (the jump); RAM's write (per
  the timing-asymmetry bug above) samples the fully-settled state — which,
  by the time it looked, already showed the jump target, not the return
  address. A later `RET` landed right back at the `RST` target instead of
  resuming after it. Fixed by splitting `RST` across both phases after
  all — not because the push itself needs two bytes (it doesn't — same
  one-byte-`PC` coincidence as `RET`), but to give `PC`'s own jump a clean
  edge nothing else is racing: push on `EXEC1`, jump on `EXEC2`.
- **A driver that was simply never built.** The very first pass wired
  `SP`'s decrement and RAM's write-enable/address for `RST` correctly, and
  *nothing looked wrong* — right up until `RET` tried to read the pushed
  byte back and got whatever the shared bus had last held, because no
  tri-state bank existed to actually drive `PC`'s value onto it during
  `RST`'s own write. `PUSH`'s 4 register pairs each got a driver bank;
  `RST`'s own "operand" (`PC` itself) was overlooked entirely until the
  round-trip test — `RST` then `RET` — made the gap impossible to miss.

`blocks.test.ts`'s program pushes `AF` and `BC`, deliberately corrupts `A`,
`B`, and `C` afterward (so a `POP` that silently failed would leave the
*corrupted* values in place, not coincidentally the right ones), pops both
back, then runs `RST 30H` into a two-instruction subroutine elsewhere in
RAM and `RET`s back — checking not just that control flow *returned*, but
that it returned to the exact right address (the resumed instruction writes
a value nothing else in the program would produce, so a wrong `RET` target
executing a *different* opcode there would be caught, not coincidentally
pass).

### Two real bugs, found tracing this composite's first real program

`blocks.test.ts` runs `ADD A,B` / `SUB C` / `AND B` / `XOR C` / `OR (HL)` /
`ADD A,A` in sequence, checking `A` after each (`5, 3, 1, 3, 11, 22` —
distinct enough that a wrong op or a wrong operand source both fail the
trace, the same "no coincidental pass" discipline "Verifying it actually
runs a program" established). Getting there took two rounds of real
debugging, both diagnosed with the session's usual pass-by-pass
`step(..., 1)` tracing:

- **`ramOe` racing the operand bus.** The first version gated RAM's FETCH
  read with a bare `OR(phase0, hlNow)` — the same shape `buildMinimalCpu`
  uses for its own `ramOe`. But `buildMinimalCpu`'s version is safe only
  because `isLoad`/`isStore` are mutually exclusive *decoded opcode* lines,
  stable for an instruction's whole DECODE_EXECUTE; here, the thing that
  needed excluding was `aluGroupNow` — derived straight from `phase2`, a
  *different* phase bit than `phase0` drives `ramOe`'s FETCH term. A ring
  counter's own rotation passes through a genuine transient where the old
  and new phase bits both read 1 (confirmed by trace: `phase=[1,0,1]`
  mid-relaxation, an expected artifact of this zero-delay solver, not a bug
  in the counter) — and the 7 operand-bus tri-buf banks (gated off
  `aluGroupNow`, one hop behind `phase2`'s own drop) took a few relaxation
  passes longer to physically release the bus than RAM's own read path took
  to start driving it again for the *next* fetch. The two didn't race by a
  full phase; they raced by a couple of relaxation passes, several hops
  downstream of the phase register itself — invisible at the phase register
  but a real, if transient, bus fight on `ir.d`, big enough (thousands of
  contended nets) to cascade through the shared VCC/GND rails and corrupt
  the phase register too, the same corruption-signature "Decode and
  execute"'s own `ram.oe` bug left. Fixed by deriving the exclusion
  structurally rather than trusting two independently-timed signals to
  settle in lockstep: `ramOe`'s FETCH term is now `AND(phase0,
  NOT(aluGroupNow))`, not bare `phase0` — tying RAM's drive to the *same*
  signal (and thus the same settling latency) the operand banks release on,
  so neither can outrace the other by construction.
- **Not enough relaxation passes to settle, once the fix above was in.**
  With `ramOe` fixed, `step 0` (`ADD A,B`) still read `A=128` instead of
  `5` — not corruption (`contended=0`), a genuinely wrong *settled* value.
  Tracing `alu.out` directly (a temporary `__debug` hook, removed once done)
  showed it wrong even *before* the capturing clock edge: `ir.d` correctly
  read `5` (B's value), but `alu.out` read `128` regardless. This
  composite's deepest combinational path (operand enable -> tri-buf ->
  per-bit XOR invert -> an 8-bit ripple-carry adder, each stage waiting on
  the previous bit's carry -> a 4:1 op-select mux -> the `aReset` mux chain)
  is simply longer than `buildMinimalCpu`'s ever was, and `step()`'s own
  default `maxIterations=64` ceiling (see solver.ts) isn't enough to fully
  propagate a value through it. Fixed by giving this one test's own
  `tick()` a `step(..., 200)` call directly — flattening once and letting
  `step()`'s *own* internal relaxation loop run deep, rather than routing
  through the shared `tickHierarchical(..., n)` helper, whose outer loop
  re-flattens (a full circuit clone) *n* separate times per tick; raising
  *that* n to compensate would've reached the same settled state but at
  roughly n times the clone cost, turning a 15-second test into one that
  didn't finish in 5+ minutes (empirically confirmed — the first fix
  attempt).

### `x=00`, `z=3`: `INC rr`/`DEC rr`, and why nothing broke live this time

`INC BC`/`DEC BC`/`INC DE`/`DEC DE`/`INC HL`/`DEC HL`/`INC SP`/`DEC SP`
(real `0x03`/`0x0B`/`0x13`/`0x1B`/`0x23`/`0x2B`/`0x33`/`0x3B`) — the first
`x=00` opcodes this slice executes, chosen out of that whole unimplemented
group for the identical reason `RST` was chosen out of `x=11`: single-byte,
single-cycle (`EXEC1` only, `EXEC2` a genuine no-op here same as `x=10`/
`x=01`), no new FSM phase, no immediate-byte fetch. Real Z80 affects *no
flags at all* for this family (unlike `INC`/`DEC r`, the 8-bit sibling this
doesn't implement) — a real simplification in this instruction's *favor*,
not a corner cut: nothing here touches `F`, and the new test asserts it
stays exactly what an `XOR A,A` set it to through all twelve instructions.

`BC`/`DE`/`HL` each get their own dedicated 16-bit `buildAlu` instance —
`spAdder`'s exact pattern (permanent ADD mode, the pair's own `DEC` `y`-line
fanned to `b`, `cin` that line inverted — see `spAdder`'s own doc comment
for the full `-1`/`+1` derivation and the `cin` mistake it guards against)
at width 16 instead of `addrBits`, `a[0..7]` wired to the low register's
`q`, `a[8..15]` to the high one's — B/D/H high, C/E/L low, the same byte
order `PUSH`/`POP` already established. Three separate always-computing
adders rather than one shared, input-muxed adder: simpler to verify
correct per pair (no 3-way input-selection mux to get wrong), and
component count was never the constraint here — the solver already
handles a composite this size fine. `SP` reuses `spAdder` itself rather
than getting a fourth: `spWantDec` widens the original
`STACK_WRITE_NOW`-only direction control with `DEC_SP_NOW` via a plain
`OR`, which is exactly the original signal whenever `DEC_SP_NOW=0` (every
`x=11` case) — `dec.x`'s one-hot decode makes the two mutually exclusive
by construction, not by this OR happening to work out.

Each pair's write-back is a *third* mux-ahead-of-`d` layer
(`wrapWithPairCommit`) stacked on the existing LD-r,r'/POP wrapper
(`ldExternal`) `B`/`C`/`D`/`E`/`H`/`L` already have, not a rewrite of it —
the same layering `A`'s own `aWeStage`/`aWeFinal` already uses for two
conditions, one layer deeper here for three. `inner.d`/`inner.we` in that
helper are the layer *below's* own sink pins (`ldExternal`'s `extD`/
`weOr.b`) — the new mux/OR drive *into* them, the same direction every
other layered write-enable in this file already uses.

Unlike every other `x=10`/`x=01`/`x=11` piece added to this composite so
far, this one had no bug to find live — the new test (`buildZ80Cpu — x=00,
z=3`) passed on its first real run, all twelve instructions, both carry
directions, `F` untouched throughout. Worth recording as data, not just
silence: the earlier sections' repeated "found live" bugs weren't evidence
that every addition to this file needs one before it's trusted — they were
each a specific, traceable mistake (a wrong `cin`, a category error between
one-hot decode lines and real bits, a same-edge race, a missing driver
bank, an unscoped phase condition), and this piece avoided all of them by
directly reusing already-debugged patterns (`spAdder`'s own `cin` trick,
`aWeStage`/`aWeFinal`'s own layering) rather than improvising fresh ones.

### `x=00`, `z=4`/`z=5`: `INC r`/`DEC r`, layering a fourth condition onto three already-tested subsystems

The next `x=00` slice — `INC`/`DEC` on `B`/`C`/`D`/`E`/`H`/`L`/`A` (`(HL)`
excluded; see the doc comment above, "x=00, z=4/z=5") — is real flag-bearing
arithmetic on *any* register, not just `A`, which means it has to plug into
three subsystems this composite already had well-tested behavior for
*before* this turn: `A`'s own write-back (`aWeStage`/`aWeFinal`), `F`'s
per-bit mux, and `B`/`C`/`D`/`E`/`H`/`L`'s `ldExternal`/`wrapWithPairCommit`
write-back chain. Every one of those got a genuine new condition added,
not just a new consumer wired to existing outputs — the highest-risk piece
of this session specifically because it touches proven code, not only new
code, in three separate places at once.

The design choice worth explaining is why this group gets *one* shared
8-bit adder rather than seven separate ones the way `BC`/`DE`/`HL` above
each got their own pair adder: `INC rr`/`DEC rr` never needed a single
"the" flag result (real Z80 sets none), so three independent
always-computing adders, gated only at commit, cost nothing. `INC r`/
`DEC r` *does* need one — `S`/`Z`/`P` have to be computed from *whichever*
register this instruction actually targets, and only one of
`B`/`C`/`D`/`E`/`H`/`L`/`A` is ever the target per cycle — so seven separate
adders would mean seven separate flag-computation chains, six of them
thrown away every single instruction for no benefit. A 7-way one-hot
read-select (`dec.y`'s relevant lines each `AND`ed with their register's
own value, `OR`ed together per bit — safe because `dec.y` is one-hot, so
at most one `AND` term per bit is ever `1`) feeds the one adder instead;
its result fans out, unselected, to every register's own write-back layer,
each individually gated by its own `INCDEC_x_NOW`.

`wrapWithPairCommit` — written for `INC rr`/`DEC rr`'s own third layer —
turned out generic enough to reuse completely unmodified for `B`/`C`/`D`/
`E`/`H`/`L`'s *fourth* layer here, one more call per register, all six
reading the identical `R8RESULT0`-`R8RESULT7` label safely (only one of
six `INCDEC_x_NOW` conditions is ever `1` at a time). `F`'s own per-bit mux
needed an actual new stage, not just a new call to something reusable: a
mux ahead of the existing `computedFlagBit[i]` input, picking between the
`x=10` value (default) and this group's own `R8_N`/`R8_P`/`R8_Z`/`R8_S` —
except at bit 0 (`C`), where real Z80 leaves the flag untouched, so that
bit's own "x=00-computed" alternative is `F`'s *own* `q[0]` fed back
(a hold, wired exactly like any other mux input, just sourced from the
register the mux itself feeds) rather than a freshly computed value. `A`
got the same shape as `F` — a mux ahead of `srcMux`'s own `in0` — and its
own `we` chain gained one more `OR` term, mirroring `aWeStage`'s existing
two-condition shape stretched to three.

142 tests, first real run, all green — including the regression pass run
*before* this piece's own new test was even written, specifically to catch
anything this turn's edits to already-proven `A`/`F`/register-file wiring
might have broken. Nothing had. The new test (`buildZ80Cpu — x=00,
z=4/z=5`) doubles as the concrete proof `C` really is preserved, not
accidentally cleared or corrupted: two `ADD A,B` warm-ups establish `C=1`
first, then all fourteen `INC`/`DEC r` instructions that follow are
checked to leave it exactly there while `S`/`Z`/`P`/`N` change freely
around it.

### `x=00`, `z=6`: `LD r,n` — the first multi-byte instruction, and the first live sign of a cost flagged three turns ago

`LD r,n` (`B`/`C`/`D`/`E`/`H`/`L`/`A`, `(HL)` excluded — see "x=00, z=6:
LD r,n" above) is this project's first instruction that reads an operand
*after* its own opcode byte. The design question it raised was whether
that needs a fifth FSM phase; it doesn't, for a genuinely simple reason
once seen: `PHASE2`/`PHASE3` (`EXEC1`/`EXEC2` for every other group) just
get reused with different semantics — "read the operand, then advance `PC`
a second time" instead of "commit, then a no-op." Three already-tested
signals widened by one `OR` term each (`PC`'s own hold condition, `isBusToA`,
`ldWe`) carried the whole thing; nothing needed a new mux layer, a new
adder, or a new register. `runInstruction()`'s own four-pulse-pair shape,
unchanged in every test in this file, drives this two-byte instruction
exactly as it drives every one-byte one — the concrete proof, not just an
argument, that no new phase was needed.

Logically, this piece had the same clean landing `INC rr`/`DEC rr` and
`INC r`/`DEC r` did: 143 tests, first real run, all green, no wiring bug
to trace. Live verification in the browser told a different, real story,
though — the first actual instance of a cost this document has been
flagging since "x=11" 's own performance note, three sections back
("the next composite deep enough... will hit the same wall"), and again
when `x=00, z=4/z=5` was added: placing `+ Z80CPU` with a `LD r,n`-bearing
program didn't visibly fail, but took long enough — the composite has
grown by three more instruction families' worth of gates and labels since
that note was written — that the browser tool's own default patience
window read it as a hung renderer on the first attempt. A second attempt,
given more time, settled cleanly (`settled: true`, `contended: 0`, no new
console errors) with the *exact* same input. Nothing was wrong; the
placement is just slow enough now that "immediately responsive" can no
longer be assumed for a fresh `+ Z80CPU` — worth recording as data, the
same way the earlier sections record real bugs and real non-bugs: this
composite's size is now large enough to affect not just `npm test`'s own
runtime (already flagged) but interactive use of the live editor too.

### `x=00`, `z=1`: `LD dd,nn` — the FSM's first real widening

`LD BC,nn`/`LD DE,nn`/`LD HL,nn`/`LD SP,nn` (`z=1`, `y` even — the odd `y`
values at this `z` are `ADD HL,rr`, still unimplemented) are this slice's
first 3-byte instructions: an opcode plus a full 16-bit immediate, low
byte first in memory (real Z80's own imm16 order). `LD r,n`'s own trick —
reuse `PHASE2`/`PHASE3` with different semantics instead of adding a phase
— doesn't stretch to a *second* operand byte on its own, since those two
phases are already spent reading the first one. This is the first time
this project's FSM actually grew: `buildRingCounter(..., 6, ...)`, not
`4` — `EXEC3`/`EXEC4` appended *after* `EXEC2`, not inserted before it, so
every existing `PHASE0`-`PHASE3` label kept its exact ring position and
every already-built instruction group's own timing stayed byte-for-byte
identical. `buildRingCounter` itself needed no change at all — it was
already generic over any phase count `>=2`, a design decision from long
before this turn paying off here without anyone having planned for it.

`BC`/`DE`/`HL` needed no new mux layer: `C`/`E`/`L`'s own low-byte-write
condition and `B`/`D`/`H`'s own high-byte-write condition each fold into
that register's *existing* `ldWe` `OR`-chain (now four terms —
`LD r,r'`/`POP`/`LD r,n`/`LD dd,nn`) as one more competing source, safe
for the identical reason the third term already was: `dec.z` is one-hot,
so `z=6` and `z=1` can never decode the same opcode. `SP` couldn't reuse
that: it's one monolithic `addrBits`-wide register, not two
independently-addressable 8-bit ones, so `C` and `B` naturally stay
untouched when only the other is written — `SP` has no such natural
separation, `sp.we` commits every bit at once regardless. A *fifth*
write-back layer solves it without inventing a holding register: each bit
gets a small mux picking its own fresh byte during its own write phase
while *self-looping* (`sp.q[i]` fed back as its own next value) during the
*other* phase — two write edges, each one re-committing the untouched
half right back to itself instead of losing it. Bits at or past
`addrBits` for the high byte simply don't exist (the per-bit loop stops
at `addrBits`), naturally truncating a 16-bit immediate to whatever width
this particular instantiation's `SP` actually has — exercised directly by
the new test's own choice of immediate (`0x1234` into a 5-bit `SP`,
`0x34 & 0x1F = 0x14`, truncation reaching *inside* the low byte, not just
discarding the high one).

Every one of the six existing `buildZ80Cpu` `describe` blocks in
`blocks.test.ts` needed the identical two-part mechanical update: a wider
`fsmD` seed (`cpu.fsmD[4]`/`cpu.fsmD[5]`, both `0`) and two more
phaseClk/dataClk pulse pairs in each one's own `runInstruction()`
(`EXEC3`/`EXEC4`, both genuine no-ops for every group except this one) —
not because any of those tests' own *logic* changed, but because the ring
they all share now takes six pulse-pairs to complete one full rotation
instead of four, regardless of whether the instruction under test reads
this turn's own new phases at all.

144 tests, first real run, all green — including every one of the six
*existing* `buildZ80Cpu` tests, run through the widened ring and the new
`SP`/`ldWe` wiring for the first time, plus the new `LD dd,nn` test itself.
No live bug this turn either, despite this being the single most invasive
change of the whole project so far — a real FSM widening touching every
test file, a genuinely new (not reused) write-back mechanism for `SP`. The
performance cost flagged throughout this section, though, showed up
exactly as predicted: `blocks.test.ts` as a whole went from ~1096s to
~1725s, and the individual `buildZ80Cpu` tests scaled with it — `x=11`
210s -> 314s, `x=00, z=4/z=5` 263s -> 423s — a real, measured ~50%
slowdown across the board from adding two more phases every instruction
now sits through, not a one-off. Tracked here as data, not a surprise:
this is the same wall "x=11"'s own performance note first named, now
crossed a second time by a deliberate, necessary design choice rather
than an accident.

### `x=11`: `JP nn` — and why `CALL nn` needs the ring to grow again

`JP nn` (`z=3`, `y=0`, real `0xC3`) reuses `LD dd,nn`'s exact `PHASE2`-
`PHASE4` shape (read low byte, advance, read high byte) — the same
machinery, unmodified. The one real difference is `PHASE5`: `LD dd,nn`
advances `PC` a third time there; `JP nn` needs to *overwrite* it with
the freshly-read target instead. Concretely, that meant leaving `PHASE5`
**out** of `pcHold`'s own `OR`-chain for this one instruction
(`JP_ADVANCE_NOW` only covers `PHASE3`) — with `pcHold=0` on `PHASE5`,
`pc.load` goes to `1` on its own, and a new `jpMux` (a third layer on
`retMux`/`rstMux`'s existing chain, mirroring exactly how `RST`'s own
target already competes with `RET`'s) supplies the actual jump target on
that edge.

The one genuinely new piece: `PC` can't play `SP`'s own "self-loop hold,
mux in the fresh half" role for its *own* two-byte write, the way `SP`
did for `LD SP,nn` — `SP` isn't also the address something else needs
mid-write, but `PC` is exactly that. `PHASE2`'s and `PHASE4`'s own reads
need `PC` to keep being the correct, uncorrupted read address (`PC` then
`PC+1`) while the jump target is still only half-known; writing a partial
target into `PC` directly would corrupt the very address the *next* read
depends on. `jpTarget` — a new, dedicated `addrBits`-wide `buildRegister`
nothing else ever seeds — takes `SP`'s exact per-bit low/high write-back
shape instead, entirely separate from `PC` itself, and only its *settled*
output (one full tick after both bytes have landed) becomes `jpMux`'s own
input on `PHASE5` — not the same edge as the high-byte read, since a
register's own `q` only reflects a write on the *next* relaxation, not
during the edge that committed it.

**`CALL nn` doesn't fit in the phases this bought.** `JP nn` used all
four available `EXEC` phases (`PHASE2`-`PHASE5`) just for the two-byte
read; `CALL nn` needs that *same* read, plus pushing the return address
(two more phases, mirroring `PUSH`'s own `EXEC1`/`EXEC2` high-then-low
byte shape), plus the jump commit itself — seven distinct actions against
four available slots. Tracked here as a known limitation rather than
attempted this turn: fitting `CALL nn` means widening the ring a *second*
time (6 phases to 8), the same expensive, all-tests-affected operation
"x=00, z=1" above already went through once. Worth doing deliberately, as
its own scoped turn, not as a rider on `JP nn`'s own smaller, cleanly
self-contained change.

Unlike `LD dd,nn`, this one *did* have a real bug, and a genuinely
embarrassing one: `jpTarget.clk` was never wired to anything. Every other
register in this composite — `pc`, `ram`, `ir`, `a`, `rB`..`rL`, `f`,
`sp` — gets its `.clk` tied to the shared `CLK` label in one block near
the end of `buildZ80Cpu`; `jpTarget`, built much earlier in the function
as a new, separate register (not a widening of an existing one the way
every other piece this session added was), never got added to that list.
`.we` and `.d` were both wired correctly — the write conditions fired on
the right phases, the mux logic was right — but a `buildRegister`'s own
D-flip-flops never latch anything without a clock edge to latch *on*, so
`jpTarget.q` read `Z` (floating, undefined) forever regardless of what its
`.we`/`.d` said, and `jpMux` faithfully loaded that undefined value into
`PC`. The control-flow test caught it immediately (`pc` stayed at `0`
instead of reaching `16`) — traced with a temporary debug build (a
throwaway per-bit label on `jpTarget.q`, read directly, removed once the
missing `.clk` was found and fixed) rather than the full suite, itself
only practical because of the file-split described next: a single
targeted re-run of just this test took ~30s instead of needing to sit
through the other seven `buildZ80Cpu` tests to see it fail again.

144 tests, all green once `jpTarget.clk` was wired — this instruction's
own real bug ended up being the "forgot a wire that isn't optional"
category "x=11"'s "Five real bugs" section already named for `RST`'s own
missing push-data driver, not a new failure mode.

### Splitting the slow tests across files: real parallelism, not just patience

By this point `blocks.test.ts` held all ten `buildZ80Cpu` tests plus every
other test in the project, and vitest — like most test runners — only
parallelizes across *files*, not across `it()`s within one; a single
huge file runs every one of its own tests on a single thread, one after
another, however many CPU cores sit idle. `npm test` had grown to ~29
minutes wall-clock this way, entirely dominated by that one file, and
every `it.concurrent()`-shaped fix would have been the wrong tool anyway:
these tests are CPU-bound (the solver's own relaxation loop), not
I/O-bound, so cooperative concurrency on one thread buys nothing —
getting real parallelism needs separate OS threads, which only
file-level splitting gets from vitest's default `pool: 'threads'`.

Each of the eight `buildZ80Cpu` `describe` blocks moved to its own file
(`test/z80cpu-x10.test.ts`, `test/z80cpu-jp-nn.test.ts`, etc.) — they
already had zero shared state (each builds its own fresh `Circuit`/
`ChipLibrary`), so the split was mechanical: copy each block's own
imports plus a shared `levelAt` helper (pulled into `test/levelAt.ts`,
the one piece of duplicated boilerplate every one of these files needed)
into its own file. `blocks.test.ts` itself kept only the genuinely fast
tests (`buildRegister`, `buildAlu`, `buildProgramCounter`, and the rest —
each well under a second).

Measured, not projected: `npm test`'s wall-clock time went from ~1726s
(`time npx vitest run`, pre-split) to ~660s post-split on this 8-core
machine — real, substantial, but noticeably short of the naive "divide by
8" a reader might expect from eight tests suddenly running concurrently.
Two things eat into that ceiling, both visible in the raw numbers: the
*individual* tests got measurably slower running concurrently than they
were running alone (`x=00, z=4/z=5` alone: ~400s; the same test as part of
this 8-way concurrent run: ~658s) — eight CPU-bound processes contending
for 8 physical cores pay real scheduling and cache overhead that a single
process sitting idle-then-busy never does — and the slowest test in the
batch still gates the whole run regardless of how many faster ones
finished already. The *total* CPU-time cost is unchanged (`user
54m59s` in the same run — still every test's own full relaxation work,
just spread across cores instead of queued on one) — this doesn't undo any of
the performance notes elsewhere in this document, it just stops one
slow file from serializing work that never needed to be serial.

### `x=11`: `CALL nn` — the ring's second widening, and the constraint that shaped it

`CALL nn` (`z=5`, `y=1`, real `0xCD` — `PUSH`'s own `z=5` column only
claims the even `y` values, so `y=1` was free) needed the FSM to grow a
second time, `6` phases to `8` (`EXEC5`/`EXEC6`, appended after `EXEC4`,
the same "append, never insert" rule the first widening established —
see "x=00, z=1: LD dd,nn" above). It needs everything `JP nn` needs (read
the low byte, advance, read the high byte, advance — `PHASE2`-`PHASE5`,
identical shape) *plus* two actions `JP nn` never had to: pushing the
return address before jumping, not just jumping. `PHASE6` pushes,
`PHASE7` jumps — six real `EXEC` phases for one instruction, the deepest
single opcode this project has built. The return address itself needed
no extra work to compute: it's just `PC`'s own value once both advances
have run, already sitting there since `PHASE5`'s own advance (unlike `JP
nn`'s, which skips it specifically to let `PHASE5` overwrite `PC` instead)
is *kept* here, landing `PC` exactly past all three bytes of this
instruction — the address execution should resume at.

**The one design decision that mattered most: the push writes one stack
byte, not two.** A real Z80's return address is 16 bits, needing two
stack bytes. This project's own `RET` — built for `RST`, long before `CALL
nn` existed — only ever reads *one* byte back, because `PC` here is only
`addrBits` wide (the same scale coincidence `RST`'s own doc comment
already names). Pushing two bytes for `CALL` while `RET` only ever pops
one would silently break every `CALL`-then-`RET` pair in this project —
not a limitation to route around, a compatibility constraint `RST`'s own
existing design already settled, that `CALL nn` just had to respect.
Respecting it turned out to be nearly free: `stackWriteNow` (already
`OR(pushNow, rstNow)`) widened to a third term, `CALL_PUSH_NOW`, and every
piece of the *existing* stack-write apparatus came along automatically —
`SP`'s own decrement (`spWantDec` already reads the `STACK_WRITE_NOW`
label this feeds), RAM's write-enable (`ramWe` already includes
`stackWriteNow`), RAM's own address-to-`SP` selection (`writeMux`, same
label) — none of it touched directly. Only a new push-*data* driver bank
needed building, mirroring `RST`'s own PC-onto-the-bus bank exactly
(gated by `CALL_PUSH_NOW` instead of `rstNow`).

`callTarget` — a *second*, separate holding register from `jpTarget`, not
a shared, widened one — takes the identical per-bit low/high write-back
shape `jpTarget` established. `JP nn` and `CALL nn` are mutually exclusive
by `dec.z` (`z=3` vs `z=5`), so sharing one register would have been
electrically safe, but a second one costs nothing this project has ever
rationed (component count) and means this addition touches zero
already-proven `JP nn` wiring — consistent with the "separate over
shared-and-muxed" preference `spAdder`-style adders already established.
`PC`'s own commit chain grew a *fourth* mux layer, `callMux` (`retMux` ->
`rstMux` -> `jpMux` -> `callMux` -> `pc.d`), gated by `CALL_JUMP_NOW` on
`PHASE7` — `PHASE6`/`PHASE7` both deliberately excluded from `pcHold`,
the identical reasoning `JP nn`'s own `PHASE5` exclusion already
established.

Every one of the now-eight existing `buildZ80Cpu` test files needed the
identical mechanical update the first ring widening required — two more
`fsmD` bits, two more no-op `EXEC5`/`EXEC6` pulse pairs in each one's own
`runInstruction()` — applied by script across all eight at once rather
than by hand, the file-split immediately paying for itself a second way:
not just faster regression runs, but a mechanical, scriptable edit that
would have been one enormous, error-prone diff inside a single 2000-line
file. `jpTarget`'s own missing-`.clk` bug (see "x=11: JP nn" above)
stayed front of mind building `callTarget` — every new register this
composite gains now gets its `.clk` wired in the *same* edit that
declares it, checked explicitly rather than assumed, and the new test
(`z80cpu-call-nn.test.ts`) is deliberately a full `CALL` -> subroutine ->
`RET` -> resume round trip, not just "did it jump": `SP` is checked
decrementing by exactly one on the call and incrementing by exactly one
on the return, and the resumed main flow only runs — and only leaves `A`
at the value that flow itself sets — if `RET` truly landed back at the
instruction *after* `CALL`, not merely *some* address.

146 tests, first real run, all green — including the deepest single
instruction this project has built, with zero live bugs this time
either, `jpTarget`'s own missing-`.clk` lesson from one turn earlier
having done its job. The performance cost compounded rather than merely
repeated, though: wall-clock for the full suite went from ~660s (the
first ring widening, eight `buildZ80Cpu` files across eight cores) to
~1519s this time — not just the expected per-instruction cost of two more
phases, but nine heavy `buildZ80Cpu` files now competing for eight
physical cores, one more file than there are cores to run them on, so at
least one test now genuinely queues behind another rather than running
fully in parallel. The file-split from one section ago bought real
headroom; it has a hard ceiling at the core count, and this turn is the
first to actually reach it.

### `x=11`: `JP cc,nn` — no ring widening, for once

`JP cc,nn` (`z=2`, `y` selecting the condition — real `0xC2`/`0xCA`/`0xD2`/
`0xDA`/`0xE2`/`0xEA`/`0xF2`/`0xFA` for `NZ`/`Z`/`NC`/`C`/`PO`/`PE`/`P`/`M`)
reuses `JP nn`'s exact `PHASE2`-`PHASE5` read/advance shape completely
unchanged. The only real design question was what `PHASE5` itself does:
`JP nn` always overwrites `PC` there; `JP cc,nn` branches — jump
(`JPCC_JUMP_NOW`) if the tested condition holds, otherwise just advance
`PC` a third time (`JPCC_FALLTHROUGH_NOW`, `LD dd,nn`'s own `PHASE5`
shape) so execution falls through to whatever comes after this
instruction's own 3 bytes. Both conditions are computed on the *same*
`PHASE5` window, mutually exclusive by construction (`conditionTrue` and
its own `NOT`), so there's no risk of neither or both firing. No FSM
widening needed this time — unlike `CALL nn`, this instruction fits
entirely inside phases the ring already had.

`y` selects the condition the identical one-hot way `INC r`/`DEC r`'s own
`r8Select` picks a register: an 8-way `AND`-then-`OR` tree, each `y` line
paired with the right `F` bit (`NZ`/`Z` read bit 6; `NC`/`C` read bit 0;
`PO`/`PE` read bit 2 — parity — not to be confused with `P`/`M`, which
read bit 7, `F`'s own sign bit, "plus"/"minus"). Computed unconditionally
off `F`'s live bits regardless of which instruction (if any) is actually
decoding — the same "always compute, gate only the commit" shape `alu`/
`spAdder`/`r8Adder` already established.

`jpCcTarget` is a *third* separate holding register, alongside `jpTarget`
and `callTarget` — `z=3`, `z=5`, and `z=2` are mutually exclusive by
construction, so all three could have shared one register safely, but a
third one costs nothing this project has ever rationed and keeps this
addition from touching any already-proven `JP nn`/`CALL nn` wiring, the
same preference restated a third time now. `PC`'s own commit chain grows
a *fifth* mux layer, `jpCcMux` (`retMux` -> `rstMux` -> `jpMux` ->
`callMux` -> `jpCcMux` -> `pc.d`), gated by `JPCC_JUMP_NOW` on `PHASE5` —
`pcHold` gets both `JPCC_ADVANCE_LOW_NOW` (`PHASE3`) and
`JPCC_FALLTHROUGH_NOW` (`PHASE5`, the condition-*false* branch);
`JPCC_JUMP_NOW` itself (`PHASE5`, condition-*true*) stays out, the same
exclusion `JP nn`'s own `PHASE5` already established.

147 tests, first real run, all green, zero live bugs this time — no ring
widening meant no new register-`.clk` wiring to forget, and the "check
every `CLK` line explicitly" discipline from `jpTarget`'s own bug held
regardless. The test itself covers 4 of the 8 conditions (`Z`/`NZ` off one
`XOR`, `C`/`NC` off one `ADD`), one taken and one not-taken instruction per
pair, each wrong branch landing on a distinct `LD A,0xEE` trap — the other
4 conditions (`PO`/`PE`, `P`/`M`) share the exact same one-hot select tree
and mux wiring, so a targeted bug in *their* two `F` bits specifically
would have to be a bug nothing else in this tree would trigger either.

Wall-clock for the full suite: `915.67s` (`time`'s own `real 15m16.365s`),
measured with `time npx vitest run`, ten heavy `buildZ80Cpu` files now
(one more than `CALL nn`'s turn) still racing eight physical cores. That
is *faster* than `CALL nn`'s own `~1519s` with only nine such files
competing — a genuinely counterintuitive number, and it gets reported
exactly as measured rather than rationalized into a story: no widened FSM
this turn means no extra phases inside the *existing* heavy files either,
so total CPU-seconds actually dropped even as the file count that has to
queue for eight cores grew by one, and machine load from one run to the
next is never controlled for here. The honest takeaway is "measure again
next time, don't assume monotonic slowdown from file count alone" — not a
confident explanation this session has no real evidence for.

### `x=11`: `CALL cc,nn` — three of the four flag-gated opcodes down

`CALL cc,nn` (`z=4`, real `0xC4`/`0xCC`/`0xD4`/`0xDC`/`0xE4`/`0xEC`/`0xF4`/
`0xFC`) is the composition `CALL nn` and `JP cc,nn` already set up to be
close to free: `CALL nn`'s exact `PHASE2`-`PHASE5` read/advance shape,
reused completely *unconditionally* — both branches need `PC` to end up
past this instruction's own 3 bytes regardless of whether the call fires,
since that address is either the fall-through target or the very return
address about to be pushed — plus `JP cc,nn`'s own `conditionTrue` line,
reused directly rather than recomputed. `y`'s condition encoding depends
only on `dec.y` and `F`'s live bits, not `dec.z`, so the identical 8-way
select tree already built for `JP cc,nn` is correct here too, without
rebuilding a single gate of it. The only real branch left is whether
`PHASE6` (push) and `PHASE7` (jump) do anything: `CALLCC_PUSH_NOW`/
`CALLCC_JUMP_NOW` are each `AND(phase, conditionTrue)` directly — no
separate "false" signal needed the way `JP cc,nn`'s own
`JPCC_FALLTHROUGH_NOW` was, since condition-false here just means "push
nothing, jump nowhere": `PC` already sits at the right address from
`PHASE5`'s own unconditional advance, and "do nothing" needs no explicit
gate of its own.

`callCcTarget` is a *fourth* separate holding register, alongside
`jpTarget`, `callTarget`, and `jpCcTarget` — the same "separate over
shared-and-muxed" preference restated a fourth time now, for the same
reason as every time before: keeps this addition from touching any
already-proven wiring. `PC`'s own commit chain grows a *sixth* mux layer,
`callCcMux` (after `jpCcMux`), gated by `CALLCC_JUMP_NOW` on `PHASE7` —
`pcHold` gets both `CALLCC_ADVANCE_LOW_NOW` (`PHASE3`) and
`CALLCC_ADVANCE_HIGH_NOW` (`PHASE5`), both unconditional this time (unlike
`JP cc,nn`'s own condition-gated `PHASE5` term); `CALLCC_PUSH_NOW`/
`CALLCC_JUMP_NOW` stay out of `pcHold` entirely, the identical exclusion
`CALL nn`'s own `PHASE6`/`PHASE7` already established. The push itself
reuses every piece of `CALL nn`'s own machinery rather than building any
of it twice: `STACK_WRITE_NOW`'s `OR`-chain widens a fourth term (already
gated by `conditionTrue` inside `CALLCC_PUSH_NOW` itself, so no extra
condition check at the `OR` gate), and the push-data driver bank is a
straight copy of `CALL nn`'s own, gated by `CALLCC_PUSH_NOW` instead —
`SP` decrement and the RAM-write address-select follow along for free,
exactly the way `CALL nn`'s own push already inherited them from `PUSH`/
`RST`.

The test proof is the union of its two parents': `JP cc,nn`'s own proof
(jumps when the condition holds, falls through — correctly, not by
accident — when it doesn't) plus `CALL nn`'s own proof (the *existing*
`RET` mechanism can pop back whatever this instruction pushed). Same two
condition pairs `JP cc,nn`'s own test used (`Z`/`NZ` off one `XOR`, `C`/
`NC` off one `ADD`), but each *taken* instance goes all the way through a
real call -> subroutine -> `RET` -> resume round trip, `SP` checked
dipping by exactly one and recovering exactly back. The not-taken half
gets no dedicated trap byte the way `JP cc,nn`'s own test used one —
`CALL cc,nn`'s own fall-through address is architecturally *identical* to
its own return address (both are "PC after this instruction's 3 bytes"),
so a trap placed there would misfire on the correct taken-then-`RET` path
too. What actually distinguishes a wrongly-not-taken bug is *when* it
shows: in the very next snapshot, immediately after the `CALL cc,nn`
instruction itself, before any subroutine could possibly have run yet —
this project's existing snapshot-per-instruction discipline already
catches that without any extra machinery. Trap bytes stay for the
opposite direction (wrongly *taken*), since that failure mode diverts to
an address nothing else ever legitimately visits.

148 tests, first real run, all green, zero live bugs — the "reuse
`conditionTrue` and `CALL nn`'s own push machinery instead of rebuilding
either" bet paid off exactly as expected: nothing about wiring two
already-proven pieces together needed a `.clk` check or any other new
failure surface, the test's own two full call -> subroutine -> `RET` ->
resume round trips (`SP` dipping by exactly one and recovering exactly
back, twice, at two different targets) passed cleanly alongside the two
not-taken cases.

Wall-clock for the full suite: `942.69s` (`time`'s own `real
15m43.438s`), eleven heavy `buildZ80Cpu` files now racing eight physical
cores — up slightly from `JP cc,nn`'s own `915.67s` with ten such files,
which is the *expected* direction this time (one more heavy file, and
`CALL cc,nn`'s own test is genuinely the single longest-running one yet,
`926.68s` alone — two full push/jump/pop round trips is real additional
work, not free). Still nowhere near `CALL nn`'s own `~1519s` peak from
two features ago; this project still isn't tracking exactly why that
particular run was so much slower than everything around it, and doesn't
pretend to here either — each number gets reported as measured, not
smoothed into a trend line this session has no real basis for drawing.

### `x=11`: `RET cc` — the fourth, and the cheapest by far

`RET cc` (`z=0`, real `0xC0`/`0xC8`/`0xD0`/`0xD8`/`0xE0`/`0xE8`/`0xF0`/
`0xF8`) closes out `x=11`'s own flag-gated quartet, and needed by far the
least new machinery of the four. It's a single-byte opcode — no operand
bytes to read or advance past at all — so the not-taken branch needs
nothing beyond `PC`'s own default `PHASE1` increment: no `FALLTHROUGH`
signal, no extra `pcHold` term, the first of the four conditional
instructions in this file that doesn't need either. `RETCC_TAKEN_NOW`
(`AND(isRetCcZ, PHASE2, conditionTrue)` — `conditionTrue` reused a third
time, unchanged, off `JP cc,nn`'s own tree) is the *only* new signal this
instruction needs: it widens the *existing* unconditional `RET`'s own
`readNow` with a third `OR` term, rather than building any parallel read
path. That widening had to wait, syntactically, until `conditionTrue`
existed — `readNow`'s own real, final definition now lives right after
`RET cc`'s own decode block, not back where `popReadNow`/`retNow` first
built the (now intermediate) `readNowStage` long before `RET cc` did.
`SP`'s own recovery (`stackActive` -> `spAluActive` -> `sp.we`) and the
RAM read address (`READ_NOW`'s own address-mux select) both already key
off `readNow`, so every already-proven piece of `POP`/`RET`'s own read
machinery comes along for free — the identical "reuse the whole
apparatus, add one term" shape `CALL cc,nn`'s own push used on
`STACK_WRITE_NOW`.

No dedicated target register either, unlike every other conditional
instruction in this file: `JP cc,nn`/`CALL cc,nn` both need one because
their 2-byte targets have to be held across two read phases before `PC`
(also the read address for those very bytes) can safely accept them;
`RET cc`'s own target is a single popped byte already sitting on the bus
the instant it's read — the identical reason unconditional `RET`'s own
`retMux` never needed one. `PC`'s own commit chain grows a *seventh* mux
layer, `retCcMux` (after `callCcMux`), gated by `RETCC_TAKEN_NOW`, `in1`
wired straight to the raw bus rather than a register's `q` — `retMux`'s
own shape, copied exactly.

The test proof mirrors `CALL cc,nn`'s own: the same `Z`/`NZ`/`C`/`NC`
pair, each inside its own real `CALL`-pushed stack frame (testing a `RET
cc` against garbage on the stack would prove nothing). A *taken* instance
is one instruction, self-contained. A *not-taken* instance needs a
following plain `RET` in the same subroutine to actually unwind the
frame — and the snapshot taken immediately after the not-taken `RET cc`
itself, one instruction *before* that plain `RET` runs, is the real
proof: `SP` still mid-frame, `PC` at the very next byte, not off at
whatever garbage address the stack's current top happened to decode as.
No trap byte needed for either direction this time — unlike `CALL cc,nn`,
a wrongly-*taken* `RET cc` doesn't divert to some fixed unreachable
address; it pops whatever's actually on top of the stack (a real,
valid — if wrong — return address from an outer frame), so the
observable failure is simply "control returned to the wrong place,"
already distinguishable from the expected snapshot without any special
setup.

With this, every `x=11` opcode this project set out to build is in:
`PUSH`/`POP`/`RET`/`RST n`/`JP nn`/`CALL nn`/`JP cc,nn`/`CALL cc,nn`/
`RET cc`.

149 tests, first real run, all green, zero live bugs — the cheapest
feature to *build* in this whole flag-gated run turned out to need the
least debugging too: one new signal, widening one existing `OR` gate,
one new mux layer, nothing else, and none of it needed a second look.

Wall-clock for the full suite, though, is the real story this time:
`2362.96s` (`time`'s own `real 39m23.666s`) — sharply worse than `CALL
cc,nn`'s own `942.69s`, not the small step the last few features each
took. Twelve heavy `buildZ80Cpu` files now queue for eight physical
cores (one more than last time), but the per-file numbers themselves grew
too, not just the queueing: `z80cpu-x10` alone went from `331s`/`449s` in
earlier runs to `729s` this time, `z80cpu-inc-dec-r` from `914s`/`921s` to
`2222s`, `z80cpu-ret-cc` itself (a genuinely light instruction to
simulate) still took `2358s` — the single longest file in the whole
suite. That spread is too uniform to be "one slow file"; it reads like
this run's machine was simply under more contention throughout (other
load on the box, thermal throttling, anything external to this
project's own code) than any of the previous measurements were, and nine
heavy files fitting eight cores was already documented as a soft ceiling,
not a hard one — three files past that ceiling clearly costs more than
proportionally. This project still has no instrumentation to tell "the
suite got slower" apart from "the machine was busier while it ran," and
says so plainly rather than inventing a cause: the number is reported
because it's what `time` measured, not because it's been explained.

### `x=00`, `z=0`, `y=4..7`: `JR cc,e` — the first PC-relative arithmetic in this file

`JR cc,e` (real `0x20`/`0x28`/`0x30`/`0x38` — `NZ`/`Z`/`NC`/`C` only) is
the first instruction in this project that genuinely needed something
`JP cc,nn`/`CALL cc,nn` never did: real PC-*relative* arithmetic, adding a
signed 8-bit displacement to `PC` rather than writing a fixed absolute
target into it. That four-condition limit is real Z80 hardware, not a
simplification made here — this `z`-column's other `y` values are
`NOP`/`EX AF,AF'`/`DJNZ`/`JR` (unconditional), none implemented, and
`PO`/`PE`/`P`/`M` were never valid encodings for this opcode on real
silicon either. `isJrCcYValid` (an `OR`-fold over `y=4..7`) keeps the
other four `y` values in this column correctly inert instead of
accidentally decoding as something else.

The condition test reuses `JP cc,nn`'s own `F`-bit taps
(`notFZ`/`f.q[6]`/`notFC`/`f.q[0]`) but *not* its `conditionTrue` pin
directly — `JR cc`'s own `y=4..7` encode the identical four conditions at
*different* `y` values than `JP cc,nn`'s own `y=0..3` (real Z80's own
encoding, not a choice made here), so a small, separate 4-way select tree
(`jrCcConditionTrue`) pairs those same `F`-bit taps with this opcode's
own `y` lines instead of rebuilding them from scratch.

The real new machinery: a *second* `buildAlu` instance (`jrOffsetAdder`,
width `addrBits`, the same "dedicated adder over one shared, muxed one"
preference `spAdder` already established), permanently in ADD mode, `a`
wired straight to `pc.q`. By the phase this fires (`PHASE4`), `PHASE3`'s
own advance has already committed on the prior edge, so `pc.q` already
equals "the address right after this instruction's own 2 bytes" — exactly
the base a relative jump needs, with no special-cased "peek ahead" logic
required to get there. `b` is `jrCcOffset`'s own 8 captured bits,
sign-extended up to `addrBits` (bit 7 repeated into every bit above it) —
correct only when `addrBits >= 8`, an explicit, documented limitation
rather than a silently wrong one for a narrower address space (this
project has never needed to exercise that combination).

`jrCcOffset` is a *plain* 8-bit register, not a "hold vs fresh" mux pair
the way every multi-byte target elsewhere in this file needs — those
exist because a single register captures two different byte-*halves*
across two separate `we` pulses; a displacement byte is captured exactly
once, so a bare `we`-gated capture (`B`/`C`/`D`/... 's own `LD r,n` shape)
is enough. Only one phase's worth of new decode logic separates the two
branches, the same economy `RET cc` already found: `JRCC_JUMP_NOW`
(`PHASE4`, `AND` with `jrCcConditionTrue`) is the only new signal `PC`'s
commit chain needs — no `FALLTHROUGH` term, since condition-false needs
nothing beyond `PHASE3`'s own already-unconditional advance
(`JRCC_ADVANCE_NOW`, `pcHold`'s newest term). `PC`'s own commit chain
grows an *eighth* mux layer, `jrCcMux` (after `retCcMux`), `in1` wired to
`jrOffsetAdder.out` directly — a live adder output, not a register's own
`q`, since the sum needs no separate holding place of its own once
`jrCcOffset` already holds the one value that changes.

The test proof adds something none of this project's other conditional
jumps had to face: a genuine *negative* displacement (`JR Z,-5`), jumping
backward to a real, already-executed instruction and proving the landing
exactly by re-executing it and checking `A` changes the way running it
again should. A forward-only test would never catch a broken
sign-extension — bit 7 of a wrongly zero-extended displacement would add
a large *positive* number instead of subtracting a small one, landing
somewhere else that might or might not happen to look wrong by accident.

150 tests, first real run, all green, zero live bugs — the first
genuinely new *kind* of arithmetic this project has wired up in a while
(a live adder feeding a mux layer, rather than a captured byte or a fixed
target) worked correctly the first time, forward and backward alike, sign
bit included.

Wall-clock for the full suite: `1558.81s` (`time`'s own `real
25m59.707s`) — thirteen heavy `buildZ80Cpu` files now, one more than
`RET cc`'s own turn, and yet the number dropped sharply from that run's
`2362.96s`. The same lesson that run's own writeup already reached for
holds again, just in the other direction this time: file count alone
doesn't predict wall-clock here, whatever else was contending for this
machine during the `RET cc` run apparently wasn't contending this time.
No new theory offered, same as before — the number is reported as
measured, not smoothed into a story about a trend that isn't actually
there across three data points this noisy.

### `x=00`, `z=0`, `y=2..3`: plain `JR e` and `DJNZ e` — and a real off-by-one

Real `0x18` (`JR`, unconditional) and `0x10` (`DJNZ`) round out `x=00`'s
`z=0` column now that `JR cc,e`'s own machinery already exists. Plain
`JR` reuses every piece of it unchanged, minus the condition test —
`isJrGroupZ` (renamed from `isJrCcZ` once it stopped being `cc`-specific;
this project has never kept a label that quietly stopped describing what
it actually gates) is the shared decode both this and `DJNZ` sit on top
of. `JR_READ_NOW`/`JR_ADVANCE_NOW`/`JR_JUMP_NOW` (renamed from `JRCC_*`
for the identical reason) are each a straight `OR`-fold across all three
variants — safe because `dec.y` one-hot means at most one of them is ever
the opcode actually decoding.

`DJNZ` needed one genuinely new piece — `djnzAdder`, a *third* dedicated
`buildAlu` (`spAdder`'s own "b=all-1s, cin=0" decrement encoding) — and
one genuine live bug, caught by the test's own 3-iteration loop, not a
single-pass check: the zero-test was originally built off `djnzAdder.out`
directly, the same OR-fold-then-stop-short-of-NOT shape used everywhere
else in this file for a zero flag. That's wrong here specifically,
because `djnzAdder` recomputes "B minus one" *continuously* off
whatever `rB.q` currently is — and by the phase the jump decision fires
(`PHASE4`), `PHASE2`'s own write has *already* committed the decrement
into `rB.q`. Reading `djnzAdder.out` at that point silently computes "B
minus one *again*," one decrement too many for the test specifically (the
value actually committed into `B` was still correct — only the *test*
was reading a stale extra subtraction). The bug is invisible on a single
pass: `B: 3->2` tests "2-1=1, nonzero" and jumps correctly, by accident.
It only misfires from the second iteration onward — `B: 2->1` tests
"1-1=0, zero" and wrongly stops one iteration early, exactly what the
loop's own second-pass snapshot caught. Fixed by building the zero-test
(`bNotZeroChain`) off `rB.q` directly instead — the register's own,
already-decremented value, not a re-derived one.

This is the first "first real run" writeup this project has had to
interrupt with a genuine, own-bug fix rather than reporting a clean pass:
the loop test, run on its own before the full suite, failed on its very
first attempt (`{a:2, b:1, pc:9}` instead of `pc:6`), the bug above was
found and fixed the same session, and the corrected version passed clean
on the immediate re-run of just that file. Reported here exactly that
way — a bug the test caught doing its job, not a footnote glossed over.
Full-suite numbers for this feature are folded into `ADD HL,rr`'s own
writeup below — both landed in the same session, one regression run
covers both.

### `x=00`, `z=1`, `y` odd: `ADD HL,rr` — and a second latent bug, found before it could bite

`ADD HL,rr` (real `0x09`/`0x19`/`0x29`/`0x39`) is the exact complement of
`LD dd,nn`'s own even-`y` opcodes at the same `z`. Implementing it
surfaced a second real, *pre-existing* gap, caught by code review before
any test had to catch it the hard way: `isLdDdNn` never checked `y`'s own
parity at all. Every `LD dd,nn` test ever written only ever used real
`LD dd,nn` opcodes (even `y`), so this never mattered in practice — but
`PHASE3`/`PHASE5`'s own advances were firing for *any* `y` at `z=1`,
meaning a fetched `ADD HL,rr` opcode (odd `y`, 1 byte) would have made
`PC` silently advance as if it had two nonexistent immediate bytes to
skip, right up until this turn actually needed odd `y` to mean something.
`isLdDdNnYValid` (even `y` only) and this instruction's own
`isAddHlYValid` (odd `y` only) now partition every `y` value at `z=1`
between exactly one of the two.

`addHlAdder` is a *fourth* dedicated `buildAlu`, 16 bits this time — a
genuine ripple-carry add across the full pair, not two independent 8-bit
ones. `b` is a 4-way one-hot select among `BC`/`DE`/`HL`/`SP`'s own bits,
the identical shape `r8Select` already uses for INC r/DEC r's own
register choice, 16 lanes instead of 8. `SP` — this simulator's own
address-space-only register, `addrBits` wide rather than a genuine 16
bits — zero-extends past `addrBits`: an unsigned address, not a signed
offset, the opposite choice from `jrOffsetAdder`'s own sign-extension.
Real Z80 leaves `S`/`Z`/`P/V` untouched for this opcode and only updates
carry (`H` too, not tracked anywhere in this project's own `F`) — a
*fourth* mux layer ahead of `F`'s own bit-0 commit, inserted only for
that one bit, so every other flag bit never sees it at all.

Its own test, run in isolation first, passed first try after the
`isLdDdNn` fix landed proactively — zero live bugs in `ADD HL,rr` itself,
the test covering all four pairs individually plus a genuine
16-bit-overflow carry case (every other addition in the test stays
comfortably under 0xFFFF, so a carry wire that was simply never connected
would have passed unnoticed without that last case).

Full suite, both this feature and plain `JR`/`DJNZ` included: `152 tests,
25 files, all green` — `time`'s own `real 54m21.259s` (`3260.54s`
reported by `vitest` itself), the slowest run this project has measured
yet, fifteen heavy `buildZ80Cpu` files now queuing eight physical cores,
two more than `JR cc,e`'s own turn. Individual file times moved in both
directions from their last measurement, not uniformly upward with file
count — `z80cpu-ret-cc` roughly doubled (`1447s` -> `2834s`) while
`z80cpu-x10` actually landed *between* its two most recent numbers rather
than past either. The same "machine contention, not file count, explains
most of the variance" conclusion this project keeps reaching holds once
more, and keeps getting reported as measured rather than smoothed into a
false trend.

### `x=00`, `z=2`: indirect loads through `(BC)`/`(DE)`/`(nn)` — the biggest single feature yet, and a genuinely new bus-fight

Real `0x02`/`0x0A`/`0x12`/`0x1A`/`0x22`/`0x2A`/`0x32`/`0x3A` — all 8 `y`
values valid, no gap. `y=0..3` (`LD (BC),A`/`LD A,(BC)`/`LD (DE),A`/`LD
A,(DE)`) are single-byte, committing at `PHASE2` like every other 1-byte
opcode; `y=4..7` (`LD (nn),HL`/`LD HL,(nn)`/`LD (nn),A`/`LD A,(nn)`) are
3-byte, reusing `LD dd,nn`'s exact 4-phase read-low/advance/read-high/
advance shape (`PHASE2`-`PHASE5`) to land a fresh address in `nnAddr`
(a *fifth* dedicated holding register, `jpTarget`'s own "hold vs fresh"
shape), then committing at `PHASE6` (`A`, one byte) or `PHASE6`+`PHASE7`
(`HL`, low byte first) — the full 8-phase budget, no FSM widening needed.
`nnAddrPlusOne` (a *fifth* dedicated `buildAlu`, `spAdder`'s own +1
encoding) supplies the address one past `nn` for `HL`'s own high byte.

RAM's own address bus grew four more override layers (`BC`/`DE`, then
`nnAddr`/`nnAddr + 1`), `A` got a new bus-driving bank for its three
writes, `H`/`L` got one each for `LD (nn),HL`'s own low/high write
phases, `isBusToA` grew a fourth term for this instruction's own three
reads, and `H`/`L` each got a *sixth* write-back layer for `LD HL,(nn)`.
Implementing this ALSO surfaced a real, pre-existing gap the same way
`ADD HL,rr` did: `isLdDdNn` needed an explicit even-`y` check it never
had reason to need before this instruction's own odd-`y` half of the
same `z=1` column started actually decoding to something.

The real find, though, was live, in the feature's own code, not a
pre-existing gap: `LD (nn),HL`'s test failed on its first run with every
single field in the snapshot — `A`, `H`, `L`, even `PC` — reading back as
`0`, not just a wrong `HL`. `settled` was `true` and `contended` was
`0` throughout, which ruled out a simple short on first glance; a
temporary standalone debug build (the same methodology this project has
used for every hard bug so far — a compiled copy of `src/sim/*.ts`, a few
`X_DEBUG_*` labels, a Node script tracing exact signals phase by phase,
all removed once the fix landed) showed the collapse landing precisely
between `EXEC6` (`PHASE7`, `H`'s own write) and the phase before it: every
value correct through `EXEC5`, everything reading `Z` from `EXEC6`
onward, structurally the *same* circuit (component and net counts
identical tick to tick) but the relaxation solver reaching a stable,
wrong fixed point in just 3-4 iterations rather than the 4-8 typical
elsewhere — a real bus fight cascading into contention severe enough to
corrupt nets with no logical connection to `RAM` or `HL` at all, exactly
the failure class this file's own `ramOe`/`hlNow` doc comments already
warn about.

The root cause: `PHASE6` (`L`-onto-bus) and `PHASE7` (`H`-onto-bus) are
*adjacent* ring positions, and this is the first time this file has ever
put two *different* bus-driving banks on two adjacent phases. Every
earlier multi-phase write (`PUSH`'s own high-then-low bytes,
`CALL nn`'s own push-then-jump) either used non-adjacent phases or never
put a second driver on the very next one — so the ring counter's own
already-documented transient (both phase bits briefly reading 1 in the
same relaxation pass, the identical artifact `pushLowNow`'s own exclusion
of `pushHighNow` exists for) never had a chance to matter before. Fixed
the same way: `ldNnHlHighNow` now explicitly excludes `ldNnHlLowNow`
(the later-executing signal excluding the earlier one), not bare
`PHASE7` — `pushLowNow`'s own shape, copied exactly, applied to a second,
independently-discovered instance of the identical class of bug this
project first found and fixed in `PUSH`'s own two-byte write, long
before either `x=00` or PC-relative arithmetic existed in this file.
An earlier, wrong first guess — widening `busActive` on the theory that
`PHASE7` sits adjacent to `FETCH` instead — is not in the final code:
it changed nothing when tried, and the debug trace's own real evidence
pointed at the `PHASE6`/`PHASE7` boundary specifically, not the
`PHASE7`/`PHASE0` one.

153 tests, all green after the fix — the largest circuit this project
has ever built along the way. The test itself round-trips real data
through all four addressing modes independently — write through one
path, clear the destination register to a different value, read back
through the same path — so a mis-wired address mux tap shows up as a
`0x00` read-back (RAM's own default for anything this program never
explicitly writes), not a value that might coincidentally still look
right.

Full suite: `153 tests, 26 files, all green` — `time`'s own `real
96m25.268s` (`5784.56s` reported by `vitest` itself), by a wide margin
the slowest run this project has measured, sixteen heavy `buildZ80Cpu`
files now queuing eight physical cores, one more than the last count.
Every single heavy file moved slower than its own last measurement this
time, not just a few — `z80cpu-x11-stack` alone took `2879s` (its own
previous number was under 2100s), and this feature's own new test,
`z80cpu-ld-indirect`, was the single longest file in the whole suite at
`4753s`, unsurprising given it round-trips four different addressing
modes through real RAM rather than checking one register transition.
Whether that's "this is a genuinely bigger circuit now" or "the machine
was busier this run" or both at once isn't something this project can
currently tell apart — reported as measured, same discipline as every
number before it.

### `x=00`, `z=4`/`z=5`/`z=6`, `y=6`: `INC (HL)`/`DEC (HL)`/`LD (HL),n` — the first genuine RAM read-modify-write, and the worst decode bug found in this project so far

Real `0x34`/`0x35`/`0x36` — the `y=6` slot every earlier `x=00` register
group (`INC r`/`DEC r`, `LD r,n`) deliberately left inert, now a real
RAM read-modify-write instead of a register touch. `INC (HL)`/`DEC (HL)`
reuse `INC r`/`DEC r`'s own shared `r8Adder` rather than building a
dedicated one — `r8Select` grows an eighth entry, `HLMEM`, selecting a
*sixth* dedicated holding register, `hlMemTemp` (`jpTarget`'s own
reasoning: `(HL)`'s value has to survive from its read phase to its
write-back phase, one phase later, after the bus has moved on), instead
of a CPU register's own `q`. One shared adder computing eight sources'
`±1`, not nine — the same economy that adder was built for in the first
place. `LD (HL),n` gets its own *seventh* holding register, `ldHlNImm`,
capturing the immediate byte off the same bus `LD r,n`'s own
`ldImm8ReadNow` already makes valid — no separate read needed, `z=6`'s
existing read/advance shape already covers `y=6` like every other `y`,
only the per-register write-backs ever excluded it.

The find, and by a wide margin the nastiest this project has hit: the
first cut forced RAM's address with an *unconditional* `isIncDecHlMem`
(bare `dec.y`/`dec.z`, no phase gate), reasoned as "a single-byte opcode
with no other RAM activity to conflict with, so holding `HL` for the
whole instruction is harmless." That reasoning missed that `ir.q` itself
doesn't update to the *next* opcode until the exact same tick `FETCH`'s
own read commits — so on that shared tick, `isIncDecHlMem` was still
reading the *old*, pre-update `ir.q` (still decoding as `INC (HL)`),
still forcing the address to `HL`, at the precise moment `FETCH` needed
`PC`. The fetch silently read `RAM[HL]` instead of the real next opcode
and captured garbage into `ir` — corrupting every subsequent decode, not
just this instruction's own execution. It didn't show up as a wrong
write; the write itself (checked directly against `RamComponent`'s own
backing `Uint8Array`, bypassing the CPU's own read path entirely) landed
correctly, every time. It surfaced two instructions later, as a wrong
`A` after the *next* `LD A,(HL)` — the kind of gap between cause and
symptom that took four rounds of a standalone debug build (this
project's now-standard methodology: a compiled copy of `src/sim/*.ts`,
temporary `X_DEBUG_*` labels, a Node script tracing exact signals phase
by phase, all removed once the fix landed) to run down, first
mis-suspecting the write itself, only reaching the actual `ir` bits on
the fourth pass. `hlNow` (this same file's own x=10/x=01 `(HL)`
addressing) never had this problem, because it was already
`PHASE2`-scoped from the start (folded into `groupActive`, itself
`PHASE2`-gated) — it was never "unconditional across the whole
instruction" to begin with, so this bug had no precedent to be caught by
analogy before it was found live. The fix gives `(HL)`'s own RMW that
same discipline: force the address only during the two phases that
actually touch RAM — `HLMEM_READ_NOW` (`PHASE2`) and `INCDEC_HLMEM_NOW`
(`PHASE3`, itself explicitly excluding `HLMEM_READ_NOW` — the identical
adjacent-ring-phase bus-fight exclusion `LD (nn),HL`'s own live bug
already taught this file, applied pre-emptively here rather than found a
fourth time) — never for the instruction's entire lifetime. `LD (HL),n`
needed the same treatment for its own write (`LDHLN_WRITE_NOW`,
`PHASE3`-only — its own `PHASE2` still needs `PC`, to read the
immediate byte itself).

One more slip on the way to the fix, caught by the regression test
itself rather than the debug build: the two new phase-gated terms were
wired into a fresh `buildOr` stage that never actually fed the final
address mux — the old wire from the previous stage still bypassed it
entirely, leaving `INCDEC_HLMEM_NOW`'s own branch dead-ending one node
short of anywhere that mattered. Re-running the same test after the
"real" fix reproduced the identical failure, byte for byte, which is
what gave it away — a genuinely different bug would not have failed on
the exact same snapshot. `INC (HL)`/`DEC (HL)`/`LD (HL),n` test:
14 sequential state snapshots checked in one continuous 18-instruction
program (`XOR A,A`; `LD HL,0x0050`; alternating `LD (HL),n`/`INC (HL)`/
`DEC (HL)` against `LD A,(HL)`, each write round-tripped back through
`A` immediately, `F`'s own `Z`/`N`/`S` bits checked alongside `A` every
time, both wraparound directions exercised, a second `LD (HL),n` thrown
in explicitly so the first one isn't a fluke) — all green after both
fixes landed.

Full suite: `154 tests, 27 files, all green`. This run also forced a
practical discipline change, unrelated to the feature's own correctness:
run cold (`vitest`'s own default thread pool, one worker per physical
core) the process was killed outright, twice, with no error text at
all — silent, instant death, the signature of the OS's own OOM killer,
though neither `dmesg` nor `journalctl` could be read to confirm it
(both came back empty even under `sudo`, `dmesg` refusing outright with
`Operation not permitted`) while the desktop's own browser processes
were independently sitting on ~21 of 31 GB of RAM at the time. Capping
the pool at `--pool=threads --poolOptions.threads.maxThreads=3` (a CLI
flag, no repo config touched) fixed it — and, unexpectedly, came out
*faster* wall-clock than the last full-parallel run despite using fewer
of the machine's eight cores: `75m47.37s` this time (`4547.37s` reported
by `vitest` itself) against the previous `96m25.268s` at full
parallelism, on a very similar-sized suite. Less inter-worker contention
for the same physical cores, on a machine already under real memory
pressure from unrelated processes, apparently outweighs the raw
core-count advantage here — not a permanent config change (this was a
one-off CLI flag for one already-memory-constrained run, not written
into `package.json`/a vitest config file), but worth remembering the
next time this suite's full run needs to happen on a busy machine.

### `x=00`, `z=7`: `RLCA`/`RRCA`/`RLA`/`RRA`/`CPL`/`SCF`/`CCF` — the single-byte accumulator/flag opcodes, and a value/condition mix-up that silently dropped `F`'s own `we`

Real `0x07`/`0x0F`/`0x17`/`0x1F`/`0x2F`/`0x37`/`0x3F` — seven of the eight
`y` values in this column, all single-byte, all committing at `PHASE2`
like every other 1-byte `x=00` opcode in this file, and — a first for this
project — no RAM access anywhere in any of the seven. `RLCA`/`RRCA`/`RLA`/
`RRA` shift `A` by one bit (circular for the first two, through `C` for
the other two) via a dedicated eight-bit shift-and-wrap network, not the
shared `r8Adder` (a rotate isn't `±1`, so reusing that adder never made
sense the way it did for `INC`/`DEC`); `CPL` complements `A` bitwise;
`SCF`/`CCF` touch only `F`, never `A` at all. `y=4` (`DAA`) was, at the
time this section was first written, the one opcode in this column left
unimplemented — not a "haven't gotten to it" gap, since `DAA`'s own
correction reads the half-carry flag (`H`) to decide what to add or
subtract, and `H` didn't exist yet (bits 3/4/5 of `F` were tied to `gnd`
unconditionally, since the very first ALU-group flags were built).
`RLCA`/`RRCA`/`RLA`/`RRA`/`SCF` all set `H` to a fixed 0 anyway, so `gnd`
was already correct for them — only `CPL`/`CCF` wanting `H=1`/`H`=old-`C`
were silently wrong, inherited from the same simplification, not new.
`DAA` is now real too, `H` included — see "Closing the half-carry gap:
real `H`, the two undocumented bits, and `DAA`" further down for the full
derivation. `RLCA`/`RRCA`/`RLA`/`RRA`/`CPL`/`SCF`/`CCF` themselves still
leave `H` and the two undocumented bits exactly where they were — that
part of this section's own reasoning didn't change, only `DAA`'s own
status did.

Two real bugs, both found live, both in `F`'s own write path — the second
considerably nastier than the first.

The first: the base per-bit mux feeding `F`'s own commit chain
(`computedFlagBit[i]`, the ALU group's raw, *unconditional* flag
computation) had never actually been gated by `aluGroupNow` at all — it
was simply wired straight into the next layer, correct only because,
until now, `F`'s `we` had never fired for any *non*-ALU-group instruction
that didn't *also* fully own every bit it touched (`INC`/`DEC r` holds `C`
explicitly; `POP AF` overwrites the whole byte from the bus). The very
first thing this feature's own commit needed — `SCF` asserting `we` while
touching only `C` — broke that assumption immediately: `Z` came back `0`
right after `SCF`, clobbered by whatever the ALU group's own raw,
stale computation happened to be at that moment, with no gate keeping it
out. The fix: a `baseMux`, gated by `aluGroupNow` itself, feeding
`f.q[i]` (a genuine hold) as the *first* layer of the chain, ahead of
every later override — the missing piece that let every later
feature (`ADD HL,rr` included, retroactively, since it had the identical
exposure and had simply never been tested against a `we`-asserting
neighbor of its own) safely touch `F`'s `we` without leaking into bits it
never meant to change.

The second, found chasing the first feature's own test: `RLCA` on
`A=0x55` correctly rotated `A` to `0xAA`, but `C` — which should become
the *old* bit 7 of `A` (`0`) — silently kept whatever it already was. A
debug build tracing the actual committed `F.q[0]` (not the live,
post-tick recomputed value — reading that after the fact is meaningless,
it just re-derives itself from `A`'s by-then-already-new bits, a dead end
this session spent real time on before catching it) proved the commit
simply never happened: starting from `C=0` (fresh off `XOR A,A`), the
"bug" was invisible — held-and-correct look identical. Starting from
`C=1` (`SCF` then two `CCF`s) exposed it outright: `C` stayed `1` straight
through `RLCA`, never becoming the `0` it should have. The root cause was
a data/condition mix-up in this feature's own code: the "is one of
`RLCA`/`RRCA`/`RLA`/`RRA` active" signal feeding `F`'s own `we` (via
`ROTACC_N_NOW`) had been built from `rotAccCStage` — the `C` *value*
itself (`AND(isRotLeft, A's old bit 7) OR AND(isRotRight, A's old bit
0)`) — instead of a pure `OR(isRotLeft, isRotRight)` condition. Whenever
the bit this rotate reads from happened to be `0`, that "value" was `0`
too, and `F`'s entire `we` silently stayed low — not a wrong value
committed, no value committed *at all*, `F` just held whatever it already
had. `isRotAny`, the condition this always needed, replaced it. The
lesson this leaves behind, worth remembering the next time a feature
reuses one signal for two purposes: a value that happens to double as its
own gating condition is only safe when the value is never legitimately
allowed to be the "off" state while the gate should be "on" — true for
almost nothing that carries real data.

Test: 15 sequential state snapshots (`A`/`C`/`N`/`Z`/`S`/`PC`) across one
continuous 15-instruction sequence — `SCF`/`CCF`/`CCF` first (proving `C`
sets, inverts, inverts again with no cross-talk into `A` at all), then
`LD A,0x55` and all four rotates twice each (a deliberately asymmetric
byte so a transposed bit or an off-by-one in the wrap shows up as a wrong
byte outright), `RLA`/`RRA` specifically placed right after a `CCF` so
the *old* `C` feeding the new bit 0/7 is provably not just a coincidence,
and `CPL` twice (a round trip back to the starting byte). The real Z80
gotcha the test deliberately proves rather than assumes: none of these
seven touch `S`/`Z`/`P` — both stay stale from the initial `XOR A,A`
through every later instruction, `S=0` even once `A` holds `0xAA` (bit 7
set) after the very first `RLCA` — a "helpful" implementation that
recomputes `S`/`Z` from the new `A` would fail this test, not pass it by
accident. All green after both fixes landed.

Full suite: `155 tests, 28 files, all green` — `4825.18s` (`80m25.18s`),
run at the same capped `--pool=threads --poolOptions.threads.maxThreads=3`
this project's last full run already settled on for a busy machine (see
"x=00, z=2" above) — comparable to that run's `75m47.37s` on one fewer
file, not the regression it might look like at a glance.

### Closing out the CPU: `ADC`/`SBC`, the shadow-register swap family, a genuinely new same-tick hazard, and a minimal I/O port invented from scratch

Nine opcodes/opcode-groups landed in one push, closing out every
real, buildable gap the project's own instruction set had left: `ADC`/
`SBC` (`x=10`), `NOP` (already correct, just never had its own test),
`EX AF,AF'`, `EXX`, `JP (HL)`, `LD SP,HL`, `EX DE,HL`, `EX (SP),HL`, `ALU
op A,n` (`x=11, z=6`), and `IN A,(n)`/`OUT (n),A`. `DI`/`EI` were a
permanent exception then (no interrupt line); a thin IM1 IRQ layer later
closed them (see "Thin IM1 IRQ" below). The `CB`/`DD`/`ED`/`FD` prefix
bytes were called permanent exceptions in this same push; that was true
*then* — the prefix *mechanism*, the `ED` table, and the `CB` table landed
in later passes (see "The CB/ED/DD/FD prefix mechanism" and the `ED`/`CB`
sections below). `DD` now has an IX slice (`LD IX,nn` / `PUSH IX` /
`POP IX`, HL-clone, `(IX+d)` LD / INC/DEC / ALU `A,(IX+d)`); `FD` has
the matching IY slice; `DD`/`FD CB` and H→IXH remap remain later.

**`ADC`/`SBC`** turned out to be exactly the "smaller lift" the very first
`x=10` doc comment predicted, back when this file had no flags register at
all to route a carry from: `isSubtractLike` (`OR(isSubtract, DECY3)`)
widens the existing SUB/CP operand-invert to cover `SBC` too; `cin` gets
two new terms (`F`'s own `C` for `ADC`, `C` inverted for `SBC`) ahead of
the existing hardcoded 0/1; `weRaw`/`cIsArith` — already pure functions of
`dec.y`, never `dec.x` — needed only wider `OR` trees, no new logic. No
new adder, no new op-select.

**`EX AF,AF'`/`EXX`/`EX DE,HL`** are one family: a real swap, both
directions committing on the *same* clock edge. `EX AF,AF'` needed two new
shadow registers (`aP`/`fP`); `EXX` needed six (`bP`..`lP`) for three
paired swaps at once; `EX DE,HL` needed none at all, just reusing `HOLD`/
`DOLD`/`EOLD`/`LOLD` (already published for `EXX`'s own swap) to trade two
*already-live* pairs. The generic tool that made all three cheap:
`wrapWithPairCommit`, built originally for `INC BC/DE/HL`'s own "+1 into a
paused pair" shape, turns out not to care that the "value" being committed
is another register's raw old contents instead of an adder's fresh
output — every later swap layer is one more call to it. The master-slave
guarantee behind all of this (see the `sp.q`-during-a-read doc comment,
"x=00: INC (HL)/DEC (HL)/LD (HL),n") — a register's own capture freezes
at whatever it saw *before* the edge, regardless of what the register
supplying that value does *during* the same edge — turned out to
generalize cleanly to two, then six, simultaneous swaps with no new
reasoning needed, confirmed each time by a test that reverses the swap
twice and checks every register lands back exactly on its seed.

Found live, twice, the identical way: `aP`'s and `fP'`s own `.clk` pins
were never actually wired to the shared `CLK` label — the exact
`jpTarget`-class bug this file has hit and fixed several times before
("checked off explicitly, every time, no exceptions," and then not
checked, again). `EXX`'s own six new registers got the fix applied
pre-emptively this time, from memory of the same mistake two features
earlier in the same session — no live failure needed to catch it a third
time.

**`EX (SP),HL`** is the one member of this swap family that trades a
register pair with *RAM* instead of another register — a real 4-phase
read-modify-write (`PHASE2`/`PHASE3` read `[SP]`/`[SP+1]` into two holding
registers, `PHASE4`/`PHASE5` write `L`/`H`'s own old values back while `L`/
`H` themselves take the holding registers' values on those same edges),
and the source of a genuinely new bug class this project hadn't hit
before. The first cut drove `L`/`H`'s own old value onto the write bus
straight from `REGL`/`REGH` (labels already anchored to `rL.q`/`rH.q` for
two earlier, working bus sources) — reasoning that since those labels
already worked everywhere else, they'd work here too. They don't, for a
reason specific to this exact opcode: `L`/`H` are *also* committing a
brand-new value on that same edge. A register safely reads *another*
register's old value on a shared edge because the *reader's own* master
latch freezes pre-edge — but a bare tri-state buffer has no master latch
of its own; it just reflects whatever `rL.q`/`rH.q` settle to within that
same tick, which is the fresh value the instant the slave releases it, not
the pre-edge one. `RAM` silently kept its old bytes while `HL`'s own
read-back looked completely correct — the write side was broken, the read
side wasn't, which is exactly the kind of asymmetric failure that takes a
debug trace to separate rather than guess at. Two more holding registers
(`oldLTemp`/`oldHTemp`, capturing `L`/`H` at `PHASE2`, well before either
one's own same-instruction write) fixed it the same way every other
"value must survive past its own bus's next user" case in this file
already does — a real flip-flop's own master-slave discipline in between,
not a live combinational tap on a register that's about to move.

**`ALU op A,n`** (`x=11, z=6`) needed almost nothing: `alu.op0`/`op1`/
`cin`/`bInv` are keyed on `dec.y` alone, never `dec.x`, and this column's
own `y` values encode the identical eight operations `x=10`'s own `y`
does — the instant the freshly-read immediate byte lands on the bus,
`alu.out`/`alu.cout` are already the right answer, zero new op-select
wiring. `aluAnyGroupNow` (`OR(aluGroupNow, aluImm8ReadNow)`) is the one
new signal needed, widening `A`/`F`'s own commit gate in place of bare
`aluGroupNow` — `groupActive` (the *register*-operand bus enable)
deliberately stays narrow, since this opcode's operand is RAM's own read,
not a register's.

**`IN A,(n)`/`OUT (n),A`** needed a real I/O-port concept this file never
had before, kept deliberately minimal: `ioPortAddr`/`ioPortDataOut` are
live output taps (the bus, and `A`), valid only while `ioRead`/`ioWrite`
fires; `ioPortDataIn` is a genuine external sink — the identical contract
`Register.d`/`Register.we` already use, a caller's own device wires into
it, this file never drives it. Port address is **16-bit Soft parity**: low
byte = bus/`n`/`C`, high = `A` (imm) or `B` (IN/OUT (C) / block). Lab LED
decode and SoftDevices still match on low 8 (`& 0xff`). Building an
actual peripheral for the other end of these pins is explicitly out of
scope — this file exposes a bus, not a keyboard controller. The test for
this one is structurally different from every other test in this file:
`ioRead`/`ioWrite`/`ioPortAddr`/`ioPortDataOut` are transient, valid for
exactly one `PHASE2` and never latched anywhere, so proving them right
needs a mid-instruction checkpoint (reading pins between individual
`phaseClk`/`dataClk` pulses) rather than the end-of-instruction snapshot
every earlier test gets away with.

Full suite after this batch: `163 tests, 36 files, all green` —
`1996.93s` test duration, `33m17.712s` real wall-clock, run capped at
`--poolOptions.threads.maxThreads=3` — but for a different reason than
the cap this project reached for earlier (see "the earlier full-parallel
OOM" above, where the very same cache made the cap unnecessary and a
default, uncapped run passed clean at `1091.98s`). This time an
uncapped run was tried first and had to be killed after each file's
own wall-clock time kept climbing the longer the run went — `free -h`
mid-run showed twelve-plus gigabytes still free, so this wasn't memory
pressure at all, just nine new heavy `buildZ80Cpu` files (`EX (SP),HL`'s
own extra RAM read-modify-write chief among them) all fighting the same
handful of cores for CPU time. Capped at three threads, each file's
time levels off instead of climbing. The flatten/computeNets cache is
still doing its job — the slowdown isn't a caching regression, it's
real per-tick solver work that no amount of caching the *structure*
removes.

### Closing the half-carry gap: real `H`, the two undocumented bits, and `DAA`

`H` (bit 4) and the two undocumented flag bits `X`/`Y` (bits 3/5) were
`gnd`, unconditionally, since the very first `x=10` flags were built —
documented every time as a deliberate simplification, but a real gap:
`DAA` (`0x27`) couldn't be implemented at all without a genuine `H` to
read. This pass closes it for the three places real Z80 actually computes
these bits fresh — the `x=10`/`x=11` ALU group (`ADD`/`ADC`/`SUB`/`SBC`/
`AND`/`XOR`/`OR`/`CP`, and `ALU op A,n`), and `INC r`/`DEC r` — then builds
`DAA` itself on top of a real `H`.

**`H` is the same idiom `C` already uses, one carry earlier.** `Alu` (in
`blocks.ts`) used to expose only the chain's two open ends — `cin` (bit
0's) and `cout` (the last slice's) — every interior carry disappeared
inside the ripple-carry chain the moment `buildAlu` folded it away. `C`
itself is `XOR(alu.cout, isSubtractLike)` — the adder's own final carry,
inverted for subtraction (borrow-out, not carry-out, in that direction).
`H` is *the exact same formula*, just read off `carries[3]` — the carry
crossing the nibble boundary — instead of `carries[7]` (`cout` itself). A
new `carries: Pin[]` field on `Alu` (every slice's own `cout`, LSB to MSB,
`carries[bits-1] === cout`) is all that took: no new gates in
`buildAluSlice`, just a wire this project was already routing internally,
finally exposed. `AND`/`OR`/`XOR` don't just leave `H` at 0 like they do
`C`, though — real Z80 hardwires `AND` to `H=1` unconditionally (a
documented silicon quirk, not a bug) and `OR`/`XOR` to `H=0`; `DECY4`
(`AND`, `y=4`) ORed straight into the final bit covers the `H=1` case with
no extra gating needed, since `OR`/`XOR`'s own nibble-carry term is
already gated off by the same `cIsArith` condition `C` already reuses
(`y=0/1/2/3/7` — `ADD`/`ADC`/`SUB`/`SBC`/`CP`, exactly the five arithmetic
ops, never the three logic ones). `r8Adder` (the shared `INC r`/`DEC r`
adder) gets the identical one-line treatment, `isDecR8` standing in for
`isSubtractLike`. `X`/`Y` are a straight mirror of the result's own bits
3/5 for both groups — no adder logic needed at all, just wiring
`alu.out[3]`/`alu.out[5]` (or `r8Adder.out[3]`/`out[5]`) into the per-bit
`F` pipeline the identical way `C`/`Z`/`S`/`P` already flow through it.
`CP`'s own real-hardware quirk — sourcing `X`/`Y` from the *operand*
instead of the discarded result — is deliberately not modeled, the same
"not chased to full silicon fidelity everywhere" stance the very next
flag this project tackles (`P/V`, see "P/V is two flags, not one"
further down) takes too, just on a different bit. `ADD HL,rr` and the six-op
RLCA/RRCA/RLA/RRA/CPL/SCF/CCF group now refresh `H`/`X`/`Y` as well
(ADD HL: H from bit11 carry, X/Y from result high; rotates/CPL/SCF/CCF:
H and X/Y per real Z80, with CCF's H ← old C) — `S`/`Z`/`P/V` still hold
for both groups, matching silicon.

**Found live, chasing this pass's own test:** `z80cpu-inc-dec-r.test.ts`
(written for the *previous* pass, when bits 3/5 were still `gnd`) failed
the instant this landed — not a logic bug, a stale fixture. Its own
`EXPECTED` array hardcodes full `F` bytes; with `X`/`Y` now real, half of
those sixteen rows needed their expected byte recomputed by hand (the
other half already had `X`/`Y`'s bits sitting at 0 in the real result, so
those rows needed no change at all) — and three rows (`INC B`, `DEC B`,
`INC D`, `DEC D`, `DEC L`, `DEC A`) turned up a `H` value the old fixture
had never been able to see either, since half-carry genuinely fires on a
`0xF`-boundary nibble carry/borrow that a `gnd`-tied `H` could never
surface as a test failure before now. Recomputing all sixteen by hand and
cross-checking every one against the same `XOR(carries[3], isSubtractLike)`
formula `blocks.ts` itself uses is what turned a red test back to green —
worth recording because it's the same lesson "same-tick hazard" was in
the previous pass, in a gentler form: a fixture frozen while the
simplification it was testing against was still real stops being ground
truth the moment that simplification is fixed, and nothing announces
that on its own — the test just goes red, and the fix is in the fixture,
not the new code, exactly as often as it might be the other way around.

**`DAA` itself** reads `H`/`C`/`N` and `A`'s own nibbles to correct `A`
back into valid packed BCD after an 8-bit add or subtract — the logic
mirrors the well-known, zexall-verified formulation MAME's own `z80.cpp`
uses, built here at gate level instead of as an `if`:

```
loCorrect = OR(H, A&0xF > 9)     — low nibble needs +0x06/-0x06
hiCorrect = OR(C, A > 0x99)      — high nibble needs +0x60/-0x60
diff      = (loCorrect ? 0x06:0) | (hiCorrect ? 0x60:0)
newA      = N ? A-diff : A+diff  — same direction the last op ran
newC      = hiCorrect            — one formula, both directions (see below)
newH      = XOR(A_before[4], A_after[4])
newS/Z/P/X/Y — fresh off the corrected newA; N unchanged
```

`A&0xF > 9` is `AND(bit3, OR(bit2, bit1))` — every nibble with bit 3 set
and at least one of bit 2/bit 1 set is `>= 0b1010`. `A > 0x99` needed a
full 8-bit comparator this project didn't have lying around; built the
same way this file already reads a carry out of a subtraction everywhere
else — `A - 0x9A` via add-the-inverse-plus-one (`~0x9A = 0x65`, `cin=1`),
reading only the final `cout` ("no borrow" means `A >= 0x9A` means
`A > 0x99`) off a scratch `buildAlu` instance whose 8 sum outputs are
never read — the identical "always compute, gate only the commit"
discipline `r8Adder` established staying true one more time, just with
an *entire adder's* outputs going unused instead of one flag bit's.
`newC = hiCorrect` unconditionally, regardless of `N`, looks suspicious
at first (shouldn't subtraction and addition need different carry
formulas?) until you notice `A > 0x99` is already false for any `A` a
genuine subtract could have produced — for `N=1`, `hiCorrect` collapses to
exactly `C` itself, i.e. "hold C," the correct subtract-direction
behavior, with no separate branch needed. `newH`'s own definition — did
bit 4 flip during the correction? — is a second instance of the exact
same "a carry/borrow crossing the bit-4 boundary defines H" idea the
main `hBit` computation above already uses, just read off the
correction's own before/after effect instead of an adder's internal
carry line.

One more scratch `buildAlu` (`daaAdder`) does the actual `+diff`/`-diff`:
op fixed at `ADD`, direction reversed the identical `bInv`/`cin`-from-
`isSubtractLike` way the main ALU group's own adder already handles
`SUB`/`SBC`/`CP`, just with old `N` (`f.q[1]`) standing in for
`isSubtractLike` — `DAA` reverses whichever direction the *previous*
instruction actually ran, so reading `N` directly is exactly right,
not a coincidence. `DAA`'s own `A`/`F` write paths slot into the same
layered-mux pipeline every other flag-writing opcode in this file
already uses (`DAARESULT{i}` ahead of `ROTACCRESULT{i}` in `A`'s write
mux; a `DAA_NOW`-gated layer for every `F` bit but `N`, which `DAA` never
touches, in `F`'s own per-bit chain) — no new layering *shape*, just one
more instance of it.

Verified with three independently hand-derived BCD round-trips in
`z80cpu-daa.test.ts`: `0x15 + 0x27` (BCD 15+27=42, low-nibble-only
correction — `5+7=0xC` doesn't itself carry out of the nibble, so `H`
going into `DAA` is 0, yet the correction still fires correctly off the
`A&0xF>9` test alone), `0x99 + 0x01` (BCD 99+1=100, wraps to `0x00` with
`C=1` — both corrections fire at once), and `0x42 - 0x27` (BCD 42-27=15,
the subtract direction, correction driven by a genuine `H=1` this time —
`2-7` borrows in the low nibble). All three passed on the first real run,
gate-level formula matching hand arithmetic exactly.

Full suite after this batch: `164 tests, 37 files, all green` —
`2321.79s` test duration, `38m42.581s` real wall-clock, capped at
`--pool=threads --poolOptions.threads.minThreads=1
--poolOptions.threads.maxThreads=3` for the identical CPU-contention
reason the previous batch needed it, not memory pressure (see the note
two sections up).

### `P/V` is two flags, not one

Real Z80 crams two unrelated flags into the same bit, picked by which of
the eight `x=10`/`x=11` ALU ops actually ran: parity of the result for
the three logic ops (`AND`/`OR`/`XOR`), signed two's-complement overflow
for the five arithmetic ones (`ADD`/`ADC`/`SUB`/`SBC`/`CP`) — this
project modeled only the first half since the very first ALU-group flags
were built, documented every time as "parity, not the arithmetic-
overflow interpretation the same bit carries for `ADD`/`SUB` on real
silicon." This pass adds the second half.

**Overflow is one `XOR`, not a sign comparison.** The naive way to detect
signed overflow is comparing the two operands' sign bits against the
result's — same-signed operands producing a different-signed result. The
textbook hardware shortcut skips the comparison entirely: overflow is
`XOR(carry into the sign bit, carry out of the sign bit)`, an identity
that holds for both addition and subtraction without a separate formula
for either direction. Buildable here for the exact reason `hBit` was
buildable in the previous pass: `Alu.carries` already exposes every
interior carry, not just the final `cout` — `carries[6]` (carry crossing
into bit 7, the sign bit) is right there, needing no new adder logic, the
identical "wire that was always there internally, now exposed" story
`carries[3]` told for `H`. `overflowBit = XOR(carries[6], carries[7])` is
the entire circuit. Since `SUB`/`SBC`/`CP` are `ADD` with the operand
inverted and `cin=1` on this exact same adder, the one formula covers
all five arithmetic ops without caring which direction ran — the same
"no new logic needed, `SUB` already IS this adder" story `C`/`H` both
told already.

**Picking which of the two to show is a single 2:1 mux**, gated by
`cIsArith` — the identical gate `cBit`/`hBit` already reuse, since it was
already exactly "the five arithmetic ops, never the three logic ones."
`pvMux(sel=cIsArith, in0=parity, in1=overflow)` slots into the per-bit
`F` pipeline as `computedFlagBit[2]`'s new value, no change to any layer
above or below it in that chain.

**`INC r`/`DEC r` never gets a parity variant at all** — real Z80 has no
logic form of `INC`/`DEC`, so `R8_P` is unconditionally overflow, no mux
needed there, just `R8_P`'s own definition replaced outright with the
identical `XOR(r8Adder.carries[6], r8Adder.carries[7])` formula read off
the shared `INC`/`DEC` adder instead of the main ALU's. `DAA` keeps
*parity* — Zilog's own manual documents `DAA` setting `P/V` to parity of
the corrected result, not overflow, so `daaPBit`'s existing computation
needed no change at all. `ADD HL,rr` and the six-op RLCA/RRCA/RLA/RRA/
CPL/SCF/CCF group still leave `P/V` (and `S`/`Z`) exactly where the base
hold puts them — unchanged, matching real Z80 for those ops (their own
`H`/`X`/`Y` are now fresh; see above).

**Found live, chasing this pass's own new test:** two *already-passing*
tests broke the instant this landed, neither one written to look for
`P/V` specifically — both were checking a full `F` byte for an
unrelated reason (`z80cpu-inc-dec-r.test.ts`'s own C-held-across-INC/DEC
proof; `z80cpu-x11-stack.test.ts`'s own PUSH/POP-round-trips-F proof) and
happened to carry the *old* parity-based value along for the ride.
`z80cpu-inc-dec-r.test.ts` needed nine of its sixteen rows' `P/V` bit
recomputed (`INC D`/`DEC D`, `0x7F<->0x80`, is this trace's own instance
of the classic signed-overflow case — the same one this pass's own
dedicated test uses); `z80cpu-x11-stack.test.ts` needed a single value
(`ADD A,0x11`'s own `F`, threaded through eight assertions via
PUSH/POP's own round-trip) corrected from `0x04` to `0x00` once `0+0x11`
stopped reading as "odd parity, so P=1" and started reading as "no
overflow, so P/V=0." The lesson is the identical one "Closing the
half-carry gap" drew from `z80cpu-inc-dec-r.test.ts` the *previous* pass,
now with a second, independent confirmation: a fixture frozen while the
simplification it exercised was still in effect stops being ground truth
the moment that simplification is fixed, on a totally different flag
bit, in a totally different test file — not a fluke, a pattern this
project should expect every time a `gnd`-tied or partially-modeled flag
bit becomes real.

Verified independently in a new `z80cpu-pv-overflow.test.ts`: the three
canonical signed-overflow cases every architecture course reaches for
(`127+1`, `127+127`, `-128-1`), one ordinary non-overflowing `ADD`, one
`AND`/`OR` pair proving parity still works unchanged for logic ops, and
an `INC`/`DEC` pair proving the flag fires and clears correctly for that
family too, not just once.

Full suite after this batch: `165 tests, 38 files, all green` —
`2483.26s` test duration, `41m24.188s` real wall-clock, same
`--pool=threads --poolOptions.threads.minThreads=1
--poolOptions.threads.maxThreads=3` cap as the previous two batches, for
the identical CPU-contention reason, not memory.

### Canvas 2D rendering cost, closed out: idle-skip and viewport culling

The Canvas 2D bottleneck this file has carried as "still-unfixed" since
the flatten/computeNets caching work — `draw()` redrawing every top-level
primitive from scratch every frame, measured at `~3.8fps` for a
freshly-placed `+ Z80CPU` sitting idle — stopped being a nuisance and
became an outright browser-tab crash once `buildZ80Cpu` grew past a few
hundred components: placing one now built thousands directly into
`topCircuit` (see "Closing out the CPU" and the P/V/half-carry batches
above, each adding real gate-level machinery, not folded chip instances),
and a single `draw()` call over that many primitives — each with its own
`ctx.createLinearGradient`, multiple pin dots, stub lines, text — blocked
the render thread long enough that the tab stopped responding to anything,
this session's own live testing included. Two independent fixes, addressing
two different halves of the same cost:

**Idle-frame skip, in `main.ts`.** `step()`'s own relaxation is
deterministic: called again with an unchanged circuit and unchanged
inputs, starting from a state that already reached a fixpoint, it reaches
that identical fixpoint in exactly one internal pass — the returned
`levelOf` is a new `Map` object, but every value in it is bit-for-bit
what it already was. `!uiDirty && simState.settled`, checked *before*
calling `step()` at all, is therefore a cheap, provably conservative
signal that a frame would be a pure no-op: `uiDirty` is set by a single
window-level, capture-phase tap on every event type that could possibly
change anything visible (mouse, keyboard, wheel, a toolbar click, a
dialog button, `resize`) — deliberately blunt and over-inclusive rather
than threading a precise "this exact mutation changed something" flag
through `Editor`/`Camera`/every toolbar handler individually, since a
stray extra redraw costs nothing perceptible but a missed one leaves a
stale frame on screen. `settled` catches the one case `uiDirty` can't: a
circuit still actively converging, or a user-built free-running
oscillator that legitimately never settles, keeps stepping and drawing
every frame regardless. Skipping `step()` when nothing changed also
skips its own `computeDrivers`/`UnionFind` work every idle frame, real
cost proportional to circuit size this cache never touched, alongside
skipping `draw()` outright — live-measured, a truly idle `+ Z80CPU` now
goes *minutes* between frames, not `~263ms` (`3.8fps`) forever.

**Viewport culling, in `Renderer.ts`.** `draw()` used to iterate and
fully render every component in `circuit.components` unconditionally,
with no notion of what's actually on screen — and since placing a
composite never auto-fits the camera to it, the vast majority of a
freshly-placed `+ Z80CPU`'s thousands of components sit *outside* the
current viewport at whatever zoom/pan the canvas already had.
`componentRadius` gives each component kind a deliberately generous
half-extent (body size plus slack for a stub line to a pin or a label's
name drawn above its dot — an approximation, not exact pin geometry,
because the only failure mode worth avoiding is culling something
actually a few pixels on-screen, and a generous margin costs one cheap
bounds check per component to rule that out, not a redraw);
`isComponentVisible`/`isWireVisible` turn that into a plain interval-
overlap test (`boundsOverlap`) against the current viewport, expanded by
a fixed screen-space margin so a component just past the edge doesn't
pop in and out as the camera pans by a pixel. Wires get a smaller fixed
margin instead of `componentRadius`'s per-kind sizing, since a polyline's
own glow underlay is only ever a handful of pixels wide regardless of
what it connects. Tested directly in `Renderer.test.ts` — thirteen cases
against the pure geometry functions themselves, no `CanvasRenderingContext2D`
needed at all, `chip`/`ram` instances included (their own real
`chipInstanceHeight`/`ramPortCount`-derived size, not a generic radius).

**Both together, live-measured** placing the default `+ Z80CPU` (9163
top-level components): the one unavoidable first frame — cache-cold
`flatten` (`~1024ms`) and `computeNets` (`~1777ms`, both cache misses
since the structure just changed), `step` (`~200ms`), then `draw`
(`~37ms`, culling already active) — costs roughly three seconds once,
the same three seconds this project's own headless timing script already
predicted for the simulation side alone. Every frame after that: zero,
until the next real interaction, at which point a pan/zoom/click redraw
costs `~30-37ms` (culling keeping the per-frame primitive count down to
whatever's actually visible) — not the `~263ms` this bottleneck used to
cost *every single frame, forever*, and nowhere near what used to crash
the tab outright. Neither fix touches simulation correctness — both are
provably safe to skip-or-cull exactly when they do, never when a real
change could be showing.

Full suite after this batch: `178 tests, 39 files, all green` —
`2418.93s` test duration, `40m19.695s` real wall-clock, same
`--pool=threads --poolOptions.threads.minThreads=1
--poolOptions.threads.maxThreads=3` cap as every batch since the CPU-
contention discovery. Neither `main.ts`'s idle-skip nor `Renderer.ts`'s
culling touches anything `src/sim/*`'s own test suite exercises — a
UI-only change, confirmed by every pre-existing `buildZ80Cpu` test still
passing unchanged, plus the new `Renderer.test.ts` (13 tests, `17ms`)
covering the culling geometry itself.

### The CB/ED/DD/FD prefix mechanism: detect, recapture, exclude

Every opcode this project decodes and executes, `x=00` through `x=11`,
has been a single, unprefixed byte. Real Z80 has four more opcode tables
behind four prefix bytes — `CB` (bit-level `RLC`/`BIT`/`SET`/`RES`), `ED`
(block transfer/search, `IX`/`IY`-less extended instructions), `DD`/`FD`
(`IX`/`IY` index-register variants of most of the unprefixed table). This
pass builds the *mechanism* every one of those four tables needs before a
single new instruction can run on top of it — detect a prefix byte,
recapture `ir` with the real opcode that follows it, advance `pc` an
extra time, and — the genuinely hard, invasive part — keep the four
already-built opcode tables from misinterpreting that recaptured byte as
if it had arrived unprefixed. At the moment this mechanism landed, no
prefixed instruction body executed yet — the foundation the next several
passes built on. The non-interrupt half of `ED` is now wired (block
column, `NEG`, `ADC`/`SBC HL,rr`, `RRD`/`RLD`, `LD (nn),dd`, `IN`/`OUT
(C)`, `LD I/R`); CB has `BIT`, `SET`/`RES`, and rotates/shifts
(register + `(HL)`); `DD` has a first IX slice (see "DD: IX" below);
`FD` has the matching IY slice (see "FD: IY" below).

**Finding the four prefix bytes needed no new decode table at all.** Real
Z80 puts all four in `x=11`'s own `z=3`/`z=5` columns — `CB`=0xCB sits at
`z=3,y=1`, the one `z=3` slot `JP nn`/`OUT (n),A`/`IN A,(n)`/
`EX (SP),HL`/`EX DE,HL` never claimed; `DD`/`ED`/`FD`=0xDD/0xED/0xFD sit
at `z=5,y=3/5/7`, the three `z=5` slots `PUSH rp`'s own `y=0,2,4,6` and
`CALL nn`'s `y=1` never claimed. `dec.x[3]`/`dec.z[3]`/`dec.z[5]`/
`dec.y[1,3,5,7]` are exactly the same lines every other `x=11` feature
already reads — `isCbPrefixRaw`/`isDdPrefixRaw`/`isEdPrefixRaw`/
`isFdPrefixRaw` are four `AND` chains off them, nothing new.

**Recapturing `ir` reuses `LD r,n`'s own shape wholesale.** The hard part
was never *finding* a prefix byte — it's what happens once one's
consumed. This project already had the exact mechanism a second-byte
read needs: `LD r,n`'s PHASE2-read/PHASE3-advance pattern (see "x=00,
z=6: LD r,n" above) — reused here unchanged, except the destination this
second read lands in is `ir` itself (recapturing it with the *real*
opcode byte, not a data operand), and `pc`'s own address is already
right (PHASE1's own increment already moved it past the prefix byte
before PHASE2 reads again — the identical "PC already the default read
address, no new address-mux term needed" fact every immediate-reading
feature already relies on). `ir.we`, previously a bare `PHASE0` label
anchor, widens to `OR(PHASE0, PREFIX_READ_NOW)`; `ram.oe` and `pc`'s own
advance-hold chain (`ramOeFinal`/`pcHold`) each pick up one more term,
the twenty-sixth and sixteenth respectively, the same shape every
multi-byte instruction already added one of.

**The invasive part: keeping the old tables blind to a recaptured byte.**
Once `ir` is recaptured, `dec.x`/`dec.y`/`dec.z` combinationally reflect
the *real* opcode's own fields from PHASE3 onward — colliding head-on
with every table this file already built. Real Z80 `0xA0` (`LDI`, once
ED-prefixed) decomposes to `x=10,y=4,z=0` — exactly `AND B` in the plain
unprefixed table this project already executes. Nothing about the
existing `x=10`/`x=01`/`x=00`/`x=11` group gates knew to stay quiet just
because the byte they were looking at arrived via a prefix — because
until this pass, a prefix byte couldn't arrive at all.

Fixing this touched far less code than it sounds like it should have,
for one reason: every downstream gate in this ~5400-line file reads one
of exactly four base signals — `isX0Group`/`isLdGroup`/`isAluGroup`/
`isStackGroup` — never `dec.x[N]` directly (verified with `grep -n
"dec\.x\["`: precisely those four call sites, no bypasses). `activePrefix`
is a real 4-bit one-hot register — CB/DD/ED/FD, whichever fired, latched
the instant `ir` is recaptured, `we=OR(PHASE0, PREFIX_READ_NOW)` (reset
to all-zero on every FETCH, the default; overridden with the real one-hot
value only when a genuine prefix was just detected — the identical
"reset by default, override on the one condition that matters"
mux-ahead-of-`d` shape `aReset` already established for `A`). Its own
inverted OR, `notPrefixActive`, becomes a fifth term `AND`ed into each of
those four base gates in place of the bare `dec.x[N]` each used to be —
every one of the hundreds of gates already built *on top of* those four
inherits the exclusion for free, without touching one of them
individually. Read at PHASE2 itself (this same tick's own recapture),
`activePrefix.q` is still whatever the *previous* instruction's FETCH
reset it to — 0, always, since FETCH unconditionally resets it every
single instruction (a real register's `.q` only moves on the next edge —
the master-slave guarantee this whole file already leans on everywhere
else) — so the exclusion is correctly *inactive* for a prefix byte's own
first-byte detection, and correctly *active* starting PHASE3 of the very
same instruction, once the real opcode byte has actually landed in `ir`.
`PREFIX_ADVANCE_NOW` (feeding `pc`'s own advance-hold chain) needed the
identical latched-not-live distinction for a different reason: gating it
by the *live* `isAnyPrefixRaw` instead would read `dec.x/y/z` fresh at
PHASE3, by which point they already reflect the real opcode byte, not
"was this instruction prefixed" — `AND(activePrefix's own OR, PHASE3)` is
the one-tick-pulsed, correctly-latched version every other multi-byte
instruction's own `*_ADVANCE_NOW` already is.

One circular-dependency trap, caught before it became actual code: the
four prefix-detection gates themselves can't be built from the *excluded*
`isStackGroup` (they'd need `notPrefixActive` before `notPrefixActive`
itself exists, which needs the very prefix bits those detection gates
compute) — they're built from `rawStackGroup` (bare `dec.x[3]`) instead,
with `isStackGroup` itself (the excluded version everything else reads)
defined afterward, once `notPrefixActive` is real. No actual circularity
ever reached the file, just a naming discipline (`raw*` for the four
unexcluded signals prefix-detection needs, the familiar name for the
excluded signal everything downstream keeps using unchanged).

**Deliberately not modeled**: a prefix immediately following another
(real hardware treats that as a restart) — this project's one-shot
"prefix, then real opcode" shape does not restart. Nested `DD CB d op` /
`FD CB d op` are modeled for BIT / SET/RES / rot on `(IX+d)`/`(IY+d)`
(see "DD CB / FD CB" below; undocumented `z≠6` stays out of scope).
`isEdActive` was the first of the four prefix bits to get a
label (LDI); `isCbActive` followed for `BIT`; `isDdActive` is labeled
for the IX slice below. `isFdActive` is labeled for the IY slice below.

Verified against the two existing test files most likely to catch a
retrofit mistake in the four base group gates (`blocks.test.ts`,
exercising `buildMinimalCpu`'s own unrelated encoding, and
`z80cpu-x10.test.ts`, exercising the real unprefixed `x=10` table this
retrofit's exclusion sits directly in front of) before running the full
suite — both passed unchanged. The full suite itself: `39/39` files,
`178/178` tests, `2665.44s` wall-clock (`time`'s own real, seven
parallel workers) — indistinguishable from this project's pre-retrofit
baseline despite the much heavier per-test cost documented below, purely
because the slowdown lands on CPU time, not wall-clock, and there's
enough parallel headroom to absorb it.

Committed to git for the first time immediately before this retrofit
began (`git init`, an initial commit of the 178-passing-test state), on
a dedicated branch — a real rollback point for a change this invasive to
code that had never needed one before, this project having had no git
history at all until this pass.

### DD: IX (first slice + HL-clone + (IX+d) mem + H→IXH)

Real Z80's `DD` prefix remaps many `HL` ops onto the `IX` index register.
This project's DD body covers the `IX` register itself (`IXH`/`IXL`), the
HL-pair shapes that need no `(IX+d)`, and the displacement mem slice
(LD / INC/DEC / ALU `A,(IX+d)`).

**First slice** — load / stack:

- **`LD IX,nn`** (`DD 21 nn nn`) — decode `isDdActive ∧ dec.x[0] ∧
  dec.z[1] ∧ dec.y[4]`. PHASE4 reads the low immediate into `IXL`,
  PHASE5 advances PC, PHASE6 reads the high into `IXH`, PHASE7 advances
  PC. Adjacent-phase exclusions mirror EDNN. `ram.oe` and `pcHold` each
  widen with the two read / two advance strobes; write-back is
  `wrapWithPairCommit` with `BUS` as the value label.
- **`PUSH IX`** (`DD E5`) / **`POP IX`** (`DD E1`) — decode
  `isDdActive ∧ dec.x[3]` with PUSH `z[5]∧y[4]` and POP `z[1]∧y[4]`.
  PUSH: PHASE4 high (`IXH→bus`), PHASE5 low (`IXL→bus`, excludes high).
  POP: PHASE4 low into `IXL`, PHASE5 high into `IXH`. `stackWriteNow` /
  `readNow` widen for the DD phases; tri-buf banks drive `REGIXH`/
  `REGIXL` onto `BUS` for PUSH; another `wrapWithPairCommit` layer
  commits POP from `BUS`.

**HL-clone slice** (no displacement) — parallel decode on raw
`dec.x/y/z` ∧ `isDdActive`, bodies at **PHASE4** (prefix burns
PHASE2–3). Never reopen `isX0Group` / `isStackGroup`
(`NOT_PREFIX_ACTIVE` kills those under DD):

- **`ADD IX,rr`** (`DD 09/19/29/39`) — widens the shared `addHlAdder`
  (`a` muxes HL/IX/IY; HL-pair `b` slot uses IX under DD so `ADD IX,IX`
  works). `ADDIX_NOW` @ PHASE4; `wrapWithPairCommit` on IX from
  `ADDHLHI`/`ADDHLLO`; F C-bit mux / `we` OR with `ADDIX_NOW` (same
  `ADDHL_C`). Unprefixed `ADDHL_NOW` stays quiet under prefix.
- **`INC/DEC IX`** (`DD 23`/`2B`) — `buildPairAdder` → `IXADD`;
  `INCDEC_IX_NOW` @ PHASE4; no flags.
- **`JP (IX)`** (`DD E9`) — `JPIX_NOW` @ PHASE4; PC mux layer after
  `jpHlMux` from `IXL`/`IXH`.
- **`LD SP,IX`** (`DD F9`) — `LDSPIX_NOW` @ PHASE4; SP mux from IX;
  widen SP `we`.
- **`EX (SP),IX`** (`DD E3`) — PHASE4–7 with adjacent exclusions;
  shares `spLoTemp`/`spHiTemp`/`oldLTemp`/`oldHTemp`/`exSpHlPlusOne`
  and the EXSPHL addr mux (strobes OR'd). Old IX captured into the
  holding temps at first read (never drive bus from live `REGIX*`
  while committing IX). IX write-back from `SPLOTEMP`/`SPHITEMP`.

**(IX+d) mem slice** — parallel decode, never reopen `isLdGroup` /
`isX0Group` / `isAluGroup`:

```
isDdMemLdRead  = isDdActive ∧ x[1] ∧ z[6] ∧ ¬y[6]   // LD r,(IX+d)
isDdMemLdWrite = isDdActive ∧ x[1] ∧ y[6] ∧ ¬z[6]   // LD (IX+d),r
isDdMemLdN     = isDdActive ∧ x[0] ∧ z[6] ∧ y[6]    // LD (IX+d),n
isDdMemIncDec  = isDdActive ∧ x[0] ∧ (z[4]∨z[5]) ∧ y[6]  // INC/DEC (IX+d)
isDdMemAlu     = isDdActive ∧ x[2] ∧ z[6]            // ALU A,(IX+d)
```

- Shared `isDdMemAny` widens d-fetch / advance for LD + INC/DEC + ALU:
  `ixDisp` capture @ PHASE4 (`DDDISP_READ_NOW`); PHASE5 advances PC past
  `d` (`DDDISP_ADVANCE_NOW`, excludes PHASE4).
- Dedicated `ixDispAdder` (`a` = IX truncated to `addrBits`, `b` =
  sign-extend `d`) — not `jrOffsetAdder` (hardwired to PC).
- `IXDISP_ADDR_NOW` gates the RAM addr mux **only** during mem R/W
  phases (PHASE6 for r↔mem / INCDEC read / ALU read, PHASE7 for
  `(IX+d),n` write and INCDEC write) — never during d/n fetches @ PC
  (same phase-scope discipline as the `IS_INCDEC_HLMEM` live bug).
- `LD r,(IX+d)` / `LD (IX+d),r`: PHASE6 mem R or W; register WE /
  bus sources use DD strobes ∧ `y`/`z` (cannot reuse dead `ldGroupNow`).
- `LD (IX+d),n`: PHASE6 fetch `n` → `ldIxDNImm`; PHASE7 write @ IX+d
  and advance past `n` (excludes PHASE6).
- **`INC`/`DEC (IX+d)`** (`DD 34 d` / `DD 35 d`): PHASE6 read @ IX+d
  into shared `hlMemTemp`; PHASE7 write `R8RESULT` @ IX+d and commit F
  (unprefixed `HLMEM_READ_NOW` @ PHASE2 / `INCDEC_HLMEM_NOW` @ PHASE3,
  shifted +4). Shared `r8Adder` selects `HLMEM` via `y[6]`; DEC
  direction ORs `DDMEM_IS_DEC` (`isDdMemIncDec ∧ z[5]`) into the dead
  `isDecR8` path for `cin`/`b`/`R8_N`/`R8_H`. Far ORs: `hlMemTemp.we`,
  `ram.oe`/`ram.we`, `R8RESULT` bus enable, `INCDEC_R8_NOW`.
- **ALU `A,(IX+d)`** (`DD 86/8E/96/9E/A6/AE/B6/BE d`): PHASE6 read @
  IX+d onto `BUS`; widen `aluAnyGroupNow` (dead `aluGroupNow` under
  prefix) so A/F commit like unprefixed ALU. Operand already comes from
  `BUS` when `ram.oe` drives it; `IXDISP_ADDR_NOW` + `ram.oe` OR PHASE6.

`DD CB` / `FD CB` BIT / SET/RES / rot on `(IX+d)`/`(IY+d)` are below;
H→IXH remap is in the next subsection. Verified by
`z80cpu-dd-ix.test.ts` (load/push/pop, HL-clone, `(IX+d)` LD, INC/DEC +
ALU, and DD CB BIT / SET/RES/rot programs; asserts HL and IY unchanged).

### DD: H→IXH / L→IXL 8-bit remap

Real Z80 remaps the 8-bit `H`/`L` slots (not `(HL)` / `y=6` / `z=6`) onto
`IXH`/`IXL` under `DD` (and `IYH`/`IYL` under `FD`). `NOT_PREFIX_ACTIVE`
kills `isLdGroup` / `isX0Group` / `isAluGroup` under DD, so this is
parallel decode only — never reopen those gates:

```
isDdHl8Ld  = isDdActive ∧ ¬ddCbMode ∧ x[1] ∧ ¬y[6] ∧ ¬z[6] ∧ (y[4]∨y[5]∨z[4]∨z[5])
isDdHl8Imm = isDdActive ∧ ¬ddCbMode ∧ x[0] ∧ z[6] ∧ (y[4]∨y[5])
isDdHl8Inc = isDdActive ∧ ¬ddCbMode ∧ x[0] ∧ (z[4]∨z[5]) ∧ (y[4]∨y[5])
isDdHl8Alu = isDdActive ∧ ¬ddCbMode ∧ x[2] ∧ (z[4]∨z[5])
```

Bodies @ **PHASE4** (prefix burns 2–3). Imm: PHASE4 read `n`, PHASE5
advance (adjacent exclude). Skip under `ddCbMode` / `fdCbMode`
(undocumented DD CB `z≠6` stays out of scope).

**Wiring:**

- Source→BUS: B/C/D/E/A use the existing tri-buf banks with
  `DDIX_HL8_LD_NOW` widening `srcActive`; H/L under HL8 use dedicated
  `REGIXH`/`REGIXL` banks (`DDIX_HL8_SRC_IXH/IXL_NOW`, also OR'd for ALU).
  Never enable `REGH`/`REGL` for remapped sources.
- Dest WE: B/C/D/E/A via `DDIX_HL8_WE_*`; IXH/IXL via
  `wrapWithPairCommit` (`DDIXH_BUS_NOW` / `DDIXL_BUS_NOW` from BUS for
  LD+imm; `DDIXH_INC_NOW` / `DDIXL_INC_NOW` from `R8RESULT`). Never
  assert remapped dest onto `rH`/`rL` WE — `DDMEMLD_WE_H` still writes
  real H for `LD H,(IX+d)`.
- INC/DEC: feed `r8Adder` from `REGIXH`/`REGIXL` (`DDIXH_INC_NOW` select);
  suppress `REGH`/`REGL` select while HL8 INC active; DEC direction OR
  `DDIX_HL8_IS_DEC` into `isDecR8Any`; F via `INCDEC_R8_NOW` widen.
- ALU `A,IXH/IXL`: same PHASE4 bus drive + `aluAnyGroupNow` widen.

FD mirrors (`FDIY_*` / `IYH`/`IYL`). Verified by HL8 describes in
`z80cpu-dd-ix.test.ts` / `z80cpu-fd-iy.test.ts` (including negative
`LD H,(IX+2)` still writing H).

### DD CB / FD CB (BIT / SET/RES / rot on (IX+d)/(IY+d))

`activePrefix` is one-hot — after `DD`, PHASE2 recaptures `CB` into IR and
latches `isDdActive`; `isCbActive` stays 0, so a bare CB-table decode
never sees the nested op. Fix: separate mode latches + a second IR-only
recapture that does **not** rewrite `activePrefix`.

The ring is **10** phases (`buildRingCounter(..., 10, ...)`): BIT still
fits in the old 8 (op @ PHASE6, read+flags @ PHASE7), but SET/RES/rot need
a read then a write after the op — that needs `PHASE8`, and op-advance
moved off `PHASE7` (it conflicted with the SET/RES/rot read) onto
`PHASE9`. Extra PHASE8/9 are inert for every pre-existing op.

**Mode latch** (`ddCbMode` / `fdCbMode`, 1-bit, CLK wired):

- `we = OR(PHASE0, setNow)`; d-mux resets to 0 on PHASE0 (same shape as
  `activePrefix`).
- `setNow = PHASE3 ∧ isDdActive ∧ isCbPrefixRaw` (IR already holds CB after
  the PHASE2 edge). FD twin with `isFdActive`.
- Labels: `IS_DDCB_MODE`, `IS_FDCB_MODE`.

**CB table under mode:**

- `cbTableActive = OR(isCbActive, ddCbMode, fdCbMode)` feeds `isCbX0..X3`
  instead of bare `isCbActive`.
- Register-form CB (`isBitRegNow` / `isSetResReg` / `isCbRotReg`) and
  SET/RES/rot (HL) paths AND `NOT(ddCbMode∨fdCbMode)` — CB itself in IR at
  PHASE4 looks like SET z=3; under mode those paths must stay quiet.
  Plain BIT (HL) is also gated off under mode so it never forces addr=HL.
- `ddCbMode` ORs into `isDdMemAny` (FD twin) so existing
  `DDDISP_READ_NOW` / `DDDISP_ADVANCE_NOW` / `ixDisp` fetch `d` at
  PHASE4–5.

**Second IR recapture** (prefix latch untouched):

- `DDCB_OP_READ_NOW = ddCbMode ∧ PHASE6` (excludes PHASE5 d-advance).
- Widens `ir.we` and `ram.oe`. No PC advance on the op fetch — PC stays
  on the op through PHASE6–8.
- `DDCB_OP_ADVANCE_NOW` @ **PHASE9** advances past the op (excludes
  adjacent PHASE8 write). Same for FD.

**BIT body @ PHASE7** (unchanged timing; advance now later):

- `BIT_IX_NOW = ddCbMode ∧ isCbX1 ∧ z[6] ∧ PHASE7` (op already in IR from
  the PHASE6 edge). Read @ `(IX+d)`: `ram.oe` + `IXDISP_ADDR_NOW`.
- Flags same phase from **BUS** (not BIT_HL's two-phase `hlMemTemp`) —
  mirror ALU `A,(IX+d)` @ PHASE6. F we/mux layer `BIT_IXIY_NOW`.
- FD mirror with `BIT_IY_NOW` / `IYDISP_ADDR_NOW`.

**SET/RES / rot @ PHASE7 read + PHASE8 write** (z=6 only; undocumented
z≠6 register write-back still skipped):

- `isDdCbSetRes = ddCbMode ∧ isCbSetRes ∧ z[6]`;
  `isDdCbRot = ddCbMode ∧ isCbX0 ∧ z[6]`.
- PHASE7: `SETRES_IX_READ_NOW` / `CBROT_IX_READ_NOW` — `ram.oe`,
  `IXDISP_ADDR`, `hlMemTemp.we` / `cbRotHold.we` (reuse CB (HL) datapath;
  addr is IX+d, never HL).
- PHASE8: `SETRES_IX_WRITE_NOW` / `CBROT_IX_WRITE_NOW` — `ram.we`,
  `IXDISP_ADDR`, `SETRESRESULT` / `CBROTRESULT` bus drive; rot ORs into
  `CBROT_NOW` for F. Commit unions: `SETRES_MEM_WRITE_ANY`,
  `CBROT_MEM_WRITE_ANY`.
- FD mirrors (`*_IY_*`). H→IXH remap is a separate subsection above.

| Phase | Action |
|-------|--------|
| 0–1 | FETCH DD / PC++ |
| 2–3 | IR←CB, latch DD; PREFIX_ADVANCE; latch ddCbMode |
| 4–5 | d→ixDisp; advance |
| 6 | IR←op (2nd recapture; `activePrefix` untouched) |
| 7 | BIT: read+flags. SET/RES/rot: read into hold @ (IX+d) |
| 8 | SET/RES: write result. Rot: write+flags |
| 9 | Advance past op |

Verified by DD/FD BIT + SET/RES/rot describes in
`z80cpu-dd-ix.test.ts` / `z80cpu-fd-iy.test.ts`.

### FD: IY (first slice + HL-clone + (IY+d) mem + H→IYH)

Mechanical mirror of "DD: IX" above, gated on `isFdActive` (`0xFD`)
instead of `isDdActive`. Same register shape (`IYH`/`IYL`), same
PHASE4–7 / PHASE4–5 / PHASE4 bodies, plus the `(IY+d)` mem mirror
(`iyDisp` / `iyDispAdder` / `ldIyDNImm` / `IYDISP_ADDR_NOW`):

- **`LD IY,nn`** / **`PUSH IY`** / **`POP IY`** — as in the first
  slice (mirror of IX).
- **`ADD IY,rr`** / **`INC/DEC IY`** / **`JP (IY)`** / **`LD SP,IY`** /
  **`EX (SP),IY`** — same HL-clone wiring with `ADDIY_NOW`,
  `IYADD`, `JPIY_NOW`, `LDSPIY_NOW`, `EXSPIY_*`.
- **`LD r,(IY+d)`** / **`LD (IY+d),r`** / **`LD (IY+d),n`** /
  **`INC`/`DEC (IY+d)`** / **ALU `A,(IY+d)`** — FD mirror of the DD
  displacement mem slice.

- `FD CB` BIT / SET/RES / rot are above (shared "DD CB / FD CB" section);
- H→IYH / L→IYL 8-bit remap mirrors "DD: H→IXH / L→IXL" above.

Verified by `z80cpu-fd-iy.test.ts` (mirror programs; asserts HL and IX
unchanged under FD).

### x=10, z=0: LDI/LDD/LDIR/LDDR

Real Z80's own simplest ED-table instruction, and this project's first —
the natural first target the prefix mechanism's own doc comment above
already named. `(DE)<-(HL)`, then `HL++`/`DE++`/`BC--`, `N`/`H` reset,
`P/V<-(BC-1 != 0)`, `S`/`Z`/`C` left alone (the two undocumented `X`/`Y`
bits *do* change on real hardware too, from `A` plus the transferred
byte — deliberately not modeled here, the same category of documented
simplification `INC r`/`DEC r`'s own unmodeled `H` used to be, before
"Closing the half-carry gap" made that one real).

**The collision the prefix mechanism's own doc comment predicted, now
actually hit.** Real `0xED 0xA0` decomposes to `x=10,y=4,z=0` — bit for
bit the same fields as the plain unprefixed table's own `AND B`. `isLdiNow`
(`AND(isEdActive, dec.y[4], dec.z[0])`) is gated on `isEdActive` for
exactly this reason — `AND B` itself already reads `notPrefixActive`
through `isAluGroup` (see the prefix mechanism's own doc comment above),
so the two conditions can never both be `1` at once, the identical
one-hot-`x`-decode guarantee this file has relied on since `INC rr`/`DEC
rr`'s own three-source write-back.

**Three phases, not two.** `PHASE2`/`PHASE3` are already spent recapturing
`ir` and giving `pc` its own extra advance (see the prefix mechanism's own
doc comment above) — every prefixed instruction's real work starts one
phase later than an unprefixed instruction's equivalent would. `LDI`'s own
work: `PHASE4` reads `(HL)` into `ldiTemp` (an 8-bit holding register, the
identical "a value must outlive its own bus's next user" reasoning
`spLoTemp`/`spHiTemp` and `hlMemTemp` above already establish), `PHASE5`
writes it to `(DE)`, `PHASE6` commits `HL++`/`DE++`/`BC--` and the three F
bits. The register commit deliberately lands on its *own*, third phase
rather than sharing `PHASE5` with the write: `HL`/`DE` still hold their
*old* values through both RAM phases this way (their own pair adders
compute `+1` fresh from those old values the whole time, simply because
nothing has told them to commit yet), so the address mux never needs an
`EX (SP),HL`-style "old value" holding register of its own for either
one — the commit genuinely hasn't happened yet when either address is
read, not a value frozen on purpose to look that way.

**`BC`'s pair adder gets a second way to reach `-1`.** `DE`/`HL` need no
change at all: each pair adder (see "x=00, z=3: INC rr/DEC rr" above)
already computes `+1` whenever its own `DEC`-line (`dec.y[3]`/`dec.y[5]`)
reads `0` — which it always does while `ir` holds `LDI`'s own recaptured
`y=4` — so `DEADD`/`HLADD` are already computing the exact values this
instruction wants, for free, before it does anything at all. `BC` is the
one exception: `LDI` always wants `-1`, but `BCADD`'s own direction line
was `dec.y[1]` alone (real `DEC BC`'s own `y`-value, which `LDI`'s `y=4`
never matches) — widened to `OR(dec.y[1], isLdiNow)`, an addition, not a
replacement, since the two conditions are mutually exclusive by
construction and never need to be told apart, only recognized together.

**`P/V` is a 16-way `OR` tree over `BCADD`'s own bits.** `BC-1 != 0`
means "at least one of its 16 bits is 1", read directly off the same
`BCADDLO`/`BCADDHI` labels `BC`'s own write-back layer reads — 4 levels
of 2-input `OR` (this library has no wide-fan-in primitive), not a
dedicated zero-detector built from scratch.

**The write-back and F layers are one more of each, appended to the
longest existing chain.** `wrapWithPairCommit(rBExt5, 'LDI_COMMIT_NOW',
'BCADDHI', ...)` and its five siblings (`C`/`D`/`E`/`H`/`L`) sit on top of
`EXX`/`EX DE,HL`/`EX (SP),HL`'s own final layers — the identical "layer
another mux-ahead-of-`d` stage, don't touch the ones below" shape every
earlier feature in this file already established, safe here for the same
reason it always is: `dec.x` one-hot guarantees `LDI` and any of those
three swap instructions never fire in the same cycle. `F`'s own per-bit
chain gets an eighth layer, three bits only (`N`=1, `P/V`=2, `H`=4 — `gnd4`
directly for `N`/`H`, since there's no "fresh value" to publish for a
constant `0`, just `ldiPvBit` for `P/V`), the same "skip the bits this op
doesn't touch" shape DAA's own bit 1 and the six-op rotate/flag group's
own bits 2/6/7 already use.

Verified with a dedicated test (`z80cpu-ldi.test.ts`) exercising two
back-to-back `LDI`s specifically so `BC` genuinely reaches `0` on the
second one — `P/V` correctly dropping to `0` exactly then, not just
staying `1` from the first — before the full suite: `40/40` files,
`179/179` tests, still green.

**`LDD`, `LDIR`, `LDDR` — the rest of the column, on the same wiring.**
Real `0xED 0xA8`/`0xB0`/`0xB8` decode to `y=5`/`y=6`/`y=7` at the same
`x=10,z=0` — `isLddNow`, `isLdirNow`, `isLddrNow` are the obvious
`AND(isEdActive, dec.y[n], dec.z[0])` siblings of `isLdiNow`, and
`isLdBlockNow` is their four-way `OR` — the single gate every piece of
shared wiring below actually reads, so `LDI`'s own decode stays exactly
`isLdiNow` (it never needed to know its cousins exist) while everything
generic upgrades to the family gate. Getting there honestly meant
renaming every `LDI_*`/`ldi*` label and variable that had quietly
outgrown "means only `LDI`" to `LDBLOCK_*`/`ldBlock*` — this project has
never kept a label that stopped describing what it actually gates (see
the `JR`/`DJNZ` doc comment above), and `LDI_COMMIT_NOW` gating an `LDD`'s
commit would have been exactly that lie.

*Direction.* `LDD`/`LDDR` walk `HL`/`DE` down instead of up — one more
`OR` line, `directionIsDecNow = OR(isLddNow, isLddrNow)`, feeding
`DEADD`/`HLADD`'s own direction inputs (`OR(dec.y[3], directionIsDecNow)`,
`OR(dec.y[5], directionIsDecNow)`) the identical way `isLdBlockNow`
already widens `BCADD`'s. `BC` never needs a direction line at all —
every member of this family decrements it, always.

*The repeat.* Real silicon spends `LDIR`/`LDDR` on extra clock cycles,
looping the same micro-instruction until `BC` hits `0`. This project has
no micro-cycles to loop, so it fakes the identical *effect* the way
`DJNZ` already does: land `PC` back on its own opcode instead of letting
it advance, for as long as there's more to do. `isRepeatVariantNow =
OR(isLdirNow, isLddrNow)` and `ldBlockPvBit` (already computed for `P/V`
— "at least one bit of `BC-1` is set", i.e. "not yet zero") gate a new
`pcMinus2Adder` (a `buildAlu` computing `pc + (-2)` in two's complement,
sitting right next to `jrOffsetAdder`) through one more mux layer at the
very end of `pc.d`'s chain, downstream of `jpHlMux`: `LDBLOCK_REPEAT_NOW
= AND(isRepeatVariantNow, ldBlockPvBit, LDBLOCK_COMMIT_NOW)` selects
`pc-2` instead of the incremented `pc` the rest of the fetch/increment
logic already computed. The opcode's own two bytes get re-fetched
next cycle exactly as if the CPU had simply not moved — `IR` reloads the
same `0xED`, `BC`/`HL`/`DE` are already past their commit, so the second
pass transfers the next byte and, once `BC` reaches `0`, the same mux
selects the ordinary advanced `PC` instead and the loop ends on its own.
No dedicated "repeat" flip-flop, no extra state at all — the same
"correct next `PC` value is just one more mux input" trick this file has
used since its very first conditional jump.

Verified with two more dedicated tests: `z80cpu-ldd.test.ts` (two
back-to-back `LDD`s, proving the pointers retreat instead of advance —
everything else already proven identical to `LDI` by shared wiring) and
`z80cpu-ldir-lddr.test.ts` (`BC` seeded to `2` so each of `LDIR`/`LDDR`
genuinely repeats once and then falls through — the first
`runInstruction()` pass must show `PC` landed back on the `ED` opcode's
own address, the second must show it advanced two bytes past it) —
before the full suite: `42/42` files, `182/182` tests, still green.

### x=10, z=1: CPI/CPD/CPIR/CPDR

Real `0xED 0xA1`/`0xA9`/`0xB1`/`0xB9` — `LDI`'s own family's compare-and-
advance twin, `A - (HL)` computed for flags only (`A` itself is never
written), then `HL++`/`HL--`/`BC--`, `N` set, `H` a real half-borrow,
`P/V<-(BC-1 != 0)`, `S`/`Z` off the comparison, `C` left exactly where it
was — a real, documented Z80 quirk: a plain `CP` updates `C`, this family
never does. `isCpiNow`/`isCpdNow`/`isCpirNow`/`isCpdrNow`
(`AND(isEdActive, dec.y[4..7], dec.z[1])`) are the obvious siblings of
`isLdiNow`'s own shape, colliding this time with real `AND C`/`XOR C`/
`OR C`/`CP C` (`z=1`'s own register, `C`, instead of `z=0`'s `B`) —
`isCpBlockNow` their four-way `OR`.

**A dedicated subtractor, deliberately kept off the shared `x=10` ALU.**
`LDI`'s own family never touched that ALU at all, so its `y=4..7`
collision was harmless by construction — `groupActive` (hence
`aluGroupNow`, hence that ALU's own write-enables) already reads `0`
throughout, gated off by `isEdActive` the same way every prefixed
opcode already is. This family genuinely needs a subtract, though, and
each of its four variants collides with a *different* real op (`AND`/
`XOR`/`OR`/`CP`) — masking four different wrong op-selects, a wrong
`A`-write-enable, and `AND`'s own real "forces `H=1`" hardware quirk,
all read straight off the very `y` bits this family recaptures, would
cost more gates and more risk than the alternative actually taken: a
permanently-wired subtractor of its own (`op0=op1=0`, `cin=1`, `b`
inverted per bit — the identical two's-complement recipe the shared
ALU's own `SUB` path uses), the same "isolated adder, no shared-decode
collision to fight" shape `pcMinus2Adder` and `daaAdder`/`gt99Cmp`
elsewhere in this file already use for their own single-purpose
arithmetic. `A` is never written by this family at all, so the shared
ALU's own `aWe` never needs touching either — there simply is no
write-back path for this adder's result, only flags.

**Two phases, not three.** `PHASE4` reads `(HL)` into a holding register
(`cpBlockTemp`, feeding the dedicated adder directly — no bus-publish
step, unlike `ldBlockTemp`, since there's no second RAM phase for a
published value to survive into); `PHASE5` both computes and commits —
`HL+-1`/`BC--`/flags, all landing on the same edge real Z80's own
two-machine-cycle timing for this family already matches, one shorter
than `LDI`'s three. With nothing driving the bus back out from this
family's own commit phase, the adjacent-phase bus-fight guard
`LDBLOCK_WRITE_NOW` needs has nothing to guard here.

**Flags, five bits fresh, one held, two skipped.** `S`(`cpBlockAdder.out[7]`),
`Z` (an OR-tree over the adder's own 8 output bits, `NOT`ed — the
identical shape the shared ALU's own `zChain`/`zBit` already establish,
just a private copy off a private adder), and `H` (`NOT` of the adder's
own `carries[3]`, half-borrow at the nibble boundary, the same idiom the
shared ALU's `hRaw` uses collapsed to a plain `NOT` since this adder
never computes anything but a subtract) are all fresh every time; `N` is
a hardwired `1`; `P/V` reads `blockPvBit` (renamed from `ldBlockPvBit` —
see below) — the identical `BC-1 != 0` bit the LD-block family already
publishes, since both families decrement `BC` the same way. `C` gets no
layer at all — real Z80 leaves it alone for this whole family, so
whatever the layer below already carries (ultimately `f.q[0]`, a genuine
hold) falls straight through, unchanged. `X`/`Y` skip it too, the
identical "not modeled" stance this project already takes for `CP`'s own
real hardware quirk of sourcing them from the operand rather than the
discarded result.

**`blockPvBit`, not `ldBlockPvBit`.** The `BC-1 != 0` bit the LD-block
family already built (a 16-way `OR` tree over `BCADD`'s own published
bits) turns out to be exactly what this family's own `P/V` needs too —
both widen `BCADD`'s own direction line to always decrement, so the same
adder computes the same answer for either family, one-hot by
construction (`z=0` vs `z=1`, never both at once). Reusing it under its
old, `LD`-specific name would have been exactly the kind of label that
quietly stopped describing what it actually gates this project has never
tolerated (see the `JR`/`DJNZ` doc comment) — renamed to
`blockPvBit`/`BLOCK_PV_NOW` the moment a second family started reading
it.

**The repeat condition genuinely differs from `LDIR`/`LDDR`'s own.** Real
Z80 stops `CPIR`/`CPDR` the moment `BC` reaches `0` *or* a match is
found — `LDIR`/`LDDR` only ever watches `BC`. `cpZChain` (the same
OR-tree feeding `Z`, tapped *before* its own final `NOT`) is exactly
"the result is nonzero," i.e. "not found" — tied to its own anchor label
(`CPBLOCK_NOT_FOUND_NOW`) so the repeat gate, built earlier in the file
alongside `LDIR`/`LDDR`'s own, can read it forward the same way it
already reads `BLOCK_PV_NOW`. `CPBLOCK_REPEAT_NOW =
AND(cpRepeatVariantNow, BLOCK_PV_NOW, CPBLOCK_NOT_FOUND_NOW,
CPBLOCK_COMMIT_NOW)` — one more term than `LDBLOCK_REPEAT_NOW`, and a
second, independent final layer on `pc.d`'s own mux chain, right after
`LDIR`/`LDDR`'s own, reusing the identical `pcMinus2Adder`.

Verified with three dedicated tests: `z80cpu-cpi.test.ts` and
`z80cpu-cpd.test.ts` (each two back-to-back comparisons, deliberately
unlike each other — a genuine nibble-boundary borrow against a *higher*
byte first, proving `H` isn't just coincidentally `0` on the trivial
case, then a match against an *equal* byte with `BC` also reaching `0`
on that exact pass, proving `P/V` still tracks `BC` and not the
comparison's own overflow) and `z80cpu-cpir-cpdr.test.ts` (three cases:
`CPIR` finding its match on the second byte after one genuine repeat,
`CPIR` exhausting `BC` with neither byte ever matching — the *other* way
to stop — and `CPDR` walking downward to its own match) — before the
full suite: `45/45` files, `187/187` tests, still green.

### x=10, z=2: INI/IND/INIR/INDR

Real `0xED 0xA2`/`0xAA`/`0xB2`/`0xBA` — a third `ED`-table column, real
Z80's `(HL)<-IN(C)`: a byte read from this project's own invented I/O
port (see "x=11: IN A,(n) / OUT (n),A" below), addressed by `C` this
time (not the immediate byte `n` that opcode reads), written into
`(HL)`, then `HL+-1`, `B--` — never the `BC` pair, `C` keeps addressing
the same port every time `INIR`/`INDR` repeats. Collides with real
unprefixed `AND D`/`XOR D`/`OR D`/`CP D` (`z=2` — `D`, not `B`/`C` this
time), the identical "recaptured byte reads as a real opcode" shape the
other two `ED`-table families already establish. Real Z80 documents
exactly two flag bits for this whole family — `Z` (`B` reaching `0`) and
`N` (the transferred byte's own bit 7) — everything else (`S`/`H`/`P/V`/
`C`) is famously undocumented territory, only reverse-engineered decades
after the official manual shipped; left unmodeled here, the same
documented-simplification stance `LDI`'s own `X`/`Y` and `CPI`'s own
`X`/`Y` already establish, not a fresh one.

**A dedicated `B-1` adder, not the shared `BCADD` pair adder.** Real
`INI` only ever decrements `B` itself — `C` never changes, so the
16-bit `BCADD` pair adder this file already built for `DEC BC` (and
widened for the LD-block and CP-block families) is the wrong tool: it
computes a *pair's* `-1`, and `C`'s own half of that would need masking
right back out again. A standalone, permanently-wired `-1` (`op0=op1=0`,
`cin=0`, `b` fanned to all-`1`s — the identical "add `0xFF`, no carry-in"
convention `INC r`/`DEC r`'s own shared adder already uses for `DEC`)
sidesteps that entirely, the same "isolated adder, no shared-decode
collision to fight" shape `cpBlockAdder` above and `pcMinus2Adder`
elsewhere in this file already use.

**Two phases plumb the port through the same bus RAM's write already
needs, one phase apart.** `PHASE4` publishes `C` onto the bus — this
composite's own `ioPortAddr` is a live tap of exactly that bus, so this
*is* the port address becoming visible, the same moment `ioRead` widens
to strobe (a second OR term on `IN A,(n)`'s own `ioRead`, not a
replacement — a real device wired to that pin needs to know the CPU is
reading its port regardless of which opcode triggered it). RAM's own
`oe` is deliberately never widened for this phase — nothing needs RAM to
drive the bus here, and letting it try would fight `C`'s own tri-buf
bank for the same wire. `PHASE5` publishes `ioPortDataIn` (the external
device's own raw response — already stable the instant `ioRead` strobed,
no holding register needed at all, unlike `ldBlockTemp`'s own value:
this one never has to survive a phase it isn't itself driven on) back
onto the bus for RAM's own write, address forced to `HL` by one more
address-mux layer, the identical shape every earlier family's own write
address override already uses. `PHASE6` commits `HL+-1`/`B--`/flags.

**The repeat condition is the simplest of this file's three.** Real Z80
stops `INIR`/`INDR` purely when `B` reaches `0` — no "found it" concept
`CPIR`/`CPDR` also has to watch for — so `IOBLOCK_REPEAT_NOW =
AND(ioRepeatVariantNow, IOB_NONZERO_NOW, INBLOCK_COMMIT_NOW)`, two terms
instead of `CPBLOCK_REPEAT_NOW`'s three, gating a third and final layer
on `pc.d`'s own mux chain, right after `LDIR`/`LDDR`'s and `CPIR`/
`CPDR`'s own, reusing the identical `pcMinus2Adder` a third time.

Verified with three dedicated tests: `z80cpu-ini.test.ts` and
`z80cpu-ind.test.ts` (each two back-to-back transfers against a fixed
external device — `0xAB`, bit 7 deliberately set so `N` reading `1` is a
genuine assertion, not a coincidental default — so `B` genuinely reaches
`0` on the second, `Z` correctly rising to `1` exactly then) and
`z80cpu-inir-indr.test.ts` (`B` seeded to `2` so each
of `INIR`/`INDR` genuinely repeats once and then falls through) — before
the full suite: `48/48` files, `191/191` tests, still green.

Found live writing that last test: a byte-order mixup in the test itself
(`LD BC,0x0002` written as `[0x01, 0x02, 0x00]`, which is actually
`LD BC,0x0200` — Z80's own `nn` operands are low byte first, so the
*first* immediate byte becomes `C`, not `B`) produced `B` reading `0xFF`
after a single decrement instead of `1` — a real bug, but in the test's
own setup, not the wiring above; every register besides `B`/`C` had
already been exercised by dozens of earlier tests using the identical
convention correctly.

### x=10, z=3: OUTI/OUTD/OTIR/OTDR

Real `0xED 0xA3`/`0xAB`/`0xB3`/`0xBB` — the fourth and final `ED`-table
column this retrofit fills in, the exact mirror image of `INI`'s own
family: `OUT(C)<-(HL)`, a byte read from `(HL)` this time rather than
written to it, sent to this project's own invented I/O port addressed
by `C`, then `HL+-1`, `B--` (never `BC`, the identical reasoning `INI`'s
own family already established). Collides with real unprefixed `AND E`/
`XOR E`/`OR E`/`CP E` (`z=3` — `E`, not `D`/`B`/`C` this time). The same
two documented flag bits (`N` from the transferred byte's own bit 7,
`Z` from `B` reaching `0`) apply here too — `Z` off the identical shared
`IOB_NONZERO_NOW`/`IOB_Z_NOW` bits `INI`'s own family already built
(decrementing `B` is the same operation regardless of transfer
direction, so nothing new needed there), `N` off `outBlockTemp`'s own
held byte instead of `ioPortDataIn` (this family never reads that pin
at all).

**Two shared resources, each widened by exactly one term.** `C`'s own
bus-driver bank — previously enabled by `INI`'s own `INBLOCK_READ_NOW`
alone — widens to `OR(INBLOCK_READ_NOW, OUTBLOCK_WRITE_NOW)`: the same
port-address role, reached one phase later by this family (`PHASE5`
instead of `PHASE4`, since `PHASE4` here is spent reading `(HL)`
instead), mutually exclusive by `dec.z` the same way every other shared
resource in this file already relies on. `ioPortDataOut` — previously a
bare tap of `AOLD` (`OUT (n),A`'s own source, see "x=11: IN A,(n) / OUT
(n),A" below) — gets a mux layer ahead of it, picking `outBlockTemp`'s
own held byte instead whenever `OUTBLOCK_WRITE_NOW` fires: the same
"mux ahead of the existing source" shape every other competing writer
in this file already uses, `OUT (n),A` itself never asserting that
select line so its own behavior is untouched. `ioWrite` widens by the
identical single OR term `ioRead` already needed for `INI`'s own family.

**The read/write phase order is the true mirror of `INI`'s.** `INI`
reads its port address (`C`) at `PHASE4` and writes RAM at `PHASE5`;
`OUTI` reads RAM (`PHASE4`, into `outBlockTemp` — a holding register
`INI`'s own family never needed, since nothing here has to survive past
the phase it's read on the way `INI`'s port response does) and writes
its port address plus the held byte at `PHASE5`. RAM's own `oe` widens
for `OUTI`'s own `PHASE4` (the mirror image of `INI`'s family never
needing that widening at all, since `INI` never reads RAM), and RAM's
own address mux gets one more override layer for that same phase.

**The repeat condition is, once again, shared.** `OTIR`/`OTDR` stop
purely when `B` reaches `0`, the identical single-condition shape
`INIR`/`INDR` already establish — a fresh `outRepeatVariantNow`/
`OUTBLOCK_REPEAT_NOW` pair, gated by this family's own `y`/`z` decode,
but reading the exact same shared `IOB_NONZERO_NOW` bit, and landing on
a fourth and final layer of `pc.d`'s own mux chain, reusing
`pcMinus2Adder` a fourth time.

A small, honest correction made along the way: the two labels this
family's own repeat gate needed to read (`B`'s own nonzero bit aside)
had been named `IOBLOCK_REPEAT_VARIANT_NOW`/`IOBLOCK_REPEAT_NOW`/
`IOBLOCK_DEC_DIR_NOW` — generic-sounding, but actually built
specifically for `INI`'s own family alone, the identical trap
`LDBLOCK_PV_NOW` fell into before `CPI`'s own family needed the same
bit (see "x=10, z=1: CPI/CPD/CPIR/CPDR" above). Renamed to
`INBLOCK_REPEAT_VARIANT_NOW`/`INBLOCK_REPEAT_NOW`/`INBLOCK_DEC_DIR_NOW`
— matching the already-correctly-`IN`-prefixed phase labels right next
to them — before this family's own genuinely distinct
`OUTBLOCK_REPEAT_VARIANT_NOW`/`OUTBLOCK_REPEAT_NOW`/
`OUTBLOCK_DEC_DIR_NOW` were added alongside them, rather than let a
second misnomer accumulate on top of the first.

Verified with three dedicated tests: `z80cpu-outi.test.ts` and
`z80cpu-outd.test.ts` (each two back-to-back transfers, mirroring
`z80cpu-in-out.test.ts`'s own mid-instruction-checkpoint technique for
`ioWrite`/`ioPortAddr`/`ioPortDataOut` — genuinely necessary here too,
since none of the three persist past the phase they're valid on — with
two *different* transferred bytes, `0xAB` then `0x11`, so `N` reading
correctly on both proves it tracks *this* transfer, not a stale leftover
from the first) and `z80cpu-otir-otdr.test.ts` (`B` seeded to `2`,
the identical repeat-then-fall-through shape `z80cpu-inir-indr.test.ts`
already established) — before the full suite: `51/51` files, `195/195`
tests, still green.

This closes out the block I/O half of `ED`'s own table (`z=0` through
`z=3`, all four now real) — the same milestone the CB/ED/DD/FD prefix
mechanism's own doc comment named as the natural stopping point for
this retrofit's own block-instruction work.

### A decode gap found across all sixteen block-instruction gates — and fixed

Found live while designing `NEG`'s own decode (see "x=01, z=4: NEG"
below): every one of the sixteen block-instruction gates above
(`LDI`/`LDD`/`LDIR`/`LDDR`/`CPI`/`CPD`/`CPIR`/`CPDR`/`INI`/`IND`/
`INIR`/`INDR`/`OUTI`/`OUTD`/`OTIR`/`OTDR`) read only `isEdActive` plus
their own `y`/`z` bits — never `dec.x`. `isEdActive` alone says just
"the recaptured byte follows a real `0xED`"; it says nothing about that
byte's own `x` field, and `y`/`z` are independent of `x` by
construction (three separate bit groups of the same byte). Real `LDI`
is `x=10,y=4,z=0` — but `isLdiNow`'s own gate, reading only `y=4`/`z=0`,
would have *also* fired for a genuinely invalid `ED`-prefixed byte like
`0xED 0x20` (`x=00,y=4,z=0` — the unprefixed `JR NZ,e` encoding,
reinterpreted), executing `LDI` instead of correctly staying inert.
Real Z80 hardware documents this precisely: any `ED`-prefixed byte
outside the real, documented rows acts as two `NOP`s — this simulator
was silently violating that contract for the entire `0x00`-`0x3F` and
`0xC0`-`0xFF` ranges of the recaptured byte, undetected because no
existing test ever fed an invalid byte after `0xED`.

Fixed by building two shared qualifier gates right where `isEdActive`
itself is defined — `isEdX2Active = AND(isEdActive, dec.x[2])` (`x=10`,
what the sixteen block gates actually needed all along) and
`isEdX1Active = AND(isEdActive, dec.x[1])` (`x=01`, `NEG`'s own
family's requirement, designed correctly from the start this time) —
and repointing all sixteen gates from bare `isEdActive` to
`isEdX2Active`. `dec.x[2]` reads `1` for every real block-instruction
byte (`0xA0`-`0xBB`), so this changes nothing observable for any opcode
this project actually implements — confirmed by re-running all twelve
block-family test files (all sixteen instructions) plus `NEG`'s own
test together right after the fix, all still green, before the next
full-suite run below. This corrects behavior only for bytes no test
exercises, by definition — invalid opcodes this project never claimed
to execute correctly, now genuinely inert instead of accidentally
decoding as a real one.

### x=01, z=4: NEG

Real `0xED 0x44` — this retrofit's first non-block `ED`-table opcode:
`A<-0-A`, real two's-complement negation. Unlike every block family
above, nothing here is left stale or unmodeled — real Z80 documents
every flag bit for this instruction completely, so all eight get a
fresh value. Collides with real unprefixed `LD B,H` (`x=01` is the
entire `LD r,r'` table; `y=0` picks `B` as the destination, `z=4` picks
`H` as the source) — but unlike every earlier collision in this file,
`y` is deliberately *not* read at all: real hardware executes `NEG` for
*every* value of `y` in this column (`0xED 0x44`, `0x4C`, `0x54`, ...
all the way to `0x7C`), a real, well-documented "undocumented
duplicate" quirk, not a gap. `isNegNow` reads `isEdX1Active`/`dec.z[4]`
only, deliberately widening past `dec.y[0]` alone.

**A dedicated `0-A` adder**, the identical "isolated adder, no
shared-decode collision to fight" shape `cpBlockAdder`/`ioBAdder` above
already use — needed here because the shared `x=10` ALU's own `a` input
is hardwired to `A` itself (see "x=10: ADC/SBC" above) and can never be
forced to a constant `0`. `0-A` in two's complement is `~A+1`: `a`
fanned to `gnd`, `b` inverted per bit, `cin` forced to `1`, the
identical recipe the shared ALU's own `SUB` path already uses, just
with a genuine `0` for the left operand instead of a register. `S`/`Z`
read straight off this adder's own output the usual way; `H` is the
identical `NOT(carries[3])` half-borrow idiom `cpBlockAdder`'s own
`cpHBit` already establishes; `P/V` is the identical `XOR(carries[6],
carries[7])` overflow idiom the shared ALU's own `pvOverflow` already
establishes — real Z80 sets it for `NEG` on exactly one input, `0x80`,
the one byte whose negation doesn't fit back into a signed byte; `N` is
a hardwired `1`; `C` is a fresh 8-way OR-tree over `A`'s own *current*
bits (nonzero `A` always borrows on negation, `A=0` never does) — the
same "any bit set" idiom this file's own nonzero checks already use
elsewhere, just over `A` instead of `BC` or `B`. `X`/`Y` mirror the
result's own bits 3/5, the same documented, not-unmodeled treatment the
`x=10` ALU group's own `X`/`Y` already get.

`A`'s own write mux and `F`'s own per-bit chain each get one more
layer, gated by `NEG_NOW` — a single `PHASE4` commit (the first
available phase for any `ED`-prefixed opcode, `PHASE2`/`PHASE3` already
spent recapturing `ir` and advancing `pc`), no holding register or
multi-phase sequencing needed at all, since every part of this
instruction is combinational off `A`'s own already-stable value.

Verified with a dedicated test (`z80cpu-neg.test.ts`) exercising three
deliberately different cases in sequence: `0x01` (the ordinary path — a
real half-borrow, `S`/`C` set, `P/V` clear), `0x80` (the one value
whose negation doesn't fit back into a signed byte — `A` unchanged,
`P/V` set, proving overflow isn't just copied blindly from the
arithmetic group's own formula), and `0x00` (no borrow at all — `Z`
set, `C` clear) — before the full suite: `52/52` files, `196/196`
tests, still green.

### x=01, z=2: ADC HL,rr/SBC HL,rr

Real `0xED 0x4A`/`0x5A`/`0x6A`/`0x7A` (`ADC HL,BC`/`DE`/`HL`/`SP`) and
`0xED 0x42`/`0x52`/`0x62`/`0x72` (the same four pairs, `SBC`) — `y`'s
own parity picks the op (odd `ADC`, even `SBC`), `y>>1` picks the pair.
Collides with real unprefixed `LD y,D` for every destination `y` picks
(`x=01` is the entire `LD r,r'` table, `z=2` picks `D` as the source).

**Reuses `ADD HL,rr`'s own shared 16-bit adder rather than building a
second one.** `isAddHlYValid` (built for plain `ADD HL,rr`, "is `y`
odd") turns out to be exactly `SBC`'s own complement, so `isAdcHlNow`/
`isSbcHlNow` are built from it directly, no fresh parity check needed.
The pair-select is genuinely different, though: `ADD HL,rr`'s own `y`
is always odd, one exact value per pair; `ADC`/`SBC HL,rr`'s own pair
comes from `y>>1`, two `y` values per pair — so each of the four gets
its own fresh 2-way `y`-fold (`isAdcSbcHlBcNow`, etc.), OR'd into
`addHlPairs`'s own per-pair `y` line rather than replacing it, the
identical "widen, don't replace" shape every earlier register-select
widening in this file already uses.

**`cin` and the operand invert are the identical `ADC`/`SBC` recipe
"x=10: ADC/SBC" above already establishes**, just applied to this
16-bit adder instead of the 8-bit one: `0` for plain `ADD HL,rr`, the
old `C` for `ADC HL,rr`, the old `C` inverted for `SBC HL,rr`; `b`
inverted per bit only for `SBC`. Real `ADD HL,rr` itself is untouched —
its own `cin`/`b` paths simply see both `isAdcHlNow` and `isSbcHlNow`
read `0` and behave exactly as before.

**Every flag bit is real here, unlike plain `ADD HL,rr`'s own C-only
treatment.** `S`/`Z` read straight off the same 16-bit result; `H` is
the identical half-carry/half-borrow idiom this file's 8-bit groups
already use, just at the 16-bit nibble boundary (`carries[11]`, not
`carries[3]`); `P/V` is the identical `XOR(carries[14], carries[15])`
overflow idiom, at the 16-bit sign bit instead of the 8-bit one; `N` is
`isSbcHlNow` directly; `C` is `XOR(cout, isSbcHlNow)`, the same
borrow-inverted convention `cBit` already establishes. `X`/`Y` mirror
the high byte's own bits 3/5 (bits 11/13 of the full 16-bit result) —
real, documented behavior for this instruction, not unmodeled, the same
stance `NEG`'s own `X`/`Y` just above already take.

Verified with five dedicated tests: an ordinary `ADC HL,BC` with no
flags set at all, a real signed overflow on `ADC` (`0x7FFF+1`), the
identical overflow the other way on `SBC` (`0x8000-1`), a real borrow
with a real starting carry (`0-0-1`, via a genuine `SCF` first — `F` has
no external seed hook), and `ADC HL,HL` with a starting carry — the one
pair whose own low/high halves are the identical registers being read
twice at once, genuinely wrapping past `0xFFFF` back to `1` with a real
carry out — before the full suite: `53/53` files, `201/201` tests,
still green.

### x=01, z=7, y=4/y=5: RRD/RLD

Real `0xED 0x67`/`0x6F` — a 12-bit BCD nibble rotate spanning `A`'s own
low nibble and both of `(HL)`'s, real Z80's own way to shift a packed-BCD
digit string one position without touching every byte's own high nibble.
Collides with real unprefixed `LD y,A` (`x=01`, `z=7` picks `A` as the
source) for every destination `y` picks.

**Three phases**, the identical shape `LDI`'s own family uses:
`PHASE4` reads `(HL)` into a holding register, `PHASE5` writes the
freshly rotated byte back to that *same* address (unlike `LDI`'s own
family, read and write share one address here, so both phases reuse a
single address-mux layer rather than needing two), `PHASE6` commits
`A`'s own low nibble and every flag bit but `C`. The rotate itself is a
per-nibble-position mux with `isRldNow` as the select — the two are
mutually exclusive by construction (`y=4` vs `y=5`), and `RRD`'s own
wiring is exactly "not `RLD`'s."

**`A`'s high nibble needs an explicit hold layer.** `A`'s own `we`
commits the whole byte in one edge, so leaving no layer at all for
`i>=4` doesn't hold anything by itself — it falls through to whatever
the shared ALU's own live, unrelated computation is carrying at the
bottom of the write-mux chain. Found live chasing this instruction's
own repro; every earlier feature that touched a subset of `A`'s bits
happened to touch *all eight*, so this exact gap never showed itself
before. Flags: `S`/`Z`/`P` (parity, not overflow) off the *new* `A`,
`H`/`N` forced to `0`, `C` untouched, `X`/`Y` mirroring the new result's
own bits 3/5.

Verified with three dedicated tests (`z80cpu-rrd-rld.test.ts`): `RRD`
and `RLD` on `A=0x3A`/`(HL)=0x12` (three genuinely distinct nibbles, so
a mixed-up rotate direction lands on a wrong digit in a specific place),
plus `RRD` on all-zeros proving `Z`/`P` — before the full suite.

### x=01, z=3: LD (nn),dd / LD dd,(nn)

Real `0xED 0x43`/`0x53`/`0x63`/`0x73` (`LD (nn),BC`/`DE`/`HL`/`SP`) and
`0x4B`/`0x5B`/`0x6B`/`0x7B` (the load direction). Collides with real
unprefixed `LD y,E` (`z=3` picks `E` as the source). `y` even = store,
`y` odd = load; `y>>1` picks the pair.

**Phase budget after the ED prefix is tight.** Unprefixed `LD (nn),HL`
needs six phases (read-low/adv/read-high/adv/write-low/write-high), and
only `PHASE4`-`PHASE7` remain once the prefix has consumed `PHASE0`-`3`.
Solved by collapsing the two immediate-byte advances into a `PC+1`
address override on the high-byte read — no separate advance between the
two reads:

- `PHASE4`: read nn low at `PC` → `nnAddr`
- `PHASE5`: read nn high at `PC+1` → `nnAddr`; advance `PC` once
- `PHASE6`: advance `PC` past the instruction; data low (store or load)
- `PHASE7`: data high

`pcPlusOne` is a light `addrBits`-wide XOR/AND ripple (+1), published onto
the address-mux chain as one more override layer after RRD/RLD's.
`nnAddr`'s own hold-vs-fresh muxes widen to accept either the unprefixed
or the ED immediate-read strobes. Register write-back reuses the existing
bus-capture `ldWe` OR-chain (one more term per `B`/`C`/`D`/`E`/`H`/`L`);
`SP` gets another hold-vs-fresh layer stacked on `LD SP,nn`/`LD SP,HL`.

**`ramOe`/`ramWe` path depth matters.** The first wiring of EDNN's four
read strobes (and two write strobes) as sequential `OR`s *after*
`RRDRLD_*_NOW` delayed RRD's own OE/WE by two or more NOR+NOT pairs —
enough that the PHASE4 bus fight on RRD's read window cascaded into
VCC/GND contention and froze the ring counter at `PHASE4` forever.
Fix: side-fold the EDNN terms into their own OR-tree, merge once *before*
RRD, and keep RRD as the final term so its path depth matches the
pre-EDNN shape. Same lesson as the existing `groupActive`-gated FETCH
OE comment, applied to OR-chain length rather than phase-bit races.

Verified with one dedicated round-trip test (`z80cpu-ld-nn-dd.test.ts`)
covering all four pairs store-then-reload through distinct absolute
addresses, plus the RRD/RLD suite still green after the OE/WE fold —
before the full suite.

### x=01, z=0/z=1: IN r,(C) / OUT (C),r

Real `0xED 0x40`/`0x48`/…/`0x78` (`IN B,(C)` … `IN A,(C)`) and
`0x41`/`0x49`/…/`0x79` (`OUT (C),B` … `OUT (C),A`). Collides with
unprefixed `LD r,B`/`LD r,C` (`z=0`/`z=1`). `y` picks the register; `y=6`
is real Z80's undocumented `IN 0,(C)` / `OUT 0,(C)` — flags + strobe
still fire, but IN writes no register and OUT drives a literal `0`.

**Single `PHASE4` after the ED prefix** (same budget `NEG` uses): `C`
onto the bus for `ioPortAddr`, `ioRead`/`ioWrite`, and — for IN — commit
the external `ioPortDataIn` byte into the destination (and `F`). Address
and data ride different nets (`BUS` vs raw `ioPortDataIn` /
`ioPortDataOut`), the identical dual-path shape `IN A,(n)` already
established at `PHASE2`.

IN flags: every bit but `C`, off the port byte — `S`/`Z`/`P`(parity)/
`H=0`/`N=0`/`X`/`Y` mirroring bits 3/5 — same recipe RRD/RLD uses off
the new `A`. Register write-back reuses the B–L bus-capture `ldWe` chain
(one more term + a mux that picks `ioPortDataIn` over `BUS` when that
term fires); `A` gets another layer on its write-mux stack. OUT extends
`ioPortDataOut`'s existing OUTI mux with one more layer gated by
`OUTRC_NOW`, fed by per-`y` tribufs (or GND for `y=6`). `C`-onto-bus
side-folds `INRC_NOW|OUTRC_NOW` before merging with INI/OUTI, so the
enable chain does not grow two sequential stages.

Verified with one dedicated mid-PHASE4 test
(`z80cpu-in-rc-out-rc.test.ts`): `IN A,(C)` / `OUT (C),B` / `OUT (C),0` /
`IN 0,(C)` / `IN B,(C)` against a fixed `0x99` device reply — before the
full suite.

### x=01, z=7, y=0..3: LD I,A / LD R,A / LD A,I / LD A,R

Real `0xED 0x47`/`0x4F`/`0x57`/`0x5F`. Collides with unprefixed `LD y,A`
(`z=7`) the same way `RRD`/`RLD` (y=4/5) does. Two new seed-path
registers (`I`, `R`) sit alongside `A'`/`F'`. Unlike the shadow
registers they have **no external seed path** — their write-enable seed
pin is tied to GND so pre-existing tests cannot leave it floating;
software writes them only via `LD I,A` / `LD R,A`.

**Single `PHASE4` after the ED prefix:** `LD I,A`/`LD R,A` commit `A`
into `I`/`R` via `wrapWithPairCommit` (no flags). `LD A,I`/`LD A,R`
commit into `A` and refresh every flag bit but `C` — `S`/`Z`/`X`/`Y` off
the transferred byte, `H`/`N` forced 0, **`P/V←IFF2`** (soft↔gate parity;
verified in `z80cpu-ld-i-r.test.ts`). Soft and gate both auto-increment `R`
on each M1/`fetch` (bit7 sticky — `bumpR` / `RINC_NOW`).

Verified with `z80cpu-ld-i-r.test.ts` — before the full suite.

### Thin IM1 IRQ / NMI / IM modes

Maskable interrupt support plus NMI/`RETN`, with **IM 0**, **IM 1**, and
**IM 2** accept on both soft and gate.

**State.** `IFF1`/`IFF2`, `IM0`/`IM1`/`IM2` latches (q-only, like `I`/`R` —
no external seed; setting one mode clears the others on `PHASE4`). External
INT / NMI are internal `Input`s defaulting to 0 (`cpu.intDrive` /
`cpu.nmiDrive`). INTACK data bus is eight Inputs defaulting to 1
(`cpu.irqBusDrive` → `0xFF`).

**`EI`/`DI`** (`0xFB`/`0xF3`, `x=11 z=3 y=7/6`): `DI` clears both IFFs on
`PHASE2`. Soft-parity **EI delay**: `EI` arms a pending latch; IFF1/IFF2
set on `PHASE2` of the *following* instruction (`EI_COMMIT`), so INT cannot
interrupt that following instruction.

**`IM 0/1/2`** (`ED 0x46`/`0x56`/`0x5E` and soft aliases): `PHASE4` sets the
matching latch and clears the other two.

**INT accept.** At `PHASE0`, if `IFF1 ∧ (IM0∨IM1∨IM2) ∧ INT` (and no NMI edge),
clear both IFFs and suppress `PHASE1` PC advance. Mode split:
- **IM0/IM1** (`im01Accept`): force IR from the bus sample — IM1 → `0xFF`
  (RST 38h), IM0 → `irqBusDrive`; latch `intServing` for the injected opcode.
- **IM2** (`im2Accept`): force IR←NOP, latch `im2Serving`; `PHASE2` pushes
  PC (same stack write + PC→bus bank as NMI), `PHASE3` reads ISR lo from
  RAM at `(I<<8)|irqBus` (truncated to `addrBits`) into PC, `PHASE4` reads
  ISR hi at `vec+1` into PC bits `8+` when `addrBits>8`. Soft:
  `softAcceptIrq` IM2 (push then word-at-vector).

**NMI accept.** Rising edge on `nmi` at `PHASE0`: clear IFF1 only (keep
IFF2), clear HALT, force IR←NOP, latch `nmiServing`, push PC on `PHASE2`,
jump `$0066` on `PHASE3`. Soft: `softNmi`.

**`RETI`/`RETN`** (`ED 0x4D` / `0x45`): same stack-pop/PC-capture as `RET`,
plus `IFF1←IFF2` on `PHASE4`. Soft `RETI` is unchanged (Spectrum); soft
`RETN` restores IFF1←IFF2. Soft's `(op&0xc7)===0x45` RETN check also
matches RETI encodings first — leave as-is.

Verified with `z80cpu-irq-im1.test.ts`, `z80cpu-irq-im0.test.ts` (includes
gate IM2), `z80cpu-nmi-retn.test.ts`, `z80cpu-bus-pins.test.ts`. Soft↔gate EI
delay and HALT latch parity: `soft-gate-ei-halt.test.ts`. INTACK = PHASE0
acknowledge sample (`INTACK_NOW` / irqBus + one R bump) + PHASE1 wait hold
(`INTACK_WAIT` / `intAckServing`; soft burns 4 wait units via
`hooks.intAckWaits` — nested 4-T Soft↔gate parity) with bus pins `IORQ∧M1`.
A free-running `busCycle` (T0–T3) + `busBusy` pin track IORQ windows;
instruction ring stays at 10 (full ring-hold while busy needs one-shot WE).
imm I/O nests strobes across PHASE2+PHASE3. NMI does not bump R (soft
`softNmi` parity).

### Spectrum Gates (mirrored RAM)

Spectrum in Gates mode is **gate CPU + mirrored flat RAM + soft ULA** for
video and IRQ — not FET Spectrum video. On entering Gates / gate boot /
each gate Spectrum step budget, `SpectrumMmu.mirrorToFlatRam` copies ROM
`$0000–$3FFF` and `syncVisibleRam` for `$4000–$FFFF` into `cpu.ram.bytes`.
After gate steps, display-file bytes (`$4000–$5AFF`) write back into the
MMU so soft ULA can refresh. Full FET Spectrum video remains out of scope.

### CB x=01: BIT y,r / BIT y,(HL)

CB-table `BIT` column. Real `0xCB 0x40`–`0xCB 0x7F`. Prefix mechanism
already spent `PHASE2`/`PHASE3` recapturing `ir` and advancing `pc`.
`isCbActive` is labeled (alongside `isEdActive`);
`isCbX1Active = AND(isCbActive, dec.x[1])` gates this column.

**Register form (`z≠6`):** flags-only on a single `PHASE4`.

**(HL) form (`z=6`):** `PHASE4` reads `(HL)` into the shared `hlMemTemp`
(OR'd with `INC`/`DEC (HL)`'s own read — mutually exclusive by prefix);
`PHASE5` commits flags. `ram.oe` and `addr=HL` side-fold the read
strobes so the OE chain does not grow sequential stages.

**Flags (both forms):** `Z` ← tested bit is 0; `H=1`; `N=0`; `C` held;
`P/V` mirrors `Z`; `S` only when testing bit 7 and it is set; `X`/`Y`
mirror the source byte's bits 3/5. For `(HL)`, real Z80 takes `X`/`Y`
from internal `WZ` — this project uses the memory byte instead
(documented simplification). Neither form writes a register or RAM.

Verified with `z80cpu-bit.test.ts` — before the full suite.

### CB x=10/x=11: RES y,r / SET y,r

Clear or set one bit. Real `0xCB 0x80`–`0xCB 0xFF`. No flags.
`isCbX2Active`/`isCbX3Active` gate RES/SET; shared result byte
`SETRESRESULT{i}` forces 1 (SET) or 0 (RES) on `y`'s bit and passes the
other bits through from the z-selected register or `HLMEM`.

**Register form (`z≠6`):** single `PHASE4` commit into B/C/D/E/H/L/A.

**(HL) form (`z=6`):** `PHASE4` read into shared `hlMemTemp` (side-folded
with `BIT`/`INC`/`DEC (HL)` reads); `PHASE5` writes `SETRESRESULT` back
(side-folded with `INC`/`DEC (HL)` writes on `ram.we`/`addr=HL`).

Side-fold discipline: when extending a two-input OR that already held two
label terms, keep both on that first OR's `a`/`b` and add a *second* OR
for the new term. Leaving an OR input dangling floats it high in this
solver — found live while adding SET/RES: `addr` stuck on `HL` so every
`LD r,n` captured `RAM[0]` (the opcode) instead of the immediate.

Verified with `z80cpu-set-res.test.ts` — before the full suite.

### CB x=00: RLC/RRC/RL/RR/SLA/SRA/SLL/SRL

CB rotate/shift column. Real `0xCB 0x00`–`0xCB 0x3F`. Unlike unprefixed
`RLCA`/`RRCA`/`RLA`/`RRA` (which hold `S`/`Z`/`P`), these refresh
`S`/`Z`/`H=0`/`P/V`(parity)/`N=0`/`C`/`X`/`Y` from the **result**.
`SLL`/`SL1` (`y=6`) is the undocumented shift that forces new bit0 to 1.

**Register form (`z≠6`):** `PHASE4` commit into B/C/D/E/H/L/A.

**(HL) form (`z=6`):** `PHASE4` read into dedicated `cbRotHold` (not
shared `hlMemTemp` — see below); `PHASE5` write + flags. OE/addr/we
side-folds with BIT/SET/RES/(HL) RMW.

**Datapath:** two deep rotate trees (register vs HL), muxed by `z[6]`.
The HL tree's source is `mux(WRITE, 0, AND(cbRotHold.q, WRITE))` — found
live: feeding a live-`we` register (or even a WRITE-gated bit that still
fans into the deep cone) during the READ phase freezes the phase ring;
isolating the deep cone onto grounded constants until WRITE drops `we`
keeps the ring moving. Register form never hits this (source is
`bitRegByte`, not being written).

Verified with `z80cpu-cb-rot.test.ts` — before the full suite.

### Solver hot-path rewrite: indexed nets

`step()` used to pay a `Map<string, …>` tax on every net, every
transistor pin, every relaxation pass — on the live `buildZ80Cpu`
composite (~67k transistors, ~34k nets) that was ~670ms per tick, which
is why a single `buildZ80Cpu` test file routinely took minutes. The
rewrite indexes nets once per `step()` into dense parallel arrays
(levels, driver bitmasks, `Int32Array` union-find with intrusive group
lists); transistor pin→net lookups happen once up front, not once per
pass. Same semantics (majority-vote capacitive hold, unconditional `Z`
on conflict, oscillation window on the fallback path only) — measured
~6× faster on the same composite (~111ms/tick), which is what made
adding `RRD`/`RLD` and continuing the suite tractable again. A follow-up
WeakMap caches that index + scratch buffers across ticks when the
structure version and `netMap` identity match (only Input values change),
and — when the caller threads the previous `SimState` straight back in —
seeds `cur[]` from a retained dense copy instead of ~34k `Map.get`s;
together those cut another ~2× (~54ms/tick on `scripts/profile-z80.ts`).
A shared `test/z80Harness.ts` also factors the repeated seed/clock/FSM
boilerplate every `buildZ80Cpu` file had been copy-pasting.

### A real solver bug this retrofit exposed — and the test that un-broke itself

Adding the prefix mechanism above didn't just add inert wiring — it
resized every other component's set of net IDs and pins ever so slightly
(new gates, a new 4-bit register, all sharing the existing `Circuit`).
That was enough to flip a decade-old, entirely latent bug in
`solver.ts`'s own floating-group fallback (see its own doc comment) from
never-observed to reliably reproducing on one specific test:
`EX (SP),HL`'s *second* execution in `z80cpu-ex-sphl.test.ts` — same
opcode, same decode, only the data on the bus (`H`/`L`/`RAM[0x60..61]`)
different from the first execution — corrupted `ir` and the phase ring
counter into simultaneous, un-recoverable `Z` (floating), never settling
even after 300 relaxation iterations.

**The actual bug**: `value = levelOf.get(members[0]) ?? 'Z'` — when a
union-find group has no forced driver, this is supposed to model
capacitive hold, but `members[0]` is whatever order `Set` iteration
happens to yield, not necessarily a member with any real history. A
transistor that starts conducting for the first time can merge a net
that's always been its own floating, always-driven-nowhere island with a
*different* net that has real remembered history from being driven every
tick until now — an arbitrary pick can flood the live net's history with
the island's stale `Z`. This had presumably been happening, harmlessly,
on some genuinely-don't-care net somewhere in this file since long before
this retrofit; the retrofit's own component-count shift just happened to
make it land, for the first time, on a net that mattered.

**The fix, after three wrong ones** (each one caught by running the
*entire* suite, not just the one failing test, before trusting it):

1. *Majority vote among every member's remembered non-`Z` value*, applied
   uniformly to both "nothing forces this group" and "two drivers
   conflict" — fixed `EX (SP),HL`, but a real, persistent electrical
   conflict (this file's own stub-ROM decoder, one specific address)
   turned into a genuine, never-settling oscillation, because a vote can
   answer a conflict with a *concrete* value instead of `Z`, and that
   concrete value re-drives the exact transistors that recreate the same
   conflict next pass — nothing ever breaks the loop the way an immediate
   `Z` naturally does.
2. Added *oscillation detection* (a trailing-window transition count per
   net; a net that changes value too many times in too few passes gets
   excluded from every future vote) to let the vote rescue transient
   conflicts while still cutting off a genuine, repeating short. Fixed
   the decoder oscillation — but exposed a second, structurally different
   failure: `ram.test.ts`'s own write-capture test deliberately drives a
   *fixed*, never-changing `0xFF` onto the data bus from a test-harness
   input, relying on the original solver's "any conflict is instantly
   `Z`" behavior (`Z` reads as `0` through `fromBits`, and ANDing with
   all-1s is the identity — a real short against an all-ones driver
   reconstructs the *other* driver's own byte exactly, bit for bit). This
   conflict never oscillates — the vote's answer is stable, just wrong,
   because a long-held external value's *history* outvotes RAM's own
   fresh, correct value the instant real contention starts. No amount of
   oscillation-window tuning fixes a conflict that never repeats.
3. *(Also a real, if smaller, lesson.)* The very first version of the
   oscillation bookkeeping ran unconditionally for every net, every
   relaxation pass, not just the ones actually landing in the fallback —
   turning `178` tests that used to run in well under a minute into a
   suite measured in *hours* (`z80cpu-x11-stack.test.ts` alone took
   `17`+ minutes). Scoping the bookkeeping to the fallback branch only
   brought individual heavy tests back down to `2`–`10` minutes each —
   still real overhead from the vote itself, absorbed by running the
   suite's 39 files across parallel workers rather than eliminated.

**Where this landed**: `forced.size > 1` (a genuine conflict) goes back
to the original, unconditional `Z` — no vote, no history, ever, the same
one-line answer this fallback always gave, because three different tests
across this suite (the decoder, `ram.test.ts`, and by extension anything
else relying on that exact idiom) depend on it staying that way.
`forced.size === 0` (nothing forces this group — true capacitive hold,
no electrical conflict exists at all) keeps the majority vote and the
oscillation guard, since neither of the regressions above ever involved
a genuinely unforced group.

**A postscript, found the same day**: `EX (SP),HL`'s second execution —
diagnosed above as a genuine, transient forced-driver conflict on the RAM
address bus, a real circuit-level race no vote-based solver fix alone
could rescue — was marked `it.fails` on exactly that reasoning. Adding
`LDI` right after (see "x=10, z=0: LDI/LDD/LDIR/LDDR" above) shifted this same
file's own component/net ordering again, the identical mechanism that
made this race reproducible in the first place — and it stopped
reproducing. `it.fails` did its actual job here: the next full-suite run
failed *it*, with `Error: Expect test to fail`, exactly the signal
built in for "the underlying bug is gone, flip this back." Confirmed
stable across two independent isolated re-runs (not a one-off settle),
so the test is a plain `it` again. Address-bus race mitigated by mutual
exclusion of EXSPHL LOW/HIGH selects plus held SP+1 for the opcode window
(`oldLTemp`/`oldHTemp` unchanged). Still monitor — do not declare solved
forever if a future wiring change reopens a transient double-drive.

### Net labels, not wire spaghetti

`buildZ80Cpu`'s own wiring is now dense enough (100+ internal `wire()`
calls, several signals with genuine multi-destination fanout — `CLK` to 11
registers, the shared operand bus, both decoder outputs, all 4 `EXEC`
phase bits, `SP`'s own value) that drawing every one of them as a literal
point-to-point line made the canvas unreadable rather than merely dense.
`Circuit`'s `label` primitive already existed for this — `LabelComponent`
(`types.ts`), `computeNets()`'s "same-named label" tie (`Circuit.ts`,
identical to how `VCC`/`GND` already tie without a drawn wire), and a
`label` toolbar tool (`Editor.ts`/`Renderer.ts`) — but no composite in this
codebase had ever actually *used* it: every one, `buildZ80Cpu` included,
wired everything with plain `wire()` calls regardless of distance. A local
`tieToLabel(name, pin, pos)` helper inside `buildZ80Cpu` (`wire()` a pin to
a fresh `makeLabel()` at a *nearby* position) replaces the worst offenders:
`CLK` (11-way), the operand bus `BUS0`-`BUS7` (9+ touch points per bit),
the far half of the decoder's `y` lines used in the ALU/flags section
(`DECY0/2/4/5/6/7`), every `EXEC`/`FETCH`/`INCREMENT` phase bit
(`PHASE0`-`PHASE3`, 13 far consumers), `SP`'s own value and the
`STACK_WRITE_NOW`/`READ_NOW` conditions gating the address mux, `IR`'s
`y`-field bits feeding `RST`'s target, and — the largest single class,
found only by counting rather than eyeballing a screenshot (below) — every
register's own `q` output feeding the operand-bus and push-byte tri-state
banks' *inputs* (`REGB0-7` through `REGL0-7`, `REGA0-7`, `REGF0-7`,
`REGPC0-5`), not just their *outputs* onto the bus.

A caught-live mistake, worth recording since the failure mode is subtle:
the first pass tied every *consumer* of the operand bus to a `BUS0`-`BUS7`
label but never tied `ir.d` itself (the bus's real, RAM-driven net) to
those same labels — creating two electrically separate networks that
happened to share a naming scheme. Every FETCH still worked (RAM wires
straight to `ir.d` regardless), but every *other* reader of the bus (the
ALU, `LD` destinations, `POP` targets, `RET`'s own capture) read whatever
the label group last held from an *earlier* write through the label path,
not RAM's live value — a register capturing a stale value from a previous
instruction instead of the current one. All 3 `buildZ80Cpu` tests failed
immediately, with symptoms that looked like decode bugs (wrong register
ending up with another register's value) until tracing back showed the
disconnected-island shape. Fixed by tying `ir.d` itself to `BUS0`-`BUS7`
right where RAM's own FETCH wire is made, anchoring the label group to a
real net instead of leaving it floating on its own.

**A second pass fixed the actual majority case.** Counting the flattened
circuit's wires found *773* of *883* long (>2000-unit) wires touched a
`source` component — `VCC`/`GND` fan-out, not signal wiring. Every
`buildAnd`/`buildOr`/`buildNot`/`buildXor` call in `library.ts` used to take
concrete `vcc`/`gnd` *pins* from whichever `Source` pair the caller handed
it and wire straight to them, regardless of distance — and `buildZ80Cpu`
handed every single one of its 100+ gate calls the *same* one global pair,
declared once at `pos.x-200`, for a composite spanning `pos.x-400` to
`pos.x+11300`.

An intermediate fix parked extra local `Source(1)`/`Source(0)` pairs beside
distant gate clusters (`vcc2`/`gnd2` … `vcc5`/`gnd5`) so power wires stayed
short within each cluster. That worked because `VCC`/`GND` are already
named-tied nets (`Circuit.computeNets()`'s `GLOBAL_NET_NAMES`): every
`source` with `value=1` joins `VCC` and every `value=0` joins `GND`, with
no wire between Sources required — the same mechanism same-named `label`s
use.

**Current approach (rail labels).** Gate power no longer draws to those
Source pins at all. `buildNot`/`buildNand`/`buildNor`/`buildTriStateBuffer`
call `tiePowerRail(circuit, 'VCC'|'GND', pin)`, which drops a local
`Label("VCC"|"GND")` next to the transistor and stubs a short wire —
`computeNets()` joins that label to the global rail the same way Sources
do. Constant signal ties (mux in1 = 0, ALU cin = 1, immediate high bits,
etc.) use the same helper, or `railPin()` when a `Pin` value is needed
before wiring. `buildZ80Cpu` keeps a single Source pair to *drive* the
rails; the old cluster aliases remain only so existing `buildAnd(parent,
vccN, gndN, …)` call sites still type-check (the pins are unused for
power). Dive-in shows many tiny VCC/GND labels instead of long power
spaghetti — intentional.

Measured effect of the cluster-Source pass (unflattened top-level wires,
`buildZ80Cpu` alone): 883 long wires before, *319* after. Rail labels
remove the remaining cross-canvas power legs that clusters could not
reach.

This is now inherited by every composite that goes through `library.ts`
gate builders, not only `buildZ80Cpu`. Remaining `vcc`/`gnd` parameters on
those builders are unused for power; cleaning the signatures is separate
cosmetic work.

Two real risks worth flagging about this mechanism generally, not specific
to what actually went wrong above: label names are matched by their bare
string (`Circuit.ts`'s `label:${name}` key), and `flatten()` namespaces a
cloned component's *id* per chip-instance but never touches a label's own
`name` field (`hierarchy.ts`) — so reusing a label name *inside* a chip
def instantiated more than once (e.g. inside `REG_BIT`, folded and placed
8 times by `buildRegister`) would wrongly tie every instance's net
together, and two `buildZ80Cpu`s placed in the same project reusing these
same names would collide with each other the same way. Neither applies
here — `buildZ80Cpu` is called once per placement, not folded into a
multiply-instantiated chip def — and `VCC`/`GND` are *deliberately* global
rails, so colliding them across instances is the intended join. Other
signal labels still need unique names per instance if two CPUs share a
canvas.

### UI

`+ Z80CPU` mirrors `+ CPU`: prompts for RAM address-bit width, then program
bytes (`promptZ80ProgramBytes`, defaulted to the same `80,91,a0,a9,b6,87` —
`ADD A,B`/`SUB C`/`AND B`/`XOR C`/`OR (HL)`/`ADD A,A` — the `x=10` test
already verifies; real `LD r,r'` bytes `0x40`-`0x7F` and `x=11`'s
`PUSH`/`POP`/`RET`/`RST n` bytes work too, `0x76` excepted), and places the
wired-together composite at the current view's center. Unlike `+ CPU`, it
leaves noticeably more for the user to wire by hand afterwards:
`B`/`C`/`D`/`E`/`H`/`L`/`SP` all need an *initial* seed wired the same
"place an Input, wire it to the bare sink pin" way `+ CPU` already requires
(their own `d`/`we` — see "x=01: LD r,r'" and "x=11" above for why those
pins are no longer the raw `buildRegister` output) — plus `CLK`/`PHASE_CLK`/
`RESET`/`A_RESET`/the FSM's seed pattern (now 4 bits wide, not 3 — the
4-phase FSM), just as before. `refreshChipPalette()` after placing it, same
as every other composite button — it doesn't fold into the palette itself
(nothing here does), just needs the palette re-drawn in case the placement
pulled in a newly-cached chip def (`MUX2`, `TRI_BUF`, `ALU_SLICE`, ...).

### In-app dialogs, not `window.prompt()`/`alert()`/`confirm()`

Every text prompt, confirmation, and error message in this UI — chip
naming, bit-width prompts, ROM/RAM/CPU program bytes, project/chip import
confirmations and error alerts, net/port renaming — went through the
browser's own native `window.prompt`/`alert`/`confirm` from the first
version of this project through the `x=11`/labels work. Two real problems
with that, not just a cosmetic one: these calls are *synchronous* and
block the page's entire event loop until a human physically clicks the
native box — fatal for anything driving the tab programmatically (this
project's own live-browser verification tooling included, since a script
has no way to click a dialog the browser renders outside the DOM); and
visually, a plain OS-chrome box dropped on top of a deliberately styled
dark canvas never looked like part of the app.

`src/ui/Dialog.ts` replaces all 14 call sites (`main.ts` and `Editor.ts`'s
own `label` tool) with `showPrompt`/`showConfirm`/`showAlert` — real DOM
(`position: fixed` overlay + panel, styled off the same CSS custom
properties `index.html`'s own toolbar/buttons already use, injected once
via a lazily-created `<style>` tag rather than a stylesheet `main.ts` would
need to remember to link), so it's just another clickable element the page
(and anything driving the page) can see. Each function returns a Promise
instead of blocking — `await showPrompt(...)` in place of
`window.prompt(...)`, same `null`-for-cancel contract, so most call sites
changed only by adding `async`/`await`, not by restructuring. Escape
resolves to the cancel value and Enter submits the primary button
everywhere, matching what the native dialogs already did; there's no
click-outside-to-dismiss, also matching native dialogs, so a stray canvas
click behind an open modal can't discard it by accident.

One call site couldn't take the direct `await`: `Editor.ts`'s `placeAt()`
(the `label` tool's own `case`) is called from a synchronous click-handling
chain (`handleMouseUp` → `performClick` → `placeAt`) that nothing else in
this codebase needed to make `async` for. `showPrompt(...).then(...)`
there instead — fire-and-forget from `placeAt`'s own point of view, the
label just appears once the (now real, clickable) dialog is answered.

`seedStandardCells()` runs once at startup (`main.ts`), so the chip palette
lists NOT/NAND/AND/NOR/OR/XOR/MUX2/MUX4/FULL_ADDER/D_LATCH/D_FF from the
first frame — placeable and wireable exactly like any chip the user folds
by hand, because that's all they are: chips, just pre-folded instead of
starting from transistors every session.

`buildRegister`/`buildAlu`/`buildProgramCounter`/`buildInstructionRegister`
don't fit the palette's one-click-places-one-instance model (they place
*several* wired-together instances at once) — they're wired to their own
toolbar buttons (`+ REG`, `+ ALU`, `+ PC`, `+ IR`) instead, inserting the
result at the current view's center. The first three prompt for a bit
width; `+ IR` doesn't, since its width is fixed at 8 (see "The instruction
register" above).

**A real layout bug caught by actually looking at the result, not by any
test:** `buildRegister` originally spaced its `REG_BIT` instances 60 world
units apart — a number carried over from spacing raw transistors, not chip
instances. A `REG_BIT` box is 5 ports tall, and `Renderer.ts` draws a chip
instance `portCount * 20 + 10` units tall — 110 units for a 5-port chip, well
over the 60-unit step. `+ REG` produced a perfectly correct circuit
(`settled: true`, right truth table) stacked into a smear of overlapping
boxes, because nothing about the *simulation* was wrong — the bug was
purely in a layout constant nobody had reason to touch since it was written
for transistors, silently wrong once instances (much taller) started using
the same code path. Caught by placing one live in the browser and looking
at it, exactly the kind of thing 83 passing tests have no way to notice.

Fixed two ways at once: promoted the height formula
(`portCount * 20 + 10`), which turned out to already be duplicated between
`geometry.ts`'s hit-testing and `Renderer.ts`'s drawing, into one shared
`chipInstanceHeight()` in `library.ts` (alongside a `CHIP_INSTANCE_WIDTH`
constant) — so there's now exactly one place that knows a chip instance's
on-screen size, and `buildRegister`/`buildAlu` compute their spacing from
it instead of a copied literal.

## Bent wires

`Wire.waypoints` (optional, `types.ts`) is a list of cosmetic bend points —
`Circuit.computeNets()` and `solver.ts` only ever look at `Wire.a`/`Wire.b`,
never at `waypoints`, so a bent wire and a straight one between the same
two pins are electrically identical. This was true by design from the very
first version of `Wire` (see its doc comment, which said so before any
code used it) — adding the feature meant adding the field and the
drawing/editing code around it, not changing anything about how a wire
behaves.

Drawing one: `Editor.handleWireClick` treats a click during wire-drawing
one of two ways depending on what's under it — on a pin, it starts or ends
the wire; on empty canvas, it commits a (grid-snapped) bend point and
keeps going. This is the standard click-to-route gesture (KiCad, Logisim,
...): click a start pin, click through as many bends as you want, click
the destination pin. `Renderer.ts` draws both the finished wire and the
in-progress rubber-band as one continuous polyline (a single path with a
`lineTo` per point, `lineJoin: 'round'`) rather than a chain of separate
segments, so corners stay smooth under the glow-underlay treatment every
wire already gets.

## Editing a drawn wire

Adding `findWaypointNear`/`findWireNear`/`distanceToSegment` (`geometry.ts`)
made wires hit-testable, which meant `Editor`'s click-vs-drag logic —
previously special-cased for marquee-select only — needed to become
general enough to also cover "select a wire", "kink a wire" (grab a bare
segment and drag — inserts a waypoint), and "move an existing bend point",
all from the *same* mousedown depending on what's under the cursor and
whether the mouse actually moves before it comes back up.

This is why `Editor.handleMouseUp()` is now the *sole* place that decides
click vs. drag, instead of `main.ts` branching on an `editor.dragging`
flag before choosing which method to call: `main.ts` forwards
mousedown/mousemove/mouseup almost unconditionally, and `handleMouseUp`
finalizes whatever drag was in progress, falling through to dispatch a
plain click only if nothing was actually dragged this gesture. Grabbing a
bare wire segment goes through a `pendingWireGrab` state first — the
waypoint isn't actually inserted until the drag crosses `DRAG_THRESHOLD` —
so releasing without moving just selects the wire instead of leaving a
zero-length kink behind. Double-clicking an existing bend point removes
just that point (handled directly in `handleDoubleClick`, no round trip
through `main.ts`); `Delete` on a selected wire removes the whole thing.

## Moving components

`Circuit.moveComponent(id, dx, dy)` translates a component's `pos` *and*
every one of its pins by the identical delta. That's the whole trick: a
pin's position is a fixed offset from its owner's `pos` decided once at
creation time (`LAYOUT` in `library.ts`), so sliding both together
preserves that offset without `moveComponent` ever needing to know what it
was — it works identically for a bare transistor, a chip instance with a
dozen pins, or anything else, with no per-kind branching. Wires reference
pins by id, so they follow automatically; a wire's own waypoints are
independent points in world space and deliberately don't move with either
endpoint (dragging a component can lengthen or reshape the segment nearest
it, exactly like dragging one end of a line in any vector tool).

`Editor` drives this with the same click-vs-drag machinery the wire-editing
work above already generalized: mousedown on a component starts a
`pendingComponentDrag` (the whole current selection if the hit component is
already part of a multi-selection and that selection has more than one
member, otherwise just that one component); past `DRAG_THRESHOLD` it
becomes a live `draggingComponents` that applies each mousemove's delta via
`moveComponent`; mouseup snaps every dragged component's final position to
the grid and selects them. Releasing without ever crossing the threshold
falls through to a plain click (select/toggle), same as it already did
before drag-to-move existed.

**A real bug hunt that turned out not to be one:** dragging a component
appeared to silently do nothing — selection would light up, but the part
never actually moved — across several attempts, closely resembling a
genuine logic bug. Direct-dispatching the same mousedown/mousemove/mouseup
sequence in the page's own JS console (bypassing the browser-automation
layer generating the clicks) reproduced it too... until computing the
*exact* world coordinates a real click at that screen position resolves to
(by temporarily exposing the live `Camera`/`Editor` instances) showed the
click had landed about 17 world units from a `source` component's center —
just outside its tight 16×8 hit-box, so the gesture was legitimately being
read as an empty-space marquee-select that happened to still sweep over
the part, which explained the selection-without-movement perfectly. The
drag code itself was correct the entire time. Fixed for real users hitting
the same near-miss by padding every hit-box a few units past its drawn
body (`HIT_PAD` in `geometry.ts`) — a mouse is nowhere near pixel-precise
either, so the same tolerance that made the automated clicks reliable is a
straightforward comfort win for a human pointer too. The lesson generalizes
past this one bug: when a click-driven interaction "does nothing," check
where the click actually landed in the app's own coordinate space before
suspecting the handler logic — a few pixels are very easy to lose between
a screenshot, a scaled display, and the app's world coordinates, and a
near-miss is invisible in a screenshot in a way it never would be to a
person looking at their own cursor.

## Persistence

Nothing was savable at all before this — everything lived only in the
tab's memory. Two independent things exist now, in `serialize.ts`, because
they need genuinely different id strategies:

- **Whole-project export/import** (`serializeProject`/`deserializeProject`)
  is a *replace*: importing a project JSON discards the running session's
  circuit and chip library outright, so there is nothing yet for the
  loaded ids to collide with — they're loaded verbatim. `main.ts`'s import
  handler still keeps the existing `Circuit`/`ChipLibrary` *objects* alive
  (clearing and repopulating them) rather than rebinding `topCircuit`/
  `library` to the freshly-parsed instances, because `Editor` holds a
  `readonly` reference to the library and every dived-in `NavFrame` holds a
  direct circuit reference — swapping the binding would leave those
  pointing at stale objects nothing else knows to update.
- **Single chip-def export/import** (`serializeChipDef`/`importChipDef`) is
  a *merge*: the whole point is bringing a chip from some other session
  into this one, where id collisions are a real risk (two independently-
  run sessions both start numbering from `t1`). `importChipDef` never
  reuses a single id from the file — every component and chip def gets a
  fresh id via `nextId()`, unconditionally — which makes collision
  structurally impossible rather than merely unlikely. Exporting also
  walks the chip's dependencies (`collectDependencies`): a chip built from
  other chips is useless without them, so the bundle includes every def it
  needs, not just the one the user asked for.

Both paths call `Circuit.noteUsedId()` for id read from a file (project
load) or generate fresh ones outright (chip import) — either way, nothing
created *after* a load can ever collide with something the load brought
in, because `nextId()`'s shared counter is fast-forwarded past every id
`noteUsedId()` has seen.

**A real bug caught by actually importing a project, not by any test:**
the first version of project-import called `library.clear()` and
repopulated only from the loaded file — which silently dropped the
`seedStandardCells()` toolbox (NOT/NAND/AND/...) the moment anyone
imported a project that didn't happen to include copies of them, since
that call only runs once at startup. Fixed by re-seeding standard cells
after every project load — harmless even if the loaded project already
had its own same-named copies (just an extra palette entry, never a broken
one), and it means the basic parts bin is never one import away from
silently vanishing.

## Caching `flatten()`/`computeNets()`: from a full clone every tick to a version-checked cache

Flagged three separate times in this document by the time it finally got
paid down (see "Re-flattening the whole hierarchy" and the `buildMinimalCpu`/
`buildZ80Cpu` notes under Known Simplifications below): `flatten()` ran a
`structuredClone` of every component, recursively through the whole
hierarchy, on *every single call* — once per animation frame in the live
app (`main.ts`'s `frame()`), once per `pulse()` in every `buildZ80Cpu` test.
`computeNets()`, called right after on the result, re-ran its own
union-find over every pin from scratch every time too. Neither had
anything to do with whether the circuit's actual *structure* — which
components exist, how they're wired — had changed since the last call, and
for the overwhelming majority of calls (toggling an input, pulsing a
clock, `requestAnimationFrame` idling with nothing being edited) it
hadn't.

The fix: a single, global, monotonically-increasing counter
(`Circuit.ts`'s `bumpStructureVersion()`/`currentStructureVersion()`),
bumped by every structural mutation to *any* `Circuit` anywhere in the
app — top-level or a `ChipDef`'s own internals, since chip defs are edited
in place ("dive in, press E"), not copied, so a chip instance's flattened
expansion depends on its def's own circuit too, transitively, however deep
the hierarchy goes. Global and coarse rather than a precise per-circuit
dependency graph: touching one circuit invalidates *every* circuit's own
cached flatten, even an unrelated one, which only costs a few redundant
re-flattens during active editing — a rare, non-performance-critical
moment — in exchange for a cache that is never wrong. `flatten()` checks
this version against a `WeakMap<Circuit, {version, result}>` keyed on the
top-level circuit, returning the exact same (never re-cloned) `Circuit`
object outright on a match; `computeNets()` does the identical check as a
private field on `Circuit` itself, since the method already has its
natural cache key sitting right there in `this`. Every raw mutation this
required auditing for (`fold()`'s own `parent.components.delete`/
`parent.wires.delete`, bypassing `removeComponent`/`removeWire` because it
moves entries into a new internal circuit rather than discarding them;
`renamePort`'s direct `.name`/`.pins` rewrites) got an explicit bump too,
rather than relying on incidental coverage from some other call in the
same function that happens to bump anyway.

One real trap on the way there, found immediately by the regression suite
rather than live: `flatten()`'s own output-building (`out.addComponent(c)`
for every cloned component) used the version-bumping public method — which
meant *building* a fresh flatten result bumped the counter past the value
being cached for it, invalidating the cache entry the instant it finished
computing it, every single time. The fix mirrors RAM's own `.bytes`
aliasing trick exactly: a new `addRawComponent()`, the `addComponent()` for
flatten()'s own throwaway output circuit specifically, that inserts
without bumping — the identical reasoning `addRawWire()` already existed
for, just never generalized to components until this needed it.

A second, subtler trap, this one caught by nine `blocks.test.ts` failures
on the very first real run: `SourceComponent`/`InputComponent`'s own
`.value` — a toggleable input's whole reason to exist — is runtime-mutable
state that changes by direct field assignment (`input.value = 1`), never
through a `Circuit` method, so it never bumps the version and never
invalidates the structural cache (correctly — flipping an input doesn't
change the netlist, only what's forced onto one of its existing nets).
But a cached flat *clone*'s own copy of `.value` is frozen at whatever it
was the moment that clone was built; every later toggle of the *original*
input, on a cache hit, was silently invisible — a test reading back an IR
or ACC that should have latched a fetched byte instead read the value from
before the clock ever pulsed. Fixed by collecting `{original, clone}`
pairs for every source/input encountered during flattening and, on a cache
*hit*, cheaply re-copying each clone's `.value` from its original before
handing the result back — a handful of pairs, not a `structuredClone` of
the whole hierarchy, so the fix costs nothing next to what it replaced.

Outcome: `blocks.test.ts` alone (the file with the most re-flattens per
tick, via `tickHierarchical`'s deliberate multi-pass loop) went from
`407871ms` to `4758ms` — roughly 85x. The full suite — the same 155
tests, 28 files this project has been measuring the wall-clock of since
the very first indirect-load feature — dropped from `4825.18s`
(`80m25.18s`, capped at `--pool=threads --poolOptions.threads.maxThreads=3`
because the machine couldn't survive full parallelism otherwise — see
"x=00, z=7" above) to `1091.98s` (`18m11.98s`), run fully parallel, on
default settings, with no OOM and no need for that cap at all. Less
memory churn from far fewer `structuredClone` calls plausibly explains
both numbers at once: the earlier full-parallel OOM was never conclusively
diagnosed (`dmesg`/`journalctl` came back empty even under `sudo`), but a
workload that no longer clones the entire hierarchy every tick, times
eight parallel workers, is a very different memory profile than one that
did. The remaining wall-clock is real relaxation cost (`step()`'s own
per-tick iteration, genuinely proportional to circuit size and unaffected
by this cache) — the ~4-9 minute-per-file numbers for the heaviest
`buildZ80Cpu` tests are what's left once the redundant cloning is gone,
not a floor this change was ever going to touch.

**What this doesn't fix, found live rather than assumed:** placing a fresh
`+ Z80CPU` in the live editor and just watching it sit idle (no clicking,
no toggling) still ran at a measured `~3.8fps`, not the `60fps`
`requestAnimationFrame` targets. This looked, for a moment, like the cache
not actually working in the live app the way it does in tests — it isn't
that. `buildZ80Cpu` is built directly into the caller's own circuit (never
`fold()`ed into one opaque instance), so `topCircuit` itself holds
hundreds of `MUX2`/`HALF_ADDER`/`REG_BIT`/`ALU_SLICE`/`TRI_BUF` chip
instances at the *top* level, all individually visible and all
individually redrawn, every single frame, by `draw()` — a Canvas 2D cost
that has nothing to do with `flatten()`/`computeNets()`/`step()` at all,
since `draw()` renders `view.circuit` (the hierarchical, human-edited
circuit), never the flattened one this cache touches. This cache fixes
exactly what it set out to fix — the *simulation* side, conclusively
proven by the headless test numbers above, which involve no rendering at
all — and does nothing for a *second*, separate, pre-existing bottleneck:
redrawing a circuit with hundreds of top-level primitives is expensive
regardless of how cheap simulating it has become. Worth its own line in
Known Simplifications below rather than quietly folding it into this
section's own success story.

## Known simplifications (v1)

- No rename UI for a `ChipDef`'s own name after folding (only the initial
  name, via a prompt at fold time) — labels and ports can be renamed by
  double-clicking them (see `renamePort()` in `hierarchy.ts` for why a port
  rename needs more than just relabeling one component).
- `maxIterations = 64` per `step()` call comfortably covers every circuit
  built so far, register bits and ALU slices included; a much deeper
  pipeline (a full CPU datapath) may need a larger cap or a smarter
  convergence order — revisit once one exists.
- `buildRegister`/`buildAlu`/`buildProgramCounter`/`buildInstructionRegister`/
  `buildRingCounter` are reachable from the toolbar (`+ REG`, `+ ALU`,
  `+ PC`, `+ IR`, `+ FSM`), not from the chip palette itself — they don't
  fit its one-click-places-one-instance model, since each inserts several
  wired-together instances at once. `buildStubRom` is the same case
  (`+ ROM`, prompting for hex bytes instead of a width). `buildAluSlice`
  alone has no dedicated button (it's exposed via the `ALU_SLICE` chip
  `buildAlu` registers, placeable individually like any other palette
  chip).
- `buildStubRom` is exactly what its name says — fixed content, no
  storage, no write port, wired from constant `makeSource`s through real
  tri-state buffers and a real decoder. Real RAM (writable, addressed at a
  realistic scale — a Z80's 64K space, not 2 or 4 words) needs an entirely
  different representation: building it from `REG_BIT` chip instances one
  address at a time does not scale past a handful of words before
  `flatten()`'s per-frame `structuredClone` (see below) makes the live UI
  unusable. The likely shape — a single component wrapping a plain
  `Uint8Array`, read/written behaviorally rather than simulated
  transistor-by-transistor, exposed to the rest of the circuit only
  through the same tri-state-bus interface `buildStubRom` already
  establishes — is a deliberate, not-yet-made decision, tracked here, not
  guessed at inside this slice.
- This solver has no propagation-delay model — a relaxation pass finds
  *a* fixpoint, not "the state a moment before" versus "a moment after."
  Chaining one register's output into another register's write-enable
  works fine *unless both are clocked by the same edge that's also the one
  transitioning the value being read* — see "A control FSM: the fetch
  loop" above for the empirically-confirmed failure mode (the shared value
  reads `'Z'`, not a defensible old-or-new answer) and its fix
  (non-overlapping clock pulses, wired explicitly, never inferred). Nothing
  in the solver enforces this — it's a wiring discipline the *user* has to
  keep, same as real two-phase-clock hardware did, and there is currently
  no in-UI warning if two clocked structures end up sharing an edge they
  shouldn't.
- ~~Re-flattening the whole hierarchy from scratch every animation frame
  (see the lesson above) is `main.ts`'s current live-simulation strategy —
  correct, but the `structuredClone`-heavy cost will start to matter well
  before a full CPU's worth of chip instances exists.~~ **Fixed** — see
  "Caching flatten()/computeNets()" above: a version-checked cache now
  skips both the clone and the net recomputation outright whenever nothing
  structural has changed since the last call, which is the overwhelming
  majority of ticks in both the live app and every test.
- ~~Canvas 2D rendering cost is a separate, still-unfixed bottleneck the
  flatten/computeNets cache above doesn't touch...~~ **Fixed** — see
  "Canvas 2D rendering cost, closed out: idle-skip and viewport culling"
  above: an idle-frame skip in `main.ts` (exploiting `step()`'s own
  determinism to know a frame would be a no-op before paying for it) plus
  viewport culling in `Renderer.ts` (skipping `drawComponent()`/`drawWire()`
  for anything actually off-screen) together turned "crashes the tab
  placing a real `+ Z80CPU`" into "one ~3s frame once, then nothing until
  the next real interaction."
- Only one wire can be selected at a time (no shift-click multi-wire
  selection to delete several at once), and there's no undo for a wire edit
  gone wrong beyond redrawing it.
- Loaded JSON is checked only for the right `format` tag, not validated
  against the full shape — a hand-edited or corrupted file with the right
  tag but malformed contents will fail with whatever error that malformed
  data happens to cause deeper in, not a clean upfront message.
- RAM placed standalone via `+ RAM` (see "Real RAM") always starts
  zero-filled — there's no UI equivalent of `+ ROM`'s hex-byte prompt for
  hand-authoring initial content *on that button specifically*. `+ CPU`
  (see "Decode and execute") does have one, since a CPU with nothing to
  run isn't much of a demo — but it's specific to that button's own
  `promptProgramBytes`, not a general "load a program into an existing
  RAM" feature reachable after the fact. Unlike `buildStubRom`, RAM needs
  no external `buildDecoder` circuit wired to it at all — its address
  decode is behavioral, baked into the `bytes[addr]` lookup itself, since
  the whole component is already the deliberate non-transistor exception;
  there's simply nothing left to keep transistor-real once that line is
  crossed.
- `buildMinimalCpu`'s instruction set (see "Decode and execute") is a
  deliberately tiny made-up 8-slot encoding, not real Z80 opcodes —
  building an actual Z80 decoder (256 opcodes, several multi-byte prefixed
  forms) is substantial follow-up work this slice doesn't attempt. Its ALU
  now supports all four ops it's capable of (ADD/AND/OR/XOR, via
  ADI/ANI/ORI/XRI) — but there's no shift, no compare, no increment/
  decrement-by-one, none of the other operations a real accumulator-based
  ISA eventually wants. STORE and LOAD's target address is limited to 5
  bits (shares the immediate field, one bit narrower than the
  4-instruction encoding's 6 — 3 opcode bits leave less room than 2 did),
  so `buildMinimalCpu` rejects `addrBits > 5` outright rather than
  silently building a CPU whose STORE/LOAD can't reach most of a larger
  RAM — FETCH itself has no such ceiling, only STORE/LOAD's own encoding
  does. There's no indirect or indexed addressing (an address computed
  from ACC, or ACC plus an offset) — every memory access's target is a
  constant baked into the instruction at program-authoring time, not
  something the running program can compute. JZ is the only conditional
  jump and tests ACC alone, so a delay loop counts ACC up to the wrap-around
  (`loop: ADI 1 / JZ done / JMP loop`): ACC is the only register, ADI takes a
  5-bit immediate and nothing subtracts.
- `buildMinimalCpu`'s own test takes 70-90+ seconds — noticeably slower
  than every earlier composite's test, for the unsurprising reason that
  it's the largest circuit `tickHierarchical`-style tests have flattened
  and re-flattened so far (PC + RAM + IR + ACC + a full 8-bit ALU + 8
  `buildTriStateBuffer`s + a `buildDecoder` + two chained 2:1 muxes per
  data bit + a 6-input OR tree + the FSM, all at once, over dozens of
  ticks), and it grew again with each instruction added on top of the
  original LDI/ADI-only version. This was the same `structuredClone`-per-
  frame cost already flagged twice above at the time this was written —
  since **fixed** (see "Caching flatten()/computeNets()" above), so this
  particular file's own wall-clock is historical color now, not a live
  concern (`blocks.test.ts` as a whole dropped from `407871ms` to `4758ms`
  once the cache landed).
- `buildZ80Cpu`'s own circuit is bigger than `buildMinimalCpu`'s (7
  parallel 8-bit `buildTriStateBuffer` banks instead of a single 8, plus
  `buildZ80Decoder`'s 3 extra `buildDecoder`s and the `aReset` mux chain)
  and needs deeper relaxation to settle — see "A real Z80 decoder" above.
  Its test stayed fast (~15s, at the time this was written) only because it
  flattens once per tick and hands `step()` a large `maxIterations`
  directly instead of routing through `tickHierarchical`'s
  re-flatten-per-outer-pass loop; the same circuit driven the *other* way
  (raising `tickHierarchical`'s own `n`) didn't finish in 5+ minutes.
  `tickHierarchical` itself is unchanged — every other test in this file
  still uses it — but this composite was the concrete case that already
  broke its "re-flatten every pass" assumption once. The underlying cost
  that made repeated re-flattening expensive in the first place is fixed
  now (see "Caching flatten()/computeNets()" above) — a composite needing
  more than 64 internal passes would still hit `tickHierarchical`'s own
  hardcoded pass-count ceiling, a genuinely different limit, but no longer
  by paying for a full re-clone on every one of those passes.
- `buildZ80Cpu` covers `x=10` (ALU-on-register), `x=01` (`LD r,r'`), all of
  `x=11`'s real, real-Z80 subset that isn't a prefix byte — `PUSH`/`POP`
  (4 valid register pairs each), `RET`, `RST n`, `JP nn`, `CALL nn`, `JP
  cc,nn`, `CALL cc,nn`, and `RET cc` (all 8 conditions each) — and a real
  *subset* of `x=00` — `INC rr`/`DEC rr` (`BC`/`DE`/`HL`/`SP`, `z=3`),
  `INC r`/`DEC r` (`B`/`C`/`D`/`E`/`H`/`L`/`A`, `z=4`/`z=5`), `LD r,n`
  (same seven registers, `z=6`), `LD dd,nn` (`BC`/`DE`/`HL`/`SP`, `z=1`
  — `(HL)` excluded from the two 8-bit groups), `ADD HL,rr` (`z=1`, `y`
  odd — the other half of that same `z`), `JR cc,e` (`z=0`, `y=4..7` —
  `NZ`/`Z`/`NC`/`C`, real Z80's own full set for this opcode), and plain
  `JR e`/`DJNZ e` (`z=0`, `y=3`/`y=2` — the rest of that column bar `NOP`/
  `EX AF,AF'`), and indirect loads through `(BC)`/`(DE)`/`(nn)` (`z=2`,
  all 8 `y` values — `LD (BC),A`/`LD A,(BC)`/`LD (DE),A`/`LD A,(DE)`/
  `LD (nn),HL`/`LD HL,(nn)`/`LD (nn),A`/`LD A,(nn)`), `INC (HL)`/
  `DEC (HL)`/`LD (HL),n` (`z=4`/`z=5`/`z=6`, `y=6` — the one slot every
  other `x=00` register group deliberately left inert, a real RAM
  read-modify-write instead of a register touch), and `RLCA`/`RRCA`/
  `RLA`/`RRA`/`CPL`/`SCF`/`CCF`/`DAA` (`z=7`, all eight `y` values now —
  `DAA` at `y=4` no longer the exception; see "x=00, z=4/z=5", "x=00,
  z=6", "x=00, z=1", "x=11: JP nn", "x=11: CALL nn", "x=11: JP cc,nn",
  "x=11: CALL cc,nn", "x=11: RET cc", "x=00: JR cc,e", "x=00: plain JR e
  and DJNZ e", "x=00: ADD HL,rr", "x=00: indirect loads through
  (BC)/(DE)/(nn)", "x=00: INC (HL)/DEC (HL)/LD (HL),n", "x=00, z=7", and
  "Closing the half-carry gap" above) — out of 256 possible opcodes.
  `x=00` is now fully covered too, `DAA` included, once a real `H` existed
  for it to read (see "Closing the half-carry gap" above for the full
  derivation — the same section covers why `RLCA`/`RRCA`/`RLA`/`RRA`/`SCF`/
  `CCF`/`CPL` leave `S`/`Z`/`P/V` stale while refreshing `H`/`X`/`Y`/`C`/`N`
  (and why plain `ADD HL,rr` refreshes `C`/`H`/`N`/`X`/`Y` the same way)).
  `x=11` is fully covered for every opcode real Z80 defines that isn't a
  prefix byte or an interrupt primitive — `PUSH`/`POP`/`RET`/`RST n`/
  `JP nn`/`CALL nn`/`JP cc,nn`/`CALL cc,nn`/`RET cc`/`EXX`/`JP (HL)`/
  `LD SP,HL`/`EX DE,HL`/`EX (SP),HL`/`IN A,(n)`/`OUT (n),A` (see "Closing
  out the CPU" above). `ADC`/`SBC` (`x=10`) and `ALU op A,n` (`x=11,
  z=6`) are real too, reusing `x=10`'s own op-select/`cin`/`bInv`
  machinery unchanged (`dec.y` alone selects the operation, never
  `dec.x`). `DI`/`EI` (`x=11, z=3, y=6/7`) now drive real `IFF1`/`IFF2`
  flip-flops as part of the IRQ/NMI layer (see "Thin IM1 IRQ / NMI / IM modes" above) —
  no longer the permanent gap this paragraph once described. Soft↔gate now
  share one-instruction EI delay and a HALT latch (`soft-gate-ei-halt.test.ts`).
  Remaining IRQ notes: INTACK is PHASE0 ack + PHASE1 wait with bus pins
  `IORQ∧M1` (labels `INTACK_NOW` / `INTACK_WAIT`; soft `intAckWaits(4)`);
  nested `busCycle`/`busBusy` track the window (instruction ring stays at 10).
  Soft and gate both implement IM0/IM1/IM2 accept (gate IM2: push + word
  at `(I<<8)|bus` → PC). Soft and gate
  both auto-increment `R` on M1 (bit7 sticky), including once on maskable
  INT accept (NMI leaves R alone, matching soft). `P/V←IFF2` on `LD A,I`/`LD A,R`
  is real on both soft and gate. Soft Run and gate both honour
  one-instruction EI delay; Soft Run stops on `HALT` (`0x76`), and the gate
  latches `halted` (MachineRunner can stop-clock). NMI/`RETN` and IM0 are
  wired on both (see "Thin IM1 IRQ / NMI / IM modes" above). `H` (half-carry) and the two undocumented flag bits are real
  now for the `x=10`/`x=11` ALU group, `INC r`/`DEC r`, `DAA`, plain
  `ADD HL,rr` / ADD IX/IY (H from bit11 carry; X/Y from result high), and
  the `RLCA`/`RRCA`/`RLA`/`RRA`/`CPL`/`SCF`/`CCF` group (H/X/Y fresh;
  CCF's H is old C) — see "Closing the half-carry gap" above. `P/V` now picks parity vs. signed
  overflow by which op actually ran — parity for `AND`/`OR`/`XOR`,
  overflow for `ADD`/`ADC`/`SUB`/`SBC`/`CP` and unconditionally for
  `INC r`/`DEC r` (which has no logic variant to be parity for); `DAA`
  keeps parity, matching Zilog's own documented behavior for it (see
  "P/V is two flags, not one" above). `ADD HL,rr` and the six-op
  RLCA/RRCA/RLA/RRA/CPL/SCF/CCF group still leave `P/V` (and `S`/`Z`)
  stale — real Z80 does too for those ops.
  `CB`/`ED`/`DD`/`FD` prefix handling — a fundamentally different
  undertaking from "one more opcode," each prefix byte opening an
  entirely separate decode table (bit-level `RLC`/`BIT`/`SET`/`RES` ops,
  `IX`/`IY` index registers, block transfer/search instructions) rather
  than one more slot in the `xxyyyzzz` scheme this file already decodes —
  now has its *mechanism* built (detect a prefix byte, recapture `ir`
  with the real opcode that follows, advance `pc` an extra time, and
  correctly exclude the existing unprefixed tables from misreading that
  recaptured byte — see "The CB/ED/DD/FD prefix mechanism" above) and
  all four `z=0..3` block-instruction columns of `ED`'s own table on top
  of it — `LDI`/`LDD`/`LDIR`/`LDDR` (see "x=10, z=0: LDI/LDD/LDIR/LDDR"
  above), real `0xED 0xA0`/`0xA8`/`0xB0`/`0xB8`; `CPI`/`CPD`/`CPIR`/
  `CPDR` (see "x=10, z=1: CPI/CPD/CPIR/CPDR" above), real `0xED 0xA1`/
  `0xA9`/`0xB1`/`0xB9`; `INI`/`IND`/`INIR`/`INDR` (see "x=10, z=2:
  INI/IND/INIR/INDR" above), real `0xED 0xA2`/`0xAA`/`0xB2`/`0xBA`; and
  `OUTI`/`OUTD`/`OTIR`/`OTDR` (see "x=10, z=3: OUTI/OUTD/OTIR/OTDR"
  above), real `0xED 0xA3`/`0xAB`/`0xB3`/`0xBB` — every repeating
  variant's own loop faked by landing `PC` back on its own opcode rather
  than by any real micro-cycle, each with a genuinely different repeat
  condition except the last pair, which genuinely shares one (`LDIR`/
  `LDDR` watch `BC` alone, `CPIR`/`CPDR` also stop on a match found,
  `INIR`/`INDR` and `OTIR`/`OTDR` both watch `B` alone — decrementing `B`
  is the identical operation regardless of transfer direction, so the
  underlying adder and its own nonzero bit are genuinely shared code,
  not just a similar shape); `NEG` (see "x=01, z=4: NEG" above), real
  `0xED 0x44` — `A<-0-A`, this retrofit's first non-block `ED`-table
  opcode, every flag bit real and fresh, none left stale; and `ADC
  HL,rr`/`SBC HL,rr` (see "x=01, z=2: ADC HL,rr/SBC HL,rr" above), real
  `0xED 0x4A`/`0x5A`/`0x6A`/`0x7A` and `0x42`/`0x52`/`0x62`/`0x72` — the
  identical shared 16-bit adder plain `ADD HL,rr` already built, widened
  for a real carry-in and operand invert (the same `x=10: ADC/SBC`
  recipe, just 16 bits wide), every flag bit real here too (plain
  `ADD HL,rr` refreshes C/H/N/X/Y and holds S/Z/P/V). The block instructions' own decode
  gates were found live, while designing `NEG`'s, to have never checked
  `dec.x` at all (see "A decode gap found across all sixteen
  block-instruction gates" above) — fixed before `NEG` landed, rather
  than propagating the same gap into a seventeenth gate. `ED` also has
  thin IRQ/NMI (`IM 0/1`/`RETI`/`RETN`/`NMI`, plus unprefixed `EI`/`DI` — see "Thin IM1
  IRQ / NMI / IM modes" above). `CB` is closed for `BIT`/`SET`/`RES`/rotates (see above).
  `DD` has an index-register slice (`IX`, `LD IX,nn`, `PUSH IX`,
  `POP IX`, plus HL-clone ADD/INC/DEC/JP/LD SP/EX and `(IX+d)` LD /
  INC/DEC / ALU `A,(IX+d)`, `DD CB` BIT/SET/RES/rot, and H→IXH remap —
  see "DD: IX" above); `FD` has the matching IY slice (see "FD: IY"
  above).
- `EX (SP),HL`'s *second* execution briefly had a real, reproducible bug
  (a transient forced-driver conflict on the RAM address bus, corrupting
  `ir`/the phase ring counter) that turned out to be sensitive to this
  file's own component/net ordering — and un-broke itself, without being
  directly addressed, the moment `LDI`'s own wiring shifted that ordering
  again. See "A real solver bug this retrofit exposed — and the test that
  un-broke itself" above for the full story. Mitigated: LOW/HIGH address
  selects are mutually exclusive (both drop rather than double-drive), and
  SP+1 is held for the opcode window after the first read-low. Still
  monitor — ordering-sensitive races can return; do not treat as solved
  forever. `oldLTemp`/`oldHTemp` remain for the write-side bus race.
- `buildZ80Cpu`'s `x=11` work is the deepest circuit this project has built
  (`spAdder` — a second full ripple-carry `buildAlu` instance — plus the
  push/pop byte-select banks, the flag-computation chain, and a 4-phase FSM
  instead of 3) and its own test runs ~70-75s even using the fast
  flatten-once-per-tick pattern "x=10"'s own performance note above
  established — noticeably slower than `x=10`'s or `x=01`'s own tests
  (~15-20s each) on the *same* underlying composite, since every test
  built against `buildZ80Cpu` now pays for this group's extra depth
  whether or not the specific test exercises `x=11` at all. This is the
  same "the next composite deep enough to need >64 internal passes *and*
  many ticks will hit the same wall" concern the earlier note already
  flagged — now with a second, independent circuit confirming it. By the
  time `x=00`'s `z=3`/`z=4`/`z=5`/`z=6` pieces were all added on top, the
  wall stopped being a projection: placing `+ Z80CPU` fresh in the live
  editor (not just running the test suite) got slow enough that the first
  live-browser check of `LD r,n` read as a hung renderer to the automation
  tooling driving it — a second attempt, given more patience, settled
  cleanly (`settled: true`, `contended: 0`) with the identical input, so
  this is latency, not a bug (see "x=00, z=6" above for the full account).
  Still real: a fresh `+ Z80CPU` placement can no longer be assumed to
  respond immediately, in the live editor as much as in `npm test`.
  `LD dd,nn`'s own ring widening (4 phases to 6 — see "x=00, z=1" above)
  pushed this from "noticeably slower" into "measured, substantial":
  `blocks.test.ts` as a whole went from ~1096s to ~1725s in one turn, and
  individual `buildZ80Cpu` tests scaled with it (`x=11` 210s -> 314s,
  `x=00, z=4/z=5` 263s -> 423s) — every instruction, regardless of which
  group it belongs to, now sits through two more genuinely wasted phases
  every single cycle. Not a regression to fix — the two extra phases are
  real, necessary machinery for `LD dd,nn`'s own second operand byte — but
  the clearest evidence yet that this composite's fixed-phase-count design
  has a real, now-quantified cost that grows with every instruction family
  added, independent of whether that specific instruction needs the depth.
- Gate-building primitives in `library.ts` (`buildNot`/`buildNand`/
  `buildNor`/`buildTriStateBuffer`, and everything built on them) attach
  power through `tiePowerRail` — a local `Label("VCC"|"GND")` stub next to
  each transistor, joined to the global rails by `computeNets()` the same
  way `Source(1)`/`Source(0)` already do. Constant 0/1 signal ties use the
  same helper (or `railPin` when a `Pin` value is needed). Callers still
  pass `vcc`/`gnd` pins for API compatibility, but those pins are unused
  for power. `buildZ80Cpu` keeps one Source pair to drive the rails; the
  older cluster-Source workaround (`vcc2`…`gnd5`) is obsolete. See "Net
  labels, not wire spaghetti" above. Cleaning unused `vcc`/`gnd`
  parameters off the builder signatures is separate cosmetic work.

## Running it

```
npm install
npm test        # engine unit tests (vitest)
npm run dev      # canvas editor at http://localhost:5173
npm run build:file  # static IIFE bundle into dist-file/ — open index.html via file://
```

`build:file` exists because browsers block ES-module scripts on `file://`
(opaque origin). It emits one classic `app.js` plus `index.html` with a
plain `<script src>` (see `vite.config.file.ts`). Regular `npm run build`
still targets HTTP hosting under `dist/`.
