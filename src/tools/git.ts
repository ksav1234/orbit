import path from 'node:path';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool, type ToolContext } from './registry.js';
import { isCommandAvailable, runCommand } from '../util/process.js';
import { clampLines, pluralize } from '../util/format.js';
import { errorMessage } from '../util/errors.js';

export interface GitFileStatus {
  /** Two-character porcelain code, e.g. ` M`, `??`, `A `. */
  code: string;
  path: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitState {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  lastCommit?: { hash: string; subject: string; author: string; date: string };
}

async function git(
  args: string[],
  context: { cwd: string; signal?: AbortSignal },
  timeoutMs = 20_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  try {
    const result = await runCommand({
      command: 'git',
      args,
      cwd: context.cwd,
      signal: context.signal,
      timeoutMs,
      maxOutputChars: 500_000,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1' },
    });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  } catch (error) {
    // A missing or unusable git binary is reported, never thrown at the caller.
    return { ok: false, stdout: '', stderr: errorMessage(error), code: null };
  }
}

/** Read repository state for the status bar and the system prompt. */
export async function readGitState(cwd: string, signal?: AbortSignal): Promise<GitState> {
  if (!(await isCommandAvailable('git'))) return { isRepo: false, files: [] };

  const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd, signal }, 5000);
  if (!inside.ok || inside.stdout.trim() !== 'true') return { isRepo: false, files: [] };

  const status = await git(['status', '--porcelain=v1', '--branch'], { cwd, signal });
  const state: GitState = { isRepo: true, files: [] };

  for (const line of status.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('##')) {
      const header = line.slice(3).trim();
      const [branchPart] = header.split(' ');
      const [branch, upstream] = (branchPart ?? '').split('...');
      state.branch = branch === 'HEAD' ? 'detached HEAD' : branch;
      if (upstream) state.upstream = upstream;
      const ahead = /ahead (\d+)/.exec(header);
      const behind = /behind (\d+)/.exec(header);
      if (ahead?.[1]) state.ahead = Number(ahead[1]);
      if (behind?.[1]) state.behind = Number(behind[1]);
      continue;
    }
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    state.files.push({
      code,
      path: file,
      staged: code[0] !== ' ' && code[0] !== '?',
      untracked: code === '??',
    });
  }

  const log = await git(['log', '-1', '--pretty=format:%h%x1f%s%x1f%an%x1f%ar'], { cwd, signal });
  if (log.ok && log.stdout.trim()) {
    const [hash = '', subject = '', author = '', date = ''] = log.stdout.trim().split('\x1f');
    state.lastCommit = { hash, subject, author, date };
  }

  return state;
}

export function summarizeGitState(state: GitState): string {
  if (!state.isRepo) return 'not a git repository';
  const modified = state.files.filter((f) => !f.untracked).length;
  const untracked = state.files.filter((f) => f.untracked).length;
  const parts = [state.branch ?? 'unknown branch'];
  if (modified) parts.push(`${modified} modified`);
  if (untracked) parts.push(`${untracked} untracked`);
  if (!modified && !untracked) parts.push('clean');
  if (state.ahead) parts.push(`${state.ahead} ahead`);
  if (state.behind) parts.push(`${state.behind} behind`);
  return parts.join(', ');
}

async function requireRepo(context: ToolContext) {
  if (!(await isCommandAvailable('git'))) {
    return toolError('Git is not installed or not on PATH.');
  }
  const inside = await git(['rev-parse', '--is-inside-work-tree'], {
    cwd: context.cwd,
    signal: context.signal,
  });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return toolError(`${path.basename(context.cwd)} is not a git repository.`);
  }
  return null;
}

// ── git_status ─────────────────────────────────────────────────────────────

export const gitStatusTool: Tool = defineTool({
  name: 'git_status',
  description:
    'Show the working tree status: current branch, staged, modified and untracked files.',
  parameters: z.object({}),
  permission: 'read',
  readOnly: true,
  async execute(_args, context) {
    const problem = await requireRepo(context);
    if (problem) return problem;

    const state = await readGitState(context.cwd, context.signal);
    const staged = state.files.filter((f) => f.staged && !f.untracked);
    const modified = state.files.filter((f) => !f.staged && !f.untracked);
    const untracked = state.files.filter((f) => f.untracked);

    const sections: string[] = [`On branch ${state.branch ?? 'unknown'}`];
    if (state.upstream) {
      sections.push(
        `Tracking ${state.upstream}${state.ahead ? `, ${state.ahead} ahead` : ''}${state.behind ? `, ${state.behind} behind` : ''}`,
      );
    }
    if (staged.length) sections.push(`Staged:\n${staged.map((f) => `  ${f.code} ${f.path}`).join('\n')}`);
    if (modified.length) sections.push(`Modified:\n${modified.map((f) => `  ${f.code} ${f.path}`).join('\n')}`);
    if (untracked.length) sections.push(`Untracked:\n${untracked.map((f) => `  ?? ${f.path}`).join('\n')}`);
    if (state.files.length === 0) sections.push('Working tree clean');

    const body = sections.join('\n\n');
    return toolOk(
      body,
      {
        kind: 'text',
        summary: summarizeGitState(state),
        lines: state.files.slice(0, 10).map((f) => `${f.code} ${f.path}`),
        hiddenLines: Math.max(0, state.files.length - 10),
        detail: body,
      },
      { metadata: { branch: state.branch, changed: state.files.length } },
    );
  },
});

