/**
 * Drives wire editing with real mouse input in the file:// build.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

interface Pt {
  x: number;
  y: number;
}

async function open(page: Page, example: string): Promise<void> {
  await page.goto(`file://${indexHtml}#e=${example}`);
  await expect(page.locator('#canvas')).toBeVisible();
  // The default session is not empty, so loading an example asks before replacing it.
  await page.locator('.z80-dialog-overlay button.z80-dialog-primary').click();
  await page.waitForFunction(
    () => location.hash === '',
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(800);
}

/** Wires whose stored path has an interior leg, with that leg's midpoint in screen space. */
async function interiorLegs(page: Page): Promise<Array<{ wireId: string; mid: Pt; vertical: boolean }>> {
  return page.evaluate(() => {
    const t = (window as unknown as {
      __simTest: {
        editor: {
          circuit: {
            wires: Map<string, { id: string; a: string; b: string; waypoints?: Pt[] }>;
            allPins(): Array<{ id: string; pos: Pt }>;
          };
        };
        camera: { worldToScreen(p: Pt, w: number, h: number): Pt };
      };
    }).__simTest;
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const pins = new Map(t.editor.circuit.allPins().map((p) => [p.id, p.pos]));
    const out: Array<{ wireId: string; mid: Pt; vertical: boolean }> = [];
    for (const w of t.editor.circuit.wires.values()) {
      const a = pins.get(w.a);
      const b = pins.get(w.b);
      if (!a || !b || !w.waypoints || w.waypoints.length < 2) continue;
      const path = [a, ...w.waypoints, b];
      for (let i = 1; i < path.length - 2; i++) {
        const p = path[i]!;
        const q = path[i + 1]!;
        if (Math.hypot(p.x - q.x, p.y - q.y) < 30) continue;
        const mid = t.camera.worldToScreen({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, rect.width, rect.height);
        out.push({
          wireId: w.id,
          mid: { x: rect.left + mid.x, y: rect.top + mid.y },
          vertical: Math.abs(p.x - q.x) < 0.5,
        });
      }
    }
    return out;
  });
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const t = (window as unknown as {
      __simTest: {
        editor: {
          circuit: {
            components: Map<string, { id: string; pos: Pt }>;
            wires: Map<string, { id: string; waypoints?: Pt[]; manual?: boolean }>;
            allPins(): Array<{ id: string; pos: Pt }>;
          };
        };
      };
    }).__simTest;
    const c = t.editor.circuit;
    return {
      components: Object.fromEntries([...c.components.values()].map((x) => [x.id, { ...x.pos }])),
      wires: Object.fromEntries([...c.wires.values()].map((w) => [w.id, { waypoints: w.waypoints?.map((p) => ({ ...p })), manual: w.manual }])),
    };
  });
}

function isOrthogonalPath(points: Pt[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) return false;
  }
  return true;
}

/** Wires can lie on top of each other; the click decides which one is selected. */
async function selectedWireId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const t = (window as unknown as { __simTest: { editor: { selectedWireId: string | null } } }).__simTest;
    return t.editor.selectedWireId ?? '';
  });
}

async function wirePath(page: Page, wireId: string): Promise<Pt[]> {
  return page.evaluate((id) => {
    const t = (window as unknown as {
      __simTest: {
        editor: {
          circuit: {
            wires: Map<string, { a: string; b: string; waypoints?: Pt[] }>;
            allPins(): Array<{ id: string; pos: Pt }>;
          };
        };
      };
    }).__simTest;
    const w = t.editor.circuit.wires.get(id)!;
    const pins = new Map(t.editor.circuit.allPins().map((p) => [p.id, p.pos]));
    return [pins.get(w.a)!, ...(w.waypoints ?? []), pins.get(w.b)!];
  }, wireId);
}

test.describe('wire editing with the mouse', () => {
  test('dragging a selected wire leg reshapes the wire and moves no component', async ({ page }) => {
    await open(page, 'lab-mini-cpu');
    expect((await interiorLegs(page)).length).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      // Earlier drags move wires, so look the legs up again every time.
      const legs = await interiorLegs(page);
      const leg = legs[(i * 3) % legs.length]!;
      const before = await snapshot(page);
      // First click selects the wire, then drag it sideways.
      await page.mouse.click(leg.mid.x, leg.mid.y);
      const wireId = await selectedWireId(page);
      expect(wireId, `no wire selected at the middle of ${leg.wireId}`).not.toBe('');
      const dx = leg.vertical ? 40 : 0;
      const dy = leg.vertical ? 0 : 40;
      await page.mouse.move(leg.mid.x, leg.mid.y);
      await page.mouse.down();
      await page.mouse.move(leg.mid.x + dx / 2, leg.mid.y + dy / 2, { steps: 4 });
      await page.mouse.move(leg.mid.x + dx, leg.mid.y + dy, { steps: 4 });
      await page.mouse.up();
      const after = await snapshot(page);
      expect(after.components, `components moved while dragging ${wireId}`).toEqual(before.components);
      expect(after.wires[wireId]!.manual).toBe(true);
      expect(isOrthogonalPath(await wirePath(page, wireId))).toBe(true);
    }
  });

  test('Escape during a drag puts the wire back', async ({ page }) => {
    await open(page, 'lab-mini-cpu');
    const [leg] = await interiorLegs(page);
    expect(leg).toBeDefined();
    const before = await snapshot(page);
    await page.mouse.click(leg!.mid.x, leg!.mid.y);
    const wireId = await selectedWireId(page);
    expect(wireId).not.toBe('');
    await page.mouse.move(leg!.mid.x, leg!.mid.y);
    await page.mouse.down();
    await page.mouse.move(leg!.mid.x + (leg!.vertical ? 50 : 0), leg!.mid.y + (leg!.vertical ? 0 : 50), { steps: 6 });
    const during = await snapshot(page);
    expect(during.wires[wireId]).not.toEqual(before.wires[wireId]);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const after = await snapshot(page);
    expect(after.wires[wireId]).toEqual(before.wires[wireId]);
    expect(after.components).toEqual(before.components);
  });

  test('the cursor says which way a wire leg slides', async ({ page }) => {
    await open(page, 'lab-mini-cpu');
    const legs = await interiorLegs(page);
    expect(legs.length).toBeGreaterThan(0);
    const probe = async (pt: Pt) => {
      await page.mouse.move(pt.x + 40, pt.y + 40);
      await page.mouse.move(pt.x, pt.y);
      return page.evaluate(() => {
        const t = (window as unknown as { __simTest: { editor: { wireGrip: { wireId: string; kind: string } | null } } }).__simTest;
        return { cursor: (document.getElementById('canvas') as HTMLCanvasElement).style.cursor, grip: t.editor.wireGrip };
      });
    };
    const seen = new Set<string>();
    for (const leg of legs) {
      const { cursor, grip } = await probe(leg.mid);
      // Where wires cross, the pointer may be over another wire's leg; only judge our own.
      if (grip?.wireId !== leg.wireId || grip.kind !== 'segment') continue;
      expect(cursor, `wire ${leg.wireId} vertical=${leg.vertical}`).toBe(leg.vertical ? 'ew-resize' : 'ns-resize');
      seen.add(cursor);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
