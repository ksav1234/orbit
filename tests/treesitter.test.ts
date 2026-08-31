import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  isParsable,
  parsableExtensions,
  parseSymbols,
  parsingAvailable,
} from '../src/tools/treesitter.js';
import { extractSymbols } from '../src/tools/symbols.js';
import { findSymbolTool, outlineFileTool } from '../src/tools/symbols.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace, writeFiles } from './helpers.js';

let workspace = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-ts-');
});

afterEach(async () => {
  await removeTempWorkspace(workspace);
});

/**
 * The grammar bundle is an optional dependency, so every parsing assertion is
 * gated on it being installed. A run without it still exercises the fallback.
 */
const available = await parsingAvailable();
const withParser = available ? it : it.skip;

describe('knowing what can be parsed', () => {
  it('lists the extensions it has grammars for', () => {
    const extensions = parsableExtensions();
    expect(extensions).toContain('.ts');
    expect(extensions).toContain('.py');
    expect(extensions).toContain('.rs');
    expect(extensions).toContain('.go');
    expect(isParsable('src/a.ts')).toBe(true);
    expect(isParsable('notes.txt')).toBe(false);
    expect(isParsable('DOCKERFILE')).toBe(false);
  });

  it('returns null for a file it has no grammar for', async () => {
    expect(await parseSymbols('anything at all', 'notes.txt')).toBeNull();
  });
});

describe('parsing symbols out of real syntax', () => {
  withParser('finds every kind of TypeScript declaration', async () => {
    const source = [
      'export class Greeter {',
      '  private secret = 1;',
      '  public open = 2;',
      '  greet(): string { return "hi"; }',
      '}',
      'export function helper(a: number) { return a; }',
      'function internal() {}',
      'export const arrow = (x: string) => x.length;',
      'export interface Shape { area(): number }',
      'export type Alias = Shape | null;',
      'export enum Colour { Red }',
    ].join('\n');

    const hits = (await parseSymbols(source, 'a.ts'))!;
    const byName = new Map(hits.map((hit) => [hit.name, hit]));

    expect(byName.get('Greeter')?.kind).toBe('class');
    expect(byName.get('greet')?.kind).toBe('method');
    expect(byName.get('helper')?.kind).toBe('function');
    expect(byName.get('Shape')?.kind).toBe('interface');
    expect(byName.get('Alias')?.kind).toBe('type');
    expect(byName.get('Colour')?.kind).toBe('enum');
    expect(byName.get('arrow')?.kind).toBe('function');
  });

  withParser('reads visibility from the syntax, not the text', async () => {
    const source = [
      'export class A {',
      '  private hidden = 1;',
      '  public shown = 2;',
      '  privateer() {}', // not private: the name merely starts that way
      '}',
      'export function out() {}',
      'function inside() {}',
    ].join('\n');

    const hits = (await parseSymbols(source, 'a.ts'))!;
    const exported = new Map(hits.map((hit) => [hit.name, hit.exported]));

    expect(exported.get('hidden')).toBe(false);
    expect(exported.get('shown')).toBe(true);
    expect(exported.get('privateer')).toBe(true);
    expect(exported.get('out')).toBe(true);
    expect(exported.get('inside')).toBe(false);
  });

  // The whole point of parsing: a declaration inside a comment or a string is
  // not a declaration, and a line-based scan cannot always tell.
  withParser('ignores declarations that only look like declarations', async () => {
    const source = [
      '/*',
      ' export function ghostInABlockComment() {}',
      '*/',
      'const sql = `export function ghostInAString() {}`;',
      'export function real() {}',
    ].join('\n');

    const hits = (await parseSymbols(source, 'a.ts'))!;
    const names = hits.map((hit) => hit.name);

    expect(names).toContain('real');
    expect(names).not.toContain('ghostInABlockComment');
    expect(names).not.toContain('ghostInAString');
  });

  withParser('handles Python, Rust and Go conventions', async () => {
    const python = (await parseSymbols(
      ['class Thing:', '    def method(self): pass', 'def _private(): pass', 'def public(): pass'].join('\n'),
      'a.py',
    ))!;
    const py = new Map(python.map((hit) => [hit.name, hit]));
    expect(py.get('Thing')?.kind).toBe('class');
    // Python has no keyword for it; the leading underscore is the convention.
    expect(py.get('_private')?.exported).toBe(false);
    expect(py.get('public')?.exported).toBe(true);

    const rust = (await parseSymbols(
      ['pub struct Config {}', 'struct Hidden {}', 'pub trait Runner {}', 'pub fn go() {}'].join('\n'),
      'a.rs',
    ))!;
    const rs = new Map(rust.map((hit) => [hit.name, hit]));
    expect(rs.get('Config')?.kind).toBe('struct');
    expect(rs.get('Config')?.exported).toBe(true);
    expect(rs.get('Hidden')?.exported).toBe(false);
    expect(rs.get('Runner')?.kind).toBe('trait');

    const go = (await parseSymbols(
      ['func Exported() {}', 'func unexported() {}'].join('\n'),
      'a.go',
    ))!;
    const g = new Map(go.map((hit) => [hit.name, hit]));
    // Go's export rule is the capital letter, and nothing else.
    expect(g.get('Exported')?.exported).toBe(true);
    expect(g.get('unexported')?.exported).toBe(false);
  });

  withParser('reports accurate line numbers', async () => {
    const source = ['', '', 'export function onLineThree() {}', '', 'export class OnLineFive {}'].join('\n');
    const hits = (await parseSymbols(source, 'a.ts'))!;
    expect(hits.find((hit) => hit.name === 'onLineThree')?.line).toBe(3);
    expect(hits.find((hit) => hit.name === 'OnLineFive')?.line).toBe(5);
  });

  withParser('survives a file that does not parse cleanly', async () => {
    // Tree-sitter recovers from errors rather than giving up, so a file being
    // edited mid-keystroke still yields the symbols it can see.
    const hits = await parseSymbols('export function ok() {}\nclass Broken { {{{ ', 'a.ts');
    expect(hits).not.toBeNull();
    expect(hits!.map((hit) => hit.name)).toContain('ok');
  });

  withParser('is stricter than the lexical fallback, on input where that matters', async () => {
    const source = [
      '/*',
      ' export function insideABlockComment() {}',
      '*/',
      'export function real() {}',
    ].join('\n');

    const parsed = (await parseSymbols(source, 'a.ts'))!.map((hit) => hit.name);
    const lexical = extractSymbols(source, 'a.ts').map((hit) => hit.name);

    expect(parsed).toEqual(['real']);
    // Documents what the scan costs rather than claiming it is broken: it skips
    // line comments but cannot track a block comment across lines.
    expect(lexical).toContain('insideABlockComment');
  });
});

