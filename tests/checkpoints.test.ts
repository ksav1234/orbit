import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CheckpointManager } from '../src/checkpoints/manager.js';
import { CheckpointsConfigSchema } from '../src/config/schema.js';
import { FileReadTracker, staleWriteMessage } from '../src/tools/tracker.js';
import { writeFileTool, editFileTool, deleteFileTool, moveFileTool } from '../src/tools/filesystem.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace, writeFiles } from './helpers.js';

let workspace = '';
let home = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-cp-');
  home = await makeTempWorkspace('orbit-cp-home-');
  process.env.ORBIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(workspace);
  await removeTempWorkspace(home);
});

function makeCheckpoints(overrides = {}) {
  return new CheckpointManager({
    config: CheckpointsConfigSchema.parse(overrides),
    sessionId: 'test-session',
    workspaceRoot: workspace,
  });
}

describe('CheckpointManager', () => {
  it('restores a modified file to its previous contents', async () => {
    await writeFiles(workspace, { 'a.txt': 'original\n' });
    const checkpoints = makeCheckpoints();

    await checkpoints.capture(path.join(workspace, 'a.txt'), 'modified');
    await fs.writeFile(path.join(workspace, 'a.txt'), 'changed\n');
    await checkpoints.commitTurn('change a.txt');

    const outcome = await checkpoints.undoLast();
    expect(outcome?.result.restored).toEqual(['a.txt']);
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('original\n');
  });

  it('deletes a file the turn created', async () => {
    const checkpoints = makeCheckpoints();
    const created = path.join(workspace, 'new.txt');

    await checkpoints.capture(created, 'created');
    await fs.writeFile(created, 'hello\n');
    await checkpoints.commitTurn('create new.txt');

    await checkpoints.undoLast();
    await expect(fs.access(created)).rejects.toThrow();
  });

  it('restores a file the turn deleted', async () => {
    await writeFiles(workspace, { 'gone.txt': 'still here\n' });
    const checkpoints = makeCheckpoints();
    const target = path.join(workspace, 'gone.txt');

    await checkpoints.capture(target, 'deleted');
    await fs.rm(target);
    await checkpoints.commitTurn('delete gone.txt');

    await checkpoints.undoLast();
    expect(await fs.readFile(target, 'utf8')).toBe('still here\n');
  });

  it('reverses a move', async () => {
    await writeFiles(workspace, { 'from.txt': 'contents\n' });
    const checkpoints = makeCheckpoints();
    const from = path.join(workspace, 'from.txt');
    const to = path.join(workspace, 'to.txt');

    await checkpoints.capture(from, 'moved', to);
    await fs.rename(from, to);
    await checkpoints.commitTurn('move the file');

    await checkpoints.undoLast();
    expect(await fs.readFile(from, 'utf8')).toBe('contents\n');
    await expect(fs.access(to)).rejects.toThrow();
  });

  it('keeps only the state each turn started from', async () => {
    await writeFiles(workspace, { 'a.txt': 'v1\n' });
    const checkpoints = makeCheckpoints();
    const file = path.join(workspace, 'a.txt');

    await checkpoints.capture(file, 'modified');
    await checkpoints.capture(file, 'modified'); // second capture in the same turn
    await fs.writeFile(file, 'v2\n');
    await checkpoints.commitTurn('first change');

    await checkpoints.capture(file, 'modified');
    await fs.writeFile(file, 'v3\n');
    await checkpoints.commitTurn('second change');

    // Undoing the last turn returns to v2, not v1.
    await checkpoints.undoLast();
    expect(await fs.readFile(file, 'utf8')).toBe('v2\n');

    // Undoing again returns to v1.
    await checkpoints.undoLast();
    expect(await fs.readFile(file, 'utf8')).toBe('v1\n');
  });

  it('rewinds several turns at once', async () => {
    await writeFiles(workspace, { 'a.txt': 'start\n' });
    const checkpoints = makeCheckpoints();
    const file = path.join(workspace, 'a.txt');

    for (const version of ['one', 'two', 'three']) {
      await checkpoints.capture(file, 'modified');
      await fs.writeFile(file, `${version}\n`);
      await checkpoints.commitTurn(`set ${version}`);
    }

    expect(checkpoints.list()).toHaveLength(3);
    const result = await checkpoints.restoreTo(2);

    expect(result.restored).toContain('a.txt');
    expect(await fs.readFile(file, 'utf8')).toBe('one\n');
    expect(checkpoints.list()).toHaveLength(1);
  });

  it('records nothing for a turn that changed nothing', async () => {
    const checkpoints = makeCheckpoints();
    expect(await checkpoints.commitTurn('read-only turn')).toBeNull();
    expect(checkpoints.list()).toHaveLength(0);
  });

  it('survives a restart', async () => {
    await writeFiles(workspace, { 'a.txt': 'persisted\n' });
    const first = makeCheckpoints();
    await first.capture(path.join(workspace, 'a.txt'), 'modified');
    await fs.writeFile(path.join(workspace, 'a.txt'), 'changed\n');
    await first.commitTurn('change it');

    const second = makeCheckpoints();
    await second.load();
    expect(second.list()).toHaveLength(1);

    await second.undoLast();
    expect(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('persisted\n');
  });

  it('reports files too large to snapshot instead of silently dropping them', async () => {
    await writeFiles(workspace, { 'big.txt': 'x'.repeat(5_000) });
    const checkpoints = makeCheckpoints({ maxFileBytes: 1_000 });

    await checkpoints.capture(path.join(workspace, 'big.txt'), 'modified');
    await fs.writeFile(path.join(workspace, 'big.txt'), 'small\n');
    await checkpoints.commitTurn('replace a big file');

    const outcome = await checkpoints.undoLast();
    expect(outcome?.result.restored).toHaveLength(0);
    expect(outcome?.result.skipped[0]?.reason).toMatch(/not snapshotted/);
    // The file is left as-is rather than corrupted with partial data.
    expect(await fs.readFile(path.join(workspace, 'big.txt'), 'utf8')).toBe('small\n');
  });

  it('does nothing when disabled', async () => {
    const checkpoints = makeCheckpoints({ enabled: false });
    await checkpoints.capture(path.join(workspace, 'a.txt'), 'created');
    expect(checkpoints.hasPendingChanges).toBe(false);
    expect(await checkpoints.commitTurn('turn')).toBeNull();
  });
});

describe('filesystem tools with checkpoints', () => {
  it('captures before every kind of change, and undo restores them all', async () => {
    await writeFiles(workspace, { 'edit.txt': 'before\n', 'move.txt': 'moving\n', 'del.txt': 'bye\n' });
    const checkpoints = makeCheckpoints();
    const context = { ...makeToolContext({ root: workspace }), checkpoints };

    await writeFileTool.execute(
      writeFileTool.parse({ path: 'created.txt', content: 'new\n' }),
      context,
    );
    await editFileTool.execute(
      editFileTool.parse({ path: 'edit.txt', old_string: 'before', new_string: 'after' }),
      context,
    );
    await moveFileTool.execute(
      moveFileTool.parse({ source: 'move.txt', destination: 'moved.txt' }),
      context,
    );
    await deleteFileTool.execute(deleteFileTool.parse({ path: 'del.txt' }), context);

    await checkpoints.commitTurn('do everything');
    await checkpoints.undoLast();

    await expect(fs.access(path.join(workspace, 'created.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, 'edit.txt'), 'utf8')).toBe('before\n');
    expect(await fs.readFile(path.join(workspace, 'move.txt'), 'utf8')).toBe('moving\n');
    expect(await fs.readFile(path.join(workspace, 'del.txt'), 'utf8')).toBe('bye\n');
  });
});

describe('stale write detection', () => {
  it('refuses a write when the file changed after the agent read it', async () => {
    await writeFiles(workspace, { 'a.ts': 'original\n' });
    const tracker = new FileReadTracker();
    const context = { ...makeToolContext({ root: workspace }), fileTracker: tracker };
    const target = path.join(workspace, 'a.ts');

    // The agent reads it…
    const stat = await fs.stat(target);
    tracker.noteRead(target, stat.mtimeMs, stat.size);

    // …then the user edits it in their editor.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(target, 'edited by the user\n');

    const result = await writeFileTool.execute(
      writeFileTool.parse({ path: 'a.ts', content: 'agent version\n' }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed on disk/);
    // The user's edit survives.
    expect(await fs.readFile(target, 'utf8')).toBe('edited by the user\n');
  });

  it('allows a write to a file the agent has not read', async () => {
    const tracker = new FileReadTracker();
    const context = { ...makeToolContext({ root: workspace }), fileTracker: tracker };

    const result = await writeFileTool.execute(
      writeFileTool.parse({ path: 'fresh.txt', content: 'new file\n' }),
      context,
    );
    expect(result.ok).toBe(true);
  });

  it('does not flag the agent’s own consecutive writes', async () => {
    const tracker = new FileReadTracker();
    const context = { ...makeToolContext({ root: workspace }), fileTracker: tracker };

    await writeFileTool.execute(writeFileTool.parse({ path: 'x.txt', content: 'one\n' }), context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await writeFileTool.execute(
      writeFileTool.parse({ path: 'x.txt', content: 'two\n' }),
      context,
    );

    expect(second.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, 'x.txt'), 'utf8')).toBe('two\n');
  });

  it('can be turned off', async () => {
    await writeFiles(workspace, { 'a.txt': 'original\n' });
    const tracker = new FileReadTracker();
    const base = makeToolContext({ root: workspace });
    const context = {
      ...base,
      fileTracker: tracker,
      config: { ...base.config, detectStaleWrites: false },
    };
    const target = path.join(workspace, 'a.txt');

    tracker.noteRead(target, 0, 0); // deliberately wrong mtime
    const result = await writeFileTool.execute(
      writeFileTool.parse({ path: 'a.txt', content: 'overwritten\n' }),
      context,
    );
    expect(result.ok).toBe(true);
  });

  it('explains what to do about it', () => {
    expect(staleWriteMessage('src/a.ts')).toMatch(/Read the file again/);
  });
});
