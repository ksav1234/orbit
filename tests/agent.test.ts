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
import { makeTempWorkspace, removeTempWorkspace, writeFiles } from './helpers.js';
import { startMockProvider, type MockProviderServer, type ScriptedTurn } from './mock-provider.js';

let workspace = '';
let orbitHome = '';
let server: MockProviderServer | null = null;

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-agent-');
  orbitHome = await makeTempWorkspace('orbit-home-');
  process.env.ORBIT_HOME = orbitHome;
});

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(orbitHome);
});

interface HarnessOptions {
  turns: ScriptedTurn[];
  permissionAnswer?: 'once' | 'session' | 'deny';
  policyOverrides?: Partial<Record<'write' | 'shell' | 'delete', 'allow' | 'ask' | 'deny'>>;
  maxIterations?: number;
  /** Simulate a model with no native function calling. */
  nativeTools?: boolean;
  /** Simulate a vision-capable model. */
  vision?: boolean;
  /** Force a specific reply ceiling so optimizer behaviour is observable. */
  maxTokens?: number;
  optimizer?: Record<string, unknown>;
}

async function makeAgent(options: HarnessOptions) {
  server = await startMockProvider(options.turns);

  const config = ConfigSchema.parse({
    permissions: { write: 'allow', shell: 'allow', delete: 'ask', ...options.policyOverrides },
    agent: {
      maxIterations: options.maxIterations ?? 10,
      parallelReadTools: true,
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    },
    // Off unless a test is specifically exercising it, so budgets stay predictable.
    optimizer: options.optimizer ?? { enabled: false },
  });

  const sandbox = new Sandbox({ root: workspace });
  const permissions = new PermissionManager({ policy: config.permissions });
  if (options.permissionAnswer) permissions.setPrompter(async () => options.permissionAnswer!);

  const planner = new Planner();
  const registry = buildToolRegistry({ extraTools: [createPlanTool(planner)] });

  const provider = createProvider({
    config: {
      id: 'mock',
      label: 'Mock',
      kind: 'openai-compatible',
      baseURL: server.baseURL,
      model: 'mock-model',
      models: ['mock-model'],
      headers: {},
      supportsTools: options.nativeTools ?? true,
      supportsVision: options.vision ?? false,
    },
    apiKey: 'sk-mock-key-1234567890',
    model: 'mock-model',
  });

  const agent = new Agent({
    provider,
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

  return { agent, events, registry, permissions, planner };
}

describe('agent loop', () => {
  it('actually executes the tools it reports, and feeds real results back to the model', async () => {
    const { agent, events } = await makeAgent({
      turns: [
        {
          toolCalls: [
            {
              name: 'write_file',
              arguments: { path: 'server.js', content: 'console.log("listening");\n' },
            },
          ],
        },
        {
          toolCalls: [
            { name: 'execute_command', arguments: { command: 'node -e "console.log(6*7)"' } },
          ],
        },
        { text: 'Created server.js and verified it runs.' },
      ],
    });

    const result = await agent.send('Create a tiny server and check it runs.');

    expect(result.reason).toBe('complete');

    // The file exists on disk with exactly the requested contents.
    const written = await fs.readFile(path.join(workspace, 'server.js'), 'utf8');
    expect(written).toBe('console.log("listening");\n');

    // The command result came from a real process, not the model.
    const commandEvent = events.find(
      (event) => event.type === 'tool-end' && event.name === 'execute_command',
    );
    expect(commandEvent).toBeDefined();
    if (commandEvent?.type === 'tool-end') {
      expect(commandEvent.result.content).toContain('42');
      expect(commandEvent.result.metadata?.exitCode).toBe(0);
    }

    // The third request carried both tool results back to the model.
    const finalRequest = server!.requests[2]!;
    const toolMessages = finalRequest.messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(JSON.stringify(toolMessages)).toContain('42');

    const finalMessage = events.find((event) => event.type === 'assistant-message');
    expect(finalMessage).toMatchObject({ text: 'Created server.js and verified it runs.' });
  });

  it('does not execute a tool the user denied', async () => {
    const { agent, events } = await makeAgent({
      turns: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'nope.txt', content: 'blocked' } }] },
        { text: 'Understood, I did not write the file.' },
      ],
      policyOverrides: { write: 'ask' },
      permissionAnswer: 'deny',
    });

    await agent.send('Write a file.');

    await expect(fs.access(path.join(workspace, 'nope.txt'))).rejects.toThrow();

    const denied = events.find((event) => event.type === 'tool-denied');
    expect(denied).toBeDefined();

    // The model is told the denial happened so it can adapt.
    const secondRequest = server!.requests[1]!;
    expect(JSON.stringify(secondRequest.messages)).toContain('Permission denied');
  });

  it('reports an unknown tool back to the model instead of failing the turn', async () => {
    const { agent, events } = await makeAgent({
      turns: [
        { toolCalls: [{ name: 'reed_file', arguments: { path: 'a.txt' } }] },
        { text: 'Sorry, I used the wrong tool name.' },
      ],
    });

    const result = await agent.send('Read a file.');
    expect(result.reason).toBe('complete');

    const toolEnd = events.find((event) => event.type === 'tool-end');
    expect(toolEnd?.type === 'tool-end' && toolEnd.result.ok).toBe(false);
    expect(JSON.stringify(server!.requests[1]!.messages)).toContain('read_file');
  });

  it('rejects malformed tool arguments with a recoverable message', async () => {
    const { agent, events } = await makeAgent({
      turns: [
        { toolCalls: [{ name: 'read_file', arguments: { wrong_key: 123 } }] },
        { text: 'Retrying with the right arguments.' },
      ],
    });

    await agent.send('Read something.');

    const toolEnd = events.find((event) => event.type === 'tool-end');
    expect(toolEnd?.type === 'tool-end' && toolEnd.result.ok).toBe(false);
    expect(toolEnd?.type === 'tool-end' && toolEnd.result.content).toMatch(/Invalid arguments/);
  });

  it('runs the tools the model asks for, in order, across iterations', async () => {
    await writeFiles(workspace, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });

    const { agent, events } = await makeAgent({
      turns: [
        {
          toolCalls: [
            { name: 'read_file', arguments: { path: 'a.txt' } },
            { name: 'read_file', arguments: { path: 'b.txt' } },
          ],
        },
        { text: 'Both files read.' },
      ],
    });

    await agent.send('Read both files.');

    const results = events.filter((event) => event.type === 'tool-end');
    expect(results).toHaveLength(2);
    const combined = JSON.stringify(server!.requests[1]!.messages);
    expect(combined).toContain('alpha');
    expect(combined).toContain('beta');
  });

  it('records the plan the model declares', async () => {
    const { agent, planner } = await makeAgent({
      turns: [
        {
          toolCalls: [
            {
              name: 'update_plan',
              arguments: {
                steps: [
                  { title: 'Inspect the project', status: 'done' },
                  { title: 'Fix the bug', status: 'active' },
                ],
              },
            },
          ],
        },
        { text: 'Plan recorded.' },
      ],
    });

    await agent.send('Plan the work.');

    expect(planner.current).toHaveLength(2);
    expect(planner.current[1]).toMatchObject({ title: 'Fix the bug', status: 'active' });
  });

  it('stops at the iteration limit rather than looping forever', async () => {
    const turns: ScriptedTurn[] = Array.from({ length: 6 }, () => ({
      toolCalls: [{ name: 'git_status', arguments: {} }],
    }));

    const { agent } = await makeAgent({ turns, maxIterations: 3 });
    const result = await agent.send('Loop forever.');

    expect(result.reason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
  });

  it('cancels an in-flight turn', async () => {
    const { agent, events } = await makeAgent({
      turns: [
        { toolCalls: [{ name: 'execute_command', arguments: { command: 'node -e "setTimeout(()=>{},5000)"' } }] },
        { text: 'unreachable' },
      ],
    });

    const promise = agent.send('Run something slow.');
    const cancelled = await new Promise<boolean>((resolve) => {
      const timer = setInterval(() => {
        if (events.some((event) => event.type === 'tool-start')) {
          clearInterval(timer);
          resolve(agent.cancel());
        }
      }, 20);
    });

    expect(cancelled).toBe(true);
    const result = await promise;
    expect(result.reason).toBe('cancelled');
  });

  it('persists the session without storing credentials', async () => {
    const { agent } = await makeAgent({ turns: [{ text: 'Hello.' }] });
    await agent.send('Say hello.');

    const sessions = new SessionManager();
    const list = await sessions.list();
    expect(list.length).toBeGreaterThan(0);

    const file = await fs.readFile(list[0]!.file, 'utf8');
    expect(file).not.toContain('sk-mock-key');
    expect(file).toContain('Say hello.');
  });

  it('drives tools through the text protocol when the model has no native tool calling', async () => {
    await writeFiles(workspace, { 'notes.md': 'the answer is 42\n' });

    const { agent, events } = await makeAgent({
      nativeTools: false,
      turns: [
        {
          text: 'I will read the file.\n<orbit:tool name="read_file">\n{"path": "notes.md"}\n</orbit:tool>',
        },
        { text: 'The notes say the answer is 42.' },
      ],
    });

    const result = await agent.send('What do the notes say?');
    expect(result.reason).toBe('complete');

    // The tool ran for real, and the protocol block was stripped from the text.
    const toolEnd = events.find((event) => event.type === 'tool-end');
    expect(toolEnd?.type === 'tool-end' && toolEnd.name).toBe('read_file');
    expect(toolEnd?.type === 'tool-end' && toolEnd.result.content).toContain('the answer is 42');

    const shownText = events
      .filter((event) => event.type === 'assistant-message')
      .map((event) => (event.type === 'assistant-message' ? event.text : ''))
      .join('\n');
    expect(shownText).not.toContain('<orbit:tool');

    // No tool schemas are sent to a model that cannot use them.
    expect(server!.requests[0]!.tools).toBeUndefined();
    // The protocol instructions are in the system prompt instead.
    expect(JSON.stringify(server!.requests[0]!.messages[0])).toContain('orbit:tool');
  });

  it('keeps tool results paired with their call when a tool returns images', async () => {
    // 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await fs.writeFile(path.join(workspace, 'a.png'), png);
    await fs.writeFile(path.join(workspace, 'b.png'), png);

    const { agent } = await makeAgent({
      vision: true,
      turns: [
        {
          toolCalls: [
            { name: 'read_image', arguments: { path: 'a.png' } },
            { name: 'read_image', arguments: { path: 'b.png' } },
          ],
        },
        { text: 'Both diagrams look fine.' },
      ],
    });

    const result = await agent.send('Look at a.png and b.png');
    expect(result.reason).toBe('complete');

    const messages = server!.requests[1]!.messages as Array<Record<string, any>>;
    const assistantIndex = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantIndex).toBeGreaterThan(-1);

    // Both tool results must follow the assistant message with no other role
    // between them, or providers reject the request.
    expect(messages[assistantIndex + 1]?.role).toBe('tool');
    expect(messages[assistantIndex + 2]?.role).toBe('tool');

    // The images arrive afterwards, as their own user message.
    const attachment = messages[assistantIndex + 3];
    expect(attachment?.role).toBe('user');
    expect(JSON.stringify(attachment?.content)).toContain('image_url');
    expect(JSON.stringify(attachment?.content)).toContain('a.png');
  });

  it('accumulates token usage across turns, not just the last one', async () => {
    const { agent } = await makeAgent({
      turns: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
    });

    await agent.send('first');
    const afterFirst = { ...agent.usage };
    await agent.send('second');

    // The mock reports 100 in / 25 out per request.
    expect(afterFirst.promptTokens).toBe(100);
    expect(agent.usage.promptTokens).toBe(200);
    expect(agent.usage.completionTokens).toBe(50);
    expect(agent.usageTracker.sessionTotals().requests).toBe(2);
  });

  it('sizes the reply budget from observed usage when the optimizer is on', async () => {
    const { agent } = await makeAgent({
      maxTokens: 8192,
      optimizer: { enabled: true, minResponseTokens: 1024 },
      turns: [{ text: 'short' }, { text: 'short' }, { text: 'short' }],
    });

    await agent.send('one');
    await agent.send('two');
    await agent.send('three');

    const budgets = server!.requests.map((request) => request.max_tokens as number);

    // First request has nothing to learn from, so it uses the configured value.
    expect(budgets[0]).toBe(8192);
    // Later ones shrink towards the observed 25-token replies, with a floor.
    expect(budgets[2]).toBeLessThan(8192);
    expect(budgets[2]).toBeGreaterThanOrEqual(1024);
  });

  it('leaves the configured budget alone when the optimizer is off', async () => {
    const { agent } = await makeAgent({
      maxTokens: 4096,
      optimizer: { enabled: false },
      turns: [{ text: 'a' }, { text: 'b' }],
    });

    await agent.send('one');
    await agent.send('two');

    for (const request of server!.requests) {
      expect(request.max_tokens).toBe(4096);
    }
  });

  it('surfaces a provider failure as a friendly error', async () => {
    const { agent, events } = await makeAgent({
      turns: [{ httpStatus: 401, body: JSON.stringify({ error: { message: 'invalid key' } }) }],
    });

    const result = await agent.send('Do something.');

    expect(result.reason).toBe('error');
    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent?.type === 'error' && errorEvent.error.kind).toBe('auth');
  });
});
