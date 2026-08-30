import { z } from 'zod';

/** The five capability classes the permission system reasons about. */
export const PermissionLevelSchema = z.enum(['read', 'write', 'delete', 'execute', 'network']);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const PermissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionPolicySchema = z.object({
  read: PermissionDecisionSchema.default('allow'),
  search: PermissionDecisionSchema.default('allow'),
  write: PermissionDecisionSchema.default('ask'),
  delete: PermissionDecisionSchema.default('ask'),
  shell: PermissionDecisionSchema.default('ask'),
  network: PermissionDecisionSchema.default('ask'),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/** Wire dialects Orbit knows how to speak. */
export const ProviderKindSchema = z.enum(['openai-compatible', 'anthropic', 'gemini']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: ProviderKindSchema.default('openai-compatible'),
  baseURL: z.string().url(),
  model: z.string().optional(),
  /** Optional curated model list, used when the endpoint has no /models route. */
  models: z.array(z.string()).default([]),
  /** Environment variable consulted before the credential store. */
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string()).default({}),
  /** Overrides for capability detection when a model is not in the built-in tables. */
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  /** Model context window in tokens, when the provider does not report one. */
  contextWindow: z.number().int().positive().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const AgentConfigSchema = z.object({
  maxIterations: z.number().int().min(1).max(200).default(40),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(8192),
  /** Compact the conversation when this fraction of the window is used. */
  compactThreshold: z.number().min(0.3).max(0.98).default(0.82),
  autoCompact: z.boolean().default(true),
  /** Run independent read-only tool calls in parallel. */
  parallelReadTools: z.boolean().default(true),
  requestTimeoutMs: z.number().int().positive().default(180_000),
  maxRetries: z.number().int().min(0).max(10).default(3),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ToolsConfigSchema = z.object({
  shellTimeoutMs: z.number().int().positive().default(120_000),
  maxOutputChars: z.number().int().positive().default(30_000),
  maxFileReadChars: z.number().int().positive().default(200_000),
  maxSearchResults: z.number().int().positive().default(200),
  /** Extra ignore entries appended to the built-in ignore list. */
  extraIgnore: z.array(z.string()).default([]),
  /** Shell commands refused outright, regardless of approval. */
  blockedCommands: z.array(z.string()).default([]),
  /**
   * Shell commands approved without prompting, as regular expressions matched
   * against the whole command line. Narrower than a blanket `shell: allow`.
   */
  allowedCommands: z.array(z.string()).default([]),
  /** Refuse a write when the file changed on disk since the agent read it. */
  detectStaleWrites: z.boolean().default(true),
});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const THEME_NAMES = ['orbit', 'mono', 'ember', 'forest', 'ice'] as const;
export const ThemeNameSchema = z.enum(THEME_NAMES);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

export const UiConfigSchema = z.object({
  banner: z.boolean().default(true),
  compact: z.boolean().default(false),
  color: z.enum(['auto', 'always', 'never']).default('auto'),
  unicode: z.enum(['auto', 'on', 'off']).default('auto'),
  showThinking: z.boolean().default(true),
  theme: ThemeNameSchema.default('orbit'),
  /** Play the launch animation. Ignored when stdout is not a terminal. */
  animation: z.boolean().default(true),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

/**
 * Snapshots of every file the agent touches, so a turn can be undone.
 * Checkpoints hold file contents, so they live under `~/.orbit` with the
 * same 0600 treatment as sessions.
 */
export const CheckpointsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Turns kept per session before the oldest are dropped. */
  maxPerSession: z.number().int().min(1).max(500).default(50),
  /** Files larger than this are recorded but not snapshotted. */
  maxFileBytes: z.number().int().positive().default(2_000_000),
});
export type CheckpointsConfig = z.infer<typeof CheckpointsConfigSchema>;

/** Web access. Off unless a key is configured; uses the `network` permission. */
export const WebConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.literal('tavily').default('tavily'),
  baseURL: z.string().url().default('https://api.tavily.com'),
  apiKeyEnv: z.string().default('TAVILY_API_KEY'),
  maxResults: z.number().int().min(1).max(20).default(5),
  searchDepth: z.enum(['basic', 'advanced']).default('basic'),
  /** Ask the provider for a synthesised answer alongside the results. */
  includeAnswer: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  /** Characters kept per extracted page. */
  maxContentChars: z.number().int().positive().default(12_000),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

/** An MCP server Orbit launches and exposes as tools. */
export const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Only stdio transport is implemented. */
  transport: z.literal('stdio').default('stdio'),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const McpConfigSchema = z.object({
  servers: z.record(McpServerSchema).default({}),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Delegated sub-agents with their own context window. */
export const SubagentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Sub-agents may not spawn sub-agents unless this is raised. */
  maxDepth: z.number().int().min(0).max(3).default(1),
  maxIterations: z.number().int().min(1).max(60).default(15),
});
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

/**
 * Per-model prices, in units of currency per million tokens. Empty by default:
 * Orbit will not invent a rate, and shows costs only for models you price.
 */
export const PricingEntrySchema = z.object({
  inputPerMillion: z.number().min(0),
  outputPerMillion: z.number().min(0),
  currency: z.string().default('USD'),
});
export type PricingEntry = z.infer<typeof PricingEntrySchema>;

export const PricingConfigSchema = z.record(PricingEntrySchema);
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

export const SessionsConfigSchema = z.object({
  persist: z.boolean().default(true),
  maxStored: z.number().int().min(1).max(1000).default(100),
});
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

/**
 * Adaptive token budgeting. Orbit measures what the model actually consumes and
 * produces, then sizes each request to fit the window instead of using one
 * fixed number for every turn.
 */
export const OptimizerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Fraction of the context window Orbit aims to keep in use. */
  targetUtilization: z.number().min(0.3).max(0.95).default(0.75),
  /** Floor and ceiling for the adaptive response budget. */
  minResponseTokens: z.number().int().min(256).default(1024),
  maxResponseTokens: z.number().int().min(512).default(16_384),
  /** Shrink tool output limits when the window gets tight. */
  adaptiveToolOutput: z.boolean().default(true),
  /** Tell the user when the optimizer changes something. */
  announce: z.boolean().default(true),
  /**
   * Scale limits with the model's window rather than using fixed constants.
   * A 1M-token model then actually gets to use its room: bigger tool results,
   * bigger replies and far less compaction than a 32k model.
   */
  scaleWithWindow: z.boolean().default(true),
  /** Windows at or above this size are treated as large-context. */
  largeWindowThreshold: z.number().int().positive().default(200_000),
  /** Ceiling for a reply on a large-context model. */
  largeWindowMaxResponseTokens: z.number().int().min(512).default(65_536),
  /**
   * Ask the provider to cache the stable prefix (system prompt + tools) where
   * it supports it. Cuts input cost on long sessions.
   */
  promptCaching: z.boolean().default(true),
});
export type OptimizerConfig = z.infer<typeof OptimizerConfigSchema>;

/**
 * Auto-working agent mode. Off by default: it widens approval, so turning it on
 * is always a deliberate act.
 */
export const AutoModeConfigSchema = z.object({
  /** Start sessions with auto mode already on. */
  enabled: z.boolean().default(false),
  /** Auto-approve file writes and edits inside the workspace. */
  approveWrites: z.boolean().default(true),
  /** Auto-approve shell commands (still subject to the block list). */
  approveShell: z.boolean().default(true),
  /** Auto-approve deletions. Off: destructive work stays a human decision. */
  approveDeletes: z.boolean().default(false),
  /** Auto-approve sharing files that match a secret pattern. Off, deliberately. */
  approveSensitive: z.boolean().default(false),
  /** How many times Orbit may continue on its own before handing back. */
  maxContinuations: z.number().int().min(0).max(25).default(4),
});
export type AutoModeConfig = z.infer<typeof AutoModeConfigSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  activeProvider: z.string().optional(),
  providers: z.record(ProviderConfigSchema).default({}),
  permissions: PermissionPolicySchema.default({}),
  agent: AgentConfigSchema.default({}),
  optimizer: OptimizerConfigSchema.default({}),
  autoMode: AutoModeConfigSchema.default({}),
  checkpoints: CheckpointsConfigSchema.default({}),
  web: WebConfigSchema.default({}),
  mcp: McpConfigSchema.default({}),
  subagents: SubagentConfigSchema.default({}),
  pricing: PricingConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  ui: UiConfigSchema.default({}),
  sessions: SessionsConfigSchema.default({}),
});
export type OrbitConfig = z.infer<typeof ConfigSchema>;

