/**
 * Component orientation — rotates and flips pin offsets around the body
 * center so LEDs, buttons, chips, rails, etc. can face each other for
 * cleaner routing.
 */

import type { ChipInstanceComponent, Component, Pin, Point } from './types.js';
import type { ChipDef } from './ChipLibrary.js';
import type { Circuit } from './Circuit.js';
import {
  ANALYZER_PIN_DX,
  analyzerPinDys,
  BUS_PASS_PIN_DX,
  BUS_SWITCH_PIN_DX,
  CHIP_PIN_DX,
  CHIP_PIN_DX_RIGHT,
  chipBodyWidth,
  chipBoxHeight,
  chipPinDxPair,
  chipPinDys,
  LAYOUT,
  pinSidesFromDef,
  transistorPinOffsets,
} from './library.js';

export type Rotation = 0 | 90 | 180 | 270;

export function rotateCw(r: Rotation): Rotation {
  return ((r + 90) % 360) as Rotation;
}

export function rotateCcw(r: Rotation): Rotation {
  return ((r + 270) % 360) as Rotation;
}

export interface Orientation {
  rotation: Rotation;
  /** Flip horizontally (local X). */
  mirrorX: boolean;
  /** Flip vertically (local Y). */
  mirrorY: boolean;
}

/** Transform a local pin offset: flip H/V in local space, then CW rotation. */
export function transformOffset(
  dx: number,
  dy: number,
  rotation: Rotation = 0,
  mirrorX = false,
  mirrorY = false,
): Point {
  let x = mirrorX ? -dx : dx;
  let y = mirrorY ? -dy : dy;
  let out: Point;
  switch (rotation) {
    case 90:
      out = { x: -y, y: x };
      break;
    case 180:
      out = { x: -x, y: -y };
      break;
    case 270:
      out = { x: y, y: -x };
      break;
    default:
      out = { x, y };
  }
  // Avoid signed zero from `-0` after rotations (breaks deep equality in tests / snaps).
  if (Object.is(out.x, -0)) out.x = 0;
  if (Object.is(out.y, -0)) out.y = 0;
  return out;
}

function setPin(
  pin: Pin,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  rot: Rotation,
  mirrorX: boolean,
  mirrorY: boolean,
): void {
  const t = transformOffset(dx, dy, rot, mirrorX, mirrorY);
  pin.pos = { x: cx + t.x, y: cy + t.y };
}

/** Components that support rotate / flip in the inspector. */
export function isOrientable(c: Component): boolean {
  return (
    c.kind === 'transistor' ||
    c.kind === 'button' ||
    c.kind === 'led' ||
    c.kind === 'sevenseg' ||
    c.kind === 'probe' ||
    c.kind === 'input' ||
    c.kind === 'source' ||
    c.kind === 'clock' ||
    c.kind === 'chip' ||
    c.kind === 'ram' ||
    c.kind === 'rom' ||
    c.kind === 'analyzer' ||
    c.kind === 'busprobe' ||
    c.kind === 'busswitch' ||
    c.kind === 'switch' ||
    c.kind === 'buspass'
  );
}

export function getOrientation(c: Component): Orientation {
  if ('rotation' in c && typeof (c as { rotation?: Rotation }).rotation === 'number') {
    const rot = (c as { rotation: Rotation }).rotation;
    const mirrorX = 'mirrorX' in c && !!(c as { mirrorX?: boolean }).mirrorX;
    const mirrorY = 'mirrorY' in c && !!(c as { mirrorY?: boolean }).mirrorY;
    return { rotation: rot, mirrorX, mirrorY };
  }
  return { rotation: 0, mirrorX: false, mirrorY: false };
}

export function setOrientation(
  c: Component,
  rotation: Rotation,
  mirrorX: boolean,
  mirrorY = false,
): void {
  if (!isOrientable(c)) return;
  (c as { rotation: Rotation }).rotation = rotation;
  (c as { mirrorX: boolean }).mirrorX = mirrorX;
  (c as { mirrorY: boolean }).mirrorY = mirrorY;
  applyPinLayout(c);
}

function applyStackedPins(
  c: { pinOrder: string[]; pins: Record<string, Pin>; pos: Point },
  dx: number,
  dys: number[],
  rotation: Rotation,
  mirrorX: boolean,
  mirrorY: boolean,
): void {
  const { x: cx, y: cy } = c.pos;
  for (let i = 0; i < c.pinOrder.length; i++) {
    const name = c.pinOrder[i]!;
    const p = c.pins[name];
    if (!p) continue;
    setPin(p, cx, cy, dx, dys[i] ?? 0, rotation, mirrorX, mirrorY);
  }
}

/**
 * Recompute absolute pin positions from the component's base LAYOUT offsets
 * and current orientation. Call after rotate/flip or when restoring a save.
 */
