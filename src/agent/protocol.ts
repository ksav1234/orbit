import type { ToolCall } from '../providers/provider.js';

/**
 * Fallback tool-call protocol for models without native function calling.
 *
 * Model output is *parsed*, never executed. A parsed call goes through exactly
 * the same schema validation and permission checks as a native tool call.
 */

const BLOCK_RE = /<orbit:tool\s+name="([a-zA-Z0-9_.-]+)"\s*>([\s\S]*?)<\/orbit:tool>/g;

export interface ParsedProtocol {
  /** Text with tool blocks removed, safe to show the user. */
  text: string;
  calls: ToolCall[];
  /** Blocks that looked like tool calls but could not be parsed. */
  errors: Array<{ name: string; reason: string; raw: string }>;
}

export function parseToolProtocol(output: string): ParsedProtocol {
  const calls: ToolCall[] = [];
  const errors: ParsedProtocol['errors'] = [];
  let text = output;
  let index = 0;

  BLOCK_RE.lastIndex = 0;
  const matches = [...output.matchAll(BLOCK_RE)];

  for (const match of matches) {
    const [block, name = '', body = ''] = match;
    text = text.replace(block, '');

    const trimmed = stripFences(body).trim();
    if (!trimmed) {
      calls.push({ id: makeId(index++), name, arguments: {} });
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        calls.push({ id: makeId(index++), name, arguments: parsed as Record<string, unknown> });
      } else {
        errors.push({ name, reason: 'the block body must be a JSON object', raw: trimmed });
      }
    } catch (error) {
      errors.push({
        name,
        reason: `the block body is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`,
        raw: trimmed,
      });
    }
  }

  return { text: text.trim(), calls, errors };
}

/** True once a complete tool block has been streamed, so the loop can act. */
export function containsToolBlock(output: string): boolean {
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(output);
}

/** Detects a partially-streamed block so the UI can hide it while it arrives. */
export function hasOpenToolBlock(output: string): boolean {
  const lastOpen = output.lastIndexOf('<orbit:tool');
  if (lastOpen === -1) return false;
  return output.indexOf('</orbit:tool>', lastOpen) === -1;
}

/** Hide in-progress protocol text from the transcript. */
export function stripPartialBlock(output: string): string {
  const lastOpen = output.lastIndexOf('<orbit:tool');
  if (lastOpen === -1) return output;
  if (output.indexOf('</orbit:tool>', lastOpen) !== -1) return output;
  return output.slice(0, lastOpen);
}

function stripFences(body: string): string {
  return body
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
}

function makeId(index: number): string {
  return `fallback_${index}_${Math.random().toString(36).slice(2, 8)}`;
}
