import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { Planner } from '../src/agent/planner.js';
import type { AgentEvent } from '../src/agent/loop.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { CheckpointManager } from '../src/checkpoints/manager.js';
import { ConfigSchema, VerifyConfigSchema, CheckpointsConfigSchema } from '../src/config/schema.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import { checksFor, detectChecks, failureReport, runChecks } from '../src/agent/verify.js';
import { makeTempWorkspace, removeTempWorkspace, writeFiles } from './helpers.js';
import { startMockProvider, type MockProviderServer, type ScriptedTurn } from './mock-provider.js';

let workspace = '';
let home = '';
let server: MockProviderServer | undefined;

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-verify-');
  home = await makeTempWorkspace('orbit-verify-home-');
  process.env.ORBIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ORBIT_HOME;
  await server?.close();
  server = undefined;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(home);
});

// ── Working out what to run ───────────────────────────────────────────────

describe('deciding what counts as verification', () => {
  const base = {
    root: '/w',
    name: 'w',
    languages: [],
    frameworks: [],
    manifests: [],
    scripts: {},
    git: false,
    topLevel: [],
  };

  it('prefers the cheapest useful signal first', () => {
    const checks = detectChecks({
      ...base,
      packageManager: 'npm',
      scripts: { typecheck: 'tsc', build: 'tsc -p .', test: 'vitest run' },
    });
    // A type error is found in seconds and makes a test run pointless anyway.
    expect(checks.map((check) => check.label)).toEqual(['typecheck', 'test']);
  });

  it('falls back to build when there is no typecheck', () => {
    const checks = detectChecks({ ...base, packageManager: 'npm', scripts: { build: 'x', test: 'y' } });
    expect(checks.map((check) => check.label)).toEqual(['build', 'test']);
  });

  it('uses the project own package manager', () => {
    const checks = detectChecks({ ...base, packageManager: 'pnpm', scripts: { test: 'x' } });
    expect(checks[0]?.command).toBe('pnpm run test');
  });

  it('knows the conventional commands for projects without npm scripts', () => {
    expect(detectChecks({ ...base, manifests: ['Cargo.toml'] }).map((c) => c.command)).toEqual([
      'cargo check',
      'cargo test',
    ]);
    expect(detectChecks({ ...base, manifests: ['go.mod'] })[1]?.command).toBe('go test ./...');
    expect(detectChecks({ ...base, testFramework: 'pytest' })[0]?.command).toBe('pytest -q');
  });

  // Running a dev server or a deploy script unprompted is not verification.
  it('finds nothing rather than guessing', () => {
    expect(detectChecks({ ...base, packageManager: 'npm', scripts: { start: 'node .', deploy: 'ship' } })).toEqual([]);
  });

  it('lets configured commands win over detection', () => {
    const config = VerifyConfigSchema.parse({ commands: ['make check'] });
    const checks = checksFor(config, { ...base, packageManager: 'npm', scripts: { test: 'x' } });
    expect(checks).toEqual([{ label: 'check 1', command: 'make check' }]);
  });
});

// ── Running them ──────────────────────────────────────────────────────────