export function applyPinLayout(c: Component): void {
  const { x: cx, y: cy } = c.pos;
  const { rotation, mirrorX, mirrorY } = getOrientation(c);

  switch (c.kind) {
    case 'transistor': {
      const off = transistorPinOffsets(c.type);
      setPin(c.pins.gate, cx, cy, off.gate[0], off.gate[1], rotation, mirrorX, mirrorY);
      setPin(c.pins.drain, cx, cy, off.drain[0], off.drain[1], rotation, mirrorX, mirrorY);
      setPin(c.pins.source, cx, cy, off.source[0], off.source[1], rotation, mirrorX, mirrorY);
      break;
    }
    case 'source': {
      const out = c.value === 1 ? LAYOUT.source.out : LAYOUT.source.gndOut;
      setPin(c.pins.out, cx, cy, out[0], out[1], rotation, mirrorX, mirrorY);
      break;
    }
    case 'input':
      setPin(c.pins.out, cx, cy, LAYOUT.input.out[0], LAYOUT.input.out[1], rotation, mirrorX, mirrorY);
      break;
    case 'button':
      setPin(c.pins.out, cx, cy, LAYOUT.button.out[0], LAYOUT.button.out[1], rotation, mirrorX, mirrorY);
      break;
    case 'switch':
      setPin(c.pins.in, cx, cy, LAYOUT.switch.in[0], LAYOUT.switch.in[1], rotation, mirrorX, mirrorY);
      setPin(c.pins.out, cx, cy, LAYOUT.switch.out[0], LAYOUT.switch.out[1], rotation, mirrorX, mirrorY);
      break;
    case 'led':
      setPin(c.pins.in, cx, cy, LAYOUT.led.in[0], LAYOUT.led.in[1], rotation, mirrorX, mirrorY);
      break;
    case 'sevenseg': {
      const order = c.pinOrder?.length ? c.pinOrder : Object.keys(c.pins);
      if (!c.pinOrder?.length) c.pinOrder = order;
      applyStackedPins(c, LAYOUT.sevenseg.pinDx, chipPinDys(order.length), rotation, mirrorX, mirrorY);
      break;
    }
    case 'probe':
      setPin(c.pins.in, cx, cy, LAYOUT.probe.in[0], LAYOUT.probe.in[1], rotation, mirrorX, mirrorY);
      break;
    case 'clock':
      setPin(c.pins.out, cx, cy, LAYOUT.clock.out[0], LAYOUT.clock.out[1], rotation, mirrorX, mirrorY);
      setPin(c.pins.trig, cx, cy, LAYOUT.clock.trig[0], LAYOUT.clock.trig[1], rotation, mirrorX, mirrorY);
      break;
    case 'chip': {
      const order = c.pinOrder?.length ? c.pinOrder : Object.keys(c.pins);
      if (!c.pinOrder?.length) c.pinOrder = order;
      const { left: pinLeft, right: pinRight } = chipPinDxPair(chipBodyWidth(c));
      if (!c.pinSide) {
        applyStackedPins(c, pinLeft, chipPinDys(order.length), rotation, mirrorX, mirrorY);
        break;
      }
      const left: string[] = [];
      const right: string[] = [];
      for (const name of order) {
        if (c.pinSide[name] === 1) right.push(name);
        else left.push(name);
      }
      const leftDys = chipPinDys(left.length);
      const rightDys = chipPinDys(right.length);
      for (let i = 0; i < left.length; i++) {
        const p = c.pins[left[i]!];
        if (p) setPin(p, cx, cy, pinLeft, leftDys[i] ?? 0, rotation, mirrorX, mirrorY);
      }
      for (let i = 0; i < right.length; i++) {
        const p = c.pins[right[i]!];
        if (p) setPin(p, cx, cy, pinRight, rightDys[i] ?? 0, rotation, mirrorX, mirrorY);
      }
      break;
    }
    case 'ram':
    case 'rom': {
      const order = c.pinOrder?.length ? c.pinOrder : Object.keys(c.pins);
      if (!c.pinOrder?.length) c.pinOrder = order;
      applyStackedPins(c, CHIP_PIN_DX, chipPinDys(order.length), rotation, mirrorX, mirrorY);
      break;
    }
    case 'analyzer': {
      const order = c.pinOrder?.length ? c.pinOrder : Object.keys(c.pins);
      if (!c.pinOrder?.length) c.pinOrder = order;
      applyStackedPins(c, ANALYZER_PIN_DX, analyzerPinDys(order.length), rotation, mirrorX, mirrorY);
      break;
    }
    case 'busprobe': {
      const order = c.pinOrder?.length ? c.pinOrder : Object.keys(c.pins);
      if (!c.pinOrder?.length) c.pinOrder = order;
      applyStackedPins(c, ANALYZER_PIN_DX, analyzerPinDys(order.length), rotation, mirrorX, mirrorY);
      break;
    }
    case 'busswitch': {
      const order = c.pinOrder?.length ? c.pinOrder : Object.keys(c.pins);
      if (!c.pinOrder?.length) c.pinOrder = order;
      // Outputs on the right (outside package), same side for every bit including ends.
      applyStackedPins(c, BUS_SWITCH_PIN_DX, analyzerPinDys(order.length), rotation, mirrorX, mirrorY);
      break;
    }
    case 'buspass': {
      const dys = analyzerPinDys(c.bitWidth);
      for (let i = 0; i < c.bitWidth; i++) {
        const a = c.pins[`a${i}`];
        const b = c.pins[`b${i}`];
        const dy = dys[i] ?? 0;
        if (a) setPin(a, cx, cy, -BUS_PASS_PIN_DX, dy, rotation, mirrorX, mirrorY);
        if (b) setPin(b, cx, cy, BUS_PASS_PIN_DX, dy, rotation, mirrorX, mirrorY);
      }
      break;
    }
    default:
      break;
  }
}

