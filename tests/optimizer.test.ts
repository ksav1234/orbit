import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TokenOptimizer, pressureFor } from '../src/context/optimizer.js';
import { UsageTracker, usageDelta } from '../src/context/usage.js';
import { responseReserveFor } from '../src/agent/agent.js';
import { OptimizerConfigSchema, ToolsConfigSchema } from '../src/config/schema.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

const tools = ToolsConfigSchema.parse({});

function makeOptimizer(overrides = {}) {
  return new TokenOptimizer(OptimizerConfigSchema.parse(overrides), tools);
}

describe('context pressure', () => {
  it('classifies utilization into bands', () => {
    expect(pressureFor(0.1)).toBe('low');
    expect(pressureFor(0.6)).toBe('moderate');
    expect(pressureFor(0.8)).toBe('high');
    expect(pressureFor(0.95)).toBe('critical');
  });
});

describe('TokenOptimizer', () => {
  it('uses the configured ceiling before it has observed anything', () => {
    const optimizer = makeOptimizer();
    const decision = optimizer.decide({
      window: 128_000,
      used: 4_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 0,
      peakCompletion: 0,
      samples: 0,
    });

    expect(decision.responseTokens).toBe(8_192);
    expect(decision.pressure).toBe('low');
    expect(decision.compactFirst).toBe(false);
  });

  it('shrinks the reply budget once it learns replies are small', () => {
    const optimizer = makeOptimizer();
    optimizer.decide({
      window: 128_000,
      used: 4_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 0,
      peakCompletion: 0,
      samples: 0,
    });

    const decision = optimizer.decide({
      window: 128_000,
      used: 4_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 300,
      peakCompletion: 500,
      samples: 6,
    });

    expect(decision.responseTokens).toBeLessThan(8_192);
    expect(decision.responseTokens).toBeGreaterThanOrEqual(1024);
  });

  it('never asks for more room than the window has left', () => {
    const optimizer = makeOptimizer();
    const decision = optimizer.decide({
      window: 32_000,
      used: 30_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 4_000,
      peakCompletion: 6_000,
      samples: 5,
    });

    expect(decision.responseTokens).toBeLessThanOrEqual(32_000 - 30_000);
    expect(decision.pressure).toBe('critical');
  });

  it('asks for compaction when even the minimum reply will not fit', () => {
    const optimizer = makeOptimizer({ minResponseTokens: 2_000 });
    const decision = optimizer.decide({
      window: 16_000,
      used: 15_500,
      configuredMaxTokens: 8_192,
      averageCompletion: 1_000,
      peakCompletion: 1_500,
      samples: 4,
    });

    expect(decision.compactFirst).toBe(true);
  });

  it('tightens tool output limits as pressure rises', () => {
    const optimizer = makeOptimizer();

    const relaxed = optimizer.decide({
      window: 100_000,
      used: 10_000,
      configuredMaxTokens: 4_000,
      averageCompletion: 1_000,
      peakCompletion: 1_000,
      samples: 3,
    });
    const strained = optimizer.decide({
      window: 100_000,
      used: 92_000,
      configuredMaxTokens: 4_000,
      averageCompletion: 1_000,
      peakCompletion: 1_000,
      samples: 3,
    });

    expect(strained.toolOutputChars).toBeLessThan(relaxed.toolOutputChars);
    expect(strained.fileReadChars).toBeLessThan(relaxed.fileReadChars);
    expect(optimizer.toolLimits().maxOutputChars).toBe(strained.toolOutputChars);
  });

  it('leaves everything alone when disabled', () => {
    const optimizer = makeOptimizer({ enabled: false });
    const decision = optimizer.decide({
      window: 16_000,
      used: 15_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 100,
      peakCompletion: 100,
      samples: 10,
    });

    expect(decision.responseTokens).toBe(8_192);
    expect(decision.toolOutputChars).toBe(tools.maxOutputChars);
    expect(decision.compactFirst).toBe(false);
  });

  it('lets a large-context model use its room', () => {
    const optimizer = makeOptimizer();

    // Both models have replied at the same size; only the window differs.
    const observed = { averageCompletion: 20_000, peakCompletion: 30_000, samples: 6 };

    const small = optimizer.decide({
      window: 128_000,
      used: 10_000,
      configuredMaxTokens: 8_192,
      ...observed,
    });
    optimizer.reset();
    const large = optimizer.decide({
      window: 1_000_000,
      used: 10_000,
      configuredMaxTokens: 8_192,
      ...observed,
    });

    // The small window is held to the configured ceiling; the large one is not.
    expect(small.responseTokens).toBe(8_192);
    expect(large.responseTokens).toBeGreaterThan(small.responseTokens);
    expect(large.toolOutputChars).toBeGreaterThan(small.toolOutputChars);
    expect(optimizer.isLargeWindow(1_000_000)).toBe(true);
    expect(optimizer.isLargeWindow(128_000)).toBe(false);
  });

  it('keeps a large window from swallowing a whole repository in one result', () => {
    const optimizer = makeOptimizer();
    const decision = optimizer.decide({
      window: 10_000_000,
      used: 1_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 1_000,
      peakCompletion: 1_000,
      samples: 4,
    });

    // Scaling is capped at 4x the 128k baseline.
    expect(decision.toolOutputChars).toBeLessThanOrEqual(tools.maxOutputChars * 4);
    expect(decision.responseTokens).toBeLessThanOrEqual(65_536);
  });

  it('does not scale with the window when told not to', () => {
    const optimizer = makeOptimizer({ scaleWithWindow: false });
    const decision = optimizer.decide({
      window: 1_000_000,
      used: 10_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 20_000,
      peakCompletion: 30_000,
      samples: 6,
    });

    expect(decision.responseTokens).toBe(8_192);
    expect(decision.toolOutputChars).toBe(tools.maxOutputChars);
  });

  it('still respects the window under pressure, however large it is', () => {
    const optimizer = makeOptimizer();
    const decision = optimizer.decide({
      window: 1_000_000,
      used: 990_000,
      configuredMaxTokens: 8_192,
      averageCompletion: 20_000,
      peakCompletion: 30_000,
      samples: 6,
    });

    expect(decision.pressure).toBe('critical');
    expect(decision.responseTokens).toBeLessThanOrEqual(10_000);
  });

  it('reports a change only when it is material', () => {
    const optimizer = makeOptimizer();
    const input = {
      window: 100_000,
      used: 10_000,
      configuredMaxTokens: 8_000,
      averageCompletion: 2_000,
      peakCompletion: 3_000,
      samples: 5,
    };

    expect(optimizer.decide(input).changed).toBe(false); // baseline
    expect(optimizer.decide(input).changed).toBe(false); // unchanged

    const shifted = optimizer.decide({ ...input, used: 88_000 });
    expect(shifted.changed).toBe(true);
    expect(shifted.reason).toMatch(/context \d+%/);
  });
});

