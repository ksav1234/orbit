import { createHash } from 'node:crypto';
import type { VerifyConfig } from '../config/schema.js';
import type { WorkspaceInfo } from '../tools/project.js';
import { runCommand } from '../util/process.js';
import { createLogger } from '../util/logger.js';
import { clampChars } from '../util/format.js';
import { redact } from '../util/redact.js';

const log = createLogger('verify');

export interface VerifyCheck {
  /** Shown to the user and to the model. */
  label: string;
  command: string;
}

export interface CheckOutcome {
  check: VerifyCheck;
  passed: boolean;
  /** The command is not installed, so it proved nothing either way. */
  unavailable?: boolean;
  /** Trimmed, redacted output — the evidence handed back to the model. */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface VerifyResult {
  ran: boolean;
  passed: boolean;
  outcomes: CheckOutcome[];
  /** Stable identity of the failures, for detecting a stuck loop. */
  signature: string;
}

/**
 * Commands that tell us whether the agent's edits actually work.
 *
 * Detected from the project rather than assumed, and deliberately narrow: a
 * type-check and a test run are evidence. A dev server or a deploy script is
 * not something to run unprompted on somebody's machine.
 */
export function detectChecks(workspace: WorkspaceInfo): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const scripts = workspace.scripts ?? {};
  const runner = workspace.packageManager ?? 'npm';
  const run = (script: string): string =>
    runner === 'npm' ? `npm run ${script}` : `${runner} run ${script}`;

  // Cheapest useful signal first: a type error is found in seconds and makes a
  // test run pointless anyway.
  for (const name of ['typecheck', 'type-check', 'tsc']) {
    if (scripts[name]) {
      checks.push({ label: 'typecheck', command: run(name) });
      break;
    }
  }
  if (checks.length === 0 && scripts.build) {
    checks.push({ label: 'build', command: run('build') });
  }
  if (scripts.test) {
    checks.push({ label: 'test', command: run('test') });
  }

  if (checks.length > 0) return checks;

  // Projects without a package manifest still have conventional entry points.
  if (workspace.manifests.includes('Cargo.toml')) {
    return [
      { label: 'build', command: 'cargo check' },
      { label: 'test', command: 'cargo test' },
    ];
  }
  if (workspace.manifests.includes('go.mod')) {
    return [
      { label: 'build', command: 'go build ./...' },
      { label: 'test', command: 'go test ./...' },
    ];
  }
  if (workspace.testFramework === 'pytest') {
    return [{ label: 'test', command: 'pytest -q' }];
  }

  return [];
}

/** The checks to run: what the user configured, else what the project implies. */
export function checksFor(config: VerifyConfig, workspace: WorkspaceInfo): VerifyCheck[] {
  if (config.commands.length > 0) {
    return config.commands.map((command, index) => ({
      label: `check ${index + 1}`,
      command,
    }));
  }
  return detectChecks(workspace);
}

/**
 * Run the checks and report what happened.
 *
 * Stops at the first failure: once the type-check is red the test output adds
 * noise rather than information, and the model should be told about one problem
 * at a time.
 */
