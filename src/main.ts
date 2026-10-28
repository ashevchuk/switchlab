import { buildAlu, buildInstructionRegister, buildProgramCounter, buildRegister, buildRingCounter, buildStubRom, buildZ80Cpu } from './sim/blocks.js';
import { ChipLibrary } from './sim/ChipLibrary.js';
import { bumpStructureVersion, Circuit, currentStructureVersion } from './sim/Circuit.js';
import { addBlinkBench, TINY_CPU_BLINK_HEX } from './examples/tinyCpuBlink.js';
import { TINY_EDITOR_ISA } from './machine/tinyEditorIsa.js';
import { placeTinyCpu, tinyCpuForRam, tinyPcPins } from './sim/foldTinyCpu.js';
import { foldZ80CpuLeavingRam, newComponentIdSet, packFoldedMachine } from './sim/foldZ80.js';
import { replaceLongWiresWithLabels } from './sim/labelWires.js';
import { circuitHasPulseGen, circuitNeedsLabTick, tickLabInstruments } from './sim/labTick.js';
import { flatten, fold, foldPortWarnings, forkChipInstance, unfold } from './sim/hierarchy.js';
import { buildNot, makeButton, makeBusProbe, makeInput, makeLabel, makeLed, makeChipInstance, makePort, makeProbe, makeRam, makeRom, makeSource, makeTty, wire, CHIP_INSTANCE_WIDTH, chipBodyWidth, chipBoxHeight, chipInstanceHeight, ramPortCount, romPortCount } from './sim/library.js';
import { EXAMPLE_PROJECTS, type ExampleGroup } from './examples/catalog.js';
import {
  deserializeProject,
  importChipDef,
  resolveStdcellInstances,
  serializeChipDef,
  serializeProject,
  type SerializedChipBundle,
  type SerializedProject,
} from './sim/serialize.js';
import {
  clearAutosave,
  clearSlot,
  createAutosaveScheduler,
  ensureSlot,
  getSessionMeta,
  loadAutosave,
  loadAutosaveSync,
  loadSlot,
  MAX_SLOTS,
  saveSessionMeta,
  type AutosaveStatus,
} from './sim/autosave.js';
import { netIdFromEditorSelection, renameNet } from './sim/netRename.js';
import { initialState, step } from './sim/solver.js';
import { pruneDuplicateChipNames, seedStandardCells, isStdcellName, STDCELL_NAMES } from './sim/stdcells.js';
import { isLabcellName } from './sim/labcells.js';
import {
  armSoftLabToGatesPor,
  circuitHasSoftSequentialChips,
  clearSoftExpandForced,
  clearSoftLabPor,
  clearSoftLabState,
  clearSoftLabStateDeep,
  clearSoftModelForceExpands,
  isSoftLabEnabled,
  loadSoftLabPreference,
  persistSoftLabPreference,
  setSoftLabEnabled,
  softLabPorActive,
  syncSoftExpandForDivePath,
} from './sim/softLab.js';
import { decodeShareHash, encodeShareHash } from './sim/shareLink.js';
import type { AnalyzerComponent, ChipInstanceComponent, Component, Level, RamComponent, SimState } from './sim/types.js';
import { MACHINE_ADDR_BITS, BMP_WIDTH, BMP_HEIGHT, requiresMachineMap } from './machine/memoryMap.js';
import { MachineRunner } from './machine/MachineRunner.js';
import { loadSpectrumSession } from './machine/spectrumSession.js';
import { placeLabLedGateDecode } from './machine/labLedGateDecode.js';
import { commandRomHexPrompt } from './machine/commandRom.js';
import { LED_BLINK_ROM_BYTES } from './machine/ledBlinkRom.js';
import { PORT_TTY_ROM_BYTES } from './machine/portTtyRom.js';
import { LAB_REG_ROM_BYTES } from './machine/labRegRom.js';
import { runSoftCommand } from './machine/softConsole.js';
import { Camera, type Bounds } from './ui/Camera.js';
import { showAlert, showChoice, showConfirm, showPrompt } from './ui/Dialog.js';
import { EditHistory } from './ui/EditHistory.js';
import { Editor, type Tool } from './ui/Editor.js';
import { GRID, isBusName, routeWirePoints, snap } from './ui/geometry.js';
import { LAB_CURRICULUM, labCurriculumIndex, labCurriculumStep } from './ui/LabCurriculum.js';
import { LabCoursePanel } from './ui/LabCoursePanel.js';
import { LabManual } from './ui/LabManual.js';
import { LogicAnalyzer } from './ui/LogicAnalyzer.js';
import { MachinePanel } from './ui/MachinePanel.js';
import { MemoryEditor } from './ui/MemoryEditor.js';
import { ObjectInspector } from './ui/ObjectInspector.js';
import { WatchList, consecutiveBusPins, type WatchBusGroup } from './ui/WatchList.js';
import { IoMapViewer } from './ui/IoMapViewer.js';
import { draw } from './ui/Renderer.js';
import { makeSoftCanvasResolve } from './ui/softCanvasResolve.js';
import { isOrientable, orientSelection } from './sim/orientation.js';
import {
  showContextMenu,
  hideContextMenu,
  contextMenuOpen,
  type ContextMenuItem,
} from './ui/ContextMenu.js';
import { toggleCheatSheet, hideCheatSheet, cheatSheetOpen } from './ui/CheatSheet.js';
import { Minimap } from './ui/Minimap.js';
import { Tutorial } from './ui/Tutorial.js';

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D canvas context is not available');

const machinePanel = new MachinePanel();
const machineRunner = new MachineRunner();
machinePanel.bindRunner(machineRunner);
machineRunner.onReboot = () => {
  clearSoftLabState(topCircuit);
};

/**
 * After autosave restore the folded Z80CPU chip has no live Z80Cpu handle —
 * soft-reattach from TTY-linked (or largest) machine RAM so Run/Reboot/Load demo work.
 */
function findLinkedMachineRam(circuit: Circuit): RamComponent | null {
  for (const c of circuit.components.values()) {
    if (c.kind === 'tty' && c.ramId) {
      const ram = circuit.components.get(c.ramId);
      if (ram && ram.kind === 'ram' && requiresMachineMap(ram.addrBits)) return ram;
    }
  }
  let best: RamComponent | null = null;
  for (const c of circuit.components.values()) {
    if (c.kind === 'ram' && requiresMachineMap(c.addrBits)) {
      if (!best || c.addrBits > best.addrBits) best = c;
    }
  }
  return best;
}

function reattachSoftMachine(_opts?: { openPanel?: boolean }): void {
  const ram = findLinkedMachineRam(topCircuit);
  if (!ram) {
    machineRunner.detach();
    if (machinePanel.attached) machinePanel.detach();
    return;
  }
  // Project reload calls machinePanel.detach() which used to clear the runner
  // binding — always re-bind so Run/Reboot/Load demo see machineRunner.
  machinePanel.bindRunner(machineRunner);
  if (!machineRunner.attached || machineRunner.machineRam !== ram) {
    machineRunner.attachSoft(ram, { library });
    machineRunner.boot();
  }
  // Sync panel.ram + show TTY — Load demo / Boot / draw require panel RAM.
  machinePanel.attach(ram);
  // 64K sessions are Spectrum machines; restore soft ULA so Run isn't a blank screen.
  if (ram.addrBits >= 16 && ram.bytes.length >= 0x10000) {
    const hint = loadSpectrumSession();
    const model = hint?.model ?? '48';
    void machinePanel
      .restoreSpectrumSession({ model, demoId: hint?.demoId ?? null })
      .catch((err) => console.warn(err));
  }
  machinePanel.refreshControls();
}

const memoryEditor = new MemoryEditor();
const logicAnalyzer = new LogicAnalyzer();
const objectInspector = new ObjectInspector();
const watchList = new WatchList();
const ioMapViewer = new IoMapViewer();

