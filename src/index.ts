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
import { PROVIDER_PRESETS, presetById } from './config/schema.js';
import { createProvider } from './providers/factory.js';
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
  print('  orbit model context <n>      Set the context window explicitly');
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

  // Context windows are guessed from the model name and refined by the
  // provider's /models endpoint. When neither is right — a large-context
  // deployment, a self-hosted build — this sets it explicitly.
  if (action === 'context') {
    if (!target) {
      const current = provider.contextWindow;
      print();
      print(
        `  ${ui.label('Context window')}  ${ui.value(
          current ? `${current.toLocaleString()} tokens (set explicitly)` : 'auto-detected from the model name',
        )}`,
      );
      print(ui.dim('  Set with: orbit model context <tokens>   ·   reset with: orbit model context auto'));
      print();
      return 0;
    }

    if (target === 'auto') {
      await config.update((draft) => {
        const entry = draft.providers[provider.id];
        if (entry) delete entry.contextWindow;
      });
      print(ui.ok('Context window will be detected automatically.'));
      return 0;
    }

    const tokens = Number.parseInt(target.replace(/[_,]/g, ''), 10);
    if (!Number.isInteger(tokens) || tokens < 1024) {
      printError(ui.error('Usage: orbit model context <tokens>   (e.g. 1000000)'));
      return 1;
    }
    await config.update((draft) => {
      const entry = draft.providers[provider.id];
      if (entry) entry.contextWindow = tokens;
    });
    print(ui.ok(`Context window for ${provider.label} set to ${tokens.toLocaleString()} tokens.`));
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
  });
  await agent.initialize();

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
  await agent.persist();
  await usageTracker.save();
  // Nothing Orbit started outlives Orbit.
  const stopped = background.stopAll();
  if (stopped > 0) print(ui.dim(`Stopped ${stopped} background process(es).`));
  await stopMcpServers(mcp.clients);
  return 0;
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
