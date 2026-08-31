import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { Agent } from '../src/agent/agent.js';
import { Planner } from '../src/agent/planner.js';
import type { AgentEvent } from '../src/agent/loop.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { SessionManager } from '../src/sessions/manager.js';
import { ConfigSchema, OptimizerConfigSchema, ToolsConfigSchema } from '../src/config/schema.js';
import { createProvider } from '../src/providers/factory.js';
import { detectWorkspace } from '../src/tools/project.js';
import { TokenOptimizer } from '../src/context/optimizer.js';
import { UsageTracker } from '../src/context/usage.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

// ── The optimizer's sizing decisions ──────────────────────────────────────

function optimizerWith(overrides: Record<string, unknown> = {}): TokenOptimizer {
  return new TokenOptimizer(
    OptimizerConfigSchema.parse({ enabled: true, ...overrides }),
    ToolsConfigSchema.parse({}),
  );
}

const base = {
  window: 128_000,
  used: 7_000,
  configuredMaxTokens: 8_192,
  averageCompletion: 700,
  peakCompletion: 700,
  samples: 4,
};

describe('sizing the output budget', () => {
  // The reported failure: 1.4k granted, 1.4k spent thinking, nothing written.
  it('leaves room for the answer on a model that thinks', () => {
    const withoutThinking = optimizerWith().decide(base).responseTokens;
    const withThinking = optimizerWith().decide({
      ...base,
      averageReasoning: 1_400,
      peakReasoning: 1_400,
    }).responseTokens;

    expect(withThinking).toBeGreaterThan(withoutThinking);
    // Enough for the observed thinking plus a real answer on top of it.
    expect(withThinking).toBeGreaterThan(1_400 * 2);
  });

  it('scales the floor with how much the model actually thinks', () => {
    const modest = optimizerWith().decide({ ...base, peakReasoning: 500 }).responseTokens;
    const heavy = optimizerWith().decide({ ...base, peakReasoning: 6_000 }).responseTokens;
    expect(heavy).toBeGreaterThan(modest);
    expect(heavy).toBeGreaterThan(6_000);
  });

  it('does not inflate the budget for a model that does not think', () => {
    const decision = optimizerWith().decide({ ...base, averageReasoning: 0, peakReasoning: 0 });
    // Sized from the observed 700-token replies, not padded with headroom.
    expect(decision.responseTokens).toBeLessThan(8_192);
  });

  // The feedback trap: a truncated completion is evidence of the cap, not of
  // how long a reply wants to be, so growing 35% at a time truncates forever.
  it('doubles out of a truncation instead of crawling', () => {
    const optimizer = optimizerWith();
    const granted = optimizer.decide(base).responseTokens;

    // The observations stay small on purpose — most replies really were short.
    // Only the truncation signal can justify a bigger grant, so this isolates
    // it: without the escape the budget would be sized from the 300-token
    // average and the turn would truncate all over again.
    const afterTruncation = optimizer.decide({
      ...base,
      averageCompletion: 300,
      peakCompletion: 300,
      lastTruncated: true,
    }).responseTokens;

    expect(afterTruncation).toBeGreaterThanOrEqual(granted * 2);

    // And without the signal, the same small observations size it down again.
    const withoutSignal = optimizerWith().decide({
      ...base,
      averageCompletion: 300,
      peakCompletion: 300,
    }).responseTokens;
    expect(withoutSignal).toBeLessThan(afterTruncation);
  });

  it('keeps every figure inside the window it was given', () => {
    const decision = optimizerWith().decide({
      ...base,
      window: 8_192,
      used: 6_000,
      peakReasoning: 20_000,
      lastTruncated: true,
    });
    expect(decision.responseTokens).toBeLessThanOrEqual(8_192 - 6_000);
    expect(decision.responseTokens).toBeGreaterThan(0);
  });

  it('respects the headroom setting', () => {
    const generous = optimizerWith({ reasoningHeadroom: 16_000 }).decide({
      ...base,
      peakReasoning: 1_000,
    }).responseTokens;
    const none = optimizerWith({ reasoningHeadroom: 0 }).decide({
      ...base,
      peakReasoning: 1_000,
    }).responseTokens;
    expect(generous).toBeGreaterThan(none);
  });
});

describe('recording that a reply was cut off', () => {
  it('remembers the last request was truncated, then forgets after a good one', () => {
    const tracker = new UsageTracker();
    const turn = { at: new Date().toISOString(), model: 'm', provider: 'P' };

    tracker.record({ ...turn, promptTokens: 100, completionTokens: 1_400, truncated: true });
    expect(tracker.lastWasTruncated()).toBe(true);

    tracker.record({ ...turn, promptTokens: 100, completionTokens: 600 });
    expect(tracker.lastWasTruncated()).toBe(false);
  });

  it('tracks thinking separately from the answer', () => {
    const tracker = new UsageTracker();
    const turn = { at: new Date().toISOString(), model: 'm', provider: 'P' };
    tracker.record({ ...turn, promptTokens: 10, completionTokens: 2_000, reasoningTokens: 1_800 });
    tracker.record({ ...turn, promptTokens: 10, completionTokens: 1_000, reasoningTokens: 200 });

    expect(tracker.peakReasoning()).toBe(1_800);
    expect(tracker.averageReasoning()).toBe(1_000);
  });

  it('ignores replies with no thinking when averaging thinking', () => {
    const tracker = new UsageTracker();
    const turn = { at: new Date().toISOString(), model: 'm', provider: 'P' };
    tracker.record({ ...turn, promptTokens: 10, completionTokens: 500 });
    tracker.record({ ...turn, promptTokens: 10, completionTokens: 900, reasoningTokens: 400 });

    // Averaging in the zero would halve the figure and starve the budget again.
    expect(tracker.averageReasoning()).toBe(400);
  });
});

