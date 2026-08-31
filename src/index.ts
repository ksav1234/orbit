#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import React from 'react';
import { render } from 'ink';
import { App } from './cli/app.js';
import { runConfigScreen, runProviderWizard } from './cli/setup.js';
import { confirm, isInteractive, print, printError, table, ui } from './cli/prompt.js';
import { loadConfig, type ConfigManager } from './config/manager.js';
import { HOOK_EVENTS, PROVIDER_PRESETS, presetById, type PricingEntry } from './config/schema.js';
import { createProvider, isLocalEndpoint } from './providers/factory.js';
import type { AIProvider } from './providers/provider.js';
import { PermissionManager } from './permissions/manager.js';
import { Sandbox } from './permissions/sandbox.js';
import { buildToolRegistry } from './tools/index.js';
import { detectWorkspace } from './tools/project.js';
import { readGitState, summarizeGitState } from './tools/git.js';
import { isCommandAvailable } from './util/process.js';
import { Agent } from './agent/agent.js';
import { Planner, createPlanTool } from './agent/planner.js';
import { AutoMode } from './agent/autopilot.js';
import { UsageTracker } from './context/usage.js';
import {
  FREE,
  describePrice,
  fetchCataloguePricing,
  isLocalProvider,
  matchCatalogueModel,
  mergePricing,
  type DiscoveredPrice,
} from './context/pricing.js';
import { HookRunner, describeHook, hookMatchesTool } from './hooks/runner.js';
import {
  WindowCache,
  describeWindowSource,
  detectWindow,
  parseWindowArgument,
  resolveWindow,
  type WindowResolution,
} from './context/window.js';
import { SessionManager, newSessionRecord } from './sessions/manager.js';
import { CheckpointManager } from './checkpoints/manager.js';
import { BackgroundRegistry } from './tools/background.js';
import { taskTool } from './agent/subagent.js';
import { startMcpServers, stopMcpServers, describeMcpServers } from './mcp/tools.js';
import { runHeadless, type HeadlessOutput } from './cli/headless.js';
import { askSecret } from './cli/prompt.js';
import { createTheme } from './ui/theme.js';
import { OrbitError, errorMessage } from './util/errors.js';
import { closeLogger, createLogger, enableDebugLogging } from './util/logger.js';
import { ensureOrbitHome, isMainModule, orbitPaths, tildify } from './util/paths.js';
import { maskKey } from './util/redact.js';
import { formatRelativeTime, pluralize } from './util/format.js';

const VERSION = '0.1.0';
const log = createLogger('cli');

// ── argument parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const FLAG_ALIASES: Record<string, string> = {
  m: 'model',
  p: 'prompt',
  h: 'help',
  v: 'version',
  d: 'debug',
};

const VALUE_FLAGS = new Set(['model', 'provider', 'prompt', 'output', 'theme']);

const COMMANDS = new Set([
  'config',
  'hooks',
  'pricing',
  'failover',
  'provider',
  'model',
  'web',
  'mcp',
  'sessions',
  'session',
  'resume',
  'clear',
  'help',
  'version',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      const name = equals === -1 ? body : body.slice(0, equals);
      const inline = equals === -1 ? undefined : body.slice(equals + 1);

      if (name.startsWith('no-')) {
        flags[name.slice(3)] = false;
        continue;
      }
      if (inline !== undefined) {
        flags[name] = inline;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[name] = next;
          i++;
          continue;
        }
      }
      flags[name] = true;
      continue;
    }

    // A leading minus followed by a digit is a negative value, not a flag
    // bundle. `orbit model context -500k` has to reach the command as an
    // argument, and `-5` is not a set of short flags under any reading.
    if (/^-\d/.test(token)) {
      positional.push(token);
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      for (const [index, letter] of [...token.slice(1)].entries()) {
        const name = FLAG_ALIASES[letter] ?? letter;
        const isLast = index === token.length - 2;
        if (isLast && VALUE_FLAGS.has(name)) {
          const next = argv[i + 1];
          if (next && !next.startsWith('-')) {
            flags[name] = next;
            i++;
            continue;
          }
        }
        flags[name] = true;
      }
      continue;
    }

    positional.push(token);
  }

  const first = positional[0];
  const command = first && COMMANDS.has(first) ? first : null;
  if (command) positional.shift();

  return { command, positional, flags };
}

// ── help ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  print();
  print(ui.title('Orbit') + ui.dim('  —  AI that works inside your workspace.'));
  print();
  print(ui.title('Usage'));
  print('  orbit [path]                 Start Orbit in a workspace (defaults to the current directory)');
  print('  orbit config                 Interactive configuration');
  print('  orbit provider <cmd>         list | add | key [id] | use <id> | remove <id>');
  print('  orbit model [<cmd>]          list | use <model>');
  print('  orbit sessions               List saved sessions');
  print('  orbit resume [<id>]          Resume the latest or a specific session');
  print('  orbit clear                  Delete stored sessions');
  print('  orbit web [key|on|off]       Web search access (Tavily)');
  print('  orbit mcp <cmd>              list | add <id> <cmd> | remove <id> | test [id]');
  print('  orbit hooks [test <n>]       Lifecycle hooks: list them, or try one out');
  print('  orbit pricing <cmd>          list | import | set <key> <in> <out> | clear');
  print('  orbit failover <cmd>         list | add <id> | remove <id> | off');
  print('  orbit model context [<n>]    Show, resize (up/down/+50k), or re-detect the window');
  print();
  print(ui.title('Options'));
  print('  -m, --model <model>          Use a specific model for this run');
  print('      --provider <id>          Use a specific configured provider');
  print('  -p, --prompt <text>          Send an initial prompt on startup');
  print('  -d, --debug                  Write a debug log to ~/.orbit/logs');
  print('      --auto                   Start with auto-working agent mode on');
  print('      --no-optimize            Disable adaptive token budgeting for this run');
  print('      --no-banner              Skip the startup banner');
  print('      --no-animation           Skip the animated intro');
  print('      --no-color               Disable colour output');
  print('      --ascii                  Use ASCII-only box drawing');
  print('      --print                  Run one prompt without the UI and exit');
  print('      --output <fmt>           text | json | stream-json (implies --print)');
  print('      --yes                    Auto-approve inside the auto-mode envelope (headless)');
  print('      --verbose                Show tool activity in headless mode');
  print('      --theme <name>           orbit | mono | ember | forest | ice');
  print('  -h, --help                   Show this help');
  print('  -v, --version                Show the version');
  print();
  print(ui.title('Examples'));
  print(ui.dim('  orbit .'));
  print(ui.dim('  orbit ./my-project --model gpt-5'));
  print(ui.dim('  orbit resume'));
  print(ui.dim('  orbit --print -p "summarise the test failures" --output json'));
  print();
}

// ── subcommands ────────────────────────────────────────────────────────────

