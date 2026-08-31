import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool, type ToolContext } from './registry.js';
import { walkFiles } from './search.js';
import { looksBinary } from './filesystem.js';
import { matchesGlob } from '../util/glob.js';
import { isParsable, parseSymbols, parsingAvailable } from './treesitter.js';
import { pluralize, truncateWidth } from '../util/format.js';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'method'
  | 'struct'
  | 'trait'
  | 'module';

export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  /** The declaration line, trimmed. */
  text: string;
  exported: boolean;
}

interface SymbolPattern {
  re: RegExp;
  kind: SymbolKind;
  /** Which capture group holds the name. */
  group?: number;
}

/**
 * Declaration patterns per language family.
 *
 * This is deliberately a lexical index, not a parser: it has to work on any
 * repository without a language server, a build, or a per-language toolchain.
 * It finds where things are declared, which is what "where is X defined?"
 * actually needs — grep finds every mention, which is usually noise.
 */
const PATTERNS: Record<string, SymbolPattern[]> = {
  js: [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
    {
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      kind: 'function',
    },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'const' },
    { re: /^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, kind: 'method' },
  ],
  python: [
    { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*async\s+def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
  ],
  rust: [
    { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
    { re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
    { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
    { re: /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module' },
  ],
  go: [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct' },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface' },
    { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: 'type' },
  ],
  java: [
    { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/, kind: 'method' },
  ],
  ruby: [
    { re: /^\s*def\s+([A-Za-z_]\w*[?!]?)/, kind: 'function' },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^\s*module\s+([A-Za-z_]\w*)/, kind: 'module' },
  ],
  php: [
    { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
  ],
  csharp: [
    { re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|abstract\s+|sealed\s+)*class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^\s*(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|async\s+)*[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)/, kind: 'method' },
  ],
};

const EXTENSION_FAMILY: Record<string, keyof typeof PATTERNS> = {
  '.ts': 'js',
  '.tsx': 'js',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
};

const MAX_FILES = 4_000;
const MAX_LINE_LENGTH = 400;

export function extractSymbols(text: string, relativePath: string): SymbolHit[] {
  const family = EXTENSION_FAMILY[path.extname(relativePath).toLowerCase()];
  if (!family) return [];
  const patterns = PATTERNS[family] ?? [];

  const hits: SymbolHit[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > MAX_LINE_LENGTH) continue;
    // Skip obvious comment lines so `// function foo()` is not indexed.
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;

    for (const pattern of patterns) {
      const match = pattern.re.exec(line);
      const name = match?.[pattern.group ?? 1];
      if (!name) continue;
      hits.push({
        name,
        kind: pattern.kind,
        file: relativePath,
        line: i + 1,
        text: line.trim(),
        exported: /^\s*(export|pub|public)\b/.test(line),
      });
      break; // First matching pattern wins; they are ordered most-specific first.
    }
  }

  return hits;
}

/**
 * Collect declarations across the workspace.
 *
 * Each file is parsed when a grammar exists for it, and pattern-matched
 * otherwise. `parsed` counts the files that got the accurate treatment, so the
 * tool can say which it used instead of implying more precision than it has.
 */
async function buildIndex(
  context: ToolContext,
  options: { glob?: string; onProgress?: (count: number) => void },
): Promise<{ symbols: SymbolHit[]; files: number; parsed: number }> {
  const symbols: SymbolHit[] = [];
  let files = 0;
  let parsed = 0;

  for await (const file of walkFiles(context.sandbox.root, context)) {
    if (context.signal.aborted || files >= MAX_FILES) break;

    const relative = path.relative(context.sandbox.root, file).split(path.sep).join('/');
    const extension = path.extname(relative).toLowerCase();
    if (!EXTENSION_FAMILY[extension] && !isParsable(relative)) continue;
    if (options.glob && !matchesGlob(relative, options.glob)) continue;

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;

    files++;
    if (files % 200 === 0) options.onProgress?.(files);

    const text = buffer.toString('utf8');
    const exact = await parseSymbols(text, relative);
    if (exact) {
      parsed++;
      symbols.push(...exact);
    } else {
      symbols.push(...extractSymbols(text, relative));
    }
  }

  return { symbols, files, parsed };
}

const findSymbolSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Symbol to find. Matched case-insensitively; a partial name is fine.'),
  kind: z
    .enum(['any', 'function', 'class', 'interface', 'type', 'enum', 'const', 'method', 'struct', 'trait', 'module'])
    .default('any')
    .describe('Restrict to one kind of declaration.'),
  glob: z.string().optional().describe('Restrict to matching files, e.g. "src/**/*.ts".'),
  exact: z.boolean().default(false).describe('Require an exact name match.'),
  max_results: z.number().int().min(1).max(200).default(40),
});