const WATCH_LS_KEY = 'switchlab.watches.v1';
function loadPersistedWatches(): string[] {
  try {
    const raw = localStorage.getItem(WATCH_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function persistWatches(): void {
  try {
    localStorage.setItem(WATCH_LS_KEY, JSON.stringify([...watchList.getPinIds()]));
  } catch {
    /* ignore */
  }
}
watchList.setPinIds(loadPersistedWatches());
watchList.onChange = () => persistWatches();

machinePanel.onOpenIoMap = () => openIoMapViewer();
function openIoMapViewer(): void {
  ioMapViewer.attach(machineRunner.machineRam);
  ioMapViewer.setVisible(true);
  ioMapViewer.draw();
}

const library = new ChipLibrary();
seedStandardCells(library); // NOT/NAND/AND/NOR/OR/XOR/MUX2/MUX4/FULL_ADDER/D_LATCH/D_FF, ready to drag out
const topCircuit = new Circuit();
loadSoftLabPreference();

/** `#demo=id` boots a bundled Spectrum game (skips session restore). */
function parseDemoHash(hash: string): string | null {
  if (!hash.startsWith('#demo=')) return null;
  const id = decodeURIComponent(hash.slice(6)).trim();
  return id || null;
}
/** `#e=example-id` loads a built-in EXAMPLE_PROJECTS entry. */
function parseExampleHash(hash: string): string | null {
  if (!hash.startsWith('#e=')) return null;
  const id = decodeURIComponent(hash.slice(3)).trim();
  return id || null;
}
function hasSnaHash(hash: string): boolean {
  return hash.startsWith('#sna=');
}
const bootDemoId = parseDemoHash(location.hash);
const bootExampleId = parseExampleHash(location.hash);
const bootSnaPending = hasSnaHash(location.hash);

function applyLoadedProject(loaded: { topCircuit: Circuit; library: ChipLibrary }): void {
  // Drop gate Inputs / soft host before wiping the circuit graph.
  machineRunner.detach();
  if (machinePanel.attached) machinePanel.detach();
  clearSoftExpandForced();
  topCircuit.components.clear();
  topCircuit.wires.clear();
  bumpStructureVersion();
  for (const c of loaded.topCircuit.components.values()) topCircuit.addComponent(c);
  for (const w of loaded.topCircuit.wires.values()) topCircuit.addRawWire(w);
  library.clear();
  for (const def of loaded.library.list()) library.register(def);
  // Fill any missing stdcells without re-adding names already in the session,
  // rebind slim lab instances (defName → seeded id), then drop orphan duplicates.
  seedStandardCells(library);
  resolveStdcellInstances(topCircuit, library);
  pruneDuplicateChipNames(library, [topCircuit, ...library.list().map((d) => d.circuit)]);
  // Soft Lab off (e.g. localStorage after reload): seed sequential Q nets so
  // COUNTER/REG don't sit at Z when Clear is already released.
  if (!isSoftLabEnabled()) armSoftLabToGatesPor(topCircuit, library);
  // Folded machines lose the live Z80Cpu handle — soft-reattach from RAM.
  reattachSoftMachine();
}

const restoredSync = bootDemoId || bootSnaPending || bootExampleId ? null : loadAutosaveSync();
if (restoredSync) {
  try {
    applyLoadedProject(deserializeProject(restoredSync));
  } catch {
    seedDemoCircuit(topCircuit);
  }
} else {
  seedDemoCircuit(topCircuit);
}

function seedDemoCircuit(c: Circuit): void {
  makeSource(c, 1, { x: 80, y: 60 }); // rail driver
  makeSource(c, 0, { x: 80, y: 140 });
  const notGate = buildNot(c, { x: 260, y: 70 });
  const btn = makeButton(c, { x: 140, y: 100 }, 'toggle');
  const led = makeLed(c, { x: 360, y: 100 }, 'out');
  const probe = makeProbe(c, { x: 360, y: 160 }, 'out');
  wire(c, btn.pins.out, notGate.in);
  wire(c, notGate.out, led.pins.in);
  wire(c, notGate.out, probe.pins.in);
}

/** Bounding box of every component's center in `circuit`, padded a little, for fit/center-on-dive. */
function circuitBounds(circuit: Circuit): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of circuit.components.values()) {
    minX = Math.min(minX, c.pos.x);
    minY = Math.min(minY, c.pos.y);
    maxX = Math.max(maxX, c.pos.x);
    maxY = Math.max(maxY, c.pos.y);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const pad = 60;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
function centroid(b: Bounds): { x: number; y: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

// --- Camera --------------------------------------------------------------
const camera = new Camera();
function viewportSize(): { w: number; h: number } {
  const rect = stage.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}
function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = viewportSize();
  // Only reassign when the backing store size actually changes — setting
  // canvas.width clears the bitmap and resets the context transform.
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel units regardless of device pixel ratio
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Hierarchy navigation ------------------------------------------------
// The live simulation always flattens from `topCircuit` regardless of which
// level is being viewed (see hierarchy.ts's flatten()). `navStack` only
// tracks *what the editor currently shows*: the circuit itself, the
// namespace path (see flatten()'s doc comment) needed to translate that
// circuit's local pin ids into the flattened simulation's net ids so the
// live colors line up even while dived inside a chip's internals, and
// (below the top) which ChipDef this level belongs to, for renamePort().
interface NavFrame {
  circuit: Circuit;
  pathPrefix: string;
  label: string;
  defId?: string;
}
const navStack: NavFrame[] = [{ circuit: topCircuit, pathPrefix: '', label: 'top' }];

const editor = new Editor(topCircuit, library);
editor.onComponentsRemoved = (ids) => {
  watchList.removeComponents(ids);
  refreshWatchStrip();
};
/** Playwright Lab-manual capture hooks (scripts/capture-lab-help*.mts). */
(window as unknown as { __simHelpCapture: { tidyAll: () => number } }).__simHelpCapture = {
  tidyAll: () => editor.tidyAllWires(false),
};
/** Playwright e2e hook: read editor/camera state and map world to screen points. */
(window as unknown as { __simTest: { editor: Editor; camera: Camera } }).__simTest = { editor, camera };
const editHistory = new EditHistory();
const tutorial = new Tutorial(stage);
tutorial.onHintChange = (hint) => {
  editor.tutorialHint = hint;
  uiDirty = true;
};

const autosaveStatusEl = document.getElementById('autosave-status');
let lastAutosaveUiStatus: AutosaveStatus = 'idle';
function setAutosaveStatusUi(status: AutosaveStatus, detail?: string): void {
  if (!autosaveStatusEl) return;
  lastAutosaveUiStatus = status;
  autosaveStatusEl.dataset.state = status;
  const slot = getSessionMeta().slots.find((s) => s.id === getSessionMeta().activeId);
  const name = slot?.name ?? 'Session';
  switch (status) {
    case 'pending':
      autosaveStatusEl.textContent = `${name} · …`;
      autosaveStatusEl.title = 'Autosave pending';
      break;
    case 'saving':
      autosaveStatusEl.textContent = `${name} · Saving…`;
      autosaveStatusEl.title = 'Writing session…';
      break;
    case 'saved':
      autosaveStatusEl.textContent = detail ? `${name} · Saved (${detail})` : `${name} · Saved`;
      autosaveStatusEl.title = 'Click to export session JSON';
      break;
    case 'error':
      autosaveStatusEl.textContent = `${name} · Save failed${detail ? ` (${detail})` : ''}`;
      autosaveStatusEl.title = 'Click for options (export / retry)';
      break;
    case 'conflict':
      autosaveStatusEl.textContent = `${name} · Changed elsewhere`;
      autosaveStatusEl.title = 'Another tab saved this session — click for Restore / Load / Export';
      break;
    default:
      autosaveStatusEl.textContent = name;
      autosaveStatusEl.title = 'Click to export session JSON';
  }
}

const autosave = createAutosaveScheduler(() => serializeProject(topCircuit, library), {
  onStatus: setAutosaveStatusUi,
  onConflict: () => {
    /* status already set; click badge to export a safety copy */
  },
});
autosave.adoptWriteGen(getSessionMeta().activeId);
let lastAutosaveStructureVersion = currentStructureVersion();
setAutosaveStatusUi('idle');

function bumpDefRevisionOnEdit(): void {
  const defId = navStack[navStack.length - 1]?.defId;
  if (defId && library.has(defId)) {
    const def = library.get(defId);
    def.revision = (def.revision ?? 0) + 1;
  }
}

editor.onBeforeEdit = () => {
  editHistory.checkpoint(editor.circuit);
  bumpDefRevisionOnEdit();
  autosave.schedule();
};
editor.onCancelEdit = () => editHistory.discardLast(editor.circuit);
objectInspector.onBeforeEdit = () => {
  editHistory.checkpoint(editor.circuit);
  bumpDefRevisionOnEdit();
  autosave.schedule();
};
objectInspector.onDive = (inst) => {
  void diveInto(inst);
};
objectInspector.onUpdateFromLibrary = (inst) => {
  if (editor.updateChipFromLibrary(inst.id)) {
    uiDirty = true;
    objectInspector.refresh();
  }
};
objectInspector.editor = editor;
objectInspector.onWatchPins = (pinIds) => {
  let added = 0;
  for (const id of pinIds) {
    const pin = editor.circuit.allPins().find((p) => p.id === id);
    const label = pin ? `${pin.componentId}:${pin.name}` : id;
    if (watchList.add(id, label)) added++;
  }
  if (added > 0) {
    watchList.setVisible(true);
    uiDirty = true;
  }
};
watchList.onSelectPin = (pinId) => {
  selectPinComponent(pinId);
};

watchList.onBusContext = (bus: WatchBusGroup, clientX: number, clientY: number) => {
  showContextMenu(clientX, clientY, [
    {
      label: 'Spawn bus probe',
      run: () => {
        editHistory.checkpoint(editor.circuit);
        const probe = makeBusProbe(editor.circuit, bus.pinIds.length, {
          x: editor.mouse.x + 80,
          y: editor.mouse.y,
        });
        const nets = editor.circuit.computeNets();
        for (let i = 0; i < bus.pinIds.length; i++) {
          const src = bus.pinIds[i]!;
          const dst = probe.pins[`b${i}`];
          if (!dst) continue;
          const na = nets.netOf.get(src);
          const nb = nets.netOf.get(dst.id);
          if (na !== undefined && nb !== undefined && na === nb) continue;
          editor.circuit.addWire(src, dst.id, undefined, `bundle-watch-${probe.id}`);
        }
        uiDirty = true;
      },
    },
    {
      label: 'Add channels to open LA',
      run: () => {
        let la: AnalyzerComponent | null = null;
        for (const c of editor.circuit.components.values()) {
          if (c.kind === 'analyzer') {
            la = c;
            break;
          }
        }
        if (!la) {
          void showAlert('Place an Analyzer first (Place → Logic analyzer).');
          return;
        }
        editHistory.checkpoint(editor.circuit);
        const need = bus.pinIds.length;
        while (la.channelCount < need) {
          if (!editor.addAnalyzerChannel(la.id)) break;
          la = editor.circuit.components.get(la.id) as AnalyzerComponent;
        }
        const nets = editor.circuit.computeNets();
        for (let i = 0; i < Math.min(need, la.channelCount); i++) {
          const src = bus.pinIds[i]!;
          const dst = la.pins[`ch${i}`];
          if (!dst) continue;
          const na = nets.netOf.get(src);
          const nb = nets.netOf.get(dst.id);
          if (na !== undefined && nb !== undefined && na === nb) continue;
          editor.circuit.addWire(src, dst.id, undefined, `bundle-la-${la.id}`);
        }
        logicAnalyzer.attach(la);
        uiDirty = true;
      },
    },
  ]);
};

function selectPinComponent(pinId: string): void {
  const compId = pinId.split(':')[0];
  if (!compId || !editor.circuit.components.has(compId)) return;
  editor.clearSelection();
  editor.selectedIds.add(compId);
  const nets = editor.circuit.computeNets();
  editor.highlightedNetId = nets.netOf.get(pinId) ?? null;
  syncInspector();
  uiDirty = true;
}

function addWatchForHoveredOrSelected(): void {
  if (editor.hoveredPinId) {
    const pin = editor.circuit.allPins().find((p) => p.id === editor.hoveredPinId);
    const label = pin ? `${pin.componentId}:${pin.name}` : editor.hoveredPinId;
    watchList.add(editor.hoveredPinId, label);
    watchList.setVisible(true);
    return;
  }
  const sel = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c);
  if (sel.length === 1) {
    objectInspector.onWatchPins?.(Object.values(sel[0]!.pins).map((p) => p.id));
  }
}
let simState: SimState = initialState();
/** Last flat net map — used by MachineRunner gate halt detection. */
let lastFlatNetMap: ReturnType<Circuit['computeNets']> | null = null;

// A single window-level, capture-phase tap on every event type that could
// possibly change what the next frame ought to look like — mouse/keyboard
// interaction with the canvas or a dialog, wheel zoom, a toolbar button
// click, a window resize — set unconditionally to `true`, never read or
// cleared here. `frame()` below is the only place that ever sets it back to
// `false`, once it has actually redrawn for that reason. Deliberately a
// blunt, over-inclusive net rather than threading a precise "this specific
// mutation changed something visible" flag through Editor/Camera/every
// toolbar handler individually: a stray extra redraw costs nothing a user
// can perceive, but a missed one means a stale frame sitting on screen — see
// `frame()`'s own doc comment for why marking too eagerly is the safe
// direction to err in here.
let uiDirty = true;
objectInspector.onChange = () => {
  uiDirty = true;
};
objectInspector.onSettleReadQ = async (inst, softQ) => {
  // Force a structure rebuild + several settle steps so transistor q pins resolve.
  uiDirty = true;
  const flat = flatten(topCircuit, library);
  const flatNetMap = flat.computeNets();
  lastFlatNetMap = flatNetMap;
  simState = initialState();
  for (let i = 0; i < 64; i++) {
    simState = step(flat, flatNetMap, simState);
    if (simState.settled) break;
  }
  // One more frame of instruments / clocks if needed
  tickLabInstruments(topCircuit, flatNetMap, simState.levelOf);
  for (let i = 0; i < 16; i++) {
    simState = step(flat, flatNetMap, simState);
    if (simState.settled) break;
  }
  const out = new Uint8Array(softQ.length);
  for (let i = 0; i < softQ.length; i++) {
    const pin = inst.pins[`q${i}`];
    if (!pin) {
      out[i] = 0;
      continue;
    }
    const net = flatNetMap.netOf.get(pin.id);
    const lvl = net != null ? (simState.levelOf.get(net) ?? 'Z') : 'Z';
    out[i] = lvl === 1 ? 1 : 0;
  }
  return out;
};
objectInspector.setContext({
  circuit: topCircuit,
  library,
  defId: null,
  allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
});

function syncInspector(): void {
  if (editor.selectedIds.size === 0) {
    objectInspector.sync(null);
    return;
  }
  const comps = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c);
  if (comps.length === 0) {
    objectInspector.sync(null);
    return;
  }
  objectInspector.sync(comps.length === 1 ? comps[0]! : comps);
}
memoryEditor.setOnChange(() => {
  uiDirty = true;
});
memoryEditor.setOnGo((addr, mem) => {
  const ram = machineRunner.machineRam;
  if (!ram || ram !== mem) return false;
  const g = runSoftCommand(ram.bytes, `G ${addr.toString(16)}`);
  if (g.reboot) {
    machineRunner.reboot();
    machineRunner.setRunning(true);
  }
  machinePanel.draw();
  machinePanel.refreshControls();
  return true;
});
logicAnalyzer.setOnRunChange(() => {
  uiDirty = true;
});
logicAnalyzer.onCursorChange = () => {
  uiDirty = true;
};

for (const evtName of ['mousedown', 'mousemove', 'mouseup', 'dblclick', 'wheel', 'keydown', 'keyup', 'click', 'change', 'resize']) {
  window.addEventListener(evtName, () => (uiDirty = true), { capture: true, passive: true });
}
// Stage shrinks/grows when the TTY panel toggles (and on browser zoom /
// DPR changes that don't always fire `window.resize`). Without this, the
// canvas CSS box follows flex layout but the backing store stays at the
// old size — fillRect only covers the new CSS viewport, leaving a strip of
// stale pixels that the browser then squashes into the right edge as a
// smear (most visible while zooming, which forces redraws).
new ResizeObserver(() => {
  resizeCanvas();
  uiDirty = true;
}).observe(stage);

function countChipInstances(defId: string): number {
  let n = 0;
  const circuits = [topCircuit, ...library.list().map((d) => d.circuit)];
  for (const circ of circuits) {
    for (const c of circ.components.values()) {
      if (c.kind === 'chip' && c.defId === defId) n++;
    }
  }
  return n;
}

async function diveInto(inst: ChipInstanceComponent): Promise<void> {
  let def = library.get(inst.defId);
  const shared = countChipInstances(inst.defId) > 1;
  if (shared) {
    const fork = await showConfirm(
      `"${def.name}" has multiple instances. Fork a private copy so edits do not affect the others?`,
    );
    if (fork) {
      def = forkChipInstance(library, inst);
      uiDirty = true;
    }
  }
  // Acknowledge current revision so the "edited" badge clears for this instance.
  inst.defRevision = def.revision ?? 0;
  const parent = navStack[navStack.length - 1]!;
  navStack.push({
    circuit: def.circuit,
    pathPrefix: `${parent.pathPrefix}${inst.id}/`,
    label: def.name,
    defId: def.id,
  });
  enterLevel();
}

function diveTo(index: number): void {
  navStack.length = index + 1;
  enterLevel();
}

function enterLevel(): void {
  const view = navStack[navStack.length - 1]!;
  // Soft Lab: auto force-expand ChipDefs on the dive path so internals are live;
  // release auto-expand when leaving (manual inspector force-expand is kept).
  resyncSoftExpandForCurrentDive();
  editor.circuit = view.circuit;
  editor.clearSelection();
  editor.cancelWire();
  // Keep per-circuit undo stacks — diving must not wipe the parent's history.
  objectInspector.setContext({
    circuit: view.circuit,
    library,
    defId: view.defId ?? null,
    allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
  });
  objectInspector.sync(null);
  // "Auto-centered at 100%" — see the reference project's own dive-in behavior.
  camera.centerOn(centroid(circuitBounds(view.circuit)), 1);
  renderBreadcrumb();
  refreshWatchStrip();
  uiDirty = true;
}

/** Soft Lab on while dived: keep path (+ Soft descendants) transistor-expanded. */
function resyncSoftExpandForCurrentDive(): void {
  const pathDefNames = navStack
    .filter((f) => f.defId)
    .map((f) => library.get(f.defId!).name);
  const { newly, released } = syncSoftExpandForDivePath(pathDefNames, library);
  if (released.length > 0 && isSoftLabEnabled()) {
    // Soft guts → Soft opaque: stale lastClk/q from the dive would freeze
    // sequential Soft chips until the next accidental edge.
    clearSoftLabStateDeep(topCircuit, library);
    simState = initialState();
    flashStatusNotice('Soft Lab — soft state reset after leaving dive');
  }
  if (newly.length > 0 && isSoftLabEnabled()) {
    armSoftLabToGatesPor(topCircuit, library, new Set(newly));
  }
}

const breadcrumbEl = document.getElementById('breadcrumb') as HTMLDivElement;
function renderBreadcrumb(): void {
  breadcrumbEl.replaceChildren();
  const meta = getSessionMeta();
  const slot = meta.slots.find((s) => s.id === meta.activeId);
  const sessionBtn = document.createElement('button');
  sessionBtn.className = 'crumb-session';
  sessionBtn.textContent = slot?.name ?? 'Session';
  sessionBtn.title = 'Switch session';
  sessionBtn.addEventListener('click', () => void switchSession());
  breadcrumbEl.appendChild(sessionBtn);

  navStack.forEach((frame, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = ' › ';
    breadcrumbEl.appendChild(sep);
    const btn = document.createElement('button');
    btn.textContent = frame.label;
    btn.addEventListener('click', () => diveTo(i));
    breadcrumbEl.appendChild(btn);
  });
}
renderBreadcrumb();
camera.centerOn(centroid(circuitBounds(topCircuit)), 1);

// IndexedDB-only autosave (too big for localStorage) — apply once if boot
// only saw the demo because LS was empty. Skip when `#demo=` is loading.
if (!restoredSync && !bootDemoId && !bootSnaPending && !bootExampleId) {
  void loadAutosave().then((data) => {
    if (!data) return;
    // Still on the fresh demo (no user edits yet, or empty) — replace.
    try {
      applyLoadedProject(deserializeProject(data));
      resetViewAfterProjectLoad();
    } catch {
      /* keep demo */
    }
  });
}

// --- Chip palette (Library menu): place an instance of any folded chip ---
const chipPaletteListEl = document.getElementById('chip-palette-list') as HTMLDivElement;
const libraryMenuTrigger = document.getElementById('library-menu-trigger');
const chipPaletteSearchEl = document.getElementById('chip-palette-search') as HTMLInputElement | null;
let chipPaletteTag: 'all' | 'gates' | 'lab' | '74xx' | 'user' = 'all';

function refreshChipPalette(): void {
  chipPaletteListEl.replaceChildren();
  const q = (chipPaletteSearchEl?.value ?? '').trim().toLowerCase();
  const defs = library.list().filter((def) => {
    if (q && !def.name.toLowerCase().includes(q)) return false;
    const std = isStdcellName(def.name);
    const gate = STDCELL_NAMES.has(def.name);
    const lab = isLabcellName(def.name);
    const is74 = /^74/.test(def.name);
    if (chipPaletteTag === 'gates' && !gate) return false;
    if (chipPaletteTag === 'lab' && !(lab && !is74)) return false;
    if (chipPaletteTag === '74xx' && !is74) return false;
    if (chipPaletteTag === 'user' && std) return false;
    return true;
  });
  if (library.list().length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No chips yet — fold a selection (Ctrl+G)';
    chipPaletteListEl.appendChild(empty);
  } else if (defs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No chips match this filter';
    chipPaletteListEl.appendChild(empty);
  } else {
    for (const def of defs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item';
      const tag = document.createElement('span');
      tag.className = 'chip-tag';
      tag.textContent = STDCELL_NAMES.has(def.name)
        ? 'gate'
        : /^74/.test(def.name)
          ? '74xx'
          : isLabcellName(def.name)
            ? 'lab'
            : 'user';
      btn.append(document.createTextNode(def.name), tag);
      btn.dataset.defId = def.id;
      btn.classList.toggle('active', editor.tool.kind === 'place-chip' && editor.tool.defId === def.id);
      btn.addEventListener('click', () => setTool({ kind: 'place-chip', defId: def.id }));
      chipPaletteListEl.appendChild(btn);
    }
  }
  libraryMenuTrigger?.classList.toggle(
    'active',
    editor.tool.kind === 'place-chip',
  );
}
chipPaletteSearchEl?.addEventListener('input', () => refreshChipPalette());
chipPaletteSearchEl?.addEventListener('click', (ev) => ev.stopPropagation());
chipPaletteSearchEl?.addEventListener('keydown', (ev) => ev.stopPropagation());
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.chip-tag-filter'))) {
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const tag = btn.dataset.tag as typeof chipPaletteTag;
    chipPaletteTag = tag;
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.chip-tag-filter'))) {
      b.classList.toggle('active', b.dataset.tag === tag);
    }
    refreshChipPalette();
  });
}
refreshChipPalette();

// --- Menubar: open / close / hover-switch like a desktop app -------------
const menus = Array.from(document.querySelectorAll<HTMLElement>('#menubar .menu'));
function closeAllMenus(): void {
  for (const m of menus) m.classList.remove('open');
}
function openMenu(menu: HTMLElement): void {
  for (const m of menus) m.classList.toggle('open', m === menu);
}
let menuBarArmed = false;
for (const menu of menus) {
  const trigger = menu.querySelector('.menu-trigger');
  trigger?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menu.classList.contains('open')) {
      closeAllMenus();
      menuBarArmed = false;
    } else {
      openMenu(menu);
      menuBarArmed = true;
    }
  });
  trigger?.addEventListener('mouseenter', () => {
    if (menuBarArmed) openMenu(menu);
  });
}
document.addEventListener('click', () => {
  closeAllMenus();
  menuBarArmed = false;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    closeAllMenus();
    menuBarArmed = false;
    hideCheatSheet();
    hideContextMenu();
  }
});
for (const panel of Array.from(document.querySelectorAll('#menubar .menu-panel'))) {
  panel.addEventListener('click', (ev: Event) => {
    const t = ev.target as HTMLElement;
    // Nested Demo flyout trigger — keep File open.
    if (t.closest('.menu-sub-trigger')) {
      ev.preventDefault();
      const sub = t.closest('.menu-sub');
      if (sub) sub.classList.toggle('open');
      return;
    }
    if (t.closest('.menu-item')) {
      queueMicrotask(() => {
        closeAllMenus();
        menuBarArmed = false;
      });
    }
  });
}