async function providerCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action = 'list', target] = args;

  switch (action) {
    case 'list': {
      const providers = config.listProviders();
      if (providers.length === 0) {
        print(ui.warn('No providers configured. Run: orbit provider add'));
        return 0;
      }
      const activeId = config.get().activeProvider;
      print();
      print(ui.title('Configured providers'));
      print();
      for (const provider of providers) {
        const marker = provider.id === activeId ? ui.accent('●') : ' ';
        const source = config.apiKeySource(provider.id);
        const key =
          source === 'env'
            ? ui.dim(`env:${provider.apiKeyEnv}`)
            : source === 'store'
              ? ui.dim(maskKey(config.apiKey(provider.id)))
              : ui.warn('no key');
        print(
          `  ${marker} ${ui.value(provider.id.padEnd(12))} ${ui.dim((provider.model ?? '-').padEnd(30))} ${key}`,
        );
      }
      print();
      print(ui.dim('  Available presets: ' + PROVIDER_PRESETS.map((p) => p.id).join(', ')));
      print();
      return 0;
    }

    case 'add': {
      if (!isInteractive()) {
        printError(ui.error('orbit provider add needs an interactive terminal.'));
        return 1;
      }
      const added = await runProviderWizard(config);
      return added ? 0 : 1;
    }

    case 'remove': {
      if (!target) {
        printError(ui.error('Usage: orbit provider remove <id>'));
        return 1;
      }
      if (!config.getProvider(target)) {
        printError(ui.error(`No provider with id "${target}".`));
        return 1;
      }
      const yes = !isInteractive() || (await confirm(`Remove provider "${target}" and its stored key?`, false));
      if (!yes) return 0;
      await config.removeProvider(target);
      print(ui.ok(`Removed ${target}.`));
      return 0;
    }

    case 'use': {
      if (!target) {
        printError(ui.error('Usage: orbit provider use <id>'));
        return 1;
      }
      await config.useProvider(target);
      print(ui.ok(`Active provider is now ${target}.`));
      return 0;
    }

    case 'key': {
      const id = target ?? config.get().activeProvider;
      if (!id) {
        printError(ui.error('Usage: orbit provider key <id>'));
        return 1;
      }
      const provider = config.getProvider(id);
      if (!provider) {
        printError(ui.error(`No provider with id "${id}".`));
        printError(ui.dim('  See: orbit provider list'));
        return 1;
      }
      if (!isInteractive()) {
        printError(ui.error('orbit provider key needs an interactive terminal.'));
        return 1;
      }

      // An environment variable outranks the stored key, so replacing the
      // stored one would silently do nothing.
      if (config.apiKeySource(id) === 'env') {
        printError(
          ui.warn(`${provider.label} is using ${provider.apiKeyEnv} from your environment.`),
        );
        printError(ui.dim('  That takes precedence. Unset it first, or change the variable.'));
        return 1;
      }

      print();
      print(ui.title(`API key  ${ui.dim(provider.label)}`));
      const preset = presetById(id);
      if (preset?.keyUrl) print(ui.dim(`  Get a key: ${preset.keyUrl}`));
      print(ui.dim('  Input is hidden and stored 0600 in ~/.orbit/credentials.'));
      print();

      const key = await askSecret('API key');
      if (!key) {
        printError(ui.warn('No key entered; nothing changed.'));
        return 1;
      }
      await config.setApiKey(id, key);
      print(ui.ok(`Key updated for ${provider.label}. ${maskKey(config.apiKey(id))}`));
      return 0;
    }

    default:
      printError(ui.error(`Unknown provider command "${action}". Try: list, add, key, remove, use.`));
      return 1;
  }
}

async function modelCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action, target] = args;
  const provider = config.activeProvider();

  if (!provider) {
    printError(ui.error('No provider configured. Run: orbit provider add'));
    return 1;
  }

  if (!action || action === 'list') {
    print();
    print(ui.title(`Models  ${ui.dim(provider.label)}`));
    print();

    let models = provider.models;
    try {
      const instance = createProvider({
        config: provider,
        apiKey: config.apiKey(provider.id),
        model: provider.model ?? provider.models[0] ?? 'placeholder',
      });
      const fetched = await instance.listModels?.();
      if (fetched?.length) models = fetched.map((model) => model.id);
    } catch (error) {
      print(ui.dim(`Could not reach the provider (${errorMessage(error)}); showing the saved list.`));
    }

    if (models.length === 0) {
      print(ui.warn('  No models available. Set one with: orbit model use <model>'));
    }
    for (const model of models.slice(0, 100)) {
      const marker = model === provider.model ? ui.accent('●') : ' ';
      print(`  ${marker} ${model}`);
    }
    print();
    return 0;
  }

  if (action === 'use') {
    if (!target) {
      printError(ui.error('Usage: orbit model use <model>'));
      return 1;
    }
    await config.useModel(target);
    print(ui.ok(`Model set to ${target}.`));
    return 0;
  }

  // The window is asked of the provider first and only guessed from the model
  // name as a last resort. This command reports which of those happened, and
  // lets the user override it when neither is right.
  if (action === 'context') {
    const activeModel = provider.model ?? provider.models[0] ?? '';
    const cache = await WindowCache.load();
    const preset = presetById(provider.id)?.contextWindow;

    const resolve = (explicit?: number): WindowResolution =>
      resolveWindow({ providerId: provider.id, model: activeModel, explicit, preset, cache });

    /** Ask the provider directly. Returns undefined when it will not say. */
    const askProvider = async (): Promise<WindowResolution | undefined> => {
      try {
        const instance = createProvider({
          config: { ...provider, contextWindow: undefined },
          apiKey: config.apiKey(provider.id),
          model: activeModel,
        });
        const found = await detectWindow({
          provider: instance,
          providerId: provider.id,
          model: activeModel,
          cache,
          allowProbe: config.get().optimizer.probeWindow,
        });
        await cache.save();
        return found;
      } catch (error) {
        print(ui.dim(`Could not reach ${provider.label} (${errorMessage(error)}).`));
        return undefined;
      }
    };

    const report = (resolved: WindowResolution): void => {
      print();
      print(`  ${ui.label('Model')}           ${ui.value(activeModel || 'none selected')}`);
      print(
        `  ${ui.label('Context window')}  ${ui.value(`${resolved.tokens.toLocaleString()} tokens`)}  ${ui.dim(
          `(${describeWindowSource(resolved.source, provider.label)})`,
        )}`,
      );
      if (resolved.source === 'name' || resolved.source === 'preset') {
        print();
        print(ui.dim(`  ${provider.label} would not say what ${activeModel}'s window is, so this is`));
        print(ui.dim('  a fallback. If you know the real figure, set it and Orbit will use it.'));
      }
      print();
      print(ui.dim('  Set with:       orbit model context <tokens>'));
      print(ui.dim('  Ask again with: orbit model context detect'));
      print(ui.dim('  Clear an override: orbit model context auto'));
      print();
    };

    // No argument: show what is in force. Nothing authoritative is known yet,
    // so ask the provider rather than telling the user to run a second command.
    if (!target) {
      let resolved = resolve(provider.contextWindow);
      if (
        (resolved.source === 'name' || resolved.source === 'preset') &&
        config.get().optimizer.autoDetectWindow &&
        activeModel
      ) {
        print(ui.dim(`Asking ${provider.label} about ${activeModel}…`));
        resolved = (await askProvider()) ?? resolved;
      }
      report(resolved);
      return 0;
    }

    if (target === 'auto' || target === 'detect') {
      if (provider.contextWindow !== undefined) {
        await config.update((draft) => {
          const entry = draft.providers[provider.id];
          if (entry) delete entry.contextWindow;
        });
        print(ui.ok('Override cleared.'));
      }
      // `detect` also discards what the provider said last time, so a model
      // whose window changed server-side is picked up.
      if (target === 'detect') cache.forget(provider.id, activeModel);

      const found = activeModel ? await askProvider() : undefined;
      if (found) {
        print(
          ui.ok(
            `${provider.label} reports ${found.tokens.toLocaleString()} tokens for ${activeModel}.`,
          ),
        );
      }
      report(found ?? resolve());
      return 0;
    }

    // `up`/`down` step the ladder, `+N`/`-N` nudge, a bare number sets it.
    // All three are relative to whatever is in force right now, detected or not.
    const inForce = resolve(provider.contextWindow).tokens;
    const tokens = parseWindowArgument(target, inForce);
    if (tokens === undefined) {
      printError(ui.error(`Cannot use "${target}" as a context window.`));
      print(ui.dim('  It must parse to a number of tokens between 1,024 and 50,000,000.'));
      print();
      print(ui.dim('  orbit model context 1000000     an exact number (1m and 128k also work)'));
      print(ui.dim('  orbit model context up          one step larger'));
      print(ui.dim('  orbit model context down        one step smaller'));
      print(ui.dim('  orbit model context +50000      relative to the current window'));
      print(ui.dim('  orbit model context detect      ask the provider'));
      print(ui.dim('  orbit model context auto        drop the override'));
      return 1;
    }

    if (tokens === inForce) {
      print(ui.ok(`Already at ${tokens.toLocaleString()} tokens.`));
      return 0;
    }

    await config.update((draft) => {
      const entry = draft.providers[provider.id];
      if (entry) entry.contextWindow = tokens;
    });
    const direction = tokens > inForce ? 'Raised' : 'Lowered';
    print(
      ui.ok(
        `${direction} ${provider.label}'s context window: ${inForce.toLocaleString()} → ${tokens.toLocaleString()} tokens.`,
      ),
    );
    print(
      ui.dim(
        '  The optimizer will scale reply and tool budgets to match. If the provider rejects requests, lower it.',
      ),
    );
    return 0;
  }

  // `orbit model <name>` is a convenient shorthand for `orbit model use <name>`.
  await config.useModel(action);
  print(ui.ok(`Model set to ${action}.`));
  return 0;
}

