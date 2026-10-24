# SwitchLab — quick user guide

A transistor-level schematic editor with live simulation, foldable chips, Soft Lab, and an optional soft Z80 machine.

**Try online:** [ashevchuk.github.io/switchlab](https://ashevchuk.github.io/switchlab/) (GitHub Pages build of `dist-file/`). Overview + screenshot gallery: **[README.md](./README.md)**.

**In-app docs:** Help → **Lab manual…** (resizable; tree: Menus · Soft Lab · Soft machine). Covers File/Place/Insert/…, Soft Lab, **Logic analyzer** (with waveforms), ROM/RAM/Z80, and Spectrum step-by-step (**Load images**, demos, tape, pad, debug). Screenshots in `src/assets/help/` — refresh with `scripts/capture-lab-help*.mts`.

## Place & wire

- **Tools:** `1` select, `2` pan, `3` wire (or the toolbar). Space + drag also pans; right-drag pans.
- **Place** menu (or hotkeys `4`–`9`, `B`, `E`, `K`, `O`, `L`, `S`) drops transistors, rails, I/O, probes, **bus probes**, **bus switches** (DIP paddles — click a bit to toggle; click the readout to step +1), labels, clocks, analyzers, **7-seg**.
- **Wire** tool: click pin → click pin (smart ortho route). Click empty for bends; click a wire/bend to place a **node** (T-junction) and branch. Delete a node heals the through-wire and drops only branch stubs. Esc backs up a bend or cancels.
- **T** tidies selected wires (orthogonal route). Arrow keys nudge selection by one grid; after nudge, attached wires tidy.
- Context **Wire matching / bus pins** also ribbons a chip to selected **Input/Button** banks (sorted by Y → `d0`/`q0`/`b0`…). Ribbon wires get a cosmetic `bundleId` (thicker bus stroke).
- Auto-routing can still pick awkward paths around bodies — use manual bends or **T**; algorithm notes for a future stand: [`docs/wire-routing.md`](./docs/wire-routing.md).

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

## Help

- **Help → Lab manual…** — full Soft Lab + Spectrum guide with screenshots (Logic analyzer, Load images, demos, tape, pad, debug). Update it when features change (`src/ui/LabManual.ts` + `src/assets/help/` + `scripts/capture-lab-help*.mts`).
- Press **?** or Help → Keyboard shortcuts… for the cheat sheet.
- **Help → Tutorial…** — button→LED→wire→toggle (clears canvas if needed). **Tutorial (latch)…** / **Tutorial (lab counter)…** load those examples. **Lab course…** opens the checklist ladder.
- **Ctrl+Z** / **Ctrl+Y** undo / redo. **Ctrl+F** find, **Ctrl+R** rename net, **Ctrl+C/V/D** copy / paste / duplicate. **Ctrl+Shift+V** or Edit → **Stamp×N…** pastes a grid of copies.
- Minimap (bottom-right) pans the view; press **=** to hide/show it.
