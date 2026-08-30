import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './compatible.js';

export type OpenAIProviderOptions = Omit<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'> &
  Partial<Pick<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'>>;

/** OpenAI platform. The reference implementation of the chat-completions dialect. */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(options: OpenAIProviderOptions) {
    super({
      id: options.id ?? 'openai',
      name: options.name ?? 'OpenAI',
      baseURL: options.baseURL ?? 'https://api.openai.com/v1',
      ...options,
    });
  }
}
