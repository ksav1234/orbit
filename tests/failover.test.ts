import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { Agent, failoverApplies } from '../src/agent/agent.js';
import { Planner } from '../src/agent/planner.js';
import type { AgentEvent } from '../src/agent/loop.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { ConfigSchema } from '../src/config/schema.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import { OrbitError } from '../src/util/errors.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

// ── Which failures are worth asking someone else about ────────────────────

describe('deciding whether to fail over', () => {
  const all = ['rate-limit', 'billing', 'server', 'auth', 'network'] as const;

  it('switches for the failures a different provider could survive', () => {
    const cases: Array<[string, boolean]> = [
      ['rate-limit', true],
      ['billing', true],
      ['auth', true],
      ['network', true],
    ];
    for (const [kind, expected] of cases) {
      const error = new OrbitError('x', { kind: kind as never });
      expect(failoverApplies(error, all), kind).toBe(expected);
    }
  });

  // A rejected request would be rejected everywhere. Switching would just burn
  // credit at a second provider to reach the same error more slowly.
  it('does not switch when the request itself is at fault', () => {
    const rejected = new OrbitError('bad request', { kind: 'provider' });
    expect(failoverApplies(rejected, all)).toBe(false);

    const serverTrouble = new OrbitError('500', { kind: 'provider', retryable: true });
    expect(failoverApplies(serverTrouble, all)).toBe(true);
  });

  it('ignores kinds nothing could help with', () => {
    for (const kind of ['context', 'sandbox', 'permission', 'cancelled', 'tool', 'config'] as const) {
      expect(failoverApplies(new OrbitError('x', { kind }), all), kind).toBe(false);
    }
  });

  it('respects a narrowed trigger list', () => {
    const billing = new OrbitError('no credit', { kind: 'billing' });
    expect(failoverApplies(billing, ['rate-limit'])).toBe(false);
    expect(failoverApplies(billing, ['billing'])).toBe(true);
  });
});

// ── A provider that fails, and one that does not ──────────────────────────

interface FakeProvider {
  baseURL: string;
  requests: number;
  close(): Promise<void>;
}

