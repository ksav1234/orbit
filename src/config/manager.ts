import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureOrbitHome, orbitPaths } from '../util/paths.js';
import { OrbitError } from '../util/errors.js';
import { registerSecret } from '../util/redact.js';
import { createLogger } from '../util/logger.js';
import {
  ConfigSchema,
  defaultConfig,
  type OrbitConfig,
  type PermissionPolicy,
  type ProviderConfig,
  type ProviderPreset,
} from './schema.js';

const log = createLogger('config');

/** Credentials live in their own 0600 file so config.json stays safe to share. */
type CredentialStore = Record<string, string>;

export class ConfigManager {
  private config: OrbitConfig = defaultConfig();
  private credentials: CredentialStore = {};
  private loaded = false;

  async load(): Promise<OrbitConfig> {
    await ensureOrbitHome();
    this.config = await this.readConfigFile();
    this.credentials = await this.readCredentials();
    for (const key of Object.values(this.credentials)) registerSecret(key);
    this.loaded = true;
    return this.config;
  }

  private async readConfigFile(): Promise<OrbitConfig> {
    try {
      const raw = await fs.readFile(orbitPaths.config, 'utf8');
      const parsed = ConfigSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        log.warn('config failed validation, falling back to defaults', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        throw new OrbitError('Configuration file is invalid.', {
          kind: 'config',
          detail: parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
          hints: [`Fix or delete ${orbitPaths.config}`, 'Run: orbit config'],
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof OrbitError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
      if (error instanceof SyntaxError) {
        throw new OrbitError('Configuration file is not valid JSON.', {
          kind: 'config',
          detail: error.message,
          hints: [`Fix or delete ${orbitPaths.config}`],
        });
      }
      throw error;
    }
  }

  private async readCredentials(): Promise<CredentialStore> {
    try {
      const raw = await fs.readFile(orbitPaths.credentialsFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      const out: CredentialStore = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      log.warn('credential store unreadable; continuing without stored keys');
      return {};
    }
  }

  get(): OrbitConfig {
    if (!this.loaded) log.warn('config accessed before load()');
    return this.config;
  }

  /** Apply a partial update, validate the result, and persist it. */
  async update(mutate: (config: OrbitConfig) => void): Promise<OrbitConfig> {
    const draft: OrbitConfig = structuredClone(this.config);
    mutate(draft);
    const parsed = ConfigSchema.safeParse(draft);
    if (!parsed.success) {
      throw new OrbitError('Invalid configuration change.', {
        kind: 'config',
        detail: parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
      });
    }
    this.config = parsed.data;
    await this.save();
    return this.config;
  }

  async save(): Promise<void> {
    await ensureOrbitHome();
    await writeFileAtomic(orbitPaths.config, JSON.stringify(this.config, null, 2) + '\n', 0o600);
  }

  // ── Providers ────────────────────────────────────────────────────────────

  listProviders(): ProviderConfig[] {
    return Object.values(this.config.providers).sort((a, b) => a.id.localeCompare(b.id));
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.config.providers[id];
  }

  activeProvider(): ProviderConfig | undefined {
    const id = this.config.activeProvider;
    if (id && this.config.providers[id]) return this.config.providers[id];
    const first = this.listProviders()[0];
    return first;
  }

  async addProvider(provider: ProviderConfig, apiKey?: string): Promise<void> {
    await this.update((config) => {
      config.providers[provider.id] = provider;
      config.activeProvider ??= provider.id;
    });
    if (apiKey) await this.setApiKey(provider.id, apiKey);
  }

  async removeProvider(id: string): Promise<void> {
    await this.update((config) => {
      delete config.providers[id];
      if (config.activeProvider === id) {
        config.activeProvider = Object.keys(config.providers)[0];
      }
    });
    await this.deleteApiKey(id);
  }

  async useProvider(id: string): Promise<void> {
    if (!this.config.providers[id]) {
      throw new OrbitError(`No provider configured with id "${id}".`, {
        kind: 'config',
        hints: ['List providers with: orbit provider list', 'Add one with: orbit provider add'],
      });
    }
    await this.update((config) => {
      config.activeProvider = id;
    });
  }

  async useModel(model: string, providerId?: string): Promise<void> {
    const id = providerId ?? this.config.activeProvider;
    if (!id || !this.config.providers[id]) {
      throw new OrbitError('No active provider to set a model on.', {
        kind: 'config',
        hints: ['Run: orbit provider add'],
      });
    }
    await this.update((config) => {
      const provider = config.providers[id];
      if (provider) {
        provider.model = model;
        if (!provider.models.includes(model)) provider.models = [model, ...provider.models];
      }
    });
  }

  /** Build a provider config from a preset, keeping any user overrides. */
  providerFromPreset(preset: ProviderPreset, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      id: overrides.id ?? preset.id,
      label: overrides.label ?? preset.label,
      kind: overrides.kind ?? preset.kind,
      baseURL: overrides.baseURL ?? preset.baseURL,
      model: overrides.model ?? preset.model ?? preset.models[0],
      models: overrides.models ?? preset.models,
      apiKeyEnv: overrides.apiKeyEnv ?? preset.apiKeyEnv,
      headers: overrides.headers ?? preset.headers ?? {},
      supportsTools: overrides.supportsTools ?? preset.supportsTools,
      supportsVision: overrides.supportsVision ?? preset.supportsVision,
      contextWindow: overrides.contextWindow ?? preset.contextWindow,
    };
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  /** Environment variables win over the stored key so CI can override locally. */
  apiKey(providerId: string): string | undefined {
    const provider = this.config.providers[providerId];
    const envName = provider?.apiKeyEnv;
    const fromEnv = envName ? process.env[envName] : undefined;
    const key = fromEnv?.trim() || this.credentials[providerId];
    if (key) registerSecret(key);
    return key || undefined;
  }

  hasApiKey(providerId: string): boolean {
    return Boolean(this.apiKey(providerId));
  }

  apiKeySource(providerId: string): 'env' | 'store' | 'none' {
    const envName = this.config.providers[providerId]?.apiKeyEnv;
    if (envName && process.env[envName]?.trim()) return 'env';
    if (this.credentials[providerId]) return 'store';
    return 'none';
  }

  /**
   * Keys for non-provider services (Tavily today). Stored in the same 0600
   * credential file, namespaced so they cannot collide with a provider id.
   */
  serviceKey(service: string, envName?: string): string | undefined {
    const fromEnv = envName ? process.env[envName]?.trim() : undefined;
    const key = fromEnv || this.credentials[`service:${service}`];
    if (key) registerSecret(key);
    return key || undefined;
  }

  serviceKeySource(service: string, envName?: string): 'env' | 'store' | 'none' {
    if (envName && process.env[envName]?.trim()) return 'env';
    if (this.credentials[`service:${service}`]) return 'store';
    return 'none';
  }

  async setServiceKey(service: string, apiKey: string): Promise<void> {
    await ensureOrbitHome();
    this.credentials[`service:${service}`] = apiKey.trim();
    registerSecret(apiKey.trim());
    await this.persistCredentials();
  }

  async deleteServiceKey(service: string): Promise<void> {
    if (!(`service:${service}` in this.credentials)) return;
    delete this.credentials[`service:${service}`];
    await this.persistCredentials();
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await ensureOrbitHome();
    this.credentials[providerId] = apiKey.trim();
    registerSecret(apiKey.trim());
    await this.persistCredentials();
  }

  async deleteApiKey(providerId: string): Promise<void> {
    if (!(providerId in this.credentials)) return;
    delete this.credentials[providerId];
    await this.persistCredentials();
  }

  private async persistCredentials(): Promise<void> {
    await fs.mkdir(orbitPaths.credentials, { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      orbitPaths.credentialsFile,
      JSON.stringify(this.credentials, null, 2) + '\n',
      0o600,
    );
  }

  // ── Permissions ──────────────────────────────────────────────────────────

  permissions(): PermissionPolicy {
    return this.config.permissions;
  }

  async setPermission(key: keyof PermissionPolicy, value: 'allow' | 'ask' | 'deny'): Promise<void> {
    await this.update((config) => {
      config.permissions[key] = value;
    });
  }
}

/** Write via a temp file + rename so a crash cannot leave a half-written config. */
export async function writeFileAtomic(
  file: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, contents, { mode });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, mode);
  } catch {
    // chmod is a no-op on some Windows filesystems.
  }
}

let singleton: ConfigManager | null = null;

export async function loadConfig(): Promise<ConfigManager> {
  if (!singleton) {
    singleton = new ConfigManager();
    await singleton.load();
  }
  return singleton;
}

export function resetConfigSingleton(): void {
  singleton = null;
}