export async function runChecks(options: {
  checks: VerifyCheck[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal | undefined;
  onProgress?: (check: VerifyCheck) => void;
}): Promise<VerifyResult> {
  const outcomes: CheckOutcome[] = [];

  for (const check of options.checks) {
    if (options.signal?.aborted) break;
    options.onProgress?.(check);

    const started = Date.now();
    try {
      const result = await runCommand({
        command: check.command,
        shell: true,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // A shell reports a missing command as an exit code, not an exception:
      // 127 on POSIX, 9009 from cmd.exe. The model cannot install a binary, and
      // asking it to fix this invites it to edit the check instead.
      if (looksUnrunnable(result.code, result.output)) {
        log.debug('check command not available', { command: check.command });
        outcomes.push({
          check,
          passed: true,
          output: '',
          durationMs: Date.now() - started,
          timedOut: false,
          unavailable: true,
        });
        continue;
      }

      const passed = result.code === 0 && !result.timedOut;
      outcomes.push({
        check,
        passed,
        // Failures are read by the model, so keep the tail: compilers and test
        // runners put the summary at the end.
        output: passed ? '' : tailOf(result.output, options.maxOutputChars),
        durationMs: Date.now() - started,
        timedOut: result.timedOut,
      });
      if (!passed) break;
    } catch (error) {
      // The command could not be run at all — a missing binary, usually. That
      // is worth reporting once, not worth retrying against.
      log.debug('check could not run', { command: check.command, error: String(error) });
      outcomes.push({
        check,
        passed: true,
        output: '',
        durationMs: Date.now() - started,
        timedOut: false,
      });
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.passed);
  const usable = outcomes.filter((outcome) => !outcome.unavailable);
  return {
    // Nothing installed means nothing was verified — saying "passed" would be
    // a claim the run does not support.
    ran: usable.length > 0,
    passed: failed.length === 0,
    outcomes,
    signature: signatureOf(failed),
  };
}

/**
 * Whether the shell is saying the command does not exist.
 *
 * The exit code alone is not enough: POSIX shells use 127, but `cmd.exe` on
 * Windows returns 1 for the same thing. The message alone is not enough either
 * — a failing test suite might well print "not found", and reading that as
 * "nothing to verify" would turn a real failure into a pass, which is the worst
 * possible direction to be wrong in.
 *
 * So it takes both: the shell's own not-found wording, and output short enough
 * that it plainly contains nothing else. A real check that ran produces more.
 */
const SHELL_NOT_FOUND = [
  /is not recognized as an internal or external command/i, // cmd.exe
  /command not found/i, // bash, zsh
  /: not found/i, // dash, sh
  /The term '[^']*' is not recognized/i, // PowerShell
];

function looksUnrunnable(code: number | null, output: string): boolean {
  if (code === 0 || code === null) return false;
  const trimmed = output.trim();
  if (trimmed.length > 400) return false;
  return SHELL_NOT_FOUND.some((pattern) => pattern.test(trimmed));
}

/** Keep the end of the output, where compilers and test runners summarise. */
function tailOf(output: string, maxChars: number): string {
  const clean = redact(output.trimEnd());
  const budget = Math.max(400, Math.floor(maxChars / 4));
  if (clean.length <= budget) return clean;
  return `…\n${clean.slice(clean.length - budget)}`;
}

/**
 * A fingerprint of the current failures.
 *
 * Used to notice the agent is going in circles: identical failures two rounds
 * running means the last attempt changed nothing that mattered, and another
 * round will spend tokens to reach the same place. Digits are stripped so line
 * numbers shifting by one does not read as progress.
 */
function signatureOf(failed: CheckOutcome[]): string {
  if (failed.length === 0) return '';
  const material = failed
    .map((outcome) => `${outcome.check.label}:${outcome.output.replace(/\d+/g, '#')}`)
    .join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** What the model is told when a check fails. */
export function failureReport(result: VerifyResult, round: number, maxRounds: number): string {
  const failed = result.outcomes.filter((outcome) => !outcome.passed);
  const lines = [
    `Your changes did not pass verification (attempt ${round} of ${maxRounds}).`,
    '',
  ];

  for (const outcome of failed) {
    lines.push(
      `$ ${outcome.check.command}`,
      outcome.timedOut
        ? `(timed out after ${Math.round(outcome.durationMs / 1000)}s)`
        : clampChars(outcome.output, 6_000).text,
      '',
    );
  }

  lines.push(
    'Fix the cause rather than working around the check. If the check itself is',
    'wrong, say so instead of changing it to pass.',
  );
  return lines.join('\n');
}

/** One line for the transcript when everything passes. */
export function successSummary(result: VerifyResult, rounds: number): string {
  const names = result.outcomes
    .filter((outcome) => !outcome.unavailable)
    .map((outcome) => outcome.check.label)
    .join(', ');
  const time = result.outcomes.reduce((sum, outcome) => sum + outcome.durationMs, 0);
  const attempt = rounds > 1 ? ` after ${rounds} rounds` : '';
  return `Verified${attempt}: ${names} passed in ${(time / 1000).toFixed(1)}s.`;
}

/**
 * Whether the workspace is Orbit's own source.
 *
 * Editing the code of the program that is running is the one case where a
 * broken change is not merely inconvenient: the next launch may not start at
 * all, and the tool needed to fix it is the tool that is broken. So it gets
 * verification and rollback turned on whether or not they were configured.
 *
 * Identified by the package name rather than the directory, so a clone or a
 * fork under any path is recognised.
 */
export function isOwnSource(workspace: WorkspaceInfo): boolean {
  return workspace.name === 'orbit-cli' && workspace.manifests.includes('package.json');
}

/**
 * Verification settings for a workspace, tightened when it is Orbit itself.
 *
 * Nothing here overrides an explicit choice: a user who set `rollbackOnFailure`
 * to false meant it. It only fills in the safer default when they never said.
 */
export function verifyConfigFor(
  config: VerifyConfig,
  workspace: WorkspaceInfo,
  explicitKeys: ReadonlySet<string> = new Set(),
): VerifyConfig {
  if (!isOwnSource(workspace)) return config;
  return {
    ...config,
    enabled: explicitKeys.has('enabled') ? config.enabled : true,
    rollbackOnFailure: explicitKeys.has('rollbackOnFailure') ? config.rollbackOnFailure : true,
  };
}
