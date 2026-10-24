/**
 * In-app user manual (Help → Lab manual…).
 * Screenshots: src/assets/help/ — refresh via scripts/capture-lab-help*.mts
 */

import { FloatingWindow } from './FloatingWindow.js';
import { LAB_CURRICULUM } from './LabCurriculum.js';

import img01 from '../assets/help/01-chrome-soft-lab.png';
import img02 from '../assets/help/02-library-lab-filter.png';
import img03 from '../assets/help/03-cmos-inverter.png';
import img04 from '../assets/help/04-and-gate-chip.png';
import img05 from '../assets/help/05-chip-dive-internals.png';
import img06 from '../assets/help/06-d-latch.png';
import img07 from '../assets/help/07-counter-7seg-soft.png';
import img08 from '../assets/help/08-counter-soft-off.png';
import img09 from '../assets/help/09-adder-bus-switch.png';
import img10 from '../assets/help/10-alu4.png';
import img11 from '../assets/help/11-buf8-oe.png';
import img12 from '../assets/help/12-contend-bus.png';
import img13 from '../assets/help/13-soft-ram.png';
import img14 from '../assets/help/14-mini-cpu.png';
import img15 from '../assets/help/15-analyzer.png';
import img16 from '../assets/help/16-sipo.png';
import img17 from '../assets/help/17-decoder.png';
import img18 from '../assets/help/18-nand-gate.png';
import img19 from '../assets/help/19-half-adder.png';
import img20 from '../assets/help/20-xor-pulse.png';
import img21 from '../assets/help/21-wire-tool-ready.png';
import img22 from '../assets/help/22-help-menu.png';
import img23 from '../assets/help/23-lab-course-panel.png';
import img24 from '../assets/help/24-place-menu.png';
import img25 from '../assets/help/25-jk-ff.png';
import img26 from '../assets/help/26-reg8.png';
import img27 from '../assets/help/27-mux.png';
import img28 from '../assets/help/28-contention-bus.png';
import img29 from '../assets/help/29-contention-soft-ram.png';
import img30 from '../assets/help/30-menu-file.png';
import img31 from '../assets/help/31-menu-place.png';
import img32 from '../assets/help/32-menu-insert.png';
import img33 from '../assets/help/33-menu-edit.png';
import img34 from '../assets/help/34-menu-view.png';
import img35 from '../assets/help/35-menu-help.png';
import img36 from '../assets/help/36-menu-library.png';
import img37 from '../assets/help/37-spectrum-machine.png';
import img38 from '../assets/help/38-rom-viewer.png';
import img39 from '../assets/help/39-lab-analyzer-circuit.png';
import img40 from '../assets/help/40-logic-analyzer-window.png';
import img41 from '../assets/help/41-analyzer-with-waveforms.png';
import img42 from '../assets/help/42-spectrum-panel.png';
import img43 from '../assets/help/43-spectrum-media-bar.png';
import img44 from '../assets/help/44-spectrum-slots-nmi.png';
import img45 from '../assets/help/45-spectrum-debug.png';
import img46 from '../assets/help/46-spectrum-poke.png';
import img47 from '../assets/help/47-spectrum-tape.png';
import img48 from '../assets/help/48-spectrum-pad-keys.png';
import img49 from '../assets/help/49-spectrum-console-load.png';
import img50 from '../assets/help/50-spectrum-demo-loaded.png';
import img51 from '../assets/help/51-spectrum-demo-list.png';

type Figure = { src: string; caption: string };

type Section = {
  id: string;
  title: string;
  body: string;
  figures?: Figure[];
};

/** Tree sidebar: groups expand/collapse; leaves open a section. */
type NavNode =
  | { kind: 'group'; id: string; title: string; children: NavNode[] }
  | { kind: 'leaf'; id: string; title: string };

function courseMap(): string {
  return LAB_CURRICULUM.map((s, i) => `${i + 1}. ${s.title} (\`${s.id}\`) — ${s.blurb}`).join('\n');
}

