import { OrbitError, isCancellation } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { parseWindowFromError } from '../context/window.js';
import { httpErrorFor, parseSSE, rawRequest, requestJSON } from './http.js';
import {
  collectStream,
  guessContextWindow,
  guessToolSupport,
  guessVisionSupport,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type FinishReason,
  type Message,
  type ModelInfo,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from './provider.js';

const log = createLogger('provider:openai-compatible');

export interface OpenAICompatibleOptions {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  supportsTools?: boolean;
  supportsVision?: boolean;
  contextWindow?: number;
  /** Some gateways want the key in a non-standard header. */
  authHeader?: string;
  authScheme?: string;
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIChoice {
  index?: number;
  delta?: OpenAIDelta;
  message?: OpenAIDelta;
  finish_reason?: string | null;
}

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: { message?: string } | string;
}

/**
 * Pull a context window off a `/models` entry. Different servers spell it
 * differently and none of them are required to include it at all, so this
 * returns `undefined` rather than guessing.
 */
function readReportedWindow(entry: Record<string, unknown>): number | undefined {
  const keys = [
    'context_length',
    'context_window',
    'max_context_length',
    'max_model_len',
    'max_input_tokens',
    'inputTokenLimit',
  ] as const;
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1024) return value;
  }
  // OpenRouter nests the same figure under `top_provider`.
  const nested = entry.top_provider;
  if (nested && typeof nested === 'object') {
    const value = (nested as { context_length?: unknown }).context_length;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1024) return value;
  }
  return undefined;
}

