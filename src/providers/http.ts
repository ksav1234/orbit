import { OrbitError, isCancellation, toFriendlyError } from '../util/errors.js';
import { redact } from '../util/redact.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('http');

export interface RequestOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  providerName: string;
}

/**
 * Map an HTTP failure onto an OrbitError with a message a human can act on.
 * Raw provider bodies are redacted before they are ever shown or logged.
 */
export async function httpErrorFor(response: Response, providerName: string): Promise<OrbitError> {
  let bodyText = '';
  try {
    bodyText = (await response.text()).slice(0, 2000);
  } catch {
    bodyText = '';
  }

  let detail = redact(bodyText);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? parsed.message ?? '');
    if (message) detail = redact(message);
  } catch {
    // Non-JSON body: keep the redacted raw text.
  }

  const status = response.status;

  if (status === 401 || status === 403) {
    return new OrbitError(`${providerName} rejected the API key.`, {
      kind: 'auth',
      detail,
      hints: [
        'Check the key is correct and still active.',
        'Update it with: orbit provider add',
      ],
    });
  }
  if (status === 404) {
    return new OrbitError(`${providerName} endpoint or model was not found.`, {
      kind: 'provider',
      detail,
      hints: ['Verify the base URL.', 'Check the model id with: orbit model list'],
    });
  }
  if (status === 429) {
    const retryAfter = response.headers.get('retry-after');
    return new OrbitError(`${providerName} rate limit reached.`, {
      kind: 'rate-limit',
      detail: retryAfter ? `Retry after ${retryAfter}s. ${detail}` : detail,
      hints: ['Wait a moment and retry.', 'Consider a different model or provider.'],
      retryable: true,
    });
  }
  if (status === 400 || status === 422) {
    return new OrbitError(`${providerName} rejected the request.`, {
      kind: 'provider',
      detail,
      hints: [
        'The model may not support tools or images.',
        'Try a different model with: /model',
      ],
    });
  }
  if (status >= 500) {
    return new OrbitError(`${providerName} is having server trouble (HTTP ${status}).`, {
      kind: 'provider',
      detail,
      hints: ['This is usually temporary. Retry shortly.'],
      retryable: true,
    });
  }

  return new OrbitError(`${providerName} request failed (HTTP ${status}).`, {
    kind: 'provider',
    detail,
  });
}

export async function requestJSON<T>(options: RequestOptions): Promise<T> {
  const response = await rawRequest(options);
  if (!response.ok) throw await httpErrorFor(response, options.providerName);
  return (await response.json()) as T;
}

export async function rawRequest(options: RequestOptions): Promise<Response> {
  const { url, method = 'POST', headers = {}, body, signal, providerName } = options;
  log.debug('request', { url, method });
  try {
    return await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'orbit-cli',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    throw toFriendlyError(error, { provider: providerName });
  }
}

export interface SSEMessage {
  event?: string;
  data: string;
}

/**
 * Parse a server-sent-events body incrementally. Handles CRLF, multi-line
 * `data:` fields, and mid-chunk event boundaries.
 */
export async function* parseSSE(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage> {
  if (!response.body) {
    throw new OrbitError('Streaming response had no body.', { kind: 'provider' });
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const message = parseSSEBlock(rawEvent);
      if (message) yield message;
      boundary = buffer.indexOf('\n\n');
    }
  }

  const tail = parseSSEBlock(buffer);
  if (tail) yield tail;
}

function parseSSEBlock(block: string): SSEMessage | null {
  const lines = block.split('\n');
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
  }

  if (dataLines.length === 0) return null;
  return event ? { event, data: dataLines.join('\n') } : { data: dataLines.join('\n') };
}

/** Streaming JSON-lines fallback for endpoints that do not use SSE framing. */
export async function* parseJSONLines(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) yield buffer.trim();
}
