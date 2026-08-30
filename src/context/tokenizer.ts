import type { ContentPart, Message, ToolDefinition } from '../providers/provider.js';

/**
 * Orbit deliberately avoids a tokenizer dependency: every provider tokenizes
 * differently, and an estimate that is stable and slightly conservative is more
 * useful for budgeting than an exact count for one vendor.
 */

/** Average characters per token, tuned separately for prose and code. */
const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_CODE = 3.2;

/** Per-message envelope overhead (role markers, delimiters). */
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 10;

/** Vision models bill images by tile; this is a mid-range approximation. */
const IMAGE_TOKENS_BASE = 85;
const IMAGE_TOKENS_PER_KB = 0.35;

const CODE_HINT = /[{}();=><]|\bfunction\b|\bconst\b|\bimport\b|^\s{2,}/m;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const density = CODE_HINT.test(text) ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  return Math.ceil(text.length / density);
}

export function estimateContentTokens(content: string | ContentPart[]): number {
  if (typeof content === 'string') return estimateTokens(content);
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') {
      total += estimateTokens(part.text);
    } else {
      const kilobytes = (part.data.length * 0.75) / 1024;
      total += Math.ceil(IMAGE_TOKENS_BASE + kilobytes * IMAGE_TOKENS_PER_KB);
    }
  }
  return total;
}

export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content);
  for (const call of message.toolCalls ?? []) {
    total += TOOL_CALL_OVERHEAD_TOKENS + estimateTokens(call.name);
    total += estimateTokens(JSON.stringify(call.arguments ?? {}));
  }
  return total;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** Tool schemas are re-sent on every request, so they belong in the budget. */
export function estimateToolTokens(tools: ToolDefinition[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum + estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters)),
    0,
  );
}

export interface BudgetInput {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** Space held back for the model's reply. */
  responseReserve: number;
  contextWindow: number;
}

export interface Budget {
  used: number;
  window: number;
  /** Tokens available before the reserve is eaten into. */
  available: number;
  ratio: number;
  breakdown: { system: number; messages: number; tools: number; reserve: number };
}

export function computeBudget(input: BudgetInput): Budget {
  const system = estimateTokens(input.systemPrompt);
  const messages = estimateMessagesTokens(input.messages);
  const tools = estimateToolTokens(input.tools);
  const used = system + messages + tools;
  const available = Math.max(0, input.contextWindow - used - input.responseReserve);

  return {
    used,
    window: input.contextWindow,
    available,
    ratio: input.contextWindow > 0 ? used / input.contextWindow : 0,
    breakdown: { system, messages, tools, reserve: input.responseReserve },
  };
}
