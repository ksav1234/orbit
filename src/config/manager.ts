import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureOrbitHome, orbitPaths } from '../util/paths.js';
import { OrbitError } from '../util/errors.js';
import { registerSecret } from '../util/redact.js';
import { createLogger } from '../util/logger.js';
import {
  ConfigSchema,
  HookSchema,
  ProviderConfigSchema,
  defaultConfig,
  type OrbitConfig,
  type PermissionPolicy,
  type ProviderConfig,
  type ProviderPreset,
} from './schema.js';

const log = createLogger('config');

/** Credentials live in their own 0600 file so config.json stays safe to share. */
type CredentialStore = Record<string, string>;

/** A configuration section that could not be used, and why. */
export interface ConfigIssue {
  section: string;
  message: string;
}

function firstMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const where = issue.path.map(String).join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/**
 * Rebuild a usable config from one that failed validation, keeping everything
 * that parses.
 *
 * Sections are validated independently against their own schema, so a typo in
 * `hooks` cannot take `providers` down with it. Two collections get finer
 * treatment still, because they are lists the user curates by hand and losing
 * all of them over one bad entry would be its own bug:
 *
 *   - `providers`, keyed by id — a broken provider is dropped, the rest stay.
 *   - `hooks.entries`, an array — a broken hook is dropped, the rest still run.
 */
export function salvageConfig(input: unknown): { config: OrbitConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { config: defaultConfig(), issues: [{ section: 'root', message: 'not an object' }] };
  }

  const raw = input as Record<string, unknown>;
  const shape = ConfigSchema.shape as Record<string, { safeParse(value: unknown): unknown }>;
  const kept: Record<string, unknown> = {};

  for (const [section, schema] of Object.entries(shape)) {
    if (!(section in raw)) continue;
    const result = schema.safeParse(raw[section]) as
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };

    if (result.success) {
      kept[section] = raw[section];
      continue;
    }

    const rescued = salvageCollection(section, raw[section], issues);
    if (rescued !== undefined) {
      kept[section] = rescued;
      continue;
    }
    issues.push({ section, message: firstMessage(result.error) });
  }

  const parsed = ConfigSchema.safeParse(kept);
  if (parsed.success) return { config: parsed.data, issues };

  // Something survived per-section validation but not the whole-object pass —
  // a cross-field rule. Defaults are the only safe answer left.
  issues.push({ section: 'root', message: firstMessage(parsed.error) });
  return { config: defaultConfig(), issues };
}

/**
 * Drop only the broken members of a hand-curated collection. Returns undefined
 * when the section is not one of those, or when nothing could be rescued.
 */
function salvageCollection(
  section: string,
  value: unknown,
  issues: ConfigIssue[],
): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined;

  if (section === 'providers') {
    const entries = Object.entries(value as Record<string, unknown>);
    const good: Record<string, unknown> = {};
    for (const [id, provider] of entries) {
      const result = ProviderConfigSchema.safeParse(provider);
      if (result.success) good[id] = provider;
      else issues.push({ section: `providers.${id}`, message: firstMessage(result.error) });
    }
    return Object.keys(good).length > 0 ? good : undefined;
  }

  if (section === 'hooks') {
    const record = value as { enabled?: unknown; entries?: unknown };
    if (!Array.isArray(record.entries)) return undefined;
    const good: unknown[] = [];
    record.entries.forEach((hook, index) => {
      const result = HookSchema.safeParse(hook);
      if (result.success) good.push(hook);
      else issues.push({ section: `hooks.entries[${index}]`, message: firstMessage(result.error) });
    });
    // Even zero surviving hooks is a rescue here: it keeps `enabled` and lets
    // the rest of the config load.
    return { ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}), entries: good };
  }

  return undefined;
}

/** Which keys each top-level section actually declared in the file. */
function recordWrittenKeys(json: unknown): Record<string, Set<string>> {
  const written: Record<string, Set<string>> = {};
  if (!json || typeof json !== 'object') return written;
  for (const [section, value] of Object.entries(json as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      written[section] = new Set(Object.keys(value));
    }
  }
  return written;
}

export class ConfigManager {
  private config: OrbitConfig = defaultConfig();
  private credentials: CredentialStore = {};
  private loaded = false;
  private issues: ConfigIssue[] = [];
  /** Whether the damaged original has already been copied aside. */
  private backedUp = false;
  /** Per-section, the keys that were literally present in the file. */
  private written: Record<string, Set<string>> = {};

  async load(): Promise<OrbitConfig> {
    await ensureOrbitHome();
    this.config = await this.readConfigFile();
    this.credentials = await this.readCredentials();
    for (const key of Object.values(this.credentials)) registerSecret(key);
    this.loaded = true;
    return this.config;
  }

  private async readConfigFile(): Promise<OrbitConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(orbitPaths.config, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
      throw error;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      // Unparseable JSON is the one case with nothing to salvage: there is no
      // way to tell which part the user meant.
      throw new OrbitError('Configuration file is not valid JSON.', {
        kind: 'config',
        detail: error instanceof Error ? error.message : String(error),
        hints: [`Fix or delete ${orbitPaths.config}`],
      });
    }

    this.written = recordWrittenKeys(json);

    const parsed = ConfigSchema.safeParse(json);
    if (parsed.success) return parsed.data;

    // One bad section must not lock the user out of the whole CLI — including
    // out of `orbit config`, which is what they would be told to run to fix it.
    // Valid sections are kept, invalid ones fall back to their defaults, and
    // exactly what was dropped is reported rather than silently swallowed.
    const { config, issues } = salvageConfig(json);
    this.issues = issues;
    log.warn('config partly invalid; unusable sections reset', {
      issues: issues.map((issue) => `${issue.section}: ${issue.message}`),
    });
    return config;
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
  /**
   * Keys the user wrote in a section, as opposed to schema defaults.
   *
   * Orbit tightens a few settings when it is editing its own source, and needs
   * to know the difference between "they chose false" and "they never said".
   */
  explicitKeys(section: string): ReadonlySet<string> {
    return this.written[section] ?? new Set<string>();
  }

  /** Sections that failed validation at load and were reset. Empty when clean. */
  validationIssues(): ConfigIssue[] {
    return this.issues;
  }

  /**
   * Copy the damaged file aside before the first write that would overwrite it.
   * The salvaged config is what gets saved, so without this the user's broken
   * (but possibly nearly-right) section would be gone for good.
   */
  private async backupIfSalvaged(): Promise<void> {
    if (this.backedUp || this.issues.length === 0) return;
    this.backedUp = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${orbitPaths.config}.invalid-${stamp}`;
    try {
      await fs.copyFile(orbitPaths.config, target);
      log.warn('kept a copy of the invalid config', { target });
    } catch (error) {
      log.warn('could not back up the invalid config', { error: String(error) });
    }
  }

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
    await this.backupIfSalvaged();
    await this.save();
    return this.config;
  }

  /**
   * Record that the user chose these settings deliberately.
   *
   * Diffing the config cannot tell: setting a value that happens to equal the
   * schema default produces no change, and that is exactly the case that
   * matters — `orbit verify off` writes `false`, which is also the default, yet
   * it is unmistakably a choice. So the caller says so.
   *
   * Paths are `section.key`, matching how they read in the config file.
   */
  markExplicit(...paths: string[]): void {
    for (const path of paths) {
      const [section, key] = path.split('.');
      if (!section || !key) continue;
      const keys = this.written[section] ?? new Set<string>();
      keys.add(key);
      this.written[section] = keys;
    }
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
