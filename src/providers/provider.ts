/**
 * Provider-neutral types. The agent runtime depends only on this module —
 * never on a concrete provider implementation.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** e.g. `image/png`. */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  /** Display name, used by the UI only. */
  name?: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  /** Assistant messages may request tools. */
  toolCalls?: ToolCall[];
  /** Tool messages answer a specific call. */
  toolCallId?: string;
  /** Tool name, carried for providers that require it on tool results. */
  name?: string;
}

/** JSON Schema subset used for tool parameters. */
export type JSONSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Ask the provider to cache the stable prefix (system prompt + tool schemas).
   * Providers that cache automatically ignore this.
   */
  cachePrefix?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache, where it reports them. */
  cachedTokens?: number;
  /** Prompt tokens written to the cache on this request. */
  cacheWriteTokens?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'cancelled';

export interface ChatResponse {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: FinishReason;
  model: string;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; argumentsDelta: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: FinishReason; response: ChatResponse };

export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface AIProvider {
  readonly name: string;
  readonly id: string;
  /** Model currently selected for this provider instance. */
  readonly model: string;

  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;

  chat(request: ChatRequest): Promise<ChatResponse>;

  stream(request: ChatRequest): AsyncIterable<StreamEvent>;

  supportsTools(model: string): boolean;

  supportsVision(model: string): boolean;

  /** Context window in tokens for the given model, used for compaction budgets. */
  contextWindow(model: string): number;

  /**
   * Ask the service to state this model's context window, for providers whose
   * models endpoint does not carry it. Resolves to `undefined` when the
   * provider will not say. Implementations must not generate any tokens.
   */
  probeContextWindow?(model: string, signal?: AbortSignal): Promise<number | undefined>;
}

// ── Capability heuristics ──────────────────────────────────────────────────
// Providers rarely advertise capabilities reliably, so Orbit uses conservative
// model-name heuristics that config can always override.

const VISION_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /o[34]\b/i,
  /claude-(?:3|4|opus|sonnet|haiku)/i,
  /gemini/i,
  /llama-?3\.2-\d+b-vision/i,
  /llava/i,
  /pixtral/i,
  /qwen.*(?:vl|omni)/i,
  /internvl/i,
  /molmo/i,
  /phi-\d+.*vision/i,
  /grok.*vision/i,
  /mistral-small-3/i,
];

const NO_TOOLS_PATTERNS = [
  /\bbase\b/i,
  /embed/i,
  /whisper/i,
  /tts/i,
  /rerank/i,
  /moderation/i,
  /-instruct-base/i,
];

export function guessVisionSupport(model: string): boolean {
  return VISION_PATTERNS.some((re) => re.test(model));
}

export function guessToolSupport(model: string): boolean {
  if (NO_TOOLS_PATTERNS.some((re) => re.test(model))) return false;
  return true;
}

/**
 * Last-resort windows by model name. Every entry here is a guess that goes
 * stale the moment a vendor ships a new generation, so it is only consulted
 * after the provider has been asked directly (see `context/window.ts`).
 * Patterns are family-wide rather than version-pinned for the same reason.
 */
const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/gpt-5|gpt-4\.1/i, 400_000],
  [/gpt-4o/i, 128_000],
  [/o[34]-?(mini)?/i, 200_000],
  [/claude-(opus|sonnet|haiku)/i, 200_000],
  [/claude-3/i, 200_000],
  [/gemini/i, 1_000_000],
  [/deepseek/i, 128_000],
  [/qwen3?-coder/i, 262_144],
  [/qwen/i, 131_072],
  [/llama-?[34]/i, 131_072],
  [/mistral|mixtral/i, 32_768],
  [/grok/i, 131_072],
];

export function guessContextWindow(model: string): number {
  for (const [re, size] of CONTEXT_WINDOWS) {
    if (re.test(model)) return size;
  }
  return 32_768;
}

/** Flatten mixed content to plain text for token counting and text-only providers. */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : `[image: ${part.name ?? part.mediaType}]`))
    .join('\n');
}

export function hasImages(messages: Message[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'),
  );
}

/** Collapse a stream into a ChatResponse; used to implement chat() from stream(). */
export async function collectStream(
  events: AsyncIterable<StreamEvent>,
  model: string,
): Promise<ChatResponse> {
  let text = '';
  let reasoning = '';
  let usage: Usage | undefined;
  let finishReason: FinishReason = 'stop';
  const toolCalls: ToolCall[] = [];

  for await (const event of events) {
    switch (event.type) {
      case 'text':
        text += event.delta;
        break;
      case 'reasoning':
        reasoning += event.delta;
        break;
      case 'tool-call':
        toolCalls.push(event.call);
        break;
      case 'usage':
        usage = event.usage;
        break;
      case 'done':
        finishReason = event.finishReason;
        return event.response;
      default:
        break;
    }
  }

  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    usage,
    finishReason,
    model,
  };
}
