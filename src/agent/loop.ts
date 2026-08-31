import type { AgentConfig, ToolsConfig } from '../config/schema.js';
import type { ContextManager } from '../context/manager.js';
import type { CompactionEvent } from '../context/manager.js';
import type { OptimizationDecision, TokenOptimizer } from '../context/optimizer.js';
import type { TurnUsage } from '../context/usage.js';
import type { PermissionManager, PermissionRequest } from '../permissions/manager.js';
import type {
  AIProvider,
  ChatResponse,
  ContentPart,
  ToolCall,
  Usage,
} from '../providers/provider.js';
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '../tools/registry.js';
import { toolError } from '../tools/registry.js';
import { OrbitError, errorMessage, isCancellation, toFriendlyError } from '../util/errors.js';
import { formatCount } from '../util/format.js';
import { mapConcurrent, retry, withTimeout } from '../util/async.js';
import { createLogger } from '../util/logger.js';
import { parseToolProtocol } from './protocol.js';
import type { PlanStep } from './planner.js';

const log = createLogger('agent:loop');

/** Ceiling for any single tool call, on top of each tool's own timeout. */
const TOOL_HARD_TIMEOUT_MS = 15 * 60_000;
const PARALLEL_READ_LIMIT = 4;

export type TurnEndReason = 'complete' | 'cancelled' | 'max-iterations' | 'error';

export type AgentEvent =
  | { type: 'turn-start' }
  | { type: 'request-start'; iteration: number }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'assistant-message'; text: string; reasoning?: string }
  | { type: 'tool-start'; call: ToolCall; readOnly: boolean }
  | { type: 'tool-progress'; callId: string; message: string }
  | { type: 'tool-end'; callId: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'tool-denied'; callId: string; name: string; reason: string }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'compaction'; event: CompactionEvent }
  | { type: 'usage'; usage: Usage }
  | { type: 'turn-usage'; turn: TurnUsage }
  | { type: 'optimization'; decision: OptimizationDecision }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'notice'; message: string }
  | { type: 'context-window'; tokens: number; source: string; detail: string }
  | { type: 'failover'; from: string; to: string; model: string; reason: string }
  | { type: 'checkpoint'; turn: number; files: number }
  | { type: 'error'; error: OrbitError }
  | { type: 'turn-end'; reason: TurnEndReason; iterations: number };

export interface TurnResult {
  reason: TurnEndReason;
  iterations: number;
  usage: Usage;
  error?: OrbitError;
}

/** Where the loop turns when the active provider will not answer. */
export interface ProviderChoice {
  provider: AIProvider;
  model: string;
  label: string;
}

export interface FailoverGateway {
  /** The next provider to try, or undefined to give up and surface the error. */
  next(error: OrbitError): ProviderChoice | undefined;
  /** Called once a switch is decided, so the session can follow it. */
  onSwitch(to: ProviderChoice, reason: string): void;
}

export interface AgentLoopDeps {
  provider: AIProvider;
  model: string;
  /** Display name for the provider, used in failover messages. */
  providerLabel?: string;
  context: ContextManager;
  registry: ToolRegistry;
  permissions: PermissionManager;
  config: AgentConfig;
  /** Adaptive token budgeting. Omit to use the configured limits as-is. */
  optimizer?: TokenOptimizer;
  /** Recent completion sizes, used to right-size the response budget. */
  usageStats?: {
    averageCompletion(): number;
    peakCompletion(): number;
    /** Thinking sizes, which share the output budget with the answer. */
    averageReasoning?(): number;
    peakReasoning?(): number;
    /** Whether the last request was cut off by its own budget. */
    lastWasTruncated?(): boolean;
    requests(): number;
  };
  /** Builds a fresh ToolContext for each call (carries the abort signal). */
  createToolContext(
    signal: AbortSignal,
    progress: (message: string) => void,
    limits?: Partial<ToolsConfig>,
  ): ToolContext;
  emit(event: AgentEvent): void;
  /** Used by context compaction to fold old turns into a written summary. */
  summarize?: (transcript: string, signal?: AbortSignal) => Promise<string>;
  onToolExecuted?(name: string, result: ToolResult): void;
  /**
   * Lifecycle hooks around tool execution. `beforeTool` may veto the call by
   * returning a reason, which is reported to the model as a denial.
   */
  /**
   * Somewhere else to ask when the active provider will not answer. Consulted
   * only after retries are exhausted, and only for failures a different
   * provider could plausibly succeed at.
   */
  failover?: FailoverGateway;
  hooks?: {
    beforeTool(call: ToolCall, args: unknown, signal: AbortSignal): Promise<string | undefined>;
    afterTool(call: ToolCall, args: unknown, result: ToolResult, signal: AbortSignal): Promise<void>;
  };
}

