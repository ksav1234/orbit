import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runHeadless } from '../src/cli/headless.js';
import { Agent } from '../src/agent/agent.js';
import { AutoMode } from '../src/agent/autopilot.js';
import { Planner, createPlanTool } from '../src/agent/planner.js';
import { taskTool } from '../src/agent/subagent.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { AutoModeConfigSchema, ConfigSchema } from '../src/config/schema.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import { makeTempWorkspace, removeTempWorkspace, writeFiles } from './helpers.js';
import { startMockProvider, type MockProviderServer, type ScriptedTurn } from './mock-provider.js';

let workspace = '';
let orbitHome = '';
let server: MockProviderServer | null = null;

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-headless-');
  orbitHome = await makeTempWorkspace('orbit-headless-home-');
  process.env.ORBIT_HOME = orbitHome;
});

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(orbitHome);
});

/** Collect everything written to stdout/stderr during the run. */
function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

interface HarnessOptions {
  turns: ScriptedTurn[];
  policy?: Record<string, string>;
  subagents?: boolean;
}

async function makeHarness(options: HarnessOptions) {
  server = await startMockProvider(options.turns);

  const config = ConfigSchema.parse({
    permissions: { write: 'ask', shell: 'ask', ...options.policy },
    agent: { maxIterations: 8 },
    optimizer: { enabled: false },
    checkpoints: { enabled: false },
    subagents: { enabled: options.subagents ?? false, maxDepth: 1, maxIterations: 5 },
  });

  const sandbox = new Sandbox({ root: workspace });
  const permissions = new PermissionManager({ policy: config.permissions });
  const planner = new Planner();
  const registry = buildToolRegistry({
    extraTools: [createPlanTool(planner), ...(options.subagents ? [taskTool] : [])],
  });
  const autoMode = new AutoMode(AutoModeConfigSchema.parse({}));

  const agent = new Agent({
    provider: createProvider({
      config: {
        id: 'mock',
        label: 'Mock',
        kind: 'openai-compatible',
        baseURL: server.baseURL,
        model: 'mock-model',
        models: ['mock-model'],
        headers: {},
      },
      apiKey: 'sk-mock-1234567890',
      model: 'mock-model',
    }),
    model: 'mock-model',
    config,
    sandbox,
    permissions,
    registry,
    planner,
    workspace: await detectWorkspace(workspace),
    sessions: new SessionManager(),
    providerLabel: 'Mock',
  });
  await agent.initialize();

  return { agent, autoMode, permissions };
}

