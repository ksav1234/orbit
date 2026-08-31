import fs from 'node:fs/promises';
import path from 'node:path';
import type { AIProvider } from '../providers/provider.js';
import { guessContextWindow } from '../providers/provider.js';
import { createLogger } from '../util/logger.js';
import { orbitPaths } from '../util/paths.js';

const log = createLogger('context:window');

/**
 * Where a context window number came from, in descending order of authority.
 *
 * - `explicit` — the user ran `orbit model context <n>`. Never overridden.
 * - `reported` — the provider's own models endpoint stated it.
 * - `probed`   — the provider stated it in an error, when asked for an
 *                impossible completion length.
 * - `preset`   — the built-in preset for this provider.
 * - `name`     — inferred from the model name. A guess, and labelled as one.
 */
export type WindowSource = 'explicit' | 'reported' | 'probed' | 'preset' | 'name';

export interface WindowResolution {
  tokens: number;
  source: WindowSource;
}

/** Human wording for a source, for the status line and `orbit model context`. */
export function describeWindowSource(source: WindowSource, providerLabel: string): string {
  switch (source) {
    case 'explicit':
      return 'set by you';
    case 'reported':
      return `reported by ${providerLabel}`;
    case 'probed':
      return `detected from ${providerLabel}`;
    case 'preset':
      return 'from the built-in preset';
    case 'name':
      return 'inferred from the model name';
  }
}

// ── Parsing a limit out of a provider error ────────────────────────────────

/**
 * Extract a context length from a provider's error text.
 *
 * OpenAI-compatible servers reject an impossible completion length with a
 * message that names the real limit — "This model's maximum context length is
 * 65536 tokens, however you requested ...". That is the provider stating its
 * own number, which beats any table Orbit could ship.
 *
 * Only phrasings that clearly mean *context* are matched. A `max_tokens` or
 * "maximum completion tokens" figure is the output cap, not the window, and
 * treating one as the other would badly under-budget the conversation.
 */
export function parseWindowFromError(text: string): number | undefined {
  if (!text) return undefined;

  const patterns: RegExp[] = [
    // OpenAI, DeepSeek, Together, Fireworks, most proxies.
    /maximum context length is\s+(\d[\d,_ ]*)/i,
    // vLLM: "This model's maximum context length is X" or "max seq len is X".
    /max(?:imum)?[ _-]?(?:seq(?:uence)?)[ _-]?len(?:gth)?[^\d]{0,24}(\d[\d,_ ]*)/i,
    // llama.cpp / TGI: "the model's context window of 8192 tokens".
    /context (?:window|length|size) (?:of|is)\s+(\d[\d,_ ]*)/i,
    // Azure OpenAI phrasing.
    /model supports (?:at most|up to)\s+(\d[\d,_ ]*)\s+(?:total\s+)?(?:context|prompt)?\s*tokens/i,
    // Generic: "context_length_exceeded ... limit 128000".
    /context[ _-]?length[^\d]{0,24}(\d[\d,_ ]*)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (!raw) continue;
    const tokens = Number.parseInt(raw.replace(/[,_ ]/g, ''), 10);
    if (isPlausibleWindow(tokens)) return tokens;
  }
  return undefined;
}

/**
 * Reject nonsense before it becomes a budget. The upper bound is generous
 * rather than principled — it only needs to catch a parsed byte count or
 * timestamp, not to predict how large windows will get.
 */
export function isPlausibleWindow(tokens: number): boolean {
  return Number.isInteger(tokens) && tokens >= 1024 && tokens <= 50_000_000;
}

// ── Stepping up and down ──────────────────────────────────────────────────

/**
 * The window sizes worth stepping through. These are the figures real models
 * actually ship with, so stepping lands on a plausible number rather than an
 * arbitrary multiple.
 */
export const WINDOW_LADDER: readonly number[] = [
  4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 200_000, 262_144, 400_000,
  524_288, 1_000_000, 2_000_000, 10_000_000,
];

/**
 * The next rung up or down from `current`.
 *
 * A window that is not on the ladder — a self-hosted build at 48k, say —
 * snaps to the next rung in the requested direction rather than being rounded
 * first, so a single step never moves the value the wrong way. Past either end
 * it doubles or halves, which keeps the control usable on hardware nobody has
 * shipped yet.
 */
