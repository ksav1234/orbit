import fs from 'node:fs/promises';
import path from 'node:path';
import type { OrbitConfig, ToolsConfig } from '../config/schema.js';
import { ContextManager } from '../context/manager.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { Sandbox } from '../permissions/sandbox.js';
import type { AIProvider, ContentPart, ImagePart, ToolCall, Usage } from '../providers/provider.js';
import { ToolRegistry, type DelegateRequest, type DelegateResult, type ToolContext, type ToolResult } from '../tools/registry.js';
import type { CheckpointManager } from '../checkpoints/manager.js';
import type { BackgroundRegistry } from '../tools/background.js';
import { FileReadTracker } from '../tools/tracker.js';
import { SUBAGENT_SYSTEM_PROMPT } from './subagent.js';
import type { WorkspaceInfo } from '../tools/project.js';
import { detectWorkspace } from '../tools/project.js';
import { readGitState, type GitState } from '../tools/git.js';
import { IMAGE_MEDIA_TYPES, readImageDimensions } from '../tools/image.js';
import {
  newSessionRecord,
  titleFromPrompt,
  type SessionManager,
  type SessionRecord,
  type ToolHistoryEntry,
} from '../sessions/manager.js';
import { createLogger } from '../util/logger.js';
import { formatBytes } from '../util/format.js';
import {
  AgentLoop,
  type AgentEvent,
  type FailoverGateway,
  type ProviderChoice,
  type TurnResult,
} from './loop.js';
import { Planner } from './planner.js';
import { SUMMARIZER_PROMPT } from '../context/compaction.js';
import { TokenOptimizer } from '../context/optimizer.js';
import { UsageTracker } from '../context/usage.js';
import { describeWindowSource, type WindowResolution, type WindowSource } from '../context/window.js';
import type { HookPayload, HookRunner } from '../hooks/runner.js';
import { ShellSession } from '../tools/shell-session.js';
import { OrbitError } from '../util/errors.js';
import { buildSystemPrompt, PROJECT_INSTRUCTION_FILES } from './prompts.js';

const log = createLogger('agent');

export interface AgentOptions {
  provider: AIProvider;
  model: string;
  config: OrbitConfig;
  sandbox: Sandbox;
  permissions: PermissionManager;
  registry: ToolRegistry;
  planner: Planner;
  workspace: WorkspaceInfo;
  git?: GitState;
  sessions: SessionManager;
  session?: SessionRecord;
  providerLabel: string;
  /** Shared usage tracker; one is created if not supplied. */
  usageTracker?: UsageTracker;
  /** Snapshots file changes so turns can be undone. */
  checkpoints?: CheckpointManager;
  /** Long-running processes started by tools. */
  background?: BackgroundRegistry;
  /** Tavily credentials for the web tools. */
  webApiKey?: string;
  /** Depth of this agent in the delegation tree. 0 is the user-facing agent. */
  depth?: number;
  /**
   * Resolve the context window for a provider/model pair. Injected so the
   * agent never has to know about detection caches or the network; falls back
   * to the provider's own estimate when absent.
   */
  resolveWindow?: (provider: AIProvider, model: string) => WindowResolution;
  /**
   * Ask the provider for the real window for a newly selected model. Called
   * on every provider/model switch; the result is applied when it arrives, so
   * a slow provider never delays the switch itself.
   */
  detectWindow?: (provider: AIProvider, model: string) => Promise<WindowResolution | undefined>;
  /** User lifecycle hooks. Omit to run without any. */
  hooks?: HookRunner;
  /**
   * Build a provider by id, for failover. Returning undefined means the id is
   * unusable (no key, bad config) and the next candidate is tried.
   */
  providerFor?: (id: string) => { provider: AIProvider; model: string; label: string } | undefined;
}

export type AgentListener = (event: AgentEvent) => void;

/** Never hold back more than this share of the window for the reply. */
const MAX_RESERVE_SHARE = 0.25;