describe('running the checks', () => {
  const opts = { timeoutMs: 30_000, maxOutputChars: 20_000 };

  it('passes when the commands pass', async () => {
    const result = await runChecks({
      checks: [{ label: 'a', command: 'node -e "process.exit(0)"' }],
      cwd: workspace,
      ...opts,
    });
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.signature).toBe('');
  });

  it('captures the output of a failure as evidence', async () => {
    const result = await runChecks({
      checks: [{ label: 'test', command: 'node -e "console.log(\'expected 1 got 2\'); process.exit(1)"' }],
      cwd: workspace,
      ...opts,
    });
    expect(result.passed).toBe(false);
    expect(result.outcomes[0]?.output).toContain('expected 1 got 2');
  });

  // Once the type-check is red, the test output is noise rather than information.
  it('stops at the first failure', async () => {
    const result = await runChecks({
      checks: [
        { label: 'first', command: 'node -e "process.exit(1)"' },
        { label: 'second', command: 'node -e "process.exit(0)"' },
      ],
      cwd: workspace,
      ...opts,
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.check.label).toBe('first');
  });

  it('gives identical failures an identical signature, and different ones different', async () => {
    const run = (message: string) =>
      runChecks({
        checks: [{ label: 't', command: `node -e "console.log('${message}'); process.exit(1)"` }],
        cwd: workspace,
        ...opts,
      });

    const first = await run('cannot find name foo');
    const again = await run('cannot find name foo');
    const other = await run('cannot find name bar');

    // Used to notice the agent is going in circles.
    expect(first.signature).toBe(again.signature);
    expect(first.signature).not.toBe(other.signature);
  });

  // Line numbers shifting by one is not progress.
  it('ignores line numbers when comparing failures', async () => {
    const run = (line: number) =>
      runChecks({
        checks: [{ label: 't', command: `node -e "console.log('error at line ${line}'); process.exit(1)"` }],
        cwd: workspace,
        ...opts,
      });
    expect((await run(12)).signature).toBe((await run(13)).signature);
  });

  it('treats a command that cannot run at all as nothing to report', async () => {
    const result = await runChecks({
      checks: [{ label: 'missing', command: 'definitely-not-a-real-binary-xyz' }],
      cwd: workspace,
      timeoutMs: 20_000,
      maxOutputChars: 5_000,
    });
    // A missing binary is a setup problem, not something to ask the model to
    // fix — and asking would invite it to edit the check instead.
    expect(result.outcomes[0]?.unavailable).toBe(true);
    // Nothing was actually verified, so it must not claim a passing run.
    expect(result.ran).toBe(false);
  });

  // The dangerous direction: reading a real failure as "the check is missing"
  // would silently turn a broken change into a verified one.
  it('does not mistake a failing check for a missing one', async () => {
    const noisy = 'expected module to be found, but it was not found in the registry';
    const result = await runChecks({
      checks: [{ label: 'test', command: `node -e "console.log('${noisy}'); process.exit(1)"` }],
      cwd: workspace,
      timeoutMs: 20_000,
      maxOutputChars: 5_000,
    });

    expect(result.outcomes[0]?.unavailable).toBeUndefined();
    expect(result.passed).toBe(false);
    expect(result.ran).toBe(true);
  });

  it('tells the model to fix the cause, not the check', async () => {
    const result = await runChecks({
      checks: [{ label: 'test', command: 'node -e "console.log(\'boom\'); process.exit(1)"' }],
      cwd: workspace,
      ...opts,
    });
    const report = failureReport(result, 1, 2);
    expect(report).toContain('boom');
    expect(report).toContain('attempt 1 of 2');
    expect(report).toMatch(/fix the cause/i);
  });
});

// ── The agent fixing its own work ─────────────────────────────────────────

async function makeAgent(turns: ScriptedTurn[], verify: Record<string, unknown>) {
  server = await startMockProvider(turns);
  const config = ConfigSchema.parse({
    permissions: { write: 'allow', shell: 'allow' },
    optimizer: { enabled: false, autoDetectWindow: false },
    agent: { maxIterations: 8 },
    verify: { enabled: true, ...verify },
  });

  const checkpoints = new CheckpointManager({
    config: CheckpointsConfigSchema.parse({}),
    sessionId: 'verify-session',
    workspaceRoot: workspace,
  });

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
        supportsTools: true,
        supportsVision: false,
      },
      apiKey: 'sk-mock-key-1234567890',
      model: 'mock-model',
    }),
    model: 'mock-model',
    config,
    sandbox: new Sandbox({ root: workspace }),
    permissions: new PermissionManager({ policy: config.permissions }),
    registry: buildToolRegistry({}),
    planner: new Planner(),
    workspace: await detectWorkspace(workspace),
    sessions: new SessionManager(),
    providerLabel: 'Mock',
    checkpoints,
  });
  await agent.initialize();

  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, events, checkpoints };
}

/**
 * A check that fails with a different message each run, driven by a counter
 * file.
 *
 * The stuck-loop guard strips digits before comparing failures, so varying the
 * numbers would still read as 'the same failure' — correctly. The variation has
 * to be in letters to represent genuine progress between rounds.
 */
const varyingFailure = (counter: string): string => {
  const file = counter.replace(/\\/g, '/');
  return (
    `node -e "const fs=require('fs');let n=0;` +
    `try{n=+fs.readFileSync('${file}','utf8')}catch{};` +
    `fs.writeFileSync('${file}',String(n+1));` +
    `console.log('error '+'abcdefgh'[n%8]);process.exit(1)"`
  );
};