// ── git_diff ───────────────────────────────────────────────────────────────

const diffSchema = z.object({
  staged: z.boolean().default(false).describe('Show staged changes instead of unstaged ones.'),
  path: z.string().optional().describe('Limit the diff to a path.'),
  stat_only: z.boolean().default(false).describe('Show only the summary of changed files.'),
});

export const gitDiffTool: Tool = defineTool({
  name: 'git_diff',
  description:
    'Show the current diff. Use this to understand what has already changed before making further edits.',
  parameters: diffSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const problem = await requireRepo(context);
    if (problem) return problem;

    const gitArgs = ['diff', '--no-color'];
    if (args.staged) gitArgs.push('--staged');
    if (args.stat_only) gitArgs.push('--stat');
    if (args.path) {
      const resolved = context.sandbox.resolve(args.path);
      gitArgs.push('--', resolved.absolute);
    }

    const result = await git(gitArgs, { cwd: context.cwd, signal: context.signal });
    if (!result.ok) return toolError(result.stderr.trim() || 'git diff failed.');

    const diff = result.stdout.trim();
    if (!diff) {
      const summary = args.staged ? 'No staged changes' : 'No unstaged changes';
      return toolOk(summary, { kind: 'status', summary });
    }

    const clamped = clampLines(diff, 400);
    const files = (diff.match(/^diff --git /gm) ?? []).length;
    const summary = `${pluralize(files, 'file')} changed${args.staged ? ' (staged)' : ''}`;

    return toolOk(
      clamped.text,
      { kind: 'diff', summary, detail: diff, hiddenLines: clamped.hiddenLines },
      { metadata: { files } },
    );
  },
});

// ── git_log ────────────────────────────────────────────────────────────────

const logSchema = z.object({
  limit: z.number().int().min(1).max(100).default(15),
  path: z.string().optional().describe('Only show commits touching this path.'),
});

export const gitLogTool: Tool = defineTool({
  name: 'git_log',
  description: 'Show recent commits with hash, author, relative date and subject.',
  parameters: logSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const problem = await requireRepo(context);
    if (problem) return problem;

    const gitArgs = [
      'log',
      `-${args.limit}`,
      '--no-color',
      '--pretty=format:%h  %ad  %an  %s',
      '--date=short',
    ];
    if (args.path) {
      const resolved = context.sandbox.resolve(args.path);
      gitArgs.push('--', resolved.absolute);
    }

    const result = await git(gitArgs, { cwd: context.cwd, signal: context.signal });
    if (!result.ok) return toolError(result.stderr.trim() || 'git log failed.');

    const body = result.stdout.trim();
    if (!body) return toolOk('No commits found.', { kind: 'status', summary: 'No commits' });

    const lines = body.split('\n');
    return toolOk(body, {
      kind: 'text',
      summary: `${pluralize(lines.length, 'commit')}`,
      lines: lines.slice(0, 8),
      hiddenLines: Math.max(0, lines.length - 8),
      detail: body,
    });
  },
});

// ── git_branch ─────────────────────────────────────────────────────────────

export const gitBranchTool: Tool = defineTool({
  name: 'git_branch',
  description: 'List local branches and show which one is checked out.',
  parameters: z.object({
    all: z.boolean().default(false).describe('Include remote-tracking branches.'),
  }),
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const problem = await requireRepo(context);
    if (problem) return problem;

    const gitArgs = ['branch', '--no-color', '--sort=-committerdate'];
    if (args.all) gitArgs.push('--all');

    const result = await git(gitArgs, { cwd: context.cwd, signal: context.signal });
    if (!result.ok) return toolError(result.stderr.trim() || 'git branch failed.');

    const lines = result.stdout.split('\n').filter((l) => l.trim());
    const current = lines.find((l) => l.startsWith('*'))?.slice(1).trim();

    return toolOk(lines.join('\n'), {
      kind: 'text',
      summary: `${pluralize(lines.length, 'branch', 'branches')}${current ? `, on ${current}` : ''}`,
      lines: lines.slice(0, 10),
      hiddenLines: Math.max(0, lines.length - 10),
      detail: lines.join('\n'),
    });
  },
});

export const gitTools: Tool[] = [gitStatusTool, gitDiffTool, gitLogTool, gitBranchTool];
