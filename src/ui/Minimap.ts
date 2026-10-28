/**
 * Overview minimap — world bounds + current viewport, click/drag to pan.
 */

import type { Camera } from './Camera.js';
import type { Circuit } from '../sim/Circuit.js';
import { componentRadius } from './Renderer.js';

const CSS = `
  #minimap {
    position: absolute;
    right: 12px;
    bottom: 48px;
    width: 160px;
    height: 110px;
    z-index: 15;
    border: 1px solid #303646;
    border-radius: 8px;
    background: rgba(18, 20, 26, 0.92);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    overflow: hidden;
    cursor: crosshair;
  }
  #minimap canvas { display: block; width: 100%; height: 100%; }
  #minimap[hidden] { display: none !important; }
`;

export class Minimap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private drag = false;

  constructor(
    private getCircuit: () => Circuit,
    private getCamera: () => Camera,
    private getViewSize: () => { w: number; h: number },
    private onPan: () => void,
  ) {
    if (!document.getElementById('minimap-style')) {
      const style = document.createElement('style');
      style.id = 'minimap-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement('div');
    this.root.id = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = 160;
    this.canvas.height = 110;
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.root.addEventListener('pointerdown', (ev) => {
      this.drag = true;
      this.root.setPointerCapture(ev.pointerId);
      this.panTo(ev);
    });
    this.root.addEventListener('pointermove', (ev) => {
      if (this.drag) this.panTo(ev);
    });
    this.root.addEventListener('pointerup', () => {
      this.drag = false;
    });
  }

  setVisible(show: boolean): void {
    this.root.hidden = !show;
  }

  private worldBounds(circuit: Circuit): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of circuit.components.values()) {
      const { rx, ry } = componentRadius(c);
      minX = Math.min(minX, c.pos.x - rx);
      minY = Math.min(minY, c.pos.y - ry);
      maxX = Math.max(maxX, c.pos.x + rx);
      maxY = Math.max(maxY, c.pos.y + ry);
    }
    if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    const pad = 40;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  private panTo(ev: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const u = (ev.clientX - rect.left) / rect.width;
    const v = (ev.clientY - rect.top) / rect.height;
    const circuit = this.getCircuit();
    const cam = this.getCamera();
    const { w, h } = this.getViewSize();
    const b = this.worldBounds(circuit);
    const worldX = b.minX + u * (b.maxX - b.minX);
    const worldY = b.minY + v * (b.maxY - b.minY);
    // Center camera on clicked world point.
    cam.x = worldX;
    cam.y = worldY;
    this.onPan();
  }

  draw(): void {
    if (this.root.hidden) return;
    const circuit = this.getCircuit();
    const cam = this.getCamera();
    const { w, h } = this.getViewSize();
    const b = this.worldBounds(circuit);
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#12141a';
    ctx.fillRect(0, 0, cw, ch);

    const sx = cw / bw;
    const sy = ch / bh;
    const s = Math.min(sx, sy);
    const ox = (cw - bw * s) / 2;
    const oy = (ch - bh * s) / 2;
    const toX = (x: number) => ox + (x - b.minX) * s;
    const toY = (y: number) => oy + (y - b.minY) * s;

    ctx.fillStyle = '#3a4254';
    for (const c of circuit.components.values()) {
      ctx.fillRect(toX(c.pos.x) - 1.5, toY(c.pos.y) - 1.5, 3, 3);
    }
    ctx.strokeStyle = '#5b6272';
    ctx.lineWidth = 1;
    for (const wire of circuit.wires.values()) {
      const a = circuit.findPin(wire.a);
      const bp = circuit.findPin(wire.b);
      if (!a || !bp) continue;
      ctx.beginPath();
      ctx.moveTo(toX(a.pos.x), toY(a.pos.y));
      ctx.lineTo(toX(bp.pos.x), toY(bp.pos.y));
      ctx.stroke();
    }

    // Viewport rectangle in world space.
    const tl = cam.screenToWorld({ x: 0, y: 0 }, w, h);
    const br = cam.screenToWorld({ x: w, y: h }, w, h);
    ctx.strokeStyle = '#f5c518';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(toX(tl.x), toY(tl.y), toX(br.x) - toX(tl.x), toY(br.y) - toY(tl.y));
  }
}
