import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool, type ToolContext, type ToolResult } from './registry.js';
import { isCommandAvailable, runCommand } from '../util/process.js';
import { matchesGlob } from '../util/glob.js';
import { looksBinary } from './filesystem.js';
import { pluralize, truncateWidth } from '../util/format.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('tools:search');

const MAX_WALK_FILES = 20_000;
const MAX_LINE_LENGTH = 400;

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

// ── search_files (content search) ──────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1).describe('Text or regular expression to search for.'),
  path: z.string().default('.').describe('Directory or file to search, relative to the workspace root.'),
  glob: z
    .string()
    .optional()
    .describe('Restrict to matching files, e.g. "**/*.ts" or "*.{js,jsx}".'),
  regex: z.boolean().default(true).describe('Treat the query as a regular expression.'),
  case_sensitive: z.boolean().default(false).describe('Match case exactly.'),
  max_results: z.number().int().min(1).max(1000).optional().describe('Cap the number of matches.'),
});

export const searchFilesTool: Tool = defineTool({
  name: 'search_files',
  description:
    'Search file contents across the workspace and return matching lines with their locations. Uses ripgrep when available. Ignored directories such as node_modules and .git are skipped.',
  parameters: searchSchema,
  permission: 'search',
  readOnly: true,
  async execute(args, context) {
    const resolved = context.sandbox.resolve(args.path);
    const limit = args.max_results ?? context.config.maxSearchResults;

    let matches: SearchMatch[];
    let engine: 'ripgrep' | 'builtin';

    if (await isCommandAvailable('rg')) {
      engine = 'ripgrep';
      matches = await ripgrepSearch(args, resolved.absolute, limit, context);
    } else {
      engine = 'builtin';
      matches = await builtinSearch(args, resolved.absolute, limit, context);
    }

    if (matches.length === 0) {
      const summary = `No matches for "${truncateWidth(args.query, 40)}"`;
      return toolOk(`${summary} in ${resolved.relative}.`, { kind: 'matches', summary });
    }

    const byFile = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const list = byFile.get(match.file) ?? [];
      list.push(match);
      byFile.set(match.file, list);
    }

    const rendered = [...byFile.entries()]
      .map(([file, fileMatches]) => {
        const lines = fileMatches
          .map((m) => `  ${m.line}: ${truncateWidth(m.text.trim(), MAX_LINE_LENGTH)}`)
          .join('\n');
        return `${file}\n${lines}`;
      })
      .join('\n\n');

    const summary = `${pluralize(matches.length, 'match', 'matches')} in ${pluralize(byFile.size, 'file')}`;
    const previewLines = [...byFile.entries()]
      .slice(0, 8)
      .map(([file, fileMatches]) => `${file} (${fileMatches.length})`);

    return toolOk(
      `${summary} for "${args.query}"\n\n${rendered}`,
      {
        kind: 'matches',
        summary,
        lines: previewLines,
        hiddenLines: Math.max(0, byFile.size - previewLines.length),
        detail: rendered,
      },
      { metadata: { engine, matches: matches.length, files: byFile.size } },
    );
  },
});

async function ripgrepSearch(
  args: z.infer<typeof searchSchema>,
  absolute: string,
  limit: number,
  context: ToolContext,
): Promise<SearchMatch[]> {
  const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '50'];
  if (!args.case_sensitive) rgArgs.push('--ignore-case');
  if (!args.regex) rgArgs.push('--fixed-strings');
  if (args.glob) rgArgs.push('--glob', args.glob);
  for (const dir of context.sandbox.ignoredDirNames()) rgArgs.push('--glob', `!${dir}/`);
  rgArgs.push('--regexp', args.query, absolute);

  const result = await runCommand({
    command: 'rg',
    args: rgArgs,
    cwd: context.cwd,
    signal: context.signal,
    timeoutMs: 30_000,
    maxOutputChars: 2_000_000,
  });

  // rg exits 1 when there are no matches; anything higher is a real failure.
  if (result.code !== null && result.code > 1) {
    log.warn('ripgrep failed, falling back to the built-in search', { code: result.code });
    return builtinSearch(args, absolute, limit, context);
  }

  const matches: SearchMatch[] = [];
  for (const line of result.stdout.split('\n')) {
    if (matches.length >= limit) break;
    const parsed = parseRipgrepLine(line, context.sandbox.root);
    if (parsed) matches.push(parsed);
  }
  return matches;
}