/**
 * Room held back for the model's answer.
 *
 * This has to scale with the window: a flat 16k reserve is reasonable on a
 * 200k model and absurd on a 32k one, where it would swallow half the context
 * before the conversation even starts.
 */
export function responseReserveFor(contextWindow: number, maxTokens: number): number {
  const wanted = Math.min(maxTokens * 2, 16_000);
  const ceiling = Math.floor(contextWindow * MAX_RESERVE_SHARE);
  return Math.max(1024, Math.min(wanted, ceiling));
}

/**
 * The single path a tool is acting on, when there is one.
 *
 * Hooks want `$ORBIT_FILE` for the common case — format the file that was just
 * written — and the tools that take a path all name it the same way. A tool
 * with several paths gets no variable rather than an arbitrary one.
 */
function filePathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'file', 'file_path', 'filename']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Whether a failure is one a different provider could plausibly succeed at.
 *
 * A rejected request (bad tool schema, oversized prompt, unsupported image) is
 * the request's fault and would be rejected again everywhere, so it never
 * triggers a switch — that would just burn credit at a second provider to reach
 * the same error more slowly.
 */
export function failoverApplies(error: OrbitError, triggers: readonly string[]): boolean {
  switch (error.kind) {
    case 'rate-limit':
      return triggers.includes('rate-limit');
    case 'billing':
      return triggers.includes('billing');
    case 'auth':
      return triggers.includes('auth');
    case 'network':
      return triggers.includes('network');
    case 'provider':
      // `provider` covers both "server trouble" (retryable, worth switching)
      // and "your request was wrong" (not).
      return error.retryable && triggers.includes('server');
    default:
      return false;
  }
}

export interface AttachmentNotice {
  kind: 'image' | 'pdf' | 'skipped';
  path: string;
  detail: string;
}

/**
 * Orchestrates a conversation: owns the context, the tool registry, the
 * session record, and the loop that ties them to a provider.
 */
export class Agent {
  readonly context: ContextManager;
  readonly planner: Planner;
  readonly usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  readonly optimizer: TokenOptimizer;
  readonly usageTracker: UsageTracker;
  readonly fileTracker = new FileReadTracker();

  private options: AgentOptions;
  private listeners = new Set<AgentListener>();
  private controller: AbortController | null = null;
  private session: SessionRecord;
  private toolHistory: ToolHistoryEntry[] = [];
  private windowSource: WindowSource = 'name';
  /**
   * One shell session per agent, so `cd` in one command is still in effect for
   * the next. A sub-agent gets its own, which keeps its exploration from moving
   * the parent's shell out from under it.
   */
  private readonly shellSession: ShellSession;
  /** Who the session started with, to return to after a failover. */
  private readonly primary: { provider: AIProvider; model: string; label: string };
  private projectInstructions = '';
  private running = false;

  constructor(options: AgentOptions) {
    this.options = options;
    this.planner = options.planner;
    this.usageTracker = options.usageTracker ?? new UsageTracker();
    this.optimizer = new TokenOptimizer(options.config.optimizer, options.config.tools);
    this.session =
      options.session ??
      newSessionRecord({
        workspace: options.sandbox.root,
        provider: {
          id: options.provider.id,
          label: options.providerLabel,
          model: options.model,
        },
      });

    this.shellSession = new ShellSession(options.sandbox);
    this.primary = {
      provider: options.provider,
      model: options.model,
      label: options.providerLabel,
    };

    const window = this.windowFor(options.provider, options.model);
    this.windowSource = window.source;
    this.context = new ContextManager({
      contextWindow: window.tokens,
      compactThreshold: options.config.agent.compactThreshold,
      responseReserve: responseReserveFor(window.tokens, options.config.agent.maxTokens),
    });

    if (options.session) {
      this.context.restore(options.session.entries);
      this.toolHistory = [...options.session.toolHistory];
      Object.assign(this.usage, options.session.usage);
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Load project instruction files and build the initial system prompt. */
  async initialize(): Promise<void> {
    this.projectInstructions = await this.readProjectInstructions();
    this.refreshSystemPrompt();
  }

  get sessionRecord(): SessionRecord {
    return this.session;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get provider(): AIProvider {
    return this.options.provider;
  }

  get model(): string {
    return this.options.model;
  }

  get workspace(): WorkspaceInfo {
    return this.options.workspace;
  }

  get visionAvailable(): boolean {
    return this.options.provider.supportsVision(this.options.model);
  }

  get toolsAvailable(): boolean {
    return this.options.provider.supportsTools(this.options.model);
  }

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn('listener threw', { error: String(error) });
      }
    }
  }