const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'Overview',
    body:
      'SwitchLab combines a transistor-level schematic editor, Soft Lab digital chips, and an optional soft Z80 / Spectrum machine.\n\n' +
      'Use the tree on the left. Drag the window corner to resize.\n\n' +
      'Quick paths:\n' +
      '  • Digital Soft Lab → Lab course / Tutorial (lab counter)\n' +
      '  • Soft Lab → Logic analyzer (waveforms + screenshots)\n' +
      '  • Menus → File / Place / Insert… (every menubar command)\n' +
      '  • Soft machine → Spectrum load images / demos / tape / controls\n\n' +
      'Toolbar: Select · Pan · Wire · Run / Pause / Step · Soft Lab (yellow = on).',
    figures: [
      { src: img01, caption: 'Main chrome: Soft Lab on, Run, status (nets / settled / contended).' },
      { src: img35, caption: 'Help menu — open this Lab manual anytime.' },
    ],
  },

  // ——— Menus ———
  {
    id: 'menu-file',
    title: 'File menu',
    body:
      'File manages projects, chips, pictures, and browser sessions.\n\n' +
      'Project:\n' +
      '  • Export project… — download top circuit + all chip defs as one JSON.\n' +
      '  • Copy share link — clipboard URL with #p=… (open to load; confirms if canvas not empty).\n' +
      '  • Import project… — replace the whole session from JSON.\n' +
      '  • Demo ▸ — Digital schematics (gates / Soft Lab / ROM, also `#e=id`), Lab I/O Soft machines, Spectrum.\n' +
      '    Empty canvas skips confirm for #e=/#p=.\n\n' +
      'Chips:\n' +
      '  • Export chip… — select one chip instance → download its def + dependencies.\n' +
      '  • Export selection as chip… (Ctrl+Shift+E) — fold selection and download JSON.\n' +
      '  • Import chip… — add a chip JSON into this session’s Library palette.\n\n' +
      'Images:\n' +
      '  • Export PNG… / Export SVG… — snapshot the current schematic view.\n\n' +
      'Sessions (browser storage, autosave):\n' +
      '  • Switch session… / Rename session… / New session… (max slots — see dialog).\n' +
      '  • Status “Changed elsewhere” if another tab wrote the same slot.\n\n' +
      'Danger zone:\n' +
      '  • Clear circuit… — wipe this hierarchy level.\n' +
      '  • Reset all sessions… — clear every slot and reload the demo schematic.',
    figures: [{ src: img30, caption: 'File menu — project, chip, PNG/SVG, sessions, clear/reset.' }],
  },
  {
    id: 'menu-place',
    title: 'Place menu',
    body:
      'Place arms a tool; click the canvas to drop parts. Hotkeys in parentheses.\n\n' +
      'Transistors & rails:\n' +
      '  N-MOS (4), P-MOS (5), VCC (6), GND (7).\n\n' +
      'Drivers & I/O:\n' +
      '  Input (8) — sticky 0/1. Port (O) — chip pin when folding; Shift+O names / bus D[7:0].\n' +
      '  Button (B) — momentary (hold mouse) / toggle. Switch / Pass switch… — same modes in inspector.\n' +
      '  LED (E). 7-seg (S). Probe (9). Net label (L).\n\n' +
      'Instruments:\n' +
      '  Pulse generator (K) — OUT + TRIG.\n' +
      '  Logic analyzer… — multi-channel capture (see Soft Lab → Logic analyzer).\n' +
      '  Bus probe… — hex/dec/bin readout (asks width).\n' +
      '  Bus switch… — DIP/hex writable bus (width 4 or 8); toggle or momentary (hold) paddles.\n' +
      '  Pass switch… — bank of SPST poles (aᵢ↔bᵢ); toggle or hold.\n' +
      '  TTY console — soft-machine console / Spectrum UI host.\n\n' +
      'Select tool: click Button/Clock/Switch to interact; double-click Analyzer or chip to open/dive.',
    figures: [
      { src: img31, caption: 'Place menu — primitives through instruments.' },
      { src: img24, caption: 'Place open on a Soft Lab bench.' },
    ],
  },
  {
    id: 'menu-insert',
    title: 'Insert menu',
    body:
      'Insert drops larger prebuilt blocks (prompts for width / program as needed).\n\n' +
      'Datapath blocks:\n' +
      '  Register…, ALU…, Program counter…, Instruction register, Control FSM…\n\n' +
      'Memory:\n' +
      '  ROM… — behavioral ROM, OE-gated read, editable in Memory panel (address bits + optional hex).\n' +
      '  Stub ROM… — fixed transistor stub ROM (decoder + tri-state), no live storage.\n' +
      '  RAM… — real R/W memory: read while OE=1, write on WE&CLK edge.\n\n' +
      'CPUs / machines:\n' +
      '  Tiny CPU… — teaching CPU (PC+RAM+IR+ACC+ALU + FETCH FSM).\n' +
      '  Z80 CPU… — Z80-opcode soft/gate CPU + RAM (asks addr bits + program bytes).\n' +
      '  Spectrum 48K… / 128K… — Z80 + 64K RAM, opens machine panel, boots soft Spectrum.\n' +
      '  (Ready-to-run machines live under File → Demo…; Insert keeps building blocks.)\n\n' +
      'See Soft machine → Spectrum chapters for boot, load images (.SNA/.Z80/.TAP…), demos, tape, pad, and debug.',
      figures: [
      { src: img32, caption: 'Insert menu — Register/ALU/PC, ROM/RAM, Z80. Demos under File → Demo.' },
      { src: img38, caption: 'rom-viewer example — behavioral ROM on the canvas.' },
    ],
  },
  {
    id: 'menu-library',
    title: 'Library menu',
    body:
      'Library lists every ChipDef in this session. Ctrl+L focuses search.\n\n' +
      'Filters:\n' +
      '  Gates — NOT NAND AND NOR OR XOR MUX2 MUX2_TG MUX4 HALF_ADDER FULL_ADDER D_LATCH D_FF TRI_BUF\n' +
      '  Lab — Soft Lab packs (COUNTER, REG, ALU, BUF8, SOFT_RAM16, …)\n' +
      '  74xx — 7400-family aliases\n' +
      '  User — chips you folded\n\n' +
      'Click a row → place-chip tool → click canvas.\n' +
      'Loading a new example resets the tool to Select (avoids stale chip ids after Lab course).',
    figures: [
      { src: img36, caption: 'Library menu with tag filters.' },
      { src: img02, caption: 'Lab filter listing Soft Lab chips.' },
    ],
  },
  {
    id: 'menu-edit',
    title: 'Edit menu',
    body:
      '  • Fold selection… (Ctrl+G) — turn selection into a reusable chip (need Ports on exposed nets).\n' +
      '  • Unfold chip… (Ctrl+Shift+G) — explode selected instance(s) back into this level.\n' +
      '  • Find… (Ctrl+F) — jump to net / port / chip / label.\n' +
      '  • Rename net… (Ctrl+R) — name or merge via a label.\n' +
      '  • Duplicate (Ctrl+D) — copy selection with offset.\n' +
      '  • Stamp×N… (Ctrl+Shift+V) — grid of N copies.\n\n' +
      'Also: Ctrl+Z / Ctrl+Y undo/redo, Delete removes selection, T tidies wires.',
    figures: [{ src: img33, caption: 'Edit menu — fold/unfold, find, rename, duplicate, stamp.' }],
  },
  {
    id: 'menu-view',
    title: 'View menu',
    body:
      '  • Watch list… — pin watch strip; Ctrl+W adds hovered/selected pin.\n' +
      '  • I/O map… — soft machine memory / I/O map (when a machine is attached).\n' +
      '  • Toggle minimap (=) — show/hide the overview map.\n\n' +
      'Zoom: toolbar − / + / 1:1 / fit, or mouse wheel. Space+drag or Pan tool to pan.',
    figures: [{ src: img34, caption: 'View menu — Watch list, I/O map, minimap.' }],
  },
  {
    id: 'menu-help',
    title: 'Help menu',
    body:
      '  • Keyboard shortcuts… (?) — cheat sheet overlay.\n' +
      '  • Lab manual… — this window.\n' +
      '  • Tutorial… — button → LED → wire → toggle (may clear canvas).\n' +
      '  • Tutorial (latch)… — load d-latch + walkthrough.\n' +
      '  • Tutorial (lab counter)… — load lab-counter-7seg, Soft Lab on.\n' +
      '  • Lab course… — checklist ladder (Next/Prev loads examples).',
    figures: [
      { src: img35, caption: 'Help menu.' },
      { src: img23, caption: 'Lab course panel after Help → Lab course…' },
    ],
  },

  // ——— Soft Lab ———
  {
    id: 'soft-lab',
    title: 'Soft Lab toggle',
    body:
      'Toolbar Soft Lab (default ON; localStorage simcpu.softLab.v1).\n\n' +
      'ON — matching chips stay opaque; solver uses behavioral models (fast). SOFT badge + optional q hex\n' +
      '    only while Soft-opaque (hidden when dive/inspector force-expands that ChipDef to silicon).\n' +
      'OFF — expand to gates/transistors (slow; teaching CMOS).\n\n' +
      'Soft ↔ Gates resets soft sequential state and sim levels. Soft → Gates also runs a short POR that\n' +
      'forces sequential Q low (and QN high) for a few solver steps so silicon leaves Z without pulsing\n' +
      'Clear — counters/regs restart at 0. Leaving a Soft Lab dive likewise resets soft state so lastClk/q\n' +
      'do not freeze the Soft exterior.\n\n' +
      'Inspector on a Soft chip:\n' +
      '  Force transistor expand / Use Soft Lab again · Diff soft vs silicon · edit q hex · Reset soft state.\n' +
      'SOFT_RAM16 requires Soft Lab ON (no silicon body).',
    figures: [
      { src: img07, caption: 'Soft ON — COUNTER4 / BCD_7SEG with SOFT badges.' },
      { src: img08, caption: 'Same circuit with Soft Lab OFF (expanded / heavier).' },
    ],
  },
  {
    id: 'wiring',
    title: 'Wiring, routing, junctions',
    body:
      'Wire tool (3):\n' +
      '  1. Click start pin. 2. Optional empty-canvas bends (Esc undoes). 3. Click end pin — smart ortho route.\n' +
      '  T tidies selection. G cycles snap.\n\n' +
      'Junctions: click a wire/bend while wiring to branch (T-node). Delete junction heals the through-wire.\n' +
      'Cosmetic H×V dots are not connections.\n\n' +
      'Context (multi-select): Ribbon bus switch → chip · Wire matching / bus pins (q↔d/b, Y-ordered banks).\n' +
      'H highlight net · Ctrl+R rename.',
    figures: [
      { src: img21, caption: 'Wire tool armed.' },
      { src: img03, caption: 'Orthogonal CMOS nets with live levels.' },
      { src: img11, caption: 'Multi-bit buses (BUF8 OE example).' },
    ],
  },
  {
    id: 'build-chip',
    title: 'Build a chip (fold)',
    body:
      '1. Build & test a netlist. 2. Place Ports on exposed nets (Shift+O for buses).\n' +
      '3. Select internals + ports → Ctrl+G / Edit → Fold — name the chip.\n' +
      '4. Library → place instances. 5. Double-click to dive; Esc / breadcrumb out.\n' +
      '6. Yellow edited badge → Update from library. Unfold: Ctrl+Shift+G.',
    figures: [
      { src: img04, caption: 'Folded AND instance.' },
      { src: img05, caption: 'Dive — chip internals.' },
      { src: img19, caption: 'half-adder — library cells.' },
    ],
  },
  {
    id: 'memory',
    title: 'Latches, FFs, registers',
    body:
      'D latch: Tutorial (latch) or course step — toggle D, pulse EN, Q holds; dive for gates.\n' +
      'Soft pack: SR_LATCH, JK_FF, T_FF, REG4/8, LATCH8/74373, SHIFT SIPO/PISO.',
    figures: [
      { src: img06, caption: 'D_LATCH walkthrough.' },
      { src: img25, caption: 'lab-jk.' },
      { src: img26, caption: 'lab-reg8.' },
    ],
  },
  {
    id: 'datapath',
    title: 'Counters, ALU, decode, mux',
    body:
      'COUNTER4/8 (ce/clr/load/co) · ADDER/ALU · DECODER/ENCODER/COMP · MUX/DEMUX · SIPO/PISO.\n' +
      'Tutorial (lab counter): COUNTER4 → BCD_7SEG → 7SEG + pulse. Clear off to count.',
    figures: [
      { src: img07, caption: 'Counter + 7-seg.' },
      { src: img10, caption: 'lab-alu4.' },
      { src: img09, caption: 'lab-adder4 + bus switches.' },
      { src: img17, caption: 'lab-decoder.' },
      { src: img16, caption: 'lab-sipo.' },
      { src: img27, caption: 'lab-mux.' },
    ],
  },
  {
    id: 'bus-ram',
    title: 'Buses, OE, Soft RAM',
    body:
      'Bus switch: paddle = bit toggle; value click = +1. Select switch+chip → Ribbon bus switch → chip.\n' +
      'BUF8: oe gates outs (lab-buf8-oe). Dual OE on one bus → contention (see Shorts).\n' +
      'SOFT_RAM16: Soft ON; addr/data/we/oe/clk; write with OE=0 then OE=1 to read.',
    figures: [
      { src: img09, caption: 'DIP bus switches.' },
      { src: img13, caption: 'lab-soft-ram.' },
      { src: img14, caption: 'lab-mini-cpu.' },
    ],
  },
  {
    id: 'contention',
    title: 'Shorts & contention',
    body:
      'Contention = two strong drivers on one net at different levels. Status contended: N; wires heat-glow;\n' +
      'probes show X. Click status to jump.\n\n' +
      'lab-contend-bus: two BUF8, both OE — drop one OE.\n' +
      'Soft RAM: OE=1 + buttons ≠ stored data — OE=0 to write; OE=1 to read without fighting.',
    figures: [
      { src: img28, caption: 'Two BUF8 fighting — contended: 8.' },
      { src: img29, caption: 'Soft RAM OE vs buttons — contended: 4, BUS X bits.' },
    ],
  },
  {
    id: 'instruments',
    title: 'Pulse & Watch list',
    body:
      'Pulse generator (K):\n' +
      '  Place → Pulse generator. Modes continuous / oneshot. Run / Fire from Inspector.\n' +
      '  TRIG↑ starts continuous; TRIG↓ stops it. Oneshot: TRIG↑ fires one pulse (need ↓ then ↑ again).\n' +
      '  Example: xor-pulse — free-running clock into XOR.\n\n' +
      'Watch list (View → Watch list… / Ctrl+W):\n' +
      '  Pin nets while simulating. Bus rows: right-click → spawn bus probe or wire into an Analyzer.\n' +
      '  Optional break on contend / watch change (status / Inspector).\n\n' +
      'Logic Analyzer has its own chapter (next) with full screenshots.',
    figures: [
      { src: img20, caption: 'xor-pulse — free-running clock.' },
      { src: img15, caption: 'lab-analyzer example (see Logic analyzer).' },
    ],
  },
  {
    id: 'logic-analyzer',
    title: 'Logic analyzer',
    body:
      'Multi-channel digital capture for Soft Lab benches.\n\n' +
      'Place:\n' +
      '  1. Place → Logic analyzer… (or open #e=lab-analyzer).\n' +
      '  2. Wire signals into CH pins (ch0, ch1, …). Context: Add/Remove LA channel.\n' +
      '  3. Double-click the LA block (or select it) to open the Logic Analyzer window.\n\n' +
      'Capture:\n' +
      '  • Arm — start sampling while the sim runs (toolbar Run; clocks/buttons tick).\n' +
      '  • Pause / Clear — stop or wipe the buffer.\n' +
      '  • Trig + Edge — optional rise/fall/either on one channel (none = free-run).\n' +
      '  • Wheel — zoom sample density (history keeps width; does not crush into the window).\n' +
      '  • Drag / Shift+wheel — pan through the buffer; view follows live until you scroll back.\n' +
      '  • Resize the floating window (corner handle) · click cursor A · Shift-click cursor B.\n' +
      '  • Export CSV / VCD / PNG from the toolbar.\n\n' +
      'Tips:\n' +
      '  • Clock-lock Hz appears when a channel shares a net with a free-running pulse gen.\n' +
      '  • Watch-list bus rows can feed channels into an existing Analyzer.\n' +
      '  • lab-analyzer wires two buttons + CLK into A/B/CLK with rise trigger on CLK.',
    figures: [
      { src: img39, caption: 'lab-analyzer — buttons, CLK, LA on the canvas.' },
      { src: img40, caption: 'Logic Analyzer window — Arm, Trig, Edge, CSV/VCD/PNG.' },
      { src: img41, caption: 'Armed capture with waveforms (cursors A/B).' },
      { src: img15, caption: 'Same example after fit (overview).' },
    ],
  },
  {
    id: 'course',
    title: 'Lab course',
    body:
      'Help → Lab course… — checklists in sessionStorage. Next/Prev loads examples.\n\n' + courseMap(),
    figures: [
      { src: img23, caption: 'Lab course panel.' },
      { src: img03, caption: 'Step 1 CMOS.' },
      { src: img06, caption: 'Step 2 latch.' },
      { src: img07, caption: 'Step 3 counter.' },
    ],
  },

  // ——— Soft machine ———
  {
    id: 'rom-ram',
    title: 'ROM & RAM',
    body:
      'Insert → ROM…\n' +
      '  Asks address bits (and optional init hex). Behavioral: while OE=1, data = bytes[addr].\n' +
      '  Double-click RAM/ROM to open the Memory editor (hex grid + asm/disasm).\n' +
      '  Stub ROM… is a fixed transistor demo (not editable storage).\n\n' +
      'Insert → RAM…\n' +
      '  Real R/W array. Read: OE=1. Write: present data, WE=1 on rising CLK (check Inspector).\n' +
      '  Memory editor: Assemble → @ / Assemble + Go / live Disasm from cursor.\n\n' +
      'Soft Lab also has SOFT_RAM16 (Library → Lab) — Soft Lab ON only; see Buses / Soft RAM.\n\n' +
      'Example: File → Demo → Digital → ROM viewer, or #e=rom-viewer.',
    figures: [
      { src: img38, caption: 'rom-viewer — ROM on the schematic with drivers/probes.' },
      { src: img32, caption: 'Insert → ROM… / Stub ROM… / RAM…' },
    ],
  },
  {
    id: 'z80',
    title: 'Z80 CPU',
    body:
      'Insert → Z80 CPU…\n' +
      '  1. Choose RAM address bits (16 = 64K for Spectrum/CP/M-class soft machines).\n' +
      '  2. Optional program bytes (comma hex). Default can seed the command ROM path.\n' +
      '  3. A Z80CPU chip + RAM appear; attach TTY / open machine panel.\n\n' +
      'File → Demo → LED blink… places Z80 + ROM that OUT bit0 to port 0x40 (PORT_LAB_LED).\n' +
      'Soft Run mirrors that bit onto LAB_LED (forceOn) and pulses IORQ / IOWRITE /\n' +
      'IOREAD / M1 host probes.\n' +
      'Gates: LAB_LED_DECODE (iorq∧wr∧port 0x40∧D0) drives the LED; folded\n' +
      'Z80CPU exposes IORQ/M1/RD/WR/MREQ ports. Nested I/O = PHASE2+3 strobes;\n' +
      'INTACK = PHASE0+1 with IORQ∧M1 (ring stays at 10).\n\n' +
      'File → Demo → Port TTY… prints via OUT (01h),A into the host VT100 console\n' +
      '(PORT_TTY_OUT) — lab alternative to MMIO text FB. Soft and Gates both\n' +
      'feed SoftDevices on port OUT/IN.\n\n' +
      'File → Demo → Lab REG/COUNTER… OUT 0x41/0x42 onto Soft Lab REG8 / COUNTER4\n' +
      '(explicit bind — chips are placed and wired to SoftDevices paint).\n\n' +
      'Dblclick machine RAM → Memory editor: write Z80 asm at @, Disasm from cursor\n' +
      '(Follow PC highlights the soft PC line), Assemble + Go (soft JP + reboot).\n' +
      'Console asm box still works the same way.\n\n' +
      'Toolbar Speed: Soft (fast interpreter) vs Gates (transistor CPU — very slow).\n' +
      'Run / Pause / Step: Soft steps instructions; Gates steps solver ticks.\n\n' +
      'From the machine panel you can Boot BASIC / CP/M / stub, or boot Spectrum (see next).\n' +
      'View → I/O map… shows soft memory / port map when a machine is linked.',
    figures: [
      { src: img32, caption: 'Insert → Z80 CPU…; File → Demo → LED / Port TTY / Spectrum.' },
      { src: img37, caption: 'Machine panel after a soft Spectrum boot (Z80 + screen + controls).' },
    ],
  },
  {
    id: 'spectrum',
    title: 'Spectrum — boot & overview',
    body:
      'Fastest path: File → Demo → Spectrum 48K… or 128K…\n' +
      '  Drops Z80 + 64K RAM, opens the machine panel, boots soft ULA ROM, switches to Spectrum tab.\n\n' +
      'Or: Insert → Z80 CPU… (16 addr bits) → machine panel Console → Boot Spectrum 48K / 128K.\n\n' +
      'Two tabs in the machine panel:\n' +
      '  • Spectrum — screen, media bar (.SNA/.TAP/…), pad, tape, poke, regs (use this daily).\n' +
      '  • Console — Boot Spectrum / Load .SNA / TAP / demos + soft TTY / CP/M for non-Spectrum work.\n\n' +
      'Click the Spectrum screen so keys go to the emulated machine (not the schematic editor).\n' +
      'A focus tip appears if the editor stole WASD / arrows.\n\n' +
      'Next chapters: Load images · Demos · Tape · Controls · Debug.\n' +
      'URLs: #demo=rainbow (or glazx, egghead, ay-beep, …). #sna=… share snapshots.\n' +
      'file:// may block Workers — engine falls back to the main thread.',
    figures: [
      { src: img42, caption: 'Machine panel — Spectrum tab (rainbow smoke, coloured paper bands).' },
      { src: img37, caption: '#demo=rainbow — Spectrum panel ready (no overlays).' },
      { src: img32, caption: 'File → Demo → Spectrum 48K… / 128K…' },
      { src: img49, caption: 'Console tab — Boot Spectrum / Load .SNA / .Z80 / .TAP…' },
    ],
  },
  {
    id: 'spectrum-load',
    title: 'Spectrum — load images',
    body:
      'On the Spectrum tab media bar (or Console buttons with the same names):\n\n' +
      '.SNA — load a 48K or 128K snapshot (registers + RAM). Instant restore; CPU continues from the snap.\n' +
      '.Z80 — load a .Z80 snapshot (v1/v2/v3). Same idea as SNA with broader third-party support.\n' +
      '.SCR — poke 6912 bytes into the display file ($4000) only (picture, not a runnable program).\n' +
      '.TRD — mount a Beta Disk image for soft TR-DOS* (sector R/W stub — not full WD1793).\n\n' +
      'Save / share:\n' +
      '  • Save .SNA / .Z80 (Console) or .Z80↓ on Spectrum tab.\n' +
      '  • PNG / SCR — export the current screen bitmap.\n' +
      '  • #sna= — Copy SNA link (deflated URL hash). Open the link to restore.\n' +
      '  • Slots S1–S4 — Shift+click (or Shift+F6–F9) save · click (F6–F9) load — sessionStorage.\n\n' +
      '48 BASIC (128K) pages the editor ROM. TR-DOS* pages Beta Disk ROM (* = soft stub).\n' +
      'Reboot cold-starts ROM at $0000 and clears tape/snapshot CPU state (keeps Spectrum session).',
    figures: [
      { src: img43, caption: 'Media bar — .SNA .Z80 .TAP .TZX .SCR .TRD · Demo · #sna=.' },
      { src: img44, caption: 'Top bar — PNG/SCR, NMI, Over, slots S1–S4.' },
      { src: img49, caption: 'Console — Load .SNA / .Z80 / Save / Copy SNA link.' },
    ],
  },
  {
    id: 'spectrum-demos',
    title: 'Spectrum — demos & games',
    body:
      'Bundled freeware (no external download):\n\n' +
      '  1. Spectrum tab → Demo dropdown → pick an entry → Load\n' +
      '     (or Console → Demo → Load demo).\n' +
      '  2. Or open a URL: #demo=rainbow | glazx | egghead | egghead-space | homebrew | pzxl | ay-beep\n\n' +
      'TAP/TZX demos wait for BASIC ready then auto-type LOAD "" (with retry).\n' +
      'After load, the screen is focused and the pad may switch (e.g. GLAZX → WASD).\n' +
      'ay-beep is a 128K SNA (AY + beeper smoke). rainbow is a 48K attr-colour smoke (bright paper bands).\n\n' +
      'Page reload soft-reattaches 64K RAM and restores the last Spectrum model + bundled Demo\n' +
      '(MMU banks / tape position are not persisted — use Save .SNA / slots / #sna= for that).\n' +
      'Gates speeds need a freshly Placed Z80CPU; after reload only Soft is available until Place again.\n\n' +
      'Teach overlay on first #demo= explains the Spectrum tab — dismiss and use the media bar.',
    figures: [
      { src: img51, caption: 'Demo dropdown listing bundled TAP/SNA entries.' },
      { src: img50, caption: 'After #demo=glazx — game on screen (wait for auto LOAD "").' },
      { src: img37, caption: '#demo=rainbow — colour smoke (not a game).' },
    ],
  },
  {
    id: 'spectrum-tape',
    title: 'Spectrum — tape (TAP/TZX)',
    body:
      '.TAP — mount a tape image for BASIC LOAD "" (flash-load trap, not audio).\n' +
      '.TZX — same path for standard/turbo data blocks that the soft loader understands.\n\n' +
      'After mount:\n' +
      '  1. Ensure Spectrum is running (Run) and BASIC is ready (or use a Demo that auto-LOAD).\n' +
      '  2. Type LOAD "" (or let the demo auto-type).\n' +
      '  3. Use the Tape row: block list, Rewind, Next, Pause, Auto-stop, queue Clear.\n\n' +
      'Flash-load enables interrupts on exit (EI+RET). Hold a key briefly on BASIC PAUSE\n' +
      'if a quick tap seems ignored — tip overlay: “Hold Space”.',
    figures: [
      { src: img47, caption: 'Tape browser — blocks, Rewind/Next, Auto-stop, queue.' },
      { src: img43, caption: 'Media bar — .TAP / .TZX buttons.' },
    ],
  },
  {
    id: 'spectrum-controls',
    title: 'Spectrum — keys, pad, speed, audio',
    body:
      'Keyboard: click the screen, then type. On-screen Spectrum keyboard is also clickable.\n\n' +
      'Joystick / pad modes (cycle the mode button on the pad):\n' +
      '  Kempston · Cursor · Sinclair · WASD\n' +
      'GLAZX menus often use W/S and 0 to start unless you change controls in-game.\n\n' +
      'Toolbar / machine panel:\n' +
      '  • Spec× — soft ops/frame multiplier (frameskip at 4×+).\n' +
      '  • Mute — silence AY + beeper (128 AY via FFFD/BFFD).\n' +
      '  • Speed Soft vs Gates — Soft for Spectrum; Gates is the transistor CPU (very slow).\n\n' +
      'NMI → soft NMI vector $0066. Step Over skips CALL/RST bodies when debugging.',
    figures: [
      { src: img48, caption: 'On-screen keyboard + joystick pad.' },
      { src: img44, caption: 'NMI / Step Over / quick SNA slots.' },
      { src: img50, caption: 'Playable session with pad visible.' },
    ],
  },
  {
    id: 'spectrum-debug',
    title: 'Spectrum — debug, poke, cheats',
    body:
      'Debug row:\n' +
      '  • Watch $ — memory dump base (hex).\n' +
      '  • BP $ — break when PC hits address; Set BP / Clear BP.\n' +
      '  • BW $ — break on write to address.\n\n' +
      'Poke / cheats:\n' +
      '  • Poke $addr = $val → write one byte.\n' +
      '  • Presets: NMI, border black/white, force EI/DI (soft).\n' +
      '  • +Cheat / Apply cheats / Del — session poke list.\n\n' +
      'Live registers dump under the tape row (PC, SP, AF, …, IM, contend≈).\n' +
      'Health line: worker vs main thread · IM · contend · tape status.',
    figures: [
      { src: img45, caption: 'Watch / PC breakpoint / break-on-write.' },
      { src: img46, caption: 'Poke, presets, session cheats.' },
      { src: img42, caption: 'Full Spectrum panel including regs health.' },
    ],
  },
  {
    id: 'simulate',
    title: 'Run / Pause / Step & status',
    body:
      'Run / Pause / Step on the toolbar. Status: path · flat nets · iterations · settled · contended.\n' +
      'Contended > 0 is clickable. Orient: R/⇧R, M/⇧M, Alt+drag pin, arrows nudge.',
    figures: [
      { src: img01, caption: 'Run + Soft Lab; contended: 0.' },
      { src: img12, caption: 'Contention visible on status and wires.' },
    ],
  },
  {
    id: 'examples',
    title: 'Examples catalog',
    body:
      'File → Demo → Digital / #e=<id>\n\n' +
      'Foundations: cmos-inverter, nand-gate, and-gate, half-adder, d-latch, xor-pulse, rom-viewer\n' +
      'Soft Lab: lab-counter-7seg, lab-counter-cascade, lab-adder4, lab-alu4, lab-alu8, lab-soft-ram,\n' +
      '  lab-contend-bus, lab-mini-cpu, lab-sipo, lab-piso, lab-decoder, lab-encoder, lab-comp,\n' +
      '  lab-jk, lab-mux, lab-buf8-oe, lab-latch8, lab-reg8, lab-clkdiv, lab-analyzer\n\n' +
      'Tutorials: Help → Tutorial… / latch / lab counter. Machines: #demo=… / Spectrum Insert.',
    figures: [
      { src: img18, caption: 'nand-gate example.' },
      { src: img07, caption: 'lab-counter-7seg.' },
    ],
  },
];