/**
 * Adapter for every endpoint that speaks the OpenAI chat-completions dialect:
 * OpenAI, DeepSeek, OpenRouter, NVIDIA NIM, vLLM, Ollama, and custom servers.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  protected readonly baseURL: string;
  protected readonly apiKey: string | undefined;
  protected readonly extraHeaders: Record<string, string>;
  private readonly toolsOverride: boolean | undefined;
  private readonly visionOverride: boolean | undefined;
  private readonly windowOverride: number | undefined;
  private readonly authHeader: string;
  private readonly authScheme: string;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.name = options.name;
    this.model = options.model;
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.toolsOverride = options.supportsTools;
    this.visionOverride = options.supportsVision;
    this.windowOverride = options.contextWindow;
    this.authHeader = options.authHeader ?? 'authorization';
    this.authScheme = options.authScheme ?? 'Bearer';
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.apiKey) {
      headers[this.authHeader] = this.authScheme
        ? `${this.authScheme} ${this.apiKey}`
        : this.apiKey;
    }
    return headers;
  }

  supportsTools(model: string): boolean {
    return this.toolsOverride ?? guessToolSupport(model);
  }

  supportsVision(model: string): boolean {
    return this.visionOverride ?? guessVisionSupport(model);
  }

  contextWindow(model: string): number {
    return this.windowOverride ?? guessContextWindow(model);
  }

  /**
   * Ask for an impossible completion length and read the limit out of the
   * refusal. OpenAI-compatible servers validate `max_tokens` against the
   * model's window and name the real figure when they reject it, which is a
   * far better source than any table Orbit could keep current.
   *
   * The request is rejected during validation, so no tokens are generated and
   * nothing is billed. A single-character message keeps it that way even on a
   * server that decides to answer anyway.
   */
  async probeContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
    const response = await rawRequest({
      url: `${this.baseURL}/chat/completions`,
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: {
        model,
        messages: [{ role: 'user', content: 'x' }],
        // Large enough that no real model can satisfy it, small enough to stay
        // inside a signed 32-bit int for servers that parse it as one.
        max_tokens: 2_000_000_000,
        stream: false,
      },
      signal,
      providerName: this.name,
    });

    // A server that accepts this is not enforcing a limit it will tell us
    // about, so there is nothing to learn.
    if (response.ok) return undefined;

    let text = '';
    try {
      text = (await response.text()).slice(0, 4000);
    } catch {
      return undefined;
    }
    return parseWindowFromError(text);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const payload = await requestJSON<{ data?: Array<Record<string, unknown>> }>({
      url: `${this.baseURL}/models`,
      method: 'GET',
      headers: this.headers(),
      signal,
      providerName: this.name,
    });
    const models = payload.data ?? [];
    return models
      .map((entry): ModelInfo | null => {
        const id = String(entry.id ?? entry.name ?? '');
        if (!id) return null;
        // Leave `contextWindow` unset when the endpoint did not say. Filling
        // it in from a name guess here would make the guess indistinguishable
        // from a real answer everywhere downstream.
        const window = readReportedWindow(entry);
        return {
          id,
          ...(window === undefined ? {} : { contextWindow: window }),
          supportsTools: this.supportsTools(id),
          supportsVision: this.supportsVision(id),
        } satisfies ModelInfo;
      })
      .filter((m): m is ModelInfo => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  protected buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => toOpenAIMessage(m, this.supportsVision(request.model))),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (stream) body.stream_options = { include_usage: true };
    if (request.tools?.length && this.supportsTools(request.model)) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await rawRequest({
      url: `${this.baseURL}/chat/completions`,
      headers: this.headers(),
      body: this.buildBody(request, false),
      signal: request.signal,
      providerName: this.name,
    });
    if (!response.ok) throw await httpErrorFor(response, this.name);

    const payload = (await response.json()) as OpenAIChunk;
    const choice = payload.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls = (message.tool_calls ?? [])
      .map((call) => parseToolCall(call.id, call.function?.name, call.function?.arguments))
      .filter((c): c is ToolCall => c !== null);

    return {
      text: message.content ?? '',
      reasoning: message.reasoning_content ?? message.reasoning ?? undefined,
      toolCalls,
      usage: toUsage(payload.usage),
      finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
      model: payload.model ?? request.model,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await rawRequest({
      url: `${this.baseURL}/chat/completions`,
      headers: { accept: 'text/event-stream', ...this.headers() },
      body: this.buildBody(request, true),
      signal: request.signal,
      providerName: this.name,
    });
    if (!response.ok) throw await httpErrorFor(response, this.name);

    const accumulator = new ToolCallAccumulator();
    let text = '';
    let reasoning = '';
    let usage: Usage | undefined;
    let finishReason: FinishReason = 'stop';
    let model = request.model;

    try {
      for await (const message of parseSSE(response, request.signal)) {
        if (request.signal?.aborted) break;
        if (message.data === '[DONE]') break;

        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(message.data) as OpenAIChunk;
        } catch {
          log.debug('skipping unparsable stream chunk');
          continue;
        }

        if (chunk.error) {
          const detail =
            typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'unknown');
          throw new OrbitError(`${this.name} reported an error mid-stream.`, {
            kind: 'provider',
            detail,
          });
        }

        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = toUsage(chunk.usage) ?? usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          yield { type: 'reasoning', delta: reasoningDelta };
        }
        if (delta.content) {
          text += delta.content;
          yield { type: 'text', delta: delta.content };
        }
        for (const call of delta.tool_calls ?? []) {
          const started = accumulator.push(call);
          if (started) yield { type: 'tool-call-start', id: started.id, name: started.name };
          if (call.function?.arguments) {
            yield {
              type: 'tool-call-delta',
              id: accumulator.idFor(call),
              argumentsDelta: call.function.arguments,
            };
          }
        }
        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason, accumulator.size > 0);
        }
      }
    } catch (error) {
      if (isCancellation(error) || request.signal?.aborted) {
        finishReason = 'cancelled';
      } else {
        throw error;
      }
    }

    const toolCalls = accumulator.finish();
    for (const call of toolCalls) yield { type: 'tool-call', call };
    if (usage) yield { type: 'usage', usage };
    if (toolCalls.length > 0 && finishReason === 'stop') finishReason = 'tool_calls';

    const response_: ChatResponse = {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      finishReason,
      model,
    };
    yield { type: 'done', finishReason, response: response_ };
  }
}

