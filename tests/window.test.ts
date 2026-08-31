import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  WindowCache,
  describeWindowSource,
  detectWindow,
  isPlausibleWindow,
  parseWindowFromError,
  parseWindowArgument,
  resolveWindow,
  stepWindow,
  WINDOW_LADDER,
} from '../src/context/window.js';
import { OpenAICompatibleProvider } from '../src/providers/compatible.js';
import { guessContextWindow } from '../src/providers/provider.js';
import { ContextManager } from '../src/context/manager.js';
import type { AIProvider } from '../src/providers/provider.js';
import type { WindowResolution } from '../src/context/window.js';
import { Agent } from '../src/agent/agent.js';
import { Planner } from '../src/agent/planner.js';
import { ConfigSchema } from '../src/config/schema.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { detectWorkspace } from '../src/tools/project.js';
import { loadConfig, resetConfigSingleton } from '../src/config/manager.js';
import { SLASH_COMMANDS, type SlashContext } from '../src/cli/commands.js';

// ── A configurable OpenAI-compatible endpoint ─────────────────────────────

interface FakeApiOptions {
  /** Entries returned from `/models`. */
  models?: Array<Record<string, unknown>>;
  /** Status + body for `/chat/completions`, used to exercise the probe. */
  completion?: { status: number; body: unknown };
}

interface FakeApi {
  baseURL: string;
  /** Paths hit, in order, so tests can assert what was and wasn't called. */
  hits: string[];
  close(): Promise<void>;
}

async function startFakeApi(options: FakeApiOptions): Promise<FakeApi> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url?.endsWith('/models')) {
      if (!options.models) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: options.models }));
      return;
    }
    // Drain the body before answering, as a real server would.
    req.on('data', () => {});
    req.on('end', () => {
      const reply = options.completion ?? { status: 500, body: { error: { message: 'boom' } } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function providerFor(baseURL: string, model = 'test-model'): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'test',
    name: 'Test',
    baseURL,
    model,
    apiKey: 'sk-test',
  });
}

// ── Parsing ───────────────────────────────────────────────────────────────

describe('reading a window out of a provider error', () => {
  it('accepts the phrasings servers actually use', () => {
    const cases: Array<[string, number]> = [
      [
        "This model's maximum context length is 65536 tokens, however you requested 2000000000 tokens.",
        65_536,
      ],
      ["This model's maximum context length is 1,000,000 tokens.", 1_000_000],
      ['max_seq_len is 8192 for this model', 8192],
      ["The model's maximum sequence length is 131072", 131_072],
      ['requested more than the context window of 200000 tokens', 200_000],
      ['error: context_length_exceeded (limit: context length 128000)', 128_000],
      ['This model supports at most 262144 total tokens', 262_144],
    ];
    for (const [message, expected] of cases) {
      expect(parseWindowFromError(message), message).toBe(expected);
    }
  });

  // Conflating the two would silently under-budget every conversation, which
  // is worse than not detecting anything at all.
  it('never mistakes an output cap for the context window', () => {
    const outputCaps = [
      'max_tokens must be less than or equal to 8192',
      'Invalid value for max_tokens: 2000000000. Maximum is 4096.',
      'max_completion_tokens exceeds the limit of 16384',
      'This model supports at most 8192 completion tokens',
    ];
    for (const message of outputCaps) {
      expect(parseWindowFromError(message), message).toBeUndefined();
    }
  });

  it('rejects text with no number and implausible numbers', () => {
    expect(parseWindowFromError('')).toBeUndefined();
    expect(parseWindowFromError('Insufficient Balance')).toBeUndefined();
    expect(parseWindowFromError('rate limited, try again')).toBeUndefined();
    // A byte count or timestamp that happened to land near the word "context".
    expect(parseWindowFromError('context length 1e12')).toBeUndefined();
    expect(isPlausibleWindow(0)).toBe(false);
    expect(isPlausibleWindow(512)).toBe(false);
    expect(isPlausibleWindow(1_763_000_000_000)).toBe(false);
    expect(isPlausibleWindow(1_000_000)).toBe(true);
  });
});

// ── Resolution order ──────────────────────────────────────────────────────