/** A check that passes only once the marker file says the fix landed. */
const gate = (file: string): string =>
  `node -e "const fs=require('fs');process.exit(fs.existsSync('${file.replace(/\\/g, '/')}')?0:1)"`;

describe('the agent checking its own work', () => {
  it('runs the checks and says so when they pass', async () => {
    const { agent, events } = await makeAgent(
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
        { text: 'done' },
      ],
      { commands: ['node -e "process.exit(0)"'] },
    );

    await agent.send('make a change');

    expect(
      events.some((event) => event.type === 'notice' && /Verified/.test(event.message)),
    ).toBe(true);
  });

  // The whole point: the agent is handed its own failure and fixes it.
  it('feeds the failure back and lets the model repair it', async () => {
    const marker = path.join(workspace, 'fixed.txt');
    const { agent, events } = await makeAgent(
      [
        // First attempt: writes something that does not satisfy the check.
        { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'broken' } }] },
        { text: 'done' },
        // After being shown the failure, it writes the file that makes it pass.
        { toolCalls: [{ name: 'write_file', arguments: { path: 'fixed.txt', content: 'ok' } }] },
        { text: 'fixed it' },
      ],
      { commands: [gate(marker)], maxRounds: 2 },
    );

    await agent.send('make it work');

    expect(await fs.readFile(marker, 'utf8')).toBe('ok');
    const notices = events.filter((event) => event.type === 'notice').map((e) => e.message);
    expect(notices.some((m) => /Verified/.test(m))).toBe(true);

    // The point is not that the loop ran again — it is that the model was given
    // the actual failure to work from. Assert on what the provider received.
    const sent = JSON.stringify(server!.requests);
    expect(sent).toContain('did not pass verification');
    expect(sent).toMatch(/Fix the cause/i);
  });

  it('gives up after the configured rounds and says the checks still fail', async () => {
    const { agent, events } = await makeAgent(
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: '1' } }] },
        { text: 'attempt' },
        { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: '2' } }] },
        { text: 'attempt' },
        { toolCalls: [{ name: 'write_file', arguments: { path: 'c.txt', content: '3' } }] },
        { text: 'attempt' },
      ],
      { commands: [varyingFailure(path.join(workspace, 'counter'))], maxRounds: 2 },
    );

    await agent.send('try');

    const notices = events.filter((event) => event.type === 'notice').map((e) => e.message);
    expect(notices.some((m) => /still failing/i.test(m))).toBe(true);

    // Each round tells the model which attempt it is on, so it knows how much
    // rope is left.
    const sent = JSON.stringify(server!.requests);
    expect(sent).toMatch(/attempt 1 of 2/);
    expect(sent).toMatch(/attempt 2 of 2/);
  });

  // Another round would spend a request to reach the same place.
  it('stops early when the same failure comes back unchanged', async () => {
    const { agent, events } = await makeAgent(
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: '1' } }] },
        { text: 'attempt' },
        { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: '2' } }] },
        { text: 'attempt' },
      ],
      { commands: ['node -e "console.log(\'same error every time\'); process.exit(1)"'], maxRounds: 3 },
    );

    await agent.send('try');

    const notices = events.filter((event) => event.type === 'notice').map((e) => e.message);
    expect(notices.some((m) => /same failure came back/i.test(m))).toBe(true);
  });

  // The bug this guards: change detection used to come from the checkpoint
  // manager, which reports nothing when checkpointing is off — so turning
  // verification on did nothing at all, silently.
  it('still verifies when checkpointing is switched off', async () => {
    server = await startMockProvider([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
      { text: 'done' },
    ]);
    const config = ConfigSchema.parse({
      permissions: { write: 'allow' },
      optimizer: { enabled: false, autoDetectWindow: false },
      checkpoints: { enabled: false },
      verify: { enabled: true, commands: ['node -e "process.exit(0)"'] },
    });
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
          supportsTools: true,
          supportsVision: false,
        },
        apiKey: 'sk-mock-key-1234567890',
        model: 'mock-model',
      }),
      model: 'mock-model',
      config,
      sandbox: new Sandbox({ root: workspace }),
      permissions: new PermissionManager({ policy: config.permissions }),
      registry: buildToolRegistry({}),
      planner: new Planner(),
      workspace: await detectWorkspace(workspace),
      sessions: new SessionManager(),
      providerLabel: 'Mock',
      checkpoints: new CheckpointManager({
        config: CheckpointsConfigSchema.parse({ enabled: false }),
        sessionId: 'off',
        workspaceRoot: workspace,
      }),
    });
    await agent.initialize();
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await agent.send('make a change');

    expect(events.some((event) => event.type === 'notice' && /Verified/.test(event.message))).toBe(
      true,
    );
  });

  it('does nothing when the turn changed no files', async () => {
    const { agent, events } = await makeAgent([{ text: 'just talking' }], {
      commands: ['node -e "process.exit(1)"'],
    });

    await agent.send('hello');

    expect(events.some((event) => event.type === 'notice' && /Verif/.test(event.message))).toBe(
      false,
    );
  });

  it('does nothing when it is switched off', async () => {
    server = await startMockProvider([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
      { text: 'done' },
    ]);
    const config = ConfigSchema.parse({
      permissions: { write: 'allow' },
      optimizer: { enabled: false, autoDetectWindow: false },
      verify: { enabled: false, commands: ['node -e "process.exit(1)"'] },
    });
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
          supportsTools: true,
          supportsVision: false,
        },
        apiKey: 'sk-mock-key-1234567890',
        model: 'mock-model',
      }),
      model: 'mock-model',
      config,
      sandbox: new Sandbox({ root: workspace }),
      permissions: new PermissionManager({ policy: config.permissions }),
      registry: buildToolRegistry({}),
      planner: new Planner(),
      workspace: await detectWorkspace(workspace),
      sessions: new SessionManager(),
      providerLabel: 'Mock',
    });
    await agent.initialize();
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await agent.send('make a change');

    expect(events.some((event) => event.type === 'notice' && /Verif/.test(event.message))).toBe(
      false,
    );
  });

  it('rolls the turn back when asked to and the checks never pass', async () => {
    await writeFiles(workspace, { 'kept.txt': 'original\n' });

    const { agent, events } = await makeAgent(
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'kept.txt', content: 'wrecked\n' } }] },
        { text: 'done' },
        { toolCalls: [{ name: 'write_file', arguments: { path: 'kept.txt', content: 'still wrong\n' } }] },
        { text: 'done' },
      ],
      {
        commands: [varyingFailure(path.join(workspace, 'counter'))],
        maxRounds: 1,
        rollbackOnFailure: true,
      },
    );

    await agent.send('change it');

    // The workspace is left as it was rather than half-fixed.
    expect(await fs.readFile(path.join(workspace, 'kept.txt'), 'utf8')).toBe('original\n');
    expect(
      events.some((event) => event.type === 'notice' && /Rolled the turn back/i.test(event.message)),
    ).toBe(true);
  });
});

