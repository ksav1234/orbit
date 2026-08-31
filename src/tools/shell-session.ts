import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../util/logger.js';
import type { Sandbox } from '../permissions/sandbox.js';

const log = createLogger('shell-session');

const ENV_MARKER = '---ORBIT-ENV---';
/** Guard against a runaway environment being carried between commands. */
const MAX_ENV_VARS = 400;
const MAX_ENV_VALUE = 8_000;

/**
 * Variables that describe the machine or the current process rather than
 * anything the user set, and so must not be carried forward. `PWD` in
 * particular would fight with the tracked working directory.
 */
const NOT_INHERITED = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  '=EXITCODE',
  'PROMPT',
  'ERRORLEVEL',
  'CD',
  'RANDOM',
  'SECONDS',
]);

export interface PreparedShellRun {
  /** What to spawn, replacing the raw command string. */
  command: string;
  args: string[];
  /** Environment overrides accumulated so far. */
  env: Record<string, string>;
  cwd: string;
  /** Call once the command has finished, whatever its exit code. */
  finish(): Promise<void>;
}

/**
 * Carries shell state between commands, so `cd` and `export` mean something.
 *
 * Each command still runs in its own process — that is what keeps exit codes,
 * timeouts and cancellation exact. What persists is the *state*: after a command
 * finishes, the shell writes its working directory and environment to a file,
 * and the next command starts from those. A long-lived interactive shell would
 * be the other approach, and would mean parsing prompts to guess where one
 * command's output ends, which is not something to build a timeout on.
 *
 * The command is written to a script file rather than passed as a shell string.
 * That sidesteps quoting differences between `cmd.exe` and `sh`, and lets a
 * multi-line command work unchanged.
 */
export class ShellSession {
  private cwd: string;
  private env: Record<string, string> = {};
  private readonly root: string;

  constructor(private readonly sandbox: Sandbox) {
    this.root = sandbox.root;
    this.cwd = sandbox.root;
  }

  /** Where the next command will run. */
  currentCwd(): string {
    return this.cwd;
  }

  /** Variables carried over from earlier commands. */
  currentEnv(): Readonly<Record<string, string>> {
    return this.env;
  }

  /** Forget everything, back to a fresh shell in the workspace root. */
  reset(): void {
    this.cwd = this.root;
    this.env = {};
  }

  /** Point the session at a directory explicitly (the `cwd` tool argument). */
  useCwd(dir: string): void {
    this.cwd = dir;
  }

  /**
   * Wrap a command so its resulting directory and environment can be read back.
   *
   * The trailing capture only runs if the command lets the script continue — a
   * command ending in `exit` skips it, and the session simply keeps the state it
   * already had. That is the right failure mode: stale state beats invented
   * state.
   */
  async prepare(command: string): Promise<PreparedShellRun> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-shell-'));
    const statePath = path.join(scratch, 'state');
    const windows = process.platform === 'win32';
    const scriptPath = path.join(scratch, windows ? 'run.cmd' : 'run.sh');

    const script = windows
      ? [
          '@echo off',
          command,
          'set __ORBIT_RC=%ERRORLEVEL%',
          `> "${statePath}" (cd & echo ${ENV_MARKER} & set)`,
          'exit /b %__ORBIT_RC%',
          '',
        ].join('\r\n')
      : [
          command,
          '__ORBIT_RC=$?',
          `{ pwd; printf '%s\\n' '${ENV_MARKER}'; env; } > '${statePath}' 2>/dev/null`,
          'exit $__ORBIT_RC',
          '',
        ].join('\n');

    await fs.writeFile(scriptPath, script, 'utf8');
    if (!windows) await fs.chmod(scriptPath, 0o700).catch(() => {});

    const prepared: PreparedShellRun = {
      // On Windows the `.cmd` goes through the spawn preparation that already
      // knows how to quote a batch shim for `cmd.exe`; hand-rolling the outer
      // quotes here produced a mangled path.
      //
      // On POSIX the wrapper is written in POSIX shell — `$?`, `{ }`, `exit` —
      // so it has to run under `sh`. Honouring `$SHELL` would hand it to fish
      // or csh, where none of that parses.
      command: windows ? scriptPath : '/bin/sh',
      args: windows ? [] : [scriptPath],
      env: { ...this.env },
      cwd: this.cwd,
      finish: async () => {
        await this.absorb(statePath);
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
      },
    };
    return prepared;
  }

  /** Read the state the wrapper wrote, if it got that far. */
  private async absorb(statePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(statePath, 'utf8');
    } catch {
      return; // The command exited the script early. Keep what we had.
    }

    const marker = raw.indexOf(ENV_MARKER);
    if (marker === -1) return;

    const reportedCwd = raw.slice(0, marker).trim().split(/\r?\n/)[0]?.trim();
    if (reportedCwd) this.adoptCwd(reportedCwd);

    const envText = raw.slice(marker + ENV_MARKER.length);
    this.adoptEnv(envText);
  }

  /**
   * Follow the command into its new directory, but only inside the workspace.
   *
   * A `cd /` must not silently move every later command outside the sandbox —
   * the boundary is the whole point, and a persistent shell is exactly the
   * feature that could erode it by accident.
   */
  private adoptCwd(reported: string): void {
    const resolved = path.resolve(reported);
    try {
      const inside = this.sandbox.resolve(resolved);
      this.cwd = inside.absolute;
    } catch {
      log.debug('command left the workspace; keeping the previous directory', {
        reported: resolved,
      });
    }
  }

  private adoptEnv(text: string): void {
    const next: Record<string, string> = {};
    let count = 0;

    for (const line of text.split(/\r?\n/)) {
      if (!line || count >= MAX_ENV_VARS) break;
      const split = line.indexOf('=');
      if (split <= 0) continue; // Continuation of a multi-line value, or noise.

      const name = line.slice(0, split);
      const value = line.slice(split + 1);
      if (NOT_INHERITED.has(name) || name.startsWith('__ORBIT_')) continue;
      if (value.length > MAX_ENV_VALUE) continue;
      // Only carry what differs from the parent process, so the overrides stay
      // a small, inspectable set rather than a copy of the whole environment.
      if (process.env[name] === value) continue;

      next[name] = value;
      count += 1;
    }

    this.env = next;
  }
}