/** rg output is `path:line:text`; on Windows the path contains a drive colon. */
export function parseRipgrepLine(line: string, root: string): SearchMatch | null {
  if (!line.trim()) return null;
  const driveOffset = /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0;
  const firstColon = line.indexOf(':', driveOffset);
  if (firstColon === -1) return null;
  const secondColon = line.indexOf(':', firstColon + 1);
  if (secondColon === -1) return null;

  const file = line.slice(0, firstColon);
  const lineNumber = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);
  if (!Number.isFinite(lineNumber)) return null;

  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return {
    file: relative.split(path.sep).join('/'),
    line: lineNumber,
    text: line.slice(secondColon + 1),
  };
}

async function builtinSearch(
  args: z.infer<typeof searchSchema>,
  absolute: string,
  limit: number,
  context: ToolContext,
): Promise<SearchMatch[]> {
  const pattern = buildPattern(args.query, args.regex, args.case_sensitive);
  const matches: SearchMatch[] = [];

  for await (const file of walkFiles(absolute, context)) {
    if (context.signal.aborted || matches.length >= limit) break;
    const relative = path.relative(context.sandbox.root, file).split(path.sep).join('/');
    if (args.glob && !matchesGlob(relative, args.glob)) continue;

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;

    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) break;
      const text = lines[i]!;
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        matches.push({ file: relative, line: i + 1, text });
      }
    }
  }

  return matches;
}

function buildPattern(query: string, isRegex: boolean, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? 'g' : 'gi';
  if (!isRegex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  try {
    return new RegExp(query, flags);
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

// ── find_files (name search) ───────────────────────────────────────────────

const findSchema = z.object({
  pattern: z.string().min(1).describe('Glob to match against paths, e.g. "**/*.test.ts" or "Dockerfile".'),
  path: z.string().default('.').describe('Directory to search, relative to the workspace root.'),
  max_results: z.number().int().min(1).max(2000).default(200),
});

export const findFilesTool: Tool = defineTool({
  name: 'find_files',
  description:
    'Find files by name or glob pattern. Returns workspace-relative paths sorted alphabetically.',
  parameters: findSchema,
  permission: 'search',
  readOnly: true,
  async execute(args, context) {
    const resolved = context.sandbox.resolve(args.path);
    const found: string[] = [];

    for await (const file of walkFiles(resolved.absolute, context)) {
      if (context.signal.aborted || found.length >= args.max_results) break;
      const relative = path.relative(context.sandbox.root, file).split(path.sep).join('/');
      if (matchesGlob(relative, args.pattern)) found.push(relative);
    }

    found.sort((a, b) => a.localeCompare(b));

    if (found.length === 0) {
      const summary = `No files match ${args.pattern}`;
      return toolOk(`${summary} under ${resolved.relative}.`, { kind: 'matches', summary });
    }

    const summary = `${pluralize(found.length, 'file')} matching ${args.pattern}`;
    return toolOk(
      `${summary}\n\n${found.join('\n')}`,
      {
        kind: 'matches',
        summary,
        lines: found.slice(0, 10),
        hiddenLines: Math.max(0, found.length - 10),
        detail: found.join('\n'),
      },
      { metadata: { count: found.length } },
    );
  },
});

/** Depth-first file walk that honours the sandbox ignore list and cancellation. */
export async function* walkFiles(root: string, context: ToolContext): AsyncGenerator<string> {
  let visited = 0;
  const stack: string[] = [root];

  const rootStat = await fs.stat(root).catch(() => null);
  if (rootStat?.isFile()) {
    yield root;
    return;
  }

  while (stack.length > 0) {
    if (context.signal.aborted || visited >= MAX_WALK_FILES) return;
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (context.sandbox.shouldIgnoreDir(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        visited++;
        yield full;
      }
    }
  }
}

export const searchTools: Tool[] = [searchFilesTool, findFilesTool];