  /** Swap provider/model mid-session (`/model`, `/provider`). */
  async switchProvider(provider: AIProvider, model: string, label: string): Promise<void> {
    this.options = { ...this.options, provider, model, providerLabel: label };
    const window = this.windowFor(provider, model);
    this.windowSource = window.source;
    this.context.setContextWindow(
      window.tokens,
      responseReserveFor(window.tokens, this.options.config.agent.maxTokens),
    );
    this.session.provider = { id: provider.id, label, model };
    this.refreshSystemPrompt();
    void this.detectWindowFor(provider, model);
  }

  /**
   * Best-effort window detection for a model that was just selected. A reply
   * that arrives after the user switched again is discarded rather than
   * applied to the wrong model.
   */
  private async detectWindowFor(provider: AIProvider, model: string): Promise<void> {
    if (!this.options.detectWindow) return;
    try {
      const found = await this.options.detectWindow(provider, model);
      if (!found) return;
      if (this.options.provider !== provider || this.options.model !== model) return;
      this.applyContextWindow(found);
    } catch {
      // Detection is an optimisation. The name-based window still works.
    }
  }

  // ── failover ─────────────────────────────────────────────────────────────

  /**
   * Offer the loop somewhere else to ask.
   *
   * Candidates are tried in configured order, each at most once per turn — a
   * provider that just failed will fail again, and cycling between two dead
   * providers would spin forever. A switch is permanent for the rest of the
   * turn; whether it survives into the next one is `returnToPrimary`.
   */
  private failoverGateway(): FailoverGateway {
    const tried = new Set<string>([this.options.provider.id]);

    return {
      next: (error: OrbitError) => {
        const config = this.options.config.failover;
        if (config.providers.length === 0) return undefined;
        if (!failoverApplies(error, config.on)) return undefined;

        for (const id of config.providers) {
          if (tried.has(id)) continue;
          tried.add(id);
          const candidate = this.options.providerFor?.(id);
          if (!candidate) {
            log.debug('failover candidate unusable', { id });
            continue;
          }
          return candidate;
        }
        return undefined;
      },
      onSwitch: (to: ProviderChoice) => {
        // The rest of the session talks to the fallback, so the window, the
        // session record and the status bar all have to follow it.
        this.options = {
          ...this.options,
          provider: to.provider,
          model: to.model,
          providerLabel: to.label,
        };
        const window = this.windowFor(to.provider, to.model);
        this.windowSource = window.source;
        this.context.setContextWindow(
          window.tokens,
          responseReserveFor(window.tokens, this.options.config.agent.maxTokens),
        );
        this.session.provider = { id: to.provider.id, label: to.label, model: to.model };
        this.refreshSystemPrompt();
      },
    };
  }

  // ── hooks ────────────────────────────────────────────────────────────────

  /** The turn about to run, 1-based, counted from the user messages so far. */
  private turnNumber(): number {
    return this.context.messages().filter((message) => message.role === 'user').length;
  }

  /** Facts every hook receives, before the event-specific extras. */
  private hookPayloadBase(): Omit<HookPayload, 'event'> {
    return {
      workspace: this.options.sandbox.root,
      sessionId: this.session.id,
      model: this.options.model,
      provider: this.options.providerLabel,
    };
  }

