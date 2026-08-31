import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { Planner } from '../src/agent/planner.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { ConfigSchema, HookSchema, type HookConfig } from '../src/config/schema.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import {
  HookRunner,
  describeHook,
  hookEnvironment,
  hookMatchesTool,
} from '../src/hooks/runner.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';
import { startMockProvider, type MockProviderServer, type ScriptedTurn } from './mock-provider.js';

const isWindows = process.platform === 'win32';

/** A shell one-liner that appends a line to a file, on either platform. */
function appendTo(file: string, text: string): string {
  return isWindows
    ? `powershell -NoProfile -Command "Add-Content -LiteralPath '${file}' -Value '${text}'"`
    : `printf '%s\\n' '${text}' >> '${file}'`;
}

function hook(partial: Partial<HookConfig> & Pick<HookConfig, 'on' | 'command'>): HookConfig {
  return HookSchema.parse(partial);
}

describe('matching hooks to tools', () => {
  it('matches a literal name, and everything when the list is empty', () => {
    const literal = hook({ on: 'post-tool', command: 'x', tools: ['write_file'] });
    expect(hookMatchesTool(literal, 'write_file')).toBe(true);
    expect(hookMatchesTool(literal, 'read_file')).toBe(false);

    const any = hook({ on: 'post-tool', command: 'x' });
    expect(hookMatchesTool(any, 'anything')).toBe(true);
  });

  it('treats a slash-wrapped entry as a regular expression', () => {
    const pattern = hook({ on: 'post-tool', command: 'x', tools: ['/^(write|edit)_file$/'] });
    expect(hookMatchesTool(pattern, 'write_file')).toBe(true);
    expect(hookMatchesTool(pattern, 'edit_file')).toBe(true);
    expect(hookMatchesTool(pattern, 'delete_file')).toBe(false);
  });

  // A typo in a pattern must not silently widen the hook to every tool, which
  // for a blocking hook would block everything.
  it('matches nothing when the pattern is malformed', () => {
    const broken = hook({ on: 'pre-tool', command: 'x', tools: ['/([unclosed/'] });
    expect(hookMatchesTool(broken, 'write_file')).toBe(false);
  });

  it('names a hook whether or not the user did', () => {
    expect(describeHook(hook({ on: 'turn-end', command: 'npm test', name: 'tests' }))).toBe('tests');
    expect(describeHook(hook({ on: 'turn-end', command: 'npm test' }))).toContain('npm test');
    // A long command is elided rather than printed in full.
    const long = describeHook(hook({ on: 'turn-end', command: 'x'.repeat(200) }));
    expect(long.length).toBeLessThan(60);
  });
});

describe('the environment a hook receives', () => {
  it('exposes the event, workspace, model and tool details', () => {
    const env = hookEnvironment({
      event: 'post-tool',
      workspace: path.join(path.sep, 'work', 'proj'),
      sessionId: 'sess-1',
      model: 'mock-model',
      provider: 'Mock',
      tool: 'write_file',
      toolArgs: { path: 'src/a.ts', content: 'x' },
      file: path.join(path.sep, 'work', 'proj', 'src', 'a.ts'),
      ok: true,
    });

    expect(env.ORBIT_EVENT).toBe('post-tool');
    expect(env.ORBIT_MODEL).toBe('mock-model');
    expect(env.ORBIT_TOOL).toBe('write_file');
    expect(env.ORBIT_TOOL_OK).toBe('1');
    expect(env.ORBIT_FILE_RELATIVE).toBe(path.join('src', 'a.ts'));
    expect(JSON.parse(env.ORBIT_TOOL_ARGS!)).toMatchObject({ path: 'src/a.ts' });
  });

  it('leaves out what does not apply, rather than sending empty strings', () => {
    const env = hookEnvironment({
      event: 'session-start',
      workspace: '/w',
      sessionId: 's',
      model: 'm',
      provider: 'p',
    });
    expect(env.ORBIT_TOOL).toBeUndefined();
    expect(env.ORBIT_FILE).toBeUndefined();
    expect(env.ORBIT_TURN).toBeUndefined();
  });
});

