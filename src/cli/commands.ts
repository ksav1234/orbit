import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Agent } from '../agent/agent.js';
import type { AutoMode } from '../agent/autopilot.js';
import type { ConfigManager } from '../config/manager.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { Sandbox } from '../permissions/sandbox.js';
import type { SessionManager } from '../sessions/manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionPolicy } from '../config/schema.js';
import { THEME_NAMES } from '../config/schema.js';
import type { McpClient } from '../mcp/client.js';
import type { BackgroundRegistry } from '../tools/background.js';
import { errorMessage } from '../util/errors.js';
import { formatWorkspaceInfo } from '../tools/project.js';
import { readGitState, summarizeGitState } from '../tools/git.js';
import { shellInfo } from '../tools/terminal.js';
import { formatCount, formatRelativeTime, pluralize } from '../util/format.js';
import { formatCost } from '../context/usage.js';
import { parseWindowArgument } from '../context/window.js';
import { describeHook } from '../hooks/runner.js';
import { tildify } from '../util/paths.js';
import { maskKey } from '../util/redact.js';
import { logFilePath } from '../util/logger.js';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

/** Everything a slash command is allowed to touch. */
export interface SlashContext {
  agent: Agent;
  config: ConfigManager;
  sessions: SessionManager;
  registry: ToolRegistry;
  permissions: PermissionManager;
  sandbox: Sandbox;
  autoMode: AutoMode;
  /** Flip auto mode and report the new state through the UI. */
  toggleAuto(enabled?: boolean): void;
  /** MCP servers connected for this session. */
  mcpClients: McpClient[];
  /** Background processes started by tools. */
  background?: BackgroundRegistry;
  /** Send a prompt to the model as if the user had typed it. */
  submit(prompt: string): void;
  /** Open the interactive model picker. */
  pickModel(): Promise<void>;
  /** Open the interactive provider picker. */
  pickProvider(): Promise<void>;
  /** Prompt for an API key with hidden input. */
  askApiKey(providerId: string): Promise<void>;
  /** Re-render with a different palette. */
  setTheme(name: string): Promise<void>;
  /** Authorize an extra directory for this session. */
  addWorkspaceRoot(dir: string): Promise<void>;
  /** Append rendered markdown to the transcript. */
  print(markdown: string): void;
  notice(text: string, tone?: NoticeTone): void;
  clearTranscript(): void;
  exit(): void;
  switchModel(model: string): Promise<void>;
  switchProvider(providerId: string): Promise<void>;
  compact(): Promise<void>;
  newSession(): Promise<void>;
  resumeSession(id: string): Promise<void>;
  listModels(): Promise<string[]>;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Argument hint shown in help and completion. */
  usage?: string;
  aliases?: string[];
  run(args: string, context: SlashContext): Promise<void> | void;
}

/**
 * Resize the context window from inside a session.
 *
 * The new size is written to the provider config so it survives a restart, and
 * applied to the live agent immediately — every downstream budget (reply
 * reserve, tool output ceiling, compaction threshold) is derived from it.
 */