  /**
   * Fire a lifecycle event. Hook failures are surfaced through the runner's
   * reporter, never thrown: a broken hook must not end a turn that succeeded.
   */
  async runHooks(
    event: 'session-start' | 'session-end' | 'turn-start' | 'turn-end',
    extra: Partial<HookPayload> = {},
  ): Promise<void> {
    const hooks = this.options.hooks;
    if (!hooks?.has(event)) return;
    try {
      await hooks.run(event, { ...this.hookPayloadBase(), event, ...extra });
    } catch (error) {
      log.warn('hook event failed', { event, error: String(error) });
    }
  }

  /** Adapts the hook runner to the narrow interface the loop asks for. */
  private hookGateway(hooks: HookRunner): {
    beforeTool(call: ToolCall, args: unknown, signal: AbortSignal): Promise<string | undefined>;
    afterTool(
      call: ToolCall,
      args: unknown,
      result: ToolResult,
      signal: AbortSignal,
    ): Promise<void>;
  } {
    const payloadFor = (call: ToolCall, args: unknown): Omit<HookPayload, 'event'> => ({
      ...this.hookPayloadBase(),
      tool: call.name,
      toolArgs: args,
      ...(filePathFromArgs(args) ? { file: filePathFromArgs(args) } : {}),
    });

    return {
      beforeTool: async (call, args, signal) => {
        if (!hooks.has('pre-tool', call.name)) return undefined;
        try {
          const veto = await hooks.vetoFor(
            { ...payloadFor(call, args), event: 'pre-tool' },
            signal,
          );
          return veto ? `${veto.hookName} — ${veto.reason}` : undefined;
        } catch (error) {
          // A hook that cannot run must not silently authorise the call, but
          // neither should it wedge the session: report and allow.
          log.warn('pre-tool hook failed', { tool: call.name, error: String(error) });
          return undefined;
        }
      },
      afterTool: async (call, args, result, signal) => {
        if (!hooks.has('post-tool', call.name)) return;
        try {
          await hooks.run(
            'post-tool',
            { ...payloadFor(call, args), event: 'post-tool', ok: result.ok },
            signal,
          );
        } catch (error) {
          log.warn('post-tool hook failed', { tool: call.name, error: String(error) });
        }
      },
    };
  }

  private windowFor(provider: AIProvider, model: string): WindowResolution {
    const resolved = this.options.resolveWindow?.(provider, model);
    return resolved ?? { tokens: provider.contextWindow(model), source: 'name' };
  }

  /** How the current window was arrived at, for the status line. */
  contextWindowSource(): WindowSource {
    return this.windowSource;
  }

  /**
   * Adopt a window discovered after startup. Detection runs in the background,
   * so this can land mid-session; the reserve and every derived budget are
   * recomputed from the new size.
   */
  applyContextWindow(resolution: WindowResolution): void {
    if (
      resolution.tokens === this.context.getContextWindow() &&
      resolution.source === this.windowSource
    ) {
      return;
    }
    this.windowSource = resolution.source;
    this.context.setContextWindow(
      resolution.tokens,
      responseReserveFor(resolution.tokens, this.options.config.agent.maxTokens),
    );
    this.session.provider = { ...this.session.provider, model: this.options.model };
    this.emit({
      type: 'context-window',
      tokens: resolution.tokens,
      source: resolution.source,
      detail: describeWindowSource(resolution.source, this.options.providerLabel),
    });
  }

  refreshSystemPrompt(): void {
    this.context.setSystemPrompt(
      buildSystemPrompt({
        workspace: this.options.workspace,
        git: this.options.git,
        permissions: this.options.permissions.getPolicy(),
        toolNames: this.options.registry.names(),
        model: this.options.model,
        provider: this.options.providerLabel,
        visionAvailable: this.visionAvailable,
        fallbackToolProtocol: !this.toolsAvailable,
        projectInstructions: this.projectInstructions,
      }),
    );
  }

  /** Re-read workspace and git state, e.g. after the agent changed files. */
  async refreshWorkspace(): Promise<void> {
    this.options.workspace = await detectWorkspace(this.options.sandbox.root);
    this.options.git = await readGitState(this.options.sandbox.root);
    this.refreshSystemPrompt();
  }