async function webCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action = 'status', ...rest] = args;
  const web = config.get().web;

  switch (action) {
    case 'key': {
      const inline = rest.join(' ').trim();
      let key = inline;
      if (!key) {
        if (!isInteractive()) {
          printError(ui.error('orbit web key needs an interactive terminal, or pass the key inline.'));
          return 1;
        }
        print(ui.dim('Get a key at https://tavily.com — it looks like tvly-...'));
        key = await askSecret('Tavily API key');
      }
      if (!key) {
        printError(ui.warn('No key entered.'));
        return 1;
      }
      await config.setServiceKey('tavily', key);
      await config.update((draft) => {
        draft.web.enabled = true;
      });
      print(ui.ok('Tavily key saved. Web search and fetch are enabled.'));
      print(ui.dim('  Stored in ~/.orbit/credentials, never printed or logged.'));
      return 0;
    }

    case 'remove': {
      await config.deleteServiceKey('tavily');
      print(ui.ok('Tavily key removed.'));
      return 0;
    }

    case 'off':
    case 'on': {
      await config.update((draft) => {
        draft.web.enabled = action === 'on';
      });
      print(ui.ok(`Web access ${action}.`));
      return 0;
    }

    default: {
      const source = config.serviceKeySource('tavily', web.apiKeyEnv);
      print();
      print(ui.title('Web access'));
      print();
      table([
        ['Provider', web.provider],
        ['Enabled', web.enabled ? 'yes' : 'no'],
        [
          'API key',
          source === 'env'
            ? `from ${web.apiKeyEnv}`
            : source === 'store'
              ? maskKey(config.serviceKey('tavily', web.apiKeyEnv))
              : 'not set',
        ],
        ['Results', `${web.maxResults} per search (${web.searchDepth})`],
      ]);
      print();
      if (source === 'none') print(ui.dim('  Add a key with: orbit web key'));
      print();
      return 0;
    }
  }
}

async function mcpCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action = 'list', id, ...rest] = args;
  const servers = config.get().mcp.servers;

  switch (action) {
    case 'add': {
      if (!id || rest.length === 0) {
        printError(ui.error('Usage: orbit mcp add <id> <command> [args...]'));
        printError(ui.dim('  e.g. orbit mcp add fs npx -y @modelcontextprotocol/server-filesystem .'));
        return 1;
      }
      await config.update((draft) => {
        draft.mcp.servers[id] = {
          command: rest[0]!,
          args: rest.slice(1),
          env: {},
          enabled: true,
          transport: 'stdio',
          timeoutMs: 30_000,
        };
      });
      print(ui.ok(`Added MCP server "${id}". It will start with your next session.`));
      return 0;
    }

    case 'remove': {
      if (!id) {
        printError(ui.error('Usage: orbit mcp remove <id>'));
        return 1;
      }
      await config.update((draft) => {
        delete draft.mcp.servers[id];
      });
      print(ui.ok(`Removed MCP server "${id}".`));
      return 0;
    }

    case 'test': {
      const entries = id ? [[id, servers[id]] as const] : Object.entries(servers);
      if (entries.length === 0 || !entries[0]?.[1]) {
        printError(ui.error(id ? `No MCP server "${id}".` : 'No MCP servers configured.'));
        return 1;
      }
      print(ui.dim('Starting servers…'));
      const result = await startMcpServers({
        servers: Object.fromEntries(entries.filter(([, value]) => value)) as typeof servers,
      });
      for (const client of result.clients) {
        print(ui.ok(`${client.id}: ${client.name} — ${client.listTools().length} tools`));
        for (const tool of client.listTools()) {
          print(ui.dim(`    ${tool.name}`));
        }
      }
      for (const failure of result.failures) {
        printError(ui.error(`${failure.id}: ${failure.error}`));
      }
      await stopMcpServers(result.clients);
      return result.failures.length > 0 ? 1 : 0;
    }

    default: {
      const entries = Object.entries(servers);
      if (entries.length === 0) {
        print(ui.warn('No MCP servers configured.'));
        print(ui.dim('  Add one with: orbit mcp add <id> <command> [args...]'));
        return 0;
      }
      print();
      print(ui.title('MCP servers'));
      print();
      for (const [serverId, server] of entries) {
        const state = server.enabled ? ui.ok('enabled') : ui.dim('disabled');
        print(`  ${ui.value(serverId.padEnd(16))} ${state}  ${ui.dim([server.command, ...server.args].join(' '))}`);
      }
      print();
      print(ui.dim('  Verify one with: orbit mcp test <id>'));
      print();
      return 0;
    }
  }
}