describe('resolving a window without the network', () => {
  it('puts the user first, then the cache, then the name', () => {
    const cache = WindowCache.ephemeral();
    cache.record('p', 'm', { tokens: 400_000, source: 'reported' });

    expect(resolveWindow({ providerId: 'p', model: 'm', explicit: 250_000, cache })).toEqual({
      tokens: 250_000,
      source: 'explicit',
    });
    expect(resolveWindow({ providerId: 'p', model: 'm', cache })).toEqual({
      tokens: 400_000,
      source: 'reported',
    });
    expect(resolveWindow({ providerId: 'p', model: 'other', cache })).toEqual({
      tokens: guessContextWindow('other'),
      source: 'name',
    });
  });

  it('ignores an implausible override rather than acting on it', () => {
    const resolved = resolveWindow({ providerId: 'p', model: 'gemini-2.5-pro', explicit: 12 });
    expect(resolved.source).not.toBe('explicit');
    expect(resolved.tokens).toBeGreaterThan(1024);
  });

  // A preset is written for the models that existed when it was written, so it
  // must not cap a later model whose name already implies more room.
  it('does not let a preset shrink a model the name knows is larger', () => {
    const withPreset = resolveWindow({
      providerId: 'gemini',
      model: 'gemini-3-pro',
      preset: 128_000,
    });
    expect(withPreset.tokens).toBe(1_000_000);
    expect(withPreset.source).toBe('name');

    // But it does fill in for a model the name says nothing about.
    const unknown = resolveWindow({
      providerId: 'deepseek',
      model: 'house-blend-9',
      preset: 128_000,
    });
    expect(unknown).toEqual({ tokens: 128_000, source: 'preset' });
  });

  // The specific failure the user hit: a new generation the table predates.
  it('does not drop a new model generation to the 32k floor', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-v9-turbo', 'deepseek-chat']) {
      expect(guessContextWindow(model), model).toBeGreaterThanOrEqual(128_000);
    }
  });

  it('describes every source in words', () => {
    const sources = ['explicit', 'reported', 'probed', 'preset', 'name'] as const;
    for (const source of sources) {
      expect(describeWindowSource(source, 'DeepSeek')).toMatch(/\w/);
    }
    expect(describeWindowSource('reported', 'DeepSeek')).toContain('DeepSeek');
  });
});

// ── Detection over HTTP ───────────────────────────────────────────────────

