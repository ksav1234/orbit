import { z } from 'zod';
import { McpClient, renderMcpContent, type McpToolDescriptor } from './client.js';
import { toolError, toolOk, type Tool, type ToolContext, type ToolResult } from '../tools/registry.js';
import type { JSONSchema } from '../providers/provider.js';
import { OrbitError, errorMessage } from '../util/errors.js';
import { clampChars, oneLine, pluralize } from '../util/format.js';
import { createLogger } from '../util/logger.js';
import type { McpConfig } from '../config/schema.js';

const log = createLogger('mcp:tools');

/** MCP tool names are namespaced so two servers cannot collide. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Wrap an MCP tool as an Orbit tool.
 *
 * MCP servers reach outside the workspace by design (databases, browsers,
 * issue trackers), so every one of them is treated as a network operation and
 * goes through the same approval path as anything else.
 */
export function createMcpTool(client: McpClient, descriptor: McpToolDescriptor): Tool {
  const name = mcpToolName(client.id, descriptor.name);
  const schema = normalizeSchema(descriptor.inputSchema);

  return {
    name,
    description:
      `[${client.name}] ${descriptor.description ?? `Tool "${descriptor.name}" provided by the ${client.name} MCP server.`}`.slice(
        0,
        1024,
      ),
    schema,
    permission: 'network',
    readOnly: false,
    parse(args: unknown) {
      // The server owns validation; Orbit only guarantees an object.
      if (args === undefined || args === null) return {};
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw new OrbitError(`Invalid arguments for ${name}.`, {
          kind: 'tool',
          detail: 'Arguments must be a JSON object.',
        });
      }
      return args;
    },
    async authorize(args) {
      const preview = oneLine(JSON.stringify(args ?? {}), 200);
      return {
        category: 'network',
        tool: name,
        title: `Run ${descriptor.name} on the ${client.name} MCP server`,
        details: [
          { label: 'Server', value: client.name },
          { label: 'Tool', value: descriptor.name },
          { label: 'Scope', value: 'Outside the workspace sandbox.' },
        ],
        preview: preview === '{}' ? undefined : preview,
        previewKind: 'text',
        target: `mcp:${client.id}:${descriptor.name}`,
      };
    },
    async execute(args, context: ToolContext): Promise<ToolResult> {
      if (!client.isRunning) {
        return toolError(`The ${client.name} MCP server is not running.`);
      }

      context.progress(`${client.name}: ${descriptor.name}`);

      try {
        const result = await client.callTool(descriptor.name, (args ?? {}) as Record<string, unknown>);
        const text = renderMcpContent(result.content).trim();
        const clamped = clampChars(text || '(the server returned no content)', context.config.maxOutputChars);

        if (result.isError) {
          return toolError(clamped.text, { summary: `${descriptor.name} failed` });
        }

        return toolOk(
          clamped.text,
          {
            kind: 'text',
            summary: `${client.name} · ${descriptor.name}`,
            lines: clamped.text.split('\n').slice(0, 10),
            detail: text,
          },
          { metadata: { server: client.id, tool: descriptor.name } },
        );
      } catch (error) {
        log.warn('mcp tool call failed', { tool: name, error: errorMessage(error) });
        return toolError(errorMessage(error), { summary: `${descriptor.name} failed` });
      }
    },
  };
}

/**
 * Providers reject malformed tool schemas, and MCP servers vary in quality.
 * Normalise to a plain object schema.
 */
function normalizeSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const copy: JSONSchema = { ...schema };
  delete copy.$schema;
  if (copy.type !== 'object') copy.type = 'object';
  if (!copy.properties || typeof copy.properties !== 'object') copy.properties = {};
  return copy;
}

export interface McpStartupResult {
  clients: McpClient[];
  tools: Tool[];
  failures: Array<{ id: string; error: string }>;
}

/**
 * Start every enabled MCP server and collect their tools. A server that fails
 * to start is reported, never fatal: the rest of the session still works.
 */
export async function startMcpServers(config: McpConfig): Promise<McpStartupResult> {
  const entries = Object.entries(config.servers).filter(([, server]) => server.enabled);
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  await Promise.all(
    entries.map(async ([id, server]) => {
      const client = new McpClient(id, server);
      try {
        const descriptors = await client.start();
        clients.push(client);
        for (const descriptor of descriptors) tools.push(createMcpTool(client, descriptor));
      } catch (error) {
        failures.push({ id, error: errorMessage(error) });
        await client.stop();
      }
    }),
  );

  return { clients, tools, failures };
}

export async function stopMcpServers(clients: McpClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.stop()));
}

export function describeMcpServers(clients: McpClient[]): string {
  if (clients.length === 0) return 'no MCP servers connected';
  return clients
    .map((client) => `${client.id} (${pluralize(client.listTools().length, 'tool')})`)
    .join(', ');
}

/** Schema helper used by tests to assert the wrapper shape. */
export const McpArgsSchema = z.record(z.unknown());