const NAV_TREE: NavNode[] = [
  {
    kind: 'group',
    id: 'g-start',
    title: 'Getting started',
    children: [
      { kind: 'leaf', id: 'overview', title: 'Overview' },
      { kind: 'leaf', id: 'simulate', title: 'Run / Pause / Step' },
    ],
  },
  {
    kind: 'group',
    id: 'g-menus',
    title: 'Menus',
    children: [
      { kind: 'leaf', id: 'menu-file', title: 'File' },
      { kind: 'leaf', id: 'menu-place', title: 'Place' },
      { kind: 'leaf', id: 'menu-insert', title: 'Insert' },
      { kind: 'leaf', id: 'menu-library', title: 'Library' },
      { kind: 'leaf', id: 'menu-edit', title: 'Edit' },
      { kind: 'leaf', id: 'menu-view', title: 'View' },
      { kind: 'leaf', id: 'menu-help', title: 'Help' },
    ],
  },
  {
    kind: 'group',
    id: 'g-softlab',
    title: 'Soft Lab (digital)',
    children: [
      { kind: 'leaf', id: 'soft-lab', title: 'Soft Lab toggle' },
      { kind: 'leaf', id: 'wiring', title: 'Wiring & junctions' },
      { kind: 'leaf', id: 'build-chip', title: 'Build a chip' },
      { kind: 'leaf', id: 'memory', title: 'Latches & registers' },
      { kind: 'leaf', id: 'datapath', title: 'Counters & ALU' },
      { kind: 'leaf', id: 'bus-ram', title: 'Buses & Soft RAM' },
      { kind: 'leaf', id: 'contention', title: 'Shorts & contention' },
      { kind: 'leaf', id: 'instruments', title: 'Pulse & Watch list' },
      { kind: 'leaf', id: 'logic-analyzer', title: 'Logic analyzer' },
      { kind: 'leaf', id: 'course', title: 'Lab course' },
      { kind: 'leaf', id: 'examples', title: 'Examples catalog' },
    ],
  },
  {
    kind: 'group',
    id: 'g-machine',
    title: 'Soft machine',
    children: [
      { kind: 'leaf', id: 'rom-ram', title: 'ROM & RAM' },
      { kind: 'leaf', id: 'z80', title: 'Z80 CPU' },
      { kind: 'leaf', id: 'spectrum', title: 'Spectrum — boot' },
      { kind: 'leaf', id: 'spectrum-load', title: 'Load images' },
      { kind: 'leaf', id: 'spectrum-demos', title: 'Demos & games' },
      { kind: 'leaf', id: 'spectrum-tape', title: 'Tape TAP/TZX' },
      { kind: 'leaf', id: 'spectrum-controls', title: 'Keys & pad' },
      { kind: 'leaf', id: 'spectrum-debug', title: 'Debug & poke' },
    ],
  },
];

