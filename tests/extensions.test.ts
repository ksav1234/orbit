import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractSymbols, findSymbolTool, outlineFileTool } from '../src/tools/symbols.js';
import { matchesAllowlist, executeCommandTool } from '../src/tools/terminal.js';
import { BackgroundRegistry, runBackgroundTool, checkBackgroundTool } from '../src/tools/background.js';
import { taskTool, READ_ONLY_SUBAGENT_TOOLS } from '../src/agent/subagent.js';
import { createMcpTool, mcpToolName } from '../src/mcp/tools.js';
import { McpClient, renderMcpContent } from '../src/mcp/client.js';
import { McpServerSchema } from '../src/config/schema.js';
import {
  loadCustomCommands,
  parseCommandFile,
  renderTemplate,
  toSlashCommands,
} from '../src/cli/custom-commands.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace, writeFiles } from './helpers.js';

let workspace = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-ext-');
});

afterEach(async () => {
  await removeTempWorkspace(workspace);
});

// ── symbols ────────────────────────────────────────────────────────────────

describe('symbol extraction', () => {
  it('finds TypeScript declarations', () => {
    const symbols = extractSymbols(
      [
        'export function authenticate(req: Request) {}',
        'export class SessionStore {}',
        'export interface Session { id: string }',
        'export type Token = string;',
        'const helper = () => 1;',
        'export const CONFIG = { a: 1 };',
      ].join('\n'),
      'src/auth.ts',
    );

    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get('authenticate')?.kind).toBe('function');
    expect(byName.get('SessionStore')?.kind).toBe('class');
    expect(byName.get('Session')?.kind).toBe('interface');
    expect(byName.get('Token')?.kind).toBe('type');
    expect(byName.get('helper')?.kind).toBe('function');
    expect(byName.get('CONFIG')?.kind).toBe('const');
    expect(byName.get('authenticate')?.exported).toBe(true);
    expect(byName.get('helper')?.exported).toBe(false);
  });

  it('finds declarations in other languages', () => {
    expect(extractSymbols('def login(user):', 'a.py')[0]).toMatchObject({
      name: 'login',
      kind: 'function',
    });
    expect(extractSymbols('pub fn verify() {}', 'a.rs')[0]).toMatchObject({
      name: 'verify',
      kind: 'function',
    });
    expect(extractSymbols('func Handle(w http.ResponseWriter) {}', 'a.go')[0]).toMatchObject({
      name: 'Handle',
      kind: 'function',
    });
    expect(extractSymbols('type Server struct {', 'a.go')[0]).toMatchObject({
      name: 'Server',
      kind: 'struct',
    });
  });

  it('ignores commented-out declarations', () => {
    const symbols = extractSymbols('// export function ghost() {}\n#  def ghost2():', 'a.ts');
    expect(symbols).toHaveLength(0);
  });

  it('ignores files in languages it does not index', () => {
    expect(extractSymbols('anything at all', 'notes.md')).toHaveLength(0);
  });
});

