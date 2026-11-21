import { describe, expect, it } from 'vitest';
import { registerWebMcpTools } from '../src/mcp/register.js';
import { createTools, runTool } from '../src/mcp/tools.js';
import { Workspace } from '../src/mcp/workspace.js';

function toolsByName(hooks = {}) {
  const tools = createTools(new Workspace(), hooks);
  const call = (name: string, args?: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return runTool(tool, args);
  };
  return { tools, call };
}

describe('MCP tools', () => {
  it('drives build and simulate with JSON-shaped arguments', () => {
    const { call } = toolsByName();
    expect(
      call('build', {
        components: [
          { name: 'a', type: 'input' },
          { name: 'n', type: 'NOT' },
          { name: 'q', type: 'probe' },
        ],
        wires: [['a', 'n.in'], ['n.out', 'q']],
      }),
    ).toMatchObject({ ok: true, placed: ['a', 'n', 'q'], wired: 2, warnings: [] });
    expect(call('simulate', { inputs: { a: 1 } })).toMatchObject({ ok: true, outputs: { q: 0 } });
    expect(call('simulate', { inputs: { a: 0 } })).toMatchObject({ ok: true, outputs: { q: 1 } });
  });

  it('returns errors as data instead of throwing', () => {
    const { call } = toolsByName();
    const result = call('build', { components: [{ name: 'g', type: 'NOPE' }] });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/unknown type "NOPE"/);
  });

  it('describes a circuit with pin-reference wires', () => {
    const { call } = toolsByName();
    call('build', {
      components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }],
      wires: [['a', 'n.in']],
    });
    expect(call('describe')).toMatchObject({
      components: [{ name: 'a', type: 'input' }, { name: 'n', type: 'NOT' }],
      wires: [['a', 'n.in']],
    });
  });

  it('runs the chip workflow end to end', () => {
    const { call } = toolsByName();
    expect(call('begin_chip', { name: 'NAND_VIA_AND' })).toMatchObject({ ok: true, scope: 'NAND_VIA_AND' });
    call('build', {
      scope: 'NAND_VIA_AND',
      components: [{ name: 'g', type: 'AND' }, { name: 'i', type: 'NOT' }],
      wires: [['g.out', 'i.in']],
    });
    expect(
      call('finish_chip', {
        scope: 'NAND_VIA_AND',
        ports: [
          { name: 'a', dir: 'in', pin: 'g.a' },
          { name: 'b', dir: 'in', pin: 'g.b' },
          { name: 'out', dir: 'out', pin: 'i.out' },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      call('test_chip', {
        name: 'NAND_VIA_AND',
        cases: [
          { in: { a: 0, b: 0 }, out: { out: 1 } },
          { in: { a: 1, b: 1 }, out: { out: 0 } },
        ],
      }),
    ).toMatchObject({ ok: true, passed: 2, total: 2, failures: [] });
  });

  it('exposes sequential simulation, truth tables and editing', () => {
    const { call } = toolsByName();
    expect(call('truth_table', { name: 'AND' })).toMatchObject({
      ok: true,
      rows: [{ in: { a: 0, b: 0 }, out: { out: 0 } }, { in: { a: 1, b: 0 }, out: { out: 0 } }, { in: { a: 0, b: 1 }, out: { out: 0 } }, { in: { a: 1, b: 1 }, out: { out: 1 } }],
    });
    call('build', {
      components: [
        { name: 'clk', type: 'input' }, { name: 'clr', type: 'input' }, { name: 'on', type: 'vcc' }, { name: 'off', type: 'gnd' },
        { name: 'c', type: 'COUNTER4' }, { name: 'q', type: 'probe', count: 4 },
      ],
      wires: [['clk', 'c.clk'], ['clr', 'c.clr'], ['on', 'c.ce'], ['off', 'c.load', 'c.d'], ['c.q', 'q']],
    });
    call('simulate', { inputs: { clr: 1 } });
    const run = call('simulate', { clock: 'clk', cycles: 3, inputs: { clr: 0 } }) as unknown as { trace: { q: { value: number } }[] };
    expect(run.trace.map((t) => t.q.value)).toEqual([1, 2, 3]);
    expect(call('simulate', { sequence: [{ clk: 1 }, { clk: 0 }], reset: true })).toMatchObject({ ok: true });
    expect(call('remove', { components: ['q'] })).toMatchObject({ ok: true, removedComponents: 4 });
    expect(call('delete_chip', { name: 'AND' })).toMatchObject({ ok: false });
  });

  it('offers publish_to_canvas only when the host provides it', () => {
    expect(toolsByName().tools.map((t) => t.name)).not.toContain('publish_to_canvas');
    const hosted = toolsByName({ publishToCanvas: () => ({ placedComponents: 3, chips: [] }) });
    expect(hosted.call('publish_to_canvas')).toEqual({ ok: true, placedComponents: 3, chips: [] });
  });
});

describe('registerWebMcpTools', () => {
  it('registers every tool with its schema and annotations', async () => {
    const registered: { name: string; annotations?: unknown; execute: (a: Record<string, unknown>) => Promise<unknown> }[] = [];
    const { tools } = toolsByName();
    const ok = await registerWebMcpTools(tools, {
      registerTool: async (tool) => {
        registered.push(tool);
      },
    });
    expect(ok).toBe(true);
    expect(registered.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(registered.find((t) => t.name === 'simulate')?.annotations).toEqual({ readOnlyHint: true });
    expect(await registered.find((t) => t.name === 'list_library')!.execute({})).toMatchObject({ ok: true });
  });

  it('does nothing when the browser has no modelContext', async () => {
    expect(await registerWebMcpTools(toolsByName().tools, undefined)).toBe(false);
  });
});
