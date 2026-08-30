import os from 'node:os';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool } from './registry.js';
import { targetForCommand } from '../permissions/manager.js';
import { runCommand } from '../util/process.js';
import { clampLines, formatDuration, oneLine, pluralize } from '../util/format.js';
import { redact } from '../util/redact.js';

/**
 * Commands refused regardless of approval. These are unrecoverable at a scope
 * far wider than a workspace, so Orbit does not offer to run them at all.
 */
const ALWAYS_BLOCKED: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+\/(?:\s|$)/, why: 'recursive delete of the filesystem root' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, why: 'filesystem formatting' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/, why: 'raw writes to a block device' },
  { re: />\s*\/dev\/(sd|nvme|disk)[a-z0-9]*/, why: 'raw writes to a block device' },
  { re: /\bformat\s+[a-zA-Z]:/i, why: 'formatting a drive' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'shutting down the machine' },
  { re: /\bdel\s+\/[sq]\b[^\n]*\\\\?\*/i, why: 'recursive delete outside the workspace' },
];

const SHELL_LABEL = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL ?? '/bin/sh');

const executeSchema = z.object({
  command: z.string().min(1).describe('Shell command to run, exactly as it should be executed.'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory relative to the workspace root. Defaults to the workspace root.'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('Kill the command after this many milliseconds.'),
  description: z
    .string()
    .optional()
    .describe('One-line explanation of why this command is being run, shown in the approval prompt.'),
});

export const executeCommandTool: Tool = defineTool({
  name: 'execute_command',
  description:
    'Run a shell command inside the workspace and return its real output and exit code. Use for builds, tests, package managers and other developer tooling. Never claim a command succeeded without running it.',
  parameters: executeSchema,
  permission: 'shell',
  readOnly: false,
  async authorize(args, context) {
    // A command the user pre-approved by pattern runs without interrupting them.
    if (matchesAllowlist(args.command, context.config.allowedCommands)) return null;

    const cwd = args.cwd ? context.sandbox.resolve(args.cwd) : null;
    const details = [
      { label: 'Directory', value: cwd ? cwd.relative : '.' },
      { label: 'Shell', value: SHELL_LABEL },
    ];
    if (args.description) details.unshift({ label: 'Purpose', value: oneLine(args.description, 60) });

    return {
      category: 'shell',
      tool: 'execute_command',
      title: 'Run a shell command',
      details,
      preview: args.command,
      previewKind: 'command',
      target: targetForCommand(args.command),
    };
  },
  async execute(args, context) {
    const blocked = findBlocked(args.command, context.config.blockedCommands);
    if (blocked) {
      return toolError(`Refused to run this command: ${blocked}.`);
    }

    const cwd = args.cwd ? context.sandbox.resolve(args.cwd) : null;
    const workingDir = cwd?.absolute ?? context.cwd;
    const timeoutMs = args.timeout_ms ?? context.config.shellTimeoutMs;

    context.progress(`$ ${oneLine(args.command, 60)}`);

    const result = await runCommand({
      command: args.command,
      shell: true,
      cwd: workingDir,
      signal: context.signal,
      timeoutMs,
      maxOutputChars: context.config.maxOutputChars,
      env: {
        ...process.env,
        // Keep tool output parseable: no pagers, no interactive prompts.
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        CI: process.env.CI ?? '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
      },
      onOutput: (chunk) => {
        const line = chunk.split('\n').filter(Boolean).pop();
        if (line) context.progress(oneLine(line, 70));
      },
    });

    const output = redact(result.output.trimEnd());
    const exitCode = result.code;

    if (result.cancelled) {
      return toolError('Command cancelled by the user before it finished.', {
        summary: 'cancelled',
        detail: output,
      });
    }
    if (result.timedOut) {
      return toolError(
        `Command timed out after ${formatDuration(timeoutMs)} and was terminated.\n\n${output}`,
        { summary: `timed out after ${formatDuration(timeoutMs)}`, detail: output },
      );
    }

    const clamped = clampLines(output, 40, 20);
    const status = exitCode === 0 ? 'succeeded' : `exited with code ${exitCode}`;
    const summary = `${oneLine(args.command, 48)} — ${status} in ${formatDuration(result.durationMs)}`;

    const modelText = [
      `$ ${args.command}`,
      `exit code: ${exitCode}`,
      result.truncated ? `(output truncated at ${context.config.maxOutputChars} characters)` : '',
      '',
      output || '(no output)',
    ]
      .filter(Boolean)
      .join('\n');

    return toolOk(
      modelText,
      {
        kind: 'output',
        summary,
        lines: clamped.text ? clamped.text.split('\n').slice(0, 20) : ['(no output)'],
        hiddenLines: clamped.hiddenLines,
        detail: output,
      },
      {
        ok: exitCode === 0,
        metadata: {
          exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          lines: output ? output.split('\n').length : 0,
        },
      },
    );
  },
});

/**
 * Pre-approved command patterns. Matched against the whole command line, so
 * `^npm (test|run build)$` approves those and nothing else — unlike setting the
 * whole `shell` permission to allow.
 */
export function matchesAllowlist(command: string, patterns: string[]): boolean {
  const trimmed = command.trim();
  for (const pattern of patterns) {
    if (!pattern.trim()) continue;
    try {
      if (new RegExp(pattern).test(trimmed)) return true;
    } catch {
      // An invalid pattern must never widen approval, so a literal match only.
      if (trimmed === pattern) return true;
    }
  }
  return false;
}

export function findBlocked(command: string, extra: string[]): string | null {
  const normalized = command.toLowerCase();
  for (const { re, why } of ALWAYS_BLOCKED) {
    if (re.test(normalized)) return why;
  }
  for (const pattern of extra) {
    if (!pattern.trim()) continue;
    try {
      if (new RegExp(pattern, 'i').test(command)) return `it matches the configured block pattern "${pattern}"`;
    } catch {
      if (normalized.includes(pattern.toLowerCase())) return `it matches the configured block list entry "${pattern}"`;
    }
  }
  return null;
}

/** Environment summary shown by `/status`. */
export function shellInfo(): { shell: string; platform: string; cpus: number } {
  return {
    shell: SHELL_LABEL,
    platform: `${process.platform} ${os.release()}`,
    cpus: os.cpus().length,
  };
}

export const terminalTools: Tool[] = [executeCommandTool];

export { pluralize };
