import { MAIN_SCOPE, Workspace } from './workspace.js';
import type { BuildSpec, ChipCase, ChipPortSpec, RemoveSpec } from './workspace.js';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  run(args: Record<string, unknown>): unknown;
}

export interface ToolHooks {
  /** Copies a workspace circuit onto the user's canvas without removing anything there. */
  publishToCanvas?(workspace: Workspace): { placedComponents: number; chips: string[] };
}

const SCOPE_PROP = {
  scope: {
    type: 'string',
    description: `Circuit to work in. Default "${MAIN_SCOPE}". A chip under construction is its own scope, named after the chip.`,
  },
};

const PIN_REF_HELP =
  'Pin references are "component.pin" (e.g. "g1.out"); a component with a single pin (input, probe, vcc, gnd) is just its name.';

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`"${key}" must be a non-empty string`);
  return v;
}

function scopeOf(args: Record<string, unknown>): string {
  return args.scope === undefined ? MAIN_SCOPE : str(args, 'scope');
}

export function createTools(ws: Workspace, hooks: ToolHooks = {}): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'list_library',
      description:
        'List every placeable chip with its ports and directions (in/out): built-in cells, chips you finished earlier, and chips the user already has on the canvas (origin "canvas"; use them like any other chip). ' +
        'outOfDate means the canvas copy changed since it was imported: delete_chip it and call list_library again. Built-in non-chip types: input, probe, vcc, gnd.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: () => ({ chips: ws.listLibrary() }),
    },
    {
      name: 'build',
      description:
        `Add components and wires in one atomic call: if anything is invalid nothing is added and the error says what to fix. ` +
        `Components: {name, type, count?}; type is a built-in (input, probe, vcc, gnd) or a chip name from list_library. ` +
        `count=N creates name0..name{N-1} and registers "name" as an N-bit bus (bit 0 = LSB) usable in simulate. ` +
        `${PIN_REF_HELP} ` +
        `Wires are lists of pin references [a, b, ...]: a is wired to every other entry. ` +
        `Buses wire in one entry: ["x", "add.a"] connects bit by bit when x is a bus of N and add has ports a0..aN-1; ` +
        `a single pin on one side fans out to every bit of the bus (["gnd", "u.b"]); ["clk", "f1.clk", "f2.clk"] fans out too. ` +
        `Batch a whole circuit into one call. The result lists warnings for chip pins that are not wired.`,
      inputSchema: {
        type: 'object',
        properties: {
          ...SCOPE_PROP,
          components: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, type: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
              required: ['name', 'type'],
            },
          },
          wires: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2 } },
        },
      },
      run: (args) => ws.build(scopeOf(args), args as BuildSpec),
    },
    {
      name: 'simulate',
      description:
        'Set inputs, run the circuit and read every probe. inputs maps an input name to 0/1, or a bus name to an integer. ' +
        'Probes come back by name; a probe bus is {value, bits}, with value null if any bit is floating (Z). ' +
        'State is kept between calls, so flip-flops, registers and counters remember. ' +
        'For sequential circuits pass clock (an input name) and cycles to pulse it N times and get a trace with one reading per cycle, ' +
        'or sequence: [{inputs...}, ...] to apply several input settings in order and get one reading per step. ' +
        'reset: true first forgets all state (power-on). Flip-flops read Z until their first clock edge.',
      inputSchema: {
        type: 'object',
        properties: {
          ...SCOPE_PROP,
          inputs: { type: 'object', additionalProperties: { type: 'integer' } },
          clock: { type: 'string' },
          cycles: { type: 'integer', minimum: 1 },
          sequence: { type: 'array', items: { type: 'object', additionalProperties: { type: 'integer' } } },
          reset: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: true },
      run: (args) => {
        const scope = scopeOf(args);
        const inputs = (args.inputs ?? {}) as Record<string, number>;
        if (args.reset === true) ws.powerCycle(scope);
        if (args.clock !== undefined) return ws.simulateClock(scope, str(args, 'clock'), Number(args.cycles ?? 1), inputs);
        if (args.sequence !== undefined) return ws.simulateSequence(scope, args.sequence as Record<string, number>[]);
        return ws.simulate(scope, inputs);
      },
    },
    {
      name: 'describe',
      description: 'Dump a circuit: component names and types, buses, and every wire as pin-reference pairs.',
      inputSchema: { type: 'object', properties: { ...SCOPE_PROP } },
      annotations: { readOnlyHint: true },
      run: (args) => ws.describe(scopeOf(args)),
    },
    {
      name: 'begin_chip',
      description:
        'Start a new reusable chip. Creates an empty scope named after the chip; build its guts there with build(scope=name), ' +
        'then call finish_chip. Do not add inputs/probes inside: the chip ports are chosen at finish_chip.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: (args) => {
        const name = str(args, 'name');
        ws.beginChip(name);
        return { scope: name };
      },
    },
    {
      name: 'finish_chip',
      description:
        'Fold the scope into a chip. ports: [{name, dir: "in"|"out", pin}]. pin is an inner pin reference, or a list of them for an input ' +
        'that fans out to several inner pins. Ports named a0..aN-1 form a bus usable as "a" in test_chip. ' +
        `${PIN_REF_HELP} The chip then appears in list_library and can be placed in any scope. Always verify it with test_chip.`,
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          ports: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                dir: { enum: ['in', 'out'] },
                pin: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
              },
              required: ['name', 'dir', 'pin'],
            },
          },
        },
        required: ['scope', 'ports'],
      },
      run: (args) => ({ chip: ws.finishChip(str(args, 'scope'), args.ports as ChipPortSpec[]) }),
    },
    {
      name: 'test_chip',
      description:
        'Check a chip against cases [{in: {...}, out: {...}}]. Keys are port names or bus names (integers). ' +
        'Returns passed/total and up to 5 failures with expected and actual values. ' +
        'Without any "out" it just returns the outputs for each input, so you can inspect behaviour first.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                in: { type: 'object', additionalProperties: { type: 'integer' } },
                out: { type: 'object', additionalProperties: { type: 'integer' } },
              },
              required: ['in'],
            },
          },
        },
        required: ['name', 'cases'],
      },
      annotations: { readOnlyHint: true },
      run: (args) => ws.testChip(str(args, 'name'), args.cases as ChipCase[]),
    },
    {
      name: 'truth_table',
      description:
        'Every input combination of a combinational chip and the outputs it produces (at most 8 input bits; buses are shown as integers). ' +
        'Use it to check a chip against what you intended without writing cases by hand. Not meaningful for chips with memory.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      annotations: { readOnlyHint: true },
      run: (args) => ws.truthTable(str(args, 'name')),
    },
    {
      name: 'remove',
      description:
        'Delete components (by name, or a whole bus by its name) and/or wires (same pin-reference lists as build) from a scope, ' +
        'so a mistake can be fixed without starting over. Wires attached to a removed component go with it.',
      inputSchema: {
        type: 'object',
        properties: {
          ...SCOPE_PROP,
          components: { type: 'array', items: { type: 'string' } },
          wires: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2 } },
        },
      },
      annotations: { consequentialHint: true },
      run: (args) => ws.remove(scopeOf(args), args as RemoveSpec),
    },
    {
      name: 'delete_chip',
      description:
        'Remove a chip you built from the library, e.g. to rebuild it under the same name after test_chip found a bug. ' +
        'Refused while any instance of it is placed, and for built-in cells.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      annotations: { consequentialHint: true },
      run: (args) => {
        ws.deleteChip(str(args, 'name'));
        return {};
      },
    },
    {
      name: 'clear',
      description: 'Empty a scope (components, wires and buses). Finished chips stay in the library.',
      inputSchema: { type: 'object', properties: { ...SCOPE_PROP } },
      annotations: { consequentialHint: true },
      run: (args) => {
        ws.clear(scopeOf(args));
        return {};
      },
    },
  ];
  if (hooks.publishToCanvas) {
    const publish = hooks.publishToCanvas;
    tools.push({
      name: 'publish_to_canvas',
      description:
        'Show the "main" circuit and the chips you built on the user\'s canvas. It is added next to what is already there; nothing is removed.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { consequentialHint: true },
      run: () => publish(ws),
    });
  }
  return tools;
}

export type ToolResult = { ok: true } & Record<string, unknown> | { ok: false; error: string };

export function runTool(tool: ToolDef, args: Record<string, unknown> | undefined): ToolResult {
  try {
    const result = tool.run(args ?? {});
    return { ok: true, ...(result as Record<string, unknown>) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
