import { OrbitError, isCancellation } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { httpErrorFor, parseSSE, rawRequest } from './http.js';
import {
  collectStream,
  guessContextWindow,
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

const log = createLogger('provider:anthropic');

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  id?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  supportsTools?: boolean;
  supportsVision?: boolean;
  contextWindow?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Native Anthropic Messages API. Blocks and tool_use differ enough from the
 * OpenAI dialect that a dedicated adapter is clearer than a translation shim. */
export class AnthropicProvider implements AIProvider {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly toolsOverride: boolean | undefined;
  private readonly visionOverride: boolean | undefined;
  private readonly windowOverride: number | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.id = options.id ?? 'anthropic';
    this.name = options.name ?? 'Anthropic';
    this.model = options.model;
    this.baseURL = (options.baseURL ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.toolsOverride = options.supportsTools;
    this.visionOverride = options.supportsVision;
    this.windowOverride = options.contextWindow;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.extraHeaders,
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return headers;
  }

  supportsTools(): boolean {
    return this.toolsOverride ?? true;
  }

  supportsVision(): boolean {
    return this.visionOverride ?? true;
  }

  contextWindow(model: string): number {
    return this.windowOverride ?? guessContextWindow(model);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await rawRequest({
      url: `${this.baseURL}/models?limit=100`,
      method: 'GET',
      headers: this.headers(),
      signal,
      providerName: this.name,
    });
    if (!response.ok) throw await httpErrorFor(response, this.name);
    const payload = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> };
    return (payload.data ?? [])
      .filter((entry): entry is { id: string; display_name?: string } => Boolean(entry.id))
      .map((entry) => ({
        id: entry.id,
        label: entry.display_name,
        // Anthropic's models endpoint does not carry a context window, and a
        // name guess here would be mistaken for one.
        supportsTools: true,
        supportsVision: true,
      }));
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : toBlocks(m.content, true).map(blockText).join('\n')))
      .join('\n\n');

    const messages = mergeConsecutive(
      request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => toAnthropicMessage(m, this.supportsVision())),
    );

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream,
    };

    // The system prompt and tool schemas are identical on every request in a
    // session, so marking the end of that prefix lets the provider bill it once.
    if (system) {
      body.system = request.cachePrefix
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length && this.supportsTools()) {
      const definitions = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
      if (request.cachePrefix && definitions.length > 0) {
        const last = definitions[definitions.length - 1] as Record<string, unknown>;
        last.cache_control = { type: 'ephemeral' };
      }
      body.tools = definitions;
      if (request.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (request.toolChoice === 'none') body.tool_choice = { type: 'none' };
      else body.tool_choice = { type: 'auto' };
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return collectStream(this.stream(request), request.model);
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await rawRequest({
      url: `${this.baseURL}/messages`,
      headers: { accept: 'text/event-stream', ...this.headers() },
      body: this.buildBody(request, true),
      signal: request.signal,
      providerName: this.name,
    });
    if (!response.ok) throw await httpErrorFor(response, this.name);

    const blocks = new Map<number, { type: string; id?: string; name?: string; buffer: string }>();
    const toolCalls: ToolCall[] = [];
    let text = '';
    let reasoning = '';
    let usage: Usage | undefined;
    let finishReason: FinishReason = 'stop';
    let model = request.model;

    try {
      for await (const message of parseSSE(response, request.signal)) {
        if (request.signal?.aborted) break;
        let event: Record<string, any>;
        try {
          event = JSON.parse(message.data) as Record<string, any>;
        } catch {
          log.debug('skipping unparsable stream chunk');
          continue;
        }

        switch (event.type) {
          case 'message_start': {
            model = event.message?.model ?? model;
            usage = mergeUsage(usage, event.message?.usage);
            break;
          }
          case 'content_block_start': {
            const index = Number(event.index ?? 0);
            const block = event.content_block as AnthropicContentBlock | undefined;
            blocks.set(index, {
              type: block?.type ?? 'text',
              id: block?.id,
              name: block?.name,
              buffer: '',
            });
            if (block?.type === 'tool_use' && block.name) {
              yield { type: 'tool-call-start', id: block.id ?? `call_${index}`, name: block.name };
            }
            break;
          }
          case 'content_block_delta': {
            const index = Number(event.index ?? 0);
            const entry = blocks.get(index);
            const delta = event.delta ?? {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              text += delta.text;
              yield { type: 'text', delta: delta.text };
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              reasoning += delta.thinking;
              yield { type: 'reasoning', delta: delta.thinking };
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              if (entry) entry.buffer += delta.partial_json;
              yield {
                type: 'tool-call-delta',
                id: entry?.id ?? `call_${index}`,
                argumentsDelta: delta.partial_json,
              };
            }
            break;
          }
          case 'content_block_stop': {
            const index = Number(event.index ?? 0);
            const entry = blocks.get(index);
            if (entry?.type === 'tool_use' && entry.name) {
              toolCalls.push({
                id: entry.id ?? `call_${index}`,
                name: entry.name,
                arguments: safeParseObject(entry.buffer),
              });
            }
            break;
          }
          case 'message_delta': {
            usage = mergeUsage(usage, event.usage);
            if (event.delta?.stop_reason) {
              finishReason = mapStopReason(String(event.delta.stop_reason));
            }
            break;
          }
          case 'error': {
            throw new OrbitError(`${this.name} reported an error mid-stream.`, {
              kind: 'provider',
              detail: String(event.error?.message ?? 'unknown'),
            });
          }
          default:
            break;
        }
      }
    } catch (error) {
      if (isCancellation(error) || request.signal?.aborted) finishReason = 'cancelled';
      else throw error;
    }

    for (const call of toolCalls) yield { type: 'tool-call', call };
    if (usage) yield { type: 'usage', usage };
    if (toolCalls.length > 0 && finishReason === 'stop') finishReason = 'tool_calls';

    const result: ChatResponse = {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      finishReason,
      model,
    };
    yield { type: 'done', finishReason, response: result };
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { __orbit_unparsed_arguments: trimmed };
  }
}