// ── The loop retrying a starved request ───────────────────────────────────

interface ThinkingServer {
  baseURL: string;
  /** The `max_tokens` each request asked for, in order. */
  budgets: number[];
  close(): Promise<void>;
}

/**
 * A provider that spends its entire allowance thinking until the allowance is
 * big enough — exactly what a reasoning model does on a starved budget.
 */
async function startThinkingProvider(answerNeeds: number): Promise<ThinkingServer> {
  const budgets: number[] = [];
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'reasoner' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { max_tokens?: number };
      const budget = body.max_tokens ?? 0;
      budgets.push(budget);

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const shell = { id: 'c', object: 'chat.completion.chunk', model: 'reasoner' };

      if (budget < answerNeeds) {
        // All of it went on thinking; no answer text at all.
        send({ ...shell, choices: [{ index: 0, delta: { reasoning_content: 'thinking…' } }] });
        send({
          ...shell,
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: {
            prompt_tokens: 7_900,
            completion_tokens: budget,
            total_tokens: 7_900 + budget,
            completion_tokens_details: { reasoning_tokens: budget },
          },
        });
      } else {
        send({ ...shell, choices: [{ index: 0, delta: { reasoning_content: 'thinking…' } }] });
        send({ ...shell, choices: [{ index: 0, delta: { content: 'Here is the answer.' } }] });
        send({
          ...shell,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 7_900,
            completion_tokens: 1_600,
            total_tokens: 9_500,
            completion_tokens_details: { reasoning_tokens: 1_400 },
          },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    budgets,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let server: ThinkingServer | undefined;
let workspace = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-limit-');
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await removeTempWorkspace(workspace);
});

async function makeAgent(overrides: Record<string, unknown> = {}) {
  const config = ConfigSchema.parse({
    agent: { maxRetries: 0, maxIterations: 8, maxTokens: 1_400 },
    optimizer: { enabled: true, minResponseTokens: 1_024, ...overrides },
  });

  const agent = new Agent({
    provider: createProvider({
      config: {
        id: 'r',
        label: 'Reasoner',
        kind: 'openai-compatible',
        baseURL: server!.baseURL,
        model: 'reasoner',
        models: ['reasoner'],
        headers: {},
        supportsTools: true,
        supportsVision: false,
        contextWindow: 128_000,
      },
      apiKey: 'sk-test-key-1234567890',
      model: 'reasoner',
    }),
    model: 'reasoner',
    config,
    sandbox: new Sandbox({ root: workspace }),
    permissions: new PermissionManager({ policy: config.permissions }),
    registry: buildToolRegistry({}),
    planner: new Planner(),
    workspace: await detectWorkspace(workspace),
    sessions: new SessionManager(),
    providerLabel: 'Reasoner',
  });
  await agent.initialize();

  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, events };
}

describe('a request starved by its own output budget', () => {
  it('widens and retries instead of returning an empty turn', async () => {
    // Needs more than the 1.4k it will first be granted.
    server = await startThinkingProvider(2_500);
    const { agent, events } = await makeAgent();

    const result = await agent.send('do the thing');

    expect(result.reason).toBe('complete');
    // It got an actual answer rather than handing back nothing.
    expect(agent.context.messages().some((m) => String(m.content).includes('Here is the answer'))).toBe(
      true,
    );
    // The second request asked for materially more than the first.
    expect(server.budgets.length).toBe(2);
    expect(server.budgets[1]!).toBeGreaterThan(server.budgets[0]!);

    const notice = events.find(
      (event) => event.type === 'notice' && event.message.includes('Retrying'),
    );
    expect(notice).toBeDefined();
  });

  it('gives up after the configured number of attempts', async () => {
    // Never satisfiable, so every attempt truncates.
    server = await startThinkingProvider(10_000_000);
    const { agent, events } = await makeAgent({ maxOutputLimitRetries: 2 });

    const result = await agent.send('do the thing');

    expect(result.reason).toBe('complete');
    // One initial attempt plus two retries, then it stops and says so.
    expect(server.budgets.length).toBe(3);
    expect(
      events.some((event) => event.type === 'notice' && event.message.includes('may be incomplete')),
    ).toBe(true);
  });

  it('does not retry when the setting is off', async () => {
    server = await startThinkingProvider(10_000_000);
    const { agent } = await makeAgent({ retryOnOutputLimit: false });

    await agent.send('do the thing');

    expect(server.budgets.length).toBe(1);
  });

  // A reply cut off mid-sentence still has content worth keeping; re-asking
  // would throw away work and bill for it twice.
  it('keeps a truncated reply that actually said something', async () => {
    server = await startThinkingProvider(0); // always answers
    const { agent } = await makeAgent();

    await agent.send('do the thing');

    expect(server.budgets.length).toBe(1);
  });
});
