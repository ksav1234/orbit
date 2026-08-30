import type { ConfigManager } from '../config/manager.js';
import {
  PROVIDER_PRESETS,
  presetById,
  THEME_NAMES,
  type PermissionPolicy,
  type ProviderConfig,
} from '../config/schema.js';
import { createProvider, isLocalEndpoint } from '../providers/factory.js';
import { maskKey } from '../util/redact.js';
import { formatCount } from '../util/format.js';
import { UsageTracker } from '../context/usage.js';
import { errorMessage } from '../util/errors.js';
import { ask, askSecret, confirm, print, printError, select, table, ui } from './prompt.js';
import { ORBIT_LOGO_SMALL, TAGLINE } from '../ui/theme.js';

/**
 * Interactive provider setup. Runs on first launch and from
 * `orbit provider add` / `orbit config`.
 */
export async function runProviderWizard(
  config: ConfigManager,
  options: { firstRun?: boolean } = {},
): Promise<ProviderConfig | null> {
  if (options.firstRun) {
    print();
    print(ui.title(ORBIT_LOGO_SMALL[0] ?? 'ORBIT'));
    print(ui.dim(TAGLINE));
    print();
    print('Orbit uses your own AI provider and your own API key.');
    print(ui.dim('Keys are stored in ~/.orbit/credentials and never printed or logged.'));
  }

  const presetId = await select(
    'Provider',
    PROVIDER_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
      description: preset.description,
    })),
  );

  const preset = presetById(presetId);
  if (!preset) return null;

  let id = preset.id;
  let label = preset.label;
  let baseURL = preset.baseURL;

  if (preset.id === 'custom') {
    id = (await ask('Provider id', 'custom')).replace(/[^a-z0-9_-]/gi, '') || 'custom';
    label = (await ask('Display name', id)) || id;
    baseURL = await ask('Base URL (OpenAI-compatible)', preset.baseURL);
  } else if (config.getProvider(preset.id)) {
    const replace = await confirm(`${preset.label} is already configured. Replace it?`, true);
    if (!replace) return null;
  }

  // ── credentials ──
  let apiKey = '';
  const envName = preset.apiKeyEnv;
  const envValue = envName ? process.env[envName] : undefined;

  if (envValue?.trim()) {
    print(ui.ok(`Found ${envName} in your environment; Orbit will use it.`));
  } else if (isLocalEndpoint(baseURL)) {
    print(ui.dim('Local endpoint detected — no API key required.'));
  } else {
    if (preset.keyUrl) print(ui.dim(`Get a key: ${preset.keyUrl}`));
    apiKey = await askSecret('API key');
    if (!apiKey) {
      printError(ui.warn('No key entered. You can add one later with: orbit provider add'));
    }
  }

  // ── model ──
  const provider: ProviderConfig = config.providerFromPreset(preset, {
    id,
    label,
    baseURL,
    models: preset.models,
  });

  let models = preset.models;
  // Context windows reported by the provider beat any guess from the model name.
  const reportedWindows = new Map<string, number>();

  if (apiKey || envValue || isLocalEndpoint(baseURL)) {
    try {
      print(ui.dim('Fetching available models…'));
      const instance = createProvider({
        config: { ...provider, model: preset.models[0] ?? 'placeholder' },
        apiKey: apiKey || envValue,
      });
      const fetched = await instance.listModels?.();
      if (fetched && fetched.length > 0) {
        models = fetched.map((model) => model.id);
        for (const model of fetched) {
          if (model.contextWindow) reportedWindows.set(model.id, model.contextWindow);
        }
      }
    } catch (error) {
      print(ui.dim(`Could not list models (${errorMessage(error)}). Using the built-in list.`));
    }
  }

  let model: string;
  if (models.length === 0) {
    model = await ask('Model id');
  } else if (models.length <= 25) {
    model = await select(
      'Model',
      models.map((id_) => ({ value: id_, label: id_ })),
    );
  } else {
    print();
    print(ui.title(`Model  ${ui.dim(`(${models.length} available)`)}`));
    const filter = await ask('Filter (leave blank to type a model id)', '');
    const filtered = filter
      ? models.filter((id_) => id_.toLowerCase().includes(filter.toLowerCase())).slice(0, 25)
      : [];
    model =
      filtered.length > 0
        ? await select(
            'Model',
            filtered.map((id_) => ({ value: id_, label: id_ })),
          )
        : await ask('Model id', models[0]);
  }

  const contextWindow = reportedWindows.get(model) ?? preset.contextWindow;

  const finalProvider: ProviderConfig = {
    ...provider,
    model,
    models: models.slice(0, 60),
    ...(contextWindow ? { contextWindow } : {}),
  };

  await config.addProvider(finalProvider, apiKey || undefined);
  await config.useProvider(finalProvider.id);

  print();
  print(ui.ok(`Configured ${finalProvider.label}.`));
  table([
    ['Provider', finalProvider.label],
    ['Endpoint', finalProvider.baseURL],
    ['Model', model],
    [
      'Context',
      contextWindow
        ? `${contextWindow.toLocaleString()} tokens${reportedWindows.has(model) ? ' (reported by the provider)' : ''}`
        : 'detected from the model name',
    ],
    [
      'API key',
      config.apiKeySource(finalProvider.id) === 'env'
        ? `from ${finalProvider.apiKeyEnv}`
        : maskKey(config.apiKey(finalProvider.id)),
    ],
  ]);
  print(ui.dim('  Change the window later with: orbit model context <tokens>'));
  print();

  return finalProvider;
}

