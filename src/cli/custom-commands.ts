import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../util/logger.js';
import type { SlashCommand } from './commands.js';

const log = createLogger('custom-commands');

/** Where Orbit looks for user- and project-defined commands. */
export const COMMAND_DIRS = ['.orbit/commands'];

export interface CustomCommandFile {
  name: string;
  description: string;
  /** The prompt template, with placeholders already documented. */
  template: string;
  source: string;
}

/**
 * Project-defined slash commands.
 *
 * A file at `.orbit/commands/review.md` becomes `/review`. Its body is sent as
 * the prompt, with `$ARGUMENTS` (or `$1`, `$2`, …) substituted — a way for a
 * team to share a reviewed, repeatable instruction instead of retyping it.
 */
export async function loadCustomCommands(roots: string[]): Promise<CustomCommandFile[]> {
  const found = new Map<string, CustomCommandFile>();

  for (const root of roots) {
    for (const relative of COMMAND_DIRS) {
      const dir = path.join(root, relative);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md') && !entry.endsWith('.txt')) continue;
        const name = path.basename(entry, path.extname(entry)).toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) continue;

        try {
          const raw = await fs.readFile(path.join(dir, entry), 'utf8');
          const parsed = parseCommandFile(raw);
          found.set(name, {
            name,
            description: parsed.description || `Project command from ${relative}/${entry}`,
            template: parsed.body,
            source: path.join(relative, entry),
          });
        } catch (error) {
          log.warn('could not read custom command', { entry, error: String(error) });
        }
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * An optional front-matter-ish first line: `--- description: ... ---`, or a
 * leading `# Heading` used as the description.
 */
export function parseCommandFile(raw: string): { description: string; body: string } {
  const lines = raw.split(/\r?\n/);

  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      const front = lines.slice(1, end).join('\n');
      const match = /description\s*:\s*(.+)/i.exec(front);
      return {
        description: match?.[1]?.trim() ?? '',
        body: lines.slice(end + 1).join('\n').trim(),
      };
    }
  }

  const heading = /^#\s+(.+)$/.exec(lines[0]?.trim() ?? '');
  if (heading?.[1]) {
    return { description: heading[1].trim(), body: lines.slice(1).join('\n').trim() };
  }

  const firstLine = lines.find((line) => line.trim())?.trim() ?? '';
  return { description: firstLine.slice(0, 80), body: raw.trim() };
}

/** Substitute `$ARGUMENTS` and positional `$1`…`$9`. */
export function renderTemplate(template: string, args: string): string {
  const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : [];

  let out = template.replace(/\$ARGUMENTS\b/g, args.trim());
  out = out.replace(/\$(\d)\b/g, (_match, digit: string) => parts[Number(digit) - 1] ?? '');

  // A command with no placeholder still gets the arguments, appended, so
  // `/review src/auth.ts` works whether or not the author used $ARGUMENTS.
  if (!/\$ARGUMENTS\b|\$\d\b/.test(template) && args.trim()) {
    out = `${out}\n\n${args.trim()}`;
  }
  return out.trim();
}

/** Convert loaded files into runnable slash commands. */
export function toSlashCommands(
  files: CustomCommandFile[],
  send: (prompt: string) => void,
): SlashCommand[] {
  return files.map((file) => ({
    name: file.name,
    description: file.description,
    usage: '[arguments]',
    run(args) {
      send(renderTemplate(file.template, args));
    },
  }));
}