// --- Toolbar + cursor ----------------------------------------------------
const CURSOR: Record<Tool['kind'], string> = {
  select: 'default',
  pan: 'grab',
  wire: 'crosshair',
  nmos: 'copy',
  pmos: 'copy',
  vcc: 'copy',
  gnd: 'copy',
  input: 'copy',
  button: 'copy',
  switch: 'copy',
  led: 'copy',
  sevenseg: 'copy',
  clock: 'copy',
  analyzer: 'copy',
  busprobe: 'copy',
  busswitch: 'copy',
  buspass: 'copy',
  tty: 'copy',
  probe: 'copy',
  label: 'copy',
  port: 'copy',
  'place-chip': 'copy',
};
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tool]'));
// Built from each button's own data-key, not hand-duplicated here, so the
// keyboard shortcut and its on-screen (N) hint (index.html) can't drift apart.
const TOOL_KEYS = new Map<string, Tool>(
  toolButtons
    .filter((b) => b.dataset.key)
    .map((b) => [b.dataset.key!, { kind: b.dataset.tool as Exclude<Tool['kind'], 'place-chip'> }]),
);
const PLACE_TOOL_LABELS: Partial<Record<Tool['kind'], string>> = {
  nmos: 'placing N-MOS',
  pmos: 'placing P-MOS',
  vcc: 'placing VCC',
  gnd: 'placing GND',
  input: 'placing input',
  button: 'placing button',
  switch: 'placing switch',
  led: 'placing LED',
  sevenseg: 'placing 7-seg',
  clock: 'placing pulse gen',
  analyzer: 'placing analyzer',
  busprobe: 'placing bus probe',
  busswitch: 'placing bus switch',
  buspass: 'placing pass switch bank',
  tty: 'placing TTY',
  probe: 'placing probe',
  label: 'placing net label',
  port: 'placing port',
  'place-chip': 'placing chip',
};
const activePlaceHint = document.getElementById('active-place-hint');
const activeToolName = document.getElementById('active-tool-name');
function setTool(tool: Tool): void {
  if (tool.kind === 'place-chip' && !library.has(tool.defId)) {
    tool = { kind: 'select' };
  }
  editor.tool = tool;
  editor.cancelWire();
  editor.marqueeStart = null;
  for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === tool.kind);
  canvas.style.cursor = CURSOR[tool.kind];
  const placeLabel =
    tool.kind === 'place-chip'
      ? `placing ${library.get(tool.defId).name}`
      : PLACE_TOOL_LABELS[tool.kind];
  if (activePlaceHint && activeToolName) {
    if (placeLabel) {
      activeToolName.textContent = placeLabel;
      activePlaceHint.hidden = false;
    } else {
      activePlaceHint.hidden = true;
      activeToolName.textContent = '';
    }
  }
  refreshChipPalette();
}
for (const b of toolButtons) {
  b.addEventListener('click', () => setTool({ kind: b.dataset.tool as Exclude<Tool['kind'], 'place-chip'> }));
}
setTool({ kind: 'select' });

const hintEl = document.getElementById('hint');
const HINT_BASE =
  'R/⇧R rotate · M/⇧M flip · T tidy · ⌃Z/Y undo/redo · ? help · ⌃G fold · Run/Pause/Step · Alt+drag pin side';
function updateSnapHint(): void {
  if (!hintEl) return;
  hintEl.textContent = `${HINT_BASE} · snap:${editor.snapMode} (G)`;
}
updateSnapHint();

document.getElementById('clear')?.addEventListener('click', async () => {
  if (!(await showConfirm('Clear this level of the circuit?'))) return;
  if (navStack.length === 1) {
    machineRunner.detach();
    machinePanel.detach();
    memoryEditor.detach();
    logicAnalyzer.clearChannels();
  }
  editHistory.checkpoint(editor.circuit);
  editor.circuit.components.clear();
  editor.circuit.wires.clear();
  editor.clearSelection();
  editor.cancelWire();
  autosave.schedule();
});

function resetEditorToTop(): void {
  navStack.length = 0;
  navStack.push({ circuit: topCircuit, pathPrefix: '', label: 'top' });
  editor.circuit = topCircuit;
  editor.clearSelection();
  editor.cancelWire();
  editHistory.clear();
  simState = initialState();
  machineRunner.detach();
  machinePanel.detach();
  memoryEditor.detach();
  logicAnalyzer.clearChannels();
  renderBreadcrumb();
  refreshChipPalette();
  camera.centerOn(centroid(circuitBounds(topCircuit)), 1);
  uiDirty = true;
  syncInspector();
  refreshWatchStrip();
  objectInspector.setContext({
    circuit: topCircuit,
    library,
    defId: null,
    allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
  });
}

document.getElementById('reset-session')?.addEventListener('click', async () => {
  if (
    !(await showConfirm(
      'Discard ALL browser sessions and reset to the demo circuit? This cannot be undone.',
    ))
  ) {
    return;
  }
  await clearAutosave();
  topCircuit.components.clear();
  topCircuit.wires.clear();
  library.clear();
  seedStandardCells(library);
  seedDemoCircuit(topCircuit);
  const meta = getSessionMeta();
  meta.activeId = '1';
  meta.slots = [{ id: '1', name: 'Session 1', updatedAt: Date.now() }];
  saveSessionMeta(meta);
  autosave.setActiveSlot('1');
  resetEditorToTop();
  setAutosaveStatusUi('idle');
});

document.getElementById('session-rename')?.addEventListener('click', async () => {
  const meta = getSessionMeta();
  const slot = meta.slots.find((s) => s.id === meta.activeId);
  if (!slot) return;
  const name = await showPrompt('Session name:', slot.name);
  if (!name?.trim()) return;
  slot.name = name.trim();
  saveSessionMeta(meta);
  setAutosaveStatusUi('idle');
  renderBreadcrumb();
});

document.getElementById('session-switch')?.addEventListener('click', () => void switchSession());
document.getElementById('session-new')?.addEventListener('click', () => void newSession());

