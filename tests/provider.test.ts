import { describe, expect, it, afterEach } from 'vitest';
import { OpenAICompatibleProvider, ToolCallAccumulator, parseToolCall, mapFinishReason } from '../src/providers/compatible.js';
import { guessContextWindow, guessVisionSupport, collectStream } from '../src/providers/provider.js';
import { sanitizeSchema } from '../src/providers/gemini.js';
import { OrbitError } from '../src/util/errors.js';
import { startMockProvider, type MockProviderServer } from './mock-provider.js';

let server: MockProviderServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function makeProvider(baseURL: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'mock',
    name: 'Mock',
    baseURL,
    apiKey: 'sk-test-key-value-1234567890',
    model: 'mock-model',
  });
}

describe('OpenAICompatibleProvider', () => {
  it('streams text deltas and reports usage', async () => {
    server = await startMockProvider([{ text: 'Hello from the mock model.' }]);
    const provider = makeProvider(server.baseURL);

    const deltas: string[] = [];
    let done: any;
    for await (const event of provider.stream({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'text') deltas.push(event.delta);
      if (event.type === 'done') done = event.response;
    }

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Hello from the mock model.');
    expect(done.usage.totalTokens).toBe(125);
    expect(done.finishReason).toBe('stop');
  });

  it('reassembles tool calls streamed in fragments', async () => {
    server = await startMockProvider([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'src/index.ts', limit: 50 } }] },
    ]);
    const provider = makeProvider(server.baseURL);

    const response = await collectStream(
      provider.stream({ model: 'mock-model', messages: [{ role: 'user', content: 'read it' }] }),
      'mock-model',
    );

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe('read_file');
    expect(response.toolCalls[0]!.arguments).toEqual({ path: 'src/index.ts', limit: 50 });
    expect(response.finishReason).toBe('tool_calls');
  });

  it('sends tool definitions when the model supports them', async () => {
    server = await startMockProvider([{ text: 'ok' }]);
    const provider = makeProvider(server.baseURL);

    await collectStream(
      provider.stream({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      }),
      'mock-model',
    );

    expect(server.requests[0]?.tools?.[0]?.function?.name).toBe('read_file');
    expect(server.requests[0]?.stream).toBe(true);
  });

  it('turns an auth failure into an actionable error', async () => {
    server = await startMockProvider([{ httpStatus: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }]);
    const provider = makeProvider(server.baseURL);

    await expect(
      collectStream(
        provider.stream({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
        'mock-model',
      ),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('marks a rate limit as retryable', async () => {
    server = await startMockProvider([{ httpStatus: 429 }]);
    const provider = makeProvider(server.baseURL);

    try {
      await collectStream(
        provider.stream({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
        'mock-model',
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      expect((error as OrbitError).retryable).toBe(true);
    }
  });

  it('stops streaming when the request is aborted', async () => {
    server = await startMockProvider([{ text: 'a '.repeat(200) }]);
    const provider = makeProvider(server.baseURL);
    const controller = new AbortController();

    const events: string[] = [];
    for await (const event of provider.stream({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })) {
      if (event.type === 'text') {
        events.push(event.delta);
        if (events.length === 3) controller.abort();
      }
      if (event.type === 'done') {
        expect(event.finishReason).toBe('cancelled');
      }
    }

    expect(events.length).toBeLessThan(200);
  });

  it('lists models from the endpoint', async () => {
    server = await startMockProvider([]);
    const provider = makeProvider(server.baseURL);
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toContain('mock-model');
  });
});

describe('tool call parsing', () => {
  it('marks unparsable arguments instead of throwing', () => {
    const call = parseToolCall('id', 'read_file', '{not json');
    expect(call?.arguments).toHaveProperty('__orbit_unparsed_arguments');
  });

  it('accepts empty arguments', () => {
    expect(parseToolCall('id', 'git_status', '')?.arguments).toEqual({});
  });

  it('ignores a fragment with no tool name', () => {
    expect(parseToolCall('id', undefined, '{}')).toBeNull();
  });

  it('accumulates fragments by index', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push({ index: 0, id: 'c0', function: { name: 'read_file', arguments: '{"pa' } });
    accumulator.push({ index: 0, function: { arguments: 'th":"a.ts"}' } });
    const calls = accumulator.finish();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual({ path: 'a.ts' });
  });

  it('maps provider finish reasons', () => {
    expect(mapFinishReason('stop', false)).toBe('stop');
    expect(mapFinishReason('stop', true)).toBe('tool_calls');
    expect(mapFinishReason('length', false)).toBe('length');
    expect(mapFinishReason('content_filter', false)).toBe('content_filter');
  });
});

describe('capability heuristics', () => {
  it('recognises vision-capable model families', () => {
    expect(guessVisionSupport('gpt-4o')).toBe(true);
    expect(guessVisionSupport('claude-sonnet-4-5')).toBe(true);
    expect(guessVisionSupport('gemini-2.5-pro')).toBe(true);
    expect(guessVisionSupport('deepseek-chat')).toBe(false);
  });

  it('estimates context windows', () => {
    expect(guessContextWindow('gpt-4o')).toBe(128_000);
    expect(guessContextWindow('some-unknown-model')).toBe(32_768);
  });
});

describe('gemini schema sanitiser', () => {
  it('drops keywords the API rejects', () => {
    const cleaned = sanitizeSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', default: '.' } },
      required: ['path'],
    });

    expect(cleaned).not.toHaveProperty('$schema');
    expect(cleaned).not.toHaveProperty('additionalProperties');
    expect((cleaned.properties as any).path).not.toHaveProperty('default');
    expect(cleaned.required).toEqual(['path']);
  });
});
