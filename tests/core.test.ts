import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { matchesGlob, globToRegExp } from '../src/util/glob.js';
import { redact, maskKey, registerSecret, clearRegisteredSecrets, redactValue } from '../src/util/redact.js';
import { unifiedDiff, detectEol, applyEol, normalizeEol } from '../src/util/diff.js';
import { clampLines, clampChars, truncateWidth, formatCount } from '../src/util/format.js';
import { parseToolProtocol, hasOpenToolBlock, stripPartialBlock } from '../src/agent/protocol.js';
import { ContextManager } from '../src/context/manager.js';
import { compressToolResults, findSafeBoundary, outlineTranscript, summarizeOlderTurns } from '../src/context/compaction.js';
import { estimateTokens, computeBudget } from '../src/context/tokenizer.js';
import { ConfigManager } from '../src/config/manager.js';
import { parseArgs } from '../src/index.js';
import { InputHistory, commonPrefix, createCompleter } from '../src/cli/input.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import { findCommand, parseSlashCommand, isSlashCommand } from '../src/cli/commands.js';
import { parsePageRange, rankPages } from '../src/tools/pdf.js';
import { makeTempWorkspace, removeTempWorkspace, writeFiles } from './helpers.js';
import type { ContextEntry } from '../src/context/compaction.js';

describe('glob matching', () => {
  it('matches simple wildcards within a segment', () => {
    expect(matchesGlob('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/index.ts', 'src/*.ts')).toBe(false);
  });

  it('matches across directories with **', () => {
    expect(matchesGlob('src/a/b/index.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/index.ts', 'src/**/*.ts')).toBe(true);
  });

  it('supports brace alternatives', () => {
    expect(matchesGlob('app.jsx', '*.{js,jsx,ts}')).toBe(true);
    expect(matchesGlob('app.css', '*.{js,jsx,ts}')).toBe(false);
  });

  it('matches a bare name against the basename', () => {
    expect(matchesGlob('deep/nested/Dockerfile', 'Dockerfile')).toBe(true);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a+b.txt').test('a+b.txt')).toBe(true);
    expect(globToRegExp('a+b.txt').test('aXbYtxt')).toBe(false);
  });
});

describe('secret redaction', () => {
  afterEach(() => clearRegisteredSecrets());

  it('redacts common key formats', () => {
    expect(redact('key=sk-abcdefghijklmnopqrstuvwx')).not.toContain('abcdefghijklmnop');
    expect(redact('Authorization: Bearer abcdef123456')).toContain('***');
    expect(redact('nvapi-abcdefghijklmnopqrstuv')).toContain('***');
  });

  it('redacts registered literal secrets anywhere they appear', () => {
    registerSecret('my-super-secret-token');
    expect(redact('the token is my-super-secret-token here')).toBe('the token is *** here');
  });

  it('redacts nested object values', () => {
    const cleaned = redactValue({ headers: { authorization: 'Bearer xyz' }, nested: { apiKey: 'abc123456' } });
    expect(JSON.stringify(cleaned)).not.toContain('Bearer xyz');
    expect(JSON.stringify(cleaned)).not.toContain('abc123456');
  });

  it('masks keys for display without revealing them', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('************cdef');
    expect(maskKey(undefined)).toBe('not set');
  });
});

describe('diff utilities', () => {
  it('counts added and removed lines', () => {
    const diff = unifiedDiff('a.ts', 'one\ntwo\nthree\n', 'one\n2\nthree\n');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.patch).toContain('+2');
  });

  it('preserves the dominant line ending', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\nb\n')).toBe('\n');
    expect(applyEol('a\nb', '\r\n')).toBe('a\r\nb');
    expect(normalizeEol('a\r\nb')).toBe('a\nb');
  });
});

describe('formatting helpers', () => {
  it('clamps long output while reporting what was hidden', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const clamped = clampLines(text, 5, 2);
    expect(clamped.hiddenLines).toBe(93);
    expect(clamped.text).toContain('93 lines hidden');
    expect(clamped.text).toContain('line 0');
    expect(clamped.text).toContain('line 99');
  });

  it('clamps by characters keeping head and tail', () => {
    const { text, truncated } = clampChars('x'.repeat(5000), 1000);
    expect(truncated).toBe(true);
    expect(text).toContain('characters omitted');
  });

  it('truncates to a display width', () => {
    expect(truncateWidth('abcdefghij', 5)).toHaveLength(5);
    expect(truncateWidth('abc', 10)).toBe('abc');
  });

  it('formats counts compactly', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(8200)).toBe('8.2k');
    expect(formatCount(1_500_000)).toBe('1.5M');
  });
});