async function sessionsCommand(sessions: SessionManager): Promise<number> {
  const list = await sessions.list({ limit: 40 });
  if (list.length === 0) {
    print(ui.dim('No saved sessions.'));
    return 0;
  }
  print();
  print(ui.title(`Sessions  ${ui.dim(tildify(orbitPaths.sessions))}`));
  print();
  for (const session of list) {
    print(
      `  ${ui.value(session.id.padEnd(32))} ${ui.dim(formatRelativeTime(session.updatedAt).padEnd(10))} ${ui.dim(
        `${pluralize(session.messageCount, 'message')} · ${session.model}`,
      )}`,
    );
    print(`  ${ui.dim(' '.repeat(32) + tildify(session.workspace))}`);
  }
  print();
  print(ui.dim('  Resume with: orbit resume <id>'));
  print();
  return 0;
}

async function clearCommand(sessions: SessionManager): Promise<number> {
  const list = await sessions.list();
  if (list.length === 0) {
    print(ui.dim('No sessions to delete.'));
    return 0;
  }
  const yes =
    !isInteractive() || (await confirm(`Delete ${pluralize(list.length, 'saved session')}?`, false));
  if (!yes) return 0;
  const removed = await sessions.deleteAll();
  print(ui.ok(`Deleted ${pluralize(removed, 'session')}.`));
  return 0;
}

// ── main TUI ───────────────────────────────────────────────────────────────

interface StartOptions {
  config: ConfigManager;
  sessions: SessionManager;
  workspaceRoot: string;
  modelOverride?: string;
  providerOverride?: string;
  resumeId?: string | true;
  initialPrompt?: string;
  showBanner: boolean;
  debug: boolean;
  /** Start with auto-working mode on (`--auto`). */
  autoMode?: boolean;
  /** Disable adaptive token budgeting for this run (`--no-optimize`). */
  optimize?: boolean;
  /** Palette override for this run. */
  themeName?: string;
  /** Play the launch animation. */
  animate?: boolean;
  /** Non-interactive run: prompt in, answer out, exit code. */
  headless?: {
    prompt: string;
    output: HeadlessOutput;
    verbose: boolean;
    autoApprove: boolean;
  };
  colorMode: 'auto' | 'never';
  unicodeMode: 'auto' | 'off';
}