async function switchSession(): Promise<void> {
  await autosave.flush();
  const meta = getSessionMeta();
  const pick = await showChoice(
    'Switch session',
    meta.slots.map((s) => ({
      value: s.id,
      label: s.name,
      detail: s.id === meta.activeId ? 'current' : undefined,
      current: s.id === meta.activeId,
      deletable: meta.slots.length > 1,
    })),
  );
  if (!pick) return;

  if (pick.action === 'delete') {
    if (meta.slots.length <= 1) {
      await showAlert('Cannot delete the only session.');
      return;
    }
    const victim = meta.slots.find((s) => s.id === pick.value);
    if (
      !(await showConfirm(`Delete session “${victim?.name ?? pick.value}”? This cannot be undone.`))
    ) {
      return;
    }
    await clearSlot(pick.value);
    meta.slots = meta.slots.filter((s) => s.id !== pick.value);
    if (meta.activeId === pick.value) {
      const next = meta.slots[0]!;
      meta.activeId = next.id;
      saveSessionMeta(meta);
      autosave.setActiveSlot(next.id);
      const data = await loadSlot(next.id);
      if (data) {
        try {
          applyLoadedProject(deserializeProject(data));
        } catch {
          topCircuit.components.clear();
          topCircuit.wires.clear();
          library.clear();
          seedStandardCells(library);
        }
      } else {
        topCircuit.components.clear();
        topCircuit.wires.clear();
        library.clear();
        seedStandardCells(library);
      }
      resetEditorToTop();
    } else {
      saveSessionMeta(meta);
    }
    setAutosaveStatusUi('idle');
    renderBreadcrumb();
    return;
  }

  const id = pick.value;
  if (id === meta.activeId) return;
  const data = await loadSlot(id);
  meta.activeId = id;
  saveSessionMeta(meta);
  autosave.setActiveSlot(id);
  if (data) {
    try {
      applyLoadedProject(deserializeProject(data));
    } catch (err) {
      await showAlert(`Could not load session: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } else {
    topCircuit.components.clear();
    topCircuit.wires.clear();
    library.clear();
    seedStandardCells(library);
  }
  resetEditorToTop();
  setAutosaveStatusUi('idle');
}

async function newSession(): Promise<void> {
  await autosave.flush();
  const meta = getSessionMeta();
  if (meta.slots.length >= MAX_SLOTS) {
    await showAlert(`Already ${MAX_SLOTS} sessions — switch or rename an existing one.`);
    return;
  }
  let next = 1;
  while (meta.slots.some((s) => s.id === String(next))) next++;
  const id = String(next);
  const name = (await showPrompt('New session name:', `Session ${id}`))?.trim() || `Session ${id}`;
  ensureSlot(meta, id, name);
  meta.activeId = id;
  saveSessionMeta(meta);
  autosave.setActiveSlot(id);
  topCircuit.components.clear();
  topCircuit.wires.clear();
  library.clear();
  seedStandardCells(library);
  resetEditorToTop();
  autosave.schedule();
  setAutosaveStatusUi('idle');
  renderBreadcrumb();
}

document.getElementById('fold')?.addEventListener('click', () => void foldSelection());
document.getElementById('unfold')?.addEventListener('click', () => void unfoldSelection());
document.getElementById('find')?.addEventListener('click', () => void findInCircuit());
document.getElementById('rename-net')?.addEventListener('click', () => void renameSelectedNet());
document.getElementById('duplicate')?.addEventListener('click', () => {
  if (editor.duplicateSelection()) uiDirty = true;
});

async function stampSelectionPrompt(): Promise<void> {
  const countStr = await showPrompt('How many copies?', '3');
  if (countStr == null) return;
  const count = Math.floor(Number(countStr));
  if (!Number.isFinite(count) || count < 1 || count > 64) {
    await showAlert('Enter a count between 1 and 64.');
    return;
  }
  const pitchStr = await showPrompt('Grid pitch in world units (dx,dy) — e.g. 80,0 or 0,60', `${GRID * 8},0`);
  if (pitchStr == null) return;
  const parts = pitchStr.split(/[,x\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  const dx = parts[0] ?? GRID * 8;
  const dy = parts[1] ?? 0;
  if (editor.stampSelection(count, dx, dy)) uiDirty = true;
  else await showAlert('Nothing to stamp — select components (or copy first).');
}

document.getElementById('stamp-selection')?.addEventListener('click', () => void stampSelectionPrompt());
document.getElementById('view-watch')?.addEventListener('click', () => {
  watchList.setVisible(true);
});
document.getElementById('view-io-map')?.addEventListener('click', () => openIoMapViewer());
document.getElementById('export-selection-chip')?.addEventListener('click', () => void exportSelectionAsChip());

async function renameSelectedNet(): Promise<void> {
  const netId = netIdFromEditorSelection(editor.circuit, {
    highlightedNetId: editor.highlightedNetId,
    selectedWireId: editor.selectedWireId,
    selectedIds: editor.selectedIds,
  });
  if (!netId) {
    await showAlert('Select a wire, label, or component (or press H on a net) first.');
    return;
  }
  const name = await showPrompt('Net name (same name merges nets):', '');
  if (!name?.trim()) return;
  editHistory.checkpoint(editor.circuit);
  const result = renameNet(editor.circuit, netId, name.trim());
  if (!result.ok) {
    await showAlert(result.reason);
    return;
  }
  // Recompute so highlight tracks the (possibly merged) named net.
  const nets = editor.circuit.computeNets();
  for (const c of editor.circuit.components.values()) {
    if (c.kind === 'label' && c.name === name.trim()) {
      editor.highlightedNetId = nets.netOf.get(c.pins.net.id) ?? null;
      break;
    }
  }
  uiDirty = true;
  if (result.merged) {
    /* soft notice via status */
    setStatusLine(`Net merged into "${name.trim()}"`);
  }
}

async function exportSelectionAsChip(): Promise<void> {
  if (editor.selectedIds.size === 0) {
    await showAlert('Select the components to fold and export.');
    return;
  }
  const warnings = foldPortWarnings(editor.circuit, editor.selectedIds);
  if (warnings.length > 0) {
    const ok = await showConfirm(`${warnings.join('\n')}\n\nFold and export anyway?`);
    if (!ok) return;
  }
  const name = await showPrompt('Chip name:', 'CHIP');
  if (!name) return;
  editHistory.checkpoint(editor.circuit);
  const pos = snap(centroid(boundsOfSelection()));
  const { def, instance } = fold(editor.circuit, editor.selectedIds, name, library, pos);
  editor.selectedIds = new Set([instance.id]);
  refreshChipPalette();
  downloadJson(`${def.name}.json`, serializeChipDef(def, library));
  autosave.schedule();
}

async function findInCircuit(): Promise<void> {
  const q = (await showPrompt('Find (net / port / chip / label):', ''))?.trim().toLowerCase();
  if (!q) return;
  const hits: Component[] = [];
  for (const c of editor.circuit.components.values()) {
    let hay = '';
    if (c.kind === 'label' || c.kind === 'port') hay = c.name;
    else if (c.kind === 'chip') hay = library.has(c.defId) ? library.get(c.defId).name : '';
    else if (c.kind === 'probe' && c.label) hay = c.label;
    else if (c.kind === 'ram') hay = 'ram';
    else if (c.kind === 'rom') hay = 'rom';
    else hay = c.kind;
    if (hay.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) hits.push(c);
  }
  if (hits.length === 0) {
    await showAlert(`No match for "${q}".`);
    return;
  }
  editor.selectedIds = new Set(hits.map((c) => c.id));
  editor.selectedWireId = null;
  // Prefer highlighting a label/port net when the query matches one.
  const labelOrPort = hits.find((c) => c.kind === 'label' || c.kind === 'port');
  if (labelOrPort) {
    const pin =
      labelOrPort.kind === 'label'
        ? labelOrPort.pins.net
        : labelOrPort.kind === 'port'
          ? labelOrPort.pins.io
          : null;
    if (pin) {
      const nets = editor.circuit.computeNets();
      const netId = nets.netOf.get(pin.id);
      if (netId) editor.highlightedNetId = netId;
    }
  }
  const b = boundsOfIds(hits.map((c) => c.id));
  camera.fit(b, vw(), vh());
  uiDirty = true;
  syncInspector();
}

function boundsOfIds(ids: string[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const c = editor.circuit.components.get(id);
    if (!c) continue;
    minX = Math.min(minX, c.pos.x);
    minY = Math.min(minY, c.pos.y);
    maxX = Math.max(maxX, c.pos.x);
    maxY = Math.max(maxY, c.pos.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const pad = 80;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

async function foldSelection(): Promise<void> {
  if (editor.selectedIds.size === 0) return;
  const warnings = foldPortWarnings(editor.circuit, editor.selectedIds);
  if (warnings.length > 0) {
    const ok = await showConfirm(`${warnings.join('\n')}\n\nFold anyway?`);
    if (!ok) return;
  }
  const name = await showPrompt('Chip name:', 'CHIP');
  if (!name) return;
  editHistory.checkpoint(editor.circuit);
  const pos = snap(centroid(boundsOfSelection()));
  const { instance } = fold(editor.circuit, editor.selectedIds, name, library, pos);
  editor.selectedIds = new Set([instance.id]);
  refreshChipPalette();
  autosave.schedule();
}

async function unfoldSelection(): Promise<void> {
  const ids = [...editor.selectedIds];
  const chips = ids
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is ChipInstanceComponent => !!c && c.kind === 'chip');
  if (chips.length === 0) {
    await showAlert('Select one or more chip instances to unfold.');
    return;
  }
  editHistory.checkpoint(editor.circuit);
  const newIds = new Set<string>();
  for (const chip of chips) {
    const { ids: placed } = unfold(editor.circuit, chip.id, library);
    for (const id of placed) newIds.add(id);
  }
  editor.selectedIds = newIds;
  editor.selectedWireId = null;
  uiDirty = true;
  syncInspector();
  autosave.schedule();
}

function boundsOfSelection(): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of editor.selectedIds) {
    const c = editor.circuit.components.get(id);
    if (!c) continue;
    minX = Math.min(minX, c.pos.x);
    minY = Math.min(minY, c.pos.y);
    maxX = Math.max(maxX, c.pos.x);
    maxY = Math.max(maxY, c.pos.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

// --- Insert prebuilt blocks ------------------------------------------------
// buildRegister()/buildAlu() (blocks.ts) place several wired-together chip
// instances at once — placing that many raw transistors by hand (a naive
// 8-bit register is on the order of 8 * ~60 transistors) isn't a reasonable
// ask of anyone clicking a palette. Width is prompted, not a fixed 8, since
// nothing else about these functions is width-specific.
async function promptWidth(label: string, defaultBits = '4'): Promise<number | null> {
  const raw = await showPrompt(`${label} width (bits):`, defaultBits);
  if (!raw) return null;
  const bits = Math.trunc(Number(raw));
  if (!Number.isFinite(bits) || bits < 1) return null;
  return Math.min(bits, 32); // a soft cap — a wider composite means more top-level components for the still-unfixed Canvas 2D render cost (see ARCHITECTURE.md's "Canvas 2D rendering cost"), not a flatten() cost anymore
}

document.getElementById('add-register')?.addEventListener('click', async () => {
  const bits = await promptWidth('Register');
  if (bits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildRegister(editor.circuit, library, bits, pos);
  refreshChipPalette();
});

document.getElementById('add-alu')?.addEventListener('click', async () => {
  const bits = await promptWidth('ALU');
  if (bits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildAlu(editor.circuit, library, bits, pos);
  refreshChipPalette();
});

document.getElementById('add-pc')?.addEventListener('click', async () => {
  const bits = await promptWidth('Program counter');
  if (bits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildProgramCounter(editor.circuit, library, bits, pos);
  refreshChipPalette();
});

document.getElementById('add-ir')?.addEventListener('click', () => {
  // No width prompt: an instruction register is fixed at 8 bits, a Z80
  // opcode byte — see buildInstructionRegister's doc comment.
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildInstructionRegister(editor.circuit, library, pos);
  refreshChipPalette();
});

document.getElementById('add-fsm')?.addEventListener('click', async () => {
  const phases = await promptWidth('FSM phase count');
  if (phases === null || phases < 2) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildRingCounter(editor.circuit, library, phases, pos);
  refreshChipPalette();
});

/** Parses "00,01,ff" into an array of 8-bit LSB-first words, rounded up to a power-of-two count (padded with 0x00) — the shape buildStubRom requires. */
async function promptRomBytes(): Promise<(0 | 1)[][] | null> {
  const raw = await showPrompt('ROM bytes, comma-separated hex (e.g. 00,01,02,03):', '00,01,02,03');
  if (!raw) return null;
  const bytes = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (bytes.length === 0) return null;

  let wordCount = 1;
  while (wordCount < bytes.length) wordCount *= 2;
  return Array.from({ length: wordCount }, (_, i) => {
    const byte = (bytes[i] ?? 0) & 0xff;
    return Array.from({ length: 8 }, (_, bit) => ((byte >> bit) & 1) as 0 | 1);
  });
}

document.getElementById('add-rom')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('ROM address bits', '8');
  if (addrBits === null) return;
  const raw = await showPrompt('Optional initial hex bytes (comma-separated, blank = zeros):', '');
  let initial: Uint8Array | undefined;
  if (raw && raw.trim()) {
    const bytes = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 16))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .map((b) => b & 0xff);
    if (bytes.length > 0) initial = Uint8Array.from(bytes);
  }
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  const rom = makeRom(editor.circuit, addrBits, 8, initial, pos);
  memoryEditor.attach(rom);
});

document.getElementById('add-stub-rom')?.addEventListener('click', async () => {
  const words = await promptRomBytes();
  if (words === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  buildStubRom(editor.circuit, library, words, pos);
  refreshChipPalette();
});

document.getElementById('add-ram')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('RAM address bits');
  if (addrBits === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  const ram = makeRam(editor.circuit, addrBits, 8, undefined, pos);
  memoryEditor.attach(ram);
});

/** Parses "05,83,0a,81" into raw program bytes for the Tiny CPU's RAM — no power-of-two rounding needed here (makeRam's own `initial` handles a program shorter than the RAM's full capacity by leaving the rest zeroed). */
async function promptProgramBytes(): Promise<Uint8Array | null> {
  const raw = await showPrompt('Program bytes, comma-separated hex (e.g. 05,83,0a,81 — see ARCHITECTURE.md\'s "Decode and execute" for the LDI/ADI encoding):', TINY_CPU_BLINK_HEX);
  if (!raw) return null;
  const bytes = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (bytes.length === 0) return null;
  return Uint8Array.from(bytes.map((b) => b & 0xff));
}

document.getElementById('add-cpu')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('CPU RAM address bits');
  if (addrBits === null) return;
  const program = await promptProgramBytes();
  if (program === null) return;
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  const { chip } = placeTinyCpu(editor.circuit, library, addrBits, program, pos);
  addBlinkBench(editor.circuit, chip);
  refreshChipPalette();
});

/**
 * Default demo: Z80 command ROM (TTY H/M/W/G on FB @ 0xE00). Needs addrBits ≥ 12.
 * For soft CP/M use addrBits=16 then TTY → Boot CP/M.
 */
const Z80_MONITOR_HEX = commandRomHexPrompt();

/** Same shape as promptProgramBytes(), defaulted to the command ROM. */
async function promptZ80ProgramBytes(): Promise<Uint8Array | null> {
  const raw = await showPrompt(
    'Program bytes, comma-separated hex — default is the Z80 command ROM (TTY H/M/W/G; FB @ 0xE00; needs 12-bit RAM). Or Insert → LED blink… for OUT 0x40 → canvas LED. Use 16-bit RAM + Boot CP/M for soft CP/M:',
    Z80_MONITOR_HEX,
  );
  if (!raw) return null;
  const bytes = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 16))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (bytes.length === 0) return null;
  return Uint8Array.from(bytes.map((b) => b & 0xff));
}

/** Place a Z80CPU + optional soft machine wiring; fold and fit view. */
function placeZ80Machine(
  addrBits: number,
  program: Uint8Array | undefined,
  afterAttach?: () => void,
): void {
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  machineRunner.detach();

  const beforeIds = new Set(editor.circuit.components.keys());
  const cpu = buildZ80Cpu(editor.circuit, library, addrBits, program, pos);
  const placedIds = newComponentIdSet(editor.circuit, beforeIds);

  if (addrBits >= MACHINE_ADDR_BITS) {
    const simTick = () => {
      const flat = flatten(topCircuit, library);
      const flatNetMap = flat.computeNets();
      lastFlatNetMap = flatNetMap;
      simState = step(flat, flatNetMap, simState);
    };
    machinePanel.attach(cpu.ram);
    machinePanel.bindRunner(machineRunner);
    machineRunner.attach(editor.circuit, library, cpu, simTick, {
      readPin: (pin) => {
        if (!lastFlatNetMap) return 'Z';
        const net = lastFlatNetMap.netOf.get(pin.id);
        if (!net) return 'Z';
        return simState.levelOf.get(net) ?? 'Z';
      },
    });
    machineRunner.boot();
    machineRunner.setSpeed('soft');
    machineRunner.setRunning(true);
    makeTty(editor.circuit, { x: pos.x + 120, y: pos.y - 80 }, cpu.ram.id);
    afterAttach?.();
    machinePanel.refreshControls();
    machinePanel.draw();
  } else {
    machinePanel.detach();
    machineRunner.detach();
  }

  foldZ80CpuLeavingRam(editor.circuit, library, placedIds, pos);
  packFoldedMachine(editor.circuit, pos);
  replaceLongWiresWithLabels(editor.circuit, 24);
  camera.fit(circuitBounds(editor.circuit), vw(), vh());
  refreshChipPalette();
}

document.getElementById('add-z80cpu')?.addEventListener('click', async () => {
  const addrBits = await promptWidth('Z80 CPU RAM address bits', String(MACHINE_ADDR_BITS));
  if (addrBits === null) return;
  const program = await promptZ80ProgramBytes();
  if (program === null) return;
  placeZ80Machine(addrBits, program);
});

/** Soft machine + canvas LED: OUT (0x40) bit0 blinks the LED. */
function placeLedBlinkMachine(): void {
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  machineRunner.detach();

  const beforeIds = new Set(editor.circuit.components.keys());
  const cpu = buildZ80Cpu(editor.circuit, library, MACHINE_ADDR_BITS, LED_BLINK_ROM_BYTES, pos);
  const placedIds = newComponentIdSet(editor.circuit, beforeIds);

  const simTick = () => {
    const flat = flatten(topCircuit, library);
    const flatNetMap = flat.computeNets();
    lastFlatNetMap = flatNetMap;
    simState = step(flat, flatNetMap, simState);
  };
  machinePanel.attach(cpu.ram);
  machinePanel.bindRunner(machineRunner);
  machineRunner.attach(editor.circuit, library, cpu, simTick, {
    readPin: (pin) => {
      if (!lastFlatNetMap) return 'Z';
      const net = lastFlatNetMap.netOf.get(pin.id);
      if (!net) return 'Z';
      return simState.levelOf.get(net) ?? 'Z';
    },
  });

  // Gates: OUT 0x40 ∧ D0 decode (outside fold so taps become chip ports).
  const gateLed = placeLabLedGateDecode(editor.circuit, library, cpu, {
    x: pos.x + CHIP_INSTANCE_WIDTH / 2 + 40,
    y: pos.y + 200,
  });

  // Named bus-control ports (outside fold selection) → stable ChipDef names.
  const busPortX = pos.x + CHIP_INSTANCE_WIDTH / 2 + 40;
  const busPortY = pos.y + 320;
  const exposeBus = (name: string, pin: typeof cpu.iorq, dy: number) => {
    const p = makePort(editor.circuit, name, { x: busPortX, y: busPortY + dy }, 'out');
    wire(editor.circuit, pin, p.pins.io);
  };
  exposeBus('IORQ', cpu.iorq, 0);
  exposeBus('M1', cpu.m1, 40);
  exposeBus('RD', cpu.rd, 80);
  exposeBus('WR', cpu.wr, 120);
  exposeBus('MREQ', cpu.mreq, 160);
  exposeBus('IOWRITE', cpu.ioWrite, 200);
  exposeBus('IOREAD', cpu.ioRead, 240);

  // Fold/pack first so the lab LED Input is not sucked into the seed grid.
  foldZ80CpuLeavingRam(editor.circuit, library, placedIds, pos);
  packFoldedMachine(editor.circuit, pos);
  replaceLongWiresWithLabels(editor.circuit, 24);

  const ledX = pos.x + CHIP_INSTANCE_WIDTH / 2 + 200;
  const ledY = pos.y - 40;
  const led = makeLed(editor.circuit, { x: ledX + 60, y: ledY }, 'LAB_LED');
  // Gates decode drives the LED electrically; Soft Run uses forceOn paint only
  // (no Soft Input on this net — avoids fighting the gate decode).
  wire(editor.circuit, gateLed, led.pins.in);
  const ledNet = makeLabel(editor.circuit, 'LAB_LED', { x: ledX + 30, y: ledY - 16 });
  wire(editor.circuit, led.pins.in, ledNet.pins.net);

  // Soft Run host probes — paint shared semantic nets (not electrically tied
  // into Z80CPU outputs — avoids fighting Gates bus drivers). Same names as
  // ChipDef ports for Soft canvas parity.
  const iorqProbe = makeInput(editor.circuit, 0, { x: ledX, y: ledY - 50 });
  const ioWriteProbe = makeInput(editor.circuit, 0, { x: ledX + 50, y: ledY - 50 });
  const ioReadProbe = makeInput(editor.circuit, 0, { x: ledX + 100, y: ledY - 50 });
  const m1Probe = makeInput(editor.circuit, 0, { x: ledX + 150, y: ledY - 50 });
  wire(
    editor.circuit,
    iorqProbe.pins.out,
    makeLabel(editor.circuit, 'IORQ', { x: ledX + 20, y: ledY - 66 }).pins.net,
  );
  wire(
    editor.circuit,
    ioWriteProbe.pins.out,
    makeLabel(editor.circuit, 'IOWRITE', { x: ledX + 70, y: ledY - 66 }).pins.net,
  );
  wire(
    editor.circuit,
    ioReadProbe.pins.out,
    makeLabel(editor.circuit, 'IOREAD', { x: ledX + 120, y: ledY - 66 }).pins.net,
  );
  wire(
    editor.circuit,
    m1Probe.pins.out,
    makeLabel(editor.circuit, 'M1', { x: ledX + 170, y: ledY - 66 }).pins.net,
  );
  machineRunner.bindSoftIoProbes({
    iorq: iorqProbe,
    ioWrite: ioWriteProbe,
    ioRead: ioReadProbe,
    m1: m1Probe,
  });

  machineRunner.bindLabLed(led, null);
  machineRunner.boot();
  machineRunner.setSpeed('soft');
  machineRunner.setRunning(true);
  makeTty(editor.circuit, { x: pos.x + 120, y: pos.y - 80 }, cpu.ram.id);
  machinePanel.refreshControls();
  machinePanel.draw();

  camera.fit(circuitBounds(editor.circuit), vw(), vh());
  refreshChipPalette();
  uiDirty = true;
}

document.getElementById('add-led-blink')?.addEventListener('click', () => {
  placeLedBlinkMachine();
});

function placePortTtyMachine(): void {
  placeZ80Machine(MACHINE_ADDR_BITS, PORT_TTY_ROM_BYTES);
}

document.getElementById('add-port-tty')?.addEventListener('click', () => {
  placePortTtyMachine();
});

/** Soft Lab REG8 + COUNTER4 via ports 0x41 / 0x42 (explicit bind, no auto-scan). */
function placeLabRegMachine(): void {
  const pos = snap(camera.screenToWorld({ x: vw() / 2, y: vh() / 2 }, vw(), vh()));
  machineRunner.detach();

  const beforeIds = new Set(editor.circuit.components.keys());
  const cpu = buildZ80Cpu(editor.circuit, library, MACHINE_ADDR_BITS, LAB_REG_ROM_BYTES, pos);
  const placedIds = newComponentIdSet(editor.circuit, beforeIds);

  const simTick = () => {
    const flat = flatten(topCircuit, library);
    const flatNetMap = flat.computeNets();
    lastFlatNetMap = flatNetMap;
    simState = step(flat, flatNetMap, simState);
  };
  machinePanel.attach(cpu.ram);
  machinePanel.bindRunner(machineRunner);
  machineRunner.attach(editor.circuit, library, cpu, simTick, {
    readPin: (pin) => {
      if (!lastFlatNetMap) return 'Z';
      const net = lastFlatNetMap.netOf.get(pin.id);
      if (!net) return 'Z';
      return simState.levelOf.get(net) ?? 'Z';
    },
  });

  foldZ80CpuLeavingRam(editor.circuit, library, placedIds, pos);
  packFoldedMachine(editor.circuit, pos);
  replaceLongWiresWithLabels(editor.circuit, 24);

  const labX = pos.x + CHIP_INSTANCE_WIDTH / 2 + 200;
  const labY = pos.y - 40;
  const regDef = library.findByName('REG8');
  const ctrDef = library.findByName('COUNTER4');
  if (!regDef || !ctrDef) {
    void showAlert('Lab REG/COUNTER demo needs Soft Lab REG8 and COUNTER4 in the library.');
    return;
  }
  const reg = makeChipInstance(editor.circuit, regDef, { x: labX, y: labY });
  const ctr = makeChipInstance(editor.circuit, ctrDef, { x: labX + 160, y: labY });
  makeLabel(editor.circuit, 'LAB_REG', { x: labX + 20, y: labY - 24 });
  makeLabel(editor.circuit, 'LAB_CTR', { x: labX + 180, y: labY - 24 });
  machineRunner.bindLabReg(reg);
  machineRunner.bindLabCounter(ctr);

  machineRunner.boot();
  machineRunner.setSpeed('soft');
  machineRunner.setRunning(true);
  makeTty(editor.circuit, { x: pos.x + 120, y: pos.y - 80 }, cpu.ram.id);
  machinePanel.refreshControls();
  machinePanel.draw();

  camera.fit(circuitBounds(editor.circuit), vw(), vh());
  refreshChipPalette();
  uiDirty = true;
}

document.getElementById('add-lab-reg')?.addEventListener('click', () => {
  placeLabRegMachine();
});

document.getElementById('add-spectrum')?.addEventListener('click', () => {
  placeZ80Machine(16, new Uint8Array(0), () => machinePanel.bootSpectrumMachine('48'));
});

document.getElementById('add-spectrum128')?.addEventListener('click', () => {
  placeZ80Machine(16, new Uint8Array(0), () => machinePanel.bootSpectrumMachine('128'));
});

// --- Project & chip file I/O ------------------------------------------------
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('export-project')?.addEventListener('click', () => {
  exportActiveSession();
});

function exportActiveSession(): void {
  const meta = getSessionMeta();
  const slot = meta.slots.find((s) => s.id === meta.activeId);
  const safe = (slot?.name ?? 'session').replace(/[^\w.-]+/g, '_');
  downloadJson(`${safe}.json`, serializeProject(topCircuit, library));
}

autosaveStatusEl?.addEventListener('click', () => {
  void (async () => {
    if (lastAutosaveUiStatus === 'conflict') {
      const pick = await showChoice(
        'This session was saved in another tab. What should this tab do?',
        [
          {
            value: 'restore',
            label: 'Restore local',
            detail: 'Keep this tab’s edits and overwrite the other tab’s save',
          },
          {
            value: 'load',
            label: 'Load other',
            detail: 'Discard local edits and reload the other tab’s save',
          },
          {
            value: 'export',
            label: 'Export…',
            detail: 'Download this tab’s project JSON first (safe copy)',
          },
        ],
      );
      if (!pick || pick.action === 'delete') return;
      if (pick.value === 'export') {
        exportActiveSession();
        return;
      }
      if (pick.value === 'restore') {
        await autosave.forceOverwrite();
        await showAlert('Local session written — other tabs may show a conflict until they reload.');
        return;
      }
      if (pick.value === 'load') {
        const meta = getSessionMeta();
        const data = await loadSlot(meta.activeId);
        if (!data) {
          await showAlert('Could not load the other tab’s save.');
          return;
        }
        try {
          applyLoadedProject(deserializeProject(data));
          autosave.adoptWriteGen(meta.activeId);
          resetViewAfterProjectLoad();
          setAutosaveStatusUi('idle');
        } catch (err) {
          await showAlert(`Could not load: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    if (lastAutosaveUiStatus === 'error') {
      const pick = await showChoice('Autosave failed (storage full or blocked).', [
        { value: 'export', label: 'Export JSON…', detail: 'Save a file copy of this session' },
        { value: 'retry', label: 'Retry save', detail: 'Try writing the session again' },
      ]);
      if (!pick || pick.action === 'delete') return;
      if (pick.value === 'export') exportActiveSession();
      else await autosave.flush();
      return;
    }
    exportActiveSession();
  })();
});

const watchStripEl = document.getElementById('watch-strip');