  // ── conversation ─────────────────────────────────────────────────────────

  /**
   * Send a user turn and run the agent loop to completion. Returns when the
   * model stops requesting tools, the turn is cancelled, or an error occurs.
   */
  async send(input: string, attachments: ContentPart[] = []): Promise<TurnResult> {
    if (this.running) {
      throw new Error('Agent is already running a turn');
    }

    this.running = true;
    this.controller = new AbortController();

    try {
      const content: ContentPart[] = [{ type: 'text', text: input }, ...attachments];
      this.context.addUserMessage(attachments.length > 0 ? content : input);

      if (this.session.title === path.basename(this.session.workspace) && input.trim()) {
        this.session.title = titleFromPrompt(input, this.session.title);
      }

      // A fallback taken last turn does not silently become the new default.
      if (this.primary && this.options.config.failover.returnToPrimary) {
        if (this.options.provider.id !== this.primary.provider.id) {
          const back = this.primary;
          this.options = {
            ...this.options,
            provider: back.provider,
            model: back.model,
            providerLabel: back.label,
          };
          this.emit({
            type: 'notice',
            message: `Back on ${back.label} for this turn.`,
          });
        }
      }

      const loop = new AgentLoop({
        provider: this.options.provider,
        model: this.options.model,
        context: this.context,
        registry: this.options.registry,
        permissions: this.options.permissions,
        config: this.options.config.agent,
        optimizer: this.optimizer,
        usageStats: {
          averageCompletion: () => this.usageTracker.averageCompletion(),
          peakCompletion: () => this.usageTracker.peakCompletion(),
          requests: () => this.usageTracker.sessionTotals().requests,
        },
        createToolContext: (signal, progress, limits) =>
          this.createToolContext(signal, progress, limits),
        emit: (event) => this.handleEvent(event),
        summarize: (transcript, signal) => this.summarize(transcript, signal),
        onToolExecuted: (name, result) => this.recordToolUse(name, result),
        providerLabel: this.options.providerLabel,
        ...(this.options.hooks ? { hooks: this.hookGateway(this.options.hooks) } : {}),
        ...(this.options.providerFor ? { failover: this.failoverGateway() } : {}),
      });

      await this.runHooks('turn-start', { turn: this.turnNumber() });

      const result = await loop.run(this.controller.signal);

      await this.runHooks('turn-end', {
        turn: this.turnNumber(),
        turnEndReason: result.reason,
      });

      // Close the checkpoint even on cancellation: files already written have
      // to be undoable, or a half-finished turn would be stranded.
      const checkpoint = await this.options.checkpoints?.commitTurn(input);
      if (checkpoint) {
        this.emit({ type: 'checkpoint', turn: checkpoint.turn, files: checkpoint.files.length });
      }

      await this.persist();
      return result;
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  get checkpoints(): CheckpointManager | undefined {
    return this.options.checkpoints;
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  private handleEvent(event: AgentEvent): void {
    // Each request reports its own usage, so session totals accumulate here.
    // (The loop's `usage` event is per-turn only.)
    if (event.type === 'turn-usage') {
      this.usage.promptTokens += event.turn.promptTokens;
      this.usage.completionTokens += event.turn.completionTokens;
      this.usage.totalTokens += event.turn.promptTokens + event.turn.completionTokens;
      this.usageTracker.record(event.turn);
    }
    this.emit(event);
  }

  private recordToolUse(name: string, result: ToolResult): void {
    this.toolHistory.push({
      name,
      at: new Date().toISOString(),
      ok: result.ok,
      summary: result.display.summary,
    });
  }

  private createToolContext(
    signal: AbortSignal,
    progress: (message: string) => void,
    limits?: Partial<ToolsConfig>,
  ): ToolContext {
    const depth = this.options.depth ?? 0;
    const subagents = this.options.config.subagents;

    return {
      sandbox: this.options.sandbox,
      permissions: this.options.permissions,
      // Limits may be tightened for this turn by the token optimizer.
      config: limits ? { ...this.options.config.tools, ...limits } : this.options.config.tools,
      cwd: this.options.sandbox.root,
      signal,
      progress,
      workspace: this.options.workspace,
      visionAvailable: this.visionAvailable,
      checkpoints: this.options.checkpoints,
      shellSession: this.shellSession,
      fileTracker: this.fileTracker,
      background: this.options.background,
      web: {
        config: this.options.config.web,
        apiKey: this.options.webApiKey,
      },
      // Sub-agents may not delegate further once the depth limit is reached.
      delegate:
        subagents.enabled && depth < subagents.maxDepth
          ? (request) => this.runDelegate(request)
          : undefined,
    };
  }

  /**
   * Run a delegated sub-agent: its own context window, a restricted tool set,
   * and only its final report comes back. Tool output it gathers is discarded
   * with its context, which is the entire point.
   */
  private async runDelegate(request: DelegateRequest): Promise<DelegateResult> {
    const subagents = this.options.config.subagents;
    const depth = (this.options.depth ?? 0) + 1;

    const registry = new ToolRegistry();
    const allowed = request.tools;
    for (const tool of this.options.registry.list()) {
      if (tool.name === 'task' || tool.name === 'update_plan') continue;
      if (allowed && !allowed.includes(tool.name)) continue;
      registry.register(tool);
    }

    const context = new ContextManager({
      contextWindow: this.options.provider.contextWindow(this.options.model),
      compactThreshold: this.options.config.agent.compactThreshold,
      responseReserve: responseReserveFor(
        this.options.provider.contextWindow(this.options.model),
        this.options.config.agent.maxTokens,
      ),
    });
    context.setSystemPrompt(
      [
        SUBAGENT_SYSTEM_PROMPT,
        '',
        '---',
        '',
        `Workspace root: ${this.options.sandbox.root}`,
        `Available tools: ${registry.names().join(', ')}`,
      ].join('\n'),
    );
    context.addUserMessage(request.prompt);

    let toolCalls = 0;
    let lastText = '';
    const usage = { promptTokens: 0, completionTokens: 0 };

    const loop = new AgentLoop({
      provider: this.options.provider,
      model: this.options.model,
      context,
      registry,
      permissions: this.options.permissions,
      config: { ...this.options.config.agent, maxIterations: subagents.maxIterations },
      optimizer: this.optimizer,
      createToolContext: (signal, progress, limits) => ({
        ...this.createToolContext(signal, progress, limits),
        // Depth is enforced by omitting `delegate` below the limit.
        delegate: depth < subagents.maxDepth ? (nested) => this.runDelegate(nested) : undefined,
        progress: (message: string) => request.progress(message),
      }),
      emit: (event) => {
        if (event.type === 'tool-start') toolCalls += 1;
        if (event.type === 'tool-end') request.progress(event.result.display.summary);
        if (event.type === 'assistant-message') lastText = event.text;
        if (event.type === 'turn-usage') {
          usage.promptTokens += event.turn.promptTokens;
          usage.completionTokens += event.turn.completionTokens;
          this.usageTracker.record(event.turn);
        }
      },
      summarize: (transcript, signal) => this.summarize(transcript, signal),
    });

    const result = await loop.run(request.signal);

    return {
      text: lastText,
      toolCalls,
      iterations: result.iterations,
      usage,
    };
  }

  /** Model-written summary used when compacting the conversation. */
  readonly summarizer = (transcript: string, signal?: AbortSignal): Promise<string> =>
    this.summarize(transcript, signal);

  private async summarize(transcript: string, signal?: AbortSignal): Promise<string> {
    const response = await this.options.provider.chat({
      model: this.options.model,
      messages: [
        { role: 'system', content: SUMMARIZER_PROMPT },
        { role: 'user', content: transcript },
      ],
      temperature: 0,
      maxTokens: 1200,
      signal,
    });
    return response.text.trim();
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Detect image paths the user mentioned so they can be attached directly.
   * PDFs are left to the read_pdf tool, which chunks them properly.
   */
  async resolveAttachments(
    input: string,
  ): Promise<{ attachments: ImagePart[]; notices: AttachmentNotice[] }> {
    const attachments: ImagePart[] = [];
    const notices: AttachmentNotice[] = [];
    const candidates = extractPathCandidates(input);

    for (const candidate of candidates) {
      const extension = path.extname(candidate).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[extension];
      if (!mediaType) continue;

      let resolved;
      try {
        resolved = await this.options.sandbox.resolveReal(candidate);
      } catch {
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(resolved.absolute);
      } catch {
        continue;
      }

      const dimensions = readImageDimensions(buffer);
      const detail = `${dimensions?.width ? `${dimensions.width} × ${dimensions.height}` : 'unknown size'}, ${formatBytes(buffer.length)}`;

      if (!this.visionAvailable) {
        notices.push({
          kind: 'skipped',
          path: resolved.relative,
          detail: `${detail} — ${this.options.model} does not support image input`,
        });
        continue;
      }

      attachments.push({
        type: 'image',
        mediaType,
        data: buffer.toString('base64'),
        name: resolved.relative,
      });
      notices.push({ kind: 'image', path: resolved.relative, detail });
    }

    return { attachments, notices };
  }

  private async readProjectInstructions(): Promise<string> {
    for (const file of PROJECT_INSTRUCTION_FILES) {
      const full = path.join(this.options.sandbox.root, file);
      try {
        const text = await fs.readFile(full, 'utf8');
        if (text.trim()) {
          log.info('loaded project instructions', { file });
          return `(from ${file})\n\n${text.trim().slice(0, 8000)}`;
        }
      } catch {
        // Try the next candidate.
      }
    }
    return '';
  }

  // ── persistence ──────────────────────────────────────────────────────────

  async persist(): Promise<void> {
    if (!this.options.config.sessions.persist) return;
    this.session = {
      ...this.session,
      entries: this.context.history(),
      toolHistory: this.toolHistory,
      usage: { ...this.usage },
      messageCount: this.context.length,
      provider: {
        id: this.options.provider.id,
        label: this.options.providerLabel,
        model: this.options.model,
      },
    };
    try {
      await this.options.sessions.save(this.session);
    } catch (error) {
      log.warn('failed to save session', { error: String(error) });
    }
  }

  /** Replace the live conversation with a stored session. */
  adoptSession(record: SessionRecord): void {
    this.session = record;
    this.context.clear();
    this.context.restore(record.entries);
    this.toolHistory = [...record.toolHistory];
    this.usage.promptTokens = record.usage.promptTokens;
    this.usage.completionTokens = record.usage.completionTokens;
    this.usage.totalTokens = record.usage.totalTokens;
    this.planner.clear();
    this.refreshSystemPrompt();
  }

  /** Start a fresh conversation, keeping provider and workspace. */
  reset(): void {
    this.context.clear();
    this.planner.clear();
    this.toolHistory = [];
    this.usage.promptTokens = 0;
    this.usage.completionTokens = 0;
    this.usage.totalTokens = 0;
    this.session = newSessionRecord({
      workspace: this.options.sandbox.root,
      provider: {
        id: this.options.provider.id,
        label: this.options.providerLabel,
        model: this.options.model,
      },
    });
  }
}

/**
 * Pull path-like tokens out of a message: quoted paths, ./relative paths, and
 * bare filenames with a known extension.
 */
export function extractPathCandidates(input: string): string[] {
  const found = new Set<string>();

  for (const match of input.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value && /\.[a-z0-9]{2,5}$/i.test(value)) found.add(value);
  }

  for (const match of input.matchAll(/(?:^|\s)((?:\.{1,2}\/|~\/|\/)?[\w./\\-]+\.[a-zA-Z0-9]{2,5})(?=$|[\s,.;:!?)])/g)) {
    const value = match[1];
    if (value) found.add(value);
  }

  return [...found];
}
