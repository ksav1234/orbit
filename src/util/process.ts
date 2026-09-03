import { spawn, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { childEnv } from './env.js';
import { CancelledError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('process');

/**
 * Find an executable on PATH, honouring PATHEXT on Windows.
 *
 * Node's `spawn` without a shell resolves only real executables, so a bare
 * `npx` or `rg` — which ship as `.cmd` shims on Windows — fails with ENOENT.
 */
function findOnPath(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) return command;

  let extensions = [''];
  if (process.platform === 'win32') {
    const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    // Windows needs an extension to execute anything. Trying the bare name
    // first would match the extensionless shell script that tools like npm
    // ship for Git Bash, which CreateProcess cannot run.
    const alreadyHasOne = pathExt.some((extension) =>
      command.toLowerCase().endsWith(extension.toLowerCase()),
    );
    extensions = alreadyHasOne ? [''] : pathExt;
  }

  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/** Quote a value so cmd.exe passes it through unchanged. */
function quoteForCmd(value: string): string {
  if (value === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  // Double any backslashes that precede a quote, then escape the quote.
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

export interface PreparedSpawn {
  command: string;
  args: string[];
  verbatim: boolean;
}

/**
 * Make a command runnable by `spawn` without a shell on every platform.
 *
 * On Windows a `.cmd`/`.bat` shim cannot be executed directly, so it is routed
 * through `cmd.exe /d /s /c` with each argument quoted. Everywhere else the
 * command is passed through untouched.
 */
export function prepareSpawn(command: string, args: string[] = []): PreparedSpawn {
  if (process.platform !== 'win32') return { command, args, verbatim: false };

  const resolved = findOnPath(command);
  if (!resolved) return { command, args, verbatim: false };

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteForCmd).join(' ');
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      // The outer quotes are required: when the string after /c both starts and
      // ends with a quote, cmd.exe strips that outer pair and runs the rest as
      // written. Without them it splits "C:\Program Files\..." at the space.
      args: ['/d', '/s', '/c', `"${line}"`],
      // Node would re-quote the assembled line and break it.
      verbatim: true,
    };
  }

  return { command: resolved, args, verbatim: false };
}

export interface RunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Hard cap on captured output; the rest is dropped and reported. */
  maxOutputChars?: number;
  /** Run through the platform shell (needed for pipes, globs, &&). */
  shell?: boolean;
  input?: string;
  /** Called with each chunk as it arrives, for live output rendering. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Interleaved stdout+stderr in arrival order. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

/**
 * Spawn a child process with cancellation, a timeout, and bounded output.
 * Cancellation and timeouts terminate the whole process tree where possible.
 */
export function runCommand(options: RunOptions): Promise<RunResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    signal,
    timeoutMs = 120_000,
    maxOutputChars = 200_000,
    shell = false,
    input,
    onOutput,
  } = options;

  return new Promise<RunResult>((resolve, reject) => {
    const started = Date.now();

    // A shell command is handed to the shell verbatim; a direct invocation is
    // resolved so Windows batch shims still work.
    const prepared = shell
      ? { command, args, verbatim: false }
      : prepareSpawn(command, args);

    const spawnOptions: SpawnOptions = {
      cwd,
      env: childEnv(env),
      shell,
      windowsHide: true,
      windowsVerbatimArguments: prepared.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(prepared.command, prepared.args, spawnOptions);
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let output = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const append = (chunk: string, stream: 'stdout' | 'stderr') => {
      onOutput?.(chunk, stream);
      if (output.length >= maxOutputChars) {
        truncated = true;
        return;
      }
      const room = maxOutputChars - output.length;
      const slice = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (slice.length < chunk.length) truncated = true;
      output += slice;
      if (stream === 'stdout') stdout += slice;
      else stderr += slice;
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: string) => append(chunk, 'stderr'));

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          // taskkill terminates the whole tree; npm/git spawn helper processes.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 2000).unref();
        }
      } catch (error) {
        log.debug('failed to terminate child process', { error: String(error) });
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      cleanup();
      if (cancelled) {
        reject(new CancelledError());
        return;
      }
      reject(error);
    });

    child.on('close', (code, sig) => {
      cleanup();
      resolve({
        code,
        signal: sig,
        stdout,
        stderr,
        output,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        truncated,
      });
    });

    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

const availability = new Map<string, boolean>();

/** Cache whether an external binary (rg, git, …) is on PATH. */
export async function isCommandAvailable(command: string): Promise<boolean> {
  const cached = availability.get(command);
  if (cached !== undefined) return cached;
  try {
    const result = await runCommand({
      command,
      args: ['--version'],
      timeoutMs: 5000,
      maxOutputChars: 2000,
    });
    const ok = result.code === 0;
    availability.set(command, ok);
    return ok;
  } catch {
    availability.set(command, false);
    return false;
  }
}

export function resetCommandAvailabilityCache(): void {
  availability.clear();
}