export function stepWindow(current: number, direction: 'up' | 'down'): number {
  if (direction === 'up') {
    const next = WINDOW_LADDER.find((rung) => rung > current);
    return clampWindow(next ?? current * 2);
  }
  const lower = [...WINDOW_LADDER].reverse().find((rung) => rung < current);
  return clampWindow(lower ?? Math.floor(current / 2));
}

/** Hold a window inside the range Orbit is willing to budget against. */
export function clampWindow(tokens: number): number {
  return Math.max(1024, Math.min(50_000_000, Math.floor(tokens)));
}

/**
 * Interpret a context-window argument: an absolute count, a relative nudge, or
 * a step along the ladder. Returns `undefined` when the text is not one of
 * those, so callers can show usage instead of acting on a misreading.
 *
 *   1000000   128k   1m      absolute
 *   +50000    -32k           relative to what is in force
 *   up        down           one rung along the ladder
 */
export function parseWindowArgument(text: string, current: number): number | undefined {
  const input = text.trim().toLowerCase();
  if (!input) return undefined;

  if (input === 'up' || input === '+' || input === 'more') return stepWindow(current, 'up');
  if (input === 'down' || input === '-' || input === 'less') return stepWindow(current, 'down');

  const match = /^([+-]?)([\d,_ ]+)([km])?$/.exec(input);
  if (!match) return undefined;
  const [, sign, digits, unit] = match;

  const base = Number.parseInt((digits ?? '').replace(/[,_ ]/g, ''), 10);
  if (!Number.isFinite(base)) return undefined;

  const scale = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
  const amount = base * scale;
  if (amount <= 0) return undefined;

  const next = sign === '+' ? current + amount : sign === '-' ? current - amount : amount;
  // Deliberately not clamped. `-500k` against a 128k window means the user
  // misjudged the size; silently landing on the 1024-token floor would be a
  // useless window that looks like it was asked for. Stepping clamps, because
  // "one more rung" past the end really does mean "as far as it goes".
  return isPlausibleWindow(next) ? next : undefined;
}

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** Absent means "asked, and the provider would not say". */
  tokens?: number;
  source?: Exclude<WindowSource, 'explicit' | 'preset' | 'name'>;
  checkedAt: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/** A positive result is stable; re-checking monthly is enough. */
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A negative result might just mean the network was down. Retry sooner. */
const MISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const cacheKey = (providerId: string, model: string): string => `${providerId}:${model}`;

/**
 * Remembers what each provider said about each model, so detection costs one
 * request per model rather than one per launch. Lives beside the other caches
 * under `~/.orbit/cache`; deleting it is always safe.
 */
export class WindowCache {
  private entries: Record<string, CacheEntry>;
  private dirty = false;

  private constructor(
    private readonly file: string,
    entries: Record<string, CacheEntry>,
  ) {
    this.entries = entries;
  }

  static async load(file = path.join(orbitPaths.cache, 'context-windows.json')): Promise<WindowCache> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return new WindowCache(file, parsed.entries);
      }
    } catch {
      // Missing or corrupt: start empty rather than fail a launch over a cache.
    }
    return new WindowCache(file, {});
  }

  /** An in-memory cache for tests and sub-agents, backed by nothing. */
  static ephemeral(): WindowCache {
    return new WindowCache('', {});
  }

  get(providerId: string, model: string): WindowResolution | undefined {
    const entry = this.entries[cacheKey(providerId, model)];
    if (!entry?.tokens || !entry.source) return undefined;
    if (this.age(entry) > HIT_TTL_MS) return undefined;
    return { tokens: entry.tokens, source: entry.source };
  }

  /** True when detection already ran recently and came back empty-handed. */
  isKnownUnavailable(providerId: string, model: string): boolean {
    const entry = this.entries[cacheKey(providerId, model)];
    if (!entry || entry.tokens !== undefined) return false;
    return this.age(entry) <= MISS_TTL_MS;
  }

  record(providerId: string, model: string, resolution: WindowResolution): void {
    if (resolution.source === 'explicit' || resolution.source === 'preset' || resolution.source === 'name') {
      return; // Only detected values are worth caching.
    }
    this.entries[cacheKey(providerId, model)] = {
      tokens: resolution.tokens,
      source: resolution.source,
      checkedAt: new Date().toISOString(),
    };
    this.dirty = true;
  }

  recordUnavailable(providerId: string, model: string): void {
    this.entries[cacheKey(providerId, model)] = { checkedAt: new Date().toISOString() };
    this.dirty = true;
  }

  /** Drop what is known about a model so the next launch asks again. */
  forget(providerId: string, model?: string): void {
    const prefix = `${providerId}:`;
    for (const key of Object.keys(this.entries)) {
      if (model ? key === cacheKey(providerId, model) : key.startsWith(prefix)) {
        delete this.entries[key];
        this.dirty = true;
      }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.file) return;
    const payload: CacheFile = { version: 1, entries: this.entries };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      this.dirty = false;
    } catch (error) {
      log.warn('could not save window cache', { error: String(error) });
    }
  }

  private age(entry: CacheEntry): number {
    const at = Date.parse(entry.checkedAt);
    return Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY;
  }
}

