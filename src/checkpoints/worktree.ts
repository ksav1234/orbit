import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../util/process.js';
import { createLogger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';

const log = createLogger('checkpoints:worktree');

/** What happened to a path between two snapshots. */
export interface TreeChange {
  /** Repo-relative, forward-slashed, as git reports it. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

const GIT_ENV = { GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1' } as const;

async function git(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await runCommand({
      command: 'git',
      args,
      cwd,
      timeoutMs,
      maxOutputChars: 2_000_000,
      env: { ...process.env, ...GIT_ENV, ...extraEnv },
    });
    return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stdout: '', stderr: errorMessage(error) };
  }
}

/** True when `root` is inside a git working tree. */
export async function isGitWorkTree(root: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], root);
  return result.ok && result.stdout.trim() === 'true';
}

/**
 * Record the current state of the working tree as a git tree object, and return
 * its hash.
 *
 * This is how shell commands become undoable. Orbit's own file tools announce
 * what they are about to touch, so their previous contents can be saved one
 * file at a time — but a shell command can change anything, and there is no way
 * to know what in advance. So the whole tree is captured instead.
 *
 * Three details make that cheap enough to do around every command:
 *
 *  - The real index is copied to a temporary file and `GIT_INDEX_FILE` points at
 *    the copy, so the user's staged changes are never touched. Copying rather
 *    than starting empty preserves git's stat cache, so `add -A` only rehashes
 *    files that actually changed.
 *  - `add -A` honours `.gitignore`, so `node_modules` and build output are not
 *    snapshotted.
 *  - Blobs git already has are reused; only new content is written.
 *
 * The objects written are loose and unreferenced, which means `git gc` prunes
 * them and nothing shows up in `git status` or `git log`.
 */
export async function snapshotWorkTree(root: string): Promise<string | undefined> {
  let indexCopy: string | undefined;
  try {
    const gitDir = await git(['rev-parse', '--absolute-git-dir'], root);
    if (!gitDir.ok) return undefined;

    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-ckpt-'));
    indexCopy = path.join(scratch, 'index');

    // Seed from the real index when there is one; a repo with no commits and no
    // index simply starts from nothing.
    try {
      await fs.copyFile(path.join(gitDir.stdout.trim(), 'index'), indexCopy);
    } catch {
      // No index yet. `add -A` will build one from scratch.
    }

    const env = { GIT_INDEX_FILE: indexCopy };
    const added = await git(['add', '-A', '--', '.'], root, env);
    if (!added.ok) {
      log.debug('could not stage the work tree', { stderr: added.stderr.slice(0, 200) });
      return undefined;
    }

    const tree = await git(['write-tree'], root, env);
    if (!tree.ok) return undefined;
    const hash = tree.stdout.trim();
    return /^[0-9a-f]{7,64}$/.test(hash) ? hash : undefined;
  } catch (error) {
    log.debug('work-tree snapshot failed', { error: String(error) });
    return undefined;
  } finally {
    if (indexCopy) {
      await fs.rm(path.dirname(indexCopy), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Paths that differ between two tree objects. */
export async function diffTrees(
  root: string,
  before: string,
  after: string,
): Promise<TreeChange[]> {
  const result = await git(['diff-tree', '-r', '--name-status', '-z', before, after], root);
  if (!result.ok) return [];

  // `-z` gives NUL-separated status/path pairs, which is the only form that
  // survives paths with spaces, quotes or non-ASCII characters intact.
  const fields = result.stdout.split('\0').filter((field) => field.length > 0);
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]![0];
    const filePath = fields[i + 1]!;
    const status =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'M' || code === 'T' ? 'modified' : undefined;
    if (status) changes.push({ path: filePath, status });
  }
  return changes;
}

/**
 * The contents of a path as of a snapshot, or undefined if it was not in it.
 *
 * Bytes, not text: a checkpoint has to be able to restore a PNG or a compiled
 * artefact exactly, and decoding it as UTF-8 on the way through would quietly
 * corrupt it.
 */
export async function readTreeFile(
  root: string,
  tree: string,
  filePath: string,
  maxBytes: number,
): Promise<{ content: Buffer } | { tooLarge: true } | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['cat-file', 'blob', `${tree}:${filePath}`], {
      cwd: root,
      env: { ...process.env, ...GIT_ENV },
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Recording it would be pointless: the manager would reject it anyway.
        aborted = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', () => {});

    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (aborted) resolve({ tooLarge: true });
      else if (code === 0) resolve({ content: Buffer.concat(chunks) });
      else resolve(undefined);
    });
  });
}