const sectionById = new Map(SECTIONS.map((s) => [s.id, s]));

export class LabManual {
  readonly win = new FloatingWindow('Lab manual', 'lab-manual-win');
  private nav: HTMLElement;
  private content: HTMLElement;
  private activeId = 'overview';
  private openGroups = new Set<string>(['g-start', 'g-menus', 'g-softlab', 'g-machine']);
  onOpenLabCourse: (() => void) | null = null;

  constructor() {
    this.win.root.style.width = 'min(96vw, 920px)';
    this.win.root.style.height = 'min(90vh, 880px)';
    this.injectStyles();

    const wrap = document.createElement('div');
    wrap.className = 'lab-manual';
    this.nav = document.createElement('nav');
    this.nav.className = 'lab-manual-nav';
    this.content = document.createElement('div');
    this.content.className = 'lab-manual-content';
    wrap.append(this.nav, this.content);
    this.win.body.appendChild(wrap);
    this.win.setVisible(false);
    this.renderNav();
    this.showSection(this.activeId);
  }

  open(sectionId?: string): void {
    this.win.setVisible(true);
    this.win.setTitle('Lab manual', 'User guide');
    if (sectionId && sectionById.has(sectionId)) this.showSection(sectionId);
    else this.showSection(this.activeId);
  }

