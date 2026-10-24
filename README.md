# SwitchLab

**Transistor-level schematic editor** with live switch-level simulation, foldable chips, a Soft Lab digital pack, and an optional soft Z80 machine (TTY, ZX Spectrum, CP/M) — all in the browser.

---

### Try it in the browser

**Live build (GitHub Pages):**  
**https://ashevchuk.github.io/switchlab/**

| Demo deep-link | What it loads |
|----------------|---------------|
| [`#e=lab-counter-7seg`](https://ashevchuk.github.io/switchlab/#e=lab-counter-7seg) | Soft Lab counter → BCD → 7-seg |
| [`#e=cmos-inverter`](https://ashevchuk.github.io/switchlab/#e=cmos-inverter) | Button → CMOS inverter → LED |
| [`#e=lab-alu4`](https://ashevchuk.github.io/switchlab/#e=lab-alu4) | 4-bit ALU bench |
| [`#demo=rainbow`](https://ashevchuk.github.io/switchlab/#demo=rainbow) | Soft Spectrum 48K + rainbow demo |
| [`#demo=glazx`](https://ashevchuk.github.io/switchlab/#demo=glazx) | Soft Spectrum TAP demo (GLAZX) |

> **Hosted build:** the live site is the `gh-pages` branch (a publish of `dist-file/`).  
> Refresh it after routing/UI changes with `npm run build:dist-file` and a force-push to `gh-pages` (see [Publishing](#publishing--github-pages)).

Offline / double-click: `npm run build:dist-file` then open `dist-file/index.html` (`file://` works; Spectrum Worker falls back to the main thread on `file://`).

---

## Table of contents

1. [Screenshots](#screenshots)
2. [What you can build](#what-you-can-build)
3. [Getting started](#getting-started)
4. [Editor basics](#editor-basics)
5. [Soft Lab](#soft-lab)
6. [Simulation](#simulation)
7. [Soft Z80 / Spectrum](#soft-z80--spectrum)
8. [Examples & share links](#examples--share-links)
9. [Scripts](#scripts)
10. [Repository layout](#repository-layout)
11. [Docs map](#docs-map)
12. [Third-party / licenses](#third-party--licenses)
13. [Publishing / GitHub Pages](#publishing--github-pages)

---

## Screenshots

### Soft Lab chrome

![Main chrome with Soft Lab on](src/assets/help/01-chrome-soft-lab.png)

*Menubar, tools, Soft Lab toggle, Run/Pause/Step, net/contention status.*

![Help menu](src/assets/help/35-menu-help.png)

*Help → Lab manual…, Lab course…, tutorials, keyboard shortcuts.*

### Place, wire, fold

![Wire tool](src/assets/help/21-wire-tool-ready.png)

*Wire tool armed — pin→pin uses channel ortho routing (escape → rails → tidy).*

![CMOS inverter](src/assets/help/03-cmos-inverter.png)

*Button → CMOS inverter → LED/probe with live wire levels.*

![Folded AND chip](src/assets/help/04-and-gate-chip.png)

*Library stdcell as a folded instance on the canvas.*

![Chip dive](src/assets/help/05-chip-dive-internals.png)

*Double-click / Inspector → Dive to edit chip internals; breadcrumb climbs out.*

### Soft Lab examples

![Counter + 7-seg (Soft ON)](src/assets/help/07-counter-7seg-soft.png)

*`lab-counter-7seg` — COUNTER4 / BCD_7SEG with Soft Lab badges and tidy ribbon buses.*

![Counter Soft OFF](src/assets/help/08-counter-soft-off.png)

*Same circuit with Soft Lab off (full transistor expand — heavier).*

![Adder + DIP bus switches](src/assets/help/09-adder-bus-switch.png)

*`lab-adder4` — DIP4 bus switches into ADDER4, bus probe + LEDs.*

![ALU4](src/assets/help/10-alu4.png)

*`lab-alu4`.*

![BUF8 OE](src/assets/help/11-buf8-oe.png)

*`lab-buf8-oe` — multi-bit bus with OE.*

![Soft RAM](src/assets/help/13-soft-ram.png)

*`lab-soft-ram`.*

![Mini CPU](src/assets/help/14-mini-cpu.png)

*`lab-mini-cpu` — small Soft Lab CPU sketch.*

![JK flip-flop](src/assets/help/25-jk-ff.png)

*`lab-jk`.*

![REG8](src/assets/help/26-reg8.png)

*`lab-reg8`.*

![MUX](src/assets/help/27-mux.png)

*`lab-mux`.*

### Contention & instruments

![Bus contention](src/assets/help/28-contention-bus.png)

*Two BUF8 drivers fighting — status shows `contended`, wires heat-pulse.*

![Logic analyzer circuit](src/assets/help/39-lab-analyzer-circuit.png)

*`lab-analyzer` on the canvas.*

![Logic analyzer window](src/assets/help/40-logic-analyzer-window.png)

*Floating Logic Analyzer — Arm/Run, triggers, channel labels.*

![Analyzer with waveforms](src/assets/help/41-analyzer-with-waveforms.png)

*Waveforms over the live circuit.*

### Soft Spectrum

![Spectrum machine panel](src/assets/help/37-spectrum-machine.png)

*Place → Spectrum 48K/128K — soft ULA screen, media bar, pad, debug.*

![Demo loaded](src/assets/help/50-spectrum-demo-loaded.png)

*Bundled TAP/SNA demo after load (e.g. GLAZX).*

![Spectrum media bar](src/assets/help/43-spectrum-media-bar.png)

*Load .SNA / .Z80 / .TAP, demos, save snapshots.*

![On-screen pad](src/assets/help/48-spectrum-pad-keys.png)

*Kempston / Cursor / Sinclair / WASD pad.*

### Menus & library

![Place menu](src/assets/help/31-menu-place.png)

![Library Lab filter](src/assets/help/02-library-lab-filter.png)

![Lab course panel](src/assets/help/23-lab-course-panel.png)

*Help → Lab course… — checklist ladder from CMOS to analyzer.*

![ROM viewer](src/assets/help/38-rom-viewer.png)

*`rom-viewer` example — behavioral ROM on the canvas.*

In-app gallery (same images): **Help → Lab manual…**.

---

## What you can build

| Layer | Contents |
|-------|----------|
| **Devices** | MOSFETs, VCC/GND sources, buttons, LEDs, probes, clocks, 7-seg, labels, junctions |
| **Stdcells** | NOT / NAND / AND / NOR / OR / XOR, muxes, adders, latches, flip-flops |
| **Soft Lab pack** | COUNTER4/8, REG, SHIFT/SIPO, decoders, COMP, BCD→7seg, BUF, ADDER4/8, ALU4/8, SOFT_RAM16, 74xx aliases |
| **Hierarchy** | Fold selection into reusable chips (`Ctrl+G`), dive to edit, Library palette |
| **Soft machines** | Soft Z80 + 64K RAM, memory-mapped TTY, ZX Spectrum 48K/128K (ULA screen, AY, tape), CP/M disks |
| **Instruments** | Logic analyzer (Arm, triggers, CSV/VCD/PNG), watch list, bus probes / DIP bus switches |

Solver is a **switch-level** relaxation engine over transistors (not a gate-only logic sim). Soft Lab chips can run as fast behavioral models while Soft Lab is on; turn it off (or force-expand one def) to flatten to transistors.

---

## Getting started

```bash
git clone https://github.com/ashevchuk/switchlab.git
cd switchlab
npm install
npm run dev
```

Open the URL Vite prints (typically `http://127.0.0.1:5173`).

**Single-file / static host build:**

```bash
npm run build:dist-file
# → dist-file/index.html + app.js + spectrum-worker.js
```

Serve locally: `npx --yes serve dist-file -l 4173`.

---

## Editor basics

### Tools & place

- Toolbar / keys: **`1`** select, **`2`** pan, **`3`** wire (Space+drag also pans).
- **Place** menu (or hotkeys `4`–`9`, `B`, `E`, `K`, `O`, `L`, `S`, …) drops primitives and instruments.
- **Library** (`Ctrl+L`) — search + filters **Gates / Lab / 74xx / User**.

### Wires

- Wire tool: pin → pin (channel orthogonal route). Empty clicks add bends; click a wire/bend for a **T-junction** node.
- **`T`** tidies selection (or wires on selected chips): escape channels, ribbon rails, rip-up, keeps safe manual bends; after a chip drag, mouseup rebuilds quality routes while mid-drag keeps the far stub live.
- Context **Wire matching / bus pins** ribbons chip↔chip or chip↔button banks (`qN`↔`dN`/`bN`, …).

### Orient & hierarchy

- **`R` / `⇧R`** rotate, **`M` / `⇧M`** flip (multi-select supported).
- **`Ctrl+G`** fold, **`Ctrl+⇧G`** unfold. Double-click chip or Inspector → **Dive**.
- Inspector docks to the **left** by default (resizable; **Dock / Undock** in the title bar; preference saved).

### Sessions

- Autosave into browser session slots (**File → Switch / New / Rename session**).
- **File → Demo ▸** (Digital / Lab I/O / Spectrum) or URL `#e=id`. **File → Copy share link** → `#p=…`.
- Export/import project or chip JSON; **Export PNG… / SVG…**.

Full shortcut list: press **`?`** or Help → Keyboard shortcuts….

---

## Soft Lab

Toolbar **Soft Lab** (default **on**) evaluates Pack A/B labcells (and nested 74xx aliases) behaviorally for interactive speed. Soft chips show a **SOFT** badge; sequential state can show **q hex** in the inspector.

| Soft Lab ON | Soft Lab OFF |
|-------------|--------------|
| Fast behavioral COUNTER / REG / ALU / … | Full transistor flatten via `flatten()` |
| Dive still works | Heavier nets / slower UI on large benches |

- **Help → Lab course…** — guided ladder (CMOS → latch → counter → ALU → Soft RAM → contention → mini-CPU → analyzer).
- Inspector → **Force transistor expand** expands one ChipDef this session while Soft Lab stays on.
- Inspector → **Diff soft vs silicon** snapshots Soft `q`, expands, settles, and reports bit diffs.

---

## Simulation

- Solver runs while the circuit is unsettled.
- **Run / Pause / Step** — Pause freezes ticks; Step advances one tick (and one soft-CPU instruction when a machine is attached).
- Status: flat nets, iterations, settled, **contended** (click when > 0 to highlight). Contended wires pulse.
- Net labels **VCC** / **GND** power rails without Source parts.
- Logic Analyzer: Arm/Pause, dual cursors, optional edge trigger, CSV / VCD / PNG export.

---

## Soft Z80 / Spectrum

**Place → Spectrum 48K… / 128K…** drops soft CPU + RAM, opens the machine panel, and boots soft Spectrum.

- **Demos:** `#demo=rainbow`, `glazx`, `egghead`, `ay-beep`, … (auto-place + load).
- **Snapshots:** Load/Save `.SNA` / `.Z80`; **Copy SNA link** → `#sna=…` (deflate).
- **Tape:** `.TAP` / `.TZX` flash-load (`LOAD ""`); browser + auto-type for bundled TAPs.
- **TR-DOS\***: mount `.TRD`, page Beta ROM — soft sector R/W (not full WD1793 timing).
- Screen focus + on-screen pad (Kempston / Cursor / Sinclair / WASD). Hold **Space** on BASIC PAUSE.
- Soft Spectrum prefers a **Worker** (`spectrum-worker.js`); on `file://` Chromium blocks Workers → main-thread fallback.
- Also from the panel: Boot BASIC / CP/M / soft stub, Spec× speed, Mute AY/beeper, NMI, breakpoints, Step Over.

---

## Examples & share links

| Hash | Meaning |
|------|---------|
| `#e=<id>` | Built-in example (`lab-counter-7seg`, `cmos-inverter`, `d-latch`, …) |
| `#p=…` | Shared project blob |
| `#demo=<id>` | Soft Spectrum bundled demo |
| `#sna=…` | Shared Spectrum snapshot |

Empty canvas skips replace-confirm for `#e=` / `#p=` / demos.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server |
| `npm test` | Vitest unit suite |
| `npm run test:routing` | Wire-routing stand fixtures |
| `npm run test:spectrum-play` | Spectrum playability + IM2 / demo hints |
| `npm run build` | `tsc` + Vite production build |
| `npm run build:dist-file` | Static `dist-file/` (IIFE + `spectrum-worker.js`) for Pages / `file://` |
| `npm run gen:examples` | Regenerate `examples/*.json` |
| `npm run gen:spectrum-games` | Embed freeware TAP/SNA from `third_party/spectrum/games/` |
| `npx playwright test` | E2E against `dist-file/` (builds first via `test:e2e`) |

**Refresh Lab-manual screenshots** (dev or Pages host):

```bash
npm run build:dist-file && npx --yes serve dist-file -l 4173
HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help.mts
HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-extra.mts
HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-menus.mts
HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-deep.mts
```

---

## Repository layout

```
src/sim/          Simulation core (Circuit, solver, library, hierarchy, Soft Lab)
src/ui/           Editor, Renderer, instruments, Lab manual, Inspector
src/machine/      Soft Z80 / Spectrum / CP/M runners + Worker host
src/assets/help/  Lab-manual screenshots (used in README + in-app manual)
examples/         Built-in project JSON (`#e=…`)
stands/wire-routing/  Routing fixtures + vitest stand
scripts/          capture-lab-help*, gen-examples, build-dist-file, …
third_party/      Spectrum ROMs/games, CP/M disks (see READMEs)
dist-file/        Generated static app (gitignored; published on `gh-pages`)
```

---

## Docs map

| Doc | Audience |
|-----|----------|
| **[README.md](./README.md)** (this file) | Overview, screenshots, try-in-browser |
| **[USER.md](./USER.md)** | Day-to-day editor / Soft Lab / Spectrum guide |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Engine, Z80 gate CPU, Soft Lab, machines (deep) |
| **[docs/wire-routing.md](./docs/wire-routing.md)** | Channel router notes + stand |
| In-app **Help → Lab manual…** | Same screenshots + curriculum map |

---

## Third-party / licenses

**SwitchLab source** (this repository, excluding `third_party/`) is licensed under the **[MIT License](./LICENSE)**.

Bundled firmware and disk images keep their upstream terms:

- **`third_party/spectrum/`** — ZX Spectrum ROMs (Amstrad permission for emulator redistribution) + freeware games under `games/`. See [`third_party/spectrum/README.md`](./third_party/spectrum/README.md).
- **`third_party/cpm/`** — CP/M 2.2 + rogue disks via z80pack heritage; educational/non-commercial redistribution. See [`third_party/cpm/README.md`](./third_party/cpm/README.md).

---

## Publishing / GitHub Pages

**Live app:** https://ashevchuk.github.io/switchlab/

The static build is published from the **`gh-pages`** branch (contents of `dist-file/`: `index.html`, `app.js`, `spectrum-worker.js`). Relative `base: './'` keeps assets working under the project subpath.

### Refresh the hosted build

```bash
npm run build:dist-file
# copy dist-file/* onto an orphan/local gh-pages worktree and force-push:
rm -rf /tmp/switchlab-gh-pages && mkdir -p /tmp/switchlab-gh-pages
cp -a dist-file/. /tmp/switchlab-gh-pages/
cd /tmp/switchlab-gh-pages && git init && git checkout -b gh-pages
git add -A && git commit -m "Publish dist-file build for GitHub Pages."
git remote add origin https://github.com/ashevchuk/switchlab.git
git push -f origin gh-pages
```

Repo settings: **Pages → Deploy from a branch → `gh-pages` / root**.

Local parity check:

```bash
npm run build:dist-file
npx --yes serve dist-file -l 4173
# open http://127.0.0.1:4173/
```