// ── Resolution ────────────────────────────────────────────────────────────

export interface ResolveOptions {
  providerId: string;
  model: string;
  /** `providers[id].contextWindow` — set only by `orbit model context <n>`. */
  explicit?: number | undefined;
  /** The built-in preset's window for this provider, if it has one. */
  preset?: number | undefined;
  cache?: WindowCache | undefined;
}

/**
 * The window to use right now, without touching the network. Called on every
 * launch and every model switch, so it must stay synchronous and cheap.
 */
export function resolveWindow(options: ResolveOptions): WindowResolution {
  if (options.explicit && isPlausibleWindow(options.explicit)) {
    return { tokens: options.explicit, source: 'explicit' };
  }

  const cached = options.cache?.get(options.providerId, options.model);
  if (cached) return cached;

  const guess = guessContextWindow(options.model);
  // A preset only wins when the model name told us nothing specific, so a
  // preset written for one generation cannot cap a later, roomier model.
  if (options.preset && isPlausibleWindow(options.preset) && options.preset > guess) {
    return { tokens: options.preset, source: 'preset' };
  }
  return { tokens: guess, source: 'name' };
}

export interface DetectOptions {
  provider: AIProvider;
  providerId: string;
  model: string;
  cache: WindowCache;
  /** Allow the one-request error probe when the models endpoint is silent. */
  allowProbe: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * Ask the provider what the model's window actually is.
 *
 * Runs in the background at startup: a wrong budget degrades quality, but a
 * slow launch is felt immediately, so nothing here is allowed to block. Every
 * failure path resolves to `undefined` and leaves the synchronous resolution
 * in place.
 */
export async function detectWindow(options: DetectOptions): Promise<WindowResolution | undefined> {
  const { provider, providerId, model, cache } = options;

  const cached = cache.get(providerId, model);
  if (cached) return cached;
  if (cache.isKnownUnavailable(providerId, model)) return undefined;

  // 1. The models endpoint, which costs nothing and is authoritative when
  //    present (OpenRouter's `context_length`, Gemini's `inputTokenLimit`).
  try {
    const models = await provider.listModels?.(options.signal);
    const match = models?.find((entry) => entry.id === model);
    if (match?.contextWindow && isPlausibleWindow(match.contextWindow)) {
      const resolution: WindowResolution = { tokens: match.contextWindow, source: 'reported' };
      cache.record(providerId, model, resolution);
      return resolution;
    }
  } catch (error) {
    log.debug('models endpoint did not answer', { error: String(error) });
  }

  // 2. Make the provider name its own limit. One request that is rejected
  //    before any tokens are generated.
  if (options.allowProbe && provider.probeContextWindow) {
    try {
      const probed = await provider.probeContextWindow(model, options.signal);
      if (probed && isPlausibleWindow(probed)) {
        const resolution: WindowResolution = { tokens: probed, source: 'probed' };
        cache.record(providerId, model, resolution);
        return resolution;
      }
    } catch (error) {
      log.debug('probe did not answer', { error: String(error) });
    }
  }

  cache.recordUnavailable(providerId, model);
  return undefined;
}
