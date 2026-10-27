import { bodyEdgeToward, getOrientation, transformOffset } from '../sim/orientation.js';
import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import { decodeBusProbe } from '../sim/busProbe.js';
import { CHIP_INSTANCE_WIDTH, chipBodyWidth, chipBoxHeight, chipInstanceHeight, BUS_PASS_BODY_W, ramPortCount, romPortCount } from '../sim/library.js';
import { softLabShowsBadge } from '../sim/softLab.js';
import type { Component, Level, Pin, Point, Wire } from '../sim/types.js';
import type { Camera } from './Camera.js';
import type { Editor } from './Editor.js';
import { GRID, BUS_SWITCH_BODY_W, busPassPaddleCenter, busSwitchPaddleCenter, busSwitchSideUnit, findSameNetTees, isBusName, pinExitDir, pinRouteDir, rawWirePolyline, routeWirePoints, routingObstacles } from './geometry.js';

const COLOR = {
  bg: '#12141a',
  grid: '#2a2f3a',
  wireHigh: '#ff6b6b',
  wireLow: '#4da3ff',
  wireFloat: '#5b6272',
  contended: '#ff4d2e',
  heat: '#ffb347',
  spark: '#ffe566',
  body: '#262b38',
  chipBody: '#232a4a',
  ramBody: '#2a3a2c',
  strokeN: '#5fd0d6',
  strokeP: '#e8b358',
  bodyStroke: '#7d8496',
  selected: '#f5c518',
  hover: '#c9cede',
  marquee: 'rgba(245, 197, 24, 0.12)',
  marqueeStroke: 'rgba(245, 197, 24, 0.65)',
  text: '#e7e9ef',
  textDim: '#9aa1b3',
};

function levelColor(level: Level, contended: boolean): string {
  if (contended) return COLOR.contended;
  if (level === 1) return COLOR.wireHigh;
  if (level === 0) return COLOR.wireLow;
  return COLOR.wireFloat;
}

/** Resolves a pin id (in the *currently viewed* circuit's local id space) to its live level. */
export type LevelResolver = (pinId: string) => { level: Level; contended: boolean };

/**
 * Viewport culling. Found live once a real `+ Z80CPU` — hundreds/thousands
 * of `chip`/`ram`/register-bit primitives, built directly into the
 * caller's own circuit rather than folded into one opaque instance (see
 * ARCHITECTURE.md's "Closing out the CPU" and "Canvas 2D rendering cost")
 * — turned a placement-time render into a browser-tab crash, not just the
 * previously-measured `~3.8fps`: with no auto-fit-camera-to-the-whole-thing
 * step after placement, the vast majority of a freshly-placed composite's
 * components sit *outside* the current viewport, at whatever zoom/pan the
 * canvas already had — yet `draw()` iterated and fully rendered (gradients,
 * multiple pin dots, stubs, text) every single one of them regardless,
 * every single call. `componentRadius` is a deliberately generous per-kind
 * half-extent (body size plus enough slack for stub lines to a pin and any
 * text drawn outside the body, e.g. a `label`'s name above its dot) — an
 * approximation, not exact pin geometry, because exactness buys nothing
 * here: the only failure mode worth avoiding is culling something that's
 * *actually* a few pixels on-screen, and a generous margin costs one cheap
 * bounds check per component to rule out, not a redraw.
 */
