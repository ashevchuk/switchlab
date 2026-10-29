/**
 * Follow PC in the memory window while the Z80 runs on gates.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

test('Follow PC tracks the gate-level Z80 at Gates turbo', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`file://${indexHtml}`);
  await expect(page.locator('#menubar')).toBeVisible();
  await page.evaluate(() => document.getElementById('add-z80cpu')!.click());
  for (let prompt = 0; prompt < 2; prompt++) {
    await page.waitForTimeout(450);
    await page.keyboard.press('Enter'); // RAM address bits, then the program prompt: keep the defaults
  }
  await expect(page.locator('.machine-panel select[data-act="speed"]')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(6000);
  await page.selectOption('.machine-panel select[data-act="speed"]', 'turbo');

  await page.evaluate(() => {
    const { editor, camera } = (window as unknown as {
      __simTest: {
        editor: { circuit: { components: Map<string, { kind: string; pos: { x: number; y: number } }> } };
        camera: { centerOn(p: { x: number; y: number }, z: number): void; worldToScreen(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } };
      };
    }).__simTest;
    const ram = [...editor.circuit.components.values()].filter((c) => c.kind === 'ram').at(-1)!;
    camera.centerOn({ x: ram.pos.x - 300, y: ram.pos.y }, 1);
    const canvas = document.getElementById('canvas')!;
    const r = canvas.getBoundingClientRect();
    const at = camera.worldToScreen(ram.pos, r.width, r.height);
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + at.x, clientY: r.top + at.y, bubbles: true }));
  });
  await page.locator('input[name="follow-pc"]').check();

  await expect(page.locator('.memory-disasm .is-pc')).toBeVisible({ timeout: 30_000 });
  const pcRow = await page.locator('.memory-disasm .is-pc').innerText();
  expect(pcRow).toMatch(/^[0-9a-f]{4}\s+[0-9a-f]{2}/);
});