/**
 * Resolve with the promise's value if it settles in time, otherwise
 * `undefined`. The promise is left running — the caller decides what to do
 * with a late answer — so nothing is cancelled or lost.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startInteractive(options: StartOptions): Promise<number> {
  const { config, sessions } = options;

  const providerId = options.providerOverride ?? config.get().activeProvider;
  const providerConfig = providerId ? config.getProvider(providerId) : config.activeProvider();

  if (!providerConfig) {
    printError(ui.error('No provider configured.'));
    printError(ui.dim('Run: orbit provider add'));
    return 1;
  }

  const model = options.modelOverride ?? providerConfig.model;
  if (!model) {
    printError(ui.error(`No model selected for ${providerConfig.label}.`));
    printError(ui.dim('Run: orbit model use <model>'));
    return 1;
  }

  let provider: AIProvider;
  try {
    provider = createProvider({
      config: providerConfig,
      apiKey: config.apiKey(providerConfig.id),
      model,
    });
  } catch (error) {
    reportStartupError(error);
    return 1;
  }

  // ── context window ──
  // The window drives every budget in the session, so it is worth asking the
  // provider rather than inferring it from the model name. Detection starts
  // here and is collected just before the UI mounts, so it overlaps with the
  // rest of startup (MCP servers, git state) and usually costs nothing.
  const windowCache = await WindowCache.load();
  const windowFor = (target: AIProvider, targetModel: string): WindowResolution =>
    resolveWindow({
      providerId: target.id,
      model: targetModel,
      explicit: config.getProvider(target.id)?.contextWindow,
      preset: presetById(target.id)?.contextWindow,
      cache: windowCache,
    });

  /**
   * Ask the provider for a model's real window. Skipped entirely when the user
   * has set one explicitly — their number is not something to second-guess.
   */
  const detectWindowFor = async (
    target: AIProvider,
    targetModel: string,
  ): Promise<WindowResolution | undefined> => {
    const optimizer = config.get().optimizer;
    if (!optimizer.autoDetectWindow) return undefined;
    if (config.getProvider(target.id)?.contextWindow) return undefined;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const found = await detectWindow({
        provider: target,
        providerId: target.id,
        model: targetModel,
        cache: windowCache,
        allowProbe: optimizer.probeWindow,
        signal: abort.signal,
      });
      await windowCache.save();
      return found;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const detection = detectWindowFor(provider, model);

  // ── workspace ──
  const sandbox = new Sandbox({
    root: options.workspaceRoot,
    extraIgnore: config.get().tools.extraIgnore,
  });

  const warnings: string[] = [];
  const workspace = await detectWorkspace(sandbox.root);
  const git = await readGitState(sandbox.root);

  if (!provider.supportsVision(model)) {
    warnings.push(`${model} does not support image input.`);
  }
  if (!provider.supportsTools(model)) {
    warnings.push(`${model} has no native tool calling; Orbit will use its text tool protocol.`);
  }
  if (!(await isCommandAvailable('rg'))) {
    warnings.push('ripgrep (rg) not found — using the slower built-in search.');
  }
  if (git.isRepo && git.files.length > 0) {
    warnings.push(`Git: ${summarizeGitState(git)}.`);
  }

  // ── runtime pieces ──
  const permissions = new PermissionManager({ policy: config.permissions() });
  const planner = new Planner();
  const background = new BackgroundRegistry();
  const autoMode = new AutoMode({
    ...config.get().autoMode,
    enabled: options.autoMode ?? config.get().autoMode.enabled,
  });
  const usageTracker = new UsageTracker();
  await usageTracker.load();

  // Hooks come from the user's own config only — never from the workspace —
  // so opening a cloned repository cannot run anything.
  const hooks = new HookRunner(config.get().hooks);

  const runtimeConfig = config.get();
  if (options.optimize === false) runtimeConfig.optimizer.enabled = false;

  // Web tools are registered only when a key exists, so the model is never
  // offered a capability that will fail on first use.
  const webKey = config.serviceKey('tavily', runtimeConfig.web.apiKeyEnv);
  const webAvailable = runtimeConfig.web.enabled && Boolean(webKey);

  // MCP servers extend the tool set; a server that fails to start is reported
  // and skipped rather than taking the session down with it.
  const mcp = await startMcpServers(runtimeConfig.mcp);
  for (const failure of mcp.failures) {
    warnings.push(`MCP server "${failure.id}" did not start: ${failure.error}`);
  }
  if (mcp.clients.length > 0) {
    warnings.push(`MCP: ${describeMcpServers(mcp.clients)}. These run outside the workspace sandbox.`);
  }

  const registry = buildToolRegistry({
    includeWeb: webAvailable,
    extraTools: [
      createPlanTool(planner),
      ...(runtimeConfig.subagents.enabled ? [taskTool] : []),
      ...mcp.tools,
    ],
  });

  let session;
  if (options.resumeId) {
    const record =
      typeof options.resumeId === 'string'
        ? await sessions.load(options.resumeId)
        : await sessions.latest(sandbox.root);
    if (record) {
      session = record;
    } else {
      warnings.push(
        typeof options.resumeId === 'string'
          ? `No session matched "${options.resumeId}"; starting a new one.`
          : 'No previous session for this workspace; starting a new one.',
      );
    }
  }

  // The session record is created here rather than inside the Agent so the
  // checkpoint history can be keyed to it — and so resuming a session resumes
  // its undo history too.
  session ??= newSessionRecord({
    workspace: sandbox.root,
    provider: { id: provider.id, label: providerConfig.label, model },
  });

  const checkpoints = new CheckpointManager({
    config: runtimeConfig.checkpoints,
    sessionId: session.id,
    workspaceRoot: sandbox.root,
  });
  await checkpoints.load();

  const agent = new Agent({
    provider,
    model,
    config: runtimeConfig,
    sandbox,
    permissions,
    registry,
    planner,
    workspace,
    git,
    sessions,
    session,
    providerLabel: providerConfig.label,
    usageTracker,
    checkpoints,
    background,
    webApiKey: webKey,
    resolveWindow: windowFor,
    detectWindow: detectWindowFor,
    hooks,
    /**
     * Build a fallback provider on demand. A provider with no key is not a
     * candidate: switching to it would swap one failure for another.
     */
    providerFor: (id) => {
      const target = config.getProvider(id);
      if (!target?.model) return undefined;
      if (!config.hasApiKey(id) && !isLocalEndpoint(target.baseURL)) return undefined;
      try {
        return {
          provider: createProvider({
            config: target,
            apiKey: config.apiKey(id),
            model: target.model,
          }),
          model: target.model,
          label: target.label,
        };
      } catch {
        return undefined;
      }
    },
  });
  await agent.initialize();

  // Collect detection with a short budget: a wrong window costs quality all
  // session, but a slow launch is felt immediately. Anything that arrives
  // later is applied to the live session instead.
  const detected = await settleWithin(detection, 2500);
  if (detected) {
    agent.applyContextWindow(detected);
  } else {
    void detection.then((late) => {
      if (late) agent.applyContextWindow(late);
    });
  }

  // Hook output goes to stderr so it cannot be confused with Orbit's own
  // reporting, and so `--print` stdout stays machine-readable.
  hooks.onOutcome((outcome) => {
    const label = describeHook(outcome.hook);
    if (outcome.error) {
      printError(ui.warn(`Hook "${label}" could not run: ${outcome.error}`));
      return;
    }
    if (outcome.timedOut) {
      printError(ui.warn(`Hook "${label}" timed out after ${outcome.hook.timeoutMs}ms.`));
      return;
    }
    if (outcome.code !== 0) {
      printError(ui.warn(`Hook "${label}" exited ${String(outcome.code)}.`));
    }
    if (outcome.output && (outcome.hook.showOutput || outcome.code !== 0)) {
      for (const line of outcome.output.split('\n').slice(0, 20)) {
        printError(ui.dim(`  ${line}`));
      }
    }
  });

  for (const issue of config.validationIssues()) {
    warnings.push(
      `Config section "${issue.section}" was unusable and is running on defaults (${issue.message}).`,
    );
  }

  const failover = config.get().failover;
  if (failover.providers.length > 0) {
    const usable = failover.providers.filter(
      (id) => config.getProvider(id) && (config.hasApiKey(id) || isLocalEndpoint(config.getProvider(id)!.baseURL)),
    );
    if (usable.length === 0) {
      warnings.push(
        `Failover lists ${failover.providers.join(', ')}, but none are usable (missing provider or key).`,
      );
    } else {
      warnings.push(`Failover ready: ${usable.join(' → ')} if ${providerConfig.label} fails.`);
    }
  }

  if (hooks.count() > 0) {
    warnings.push(
      `${pluralize(hooks.count(), 'lifecycle hook')} configured. Review them with: orbit hooks`,
    );
  }
  await agent.runHooks('session-start');

  const activeWindow = agent.context.getContextWindow();
  if (agent.contextWindowSource() === 'name') {
    // Stated plainly: the budget is a guess, and there is a command to fix it.
    warnings.push(
      `Context window assumed to be ${activeWindow.toLocaleString()} tokens (${providerConfig.label} did not say). Run: orbit model context`,
    );
  }

  if (runtimeConfig.web.enabled && !webKey) {
    warnings.push('Web search is configured but has no Tavily key. Run: orbit web key');
  }

  if (autoMode.enabled) {
    warnings.push(
      'Auto mode is ON: writes and shell commands run without asking. Ctrl+Shift+A (or Ctrl+G) turns it off.',
    );
  }

  await sessions.prune(config.get().sessions.maxStored);

  const theme = createTheme({
    color: options.colorMode,
    unicode: options.unicodeMode,
    theme: options.themeName ?? runtimeConfig.ui.theme,
  });

  // ── headless: one prompt, one answer, an exit code ──
  if (options.headless) {
    const result = await runHeadless({
      agent,
      autoMode,
      permissions,
      prompt: options.headless.prompt,
      output: options.headless.output,
      verbose: options.headless.verbose,
      autoApprove: options.headless.autoApprove,
    });
    // Headless runs get the same lifecycle as interactive ones — running tests
    // after an agent edit is exactly what a scripted run is for.
    await agent.runHooks('session-end');
    await agent.persist();
    await usageTracker.save();
    background.stopAll();
    await stopMcpServers(mcp.clients);
    return result.exitCode;
  }

  // Ink drives the interactive UI from raw-mode stdin. Without a TTY it throws
  // a React reconciler stack trace in the user's face, so stop here instead and
  // point at the mode that does work without one.
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    printError(ui.error('Orbit needs an interactive terminal.'));
    printError(ui.dim('stdin is not a TTY, which happens when input is piped or redirected.'));
    printError('');
    printError(ui.dim('To run a single prompt without the UI:'));
    printError(ui.dim('  orbit --print -p "your prompt here"'));
    await agent.persist();
    await usageTracker.save();
    background.stopAll();
    await stopMcpServers(mcp.clients);
    return 1;
  }

  const instance = render(
    React.createElement(App, {
      agent,
      config,
      sessions,
      registry,
      permissions,
      sandbox,
      autoMode,
      theme,
      showBanner: options.showBanner,
      showRequestCost: runtimeConfig.ui.requestCost,
      // An intro is only worth playing to a human watching a real terminal.
      animate:
        (options.animate ?? true) &&
        runtimeConfig.ui.animation &&
        Boolean(process.stdout.isTTY) &&
        !process.env.ORBIT_NO_ANIMATION &&
        !options.headless,
      debug: options.debug,
      warnings,
      version: VERSION,
      initialPrompt: options.initialPrompt,
      mcpClients: mcp.clients,
      background,
      createProviderFor: (id: string, overrideModel?: string) => {
        const target = config.getProvider(id);
        if (!target) throw new OrbitError(`No provider with id "${id}".`, { kind: 'config' });
        return {
          provider: createProvider({
            config: target,
            apiKey: config.apiKey(id),
            model: overrideModel ?? target.model,
          }),
          label: target.label,
        };
      },
    }),
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
  await agent.runHooks('session-end');
  await agent.persist();
  await usageTracker.save();
  // Nothing Orbit started outlives Orbit.
  const stopped = background.stopAll();
  if (stopped > 0) print(ui.dim(`Stopped ${stopped} background process(es).`));
  await stopMcpServers(mcp.clients);
  return 0;
}

