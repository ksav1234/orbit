import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../src/config/manager.js';
import { createProvider } from '../src/providers/factory.js';
import { ContextManager } from '../src/context/manager.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

let home = '';

beforeEach(async () => {
  home = await makeTempWorkspace('orbit-switch-');
  process.env.ORBIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(home);
});

async function seed(): Promise<ConfigManager> {
  const config = new ConfigManager();
  await config.load();
  await config.addProvider(
    {
      id: 'alpha',
      label: 'Alpha',
      kind: 'openai-compatible',
      baseURL: 'https://alpha.example.com/v1',
      model: 'alpha-small',
      models: ['alpha-small', 'alpha-large'],
      headers: {},
    },
    'sk-alpha-key-1234567890',
  );
  await config.addProvider(
    {
      id: 'beta',
      label: 'Beta',
      kind: 'openai-compatible',
      baseURL: 'https://beta.example.com/v1',
      model: 'beta-one',
      models: ['beta-one'],
      headers: {},
    },
    'sk-beta-key-1234567890',
  );
  return config;
}

describe('changing the model', () => {
  it('persists across restarts', async () => {
    const config = await seed();
    await config.useModel('alpha-large');

    const reloaded = new ConfigManager();
    await reloaded.load();
    expect(reloaded.activeProvider()?.model).toBe('alpha-large');
  });

  it('remembers a model the provider never listed', async () => {
    const config = await seed();
    await config.useModel('some-preview-model');

    const provider = config.getProvider('alpha')!;
    expect(provider.model).toBe('some-preview-model');
    // It joins the list so it is offered next time.
    expect(provider.models).toContain('some-preview-model');
  });

  it('does not duplicate a model already in the list', async () => {
    const config = await seed();
    await config.useModel('alpha-large');
    await config.useModel('alpha-large');

    const models = config.getProvider('alpha')!.models;
    expect(models.filter((m) => m === 'alpha-large')).toHaveLength(1);
  });

  it('sets the model on a named provider without switching to it', async () => {
    const config = await seed();
    await config.useProvider('alpha');
    await config.useModel('beta-two', 'beta');

    expect(config.get().activeProvider).toBe('alpha');
    expect(config.getProvider('beta')?.model).toBe('beta-two');
  });
});

describe('changing the provider', () => {
  it('switches the active provider and keeps its own model', async () => {
    const config = await seed();
    await config.useProvider('beta');

    expect(config.activeProvider()?.id).toBe('beta');
    expect(config.activeProvider()?.model).toBe('beta-one');
  });

  it('refuses an unknown provider with a usable message', async () => {
    const config = await seed();
    await expect(config.useProvider('nope')).rejects.toMatchObject({ kind: 'config' });
  });

  it('picks a remaining provider when the active one is removed', async () => {
    const config = await seed();
    await config.useProvider('beta');
    await config.removeProvider('beta');

    expect(config.get().activeProvider).toBe('alpha');
    expect(config.apiKey('beta')).toBeUndefined();
  });

  it('keeps each provider key separate', async () => {
    const config = await seed();
    expect(config.apiKey('alpha')).toBe('sk-alpha-key-1234567890');
    expect(config.apiKey('beta')).toBe('sk-beta-key-1234567890');

    await config.setApiKey('alpha', 'sk-alpha-rotated-0987654321');
    expect(config.apiKey('alpha')).toBe('sk-alpha-rotated-0987654321');
    expect(config.apiKey('beta')).toBe('sk-beta-key-1234567890');
  });
});

describe('context window on switch', () => {
  it('follows the model, in both directions', () => {
    const context = new ContextManager({ contextWindow: 1_000_000, responseReserve: 16_000 });
    expect(context.getContextWindow()).toBe(1_000_000);

    // Down to a small model…
    context.setContextWindow(32_000);
    expect(context.getContextWindow()).toBe(32_000);
    const smallBudget = context.budget([]);
    expect(smallBudget.breakdown.reserve).toBeLessThanOrEqual(8_000);

    // …and back up. The reserve must recover, or long replies get squeezed
    // on a model that has plenty of room.
    context.setContextWindow(1_000_000);
    const largeBudget = context.budget([]);
    expect(largeBudget.window).toBe(1_000_000);
    expect(largeBudget.breakdown.reserve).toBeGreaterThan(smallBudget.breakdown.reserve);
  });
});

describe('creating a provider instance', () => {
  it('reports a missing key as an auth problem, not a network one', async () => {
    const config = await seed();
    await config.deleteApiKey('alpha');

    expect(() =>
      createProvider({ config: config.getProvider('alpha')!, apiKey: undefined }),
    ).toThrowError(expect.objectContaining({ kind: 'auth' }));
  });

  it('needs no key for a local endpoint', async () => {
    const config = await seed();
    await config.addProvider({
      id: 'local',
      label: 'Local',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      model: 'llama3',
      models: ['llama3'],
      headers: {},
    });

    const provider = createProvider({ config: config.getProvider('local')!, apiKey: undefined });
    expect(provider.model).toBe('llama3');
  });

  it('reports a missing model clearly', async () => {
    const config = await seed();
    await config.update((draft) => {
      delete draft.providers.alpha!.model;
    });

    expect(() =>
      createProvider({ config: config.getProvider('alpha')!, apiKey: 'sk-x-1234567890' }),
    ).toThrowError(/No model selected/);
  });
});
