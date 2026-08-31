import path from 'node:path';
import { createRequire } from 'node:module';
import { createLogger } from '../util/logger.js';
import type { SymbolHit, SymbolKind } from './symbols.js';

const log = createLogger('treesitter');

/**
 * Real parsing for `find_symbol` and `outline_file`.
 *
 * The lexical index this sits in front of finds declarations reliably and
 * nothing else — it cannot tell a method from a call, or a name in a comment
 * from a definition. Tree-sitter can, because it builds an actual syntax tree.
 *
 * Two constraints shaped how it is wired in:
 *
 *  - **No native compilation.** The grammars are pre-built WASM, so an install
 *    behaves the same on Windows, macOS and Linux and needs no toolchain.
 *  - **Optional.** The grammar bundle is tens of megabytes, so it is an optional
 *    dependency. When it is absent, everything falls back to the lexical index
 *    and says so, rather than the tools disappearing.
 */

const GRAMMAR_PACKAGE = '@vscode/tree-sitter-wasm';

/** Extension → the grammar that understands it. */
const GRAMMARS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'c-sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'cpp',
  '.h': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.css': 'css',
  '.scss': 'css',
  '.ps1': 'powershell',
};

/**
 * Which nodes count as a definition, per grammar.
 *
 * Written as capture names so one query can carry the kind: a `@class` capture
 * is a class wherever it appears. Patterns a grammar does not have are dropped
 * at compile time rather than failing the whole query.
 */
const QUERIES: Record<string, string[]> = {
  typescript: [
    '(class_declaration name: (type_identifier) @class)',
    '(abstract_class_declaration name: (type_identifier) @class)',
    '(function_declaration name: (identifier) @function)',
    '(generator_function_declaration name: (identifier) @function)',
    '(method_definition name: (property_identifier) @method)',
    '(public_field_definition name: (property_identifier) @const)',
    '(interface_declaration name: (type_identifier) @interface)',
    '(type_alias_declaration name: (type_identifier) @type)',
    '(enum_declaration name: (identifier) @enum)',
    '(variable_declarator name: (identifier) @function value: (arrow_function))',
    '(variable_declarator name: (identifier) @function value: (function_expression))',
    // Plain bindings too: `const TIMEOUT = 5` is something people search for.
    // A function-valued binding matches this as well as the patterns above; the
    // more specific kind wins when they collide.
    '(variable_declarator name: (identifier) @const)',
    '(module name: (identifier) @module)',
  ],
  javascript: [
    '(class_declaration name: (identifier) @class)',
    '(function_declaration name: (identifier) @function)',
    '(generator_function_declaration name: (identifier) @function)',
    '(method_definition name: (property_identifier) @method)',
    '(variable_declarator name: (identifier) @function value: (arrow_function))',
    '(variable_declarator name: (identifier) @function value: (function_expression))',
    // Plain bindings too: `const TIMEOUT = 5` is something people search for.
    // A function-valued binding matches this as well as the patterns above; the
    // more specific kind wins when they collide.
    '(variable_declarator name: (identifier) @const)',
  ],
  python: [
    '(class_definition name: (identifier) @class)',
    '(function_definition name: (identifier) @function)',
    '(decorated_definition definition: (function_definition name: (identifier) @function))',
  ],
  rust: [
    '(struct_item name: (type_identifier) @struct)',
    '(enum_item name: (type_identifier) @enum)',
    '(trait_item name: (type_identifier) @trait)',
    '(function_item name: (identifier) @function)',
    '(impl_item type: (type_identifier) @class)',
    '(type_item name: (type_identifier) @type)',
    '(mod_item name: (identifier) @module)',
    '(const_item name: (identifier) @const)',
  ],
  go: [
    '(function_declaration name: (identifier) @function)',
    '(method_declaration name: (field_identifier) @method)',
    '(type_spec name: (type_identifier) @type)',
    '(const_spec name: (identifier) @const)',
  ],
  java: [
    '(class_declaration name: (identifier) @class)',
    '(interface_declaration name: (identifier) @interface)',
    '(enum_declaration name: (identifier) @enum)',
    '(method_declaration name: (identifier) @method)',
    '(record_declaration name: (identifier) @class)',
  ],
  'c-sharp': [
    '(class_declaration name: (identifier) @class)',
    '(interface_declaration name: (identifier) @interface)',
    '(struct_declaration name: (identifier) @struct)',
    '(enum_declaration name: (identifier) @enum)',
    '(method_declaration name: (identifier) @method)',
    '(record_declaration name: (identifier) @class)',
  ],
  ruby: [
    '(class name: (constant) @class)',
    '(module name: (constant) @module)',
    '(method name: (identifier) @method)',
    '(singleton_method name: (identifier) @method)',
  ],
  php: [
    '(class_declaration name: (name) @class)',
    '(interface_declaration name: (name) @interface)',
    '(trait_declaration name: (name) @trait)',
    '(function_definition name: (name) @function)',
    '(method_declaration name: (name) @method)',
  ],
  cpp: [
    '(struct_specifier name: (type_identifier) @struct)',
    '(class_specifier name: (type_identifier) @class)',
    '(enum_specifier name: (type_identifier) @enum)',
    '(function_declarator declarator: (identifier) @function)',
    '(function_declarator declarator: (field_identifier) @method)',
    '(type_definition declarator: (type_identifier) @type)',
  ],
  bash: ['(function_definition name: (word) @function)'],
  css: [],
  powershell: [],
};

