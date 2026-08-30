import type { Message } from '../providers/provider.js';
import { estimateMessageTokens, estimateTokens } from './tokenizer.js';
import { clampChars } from '../util/format.js';

export interface ContextEntry {
  id: string;
  message: Message;
  tokens: number;
  /** Entries added by compaction, so they are not compacted again. */
  synthetic?: boolean;
  /** Tool results already reduced in size. */
  compressed?: boolean;
  timestamp: string;
}

export interface CompressionResult {
  entries: ContextEntry[];
  savedTokens: number;
  compressedCount: number;
}

/**
 * First compaction stage: shrink old tool results. Tool output is the bulk of a
 * long agent session and the least valuable to keep verbatim once acted upon.
 */
export function compressToolResults(
  entries: ContextEntry[],
  options: { keepRecent?: number; maxChars?: number } = {},
): CompressionResult {
  const keepRecent = options.keepRecent ?? 6;
  const maxChars = options.maxChars ?? 600;

  const toolIndices = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.message.role === 'tool' && !entry.compressed);

  const compressible = toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecent));
  if (compressible.length === 0) {
    return { entries, savedTokens: 0, compressedCount: 0 };
  }

  const next = [...entries];
  let saved = 0;

  for (const { entry, index } of compressible) {
    const content = typeof entry.message.content === 'string' ? entry.message.content : '';
    if (content.length <= maxChars) continue;

    const clamped = clampChars(content, maxChars);
    const replacement: ContextEntry = {
      ...entry,
      message: { ...entry.message, content: clamped.text },
      tokens: estimateTokens(clamped.text) + 4,
      compressed: true,
    };
    saved += entry.tokens - replacement.tokens;
    next[index] = replacement;
  }

  return {
    entries: next,
    savedTokens: Math.max(0, saved),
    compressedCount: compressible.length,
  };
}

export type Summarizer = (transcript: string, signal?: AbortSignal) => Promise<string>;

export interface SummarizeOptions {
  /** Number of trailing entries kept verbatim. */
  keepRecent?: number;
  summarizer?: Summarizer;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  entries: ContextEntry[];
  summary: string | null;
  removedCount: number;
  savedTokens: number;
}

/**
 * Second compaction stage: fold the older part of the conversation into a
 * written summary. When no model summarizer is available, fall back to a
 * deterministic outline so the agent never silently loses history.
 */
export async function summarizeOlderTurns(
  entries: ContextEntry[],
  options: SummarizeOptions = {},
): Promise<SummarizeResult> {
  const keepRecent = options.keepRecent ?? 8;
  if (entries.length <= keepRecent + 2) {
    return { entries, summary: null, removedCount: 0, savedTokens: 0 };
  }

  const boundary = findSafeBoundary(entries, entries.length - keepRecent);
  if (boundary <= 1) {
    return { entries, summary: null, removedCount: 0, savedTokens: 0 };
  }

  const older = entries.slice(0, boundary);
  const recent = entries.slice(boundary);
  const droppedTokens = older.reduce((sum, entry) => sum + entry.tokens, 0);

  const transcript = renderTranscript(older);
  let summary: string;
  if (options.summarizer) {
    try {
      summary = await options.summarizer(transcript, options.signal);
    } catch {
      summary = outlineTranscript(older);
    }
  } else {
    summary = outlineTranscript(older);
  }

  const summaryMessage: Message = {
    role: 'user',
    content: `[Summary of earlier conversation, generated automatically to free context space]\n\n${summary}`,
  };
  const summaryEntry: ContextEntry = {
    id: `summary-${Date.now().toString(36)}`,
    message: summaryMessage,
    tokens: estimateMessageTokens(summaryMessage),
    synthetic: true,
    timestamp: new Date().toISOString(),
  };

  return {
    entries: [summaryEntry, ...recent],
    summary,
    removedCount: older.length,
    savedTokens: Math.max(0, droppedTokens - summaryEntry.tokens),
  };
}

/**
 * Never split an assistant tool-call from its tool results: providers reject a
 * tool result whose call is missing, and vice versa.
 */
export function findSafeBoundary(entries: ContextEntry[], desired: number): number {
  let index = Math.min(Math.max(desired, 0), entries.length);

  // Move forward past any orphaned tool results.
  while (index < entries.length && entries[index]?.message.role === 'tool') index++;

  // If the entry just before the boundary requested tools, keep it with them.
  const previous = entries[index - 1];
  if (previous?.message.role === 'assistant' && (previous.message.toolCalls?.length ?? 0) > 0) {
    index -= 1;
  }
  return Math.max(0, index);
}

export function renderTranscript(entries: ContextEntry[]): string {
  return entries
    .map((entry) => {
      const { message } = entry;
      const content = typeof message.content === 'string' ? message.content : '[multimodal content]';
      if (message.role === 'tool') {
        return `TOOL RESULT (${message.name ?? 'tool'}): ${clampChars(content, 500).text}`;
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        const calls = message.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 200)})`).join(', ');
        return `ASSISTANT: ${content}\nCALLED: ${calls}`;
      }
      return `${message.role.toUpperCase()}: ${clampChars(content, 1500).text}`;
    })
    .join('\n\n');
}

/** Deterministic fallback summary: what was asked, what ran, what changed. */
export function outlineTranscript(entries: ContextEntry[]): string {
  const requests: string[] = [];
  const toolUses = new Map<string, number>();
  const filesTouched = new Set<string>();

  for (const entry of entries) {
    const { message } = entry;
    if (message.role === 'user' && typeof message.content === 'string') {
      const first = message.content.split('\n').find((line) => line.trim());
      if (first && !first.startsWith('[Summary of earlier')) requests.push(clampChars(first, 200).text);
    }
    for (const call of message.toolCalls ?? []) {
      toolUses.set(call.name, (toolUses.get(call.name) ?? 0) + 1);
      const target = call.arguments?.path ?? call.arguments?.source ?? call.arguments?.destination;
      if (typeof target === 'string') filesTouched.add(target);
    }
  }

  const lines: string[] = [];
  if (requests.length) {
    lines.push('User requests in this period:');
    lines.push(...requests.slice(-8).map((r) => `- ${r}`));
  }
  if (toolUses.size) {
    lines.push('', 'Tools used:');
    lines.push(
      ...[...toolUses.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `- ${name} ×${count}`),
    );
  }
  if (filesTouched.size) {
    lines.push('', 'Files referenced:');
    lines.push(...[...filesTouched].slice(0, 20).map((f) => `- ${f}`));
  }
  lines.push(
    '',
    'Detail from this period was dropped to free context. Re-read any file before relying on its contents.',
  );
  return lines.join('\n');
}

export const SUMMARIZER_PROMPT = `Summarize the conversation below for an AI coding agent that will keep working on the same task.

Include, in this order:
1. What the user asked for, including any constraints or preferences they stated.
2. What has already been done: files created, edited or deleted, and commands run with their outcomes.
3. Findings that still matter: root causes identified, decisions made, and things ruled out.
4. What remains to be done.

Be specific about file paths and command names. Do not invent anything that is not in the transcript. Write it as compact notes, not prose.`;