export const findSymbolTool: Tool = defineTool({
  name: 'find_symbol',
  description:
    'Find where a function, class, interface, type or constant is declared. Faster and far less noisy than search_files for "where is X defined?", because it matches declarations rather than every mention.',
  parameters: findSymbolSchema,
  permission: 'search',
  readOnly: true,
  async execute(args, context) {
    context.progress('Indexing declarations…');

    const { symbols, files, parsed } = await buildIndex(context, {
      glob: args.glob,
      onProgress: (count) => context.progress(`Indexed ${count} files…`),
    });

    // How the answer was arrived at, so a lexical result is not mistaken for a
    // parsed one.
    const method =
      parsed === files
        ? 'parsed'
        : parsed === 0
          ? 'matched by pattern'
          : `${parsed} of ${files} parsed, the rest matched by pattern`;

    const needle = args.name.toLowerCase();
    const matches = symbols
      .filter((symbol) => (args.kind === 'any' ? true : symbol.kind === args.kind))
      .filter((symbol) =>
        args.exact
          ? symbol.name.toLowerCase() === needle
          : symbol.name.toLowerCase().includes(needle),
      )
      // Exact matches first, then exported symbols, then alphabetically.
      .sort((a, b) => {
        const aExact = a.name.toLowerCase() === needle ? 0 : 1;
        const bExact = b.name.toLowerCase() === needle ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        if (a.exported !== b.exported) return a.exported ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, args.max_results);

    if (matches.length === 0) {
      const summary = `No declaration of "${args.name}"`;
      return toolOk(
        `${summary} found in ${pluralize(files, 'indexed file')} (${method}). It may be defined in a dependency, generated, or spelled differently — try search_files.`,
        { kind: 'matches', summary },
      );
    }

    const rendered = matches
      .map(
        (symbol) =>
          `${symbol.file}:${symbol.line}  [${symbol.kind}${symbol.exported ? ', exported' : ''}] ${symbol.name}\n    ${truncateWidth(symbol.text, 160)}`,
      )
      .join('\n');

    const summary = `${pluralize(matches.length, 'declaration')} of "${truncateWidth(args.name, 30)}"`;
    return toolOk(
      `${summary} (searched ${pluralize(files, 'file')}, ${method})\n\n${rendered}`,
      {
        kind: 'matches',
        summary,
        lines: matches.slice(0, 10).map((symbol) => `${symbol.file}:${symbol.line}  ${symbol.name}`),
        hiddenLines: Math.max(0, matches.length - 10),
        detail: rendered,
      },
      { metadata: { matches: matches.length, filesIndexed: files, filesParsed: parsed } },
    );
  },
});

const outlineSchema = z.object({
  path: z.string().describe('File to outline, relative to the workspace root.'),
});

export const outlineFileTool: Tool = defineTool({
  name: 'outline_file',
  description:
    'List the declarations in a single file with their line numbers. Use this to understand a large file before reading it in full.',
  parameters: outlineSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolved.absolute);
    } catch {
      return toolError(`File not found: ${resolved.relative}`);
    }
    if (looksBinary(buffer)) return toolError(`${resolved.relative} is a binary file.`);

    const text = buffer.toString('utf8');
    // Parsed when a grammar covers the language, pattern-matched otherwise.
    const parsedSymbols = await parseSymbols(text, resolved.relative);
    const symbols = parsedSymbols ?? extractSymbols(text, resolved.relative);
    const lineCount = text.split(/\r?\n/).length;

    if (symbols.length === 0) {
      return toolOk(
        `No declarations recognised in ${resolved.relative} (${pluralize(lineCount, 'line')}). Orbit indexes common languages only; read the file directly.`,
        { kind: 'text', summary: `${resolved.relative} — no declarations found` },
      );
    }

    const rendered = symbols
      .map((symbol) => `${String(symbol.line).padStart(6)}  [${symbol.kind}] ${symbol.name}`)
      .join('\n');

    return toolOk(
      `${resolved.relative} (${pluralize(lineCount, 'line')}, ${parsedSymbols ? 'parsed' : 'matched by pattern'})\n\n${rendered}`,
      {
        kind: 'text',
        summary: `${resolved.relative} — ${pluralize(symbols.length, 'declaration')}`,
        lines: symbols.slice(0, 12).map((symbol) => `${symbol.line}  ${symbol.name}`),
        hiddenLines: Math.max(0, symbols.length - 12),
        detail: rendered,
      },
      { metadata: { symbols: symbols.length, lines: lineCount } },
    );
  },
});

export const symbolTools: Tool[] = [findSymbolTool, outlineFileTool];
