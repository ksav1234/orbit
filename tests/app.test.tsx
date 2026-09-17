import React from 'react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { App } from '../src/cli/app.js';
import { Agent } from '../src/agent/agent.js';
import { Planner, createPlanTool } from '../src/agent/planner.js';
import { AutoMode } from '../src/agent/autopilot.js';
import { AutoModeConfigSchema, CheckpointsConfigSchema, type AutoModeConfig } from '../src/config/schema.js';
import { CheckpointManager } from '../src/checkpoints/manager.js';
import { newSessionRecord } from '../src/sessions/manager.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { ConfigManager } from '../src/config/manager.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import { createTheme } from '../src/ui/theme.js';
import { makeTempWorkspace, removeTempWorkspace, writeFiles } from './helpers.js';
import { startMockProvider, type MockProviderServer, type ScriptedTurn } from './mock-provider.js';

/** Terminal key sequences, built from char codes so no control byte sits in the source. */
const ESCAPE = String.fromCharCode(27);
const DOWN = `${ESCAPE}[B`;

let workspace = '';
let orbitHome = '';
let server: MockProviderServer | null = null;

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-app-');
  orbitHome = await makeTempWorkspace('orbit-app-home-');
  process.env.ORBIT_HOME = orbitHome;
  process.env.NO_COLOR = '1';
});

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env.ORBIT_HOME;
  delete process.env.NO_COLOR;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(orbitHome);
});

async function mountApp(
  turns: ScriptedTurn[],
  policy: Record<string, string> = {},
  autoModeOverrides: Partial<AutoModeConfig> = {},
  appOverrides: { animate?: boolean } = {},
) {
  server = await startMockProvider(turns);

  const configManager = new ConfigManager();
  await configManager.load();
  await configManager.addProvider(
    {
      id: 'mock',
      label: 'Mock',
      kind: 'openai-compatible',
      baseURL: server.baseURL,
      model: 'mock-model',
      models: ['mock-model', 'mock-model-mini'],
      headers: {},
    },
    'sk-mock-key-abcdef123456',
  );
  await configManager.update((draft) => {
    Object.assign(draft.permissions, { write: 'allow', shell: 'allow', ...policy });
    draft.agent.maxIterations = 6;
  });

  const sandbox = new Sandbox({ root: workspace });
  const permissions = new PermissionManager({ policy: configManager.permissions() });
  const planner = new Planner();
  const registry = buildToolRegistry({ extraTools: [createPlanTool(planner)] });
  const autoMode = new AutoMode(
    AutoModeConfigSchema.parse({ maxContinuations: 2, ...autoModeOverrides }),
  );

  const session = newSessionRecord({
    workspace,
    provider: { id: 'mock', label: 'Mock', model: 'mock-model' },
  });
  const checkpoints = new CheckpointManager({
    config: CheckpointsConfigSchema.parse({}),
    sessionId: session.id,
    workspaceRoot: workspace,
  });

  const provider = createProvider({
    config: configManager.getProvider('mock')!,
    apiKey: configManager.apiKey('mock'),
    model: 'mock-model',
  });

  const agent = new Agent({
    provider,
    model: 'mock-model',
    config: configManager.get(),
    sandbox,
    permissions,
    registry,
    planner,
    workspace: await detectWorkspace(workspace),
    sessions: new SessionManager(),
    session,
    providerLabel: 'Mock',
    checkpoints,
  });
  await agent.initialize();

  const instance = render(
    <App
      agent={agent}
      config={configManager}
      sessions={new SessionManager()}
      registry={registry}
      permissions={permissions}
      sandbox={sandbox}
      autoMode={autoMode}
      theme={createTheme({ color: 'never', unicode: 'on' })}
      showBanner
      animate={appOverrides.animate ?? false}
      debug={false}
      warnings={[]}
      createProviderFor={(id, model) => ({
        provider: createProvider({
          config: configManager.getProvider(id)!,
          apiKey: configManager.apiKey(id),
          model: model ?? 'mock-model',
        }),
        label: 'Mock',
      })}
    />,
  );

  return {
    instance,
    agent,
    permissions,
    autoMode,
    output: () => stripAnsi(instance.frames.join('\n')),
  };
}

// Generous by design: these render a real Ink app while other test files run
// in parallel, so a short deadline measures machine load, not correctness.
async function waitFor(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the expected UI state');
}

