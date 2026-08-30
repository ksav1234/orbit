import { OrbitError } from '../util/errors.js';
import type { ProviderConfig } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { DeepSeekProvider } from './deepseek.js';
import { GeminiProvider } from './gemini.js';
import { NvidiaProvider } from './nvidia.js';
import { OpenAICompatibleProvider } from './compatible.js';
import { OpenAIProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import type { AIProvider } from './provider.js';

export interface CreateProviderOptions {
  config: ProviderConfig;
  apiKey?: string;
  /** Overrides the model recorded in config (e.g. `orbit --model ...`). */
  model?: string;
}

/** Endpoints on the loopback interface do not need credentials. */
export function isLocalEndpoint(baseURL: string): boolean {
  try {
    const { hostname } = new URL(baseURL);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

export function createProvider(options: CreateProviderOptions): AIProvider {
  const { config, apiKey } = options;
  const model = options.model ?? config.model;

  if (!model) {
    throw new OrbitError(`No model selected for provider "${config.label}".`, {
      kind: 'config',
      hints: ['Pick one with: orbit model use <model>', 'Or pass: orbit --model <model>'],
    });
  }

  if (!apiKey && !isLocalEndpoint(config.baseURL)) {
    const envHint = config.apiKeyEnv ? `Set ${config.apiKeyEnv}, or run: orbit provider add` : 'Run: orbit provider add';
    throw new OrbitError(`No API key configured for ${config.label}.`, {
      kind: 'auth',
      detail: 'Orbit needs your own key to talk to this provider.',
      hints: [envHint],
    });
  }

  const shared = {
    id: config.id,
    name: config.label,
    baseURL: config.baseURL,
    apiKey,
    model,
    headers: config.headers,
    supportsTools: config.supportsTools,
    supportsVision: config.supportsVision,
    contextWindow: config.contextWindow,
  };

  if (config.kind === 'anthropic') return new AnthropicProvider(shared);
  if (config.kind === 'gemini') return new GeminiProvider(shared);

  // OpenAI-compatible dialect: use the specialised subclass when the endpoint
  // has known quirks, otherwise the generic adapter.
  switch (config.id) {
    case 'openai':
      return new OpenAIProvider(shared);
    case 'openrouter':
      return new OpenRouterProvider(shared);
    case 'deepseek':
      return new DeepSeekProvider(shared);
    case 'nvidia':
      return new NvidiaProvider(shared);
    default:
      if (/openrouter\.ai/.test(config.baseURL)) return new OpenRouterProvider(shared);
      if (/api\.deepseek\.com/.test(config.baseURL)) return new DeepSeekProvider(shared);
      if (/api\.nvidia\.com|integrate\.api\.nvidia/.test(config.baseURL)) return new NvidiaProvider(shared);
      return new OpenAICompatibleProvider(shared);
  }
}

export * from './provider.js';
export { OpenAICompatibleProvider } from './compatible.js';
export { OpenAIProvider } from './openai.js';
export { OpenRouterProvider } from './openrouter.js';
export { DeepSeekProvider } from './deepseek.js';
export { NvidiaProvider } from './nvidia.js';
export { AnthropicProvider } from './anthropic.js';
export { GeminiProvider } from './gemini.js';
