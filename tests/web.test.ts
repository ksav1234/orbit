import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import { webSearchTool, webFetchTool } from '../src/tools/web.js';
import { WebConfigSchema } from '../src/config/schema.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace } from './helpers.js';

interface MockTavily {
  baseURL: string;
  requests: Array<{ path: string; body: Record<string, any>; auth: string | undefined }>;
  close(): Promise<void>;
}

async function startMockTavily(
  handler: (path: string, body: Record<string, any>) => { status?: number; payload: unknown },
): Promise<MockTavily> {
  const requests: MockTavily['requests'] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
      requests.push({
        path: req.url ?? '',
        body,
        auth: req.headers.authorization as string | undefined,
      });
      const { status = 200, payload } = handler(req.url ?? '', body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

let server: MockTavily | null = null;
let workspace = '';

afterEach(async () => {
  await server?.close();
  server = null;
  if (workspace) await removeTempWorkspace(workspace);
  workspace = '';
});

async function makeWebContext(options: { apiKey?: string; enabled?: boolean; baseURL: string }) {
  workspace = await makeTempWorkspace('orbit-web-');
  return {
    ...makeToolContext({ root: workspace }),
    web: {
      config: WebConfigSchema.parse({
        baseURL: options.baseURL,
        enabled: options.enabled ?? true,
        maxResults: 3,
      }),
      apiKey: options.apiKey,
    },
  };
}

describe('web_search', () => {
  it('searches and returns results with their sources', async () => {
    server = await startMockTavily(() => ({
      payload: {
        query: 'vitest snapshot',
        answer: 'Vitest supports snapshots via toMatchSnapshot.',
        results: [
          {
            title: 'Snapshot | Vitest',
            url: 'https://vitest.dev/guide/snapshot',
            content: 'Snapshot tests are useful for UI output.',
          },
          {
            title: 'Vitest API',
            url: 'https://vitest.dev/api/',
            content: 'expect(...).toMatchSnapshot()',
          },
        ],
      },
    }));

    const context = await makeWebContext({ apiKey: 'tvly-test-key', baseURL: server.baseURL });
    const args = webSearchTool.parse({ query: 'vitest snapshot' });
    const result = await webSearchTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('vitest.dev/guide/snapshot');
    expect(result.content).toContain('Snapshot tests are useful');
    expect(result.metadata?.results).toBe(2);

    // The key travels in the Authorization header, never the body.
    expect(server.requests[0]?.auth).toBe('Bearer tvly-test-key');
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain('tvly-test-key');
    expect(server.requests[0]?.body.max_results).toBe(3);
  });

  it('labels the provider summary as unverified', async () => {
    server = await startMockTavily(() => ({
      payload: { answer: 'A confident claim.', results: [{ title: 'T', url: 'https://x', content: 'c' }] },
    }));

    const context = await makeWebContext({ apiKey: 'tvly-key', baseURL: server.baseURL });
    const result = await webSearchTool.execute(webSearchTool.parse({ query: 'anything' }), context);

    expect(result.content).toContain('verify before relying on it');
    expect(result.content).toContain('not verified facts');
  });

  it('reports an empty result set rather than inventing one', async () => {
    server = await startMockTavily(() => ({ payload: { results: [] } }));

    const context = await makeWebContext({ apiKey: 'tvly-key', baseURL: server.baseURL });
    const result = await webSearchTool.execute(
      webSearchTool.parse({ query: 'zzzz nonexistent' }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/No web results/);
  });

  it('explains what to do when no key is configured', async () => {
    server = await startMockTavily(() => ({ payload: {} }));
    const context = await makeWebContext({ baseURL: server.baseURL });

    const result = await webSearchTool.execute(webSearchTool.parse({ query: 'anything at all' }), context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/orbit web key/);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses when web access is disabled', async () => {
    server = await startMockTavily(() => ({ payload: {} }));
    const context = await makeWebContext({
      apiKey: 'tvly-key',
      enabled: false,
      baseURL: server.baseURL,
    });

    const result = await webSearchTool.execute(webSearchTool.parse({ query: 'anything at all' }), context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/);
  });

  it('turns a rejected key into an actionable message', async () => {
    server = await startMockTavily(() => ({
      status: 401,
      payload: { detail: 'invalid api key' },
    }));

    const context = await makeWebContext({ apiKey: 'tvly-bad', baseURL: server.baseURL });
    const result = await webSearchTool.execute(webSearchTool.parse({ query: 'anything at all' }), context);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected the API key/);
    expect(result.error).not.toContain('tvly-bad');
  });

  it('asks for network permission and says what leaves the machine', async () => {
    server = await startMockTavily(() => ({ payload: { results: [] } }));
    const context = await makeWebContext({ apiKey: 'tvly-key', baseURL: server.baseURL });

    const request = await webSearchTool.authorize(
      webSearchTool.parse({ query: 'how to configure vitest' }),
      context,
    );

    expect(request?.category).toBe('network');
    expect(request?.details?.some((detail) => /Only the query text/.test(detail.value))).toBe(true);
  });
});

describe('web_fetch', () => {
  it('returns page text and reports pages it could not read', async () => {
    server = await startMockTavily(() => ({
      payload: {
        results: [{ url: 'https://example.com/a', raw_content: 'The full article text.' }],
        failed_results: [{ url: 'https://example.com/b', error: 'timeout' }],
      },
    }));

    const context = await makeWebContext({ apiKey: 'tvly-key', baseURL: server.baseURL });
    const result = await webFetchTool.execute(
      webFetchTool.parse({ urls: ['https://example.com/a', 'https://example.com/b'] }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('The full article text.');
    expect(result.content).toContain('Could not extract 1 page');
    expect(result.metadata).toMatchObject({ fetched: 1, failed: 1 });
  });

  it('fails clearly when nothing could be extracted', async () => {
    server = await startMockTavily(() => ({
      payload: { results: [], failed_results: [{ url: 'https://x', error: 'blocked' }] },
    }));

    const context = await makeWebContext({ apiKey: 'tvly-key', baseURL: server.baseURL });
    const result = await webFetchTool.execute(
      webFetchTool.parse({ urls: ['https://x'] }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/);
  });

  it('splits the character budget across pages', async () => {
    server = await startMockTavily(() => ({
      payload: {
        results: [
          { url: 'https://a', raw_content: 'a'.repeat(50_000) },
          { url: 'https://b', raw_content: 'b'.repeat(50_000) },
        ],
      },
    }));

    const context = await makeWebContext({ apiKey: 'tvly-key', baseURL: server.baseURL });
    const result = await webFetchTool.execute(
      webFetchTool.parse({ urls: ['https://a', 'https://b'] }),
      context,
    );

    // Both pages are represented; neither crowds the other out.
    expect(result.content).toContain('https://a');
    expect(result.content).toContain('https://b');
    expect(result.content.length).toBeLessThan(30_000);
  });
});
