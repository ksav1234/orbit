import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CheckpointManager } from '../src/checkpoints/manager.js';
import { CheckpointsConfigSchema } from '../src/config/schema.js';
import { executeCommandTool } from '../src/tools/terminal.js';
import {
  diffTrees,
  isGitWorkTree,
  readTreeFile,
  snapshotWorkTree,
} from '../src/checkpoints/worktree.js';
import { runCommand } from '../src/util/process.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace, writeFiles } from './helpers.js';

let workspace = '';
let home = '';

/** Set up a real git repository with one commit, so snapshots have a baseline. */
async function initRepo(root: string): Promise<boolean> {
  const run = async (args: string[]) => {
    const result = await runCommand({
      command: 'git',
      args,
      cwd: root,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Orbit Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Orbit Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
    return result.code === 0;
  };

  if (!(await run(['init', '-q']))) return false;
  await run(['config', 'user.email', 'test@example.invalid']);
  await run(['config', 'user.name', 'Orbit Test']);
  await run(['config', 'commit.gpgsign', 'false']);
  await writeFiles(root, { 'tracked.txt': 'original\n', '.gitignore': 'ignored/\n' });
  if (!(await run(['add', '-A']))) return false;
  return run(['commit', '-qm', 'initial']);
}

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-sh-');
  home = await makeTempWorkspace('orbit-sh-home-');
  process.env.ORBIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(home);
});

function makeCheckpoints(overrides: Record<string, unknown> = {}): CheckpointManager {
  return new CheckpointManager({
    config: CheckpointsConfigSchema.parse(overrides),
    sessionId: 'shell-session',
    workspaceRoot: workspace,
  });
}

describe('snapshotting a working tree with git', () => {
  it('produces a tree hash, and a different one after a change', async () => {
    expect(await initRepo(workspace)).toBe(true);
    expect(await isGitWorkTree(workspace)).toBe(true);

    const before = await snapshotWorkTree(workspace);
    expect(before).toMatch(/^[0-9a-f]{7,64}$/);

    await writeFiles(workspace, { 'tracked.txt': 'changed\n' });
    const after = await snapshotWorkTree(workspace);

    expect(after).toMatch(/^[0-9a-f]{7,64}$/);
    expect(after).not.toBe(before);
  });

  it('reports what changed, with the right status for each path', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const before = (await snapshotWorkTree(workspace))!;

    await writeFiles(workspace, { 'tracked.txt': 'edited\n', 'brand-new.txt': 'hello\n' });
    await fs.writeFile(path.join(workspace, 'doomed.txt'), 'x\n', 'utf8');
    const mid = (await snapshotWorkTree(workspace))!;
    await fs.rm(path.join(workspace, 'doomed.txt'));

    const after = (await snapshotWorkTree(workspace))!;

    const firstPass = await diffTrees(workspace, before, mid);
    expect(firstPass).toEqual(
      expect.arrayContaining([
        { path: 'tracked.txt', status: 'modified' },
        { path: 'brand-new.txt', status: 'added' },
        { path: 'doomed.txt', status: 'added' },
      ]),
    );

    const secondPass = await diffTrees(workspace, mid, after);
    expect(secondPass).toEqual([{ path: 'doomed.txt', status: 'deleted' }]);
  });

  // Snapshotting node_modules on every shell command would be unusable, and
  // git already knows what to leave out.
  it('leaves ignored files out of the snapshot', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const before = (await snapshotWorkTree(workspace))!;

    await fs.mkdir(path.join(workspace, 'ignored'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'ignored', 'junk.bin'), 'noise\n', 'utf8');
    const after = (await snapshotWorkTree(workspace))!;

    expect(after).toBe(before);
  });

  it('reads a file back byte-for-byte, including binary content', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x7f, 0x80]);
    await fs.writeFile(path.join(workspace, 'blob.bin'), bytes);

    const tree = (await snapshotWorkTree(workspace))!;
    const read = await readTreeFile(workspace, tree, 'blob.bin', 1_000_000);

    expect(read && 'content' in read).toBe(true);
    expect((read as { content: Buffer }).content.equals(bytes)).toBe(true);
  });

  it('says a file is too large rather than loading it', async () => {
    expect(await initRepo(workspace)).toBe(true);
    await fs.writeFile(path.join(workspace, 'big.txt'), 'x'.repeat(200_000), 'utf8');
    const tree = (await snapshotWorkTree(workspace))!;

    const read = await readTreeFile(workspace, tree, 'big.txt', 1_000);

    expect(read).toEqual({ tooLarge: true });
  });

  it('returns nothing at all outside a git repository', async () => {
    expect(await isGitWorkTree(workspace)).toBe(false);
    expect(await snapshotWorkTree(workspace)).toBeUndefined();
  });
});

