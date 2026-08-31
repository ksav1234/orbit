import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import type { Agent } from '../agent/agent.js';
import type { AutoMode } from '../agent/autopilot.js';
import type { PlanStep } from '../agent/planner.js';
import type { AgentEvent, TurnEndReason } from '../agent/loop.js';
import type { ConfigManager } from '../config/manager.js';
import type { PermissionManager, PermissionChoice, PermissionRequest } from '../permissions/manager.js';
import type { Sandbox } from '../permissions/sandbox.js';
import type { SessionManager } from '../sessions/manager.js';
import type { ToolRegistry, ToolResult } from '../tools/registry.js';
import type { AIProvider, ToolCall } from '../providers/provider.js';
import { OrbitError, errorMessage } from '../util/errors.js';
import { deferred } from '../util/async.js';
import path from 'node:path';
import { stat as statFile } from 'node:fs/promises';
import { formatCount } from '../util/format.js';
import { tildify } from '../util/paths.js';
import type { OrbitConfig } from '../config/schema.js';
import type { McpClient } from '../mcp/client.js';
import type { BackgroundRegistry } from '../tools/background.js';
import { createTheme } from '../ui/theme.js';
import { loadCustomCommands, toSlashCommands } from './custom-commands.js';
import type { SlashCommand } from './commands.js';
import { resolveCommand } from './commands.js';
import { ThemeContext, useTerminalSize } from '../ui/context.js';
import type { Theme } from '../ui/theme.js';
import { Banner, type BannerProps } from '../ui/components/Header.js';
import { Footer } from '../ui/components/Footer.js';
import {
  AssistantMessage,
  Markdown,
  Notice,
  ReasoningTrace,
  UserMessage,
  type NoticeTone,
} from '../ui/components/Message.js';
import { ToolCallView } from '../ui/components/ToolCall.js';
import { PermissionPrompt, PermissionRecord } from '../ui/components/Permission.js';
import { SelectPrompt, SecretPrompt, type SelectOption } from '../ui/components/Select.js';
import { AnimatedBanner } from '../ui/components/AnimatedBanner.js';
import { PlanView } from '../ui/components/Plan.js';
import { ErrorBox } from '../ui/components/ErrorBox.js';
import { PromptInput } from '../ui/components/Input.js';
import { Spinner } from '../ui/components/Spinner.js';
import { InputHistory, createCompleter, type Completion } from './input.js';
import { clearScreen, useGlobalKeys } from './keyboard.js';
import {
  commandList,
  findCommand,
  isSlashCommand,
  parseSlashCommand,
  type SlashContext,
} from './commands.js';
import { readGitState } from '../tools/git.js';

// ── transcript model ───────────────────────────────────────────────────────

