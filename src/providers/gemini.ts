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
  type JSONSchema,
  type Message,
  type ModelInfo,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from './provider.js';

const log = createLogger('provider:gemini');

export interface GeminiProviderOptions {
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

/** Native Google Generative Language API (`generateContent`). */
export class GeminiProvider implements AIProvider {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly toolsOverride: boolean | undefined;
  private readonly visionOverride: boolean | undefined;
  private readonly windowOverride: number | undefined;

  constructor(options: GeminiProviderOptions) {
    this.id = options.id ?? 'gemini';
    this.name = options.name ?? 'Google Gemini';
    this.model = options.model;
    this.baseURL = (options.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/+$/,
      '',
    );
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.toolsOverride = options.supportsTools;
    this.visionOverride = options.supportsVision;
    this.windowOverride = options.contextWindow;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.apiKey) headers['x-goog-api-key'] = this.apiKey;
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
      url: `${this.baseURL}/models`,
      method: 'GET',
      headers: this.headers(),
      signal,
      providerName: this.name,
    });
    if (!response.ok) throw await httpErrorFor(response, this.name);
    const payload = (await response.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };
    return (payload.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => {
        const id = (m.name ?? '').replace(/^models\//, '');
        return {
          id,
          label: m.displayName,
          ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}),
          supportsTools: true,
          supportsVision: true,
        } satisfies ModelInfo;
      })
      .filter((m) => m.id.length > 0);
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : partsToText(m.content)))
      .join('\n\n');

    const contents = mergeConsecutive(
      request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => toGeminiContent(m, this.supportsVision())),
    );

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    if (request.tools?.length && this.supportsTools()) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: sanitizeSchema(tool.parameters),
          })),
        },
      ];
      body.toolConfig = {
        functionCallingConfig: {
          mode: request.toolChoice === 'required' ? 'ANY' : request.toolChoice === 'none' ? 'NONE' : 'AUTO',
        },
      };
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return collectStream(this.stream(request), request.model);
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const url = `${this.baseURL}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
    const response = await rawRequest({
      url,
      headers: { accept: 'text/event-stream', ...this.headers() },
      body: this.buildBody(request),
      signal: request.signal,
      providerName: this.name,
    });
    if (!response.ok) throw await httpErrorFor(response, this.name);

    const toolCalls: ToolCall[] = [];
    let text = '';
    let reasoning = '';
    let usage: Usage | undefined;
    let finishReason: FinishReason = 'stop';
    let callIndex = 0;

    try {
      for await (const message of parseSSE(response, request.signal)) {
        if (request.signal?.aborted) break;
        let chunk: Record<string, any>;
        try {
          chunk = JSON.parse(message.data) as Record<string, any>;
        } catch {
          log.debug('skipping unparsable stream chunk');
          continue;
        }

        if (chunk.error) {
          throw new OrbitError(`${this.name} reported an error mid-stream.`, {
            kind: 'provider',
            detail: String(chunk.error?.message ?? 'unknown'),
          });
        }

        if (chunk.usageMetadata) {
          const prompt = Number(chunk.usageMetadata.promptTokenCount ?? 0);
          const completion = Number(chunk.usageMetadata.candidatesTokenCount ?? 0);
          // Gemini bills thinking under its own counter rather than folding it
          // into the candidate tokens, so it has to be added back to get the
          // real completion cost.
          const thoughts = Number(chunk.usageMetadata.thoughtsTokenCount ?? 0);
          usage = {
            promptTokens: prompt,
            completionTokens: completion + thoughts,
            totalTokens: Number(chunk.usageMetadata.totalTokenCount ?? prompt + completion + thoughts),
            ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
          };
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            if (part.thought === true) {
              reasoning += part.text;
              yield { type: 'reasoning', delta: part.text };
            } else {
              text += part.text;
              yield { type: 'text', delta: part.text };
            }
          }
          if (part.functionCall?.name) {
            const id = `call_${callIndex++}_${Math.random().toString(36).slice(2, 8)}`;
            const call: ToolCall = {
              id,
              name: String(part.functionCall.name),
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            };
            toolCalls.push(call);
            yield { type: 'tool-call-start', id, name: call.name };
          }
        }

        if (candidate.finishReason) {
          finishReason = mapFinishReason(String(candidate.finishReason), toolCalls.length > 0);
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
      model: request.model,
    };
    yield { type: 'done', finishReason, response: result };
  }
}

function mapFinishReason(reason: string, hasTools: boolean): FinishReason {
  switch (reason) {
    case 'STOP':
      return hasTools ? 'tool_calls' : 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return hasTools ? 'tool_calls' : 'stop';
  }
}

function partsToText(content: ContentPart[]): string {
  return content.map((p) => (p.type === 'text' ? p.text : `[image: ${p.name ?? p.mediaType}]`)).join('\n');
}

function toGeminiContent(message: Message, allowImages: boolean): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: message.name ?? 'tool',
            response: {
              result: typeof message.content === 'string' ? message.content : partsToText(message.content),
            },
          },
        },
      ],
    };
  }

  const parts: Array<Record<string, unknown>> = [];
  if (typeof message.content === 'string') {
    if (message.content) parts.push({ text: message.content });
  } else {
    for (const part of message.content) {
      if (part.type === 'image') {
        if (allowImages) parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } });
        else
          parts.push({
            text: `[image omitted: ${part.name ?? part.mediaType} — the selected model does not accept image input]`,
          });
      } else if (part.text) {
        parts.push({ text: part.text });
      }
    }
  }

  for (const call of message.toolCalls ?? []) {
    parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
  }

  if (parts.length === 0) parts.push({ text: '' });
  return { role: message.role === 'assistant' ? 'model' : 'user', parts };
}

function mergeConsecutive(contents: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const content of contents) {
    const previous = out[out.length - 1];
    if (previous && previous.role === content.role) {
      previous.parts = [...(previous.parts as unknown[]), ...(content.parts as unknown[])];
    } else {
      out.push({ ...content });
    }
  }
  return out;
}

/** Gemini accepts a restricted JSON Schema dialect; drop what it rejects. */
export function sanitizeSchema(schema: JSONSchema): JSONSchema {
  const DROP = new Set([
    '$schema',
    'additionalProperties',
    'definitions',
    '$defs',
    '$ref',
    'const',
    'examples',
    'default',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'patternProperties',
    'oneOf',
    'allOf',
    'not',
  ]);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (DROP.has(key)) continue;
      out[key] = walk(value);
    }
    return out;
  };

  return walk(schema) as JSONSchema;
}
