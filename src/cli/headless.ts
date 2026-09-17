import type { Agent } from '../agent/agent.js';
import type { AutoMode } from '../agent/autopilot.js';
import type { AgentEvent } from '../agent/loop.js';
import type { PermissionManager, PermissionRequest } from '../permissions/manager.js';
import { errorMessage, OrbitError } from '../util/errors.js';
import { formatCount, oneLine } from '../util/format.js';
import { print, printError, ui } from './prompt.js';

export type HeadlessOutput = 'text' | 'json' | 'stream-json';

export interface HeadlessOptions {
  agent: Agent;
  autoMode: AutoMode;
  permissions: PermissionManager;
  prompt: string;
  output: HeadlessOutput;
  /** Print tool activity as it happens. */
  verbose: boolean;
  /** Approve every permission the auto-mode envelope covers. Without this,
   *  anything that would prompt is denied, because nobody is there to answer. */
  autoApprove: boolean;
}

export interface HeadlessResult {
  exitCode: number;
  text: string;
}

interface ToolRecord {
  name: string;
  ok: boolean;
  summary: string;
  durationMs: number;
}

/**
 * Non-interactive run: one prompt, one answer, an exit code.
 *
 * This is what makes Orbit usable from a script, a git hook or CI. Because
 * nobody can answer a prompt, permissions resolve without a human: either the
 * auto-mode envelope approves them or they are denied and the model is told so.
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const { agent, permissions, autoMode } = options;

  const tools: ToolRecord[] = [];
  const denied: string[] = [];
  const notices: string[] = [];
  let answer = '';
  let failure: OrbitError | null = null;

  // No terminal means no prompting: make that explicit rather than hanging.
  permissions.setPrompter(async (request: PermissionRequest) => {
    denied.push(`${request.category}: ${request.title}`);
    return 'deny';
  });
  if (options.autoApprove) {
    autoMode.set(true);
    permissions.setAutoApprover(autoMode.approver);
  }

  const emit = (event: Record<string, unknown>): void => {
    if (options.output === 'stream-json') print(JSON.stringify(event));
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'assistant-message':
        if (event.text.trim()) answer = event.text;
        emit({ type: 'assistant', text: event.text });
        break;
      case 'tool-end':
        tools.push({
          name: event.name,
          ok: event.result.ok,
          summary: event.result.display.summary,
          durationMs: event.durationMs,
        });
        if (options.verbose && options.output === 'text') {
          printError(
            ui.dim(`  ${event.result.ok ? '+' : 'x'} ${event.name}: ${oneLine(event.result.display.summary, 70)}`),
          );
        }
        emit({
          type: 'tool',
          name: event.name,
          ok: event.result.ok,
          summary: event.result.display.summary,
        });
        break;
      case 'tool-denied':
        denied.push(`${event.name}: ${event.reason}`);
        emit({ type: 'tool-denied', name: event.name, reason: event.reason });
        break;
      case 'notice':
        notices.push(event.message);
        emit({ type: 'notice', message: event.message });
        break;
      case 'error':
        failure = event.error;
        emit({ type: 'error', message: event.error.message, detail: event.error.detail });
        break;
      default:
        break;
    }
  });

  let turnReason = 'complete';
  try {
    const result = await agent.send(options.prompt);
    turnReason = result.reason;
  } catch (error) {
    failure =
      error instanceof OrbitError
        ? error
        : new OrbitError('Orbit could not complete the request.', {
            kind: 'internal',
            detail: errorMessage(error),
          });
  } finally {
    unsubscribe();
    permissions.setPrompter(undefined);
    permissions.setAutoApprover(null);
  }

  const usage = agent.usageTracker.sessionTotals();
  const exitCode = failure ? 1 : turnReason === 'complete' ? 0 : 2;

  if (options.output === 'json') {
    print(
      JSON.stringify(
        {
          ok: !failure,
          reason: turnReason,
          answer,
          tools,
          denied,
          notices,
          usage: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            requests: usage.requests,
          },
          session: agent.sessionRecord.id,
          model: agent.model,
          ...(failure
            ? { error: { message: failure.message, kind: failure.kind, detail: failure.detail } }
            : {}),
        },
        null,
        2,
      ),
    );
  } else if (options.output === 'text') {
    if (failure) {
      printError(ui.error(failure.message));
      if (failure.detail) printError(ui.dim(`  ${failure.detail}`));
    } else {
      if (answer) print(answer);
      if (options.verbose) {
        // Prompt/completion split and the thinking share, so a scripted run can
        // account for what a reasoning model actually cost.
        const parts = [
          `${tools.length} tool calls`,
          `${formatCount(usage.promptTokens)} in`,
          `${formatCount(usage.completionTokens)} out`,
        ];
        if (usage.reasoningTokens) parts.push(`${formatCount(usage.reasoningTokens)} thinking`);
        if (usage.cachedTokens) parts.push(`${formatCount(usage.cachedTokens)} cached`);
        parts.push(turnReason);
        printError(ui.dim(`\n${parts.join(' · ')}`));
      }
      // Always said, verbose or not: a scripted caller has to be able to tell
      // a finished job from one that ran out of steps.
      if (turnReason === 'max-iterations') {
        printError(
          ui.warn('Stopped at the step limit without finishing. The task is incomplete.'),
        );
      }
    }
    for (const entry of denied) {
      printError(ui.warn(`denied: ${entry}`));
    }
  } else {
    emit({
      type: 'result',
      ok: !failure,
      reason: turnReason,
      answer,
      usage: { totalTokens: usage.totalTokens },
    });
  }

  return { exitCode, text: answer };
}