type TranscriptItem =
  | { kind: 'banner'; id: string }
  | { kind: 'user'; id: string; text: string; attachments: string[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'markdown'; id: string; text: string }
  | { kind: 'notice'; id: string; text: string; tone: NoticeTone }
  | {
      kind: 'tool';
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: 'ok' | 'error' | 'denied';
      result?: ToolResult;
      durationMs?: number;
      deniedReason?: string;
    }
  | { kind: 'permission'; id: string; request: PermissionRequest; choice: PermissionChoice }
  | { kind: 'plan'; id: string; steps: PlanStep[] }
  | { kind: 'error'; id: string; error: OrbitError };

/** A modal owns the keyboard until it resolves. */
type Modal =
  | {
      kind: 'select';
      title: string;
      hint?: string;
      options: Array<SelectOption<string>>;
      onSelect: (value: string) => void;
      onCancel: () => void;
    }
  | {
      kind: 'secret';
      title: string;
      hint?: string;
      onSubmit: (value: string) => void;
      onCancel: () => void;
    };

interface ActiveTool {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  progress?: string;
  startedAt: number;
}

type Status = 'idle' | 'thinking' | 'streaming' | 'tools' | 'compacting';

export interface AppProps {
  agent: Agent;
  config: ConfigManager;
  sessions: SessionManager;
  registry: ToolRegistry;
  permissions: PermissionManager;
  sandbox: Sandbox;
  autoMode: AutoMode;
  theme: Theme;
  showBanner: boolean;
  /** Play the launch animation before settling into the banner. */
  animate?: boolean;
  debug: boolean;
  warnings: string[];
  version?: string;
  initialPrompt?: string;
  /** Connected MCP servers, for /mcp. */
  mcpClients?: McpClient[];
  /** Background process registry shared with the tools. */
  background?: BackgroundRegistry;
  /** Builds a provider instance for `/model` and `/provider`. */
  createProviderFor(providerId: string, model?: string): { provider: AIProvider; label: string };
}

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${++sequence}`;

export function App(props: AppProps): React.ReactElement {
  const { agent, theme, registry, sandbox, config, sessions, permissions, autoMode, debug } = props;
  const { exit } = useApp();
  const { columns, layout } = useTerminalSize();

  const animating = Boolean(props.animate && props.showBanner);
  const [transcript, setTranscript] = useState<TranscriptItem[]>(() =>
    props.showBanner && !animating ? [{ kind: 'banner', id: 'banner' }] : [],
  );
  const [introPlaying, setIntroPlaying] = useState(animating);
  const [status, setStatus] = useState<Status>('idle');
  const [streamText, setStreamText] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [pendingPermission, setPendingPermission] = useState<{
    request: PermissionRequest;
    resolve: (choice: PermissionChoice, instruction?: string) => void;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [usedTokens, setUsedTokens] = useState(0);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [modelLabel, setModelLabel] = useState(agent.model);
  const [providerLabel, setProviderLabel] = useState(agent.sessionRecord.provider.label);
  const [autoEnabled, setAutoEnabled] = useState(autoMode.enabled);
  const [pressure, setPressure] = useState<string | undefined>(undefined);
  const [themeName, setThemeName] = useState(theme.name);
  /** A picker or key prompt currently owning the keyboard. */
  const [modal, setModal] = useState<Modal | null>(null);
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);

  // Rebuild the palette in place when /theme changes, keeping the colour and
  // unicode decisions the CLI flags already made.
  const activeTheme = useMemo(
    () =>
      themeName === theme.name
        ? theme
        : createTheme({
            theme: themeName,
            color: theme.color ? 'always' : 'never',
            unicode: theme.unicode ? 'on' : 'off',
          }),
    [themeName, theme],
  );

  const history = useRef(new InputHistory());
  /** Arguments by call id, so a finished tool can render what it was asked to do. */
  const toolArgs = useRef(new Map<string, Record<string, unknown>>());
  /** Set when auto mode should keep working after the current turn ends. */
  const pendingContinuation = useRef<string | null>(null);
  /** Lets project commands submit prompts without re-creating them each render. */
  const runPromptRef = useRef<((text: string) => Promise<void>) | null>(null);
  /** Lets the pickers reuse switchModel/switchProvider from the same context object. */
  const slashContextRef = useRef<SlashContext | null>(null);
  const busy = status !== 'idle';

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((items) => [...items, item]);
  }, []);

  const notice = useCallback(
    (text: string, tone: NoticeTone = 'info') => {
      append({ kind: 'notice', id: nextId('notice'), text, tone });
    },
    [append],
  );

  // ── agent events ─────────────────────────────────────────────────────────

  useEffect(() => {
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case 'turn-start':
          setStatus('thinking');
          setStreamText('');
          setReasoning('');
          break;

        case 'request-start':
          setStatus('thinking');
          setStreamText('');
          break;

        case 'text-delta':
          setStatus('streaming');
          setStreamText((text) => text + event.delta);
          break;

        case 'reasoning-delta':
          setStatus('thinking');
          setReasoning((text) => (text + event.delta).slice(-2000));
          break;

        case 'assistant-message':
          setStreamText('');
          setReasoning('');
          if (event.text.trim()) {
            append({ kind: 'assistant', id: nextId('assistant'), text: event.text });
          }
          break;

        case 'tool-start':
          setStatus('tools');
          toolArgs.current.set(event.call.id, event.call.arguments ?? {});
          setActiveTools((tools) => [
            ...tools,
            {
              callId: event.call.id,
              name: event.call.name,
              args: event.call.arguments ?? {},
              startedAt: Date.now(),
            },
          ]);
          break;

        case 'tool-progress':
          setActiveTools((tools) =>
            tools.map((tool) =>
              tool.callId === event.callId ? { ...tool, progress: event.message } : tool,
            ),
          );
          break;

        case 'tool-end': {
          const args = toolArgs.current.get(event.callId) ?? {};
          toolArgs.current.delete(event.callId);
          setActiveTools((tools) => tools.filter((tool) => tool.callId !== event.callId));
          append({
            kind: 'tool',
            id: nextId('tool'),
            name: event.name,
            args,
            status: event.result.ok ? 'ok' : 'error',
            result: event.result,
            durationMs: event.durationMs,
          });
          break;
        }

        case 'tool-denied': {
          const args = toolArgs.current.get(event.callId) ?? {};
          toolArgs.current.delete(event.callId);
          setActiveTools((tools) => tools.filter((tool) => tool.callId !== event.callId));
          append({
            kind: 'tool',
            id: nextId('tool'),
            name: event.name,
            args,
            status: 'denied',
            deniedReason: event.reason,
          });
          break;
        }

        case 'compaction':
          if (event.event.type === 'started') {
            setStatus('compacting');
            notice('Context limit approaching — compressing earlier turns…');
          } else if (event.event.type === 'finished') {
            notice(
              `Context optimized: ${event.event.before.toLocaleString()} → ${event.event.after.toLocaleString()} tokens.`,
              'success',
            );
          }
          break;

        case 'usage':
        case 'turn-usage':
          setUsedTokens(agent.context.budget(registry.definitions()).used);
          break;

        case 'optimization': {
          setPressure(event.decision.pressure);
          if (agent.optimizer.getConfig().announce && event.decision.reason) {
            notice(
              `Token budget adjusted — ${event.decision.reason}`,
              event.decision.pressure === 'critical' ? 'warning' : 'info',
            );
          }
          break;
        }

        case 'retry':
          // The retried request re-streams from the start, so drop whatever the
          // failed attempt had already rendered.
          setStreamText('');
          setReasoning('');
          notice(
            `Retrying after a provider error (attempt ${event.attempt}): ${event.reason}`,
            'warning',
          );
          break;

        case 'notice':
          notice(event.message, 'warning');
          break;

        case 'context-window':
          // Detection can land after the banner has already scrolled past, so
          // the corrected figure is stated in the transcript too.
          setUsedTokens(agent.context.budget(registry.definitions()).used);
          notice(
            `Context window: ${event.tokens.toLocaleString()} tokens (${event.detail}).`,
            'success',
          );
          break;

        case 'checkpoint':
          notice(
            `Checkpoint ${event.turn}: ${event.files} file${event.files === 1 ? '' : 's'} changed. /undo reverts it.`,
          );
          break;

        case 'error':
          append({ kind: 'error', id: nextId('error'), error: event.error });
          break;

        case 'turn-end':
          setStatus('idle');
          setActiveTools([]);
          setStreamText('');
          setReasoning('');
          setUsedTokens(agent.context.budget(registry.definitions()).used);
          if (event.reason === 'cancelled') {
            // A cancellation is the user taking back control: stop auto-working.
            pendingContinuation.current = null;
            autoMode.resetContinuations();
            notice('Cancelled.', 'warning');
          } else {
            pendingContinuation.current = autoMode.nextContinuation(agent.planner, event.reason);
          }
          break;

        default:
          break;
      }
    });
    return unsubscribe;
  }, [agent, append, notice, registry, autoMode]);

  // Auto mode's approval rule is installed only while the mode is on.
  useEffect(() => {
    const unsubscribe = autoMode.onChange((enabled) => {
      setAutoEnabled(enabled);
      permissions.setAutoApprover(enabled ? autoMode.approver : null);
    });
    permissions.setAutoApprover(autoMode.enabled ? autoMode.approver : null);
    return () => {
      unsubscribe();
      permissions.setAutoApprover(null);
    };
  }, [autoMode, permissions]);

  // Plan updates come from the model's update_plan tool calls.
  useEffect(() => agent.planner.onChange((steps) => setPlan([...steps])), [agent]);

  // Permission prompts are rendered by this component and resolved by the user.
  useEffect(() => {
    permissions.setPrompter(async (request) => {
      const gate = deferred<PermissionChoice>();
      setPendingPermission({
        request,
        resolve: (choice, instruction) => {
          setPendingPermission(null);
          // "Edit instruction" rejects the operation and tells the model what
          // the user wants instead, so the turn continues rather than stalling.
          permissions.setRedirect(choice === 'redirect' ? (instruction ?? null) : null);
          append({ kind: 'permission', id: nextId('permission'), request, choice });
          gate.resolve(choice);
        },
      });
      return gate.promise;
    });
    return () => permissions.setPrompter(undefined);
  }, [permissions, append]);

  useEffect(() => {
    // Project commands come from .orbit/commands in the workspace.
    loadCustomCommands([sandbox.root])
      .then((files) => {
        if (files.length === 0) return;
        setCustomCommands(toSlashCommands(files, (prompt) => void runPromptRef.current?.(prompt)));
      })
      .catch(() => setCustomCommands([]));
  }, [sandbox]);

  useEffect(() => {
    // Git state is decoration; never let a missing binary reach the user.
    readGitState(sandbox.root)
      .then((state) => {
        if (state.isRepo) setBranch(state.branch);
      })
      .catch(() => setBranch(undefined));
  }, [sandbox]);

  // ── actions ──────────────────────────────────────────────────────────────

  const reportTurnError = useCallback(
    (error: unknown) => {
      append({
        kind: 'error',
        id: nextId('error'),
        error:
          error instanceof OrbitError
            ? error
            : new OrbitError('Orbit could not complete that turn.', {
                kind: 'internal',
                detail: errorMessage(error),
              }),
      });
      setStatus('idle');
    },
    [append],
  );

  const runPrompt = useCallback(
    async (text: string) => {
      const { attachments, notices } = await agent.resolveAttachments(text);

      append({
        kind: 'user',
        id: nextId('user'),
        text,
        attachments: notices.map((n) => `${n.path} — ${n.detail}`),
      });

      for (const item of notices) {
        if (item.kind === 'skipped') {
          notice(
            `${item.path} was not sent: ${item.detail}. Switch models with /model to analyse it.`,
            'warning',
          );
        }
      }

      pendingContinuation.current = null;
      autoMode.resetContinuations();

      try {
        await agent.send(text, attachments);
      } catch (error) {
        reportTurnError(error);
        return;
      }

      // Auto mode keeps working while the model's own plan has open steps.
      // Every continuation is announced, and the loop is bounded.
      let next = pendingContinuation.current;
      pendingContinuation.current = null;

      while (next) {
        const limit = autoMode.getConfig().maxContinuations;
        notice(
          `Auto mode: continuing on its own (${autoMode.continuationCount}/${limit}). Press ctrl+c to stop.`,
        );
        try {
          await agent.send(next);
        } catch (error) {
          reportTurnError(error);
          return;
        }
        next = pendingContinuation.current;
        pendingContinuation.current = null;
      }

      if (autoMode.enabled && autoMode.continuationsLeft === 0 && autoMode.continuationCount > 0) {
        notice(
          `Auto mode paused after ${autoMode.continuationCount} continuations. Say "continue" to keep going.`,
          'warning',
        );
      }
    },
    [agent, append, notice, autoMode, reportTurnError],
  );

  const toggleAuto = useCallback(
    (enabled?: boolean) => {
      const next = enabled === undefined ? autoMode.toggle() : autoMode.set(enabled);
      const status = autoMode.status();
      if (next) {
        notice(
          `Auto mode ON — auto-approves ${status.approves.join(', ')}; still asks for ${status.requiresApproval.join(', ')}.`,
          'success',
        );
      } else {
        notice('Auto mode OFF — every restricted operation asks first.');
      }
    },
    [autoMode, notice],
  );

  useEffect(() => {
    runPromptRef.current = runPrompt;
  }, [runPrompt]);

  /** Open a modal and resolve once the user chooses or cancels. */
  const askSelect = useCallback(
    (title: string, options: Array<SelectOption<string>>, hint?: string): Promise<string | null> => {
      const gate = deferred<string | null>();
      setModal({
        kind: 'select',
        title,
        hint,
        options,
        onSelect: (value) => {
          setModal(null);
          gate.resolve(value);
        },
        onCancel: () => {
          setModal(null);
          gate.resolve(null);
        },
      });
      return gate.promise;
    },
    [],
  );

  const askSecret = useCallback((title: string, hint?: string): Promise<string | null> => {
    const gate = deferred<string | null>();
    setModal({
      kind: 'secret',
      title,
      hint,
      onSubmit: (value) => {
        setModal(null);
        gate.resolve(value);
      },
      onCancel: () => {
        setModal(null);
        gate.resolve(null);
      },
    });
    return gate.promise;
  }, []);

  const slashContext = useMemo<SlashContext>(
    () => ({
      agent,
      config,
      sessions,
      registry,
      permissions,
      sandbox,
      autoMode,
      toggleAuto,
      pickModel: async () => {
        const provider = config.activeProvider();
        if (!provider) {
          notice('No provider configured. Run `orbit provider add`.', 'warning');
          return;
        }

        // Prefer the live list; fall back to what was saved if the provider is
        // unreachable, so the picker still works offline.
        let models = provider.models;
        let live = false;
        try {
          const fetched = await agent.provider.listModels?.();
          if (fetched?.length) {
            models = fetched.map((model) => model.id);
            live = true;
          }
        } catch {
          // Keep the saved list.
        }
        if (models.length === 0) {
          notice('This provider did not offer a model list. Use `/model <name>`.', 'warning');
          return;
        }

        const current = agent.model;
        const choice = await askSelect(
          `Model  ${provider.label}`,
          models.map((model) => ({
            value: model,
            label: model,
            current: model === current,
            badge: model === current ? 'current' : undefined,
          })),
          live ? undefined : 'saved list — provider unreachable',
        );
        if (choice && choice !== current) await slashContextRef.current?.switchModel(choice);
      },
      pickProvider: async () => {
        const providers = config.listProviders();
        if (providers.length === 0) {
          notice('No providers configured. Run `orbit provider add`.', 'warning');
          return;
        }

        const activeId = config.get().activeProvider;
        const choice = await askSelect(
          'Provider',
          providers.map((provider) => {
            const source = config.apiKeySource(provider.id);
            return {
              value: provider.id,
              label: provider.label,
              current: provider.id === activeId,
              badge: `${provider.model ?? 'no model'} · ${
                source === 'env' ? 'env key' : source === 'store' ? 'key set' : 'no key'
              }`,
            };
          }),
        );
        if (choice && choice !== activeId) await slashContextRef.current?.switchProvider(choice);
      },
      askApiKey: async (providerId) => {
        const provider = config.getProvider(providerId);
        if (!provider) return;

        const key = await askSecret(
          `API key  ${provider.label}`,
          provider.apiKeyEnv ? `or set ${provider.apiKeyEnv} in your environment` : undefined,
        );
        if (!key) {
          notice('Key unchanged.');
          return;
        }

        await config.setApiKey(providerId, key);
        notice(`Key saved for ${provider.label}.`, 'success');

        // Rebuild the provider so the new key is used immediately.
        if (providerId === config.get().activeProvider) {
          try {
            const { provider: instance, label } = props.createProviderFor(providerId);
            await agent.switchProvider(instance, instance.model, label);
          } catch (error) {
            notice(`Saved, but could not reload the provider: ${errorMessage(error)}`, 'warning');
          }
        }
      },
      mcpClients: props.mcpClients ?? [],
      background: props.background,
      submit: (prompt) => void runPrompt(prompt),
      setTheme: async (name) => {
        await config.update((draft) => {
          draft.ui.theme = name as OrbitConfig['ui']['theme'];
        });
        setThemeName(name);
        notice(`Theme set to ${name}.`, 'success');
      },
      addWorkspaceRoot: async (dir) => {
        const resolved = path.resolve(sandbox.root, dir);
        const info = await statFile(resolved).catch(() => null);
        if (!info?.isDirectory()) {
          notice(`Not a directory: ${dir}`, 'warning');
          return;
        }
        sandbox.addRoot(resolved);
        agent.refreshSystemPrompt();
        notice(`Authorized ${tildify(resolved)} for this session.`, 'success');
      },
      print: (markdown) => append({ kind: 'markdown', id: nextId('md'), text: markdown }),
      notice,
      clearTranscript: () => {
        clearScreen();
        setTranscript([]);
      },
      exit: () => {
        void agent.persist().finally(() => exit());
      },
      switchModel: async (model) => {
        const providerId = config.get().activeProvider;
        if (!providerId) {
          notice('No provider is configured.', 'warning');
          return;
        }
        try {
          const { provider, label } = props.createProviderFor(providerId, model);
          await agent.switchProvider(provider, model, label);
          await config.useModel(model, providerId);
          setModelLabel(model);
          setProviderLabel(label);
          notice(`Model switched to ${model}.`, 'success');
        } catch (error) {
          append({
            kind: 'error',
            id: nextId('error'),
            error:
              error instanceof OrbitError
                ? error
                : new OrbitError('Could not switch model.', { detail: errorMessage(error) }),
          });
        }
      },
      switchProvider: async (providerId) => {
        const target = config.getProvider(providerId);
        if (!target) {
          notice(`No provider with id "${providerId}". See /provider.`, 'warning');
          return;
        }
        try {
          const { provider, label } = props.createProviderFor(providerId);
          await agent.switchProvider(provider, provider.model, label);
          await config.useProvider(providerId);
          setModelLabel(provider.model);
          setProviderLabel(label);
          notice(`Provider switched to ${label} (${provider.model}).`, 'success');
        } catch (error) {
          append({
            kind: 'error',
            id: nextId('error'),
            error:
              error instanceof OrbitError
                ? error
                : new OrbitError('Could not switch provider.', { detail: errorMessage(error) }),
          });
        }
      },
      compact: async () => {
        setStatus('compacting');
        const before = agent.context.budget(registry.definitions()).used;
        await agent.context.compact({
          tools: registry.definitions(),
          force: true,
          summarizer: agent.summarizer,
        });
        const after = agent.context.budget(registry.definitions()).used;
        setUsedTokens(after);
        setStatus('idle');
        notice(
          `Context compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens.`,
          'success',
        );
      },
      newSession: async () => {
        await agent.persist();
        agent.reset();
        setPlan([]);
        setUsedTokens(agent.context.budget(registry.definitions()).used);
        notice('Started a new session.', 'success');
      },
      resumeSession: async (id) => {
        const record = await sessions.load(id);
        if (!record) {
          notice(`No session found matching "${id}".`, 'warning');
          return;
        }
        await agent.persist();
        agent.adoptSession(record);
        setUsedTokens(agent.context.budget(registry.definitions()).used);
        notice(
          `Resumed ${record.id} (${record.messageCount} messages, ${record.provider.model}).`,
          'success',
        );
      },
      listModels: async () => {
        const provider = agent.provider;
        if (!provider.listModels) return [];
        const models = await provider.listModels();
        return models.map((model) => model.id);
      },
    }),
    [
      agent,
      config,
      sessions,
      registry,
      permissions,
      sandbox,
      autoMode,
      toggleAuto,
      askSelect,
      askSecret,
      append,
      notice,
      exit,
      props,
    ],
  );

  useEffect(() => {
    slashContextRef.current = slashContext;
  }, [slashContext]);

  const handleSubmit = useCallback(
    (value: string) => {
      if (isSlashCommand(value)) {
        const parsed = parseSlashCommand(value);
        const command = parsed ? resolveCommand(parsed.name, customCommands) : undefined;
        append({ kind: 'user', id: nextId('user'), text: value, attachments: [] });
        if (!command || !parsed) {
          notice(`Unknown command "${value.trim()}". Type /help for the list.`, 'warning');
          return;
        }
        void Promise.resolve(command.run(parsed.args, slashContext)).catch((error: unknown) => {
          notice(`/${parsed.name} failed: ${errorMessage(error)}`, 'danger');
        });
        return;
      }
      void runPrompt(value);
    },
    [append, notice, runPrompt, slashContext, customCommands],
  );

  // Run a prompt supplied on the command line, once, at startup.
  const initialRan = useRef(false);
  useEffect(() => {
    if (initialRan.current || !props.initialPrompt) return;
    initialRan.current = true;
    void runPrompt(props.initialPrompt);
  }, [props.initialPrompt, runPrompt]);

  const keyState = useGlobalKeys({
    busy,
    active: !pendingPermission && !modal && !introPlaying,
    onCancel: () => {
      if (!agent.cancel()) setStatus('idle');
    },
    onExit: () => {
      void agent.persist().finally(() => exit());
    },
    onClearScreen: () => {
      clearScreen();
      setTranscript([]);
    },
    onToggleExpand: () => setExpanded((value) => !value),
    onToggleAuto: () => toggleAuto(),
  });

  // ── completion ───────────────────────────────────────────────────────────

  const completer = useMemo(
    () =>
      createCompleter({
        sandbox,
        commands: commandList(customCommands),
        commandArguments: (command, prefix): Completion[] => {
          if (command === 'model') {
            const models = config.activeProvider()?.models ?? [];
            return models
              .filter((model) => model.startsWith(prefix))
              .map((model) => ({ value: model, label: model, kind: 'argument' }));
          }
          if (command === 'provider') {
            return config
              .listProviders()
              .filter((provider) => provider.id.startsWith(prefix))
              .map((provider) => ({
                value: provider.id,
                label: provider.id,
                kind: 'argument',
                description: provider.label,
              }));
          }
          if (command === 'permissions') {
            return ['read', 'search', 'write', 'delete', 'shell', 'network']
              .filter((name) => name.startsWith(prefix))
              .map((name) => ({ value: name, label: name, kind: 'argument' }));
          }
          if (command === 'auto') {
            return ['on', 'off', 'status']
              .filter((name) => name.startsWith(prefix))
              .map((name) => ({ value: name, label: name, kind: 'argument' }));
          }
          if (command === 'session') {
            return ['new'].filter((name) => name.startsWith(prefix)).map((name) => ({
              value: name,
              label: name,
              kind: 'argument',
            }));
          }
          return [];
        },
      }),
    [sandbox, config, customCommands],
  );

  // ── render ───────────────────────────────────────────────────────────────

  const workspaceSummary = useMemo(() => {
    const info = agent.workspace;
    const parts = [
      info.languages.join('/') || 'unknown',
      info.frameworks[0],
      info.packageManager,
      info.testFramework,
    ].filter(Boolean);
    return parts.join(' · ');
  }, [agent]);

  const statusLabel =
    status === 'thinking'
      ? 'Thinking'
      : status === 'streaming'
        ? 'Responding'
        : status === 'tools'
          ? 'Running tools'
          : status === 'compacting'
            ? 'Optimizing context'
            : '';

  const footerHint = keyState.hint
    ? keyState.hint
    : busy
      ? autoEnabled
        ? 'auto mode · ctrl+c to cancel'
        : 'ctrl+c to cancel'
      : pendingPermission
        ? 'waiting for your decision'
        : modal
          ? 'esc to cancel'
          : undefined;

  const usageSummary = useMemo(() => {
    const totals = agent.usageTracker.lifetimeTotals();
    if (totals.requests === 0) return undefined;
    return `${formatCount(totals.promptTokens)} in / ${formatCount(totals.completionTokens)} out lifetime`;
  }, [agent]);

  return (
    <ThemeContext.Provider value={activeTheme}>
      <Box flexDirection="column" width={columns}>
        <Static items={transcript}>
          {(item) => (
            <TranscriptView
              key={item.id}
              item={item}
              columns={columns}
              layout={layout}
              expanded={expanded}
              debug={debug}
              banner={{
                model: modelLabel,
                provider: providerLabel,
                workspace: sandbox.root,
                session: agent.sessionRecord.id,
                workspaceSummary,
                warnings: props.warnings,
                version: props.version,
                autoMode: autoEnabled,
                usageSummary,
                modelInfo: {
                  model: modelLabel,
                  provider: providerLabel,
                  contextWindow: agent.context.getContextWindow(),
                  supportsTools: agent.toolsAvailable,
                  supportsVision: agent.visionAvailable,
                },
              }}
            />
          )}
        </Static>

        {introPlaying && (
          <AnimatedBanner
            columns={columns}
            layout={layout}
            onComplete={() => {
              setIntroPlaying(false);
              // Commit one static frame so the scrollback matches the
              // non-animated launch exactly.
              append({ kind: 'banner', id: 'banner' });
            }}
          />
        )}

        {plan.length > 0 && <PlanView steps={plan} columns={columns} />}

        {reasoning && status === 'thinking' && (
          <ReasoningTrace text={reasoning} columns={columns} />
        )}

        {streamText && <AssistantMessage text={streamText} columns={columns} streaming />}

        {activeTools.map((tool) => (
          <ToolCallView
            key={tool.callId}
            name={tool.name}
            args={tool.args}
            status="running"
            progress={tool.progress}
            startedAt={tool.startedAt}
            columns={columns}
          />
        ))}

        {busy && !streamText && activeTools.length === 0 && (
          <Box marginBottom={1}>
            <Spinner label={statusLabel} />
          </Box>
        )}

        {pendingPermission && (
          <PermissionPrompt
            request={pendingPermission.request}
            columns={columns}
            onDecide={pendingPermission.resolve}
          />
        )}

        {!pendingPermission && modal?.kind === 'select' && (
          <SelectPrompt
            title={modal.title}
            hint={modal.hint}
            options={modal.options}
            columns={columns}
            onSelect={modal.onSelect}
            onCancel={modal.onCancel}
          />
        )}

        {!pendingPermission && modal?.kind === 'secret' && (
          <SecretPrompt
            title={modal.title}
            hint={modal.hint}
            columns={columns}
            onSubmit={modal.onSubmit}
            onCancel={modal.onCancel}
          />
        )}

        {!pendingPermission && !modal && !introPlaying && (
          <PromptInput
            columns={columns}
            history={history.current}
            disabled={busy}
            onSubmit={handleSubmit}
            complete={completer}
          />
        )}

        <Footer
          model={modelLabel}
          provider={providerLabel}
          workspace={sandbox.root}
          usedTokens={usedTokens}
          contextWindow={agent.context.getContextWindow()}
          session={agent.sessionRecord.id.slice(0, 18)}
          columns={columns}
          layout={layout}
          branch={branch}
          hint={footerHint}
          autoMode={autoEnabled}
          pressure={pressure}
        />
      </Box>
    </ThemeContext.Provider>
  );
}

interface TranscriptViewProps {
  item: TranscriptItem;
  columns: number;
  layout: ReturnType<typeof useTerminalSize>['layout'];
  expanded: boolean;
  debug: boolean;
  banner: Omit<BannerProps, 'columns' | 'layout'>;
}

function TranscriptView({
  item,
  columns,
  layout,
  expanded,
  debug,
  banner,
}: TranscriptViewProps): React.ReactElement | null {
  switch (item.kind) {
    case 'banner':
      return <Banner {...banner} columns={columns} layout={layout} />;
    case 'user':
      return <UserMessage text={item.text} columns={columns} attachments={item.attachments} />;
    case 'assistant':
      return <AssistantMessage text={item.text} columns={columns} />;
    case 'markdown':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Markdown text={item.text} columns={columns} />
        </Box>
      );
    case 'notice':
      return <Notice text={item.text} tone={item.tone} columns={columns} />;
    case 'tool':
      return (
        <ToolCallView
          name={item.name}
          args={item.args}
          status={item.status}
          result={item.result}
          durationMs={item.durationMs}
          deniedReason={item.deniedReason}
          columns={columns}
          expanded={expanded}
        />
      );
    case 'permission':
      return <PermissionRecord request={item.request} choice={item.choice} columns={columns} />;
    case 'plan':
      return <PlanView steps={item.steps} columns={columns} />;
    case 'error':
      return <ErrorBox error={item.error} columns={columns} debug={debug} />;
    default:
      return null;
  }
}

