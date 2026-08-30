import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './compatible.js';

export type OpenRouterProviderOptions = Omit<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'> &
  Partial<Pick<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'>>;

/** OpenRouter asks clients to identify themselves via referer/title headers. */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(options: OpenRouterProviderOptions) {
    super({
      id: options.id ?? 'openrouter',
      name: options.name ?? 'OpenRouter',
      baseURL: options.baseURL ?? 'https://openrouter.ai/api/v1',
      ...options,
      headers: {
        'HTTP-Referer': 'https://github.com/orbit-cli',
        'X-Title': 'Orbit',
        ...options.headers,
      },
    });
  }
}
