import fs from 'node:fs/promises';
import path from 'node:path';
import type { OrbitConfig, ToolsConfig } from '../config/schema.js';
import { ContextManager } from '../context/manager.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { Sandbox } from '../permissions/sandbox.js';
import type { AIProvider, ContentPart, ImagePart, Usage } from '../providers/provider.js';
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
import { AgentLoop, type AgentEvent, type TurnResult } from './loop.js';
import { Planner } from './planner.js';
import { SUMMARIZER_PROMPT } from '../context/compaction.js';
import { TokenOptimizer } from '../context/optimizer.js';
import { UsageTracker } from '../context/usage.js';
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

    this.context = new ContextManager({
      contextWindow: options.provider.contextWindow(options.model),
      compactThreshold: options.config.agent.compactThreshold,
      responseReserve: responseReserveFor(
        options.provider.contextWindow(options.model),
        options.config.agent.maxTokens,
      ),
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
    this.context.setContextWindow(provider.contextWindow(model));
    this.session.provider = { id: provider.id, label, model };
    this.refreshSystemPrompt();
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
      });

      const result = await loop.run(this.controller.signal);

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