describe('the symbol tools end to end', () => {
  it('finds a declaration and says how it found it', async () => {
    await writeFiles(workspace, {
      'src/auth.ts': ['export function signIn(user: string) {', '  return user;', '}'].join('\n'),
      'src/other.ts': '// signIn is mentioned here but not declared\n',
    });

    const result = await findSymbolTool.execute(
      { name: 'signIn', kind: 'any', exact: false, max_results: 10 },
      makeToolContext({ root: workspace }),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/auth.ts:1');
    // The method is stated, so a lexical result is never mistaken for a parsed one.
    expect(result.content).toMatch(/parsed|matched by pattern/);
    if (available) {
      expect(result.content).toContain('parsed');
      // The mention in the comment is not a declaration.
      expect(result.content).not.toContain('src/other.ts');
    }
  });

  it('outlines a single file', async () => {
    await writeFiles(workspace, {
      'thing.ts': ['export class Thing {', '  run() {}', '}', 'export const VALUE = 1;'].join('\n'),
    });

    const result = await outlineFileTool.execute(
      { path: 'thing.ts' },
      makeToolContext({ root: workspace }),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('Thing');
    if (available) {
      expect(result.content).toContain('parsed');
      expect(result.content).toContain('run');
    }
  });

  it('still works for a language it has no grammar for', async () => {
    await writeFiles(workspace, {
      'legacy.kt': 'class KotlinThing {\n  fun run() {}\n}\n',
    });

    const result = await outlineFileTool.execute(
      { path: 'legacy.kt' },
      makeToolContext({ root: workspace }),
    );

    // Kotlin has no bundled grammar, so this is the lexical path — which must
    // still produce something rather than an error.
    expect(result.ok).toBe(true);
    expect(result.content).toContain('KotlinThing');
    expect(result.content).toContain('matched by pattern');
  });

  it('reports a mixed index honestly', async () => {
    await writeFiles(workspace, {
      'a.ts': 'export function parsed() {}\n',
      'b.kt': 'class NotParsed {}\n',
    });

    const result = await findSymbolTool.execute(
      { name: 'a', kind: 'any', exact: false, max_results: 10 },
      makeToolContext({ root: workspace }),
    );

    expect(result.ok).toBe(true);
    if (available) {
      // Neither "all parsed" nor "none parsed" would be true here.
      expect(result.content).toMatch(/1 of 2 parsed/);
    }
  });
});