/**
 * Inspect and try out lifecycle hooks.
 *
 * There is deliberately no `hooks add`: a hook is a shell command that Orbit
 * will run on your behalf, so it should be written into `~/.orbit/config.json`
 * deliberately rather than assembled from command-line arguments.
 */
async function hooksCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action, target] = args;
  const hooksConfig = config.get().hooks;
  const entries = hooksConfig.entries;

  if (!action || action === 'list') {
    print();
    print(ui.title(`Hooks  ${ui.dim(hooksConfig.enabled ? '' : '(all disabled)')}`));
    print();

    if (entries.length === 0) {
      print(ui.dim('  None configured.'));
      print();
      print(ui.dim(`  Hooks live under "hooks" in ${tildify(orbitPaths.config)}:`));
      print();
      print(ui.dim('    "hooks": {'));
      print(ui.dim('      "entries": ['));
      print(ui.dim('        {'));
      print(ui.dim('          "name": "format",'));
      print(ui.dim('          "on": "post-tool",'));
      print(ui.dim('          "tools": ["write_file", "edit_file"],'));
      print(ui.dim('          "command": "npx prettier --write \\"$ORBIT_FILE\\""'));
      print(ui.dim('        },'));
      print(ui.dim('        { "name": "test", "on": "turn-end", "command": "npm test", "showOutput": true }'));
      print(ui.dim('      ]'));
      print(ui.dim('    }'));
      print();
      print(ui.dim(`  Events: ${HOOK_EVENTS.join(', ')}`));
      print();
      return 0;
    }

    for (const [index, hook] of entries.entries()) {
      const marker = hook.enabled && hooksConfig.enabled ? ui.accent('●') : ui.dim('○');
      const flags: string[] = [];
      if (hook.tools.length > 0) flags.push(hook.tools.join(', '));
      if (hook.blocking) flags.push('blocking');
      if (hook.showOutput) flags.push('shows output');
      if (!hook.enabled) flags.push('disabled');

      print(`  ${marker} ${String(index + 1).padStart(2)}. ${ui.value(describeHook(hook))}`);
      print(`       ${ui.dim(hook.on)}  ${ui.dim(hook.command)}`);
      if (flags.length > 0) print(`       ${ui.dim(flags.join('  ·  '))}`);
    }
    print();
    print(ui.dim('  Try one with: orbit hooks test <number>'));
    print();
    return 0;
  }

  if (action === 'test') {
    const index = Number.parseInt(target ?? '', 10) - 1;
    const hook = entries[index];
    if (!hook) {
      printError(ui.error(`No hook ${target ?? ''}. Run: orbit hooks list`));
      return 1;
    }

    // A tool hook needs a tool name to match against. The third argument wins;
    // otherwise pick a real tool the hook's matcher accepts — a regex entry is
    // a pattern, not a name, so it cannot stand in for one.
    const isToolHook = hook.on === 'pre-tool' || hook.on === 'post-tool';
    let tool = args[2];
    if (isToolHook && !tool) {
      const available = buildToolRegistry({})
        .definitions()
        .map((definition) => definition.name);
      tool = available.find((name) => hookMatchesTool(hook, name));
      if (!tool) {
        printError(ui.error(`No tool matches ${hook.tools.join(', ')}, so this hook can never run.`));
        print(ui.dim('  Name a tool explicitly to test anyway: orbit hooks test <n> <tool>'));
        return 1;
      }
    }

    print(ui.dim(`Running "${describeHook(hook)}"${tool ? ` against ${tool}` : ''}…`));
    const runner = new HookRunner({ enabled: true, entries: [{ ...hook, enabled: true }] });
    const outcomes = await runner.run(hook.on, {
      event: hook.on,
      workspace: process.cwd(),
      sessionId: 'hook-test',
      model: config.activeProvider()?.model ?? 'none',
      provider: config.activeProvider()?.label ?? 'none',
      // Stand-ins so a tool hook has something to act on without a real call.
      ...(isToolHook && tool
        ? { tool, file: path.join(process.cwd(), 'example.txt'), ok: true }
        : {}),
    });

    const outcome = outcomes[0];
    if (!outcome) {
      printError(
        ui.error(
          tool
            ? `The hook's tool filter (${hook.tools.join(', ')}) does not match "${tool}", so nothing ran.`
            : 'The hook did not match its own event, so nothing ran.',
        ),
      );
      return 1;
    }
    print();
    if (outcome.output) print(outcome.output);
    print();
    if (outcome.error) {
      printError(ui.error(`Could not run it: ${outcome.error}`));
      return 1;
    }
    if (outcome.timedOut) {
      printError(ui.error(`Timed out after ${hook.timeoutMs}ms.`));
      return 1;
    }
    if (outcome.code === 0) {
      print(ui.ok(`Exited 0 in ${outcome.durationMs}ms.`));
      return 0;
    }
    printError(ui.warn(`Exited ${String(outcome.code)} in ${outcome.durationMs}ms.`));
    if (hook.blocking && hook.on === 'pre-tool') {
      print(ui.dim('  As a blocking pre-tool hook, that would refuse the tool call.'));
    }
    return 1;
  }

  printError(ui.error(`Unknown hooks command "${action}". Try: list, test <number>.`));
  return 1;
}

/**
 * Show and fill in model rates.
 *
 * Orbit still ships no rate table — prices change and a stale number is worse
 * than none. What it can do is ask: OpenRouter publishes machine-readable
 * prices, and a local endpoint costs nothing by definition. Everything else is
 * typed in, and every rate says where it came from.
 */
