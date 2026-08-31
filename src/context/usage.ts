import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { orbitPaths, ensureOrbitHome } from '../util/paths.js';
import { writeFileAtomic } from '../config/manager.js';
import { createLogger } from '../util/logger.js';
import type { Usage } from '../providers/provider.js';
import type { PricingConfig } from '../config/schema.js';

const log = createLogger('usage');

/** One model request: what went in, what came out, and how long it took. */
export interface TurnUsage {
  at: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache, where reported. */
  cachedTokens?: number;
  /** Completion tokens spent thinking, where the provider separates them. */
  reasoningTokens?: number;
  /** Response budget the optimizer granted for this request. */
  budgetTokens?: number;
  durationMs?: number;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Part of completionTokens that the model spent thinking. */
  reasoningTokens: number;
  requests: number;
  firstUsed: string;
  lastUsed: string;
}

const ModelUsageSchema = z.object({
  promptTokens: z.number().default(0),
  completionTokens: z.number().default(0),
  cachedTokens: z.number().default(0),
  // Defaulted, so usage files written before this existed still load.
  reasoningTokens: z.number().default(0),
  requests: z.number().default(0),
  firstUsed: z.string().default(() => new Date().toISOString()),
  lastUsed: z.string().default(() => new Date().toISOString()),
});

const UsageFileSchema = z.object({
  version: z.literal(1).default(1),
  models: z.record(ModelUsageSchema).default({}),
});

export type UsageFile = z.infer<typeof UsageFileSchema>;

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from cache, included in promptTokens. */
  cachedTokens: number;
  /** Completion tokens spent thinking, included in completionTokens. */
  reasoningTokens: number;
  totalTokens: number;
  requests: number;
}

/** Money spent, for models the user has priced. */
export interface CostEstimate {
  currency: string;
  input: number;
  output: number;
  total: number;
  /** Models with no configured price, so the total is a floor not a bill. */
  unpriced: string[];
}

/**
 * Tracks token consumption for the current session and, across sessions, per
 * model in `~/.orbit/usage.json`. Counts only; never any content.
 */
export class UsageTracker {
  private file: UsageFile = { version: 1, models: {} };
  private turns: TurnUsage[] = [];
  private loaded = false;
  private dirty = false;

  get path(): string {
    return path.join(orbitPaths.root, 'usage.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = UsageFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.file = parsed.data;
    } catch {
      // A missing or unreadable usage file is not an error worth surfacing.
    }
    this.loaded = true;
  }

  /**
   * Record one model request. Providers report cumulative usage per response,
   * so callers pass the delta they observed for this request.
   */
  record(turn: TurnUsage): void {
    this.turns.push(turn);
    if (this.turns.length > 500) this.turns.shift();

    const key = `${turn.provider}:${turn.model}`;
    const now = new Date().toISOString();
    const existing = this.file.models[key];

    this.file.models[key] = {
      promptTokens: (existing?.promptTokens ?? 0) + turn.promptTokens,
      completionTokens: (existing?.completionTokens ?? 0) + turn.completionTokens,
      cachedTokens: (existing?.cachedTokens ?? 0) + (turn.cachedTokens ?? 0),
      reasoningTokens: (existing?.reasoningTokens ?? 0) + (turn.reasoningTokens ?? 0),
      requests: (existing?.requests ?? 0) + 1,
      firstUsed: existing?.firstUsed ?? now,
      lastUsed: now,
    };
    this.dirty = true;
  }

