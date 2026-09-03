import { spawn, type ChildProcess } from 'node:child_process';
import { childEnv } from '../util/env.js';
import { OrbitError } from '../util/errors.js';
import { prepareSpawn } from '../util/process.js';
import { createLogger } from '../util/logger.js';
import type { McpServerConfig } from '../config/schema.js';
import type { JSONSchema } from '../providers/provider.js';

const log = createLogger('mcp');

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string };
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

/**
 * Minimal MCP client over stdio.
 *
 * Implements the handshake, `tools/list` and `tools/call` — the surface Orbit
 * needs to expose a server's tools. Framing is newline-delimited JSON-RPC,
 * which is what stdio MCP servers speak.
 */
export class McpClient {
  readonly id: string;
  private readonly config: McpServerConfig;
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();
  private serverInfo: { name?: string; version?: string } = {};
  private tools: McpToolDescriptor[] = [];
  private started = false;
  private closed = false;

  constructor(id: string, config: McpServerConfig) {
    this.id = id;
    this.config = config;
  }

  get name(): string {
    return this.serverInfo.name ?? this.id;
  }

  get isRunning(): boolean {
    return this.started && !this.closed;
  }

  listTools(): McpToolDescriptor[] {
    return this.tools;
  }

  /** Launch the server, complete the handshake, and cache its tool list. */
  async start(): Promise<McpToolDescriptor[]> {
    if (this.started) return this.tools;
    this.started = true;

    // MCP servers are almost always launched with `npx`, which is a batch shim
    // on Windows and cannot be spawned directly.
    const prepared = prepareSpawn(this.config.command, this.config.args);

    try {
      this.child = spawn(prepared.command, prepared.args, {
        cwd: this.config.cwd,
        env: { ...childEnv(), ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: prepared.verbatim,
      });
    } catch (error) {
      throw new OrbitError(`Could not start MCP server "${this.id}".`, {
        kind: 'config',
        detail: String(error),
        hints: [`Check the command: ${this.config.command}`],
      });
    }

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk));

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      // Servers use stderr for logs; keep it out of the UI but in the debug log.
      log.debug(`[${this.id}] ${chunk.trimEnd()}`);
    });

    this.child.on('error', (error) => {
      log.warn('mcp server error', { id: this.id, error: error.message });
      this.failAll(new OrbitError(`MCP server "${this.id}" failed: ${error.message}`, { kind: 'tool' }));
      this.closed = true;
    });

    this.child.on('close', (code) => {
      log.info('mcp server exited', { id: this.id, code });
      this.closed = true;
      this.failAll(new OrbitError(`MCP server "${this.id}" exited (code ${code}).`, { kind: 'tool' }));
    });

    const initialize = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'orbit', version: '0.1.0' },
    })) as { serverInfo?: { name?: string; version?: string } };

    this.serverInfo = initialize?.serverInfo ?? {};
    this.notify('notifications/initialized', {});

    const listed = (await this.request('tools/list', {})) as { tools?: McpToolDescriptor[] };
    this.tools = (listed?.tools ?? []).filter((tool) => typeof tool.name === 'string');

    log.info('mcp server ready', { id: this.id, name: this.name, tools: this.tools.length });
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: McpContentBlock[];
      isError?: boolean;
    };
    return {
      content: result?.content ?? [],
      isError: Boolean(result?.isError),
    };
  }

  async stop(): Promise<void> {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.failAll(new OrbitError('MCP server stopped.', { kind: 'tool' }));
    try {
      this.child.stdin?.end();
      this.child.kill();
    } catch {
      // Already gone.
    }
  }

  // ── transport ────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleMessage(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      log.debug('ignoring non-JSON line from mcp server', { id: this.id });
      return;
    }

    if (typeof message.id !== 'number') return; // A notification from the server.

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(
        new OrbitError(`MCP server "${this.id}" returned an error.`, {
          kind: 'tool',
          detail: message.error.message,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin || this.closed) {
      return Promise.reject(
        new OrbitError(`MCP server "${this.id}" is not running.`, { kind: 'tool' }),
      );
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OrbitError(`MCP server "${this.id}" did not respond to ${method}.`, {
            kind: 'tool',
            detail: `Timed out after ${Math.round(this.config.timeoutMs / 1000)}s.`,
            retryable: true,
          }),
        );
      }, this.config.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private failAll(error: unknown): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Flatten MCP content blocks into text the model can read. */
export function renderMcpContent(content: McpContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text' && block.text) return block.text;
      if (block.type === 'resource') {
        return block.resource?.text ?? `[resource: ${block.resource?.uri ?? 'unknown'}]`;
      }
      if (block.type === 'image') return `[image returned by the server: ${block.mimeType ?? 'unknown type'}]`;
      return `[${block.type} content]`;
    })
    .filter(Boolean)
    .join('\n');
}