describe('fallback tool protocol', () => {
  it('parses a tool block and strips it from the visible text', () => {
    const output = 'Let me look.\n<orbit:tool name="read_file">\n{"path": "src/a.ts"}\n</orbit:tool>';
    const parsed = parseToolProtocol(output);

    expect(parsed.text).toBe('Let me look.');
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]).toMatchObject({ name: 'read_file', arguments: { path: 'src/a.ts' } });
  });

  it('tolerates markdown fences inside the block', () => {
    const output = '<orbit:tool name="git_status">\n```json\n{}\n```\n</orbit:tool>';
    expect(parseToolProtocol(output).calls[0]?.name).toBe('git_status');
  });

  it('reports malformed JSON instead of executing anything', () => {
    const output = '<orbit:tool name="read_file">\n{path: broken}\n</orbit:tool>';
    const parsed = parseToolProtocol(output);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.errors[0]?.reason).toMatch(/not valid JSON/);
  });

  it('hides a partially streamed block', () => {
    const partial = 'Working…\n<orbit:tool name="read_file">\n{"pa';
    expect(hasOpenToolBlock(partial)).toBe(true);
    expect(stripPartialBlock(partial)).toBe('Working…\n');
  });
});

describe('context management', () => {
  it('estimates tokens and reports the budget breakdown', () => {
    const budget = computeBudget({
      systemPrompt: 'x'.repeat(4000),
      messages: [{ role: 'user', content: 'hello world' }],
      tools: [{ name: 'read_file', description: 'reads', parameters: { type: 'object' } }],
      responseReserve: 1000,
      contextWindow: 10_000,
    });

    expect(budget.breakdown.system).toBeGreaterThan(500);
    expect(budget.used).toBeGreaterThan(budget.breakdown.system);
    expect(budget.available).toBe(10_000 - budget.used - 1000);
  });

  it('estimates code more densely than prose', () => {
    const code = 'const x = { a: 1 };'.repeat(20);
    const prose = 'the quick brown fox jumps over '.repeat(20);
    expect(estimateTokens(code) / code.length).toBeGreaterThan(estimateTokens(prose) / prose.length);
  });

  it('compresses old tool results but keeps recent ones intact', () => {
    const entries: ContextEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      message: { role: 'tool', content: 'y'.repeat(4000), toolCallId: `c${i}`, name: 'read_file' },
      tokens: 1000,
      timestamp: new Date().toISOString(),
    }));

    const result = compressToolResults(entries, { keepRecent: 3, maxChars: 300 });
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(result.entries[0]!.compressed).toBe(true);
    expect(result.entries[9]!.compressed).toBeUndefined();
  });

  it('never splits an assistant tool call from its results', () => {
    const entries: ContextEntry[] = [
      { id: 'a', message: { role: 'user', content: 'hi' }, tokens: 5, timestamp: '' },
      {
        id: 'b',
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
        tokens: 5,
        timestamp: '',
      },
      { id: 'c', message: { role: 'tool', content: 'result', toolCallId: 'c1' }, tokens: 5, timestamp: '' },
      { id: 'd', message: { role: 'assistant', content: 'done' }, tokens: 5, timestamp: '' },
    ];

    // Cutting between the call and its result would orphan the result, so the
    // boundary moves forward past it and the pair is dropped together.
    expect(findSafeBoundary(entries, 2)).toBe(3);
    expect(findSafeBoundary(entries, 3)).toBe(3);
    // Cutting before the call keeps the call and its result on the same side.
    expect(findSafeBoundary(entries, 1)).toBe(1);

    // An assistant tool call with no following result is never left stranded.
    const stranded: ContextEntry[] = [
      { id: 'a', message: { role: 'user', content: 'hi' }, tokens: 5, timestamp: '' },
      {
        id: 'b',
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
        tokens: 5,
        timestamp: '',
      },
      { id: 'c', message: { role: 'assistant', content: 'done' }, tokens: 5, timestamp: '' },
    ];
    expect(findSafeBoundary(stranded, 2)).toBe(1);
  });

  it('summarises older turns deterministically when no model is available', async () => {
    const entries: ContextEntry[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      message:
        i % 2 === 0
          ? { role: 'user' as const, content: `request number ${i}` }
          : {
              role: 'assistant' as const,
              content: '',
              toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `file${i}.ts` } }],
            },
      tokens: 50,
      timestamp: new Date().toISOString(),
    }));

    const result = await summarizeOlderTurns(entries, { keepRecent: 4 });
    expect(result.summary).toBeTruthy();
    expect(result.entries.length).toBeLessThan(entries.length);
    expect(result.entries[0]!.synthetic).toBe(true);
    expect(result.summary).toContain('read_file');
  });

  it('produces an outline naming the tools and files involved', () => {
    const outline = outlineTranscript([
      { id: '1', message: { role: 'user', content: 'fix the auth bug' }, tokens: 5, timestamp: '' },
      {
        id: '2',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c', name: 'edit_file', arguments: { path: 'src/auth.ts' } }],
        },
        tokens: 5,
        timestamp: '',
      },
    ]);

    expect(outline).toContain('fix the auth bug');
    expect(outline).toContain('edit_file');
    expect(outline).toContain('src/auth.ts');
  });

  it('compacts when the window fills up', async () => {
    const manager = new ContextManager({ contextWindow: 4000, compactThreshold: 0.5, responseReserve: 200 });
    manager.setSystemPrompt('system');

    for (let i = 0; i < 12; i++) {
      manager.addUserMessage(`question ${i} ` + 'z'.repeat(400));
      manager.addAssistantMessage(`answer ${i} ` + 'z'.repeat(400));
    }

    expect(manager.needsCompaction([])).toBe(true);
    const before = manager.budget([]).used;
    await manager.compact({ tools: [] });
    expect(manager.budget([]).used).toBeLessThan(before);
  });

  it('drops the oldest messages when a single turn still will not fit', () => {
    const manager = new ContextManager({ contextWindow: 500, responseReserve: 100 });
    for (let i = 0; i < 20; i++) manager.addUserMessage('x'.repeat(400));
    expect(manager.enforceHardLimit([])).toBe(true);
    expect(manager.length).toBeLessThan(20);
  });
});