/** Answers every request with a fixed HTTP status, or streams a reply. */
async function startProvider(
  behaviour: { status: number; body?: unknown } | { reply: string },
): Promise<FakeProvider> {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm' }] }));
      return;
    }
    state.requests += 1;
    req.on('data', () => {});
    req.on('end', () => {
      if ('status' in behaviour) {
        res.writeHead(behaviour.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(behaviour.body ?? { error: { message: 'nope' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: 'c', object: 'chat.completion.chunk', model: 'm' };
      send({ ...base, choices: [{ index: 0, delta: { content: behaviour.reply } }] });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let servers: FakeProvider[] = [];
let workspace = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-failover-');
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  await removeTempWorkspace(workspace);
});

async function makeAgent(options: {
  primary: FakeProvider;
  fallbacks: Record<string, FakeProvider>;
  chain: string[];
  triggers?: string[];
  returnToPrimary?: boolean;
}) {
  const config = ConfigSchema.parse({
    agent: { maxRetries: 0, maxIterations: 4 },
    optimizer: { enabled: false, autoDetectWindow: false },
    failover: {
      providers: options.chain,
      ...(options.triggers ? { on: options.triggers } : {}),
      ...(options.returnToPrimary !== undefined ? { returnToPrimary: options.returnToPrimary } : {}),
    },
  });

  const build = (baseURL: string, label: string) =>
    createProvider({
      config: {
        id: label.toLowerCase(),
        label,
        kind: 'openai-compatible',
        baseURL,
        model: 'm',
        models: ['m'],
        headers: {},
        supportsTools: true,
        supportsVision: false,
      },
      apiKey: 'sk-test-key-1234567890',
      model: 'm',
    });

  const agent = new Agent({
    provider: build(options.primary.baseURL, 'Primary'),
    model: 'm',
    config,
    sandbox: new Sandbox({ root: workspace }),
    permissions: new PermissionManager({ policy: config.permissions }),
    registry: buildToolRegistry({}),
    planner: new Planner(),
    workspace: await detectWorkspace(workspace),
    sessions: new SessionManager(),
    providerLabel: 'Primary',
    providerFor: (id) => {
      const server = options.fallbacks[id];
      if (!server) return undefined;
      return { provider: build(server.baseURL, id), model: 'm', label: id };
    },
  });
  await agent.initialize();

  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, events };
}

describe('failing over to another provider', () => {
  it('finishes the turn on the fallback when the primary is out of credit', async () => {
    const primary = await startProvider({
      status: 402,
      body: { error: { message: 'Insufficient Balance' } },
    });
    const backup = await startProvider({ reply: 'answered by the backup' });
    servers = [primary, backup];

    const { agent, events } = await makeAgent({
      primary,
      fallbacks: { backup },
      chain: ['backup'],
    });

    const result = await agent.send('hello');

    expect(result.reason).toBe('complete');
    // The turn produced a real answer, from the provider that could give one.
    expect(agent.context.messages().some((m) => String(m.content).includes('backup'))).toBe(true);

    const switched = events.find((event) => event.type === 'failover');
    expect(switched).toMatchObject({ from: 'Primary', to: 'backup' });
    expect(backup.requests).toBe(1);
  });

  it('switches for a rate limit', async () => {
    const primary = await startProvider({ status: 429 });
    const backup = await startProvider({ reply: 'ok' });
    servers = [primary, backup];

    const { agent, events } = await makeAgent({ primary, fallbacks: { backup }, chain: ['backup'] });
    const result = await agent.send('hello');

    expect(result.reason).toBe('complete');
    expect(events.some((event) => event.type === 'failover')).toBe(true);
  });

  // A 400 means the request is wrong. Trying it elsewhere wastes a second call.
  it('does not switch when the provider rejected the request', async () => {
    const primary = await startProvider({ status: 400 });
    const backup = await startProvider({ reply: 'never asked' });
    servers = [primary, backup];

    const { agent, events } = await makeAgent({ primary, fallbacks: { backup }, chain: ['backup'] });
    const result = await agent.send('hello');

    expect(result.reason).toBe('error');
    expect(events.some((event) => event.type === 'failover')).toBe(false);
    expect(backup.requests).toBe(0);
  });

  it('walks the chain until someone answers', async () => {
    const primary = await startProvider({ status: 402 });
    const first = await startProvider({ status: 429 });
    const second = await startProvider({ reply: 'third time lucky' });
    servers = [primary, first, second];

    const { agent, events } = await makeAgent({
      primary,
      fallbacks: { first, second },
      chain: ['first', 'second'],
    });

    const result = await agent.send('hello');

    expect(result.reason).toBe('complete');
    expect(events.filter((event) => event.type === 'failover')).toHaveLength(2);
    expect(second.requests).toBe(1);
  });

  it('gives up with the real error when the whole chain fails', async () => {
    const primary = await startProvider({ status: 402 });
    const backup = await startProvider({ status: 429 });
    servers = [primary, backup];

    const { agent, events } = await makeAgent({ primary, fallbacks: { backup }, chain: ['backup'] });
    const result = await agent.send('hello');

    expect(result.reason).toBe('error');
    // The surfaced error is the last real failure, not a generic one.
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  // Cycling between two dead providers would spin forever.
  it('tries each provider at most once per turn', async () => {
    const primary = await startProvider({ status: 402 });
    const backup = await startProvider({ status: 402 });
    servers = [primary, backup];

    const { agent } = await makeAgent({
      primary,
      fallbacks: { backup },
      chain: ['backup', 'backup', 'backup'],
    });
    await agent.send('hello');

    expect(backup.requests).toBe(1);
  });

  it('skips a candidate that is not configured', async () => {
    const primary = await startProvider({ status: 402 });
    const backup = await startProvider({ reply: 'reached' });
    servers = [primary, backup];

    const { agent, events } = await makeAgent({
      primary,
      fallbacks: { backup },
      chain: ['does-not-exist', 'backup'],
    });
    const result = await agent.send('hello');

    expect(result.reason).toBe('complete');
    expect(events.filter((event) => event.type === 'failover')).toHaveLength(1);
  });

  it('does nothing at all when no chain is configured', async () => {
    const primary = await startProvider({ status: 402 });
    servers = [primary];

    const { agent, events } = await makeAgent({ primary, fallbacks: {}, chain: [] });
    const result = await agent.send('hello');

    expect(result.reason).toBe('error');
    expect(events.some((event) => event.type === 'failover')).toBe(false);
  });

  it('returns to the primary on the next turn', async () => {
    const primary = await startProvider({ status: 402 });
    const backup = await startProvider({ reply: 'ok' });
    servers = [primary, backup];

    const { agent } = await makeAgent({
      primary,
      fallbacks: { backup },
      chain: ['backup'],
      returnToPrimary: true,
    });

    await agent.send('first');
    expect(agent.provider.name).toBe('backup');

    await agent.send('second');
    // Asked the primary again rather than quietly settling on the fallback.
    expect(primary.requests).toBe(2);
  });
});
