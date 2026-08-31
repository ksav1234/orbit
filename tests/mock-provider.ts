import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Split the text into this many stream chunks (default: word by word). */
  chunkSize?: number;
  /** Report this many completion tokens as reasoning, as a thinking model does. */
  reasoningTokens?: number;
  /** Report this many prompt tokens as cache hits. */
  cachedTokens?: number;
  /** Emit an HTTP error instead of a normal response. */
  httpStatus?: number;
  body?: string;
}

export interface MockProviderServer {
  baseURL: string;
  /** Bodies of the requests the server received, in order. */
  requests: Array<Record<string, any>>;
  close(): Promise<void>;
}

/**
 * A minimal OpenAI-compatible endpoint used to exercise the real provider,
 * agent loop and tools without contacting a live model.
 */
export async function startMockProvider(turns: ScriptedTurn[]): Promise<MockProviderServer> {
  const requests: Array<Record<string, any>> = [];
  let index = 0;

  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] }));
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        requests.push(JSON.parse(raw || '{}'));
      } catch {
        requests.push({});
      }

      const turn = turns[index++] ?? { text: '' };

      if (turn.httpStatus) {
        res.writeHead(turn.httpStatus, { 'content-type': 'application/json' });
        res.end(turn.body ?? JSON.stringify({ error: { message: 'scripted failure' } }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: 'mock-model' };

      if (turn.text) {
        const pieces = splitText(turn.text, turn.chunkSize);
        for (const piece of pieces) {
          send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
        }
      }

      if (turn.toolCalls?.length) {
        turn.toolCalls.forEach((call, callIndex) => {
          // Fragment the call the way real providers stream them.
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: callIndex,
                      id: `call_${callIndex}`,
                      type: 'function',
                      function: { name: call.name, arguments: '' },
                    },
                  ],
                },
              },
            ],
          });

          const serialized = JSON.stringify(call.arguments);
          const midpoint = Math.floor(serialized.length / 2);
          for (const fragment of [serialized.slice(0, midpoint), serialized.slice(midpoint)]) {
            send({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: callIndex, function: { arguments: fragment } }] },
                },
              ],
            });
          }
        });
      }

      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }],
      });
      send({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 125,
          // Reasoning models report the thinking share separately; including it
          // here keeps the token-accounting path exercised end to end.
          ...(turn.reasoningTokens !== undefined
            ? { completion_tokens_details: { reasoning_tokens: turn.reasoningTokens } }
            : {}),
          ...(turn.cachedTokens !== undefined
            ? { prompt_tokens_details: { cached_tokens: turn.cachedTokens } }
            : {}),
        },
      });

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function splitText(text: string, chunkSize?: number): string[] {
  if (chunkSize && chunkSize > 0) {
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) pieces.push(text.slice(i, i + chunkSize));
    return pieces;
  }
  return text.split(/(?<=\s)/);
}