  /** Usage for this process only. */
  sessionTotals(): UsageTotals {
    return this.turns.reduce<UsageTotals>(
      (totals, turn) => ({
        promptTokens: totals.promptTokens + turn.promptTokens,
        completionTokens: totals.completionTokens + turn.completionTokens,
        cachedTokens: totals.cachedTokens + (turn.cachedTokens ?? 0),
        reasoningTokens: totals.reasoningTokens + (turn.reasoningTokens ?? 0),
        totalTokens: totals.totalTokens + turn.promptTokens + turn.completionTokens,
        requests: totals.requests + 1,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        requests: 0,
      },
    );
  }

  lifetimeTotals(): UsageTotals {
    return Object.values(this.file.models).reduce<UsageTotals>(
      (totals, model) => ({
        promptTokens: totals.promptTokens + model.promptTokens,
        completionTokens: totals.completionTokens + model.completionTokens,
        cachedTokens: totals.cachedTokens + (model.cachedTokens ?? 0),
        reasoningTokens: totals.reasoningTokens + (model.reasoningTokens ?? 0),
        totalTokens: totals.totalTokens + model.promptTokens + model.completionTokens,
        requests: totals.requests + model.requests,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        requests: 0,
      },
    );
  }

  byModel(): Array<{ key: string; usage: ModelUsage }> {
    return Object.entries(this.file.models)
      .map(([key, usage]) => ({ key, usage }))
      .sort(
        (a, b) =>
          b.usage.promptTokens + b.usage.completionTokens -
          (a.usage.promptTokens + a.usage.completionTokens),
      );
  }

  recentTurns(limit = 10): TurnUsage[] {
    return this.turns.slice(-limit);
  }

  /** Average completion size, used by the optimizer to size the next request. */
  averageCompletion(samples = 8): number {
    const recent = this.turns.slice(-samples).filter((turn) => turn.completionTokens > 0);
    if (recent.length === 0) return 0;
    return Math.round(
      recent.reduce((sum, turn) => sum + turn.completionTokens, 0) / recent.length,
    );
  }

  /** Largest recent completion, so the budget leaves room for an outlier. */
  peakCompletion(samples = 8): number {
    const recent = this.turns.slice(-samples);
    return recent.reduce((peak, turn) => Math.max(peak, turn.completionTokens), 0);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await ensureOrbitHome();
      await writeFileAtomic(this.path, JSON.stringify(this.file, null, 2) + '\n', 0o600);
      this.dirty = false;
    } catch (error) {
      log.warn('could not persist usage totals', { error: String(error) });
    }
  }

  async reset(): Promise<void> {
    this.file = { version: 1, models: {} };
    this.turns = [];
    this.dirty = true;
    await this.save();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Estimate spend from user-supplied prices. Orbit ships no rate table:
   * prices change, and a confidently wrong number is worse than none.
   * Models without a configured price are listed instead of guessed at.
   */
  estimateCost(pricing: PricingConfig, scope: 'session' | 'lifetime' = 'lifetime'): CostEstimate {
    const entries: Array<{ key: string; prompt: number; completion: number }> =
      scope === 'lifetime'
        ? this.byModel().map(({ key, usage }) => ({
            key,
            prompt: usage.promptTokens,
            completion: usage.completionTokens,
          }))
        : aggregateTurns(this.turns);

    let input = 0;
    let output = 0;
    let currency = 'USD';
    const unpriced: string[] = [];

    for (const entry of entries) {
      const price = pricing[entry.key] ?? pricing[entry.key.split(':').pop() ?? ''];
      if (!price) {
        if (entry.prompt + entry.completion > 0) unpriced.push(entry.key);
        continue;
      }
      currency = price.currency;
      input += (entry.prompt / 1_000_000) * price.inputPerMillion;
      output += (entry.completion / 1_000_000) * price.outputPerMillion;
    }

    return { currency, input, output, total: input + output, unpriced };
  }
}

function aggregateTurns(turns: TurnUsage[]): Array<{ key: string; prompt: number; completion: number }> {
  const byKey = new Map<string, { prompt: number; completion: number }>();
  for (const turn of turns) {
    const key = `${turn.provider}:${turn.model}`;
    const entry = byKey.get(key) ?? { prompt: 0, completion: 0 };
    entry.prompt += turn.promptTokens;
    entry.completion += turn.completionTokens;
    byKey.set(key, entry);
  }
  return [...byKey.entries()].map(([key, value]) => ({ key, ...value }));
}

export function formatCost(estimate: CostEstimate): string {
  if (estimate.total === 0 && estimate.unpriced.length > 0) {
    return `not priced (${estimate.unpriced.length} model${estimate.unpriced.length === 1 ? '' : 's'} without a configured rate)`;
  }
  const amount = estimate.total < 0.01 ? estimate.total.toFixed(4) : estimate.total.toFixed(2);
  const suffix = estimate.unpriced.length > 0 ? ` (+${estimate.unpriced.length} unpriced)` : '';
  return `${amount} ${estimate.currency}${suffix}`;
}

/** Delta between two cumulative usage readings, clamped at zero. */
export function usageDelta(previous: Usage | undefined, current: Usage): Usage {
  if (!previous) return current;
  const promptTokens = Math.max(0, current.promptTokens - previous.promptTokens);
  const completionTokens = Math.max(0, current.completionTokens - previous.completionTokens);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
