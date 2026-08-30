import fs from 'node:fs/promises';
import path from 'node:path';
import type { Sandbox } from '../permissions/sandbox.js';

/** In-memory prompt history with the usual shell semantics. */
export class InputHistory {
  private entries: string[] = [];
  private cursor = -1;
  private draft = '';

  constructor(private readonly limit = 200) {}

  add(entry: string): void {
    const trimmed = entry.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] === trimmed) {
      this.cursor = -1;
      return;
    }
    this.entries.push(trimmed);
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = -1;
  }

  /** Move back through history; returns null when already at the oldest entry. */
  previous(current: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.cursor === -1) {
      this.draft = current;
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor -= 1;
    } else {
      return null;
    }
    return this.entries[this.cursor] ?? null;
  }

  /** Move forward; returns the saved draft once past the newest entry. */
  next(): string | null {
    if (this.cursor === -1) return null;
    if (this.cursor < this.entries.length - 1) {
      this.cursor += 1;
      return this.entries[this.cursor] ?? null;
    }
    this.cursor = -1;
    return this.draft;
  }

  reset(): void {
    this.cursor = -1;
    this.draft = '';
  }

  all(): string[] {
    return [...this.entries];
  }
}

export interface Completion {
  /** Text inserted in place of the token. */
  value: string;
  /** Text shown in the suggestion list. */
  label: string;
  kind: 'command' | 'file' | 'directory' | 'argument';
  description?: string;
}

export interface CompletionResult {
  /** Index in the buffer where the replacement starts. */
  start: number;
  /** Index where the replacement ends (usually the cursor). */
  end: number;
  items: Completion[];
}

export interface CompleterOptions {
  sandbox: Sandbox;
  commands: Array<{ name: string; description: string }>;
  /** Argument suggestions for a slash command, e.g. model names. */
  commandArguments?: (command: string, prefix: string) => Completion[];
}

/**
 * Tab completion for slash commands, their arguments, and workspace paths.
 * Paths are completed only inside the sandbox.
 */
export function createCompleter(options: CompleterOptions) {
  return async function complete(text: string, cursor: number): Promise<CompletionResult | null> {
    const upToCursor = text.slice(0, cursor);

    // Slash command at the very start of the buffer.
    if (/^\/[\w-]*$/.test(upToCursor)) {
      const prefix = upToCursor.slice(1).toLowerCase();
      const items = options.commands
        .filter((command) => command.name.startsWith(prefix))
        .map<Completion>((command) => ({
          value: `/${command.name} `,
          label: `/${command.name}`,
          kind: 'command',
          description: command.description,
        }));
      return items.length > 0 ? { start: 0, end: cursor, items } : null;
    }

    // Arguments to a slash command.
    const commandMatch = /^\/([\w-]+)\s+(\S*)$/.exec(upToCursor);
    if (commandMatch && options.commandArguments) {
      const [, command = '', prefix = ''] = commandMatch;
      const items = options.commandArguments(command, prefix);
      if (items.length > 0) {
        return { start: cursor - prefix.length, end: cursor, items };
      }
    }

    // Path completion on the token under the cursor. Tab is explicit intent,
    // so any word is a candidate; no matches simply means no suggestions.
    const tokenStart = findTokenStart(upToCursor);
    const token = upToCursor.slice(tokenStart);
    if (!token) return null;

    const items = await completePath(options.sandbox, token);
    return items.length > 0 ? { start: tokenStart, end: cursor, items } : null;
  };
}

function findTokenStart(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i]!;
    if (char === ' ' || char === '\n' || char === '\t' || char === '"' || char === "'") return i + 1;
  }
  return 0;
}

async function completePath(sandbox: Sandbox, token: string): Promise<Completion[]> {
  const separator = token.lastIndexOf('/');
  const dirPart = separator === -1 ? '' : token.slice(0, separator + 1);
  const filePart = separator === -1 ? token : token.slice(separator + 1);

  let resolved;
  try {
    resolved = sandbox.resolve(dirPart || '.');
  } catch {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
  } catch {
    return [];
  }

  const lower = filePart.toLowerCase();
  return entries
    .filter((entry) => entry.name.toLowerCase().startsWith(lower))
    .filter((entry) => !entry.isDirectory() || !sandbox.shouldIgnoreDir(entry.name))
    .filter((entry) => filePart.startsWith('.') || !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 30)
    .map<Completion>((entry) => ({
      value: `${dirPart}${entry.name}${entry.isDirectory() ? '/' : ''}`,
      label: `${entry.name}${entry.isDirectory() ? '/' : ''}`,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }));
}

/** Longest shared prefix, so Tab fills in as much as is unambiguous. */
export function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** `~` and absolute paths are expanded for display only. */
export function displayPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : target;
}