describe('detecting a window from the provider', () => {
  let api: FakeApi | undefined;

  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it('uses the models endpoint when it reports one, and skips the probe', async () => {
    api = await startFakeApi({
      models: [{ id: 'test-model', context_length: 1_000_000 }, { id: 'other' }],
    });
    const cache = WindowCache.ephemeral();

    const found = await detectWindow({
      provider: providerFor(api.baseURL),
      providerId: 'test',
      model: 'test-model',
      cache,
      allowProbe: true,
    });

    expect(found).toEqual({ tokens: 1_000_000, source: 'reported' });
    expect(api.hits.some((url) => url.includes('chat/completions'))).toBe(false);
  });

  it('reads OpenRouter-style nested windows', async () => {
    api = await startFakeApi({
      models: [{ id: 'test-model', top_provider: { context_length: 262_144 } }],
    });
    const found = await detectWindow({
      provider: providerFor(api.baseURL),
      providerId: 'test',
      model: 'test-model',
      cache: WindowCache.ephemeral(),
      allowProbe: false,
    });
    expect(found).toEqual({ tokens: 262_144, source: 'reported' });
  });

  it('falls back to making the provider name its own limit', async () => {
    api = await startFakeApi({
      models: [{ id: 'test-model' }], // present, but silent about the window
      completion: {
        status: 400,
        body: {
          error: {
            message:
              "This model's maximum context length is 163840 tokens, however you requested 2000000000 tokens.",
          },
        },
      },
    });
    const found = await detectWindow({
      provider: providerFor(api.baseURL),
      providerId: 'test',
      model: 'test-model',
      cache: WindowCache.ephemeral(),
      allowProbe: true,
    });
    expect(found).toEqual({ tokens: 163_840, source: 'probed' });
  });

  it('leaves the probe alone when it is switched off', async () => {
    api = await startFakeApi({ models: [{ id: 'test-model' }] });
    const found = await detectWindow({
      provider: providerFor(api.baseURL),
      providerId: 'test',
      model: 'test-model',
      cache: WindowCache.ephemeral(),
      allowProbe: false,
    });
    expect(found).toBeUndefined();
    expect(api.hits.some((url) => url.includes('chat/completions'))).toBe(false);
  });

  // The real DeepSeek account this was built against answered 402 Insufficient
  // Balance to everything, which must degrade to "no answer", not to a crash.
  it('gives up quietly when the provider errors for an unrelated reason', async () => {
    api = await startFakeApi({
      models: [{ id: 'test-model' }],
      completion: {
        status: 402,
        body: { error: { message: 'Insufficient Balance', type: 'unknown_error' } },
      },
    });
    const found = await detectWindow({
      provider: providerFor(api.baseURL),
      providerId: 'test',
      model: 'test-model',
      cache: WindowCache.ephemeral(),
      allowProbe: true,
    });
    expect(found).toBeUndefined();
  });

  it('survives a provider that is not listening at all', async () => {
    const found = await detectWindow({
      provider: providerFor('http://127.0.0.1:1/v1'),
      providerId: 'test',
      model: 'test-model',
      cache: WindowCache.ephemeral(),
      allowProbe: true,
    });
    expect(found).toBeUndefined();
  });

  it('asks once per model, then answers from the cache', async () => {
    api = await startFakeApi({ models: [{ id: 'test-model', context_length: 200_000 }] });
    const cache = WindowCache.ephemeral();
    const provider = providerFor(api.baseURL);

    await detectWindow({ provider, providerId: 'test', model: 'test-model', cache, allowProbe: true });
    const callsAfterFirst = api.hits.length;
    await detectWindow({ provider, providerId: 'test', model: 'test-model', cache, allowProbe: true });

    expect(api.hits.length).toBe(callsAfterFirst);
  });

  it('remembers a failure too, so a silent provider is not asked every launch', async () => {
    api = await startFakeApi({
      models: [{ id: 'test-model' }],
      completion: { status: 400, body: { error: { message: 'nope' } } },
    });
    const cache = WindowCache.ephemeral();
    const provider = providerFor(api.baseURL);

    await detectWindow({ provider, providerId: 'test', model: 'test-model', cache, allowProbe: true });
    const callsAfterFirst = api.hits.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await detectWindow({ provider, providerId: 'test', model: 'test-model', cache, allowProbe: true });
    expect(api.hits.length).toBe(callsAfterFirst);

    // …until the user explicitly asks again.
    cache.forget('test', 'test-model');
    await detectWindow({ provider, providerId: 'test', model: 'test-model', cache, allowProbe: true });
    expect(api.hits.length).toBeGreaterThan(callsAfterFirst);
  });

  it('does not report a window the endpoint never gave', async () => {
    api = await startFakeApi({ models: [{ id: 'test-model' }, { id: 'roomy', context_length: 999_999 }] });
    const models = await providerFor(api.baseURL).listModels();

    expect(models.find((m) => m.id === 'test-model')?.contextWindow).toBeUndefined();
    expect(models.find((m) => m.id === 'roomy')?.contextWindow).toBe(999_999);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────

describe('the detection cache on disk', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-window-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('survives a restart', async () => {
    const file = path.join(dir, 'nested', 'context-windows.json');
    const first = await WindowCache.load(file);
    first.record('deepseek', 'deepseek-v4-pro', { tokens: 1_000_000, source: 'probed' });
    await first.save();

    const second = await WindowCache.load(file);
    expect(second.get('deepseek', 'deepseek-v4-pro')).toEqual({
      tokens: 1_000_000,
      source: 'probed',
    });
    expect(second.get('deepseek', 'deepseek-v4-flash')).toBeUndefined();
  });

  it('shrugs off a corrupt file rather than failing a launch', async () => {
    const file = path.join(dir, 'context-windows.json');
    await fs.writeFile(file, '{ this is not json', 'utf8');
    const cache = await WindowCache.load(file);
    expect(cache.get('any', 'thing')).toBeUndefined();
  });

  it('stores nothing for values that were never detected', async () => {
    const file = path.join(dir, 'context-windows.json');
    const cache = await WindowCache.load(file);
    cache.record('p', 'm', { tokens: 999_999, source: 'name' });
    cache.record('p', 'm2', { tokens: 999_999, source: 'explicit' });
    await cache.save();

    await expect(fs.readFile(file, 'utf8')).rejects.toThrow();
  });
});

// ── Budgets follow the window ─────────────────────────────────────────────

describe('adopting a larger window mid-session', () => {
  it('re-bases the reply reserve instead of staying squeezed', () => {
    // Built for a 32k model: the reserve is capped at a quarter of that.
    const context = new ContextManager({ contextWindow: 32_768, responseReserve: 8192 });
    const small = context.budget([]);
    expect(small.window).toBe(32_768);

    // Detection discovers the real window. Without re-basing, the reserve
    // would stay at the 32k-sized figure and the model would be handed a
    // fraction of the room it actually has for an answer.
    context.setContextWindow(1_000_000, 16_000);
    const large = context.budget([]);

    expect(large.window).toBe(1_000_000);
    expect(large.available).toBeGreaterThan(small.available * 20);
    expect(large.available).toBeLessThan(1_000_000);
  });

  it('keeps a shrink honest when switching down to a small model', () => {
    const context = new ContextManager({ contextWindow: 1_000_000, responseReserve: 16_000 });
    context.setContextWindow(8192, 4096);
    const budget = context.budget([]);
    expect(budget.window).toBe(8192);
    // Never hold back more than a quarter of the window for the reply.
    expect(budget.available).toBeGreaterThan(8192 * 0.7);
  });
});

// ── The agent adopting a window ───────────────────────────────────────────

describe('the agent and its window', () => {
  const makeAgent = async (
    overrides: Partial<Parameters<typeof buildAgent>[0]> = {},
  ): ReturnType<typeof buildAgent> => buildAgent(overrides);

  async function buildAgent(overrides: {
    resolveWindow?: (provider: AIProvider, model: string) => WindowResolution;
    detectWindow?: (provider: AIProvider, model: string) => Promise<WindowResolution | undefined>;
  }) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-agent-window-'));
    const config = ConfigSchema.parse({ optimizer: { enabled: false } });
    const sandbox = new Sandbox({ root: workspace });
    const provider = providerFor('http://127.0.0.1:1/v1', 'mock-model');
    const agent = new Agent({
      provider,
      model: 'mock-model',
      config,
      sandbox,
      permissions: new PermissionManager({ policy: config.permissions }),
      registry: buildToolRegistry({}),
      planner: new Planner(),
      workspace: await detectWorkspace(workspace),
      sessions: new SessionManager(),
      providerLabel: 'Mock',
      ...overrides,
    });
    await agent.initialize();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    agent.subscribe((event) => events.push(event as never));
    return { agent, events, provider, cleanup: () => fs.rm(workspace, { recursive: true, force: true }) };
  }

  it('starts from the injected resolution rather than the provider guess', async () => {
    const { agent, cleanup } = await makeAgent({
      resolveWindow: () => ({ tokens: 1_000_000, source: 'reported' }),
    });
    try {
      expect(agent.context.getContextWindow()).toBe(1_000_000);
      expect(agent.contextWindowSource()).toBe('reported');
    } finally {
      await cleanup();
    }
  });

  it('announces a window that arrives after startup, and grows the budget', async () => {
    const { agent, events, cleanup } = await makeAgent({});
    try {
      const before = agent.context.budget([]).available;
      agent.applyContextWindow({ tokens: 1_000_000, source: 'probed' });

      const announced = events.find((event) => event.type === 'context-window');
      expect(announced).toMatchObject({ tokens: 1_000_000, source: 'probed' });
      expect(String(announced?.detail)).toContain('Mock');
      expect(agent.context.budget([]).available).toBeGreaterThan(before);
    } finally {
      await cleanup();
    }
  });

  it('says nothing when the detected window matches what is already in force', async () => {
    const { agent, events, cleanup } = await makeAgent({
      resolveWindow: () => ({ tokens: 200_000, source: 'reported' }),
    });
    try {
      agent.applyContextWindow({ tokens: 200_000, source: 'reported' });
      expect(events.filter((event) => event.type === 'context-window')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('detects again when the model changes', async () => {
    const asked: string[] = [];
    const { agent, cleanup } = await makeAgent({
      detectWindow: async (_provider, model) => {
        asked.push(model);
        return model === 'roomy-model' ? { tokens: 1_000_000, source: 'reported' } : undefined;
      },
    });
    try {
      const provider = providerFor('http://127.0.0.1:1/v1', 'roomy-model');
      await agent.switchProvider(provider, 'roomy-model', 'Mock');
      // switchProvider does not wait on the network; the answer lands after.
      await vi.waitFor(() => expect(agent.context.getContextWindow()).toBe(1_000_000));
      expect(asked).toEqual(['roomy-model']);
    } finally {
      await cleanup();
    }
  });

  // A slow answer for a model the user already moved away from must not be
  // applied to whatever they switched to instead.
  it('discards a detection that arrives after another switch', async () => {
    let release: (value: WindowResolution | undefined) => void = () => {};
    const { agent, cleanup } = await makeAgent({
      detectWindow: (_provider, model) =>
        model === 'slow-model'
          ? new Promise<WindowResolution | undefined>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(undefined),
    });
    try {
      await agent.switchProvider(providerFor('http://127.0.0.1:1/v1', 'slow-model'), 'slow-model', 'Mock');
      await agent.switchProvider(providerFor('http://127.0.0.1:1/v1', 'other-model'), 'other-model', 'Mock');
      const settled = agent.context.getContextWindow();

      release({ tokens: 1_000_000, source: 'reported' });
      await Promise.resolve();
      await Promise.resolve();

      expect(agent.context.getContextWindow()).toBe(settled);
    } finally {
      await cleanup();
    }
  });
});

// ── Stepping ──────────────────────────────────────────────────────────────

describe('stepping the window up and down', () => {
  it('walks the ladder from a value already on it', () => {
    expect(stepWindow(131_072, 'up')).toBe(200_000);
    expect(stepWindow(200_000, 'down')).toBe(131_072);
    expect(stepWindow(32_768, 'up')).toBe(65_536);
  });

  // A self-hosted build at an odd size must not move the wrong way, which is
  // what rounding-then-stepping would do.
  it('snaps an off-ladder value in the requested direction', () => {
    expect(stepWindow(48_000, 'up')).toBe(65_536);
    expect(stepWindow(48_000, 'down')).toBe(32_768);
    expect(stepWindow(999_999, 'up')).toBe(1_000_000);
    expect(stepWindow(1_000_001, 'down')).toBe(1_000_000);
  });

  it('keeps working past either end of the ladder', () => {
    const top = WINDOW_LADDER[WINDOW_LADDER.length - 1]!;
    expect(stepWindow(top, 'up')).toBe(Math.min(50_000_000, top * 2));
    expect(stepWindow(2_048, 'down')).toBe(1_024);
    // And never below the floor, however many times it is asked.
    expect(stepWindow(stepWindow(1_024, 'down'), 'down')).toBe(1_024);
  });

  it('never leaves the plausible range', () => {
    let value = 4_096;
    for (let i = 0; i < 40; i++) value = stepWindow(value, 'up');
    expect(isPlausibleWindow(value)).toBe(true);
    for (let i = 0; i < 80; i++) value = stepWindow(value, 'down');
    expect(isPlausibleWindow(value)).toBe(true);
  });
});

describe('reading a resize argument', () => {
  it('accepts absolute sizes with and without units', () => {
    expect(parseWindowArgument('1000000', 32_768)).toBe(1_000_000);
    expect(parseWindowArgument('1m', 32_768)).toBe(1_000_000);
    expect(parseWindowArgument('128k', 32_768)).toBe(128_000);
    expect(parseWindowArgument('1,000,000', 32_768)).toBe(1_000_000);
    expect(parseWindowArgument('262144', 32_768)).toBe(262_144);
  });

  it('accepts relative nudges against what is in force', () => {
    expect(parseWindowArgument('+50000', 128_000)).toBe(178_000);
    expect(parseWindowArgument('-50k', 128_000)).toBe(78_000);
    expect(parseWindowArgument('+1m', 128_000)).toBe(1_128_000);
  });

  it('accepts the step words and their bare-sign aliases', () => {
    expect(parseWindowArgument('up', 131_072)).toBe(200_000);
    expect(parseWindowArgument('UP', 131_072)).toBe(200_000);
    expect(parseWindowArgument('more', 131_072)).toBe(200_000);
    expect(parseWindowArgument('+', 131_072)).toBe(200_000);
    expect(parseWindowArgument('down', 200_000)).toBe(131_072);
    expect(parseWindowArgument('less', 200_000)).toBe(131_072);
    expect(parseWindowArgument('-', 200_000)).toBe(131_072);
  });

  // Landing on the 1024-token floor because the user misjudged a subtraction
  // would look like it was asked for. Refusing is the honest outcome.
  it('refuses a relative move that falls out of range instead of clamping', () => {
    expect(parseWindowArgument('-500k', 128_000)).toBeUndefined();
    expect(parseWindowArgument('-128k', 128_000)).toBeUndefined();
    expect(parseWindowArgument('+999m', 128_000)).toBeUndefined();
  });

  it('rejects anything it cannot read', () => {
    for (const bad of ['', '   ', 'bogus', 'up up', '12.5k', 'auto', '0', 'k', '+-5', '5x']) {
      expect(parseWindowArgument(bad, 128_000), bad).toBeUndefined();
    }
  });
});

// ── /context, in a live session ───────────────────────────────────────────

describe('resizing from inside a session', () => {
  let home = '';
  let workspace = '';

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-ctx-home-'));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-ctx-ws-'));
    process.env.ORBIT_HOME = home;
    resetConfigSingleton();
  });

  afterEach(async () => {
    delete process.env.ORBIT_HOME;
    resetConfigSingleton();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  /**
   * A session with a real ConfigManager and Agent, and a SlashContext carrying
   * only what /context touches. Notices are captured instead of rendered.
   */
  async function session() {
    const configManager = await loadConfig();
    await configManager.update((draft) => {
      draft.activeProvider = 'test';
      draft.providers.test = {
        id: 'test',
        label: 'Test',
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:1/v1',
        model: 'test-model',
        models: ['test-model'],
        headers: {},
      };
      draft.optimizer.enabled = false;
    });

    const config = configManager.get();
    const registry = buildToolRegistry({});
    const agent = new Agent({
      provider: providerFor('http://127.0.0.1:1/v1'),
      model: 'test-model',
      config,
      sandbox: new Sandbox({ root: workspace }),
      permissions: new PermissionManager({ policy: config.permissions }),
      registry,
      planner: new Planner(),
      workspace: await detectWorkspace(workspace),
      sessions: new SessionManager(),
      providerLabel: 'Test',
      resolveWindow: () => ({ tokens: 128_000, source: 'name' }),
    });
    await agent.initialize();

    const notices: string[] = [];
    const context = {
      agent,
      config: configManager,
      registry,
      notice: (text: string) => notices.push(text),
    } as unknown as SlashContext;

    const run = async (args: string): Promise<void> => {
      const command = SLASH_COMMANDS.find((entry) => entry.name === 'context');
      await command?.run(args, context);
    };

    return { agent, configManager, registry, notices, run };
  }

  it('applies a step to the live window and persists it', async () => {
    const { agent, configManager, notices, run } = await session();
    expect(agent.context.getContextWindow()).toBe(128_000);

    await run('up');

    expect(agent.context.getContextWindow()).toBe(131_072);
    expect(configManager.getProvider('test')?.contextWindow).toBe(131_072);
    expect(notices.join(' ')).toMatch(/increased/i);
  });

  it('decreases as well as increases', async () => {
    const { agent, run } = await session();
    await run('down');
    expect(agent.context.getContextWindow()).toBe(65_536);
    await run('64k');
    expect(agent.context.getContextWindow()).toBe(64_000);
  });

  it('grows the room available for the next turn', async () => {
    const { agent, registry, run } = await session();
    const before = agent.context.budget(registry.definitions()).available;
    await run('1m');
    const after = agent.context.budget(registry.definitions()).available;
    expect(after).toBeGreaterThan(before);
  });

  // Shrinking below what is already in the window would make the very next
  // request fail at the provider, which is a worse outcome than refusing.
  it('refuses to shrink below what the conversation already uses', async () => {
    const { agent, configManager, notices, run } = await session();
    agent.context.addUserMessage('x'.repeat(40_000));
    const used = agent.context.budget([]).used;
    expect(used).toBeGreaterThan(4_096);

    await run('4096');

    expect(agent.context.getContextWindow()).toBe(128_000);
    expect(configManager.getProvider('test')?.contextWindow).toBeUndefined();
    expect(notices.join(' ')).toMatch(/already in use|compact/i);
  });

  it('reports a bad argument without changing anything', async () => {
    const { agent, notices, run } = await session();
    await run('enormous');
    expect(agent.context.getContextWindow()).toBe(128_000);
    expect(notices.join(' ')).toMatch(/cannot use/i);
  });

  it('clears an override and says the change lands next launch', async () => {
    const { configManager, notices, run } = await session();
    await run('1m');
    expect(configManager.getProvider('test')?.contextWindow).toBe(1_000_000);

    await run('auto');
    expect(configManager.getProvider('test')?.contextWindow).toBeUndefined();
    expect(notices.join(' ')).toMatch(/next launch/i);
  });

  it('says so rather than rewriting config when nothing would change', async () => {
    const { configManager, notices, run } = await session();
    await run('128000');
    expect(notices.join(' ')).toMatch(/already at/i);
    expect(configManager.getProvider('test')?.contextWindow).toBeUndefined();
  });
});