async function resizeContext(spec: string, context: SlashContext): Promise<void> {
  const { agent, config } = context;
  const providerId = agent.provider.id;
  const providerConfig = config.getProvider(providerId);
  if (!providerConfig) {
    context.notice('No provider is configured.', 'warning');
    return;
  }

  const inForce = agent.context.getContextWindow();

  // `auto` hands the decision back to the provider. The detected size only
  // lands at the next launch, so say so rather than implying it took effect.
  if (spec.toLowerCase() === 'auto' || spec.toLowerCase() === 'detect') {
    if (providerConfig.contextWindow === undefined) {
      context.notice('No override is set — the window already comes from detection.');
      return;
    }
    await config.update((draft) => {
      const entry = draft.providers[providerId];
      if (entry) delete entry.contextWindow;
    });
    context.notice(
      `Override cleared. ${providerConfig.label} will be asked at the next launch; this session stays at ${formatCount(inForce)}.`,
      'success',
    );
    return;
  }

  const tokens = parseWindowArgument(spec, inForce);
  if (tokens === undefined) {
    context.notice(
      `Cannot use "${spec}" as a context window. Try: /context up · /context down · /context 1m · /context +50k · /context auto`,
      'warning',
    );
    return;
  }

  if (tokens === inForce) {
    context.notice(`Already at ${formatCount(tokens)} tokens.`);
    return;
  }

  // Refuse to shrink below what the conversation already occupies: the next
  // request would be rejected outright, which is worse than saying no here.
  const used = agent.context.budget(context.registry.definitions()).used;
  if (tokens <= used) {
    context.notice(
      `${formatCount(tokens)} is smaller than the ${formatCount(used)} already in use. Run /compact first, or pick a larger size.`,
      'warning',
    );
    return;
  }

  await config.update((draft) => {
    const entry = draft.providers[providerId];
    if (entry) entry.contextWindow = tokens;
  });
  agent.applyContextWindow({ tokens, source: 'explicit' });

  const budget = agent.context.budget(context.registry.definitions());
  context.notice(
    `Context window ${tokens > inForce ? 'increased' : 'decreased'}: ${formatCount(inForce)} → ${formatCount(tokens)}. ${formatCount(budget.available)} free for this turn.`,
    'success',
  );
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show available commands and keyboard shortcuts',
    aliases: ['?'],
    run(_args, context) {
      const commands = SLASH_COMMANDS.map(
        (command) => `  /${command.name.padEnd(12)} ${command.description}`,
      ).join('\n');

      context.print(
        [
          '**Commands**',
          '```',
          commands,
          '```',
          '**Keyboard**',
          '```',
          '  Enter          Send',
          '  Shift+Enter    New line (or end a line with \\)',
          '  Ctrl+J         New line',
          '  Ctrl+C         Cancel the current operation',
          '  Ctrl+D         Exit Orbit',
          '  Ctrl+L         Clear the screen',
          '  Ctrl+O         Expand the last tool output',
          '  Ctrl+Shift+A   Toggle auto-working mode (Ctrl+G always works)',
          '  Up / Down      Prompt history',
          '  Tab            Complete commands and paths',
          '  Esc            Clear the input, or cancel',
          '```',
        ].join('\n'),
      );
    },
  },
  {
    name: 'model',
    description: 'Change the model — opens a picker, or takes a name',
    usage: '[model|list]',
    async run(args, context) {
      const target = args.trim();

      if (target && target !== 'list') {
        await context.switchModel(target);
        return;
      }

      if (target === 'list') {
        const provider = context.config.activeProvider();
        let available = provider?.models ?? [];
        try {
          const fetched = await context.listModels();
          if (fetched.length > 0) available = fetched;
        } catch {
          // The provider may not expose /models; the saved list still works.
        }

        const current = context.agent.model;
        context.print(
          [
            `**Current model**  \`${current}\``,
            '',
            available.length ? '```' : '_No model list available from this provider._',
            available.length
              ? available
                  .slice(0, 60)
                  .map((model) => `  ${model === current ? '●' : ' '} ${model}`)
                  .join('\n')
              : '',
            available.length ? '```' : '',
            '_Pick one interactively with_ `/model`',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      await context.pickModel();
    },
  },
  {
    name: 'provider',
    description: 'Change the provider — opens a picker, or takes an id',
    usage: '[provider-id|list]',
    async run(args, context) {
      const target = args.trim();

      if (target && target !== 'list') {
        await context.switchProvider(target);
        return;
      }

      const providers = context.config.listProviders();
      if (providers.length === 0) {
        context.notice('No providers configured. Run `orbit provider add` to add one.', 'warning');
        return;
      }

      if (target === 'list') {
        const activeId = context.config.get().activeProvider;
        const rows = providers
          .map((provider) => {
            const marker = provider.id === activeId ? '●' : ' ';
            const key = context.config.apiKeySource(provider.id);
            const keyLabel =
              key === 'env'
                ? `env:${provider.apiKeyEnv}`
                : key === 'store'
                  ? maskKey(context.config.apiKey(provider.id))
                  : 'no key';
            return `  ${marker} ${provider.id.padEnd(12)} ${(provider.model ?? '-').padEnd(28)} ${keyLabel}`;
          })
          .join('\n');

        context.print(
          ['**Providers**', '```', rows, '```', '_Pick one interactively with_ `/provider`'].join('\n'),
        );
        return;
      }

      await context.pickProvider();
    },
  },
  {
    name: 'key',
    description: 'Set the API key for the active or a named provider',
    usage: '[provider-id]',
    async run(args, context) {
      const target = args.trim() || context.config.get().activeProvider;
      if (!target) {
        context.notice('No provider configured. Run `orbit provider add`.', 'warning');
        return;
      }

      const provider = context.config.getProvider(target);
      if (!provider) {
        context.notice(`No provider with id "${target}". See /provider list.`, 'warning');
        return;
      }

      // An environment variable outranks the stored key, so changing the stored
      // one would appear to do nothing. Say so rather than letting it confuse.
      if (context.config.apiKeySource(target) === 'env') {
        context.notice(
          `${provider.label} is using ${provider.apiKeyEnv} from your environment, which takes precedence. Unset it first, or change the variable.`,
          'warning',
        );
        return;
      }

      await context.askApiKey(target);
    },
  },
  {
    name: 'status',
    description: 'Show provider, model, workspace and session state',
    async run(_args, context) {
      const agent = context.agent;
      const budget = agent.context.budget(context.registry.definitions());
      const shell = shellInfo();
      const session = agent.sessionRecord;
      const logFile = logFilePath();

      const rows: Array<[string, string]> = [
        ['Provider', session.provider.label],
        ['Model', agent.model],
        ['Tools', agent.toolsAvailable ? 'native' : 'text protocol (fallback)'],
        ['Vision', agent.visionAvailable ? 'supported' : 'not supported'],
        ['Workspace', tildify(context.sandbox.root)],
        ['Session', `${session.id} (${pluralize(session.messageCount || agent.context.length, 'message')})`],
        [
          'Context',
          `${formatCount(budget.used)} / ${formatCount(budget.window)} tokens (${Math.round(budget.ratio * 100)}%)`,
        ],
        [
          'Usage',
          `${formatCount(agent.usage.promptTokens)} in, ${formatCount(agent.usage.completionTokens)} out (/usage for detail)`,
        ],
        ['Auto mode', context.autoMode.describe()],
        [
          'Optimizer',
          agent.optimizer.getConfig().enabled
            ? `on ${agent.optimizer.last() ? `(${agent.optimizer.last()!.pressure} pressure, ${formatCount(agent.optimizer.last()!.responseTokens)} reply budget)` : '(no measurement yet)'}`
            : 'off',
        ],
        ['Shell', shell.shell],
        ['Platform', shell.platform],
      ];
      if (logFile) rows.push(['Debug log', tildify(logFile)]);

      const width = Math.max(...rows.map(([label]) => label.length));
      context.print(
        ['```', ...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`), '```'].join('\n'),
      );
    },
  },
  {
    name: 'context',
    description: 'Show context usage, or resize the window',
    usage: '[up | down | +50k | -50k | <tokens> | auto]',
    async run(args, context) {
      const trimmed = args.trim();
      if (trimmed) {
        await resizeContext(trimmed, context);
        return;
      }
      const budget = context.agent.context.budget(context.registry.definitions());
      const { breakdown } = budget;
      const rows: Array<[string, number]> = [
        ['System prompt', breakdown.system],
        ['Tool schemas', breakdown.tools],
        ['Conversation', breakdown.messages],
        ['Reserved for reply', breakdown.reserve],
      ];
      const total = budget.window;

      const bars = rows
        .map(([label, value]) => {
          const share = total > 0 ? value / total : 0;
          const filled = Math.max(0, Math.round(share * 24));
          return `  ${label.padEnd(20)} ${'█'.repeat(filled).padEnd(24, '·')} ${formatCount(value).padStart(7)}`;
        })
        .join('\n');

      context.print(
        [
          '**Context usage**',
          '```',
          bars,
          '',
          `  ${'Total used'.padEnd(20)} ${formatCount(budget.used)} of ${formatCount(total)} (${Math.round(budget.ratio * 100)}%)`,
          `  ${'Messages'.padEnd(20)} ${context.agent.context.length}`,
          '```',
          '_Compact with_ `/compact`_ · resize with_ `/context up` _or_ `/context down`_._',
        ].join('\n'),
      );
    },
  },
  {
    name: 'compact',
    description: 'Summarize earlier turns to free context space',
    async run(_args, context) {
      await context.compact();
    },
  },
  {
    name: 'auto',
    description: 'Toggle auto-working agent mode (Ctrl+Shift+A / Ctrl+G)',
    usage: '[on|off]',
    run(args, context) {
      const argument = args.trim().toLowerCase();

      if (argument === 'on' || argument === 'off') {
        context.toggleAuto(argument === 'on');
        return;
      }
      if (argument === '') {
        context.toggleAuto();
        return;
      }
      if (argument === 'status') {
        const status = context.autoMode.status();
        context.print(
          [
            `**Auto mode** — ${status.enabled ? 'on' : 'off'}`,
            '```',
            `  Auto-approves     ${status.approves.join(', ')}`,
            `  Always asks       ${status.requiresApproval.join(', ')}`,
            `  Self-continues    ${status.continuations}/${status.maxContinuations} used this turn`,
            '```',
            '_Auto mode widens approval, never the workspace boundary._',
          ].join('\n'),
        );
        return;
      }

      context.notice('Usage: /auto [on|off|status]', 'warning');
    },
  },
  {
    name: 'usage',
    description: 'Show token usage and what the optimizer is doing',
    aliases: ['tokens'],
    run(_args, context) {
      const tracker = context.agent.usageTracker;
      const session = tracker.sessionTotals();
      const lifetime = tracker.lifetimeTotals();
      const decision = context.agent.optimizer.last();
      const budget = context.agent.context.budget(context.registry.definitions());

      const pricing = context.config.get().pricing;
      const sessionCost = tracker.estimateCost(pricing, 'session');
      const lifetimeCost = tracker.estimateCost(pricing, 'lifetime');

      const rows: Array<[string, string]> = [
        ['Session in', formatCount(session.promptTokens)],
        ['Session out', formatCount(session.completionTokens)],
        ['Session total', formatCount(session.totalTokens)],
        ...(session.cachedTokens > 0
          ? ([
              [
                'From cache',
                `${formatCount(session.cachedTokens)} (${Math.round((session.cachedTokens / Math.max(1, session.promptTokens)) * 100)}% of input)`,
              ],
            ] as Array<[string, string]>)
          : []),
        ['Session cost', formatCost(sessionCost)],
        ['Requests', String(session.requests)],
        [
          'Avg reply',
          session.requests > 0 ? `${formatCount(tracker.averageCompletion())} tokens` : '-',
        ],
        [
          'Peak reply',
          session.requests > 0 ? `${formatCount(tracker.peakCompletion())} tokens` : '-',
        ],
        ['Lifetime in', formatCount(lifetime.promptTokens)],
        ['Lifetime out', formatCount(lifetime.completionTokens)],
        ['Lifetime reqs', String(lifetime.requests)],
        ['Lifetime cost', formatCost(lifetimeCost)],
      ];

      const width = Math.max(...rows.map(([label]) => label.length));
      const table = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);

      const optimizer = context.agent.optimizer.getConfig();
      const optimizerLines = [
        `  Enabled           ${optimizer.enabled ? 'yes' : 'no'}`,
        `  Context in use    ${formatCount(budget.used)} / ${formatCount(budget.window)} (${Math.round(budget.ratio * 100)}%)`,
        decision
          ? `  Pressure          ${decision.pressure}`
          : '  Pressure          not measured yet',
        decision
          ? `  Reply budget      ${formatCount(decision.responseTokens)} tokens (ceiling ${formatCount(optimizer.maxResponseTokens)})`
          : `  Reply budget      ${formatCount(context.config.get().agent.maxTokens)} tokens (configured)`,
        decision
          ? `  Tool output cap   ${formatCount(decision.toolOutputChars)} chars`
          : '',
      ].filter(Boolean);

      const perModel = tracker
        .byModel()
        .slice(0, 6)
        .map(
          ({ key, usage }) =>
            `  ${key.padEnd(28)} ${formatCount(usage.promptTokens + usage.completionTokens).padStart(8)}  ${usage.requests} req`,
        );

      context.print(
        [
          '**Token usage**',
          '```',
          ...table,
          '```',
          '**Auto-optimization**',
          '```',
          ...optimizerLines,
          '```',
          perModel.length ? '**By model (lifetime)**' : '',
          perModel.length ? '```' : '',
          perModel.length ? perModel.join('\n') : '',
          perModel.length ? '```' : '',
          lifetimeCost.unpriced.length > 0
            ? '_Cost needs per-model rates:_ `orbit config` _→ Model pricing. Orbit ships no rate table._'
            : '_Counts come from the provider where it reports them._',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  },
  {
    name: 'files',
    description: 'List files the agent has touched in this session',
    run(_args, context) {
      const history = context.agent.sessionRecord.toolHistory;
      const touched = history.filter((entry) =>
        ['write_file', 'edit_file', 'delete_file', 'move_file'].includes(entry.name),
      );

      if (touched.length === 0) {
        context.notice('No files have been modified in this session.');
        return;
      }

      const lines = touched.map(
        (entry) => `  ${entry.ok ? '✓' : '✗'} ${entry.name.padEnd(12)} ${entry.summary}`,
      );
      context.print(['**Modified in this session**', '```', ...lines, '```'].join('\n'));
    },
  },
  {
    name: 'tools',
    description: 'List the tools available to the agent',
    run(_args, context) {
      const rows = context.registry
        .list()
        .map((tool) => {
          const badge = tool.readOnly ? 'read ' : 'write';
          return `  ${badge}  ${tool.name.padEnd(18)} ${tool.description.split('.')[0]}`;
        })
        .join('\n');
      context.print(['**Tools**', '```', rows, '```'].join('\n'));
    },
  },
  {
    name: 'permissions',
    description: 'Show or change the permission policy',
    usage: '[read|write|delete|shell|network|search] [allow|ask|deny]',
    async run(args, context) {
      const [key, value] = args.trim().split(/\s+/);

      if (key && value) {
        const validKeys = ['read', 'search', 'write', 'delete', 'shell', 'network'];
        const validValues = ['allow', 'ask', 'deny'];
        if (!validKeys.includes(key) || !validValues.includes(value)) {
          context.notice(
            `Usage: /permissions <${validKeys.join('|')}> <${validValues.join('|')}>`,
            'warning',
          );
          return;
        }
        await context.config.setPermission(
          key as keyof PermissionPolicy,
          value as 'allow' | 'ask' | 'deny',
        );
        context.permissions.setPolicy(context.config.permissions());
        context.agent.refreshSystemPrompt();
        context.notice(`Permission "${key}" set to "${value}".`, 'success');
        return;
      }

      const policy = context.permissions.getPolicy();
      const rows = Object.entries(policy)
        .map(([name, decision]) => `  ${name.padEnd(10)} ${decision}`)
        .join('\n');
      const grants = context.permissions.listSessionGrants();

      context.print(
        [
          '**Permission policy**',
          '```',
          rows,
          '```',
          grants.length
            ? `**Granted for this session**\n\`\`\`\n${grants.map((g) => `  ${g}`).join('\n')}\n\`\`\``
            : '_No session grants._',
          '_Change with_ `/permissions write ask`',
        ].join('\n'),
      );
    },
  },
  {
    name: 'git',
    description: 'Show the current git state',
    async run(_args, context) {
      const state = await readGitState(context.sandbox.root);
      if (!state.isRepo) {
        context.notice('This workspace is not a git repository.');
        return;
      }
      const files = state.files.map((file) => `  ${file.code} ${file.path}`).join('\n');
      context.print(
        [
          `**Git** — ${summarizeGitState(state)}`,
          state.files.length ? '```' : '',
          state.files.length ? files : '',
          state.files.length ? '```' : '_Working tree clean._',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  },
  {
    name: 'session',
    description: 'List sessions, or resume one by id',
    usage: '[id|new]',
    aliases: ['sessions'],
    async run(args, context) {
      const target = args.trim();

      if (target === 'new') {
        await context.newSession();
        return;
      }
      if (target) {
        await context.resumeSession(target);
        return;
      }

      const sessions = await context.sessions.list({ limit: 15 });
      if (sessions.length === 0) {
        context.notice('No saved sessions yet.');
        return;
      }

      const current = context.agent.sessionRecord.id;
      const rows = sessions
        .map((session) => {
          const marker = session.id === current ? '●' : ' ';
          return `  ${marker} ${session.id.padEnd(30)} ${formatRelativeTime(session.updatedAt).padEnd(10)} ${path.basename(session.workspace)}`;
        })
        .join('\n');

      context.print(
        ['**Sessions**', '```', rows, '```', '_Resume with_ `/session <id>`  _or start fresh with_ `/session new`'].join(
          '\n',
        ),
      );
    },
  },
  {
    name: 'undo',
    description: 'Undo the file changes made by the last turn',
    async run(_args, context) {
      const checkpoints = context.agent.checkpoints;
      if (!checkpoints?.enabled) {
        context.notice('Checkpoints are disabled, so there is nothing to undo.', 'warning');
        return;
      }

      const last = checkpoints.latest();
      if (!last) {
        context.notice('No file changes have been recorded in this session.');
        return;
      }

      const outcome = await checkpoints.undoLast();
      if (!outcome) {
        context.notice('Nothing to undo.');
        return;
      }

      const { checkpoint, result } = outcome;
      const lines = [
        `**Undid turn ${checkpoint.turn}** — ${checkpoint.label}`,
        '```',
        ...result.restored.map((file) => `  restored  ${file}`),
        ...result.skipped.map((entry) => `  skipped   ${entry.path} (${entry.reason})`),
        '```',
      ];
      context.print(lines.join('\n'));
      context.notice(
        `Reverted ${pluralize(result.restored.length, 'file')}. The model has not been told — say what you want instead.`,
        result.skipped.length > 0 ? 'warning' : 'success',
      );
    },
  },
  {
    name: 'rewind',
    description: 'Undo every file change back to a given turn',
    usage: '<turn>',
    async run(args, context) {
      const checkpoints = context.agent.checkpoints;
      if (!checkpoints?.enabled) {
        context.notice('Checkpoints are disabled.', 'warning');
        return;
      }

      const turn = Number.parseInt(args.trim(), 10);
      if (!Number.isInteger(turn)) {
        context.notice('Usage: /rewind <turn>. See /checkpoints for the list.', 'warning');
        return;
      }
      if (!checkpoints.find(turn)) {
        context.notice(`No checkpoint for turn ${turn}. See /checkpoints.`, 'warning');
        return;
      }

      const result = await checkpoints.restoreTo(turn);
      context.print(
        [
          `**Rewound to before turn ${turn}**`,
          '```',
          ...result.restored.map((file) => `  restored  ${file}`),
          ...result.skipped.map((entry) => `  skipped   ${entry.path} (${entry.reason})`),
          '```',
        ].join('\n'),
      );
      context.notice(`Reverted ${pluralize(result.restored.length, 'file')}.`, 'success');
    },
  },
  {
    name: 'checkpoints',
    description: 'List the file changes recorded for each turn',
    run(_args, context) {
      const checkpoints = context.agent.checkpoints;
      if (!checkpoints?.enabled) {
        context.notice('Checkpoints are disabled.', 'warning');
        return;
      }

      const all = checkpoints.list();
      if (all.length === 0) {
        context.notice('No file changes recorded yet in this session.');
        return;
      }

      const rows = all.map(
        (checkpoint) =>
          `  ${String(checkpoint.turn).padStart(3)}  ${formatRelativeTime(checkpoint.at).padEnd(10)} ${checkpoints
            .describe(checkpoint)
            .padEnd(24)} ${checkpoint.label}`,
      );

      context.print(
        [
          '**Checkpoints**',
          '```',
          '  turn  when       changes                  prompt',
          ...rows,
          '```',
          '_Undo the last one with_ `/undo`_, or go further back with_ `/rewind <turn>`',
        ].join('\n'),
      );
    },
  },
  {
    name: 'export',
    description: 'Write the conversation to a Markdown file',
    usage: '[path]',
    async run(args, context) {
      const target = args.trim() || `orbit-${context.agent.sessionRecord.id}.md`;
      let resolved;
      try {
        resolved = context.sandbox.resolve(target);
      } catch (error) {
        context.notice(`Cannot export there: ${errorMessage(error)}`, 'warning');
        return;
      }

      const markdown = renderSessionMarkdown(context);
      await writeFile(resolved.absolute, markdown, 'utf8');
      context.notice(`Exported ${pluralize(context.agent.context.length, 'message')} to ${resolved.relative}.`, 'success');
    },
  },
  {
    name: 'workspace',
    description: 'Show authorized roots, or authorize another directory',
    usage: '[add <path>]',
    async run(args, context) {
      const [action, ...rest] = args.trim().split(/\s+/);

      if (action === 'add') {
        const dir = rest.join(' ').trim();
        if (!dir) {
          context.notice('Usage: /workspace add <path>', 'warning');
          return;
        }
        await context.addWorkspaceRoot(dir);
        return;
      }

      const roots = context.sandbox.authorizedRoots;
      context.print(
        [
          '**Authorized roots**',
          '```',
          ...roots.map((root, index) => `  ${index === 0 ? '●' : ' '} ${tildify(root)}`),
          '```',
          '_Everything outside these is refused._ `/workspace add ../lib` _authorizes another._',
        ].join('\n'),
      );
    },
  },
  {
    name: 'web',
    description: 'Show web access status, or set the Tavily API key',
    usage: '[key <api-key>|off|on]',
    async run(args, context) {
      const trimmed = args.trim();
      const web = context.config.get().web;

      if (trimmed.startsWith('key')) {
        const key = trimmed.slice(3).trim();
        if (!key) {
          context.notice(
            'Usage: /web key <api-key>. Run `orbit web key` instead to enter it without it appearing on screen.',
            'warning',
          );
          return;
        }
        await context.config.setServiceKey('tavily', key);
        context.notice('Tavily key saved to ~/.orbit/credentials. Restart Orbit to enable the web tools.', 'success');
        return;
      }

      if (trimmed === 'on' || trimmed === 'off') {
        await context.config.update((draft) => {
          draft.web.enabled = trimmed === 'on';
        });
        context.notice(`Web access ${trimmed}. Restart Orbit to apply.`, 'success');
        return;
      }

      const source = context.config.serviceKeySource('tavily', web.apiKeyEnv);
      const hasTools = context.registry.has('web_search');

      context.print(
        [
          '**Web access**',
          '```',
          `  Provider     ${web.provider}`,
          `  Enabled      ${web.enabled ? 'yes' : 'no'}`,
          `  API key      ${source === 'env' ? `from ${web.apiKeyEnv}` : source === 'store' ? maskKey(context.config.serviceKey('tavily', web.apiKeyEnv)) : 'not set'}`,
          `  Tools        ${hasTools ? 'web_search, web_fetch' : 'not loaded (no key at startup)'}`,
          `  Results      ${web.maxResults} per search, ${web.searchDepth} depth`,
          `  Permission   network is set to "${context.permissions.getPolicy().network}"`,
          '```',
          source === 'none'
            ? '_Add a key with_ `orbit web key` _(hidden input), then restart._'
            : '_Searches send only your query text to Tavily._',
        ].join('\n'),
      );
    },
  },
  {
    name: 'mcp',
    description: 'Show connected MCP servers and their tools',
    run(_args, context) {
      if (context.mcpClients.length === 0) {
        context.print(
          [
            '**MCP**',
            '',
            'No MCP servers are configured.',
            '',
            'Add one to `~/.orbit/config.json`:',
            '```json',
            '"mcp": {',
            '  "servers": {',
            '    "filesystem": {',
            '      "command": "npx",',
            '      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]',
            '    }',
            '  }',
            '}',
            '```',
          ].join('\n'),
        );
        return;
      }

      const sections = context.mcpClients.map((client) => {
        const tools = client.listTools();
        return [
          `**${client.name}** (${client.id}) — ${client.isRunning ? 'connected' : 'disconnected'}`,
          '```',
          ...tools.map((tool) => `  ${tool.name.padEnd(28)} ${(tool.description ?? '').slice(0, 60)}`),
          '```',
        ].join('\n');
      });

      context.print(
        ['**MCP servers**', ...sections, '_MCP tools run outside the workspace sandbox and always ask for approval._'].join(
          '\n\n',
        ),
      );
    },
  },
  {
    name: 'bg',
    description: 'List or stop background processes',
    usage: '[stop <id>|stop all]',
    run(args, context) {
      const registry = context.background;
      if (!registry) {
        context.notice('Background processes are not available.', 'warning');
        return;
      }

      const [action, id] = args.trim().split(/\s+/);
      if (action === 'stop') {
        if (!id) {
          context.notice('Usage: /bg stop <id>, or /bg stop all', 'warning');
          return;
        }
        const stopped = id === 'all' ? registry.stopAll() : registry.stop(id) ? 1 : 0;
        context.notice(`Stopped ${pluralize(stopped, 'process', 'processes')}.`, 'success');
        return;
      }

      const all = registry.list();
      if (all.length === 0) {
        context.notice('No background processes.');
        return;
      }

      context.print(
        [
          '**Background processes**',
          '```',
          ...all.map(
            (entry) =>
              `  ${entry.id.padEnd(6)} ${entry.status.padEnd(8)} ${entry.command.slice(0, 50)}`,
          ),
          '```',
          '_Stop one with_ `/bg stop <id>`',
        ].join('\n'),
      );
    },
  },
  {
    name: 'hooks',
    description: 'Show the lifecycle hooks that are running this session',
    run(_args, context) {
      const { enabled, entries } = context.config.get().hooks;
      if (entries.length === 0) {
        context.print(
          [
            '**Hooks**',
            '',
            'None configured. Hooks run a command when something happens — a file is',
            'written, a turn ends, a session starts. They live in your user config;',
            'run `orbit hooks` outside a session to see the shape.',
          ].join('\n'),
        );
        return;
      }

      const lines = entries.map((hook) => {
        const state = enabled && hook.enabled ? '●' : '○';
        const extras = [
          hook.tools.length > 0 ? hook.tools.join(', ') : undefined,
          hook.blocking ? 'blocking' : undefined,
          !hook.enabled ? 'disabled' : undefined,
        ].filter(Boolean);
        const suffix = extras.length > 0 ? `  (${extras.join(', ')})` : '';
        return `  ${state} ${hook.on.padEnd(14)} ${describeHook(hook)}${suffix}`;
      });

      context.print(
        [
          `**Hooks**${enabled ? '' : '  — all disabled'}`,
          '```',
          ...lines,
          '```',
          '_Change them in your config file. Try one with_ `orbit hooks test <n>`_._',
        ].join('\n'),
      );
    },
  },
  {
    name: 'theme',
    description: 'Change the colour palette',
    usage: '[orbit|mono|ember|forest|ice]',
    async run(args, context) {
      const name = args.trim().toLowerCase();
      if (!name) {
        context.print(
          [
            `**Theme** — currently \`${context.config.get().ui.theme}\``,
            '```',
            ...THEME_NAMES.map((theme) => `  ${theme}`),
            '```',
            '_Change with_ `/theme ember`',
          ].join('\n'),
        );
        return;
      }
      if (!THEME_NAMES.includes(name as (typeof THEME_NAMES)[number])) {
        context.notice(`Unknown theme "${name}". Options: ${THEME_NAMES.join(', ')}.`, 'warning');
        return;
      }
      await context.setTheme(name);
    },
  },
  {
    name: 'clear',
    description: 'Clear the screen and start a new conversation',
    async run(_args, context) {
      context.clearTranscript();
      await context.newSession();
    },
  },
  {
    name: 'quit',
    description: 'Exit Orbit',
    aliases: ['exit', 'q'],
    run(_args, context) {
      context.exit();
    },
  },
];

const BY_NAME = new Map<string, SlashCommand>();
for (const command of SLASH_COMMANDS) {
  BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command);
}

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith('/');
}

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const match = /^\s*\/([\w?-]+)\s*([\s\S]*)$/.exec(input);
  if (!match) return null;
  return { name: (match[1] ?? '').toLowerCase(), args: match[2] ?? '' };
}

export function findCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export function commandList(extra: SlashCommand[] = []): Array<{ name: string; description: string }> {
  return [...SLASH_COMMANDS, ...extra].map((command) => ({
    name: command.name,
    description: command.description,
  }));
}

/**
 * Project commands are resolved before built-ins are consulted, but cannot
 * shadow one: a repo should not be able to redefine `/quit`.
 */
export function resolveCommand(
  name: string,
  custom: SlashCommand[],
): SlashCommand | undefined {
  const builtin = findCommand(name);
  if (builtin) return builtin;
  return custom.find((command) => command.name === name.toLowerCase());
}

/** Render the conversation as Markdown for `/export`. */
export function renderSessionMarkdown(context: SlashContext): string {
  const session = context.agent.sessionRecord;
  const lines: string[] = [
    `# Orbit session — ${session.title}`,
    '',
    `- **Session**: \`${session.id}\``,
    `- **Model**: ${session.provider.model} via ${session.provider.label}`,
    `- **Workspace**: ${tildify(session.workspace)}`,
    `- **Exported**: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ];

  for (const entry of context.agent.context.history()) {
    const { message } = entry;
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (part.type === 'text' ? part.text : `_[image: ${part.name ?? part.mediaType}]_`))
            .join('\n');

    if (message.role === 'user') {
      lines.push(`## User`, '', content, '');
    } else if (message.role === 'assistant') {
      if (content.trim()) lines.push(`## Orbit`, '', content, '');
      for (const call of message.toolCalls ?? []) {
        lines.push(
          `> \`${call.name}\` ${'`' + JSON.stringify(call.arguments).slice(0, 200) + '`'}`,
          '',
        );
      }
    } else if (message.role === 'tool') {
      const preview = content.split('\n').slice(0, 20).join('\n');
      lines.push('<details><summary>tool result</summary>', '', '```', preview, '```', '', '</details>', '');
    }
  }

  return lines.join('\n');
}