async function pricingCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const pricing = config.get().pricing;

  if (!action || action === 'list') {
    const entries = Object.entries(pricing);
    print();
    print(ui.title('Model pricing'));
    print();
    if (entries.length === 0) {
      print(ui.dim('  No rates set, so /usage shows token counts without costs.'));
      print();
      print(ui.dim('  orbit pricing import          fill in what the provider publishes'));
      print(ui.dim('  orbit pricing set <key> <in> <out>   enter a rate yourself'));
      print();
      return 0;
    }
    const width = Math.max(...entries.map(([key]) => key.length));
    for (const [key, entry] of entries) {
      print(`  ${ui.value(key.padEnd(width))}  ${ui.dim(describePrice(entry))}`);
    }
    print();
    print(ui.dim('  Costs appear in /usage and in `orbit config`.'));
    print();
    return 0;
  }

  if (action === 'set') {
    const [key, input, output, currency] = rest;
    const inputPerMillion = Number(input);
    const outputPerMillion = Number(output);
    if (!key || !Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) {
      printError(ui.error('Usage: orbit pricing set <Provider:model> <input> <output> [currency]'));
      print(ui.dim('  Prices are per million tokens, as vendors quote them.'));
      print(ui.dim('  Example: orbit pricing set "DeepSeek:deepseek-chat" 0.27 1.10'));
      return 1;
    }
    await config.update((draft) => {
      draft.pricing[key] = {
        inputPerMillion,
        outputPerMillion,
        currency: (currency ?? 'USD').toUpperCase(),
      };
    });
    print(ui.ok(`${key}: ${describePrice(config.get().pricing[key]!)}`));
    return 0;
  }

  if (action === 'clear') {
    const key = rest[0];
    await config.update((draft) => {
      if (key) delete draft.pricing[key];
      else draft.pricing = {};
    });
    print(ui.ok(key ? `Cleared the rate for ${key}.` : 'Cleared every rate.'));
    return 0;
  }

  if (action === 'import') {
    const target = rest[0] ? config.getProvider(rest[0]) : config.activeProvider();
    if (!target) {
      printError(ui.error('No provider to import for. Run: orbit provider add'));
      return 1;
    }

    print(ui.dim(`Asking ${target.label} what it charges…`));
    let catalogue = new Map<string, PricingEntry>();
    let askFailed: string | undefined;
    try {
      catalogue = await fetchCataloguePricing({
        baseURL: target.baseURL,
        apiKey: config.apiKey(target.id),
        providerName: target.label,
      });
    } catch (error) {
      askFailed = errorMessage(error);
    }

    if (catalogue.size === 0) {
      // Only now consider the endpoint's address. Asking first matters: a paid
      // API reached through a proxy on localhost would otherwise be priced at
      // zero on the strength of its hostname.
      if (isLocalProvider(target.baseURL)) {
        const models = [...new Set([target.model, ...target.models].filter(Boolean))] as string[];
        await config.update((draft) => {
          for (const model of models) draft.pricing[`${target.label}:${model}`] = FREE;
        });
        print(
          ui.ok(
            `${target.label} publishes no prices and runs on a local address — ${pluralize(models.length, 'model')} priced at zero.`,
          ),
        );
        print(
          ui.dim(
            '  If that endpoint forwards to a paid API, set the real rate: orbit pricing set <key> <in> <out>',
          ),
        );
        return 0;
      }

      printError(
        ui.warn(
          askFailed
            ? `${target.label} does not publish prices (${askFailed}).`
            : `${target.label} returned no prices.`,
        ),
      );
      print(ui.dim('  Only OpenRouter-style catalogues do. Enter rates with:'));
      print(ui.dim(`  orbit pricing set "${target.label}:${target.model ?? '<model>'}" <in> <out>`));
      return 1;
    }

    // Only price the models this provider is actually configured with, rather
    // than importing a catalogue of thousands.
    const wanted = [...new Set([target.model, ...target.models].filter(Boolean))] as string[];
    const found: DiscoveredPrice[] = [];
    const missed: string[] = [];

    for (const model of wanted) {
      const match = matchCatalogueModel(model, catalogue);
      if (!match) {
        missed.push(model);
        continue;
      }
      found.push({
        key: `${target.label}:${model}`,
        model,
        entry: match.entry,
        authority: match.id === model ? 'provider' : 'catalogue',
      });
    }

    if (found.length === 0) {
      printError(ui.warn(`None of ${target.label}'s configured models appear in its catalogue.`));
      return 1;
    }

    await config.update((draft) => {
      draft.pricing = mergePricing(draft.pricing, found);
    });

    print();
    for (const price of found) {
      print(`  ${ui.ok('set')} ${ui.value(price.key)}  ${ui.dim(describePrice(price.entry))}`);
    }
    if (missed.length > 0) {
      print();
      print(ui.dim(`  Not listed, so left unpriced: ${missed.join(', ')}`));
    }
    print();
    print(ui.dim('  Thinking tokens are billed as output, and are counted there.'));
    print();
    return 0;
  }

  printError(ui.error(`Unknown pricing command "${action}". Try: list, import, set, clear.`));
  return 1;
}

/**
 * Manage the provider fallback chain.
 *
 * Deliberately a list of ids rather than a policy language: the useful question
 * is "who else could answer this", and the answer is a provider you have already
 * configured and paid for.
 */
async function failoverCommand(config: ConfigManager, args: string[]): Promise<number> {
  const [action, target] = args;
  const current = config.get().failover;
  const active = config.get().activeProvider;

  const describe = (id: string): string => {
    const provider = config.getProvider(id);
    if (!provider) return `${id}  ${ui.dim('(not configured)')}`;
    const local = isLocalEndpoint(provider.baseURL);
    const ready = config.hasApiKey(id) || local;
    return `${id}  ${ui.dim(`${provider.model ?? 'no model'} · ${ready ? 'ready' : 'no key'}`)}`;
  };

  if (!action || action === 'list') {
    print();
    print(ui.title('Failover'));
    print();
    if (current.providers.length === 0) {
      print(ui.dim('  Off. A request that fails is reported and the turn stops.'));
      print();
      print(ui.dim('  orbit failover add <provider>     try this one when the active provider fails'));
      print(ui.dim('  orbit provider list               see the ids you have configured'));
      print();
      return 0;
    }
    print(`  ${ui.label('Active')}    ${ui.value(active ?? 'none')}`);
    print(`  ${ui.label('Then')}      ${current.providers.map(describe).join(`
            `)}`);
    print(`  ${ui.label('When')}      ${ui.value(current.on.join(', '))}`);
    print(
      `  ${ui.label('Next turn')} ${ui.value(current.returnToPrimary ? 'back to the active provider' : 'stay on the fallback')}`,
    );
    print();
    print(ui.dim('  A 400 never triggers a switch: the request is at fault, not the provider.'));
    print();
    return 0;
  }

  if (action === 'add') {
    if (!target) {
      printError(ui.error('Usage: orbit failover add <provider>'));
      return 1;
    }
    if (!config.getProvider(target)) {
      printError(ui.error(`No provider with id "${target}". See: orbit provider list`));
      return 1;
    }
    if (target === active) {
      printError(ui.error(`"${target}" is the active provider — it cannot fall back to itself.`));
      return 1;
    }
    if (current.providers.includes(target)) {
      print(ui.dim(`Already in the chain.`));
      return 0;
    }
    await config.update((draft) => {
      draft.failover.providers.push(target);
    });
    print(ui.ok(`Failover chain: ${config.get().failover.providers.join(' → ')}`));
    if (!config.hasApiKey(target) && !isLocalEndpoint(config.getProvider(target)!.baseURL)) {
      print(ui.warn(`  "${target}" has no key yet, so it would fail too. Run: orbit provider key ${target}`));
    }
    return 0;
  }

  if (action === 'remove') {
    if (!target) {
      printError(ui.error('Usage: orbit failover remove <provider>'));
      return 1;
    }
    await config.update((draft) => {
      draft.failover.providers = draft.failover.providers.filter((id) => id !== target);
    });
    const left = config.get().failover.providers;
    print(ui.ok(left.length > 0 ? `Failover chain: ${left.join(' → ')}` : 'Failover is off.'));
    return 0;
  }

  if (action === 'off' || action === 'clear') {
    await config.update((draft) => {
      draft.failover.providers = [];
    });
    print(ui.ok('Failover is off.'));
    return 0;
  }

  printError(ui.error(`Unknown failover command "${action}". Try: list, add, remove, off.`));
  return 1;
}