/** Streamed tool calls arrive as fragments keyed by index; reassemble them. */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  get size(): number {
    return this.byIndex.size;
  }

  idFor(call: OpenAIToolCallDelta): string {
    const index = call.index ?? 0;
    return this.byIndex.get(index)?.id ?? call.id ?? `call_${index}`;
  }

  /** Returns the call header when this fragment starts a new call. */
  push(call: OpenAIToolCallDelta): { id: string; name: string } | null {
    const index = call.index ?? 0;
    const existing = this.byIndex.get(index);
    if (!existing) {
      const entry = {
        id: call.id ?? `call_${index}_${Date.now().toString(36)}`,
        name: call.function?.name ?? '',
        args: call.function?.arguments ?? '',
      };
      this.byIndex.set(index, entry);
      return entry.name ? { id: entry.id, name: entry.name } : null;
    }
    if (call.id) existing.id = call.id;
    const hadName = Boolean(existing.name);
    if (call.function?.name) existing.name = call.function.name;
    if (call.function?.arguments) existing.args += call.function.arguments;
    if (!hadName && existing.name) return { id: existing.id, name: existing.name };
    return null;
  }

  finish(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => parseToolCall(entry.id, entry.name, entry.args))
      .filter((c): c is ToolCall => c !== null);
  }
}

/**
 * Tool arguments arrive as a JSON string. A malformed payload becomes a call
 * with a parse marker so the agent can tell the model what went wrong instead
 * of crashing the loop.
 */
export function parseToolCall(
  id: string | undefined,
  name: string | undefined,
  rawArgs: string | undefined,
): ToolCall | null {
  if (!name) return null;
  const callId = id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
  const raw = (rawArgs ?? '').trim();
  if (!raw) return { id: callId, name, arguments: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { id: callId, name, arguments: parsed as Record<string, unknown> };
    }
    return { id: callId, name, arguments: { value: parsed } };
  } catch {
    return { id: callId, name, arguments: { __orbit_unparsed_arguments: raw } };
  }
}

export function toUsage(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        /** DeepSeek's spelling for the same figure. */
        reasoning_tokens?: number;
      }
    | null
    | undefined,
): Usage | undefined {
  if (!usage) return undefined;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;

  // OpenAI reports cache hits under prompt_tokens_details; DeepSeek uses its
  // own prompt_cache_hit_tokens field. Both cache automatically.
  const cachedTokens =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;

  // Reasoning models bill thinking as completion tokens but report it
  // separately, which is the only way to show what a long think actually cost.
  const reasoningTokens =
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: usage.total_tokens ?? prompt + completion,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
}

export function mapFinishReason(reason: string | null | undefined, hasTools: boolean): FinishReason {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return hasTools ? 'tool_calls' : 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return hasTools ? 'tool_calls' : 'stop';
  }
}

function toOpenAIMessage(message: Message, allowImages: boolean): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: flattenForText(message.content),
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: flattenForText(message.content) || null,
      tool_calls: message.toolCalls.map((call, index) => ({
        id: call.id,
        type: 'function',
        index,
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    };
  }

  if (Array.isArray(message.content)) {
    if (!allowImages) {
      return { role: message.role, content: flattenForText(message.content) };
    }
    return {
      role: message.role,
      content: message.content.map((part) => toOpenAIContentPart(part)),
    };
  }

  return { role: message.role, content: message.content };
}

function toOpenAIContentPart(part: ContentPart): Record<string, unknown> {
  if (part.type === 'image') {
    return {
      type: 'image_url',
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    };
  }
  return { type: 'text', text: part.text };
}

function flattenForText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : `[image omitted: ${part.name ?? part.mediaType} — the selected model does not accept image input]`,
    )
    .join('\n');
}

export { collectStream };