describe('argument parsing', () => {
  it('parses a bare invocation', () => {
    expect(parseArgs([])).toEqual({ command: null, positional: [], flags: {} });
  });

  it('parses a workspace path', () => {
    expect(parseArgs(['./project'])).toMatchObject({ command: null, positional: ['./project'] });
  });

  it('parses commands and their arguments', () => {
    expect(parseArgs(['provider', 'add'])).toMatchObject({ command: 'provider', positional: ['add'] });
    expect(parseArgs(['model', 'use', 'gpt-5'])).toMatchObject({
      command: 'model',
      positional: ['use', 'gpt-5'],
    });
  });

  it('parses long and short flags with values', () => {
    expect(parseArgs(['--model', 'qwen3-coder']).flags.model).toBe('qwen3-coder');
    expect(parseArgs(['-m', 'gpt-5']).flags.model).toBe('gpt-5');
    expect(parseArgs(['--model=gpt-5']).flags.model).toBe('gpt-5');
  });

  it('parses negated flags', () => {
    expect(parseArgs(['--no-banner']).flags.banner).toBe(false);
    expect(parseArgs(['--no-color']).flags.color).toBe(false);
  });

  it('parses boolean short flags', () => {
    expect(parseArgs(['-d']).flags.debug).toBe(true);
    expect(parseArgs(['-h']).flags.help).toBe(true);
  });
});

describe('slash commands', () => {
  it('detects and parses a command', () => {
    expect(isSlashCommand('  /help')).toBe(true);
    expect(isSlashCommand('help')).toBe(false);
    expect(parseSlashCommand('/model gpt-5')).toEqual({ name: 'model', args: 'gpt-5' });
  });

  it('resolves aliases', () => {
    expect(findCommand('exit')?.name).toBe('quit');
    expect(findCommand('sessions')?.name).toBe('session');
    expect(findCommand('nope')).toBeUndefined();
  });
});