/**
 * The controlled agent loop: model → tool calls → permission → execution →
 * results → model, until the model stops asking for tools.
 */
export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  private readonly usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  /** Who is answering right now. Changes only through failover. */
  private active: { provider: AIProvider; model: string; label: string };
  /** Retries spent widening the output budget within this turn. */
  private outputLimitRetries = 0;
  /**
   * A budget the optimizer must not shrink below, set after a truncation. The
   * optimizer sizes from observation; this is the one case where the loop knows
   * better than the observation does.
   */
  private forcedBudget: number | undefined;
  /** Response budget granted for the request currently in flight. */
  private responseBudget: number;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.responseBudget = deps.config.maxTokens;
    this.active = {
      provider: deps.provider,
      model: deps.model,
      label: deps.providerLabel ?? deps.provider.name,
    };
  }

  /** Who answered, which is not always who was asked. */
  activeProvider(): { provider: AIProvider; model: string; label: string } {
    return this.active;
  }

  async run(signal: AbortSignal): Promise<TurnResult> {
    const { emit, config } = this.deps;
    emit({ type: 'turn-start' });

    let iterations = 0;

    try {
      while (iterations < config.maxIterations) {
        if (signal.aborted) return this.finish('cancelled', iterations);
        iterations++;

        const decision = this.optimize();
        await this.maybeCompact(signal, decision?.compactFirst ?? false);
        if (signal.aborted) return this.finish('cancelled', iterations);

        emit({ type: 'request-start', iteration: iterations });

        const startedAt = Date.now();
        const response = await this.requestModel(signal);
        if (signal.aborted || response.finishReason === 'cancelled') {
          if (response.text.trim()) {
            this.deps.context.addAssistantMessage(response.text, []);
            emit({ type: 'assistant-message', text: response.text });
          }
          return this.finish('cancelled', iterations);
        }

        if (response.usage) {
          this.accumulateUsage(response.usage);
          emit({
            type: 'turn-usage',
            turn: {
              at: new Date().toISOString(),
              model: this.active.model,
              provider: this.active.label,
              promptTokens: response.usage.promptTokens,
              completionTokens: response.usage.completionTokens,
              cachedTokens: response.usage.cachedTokens,
              reasoningTokens: response.usage.reasoningTokens,
              budgetTokens: this.responseBudget,
              truncated: response.finishReason === 'length',
              durationMs: Date.now() - startedAt,
            },
          });
          emit({ type: 'usage', usage: { ...this.usage } });
        }

        const { text, calls, protocolErrors } = this.extractToolCalls(response);

        if (calls.length === 0) {
          // Checked before the message is recorded: a think that consumed the
          // whole grant produced nothing worth keeping, and asking again with a
          // bigger budget beats handing back an empty turn for the user to prod
          // with "continue".
          if (response.finishReason === 'length' && this.shouldWidenAndRetry(text)) {
            const previous = this.responseBudget;
            this.outputLimitRetries += 1;
            this.forcedBudget = Math.max(previous * 2, previous + 4_096);
            emit({
              type: 'notice',
              message: `Output limit reached at ${formatCount(previous)} tokens with nothing but thinking to show. Retrying with ${formatCount(this.forcedBudget)}.`,
            });
            continue;
          }

          this.deps.context.addAssistantMessage(text, []);
          emit({ type: 'assistant-message', text, reasoning: response.reasoning });

          if (protocolErrors.length > 0) {
            // The model tried to call a tool and got the format wrong; tell it.
            this.deps.context.addSystemNote(
              `Your tool block could not be parsed: ${protocolErrors.join('; ')}. Re-send it using the exact protocol format.`,
            );
            continue;
          }

          if (response.finishReason === 'length') {
            emit({
              type: 'notice',
              message: 'The response hit the model output limit and may be incomplete.',
            });
          }
          return this.finish('complete', iterations);
        }

        this.deps.context.addAssistantMessage(text, calls);
        if (text.trim()) emit({ type: 'assistant-message', text, reasoning: response.reasoning });

        const outcome = await this.executeCalls(calls, signal);
        if (outcome === 'cancelled') return this.finish('cancelled', iterations);
      }

      this.deps.context.addSystemNote(
        `Stopped after ${config.maxIterations} tool iterations without completing. Summarize what you did and what remains.`,
      );
      emit({
        type: 'notice',
        message: `Reached the ${config.maxIterations}-step limit for one turn. Ask Orbit to continue if it should keep going.`,
      });
      return this.finish('max-iterations', iterations);
    } catch (error) {
      if (isCancellation(error)) return this.finish('cancelled', iterations);
      const friendly = toFriendlyError(error, { provider: this.active.label });
      log.error('agent loop failed', { message: friendly.message, detail: friendly.detail });
      emit({ type: 'error', error: friendly });
      return { reason: 'error', iterations, usage: { ...this.usage }, error: friendly };
    }
  }

  private finish(reason: TurnEndReason, iterations: number): TurnResult {
    this.deps.emit({ type: 'turn-end', reason, iterations });
    return { reason, iterations, usage: { ...this.usage } };
  }

  private accumulateUsage(usage: Usage): void {
    this.usage.promptTokens += usage.promptTokens;
    this.usage.completionTokens += usage.completionTokens;
    this.usage.totalTokens += usage.totalTokens;
  }

  private nativeToolsAvailable(): boolean {
    // The active provider, which after a failover is not the one in deps.
    return (
      this.active.provider.supportsTools(this.active.model) && this.deps.registry.list().length > 0
    );
  }

  /**
   * Size this request against the window that is actually left, rather than
   * sending the same max_tokens on turn 1 and turn 40.
   */
  private optimize(): OptimizationDecision | null {
    const { optimizer, usageStats, context, registry, config, emit } = this.deps;
    if (!optimizer) {
      this.responseBudget = this.forcedBudget ?? config.maxTokens;
      return null;
    }

    const tools = this.nativeToolsAvailable() ? registry.definitions() : [];
    const budget = context.budget(tools);

    const decision = optimizer.decide({
      window: budget.window,
      used: budget.used,
      configuredMaxTokens: config.maxTokens,
      averageCompletion: usageStats?.averageCompletion() ?? 0,
      peakCompletion: usageStats?.peakCompletion() ?? 0,
      averageReasoning: usageStats?.averageReasoning?.() ?? 0,
      peakReasoning: usageStats?.peakReasoning?.() ?? 0,
      lastTruncated: usageStats?.lastWasTruncated?.() ?? false,
      samples: usageStats?.requests() ?? 0,
    });

    this.responseBudget = this.forcedBudget
      ? Math.max(decision.responseTokens, Math.min(this.forcedBudget, budget.available))
      : decision.responseTokens;
    if (decision.changed) emit({ type: 'optimization', decision });
    return decision;
  }

  /**
   * Whether hitting the output limit is worth another, larger attempt.
   *
   * Only when the model produced nothing usable — a reply that was cut off
   * mid-sentence still has content worth keeping, and re-asking would throw
   * away work and bill for it twice. A think that ate the whole budget produced
   * no answer at all, which is the case worth retrying.
   */
  private shouldWidenAndRetry(text: string): boolean {
    const config = this.deps.optimizer?.getConfig();
    if (!config?.retryOnOutputLimit) return false;
    if (this.outputLimitRetries >= config.maxOutputLimitRetries) return false;
    if (text.trim().length > 0) return false;

    // Room to actually grant more, or there is no point asking again.
    const tools = this.nativeToolsAvailable() ? this.deps.registry.definitions() : [];
    const budget = this.deps.context.budget(tools);
    return budget.available > this.responseBudget + 1_024;
  }

  private async maybeCompact(signal: AbortSignal, force = false): Promise<void> {
    const { context, config, registry, emit } = this.deps;
    const tools = this.nativeToolsAvailable() ? registry.definitions() : [];
    const needed = force || context.needsCompaction(tools);
    if (!config.autoCompact || !needed) return;

    await context.compact({
      tools,
      signal,
      force,
      summarizer: this.deps.summarize,
      onEvent: (event) => emit({ type: 'compaction', event }),
    });
    context.enforceHardLimit(tools);
  }

  /**
   * One streamed model call: retries for transient faults, then a different
   * provider for faults that retrying cannot fix.
   *
   * The conversation itself is provider-agnostic, so a switch mid-turn keeps
   * every message and tool result already gathered. What does change is whether
   * native tool calling is available, so that is recomputed per candidate.
   */
  private async requestModel(signal: AbortSignal): Promise<ChatResponse> {
    for (;;) {
      try {
        return await this.requestOnce(signal);
      } catch (error) {
        if (isCancellation(error) || signal.aborted) throw error;
        if (!(error instanceof OrbitError)) throw error;

        const next = this.deps.failover?.next(error);
        if (!next) throw error;

        const from = this.active.label;
        this.active = next;
        this.deps.failover?.onSwitch(next, error.message);
        this.deps.emit({
          type: 'failover',
          from,
          to: next.label,
          model: next.model,
          reason: error.message,
        });
      }
    }
  }

  private async requestOnce(signal: AbortSignal): Promise<ChatResponse> {
    const { context, registry, config, emit } = this.deps;
    const { provider, model } = this.active;
    const useNativeTools = this.nativeToolsAvailable();

    return retry(
      async () => {
        const events = provider.stream({
          model,
          messages: context.messages(),
          tools: useNativeTools ? registry.definitions() : undefined,
          temperature: config.temperature,
          maxTokens: this.responseBudget,
          cachePrefix: this.deps.optimizer?.getConfig().promptCaching ?? false,
          signal,
        });

        let final: ChatResponse | null = null;
        for await (const event of events) {
          if (event.type === 'text') emit({ type: 'text-delta', delta: event.delta });
          else if (event.type === 'reasoning') emit({ type: 'reasoning-delta', delta: event.delta });
          else if (event.type === 'done') final = event.response;
        }

        if (!final) {
          throw new OrbitError('The provider closed the stream without a response.', {
            kind: 'provider',
            retryable: true,
          });
        }
        return final;
      },
      {
        attempts: config.maxRetries + 1,
        signal,
        shouldRetry: (error) => {
          if (isCancellation(error) || signal.aborted) return false;
          return error instanceof OrbitError ? error.retryable : false;
        },
        onRetry: (error, attempt, delayMs) => {
          emit({ type: 'retry', attempt, delayMs, reason: errorMessage(error) });
        },
      },
    );
  }

  /** Native tool calls when supported, parsed protocol blocks otherwise. */
  private extractToolCalls(response: ChatResponse): {
    text: string;
    calls: ToolCall[];
    protocolErrors: string[];
  } {
    if (this.nativeToolsAvailable()) {
      return { text: response.text, calls: response.toolCalls, protocolErrors: [] };
    }
    const parsed = parseToolProtocol(response.text);
    return {
      text: parsed.text,
      calls: parsed.calls,
      protocolErrors: parsed.errors.map((e) => `${e.name}: ${e.reason}`),
    };
  }

  /**
   * Resolve, authorize, then execute a batch of tool calls. Authorization is
   * strictly sequential because approval prompts are modal; execution of
   * consecutive read-only calls is parallelised.
   */
  private async executeCalls(calls: ToolCall[], signal: AbortSignal): Promise<'ok' | 'cancelled'> {
    const { registry, permissions, context, emit } = this.deps;

    interface Prepared {
      call: ToolCall;
      tool?: Tool;
      args?: unknown;
      readOnly: boolean;
      /** Set when the call cannot run: unknown tool, bad args, or denial. */
      failure?: ToolResult;
      denialReason?: string;
    }

    const prepared: Prepared[] = [];

    for (const call of calls) {
      if (signal.aborted) return 'cancelled';

      const tool = registry.get(call.name);
      if (!tool) {
        const suggestion = registry.suggest(call.name);
        prepared.push({
          call,
          readOnly: true,
          failure: toolError(
            `No tool named "${call.name}".${suggestion ? ` Did you mean "${suggestion}"?` : ''} Available tools: ${registry.names().join(', ')}.`,
          ),
        });
        continue;
      }

      if ('__orbit_unparsed_arguments' in (call.arguments ?? {})) {
        prepared.push({
          call,
          tool,
          readOnly: tool.readOnly,
          failure: toolError(
            `The arguments for ${call.name} were not valid JSON. Send the arguments again as a well-formed JSON object.`,
          ),
        });
        continue;
      }

      let args: unknown;
      try {
        args = tool.parse(call.arguments ?? {});
      } catch (error) {
        prepared.push({
          call,
          tool,
          readOnly: tool.readOnly,
          failure: toolError(
            error instanceof OrbitError && error.detail
              ? `${error.message} ${error.detail}`
              : errorMessage(error),
          ),
        });
        continue;
      }

      // Authorization happens here, before anything is executed.
      const toolContext = this.deps.createToolContext(signal, () => {});
      let request: PermissionRequest | null = null;
      try {
        request = await tool.authorize(args, toolContext);
      } catch (error) {
        prepared.push({
          call,
          tool,
          args,
          readOnly: tool.readOnly,
          failure: toolError(errorMessage(error)),
        });
        continue;
      }

      if (tool.permission && !request) {
        // Tools with a permission class but no custom prompt still get checked.
        request = {
          category: tool.permission,
          tool: tool.name,
          title: `${tool.name}`,
        };
      }

      let effectiveArgs = args;
      let partialNote: string | undefined;

      if (request) {
        const decision = await permissions.check(request);
        if (!decision.granted) {
          const reason = decision.reason ?? 'The user denied this operation.';
          prepared.push({
            call,
            tool,
            args,
            readOnly: tool.readOnly,
            failure: toolError(`Permission denied. ${reason}`, { summary: 'denied by user' }),
            denialReason: reason,
          });
          continue;
        }

        // The user accepted some of the change. The tool rewrites its own
        // arguments to match, because only it knows how they map onto the file.
        if (decision.choice === 'partial' && decision.selectedHunks && tool.narrow) {
          const narrowed = await tool.narrow(args, decision.selectedHunks, toolContext);
          if (narrowed === null) {
            // Refuse rather than write something that is neither what the model
            // proposed nor what the user picked.
            const reason =
              'The selected changes could not be applied on their own — they overlap. Propose them separately.';
            prepared.push({
              call,
              tool,
              args,
              readOnly: tool.readOnly,
              failure: toolError(`Permission denied. ${reason}`, { summary: 'partial apply failed' }),
              denialReason: reason,
            });
            continue;
          }
          effectiveArgs = narrowed;
          partialNote = decision.reason;
        }
      }

      prepared.push({
        call,
        tool,
        args: effectiveArgs,
        readOnly: tool.readOnly,
        ...(partialNote ? { partialNote } : {}),
      });
    }

    if (signal.aborted) return 'cancelled';

    // Execute in the order the model requested, so tool results line up with
    // the calls. Only consecutive read-only calls are parallelised.
    const batches = groupConsecutive(prepared, (item) => item.readOnly && !item.failure);

    // Images produced by tools are collected and attached *after* every tool
    // result: a user message in the middle would orphan the remaining results
    // from the assistant message that requested them.
    const attachments: ContentPart[] = [];
    const attachmentNames: string[] = [];

    for (const batch of batches) {
      if (signal.aborted) return 'cancelled';
      const parallel =
        this.deps.config.parallelReadTools && batch.length > 1 && batch[0]!.readOnly && !batch[0]!.failure;

      const collect = (parts: ContentPart[] | undefined, names: string[]): void => {
        if (!parts?.length) return;
        attachments.push(...parts);
        attachmentNames.push(...names);
      };

      if (parallel) {
        await mapConcurrent(batch, PARALLEL_READ_LIMIT, async (item) => {
          const produced = await this.dispatch(item, signal);
          collect(produced.images, produced.names);
        });
      } else {
        for (const item of batch) {
          if (signal.aborted) return 'cancelled';
          const produced = await this.dispatch(item, signal);
          collect(produced.images, produced.names);
        }
      }
    }

    if (attachments.length > 0) {
      context.addAttachments(
        attachments,
        `Images attached by tools: ${attachmentNames.join(', ')}.`,
      );
    }

    return signal.aborted ? 'cancelled' : 'ok';
  }

  /** Emit and record a prepared call, whether it failed preparation or runs. */
  private async dispatch(
    item: {
      call: ToolCall;
      tool?: Tool;
      args?: unknown;
      readOnly: boolean;
      failure?: ToolResult;
      denialReason?: string;
      /** Told to the model when only part of a proposed change was accepted. */
      partialNote?: string;
    },
    signal: AbortSignal,
  ): Promise<{ images?: ContentPart[]; names: string[] }> {
    const { emit, context } = this.deps;

    if (item.failure) {
      emit({ type: 'tool-start', call: item.call, readOnly: item.readOnly });
      if (item.denialReason) {
        emit({
          type: 'tool-denied',
          callId: item.call.id,
          name: item.call.name,
          reason: item.denialReason,
        });
      } else {
        emit({
          type: 'tool-end',
          callId: item.call.id,
          name: item.call.name,
          result: item.failure,
          durationMs: 0,
        });
      }
      context.addToolResult(item.call, item.failure.content);
      return { names: [] };
    }

    return this.runOne(item.tool!, item.call, item.args, signal, item.partialNote);
  }

  private async runOne(
    tool: Tool,
    call: ToolCall,
    args: unknown,
    signal: AbortSignal,
    partialNote?: string,
  ): Promise<{ images?: ContentPart[]; names: string[] }> {
    const { emit, context } = this.deps;
    emit({ type: 'tool-start', call, readOnly: tool.readOnly });

    const started = Date.now();
    const toolContext = this.deps.createToolContext(
      signal,
      (message) => emit({ type: 'tool-progress', callId: call.id, message }),
      this.deps.optimizer?.toolLimits(),
    );

    // A blocking pre-tool hook gets to refuse before anything runs. The model
    // is told why, so it can adapt rather than retrying the same call.
    if (this.deps.hooks) {
      const veto = await this.deps.hooks.beforeTool(call, args, signal);
      if (veto) {
        emit({ type: 'tool-denied', callId: call.id, name: tool.name, reason: veto });
        context.addToolResult(call, `Refused by a hook: ${veto}`);
        return { names: [] };
      }
    }

    let result: ToolResult;
    try {
      result = await withTimeout(
        tool.execute(args, toolContext),
        TOOL_HARD_TIMEOUT_MS,
        `${tool.name}`,
      );
    } catch (error) {
      if (isCancellation(error) || signal.aborted) {
        result = toolError(`${tool.name} was cancelled before it finished.`);
      } else {
        const friendly = toFriendlyError(error);
        log.warn('tool threw', { tool: tool.name, message: friendly.message });
        result = toolError(friendly.detail ? `${friendly.message} ${friendly.detail}` : friendly.message);
      }
    }

    const durationMs = Date.now() - started;
    emit({ type: 'tool-end', callId: call.id, name: tool.name, result, durationMs });
    this.deps.onToolExecuted?.(tool.name, result);
    // Runs before the result is handed back, so a formatter has finished with
    // the file by the time the model reads about it.
    if (this.deps.hooks) await this.deps.hooks.afterTool(call, args, result, signal);

    // The model has to know it got less than it asked for, or it will assume the
    // rest landed and build on it.
    context.addToolResult(
      call,
      partialNote ? `${result.content}\n\n${partialNote}` : result.content,
    );

    const images = result.images?.length ? result.images : undefined;
    return {
      images,
      names: images?.map((image) => image.name ?? image.mediaType) ?? [],
    };
  }
}

/** Split a list into runs of consecutive items sharing a predicate value. */
export function groupConsecutive<T>(items: T[], key: (item: T) => boolean): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && key(last[0]!) === key(item)) last.push(item);
    else groups.push([item]);
  }
  return groups;
}
