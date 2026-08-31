import path from 'node:path';
import type { HookConfig, HookEvent, HooksConfig } from '../config/schema.js';
import { runCommand } from '../util/process.js';
import { createLogger } from '../util/logger.js';
import { redact } from '../util/redact.js';

const log = createLogger('hooks');

/** Facts about what just happened, handed to the hook as env vars and stdin. */
export interface HookPayload {
  event: HookEvent;
  workspace: string;
  sessionId: string;
  model: string;
  provider: string;
  /** Tool events only. */
  tool?: string;
  toolArgs?: unknown;
  /** The path the tool is acting on, when it has exactly one. */
  file?: string;
  /** Turn events only. */
  turn?: number;
  turnEndReason?: string;
  /** `post-tool` only: whether the tool reported failure. */
  ok?: boolean;
}

export interface HookOutcome {
  hook: HookConfig;
  /** Null when the process was killed or never started. */
  code: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the hook could not be run at all. */
  error?: string;
}

/** What a blocking `pre-tool` hook decided. */
export interface HookVeto {
  hookName: string;
  reason: string;
}

const MAX_HOOK_OUTPUT = 8_000;

/**
 * Matches a tool name against a hook's `tools` list. A bare string matches
 * exactly; `/pattern/` is a regular expression, so one hook can cover
 * `write_file` and `edit_file` without listing every tool by hand.
 */
export function hookMatchesTool(hook: HookConfig, tool: string | undefined): boolean {
  if (hook.tools.length === 0) return true;
  if (!tool) return false;
  return hook.tools.some((entry) => {
    const asRegex = /^\/(.*)\/([a-z]*)$/.exec(entry);
    if (asRegex?.[1] !== undefined) {
      try {
        return new RegExp(asRegex[1], asRegex[2]).test(tool);
      } catch {
        return false; // A malformed pattern matches nothing rather than everything.
      }
    }
    return entry === tool;
  });
}

/**
 * The environment a hook sees. Orbit's own variables are prefixed `ORBIT_` and
 * the full payload also arrives on stdin as JSON, so a hook can either read one
 * variable in a one-liner or parse the lot in a script.
 */
export function hookEnvironment(payload: HookPayload): Record<string, string> {
  const env: Record<string, string> = {
    ORBIT_EVENT: payload.event,
    ORBIT_WORKSPACE: payload.workspace,
    ORBIT_SESSION: payload.sessionId,
    ORBIT_MODEL: payload.model,
    ORBIT_PROVIDER: payload.provider,
  };
  if (payload.tool) env.ORBIT_TOOL = payload.tool;
  if (payload.file) {
    env.ORBIT_FILE = payload.file;
    env.ORBIT_FILE_RELATIVE = path.relative(payload.workspace, payload.file) || payload.file;
  }
  if (payload.turn !== undefined) env.ORBIT_TURN = String(payload.turn);
  if (payload.turnEndReason) env.ORBIT_TURN_REASON = payload.turnEndReason;
  if (payload.ok !== undefined) env.ORBIT_TOOL_OK = payload.ok ? '1' : '0';
  if (payload.toolArgs !== undefined) {
    try {
      env.ORBIT_TOOL_ARGS = JSON.stringify(payload.toolArgs).slice(0, 16_000);
    } catch {
      // Unserialisable arguments simply do not get the variable.
    }
  }
  return env;
}

/**
 * Runs the user's lifecycle hooks.
 *
 * Hooks are a deliberate escape hatch — they execute whatever command you put
 * in your config — so the rules are narrow: they come from your user config
 * only, they are bounded by a timeout, their output is capped and redacted, and
 * a hook that fails is reported rather than being allowed to take the session
 * down with it. The one exception is a `blocking` `pre-tool` hook, whose
 * non-zero exit is the whole point: it stops the tool call.
 */
export class HookRunner {
  private readonly config: HooksConfig;
  private reporter: ((outcome: HookOutcome) => void) | undefined;

  constructor(config: HooksConfig) {
    this.config = config;
  }

  /** Where to send hook output and failures for display. */
  onOutcome(reporter: (outcome: HookOutcome) => void): void {
    this.reporter = reporter;
  }

  /** True when at least one enabled hook exists for an event. */
  has(event: HookEvent, tool?: string): boolean {
    return this.hooksFor(event, tool).length > 0;
  }

  count(): number {
    return this.config.enabled ? this.config.entries.filter((hook) => hook.enabled).length : 0;
  }

  private hooksFor(event: HookEvent, tool?: string): HookConfig[] {
    if (!this.config.enabled) return [];
    return this.config.entries.filter(
      (hook) => hook.enabled && hook.on === event && hookMatchesTool(hook, tool),
    );
  }

  /**
   * Run every hook for an event, in the order they appear in config.
   *
   * Sequential rather than parallel: hooks mutate the workspace (formatting a
   * file, regenerating a lockfile) and two of them racing on the same file is a
   * bug the user cannot debug.
   */
  async run(event: HookEvent, payload: HookPayload, signal?: AbortSignal): Promise<HookOutcome[]> {
    const hooks = this.hooksFor(event, payload.tool);
    const outcomes: HookOutcome[] = [];
    for (const hook of hooks) {
      const outcome = await this.runOne(hook, payload, signal);
      outcomes.push(outcome);
      this.reporter?.(outcome);
    }
    return outcomes;
  }

  /**
   * Run the blocking `pre-tool` hooks and report the first veto.
   *
   * Non-blocking hooks for the same event still run — a logging hook should not
   * have to opt out of being useful — but only a blocking one can stop the call.
   */
  async vetoFor(payload: HookPayload, signal?: AbortSignal): Promise<HookVeto | undefined> {
    const outcomes = await this.run('pre-tool', payload, signal);
    for (const outcome of outcomes) {
      if (!outcome.hook.blocking) continue;
      const failed = outcome.code !== 0 || outcome.timedOut || outcome.error !== undefined;
      if (!failed) continue;
      const reason = outcome.timedOut
        ? `timed out after ${outcome.hook.timeoutMs}ms`
        : (outcome.error ?? outcome.output.trim() ?? '').slice(0, 500) ||
          `exited with code ${String(outcome.code)}`;
      return { hookName: describeHook(outcome.hook), reason };
    }
    return undefined;
  }

  private async runOne(
    hook: HookConfig,
    payload: HookPayload,
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    const started = Date.now();
    log.debug('running hook', { hook: describeHook(hook), event: hook.on });

    try {
      const result = await runCommand({
        command: hook.command,
        cwd: payload.workspace,
        env: hookEnvironment(payload),
        shell: hook.shell,
        timeoutMs: hook.timeoutMs,
        maxOutputChars: MAX_HOOK_OUTPUT,
        input: safePayloadJson(payload),
        ...(signal ? { signal } : {}),
      });
      return {
        hook,
        code: result.code,
        output: redact(result.output).trim(),
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      };
    } catch (error) {
      // A command that does not exist, or a cwd that vanished. Report it; the
      // session carries on.
      return {
        hook,
        code: null,
        output: '',
        durationMs: Date.now() - started,
        timedOut: false,
        error: redact(error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

/** A stable label for a hook, whether or not the user named it. */
export function describeHook(hook: HookConfig): string {
  if (hook.name) return hook.name;
  const command = hook.command.length > 40 ? `${hook.command.slice(0, 37)}…` : hook.command;
  return `${hook.on}: ${command}`;
}

function safePayloadJson(payload: HookPayload): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ event: payload.event, workspace: payload.workspace });
  }
}
