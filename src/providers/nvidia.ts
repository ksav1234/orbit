import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './compatible.js';

export type NvidiaProviderOptions = Omit<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'> &
  Partial<Pick<OpenAICompatibleOptions, 'id' | 'name' | 'baseURL'>>;

/** NVIDIA NIM hosted inference, and self-hosted NIM containers. */
export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor(options: NvidiaProviderOptions) {
    super({
      id: options.id ?? 'nvidia',
      name: options.name ?? 'NVIDIA NIM',
      baseURL: options.baseURL ?? 'https://integrate.api.nvidia.com/v1',
      ...options,
    });
  }
}
