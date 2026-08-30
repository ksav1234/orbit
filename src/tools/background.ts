import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool } from './registry.js';
import { targetForCommand } from '../permissions/manager.js';
import { findBlocked } from './terminal.js';
import { clampLines, formatDuration, oneLine, pluralize } from '../util/format.js';
import { redact } from '../util/redact.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('tools:background');

const MAX_BUFFERED_CHARS = 200_000;

export interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  status: 'running' | 'exited' | 'killed';
  output: string;
  truncated: boolean;
}

/**
 * Long-running commands (dev servers, watchers) that outlive a single tool
 * call. The agent starts them, checks their output later, and stops them —
 * without blocking the turn for the process's lifetime.
 */
export class BackgroundRegistry {
  private readonly processes = new Map<string, BackgroundProcess>();
  private readonly handles = new Map<string, ChildProcess>();
  private counter = 0;

  start(options: { command: string; cwd: string; env?: NodeJS.ProcessEnv }): BackgroundProcess {
    const id = `bg-${++this.counter}`;
    const record: BackgroundProcess = {
      id,
      command: options.command,
      cwd: options.cwd,
      startedAt: Date.now(),
      exitCode: null,
      status: 'running',
      output: '',
      truncated: false,
    };

    const child = spawn(options.command, {
      shell: true,
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (chunk: string): void => {
      if (record.output.length >= MAX_BUFFERED_CHARS) {
        record.truncated = true;
        // Keep the tail: for a server log, recent lines are what matter.
        record.output = record.output.slice(-Math.floor(MAX_BUFFERED_CHARS / 2));
      }
      record.output += chunk;
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error) => {
      append(`\n[orbit] failed to start: ${error.message}\n`);
      record.status = 'exited';
      record.exitCode = null;
      record.endedAt = Date.now();
    });

    child.on('close', (code) => {
      record.exitCode = code;
      record.endedAt = Date.now();
      if (record.status === 'running') record.status = 'exited';
      log.info('background process ended', { id, code });
    });

    this.processes.set(id, record);
    this.handles.set(id, child);
    return record;
  }

  get(id: string): BackgroundProcess | undefined {
    return this.processes.get(id);
  }

  list(): BackgroundProcess[] {
    return [...this.processes.values()];
  }

  running(): BackgroundProcess[] {
    return this.list().filter((entry) => entry.status === 'running');
  }

  stop(id: string): boolean {
    const child = this.handles.get(id);
    const record = this.processes.get(id);
    if (!child || !record || record.status !== 'running') return false;

    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (record.status === 'running') child.kill('SIGKILL');
        }, 2000).unref();
      }
      record.status = 'killed';
      record.endedAt = Date.now();
      return true;
    } catch (error) {
      log.warn('could not stop background process', { id, error: String(error) });
      return false;
    }
  }

  /** Stop everything. Called when Orbit exits so nothing is orphaned. */
  stopAll(): number {
    let stopped = 0;
    for (const record of this.running()) {
      if (this.stop(record.id)) stopped++;
    }
    return stopped;
  }
}

// ── run_background ─────────────────────────────────────────────────────────

const startSchema = z.object({
  command: z.string().min(1).describe('Command to run in the background, e.g. "npm run dev".'),
  cwd: z.string().optional().describe('Working directory relative to the workspace root.'),
  description: z.string().optional().describe('Why this process is being started.'),
});

