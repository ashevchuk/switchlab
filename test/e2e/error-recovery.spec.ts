/**
 * A thrown error reaches the user as a toast, and the editor keeps running afterwards.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

type SimTest = {
  camera: { centerOn(p: { x: number; y: number }, z: number): void };
  editor: { circuit: { components: Map<string, unknown> }; selectedIds: Set<string> };
};

async function open(page: Page): Promise<void> {
  await page.goto(`file://${indexHtml}#e=lab-counter-7seg`);
  await expect(page.locator('#menubar')).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter'); // confirm the replace-circuit prompt
  await page.waitForTimeout(2000);
}

const canvasPixels = (page: Page) =>
  page.evaluate(() => (document.getElementById('canvas') as HTMLCanvasElement).toDataURL());

test.describe('error reporting', () => {
  test('an uncaught script error becomes a toast with advice, and can be dismissed', async ({ page }) => {
    await open(page);
    await page.evaluate(() => setTimeout(() => { throw new Error('boom from a timer'); }));
    const toast = page.locator('.app-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('boom from a timer');
    await expect(toast).toContainText('autosaved');
    await toast.locator('.app-toast-close').click();
    await expect(toast).toHaveCount(0);
  });

  test('the ResizeObserver notice is not an error, a real one right after it still is', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
      setTimeout(() => { throw new Error('a real problem'); });
    });
    const toast = page.locator('.app-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('a real problem');
  });

  test('the same error twice is one toast with a counter', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('repeated'); });
      setTimeout(() => { throw new Error('repeated'); });
    });
    await expect(page.locator('.app-toast')).toHaveCount(1);
    await expect(page.locator('.app-toast-count')).toHaveText('×2');
  });

  test('an error inside a frame is reported and the frame loop survives', async ({ page }) => {
    await open(page);
    // syncInspector() runs every frame and reads the selected components.
    await page.evaluate(() => {
      const { editor } = (window as unknown as { __simTest: SimTest }).__simTest;
      editor.selectedIds = new Set(['anything']);
      (editor.circuit.components as { get: unknown }).get = () => { throw new Error('frame boom'); };
    });
    await expect(page.locator('.app-toast')).toContainText('frame boom');
    await expect(page.locator('.app-toast')).toContainText('The editor hit an error');

    await page.evaluate(() => {
      const { editor } = (window as unknown as { __simTest: SimTest }).__simTest;
      delete (editor.circuit.components as { get?: unknown }).get;
      editor.selectedIds = new Set();
    });
    const before = await canvasPixels(page);
    await page.evaluate(() => {
      (window as unknown as { __simTest: SimTest }).__simTest.camera.centerOn({ x: 900, y: 600 }, 0.7);
    });
    await page.waitForTimeout(600);
    expect(await canvasPixels(page)).not.toBe(before);
  });
});