interface LoadedGrammar {
  language: unknown;
  query: unknown;
}

interface Runtime {
  Parser: {
    init(options?: Record<string, unknown>): Promise<void>;
    new (): {
      setLanguage(language: unknown): void;
      parse(source: string): { rootNode: TsNode } | null;
      delete(): void;
    };
  };
  Language: { load(pathOrBytes: string): Promise<unknown> };
  Query: new (
    language: unknown,
    source: string,
  ) => { captures(node: TsNode): Array<{ name: string; node: TsNode }> };
}

interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  parent: TsNode | null;
}

/** Null once we know the grammar bundle is not installed. */
let runtime: Runtime | null | undefined;
let runtimeReady: Promise<Runtime | null> | undefined;
const grammars = new Map<string, LoadedGrammar | null>();

/** The extensions tree-sitter can parse, for the tool description and docs. */
export function parsableExtensions(): string[] {
  return Object.keys(GRAMMARS).sort();
}

/** True when a file could be parsed rather than pattern-matched. */
export function isParsable(filePath: string): boolean {
  return GRAMMARS[path.extname(filePath).toLowerCase()] !== undefined;
}

/**
 * Load the WASM runtime, once. Resolves to null when the optional grammar
 * bundle is not installed, which is a supported state rather than an error.
 */
async function ensureRuntime(): Promise<Runtime | null> {
  if (runtime !== undefined) return runtime;
  runtimeReady ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const loaded = require(GRAMMAR_PACKAGE) as Runtime;
      // `locateFile` is how Emscripten finds the sibling .wasm; without it the
      // lookup is relative to the process cwd, which is the user's workspace.
      await loaded.Parser.init({
        locateFile: () => require.resolve(`${GRAMMAR_PACKAGE}/wasm/tree-sitter.wasm`),
      });
      runtime = loaded;
      log.debug('tree-sitter runtime ready');
    } catch (error) {
      runtime = null;
      log.debug('tree-sitter unavailable; using the lexical index', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return runtime;
  })();
  return runtimeReady;
}

/** True when precise parsing is available at all. */
export async function parsingAvailable(): Promise<boolean> {
  return (await ensureRuntime()) !== null;
}

async function loadGrammar(name: string): Promise<LoadedGrammar | null> {
  const cached = grammars.get(name);
  if (cached !== undefined) return cached;

  const active = await ensureRuntime();
  if (!active) {
    grammars.set(name, null);
    return null;
  }

  try {
    const require = createRequire(import.meta.url);
    const wasm = require.resolve(`${GRAMMAR_PACKAGE}/wasm/tree-sitter-${name}.wasm`);
    const language = await active.Language.load(wasm);

    // Compile patterns one at a time: a grammar that lacks a node type rejects
    // the whole query, and losing every pattern over one unsupported rule would
    // silently drop a language.
    const supported: string[] = [];
    for (const pattern of QUERIES[name] ?? []) {
      try {
        new active.Query(language, pattern);
        supported.push(pattern);
      } catch {
        log.debug('pattern not supported by grammar', { grammar: name, pattern });
      }
    }
    if (supported.length === 0) {
      grammars.set(name, null);
      return null;
    }

    const query = new active.Query(language, supported.join('\n'));
    const entry: LoadedGrammar = { language, query };
    grammars.set(name, entry);
    return entry;
  } catch (error) {
    log.debug('grammar failed to load', { grammar: name, error: String(error) });
    grammars.set(name, null);
    return null;
  }
}