const PERMISSION_KEYS: Array<keyof PermissionPolicy> = [
  'read',
  'search',
  'write',
  'delete',
  'shell',
  'network',
];

/**
 * `orbit config` — the settings screen.
 *
 * It loops until you choose to exit, because changing a provider, then its
 * model, then a permission is the normal case; making each one a fresh
 * invocation of the command was needless friction.
 */
export async function runConfigScreen(config: ConfigManager): Promise<void> {
  for (;;) {
    const again = await runConfigScreenOnce(config);
    if (!again) return;
  }
}

/** One pass of the settings screen. Returns false when the user is done. */
async function runConfigScreenOnce(config: ConfigManager): Promise<boolean> {
  const current = config.get();
  const active = config.activeProvider();

  const usage = new UsageTracker();
  await usage.load();
  const lifetime = usage.lifetimeTotals();

  print();
  print(ui.title('Orbit Configuration'));
  print();

  table([
    ['Provider', active ? `${active.label} (${active.id})` : 'not configured'],
    ['Model', active?.model ?? '-'],
    [
      'API key',
      active
        ? config.apiKeySource(active.id) === 'env'
          ? `from ${active.apiKeyEnv}`
          : maskKey(config.apiKey(active.id))
        : '-',
    ],
    ['Config file', '~/.orbit/config.json'],
  ]);

  print();
  print(ui.title('Workspace permissions'));
  table(PERMISSION_KEYS.map((key) => [key, current.permissions[key]] as [string, string]));

  print();
  print(ui.title('Token usage'));
  if (lifetime.requests === 0) {
    print(ui.dim('  No requests recorded yet.'));
  } else {
    table([
      ['Input', `${formatCount(lifetime.promptTokens)} tokens`],
      ['Output', `${formatCount(lifetime.completionTokens)} tokens`],
      ['Total', `${formatCount(lifetime.totalTokens)} tokens`],
      ['Requests', String(lifetime.requests)],
    ]);
    const perModel = usage.byModel().slice(0, 5);
    if (perModel.length > 0) {
      print();
      for (const { key, usage: model } of perModel) {
        print(
          `  ${ui.label(key.padEnd(30))} ${ui.value(
            formatCount(model.promptTokens + model.completionTokens).padStart(8),
          )}  ${ui.dim(`${model.requests} req`)}`,
        );
      }
    }
  }

  print();
  print(ui.title('Automation'));
  const webSource = config.serviceKeySource('tavily', current.web.apiKeyEnv);
  table([
    [
      'Optimizer',
      current.optimizer.enabled
        ? `on (target ${Math.round(current.optimizer.targetUtilization * 100)}% of window, reply ${formatCount(current.optimizer.minResponseTokens)}–${formatCount(current.optimizer.maxResponseTokens)})`
        : 'off',
    ],
    [
      'Auto mode',
      current.autoMode.enabled
        ? `on by default (${current.autoMode.maxContinuations} continuations)`
        : 'off by default',
    ],
    [
      'Checkpoints',
      current.checkpoints.enabled
        ? `on (last ${current.checkpoints.maxPerSession} turns undoable)`
        : 'off',
    ],
    [
      'Web search',
      current.web.enabled
        ? webSource === 'none'
          ? 'enabled, but no Tavily key'
          : `Tavily (${webSource === 'env' ? current.web.apiKeyEnv : maskKey(config.serviceKey('tavily'))})`
        : 'off',
    ],
    [
      'MCP servers',
      Object.keys(current.mcp.servers).length > 0
        ? Object.keys(current.mcp.servers).join(', ')
        : 'none configured',
    ],
    ['Sub-agents', current.subagents.enabled ? `on (depth ${current.subagents.maxDepth})` : 'off'],
    ['Theme', current.ui.theme],
  ]);
  print();

  const action = await select('What would you like to change?', [
    { value: 'provider', label: 'Add or replace a provider' },
    { value: 'active', label: 'Switch the active provider', description: 'Choose from configured providers' },
    { value: 'model', label: 'Change the model' },
    { value: 'key', label: 'Change the API key', description: 'Hidden input, for the active provider' },
    { value: 'context', label: 'Set the context window', description: 'Override the detected size' },
    { value: 'permissions', label: 'Change workspace permissions' },
    { value: 'agent', label: 'Agent behaviour', description: 'Temperature, iteration limit, compaction' },
    { value: 'optimizer', label: 'Token optimization', description: 'Adaptive reply budget and tool output limits' },
    { value: 'auto', label: 'Auto-working mode', description: 'What auto mode may approve on its own' },
    { value: 'web', label: 'Web access', description: 'Tavily API key for web_search and web_fetch' },
    { value: 'checkpoints', label: 'Checkpoints and undo' },
    { value: 'subagents', label: 'Sub-agents', description: 'Delegated investigations with their own context' },
    { value: 'theme', label: 'Colour theme' },
    { value: 'pricing', label: 'Model pricing', description: 'For cost estimates in /usage' },
    { value: 'usage', label: 'Reset token usage statistics' },
    { value: 'quit', label: 'Nothing, exit' },
  ]);

  switch (action) {
    case 'provider':
      await runProviderWizard(config);
      break;

    case 'active': {
      const providers = config.listProviders();
      if (providers.length === 0) {
        printError(ui.warn('No providers configured yet.'));
        await runProviderWizard(config, { firstRun: true });
        break;
      }
      const id = await select(
        'Active provider',
        providers.map((provider) => ({
          value: provider.id,
          label: provider.label,
          description: provider.model,
        })),
      );
      await config.useProvider(id);
      print(ui.ok(`Active provider is now ${id}.`));
      break;
    }

    case 'model': {
      if (!active) {
        printError(ui.warn('Configure a provider first.'));
        break;
      }
      const model =
        active.models.length > 0
          ? await select(
              'Model',
              active.models.slice(0, 30).map((id_) => ({ value: id_, label: id_ })),
            )
          : await ask('Model id', active.model);
      await config.useModel(model);
      print(ui.ok(`Model set to ${model}.`));
      break;
    }

    case 'permissions': {
      for (const key of PERMISSION_KEYS) {
        const value = await select(
          `Permission: ${key}`,
          [
            { value: 'allow', label: 'Allow', description: 'Never ask' },
            { value: 'ask', label: 'Ask', description: 'Prompt each time' },
            { value: 'deny', label: 'Deny', description: 'Always refuse' },
          ],
          ['allow', 'ask', 'deny'].indexOf(current.permissions[key]),
        );
        await config.setPermission(key, value as 'allow' | 'ask' | 'deny');
      }
      print(ui.ok('Permissions updated.'));
      break;
    }

    case 'agent': {
      const temperature = Number(
        await ask('Temperature (0-2)', String(current.agent.temperature)),
      );
      const maxIterations = Number(
        await ask('Max tool iterations per turn', String(current.agent.maxIterations)),
      );
      const autoCompact = await confirm(
        'Automatically compact context when it fills up?',
        current.agent.autoCompact,
      );
      await config.update((draft) => {
        if (Number.isFinite(temperature)) draft.agent.temperature = Math.min(2, Math.max(0, temperature));
        if (Number.isInteger(maxIterations) && maxIterations > 0) {
          draft.agent.maxIterations = Math.min(200, maxIterations);
        }
        draft.agent.autoCompact = autoCompact;
      });
      print(ui.ok('Agent settings updated.'));
      break;
    }

    case 'optimizer': {
      const enabled = await confirm(
        'Adapt the reply budget and tool output limits to the remaining context?',
        current.optimizer.enabled,
      );
      let target = current.optimizer.targetUtilization;
      let maxResponse = current.optimizer.maxResponseTokens;
      let announce = current.optimizer.announce;

      if (enabled) {
        const targetPercent = Number(
          await ask('Target context utilization (%)', String(Math.round(target * 100))),
        );
        if (Number.isFinite(targetPercent)) {
          target = Math.min(0.95, Math.max(0.3, targetPercent / 100));
        }
        const ceiling = Number(
          await ask('Maximum reply size (tokens)', String(maxResponse)),
        );
        if (Number.isInteger(ceiling) && ceiling >= 512) maxResponse = ceiling;
        announce = await confirm('Tell me when the budget changes?', announce);
      }

      await config.update((draft) => {
        draft.optimizer.enabled = enabled;
        draft.optimizer.targetUtilization = target;
        draft.optimizer.maxResponseTokens = maxResponse;
        draft.optimizer.announce = announce;
      });
      print(ui.ok(`Token optimization ${enabled ? 'enabled' : 'disabled'}.`));
      break;
    }

    case 'auto': {
      print();
      print(ui.warn('  Auto mode approves operations without asking each time.'));
      print(ui.dim('  It never widens the workspace boundary or the shell block list.'));
      print();

      const enabled = await confirm('Start new sessions with auto mode on?', current.autoMode.enabled);
      const approveWrites = await confirm(
        'Auto-approve file writes and edits?',
        current.autoMode.approveWrites,
      );
      const approveShell = await confirm(
        'Auto-approve shell commands?',
        current.autoMode.approveShell,
      );
      const approveDeletes = await confirm(
        'Auto-approve deletions? (not recommended)',
        current.autoMode.approveDeletes,
      );
      const approveSensitive = await confirm(
        'Auto-approve sharing files that look like secrets? (not recommended)',
        current.autoMode.approveSensitive,
      );
      const maxContinuations = Number(
        await ask(
          'How many times may Orbit continue on its own?',
          String(current.autoMode.maxContinuations),
        ),
      );

      await config.update((draft) => {
        draft.autoMode.enabled = enabled;
        draft.autoMode.approveWrites = approveWrites;
        draft.autoMode.approveShell = approveShell;
        draft.autoMode.approveDeletes = approveDeletes;
        draft.autoMode.approveSensitive = approveSensitive;
        if (Number.isInteger(maxContinuations) && maxContinuations >= 0) {
          draft.autoMode.maxContinuations = Math.min(25, maxContinuations);
        }
      });
      print(ui.ok('Auto mode settings updated.'));
      break;
    }

    case 'key': {
      if (!active) {
        printError(ui.warn('Configure a provider first.'));
        break;
      }
      if (config.apiKeySource(active.id) === 'env') {
        printError(ui.warn(`${active.label} is using ${active.apiKeyEnv} from your environment.`));
        print(ui.dim('  That takes precedence over a stored key. Unset it first, or change the variable.'));
        break;
      }

      const preset = presetById(active.id);
      if (preset?.keyUrl) print(ui.dim(`  Get a key: ${preset.keyUrl}`));
      const key = await askSecret(`API key for ${active.label}`);
      if (!key) {
        print(ui.dim('Nothing changed.'));
        break;
      }
      await config.setApiKey(active.id, key);
      print(ui.ok(`Key updated. ${maskKey(config.apiKey(active.id))}`));
      break;
    }

    case 'context': {
      if (!active) {
        printError(ui.warn('Configure a provider first.'));
        break;
      }
      print();
      print(ui.dim(`  Orbit detects the window from the model name and the provider's model list.`));
      print(ui.dim('  Override it here if your deployment serves a different size.'));
      print();
      const answer = await ask(
        'Context window in tokens ("auto" to detect)',
        active.contextWindow ? String(active.contextWindow) : 'auto',
      );
      await config.update((draft) => {
        const entry = draft.providers[active.id];
        if (!entry) return;
        if (answer.trim().toLowerCase() === 'auto') {
          delete entry.contextWindow;
          return;
        }
        const tokens = Number.parseInt(answer.replace(/[_,]/g, ''), 10);
        if (Number.isInteger(tokens) && tokens >= 1024) entry.contextWindow = tokens;
      });
      print(ui.ok('Context window updated.'));
      break;
    }

    case 'web': {
      print();
      print(ui.dim('  Web search uses Tavily. Only your query text leaves the machine.'));
      print(ui.dim('  Get a key at https://tavily.com'));
      print();

      const enabled = await confirm('Enable web search and fetch?', current.web.enabled);
      if (enabled && config.serviceKeySource('tavily', current.web.apiKeyEnv) === 'none') {
        const key = await askSecret('Tavily API key (blank to skip)');
        if (key) await config.setServiceKey('tavily', key);
      }

      const maxResults = Number(
        await ask('Results per search', String(current.web.maxResults)),
      );
      const depth = await select(
        'Search depth',
        [
          { value: 'basic', label: 'basic', description: 'Faster and cheaper' },
          { value: 'advanced', label: 'advanced', description: 'Digs deeper, costs more' },
        ],
        current.web.searchDepth === 'advanced' ? 1 : 0,
      );

      await config.update((draft) => {
        draft.web.enabled = enabled;
        if (Number.isInteger(maxResults) && maxResults > 0) {
          draft.web.maxResults = Math.min(20, maxResults);
        }
        draft.web.searchDepth = depth as 'basic' | 'advanced';
      });
      print(ui.ok(`Web access ${enabled ? 'enabled' : 'disabled'}.`));
      break;
    }

    case 'checkpoints': {
      const enabled = await confirm(
        'Snapshot files before each turn so changes can be undone?',
        current.checkpoints.enabled,
      );
      const maxPerSession = Number(
        await ask('Turns kept per session', String(current.checkpoints.maxPerSession)),
      );
      await config.update((draft) => {
        draft.checkpoints.enabled = enabled;
        if (Number.isInteger(maxPerSession) && maxPerSession > 0) {
          draft.checkpoints.maxPerSession = Math.min(500, maxPerSession);
        }
      });
      print(ui.ok(`Checkpoints ${enabled ? 'enabled' : 'disabled'}.`));
      break;
    }

    case 'subagents': {
      const enabled = await confirm(
        'Let the agent delegate investigations to sub-agents?',
        current.subagents.enabled,
      );
      const maxIterations = Number(
        await ask('Maximum steps per sub-agent', String(current.subagents.maxIterations)),
      );
      await config.update((draft) => {
        draft.subagents.enabled = enabled;
        if (Number.isInteger(maxIterations) && maxIterations > 0) {
          draft.subagents.maxIterations = Math.min(60, maxIterations);
        }
      });
      print(ui.ok(`Sub-agents ${enabled ? 'enabled' : 'disabled'}.`));
      break;
    }

    case 'theme': {
      const theme = await select(
        'Colour theme',
        THEME_NAMES.map((name) => ({ value: name, label: name })),
        THEME_NAMES.indexOf(current.ui.theme),
      );
      await config.update((draft) => {
        draft.ui.theme = theme;
      });
      print(ui.ok(`Theme set to ${theme}.`));
      break;
    }

    case 'pricing': {
      print();
      print(ui.dim('  Orbit ships no rate table: prices change, and a wrong number is worse'));
      print(ui.dim('  than none. Enter the rates from your provider to see costs in /usage.'));
      print();

      const key = await ask(
        'Model key (as shown in /usage, e.g. "OpenAI:gpt-5")',
        active ? `${active.label}:${active.model ?? ''}` : '',
      );
      if (!key.trim()) {
        print(ui.dim('Skipped.'));
        break;
      }
      const inputPerMillion = Number(await ask('Input price per million tokens', '0'));
      const outputPerMillion = Number(await ask('Output price per million tokens', '0'));
      const currency = (await ask('Currency', 'USD')).trim().toUpperCase() || 'USD';

      if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) {
        printError(ui.warn('Prices must be numbers. Nothing changed.'));
        break;
      }
      await config.update((draft) => {
        draft.pricing[key.trim()] = {
          inputPerMillion: Math.max(0, inputPerMillion),
          outputPerMillion: Math.max(0, outputPerMillion),
          currency,
        };
      });
      print(ui.ok(`Priced ${key.trim()}.`));
      break;
    }

    case 'usage': {
      if (lifetime.requests === 0) {
        print(ui.dim('Nothing to reset.'));
        break;
      }
      const yes = await confirm(
        `Delete recorded usage for ${formatCount(lifetime.totalTokens)} tokens across ${lifetime.requests} requests?`,
        false,
      );
      if (yes) {
        await usage.reset();
        print(ui.ok('Token usage statistics cleared.'));
      }
      break;
    }

    case 'quit':
      print(ui.dim('Nothing else changed.'));
      return false;

    default:
      break;
  }

  // Every change above is written through config.update(), which persists
  // immediately — there is nothing left to save separately.
  return true;
}
