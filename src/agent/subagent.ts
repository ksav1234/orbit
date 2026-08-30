import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool, type ToolContext } from '../tools/registry.js';
import { clampChars, formatCount, pluralize } from '../util/format.js';
import { errorMessage } from '../util/errors.js';

/**
 * Delegation.
 *
 * A broad search ("where is authentication handled?") can burn tens of
 * thousands of tokens on tool output that stops being useful the moment the
 * answer is found. A sub-agent does that work in its own context window and
 * returns only its conclusion, so the main conversation stays small.
 */

export const SUBAGENT_SYSTEM_PROMPT = `You are a focused sub-agent working for Orbit's main agent.

You have been given one specific, self-contained task. Complete it using the tools available, then report back.

Rules:
- Work only on the task you were given. Do not expand scope.
- Your reply is the only thing the main agent will see: the tool output you gathered is discarded. Include every concrete detail it will need — file paths with line numbers, exact names, exact command output that mattered.
- Be concise but complete. No preamble, no restating the task.
- If you could not determine something, say so explicitly rather than guessing.
- Never claim to have run a tool you did not run.`;

const taskSchema = z.object({
  description: z
    .string()
    .min(4)
    .max(120)
    .describe('Short label for what this sub-agent is doing, shown to the user.'),
  prompt: z
    .string()
    .min(10)
    .describe(
      'The full, self-contained task. The sub-agent cannot see this conversation, so include all the context it needs.',
    ),
  scope: z
    .enum(['read-only', 'full'])
    .default('read-only')
    .describe(
      'read-only lets it inspect and search; full also lets it edit files and run commands (each still needing approval).',
    ),
});

/** Tools a read-only sub-agent may use. */
export const READ_ONLY_SUBAGENT_TOOLS = [
  'list_files',
  'read_file',
  'search_files',
  'find_files',
  'find_symbol',
  'outline_file',
  'inspect_project',
  'project_structure',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'read_pdf',
];

export const taskTool: Tool = defineTool({
  name: 'task',
  description:
    'Delegate a self-contained investigation to a sub-agent with its own context window. Use it for open-ended searches ("find everywhere X is configured") where the intermediate tool output would be large and only the conclusion matters. Do not use it for work you can finish in two or three tool calls.',
  parameters: taskSchema,
  readOnly: true,
  async execute(args, context: ToolContext) {
    if (!context.delegate) {
      return toolError(
        'Sub-agents are not available in this session. Do the work directly with the other tools.',
      );
    }

    context.progress(`Delegating: ${args.description}`);

    try {
      const result = await context.delegate({
        prompt: args.prompt,
        tools: args.scope === 'read-only' ? READ_ONLY_SUBAGENT_TOOLS : undefined,
        signal: context.signal,
        progress: (message) => context.progress(`${args.description}: ${message}`),
      });

      const report = result.text.trim();
      if (!report) {
        return toolError(
          `The sub-agent finished without producing a report after ${pluralize(result.toolCalls, 'tool call')}. Try a more specific task, or do the work directly.`,
        );
      }

      const clamped = clampChars(report, context.config.maxFileReadChars);
      const cost = result.usage
        ? ` · ${formatCount(result.usage.promptTokens + result.usage.completionTokens)} tokens`
        : '';

      return toolOk(
        [
          `Sub-agent report — ${args.description}`,
          `(${pluralize(result.toolCalls, 'tool call')} over ${pluralize(result.iterations, 'step')})`,
          '',
          clamped.text,
        ].join('\n'),
        {
          kind: 'text',
          summary: `${args.description} — ${pluralize(result.toolCalls, 'tool call')}${cost}`,
          lines: clamped.text.split('\n').slice(0, 12),
          detail: report,
        },
        {
          metadata: {
            toolCalls: result.toolCalls,
            iterations: result.iterations,
            tokens: result.usage
              ? result.usage.promptTokens + result.usage.completionTokens
              : undefined,
          },
        },
      );
    } catch (error) {
      return toolError(`The sub-agent failed: ${errorMessage(error)}`);
    }
  },
});