function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function mergeUsage(
  current: Usage | undefined,
  incoming:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined,
): Usage | undefined {
  if (!incoming) return current;
  const promptTokens = incoming.input_tokens ?? current?.promptTokens ?? 0;
  const completionTokens = incoming.output_tokens ?? current?.completionTokens ?? 0;
  const cachedTokens = incoming.cache_read_input_tokens ?? current?.cachedTokens;
  const cacheWriteTokens = incoming.cache_creation_input_tokens ?? current?.cacheWriteTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function blockText(block: Record<string, unknown>): string {
  return typeof block.text === 'string' ? block.text : '';
}

function toBlocks(content: ContentPart[], allowImages: boolean): Array<Record<string, unknown>> {
  return content.map((part) => {
    if (part.type === 'image') {
      if (!allowImages) {
        return {
          type: 'text',
          text: `[image omitted: ${part.name ?? part.mediaType} — the selected model does not accept image input]`,
        };
      }
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.data },
      };
    }
    return { type: 'text', text: part.text };
  });
}

function toAnthropicMessage(message: Message, allowImages: boolean): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: typeof message.content === 'string' ? message.content : toBlocks(message.content, false),
        },
      ],
    };
  }

  const blocks: Array<Record<string, unknown>> = [];
  const textContent = typeof message.content === 'string' ? message.content : '';
  if (Array.isArray(message.content)) blocks.push(...toBlocks(message.content, allowImages));
  else if (textContent) blocks.push({ type: 'text', text: textContent });

  if (message.role === 'assistant' && message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.arguments ?? {},
      });
    }
  }

  return { role: message.role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
}

/** Anthropic rejects consecutive messages with the same role; merge their blocks. */
function mergeConsecutive(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (previous && previous.role === message.role) {
      const a = previous.content as unknown[];
      const b = message.content as unknown[];
      previous.content = [...a, ...b];
    } else {
      out.push({ ...message });
    }
  }
  return out;
}
