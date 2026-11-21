/**
 * WebMCP: a stand-in `document.modelContext` captures the registered tools, then a
 * circuit is built, verified and published through them exactly as an agent would.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

test.describe('WebMCP tools', () => {
  test('build, verify and publish a circuit; undo removes it again', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    await page.addInitScript(() => {
      const tools = new Map<string, { execute(args: unknown): Promise<unknown> }>();
      Object.defineProperty(document, 'modelContext', {
        value: { registerTool: async (t: { name: string; execute(args: unknown): Promise<unknown> }) => void tools.set(t.name, t) },
      });
      (window as unknown as { __tools: typeof tools }).__tools = tools;
    });
    await page.goto(`file://${indexHtml}`);
    await expect(page.locator('#canvas')).toBeVisible();
    await page.waitForTimeout(400);

    const run = await page.evaluate(async () => {
      const tools = (window as unknown as { __tools: Map<string, { execute(args: unknown): Promise<unknown> }> }).__tools;
      const call = async (name: string, args: unknown = {}) => JSON.parse(JSON.stringify(await tools.get(name)!.execute(args)));
      const bits = [0, 1, 2, 3];
      await call('begin_chip', { name: 'ADD4' });
      await call('build', {
        scope: 'ADD4',
        components: [{ name: 'fa', type: 'FULL_ADDER', count: 4 }, { name: 'gnd', type: 'gnd' }],
        wires: [['gnd', 'fa0.cin'], ...[0, 1, 2].map((i) => [`fa${i}.cout`, `fa${i + 1}.cin`])],
      });
      await call('finish_chip', {
        scope: 'ADD4',
        ports: [
          ...bits.flatMap((i) => [
            { name: `a${i}`, dir: 'in', pin: `fa${i}.a` },
            { name: `b${i}`, dir: 'in', pin: `fa${i}.b` },
            { name: `s${i}`, dir: 'out', pin: `fa${i}.sum` },
          ]),
          { name: 'cout', dir: 'out', pin: 'fa3.cout' },
        ],
      });
      const tested = await call('test_chip', { name: 'ADD4', cases: [[9, 5], [15, 15], [0, 0]].map(([a, b]) => ({ in: { a, b }, out: { s: (a! + b!) % 16, cout: (a! + b!) >> 4 } })) });
      await call('build', {
        components: [
          { name: 'x', type: 'input', count: 4 }, { name: 'y', type: 'input', count: 4 },
          { name: 'add', type: 'ADD4' }, { name: 'sum', type: 'probe', count: 4 }, { name: 'carry', type: 'probe' },
        ],
        wires: [['x', 'add.a'], ['y', 'add.b'], ['add.s', 'sum'], ['add.cout', 'carry']],
      });
      const sim = await call('simulate', { inputs: { x: 9, y: 5 } });
      const editor = (window as unknown as { __simTest: { editor: { circuit: { components: Map<string, unknown> } } } }).__simTest.editor;
      const before = editor.circuit.components.size;
      const published = await call('publish_to_canvas');
      return { names: [...tools.keys()], tested, sim, published, before, after: editor.circuit.components.size };
    });

    expect(run.names).toEqual(expect.arrayContaining(['build', 'simulate', 'finish_chip', 'test_chip', 'publish_to_canvas']));
    expect(run.tested).toMatchObject({ ok: true, passed: 3, total: 3 });
    expect(run.sim.outputs.sum).toEqual({ value: 14, bits: '1110' });
    expect(run.published).toMatchObject({ ok: true, chips: ['ADD4'] });
    expect(run.after).toBeGreaterThan(run.before);

    await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    const afterUndo = await page.evaluate(
      () => (window as unknown as { __simTest: { editor: { circuit: { components: Map<string, unknown> } } } }).__simTest.editor.circuit.components.size,
    );
    expect(afterUndo).toBe(run.before);
    expect(problems).toEqual([]);
  });

  test('a chip left on the canvas is usable by a later agent session and is shared, not copied', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    await page.addInitScript(() => {
      const tools = new Map<string, { execute(args: unknown): Promise<unknown> }>();
      Object.defineProperty(document, 'modelContext', {
        value: { registerTool: async (t: { name: string; execute(args: unknown): Promise<unknown> }) => void tools.set(t.name, t) },
      });
      (window as unknown as { __tools: typeof tools }).__tools = tools;
    });
    type Call = (name: string, args?: unknown) => Promise<Record<string, unknown>>;
    const withCall = <T>(fn: (call: Call) => Promise<T>) =>
      page.evaluate(`(async () => {
        const tools = window.__tools;
        const call = async (name, args = {}) => JSON.parse(JSON.stringify(await tools.get(name).execute(args)));
        return (${fn.toString()})(call);
      })()`) as Promise<T>;

    await page.goto(`file://${indexHtml}`);
    await expect(page.locator('#canvas')).toBeVisible();
    await page.waitForTimeout(400);
    await withCall(async (call) => {
      await call('begin_chip', { name: 'INV2' });
      await call('build', { scope: 'INV2', components: [{ name: 'a', type: 'NOT' }, { name: 'b', type: 'NOT' }], wires: [['a.out', 'b.in']] });
      await call('finish_chip', { scope: 'INV2', ports: [{ name: 'in', dir: 'in', pin: 'a.in' }, { name: 'out', dir: 'out', pin: 'b.out' }] });
      await call('build', { components: [{ name: 'u', type: 'INV2' }] });
      return call('publish_to_canvas');
    });
    await page.waitForTimeout(2500);
    await page.reload();
    await expect(page.locator('#canvas')).toBeVisible();
    await page.waitForTimeout(600);

    const run = await withCall(async (call) => {
      const library = (await call('list_library')) as { chips: { name: string; origin?: string }[] };
      await call('build', {
        components: [{ name: 'i', type: 'input' }, { name: 'u', type: 'INV2' }, { name: 'q', type: 'probe' }],
        wires: [['i', 'u.in'], ['u.out', 'q']],
      });
      const sim = await call('simulate', { inputs: { i: 1 } });
      const published = await call('publish_to_canvas');
      return { chip: library.chips.find((c) => c.name === 'INV2'), sim, published };
    });
    expect(run.chip).toMatchObject({ name: 'INV2', origin: 'canvas' });
    expect(run.sim).toMatchObject({ outputs: { q: 1 } });
    expect(run.published).toMatchObject({ ok: true, chips: [] });
    expect(problems).toEqual([]);
  });
});