  private injectStyles(): void {
    if (document.getElementById('lab-manual-css')) return;
    const style = document.createElement('style');
    style.id = 'lab-manual-css';
    style.textContent = `
      .float-win.lab-manual-win {
        width: min(96vw, 920px);
        height: min(90vh, 880px);
        min-width: 420px;
        min-height: 320px;
        max-width: min(98vw, 1100px);
        max-height: min(96vh, 960px);
        resize: both;
      }
      .float-win.lab-manual-win .float-win-body {
        padding: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1 1 auto;
        overflow: hidden;
      }
      .lab-manual {
        display: grid;
        grid-template-columns: minmax(180px, 220px) 1fr;
        min-height: 0;
        flex: 1;
        height: 100%;
      }
      .lab-manual-nav {
        border-right: 1px solid #2a3040;
        overflow: auto;
        padding: 6px 0 12px;
        background: #141820;
      }
      .lab-manual-nav .nav-group > .nav-group-btn,
      .lab-manual-nav .nav-leaf {
        display: block;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        color: #9aa3b5;
        font: 12px/1.35 ui-sans-serif, system-ui, sans-serif;
        padding: 5px 10px;
        cursor: pointer;
      }
      .lab-manual-nav .nav-group-btn {
        font-weight: 600;
        color: #c5cad6;
        letter-spacing: 0.02em;
      }
      .lab-manual-nav .nav-group-btn::before {
        content: '▸ ';
        color: #6a7388;
        font-size: 10px;
      }
      .lab-manual-nav .nav-group.open > .nav-group-btn::before { content: '▾ '; }
      .lab-manual-nav .nav-children { display: none; padding-left: 8px; }
      .lab-manual-nav .nav-group.open > .nav-children { display: block; }
      .lab-manual-nav .nav-leaf { padding-left: 18px; }
      .lab-manual-nav .nav-leaf:hover,
      .lab-manual-nav .nav-group-btn:hover { color: #e7e9ef; background: #1c2230; }
      .lab-manual-nav .nav-leaf.active {
        color: var(--accent, #f5c518);
        background: #1c2230;
        font-weight: 600;
      }
      .lab-manual-content {
        overflow: auto;
        padding: 14px 16px 24px;
        min-width: 0;
        min-height: 0;
      }
      .lab-manual-content h2 {
        margin: 0 0 10px;
        font: 600 16px/1.25 ui-monospace, monospace;
        color: var(--accent, #f5c518);
      }
      .lab-manual-content .lab-manual-body {
        margin: 0;
        white-space: pre-wrap;
        font: 13px/1.55 ui-sans-serif, system-ui, sans-serif;
        color: #c5cad6;
      }
      .lab-manual-content figure { margin: 16px 0 0; padding: 0; }
      .lab-manual-content figure img {
        display: block;
        width: 100%;
        max-width: 100%;
        border-radius: 8px;
        border: 1px solid #303646;
        background: #0c0e14;
      }
      .lab-manual-content figcaption {
        margin-top: 6px;
        font: 11px/1.4 ui-monospace, monospace;
        color: #6a7388;
      }
      .lab-manual-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 16px;
      }
      .lab-manual-actions button {
        font: 600 11px ui-monospace, monospace;
        padding: 5px 10px;
        border-radius: 4px;
        border: 1px solid #2e3648;
        background: #1c2230;
        color: #e7e9ef;
        cursor: pointer;
      }
      .lab-manual-actions button:hover {
        border-color: var(--accent, #f5c518);
        color: var(--accent, #f5c518);
      }
      @media (max-width: 720px) {
        .lab-manual { grid-template-columns: 1fr; }
        .lab-manual-nav {
          max-height: 180px;
          border-right: none;
          border-bottom: 1px solid #2a3040;
        }
      }
    `;
    document.head.appendChild(style);
  }