describe('input history and completion', () => {
  it('walks backwards and forwards through history', () => {
    const history = new InputHistory();
    history.add('first');
    history.add('second');

    expect(history.previous('draft')).toBe('second');
    expect(history.previous('draft')).toBe('first');
    expect(history.previous('draft')).toBeNull();
    expect(history.next()).toBe('second');
    expect(history.next()).toBe('draft');
  });

  it('ignores blank and duplicate entries', () => {
    const history = new InputHistory();
    history.add('  ');
    history.add('same');
    history.add('same');
    expect(history.all()).toEqual(['same']);
  });

  it('computes the longest common prefix', () => {
    expect(commonPrefix(['src/index.ts', 'src/input.ts'])).toBe('src/in');
    expect(commonPrefix([])).toBe('');
  });

  it('completes slash commands and workspace paths', async () => {
    const root = await makeTempWorkspace();
    try {
      await writeFiles(root, { 'src/index.ts': '', 'src/input.ts': '', 'node_modules/x/y.js': '' });
      const complete = createCompleter({
        sandbox: new Sandbox({ root }),
        commands: [
          { name: 'model', description: 'model' },
          { name: 'compact', description: 'compact' },
        ],
      });

      const commands = await complete('/mo', 3);
      expect(commands?.items[0]?.value).toBe('/model ');

      const paths = await complete('look at src/in', 14);
      expect(paths?.items.map((item) => item.label)).toEqual(['index.ts', 'input.ts']);

      const hidden = await complete('check ./', 8);
      expect(hidden?.items.map((item) => item.label)).not.toContain('node_modules/');
    } finally {
      await removeTempWorkspace(root);
    }
  });
});

describe('pdf helpers', () => {
  it('parses page ranges', () => {
    expect(parsePageRange('1-3', 10)).toEqual([1, 2, 3]);
    expect(parsePageRange('2,5,8-9', 10)).toEqual([2, 5, 8, 9]);
    expect(parsePageRange('9-99', 10)).toEqual([9, 10]);
    expect(parsePageRange('nonsense', 10)).toEqual([]);
  });

  it('ranks pages by relevance to a query', () => {
    const pages = [
      { number: 1, text: 'introduction and table of contents' },
      { number: 2, text: 'the authentication vulnerability allows session fixation' },
      { number: 3, text: 'appendix' },
    ];
    const ranked = rankPages(pages, 'authentication session', 2);
    expect(ranked[0]?.number).toBe(2);
  });
});

describe('config manager', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTempWorkspace('orbit-config-');
    process.env.ORBIT_HOME = home;
  });

  afterEach(async () => {
    delete process.env.ORBIT_HOME;
    await removeTempWorkspace(home);
  });

  it('starts from defaults and persists provider changes', async () => {
    const manager = new ConfigManager();
    await manager.load();

    expect(manager.get().permissions.write).toBe('ask');
    expect(manager.get().permissions.read).toBe('allow');

    await manager.addProvider(
      {
        id: 'test',
        label: 'Test',
        kind: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        model: 'test-model',
        models: ['test-model'],
        headers: {},
      },
      'sk-secret-value-abcdef123456',
    );

    const reloaded = new ConfigManager();
    await reloaded.load();
    expect(reloaded.getProvider('test')?.model).toBe('test-model');
    expect(reloaded.apiKey('test')).toBe('sk-secret-value-abcdef123456');
    expect(reloaded.apiKeySource('test')).toBe('store');
  });

  it('keeps credentials out of config.json', async () => {
    const manager = new ConfigManager();
    await manager.load();
    await manager.addProvider(
      {
        id: 'test',
        label: 'Test',
        kind: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        model: 'm',
        models: [],
        headers: {},
      },
      'sk-do-not-store-me-123456',
    );

    const { readFile } = await import('node:fs/promises');
    const config = await readFile(`${home}/config.json`, 'utf8');
    expect(config).not.toContain('sk-do-not-store-me');
  });

  it('prefers an environment variable over the stored key', async () => {
    const manager = new ConfigManager();
    await manager.load();
    await manager.addProvider(
      {
        id: 'test',
        label: 'Test',
        kind: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        model: 'm',
        models: [],
        headers: {},
        apiKeyEnv: 'ORBIT_TEST_KEY',
      },
      'stored-key-value-123456',
    );

    process.env.ORBIT_TEST_KEY = 'env-key-value-123456';
    try {
      expect(manager.apiKey('test')).toBe('env-key-value-123456');
      expect(manager.apiKeySource('test')).toBe('env');
    } finally {
      delete process.env.ORBIT_TEST_KEY;
    }
  });
});