describe('undoing what a shell command did', () => {
  it('reverts a file the command overwrote', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    const result = await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Set-Content -LiteralPath tracked.txt -Value wrecked"'
            : "printf 'wrecked\\n' > tracked.txt",
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toContain('wrecked');

    const checkpoint = await checkpoints.commitTurn('run a command');
    expect(checkpoint?.files.map((file) => file.path)).toContain('tracked.txt');

    await checkpoints.undoLast();

    expect(await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('deletes a file the command created', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Set-Content -LiteralPath generated.txt -Value hi"'
            : "printf 'hi\\n' > generated.txt",
      },
      context,
    );
    expect(await fs.readFile(path.join(workspace, 'generated.txt'), 'utf8')).toContain('hi');

    await checkpoints.commitTurn('generate');
    await checkpoints.undoLast();

    await expect(fs.readFile(path.join(workspace, 'generated.txt'), 'utf8')).rejects.toThrow();
  });

  it('restores a file the command deleted', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Remove-Item -LiteralPath tracked.txt -Force"'
            : 'rm tracked.txt',
      },
      context,
    );
    await expect(fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8')).rejects.toThrow();

    await checkpoints.commitTurn('delete it');
    await checkpoints.undoLast();

    expect(await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  // A command that changed nothing must not manufacture a checkpoint, or every
  // `ls` would push a real change out of undo range.
  it('records nothing for a command that changed nothing', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    await executeCommandTool.execute({ command: 'git status --porcelain' }, context);

    expect(checkpoints.hasPendingChanges).toBe(false);
    expect(await checkpoints.commitTurn('look around')).toBeNull();
  });

  it('still records files written by a command that then failed', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    const result = await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Set-Content -LiteralPath half.txt -Value partial; exit 3"'
            : "printf 'partial\\n' > half.txt; exit 3",
      },
      context,
    );

    expect(result.ok).toBe(false);
    await checkpoints.commitTurn('half-finished');
    await checkpoints.undoLast();

    await expect(fs.readFile(path.join(workspace, 'half.txt'), 'utf8')).rejects.toThrow();
  });

  it('does nothing when the feature is switched off', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints({ shellCommands: false });
    const context = makeToolContext({ root: workspace, checkpoints });

    await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Set-Content -LiteralPath tracked.txt -Value wrecked"'
            : "printf 'wrecked\\n' > tracked.txt",
      },
      context,
    );

    expect(checkpoints.hasPendingChanges).toBe(false);
  });

  // Without a repo there is nothing to diff against. The command must still run
  // normally rather than failing because checkpointing could not happen.
  it('runs the command normally outside a git repository', async () => {
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    const result = await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Set-Content -LiteralPath free.txt -Value hi"'
            : "printf 'hi\\n' > free.txt",
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, 'free.txt'), 'utf8')).toContain('hi');
    expect(checkpoints.hasPendingChanges).toBe(false);
  });

  // A file tool captures state from the start of the turn, which is earlier and
  // therefore more correct than a mid-turn shell snapshot.
  it('does not let a shell snapshot overwrite an earlier tool capture', async () => {
    expect(await initRepo(workspace)).toBe(true);
    const checkpoints = makeCheckpoints();
    const context = makeToolContext({ root: workspace, checkpoints });

    // The tool records "original", then a command changes the file again.
    await checkpoints.capture(path.join(workspace, 'tracked.txt'), 'modified');
    await fs.writeFile(path.join(workspace, 'tracked.txt'), 'first edit\n', 'utf8');

    await executeCommandTool.execute(
      {
        command:
          process.platform === 'win32'
            ? 'powershell -NoProfile -Command "Set-Content -LiteralPath tracked.txt -Value second"'
            : "printf 'second\\n' > tracked.txt",
      },
      context,
    );

    await checkpoints.commitTurn('two changes');
    await checkpoints.undoLast();

    // All the way back to the start of the turn, not to the middle of it.
    expect(await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('original\n');
  });
});