describe('running hooks', () => {
  let workspace = '';

  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(workspace);
  });

  const payload = (event: HookConfig['on'], extra: Record<string, unknown> = {}) => ({
    event,
    workspace,
    sessionId: 'sess',
    model: 'mock-model',
    provider: 'Mock',
    ...extra,
  });

  it('actually executes the command, in the workspace', async () => {
    const marker = path.join(workspace, 'ran.txt');
    const runner = new HookRunner({
      enabled: true,
      entries: [hook({ on: 'turn-end', command: appendTo(marker, 'turn-end') })],
    });

    const outcomes = await runner.run('turn-end', payload('turn-end'));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.code).toBe(0);
    expect(await fs.readFile(marker, 'utf8')).toContain('turn-end');
  });

  it('runs hooks for one event in configured order, not in parallel', async () => {
    const marker = path.join(workspace, 'order.txt');
    const runner = new HookRunner({
      enabled: true,
      entries: [
        hook({ on: 'turn-end', command: appendTo(marker, 'first') }),
        hook({ on: 'turn-end', command: appendTo(marker, 'second') }),
      ],
    });

    await runner.run('turn-end', payload('turn-end'));

    const lines = (await fs.readFile(marker, 'utf8')).trim().split(/\r?\n/);
    expect(lines).toEqual(['first', 'second']);
  });

  it('ignores hooks for other events and disabled ones', async () => {
    const marker = path.join(workspace, 'never.txt');
    const runner = new HookRunner({
      enabled: true,
      entries: [
        hook({ on: 'session-start', command: appendTo(marker, 'wrong-event') }),
        hook({ on: 'turn-end', command: appendTo(marker, 'disabled'), enabled: false }),
      ],
    });

    const outcomes = await runner.run('turn-end', payload('turn-end'));

    expect(outcomes).toHaveLength(0);
    await expect(fs.readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('honours the master switch', async () => {
    const runner = new HookRunner({
      enabled: false,
      entries: [hook({ on: 'turn-end', command: 'echo hi' })],
    });
    expect(runner.has('turn-end')).toBe(false);
    expect(runner.count()).toBe(0);
    expect(await runner.run('turn-end', payload('turn-end'))).toHaveLength(0);
  });

  it('passes the payload on stdin as JSON', async () => {
    const out = path.join(workspace, 'stdin.json');
    const command = isWindows
      ? `powershell -NoProfile -Command "$input | Set-Content -LiteralPath '${out}'"`
      : `cat > '${out}'`;
    const runner = new HookRunner({ enabled: true, entries: [hook({ on: 'turn-end', command })] });

    await runner.run('turn-end', payload('turn-end', { turn: 3 }));

    const parsed = JSON.parse(await fs.readFile(out, 'utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: 'turn-end', turn: 3, model: 'mock-model' });
  });

  it('reports a command that does not exist instead of throwing', async () => {
    const runner = new HookRunner({
      enabled: true,
      entries: [hook({ on: 'turn-end', command: 'definitely-not-a-real-binary-xyz', shell: false })],
    });

    const outcomes = await runner.run('turn-end', payload('turn-end'));

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    // Either the spawn fails outright or the shell reports a non-zero exit;
    // both are "it did not work", and neither may throw.
    expect(outcome.error !== undefined || outcome.code !== 0).toBe(true);
  });

  it('reports every outcome to the reporter', async () => {
    const seen: Array<number | null> = [];
    const runner = new HookRunner({
      enabled: true,
      entries: [
        hook({ on: 'turn-end', command: 'exit 0' }),
        hook({ on: 'turn-end', command: 'exit 3' }),
      ],
    });
    runner.onOutcome((outcome) => seen.push(outcome.code));

    await runner.run('turn-end', payload('turn-end'));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(0);
    expect(seen[1]).not.toBe(0);
  });
});

describe('blocking pre-tool hooks', () => {
  let workspace = '';

  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });
  afterEach(async () => {
    await removeTempWorkspace(workspace);
  });

  const payload = {
    event: 'pre-tool' as const,
    workspace: '',
    sessionId: 's',
    model: 'm',
    provider: 'p',
    tool: 'write_file',
  };

  it('vetoes when a blocking hook exits non-zero', async () => {
    const runner = new HookRunner({
      enabled: true,
      entries: [
        hook({ on: 'pre-tool', command: 'exit 1', blocking: true, name: 'guard' }),
      ],
    });

    const veto = await runner.vetoFor({ ...payload, workspace });

    expect(veto?.hookName).toBe('guard');
    expect(veto?.reason).toBeTruthy();
  });

  it('does not veto when the blocking hook succeeds', async () => {
    const runner = new HookRunner({
      enabled: true,
      entries: [hook({ on: 'pre-tool', command: 'exit 0', blocking: true })],
    });
    expect(await runner.vetoFor({ ...payload, workspace })).toBeUndefined();
  });

  // A logging hook must not gain veto power just by failing.
  it('ignores a failing hook that is not marked blocking', async () => {
    const runner = new HookRunner({
      enabled: true,
      entries: [hook({ on: 'pre-tool', command: 'exit 9', blocking: false })],
    });
    expect(await runner.vetoFor({ ...payload, workspace })).toBeUndefined();
  });

  it('only consults hooks whose tool matcher applies', async () => {
    const runner = new HookRunner({
      enabled: true,
      entries: [
        hook({ on: 'pre-tool', command: 'exit 1', blocking: true, tools: ['delete_file'] }),
      ],
    });
    expect(await runner.vetoFor({ ...payload, workspace })).toBeUndefined();
    expect(
      await runner.vetoFor({ ...payload, workspace, tool: 'delete_file' }),
    ).toBeDefined();
  });
});

// ── The agent actually firing them ────────────────────────────────────────

describe('hooks in a real turn', () => {
  let server: MockProviderServer | undefined;
  let workspace = '';

  beforeEach(async () => {
    workspace = await makeTempWorkspace();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await removeTempWorkspace(workspace);
  });

  async function makeAgent(entries: HookConfig[], turns: ScriptedTurn[]) {
    server = await startMockProvider(turns);
    const config = ConfigSchema.parse({
      permissions: { write: 'allow', shell: 'allow' },
      optimizer: { enabled: false, autoDetectWindow: false },
      hooks: { enabled: true, entries },
    });

    const registry = buildToolRegistry({});
    const runner = new HookRunner(config.hooks);
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
      registry,
      planner: new Planner(),
      workspace: await detectWorkspace(workspace),
      sessions: new SessionManager(),
      providerLabel: 'Mock',
      hooks: runner,
    });
    await agent.initialize();
    return { agent, registry };
  }

  it('fires turn-start and turn-end around a real turn', async () => {
    const marker = path.join(workspace, 'lifecycle.txt');
    const { agent } = await makeAgent(
      [
        hook({ on: 'turn-start', command: appendTo(marker, 'start') }),
        hook({ on: 'turn-end', command: appendTo(marker, 'end') }),
      ],
      [{ text: 'done' }],
    );

    await agent.send('hello');

    const lines = (await fs.readFile(marker, 'utf8')).trim().split(/\r?\n/);
    expect(lines).toEqual(['start', 'end']);
  });

  it('runs a post-tool hook after the tool really wrote the file', async () => {
    const target = path.join(workspace, 'note.txt');
    const log = path.join(workspace, 'formatted.txt');
    const { agent } = await makeAgent(
      [
        hook({
          on: 'post-tool',
          tools: ['write_file'],
          // Reads the file the tool just wrote, proving ordering.
          command: isWindows
            ? `powershell -NoProfile -Command "Get-Content -LiteralPath $env:ORBIT_FILE | Set-Content -LiteralPath '${log}'"`
            : `cat "$ORBIT_FILE" > '${log}'`,
        }),
      ],
      [
        {
          toolCalls: [
            { name: 'write_file', arguments: { path: 'note.txt', content: 'hello from the tool' } },
          ],
        },
        { text: 'written' },
      ],
    );

    await agent.send('write a note');

    expect(await fs.readFile(target, 'utf8')).toContain('hello from the tool');
    // The hook saw the finished file, not an empty or partial one.
    expect(await fs.readFile(log, 'utf8')).toContain('hello from the tool');
  });

  it('lets a blocking pre-tool hook stop the write from happening at all', async () => {
    const target = path.join(workspace, 'blocked.txt');
    const { agent } = await makeAgent(
      [
        hook({
          on: 'pre-tool',
          tools: ['write_file'],
          command: 'exit 1',
          blocking: true,
          name: 'no-writes',
        }),
      ],
      [
        {
          toolCalls: [{ name: 'write_file', arguments: { path: 'blocked.txt', content: 'nope' } }],
        },
        { text: 'understood' },
      ],
    );

    const events: string[] = [];
    agent.subscribe((event) => {
      if (event.type === 'tool-denied') events.push(event.reason);
    });

    await agent.send('write a file');

    // The file was never created, and the model was told why.
    await expect(fs.readFile(target, 'utf8')).rejects.toThrow();
    expect(events.join(' ')).toContain('no-writes');
  });

  it('leaves the turn alone when a hook fails', async () => {
    const { agent } = await makeAgent(
      [hook({ on: 'turn-end', command: 'exit 7' })],
      [{ text: 'the answer' }],
    );

    const result = await agent.send('hello');

    expect(result.reason).toBe('complete');
    expect(agent.context.messages().some((m) => m.role === 'assistant')).toBe(true);
  });
});
