import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import {
  FREE,
  describePrice,
  fetchCataloguePricing,
  isLocalProvider,
  matchCatalogueModel,
  mergePricing,
} from '../src/context/pricing.js';
import { UsageTracker } from '../src/context/usage.js';
import type { PricingEntry } from '../src/config/schema.js';

/** A catalogue endpoint shaped like OpenRouter's `/models`. */
async function startCatalogue(data: unknown[]): Promise<{ baseURL: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let api: { baseURL: string; close(): Promise<void> } | undefined;

afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe('reading published prices', () => {
  it('converts per-token decimal strings to per-million rates', async () => {
    api = await startCatalogue([
      { id: 'deepseek/deepseek-chat', pricing: { prompt: '0.00000027', completion: '0.0000011' } },
      { id: 'openai/gpt-5', pricing: { prompt: '0.00000125', completion: '0.00001' } },
    ]);

    const prices = await fetchCataloguePricing({
      baseURL: api.baseURL,
      providerName: 'Catalogue',
    });

    // 0.00000027 $/token is $0.27 per million, the unit vendors quote.
    expect(prices.get('deepseek/deepseek-chat')?.inputPerMillion).toBeCloseTo(0.27, 6);
    expect(prices.get('deepseek/deepseek-chat')?.outputPerMillion).toBeCloseTo(1.1, 6);
    expect(prices.get('openai/gpt-5')?.outputPerMillion).toBeCloseTo(10, 6);
  });

  // Zero is a real rate for a free model, not a missing one.
  it('keeps a genuine zero rate', async () => {
    api = await startCatalogue([{ id: 'meta/free', pricing: { prompt: '0', completion: '0' } }]);
    const prices = await fetchCataloguePricing({ baseURL: api.baseURL, providerName: 'C' });
    expect(prices.get('meta/free')).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
      currency: 'USD',
    });
  });

  it('skips entries with no usable price rather than inventing one', async () => {
    api = await startCatalogue([
      { id: 'a/no-pricing' },
      { id: 'b/null-pricing', pricing: null },
      { id: 'c/bad', pricing: { prompt: 'free', completion: '0.001' } },
      { id: 'd/negative', pricing: { prompt: '-1', completion: '1' } },
      { id: 'e/no-id-below', pricing: { prompt: '0.001', completion: '0.002' } },
      { pricing: { prompt: '0.001', completion: '0.002' } },
    ]);

    const prices = await fetchCataloguePricing({ baseURL: api.baseURL, providerName: 'C' });
    expect([...prices.keys()]).toEqual(['e/no-id-below']);
  });

  it('reports a provider with no catalogue at all', async () => {
    await expect(
      fetchCataloguePricing({ baseURL: 'http://127.0.0.1:1/v1', providerName: 'Nobody' }),
    ).rejects.toThrow();
  });
});

describe('matching a configured model to a catalogue', () => {
  const catalogue = new Map<string, PricingEntry>([
    ['deepseek/deepseek-chat', { inputPerMillion: 0.27, outputPerMillion: 1.1, currency: 'USD' }],
    ['vendor-a/shared', { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' }],
    ['vendor-b/shared', { inputPerMillion: 9, outputPerMillion: 10, currency: 'USD' }],
    ['exact-name', { inputPerMillion: 5, outputPerMillion: 6, currency: 'USD' }],
  ]);

  it('prefers an exact id', () => {
    expect(matchCatalogueModel('exact-name', catalogue)?.id).toBe('exact-name');
  });

  it('matches a namespaced id by its unique suffix', () => {
    const match = matchCatalogueModel('deepseek-chat', catalogue);
    expect(match?.id).toBe('deepseek/deepseek-chat');
    expect(match?.entry.inputPerMillion).toBe(0.27);
  });

  // Two vendors list the same model at different prices. Picking one would put
  // a number in front of the user that might be off by 10x.
  it('refuses an ambiguous match', () => {
    expect(matchCatalogueModel('shared', catalogue)).toBeUndefined();
  });

  it('returns nothing for a model the catalogue does not have', () => {
    expect(matchCatalogueModel('never-heard-of-it', catalogue)).toBeUndefined();
  });
});

describe('local endpoints', () => {
  it('recognises the addresses that mean "this machine"', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8000/v1',
      'https://localhost/v1',
      'http://0.0.0.0:5000',
    ]) {
      expect(isLocalProvider(url), url).toBe(true);
    }
  });

  it('does not mistake a remote host for a local one', () => {
    for (const url of [
      'https://api.deepseek.com/v1',
      'https://openrouter.ai/api/v1',
      'https://localhost.evil.example.com/v1',
      'https://my-localhost-proxy.example.com/v1',
    ]) {
      expect(isLocalProvider(url), url).toBe(false);
    }
  });
});

describe('presenting and storing rates', () => {
  it('describes a rate the way vendors quote it', () => {
    expect(describePrice({ inputPerMillion: 0.27, outputPerMillion: 1.1, currency: 'USD' })).toContain(
      '0.270 in',
    );
    expect(describePrice(FREE)).toBe('free');
  });

  it('overwrites an existing rate and leaves the others alone', () => {
    const merged = mergePricing(
      {
        'A:one': { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' },
        'A:two': { inputPerMillion: 2, outputPerMillion: 2, currency: 'USD' },
      },
      [
        {
          key: 'A:one',
          model: 'one',
          entry: { inputPerMillion: 5, outputPerMillion: 6, currency: 'USD' },
          authority: 'provider',
        },
      ],
    );
    expect(merged['A:one']?.inputPerMillion).toBe(5);
    expect(merged['A:two']?.inputPerMillion).toBe(2);
  });
});

describe('costing real usage', () => {
  it('bills thinking tokens as output, because that is how providers bill them', () => {
    const tracker = new UsageTracker();
    tracker.record({
      at: new Date().toISOString(),
      model: 'reasoner',
      provider: 'Test',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      reasoningTokens: 800_000,
    });

    const cost = tracker.estimateCost(
      { 'Test:reasoner': { inputPerMillion: 1, outputPerMillion: 10, currency: 'USD' } },
      'session',
    );

    // 1M in at $1 plus 1M out at $10 — the 800k of thinking is inside that
    // output figure, not billed twice on top of it.
    expect(cost.input).toBeCloseTo(1, 6);
    expect(cost.output).toBeCloseTo(10, 6);

    const totals = tracker.sessionTotals();
    expect(totals.reasoningTokens).toBe(800_000);
    expect(totals.completionTokens).toBe(1_000_000);
  });

  it('says which models it could not price rather than guessing', () => {
    const tracker = new UsageTracker();
    tracker.record({
      at: new Date().toISOString(),
      model: 'unpriced',
      provider: 'Test',
      promptTokens: 100,
      completionTokens: 100,
    });

    const cost = tracker.estimateCost({}, 'session');
    expect(cost.input).toBe(0);
    expect(cost.unpriced ?? []).toContain('Test:unpriced');
  });
});
