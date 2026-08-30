import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { OrbitError } from '../util/errors.js';
import type { JSONSchema, ImagePart, ToolDefinition } from '../providers/provider.js';
import type { PermissionCategory, PermissionManager, PermissionRequest } from '../permissions/manager.js';
import type { Sandbox } from '../permissions/sandbox.js';
import type { ToolsConfig, WebConfig } from '../config/schema.js';
import type { CheckpointManager } from '../checkpoints/manager.js';
import type { FileReadTracker } from './tracker.js';
import type { BackgroundRegistry } from './background.js';
import type { WorkspaceInfo } from './project.js';

/** How a tool result should be rendered in the transcript. */
export type ToolDisplayKind = 'text' | 'tree' | 'diff' | 'output' | 'image' | 'pdf' | 'matches' | 'status';

export interface ToolDisplay {
  kind: ToolDisplayKind;
  /** One-line summary shown next to the tool name. */
  summary: string;
  /** Short preview lines rendered under the tool call. */
  lines?: string[];
  /** Full content, revealed when the user expands the entry. */
  detail?: string;
  /** Number of lines hidden from `lines`. */
  hiddenLines?: number;
}

export interface ToolResult {
  ok: boolean;
  /** The text the model sees. Never fabricated: always derived from real work. */
  content: string;
  /** Images to attach to the next model request (vision-capable models only). */
  images?: ImagePart[];
  display: ToolDisplay;
  /** Present when ok === false. */
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolProgress {
  (message: string): void;
}

export interface ToolContext {
  sandbox: Sandbox;
  permissions: PermissionManager;
  config: ToolsConfig;
  /** Absolute workspace root; also the default cwd for shell commands. */
  cwd: string;
  signal: AbortSignal;
  /** Report intermediate status to the UI (never seen by the model). */
  progress: ToolProgress;
  workspace?: WorkspaceInfo;
  /** True when the selected model can accept images. */
  visionAvailable: boolean;
  /** Snapshots files before they change, so a turn can be undone. */
  checkpoints?: CheckpointManager;
  /** Tracks what the agent has read, to catch writes over external edits. */
  fileTracker?: FileReadTracker;
  /** Web access configuration and credentials, when the user enabled it. */
  web?: WebAccess;
  /** Runs a delegated sub-agent; present only when sub-agents are enabled. */
  delegate?: DelegateRunner;
  /** Long-running processes started by this session. */
  background?: BackgroundRegistry;
}

/** Credentials and settings for the web tools. */
export interface WebAccess {
  config: WebConfig;
  apiKey: string | undefined;
}

export interface DelegateRequest {
  prompt: string;
  /** Tools the sub-agent may use; defaults to the read-only set. */
  tools?: string[];
  signal: AbortSignal;
  progress: ToolProgress;
}

export interface DelegateResult {
  text: string;
  toolCalls: number;
  iterations: number;
  usage?: { promptTokens: number; completionTokens: number };
}

export type DelegateRunner = (request: DelegateRequest) => Promise<DelegateResult>;

export interface ToolSpec<Schema extends z.ZodType> {
  name: string;
  description: string;
  parameters: Schema;
  /** Permission class checked before execution. Omit for always-allowed tools. */
  permission?: PermissionCategory;
  /** Read-only tools may be executed in parallel with each other. */
  readOnly: boolean;
  /** Build the approval prompt. Return null to execute without prompting. */
  authorize?(args: z.infer<Schema>, context: ToolContext): Promise<PermissionRequest | null>;
  execute(args: z.infer<Schema>, context: ToolContext): Promise<ToolResult>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: JSONSchema;
  readonly permission?: PermissionCategory;
  readonly readOnly: boolean;
  parse(args: unknown): unknown;
  authorize(args: unknown, context: ToolContext): Promise<PermissionRequest | null>;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

/** Wrap a spec into a Tool with schema generation and argument validation. */
export function defineTool<Schema extends z.ZodType>(spec: ToolSpec<Schema>): Tool {
  const jsonSchema = zodToJsonSchema(spec.parameters, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JSONSchema;
  delete jsonSchema.$schema;

  return {
    name: spec.name,
    description: spec.description,
    schema: jsonSchema,
    permission: spec.permission,
    readOnly: spec.readOnly,
    parse(args: unknown) {
      const result = spec.parameters.safeParse(args ?? {});
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
          .join('; ');
        throw new OrbitError(`Invalid arguments for ${spec.name}.`, {
          kind: 'tool',
          detail: issues,
        });
      }
      return result.data;
    },
    async authorize(args, context) {
      if (!spec.authorize) return null;
      return spec.authorize(args as z.infer<Schema>, context);
    },
    async execute(args, context) {
      return spec.execute(args as z.infer<Schema>, context);
    },
  };
}

/** Convenience constructors so tools return consistently shaped results. */
export function toolOk(
  content: string,
  display: Partial<ToolDisplay> & { summary: string },
  extra: Partial<ToolResult> = {},
): ToolResult {
  return {
    ok: true,
    content,
    display: { kind: display.kind ?? 'text', ...display },
    ...extra,
  };
}

export function toolError(
  message: string,
  display?: Partial<ToolDisplay>,
): ToolResult {
  return {
    ok: false,
    content: `Error: ${message}`,
    error: message,
    display: {
      kind: display?.kind ?? 'status',
      summary: display?.summary ?? message,
      ...display,
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new OrbitError(`Duplicate tool registration: ${tool.name}`, { kind: 'internal' });
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Definitions in the shape providers expect. */
  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    }));
  }

  /** Suggest a close match when the model invents a tool name. */
  suggest(name: string): string | undefined {
    const target = name.toLowerCase();
    let best: { name: string; score: number } | undefined;
    for (const candidate of this.tools.keys()) {
      const score = similarity(target, candidate.toLowerCase());
      if (score > 0.6 && (!best || score > best.score)) best = { name: candidate, score };
    }
    return best?.name;
  }
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  const distance = levenshtein(longer, shorter);
  return (longer.length - distance) / longer.length;
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j] ?? 0;
  }
  return previous[b.length] ?? 0;
}
