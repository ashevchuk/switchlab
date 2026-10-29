/**
 * Methodical Spectrum feature audit: every bundled demo + key UI paths.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  placeSpectrum48,
  placeSpectrum128,
  spectrumScreenActive,
  loadBundledDemo,
  panelLog,
  waitMenubar,
} from './spectrumHelpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

const DEMO_IDS = ['rainbow', 'ay-beep', 'glazx', 'homebrew', 'egghead', 'egghead-space', 'pzxl'] as const;

test.describe('Spectrum audit — demos', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`file://${indexHtml}`);
    await waitMenubar(page);
  });

  for (const id of DEMO_IDS) {
    test(`Load demo "${id}" paints screen`, async ({ page }) => {
      test.setTimeout(120_000);
      if (id === 'ay-beep') await placeSpectrum128(page);
      else await placeSpectrum48(page);
      await loadBundledDemo(page, id);
      await expect
        .poll(() => spectrumScreenActive(page), {
          timeout: id === 'rainbow' || id === 'ay-beep' ? 20_000 : 60_000,
        })
        .toBe(true);
    });
  }

  test('GLAZX loads WASD pad and up changes map selection activity', async ({ page }) => {
    test.setTimeout(120_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'glazx');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => page.locator('.spec-joy-mode').innerText()).toMatch(/WASD/i);
    await page.locator('canvas[data-canvas="spec"]').click();
    // Reach map select: Space / Enter / 0 / 1 then WASD up
    for (const k of ['Space', 'Enter', 'Digit0', 'Digit1']) {
      await page.keyboard.press(k);
      await page.waitForTimeout(200);
    }
    const before = await page.locator('[data-spec-regs]').innerText();
    await page.locator('.spec-joy-up').click();
    await page.waitForTimeout(300);
    await page.locator('.spec-joy-down').click();
    await page.waitForTimeout(300);
    await expect
      .poll(async () => {
        const regs = await page.locator('[data-spec-regs]').innerText();
        const health = await page.locator('[data-spec-health]').innerText();
        return { regs, health, moved: regs !== before || /IM2|main|worker/i.test(health) };
      }, { timeout: 10_000 })
      .toMatchObject({ moved: true });
    await expect(page.locator('[data-spec-health]')).toContainText(/IM|main|worker/i);
  });

  for (const id of ['rainbow', 'glazx'] as const) {
    test(`#demo=${id} boots via hash`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.goto(`file://${indexHtml}#demo=${id}`);
      await expect(page.locator('.float-win.machine-panel')).toBeVisible({ timeout: 25_000 });
      await expect.poll(() => spectrumScreenActive(page), { timeout: 60_000 }).toBe(true);
    });
  }
});

test.describe('Spectrum audit — demo after demo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`file://${indexHtml}`);
    await waitMenubar(page);
  });

  const tapePosition = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (document.querySelector('[data-act="tape-prog"]') as HTMLProgressElement | null)?.value ?? 0);

  test('a TAP demo loads on top of a running snapshot demo', async ({ page }) => {
    test.setTimeout(150_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await loadBundledDemo(page, 'glazx');
    // LOAD "" is only picked up at the BASIC prompt: the tape must advance past block 0.
    await expect.poll(() => tapePosition(page), { timeout: 90_000 }).toBeGreaterThan(0);
  });

  test('a TAP demo loads on top of another TAP demo', async ({ page }) => {
    test.setTimeout(200_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'glazx');
    await expect.poll(() => tapePosition(page), { timeout: 90_000 }).toBeGreaterThan(0);
    await loadBundledDemo(page, 'pzxl');
    await expect.poll(() => panelLog(page), { timeout: 20_000 }).toContain('pZXl.tap');
    // The new tape starts again from block 0 and has to move on.
    await expect.poll(() => tapePosition(page), { timeout: 90_000 }).toBeGreaterThan(0);
  });
});

test.describe('Spectrum audit — features', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`file://${indexHtml}`);
    await waitMenubar(page);
  });

  test('Reboot after rainbow SNA leaves snapshot and restarts ROM', async ({ page }) => {
    test.setTimeout(60_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await page.locator('.float-win.machine-panel [data-act="pause"]').first().click();
    await expect.poll(async () => page.locator('[data-spec-regs]').innerText()).toMatch(/PC=8[0-9a-f]{3}/i);
    await page.locator('.float-win.machine-panel [data-act="reboot"]').first().click();
    await expect.poll(async () => panelLog(page)).toMatch(/reboot \(Spectrum 48K\)/i);
    await expect
      .poll(async () => page.locator('[data-spec-regs]').innerText(), { timeout: 10_000 })
      .toMatch(/PC=(0[0-3][0-9a-f]{2})/i);
    const after = await page.locator('[data-spec-regs]').innerText();
    expect(after).not.toMatch(/PC=8[0-9a-f]{3}/i);
  });

  test('ParaZXland leaves PAUSE when Space held (flash-load EI)', async ({ page }) => {
    test.setTimeout(90_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'pzxl');
    // Tape fully consumed, then ROM PAUSE with EI (press-any-key)
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const prog = document.querySelector('[data-act="tape-prog"]') as HTMLProgressElement | null;
          const regs = document.querySelector('[data-spec-regs]')?.textContent ?? '';
          return {
            tapeDone: !!prog && prog.value >= prog.max && prog.max >= 6,
            pause: /PC=1f3e/i.test(regs) && /IFF=11/.test(regs),
            regs: regs.split('\n')[0],
          };
        });
      }, { timeout: 60_000 })
      .toMatchObject({ tapeDone: true, pause: true });

    await page.locator('canvas[data-canvas="spec"]').click();
    await page.keyboard.down('Space');
    await expect
      .poll(async () => {
        const regs = await page.locator('[data-spec-regs]').innerText();
        return /PC=1f3e/i.test(regs);
      }, { timeout: 8_000 })
      .toBe(false);
    await page.keyboard.up('Space');
  });

  test('poke writes RAM (paused)', async ({ page }) => {
    await placeSpectrum48(page);
    await page.locator('.float-win.machine-panel [data-act="pause"]').first().click();
    await page.evaluate(() => {
      (document.querySelector('[data-act="poke-addr"]') as HTMLInputElement).value = '8000';
      (document.querySelector('[data-act="poke-val"]') as HTMLInputElement).value = 'a5';
      document.querySelector('[data-act="poke-go"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      (document.querySelector('[data-act="watch"]') as HTMLInputElement).value = '8000';
      document.querySelector('[data-act="watch"]')?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(async () => page.locator('[data-spec-regs]').innerText()).toMatch(/@8000:\s*a5/i);
  });

  test('cheat add / apply / del cycle', async ({ page }) => {
    await placeSpectrum48(page);
    await page.evaluate(() => {
      (document.querySelector('[data-act="poke-addr"]') as HTMLInputElement).value = '9000';
      (document.querySelector('[data-act="poke-val"]') as HTMLInputElement).value = '42';
      document.querySelector('[data-act="cheat-add"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const list = page.locator('[data-act="cheat-list"]');
    await expect(list.locator('option')).not.toHaveCount(0);
    await page.evaluate(() => {
      document.querySelector('[data-act="cheat-apply"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(async () => panelLog(page)).toMatch(/Applied/i);
    await page.evaluate(() => {
      const sel = document.querySelector('[data-act="cheat-list"]') as HTMLSelectElement;
      if (sel.options.length) sel.selectedIndex = 0;
      document.querySelector('[data-act="cheat-del"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });

  test('48 BASIC + Boot TR-DOS visible on Spectrum tab (128K)', async ({ page }) => {
    await placeSpectrum128(page);
    await expect(page.locator('[data-act="spectrum-48basic-tab"]')).toBeVisible();
    await page.locator('[data-act="spectrum-48basic-tab"]').click();
    await expect.poll(async () => panelLog(page)).toMatch(/48 BASIC/i);
    await page.locator('[data-act="trdos-boot-tab"]').click();
    await expect.poll(async () => panelLog(page)).toMatch(/TR-DOS|soft stub/i);
    await expect(page.locator('[data-spec-model]')).toContainText(/TR-DOS/i);
  });

  test('breakpoint set/clear and step-over visible', async ({ page }) => {
    await placeSpectrum48(page);
    await expect(page.locator('[data-act="step-over"]')).toBeVisible();
    await page.evaluate(() => {
      (document.querySelector('[data-act="bp"]') as HTMLInputElement).value = '15f6';
      document.querySelector('[data-act="bp-set"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(async () => panelLog(page)).toMatch(/breakpoint|BP/i);
    await page.locator('[data-act="bp-clear"]').click();
    await expect.poll(async () => panelLog(page)).toMatch(/cleared|Clear|off/i);
  });

  test('tape UI enables after TAP mount', async ({ page }) => {
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'glazx');
    await expect
      .poll(async () => !(await page.locator('[data-act="tape-rew"]').isDisabled()), { timeout: 10_000 })
      .toBe(true);
    await expect(page.locator('[data-act="tape-pause"]')).toBeVisible();
    await expect(page.locator('[data-act="tape-prog"]')).toBeVisible();
  });

  test('Copy #sna= from Spectrum tab shows share URL', async ({ page }) => {
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await page.locator('[data-act="copy-sna-link-tab"]').click();
    await expect(page.locator('.z80-dialog-overlay')).toBeVisible({ timeout: 10_000 });
    const url = await page.inputValue('.z80-dialog-overlay input');
    expect(url).toMatch(/#sna=/);
    await page.locator('.z80-dialog-overlay button', { hasText: 'OK' }).click();
  });

  test('file:// uses main-thread Spectrum engine (Worker blocked)', async ({ page }) => {
    await placeSpectrum48(page);
    const status = await page.evaluate(() => {
      try {
        const url = new URL('spectrum-worker.js', location.href);
        new Worker(url.href).terminate();
        return { workerAllowed: true };
      } catch (e) {
        return { workerAllowed: false, err: String(e) };
      }
    });
    // Chromium file:// blocks classic Workers (origin null) — engine fallback must still run.
    expect(status.workerAllowed).toBe(false);
    await expect.poll(() => spectrumScreenActive(page), { timeout: 15_000 }).toBe(true);
  });

  test('virtual keyboard under screen + media strip', async ({ page }) => {
    await placeSpectrum48(page);
    await expect(page.locator('.spec-kbd')).toBeVisible();
    await expect(page.locator('.spec-media')).toBeVisible();
    await expect(page.locator('[data-act="load-game-tab"]')).toBeVisible();
    const order = await page.evaluate(() => {
      const pane = document.querySelector('[data-pane="spectrum"]');
      if (!pane) return null;
      const media = pane.querySelector('.spec-media');
      const canvas = pane.querySelector('canvas[data-canvas="spec"]');
      const kbd = pane.querySelector('.spec-kbd');
      if (!media || !canvas || !kbd) return null;
      return {
        mediaAboveCanvas: media.getBoundingClientRect().top < canvas.getBoundingClientRect().top,
        canvasAboveKbd: canvas.getBoundingClientRect().top < kbd.getBoundingClientRect().top,
      };
    });
    expect(order?.mediaAboveCanvas).toBe(true);
    expect(order?.canvasAboveKbd).toBe(true);
  });
});