/**
 * Press a key and wait for the UI to react, re-sending if it does not.
 *
 * Ink attaches its stdin handler in an effect, which runs *after* the frame
 * announcing the prompt is already visible. Under load that gap is wide enough
 * for a single write to land in it and be dropped, which turns a one-shot
 * keypress into a coin flip -- the failure looks like a 25s hang with no
 * progress rather than a slow pass.
 *
 * Only safe for keys where pressing twice means the same as pressing once
 * (deny, cancel, dismiss). Do not use it for arrows or text.
 */
async function pressUntil(
  instance: { stdin: { write(data: string): void } },
  key: string,
  done: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    instance.stdin.write(key);
    for (let i = 0; i < 8 && Date.now() < deadline; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (done()) return;
    }
  }
  throw new Error(`timed out after pressing ${JSON.stringify(key)}`);
}

const ENTER = '\r';

describe('Orbit app', () => {
  it('renders the startup screen with the workspace identity', async () => {
    const { instance, output } = await mountApp([{ text: 'hi' }]);
    await waitFor(() => output().includes('AI that works inside your workspace.'));

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(output()).toContain('mock-model');
    expect(output()).toContain('Mock');
    expect(frame).toContain('What would you like to build?');
    instance.unmount();
  });

  it('runs a full prompt → tool → answer cycle driven from the keyboard', async () => {
    const { instance, output } = await mountApp([
      {
        toolCalls: [
          { name: 'write_file', arguments: { path: 'hello.txt', content: 'hello world\n' } },
        ],
      },
      { text: 'Created hello.txt for you.' },
    ]);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('create hello.txt');
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('create hello.txt'));
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Created hello.txt for you.'));

    // The transcript shows the tool that really ran…
    expect(output()).toContain('write_file');
    expect(output()).toContain('hello.txt');

    // …and the file exists on disk with the exact contents.
    const written = await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8');
    expect(written).toBe('hello world\n');

    instance.unmount();
  });

  it('asks for approval and does not run the tool when denied', async () => {
    const { instance, output } = await mountApp(
      [
        {
          toolCalls: [{ name: 'write_file', arguments: { path: 'blocked.txt', content: 'nope' } }],
        },
        { text: 'I did not write the file.' },
      ],
      { write: 'ask' },
    );

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('write blocked.txt');
    instance.stdin.write(ENTER);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('Permission required'));
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('blocked.txt');

    await pressUntil(instance, 'n', () => output().includes('I did not write the file.'));
    await expect(fs.access(path.join(workspace, 'blocked.txt'))).rejects.toThrow();
    expect(output()).toContain('denied');

    instance.unmount();
  });

  it('reports what each model request cost, from provider-reported usage', async () => {
    const { instance, output } = await mountApp([
      { text: 'the answer', reasoningTokens: 18, cachedTokens: 40 },
    ]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('a question');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('the answer'));
    await waitFor(() => /up\s+\d/.test(output()));

    const frame = output();
    // Prompt and completion, plus how much of the window is now in use.
    expect(frame).toMatch(/up\s+[\d.]+k?/);
    expect(frame).toMatch(/down\s+[\d.]+k?/);
    expect(frame).toContain('ctx');
    // The thinking share and the cache hit, both provider-reported.
    expect(frame).toContain('18 thinking');
    expect(frame).toContain('40 cached');

    instance.unmount();
  });

  it('applies only the hunks the user picked', async () => {
    const original = [
      'alpha',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'omega',
    ].join('\n');
    await writeFiles(workspace, { 'both.txt': original + '\n' });

    // The model proposes two separate changes: one wanted, one not.
    const proposed = original.replace('alpha', 'ALPHA').replace('omega', 'OMEGA');
    const { instance, output } = await mountApp(
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'both.txt', content: proposed + '\n' } }] },
        { text: 'Applied what you kept.' },
      ],
      { write: 'ask' },
    );

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('change both ends');
    instance.stdin.write(ENTER);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('Permission required'));
    // The prompt offers to pick, because there is more than one hunk.
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Pick changes (2)');

    await pressUntil(instance, 'p', () =>
      stripAnsi(instance.lastFrame() ?? '').includes('space toggle'),
    );

    // Everything starts accepted; reject the second hunk and apply.
    instance.stdin.write(DOWN);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('apply 2 of 2'));
    instance.stdin.write(' ');
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('apply 1 of 2'));
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Applied what you kept.'));

    const written = await fs.readFile(path.join(workspace, 'both.txt'), 'utf8');
    // The kept change landed; the rejected one did not.
    expect(written).toContain('ALPHA');
    expect(written).toContain('omega');
    expect(written).not.toContain('OMEGA');
    expect(output()).toContain('applied 1 of 2 changes');

    instance.unmount();
  });

  it('says plainly when it stopped without finishing', async () => {
    // A model that only ever calls tools never reaches a final answer, so the
    // turn ends at the step limit rather than at an answer.
    const turns = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [
        { name: 'write_file', arguments: { path: `f${i}.txt`, content: String(i) } },
      ],
    }));
    const { instance, output } = await mountApp(turns, { write: 'allow' }, {}, {});

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('do a long job');
    instance.stdin.write(ENTER);

    // Silence here would make a half-done task look finished.
    await waitFor(() => /without finishing|not done/i.test(output()));
    expect(output()).toMatch(/continue/i);

    instance.unmount();
  });

  it('handles slash commands without contacting the model', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/help');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Keyboard'));
    expect(output()).toContain('/compact');
    expect(output()).toContain('Ctrl+C');
    expect(server!.requests).toHaveLength(0);

    instance.unmount();
  });

  it('reports an unknown slash command instead of sending it to the model', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/nope');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Unknown command'));
    expect(server!.requests).toHaveLength(0);

    instance.unmount();
  });

  it('shows the plan the model declares', async () => {
    const { instance, output } = await mountApp([
      {
        toolCalls: [
          {
            name: 'update_plan',
            arguments: {
              steps: [
                { title: 'Inspect the workspace', status: 'done' },
                { title: 'Write the fix', status: 'active' },
              ],
            },
          },
        ],
      },
      { text: 'Plan is set.' },
    ]);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('plan the work');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Plan is set.'));
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Write the fix');

    instance.unmount();
  });

  it('shows the launch banner with model capabilities and a welcome', async () => {
    const { instance, output } = await mountApp([{ text: 'hi' }]);
    await waitFor(() => output().includes('AI that works inside your workspace.'));

    const frames = output();
    expect(frames).toMatch(/Good (morning|afternoon|evening)|Working late/);
    expect(frames).toContain('mock-model');
    expect(frames).toContain('Auto mode');
    expect(frames).toContain('ctrl+shift+a');
    // Capability badges come from the provider, not from a hardcoded string.
    expect(frames).toContain('tools');

    instance.unmount();
  });

  it('toggles auto mode from the keyboard and shows it in the status bar', async () => {
    const { instance, output, autoMode } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    expect(autoMode.enabled).toBe(false);

    instance.stdin.write('\x07'); // Ctrl+G
    await waitFor(() => autoMode.enabled);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('AUTO'));
    expect(output()).toContain('Auto mode ON');

    instance.stdin.write('\x07');
    await waitFor(() => !autoMode.enabled && output().includes('Auto mode OFF'));

    instance.unmount();
  });

  it('auto-approves a write in auto mode instead of prompting', async () => {
    const { instance, output, autoMode } = await mountApp(
      [
        {
          toolCalls: [{ name: 'write_file', arguments: { path: 'auto.txt', content: 'written\n' } }],
        },
        { text: 'Wrote auto.txt.' },
      ],
      { write: 'ask' },
    );

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/auto on');
    instance.stdin.write(ENTER);
    await waitFor(() => autoMode.enabled);

    instance.stdin.write('write the file');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Wrote auto.txt.'));

    // No approval prompt was shown, and the write really happened.
    expect(output()).not.toContain('Permission required');
    expect(await fs.readFile(path.join(workspace, 'auto.txt'), 'utf8')).toBe('written\n');

    instance.unmount();
  });

  it('still asks before deleting, even in auto mode', async () => {
    await writeFiles(workspace, { 'old.txt': 'bye\n' });

    const { instance, autoMode } = await mountApp(
      [
        { toolCalls: [{ name: 'delete_file', arguments: { path: 'old.txt' } }] },
        { text: 'Nothing was deleted.' },
      ],
      { delete: 'ask' },
    );

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('/auto on');
    instance.stdin.write(ENTER);
    await waitFor(() => autoMode.enabled);

    instance.stdin.write('delete old.txt');
    instance.stdin.write(ENTER);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('Destructive operation'));
    await pressUntil(instance, 'n', () =>
      stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'),
    );
    // The file survives a denial.
    expect(await fs.readFile(path.join(workspace, 'old.txt'), 'utf8')).toBe('bye\n');

    instance.unmount();
  });

  it('keeps working on its own while the plan has open steps', async () => {
    const { instance, output, autoMode } = await mountApp([
      // Turn 1: declare a plan with an open step, then stop.
      {
        toolCalls: [
          {
            name: 'update_plan',
            arguments: {
              steps: [
                { title: 'Create the file', status: 'active' },
                { title: 'Verify it', status: 'pending' },
              ],
            },
          },
        ],
      },
      { text: 'Plan set.' },
      // Turn 2 arrives without the user typing anything.
      {
        toolCalls: [{ name: 'write_file', arguments: { path: 'auto-step.txt', content: 'done\n' } }],
      },
      {
        toolCalls: [
          {
            name: 'update_plan',
            arguments: {
              steps: [
                { title: 'Create the file', status: 'done' },
                { title: 'Verify it', status: 'done' },
              ],
            },
          },
        ],
      },
      { text: 'All steps complete.' },
    ]);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('/auto on');
    instance.stdin.write(ENTER);
    await waitFor(() => autoMode.enabled);

    instance.stdin.write('do the work');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('All steps complete.'), 15_000);

    expect(output()).toContain('continuing on its own');
    expect(await fs.readFile(path.join(workspace, 'auto-step.txt'), 'utf8')).toBe('done\n');
    // It stopped once the plan was finished rather than looping.
    expect(autoMode.continuationCount).toBe(1);

    instance.unmount();
  });

  it('reports token usage on request', async () => {
    const { instance, output } = await mountApp([{ text: 'hello' }]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('hi');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('hello'));

    instance.stdin.write('/usage');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Token usage'));
    expect(output()).toContain('Session in');
    expect(output()).toContain('Auto-optimization');

    instance.unmount();
  });

  it('undoes the file changes from the last turn', async () => {
    await writeFiles(workspace, { 'a.txt': 'original\n' });

    const { instance, output } = await mountApp([
      {
        toolCalls: [
          { name: 'write_file', arguments: { path: 'a.txt', content: 'replaced\n' } },
        ],
      },
      { text: 'Replaced the file.' },
    ]);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('replace a.txt');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Replaced the file.'));

    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('replaced\n');

    instance.stdin.write('/undo');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('restored'));

    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('original\n');
    instance.unmount();
  });

  it('lists checkpoints and reports when there is nothing to undo', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/undo');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('No file changes'));

    instance.stdin.write('/checkpoints');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('No file changes recorded'));

    instance.unmount();
  });

  it('rejects a write with an instruction instead of a flat denial', async () => {
    const { instance, output } = await mountApp(
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'wrong.txt', content: 'x' } }] },
        { text: 'Understood, I will use the other file.' },
      ],
      { write: 'ask' },
    );

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('write a file');
    instance.stdin.write(ENTER);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('Permission required'));
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('[E] Edit instruction');

    // Re-sent until the editor opens. Safe here because the assertions below are
    // about the redirect reaching the model, not the exact text typed into it.
    await pressUntil(instance, 'e', () =>
      stripAnsi(instance.lastFrame() ?? '').includes('What should Orbit do instead?'),
    );
    instance.stdin.write('use right.txt instead');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Understood, I will use the other file.'));

    // Nothing was written, and the model was told what the user wants.
    await expect(fs.access(path.join(workspace, 'wrong.txt'))).rejects.toThrow();
    expect(JSON.stringify(server!.requests[1]!.messages)).toContain('use right.txt instead');

    instance.unmount();
  });

  it('switches the colour theme', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/theme ember');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Theme set to ember'));

    instance.stdin.write('/theme');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('currently'));
    expect(output()).toContain('forest');

    instance.unmount();
  });

  it('shows web access status without a key', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/web');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Web access'));

    expect(output()).toContain('not set');
    expect(output()).toContain('orbit web key');

    instance.unmount();
  });

  it('reports that no MCP servers are configured, with an example', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/mcp');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('No MCP servers are configured'));
    expect(output()).toContain('server-filesystem');

    instance.unmount();
  });

  it('exports the conversation to Markdown', async () => {
    const { instance, output } = await mountApp([{ text: 'Here is the answer.' }]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('ask something');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Here is the answer.'));

    instance.stdin.write('/export notes.md');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Exported'));

    const markdown = await fs.readFile(path.join(workspace, 'notes.md'), 'utf8');
    expect(markdown).toContain('# Orbit session');
    expect(markdown).toContain('ask something');
    expect(markdown).toContain('Here is the answer.');
    expect(markdown).not.toContain('sk-mock-key');

    instance.unmount();
  });

  it('lists authorized workspace roots', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/workspace');
    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Authorized roots'));
    expect(output()).toContain('Everything outside these is refused');

    instance.unmount();
  });

  it('changes the model from a picker', async () => {
    const { instance, output, agent } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    expect(agent.model).toBe('mock-model');

    instance.stdin.write('/model');
    instance.stdin.write(ENTER);

    // The picker lists what the provider actually reports.
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('Model  Mock'));
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('mock-model');
    expect(frame).toContain('mock-model-mini');
    expect(frame).toContain('current');

    // Move the cursor onto the second entry, confirming it landed there before
    // committing. An arrow key is not idempotent, so this checks the highlight
    // rather than re-sending blind — the keystroke can be dropped in the gap
    // between the frame appearing and Ink attaching its input handler.
    const cursorOnMini = (): boolean => {
      const lines = stripAnsi(instance.lastFrame() ?? '').split('\n');
      return lines.some((line) => line.includes('→') && line.includes('mock-model-mini'));
    };
    await pressUntil(instance, DOWN, cursorOnMini);

    await pressUntil(instance, ENTER, () =>
      output().includes('Model switched to mock-model-mini'),
    );
    expect(agent.model).toBe('mock-model-mini');

    instance.unmount();
  });

  it('leaves the model alone when the picker is cancelled', async () => {
    const { instance, agent } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/model');
    instance.stdin.write(ENTER);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('Model  Mock'));

    await pressUntil(instance, ESCAPE, () =>
      stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'),
    );

    expect(agent.model).toBe('mock-model');
    instance.unmount();
  });

  it('still accepts a model name directly', async () => {
    const { instance, output, agent } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/model mock-model-mini');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Model switched to mock-model-mini'));
    expect(agent.model).toBe('mock-model-mini');
    instance.unmount();
  });

  it('opens a provider picker showing key status', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/provider');
    instance.stdin.write(ENTER);

    // Wait for the picker's own footer, not the banner's "Provider" row.
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('enter select'));
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('Mock');
    expect(frame).toContain('key set');

    await pressUntil(instance, ESCAPE, () =>
      stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'),
    );
    instance.unmount();
  });

  it('sets an API key with hidden input', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));

    instance.stdin.write('/key');
    instance.stdin.write(ENTER);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('API key  Mock'));

    instance.stdin.write('sk-brand-new-key-987654321');
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('••••'));

    // The key itself is never rendered.
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('sk-brand-new-key');

    instance.stdin.write(ENTER);
    await waitFor(() => output().includes('Key saved for Mock'));
    expect(output()).not.toContain('sk-brand-new-key');

    instance.unmount();
  });

  it('plays the intro, then settles into the static banner', async () => {
    const { instance, output } = await mountApp([], {}, {}, { animate: true });

    // While the intro plays the prompt is hidden, so a keystroke cannot be
    // swallowed by an input the user cannot see.
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('by -Ksav_Ydv'));
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('What would you like to build?');

    // Once it settles, the banner is committed to the scrollback and the
    // prompt comes back.
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    expect(output()).toContain('AI that works inside your workspace.');
    expect(output()).toContain('Workspace');

    instance.unmount();
  });

  it('skips the intro on a keypress', async () => {
    const { instance } = await mountApp([], {}, {}, { animate: true });
    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('ORBIT') ||
      stripAnsi(instance.lastFrame() ?? '').includes('█'));

    // The placeholder disappears as soon as anything is typed, so waiting on it
    // would depend on exactly one keystroke landing. The session header is
    // stable once the intro is over.
    await pressUntil(instance, ' ', () =>
      stripAnsi(instance.lastFrame() ?? '').includes('Workspace'),
    );

    instance.unmount();
  });

  it('shows the byline in the static banner too', async () => {
    const { instance, output } = await mountApp([]);
    await waitFor(() => output().includes('AI that works inside your workspace.'));
    expect(output()).toContain('by -Ksav_Ydv');
    instance.unmount();
  });

  it('surfaces a provider error in a readable box', async () => {
    const { instance, output } = await mountApp([
      { httpStatus: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) },
    ]);

    await waitFor(() => stripAnsi(instance.lastFrame() ?? '').includes('What would you like to build?'));
    instance.stdin.write('hello');
    instance.stdin.write(ENTER);

    await waitFor(() => output().includes('Authentication Error'));
    expect(output()).toContain('rejected the API key');
    expect(output()).not.toContain('sk-mock-key');

    instance.unmount();
  });
});