/**
 * Most specific first. When two patterns describe the same declaration, the
 * earlier kind wins — a function-valued binding is reported as a function, not
 * as a constant that happens to hold one.
 */
const KIND_PRIORITY: SymbolKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'struct',
  'trait',
  'enum',
  'type',
  'module',
  'const',
];

const KINDS = new Set<SymbolKind>([
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'const',
  'method',
  'struct',
  'trait',
  'module',
]);

/**
 * Whether a definition is visible outside its file.
 *
 * Asked of the tree rather than the text, so `export` inside a string or a
 * comment cannot be mistaken for the real thing. Each language spells it
 * differently, and a language with no concept of it reports everything as
 * exported — which is accurate, not a fallback.
 */
function isExported(node: TsNode, grammar: string): boolean {
  if (grammar === 'python') return !node.text.startsWith('_');
  if (grammar === 'go') return /^[A-Z]/.test(node.text);
  if (grammar === 'rust') {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type.endsWith('_item')) {
        return parent.text.startsWith('pub');
      }
    }
    return false;
  }
  if (grammar === 'typescript' || grammar === 'tsx' || grammar === 'javascript') {
    for (let parent = node.parent; parent; parent = parent.parent) {
      // A class member's visibility is its own modifier, not its class's
      // export. Without this, every private field of an exported class would
      // be reported as part of the public surface.
      if (parent.type === 'class_body') {
        const member = node.parent;
        if (!member) return false;
        if (node.text.startsWith('#')) return false;
        return !/^\s*(private|protected)\s/.test(member.text.slice(0, 40));
      }
      if (parent.type === 'export_statement') return true;
      if (parent.type === 'program') return false;
    }
    return false;
  }
  if (grammar === 'java' || grammar === 'c-sharp' || grammar === 'php') {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type.endsWith('_declaration')) return /\bpublic\b/.test(parent.text.slice(0, 200));
    }
    return false;
  }
  return true;
}

/**
 * Extract every definition from a file by parsing it.
 *
 * Returns null when the file cannot be parsed — an unknown extension, a missing
 * grammar, or no runtime — so the caller knows to fall back rather than treating
 * an empty list as "no symbols here".
 */
export async function parseSymbols(
  text: string,
  relativePath: string,
): Promise<SymbolHit[] | null> {
  const grammarName = GRAMMARS[path.extname(relativePath).toLowerCase()];
  if (!grammarName) return null;

  const grammar = await loadGrammar(grammarName);
  if (!grammar) return null;

  const active = await ensureRuntime();
  if (!active) return null;

  const parser = new active.Parser();
  try {
    parser.setLanguage(grammar.language);
    const tree = parser.parse(text);
    if (!tree) return null;

    const lines = text.split('\n');
    // Keyed by name and line, because one declaration can match several
    // patterns — `const f = () => {}` is both a binding and a function, and
    // the useful answer is "function".
    const found = new Map<string, SymbolHit>();

    const query = grammar.query as {
      captures(node: TsNode): Array<{ name: string; node: TsNode }>;
    };
    for (const capture of query.captures(tree.rootNode)) {
      const kind = capture.name as SymbolKind;
      if (!KINDS.has(kind)) continue;

      const line = capture.node.startPosition.row + 1;
      const key = `${capture.node.text}:${line}`;
      const existing = found.get(key);
      if (existing && KIND_PRIORITY.indexOf(existing.kind) <= KIND_PRIORITY.indexOf(kind)) {
        continue;
      }

      found.set(key, {
        name: capture.node.text,
        kind,
        file: relativePath,
        line,
        text: (lines[capture.node.startPosition.row] ?? '').trim().slice(0, 200),
        exported: isExported(capture.node, grammarName),
      });
    }

    return [...found.values()].sort((a, b) => a.line - b.line);
  } catch (error) {
    log.debug('parse failed', { file: relativePath, error: String(error) });
    return null;
  } finally {
    parser.delete();
  }
}

/** Drop cached grammars. Used by tests; harmless otherwise. */
export function resetParserCache(): void {
  grammars.clear();
  runtime = undefined;
  runtimeReady = undefined;
}