function refreshWatchStrip(): void {
  if (!watchStripEl) return;
  const probes = [...editor.circuit.components.values()].filter((c) => c.kind === 'probe');
  if (probes.length === 0) {
    watchStripEl.classList.remove('visible');
    watchStripEl.replaceChildren();
    return;
  }
  watchStripEl.classList.add('visible');
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(watchStripEl.children)) {
    const id = (child as HTMLElement).dataset.probeId;
    if (id) existing.set(id, child as HTMLElement);
  }
  watchStripEl.replaceChildren();
  const title = document.createElement('span');
  title.className = 'watch-label';
  title.textContent = 'Watch';
  watchStripEl.appendChild(title);
  for (const p of probes) {
    if (p.kind !== 'probe') continue;
    let item = existing.get(p.id);
    if (!item) {
      item = document.createElement('span');
      item.className = 'watch-item';
      item.dataset.probeId = p.id;
      const name = document.createElement('span');
      name.className = 'watch-name';
      const lvl = document.createElement('span');
      lvl.className = 'watch-lvl';
      lvl.dataset.lvl = 'Z';
      lvl.textContent = 'Z';
      item.append(name, lvl);
    }
    const nameEl = item.querySelector('.watch-name')!;
    nameEl.textContent = p.label?.trim() || 'probe';
    watchStripEl.appendChild(item);
  }
}

function updateWatchLevels(
  resolve: (localPinId: string) => { level: Level; contended: boolean },
): void {
  if (!watchStripEl?.classList.contains('visible')) return;
  let stale = false;
  for (const child of Array.from(watchStripEl.querySelectorAll('.watch-item'))) {
    const id = (child as HTMLElement).dataset.probeId;
    if (!id) continue;
    const c = editor.circuit.components.get(id);
    if (!c || c.kind !== 'probe') {
      stale = true;
      continue;
    }
    const { level } = resolve(c.pins.in.id);
    const lvlEl = child.querySelector('.watch-lvl') as HTMLElement | null;
    if (!lvlEl) continue;
    const text = String(level);
    lvlEl.dataset.lvl = text;
    lvlEl.textContent = text;
  }
  // Probe deleted but strip not yet rebuilt (e.g. structure bump raced).
  if (stale) refreshWatchStrip();
}

refreshWatchStrip();

function resetViewAfterProjectLoad(): void {
  tutorial.stop();
  navStack.length = 0;
  navStack.push({ circuit: topCircuit, pathPrefix: '', label: 'top' });
  editor.circuit = topCircuit;
  editor.clearSelection();
  editor.clearClipboard();
  editor.cancelWire();
  // Library was replaced — any place-chip defId from the previous session is
  // gone (throws "unknown chip definition" on click and freezes interaction).
  setTool({ kind: 'select' });
  editHistory.clear();
  simState = initialState();
  renderBreadcrumb();
  refreshChipPalette();
  refreshWatchStrip();
  camera.fit(circuitBounds(topCircuit), vw(), vh());
  machineRunner.detach();
  machinePanel.detach();
  memoryEditor.detach();
  logicAnalyzer.clearChannels();
  objectInspector.setContext({
    circuit: topCircuit,
    library,
    defId: null,
    allCircuits: [topCircuit, ...library.list().map((d) => d.circuit)],
  });
  objectInspector.sync(null);
  uiDirty = true;
  autosave.schedule();
}