  private renderNav(): void {
    this.nav.replaceChildren();
    for (const node of NAV_TREE) this.appendNavNode(this.nav, node);
  }

  private appendNavNode(parent: HTMLElement, node: NavNode): void {
    if (node.kind === 'group') {
      const wrap = document.createElement('div');
      wrap.className = 'nav-group' + (this.openGroups.has(node.id) ? ' open' : '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-group-btn';
      btn.textContent = node.title;
      btn.addEventListener('click', () => {
        if (this.openGroups.has(node.id)) this.openGroups.delete(node.id);
        else this.openGroups.add(node.id);
        this.renderNav();
      });
      const kids = document.createElement('div');
      kids.className = 'nav-children';
      for (const ch of node.children) this.appendNavNode(kids, ch);
      wrap.append(btn, kids);
      parent.appendChild(wrap);
      return;
    }
    const leaf = document.createElement('button');
    leaf.type = 'button';
    leaf.className = 'nav-leaf' + (node.id === this.activeId ? ' active' : '');
    leaf.textContent = node.title;
    leaf.addEventListener('click', () => this.showSection(node.id));
    parent.appendChild(leaf);
  }

  private showSection(id: string): void {
    const sec = sectionById.get(id) ?? sectionById.get('overview')!;
    this.activeId = sec.id;
    // Ensure parent groups containing this leaf stay open
    for (const g of NAV_TREE) {
      if (g.kind === 'group' && g.children.some((c) => c.kind === 'leaf' && c.id === sec.id)) {
        this.openGroups.add(g.id);
      }
    }
    this.renderNav();
    this.content.replaceChildren();

    const h2 = document.createElement('h2');
    h2.textContent = sec.title;
    const body = document.createElement('p');
    body.className = 'lab-manual-body';
    body.textContent = sec.body;
    this.content.append(h2, body);

    for (const fig of sec.figures ?? []) {
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.src = fig.src;
      img.alt = fig.caption;
      img.loading = 'lazy';
      const cap = document.createElement('figcaption');
      cap.textContent = fig.caption;
      figure.append(img, cap);
      this.content.appendChild(figure);
    }

    if (sec.id === 'course' || sec.id === 'menu-help' || sec.id === 'overview') {
      const actions = document.createElement('div');
      actions.className = 'lab-manual-actions';
      const courseBtn = document.createElement('button');
      courseBtn.type = 'button';
      courseBtn.textContent = 'Open Lab course…';
      courseBtn.addEventListener('click', () => this.onOpenLabCourse?.());
      actions.appendChild(courseBtn);
      this.content.appendChild(actions);
    }

    this.content.scrollTop = 0;
  }
}