describe('headless mode', () => {
  it('prints the answer and exits zero', async () => {
    const { agent, autoMode, permissions } = await makeHarness({
      turns: [{ text: 'The tests pass.' }],
    });
    const output = captureOutput();

    try {
      const result = await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'Do the tests pass?',
        output: 'text',
        verbose: false,
        autoApprove: false,
      });

      expect(result.exitCode).toBe(0);
      expect(output.stdout()).toContain('The tests pass.');
    } finally {
      output.restore();
    }
  });

  it('emits machine-readable JSON', async () => {
    const { agent, autoMode, permissions } = await makeHarness({
      turns: [
        { toolCalls: [{ name: 'list_files', arguments: { path: '.' } }] },
        { text: 'The workspace is empty.' },
      ],
    });
    const output = captureOutput();

    let parsed: any;
    try {
      const result = await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'What is here?',
        output: 'json',
        verbose: false,
        autoApprove: false,
      });
      parsed = JSON.parse(output.stdout());
      expect(result.exitCode).toBe(0);
    } finally {
      output.restore();
    }

    expect(parsed.ok).toBe(true);
    expect(parsed.answer).toBe('The workspace is empty.');
    expect(parsed.tools[0]).toMatchObject({ name: 'list_files', ok: true });
    expect(parsed.usage.totalTokens).toBeGreaterThan(0);
    expect(parsed.model).toBe('mock-model');
  });

  it('denies what it cannot ask about, and tells the model why', async () => {
    const { agent, autoMode, permissions } = await makeHarness({
      turns: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'x.txt', content: 'nope' } }] },
        { text: 'I could not write the file.' },
      ],
      policy: { write: 'ask' },
    });
    const output = captureOutput();

    let parsed: any;
    try {
      await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'Write x.txt',
        output: 'json',
        verbose: false,
        autoApprove: false,
      });
      parsed = JSON.parse(output.stdout());
    } finally {
      output.restore();
    }

    expect(parsed.denied.length).toBeGreaterThan(0);
    await expect(fs.access(path.join(workspace, 'x.txt'))).rejects.toThrow();
  });

  it('approves inside the auto-mode envelope with --yes', async () => {
    const { agent, autoMode, permissions } = await makeHarness({
      turns: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'ok.txt', content: 'written\n' } }] },
        { text: 'Wrote ok.txt.' },
      ],
      policy: { write: 'ask' },
    });
    const output = captureOutput();

    try {
      const result = await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'Write ok.txt',
        output: 'text',
        verbose: false,
        autoApprove: true,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      output.restore();
    }

    expect(await fs.readFile(path.join(workspace, 'ok.txt'), 'utf8')).toBe('written\n');
  });

  it('exits non-zero on a provider failure', async () => {
    const { agent, autoMode, permissions } = await makeHarness({
      turns: [{ httpStatus: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }],
    });
    const output = captureOutput();

    try {
      const result = await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'anything',
        output: 'text',
        verbose: false,
        autoApprove: false,
      });

      expect(result.exitCode).toBe(1);
      expect(output.stderr()).toContain('rejected the API key');
      expect(output.stderr()).not.toContain('sk-mock');
    } finally {
      output.restore();
    }
  });

  it('streams events as JSON lines', async () => {
    const { agent, autoMode, permissions } = await makeHarness({
      turns: [{ text: 'Done.' }],
    });
    const output = captureOutput();

    let lines: any[];
    try {
      await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'go',
        output: 'stream-json',
        verbose: false,
        autoApprove: false,
      });
      lines = output
        .stdout()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } finally {
      output.restore();
    }

    expect(lines.some((line) => line.type === 'assistant')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'result', ok: true });
  });
});

describe('sub-agent delegation', () => {
  it('runs a real sub-agent and returns only its report', async () => {
    await writeFiles(workspace, {
      'src/auth.ts': 'export function authenticate() {\n  return true;\n}\n',
    });

    // Turn 1: main agent delegates. Turns 2-3: the sub-agent works and reports.
    // Turn 4: the main agent answers using the report.
    const { agent, autoMode, permissions } = await makeHarness({
      subagents: true,
      turns: [
        {
          toolCalls: [
            {
              name: 'task',
              arguments: {
                description: 'find auth',
                prompt: 'Find where authenticate is declared and report the file and line.',
              },
            },
          ],
        },
        { toolCalls: [{ name: 'find_symbol', arguments: { name: 'authenticate' } }] },
        { text: 'authenticate is declared in src/auth.ts at line 1.' },
        { text: 'Authentication lives in src/auth.ts:1.' },
      ],
    });

    const output = captureOutput();
    let parsed: any;
    try {
      await runHeadless({
        agent,
        autoMode,
        permissions,
        prompt: 'Where is authentication handled?',
        output: 'json',
        verbose: false,
        autoApprove: false,
      });
      parsed = JSON.parse(output.stdout());
    } finally {
      output.restore();
    }

    expect(parsed.ok).toBe(true);
    expect(parsed.answer).toContain('src/auth.ts:1');

    // The main conversation saw the task tool, not the sub-agent's own calls.
    const mainTools = parsed.tools.map((tool: any) => tool.name);
    expect(mainTools).toContain('task');
    expect(mainTools).not.toContain('find_symbol');

    // The sub-agent's tool output never entered the main context: the last
    // request contains its conclusion, not the raw search result.
    const lastRequest = server!.requests.at(-1)!;
    const serialized = JSON.stringify(lastRequest.messages);
    expect(serialized).toContain('Sub-agent report');
    expect(serialized).toContain('src/auth.ts at line 1');
  });
});
