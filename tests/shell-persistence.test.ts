import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ShellSession } from '../src/tools/shell-session.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { executeCommandTool } from '../src/tools/terminal.js';
import { ToolsConfigSchema } from '../src/config/schema.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { PermissionPolicySchema } from '../src/config/schema.js';
import { detectWorkspace } from '../src/tools/project.js';
import type { ToolContext } from '../src/tools/registry.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

const isWindows = process.platform === 'win32';
let workspace = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-sh-persist-');
  await fs.mkdir(path.join(workspace, 'nested', 'deeper'), { recursive: true });
});

afterEach(async () => {
  await removeTempWorkspace(workspace);
});

/** A tool context sharing one shell session, as a real turn does. */
async function makeContext(
  session: ShellSession,
  overrides: Partial<ToolContext> = {},
): Promise<ToolContext> {
  const sandbox = new Sandbox({ root: workspace });
  return {
    sandbox,
    permissions: new PermissionManager({
      policy: PermissionPolicySchema.parse({}),
      interactive: false,
    }),
    config: ToolsConfigSchema.parse({}),
    cwd: workspace,
    signal: new AbortController().signal,
    progress: () => {},
    workspace: await detectWorkspace(workspace),
    visionAvailable: false,
    shellSession: session,
    ...overrides,
  } as ToolContext;
}

/** Print the working directory, whichever shell is in play. */
const PWD = isWindows ? 'cd' : 'pwd';
const setVar = (name: string, value: string): string =>
  isWindows ? `set ${name}=${value}` : `export ${name}=${value}`;
const readVar = (name: string): string => (isWindows ? `echo %${name}%` : `echo "$${name}"`);

describe('a shell session that remembers', () => {
  it('carries cd into the next command', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    const first = await executeCommandTool.execute({ command: 'cd nested' }, context);
    expect(first.ok).toBe(true);

    const second = await executeCommandTool.execute({ command: PWD }, context);

    expect(second.ok).toBe(true);
    expect(second.content.toLowerCase()).toContain('nested');
    expect(session.currentCwd().toLowerCase()).toContain('nested');
  });

  it('stacks directory changes across several commands', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    await executeCommandTool.execute({ command: 'cd nested' }, context);
    await executeCommandTool.execute({ command: 'cd deeper' }, context);
    const result = await executeCommandTool.execute({ command: PWD }, context);

    expect(result.content.toLowerCase()).toContain('deeper');
  });

  it('carries an exported variable into the next command', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    await executeCommandTool.execute({ command: setVar('ORBIT_TEST_VAR', 'carried') }, context);
    const result = await executeCommandTool.execute({ command: readVar('ORBIT_TEST_VAR') }, context);

    expect(result.content).toContain('carried');
    expect(session.currentEnv().ORBIT_TEST_VAR).toBe('carried');
  });

  // The workspace boundary is the point of the sandbox; a persistent shell is
  // exactly the feature that could erode it one `cd ..` at a time.
  it('refuses to follow a command out of the workspace', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    const escape = isWindows ? 'cd \\' : 'cd /';
    await executeCommandTool.execute({ command: escape }, context);

    expect(session.currentCwd()).toBe(workspace);

    // And the next command still runs inside the workspace.
    const result = await executeCommandTool.execute({ command: PWD }, context);
    expect(result.content).toContain(path.basename(workspace));
  });

  it('lets an explicit cwd argument override where the session had got to', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    await executeCommandTool.execute({ command: 'cd nested' }, context);
    const result = await executeCommandTool.execute({ command: PWD, cwd: '.' }, context);

    expect(result.content).toContain(path.basename(workspace));
    expect(result.content.toLowerCase()).not.toContain('nested');
  });

  it('reports exit codes exactly, wrapper and all', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    const ok = await executeCommandTool.execute({ command: 'exit 0' }, context);
    expect(ok.ok).toBe(true);

    const bad = await executeCommandTool.execute({ command: 'exit 7' }, context);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('7');
  });

  // A command that exits the script skips the state capture. Keeping the old
  // state is right; inventing one would be worse.
  it('keeps the previous directory when a command exits early', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    await executeCommandTool.execute({ command: 'cd nested' }, context);
    const before = session.currentCwd();

    await executeCommandTool.execute({ command: 'exit 3' }, context);

    expect(session.currentCwd()).toBe(before);
  });

  it('starts fresh after a reset', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    await executeCommandTool.execute({ command: 'cd nested' }, context);
    await executeCommandTool.execute({ command: setVar('ORBIT_TEST_VAR', 'x') }, context);
    session.reset();

    expect(session.currentCwd()).toBe(workspace);
    expect(session.currentEnv()).toEqual({});
  });

  it('runs a multi-line command unchanged', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    const command = isWindows ? 'echo one\r\necho two' : 'echo one\necho two';
    const result = await executeCommandTool.execute({ command }, context);

    expect(result.content).toContain('one');
    expect(result.content).toContain('two');
  });

  it('behaves like the old one-shot shell when switched off', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session, {
      config: ToolsConfigSchema.parse({ persistentShell: false }),
    });

    await executeCommandTool.execute({ command: 'cd nested' }, context);
    const result = await executeCommandTool.execute({ command: PWD }, context);

    // Each command starts from the workspace root again.
    expect(result.content.toLowerCase()).not.toContain('nested');
    expect(session.currentCwd()).toBe(workspace);
  });

  it('does not carry the whole parent environment forward', async () => {
    const session = new ShellSession(new Sandbox({ root: workspace }));
    const context = await makeContext(session);

    await executeCommandTool.execute({ command: setVar('ORBIT_TEST_VAR', 'one') }, context);

    // Only what differs from this process, so the override set stays small and
    // inspectable rather than a copy of everything.
    const carried = Object.keys(session.currentEnv());
    expect(carried).toContain('ORBIT_TEST_VAR');
    expect(carried.length).toBeLessThan(20);
    expect(carried).not.toContain('PWD');
  });
});
