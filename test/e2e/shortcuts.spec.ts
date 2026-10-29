/**
 * Editor shortcuts follow the physical key, so they work on a Cyrillic layout, and
 * Edit → Undo / Redo reach the same history.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

type SimTest = { editor: { circuit: { components: Map<string, { id: string; kind: string; rotation?: number }> }; selectedIds: Set<string> } };

async function openWithSelectedChip(page: Page): Promise<string> {
  await page.goto(`file://${indexHtml}#e=lab-counter-7seg`);
  await expect(page.locator('#menubar')).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter'); // confirm the replace-circuit prompt
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const { editor } = (window as unknown as { __simTest: SimTest }).__simTest;
    const chip = [...editor.circuit.components.values()].find((c) => c.kind === 'chip' && 'q0' in (c as unknown as { pins: object }).pins);
    if (!chip) throw new Error('no chip in the example');
    editor.selectedIds = new Set([chip.id]);
    return chip.id;
  });
}

const rotationOf = (page: Page, id: string) =>
  page.evaluate((i) => {
    const { editor } = (window as unknown as { __simTest: SimTest }).__simTest;
    return editor.circuit.components.get(i)?.rotation ?? 0;
  }, id);

const press = (page: Page, init: KeyboardEventInit) =>
  page.evaluate((i) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);

test.describe('shortcuts', () => {
  test('R and Ctrl+Z work on a Ukrainian layout', async ({ page }) => {
    const id = await openWithSelectedChip(page);
    expect(await rotationOf(page, id)).toBe(0);
    await press(page, { key: 'к', code: 'KeyR' });
    expect(await rotationOf(page, id)).toBe(90);
    await press(page, { key: 'я', code: 'KeyZ', ctrlKey: true });
    expect(await rotationOf(page, id)).toBe(0);
  });

  test('Edit → Undo and Redo revert and reapply a rotation', async ({ page }) => {
    const id = await openWithSelectedChip(page);
    await press(page, { key: 'r', code: 'KeyR' });
    expect(await rotationOf(page, id)).toBe(90);
    await page.evaluate(() => (document.getElementById('undo') as HTMLButtonElement).click());
    expect(await rotationOf(page, id)).toBe(0);
    await page.evaluate(() => (document.getElementById('redo') as HTMLButtonElement).click());
    expect(await rotationOf(page, id)).toBe(90);
  });
});