/** Refresh one chip instance's pinSide/layout from its ChipDef (keeps wires). */
export function syncPinSidesFromDef(c: ChipInstanceComponent, def: ChipDef): void {
  c.pinSide = { ...pinSidesFromDef(def) };
  applyPinLayout(c);
}

/** Recompute pinSide + pin positions for every instance of `def` in `circuits`. */
export function relayoutDefInstances(def: ChipDef, circuits: Circuit[]): void {
  for (const circuit of circuits) {
    for (const c of circuit.components.values()) {
      if (c.kind !== 'chip' || c.defId !== def.id) continue;
      syncPinSidesFromDef(c, def);
    }
  }
}

/**
 * Point on an axis-aligned body edge closest to `target` (for stub drawing).
 * Uses nearest-side distance — not a center→target ray — so tall chips with
 * left/right pin stacks get short horizontal leads instead of a fan toward
 * the vertical mid-edge.
 */
export function bodyEdgeToward(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  target: Point,
): Point {
  const distL = Math.abs(cx - halfW - target.x);
  const distR = Math.abs(cx + halfW - target.x);
  const distT = Math.abs(cy - halfH - target.y);
  const distB = Math.abs(cy + halfH - target.y);
  const minH = Math.min(distL, distR);
  const minV = Math.min(distT, distB);
  if (minH <= minV) {
    return {
      x: distL <= distR ? cx - halfW : cx + halfW,
      y: Math.max(cy - halfH, Math.min(cy + halfH, target.y)),
    };
  }
  return {
    x: Math.max(cx - halfW, Math.min(cx + halfW, target.x)),
    y: distT <= distB ? cy - halfH : cy + halfH,
  };
}

/** Selection AABB center (component centers). */
export function selectionCenter(comps: Component[]): Point {
  let sx = 0;
  let sy = 0;
  for (const c of comps) {
    sx += c.pos.x;
    sy += c.pos.y;
  }
  const n = Math.max(comps.length, 1);
  return { x: sx / n, y: sy / n };
}

/**
 * Rotate or flip several components around their shared center, then each
 * component's own orientation. Single-item selections keep their position.
 */
export function orientSelection(
  comps: Component[],
  mode: 'cw' | 'ccw' | 'flipH' | 'flipV',
  move: (c: Component, dx: number, dy: number) => void,
): void {
  if (comps.length === 0) return;
  const center = selectionCenter(comps);
  const multi = comps.length > 1;

  for (const c of comps) {
    if (!isOrientable(c)) continue;
    const { rotation, mirrorX, mirrorY } = getOrientation(c);
    if (multi) {
      const dx = c.pos.x - center.x;
      const dy = c.pos.y - center.y;
      let nx = dx;
      let ny = dy;
      if (mode === 'cw') {
        const t = transformOffset(dx, dy, 90, false, false);
        nx = t.x;
        ny = t.y;
      } else if (mode === 'ccw') {
        const t = transformOffset(dx, dy, 270, false, false);
        nx = t.x;
        ny = t.y;
      } else if (mode === 'flipH') {
        nx = -dx;
      } else {
        ny = -dy;
      }
      move(c, center.x + nx - c.pos.x, center.y + ny - c.pos.y);
    }
    if (mode === 'cw') setOrientation(c, rotateCw(rotation), mirrorX, mirrorY);
    else if (mode === 'ccw') setOrientation(c, rotateCcw(rotation), mirrorX, mirrorY);
    else if (mode === 'flipH') setOrientation(c, rotation, !mirrorX, mirrorY);
    else setOrientation(c, rotation, mirrorX, !mirrorY);
  }
}


export type BodyEdge = 'left' | 'right' | 'top' | 'bottom';

/** Body box of a chip as drawn: width and height swap when it is turned a quarter. */
export function chipBoxSize(c: ChipInstanceComponent): { w: number; h: number } {
  const w = chipBodyWidth(c);
  const h = chipBoxHeight(c);
  return c.rotation === 90 || c.rotation === 270 ? { w: h, h: w } : { w, h };
}

/** The body edge a chip pin sits on after flip and rotation. */
export function chipPinEdge(c: ChipInstanceComponent, pinName: string): BodyEdge {
  let left = c.pinSide?.[pinName] !== 1;
  if (c.mirrorX) left = !left;
  switch (c.rotation) {
    case 90:
      return left ? 'top' : 'bottom';
    case 180:
      return left ? 'right' : 'left';
    case 270:
      return left ? 'bottom' : 'top';
    default:
      return left ? 'left' : 'right';
  }
}