function reportStartupError(error: unknown): void {
  if (error instanceof OrbitError) {
    printError('');
    printError(ui.error(error.message));
    if (error.detail) printError(ui.dim(`  ${error.detail}`));
    for (const hint of error.hints) printError(ui.dim(`  → ${hint}`));
    printError('');
    return;
  }
  printError(ui.error(errorMessage(error)));
}

async function resolveWorkspace(input: string | undefined): Promise<string> {
  const target = path.resolve(input ?? process.cwd());
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    throw new OrbitError(`Directory not found: ${tildify(target)}`, {
      kind: 'config',
      hints: ['Create it first, or point Orbit at an existing directory.'],
    });
  }
  if (!stat.isDirectory()) {
    throw new OrbitError(`Not a directory: ${tildify(target)}`, { kind: 'config' });
  }
  return target;
}

function parseOutputFormat(value: string | boolean | undefined): HeadlessOutput {
  if (value === 'json') return 'json';
  if (value === 'stream-json') return 'stream-json';
  return 'text';
}

// ── entry point ────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.help) {
    showHelp();
    return 0;
  }
  if (flags.version) {
    print(`orbit ${VERSION}`);
    return 0;
  }

  if (flags.debug) {
    const file = enableDebugLogging();
    print(ui.dim(`Debug log: ${tildify(file)}`));
  }

  await ensureOrbitHome();

  let config: ConfigManager;
  try {
    config = await loadConfig();
  } catch (error) {
    reportStartupError(error);
    return 1;
  }

  // Say it once, before any command runs, so a reset section is never a silent
  // surprise — and so it is visible even for commands that print nothing else.
  const configIssues = config.validationIssues();
  if (configIssues.length > 0) {
    printError(ui.warn(`Parts of ${tildify(orbitPaths.config)} could not be used:`));
    for (const issue of configIssues.slice(0, 6)) {
      printError(ui.dim(`  ${issue.section} — ${issue.message}`));
    }
    printError(
      ui.dim('  Those sections are running on defaults. Everything else loaded normally.'),
    );
    printError(ui.dim('  Fix the file, or run: orbit config'));
    printError('');
  }

  const sessions = new SessionManager();

  switch (command) {
    case 'help':
      showHelp();
      return 0;
    case 'version':
      print(`orbit ${VERSION}`);
      return 0;
    case 'config':
      if (!isInteractive()) {
        printError(ui.error('orbit config needs an interactive terminal.'));
        return 1;
      }
      await runConfigScreen(config);
      return 0;
    case 'provider':
      return providerCommand(config, positional);
    case 'model':
      return modelCommand(config, positional);
    case 'web':
      return webCommand(config, positional);
    case 'hooks':
      return hooksCommand(config, positional);
    case 'pricing':
      return pricingCommand(config, positional);
    case 'failover':
      return failoverCommand(config, positional);
    case 'mcp':
      return mcpCommand(config, positional);
    case 'sessions':
    case 'session':
      return sessionsCommand(sessions);
    case 'clear':
      return clearCommand(sessions);
    default:
      break;
  }

  // `orbit resume [id]` continues into the interactive path below.
  let resumeTarget: string | true | undefined;
  if (command === 'resume') {
    const id = positional[0];
    resumeTarget = id ?? true;
    if (id) positional.shift();
  } else if (typeof flags.resume === 'string') {
    resumeTarget = flags.resume;
  } else if (flags.resume === true) {
    resumeTarget = true;
  }

  // Validate the workspace before setup, so a mistyped path is reported as one.
  let workspaceRoot: string;
  try {
    workspaceRoot = await resolveWorkspace(positional[0]);
  } catch (error) {
    reportStartupError(error);
    return 1;
  }

  // First run: no providers configured yet.
  if (config.listProviders().length === 0) {
    if (!isInteractive()) {
      printError(ui.error('No provider configured and no terminal available for setup.'));
      printError(ui.dim('Run `orbit provider add` in an interactive shell.'));
      return 1;
    }
    const added = await runProviderWizard(config, { firstRun: true });
    if (!added) {
      printError(ui.warn('Setup cancelled.'));
      return 1;
    }
  }

  // `--print` (or piped stdin with a prompt) means nobody is watching a TUI.
  const headlessPrompt =
    flags.print === true || flags.output !== undefined
      ? typeof flags.prompt === 'string'
        ? flags.prompt
        : positional.join(' ').trim() || undefined
      : undefined;

  if ((flags.print === true || flags.output !== undefined) && !headlessPrompt) {
    printError(ui.error('--print needs a prompt: orbit --print -p "your request"'));
    return 1;
  }

  return startInteractive({
    config,
    sessions,
    workspaceRoot,
    modelOverride: typeof flags.model === 'string' ? flags.model : undefined,
    providerOverride: typeof flags.provider === 'string' ? flags.provider : undefined,
    initialPrompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
    resumeId: resumeTarget,
    autoMode: flags.auto === true ? true : undefined,
    optimize: flags.optimize === false ? false : undefined,
    themeName: typeof flags.theme === 'string' ? flags.theme : undefined,
    animate: flags.animation !== false,
    headless: headlessPrompt
      ? {
          prompt: headlessPrompt,
          output: parseOutputFormat(flags.output),
          verbose: flags.verbose === true,
          autoApprove: flags.yes === true || flags.auto === true,
        }
      : undefined,
    showBanner: flags.banner !== false && config.get().ui.banner,
    debug: Boolean(flags.debug),
    colorMode: flags.color === false ? 'never' : 'auto',
    unicodeMode: flags.ascii === true ? 'off' : 'auto',
  });
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      log.error('fatal', { message: errorMessage(error) });
      reportStartupError(error);
      process.exitCode = 1;
    })
    .finally(() => {
      closeLogger();
    });
}
