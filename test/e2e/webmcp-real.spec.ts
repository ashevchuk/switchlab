/**
 * WebMCP through the browser's own implementation (no stand-in): the tools are
 * listed with getTools() and run with executeTool(), the way an agent would.
 * Skipped when the Chromium build has no document.modelContext.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

test.use({ launchOptions: { args: ['--enable-features=WebMCP'] } });

test('tools registered with the browser run through executeTool', async ({ page }) => {
  await page.goto(`file://${indexHtml}`);
  await expect(page.locator('#canvas')).toBeVisible();
  test.skip(await page.evaluate(() => typeof (document as { modelContext?: unknown }).modelContext !== 'object'), 'WebMCP is not available in this Chromium');
  await page.waitForTimeout(400);

  const listed = await page.evaluate(async () => {
    const tools = await (document as unknown as { modelContext: { getTools(): Promise<{ name: string; annotations: unknown; inputSchema: string }[]> } }).modelContext.getTools();
    return tools.map((t) => ({ name: t.name, annotations: t.annotations, schemaIsObject: JSON.parse(t.inputSchema).type === 'object' }));
  });
  expect(listed.map((t) => t.name)).toEqual(
    expect.arrayContaining(['build', 'simulate', 'begin_chip', 'finish_chip', 'test_chip', 'truth_table', 'publish_to_canvas']),
  );
  expect(listed.every((t) => t.schemaIsObject)).toBe(true);
  expect(listed.find((t) => t.name === 'simulate')?.annotations).toMatchObject({ readOnlyHint: true });

  // This Chromium takes the arguments as a JSON string and returns the result as one.
  const run = (name: string, input: unknown) =>
    page.evaluate(
      async ({ name, input }) => {
        const mc = (document as unknown as { modelContext: { getTools(): Promise<{ name: string }[]>; executeTool(t: unknown, args: string): Promise<string> } }).modelContext;
        const tool = (await mc.getTools()).find((t) => t.name === name);
        return JSON.parse(await mc.executeTool(tool, JSON.stringify(input)));
      },
      { name, input },
    );

  expect(
    await run('build', {
      components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }, { name: 'q', type: 'probe' }],
      wires: [['a', 'n.in'], ['n.out', 'q']],
    }),
  ).toMatchObject({ ok: true, wired: 2 });
  expect(await run('simulate', { inputs: { a: 1 } })).toMatchObject({ ok: true, outputs: { q: 0 } });
  expect(await run('build', { components: [{ name: 'g', type: 'NOPE' }] })).toMatchObject({ ok: false, error: expect.stringContaining('unknown type "NOPE"') });
  expect(await run('simulate', { inputs: 'nope' })).toEqual({ ok: false, error: 'inputs: expected object, got string' });
  expect(await run('publish_to_canvas', {})).toMatchObject({ ok: true, placedComponents: 3 });
});