export function componentRadius(c: Component): { rx: number; ry: number } {
  switch (c.kind) {
    case 'transistor':
      return { rx: 36, ry: 34 };
    case 'button':
      return { rx: 28, ry: 26 };
    case 'switch':
      return { rx: 28, ry: 22 };
    case 'source':
      return { rx: 28, ry: 30 };
    case 'input':
      return { rx: 22, ry: 20 };
    case 'clock':
      return { rx: 32, ry: 26 };
    case 'analyzer':
      return { rx: 40, ry: Math.max(28, (c.channelCount * 16) / 2 + 20) };
    case 'busprobe':
      return { rx: 52, ry: Math.max(28, (c.bitWidth * 16) / 2 + 24) };
    case 'busswitch':
      return { rx: 60, ry: Math.max(28, (c.bitWidth * 16) / 2 + 24) };
    case 'buspass':
      return { rx: BUS_PASS_BODY_W / 2 + 16, ry: Math.max(28, (c.bitWidth * 16) / 2 + 24) };
    case 'tty':
      return { rx: 44, ry: 30 };
    case 'probe':
      return { rx: 24, ry: 34 };
    case 'junction':
      return { rx: 14, ry: 14 };
    case 'led':
      return { rx: 26, ry: 34 };
    case 'sevenseg':
      return { rx: 48, ry: 56 };
    case 'label':
      return { rx: 50, ry: 24 };
    case 'port':
      return { rx: 40, ry: 28 };
    case 'chip':
      return { rx: chipBodyWidth(c) / 2 + 20, ry: chipBoxHeight(c) / 2 + 20 };
    case 'ram':
      return { rx: CHIP_INSTANCE_WIDTH / 2 + 20, ry: chipInstanceHeight(ramPortCount(c)) / 2 + 20 };
    case 'rom':
      return { rx: CHIP_INSTANCE_WIDTH / 2 + 20, ry: chipInstanceHeight(romPortCount(c)) / 2 + 20 };
  }
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOverlap(a: WorldBounds, b: WorldBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function isComponentVisible(c: Component, visible: WorldBounds): boolean {
  const { rx, ry } = componentRadius(c);
  return boundsOverlap({ minX: c.pos.x - rx, minY: c.pos.y - ry, maxX: c.pos.x + rx, maxY: c.pos.y + ry }, visible);
}

export function isWireVisible(points: { x: number; y: number }[], visible: WorldBounds): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // A wire's own glow underlay is a handful of px wide at most — a fixed
  // small margin (not componentRadius's per-kind sizing, which doesn't
  // apply to a polyline) comfortably covers it.
  const margin = 12;
  return boundsOverlap({ minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin }, visible);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Soft glow ring behind a rounded-rect body: a wider, low-alpha stroke, cheaper and more predictable across browsers than ctx.shadowBlur under a zoom transform. */
function glowRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, color: string): void {
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  roundRectPath(ctx, x - 2, y - 2, w + 4, h + 4, r + 2);
  ctx.stroke();
  ctx.restore();
}

export function draw(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  viewportW: number,
  viewportH: number,
  circuit: Circuit,
  resolve: LevelResolver,
  editor: Editor,
  library: ChipLibrary,
  opts?: { softMode?: boolean },
): void {
  // Clear the full backing store in device pixels (identity transform), not
  // just the CSS viewport rect. Avoids a 1-px stale strip when
  // round(w*dpr) > w*dpr, and any leftover from a previous larger buffer
  // before resizeCanvas caught up.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  ctx.save();
  ctx.translate(viewportW / 2, viewportH / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);

  // Soft Run badge only — do not mute wire/pin colors. Soft canvas resolve
  // already paints Input/Source/LED-forceOn nets; muting made a driven LAB_LED
  // look like Z next to bright seed Inputs.
  drawGrid(ctx, camera, viewportW, viewportH);

  // A fixed screen-space margin (in world units, i.e. divided by scale)
  // around the visible viewport — generous enough that a component's own
  // glow ring or a wire's bend point dragged just past the edge doesn't pop
  // in and out as the camera pans by a pixel. See `componentRadius`'s own
  // doc comment for why this culling exists at all.
  const cullMargin = 200 / camera.scale;
  const topLeft = camera.screenToWorld({ x: 0, y: 0 }, viewportW, viewportH);
  const bottomRight = camera.screenToWorld({ x: viewportW, y: viewportH }, viewportW, viewportH);
  const visible: WorldBounds = {
    minX: topLeft.x - cullMargin,
    minY: topLeft.y - cullMargin,
    maxX: bottomRight.x + cullMargin,
    maxY: bottomRight.y + cullMargin,
  };

  const pinById = new Map<string, Pin>();
  for (const p of circuit.allPins()) pinById.set(p.id, p);

  const highlightNet = editor.highlightedNetId;
  const hoverNet = editor.netIdUnderPointer();
  const glowNet = highlightNet ?? hoverNet;
  const nets = circuit.computeNets();
  const netOf = glowNet ? nets.netOf : null;

  // Pins on the hovered / H-highlighted net get the same glow family as wires.
  const pinGlowNet = hoverNet;
  const pinGlowStyle: PinGlowStyle | null = pinGlowNet
    ? pinGlowNet === highlightNet
      ? 'net'
      : 'hover'
    : null;
  const glowPinIds = pinGlowNet
    ? new Set(
        [...nets.netOf.entries()].filter(([, nid]) => nid === pinGlowNet).map(([pid]) => pid),
      )
    : null;

  // Extended VCC/GND rails through same-net sources sharing a Y.
  drawPowerRailBars(ctx, circuit, nets);

  // Wires first, so component bodies sit on top of the lines meeting them.
  const routedWires: Point[][] = [];
  const wireEntries: Array<{ w: Wire; points: Point[] }> = [];
  for (const w of circuit.wires.values()) {
    const a = pinById.get(w.a);
    const b = pinById.get(w.b);
    if (!a || !b) continue;
    const raw = w.waypoints && w.waypoints.length ? [a.pos, ...w.waypoints, b.pos] : [a.pos, b.pos];
    const points = routeWirePoints(raw);
    routedWires.push(points);
    wireEntries.push({ w, points });
  }

  // Group bundleId wires: draw a thicker shared trunk once, then fan to pins.
  const bundleDrawn = new Set<string>();
  for (const { w, points } of wireEntries) {
    if (!isWireVisible(points, visible)) continue;
    const { level, contended } = resolve(w.a);
    const netHit = netOf != null && glowNet != null && netOf.get(w.a) === glowNet;
    const sticky = highlightNet != null && netHit;
    const emphasis =
      w.id === editor.selectedWireId || editor.selectedWireIds.has(w.id)
        ? 'selected'
        : sticky
          ? 'net'
          : netHit
            ? 'hover'
            : editor.tool.kind === 'select' && w.id === editor.hoveredWireId
              ? 'hover'
              : 'none';
    const netName = editor.formatNetName(nets.netOf.get(w.a) ?? null);
    const a = pinById.get(w.a)!;
    const b = pinById.get(w.b)!;
    const bus =
      !!w.bundleId ||
      isBusName(netName) ||
      isBusName(a.name) ||
      isBusName(b.name) ||
      (netName?.includes('[') ?? false);

    if (w.bundleId && !bundleDrawn.has(w.bundleId)) {
      bundleDrawn.add(w.bundleId);
      // Thicker trunk along the middle segment of the first bundled wire.
      if (points.length >= 2) {
        const midStart = Math.max(0, Math.floor((points.length - 1) / 2) - 1);
        const midEnd = Math.min(points.length - 1, midStart + 2);
        const trunk = points.slice(midStart, midEnd + 1);
        if (trunk.length >= 2) {
          drawWire(ctx, trunk, levelColor(level, contended), contended, 'none', true);
        }
      }
    }
    drawWire(ctx, points, levelColor(level, contended), contended, emphasis, bus);
  }

  // Crossings stay unmarked (KiCad/Logisim style). Connection dots belong on
  // real junction nodes / T-splices — not on every H×V geometric cross.
  // findWireCrossings() remains available if we later draw hop bridges.
  drawSameNetTees(ctx, wireEntries, nets.netOf, resolve, visible);
  // Rubber-band while a wire is in progress: the start pin, every bend
  // point committed so far, then a dashed segment out to the cursor.
  if (editor.tool.kind === 'wire' && editor.wireStartPinId) {
    const start = pinById.get(editor.wireStartPinId);
    if (start) {
      const hoverPin = editor.hoveredPinId ? pinById.get(editor.hoveredPinId) : undefined;
      const points = editor.routeNewWire(
        start.id,
        editor.wireWaypoints,
        hoverPin?.id ?? null,
        editor.mouse,
      );
      if (points) {
        ctx.save();
        ctx.strokeStyle = COLOR.hover;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([5, 5]);
        strokeRoundedPolyline(ctx, points, 7);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR.hover;
        for (const p of editor.wireWaypoints) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  const guide = editor.wireGuide;
  if (guide) {
    ctx.save();
    ctx.strokeStyle = COLOR.hover;
    ctx.lineWidth = 1 / camera.scale;
    ctx.setLineDash([4 / camera.scale, 4 / camera.scale]);
    ctx.beginPath();
    if (guide.axis === 'x') {
      ctx.moveTo(guide.value, topLeft.y);
      ctx.lineTo(guide.value, bottomRight.y);
    } else {
      ctx.moveTo(topLeft.x, guide.value);
      ctx.lineTo(bottomRight.x, guide.value);
    }
    ctx.stroke();
    ctx.restore();
  }

  for (const c of circuit.components.values()) {
    if (!isComponentVisible(c, visible)) continue;
    const selected = editor.selectedIds.has(c.id);
    const hovered = !selected && editor.hoveredComponentId === c.id && editor.tool.kind === 'select';
    drawComponent(
      ctx,
      c,
      resolve,
      selected,
      hovered,
      library,
      opts?.softMode === true,
      glowPinIds,
      pinGlowStyle,
    );
  }

  // Tutorial target rings (button / LED / wire endpoints / toggle target).
  const th = editor.tutorialHint;
  if (th) {
    ctx.save();
    ctx.strokeStyle = 'rgba(245, 197, 24, 0.85)';
    ctx.lineWidth = 2 / Math.max(camera.scale, 0.01);
    ctx.setLineDash([6 / camera.scale, 4 / camera.scale]);
    for (const c of circuit.components.values()) {
      const match =
        (th === 'place-button' && c.kind === 'button') ||
        (th === 'place-led' && c.kind === 'led') ||
        (th === 'toggle' && c.kind === 'button') ||
        (th === 'wire' && (c.kind === 'button' || c.kind === 'led'));
      if (!match) continue;
      ctx.beginPath();
      ctx.arc(c.pos.x, c.pos.y, 28, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Hovered pin magnet while the wire tool is active (placing or completing).
  if (editor.tool.kind === 'wire' && editor.hoveredPinId) {
    const p = pinById.get(editor.hoveredPinId);
    if (p) {
      ctx.save();
      ctx.strokeStyle = COLOR.selected;
      ctx.fillStyle = 'rgba(245, 197, 24, 0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COLOR.selected;
      ctx.fill();
      ctx.restore();
    }
  }

  // Draggable bend-point handles, only for the wire that's selected or (in
  // select tool) currently hovered — showing them on every wire at once
  // would just be noise.
  for (const w of circuit.wires.values()) {
    if (!w.waypoints || w.waypoints.length === 0) continue;
    const isSelected = editor.selectedWireIds.has(w.id);
    const isHovered = editor.tool.kind === 'select' && w.id === editor.hoveredWireId;
    if (!isSelected && !isHovered) continue;
    ctx.fillStyle = isSelected ? COLOR.selected : COLOR.hover;
    for (const wp of w.waypoints) {
      ctx.beginPath();
      ctx.arc(wp.x, wp.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Marquee selection rectangle (already in world space, same transform as everything else).
  if (editor.marqueeStart && editor.dragging) {
    const { x, y } = editor.marqueeStart;
    const w = editor.mouse.x - x;
    const h = editor.mouse.y - y;
    ctx.fillStyle = COLOR.marquee;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLOR.marqueeStroke;
    ctx.lineWidth = 1 / camera.scale;
    ctx.strokeRect(x, y, w, h);
  }

  // Net name chip near the cursor (hover wire/pin, or sticky H highlight).
  // Prefer pin name+net when a pin is under the cursor.
  let tip = '';
  if (editor.hoveredPinId && !editor.dragging) {
    const pin = pinById.get(editor.hoveredPinId);
    if (pin) {
      const nets = circuit.computeNets();
      const net = editor.formatNetName(nets.netOf.get(pin.id) ?? null);
      const { level, contended } = resolve(pin.id);
      const lvl = contended ? 'X' : level === 'Z' ? 'Z' : String(level);
      tip = net ? `${pin.name} · ${net} · ${lvl}` : `${pin.name} · ${lvl}`;
    }
  }
  if (!tip) {
    // Sticky H / wire-select still glows the net, but the name chip only
    // appears while the pointer is actually on a pin or wire — otherwise it
    // sticks to empty canvas after a bend edit or selection.
    if (editor.hoveredPinId || editor.hoveredWireId) {
      tip = editor.formatNetName(glowNet) ?? '';
    }
  }
  // Chip dive preview while hovering an instance in select tool.
  if (
    !tip &&
    editor.tool.kind === 'select' &&
    editor.hoveredComponentId &&
    !editor.dragging
  ) {
    const hc = circuit.components.get(editor.hoveredComponentId);
    if (hc?.kind === 'chip' && library.has(hc.defId)) {
      const def = library.get(hc.defId);
      const edited = (def.revision ?? 0) !== (hc.defRevision ?? 0);
      tip = `${def.name} · ${def.ports.length} pins · Dive${edited ? ' · edited' : ''}`;
    }
  }
  if (tip && !editor.dragging) {
    const lx = editor.mouse.x + 12 / camera.scale;
    const ly = editor.mouse.y - 10 / camera.scale;
    ctx.save();
    ctx.font = `${11 / camera.scale}px ui-monospace, "SF Mono", monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pad = 4 / camera.scale;
    const tw = ctx.measureText(tip).width;
    const th = 14 / camera.scale;
    ctx.fillStyle = 'rgba(18, 20, 28, 0.88)';
    ctx.strokeStyle = glowNet === highlightNet ? '#5ec8ff' : COLOR.hover;
    ctx.lineWidth = 1 / camera.scale;
    roundRectPath(ctx, lx - pad, ly - th / 2, tw + pad * 2, th, 3 / camera.scale);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e7e9ef';
    ctx.fillText(tip, lx, ly);
    ctx.restore();
  }

  ctx.restore();

  if (opts?.softMode) {
    ctx.save();
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = 'SOFT RUN';
    const padX = 8;
    const padY = 5;
    const tw = ctx.measureText(label).width;
    const x = 10;
    const y = 10;
    ctx.fillStyle = 'rgba(40, 28, 12, 0.82)';
    ctx.strokeStyle = '#e6a23c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x, y, tw + padX * 2, 12 + padY * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e6a23c';
    ctx.fillText(label, x + padX, y + padY);
    ctx.restore();
  }
}

/** Adaptive dot grid — Path2D cache keyed by visible world window + zoom. */
let gridPathCache: { key: string; path: Path2D } | null = null;

function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, viewportW: number, viewportH: number): void {
  let step = GRID;
  while (step * camera.scale < 18) step *= 2;

  const topLeft = camera.screenToWorld({ x: 0, y: 0 }, viewportW, viewportH);
  const bottomRight = camera.screenToWorld({ x: viewportW, y: viewportH }, viewportW, viewportH);
  const x0 = Math.floor(topLeft.x / step) * step;
  const x1 = Math.ceil(bottomRight.x / step) * step;
  const y0 = Math.floor(topLeft.y / step) * step;
  const y1 = Math.ceil(bottomRight.y / step) * step;
  const r = 1.3 / camera.scale;
  const key = `${step}|${x0}|${x1}|${y0}|${y1}|${r.toFixed(4)}`;

  if (!gridPathCache || gridPathCache.key !== key) {
    const path = new Path2D();
    for (let x = x0; x <= x1; x += step) {
      for (let y = y0; y <= y1; y += step) {
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    gridPathCache = { key, path };
  }

  ctx.fillStyle = COLOR.grid;
  ctx.fill(gridPathCache.path);
}

/**
 * Solder dots where same-net wires split: a wire ending on another's run, or
 * two wires that ran colinear and part ways. Nets are electrical truth, so
 * these dots only make the drawing say what the netlist already does — no
 * `junction` component required.
 */
function drawSameNetTees(
  ctx: CanvasRenderingContext2D,
  wires: Array<{ w: Wire; points: Point[] }>,
  netOf: Map<string, string>,
  resolve: LevelResolver,
  visible: WorldBounds,
): void {
  const byNet = new Map<string, Array<{ w: Wire; points: Point[] }>>();
  for (const entry of wires) {
    const net = netOf.get(entry.w.a);
    if (!net) continue;
    const list = byNet.get(net);
    if (list) list.push(entry);
    else byNet.set(net, [entry]);
  }
  for (const entries of byNet.values()) {
    if (entries.length < 2) continue;
    const tees = findSameNetTees(entries.map((e) => e.points));
    if (!tees.length) continue;
    const { level, contended } = resolve(entries[0]!.w.a);
    ctx.fillStyle = levelColor(level, contended);
    for (const p of tees) {
      if (p.x < visible.minX || p.x > visible.maxX || p.y < visible.minY || p.y > visible.maxY) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Draws a wire as a rounded orthogonal polyline (schematic-style). */
function drawWire(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  contended: boolean,
  emphasis: 'none' | 'hover' | 'selected' | 'net' = 'none',
  bus = false,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = () => strokeRoundedPolyline(ctx, points, 7);
  const coreW = bus ? (contended ? 4.2 : 3.4) : contended ? 3 : 2.2;
  const glowW = bus ? (contended ? 16 : 13) : contended ? 13 : 10;
  const softW = bus ? (contended ? 12 : 9) : contended ? 9 : 6;
  if (contended) drawContendedHeat(ctx, points, path, bus);
  if (emphasis !== 'none') {
    const glow =
      emphasis === 'selected' ? COLOR.selected : emphasis === 'net' ? '#5ec8ff' : COLOR.hover;
    ctx.globalAlpha = emphasis === 'selected' ? 0.45 : emphasis === 'net' ? 0.38 : 0.28;
    ctx.strokeStyle = glow;
    ctx.lineWidth = glowW;
    path();
    ctx.stroke();
  }
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = softW;
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = coreW;
  ctx.strokeStyle = color;
  path();
  ctx.stroke();
  if (bus && points.length >= 2) {
    // Schematic bus mark: small diagonal slash at mid-polyline.
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
    }
    let along = total / 2;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (seg < 0.5) continue;
      if (along > seg) {
        along -= seg;
        continue;
      }
      const t = along / seg;
      const mx = a.x + (b.x - a.x) * t;
      const my = a.y + (b.y - a.y) * t;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(mx - 5, my - 5);
      ctx.lineTo(mx + 5, my + 5);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** Pulsing heat halo + traveling embers + sparks on shorted nets. */
function drawContendedHeat(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  path: () => void,
  bus: boolean,
): void {
  const t = performance.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 9);
  const g = Math.floor(40 + 90 * pulse);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Soft heat bloom
  ctx.globalAlpha = 0.22 + 0.18 * pulse;
  ctx.strokeStyle = `rgb(255, ${g}, 28)`;
  ctx.lineWidth = bus ? 20 : 15;
  path();
  ctx.stroke();

  // Hot core shimmer
  ctx.globalAlpha = 0.35 + 0.25 * pulse;
  ctx.strokeStyle = COLOR.contended;
  ctx.lineWidth = bus ? 8 : 6;
  path();
  ctx.stroke();

  // Embers racing along the wire
  ctx.setLineDash([5, 12]);
  ctx.lineDashOffset = -(t * 55);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = COLOR.heat;
  ctx.lineWidth = bus ? 2.8 : 2.1;
  path();
  ctx.stroke();
  ctx.setLineDash([]);

  // Flickering sparks at a few stations along the polyline
  const stations = samplePolyline(points, 28);
  for (let i = 0; i < stations.length; i++) {
    const p = stations[i]!;
    const flicker = 0.35 + 0.65 * Math.max(0, Math.sin(t * 14 + i * 1.7));
    if (flicker < 0.45) continue;
    const r = (bus ? 2.4 : 1.8) * (0.7 + 0.5 * flicker);
    ctx.globalAlpha = 0.55 * flicker;
    ctx.fillStyle = COLOR.spark;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Tiny smoke puff drifting up
    ctx.globalAlpha = 0.12 * flicker;
    ctx.fillStyle = '#c8c8c8';
    ctx.beginPath();
    ctx.arc(p.x + Math.sin(t * 3 + i) * 2, p.y - 4 - (t * 8 + i * 3) % 10, r * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Points spaced roughly `spacing` apart along an orthogonal polyline. */
function samplePolyline(points: Point[], spacing: number): Point[] {
  if (points.length < 2) return [];
  const out: Point[] = [];
  let carry = spacing * 0.5;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.5) continue;
    let d = carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += spacing;
    }
    carry = d - len;
  }
  return out;
}

/** Horizontal power-rail bars linking same-net VCC/GND sources at a shared Y. */
function drawPowerRailBars(
  ctx: CanvasRenderingContext2D,
  circuit: Circuit,
  nets: { netOf: Map<string, string> },
): void {
  type Group = { value: 0 | 1; y: number; xs: number[] };
  const groups = new Map<string, Group>();
  for (const c of circuit.components.values()) {
    if (c.kind !== 'source') continue;
    const net = nets.netOf.get(c.pins.out.id) ?? c.id;
    const yKey = Math.round(c.pos.y);
    const key = `${net}|${c.value}|${yKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { value: c.value, y: c.pos.y, xs: [] };
      groups.set(key, g);
    }
    g.xs.push(c.pos.x);
  }
  ctx.save();
  ctx.lineCap = 'round';
  for (const g of groups.values()) {
    if (g.xs.length < 2) continue;
    const minX = Math.min(...g.xs) - 14;
    const maxX = Math.max(...g.xs) + 14;
    // VCC rail at the top bar; GND at the uppermost earth bar (just under the pin).
    const barY = g.y - 6;
    ctx.strokeStyle = g.value === 1 ? COLOR.wireHigh : COLOR.wireLow;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(minX, barY);
    ctx.lineTo(maxX, barY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPinDot(
  ctx: CanvasRenderingContext2D,
  pin: Pin,
  resolve: LevelResolver,
  glow: PinGlowStyle | null = null,
): void {
  const { level, contended } = resolve(pin.id);
  const color = levelColor(level, contended);
  ctx.save();
  if (glow) {
    // Match wire emphasis: cyan for sticky H net, soft grey for pointer hover.
    ctx.globalAlpha = glow === 'net' ? 0.55 : 0.4;
    ctx.strokeStyle = glow === 'net' ? '#5ec8ff' : COLOR.hover;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(pin.pos.x, pin.pos.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = glow === 'net' ? 0.35 : 0.25;
    ctx.fillStyle = glow === 'net' ? '#5ec8ff' : COLOR.hover;
    ctx.beginPath();
    ctx.arc(pin.pos.x, pin.pos.y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pin.pos.x, pin.pos.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(pin.pos.x, pin.pos.y, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

type PinGlowStyle = 'hover' | 'net';

function pinGlow(
  pin: Pin,
  glowPinIds: Set<string> | null,
  style: PinGlowStyle | null,
): PinGlowStyle | null {
  if (!glowPinIds || !style) return null;
  return glowPinIds.has(pin.id) ? style : null;
}

/** Human-readable pin label for schematic bodies (addr0 → A0, we → WE, …). */
export function formatPinLabel(name: string): string {
  const addr = /^addr(\d+)$/i.exec(name);
  if (addr) return `A${addr[1]}`;
  const data = /^data(\d+)$/i.exec(name);
  if (data) return `D${data[1]}`;
  const ch = /^ch(\d+)$/i.exec(name);
  if (ch) return `CH${ch[1]}`;
  const bit = /^b(\d+)$/i.exec(name);
  if (bit) return `B${bit[1]}`;
  const known: Record<string, string> = {
    we: 'WE',
    oe: 'OE',
    clk: 'CLK',
    gate: 'G',
    drain: 'D',
    source: 'S',
    out: 'OUT',
    in: 'IN',
    trig: 'TRIG',
    net: 'NET',
    io: 'IO',
  };
  const low = name.toLowerCase();
  if (known[low]) return known[low]!;
  // Folded ports often arrive as p0/p1 — keep short; otherwise show as authored.
  if (/^p\d+$/i.test(name)) return name.toUpperCase();
  return name.length <= 6 ? name.toUpperCase() : name;
}

/**
 * Chip / RAM / ROM body title — silkscreen-style, like a real IC package:
 * text always runs along the long axis of the body (vertical on tall
 * left/right-pin packages, horizontal on wide ones), centered on the die.
 */
function drawChipMarking(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  text: string,
): void {
  ctx.save();
  ctx.fillStyle = COLOR.text;
  ctx.font = '10px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(cx, cy);
  if (h > w) {
    // Tall package (DIP-like): read upward along the body.
    ctx.rotate(-Math.PI / 2);
  }
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * Classify which body edge a pin sits on for label placement.
 * Tall left/right stacks put corner pins closer to the top/bottom edge than
 * to the side — prefer the side the pin is actually beside (dx vs dy), not
 * whichever body edge happens to be nearest in absolute distance.
 */
export function pinLabelEdge(
  pin: Point,
  cx: number,
  cy: number,
  bodyW: number,
  _bodyH: number,
): 'left' | 'right' | 'top' | 'bottom' {
  const halfW = bodyW / 2;
  const dx = pin.x - cx;
  const dy = pin.y - cy;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // Stacked side pins (busprobe / analyzer / DIP): corner pins are still
  // beside the left/right edge even when closer to the top/bottom of a short body.
  if (adx >= Math.max(halfW * 0.35, ady * 0.35)) {
    return dx <= 0 ? 'left' : 'right';
  }

  const halfH = _bodyH / 2;
  const distL = Math.abs(cx - halfW - pin.x);
  const distR = Math.abs(cx + halfW - pin.x);
  const distT = Math.abs(cy - halfH - pin.y);
  const distB = Math.abs(cy + halfH - pin.y);
  const minH = Math.min(distL, distR);
  const minV = Math.min(distT, distB);
  if (minH <= minV) return distL <= distR ? 'left' : 'right';
  return distT <= distB ? 'top' : 'bottom';
}

/**
 * Pin name just inside the body beside the pin. Left/right labels always share
 * the pin's Y with middle baseline so a stack reads as one column.
 */
function drawBodyPinLabel(
  ctx: CanvasRenderingContext2D,
  pin: Pin,
  cx: number,
  cy: number,
  labelText?: string,
  bodyW = CHIP_INSTANCE_WIDTH,
  bodyH?: number,
): void {
  const halfH = bodyH != null ? bodyH / 2 : bodyW / 2;
  const h = halfH * 2;
  const edge = pinLabelEdge(pin.pos, cx, cy, bodyW, h);

  const inset = 10;
  let lx = pin.pos.x;
  let ly = pin.pos.y;
  let align: CanvasTextAlign = 'center';
  // Always middle — top/bottom baseline shifts glyphs and makes corner
  // labels look crooked against a left/right stack.
  const baseline: CanvasTextBaseline = 'middle';

  if (edge === 'left') {
    lx = pin.pos.x + inset;
    align = 'left';
  } else if (edge === 'right') {
    lx = pin.pos.x - inset;
    align = 'right';
  } else if (edge === 'top') {
    ly = pin.pos.y + inset;
  } else {
    ly = pin.pos.y - inset;
  }

  ctx.save();
  ctx.font = '9px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = COLOR.textDim;
  ctx.fillText(labelText ?? formatPinLabel(pin.name), lx, ly);
  ctx.restore();
}

/**
 * Enhancement MOSFET matching the lab reference card:
 * three thick channel bars, narrow gate gap, substrate stub from the
 * middle bar (arrow N→in / P→out) then L-bend into the source-side
 * channel rectangle (not into the D/S stem wire).
 * When `conducting`, the three bars merge into one continuous D–S channel
 * (same gate rule as the solver: N@G=1, P@G=0).
 */
function drawMosfetSymbol(
  ctx: CanvasRenderingContext2D,
  c: Extract<Component, { kind: 'transistor' }>,
  color: string,
  selected: boolean,
  hovered: boolean,
  conducting = false,
): void {
  const { rotation, mirrorX, mirrorY } = getOrientation(c);
  const isN = c.type === 'N';
  const gateX = -28;
  // Narrow insulator gap (≈ stroke width), like the reference card.
  const gatePlateX = -7;
  const chanX = 0;
  const bodyX = 11;
  const topPinY = -28;
  const botPinY = 28;
  const sourceY = isN ? botPinY : topPinY;
  const drainY = isN ? topPinY : botPinY;
  const barW = 5;
  const barH = 7;
  const barGap = 3;
  const barPitch = barH + barGap;
  const bars = [-barPitch, 0, barPitch] as const;
  const topBarTop = bars[0]! - barH / 2;
  const botBarBot = bars[2]! + barH / 2;
  // Source-side channel bar (bottom for N, top for P) — L ends on this rectangle.
  const srcBarY = isN ? bars[2]! : bars[0]!;

  ctx.save();
  ctx.translate(c.pos.x, c.pos.y);
  if (mirrorX) ctx.scale(-1, 1);
  if (mirrorY) ctx.scale(1, -1);
  ctx.rotate((rotation * Math.PI) / 180);

  if (selected || hovered) {
    ctx.strokeStyle = selected ? COLOR.selected : COLOR.hover;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(gateX, 0);
    ctx.lineTo(gatePlateX, 0);
    ctx.moveTo(chanX, topPinY);
    ctx.lineTo(chanX, botPinY);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected || hovered ? 2.2 : 1.8;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';

  // Gate lead + insulated gate plate.
  ctx.beginPath();
  ctx.moveTo(gateX, 0);
  ctx.lineTo(gatePlateX, 0);
  ctx.moveTo(gatePlateX, topBarTop - 1);
  ctx.lineTo(gatePlateX, botBarBot + 1);
  ctx.stroke();

  // Channel: three separate bars when off; solid D–S slab when conducting.
  if (conducting) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.fillRect(chanX - barW / 2, topBarTop, barW, botBarBot - topBarTop);
    ctx.restore();
    ctx.fillRect(chanX - barW / 2, topBarTop, barW, botBarBot - topBarTop);
  } else {
    for (const cy of bars) {
      ctx.fillRect(chanX - barW / 2, cy - barH / 2, barW, barH);
    }
  }

  // Drain / source stems (same vertical as the bars).
  ctx.beginPath();
  ctx.moveTo(chanX, topPinY);
  ctx.lineTo(chanX, topBarTop);
  ctx.moveTo(chanX, botPinY);
  ctx.lineTo(chanX, botBarBot);
  ctx.stroke();

  // Substrate: middle bar → right → L into the *source-side rectangle*.
  const midRight = chanX + barW / 2;
  ctx.beginPath();
  ctx.moveTo(midRight, 0);
  ctx.lineTo(bodyX, 0);
  ctx.lineTo(bodyX, srcBarY);
  ctx.lineTo(midRight, srcBarY);
  ctx.stroke();

  // Arrow on the stub off the middle bar (N tip touches the bar; P points out).
  const ah = 3.2;
  const aw = 5;
  ctx.beginPath();
  if (isN) {
    ctx.moveTo(midRight, 0);
    ctx.lineTo(midRight + aw, -ah);
    ctx.lineTo(midRight + aw, ah);
  } else {
    const tip = bodyX - 1;
    ctx.moveTo(tip, 0);
    ctx.lineTo(tip - aw, -ah);
    ctx.lineTo(tip - aw, ah);
  }
  ctx.closePath();
  ctx.fill();

  // G / D / S captions.
  ctx.font = '8px ui-monospace, "SF Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.8;
  ctx.textAlign = 'center';
  ctx.fillText('G', gateX + 6, -8);
  ctx.fillText('D', 8, drainY + (drainY < 0 ? 9 : -9));
  ctx.fillText('S', 8, sourceY + (sourceY < 0 ? 9 : -9));
  ctx.globalAlpha = 1;

  ctx.restore();
}

/** Draw a polyline with rounded corners (schematic-style curves). */
function strokeRoundedPolyline(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  cornerR = 8,
): void {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  if (points.length === 1) return;
  if (points.length === 2) {
    ctx.lineTo(points[1]!.x, points[1]!.y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const d1x = cur.x - prev.x;
    const d1y = cur.y - prev.y;
    const d2x = next.x - cur.x;
    const d2y = next.y - cur.y;
    const len1 = Math.hypot(d1x, d1y) || 1;
    const len2 = Math.hypot(d2x, d2y) || 1;
    const r = Math.min(cornerR, len1 / 3, len2 / 3, 4);
    const p1 = { x: cur.x - (d1x / len1) * r, y: cur.y - (d1y / len1) * r };
    const p2 = { x: cur.x + (d2x / len2) * r, y: cur.y + (d2y / len2) * r };
    ctx.lineTo(p1.x, p1.y);
    ctx.quadraticCurveTo(cur.x, cur.y, p2.x, p2.y);
  }
  const last = points[points.length - 1]!;
  ctx.lineTo(last.x, last.y);
}

function drawComponent(
  ctx: CanvasRenderingContext2D,
  c: Component,
  resolve: LevelResolver,
  selected: boolean,
  hovered: boolean,
  library: ChipLibrary,
  softMode = false,
  glowPinIds: Set<string> | null = null,
  glowStyle: PinGlowStyle | null = null,
): void {
  ctx.font = '10px ui-monospace, "SF Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const ringColor = selected ? COLOR.selected : hovered ? COLOR.hover : null;
  const bodyStroke = (defaultColor: string) => (selected ? COLOR.selected : hovered ? COLOR.hover : defaultColor);
  const dot = (pin: Pin) => drawPinDot(ctx, pin, resolve, pinGlow(pin, glowPinIds, glowStyle));

  const stub = (fromX: number, fromY: number, pin: Pin) => {
    ctx.strokeStyle = COLOR.bodyStroke;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(pin.pos.x, pin.pos.y);
    ctx.stroke();
  };

  /** Stub from body bbox edge toward the pin (orientation-aware). */
  const stubPin = (cx: number, cy: number, hw: number, hh: number, pin: Pin) => {
    const edge = bodyEdgeToward(cx, cy, hw, hh, pin.pos);
    stub(edge.x, edge.y, pin);
  };

  switch (c.kind) {
    case 'transistor': {
      const stroke = c.type === 'N' ? COLOR.strokeN : COLOR.strokeP;
      // Match solver: N conducts at G=1, P at G=0. Soft Run mutes like live wires.
      const gateLevel = resolve(c.pins.gate.id).level;
      const conducting =
        !softMode && (c.type === 'N' ? gateLevel === 1 : gateLevel === 0);
      drawMosfetSymbol(ctx, c, bodyStroke(stroke), selected, hovered, conducting);
      dot(c.pins.gate);
      dot(c.pins.drain);
      dot(c.pins.source);
      break;
    }
    case 'source': {
      const { x, y } = c.pos;
      const isVcc = c.value === 1;
      const stroke = isVcc ? COLOR.wireHigh : COLOR.wireLow;
      const { rotation, mirrorX, mirrorY } = getOrientation(c);
      if (ringColor) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // Draw the whole rail symbol in local space so rotate / flip moves
      // the bar + stem together (not just the pin stub).
      ctx.save();
      ctx.translate(x, y);
      if (mirrorX) ctx.scale(-1, 1);
      if (mirrorY) ctx.scale(1, -1);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.strokeStyle = bodyStroke(stroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (isVcc) {
        // Classic VCC: pin at +Y, stem up into a horizontal rail bar.
        ctx.beginPath();
        ctx.moveTo(0, 15);
        ctx.lineTo(0, 2);
        ctx.lineTo(0, -6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-10, -6);
        ctx.lineTo(10, -6);
        ctx.stroke();
      } else {
        // Earth symbol: pin above (toward the circuit), three bars below.
        ctx.beginPath();
        ctx.moveTo(0, -15);
        ctx.lineTo(0, -6);
        ctx.stroke();
        for (let i = 0; i < 3; i++) {
          const half = 11 - i * 3.5;
          const yy = -6 + i * 4;
          ctx.beginPath();
          ctx.moveTo(-half, yy);
          ctx.lineTo(half, yy);
          ctx.stroke();
        }
      }
      ctx.restore();
      // Keep the name upright; place it opposite the pin.
      const labelOff = transformOffset(0, isVcc ? -12 : 14, rotation, mirrorX, mirrorY);
      ctx.fillStyle = COLOR.text;
      ctx.font = '9px ui-monospace, "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isVcc ? 'VCC' : 'GND', x + labelOff.x, y + labelOff.y);
      dot(c.pins.out);
      break;
    }
    case 'input': {
      const { x, y } = c.pos;
      const w = 24;
      const h = 20;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = c.value === 1 ? '#3d2f14' : '#182233';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.value === 1 ? COLOR.wireHigh : COLOR.wireLow);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, w / 2, h / 2, c.pins.out);
      dot(c.pins.out);
      ctx.fillStyle = COLOR.text;
      ctx.fillText(String(c.value), x, y);
      break;
    }
    case 'button': {
      const { x, y } = c.pos;
      const on = c.value === 1;
      const toggle = c.mode === 'toggle';
      // Chassis plate
      const pw = 34;
      const ph = 30;
      if (ringColor) glowRect(ctx, x - pw / 2, y - ph / 2, pw, ph, 6, ringColor);
      ctx.fillStyle = '#151820';
      roundRectPath(ctx, x - pw / 2, y - ph / 2, pw, ph, 5);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.2;
      ctx.stroke();
      // Raised / pressed circular actuator
      const r = on ? 8.5 : 10;
      const cyBtn = on ? y - 1 : y - 3;
      ctx.beginPath();
      ctx.arc(x, cyBtn + 1.5, r + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
      const grad = ctx.createRadialGradient(x - 2, cyBtn - 2, 1, x, cyBtn, r);
      if (on) {
        grad.addColorStop(0, '#f0c040');
        grad.addColorStop(1, '#a87818');
      } else {
        grad.addColorStop(0, '#5a6578');
        grad.addColorStop(1, '#2a3140');
      }
      ctx.beginPath();
      ctx.arc(x, cyBtn, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = bodyStroke(on ? COLOR.selected : '#8a93a8');
      ctx.lineWidth = 1.3;
      ctx.stroke();
      // Mode caption under the bezel
      ctx.font = '7px ui-monospace, "SF Mono", monospace';
      ctx.fillStyle = COLOR.textDim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(toggle ? 'TOG' : 'MOM', x, y + 11);
      stubPin(x, y, pw / 2, ph / 2, c.pins.out);
      dot(c.pins.out);
      break;
    }
    case 'switch': {
      const { x, y } = c.pos;
      const w = 36;
      const h = 22;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 4, ringColor);
      ctx.fillStyle = '#151820';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.closed ? '#8fd46a' : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.2;
      ctx.stroke();
      stubPin(x, y, w / 2, h / 2, c.pins.in);
      stubPin(x, y, w / 2, h / 2, c.pins.out);
      dot(c.pins.in);
      dot(c.pins.out);
      // Knife blade: closed = bridge across, open = lifted toward out side.
      ctx.strokeStyle = c.closed ? '#8fd46a' : '#8a93a8';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (c.closed) {
        ctx.moveTo(x - 8, y);
        ctx.lineTo(x + 8, y);
      } else {
        ctx.moveTo(x - 8, y);
        ctx.lineTo(x + 6, y - 7);
      }
      ctx.stroke();
      ctx.fillStyle = COLOR.textDim;
      ctx.font = '7px ui-monospace, "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.closed ? 'ON' : 'OFF', x, y + 8);
      break;
    }
    case 'clock': {
      const { x, y } = c.pos;
      const w = 44;
      const h = 32;
      const active = c.mode === 'oneshot' ? c.holdFrames > 0 : c.running;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = active ? '#1e2a38' : COLOR.body;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.value === 1 ? COLOR.wireHigh : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, w / 2, h / 2, c.pins.out);
      stubPin(x, y, w / 2, h / 2, c.pins.trig);
      dot(c.pins.out);
      dot(c.pins.trig);
      ctx.save();
      ctx.font = '8px ui-monospace, "SF Mono", monospace';
      ctx.fillStyle = COLOR.textDim;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('OUT', c.pins.out.pos.x + 6, c.pins.out.pos.y);
      ctx.textAlign = 'right';
      ctx.fillText('TRIG', c.pins.trig.pos.x - 6, c.pins.trig.pos.y);
      ctx.restore();
      ctx.fillStyle = COLOR.selected;
      ctx.textAlign = 'center';
      ctx.fillText(c.mode === 'oneshot' ? 'PULSE' : active ? 'CLK▶' : 'CLK', x, y - 5);
      ctx.fillStyle = COLOR.textDim;
      ctx.fillText(c.mode === 'oneshot' ? `${c.dutyFrames}f` : `${c.periodFrames}f`, x, y + 9);
      break;
    }
    case 'analyzer': {
      const { x, y } = c.pos;
      const n = c.channelCount;
      const h = Math.max(36, (n - 1) * 20 + 28);
      const w = 64;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = c.armed ? '#1a2430' : COLOR.body;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(c.armed ? COLOR.selected : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (let i = 0; i < n; i++) {
        const p = c.pins[`ch${i}`];
        if (!p) continue;
        stubPin(x, y, w / 2, h / 2, p);
        dot(p);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
      }
      ctx.fillStyle = COLOR.selected;
      ctx.font = '10px ui-monospace, "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LA', x + 14, y - 8);
      ctx.fillStyle = c.armed ? COLOR.wireHigh : COLOR.textDim;
      ctx.fillText(c.armed ? 'REC' : `${n}ch`, x + 14, y + 8);
      break;
    }
    case 'busprobe': {
      const { x, y } = c.pos;
      const n = c.bitWidth;
      // Match analyzer pitch so body edges don't steal corner pins for labels.
      const h = Math.max(40, (n - 1) * 20 + 28);
      const w = 78;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = '#161a22';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      const levels: Array<{ level: Level; contended: boolean }> = [];
      for (let i = 0; i < n; i++) {
        const p = c.pins[`b${i}`];
        if (!p) {
          levels.push({ level: 'Z', contended: false });
          continue;
        }
        stubPin(x, y, w / 2, h / 2, p);
        dot(p);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
        const { level, contended } = resolve(p.id);
        levels.push({ level, contended });
      }
      const decoded = decodeBusProbe(levels, c.radix);
      ctx.font = '10px ui-monospace, "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = COLOR.textDim;
      ctx.fillText(c.label?.trim() || `BUS${n}`, x + 12, y - h / 2 + 14);
      ctx.fillStyle = decoded.value === null ? '#e0a060' : COLOR.selected;
      const prefix = c.radix === 'hex' ? '0x' : c.radix === 'bin' ? '0b' : '';
      ctx.font = '12px ui-monospace, "SF Mono", monospace';
      ctx.fillText(`${prefix}${decoded.text}`, x + 12, y + 2);
      if (c.radix !== 'bin' && n <= 16) {
        ctx.fillStyle = COLOR.textDim;
        ctx.font = '9px ui-monospace, "SF Mono", monospace';
        const bin = decoded.bitsMsbFirst;
        const shown = bin.length > 12 ? `${bin.slice(0, 6)}…${bin.slice(-4)}` : bin;
        ctx.fillText(shown, x + 12, y + 16);
      }
      break;
    }
    case 'busswitch': {
      const { x, y } = c.pos;
      const n = c.bitWidth;
      const h = Math.max(44, (n - 1) * 20 + 28);
      const w = BUS_SWITCH_BODY_W;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 5, ringColor);
      // Package
      ctx.fillStyle = '#181c14';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 5);
      ctx.fill();
      ctx.strokeStyle = bodyStroke('#6a9a5a');
      ctx.lineWidth = selected || hovered ? 2 : 1.25;
      ctx.stroke();

      // Left readout strip (clear of paddles)
      const levels = Array.from({ length: n }, (_, i) => ({
        level: (((c.value >> i) & 1) as 0 | 1),
        contended: false,
      }));
      const decoded = decodeBusProbe(levels, c.radix);
      const prefix = c.radix === 'hex' ? '0x' : c.radix === 'bin' ? '0b' : '';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLOR.textDim;
      ctx.font = '9px ui-monospace, "SF Mono", monospace';
      ctx.fillText(c.label?.trim() || `DIP${n}`, x - w / 2 + 22, y - 10);
      ctx.fillStyle = COLOR.selected;
      ctx.font = '12px ui-monospace, "SF Mono", monospace';
      ctx.fillText(`${prefix}${decoded.text}`, x - w / 2 + 22, y + 6);

      // Vertical divider between readout and DIP bank
      ctx.strokeStyle = '#2e3828';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 8, y - h / 2 + 6);
      ctx.lineTo(x - 8, y + h / 2 - 6);
      ctx.stroke();

      // Always stub onto the pin-bank side (not top/bottom for end bits).
      const side = busSwitchSideUnit(c);
      const hw = w / 2;
      const hh = h / 2;
      for (let i = 0; i < n; i++) {
        const p = c.pins[`b${i}`];
        if (!p) continue;
        let ex: number;
        let ey: number;
        if (Math.abs(side.x) >= Math.abs(side.y)) {
          ex = side.x >= 0 ? x + hw : x - hw;
          ey = Math.max(y - hh, Math.min(y + hh, p.pos.y));
        } else {
          ex = Math.max(x - hw, Math.min(x + hw, p.pos.x));
          ey = side.y >= 0 ? y + hh : y - hh;
        }
        stub(ex, ey, p);
        dot(p);
        drawBodyPinLabel(ctx, p, x, y, String(i), w, h);

        const pad = busSwitchPaddleCenter(c, i);
        if (!pad) continue;
        const on = ((c.value >> i) & 1) === 1;
        const slotW = 10;
        const slotH = 14;
        ctx.fillStyle = '#0c0e0a';
        roundRectPath(ctx, pad.x - slotW / 2, pad.y - slotH / 2, slotW, slotH, 2);
        ctx.fill();
        ctx.strokeStyle = '#3d4a34';
        ctx.lineWidth = 1;
        ctx.stroke();
        const ky = pad.y + (on ? -3.5 : 3.5);
        ctx.fillStyle = on ? '#8fd46a' : '#5a6270';
        roundRectPath(ctx, pad.x - 4, ky - 3.5, 8, 7, 1.5);
        ctx.fill();
      }
      break;
    }
    case 'buspass': {
      const { x, y } = c.pos;
      const n = c.bitWidth;
      const h = Math.max(44, (n - 1) * 20 + 28);
      const w = BUS_PASS_BODY_W;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 5, ringColor);
      ctx.fillStyle = '#141820';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 5);
      ctx.fill();
      ctx.strokeStyle = bodyStroke('#5a8aaa');
      ctx.lineWidth = selected || hovered ? 2 : 1.25;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLOR.textDim;
      ctx.font = '8px ui-monospace, "SF Mono", monospace';
      ctx.fillText(c.label?.trim() || `SW×${n}`, x, y - h / 2 + 10);
      for (let i = 0; i < n; i++) {
        const pa = c.pins[`a${i}`];
        const pb = c.pins[`b${i}`];
        if (pa) {
          stubPin(x, y, w / 2, h / 2, pa);
          dot(pa);
          drawBodyPinLabel(ctx, pa, x, y, String(i), w, h);
        }
        if (pb) {
          stubPin(x, y, w / 2, h / 2, pb);
          dot(pb);
        }
        const pad = busPassPaddleCenter(c, i);
        if (!pad) continue;
        const on = ((c.closed >> i) & 1) === 1;
        const slotW = 12;
        const slotH = 14;
        ctx.fillStyle = '#0c0e12';
        roundRectPath(ctx, pad.x - slotW / 2, pad.y - slotH / 2, slotW, slotH, 2);
        ctx.fill();
        ctx.strokeStyle = '#3a4558';
        ctx.lineWidth = 1;
        ctx.stroke();
        const ky = pad.y + (on ? -3.5 : 3.5);
        ctx.fillStyle = on ? '#6ab0e8' : '#5a6270';
        roundRectPath(ctx, pad.x - 4.5, ky - 3.5, 9, 7, 1.5);
        ctx.fill();
      }
      break;
    }
    case 'tty': {
      const { x, y } = c.pos;
      const w = 64;
      const h = 36;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 6, ringColor);
      ctx.fillStyle = '#152018';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      ctx.fillStyle = COLOR.selected;
      ctx.fillText('TTY', x, y - 4);
      ctx.fillStyle = COLOR.textDim;
      ctx.fillText(c.ramId ? 'linked' : '—', x, y + 10);
      break;
    }
    case 'led': {
      const { x, y } = c.pos;
      const { level, contended } = resolve(c.pins.in.id);
      const on = c.forceOn === true || (level === 1 && !contended);
      if (ringColor) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (on) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = c.color;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = on ? c.color : '#1a1c22';
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(on ? c.color : COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, 11, 11, c.pins.in);
      dot(c.pins.in);
      if (c.label) {
        ctx.fillStyle = COLOR.textDim;
        ctx.fillText(c.label, x, y - 20);
      }
      break;
    }
    case 'sevenseg': {
      const { x, y } = c.pos;
      const w = 36;
      const h = 52;
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 4, ringColor);
      ctx.fillStyle = '#14161c';
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();

      const lit = (name: string): boolean => {
        const p = c.pins[name];
        if (!p) return false;
        const { level, contended } = resolve(p.id);
        return level === 1 && !contended;
      };
      const dim = '#2a2e38';
      const on = c.color;
      const seg = (x1: number, y1: number, x2: number, y2: number, active: boolean) => {
        ctx.strokeStyle = active ? on : dim;
        ctx.lineWidth = active ? 3.2 : 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + x1, y + y1);
        ctx.lineTo(x + x2, y + y2);
        ctx.stroke();
      };
      // Classic 7-seg layout (common cathode, active-high).
      seg(-10, -18, 10, -18, lit('a'));
      seg(12, -16, 12, -2, lit('b'));
      seg(12, 2, 12, 16, lit('c'));
      seg(-10, 18, 10, 18, lit('d'));
      seg(-12, 2, -12, 16, lit('e'));
      seg(-12, -16, -12, -2, lit('f'));
      seg(-10, 0, 10, 0, lit('g'));
      if (c.hasDp && c.pins.dp) {
        ctx.fillStyle = lit('dp') ? on : dim;
        ctx.beginPath();
        ctx.arc(x + 16, y + 18, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const name of c.pinOrder) {
        const p = c.pins[name];
        if (!p) continue;
        stubPin(x, y, w / 2, h / 2, p);
        dot(p);
      }
      break;
    }
    case 'probe': {
      const { x, y } = c.pos;
      const { level, contended } = resolve(c.pins.in.id);
      if (ringColor) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = COLOR.body;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      stubPin(x, y, 10, 10, c.pins.in);
      dot(c.pins.in);
      ctx.fillStyle = levelColor(level, contended);
      ctx.fillText(level === 'Z' ? '?' : String(level), x, y);
      if (c.label) {
        ctx.fillStyle = COLOR.textDim;
        ctx.fillText(c.label, x, y - 18);
      }
      break;
    }
    case 'label': {
      const { x, y } = c.pos;
      dot(c.pins.net);
      ctx.fillStyle = selected || hovered ? COLOR.selected : COLOR.textDim;
      ctx.fillText(c.name, x, y - 12);
      break;
    }
    case 'junction': {
      const { x, y } = c.pos;
      const { level, contended } = resolve(c.pins.net.id);
      const fill = levelColor(level, contended);
      const s = selected || hovered ? 5 : 3.5;
      ctx.fillStyle = fill;
      ctx.fillRect(x - s, y - s, s * 2, s * 2);
      ctx.strokeStyle = selected ? COLOR.selected : hovered ? COLOR.hover : '#1a1c22';
      ctx.lineWidth = selected || hovered ? 1.5 : 1;
      ctx.strokeRect(x - s, y - s, s * 2, s * 2);
      break;
    }
    case 'port': {
      const { x, y } = c.pos;
      const s = 8;
      const { level, contended } = resolve(c.pins.io.id);
      const live = levelColor(level, contended);
      // Soft fill tinted by level; keep body dark enough for the label.
      ctx.fillStyle = COLOR.body;
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = live;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selected || hovered ? bodyStroke(COLOR.bodyStroke) : live;
      ctx.lineWidth = selected || hovered ? 2 : 1.6;
      ctx.stroke();
      // Direction chevron: in ←, out →, inout both (diamond alone).
      const dir = c.dir ?? 'inout';
      if (dir === 'in' || dir === 'out') {
        ctx.beginPath();
        if (dir === 'in') {
          ctx.moveTo(x + 14, y - 4);
          ctx.lineTo(x + 8, y);
          ctx.lineTo(x + 14, y + 4);
        } else {
          ctx.moveTo(x - 14, y - 4);
          ctx.lineTo(x - 8, y);
          ctx.lineTo(x - 14, y + 4);
        }
        ctx.strokeStyle = selected || hovered ? COLOR.selected : live;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      dot(c.pins.io);
      ctx.fillStyle = selected || hovered ? COLOR.selected : COLOR.textDim;
      const tag = dir === 'in' ? 'IN ' : dir === 'out' ? 'OUT ' : '';
      ctx.fillText(`${tag}${c.name}`, x, y - 16);
      break;
    }
    case 'chip': {
      const { x, y } = c.pos;
      const w = chipBodyWidth(c);
      const h = chipBoxHeight(c);
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 8, ringColor);
      const grad = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      grad.addColorStop(0, COLOR.chipBody);
      grad.addColorStop(1, '#2c335c');
      ctx.fillStyle = grad;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (const p of Object.values(c.pins) as Pin[]) {
        stubPin(x, y, w / 2, h / 2, p);
        dot(p);
        let label: string | undefined;
        if (library.has(c.defId)) {
          for (const ic of library.get(c.defId).circuit.components.values()) {
            if (ic.kind === 'port' && ic.name === p.name) {
              const dir = ic.dir ?? 'inout';
              if (dir === 'in') label = `›${formatPinLabel(p.name)}`;
              else if (dir === 'out') label = `${formatPinLabel(p.name)}›`;
              break;
            }
          }
        }
        drawBodyPinLabel(ctx, p, x, y, label, w, h);
      }
      ctx.fillStyle = COLOR.text;
      const name =
        c.marking?.trim() || (library.has(c.defId) ? library.get(c.defId).name : '?');
      drawChipMarking(ctx, x, y, w, h, name);
      // Badge only while Soft Lab actually evaluates this def (opaque). Dive
      // force-expand and inspector "Expand to compare silicon" hide it so the
      // schematic matches live transistor guts.
      const softOpaque =
        library.has(c.defId) && softLabShowsBadge(library.get(c.defId).name);
      if (softOpaque) {
        ctx.save();
        ctx.font = 'bold 8px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const badge = 'SOFT';
        const tw = ctx.measureText(badge).width;
        const bx = x - w / 2 + 4;
        const by = y - h / 2 + 4;
        ctx.fillStyle = 'rgba(40, 28, 12, 0.9)';
        ctx.strokeStyle = '#e6a23c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, tw + 6, 11);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e6a23c';
        ctx.fillText(badge, bx + 3, by + 1);
        ctx.restore();
        // Sequential Soft Lab value under marking (skip combinatorial q.length===0).
        if (c.softState && c.softState.q instanceof Uint8Array && c.softState.q.length > 0) {
          let v = 0;
          for (let i = 0; i < c.softState.q.length; i++) v |= (c.softState.q[i]! & 1) << i;
          const hex = `0x${v.toString(16).toUpperCase()}`;
          ctx.save();
          ctx.fillStyle = '#e6a23c';
          ctx.font = '9px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.translate(x, y);
          if (h > w) ctx.rotate(-Math.PI / 2);
          ctx.fillText(hex, 0, 12);
          ctx.restore();
        }
      }
      // Shared ChipDef was edited after this instance was placed / last dived.
      if (library.has(c.defId)) {
        const rev = library.get(c.defId).revision ?? 0;
        if (rev !== (c.defRevision ?? 0)) {
          ctx.fillStyle = COLOR.selected;
          ctx.beginPath();
          ctx.arc(x + w / 2 - 8, y - h / 2 + 8, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'ram': {
      const { x, y } = c.pos;
      const w = CHIP_INSTANCE_WIDTH;
      const h = chipInstanceHeight(ramPortCount(c));
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 8, ringColor);
      const grad = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      grad.addColorStop(0, COLOR.ramBody);
      grad.addColorStop(1, '#1c2e1f');
      ctx.fillStyle = grad;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (const p of Object.values(c.pins) as Pin[]) {
        stubPin(x, y, w / 2, h / 2, p);
        dot(p);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
      }
      drawChipMarking(ctx, x, y, w, h, `RAM ${1 << c.addrBits}×${c.dataBits}`);
      break;
    }
    case 'rom': {
      const { x, y } = c.pos;
      const w = CHIP_INSTANCE_WIDTH;
      const h = chipInstanceHeight(romPortCount(c));
      if (ringColor) glowRect(ctx, x - w / 2, y - h / 2, w, h, 8, ringColor);
      const grad = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      grad.addColorStop(0, '#2a2438');
      grad.addColorStop(1, '#1c1830');
      ctx.fillStyle = grad;
      roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = bodyStroke(COLOR.bodyStroke);
      ctx.lineWidth = selected || hovered ? 2 : 1.3;
      ctx.stroke();
      for (const p of Object.values(c.pins) as Pin[]) {
        stubPin(x, y, w / 2, h / 2, p);
        dot(p);
        drawBodyPinLabel(ctx, p, x, y, undefined, w, h);
      }
      drawChipMarking(ctx, x, y, w, h, `ROM ${1 << c.addrBits}×${c.dataBits}`);
      break;
    }
  }
}