// ── Not going quiet ───────────────────────────────────────────────────────

describe('running out of steps', () => {
  // Hitting the iteration limit used to end the turn with no word of it, so a
  // half-done task looked finished. Stopping short has to be visible.
  it('reports the reason so a caller can tell it did not finish', async () => {
    // A model that only ever calls tools never reaches a final answer.
    const turns = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ name: 'write_file', arguments: { path: `f${i}.txt`, content: String(i) } }],
    }));
    server = await startMockProvider(turns);

    const config = ConfigSchema.parse({
      permissions: { write: 'allow' },
      optimizer: { enabled: false, autoDetectWindow: false },
      agent: { maxIterations: 3 },
    });
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
          supportsTools: true,
          supportsVision: false,
        },
        apiKey: 'sk-mock-key-1234567890',
        model: 'mock-model',
      }),
      model: 'mock-model',
      config,
      sandbox: new Sandbox({ root: workspace }),
      permissions: new PermissionManager({ policy: config.permissions }),
      registry: buildToolRegistry({}),
      planner: new Planner(),
      workspace: await detectWorkspace(workspace),
      sessions: new SessionManager(),
      providerLabel: 'Mock',
    });
    await agent.initialize();

    const result = await agent.send('keep going forever');

    // The reason is on the result, not buried — the UI and headless output both
    // key off it to say the task is incomplete.
    expect(result.reason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
  });
});
