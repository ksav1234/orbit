import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './compatible.js';

export type DeepSeekProviderOptions = Omit<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'> &
  Partial<Pick<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'>>;

/**
 * DeepSeek. Streams chain-of-thought in `reasoning_content`, which the
 * compatible adapter already surfaces as `reasoning` events.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: DeepSeekProviderOptions) {
    super({
      id: options.id ?? 'deepseek',
      name: options.name ?? 'DeepSeek',
      baseURL: options.baseURL ?? 'https://api.deepseek.com/v1',
      supportsVision: options.supportsVision ?? false,
      ...options,
    });
  }
}