describe('find_symbol', () => {
  it('locates a declaration and reports where it is', async () => {
    await writeFiles(workspace, {
      'src/auth.ts': 'export function authenticate() {\n  return true;\n}\n',
      'src/uses.ts': 'import { authenticate } from "./auth";\nauthenticate();\nauthenticate();\n',
    });

    const context = makeToolContext({ root: workspace });
    const result = await findSymbolTool.execute(
      findSymbolTool.parse({ name: 'authenticate' }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/auth.ts:1');
    // The call sites are not declarations, so they are not listed.
    expect(result.metadata?.matches).toBe(1);
  });

  it('says so plainly when nothing is declared with that name', async () => {
    await writeFiles(workspace, { 'src/a.ts': 'export const x = 1;\n' });
    const context = makeToolContext({ root: workspace });

    const result = await findSymbolTool.execute(
      findSymbolTool.parse({ name: 'missingThing', exact: true }),
      context,
    );

    expect(result.content).toMatch(/No declaration/);
    expect(result.content).toMatch(/try search_files/);
  });

  it('outlines a file', async () => {
    await writeFiles(workspace, {
      'big.ts': ['export class A {}', '', 'export function b() {}', 'const c = 1;'].join('\n'),
    });

    const context = makeToolContext({ root: workspace });
    const result = await outlineFileTool.execute(
      outlineFileTool.parse({ path: 'big.ts' }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('[class] A');
    expect(result.content).toContain('[function] b');
    expect(result.metadata?.symbols).toBe(3);
  });
});

// ── shell allowlist ────────────────────────────────────────────────────────

describe('command allowlist', () => {
  it('matches configured patterns against the whole command', () => {
    expect(matchesAllowlist('npm test', ['^npm (test|run build)$'])).toBe(true);
    expect(matchesAllowlist('npm run build', ['^npm (test|run build)$'])).toBe(true);
    expect(matchesAllowlist('npm install left-pad', ['^npm (test|run build)$'])).toBe(false);
  });

  it('treats an invalid pattern as a literal, never as a wildcard', () => {
    expect(matchesAllowlist('anything', ['[unclosed'])).toBe(false);
    expect(matchesAllowlist('[unclosed', ['[unclosed'])).toBe(true);
  });

  it('skips the approval prompt for an allowlisted command', async () => {
    const base = makeToolContext({ root: workspace });
    const context = { ...base, config: { ...base.config, allowedCommands: ['^npm test$'] } };

    const allowed = await executeCommandTool.authorize(
      executeCommandTool.parse({ command: 'npm test' }),
      context,
    );
    const notAllowed = await executeCommandTool.authorize(
      executeCommandTool.parse({ command: 'npm install' }),
      context,
    );

    expect(allowed).toBeNull();
    expect(notAllowed?.category).toBe('shell');
  });
});

// ── background processes ───────────────────────────────────────────────────

describe('background processes', () => {
  it('starts a process, reads its output, and stops it', async () => {
    const registry = new BackgroundRegistry();
    const context = { ...makeToolContext({ root: workspace }), background: registry };

    try {
      const started = await runBackgroundTool.execute(
        runBackgroundTool.parse({
          command: 'node -e "console.log(\'server up\'); setInterval(()=>{}, 1000)"',
        }),
        context,
      );

      expect(started.ok).toBe(true);
      const id = started.metadata?.id as string;

      const checked = await checkBackgroundTool.execute(
        checkBackgroundTool.parse({ id }),
        context,
      );
      expect(checked.content).toContain('server up');
      expect(checked.content).toContain('running');

      expect(registry.stop(id)).toBe(true);
      expect(registry.running()).toHaveLength(0);
    } finally {
      registry.stopAll();
    }
  });

  it('reports a command that dies immediately', async () => {
    const registry = new BackgroundRegistry();
    const context = { ...makeToolContext({ root: workspace }), background: registry };

    try {
      const result = await runBackgroundTool.execute(
        runBackgroundTool.parse({ command: 'node -e "process.exit(7)"' }),
        context,
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain('exit 7');
    } finally {
      registry.stopAll();
    }
  });

  it('refuses a blocked command', async () => {
    const registry = new BackgroundRegistry();
    const context = { ...makeToolContext({ root: workspace }), background: registry };
    const result = await runBackgroundTool.execute(
      runBackgroundTool.parse({ command: 'rm -rf /' }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Refused/);
  });
});

// ── sub-agents ─────────────────────────────────────────────────────────────

describe('task tool', () => {
  it('returns only the sub-agent report', async () => {
    const context = {
      ...makeToolContext({ root: workspace }),
      delegate: async () => ({
        text: 'Authentication lives in src/auth.ts:12.',
        toolCalls: 7,
        iterations: 3,
        usage: { promptTokens: 5000, completionTokens: 200 },
      }),
    };

    const result = await taskTool.execute(
      taskTool.parse({
        description: 'find auth',
        prompt: 'Find where authentication is implemented and report the file and line.',
      }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/auth.ts:12');
    expect(result.content).toContain('7 tool calls');
    expect(result.metadata?.toolCalls).toBe(7);
  });

  it('says so when delegation is unavailable', async () => {
    const context = makeToolContext({ root: workspace });
    const result = await taskTool.execute(
      taskTool.parse({ description: 'find auth', prompt: 'Find the authentication code.' }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not available/);
  });

  it('reports an empty report rather than pretending it succeeded', async () => {
    const context = {
      ...makeToolContext({ root: workspace }),
      delegate: async () => ({ text: '   ', toolCalls: 2, iterations: 1 }),
    };

    const result = await taskTool.execute(
      taskTool.parse({ description: 'search', prompt: 'Look for something specific.' }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without producing a report/);
  });

  it('restricts a read-only sub-agent to non-mutating tools', () => {
    expect(READ_ONLY_SUBAGENT_TOOLS).toContain('read_file');
    expect(READ_ONLY_SUBAGENT_TOOLS).toContain('search_files');
    expect(READ_ONLY_SUBAGENT_TOOLS).not.toContain('write_file');
    expect(READ_ONLY_SUBAGENT_TOOLS).not.toContain('execute_command');
    expect(READ_ONLY_SUBAGENT_TOOLS).not.toContain('delete_file');
  });
});

// ── MCP ────────────────────────────────────────────────────────────────────

describe('MCP', () => {
  it('namespaces tool names so two servers cannot collide', () => {
    expect(mcpToolName('github', 'search')).toBe('mcp__github__search');
    expect(mcpToolName('my-server', 'do.thing')).toBe('mcp__my_server__do_thing');
  });

  it('flattens content blocks to text', () => {
    expect(
      renderMcpContent([
        { type: 'text', text: 'first' },
        { type: 'resource', resource: { uri: 'file://x', text: 'second' } },
        { type: 'image', mimeType: 'image/png' },
      ]),
    ).toBe('first\nsecond\n[image returned by the server: image/png]');
  });

  it('routes MCP tools through the network permission', async () => {
    const client = new McpClient('demo', McpServerSchema.parse({ command: 'noop' }));
    const tool = createMcpTool(client, {
      name: 'query',
      description: 'Run a database query',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
    });

    expect(tool.name).toBe('mcp__demo__query');
    expect(tool.permission).toBe('network');
    expect(tool.description).toContain('Run a database query');

    const request = await tool.authorize({ sql: 'select 1' }, makeToolContext({ root: workspace }));
    expect(request?.category).toBe('network');
    expect(request?.details?.some((d) => /Outside the workspace/.test(d.value))).toBe(true);
  });

  it('normalises a missing or malformed schema', () => {
    const client = new McpClient('demo', McpServerSchema.parse({ command: 'noop' }));

    const noSchema = createMcpTool(client, { name: 'a' });
    expect(noSchema.schema).toMatchObject({ type: 'object' });

    const badSchema = createMcpTool(client, {
      name: 'b',
      inputSchema: { type: 'string', $schema: 'http://json-schema.org/draft-07/schema#' },
    });
    expect(badSchema.schema.type).toBe('object');
    expect(badSchema.schema).not.toHaveProperty('$schema');
  });

  it('fails cleanly when the server is not running', async () => {
    const client = new McpClient('demo', McpServerSchema.parse({ command: 'noop' }));
    const tool = createMcpTool(client, { name: 'query' });

    const result = await tool.execute({}, makeToolContext({ root: workspace }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not running/);
  });

  it('starts a real stdio server and calls one of its tools', async () => {
    // A minimal MCP server: enough of the protocol to prove the client works.
    const serverPath = path.join(workspace, 'mcp-server.mjs');
    await fs.writeFile(
      serverPath,
      `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf('\\n');
  }
});
function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'demo-server', version: '1.0.0' },
    }});
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ]}});
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'echoed: ' + message.params.arguments.text }],
    }});
  }
}
`,
      'utf8',
    );

    const client = new McpClient(
      'demo',
      McpServerSchema.parse({ command: process.execPath, args: [serverPath], timeoutMs: 10_000 }),
    );

    try {
      const tools = await client.start();
      expect(client.name).toBe('demo-server');
      expect(tools.map((tool) => tool.name)).toEqual(['echo']);

      const orbitTool = createMcpTool(client, tools[0]!);
      const result = await orbitTool.execute({ text: 'hello' }, makeToolContext({ root: workspace }));

      expect(result.ok).toBe(true);
      expect(result.content).toBe('echoed: hello');
    } finally {
      await client.stop();
    }
  });
});

// ── project commands ───────────────────────────────────────────────────────

describe('custom slash commands', () => {
  it('reads a description from front matter', () => {
    const parsed = parseCommandFile('---\ndescription: Review the diff\n---\nDo the review.');
    expect(parsed.description).toBe('Review the diff');
    expect(parsed.body).toBe('Do the review.');
  });

  it('falls back to a leading heading', () => {
    const parsed = parseCommandFile('# Changelog entry\n\nWrite a changelog entry.');
    expect(parsed.description).toBe('Changelog entry');
    expect(parsed.body).toBe('Write a changelog entry.');
  });

  it('substitutes arguments', () => {
    expect(renderTemplate('Review $ARGUMENTS carefully.', 'src/a.ts')).toBe(
      'Review src/a.ts carefully.',
    );
    expect(renderTemplate('Compare $1 with $2.', 'a.ts b.ts')).toBe('Compare a.ts with b.ts.');
  });

  it('appends arguments when the template has no placeholder', () => {
    expect(renderTemplate('Review the diff.', 'src/a.ts')).toBe('Review the diff.\n\nsrc/a.ts');
    expect(renderTemplate('Review the diff.', '')).toBe('Review the diff.');
  });

  it('loads commands from .orbit/commands', async () => {
    await writeFiles(workspace, {
      '.orbit/commands/review.md': '---\ndescription: Review the changes\n---\nReview $ARGUMENTS.',
      '.orbit/commands/notes.txt': 'Write release notes.',
      '.orbit/commands/BAD NAME.md': 'ignored',
    });

    const files = await loadCustomCommands([workspace]);
    expect(files.map((file) => file.name)).toEqual(['notes', 'review']);
    expect(files.find((file) => file.name === 'review')?.description).toBe('Review the changes');
  });

  it('turns loaded files into commands that submit a prompt', () => {
    const sent: string[] = [];
    const commands = toSlashCommands(
      [{ name: 'review', description: 'Review', template: 'Review $ARGUMENTS.', source: 'x' }],
      (prompt) => sent.push(prompt),
    );

    commands[0]!.run('src/auth.ts', {} as never);
    expect(sent).toEqual(['Review src/auth.ts.']);
  });

  it('returns nothing when the directory does not exist', async () => {
    expect(await loadCustomCommands([workspace])).toEqual([]);
  });
});
