# SwitchLab — quick user guide

A transistor-level schematic editor with live simulation, foldable chips, Soft Lab, and an optional soft Z80 machine.

**Try online:** [ashevchuk.github.io/switchlab](https://ashevchuk.github.io/switchlab/) (GitHub Pages build of `dist-file/`). Overview + screenshot gallery: **[README.md](./README.md)**.

**In-app docs:** Help → **Lab manual…** (resizable; tree: Menus · Soft Lab · Soft machine). Covers File/Place/Insert/…, Soft Lab, **Logic analyzer** (with waveforms), ROM/RAM/Z80, and Spectrum step-by-step (**Load images**, demos, tape, pad, debug). Screenshots in `src/assets/help/` — refresh with `scripts/capture-lab-help*.mts`.

## Place & wire

- **Tools:** `1` select, `2` pan, `3` wire (or the toolbar). Space + drag also pans; right-drag pans.
- **Place** menu (or hotkeys `4`–`9`, `B`, `E`, `K`, `O`, `L`, `S`) drops transistors, rails, I/O, probes, **bus probes**, **bus switches** (DIP paddles — click a bit to toggle; click the readout to step +1), labels, clocks, analyzers, **7-seg**.
- **Wire** tool: click pin → click pin; the dashed preview is the route that will be committed (channel router, avoids chip bodies and other wires). Click empty space to place bends and take over the route by hand. Click a wire/bend to place a **node** (T-junction) and branch. Delete a node heals the through-wire and drops only branch stubs. Esc backs up a bend or cancels.
- **Editing a wire** (select tool): drag a segment to slide it sideways, drag a corner to move it; legs stay orthogonal and the pin exits are kept. A dragged part snaps to a gap beside a chip body, to a gap beside another wire (never onto it, so wires do not glue together), to a pin's row or column, and to the grid; a dashed guide line shows what it snapped to (cyan for a body, amber for another wire, grey for a pin). The part keeps its offset from the cursor, so it does not jump when grabbed. Esc cancels the drag and leaves no undo step behind. With several wires selected, dragging a leg of one carries the parallel legs of the others alongside it by the same distance. The cursor shows which way a leg slides (`ew-resize` / `ns-resize`) or that a corner moves, and the leg under the pointer is highlighted. A leg at a pin jogs where it was taken hold of. A wire running through a part's pin margin can be grabbed directly; only the part's body takes the click. Double-click a corner to remove it. A hand-shaped wire is left alone by nudge, rotate, flip and **Tidy all** while its shape is still orthogonal and clear of bodies; otherwise the router takes it back.
- Context **Separate wires** sets wires of different nets that run on top of each other, or closer than a gap, side by side. With two or more wires selected it works on those only.
- **T** tidies the selection. Selecting the wire itself and pressing **T** always re-routes it automatically and drops its manual shape. Arrow keys nudge selection by one grid; after a nudge, attached automatic wires tidy.
- Context **Wire matching / bus pins** also ribbons a chip to selected **Input/Button** banks (sorted by Y → `d0`/`q0`/`b0`…). Ribbon wires get a cosmetic `bundleId` (thicker bus stroke).
- Auto-routing can still pick awkward paths around bodies — drag a segment or select the wire and press **T**; algorithm notes for a future stand: [`docs/wire-routing.md`](./docs/wire-routing.md).

## Orient

- **R** / **Shift+R** — rotate clockwise / counter-clockwise (multi-select rotates around the group center).
- **M** / **Shift+M** — flip horizontal / vertical.
- Right-click the canvas for the same actions plus tidy, delete, dive, pin side, rename net, copy/paste.

## Fold & hierarchy

- **Ctrl+G** fold selection into a reusable chip; **Ctrl+Shift+G** unfold.
- Double-click a chip (or Inspector → Dive) to edit internals; breadcrumb or Esc climbs out.
- **Library** menu lists folded chips (search / Gates·Lab·74xx·User filters; **Ctrl+L** focuses search). Place again from the palette.
- Stdcells include gates (NOT/NAND/…) plus the digital-lab pack: registers, shifters, **COUNTER4/COUNTER8**, decoders, comparators, BCD→7seg, bus buffers, **ADDER4/8**, **ALU4/ALU8**, **SOFT_RAM16**, and 74xx aliases — hierarchies of smaller chips.
- Toolbar **Soft Lab** (on by default) evaluates Pack A/B chips (and top-level 74xx aliases like 7400/7474) behaviorally for interactive speed — including nested labcells; turn it off to expand them into transistors (dive-in still works either way). Inspector → **Force transistor expand** expands one ChipDef this session while Soft Lab stays on. Soft Lab chips show a note and optional **q hex** edit for sequential state.
- **COUNTER4/8** have `ce` (clock enable), `clr`, `load`, and `co`; **COMP2/4** expose `eq` / `gt` / `lt`. Invalid BCD blanks the 7-seg decoder.
- Context menu **Wire matching / bus pins** pairs exact names, then bus remaps (`qN`↔`dN`/`bN`, `aN`↔`bN`).
- When a chip shows a yellow **edited** badge (def changed after place), context menu or Inspector → **Update from library** refreshes pin sides/layout and clears the badge without deleting wires.

## Sessions & examples

- Work autosaves into browser session slots (File → Switch / New / Rename session). If another tab saved the same slot, the status shows **Changed elsewhere** — click it for Restore local / Load other / Export.
- **File → Demo ▸ Digital** loads built-in schematics (`#e=id`). Empty canvas skips confirm for `#e=` / `#p=`.
- **Help → Lab course…** opens a checklist panel (checkboxes + Next/Prev, saved in the session). Opening a curriculum example from elsewhere syncs the panel step if it is visible.
- Soft Lab chips: Inspector **Diff soft vs silicon** snapshots Soft `q`, expands transistors, settles, and reports matching / diff bits.
- Select a **bus switch** + chip → context **Ribbon bus switch → chip** (wires `bN` → `aN`/`dN`/…).
- **File → Copy share link** puts a `#p=…` URL on the clipboard (open the link to load; confirms replace if the canvas isn’t empty).
- Export / import project or chip JSON from the File menu. **Export PNG…** / **Export SVG…** snapshot the schematic.
- Loading any example/project resets the tool to **Select** (avoids a stale Library chip placement from a previous session).

## Simulate

- The solver runs continuously while the circuit is unsettled.
- Toolbar **Run** / **Pause** / **Step**: Pause freezes solver ticks; Step advances one tick (and one soft-CPU instruction when a machine is attached).
- Status bar shows contended nets (shorts) — click it when contended > 0 to highlight the first contended net. Contended wires pulse with a heat/ember animation. Try **lab-contend-bus** for a two-BUF8 OE fight.
- Net labels named **VCC** or **GND** power that rail even without a Source component.
- A short is local: a group of nets tied to both VCC and GND, or driven both ways, reads `Z` and counts as contended while the rest of the circuit keeps running.
- A latch or floating node that nothing has written stays `Z` instead of a random 0 or 1; reset or seed it before reading it.
- An unexpected error, or a machine that stops on one, shows a toast in the bottom-right corner with a suggested fix. It stays until dismissed; repeats only raise its counter. The editor keeps running, and Reboot restarts a stopped machine.
- A Z80 built from gates (Speed **Gates …**) runs at roughly 7 instructions per second, so a monitor command can take tens of seconds. **Soft** runs the same program with the interpreter at full speed. Place → Z80 CPU defaults to 16 address bits (64K); typing 12 there gives the 4K machine, which is about 20% faster on gates.
- Logic Analyzer: Arm/Pause, dual cursors, clock-lock Hz estimate when a channel shares a net with a free-running clock; export CSV / **VCD** / **PNG**. Watch-list bus rows: right-click → spawn bus probe or wire into an Analyzer.

## Soft Z80 machine (TTY)

**Place → Spectrum 48K… / 128K…** drops a Z80 + 64K RAM, opens TTY, and boots soft Spectrum in one click.

- Open `#demo=rainbow` (or `egghead`, `glazx`, `ay-beep`, …) to auto-place and load a bundled demo (model from the entry, default 48K). A short teach overlay explains the Spectrum tab. Empty canvas skips confirm for `#e=` / `#p=`.
- Share a live snapshot with **Copy SNA link** (`#sna=z…` deflate) or load one the same way.
- Spectrum slots **S1–S4** (Shift+click save, click load; **F6–F9** / Shift+F6–F9) store SNA in sessionStorage. Health line shows worker/main · IM · contend · tape.
- Preset menu: NMI / border / soft EI·DI. Focus tip appears if the editor stole keys from the screen.

Or place a **Z80CPU** with **addrBits=16** (64K RAM), open the TTY panel, Soft speed:

- **Boot Spectrum 48K / 128K** — soft ULA screen on the Spectrum tab (keys, Kempston/Cursor/Sinclair/WASD pad). **48 BASIC** pages the 128 editor ROM. **Boot TR-DOS*** pages Beta Disk ROM.
- **Load .SNA / .Z80 / .TAP / .TZX** — snapshots and tape flash-load (`LOAD ""`). **Save .SNA / .Z80 / PNG / .SCR**.
- **Mount .TRD** — mounts a Beta Disk image and can page TR-DOS ROM. Soft Beta does sector R/W + seek/read-address (enough for many TR-DOS ROM paths); **not** a full WD1793 timing model.
- **Demo** dropdown loads bundled freeware TAP/SNA. TAP/TZX demos wait for BASIC input then auto-type `LOAD ""` (with retry). After load, the Spectrum screen is focused and the pad switches to a demo-friendly mode (e.g. GLAZX → **WASD**).
- On-screen pad modes: **Kempston / Cursor / Sinclair / WASD** (cycle the mode button). GLAZX menus use **W/S** and **0** to begin unless you change controls in-game.
- BASIC `PAUSE` / “press any key” shows a tip on the screen — **hold Space** briefly.
- **Reboot** (machine panel) cold-boots the soft Spectrum ROM at `$0000` and clears tape/snapshot CPU state while keeping the Spectrum session. On non-Spectrum soft/gate machines it reseeds the soft CPU / gate FSM as before.
- **Spec×** multiplies soft ops/frame (frameskip at 4×+). **Mute** silences AY + beeper (128 AY via FFFD/BFFD). Soft Spectrum prefers a **Worker** (`spectrum-worker.js`); on `file://` Chromium blocks Workers so the engine falls back to the main thread.
- Spectrum tab: **Tape** browser, **Poke / cheats**, live **registers**, **PC / write breakpoints**, **Step Over**, **NMI**, pad modes above, **`.Z80↓`** save.
- Soft contended accesses drain the frame instruction budget (`contend≈` in regs — approximate soft-ops, not cycle-exact ULA).
- **TR-DOS*** / Soft Beta: sector R/W + seek against `.TRD` — **not** a full WD1793. DivMMC/+2A ports are **latches only**.
- Flash-load trap enables interrupts on exit (EI+RET). Hold a key briefly on PAUSE if a quick tap seems ignored.
- Also: Boot BASIC / CP/M / soft stub from the same panel.

## AI agents (WebMCP)

When the browser exposes WebMCP (`document.modelContext`), SwitchLab registers tools an agent can call, so a prompt such as "build an 8-bit multiplier" produces a verified circuit on the canvas. Without WebMCP nothing changes. At the time of writing it is behind a feature flag in Chromium builds (for example `--enable-features=WebMCP`); the page must be a secure context (`https:`, `localhost` or `file:`).

The agent works in a private sandbox, never on the canvas directly: it builds, simulates and tests there, and only then shows the result.

| Tools | What they do |
|-------|--------------|
| `list_library`, `describe` | Chips available (built-in, yours on the canvas, ones it built) and what a circuit contains |
| `build`, `remove`, `move`, `clear` | Add components and wires (buses wire in one entry), delete, shift, empty a scope. A failed `build` changes nothing |
| `simulate` | Set inputs (on your canvas also buttons and bus switches) and read probes/LEDs; state is kept between calls; `clock` + `cycles` pulses a clock and returns one reading per cycle |
| `begin_chip`, `finish_chip`, `test_chip`, `truth_table`, `delete_chip` | Build a reusable chip from parts, check it against cases or an exhaustive table |
| `publish_to_canvas` | Add the circuit and its chips next to what is on the canvas |
| `open_canvas`, `apply_to_canvas` | Copy your circuit into the sandbox, edit it there, apply only what changed |

What stays safe:

- **Nothing changes on the canvas until `publish_to_canvas` or `apply_to_canvas`.** Publishing only adds, to the right of everything already there, and fits the view to the new block.
- **`apply_to_canvas` applies only the difference.** Parts the agent did not touch, including RAM contents and machine links, stay exactly as they are. If you changed the canvas after `open_canvas`, it refuses and applies nothing.
- **Ctrl+Z undoes a publish or an apply in one step.**
- **Your chips are usable.** Chips on the canvas are shared with the agent, not copied. It can rebuild one in place (`begin_chip` with `replace`, then `publish_to_canvas` with `replace`): the ports must stay the same, and every instance and every chip built on it follows. The instances then show the usual "edited" marker.
- Nets in a published circuit are named after the agent's inputs and probes; a name already used by a label on the canvas is renamed (`a0` becomes `a0_2`), because labels with one name are one net.

Limits: the agent cannot change the type, label or value of an existing component, new parts are placed in a block to the right of the canvas rather than next to what they connect to, and the sandbox is lost when the page reloads (chips and published circuits are on the canvas, so they stay).

## Help

- **Help → Lab manual…** — full Soft Lab + Spectrum guide with screenshots (Logic analyzer, Load images, demos, tape, pad, debug). Update it when features change (`src/ui/LabManual.ts` + `src/assets/help/` + `scripts/capture-lab-help*.mts`).
- Press **?** or Help → Keyboard shortcuts… for the cheat sheet.
- **Help → Tutorial…** — button→LED→wire→toggle (clears canvas if needed). **Tutorial (latch)…** / **Tutorial (lab counter)…** load those examples. **Lab course…** opens the checklist ladder.
- **Ctrl+Z** / **Ctrl+Y** undo / redo. **Ctrl+F** find, **Ctrl+R** rename net, **Ctrl+C/V/D** copy / paste / duplicate. **Ctrl+Shift+V** or Edit → **Stamp×N…** pastes a grid of copies.
- Minimap (bottom-right) pans the view; press **=** to hide/show it.
