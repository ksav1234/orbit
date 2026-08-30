import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { Planner, createPlanTool } from '../src/agent/planner.js';
import type { AgentEvent } from '../src/agent/loop.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { ConfigSchema } from '../src/config/schema.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';
import { startMockProvider, type MockProviderServer, type ScriptedTurn } from './mock-provider.js';

/**
 * The MVP acceptance flow: build something, verify it by running it, then find
 * and fix a problem. Every tool result in this test comes from real work on a
 * real temporary workspace.
 */

let workspace = '';
let orbitHome = '';
let server: MockProviderServer | null = null;

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-accept-');
  orbitHome = await makeTempWorkspace('orbit-accept-home-');
  process.env.ORBIT_HOME = orbitHome;
});

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(orbitHome);
});

async function buildAgent(turns: ScriptedTurn[]) {
  server = await startMockProvider(turns);

  const config = ConfigSchema.parse({
    permissions: { write: 'ask', shell: 'ask', delete: 'ask' },
    agent: { maxIterations: 20 },
  });

  const sandbox = new Sandbox({ root: workspace });
  const permissions = new PermissionManager({ policy: config.permissions });

  const approvals: string[] = [];
  permissions.setPrompter(async (request) => {
    approvals.push(`${request.category}:${request.title}`);
    return 'once';
  });

  const planner = new Planner();
  const registry = buildToolRegistry({ extraTools: [createPlanTool(planner)] });

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

  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));

  return { agent, events, approvals, planner };
}

const PACKAGE_JSON = JSON.stringify(
  { name: 'demo-api', version: '1.0.0', type: 'commonjs', scripts: { test: 'node test.js' } },
  null,
  2,
);

const AUTH_SOURCE = `function authenticate(req) {
  const header = req.headers.authorization;
  const token = header;
  if (!token) return { ok: false };
  return { ok: token === 'secret', user: 'demo' };
}

module.exports = { authenticate };
`;

const TEST_SOURCE = `const assert = require('assert');
const { authenticate } = require('./auth.js');

assert.deepStrictEqual(authenticate({ headers: {} }), { ok: false });
assert.strictEqual(authenticate({ headers: { authorization: 'Bearer secret' } }).ok, true);
console.log('2 passed');
`;

describe('MVP acceptance', () => {
  it('creates a project, asks before writing, runs its tests and reports honestly', async () => {
    const { agent, events, approvals, planner } = await buildAgent([
      // 1. Orient.
      { toolCalls: [{ name: 'inspect_project', arguments: {} }] },
      // 2. Declare a plan.
      {
        toolCalls: [
          {
            name: 'update_plan',
            arguments: {
              steps: [
                { title: 'Create the project files', status: 'active' },
                { title: 'Run the tests', status: 'pending' },
              ],
            },
          },
        ],
      },
      // 3. Write the files.
      { toolCalls: [{ name: 'write_file', arguments: { path: 'package.json', content: PACKAGE_JSON } }] },
      { toolCalls: [{ name: 'write_file', arguments: { path: 'auth.js', content: AUTH_SOURCE } }] },
      { toolCalls: [{ name: 'write_file', arguments: { path: 'test.js', content: TEST_SOURCE } }] },
      // 4. Run them for real.
      { toolCalls: [{ name: 'execute_command', arguments: { command: 'node test.js' } }] },
      // 5. Report.
      { text: 'Created package.json, auth.js and test.js. The test run failed.' },
    ]);

    const result = await agent.send('Create a small Node.js API with authentication.');
    expect(result.reason).toBe('complete');

    // Files exist on disk exactly as written.
    for (const file of ['package.json', 'auth.js', 'test.js']) {
      const contents = await fs.readFile(path.join(workspace, file), 'utf8');
      expect(contents.length).toBeGreaterThan(10);
    }

    // Each write and the shell command required explicit approval.
    expect(approvals.filter((entry) => entry.startsWith('write:'))).toHaveLength(3);
    expect(approvals.some((entry) => entry.startsWith('shell:'))).toBe(true);

    // The plan came from the model's own tool call.
    expect(planner.current.map((step) => step.title)).toEqual([
      'Create the project files',
      'Run the tests',
    ]);

    // The test command really ran, and really failed — the seeded auth.js does
    // not strip the "Bearer " prefix, so the assertion fails.
    const run = events.find(
      (event) => event.type === 'tool-end' && event.name === 'execute_command',
    );
    expect(run?.type === 'tool-end' && run.result.ok).toBe(false);
    expect(run?.type === 'tool-end' && run.result.metadata?.exitCode).not.toBe(0);
    expect(run?.type === 'tool-end' && run.result.content).toMatch(/Assertion|assert/i);

    // The failure reached the model, so it cannot claim the tests passed.
    const lastRequest = server!.requests.at(-1)!;
    expect(JSON.stringify(lastRequest.messages)).toMatch(/exit code: [1-9]/);
  });

  it('finds and fixes a real bug, then verifies the fix by re-running the tests', async () => {
    await fs.writeFile(path.join(workspace, 'package.json'), PACKAGE_JSON);
    await fs.writeFile(path.join(workspace, 'auth.js'), AUTH_SOURCE);
    await fs.writeFile(path.join(workspace, 'test.js'), TEST_SOURCE);

    const { agent, events } = await buildAgent([
      { toolCalls: [{ name: 'search_files', arguments: { query: 'authorization', path: '.' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'auth.js' } }] },
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'auth.js',
              old_string: '  const token = header;',
              new_string: "  const token = header?.replace('Bearer ', '');",
            },
          },
        ],
      },
      { toolCalls: [{ name: 'execute_command', arguments: { command: 'node test.js' } }] },
      { text: 'Fixed auth.js:3 — the Bearer prefix was not stripped. Tests now pass.' },
    ]);

    const result = await agent.send('Find and fix any obvious problems in this project.');
    expect(result.reason).toBe('complete');

    // The edit landed in the file.
    const patched = await fs.readFile(path.join(workspace, 'auth.js'), 'utf8');
    expect(patched).toContain("header?.replace('Bearer ', '')");

    // The search actually located the code.
    const search = events.find(
      (event) => event.type === 'tool-end' && event.name === 'search_files',
    );
    expect(search?.type === 'tool-end' && search.result.content).toContain('auth.js');

    // The verification run genuinely passed this time.
    const run = events.find(
      (event) => event.type === 'tool-end' && event.name === 'execute_command',
    );
    expect(run?.type === 'tool-end' && run.result.ok).toBe(true);
    expect(run?.type === 'tool-end' && run.result.content).toContain('2 passed');

    // The diff shown to the user came from the real before/after contents.
    const edit = events.find((event) => event.type === 'tool-end' && event.name === 'edit_file');
    expect(edit?.type === 'tool-end' && edit.result.display.detail).toContain('+  const token');
  });
});