describe('UsageTracker', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTempWorkspace('orbit-usage-');
    process.env.ORBIT_HOME = home;
  });

  afterEach(async () => {
    delete process.env.ORBIT_HOME;
    await removeTempWorkspace(home);
  });

  it('accumulates session totals across requests', () => {
    const tracker = new UsageTracker();
    tracker.record({
      at: new Date().toISOString(),
      model: 'm',
      provider: 'p',
      promptTokens: 100,
      completionTokens: 20,
    });
    tracker.record({
      at: new Date().toISOString(),
      model: 'm',
      provider: 'p',
      promptTokens: 150,
      completionTokens: 40,
    });

    const totals = tracker.sessionTotals();
    expect(totals.promptTokens).toBe(250);
    expect(totals.completionTokens).toBe(60);
    expect(totals.totalTokens).toBe(310);
    expect(totals.requests).toBe(2);
  });

  it('reports average and peak completion sizes', () => {
    const tracker = new UsageTracker();
    for (const completion of [100, 900, 200]) {
      tracker.record({
        at: new Date().toISOString(),
        model: 'm',
        provider: 'p',
        promptTokens: 10,
        completionTokens: completion,
      });
    }
    expect(tracker.averageCompletion()).toBe(400);
    expect(tracker.peakCompletion()).toBe(900);
  });

  it('persists lifetime totals per model', async () => {
    const tracker = new UsageTracker();
    await tracker.load();
    tracker.record({
      at: new Date().toISOString(),
      model: 'gpt-5',
      provider: 'OpenAI',
      promptTokens: 500,
      completionTokens: 250,
    });
    await tracker.save();

    const reloaded = new UsageTracker();
    await reloaded.load();
    const lifetime = reloaded.lifetimeTotals();

    expect(lifetime.promptTokens).toBe(500);
    expect(lifetime.completionTokens).toBe(250);
    expect(reloaded.byModel()[0]?.key).toBe('OpenAI:gpt-5');
  });

  it('clears statistics on reset', async () => {
    const tracker = new UsageTracker();
    await tracker.load();
    tracker.record({
      at: new Date().toISOString(),
      model: 'm',
      provider: 'p',
      promptTokens: 10,
      completionTokens: 10,
    });
    await tracker.reset();

    expect(tracker.lifetimeTotals().requests).toBe(0);
    expect(tracker.sessionTotals().requests).toBe(0);
  });

  it('computes a delta between cumulative readings', () => {
    const delta = usageDelta(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      { promptTokens: 180, completionTokens: 70, totalTokens: 250 },
    );
    expect(delta).toEqual({ promptTokens: 80, completionTokens: 20, totalTokens: 100 });
  });

  it('never returns a negative delta', () => {
    const delta = usageDelta(
      { promptTokens: 500, completionTokens: 100, totalTokens: 600 },
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    );
    expect(delta.promptTokens).toBe(0);
    expect(delta.completionTokens).toBe(0);
  });
});

describe('response reserve', () => {
  it('never holds back more than a quarter of a small window', () => {
    // A flat 16k reserve would swallow half of a 32k window.
    expect(responseReserveFor(32_768, 8_192)).toBe(8_192);
    expect(responseReserveFor(32_768, 8_192) / 32_768).toBeLessThanOrEqual(0.25);
  });

  it('uses the full reserve when the window can afford it', () => {
    expect(responseReserveFor(200_000, 8_192)).toBe(16_000);
    expect(responseReserveFor(1_000_000, 8_192)).toBe(16_000);
  });

  it('keeps a usable floor on a tiny window', () => {
    expect(responseReserveFor(4_000, 8_192)).toBe(1_024);
  });

  it('respects a smaller configured reply size', () => {
    expect(responseReserveFor(200_000, 2_000)).toBe(4_000);
  });
});