/**
 * Built-in provider presets. Templates only: no keys live here, and users may
 * add any OpenAI-compatible endpoint of their own.
 */
export interface ProviderPreset extends Omit<ProviderConfig, 'headers' | 'models'> {
  description: string;
  keyUrl?: string;
  models: string[];
  headers?: Record<string, string>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI platform models.',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'Aggregated access to many hosted models.',
    keyUrl: 'https://openrouter.ai/keys',
    headers: { 'HTTP-Referer': 'https://github.com/orbit-cli', 'X-Title': 'Orbit' },
    models: [
      'qwen/qwen3-coder',
      'anthropic/claude-sonnet-4.5',
      'deepseek/deepseek-chat',
      'google/gemini-2.5-pro',
      'openai/gpt-5',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek chat and reasoning models.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    // DeepSeek documents 128K. If your account or endpoint serves a larger
    // window, raise it with `orbit model context <tokens>` and the optimizer
    // will scale reply and tool budgets to match.
    contextWindow: 128_000,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    description: 'NVIDIA-hosted inference microservices.',
    keyUrl: 'https://build.nvidia.com',
    models: [
      'qwen/qwen3-coder-480b-a35b-instruct',
      'meta/llama-3.3-70b-instruct',
      'deepseek-ai/deepseek-v3.1',
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Claude models over the native Messages API.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
    description: 'Gemini models over the native generateContent API.',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    description: 'Local models served by Ollama.',
    models: ['qwen3-coder', 'llama3.3', 'deepseek-r1'],
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
    description: 'Any endpoint implementing /chat/completions.',
    models: [],
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export function defaultConfig(): OrbitConfig {
  return ConfigSchema.parse({});
}
