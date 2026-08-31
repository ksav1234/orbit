import type { PricingConfig, PricingEntry } from '../config/schema.js';
import { requestJSON } from '../providers/http.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('pricing');

/** A rate Orbit found, and where it came from. */
export interface DiscoveredPrice {
  /** The `Provider:model` key `/usage` aggregates by. */
  key: string;
  model: string;
  entry: PricingEntry;
  /**
   * Whether this is the rate the configured provider itself charges, or a rate
   * for the same model taken from a catalogue that happens to list it. The two
   * are not the same number, and the difference has to reach the user.
   */
  authority: 'provider' | 'catalogue';
}

/**
 * A model's price as listed by an OpenRouter-style catalogue.
 *
 * Prices arrive as decimal strings in dollars per token — `"0.0000015"` — which
 * loses nothing to floating point until it is multiplied out. Orbit stores rates
 * per million tokens, the unit every vendor quotes in.
 */
interface CatalogueEntry {
  id?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
}

const PER_MILLION = 1_000_000;

function perMillion(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed * PER_MILLION;
}

/**
 * Read every priced model out of an OpenRouter-compatible `/models` response.
 *
 * OpenRouter is the only provider Orbit talks to that publishes machine-readable
 * prices, which is why this is the one place rates can be filled in without the
 * user typing them. Everyone else is asked for a number.
 */
export async function fetchCataloguePricing(options: {
  baseURL: string;
  apiKey?: string | undefined;
  providerName: string;
  signal?: AbortSignal | undefined;
}): Promise<Map<string, PricingEntry>> {
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const payload = await requestJSON<{ data?: CatalogueEntry[] }>({
    url: `${options.baseURL.replace(/\/+$/, '')}/models`,
    method: 'GET',
    headers,
    providerName: options.providerName,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const prices = new Map<string, PricingEntry>();
  for (const entry of payload.data ?? []) {
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (!id || !entry.pricing) continue;

    const inputPerMillion = perMillion(entry.pricing.prompt);
    const outputPerMillion = perMillion(entry.pricing.completion);
    if (inputPerMillion === undefined || outputPerMillion === undefined) continue;
    // A catalogue lists free models at 0/0. That is a real rate, not a gap.
    prices.set(id, { inputPerMillion, outputPerMillion, currency: 'USD' });
  }

  log.debug('catalogue pricing read', { models: prices.size });
  return prices;
}

/**
 * Match a configured model against a catalogue.
 *
 * Catalogue ids are namespaced (`deepseek/deepseek-chat`) while a provider's own
 * id usually is not (`deepseek-chat`), so an exact match is tried first and a
 * unique suffix match second. A model matching several catalogue entries is left
 * alone: guessing which vendor's variant was meant would put a wrong number in
 * front of the user, which is the thing to avoid.
 */
export function matchCatalogueModel(
  model: string,
  catalogue: Map<string, PricingEntry>,
): { id: string; entry: PricingEntry } | undefined {
  const exact = catalogue.get(model);
  if (exact) return { id: model, entry: exact };

  const needle = model.toLowerCase();
  const candidates = [...catalogue.entries()].filter(([id]) => {
    const lower = id.toLowerCase();
    return lower === needle || lower.endsWith(`/${needle}`);
  });

  if (candidates.length !== 1) return undefined;
  const [id, entry] = candidates[0]!;
  return { id, entry };
}

/** Local models cost nothing to run, and that is a fact rather than a guess. */
export function isLocalProvider(baseURL: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(baseURL);
}

export const FREE: PricingEntry = { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' };

/** Format a rate the way vendors quote it, for confirmation before saving. */
export function describePrice(entry: PricingEntry): string {
  const money = (value: number): string =>
    value === 0 ? 'free' : `${value.toFixed(value < 1 ? 3 : 2)}`;
  if (entry.inputPerMillion === 0 && entry.outputPerMillion === 0) return 'free';
  return `${money(entry.inputPerMillion)} in / ${money(entry.outputPerMillion)} out per 1M ${entry.currency}`;
}

/** Rates already stored, newest wins, keyed as `/usage` aggregates. */
export function mergePricing(
  existing: PricingConfig,
  discovered: DiscoveredPrice[],
): PricingConfig {
  const merged: PricingConfig = { ...existing };
  for (const price of discovered) merged[price.key] = price.entry;
  return merged;
}