async function loadExampleById(id: string, confirmReplace = true): Promise<boolean> {
  const ex = EXAMPLE_PROJECTS.find((e) => e.id === id);
  if (!ex) {
    await showAlert(`Unknown example “${id}”.`);
    return false;
  }
  if (
    confirmReplace &&
    topCircuit.components.size > 0 &&
    !(await showConfirm(
      `Load “${ex.title}”? This replaces the current circuit and chip library in this session.`,
    ))
  ) {
    return false;
  }
  try {
    applyLoadedProject(deserializeProject(ex.project));
    // One-shot channel assignment (not per-frame) so lab fanouts stay readable.
    editor.tidyAllWires(false);
    resetViewAfterProjectLoad();
    const ci = labCurriculumIndex(id);
    if (ci >= 0) {
      labCourseIndex = ci;
      // Keep the checklist panel in sync when the same example is opened from
      // Help tutorials / File → Examples (not only Lab course Next/Prev).
      if (labCoursePanel.win.visible) labCoursePanel.showStep(ci);
    }
    return true;
  } catch (err) {
    await showAlert(`Could not load example: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

let labCourseIndex = -1;
const labCoursePanel = new LabCoursePanel();
labCoursePanel.onNavigate = (index) => {
  void openLabCourse(index);
};
const labManual = new LabManual();
labManual.onOpenLabCourse = () => {
  const idx = labCourseIndex >= 0 ? labCourseIndex : 0;
  void openLabCourse(idx);
};

async function openLabCourse(startIndex = 0): Promise<void> {
  const step = labCurriculumStep(startIndex);
  if (!step) return;
  if (!(await loadExampleById(step.id, true))) return;
  labCourseIndex = startIndex;
  labCoursePanel.showStep(startIndex);
}

/** File → Demo → Digital: every EXAMPLE_PROJECTS entry (gates / Soft Lab, no Z80). */
function populateDigitalDemoMenu(): void {
  const host = document.getElementById('demo-digital-list');
  if (!host) return;
  host.replaceChildren();
  const groups: ExampleGroup[] = ['Basics', 'Soft Lab', 'Memory'];
  for (const group of groups) {
    const items = EXAMPLE_PROJECTS.filter((ex) => ex.group === group);
    if (items.length === 0) continue;
    const head = document.createElement('div');
    head.className = 'menu-section';
    head.textContent = group;
    host.appendChild(head);
    for (const ex of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item';
      btn.dataset.exampleId = ex.id;
      btn.title = `${ex.detail} (#e=${ex.id})`;
      btn.appendChild(document.createTextNode(ex.title));
      const desc = document.createElement('span');
      desc.className = 'item-desc';
      desc.textContent = ex.detail;
      btn.appendChild(desc);
      btn.addEventListener('click', () => {
        void loadExampleById(ex.id);
      });
      host.appendChild(btn);
    }
  }
}

populateDigitalDemoMenu();

async function openLatchTutorial(): Promise<void> {
  if (!(await loadExampleById('d-latch', true))) return;
  await showAlert(
    'Latch walkthrough:\n\n' +
      '1. Toggle D (data) with the select tool.\n' +
      '2. Pulse or hold Enable so Q follows D.\n' +
      '3. Release Enable — Q holds the last value.\n' +
      '4. Double-click the chip to dive into its gates.\n\n' +
      'Press ? for keyboard shortcuts.',
  );
}

async function openLabCounterTutorial(): Promise<void> {
  const id = EXAMPLE_PROJECTS.some((e) => e.id === 'lab-counter-7seg')
    ? 'lab-counter-7seg'
    : 'lab-shift-counter';
  if (!(await loadExampleById(id, true))) return;
  setSoftLabEnabled(true);
  updateSoftLabChrome();
  await showAlert(
    'Lab counter walkthrough:\n\n' +
      '1. Soft Lab is on — COUNTER4 / BCD_7SEG run as fast behavioral chips.\n' +
      '2. Toggle Clear off so the counter can leave 0.\n' +
      '3. Watch the 7-seg count with the free-running pulse.\n' +
      '4. Turn Soft Lab off to expand chips into transistors (slower).\n' +
      '5. Library → Lab filter lists REG/SHIFT/COUNTER packs.\n\n' +
      'Press ? for keyboard shortcuts.',
  );
}

async function startButtonLedTutorial(): Promise<void> {
  if (
    topCircuit.components.size > 0 &&
    !(await showConfirm(
      'Start the button→LED tutorial? This clears the canvas (current circuit is replaced).',
    ))
  ) {
    return;
  }
  if (topCircuit.components.size > 0) {
    topCircuit.components.clear();
    topCircuit.wires.clear();
    bumpStructureVersion();
    library.clear();
    seedStandardCells(library);
    resetViewAfterProjectLoad();
  } else {
    tutorial.stop();
  }
  tutorial.start(topCircuit);
  uiDirty = true;
}

document.getElementById('help-cheatsheet')?.addEventListener('click', () => toggleCheatSheet());
document.getElementById('help-lab-manual')?.addEventListener('click', () => labManual.open());
document.getElementById('help-tutorial')?.addEventListener('click', () => {
  void startButtonLedTutorial();
});
document.getElementById('help-tutorial-latch')?.addEventListener('click', () => void openLatchTutorial());
document.getElementById('help-tutorial-lab')?.addEventListener('click', () => void openLabCounterTutorial());
document.getElementById('help-lab-course')?.addEventListener('click', () => {
  const idx = labCourseIndex >= 0 ? labCourseIndex : 0;
  void openLabCourse(idx);
});

async function bootFromUrlHash(): Promise<void> {
  const exampleId = parseExampleHash(location.hash);
  if (exampleId) {
    const fresh = topCircuit.components.size === 0;
    const ok = await loadExampleById(exampleId, !fresh);
    if (ok) {
      const ci = labCurriculumIndex(exampleId);
      if (ci >= 0) labCourseIndex = ci;
    }
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return;
  }
  const demoId = parseDemoHash(location.hash);
  if (demoId) {
    try {
      const { findSpectrumGame } = await import('./machine/spectrum/gamesData.js');
      const entry = findSpectrumGame(demoId);
      const model = entry?.model ?? '48';
      placeZ80Machine(16, new Uint8Array(0), () => machinePanel.bootSpectrumMachine(model));
      await machinePanel.loadBundledDemoById(demoId);
      showDemoTeachOverlay(demoId);
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (err) {
      await showAlert(
        `Could not load demo "${demoId}": ${err instanceof Error ? err.message : String(err)}`,
      );
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    return;
  }
  if (hasSnaHash(location.hash)) {
    try {
      const { decodeSnaHash } = await import('./sim/snaShare.js');
      const { isSna128 } = await import('./machine/spectrum/sna.js');
      const sna = await decodeSnaHash(location.hash);
      if (!sna) throw new Error('Invalid #sna= payload');
      const model = isSna128(sna) ? '128' : '48';
      placeZ80Machine(16, new Uint8Array(0), () => machinePanel.bootSpectrumMachine(model));
      machineRunner.loadSpectrumSna(sna);
      machinePanel.setVisible(true);
      showDemoTeachOverlay('sna');
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (err) {
      await showAlert(`Could not load #sna= link: ${err instanceof Error ? err.message : String(err)}`);
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    return;
  }
  const shared = await decodeShareHash(location.hash);
  if (!shared) return;
  if (
    topCircuit.components.size > 0 &&
    !(await showConfirm(
      'Load project from share link? This replaces the current circuit and chip library in this session.',
    ))
  ) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return;
  }
  try {
    applyLoadedProject(deserializeProject(shared));
    resetViewAfterProjectLoad();
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch (err) {
    await showAlert(`Could not load share link: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function showDemoTeachOverlay(kind: string): void {
  let el = document.getElementById('demo-teach-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'demo-teach-overlay';
    el.innerHTML =
      '<div class="demo-teach-card"><strong data-teach-title>Spectrum demo ready</strong>' +
      '<p data-teach-body></p>' +
      '<button type="button" class="primary">Got it</button></div>';
    document.body.appendChild(el);
    el.querySelector('button')?.addEventListener('click', () => {
      el!.hidden = true;
    });
  }
  const title = el.querySelector('[data-teach-title]');
  const body = el.querySelector('[data-teach-body]');
  const tapish = kind !== 'sna' && kind !== 'rainbow';
  void import('./ui/spectrumDemoHints.js').then(({ spectrumDemoHint }) => {
    const hint = spectrumDemoHint(kind);
    if (title) title.textContent = tapish ? 'TAP demo loading' : 'Spectrum demo ready';
    if (body) {
      const base = tapish
        ? 'Spectrum tab · wait for auto LOAD "" · click the screen so keys go to Spectrum (not the editor).'
        : 'Open the Spectrum tab · click the screen · Enter for K · type or use the on-screen keys.';
      const pause = tapish
        ? ' On “Press any key” / PAUSE, hold Space briefly (quick taps can miss a frame).'
        : '';
      body.textContent = `${base}${pause}${hint.teachExtra ? ` ${hint.teachExtra}` : ''} Pad: ${hint.padHint}`;
    }
  });
  el.dataset.demo = kind;
  el.hidden = false;
}

// Boot from `#demo=…` / `#sna=…` / `#p=…` after UI wiring; also handle hash-only navigations.
void bootFromUrlHash();
window.addEventListener('hashchange', () => {
  void bootFromUrlHash();
});

machinePanel.onCopySnaLink = () => {
  void (async () => {
    try {
      const sna = await machineRunner.saveSpectrumSna();
      const { encodeSnaHash } = await import('./sim/snaShare.js');
      const enc = await encodeSnaHash(sna);
      if (!enc.ok) {
        await showAlert(`SNA too large for URL (${Math.round(enc.size / 1024)} KB).`);
        return;
      }
      const url = `${location.origin}${location.pathname}${location.search}${enc.hash}`;
      try {
        await navigator.clipboard.writeText(url);
        await showAlert('SNA share link copied to clipboard.');
      } catch {
        await showPrompt('Copy this SNA URL:', url);
      }
    } catch (err) {
      await showAlert(`Could not copy SNA link: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

document.getElementById('copy-share-link')?.addEventListener('click', () => {
  void (async () => {
    const encoded = await encodeShareHash(serializeProject(topCircuit, library));
    if (!encoded.ok) {
      await showAlert(
        `Project is too large to put in a URL (${Math.round(encoded.size / 1024)} KB > 1.5 MB). Export JSON instead.`,
      );
      return;
    }
    const url = `${location.origin}${location.pathname}${location.search}${encoded.hash}`;
    try {
      await navigator.clipboard.writeText(url);
      history.replaceState(null, '', encoded.hash);
      await showAlert('Share link copied to clipboard.');
    } catch {
      await showPrompt('Copy this share URL:', url);
    }
  })();
});

const importProjectInput = document.getElementById('import-project-file') as HTMLInputElement;
document.getElementById('import-project')?.addEventListener('click', () => importProjectInput.click());
importProjectInput.addEventListener('change', async () => {
  const file = importProjectInput.files?.[0];
  importProjectInput.value = ''; // so picking the same file again still fires 'change'
  if (!file) return;
  if (!(await showConfirm('Import project? This replaces the current circuit and chip library entirely.'))) return;
  file
    .text()
    .then((text) => {
      const loaded = deserializeProject(JSON.parse(text) as SerializedProject);
      applyLoadedProject(loaded);
      resetViewAfterProjectLoad();
    })
    .catch((err: unknown) => {
      void showAlert(`Could not load that project file: ${err instanceof Error ? err.message : String(err)}`);
    });
});

document.getElementById('export-chip')?.addEventListener('click', async () => {
  const chips = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is ChipInstanceComponent => c?.kind === 'chip');
  if (chips.length !== 1) {
    await showAlert('Select exactly one chip instance first — that chip\'s definition is what gets exported.');
    return;
  }
  const def = library.get(chips[0]!.defId);
  downloadJson(`${def.name}.json`, serializeChipDef(def, library));
});

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSchematicPng(): void {
  const bounds = circuitBounds(editor.circuit);
  const w = 1600;
  const h = 1000;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  if (!octx) return;
  const cam = new Camera();
  cam.fit(bounds, w, h);
  const view = navStack[navStack.length - 1]!;
  const flat = flatten(topCircuit, library);
  const flatNetMap = flat.computeNets();
  const resolve = (localPinId: string): { level: Level; contended: boolean } => {
    const net = flatNetMap.netOf.get(view.pathPrefix + localPinId);
    if (!net) return { level: 'Z', contended: false };
    return { level: simState.levelOf.get(net) ?? 'Z', contended: simState.contended.has(net) };
  };
  draw(octx, cam, w, h, editor.circuit, resolve, editor, library);
  off.toBlob((blob) => {
    if (blob) downloadBlob('schematic.png', blob);
  }, 'image/png');
}

function exportSchematicSvg(): void {
  const circuit = editor.circuit;
  const bounds = circuitBounds(circuit);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const pinById = new Map([...circuit.allPins()].map((p) => [p.id, p]));
  const nets = circuit.computeNets();
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${w} ${h}" ` +
      `width="${Math.round(w)}" height="${Math.round(h)}">`,
  );
  parts.push(
    `<rect fill="#0b0c10" x="${bounds.minX}" y="${bounds.minY}" width="${w}" height="${h}"/>`,
  );

  for (const w of circuit.wires.values()) {
    const a = pinById.get(w.a);
    const b = pinById.get(w.b);
    if (!a || !b) continue;
    const raw = w.waypoints?.length ? [a.pos, ...w.waypoints, b.pos] : [a.pos, b.pos];
    const pts = routeWirePoints(raw);
    const netName = editor.formatNetName(nets.netOf.get(w.a) ?? null);
    const bus = isBusName(netName) || isBusName(a.name) || isBusName(b.name);
    parts.push(
      `<polyline fill="none" stroke="#9aa1b3" stroke-width="${bus ? 3.2 : 2}" stroke-linecap="round" stroke-linejoin="round" ` +
        `points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}"/>`,
    );
  }

  const pinDot = (x: number, y: number) =>
    parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="#7d8496"/>`);

  for (const c of circuit.components.values()) {
    const { x, y } = c.pos;
    switch (c.kind) {
      case 'transistor': {
        const stroke = c.type === 'N' ? '#5fd0d6' : '#e8b358';
        const isN = c.type === 'N';
        const srcBarY = isN ? 10 : -10;
        const g = (dx: number, dy: number) => `${x + dx},${y + dy}`;
        parts.push(`<g stroke="${stroke}" fill="${stroke}" stroke-width="1.8" stroke-linecap="butt">`);
        parts.push(`<line x1="${x - 28}" y1="${y}" x2="${x - 7}" y2="${y}" fill="none"/>`);
        parts.push(`<line x1="${x - 7}" y1="${y - 14}" x2="${x - 7}" y2="${y + 14}" fill="none"/>`);
        for (const cy of [-10, 0, 10]) {
          parts.push(`<rect x="${x - 2.5}" y="${y + cy - 3.5}" width="5" height="7" stroke="none"/>`);
        }
        parts.push(`<line x1="${x}" y1="${y - 28}" x2="${x}" y2="${y - 13.5}" fill="none"/>`);
        parts.push(`<line x1="${x}" y1="${y + 28}" x2="${x}" y2="${y + 13.5}" fill="none"/>`);
        parts.push(`<polyline points="${g(2.5, 0)} ${g(11, 0)} ${g(11, srcBarY)} ${g(2.5, srcBarY)}" fill="none"/>`);
        if (isN) {
          parts.push(`<polygon points="${g(2.5, 0)} ${g(7.5, -3.2)} ${g(7.5, 3.2)}" stroke="none"/>`);
        } else {
          parts.push(`<polygon points="${g(10, 0)} ${g(5, -3.2)} ${g(5, 3.2)}" stroke="none"/>`);
        }
        parts.push(`</g>`);
        break;
      }
      case 'source': {
        const stroke = c.value === 1 ? '#ff6b6b' : '#4da3ff';
        const label = c.value === 1 ? 'VCC' : 'GND';
        if (c.value === 1) {
          parts.push(
            `<line x1="${x}" y1="${y + 15}" x2="${x}" y2="${y - 6}" stroke="${stroke}" stroke-width="1.5"/>`,
          );
          parts.push(
            `<line x1="${x - 10}" y1="${y - 6}" x2="${x + 10}" y2="${y - 6}" stroke="${stroke}" stroke-width="1.5"/>`,
          );
        } else {
          parts.push(
            `<line x1="${x}" y1="${y - 15}" x2="${x}" y2="${y - 6}" stroke="${stroke}" stroke-width="1.5"/>`,
          );
          for (let i = 0; i < 3; i++) {
            const half = 11 - i * 3.5;
            const yy = y - 6 + i * 4;
            parts.push(
              `<line x1="${x - half}" y1="${yy}" x2="${x + half}" y2="${yy}" stroke="${stroke}" stroke-width="1.4"/>`,
            );
          }
        }
        parts.push(
          `<text x="${x}" y="${c.value === 1 ? y - 14 : y + 16}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="9">${label}</text>`,
        );
        break;
      }
      case 'button': {
        parts.push(
          `<rect x="${x - 17}" y="${y - 15}" width="34" height="30" rx="5" fill="#151820" stroke="#7d8496" stroke-width="1.3"/>`,
        );
        parts.push(`<circle cx="${x}" cy="${y - 3}" r="10" fill="#2a3140" stroke="#8a93a8" stroke-width="1.3"/>`);
        parts.push(
          `<text x="${x}" y="${y + 12}" text-anchor="middle" fill="#9aa1b3" font-family="ui-monospace,monospace" font-size="7">${c.mode === 'toggle' ? 'TOG' : 'MOM'}</text>`,
        );
        break;
      }
      case 'switch': {
        parts.push(
          `<rect x="${x - 18}" y="${y - 11}" width="36" height="22" rx="4" fill="#151820" stroke="${c.closed ? '#8fd46a' : '#7d8496'}" stroke-width="1.3"/>`,
        );
        parts.push(
          `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="9">${c.closed ? 'ON' : 'OFF'}</text>`,
        );
        break;
      }
      case 'led': {
        parts.push(`<circle cx="${x}" cy="${y}" r="11" fill="#1a1c22" stroke="${escapeXml(c.color)}" stroke-width="1.4"/>`);
        if (c.label) {
          parts.push(
            `<text x="${x}" y="${y - 20}" text-anchor="middle" fill="#9aa1b3" font-family="ui-monospace,monospace" font-size="10">${escapeXml(c.label)}</text>`,
          );
        }
        break;
      }
      case 'probe': {
        parts.push(`<circle cx="${x}" cy="${y}" r="10" fill="#262b38" stroke="#7d8496" stroke-width="1.3"/>`);
        parts.push(
          `<text x="${x}" y="${y + 3}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="10">?</text>`,
        );
        if (c.label) {
          parts.push(
            `<text x="${x}" y="${y - 18}" text-anchor="middle" fill="#9aa1b3" font-family="ui-monospace,monospace" font-size="10">${escapeXml(c.label)}</text>`,
          );
        }
        break;
      }
      case 'input': {
        parts.push(
          `<rect x="${x - 12}" y="${y - 10}" width="24" height="20" rx="6" fill="#182233" stroke="#4da3ff" stroke-width="1.3"/>`,
        );
        parts.push(
          `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="11">${c.value}</text>`,
        );
        break;
      }
      case 'label': {
        parts.push(
          `<text x="${x}" y="${y - 12}" text-anchor="middle" fill="#9aa1b3" font-family="ui-monospace,monospace" font-size="10">${escapeXml(c.name)}</text>`,
        );
        break;
      }
      case 'junction': {
        parts.push(
          `<rect x="${x - 3.5}" y="${y - 3.5}" width="7" height="7" fill="#4da3ff" stroke="#1a1c22" stroke-width="1"/>`,
        );
        break;
      }
      case 'port': {
        const s = 8;
        parts.push(
          `<polygon points="${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}" fill="#262b38" stroke="#7d8496" stroke-width="1.3"/>`,
        );
        parts.push(
          `<text x="${x}" y="${y - 16}" text-anchor="middle" fill="#9aa1b3" font-family="ui-monospace,monospace" font-size="10">${escapeXml(c.name)}</text>`,
        );
        break;
      }
      case 'chip': {
        const bw = chipBodyWidth(c);
        const bh = chipBoxHeight(c);
        const label = c.marking || (library.has(c.defId) ? library.get(c.defId).name : 'chip');
        parts.push(
          `<rect x="${x - bw / 2}" y="${y - bh / 2}" width="${bw}" height="${bh}" rx="8" fill="#232a4a" stroke="#7d8496" stroke-width="1.5"/>`,
        );
        parts.push(
          `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="11">${escapeXml(label)}</text>`,
        );
        break;
      }
      case 'ram':
      case 'rom': {
        const n = c.kind === 'ram' ? ramPortCount(c) : romPortCount(c);
        const bw = CHIP_INSTANCE_WIDTH;
        const bh = chipInstanceHeight(n);
        parts.push(
          `<rect x="${x - bw / 2}" y="${y - bh / 2}" width="${bw}" height="${bh}" rx="8" fill="#2a3a2c" stroke="#7d8496" stroke-width="1.5"/>`,
        );
        parts.push(
          `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="11">${c.kind.toUpperCase()}</text>`,
        );
        break;
      }
      case 'clock':
      case 'analyzer':
      case 'busprobe':
      case 'busswitch':
      case 'buspass':
      case 'tty': {
        const label =
          c.kind === 'clock'
            ? 'CLK'
            : c.kind === 'analyzer'
              ? 'LA'
              : c.kind === 'busprobe'
                ? 'BUS'
                : c.kind === 'busswitch'
                  ? 'DIP'
                  : c.kind === 'buspass'
                    ? 'PASS'
                    : 'TTY';
        parts.push(
          `<rect x="${x - 28}" y="${y - 18}" width="56" height="36" rx="6" fill="#191c25" stroke="#f5c518" stroke-width="1.3"/>`,
        );
        parts.push(
          `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#e7e9ef" font-family="ui-monospace,monospace" font-size="11">${label}</text>`,
        );
        break;
      }
    }
    for (const pin of Object.values(c.pins)) {
      pinDot(pin.pos.x, pin.pos.y);
    }
  }

  parts.push('</svg>');
  downloadBlob('schematic.svg', new Blob([parts.join('\n')], { type: 'image/svg+xml' }));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.getElementById('export-png')?.addEventListener('click', () => exportSchematicPng());
document.getElementById('export-svg')?.addEventListener('click', () => exportSchematicSvg());

const importChipInput = document.getElementById('import-chip-file') as HTMLInputElement;
document.getElementById('import-chip')?.addEventListener('click', () => importChipInput.click());
importChipInput.addEventListener('change', () => {
  const file = importChipInput.files?.[0];
  importChipInput.value = '';
  if (!file) return;
  file
    .text()
    .then(async (text) => {
      const def = importChipDef(JSON.parse(text) as SerializedChipBundle, library);
      refreshChipPalette();
      await showAlert(`Imported "${def.name}" — it's in the chip palette now.`);
    })
    .catch((err: unknown) => {
      void showAlert(`Could not load that chip file: ${err instanceof Error ? err.message : String(err)}`);
    });
});

// --- Zoom controls ---------------------------------------------------------
const zoomPctEl = document.getElementById('zoom-pct') as HTMLSpanElement;
function vw(): number {
  return viewportSize().w;
}
function vh(): number {
  return viewportSize().h;
}
document.getElementById('zoom-in')?.addEventListener('click', () => camera.zoomAt({ x: vw() / 2, y: vh() / 2 }, 1.25, vw(), vh()));
document.getElementById('zoom-out')?.addEventListener('click', () => camera.zoomAt({ x: vw() / 2, y: vh() / 2 }, 1 / 1.25, vw(), vh()));
document.getElementById('zoom-100')?.addEventListener('click', () => {
  camera.scale = 1;
});
document.getElementById('zoom-fit')?.addEventListener('click', () => camera.fit(circuitBounds(editor.circuit), vw(), vh()));

// --- Mouse / keyboard input ------------------------------------------------
function screenPoint(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}
function worldPoint(ev: MouseEvent): { x: number; y: number } {
  return camera.screenToWorld(screenPoint(ev), vw(), vh());
}

let spacePressed = false;
let panDrag: { startScreen: { x: number; y: number } } | null = null;
// Set only by canvas's own mousedown, checked by window's mouseup below — a
// drag started on the canvas must still resolve correctly even if it ends
// outside it (window listens so that works), but a mouseup with no matching
// canvas mousedown (e.g. releasing a click on a toolbar button, which also
// bubbles a mouseup to window) must NOT be treated as a canvas interaction.
// Without this guard, clicking "fold" fires a spurious empty-space click in
// world space first, silently clearing the selection fold() was about to
// use — a real bug caught live, not an automation-timing artifact.
let mouseDownOnCanvas = false;

/** True while focus is in a dialog, floating instrument, or text field. */
function focusInUiChrome(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return !!el.closest('.float-win, .z80-dialog-overlay, .hex-view, .z80-ctx, .z80-cheat, #minimap');
}

function isPanGesture(ev: MouseEvent): boolean {
  // Right button (2) — middle-click is awkward on many mice/trackpads.
  return editor.tool.kind === 'pan' || spacePressed || ev.button === 2;
}

let rightDragDist = 0;
let rightDragOrigin: { x: number; y: number } | null = null;

function orientSelected(mode: 'cw' | 'ccw' | 'flipH' | 'flipV'): boolean {
  const comps = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c && isOrientable(c));
  if (comps.length === 0) return false;
  editHistory.checkpoint(editor.circuit);
  orientSelection(comps, mode, (c, dx, dy) => editor.circuit.moveComponent(c.id, dx, dy));
  editor.tidySelectedWires(false);
  return true;
}

function openCanvasContextMenu(ev: MouseEvent): void {
  const world = worldPoint(ev);
  editor.handleMouseMove(world);

  const pin = editor.hoveredPinId
    ? editor.circuit.allPins().find((p) => p.id === editor.hoveredPinId)
    : undefined;
  const hitComp = editor.hoveredComponentId
    ? editor.circuit.components.get(editor.hoveredComponentId)
    : undefined;
  const hitWireId = editor.hoveredWireId;

  // Prefer the hit target for selection when nothing useful is selected.
  if (hitComp && !editor.selectedIds.has(hitComp.id)) {
    editor.selectedIds = new Set([hitComp.id]);
    editor.selectedWireId = null;
  } else if (hitWireId && editor.selectedIds.size === 0) {
    editor.selectedWireId = hitWireId;
  }

  const hasSel = editor.selectedIds.size > 0 || editor.selectedWireIds.size > 0;
  const orientable = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is Component => !!c && isOrientable(c));
  const chipSel = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .filter((c): c is ChipInstanceComponent => c?.kind === 'chip');
  const analyzerSel = [...editor.selectedIds]
    .map((id) => editor.circuit.components.get(id))
    .find((c) => c?.kind === 'analyzer');

  const items: (ContextMenuItem | 'sep')[] = [];
  if (orientable.length > 0) {
    items.push(
      { label: 'Rotate CW', kbd: 'R', run: () => { if (orientSelected('cw')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      { label: 'Rotate CCW', kbd: '⇧R', run: () => { if (orientSelected('ccw')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      { label: 'Flip H', kbd: 'M', run: () => { if (orientSelected('flipH')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      { label: 'Flip V', kbd: '⇧M', run: () => { if (orientSelected('flipV')) { uiDirty = true; syncInspector(); objectInspector.refresh(); } } },
      'sep',
    );
  }
  items.push({
    label: 'Separate wires',
    disabled: editor.circuit.wires.size < 2,
    run: () => {
      if (editor.separateWires() > 0) uiDirty = true;
    },
  });
  items.push({
    label: 'Tidy wires',
    kbd: 'T',
    disabled: !hasSel,
    run: () => {
      if (editor.tidySelectedWires() > 0) uiDirty = true;
    },
  });
  if (editor.canRibbonBusSwitch()) {
    items.push({
      label: 'Ribbon bus switch → chip',
      run: () => {
        if (editor.wireBusSwitchToHost() > 0) uiDirty = true;
      },
    });
  } else if (editor.canWireMatchingPorts()) {
    items.push({
      label: 'Wire matching / bus pins',
      run: () => {
        if (editor.wireMatchingPorts() > 0) uiDirty = true;
      },
    });
  }
  items.push({
    label: 'Delete',
    kbd: 'Del',
    danger: true,
    disabled: !hasSel,
    run: () => {
      editor.handleDelete();
      uiDirty = true;
    },
  });
  if (chipSel.length === 1) {
    const inst = chipSel[0]!;
    items.push({
      label: 'Dive',
      run: () => void diveInto(inst),
    });
    if (library.has(inst.defId)) {
      const def = library.get(inst.defId);
      if ((def.revision ?? 0) !== (inst.defRevision ?? 0)) {
        items.push({
          label: 'Update from library',
          run: () => {
            if (editor.updateChipFromLibrary(inst.id)) {
              uiDirty = true;
              objectInspector.refresh();
            }
          },
        });
      }
    }
  }
  if (analyzerSel && analyzerSel.kind === 'analyzer') {
    items.push({
      label: 'Add LA channel',
      run: () => {
        if (editor.addAnalyzerChannel(analyzerSel.id)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
    items.push({
      label: 'Remove LA channel',
      run: () => {
        if (editor.removeAnalyzerChannel(analyzerSel.id)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
  }
  if (editor.hoveredPinId) {
    const pid = editor.hoveredPinId;
    items.push('sep');
    items.push({
      label: watchList.has(pid) ? 'Unwatch pin' : 'Watch pin',
      kbd: '⌃W',
      run: () => {
        if (watchList.has(pid)) watchList.remove(pid);
        else {
          const pin = editor.circuit.allPins().find((p) => p.id === pid);
          watchList.add(pid, pin ? `${pin.componentId}:${pin.name}` : pid);
          watchList.setVisible(true);
        }
      },
    });
    const pin = editor.circuit.allPins().find((p) => p.id === pid);
    const host = pin ? editor.circuit.components.get(pin.componentId) : undefined;
    if (host && (host.kind === 'chip' || host.kind === 'busprobe' || host.kind === 'ram' || host.kind === 'rom')) {
      const busPins = consecutiveBusPins(host.pins as Record<string, { id: string }>, pin!.name);
      if (busPins.length >= 2) {
        items.push({
          label: 'Watch as bus',
          run: () => {
            if (watchList.addBus(busPins, `${host.id}:${pin!.name.replace(/\d+$/, '')}[${busPins.length - 1}:0]`)) {
              watchList.setVisible(true);
            }
          },
        });
      }
    }
  }
  if (pin && hitComp?.kind === 'chip') {
    const pinName = pin.name;
    items.push('sep');
    items.push({
      label: `Pin “${pinName}” → Left`,
      run: () => {
        if (editor.setChipPinSide(hitComp.id, pinName, -1)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
    items.push({
      label: `Pin “${pinName}” → Right`,
      run: () => {
        if (editor.setChipPinSide(hitComp.id, pinName, 1)) {
          uiDirty = true;
          objectInspector.refresh();
        }
      },
    });
  }
  items.push('sep');
  items.push({
    label: 'Rename net…',
    kbd: '⌃R',
    run: () => void renameSelectedNet(),
  });
  items.push({
    label: 'Copy',
    kbd: '⌃C',
    disabled: editor.selectedIds.size === 0,
    run: () => editor.copySelection(),
  });
  items.push({
    label: 'Paste',
    kbd: '⌃V',
    run: () => {
      if (editor.pasteClipboard()) uiDirty = true;
    },
  });

  showContextMenu(ev.clientX, ev.clientY, items);
  uiDirty = true;
}

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (rightDragDist > 6) {
    rightDragDist = 0;
    return;
  }
  openCanvasContextMenu(ev);
});

canvas.addEventListener('mousedown', (ev) => {
  mouseDownOnCanvas = true;
  hideContextMenu();
  if (isPanGesture(ev)) {
    ev.preventDefault();
    panDrag = { startScreen: screenPoint(ev) };
    if (ev.button === 2) {
      rightDragOrigin = screenPoint(ev);
      rightDragDist = 0;
    }
    canvas.style.cursor = 'grabbing';
    return;
  }
  editor.worldPerPixel = 1 / camera.scale;
  editor.handleMouseDown(worldPoint(ev), { altKey: ev.altKey, shiftKey: ev.shiftKey });
});

// While actively dragging something, the cursor says so regardless of
// tool; otherwise hovering a grabbable part (in the select tool) previews
// that a drag is possible before the user commits to one.
function updateCursor(): void {
  if (editor.isDragging) {
    canvas.style.cursor = 'grabbing';
  } else if (editor.tool.kind === 'select' && editor.wireGrip) {
    const grip = editor.wireGrip;
    canvas.style.cursor = grip.kind === 'corner' ? 'move' : grip.vertical ? 'ew-resize' : 'ns-resize';
  } else if (editor.tool.kind === 'select' && (editor.hoveredComponentId || editor.hoveredWireId)) {
    canvas.style.cursor = 'grab';
  } else {
    canvas.style.cursor = CURSOR[editor.tool.kind];
  }
}

canvas.addEventListener('mousemove', (ev) => {
  if (panDrag) {
    const p = screenPoint(ev);
    camera.pan(p.x - panDrag.startScreen.x, p.y - panDrag.startScreen.y);
    if (rightDragOrigin) {
      const dx = p.x - rightDragOrigin.x;
      const dy = p.y - rightDragOrigin.y;
      rightDragDist = Math.hypot(dx, dy);
    }
    panDrag = { startScreen: p };
    return;
  }
  const world = worldPoint(ev);
  editor.worldPerPixel = 1 / camera.scale;
  editor.handleMouseMove(world);
  editor.handleMouseDrag(world); // no-ops internally unless a marquee/waypoint/component drag is actually in progress
  updateCursor();
});

// Editor.handleMouseUp() is the sole decision point for click-vs-drag (see
// its doc comment) — main.ts no longer needs to know which one happened.
window.addEventListener('mouseup', (ev) => {
  if (!mouseDownOnCanvas) return;
  mouseDownOnCanvas = false;
  if (panDrag) {
    panDrag = null;
    rightDragOrigin = null;
    canvas.style.cursor = CURSOR[editor.tool.kind];
    return;
  }
  editor.worldPerPixel = 1 / camera.scale;
  editor.handleMouseUp(worldPoint(ev), ev.shiftKey);
  updateCursor();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = Math.exp(-ev.deltaY * 0.0015);
  camera.zoomAt(screenPoint(ev), factor, vw(), vh());
}, { passive: false });

canvas.addEventListener('dblclick', async (ev) => {
  const hit: Component | null = editor.handleDoubleClick(worldPoint(ev));
  if (!hit) return;
  if (hit.kind === 'chip') {
    await diveInto(hit);
  } else if (hit.kind === 'ram' || hit.kind === 'rom') {
    memoryEditor.attach(hit);
  } else if (hit.kind === 'analyzer') {
    logicAnalyzer.attach(hit);
  } else if (hit.kind === 'tty') {
    const ramComp = hit.ramId ? editor.circuit.components.get(hit.ramId) : undefined;
    if (ramComp && ramComp.kind === 'ram') {
      // Ensure Soft runner is live after page reload (panel alone is not enough).
      machinePanel.bindRunner(machineRunner);
      if (!machineRunner.attached || machineRunner.machineRam !== ramComp) {
        machineRunner.attachSoft(ramComp, { library });
        machineRunner.boot();
      }
      machinePanel.attach(ramComp);
      if (ramComp.addrBits >= 16 && ramComp.bytes.length >= 0x10000 && !machineRunner.isSpectrum) {
        const hint = loadSpectrumSession();
        void machinePanel
          .restoreSpectrumSession({
            model: hint?.model ?? '48',
            demoId: hint?.demoId ?? null,
          })
          .catch((err) => console.warn(err));
      }
    } else {
      await showAlert('TTY is not linked to a machine RAM. Place a Z80CPU (≥12 addr bits) first.');
    }
  }
  // Labels / buttons / clocks / ports — use the Object Inspector (selection).
});

const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -GRID],
  ArrowDown: [0, GRID],
  ArrowLeft: [-GRID, 0],
  ArrowRight: [GRID, 0],
};

window.addEventListener('keydown', (ev) => {
  // Cheat sheet / context menu close even when focus is in chrome.
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === '?') {
    ev.preventDefault();
    toggleCheatSheet();
    return;
  }
  if (ev.key === 'Escape') {
    if (cheatSheetOpen()) {
      hideCheatSheet();
      ev.preventDefault();
      return;
    }
    if (contextMenuOpen()) {
      hideContextMenu();
      ev.preventDefault();
      return;
    }
  }
  // Soft Spectrum games need Q/W/O/P/Space globally — otherwise editor tools
  // steal them whenever the circuit canvas (not the TTY screen) has focus.
  if (machinePanel.handleGlobalKey(ev, true)) return;
  // Hex editor / floating instruments / dialogs use focusable divs, not only
  // INPUT/TEXTAREA — skip canvas hotkeys while typing there.
  if (focusInUiChrome()) return;
  if (ev.code === 'Space') spacePressed = true;
  const noModifiers = !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'g') {
    ev.preventDefault();
    if (ev.shiftKey) void unfoldSelection();
    else void foldSelection();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    void findInCircuit();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'w') {
    ev.preventDefault();
    addWatchForHoveredOrSelected();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'r' && !ev.shiftKey) {
    ev.preventDefault();
    void renameSelectedNet();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
    ev.preventDefault();
    if (editor.duplicateSelection()) uiDirty = true;
  } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'v') {
    ev.preventDefault();
    void stampSelectionPrompt();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'l') {
    ev.preventDefault();
    const libMenu = document.querySelector<HTMLElement>('#menubar .menu[data-menu="library"]');
    if (libMenu) {
      openMenu(libMenu);
      menuBarArmed = true;
      chipPaletteSearchEl?.focus();
      chipPaletteSearchEl?.select();
    }
  } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'e') {
    ev.preventDefault();
    void exportSelectionAsChip();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
    ev.preventDefault();
    if (editHistory.undo(editor.circuit)) {
      editor.clearSelection();
      editor.cancelWire();
      uiDirty = true;
    }
  } else if (
    (ev.ctrlKey || ev.metaKey) &&
    (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))
  ) {
    ev.preventDefault();
    if (editHistory.redo(editor.circuit)) {
      editor.clearSelection();
      editor.cancelWire();
      uiDirty = true;
    }
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
    ev.preventDefault();
    editor.copySelection();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v' && !ev.shiftKey) {
    ev.preventDefault();
    if (editor.pasteClipboard()) uiDirty = true;
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    editor.handleDelete();
    uiDirty = true;
  } else if (ev.key === 'Escape') {
    if (editor.cancelWireDrag()) {
      uiDirty = true;
    } else if (editor.wireStartPinId) {
      editor.escapeWireStep();
      uiDirty = true;
    } else if (editor.tool.kind !== 'select') {
      setTool({ kind: 'select' });
    } else if (navStack.length > 1) {
      diveTo(navStack.length - 2);
    }
  } else if (ev.key === '0') {
    camera.scale = 1;
  } else if (ev.key.toLowerCase() === 'f') {
    camera.fit(circuitBounds(editor.circuit), vw(), vh());
  } else if (ev.altKey && !ev.ctrlKey && !ev.metaKey && NUDGE_KEYS[ev.key] && editor.selectedIds.size >= 2) {
    ev.preventDefault();
    const [dx, dy] = NUDGE_KEYS[ev.key]!;
    if (ev.shiftKey && editor.selectedIds.size >= 3) {
      if (dx !== 0) editor.distributeSelection('x');
      else editor.distributeSelection('y');
    } else if (!ev.shiftKey) {
      if (dx < 0) editor.alignSelection('x', 'min');
      else if (dx > 0) editor.alignSelection('x', 'max');
      else if (dy < 0) editor.alignSelection('y', 'min');
      else if (dy > 0) editor.alignSelection('y', 'max');
    }
    uiDirty = true;
    syncInspector();
  } else if (noModifiers && NUDGE_KEYS[ev.key] && editor.selectedIds.size > 0) {
    // Fine-positioning after a rough drag — one grid step per press, no
    // separate "confirm" step needed since a move is already grid-snapped.
    ev.preventDefault();
    editHistory.checkpoint(editor.circuit);
    const [dx, dy] = NUDGE_KEYS[ev.key]!;
    for (const id of editor.selectedIds) editor.circuit.moveComponent(id, dx, dy);
    editor.tidySelectedWires(false);
  } else if (noModifiers && ev.key.toLowerCase() === 'h') {
    editor.highlightSelectionNet();
    uiDirty = true;
  } else if (noModifiers && ev.key.toLowerCase() === 't') {
    if (editor.tidySelectedWires() > 0) uiDirty = true;
  } else if (noModifiers && ev.key.toLowerCase() === 'g') {
    ev.preventDefault();
    editor.cycleSnapMode();
    updateSnapHint();
    uiDirty = true;
  } else if (noModifiers && (ev.key === 'r' || ev.key === 'R')) {
    if (orientSelected(ev.shiftKey ? 'ccw' : 'cw')) {
      ev.preventDefault();
      uiDirty = true;
      syncInspector();
      objectInspector.refresh();
    }
  } else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'm') {
    if (orientSelected(ev.shiftKey ? 'flipV' : 'flipH')) {
      ev.preventDefault();
      uiDirty = true;
      syncInspector();
      objectInspector.refresh();
    }
  } else if (noModifiers && ev.key === '=') {
    minimap.setVisible(minimap.root.hidden);
    uiDirty = true;
  } else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.shiftKey && ev.key.toLowerCase() === 'o') {
    ev.preventDefault();
    setTool({ kind: 'port', promptName: true });
  } else if (noModifiers && TOOL_KEYS.has(ev.key.toLowerCase())) {
    setTool(TOOL_KEYS.get(ev.key.toLowerCase())!);
  }
});
window.addEventListener('keyup', (ev) => {
  if (machinePanel.handleGlobalKey(ev, false)) return;
  if (focusInUiChrome()) return;
  if (ev.code === 'Space') spacePressed = false;
});

// --- Simulation + render loop -------------------------------------------
const statusEl = document.getElementById('status') as HTMLDivElement;

/** Status bar truncates with ellipsis — keep full text in title for hover. */
function setStatusLine(text: string): void {
  statusEl.textContent = text;
  statusEl.title = text;
}

let lastContendedNets = new Set<string>();
/** Contended set from the previous sim frame — used for "break on contend". */
let prevBreakContended = new Set<string>();
let simPaused = false;
let simStepOnce = false;

/** Brief status-line notice (Soft Lab toggle / dive leave); cleared by deadline. */
let statusNotice: string | null = null;
let statusNoticeUntil = 0;

function flashStatusNotice(msg: string, ms = 4500): void {
  statusNotice = msg;
  statusNoticeUntil = performance.now() + ms;
  uiDirty = true;
  // Status text is only rewritten on sim draw frames — schedule a clear so an
  // idle settled circuit does not leave the notice stuck forever.
  window.setTimeout(() => {
    if (statusNotice != null && performance.now() >= statusNoticeUntil) {
      statusNotice = null;
      uiDirty = true;
    }
  }, ms + 50);
}

function statusNoticeActive(): boolean {
  if (!statusNotice) return false;
  if (performance.now() >= statusNoticeUntil) {
    statusNotice = null;
    return false;
  }
  return true;
}

function statusNoticeSuffix(): string {
  return statusNoticeActive() ? ` | ${statusNotice}` : '';
}

function updateSoftLabChrome(): void {
  const btn = document.getElementById('sim-soft-lab');
  if (!btn) return;
  const on = isSoftLabEnabled();
  btn.classList.toggle('active', on);
  btn.dataset.mode = on ? 'soft' : 'gates';
  btn.textContent = on ? 'Soft Lab' : 'Gates';
  btn.title = on
    ? 'Soft Lab ON — behavioral COUNTER/BCD/REG… (click for Gates)'
    : 'Gates — full transistor expand (click for Soft Lab)';
}

function pauseSimForBreak(): void {
  if (simPaused) return;
  simPaused = true;
  if (machineRunner.attached) machineRunner.setRunning(false);
  updateSimChrome();
}

/** Draw LA cursor channel levels next to the open analyzer's CH pins. */
function drawAnalyzerCursorOverlay(
  c: CanvasRenderingContext2D,
  viewportW: number,
  viewportH: number,
): void {
  const device = logicAnalyzer.attachedDevice;
  const levels = logicAnalyzer.getCursorLevels();
  if (!device || !levels || !logicAnalyzer.hasCursor) {
    watchList.setAnalyzerCursor(null);
    return;
  }
  watchList.setAnalyzerCursor(levels.map((level, ch) => ({ ch, level: String(level) })));
  const viewCircuit = editor.circuit;
  if (!viewCircuit.components.has(device.id)) return;
  c.save();
  c.font = 'bold 11px ui-monospace, monospace';
  c.textBaseline = 'middle';
  for (let ch = 0; ch < levels.length; ch++) {
    const pin = device.pins[`ch${ch}`];
    if (!pin) continue;
    const scr = camera.worldToScreen(pin.pos, viewportW, viewportH);
    const label = `ch${ch}=${levels[ch]}`;
    const tw = c.measureText(label).width;
    const x = scr.x + 10;
    const y = scr.y;
    c.fillStyle = 'rgba(20, 22, 29, 0.88)';
    c.strokeStyle = '#f5c518';
    c.lineWidth = 1;
    c.fillRect(x - 4, y - 9, tw + 8, 18);
    c.strokeRect(x - 4, y - 9, tw + 8, 18);
    c.fillStyle = '#f5c518';
    c.fillText(label, x, y);
  }
  c.restore();
}

function applyBreakChecks(
  resolve: (localPinId: string) => { level: Level; contended: boolean },
  newContended: Set<string>,
): void {
  if (watchList.breakOnContend) {
    for (const netId of newContended) {
      if (!prevBreakContended.has(netId)) {
        pauseSimForBreak();
        highlightContendedNet(netId);
        break;
      }
    }
  }
  const changed = watchList.updateLevels(resolve);
  if (watchList.breakOnWatchChange && changed.length > 0) {
    pauseSimForBreak();
    selectPinComponent(changed[0]!);
  }
  prevBreakContended = new Set(newContended);
}

const minimap = new Minimap(
  () => editor.circuit,
  () => camera,
  () => ({ w: vw(), h: vh() }),
  () => {
    uiDirty = true;
  },
);
stage.appendChild(minimap.root);

document.getElementById('view-minimap')?.addEventListener('click', () => {
  minimap.setVisible(minimap.root.hidden);
  uiDirty = true;
});

function updateSimChrome(): void {
  document.getElementById('sim-run')?.classList.toggle('active', !simPaused);
  document.getElementById('sim-pause')?.classList.toggle('active', simPaused);
}

document.getElementById('sim-run')?.addEventListener('click', () => {
  simPaused = false;
  if (machineRunner.attached) machineRunner.setRunning(true);
  updateSimChrome();
  uiDirty = true;
});
document.getElementById('sim-pause')?.addEventListener('click', () => {
  simPaused = true;
  if (machineRunner.attached) machineRunner.setRunning(false);
  updateSimChrome();
  uiDirty = true;
});
document.getElementById('sim-soft-lab')?.addEventListener('click', () => {
  const wasOn = isSoftLabEnabled();
  setSoftLabEnabled(!wasOn);
  if (wasOn && !isSoftLabEnabled()) {
    // Soft → Gates: seed silicon Q nets so sequential chips leave Z without
    // requiring the user to pulse Clear (see armSoftLabToGatesPor).
    armSoftLabToGatesPor(topCircuit, library);
    // Hold pulse gens quiet while POR forces Q — a free-running CLK during
    // POR leaves T_FF guts oscillating (settled:false forever after POR).
    for (const c of topCircuit.components.values()) {
      if (c.kind !== 'clock') continue;
      c.value = 0;
      c.phase = 0;
      c.holdFrames = 0;
    }
    flashStatusNotice('Gates — POR seeds Q low for a few steps (counters restart at 0)');
  } else if (!wasOn && isSoftLabEnabled()) {
    // Gates → Soft: drop orphan Soft-model force-expands (Soft-off-while-dived
    // left COUNTER/T_FF stuck expanded → floating Q, dead Soft chips), drop
    // any in-flight Gates POR, and wipe soft sequential state deeply.
    clearSoftModelForceExpands();
    clearSoftLabPor();
    clearSoftLabStateDeep(topCircuit, library);
    flashStatusNotice('Soft Lab — soft state reset');
  }
  // Reset sim levels — Soft↔Gates changes the flat netlist shape around Soft
  // sequential chips; carrying the previous levelOf Map leaves Soft/Gates
  // half-converged. A design without any keeps its state: wiping it would leave
  // the latches of a gate-level CPU floating until it is reset.
  if (circuitHasSoftSequentialChips(topCircuit, library)) simState = initialState();
  // Toggle while dived must re-apply dive expand — otherwise Soft-opaque
  // children (e.g. T_FF under COUNTER4) grey out the schematic (flat nets≈20).
  resyncSoftExpandForCurrentDive();
  persistSoftLabPreference();
  updateSoftLabChrome();
  uiDirty = true;
  objectInspector.refresh();
});
updateSoftLabChrome();
document.getElementById('sim-step')?.addEventListener('click', () => {
  if (machineRunner.attached) {
    machineRunner.setRunning(false);
    machineRunner.stepInstruction();
  }
  simPaused = true;
  simStepOnce = true;
  updateSimChrome();
  uiDirty = true;
});
updateSimChrome();

function highlightFirstContendedNet(): void {
  if (lastContendedNets.size === 0 || !lastFlatNetMap) return;
  const netId = [...lastContendedNets][0]!;
  highlightContendedNet(netId);
}

function highlightContendedNet(netId: string): void {
  if (!lastFlatNetMap) return;
  const view = navStack[navStack.length - 1]!;
  const pins = lastFlatNetMap.pinsOf.get(netId) ?? [];
  const localPins = pins
    .filter((p) => (view.pathPrefix ? p.startsWith(view.pathPrefix) : !p.includes('/')))
    .map((p) => (view.pathPrefix ? p.slice(view.pathPrefix.length) : p));
  editor.clearSelection();
  const localNets = editor.circuit.computeNets();
  for (const pid of localPins) {
    const compId = pid.split(':')[0];
    if (compId && editor.circuit.components.has(compId)) editor.selectedIds.add(compId);
  }
  if (localPins[0]) {
    editor.highlightedNetId = localNets.netOf.get(localPins[0]) ?? null;
  } else {
    // Named rails (VCC/GND) may already match local net ids.
    editor.highlightedNetId = localNets.pinsOf.has(netId) ? netId : null;
  }
  // Also select wires on the highlighted local net.
  if (editor.highlightedNetId) {
    for (const w of editor.circuit.wires.values()) {
      if (localNets.netOf.get(w.a) === editor.highlightedNetId) editor.selectedWireIds.add(w.id);
    }
  }
  syncInspector();
  uiDirty = true;
}

statusEl.addEventListener('click', () => {
  if (lastContendedNets.size === 0) return;
  highlightFirstContendedNet();
});

/** Offscreen 128×64 for soft bitmap HUD (screen-fixed, not world coords). */
const bmpHudTmp = document.createElement('canvas');
bmpHudTmp.width = BMP_WIDTH;
bmpHudTmp.height = BMP_HEIGHT;
const bmpHudCtx = bmpHudTmp.getContext('2d');

/** Subtle corner preview when SoftDevices.bitmap has any set pixel. */
function drawSoftBitmapHud(c: CanvasRenderingContext2D, _vw: number, vh: number): void {
  if (!machineRunner.attached || !bmpHudCtx) return;
  const bmp = machineRunner.softDevices.bitmap;
  let any = false;
  for (let i = 0; i < bmp.length; i++) {
    if (bmp[i]) {
      any = true;
      break;
    }
  }
  if (!any) return;

  const img = bmpHudCtx.createImageData(BMP_WIDTH, BMP_HEIGHT);
  for (let i = 0; i < BMP_WIDTH * BMP_HEIGHT; i++) {
    const bit = (bmp[(i / 8) | 0]! >> (7 - (i & 7))) & 1;
    const o = i * 4;
    const v = bit ? 180 : 12;
    img.data[o] = v;
    img.data[o + 1] = bit ? 190 : 14;
    img.data[o + 2] = bit ? 210 : 18;
    img.data[o + 3] = bit ? 220 : 160;
  }
  bmpHudCtx.putImageData(img, 0, 0);
  const scale = 1;
  const w = BMP_WIDTH * scale;
  const h = BMP_HEIGHT * scale;
  const x = 8;
  const y = vh - h - 8;
  c.save();
  c.globalAlpha = 0.85;
  c.fillStyle = 'rgba(10,12,18,0.7)';
  c.fillRect(x - 2, y - 2, w + 4, h + 4);
  c.imageSmoothingEnabled = false;
  c.drawImage(bmpHudTmp, x, y, w, h);
  c.restore();
}

/**
 * Idle-frame skip: found live once `flatten()`/`computeNets()` caching (see
 * ARCHITECTURE.md's "Caching flatten()/computeNets()") turned out to fix
 * only *half* the documented `~3.8fps`-while-idle bottleneck — `step()`
 * itself still costs real relaxation work proportional to circuit size
 * every single call, and `draw()` redraws every top-level primitive from
 * scratch every call, *neither* of them aware that a genuinely idle circuit
 * (nobody clicked anything, and it already reached a fixpoint) produces the
 * exact same output on every call. `step()`'s own relaxation is
 * deterministic: calling it again with an unchanged circuit and unchanged
 * inputs, starting from a state that already settled, reaches that identical
 * fixpoint in exactly one internal pass — the returned `levelOf` is a new
 * `Map` object, but every value in it is bit-for-bit what it already was.
 * `!uiDirty && simState.settled`, checked *before* calling `step()` at all,
 * is therefore a cheap, provably safe (never wrong, only ever conservative)
 * signal that this frame would be a no-op: `uiDirty` catches every possible
 * source of a genuine change (circuit edits, an Input toggled by click,
 * camera pan/zoom, selection/hover, a toolbar action — see the tap installed
 * above), and `settled` catches the one case that flag can't: a circuit that
 * is still actively converging (or, for a user-built free-running
 * oscillator, one that legitimately never does) keeps stepping and drawing
 * every frame regardless of `uiDirty`, exactly as before this change.
 */
function readTinyPc(chip: ChipInstanceComponent): number | null {
  if (!lastFlatNetMap) return null;
  let pc = 0;
  for (const [i, pin] of tinyPcPins(chip).entries()) {
    const net = lastFlatNetMap.netOf.get(pin.id);
    const level = net === undefined ? undefined : simState.levelOf.get(net);
    if (level !== 0 && level !== 1) return null;
    pc |= level << i;
  }
  return pc;
}

/**
 * While a gate-level machine runs, redrawing a 100k-transistor sheet every frame
 * costs more than the phases themselves. Leave at least this many times the last
 * redraw's duration between redraws so the solver gets the rest of the time.
 */
const GATE_RUN_REDRAW_GAP_FACTOR = 3;
let lastRedrawMs = 0;
let lastRedrawEndMs = 0;

function frame(): void {
  syncInspector();
  if (tutorial.active) tutorial.tick(editor.circuit);
  // Catch Insert-menu / paste / clear mutations that skip onBeforeEdit.
  const ver = currentStructureVersion();
  if (ver !== lastAutosaveStructureVersion) {
    lastAutosaveStructureVersion = ver;
    autosave.schedule();
    refreshWatchStrip();
  }
  // Soft Run advances the interpreter only; gate Run spends a time-budgeted
  // slice of transistor phases. Either way we avoid the old pattern of
  // 160 full step()s *plus* another step+draw in the same rAF.
  let machineWorked = false;
  if (machineRunner.running) {
    machineWorked = machineRunner.tickBudget();
  }
  if (memoryEditor.attached) {
    const tinyCpu = memoryEditor.memory?.kind === 'ram' ? tinyCpuForRam(topCircuit, library, memoryEditor.memory) : undefined;
    memoryEditor.setIsa(tinyCpu ? TINY_EDITOR_ISA : null);
    const soft = machineRunner.isSoft ? machineRunner.softCpu : null;
    const pc = tinyCpu ? readTinyPc(tinyCpu) : soft ? soft.pc & 0xffff : null;
    if (memoryEditor.setLivePc(pc) && (tinyCpu || soft)) machineWorked = true;
  }

  // No manual Lab Run — keep ticking while a pulse/button/analyzer actually
  // needs wall-clock frames; idle TRIG is sampled after step (fresh net levels).
  const labActive = circuitNeedsLabTick(topCircuit, logicAnalyzer.anyArmed(topCircuit));
  const hasPulseGen = circuitHasPulseGen(topCircuit);
  const porActive = softLabPorActive();

  const softRun = machineRunner.running && machineRunner.isSoft;

  // Soft Run: skip transistor step/canvas every frame (TTY samples RAM).
  // Gate Run / idle / edits: normal path. Soft still redraws canvas when
  // the user pans/zooms (uiDirty) or lab instruments are active/changing.
  let labChanged = false;
  const needSimDraw =
    softRun
      ? uiDirty ||
        labActive ||
        labChanged ||
        simStepOnce ||
        statusNoticeActive() ||
        porActive ||
        (machineWorked && (machineRunner.hasLabLed || memoryEditor.attached))
      : uiDirty ||
        labChanged ||
        (!simPaused && !simState.settled) ||
        simStepOnce ||
        (machineRunner.running && machineWorked) ||
        labActive ||
        porActive ||
        statusNoticeActive() ||
        // Keep the canvas alive so contended-wire heat animation plays while settled.
        simState.contended.size > 0;

  const gateRunRedrawDeferred =
    machineRunner.running &&
    !machineRunner.isSoft &&
    !uiDirty &&
    !simStepOnce &&
    !labActive &&
    !hasPulseGen &&
    !porActive &&
    performance.now() - lastRedrawEndMs < GATE_RUN_REDRAW_GAP_FACTOR * lastRedrawMs;
  const redrawStartMs = performance.now();

  if (needSimDraw && !gateRunRedrawDeferred) {
    // Keep backing store in sync even if a layout change slipped past the
    // ResizeObserver (e.g. panel attach in the same turn as a zoom redraw).
    resizeCanvas();
    // Soft at top level: draw chip boxes without expanding ~200k components
    // through flatten() — interactive TTY does not need pin levels. Dive-in
    // (navStack depth > 1) or any Gates path still flattens as before.
    const softTop = softRun && navStack.length === 1;
    const softLabLedPaint =
      softRun && machineWorked && (machineRunner.hasLabLed || memoryEditor.attached);
    if (!softRun || uiDirty || labActive || labChanged || simStepOnce || softLabLedPaint) {
      const view = navStack[navStack.length - 1]!;
      if (softTop && !simStepOnce) {
        // Soft machine HUD — no transistor step; still advance free-running instruments
        // (except during Soft→Gates POR — see tick below).
        if (labActive && !porActive) {
          labChanged = tickLabInstruments(
            topCircuit,
            lastFlatNetMap ?? undefined,
            simState.levelOf,
          );
        }
        // Input/Source/LED-forceOn levels only — no flatten. Keeps lab LED
        // wires in sync with SoftDevices instead of painting every net as Z.
        const resolve = makeSoftCanvasResolve(view.circuit);
        draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library, { softMode: true });
        tutorial.tick(view.circuit);
        drawSoftBitmapHud(ctx!, vw(), vh());
        drawAnalyzerCursorOverlay(ctx!, vw(), vh());
        minimap.draw();
        zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
        lastContendedNets = new Set();
        statusEl.classList.remove('clickable');
        setStatusLine(
          `${navStack.map((f) => f.label).join('/')} | soft (flatten deferred) | machine: soft${simPaused ? ' | sim paused' : ''}` +
            statusNoticeSuffix(),
        );
        updateWatchLevels(resolve);
        applyBreakChecks(resolve, lastContendedNets);
      } else {
        let flat = flatten(topCircuit, library);
        let flatNetMap = flat.computeNets();
        lastFlatNetMap = flatNetMap;
        const canStep = !softRun && (!simPaused || simStepOnce);
        if (canStep) {
          simState = step(flat, flatNetMap, simState);
        }
        simStepOnce = false;
        // One tick per frame, AFTER step so TRIG sees the button level. When the
        // pulse gen changes its OUT driver, re-flatten — flat clones are stale.
        // Skip while Soft→Gates POR is forcing Q: CLK edges during POR leave
        // expanded COUNTER/T_FF guts unable to settle (iterations stuck at 64).
        if (!porActive && (labActive || hasPulseGen)) {
          if (tickLabInstruments(topCircuit, flatNetMap, simState.levelOf)) {
            labChanged = true;
            flat = flatten(topCircuit, library);
            flatNetMap = flat.computeNets();
            lastFlatNetMap = flatNetMap;
            if (canStep) {
              simState = step(flat, flatNetMap, simState);
            }
          }
        }
        if (labActive || labChanged) {
          let clkPeriod: number | null = null;
          const nets = flatNetMap;
          // Prefer a free-running clock that shares a net with an analyzer channel.
          for (const la of topCircuit.components.values()) {
            if (la.kind !== 'analyzer') continue;
            for (let ch = 0; ch < la.channelCount; ch++) {
              const chPin = la.pins[`ch${ch}`];
              if (!chPin) continue;
              const chNet = nets.netOf.get(chPin.id);
              if (!chNet) continue;
              for (const c of topCircuit.components.values()) {
                if (c.kind !== 'clock' || c.mode !== 'continuous' || !c.running) continue;
                if (nets.netOf.get(c.pins.out.id) === chNet) {
                  clkPeriod = c.periodFrames;
                  break;
                }
              }
              if (clkPeriod != null) break;
            }
            if (clkPeriod != null) break;
          }
          if (clkPeriod == null) {
            for (const c of topCircuit.components.values()) {
              if (c.kind === 'clock' && c.mode === 'continuous' && c.running) {
                clkPeriod = c.periodFrames;
                break;
              }
            }
          }
          logicAnalyzer.setTimebaseFrames(clkPeriod);
          logicAnalyzer.sampleCircuit(topCircuit, flatNetMap, simState.levelOf);
        }

        const resolve = (localPinId: string): { level: Level; contended: boolean } => {
          const net = flatNetMap.netOf.get(view.pathPrefix + localPinId);
          if (!net) return { level: 'Z', contended: false };
          return { level: simState.levelOf.get(net) ?? 'Z', contended: simState.contended.has(net) };
        };

        lastContendedNets = new Set(simState.contended);
        applyBreakChecks(resolve, lastContendedNets);

        tutorial.tick(view.circuit);
        draw(ctx!, camera, vw(), vh(), view.circuit, resolve, editor, library, {
          softMode: softRun,
        });
        drawSoftBitmapHud(ctx!, vw(), vh());
        drawAnalyzerCursorOverlay(ctx!, vw(), vh());
        minimap.draw();
        zoomPctEl.textContent = `${Math.round(camera.scale * 100)}%`;
        if (lastContendedNets.size > 0) statusEl.classList.add('clickable');
        else statusEl.classList.remove('clickable');
        const contendedHint =
          lastContendedNets.size > 0 && lastContendedNets.size <= 4
            ? ` [${[...lastContendedNets].map((n) => editor.formatNetName(n) ?? n).join(', ')}]`
            : '';
        const mode =
          machineRunner.running && machineRunner.isSoft
            ? 'machine: soft'
            : machineRunner.running
              ? 'machine: gates'
              : machineRunner.attached
                ? 'machine: pause'
                : '';
        const lab = labActive ? ' | lab' : '';
        const paused = simPaused ? ' | sim paused' : '';
        setStatusLine(
          `${navStack.map((f) => f.label).join('/')} | flat nets: ${flatNetMap.pinsOf.size} | ` +
            `iterations: ${simState.iterations} | settled: ${simState.settled} | contended: ${simState.contended.size}${contendedHint}` +
            (mode ? ` | ${mode}` : '') +
            lab +
            paused +
            statusNoticeSuffix(),
        );
        updateWatchLevels(resolve);
      }
    }
    updateSoftLabChrome();
    uiDirty = false;
    lastRedrawEndMs = performance.now();
    lastRedrawMs = lastRedrawEndMs - redrawStartMs;
  } else {
    updateSoftLabChrome();
  }
  // Soft TTY samples ram.bytes independently of the transistor canvas.
  if (machinePanel.attached) machinePanel.draw();
  if (ioMapViewer.visible) {
    ioMapViewer.attach(machineRunner.machineRam);
    ioMapViewer.draw();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
