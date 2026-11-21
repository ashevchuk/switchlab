import { runTool } from './tools.js';
import type { ToolDef } from './tools.js';

interface ModelContextLike {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, boolean>;
      execute(args: Record<string, unknown>): Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** The spec moved the entry point from `navigator` to `document`; older Chrome builds still use `navigator`. */
function findModelContext(): ModelContextLike | undefined {
  const holders: unknown[] = [typeof document === 'undefined' ? undefined : document, typeof navigator === 'undefined' ? undefined : navigator];
  for (const holder of holders) {
    const mc = (holder as { modelContext?: ModelContextLike } | undefined)?.modelContext;
    if (mc && typeof mc.registerTool === 'function') return mc;
  }
  return undefined;
}

/** Registers the tools with the browser's agent. Returns false when WebMCP is not available. */
export async function registerWebMcpTools(
  tools: ToolDef[],
  modelContext: ModelContextLike | undefined = findModelContext(),
  signal?: AbortSignal,
): Promise<boolean> {
  if (!modelContext) return false;
  await Promise.all(
    tools.map((tool) =>
      modelContext.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations as Record<string, boolean> } : {}),
          execute: async (args) => runTool(tool, args),
        },
        signal ? { signal } : {},
      ),
    ),
  );
  return true;
}
