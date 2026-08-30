import type { ContentPart, Message, ToolCall, ToolDefinition } from '../providers/provider.js';
import { shortId } from '../util/id.js';
import { createLogger } from '../util/logger.js';
import {
  compressToolResults,
  summarizeOlderTurns,
  type ContextEntry,
  type Summarizer,
} from './compaction.js';
import { computeBudget, estimateMessageTokens, type Budget } from './tokenizer.js';

const log = createLogger('context');

export interface ContextManagerOptions {
  contextWindow: number;
  /** Tokens held back for the model's reply. */
  responseReserve?: number;
  /** Fraction of the window that triggers compaction. */
  compactThreshold?: number;
  systemPrompt?: string;
}

export type CompactionEvent =
  | { type: 'started'; ratio: number }
  | { type: 'compressed-tools'; count: number; savedTokens: number }
  | { type: 'summarized'; removed: number; savedTokens: number }
  | { type: 'finished'; before: number; after: number };

export interface CompactOptions {
  tools: ToolDefinition[];
  summarizer?: Summarizer;
  signal?: AbortSignal;
  onEvent?: (event: CompactionEvent) => void;
  /** Compact even if the threshold has not been reached. */
  force?: boolean;
}

/**
 * Owns the conversation and keeps it inside the model's context window.
 * The agent loop asks for messages; this class decides what fits.
 */
export class ContextManager {
  private entries: ContextEntry[] = [];
  private systemPrompt: string;
  private window: number;
  private reserve: number;
  private threshold: number;
  /**
   * The reserve the session was configured with. Kept separate from the
   * effective reserve so switching to a small model and back restores it,
   * rather than leaving a large model permanently squeezed.
   */
  private readonly configuredReserve: number;

  constructor(options: ContextManagerOptions) {
    this.window = options.contextWindow;
    this.configuredReserve =
      options.responseReserve ?? Math.min(8192, Math.floor(options.contextWindow * 0.15));
    this.reserve = this.reserveFor(options.contextWindow);
    this.threshold = options.compactThreshold ?? 0.82;
    this.systemPrompt = options.systemPrompt ?? '';
  }

  /** Never hold back more than a quarter of the window for the reply. */
  private reserveFor(window: number): number {
    return Math.min(this.configuredReserve, Math.floor(window * 0.25));
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setContextWindow(window: number): void {
    this.window = window;
    this.reserve = this.reserveFor(window);
  }

  getContextWindow(): number {
    return this.window;
  }

  private push(message: Message): ContextEntry {
    const entry: ContextEntry = {
      id: shortId(),
      message,
      tokens: estimateMessageTokens(message),
      timestamp: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  addUserMessage(content: string | ContentPart[]): ContextEntry {
    return this.push({ role: 'user', content });
  }

  addAssistantMessage(text: string, toolCalls: ToolCall[] = []): ContextEntry {
    const message: Message = { role: 'assistant', content: text };
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
    return this.push(message);
  }

  addToolResult(call: ToolCall, content: string): ContextEntry {
    return this.push({
      role: 'tool',
      content,
      toolCallId: call.id,
      name: call.name,
    });
  }

  /**
   * Attach images produced by tools.
   *
   * They cannot ride inside a tool result for most providers, and a user
   * message placed *between* two tool results breaks the call/result pairing
   * those providers require — so this must be called only after every tool
   * result for the batch has been added.
   */
  addAttachments(parts: ContentPart[], note?: string): ContextEntry | null {
    if (parts.length === 0) return null;
    const content: ContentPart[] = note ? [{ type: 'text', text: note }, ...parts] : [...parts];
    return this.push({ role: 'user', content });
  }

  /** A note the model should see, e.g. a denied permission or a cancellation. */
  addSystemNote(text: string): ContextEntry {
    return this.push({ role: 'user', content: `[Orbit] ${text}` });
  }

  messages(): Message[] {
    const messages: Message[] = [];
    if (this.systemPrompt) messages.push({ role: 'system', content: this.systemPrompt });
    for (const entry of this.entries) messages.push(entry.message);
    return messages;
  }

  /** Conversation without the system prompt, for session persistence. */
  history(): ContextEntry[] {
    return this.entries;
  }

  restore(entries: ContextEntry[]): void {
    this.entries = entries.map((entry) => ({
      ...entry,
      tokens: entry.tokens || estimateMessageTokens(entry.message),
    }));
  }

  clear(): void {
    this.entries = [];
  }

  get length(): number {
    return this.entries.length;
  }

  budget(tools: ToolDefinition[] = []): Budget {
    return computeBudget({
      systemPrompt: this.systemPrompt,
      messages: this.entries.map((entry) => entry.message),
      tools,
      responseReserve: this.reserve,
      contextWindow: this.window,
    });
  }

  needsCompaction(tools: ToolDefinition[] = []): boolean {
    return this.budget(tools).ratio >= this.threshold;
  }

  /**
   * Reduce context usage. Tool results are compressed first because that is
   * lossless for the agent's purposes; only then is history summarized.
   */
  async compact(options: CompactOptions): Promise<Budget> {
    const before = this.budget(options.tools);
    if (!options.force && before.ratio < this.threshold) return before;

    options.onEvent?.({ type: 'started', ratio: before.ratio });
    log.info('compacting context', { ratio: before.ratio, entries: this.entries.length });

    const compressed = compressToolResults(this.entries, { keepRecent: 6 });
    if (compressed.savedTokens > 0) {
      this.entries = compressed.entries;
      options.onEvent?.({
        type: 'compressed-tools',
        count: compressed.compressedCount,
        savedTokens: compressed.savedTokens,
      });
    }

    let current = this.budget(options.tools);
    if (current.ratio >= this.threshold * 0.95) {
      const summarized = await summarizeOlderTurns(this.entries, {
        keepRecent: 8,
        summarizer: options.summarizer,
        signal: options.signal,
      });
      if (summarized.summary !== null) {
        this.entries = summarized.entries;
        options.onEvent?.({
          type: 'summarized',
          removed: summarized.removedCount,
          savedTokens: summarized.savedTokens,
        });
      }
      current = this.budget(options.tools);
    }

    options.onEvent?.({ type: 'finished', before: before.used, after: current.used });
    log.info('compaction complete', { before: before.used, after: current.used });
    return current;
  }

  /**
   * Last-resort trim when a single turn still will not fit — for example a
   * huge tool result pasted into a small window.
   */
  enforceHardLimit(tools: ToolDefinition[] = []): boolean {
    let trimmed = false;
    let guard = 0;
    while (this.budget(tools).available <= 0 && this.entries.length > 2 && guard++ < 100) {
      this.entries.shift();
      trimmed = true;
    }
    if (trimmed) log.warn('hard context limit reached; oldest messages dropped');
    return trimmed;
  }
}

export type { ContextEntry } from './compaction.js';
export type { Budget } from './tokenizer.js';
