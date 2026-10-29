/**
 * http(s) Spectrum e2e — exercises real Worker (blocked on file://).
 * Serves dist-file/ over localhost for the duration of this file.
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  placeSpectrum48,
  placeSpectrum128,
  loadBundledDemo,
  spectrumScreenActive,
  waitMenubar,
  panelLog,
} from './spectrumHelpers.js';
import { buildMinimalTrd } from '../../src/machine/spectrum/expansions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist-file');

function contentType(p: string): string {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] || '/');
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(file) });
      res.end(data);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

test.describe('Spectrum Worker (http)', () => {
  let base = '';
  let close: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      throw new Error('dist-file missing — run npm run build:dist-file');
    }
    const s = await startServer();
    base = s.base;
    close = s.close;
  });

  test.afterAll(async () => {
    await close?.();
  });

  test('Place Spectrum uses Worker and rainbow paints', async ({ page }) => {
    test.setTimeout(60_000);
    const workers: string[] = [];
    page.on('worker', (w) => workers.push(w.url()));
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum48(page);
    await expect.poll(() => workers.some((u) => u.includes('spectrum-worker')), { timeout: 5_000 }).toBe(true);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
  });

  test('TAP auto-LOAD types LOAD "" once while the RAM window follows the PC', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum48(page);
    // The memory window's per-frame refresh slows requestAnimationFrame; the emulation keeps its own clock.
    await page.evaluate(() => {
      const { editor, camera } = (window as unknown as {
        __simTest: {
          editor: { circuit: { components: Map<string, { kind: string; pos: { x: number; y: number } }> } };
          camera: { centerOn(p: { x: number; y: number }, z: number): void; worldToScreen(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } };
        };
      }).__simTest;
      const ram = [...editor.circuit.components.values()].find((c) => c.kind === 'ram')!;
      camera.centerOn({ x: ram.pos.x - 300, y: ram.pos.y }, 1);
      const canvas = document.getElementById('canvas')!;
      const r = canvas.getBoundingClientRect();
      const at = camera.worldToScreen(ram.pos, r.width, r.height);
      canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + at.x, clientY: r.top + at.y, bubbles: true }));
    });
    const follow = page.locator('input[name="follow-pc"]');
    await expect(follow).toBeVisible();
    await follow.check();
    await loadBundledDemo(page, 'glazx');
    await expect.poll(() => panelLog(page), { timeout: 30_000 }).toContain('Typing LOAD ""');
    await expect
      .poll(async () => page.evaluate(() => Number((document.querySelector('[data-act="tape-prog"]') as HTMLProgressElement | null)?.value ?? 0)), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    expect(await panelLog(page)).not.toContain('retrying');
  });

  test('a hung Worker is replaced, the user is told, and the new Spectrum runs', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);

    const hung = page.workers().find((w) => w.url().includes('spectrum-worker'))!;
    void hung.evaluate(() => { for (;;); }).catch(() => undefined); // never returns: the Worker thread is stuck

    const toast = page.locator('.app-toast', { hasText: 'Spectrum emulator restarted' });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText('lost');
    await expect
      .poll(() => page.workers().filter((w) => w.url().includes('spectrum-worker') && w !== hung).length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    // The replacement is a cold boot: the BASIC screen is painted and the machine is running again.
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await expect(page.locator('.machine-panel-status')).toContainText('run');
  });

  test('tape rewind posts and Worker stays alive after TAP demo', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'glazx');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 60_000 }).toBe(true);
    await page.locator('[data-act="tape-rew"]').click();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const prog = document.querySelector('[data-act="tape-prog"]') as HTMLProgressElement | null;
          return prog ? Number(prog.value) : -1;
        });
      }, { timeout: 5_000 })
      .toBe(0);
  });

  test('SNA round-trip save then reload keeps screen', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await page.locator('.float-win.machine-panel [data-act="pause"]').first().click();
    await expect.poll(async () => page.locator('[data-spec-regs]').innerText()).toMatch(/PC=8/i);
    const beforePc = (await page.locator('[data-spec-regs]').innerText()).match(/PC=([0-9a-f]+)/i)?.[1];
    await page.locator('[data-tab="console"]').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-act="save-sna"]').click(),
    ]);
    const tmp = await download.path();
    expect(tmp).toBeTruthy();
    const buf = fs.readFileSync(tmp!);
    expect(buf.length).toBeGreaterThan(40_000);
    await page.locator('[data-tab="spectrum"]').click();
    await page.locator('[data-act="reboot"]').first().click();
    await expect.poll(async () => panelLog(page)).toMatch(/reboot/i);
    await page.setInputFiles('input[data-file="sna"]', {
      name: 'roundtrip.sna',
      mimeType: 'application/octet-stream',
      buffer: buf,
    });
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await page.locator('.float-win.machine-panel [data-act="pause"]').first().click();
    await expect
      .poll(async () => {
        const regs = await page.locator('[data-spec-regs]').innerText();
        return regs.match(/PC=([0-9a-f]+)/i)?.[1];
      }, { timeout: 5_000 })
      .toBe(beforePc);
  });

  test('Z80 round-trip save/load keeps PC', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await page.locator('.float-win.machine-panel [data-act="pause"]').first().click();
    await expect.poll(async () => page.locator('[data-spec-regs]').innerText()).toMatch(/PC=8/i);
    const beforePc = (await page.locator('[data-spec-regs]').innerText()).match(/PC=([0-9a-f]+)/i)?.[1];
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-act="save-z80-tab"]').click(),
    ]);
    const tmp = await download.path();
    expect(tmp).toBeTruthy();
    const buf = fs.readFileSync(tmp!);
    expect(buf.length).toBeGreaterThan(30);
    await page.locator('[data-act="reboot"]').first().click();
    await expect.poll(async () => panelLog(page)).toMatch(/reboot/i);
    await page.setInputFiles('input[data-file="z80"]', {
      name: 'roundtrip.z80',
      mimeType: 'application/octet-stream',
      buffer: buf,
    });
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
    await page.locator('.float-win.machine-panel [data-act="pause"]').first().click();
    await expect
      .poll(async () => {
        const regs = await page.locator('[data-spec-regs]').innerText();
        return regs.match(/PC=([0-9a-f]+)/i)?.[1];
      }, { timeout: 5_000 })
      .toBe(beforePc);
  });

  test('128K TAP via 48 BASIC auto-LOAD paints', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum128(page);
    await page.locator('[data-act="spectrum-48basic-tab"]').click();
    await expect.poll(async () => panelLog(page)).toMatch(/48 BASIC/i);
    await loadBundledDemo(page, 'glazx');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 60_000 }).toBe(true);
  });

  test('TRD mount logs Beta stub and labels disk', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${base}/`);
    await waitMenubar(page);
    await placeSpectrum128(page);
    await page.locator('[data-act="trdos-boot-tab"]').click();
    await expect.poll(async () => panelLog(page)).toMatch(/soft stub|sector/i);
    const trd = buildMinimalTrd('E2EDISK');
    await page.setInputFiles('input[data-file="trd"]', {
      name: 'e2e.trd',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(trd),
    });
    await expect.poll(async () => panelLog(page)).toMatch(/E2EDISK|Beta sector/i);
    await expect.poll(async () => page.locator('[data-spec-regs]').innerText()).toMatch(/Beta stub/i);
  });
});