export const runBackgroundTool: Tool = defineTool({
  name: 'run_background',
  description:
    'Start a long-running command (dev server, watcher, tail) that keeps running after this tool returns. Use check_background to read its output and stop_background to end it. For commands that finish on their own, use execute_command instead.',
  parameters: startSchema,
  permission: 'shell',
  readOnly: false,
  async authorize(args, context) {
    const cwd = args.cwd ? context.sandbox.resolve(args.cwd) : null;
    return {
      category: 'shell',
      tool: 'run_background',
      title: 'Start a background process',
      details: [
        ...(args.description ? [{ label: 'Purpose', value: oneLine(args.description, 60) }] : []),
        { label: 'Directory', value: cwd ? cwd.relative : '.' },
        { label: 'Lifetime', value: 'runs until stopped or Orbit exits' },
      ],
      preview: args.command,
      previewKind: 'command',
      target: targetForCommand(args.command),
    };
  },
  async execute(args, context) {
    if (!context.background) {
      return toolError('Background processes are not available in this session.');
    }
    const blocked = findBlocked(args.command, context.config.blockedCommands);
    if (blocked) return toolError(`Refused to run this command: ${blocked}.`);

    const cwd = args.cwd ? context.sandbox.resolve(args.cwd) : null;
    const record = context.background.start({
      command: args.command,
      cwd: cwd?.absolute ?? context.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
    });

    // Give it a beat to fail fast on a bad command, so the model learns now.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const current = context.background.get(record.id)!;

    const summary =
      current.status === 'running'
        ? `${record.id} running: ${oneLine(args.command, 44)}`
        : `${record.id} exited immediately (code ${current.exitCode})`;

    return toolOk(
      [
        `Started ${record.id}: ${args.command}`,
        `status: ${current.status}${current.exitCode === null ? '' : ` (exit ${current.exitCode})`}`,
        current.output ? `\nearly output:\n${redact(clampLines(current.output.trim(), 20).text)}` : '',
        '\nUse check_background to read more output later.',
      ]
        .filter(Boolean)
        .join('\n'),
      { kind: 'status', summary, detail: current.output },
      { ok: current.status === 'running', metadata: { id: record.id, status: current.status } },
    );
  },
});

// ── check_background ───────────────────────────────────────────────────────

const checkSchema = z.object({
  id: z.string().optional().describe('Process id to inspect. Omit to list every process.'),
  lines: z.number().int().min(1).max(500).default(60).describe('How many recent output lines to return.'),
});

export const checkBackgroundTool: Tool = defineTool({
  name: 'check_background',
  description:
    'Read the output and status of background processes started with run_background.',
  parameters: checkSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    if (!context.background) {
      return toolError('Background processes are not available in this session.');
    }

    if (!args.id) {
      const all = context.background.list();
      if (all.length === 0) {
        return toolOk('No background processes have been started.', {
          kind: 'status',
          summary: 'no background processes',
        });
      }
      const rows = all.map(
        (entry) =>
          `${entry.id}  ${entry.status.padEnd(8)} ${formatDuration(
            (entry.endedAt ?? Date.now()) - entry.startedAt,
          ).padStart(8)}  ${oneLine(entry.command, 50)}`,
      );
      return toolOk(rows.join('\n'), {
        kind: 'text',
        summary: `${pluralize(all.length, 'background process', 'background processes')}`,
        lines: rows.slice(0, 10),
      });
    }

    const record = context.background.get(args.id);
    if (!record) return toolError(`No background process with id "${args.id}".`);

    const output = redact(record.output.trimEnd());
    const tail = output.split('\n').slice(-args.lines).join('\n');
    const elapsed = formatDuration((record.endedAt ?? Date.now()) - record.startedAt);

    return toolOk(
      [
        `${record.id}: ${record.command}`,
        `status: ${record.status}${record.exitCode === null ? '' : ` (exit ${record.exitCode})`}, running for ${elapsed}`,
        record.truncated ? '(earlier output was dropped)' : '',
        '',
        tail || '(no output yet)',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        kind: 'output',
        summary: `${record.id} — ${record.status}, ${elapsed}`,
        lines: tail.split('\n').slice(-12),
        detail: output,
      },
      { metadata: { status: record.status, exitCode: record.exitCode } },
    );
  },
});

// ── stop_background ────────────────────────────────────────────────────────

export const stopBackgroundTool: Tool = defineTool({
  name: 'stop_background',
  description: 'Stop a background process started with run_background.',
  parameters: z.object({
    id: z.string().describe('Process id to stop, or "all".'),
  }),
  permission: 'shell',
  readOnly: false,
  async authorize(args) {
    return {
      category: 'shell',
      tool: 'stop_background',
      title: `Stop background process ${args.id}`,
      target: 'stop_background',
    };
  },
  async execute(args, context) {
    if (!context.background) {
      return toolError('Background processes are not available in this session.');
    }
    if (args.id === 'all') {
      const stopped = context.background.stopAll();
      return toolOk(`Stopped ${pluralize(stopped, 'process', 'processes')}.`, {
        kind: 'status',
        summary: `stopped ${stopped}`,
      });
    }
    const stopped = context.background.stop(args.id);
    return stopped
      ? toolOk(`Stopped ${args.id}.`, { kind: 'status', summary: `stopped ${args.id}` })
      : toolError(`${args.id} is not running.`);
  },
});

export const backgroundTools: Tool[] = [
  runBackgroundTool,
  checkBackgroundTool,
  stopBackgroundTool,
];
