import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Sandbox } from '../src/permissions/sandbox.js';
import { prepareSpawn, runCommand, isCommandAvailable } from '../src/util/process.js';
import { detectEol, applyEol, normalizeEol, unifiedDiff } from '../src/util/diff.js';
import { matchesGlob } from '../src/util/glob.js';
import { parseRipgrepLine } from '../src/tools/search.js';
import { readFileTool, writeFileTool, editFileTool, listFilesTool } from '../src/tools/filesystem.js';
import { executeCommandTool, shellInfo } from '../src/tools/terminal.js';
import { tildify, shortenPath, isMainModule } from '../src/util/paths.js';
import { detectUnicodeSupport, detectColorSupport } from '../src/ui/theme.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace, writeFiles } from './helpers.js';

const isWindows = process.platform === 'win32';
const SEP = path.sep;

let workspace = '';

beforeEach(async () => {
  workspace = await makeTempWorkspace('orbit-platform-');
});

afterEach(async () => {
  await removeTempWorkspace(workspace);
});

describe('workspace boundary across path styles', () => {
  it('accepts both separator styles for the same file', async () => {
    await writeFiles(workspace, { 'src/index.ts': 'export const x = 1;\n' });
    const sandbox = new Sandbox({ root: workspace });

    const forward = sandbox.resolve('src/index.ts');
    const native = sandbox.resolve(['src', 'index.ts'].join(SEP));

    expect(forward.absolute).toBe(native.absolute);
    // Relative paths are always reported with forward slashes, on every OS.
    expect(forward.relative).toBe('src/index.ts');
    expect(native.relative).toBe('src/index.ts');
  });

  it('collapses redundant separators and dot segments', () => {
    const sandbox = new Sandbox({ root: workspace });
    for (const input of ['./src/index.ts', 'src//index.ts', 'src/./index.ts', 'a/../src/index.ts']) {
      expect(sandbox.resolve(input).relative).toBe('src/index.ts');
    }
  });

  it('refuses traversal written with either separator', () => {
    const sandbox = new Sandbox({ root: workspace });
    const backslash = String.fromCharCode(92);

    const escapes = [
      '../outside',
      `..${backslash}outside`,
      'src/../../outside',
      `src${backslash}..${backslash}..${backslash}outside`,
    ];

    for (const escape of escapes) {
      // A backslash is a literal filename character on POSIX, so only the
      // forward-slash forms are escapes there.
      const isEscapeHere = isWindows || !escape.includes(backslash);
      if (!isEscapeHere) continue;
      expect(() => sandbox.resolve(escape)).toThrow();
    }
  });

  it('refuses an absolute path outside the root', () => {
    const sandbox = new Sandbox({ root: workspace });
    const outside = isWindows ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
    expect(() => sandbox.resolve(outside)).toThrow();
  });

  it.runIf(isWindows)('treats Windows paths case-insensitively', () => {
    const sandbox = new Sandbox({ root: workspace });
    const target = path.join(workspace, 'src', 'index.ts');

    // A user or model may type any casing; containment must not depend on it.
    for (const variant of [target, target.toUpperCase(), target.toLowerCase()]) {
      expect(() => sandbox.resolve(variant)).not.toThrow();
      expect(sandbox.resolve(variant).relative.toLowerCase()).toBe('src/index.ts');
    }
  });

  it.runIf(!isWindows)('treats POSIX paths case-sensitively', () => {
    const sandbox = new Sandbox({ root: workspace });
    // An upper-cased root is a different directory on POSIX, so it is outside.
    expect(() => sandbox.resolve(workspace.toUpperCase() + '/x')).toThrow();
  });
});

describe('spawning commands', () => {
  it('passes commands through unchanged on POSIX', () => {
    if (isWindows) return;
    expect(prepareSpawn('git', ['status'])).toEqual({
      command: 'git',
      args: ['status'],
      verbatim: false,
    });
  });

  it.runIf(isWindows)('routes Windows batch shims through cmd.exe', () => {
    // npm ships `npx` as a .cmd on Windows; Node cannot spawn it directly.
    const prepared = prepareSpawn('npx', ['-y', 'some-package']);

    expect(prepared.command.toLowerCase()).toContain('cmd.exe');
    expect(prepared.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(prepared.verbatim).toBe(true);
    // The whole line is wrapped, or cmd.exe splits it at the first space.
    expect(prepared.args[3]).toMatch(/^".*"$/);
    expect(prepared.args[3]).toContain('-y');
  });

  it.runIf(isWindows)('resolves real executables to a full path', () => {
    const prepared = prepareSpawn('node', ['-v']);
    expect(prepared.command.toLowerCase()).toMatch(/node\.exe$/);
    expect(prepared.verbatim).toBe(false);
  });

  it('runs a command and captures its output on this platform', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'console.log("cross-platform")'],
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cross-platform');
  });

  it('detects a missing command without throwing', async () => {
    expect(await isCommandAvailable('orbit-definitely-not-installed')).toBe(false);
  });

  it('runs a shell command through the platform shell', async () => {
    const context = makeToolContext({ root: workspace });
    const result = await executeCommandTool.execute(
      executeCommandTool.parse({ command: 'node -e "console.log(1+1)"' }),
      context,
    );

    expect(result.metadata?.exitCode).toBe(0);
    expect(result.content).toContain('2');
  });

  it('names the shell it will use', () => {
    const info = shellInfo();
    expect(info.shell.length).toBeGreaterThan(0);
    expect(info.platform).toContain(process.platform);
    if (isWindows) expect(info.shell).toBe('cmd.exe');
  });
});

describe('line endings', () => {
  it('detects and preserves the dominant ending', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('\r\n');
    expect(detectEol('a\nb\nc')).toBe('\n');
    expect(applyEol('a\nb', '\r\n')).toBe('a\r\nb');
    expect(normalizeEol('a\r\nb')).toBe('a\nb');
  });

  it('keeps CRLF when editing a CRLF file', async () => {
    await fs.writeFile(path.join(workspace, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    const context = makeToolContext({ root: workspace });

    await editFileTool.execute(
      editFileTool.parse({ path: 'crlf.txt', old_string: 'two', new_string: 'TWO' }),
      context,
    );

    const updated = await fs.readFile(path.join(workspace, 'crlf.txt'), 'utf8');
    expect(updated).toBe('one\r\nTWO\r\nthree\r\n');
    expect(updated).not.toContain('\n\n');
  });

  it('keeps LF when editing an LF file, even on Windows', async () => {
    await fs.writeFile(path.join(workspace, 'lf.txt'), 'one\ntwo\n');
    const context = makeToolContext({ root: workspace });

    await editFileTool.execute(
      editFileTool.parse({ path: 'lf.txt', old_string: 'two', new_string: 'TWO' }),
      context,
    );

    expect(await fs.readFile(path.join(workspace, 'lf.txt'), 'utf8')).toBe('one\nTWO\n');
  });

  it('diffs CRLF and LF content identically', () => {
    const crlf = unifiedDiff('a.txt', 'one\r\ntwo\r\n', 'one\r\n2\r\n');
    const lf = unifiedDiff('a.txt', 'one\ntwo\n', 'one\n2\n');
    expect(crlf.added).toBe(lf.added);
    expect(crlf.removed).toBe(lf.removed);
  });

  it('reads a CRLF file without leaking carriage returns to the model', async () => {
    await fs.writeFile(path.join(workspace, 'crlf.md'), 'line one\r\nline two\r\n');
    const context = makeToolContext({ root: workspace });

    const result = await readFileTool.execute(
      readFileTool.parse({ path: 'crlf.md' }),
      context,
    );
    expect(result.content).not.toContain('\r');
    expect(result.content).toContain('line two');
  });
});

describe('paths reported to the model and the user', () => {
  it('always uses forward slashes in tool output', async () => {
    await writeFiles(workspace, { 'src/deep/file.ts': 'x\n' });
    const context = makeToolContext({ root: workspace });

    const listing = await listFilesTool.execute(
      listFilesTool.parse({ path: '.', depth: 3 }),
      context,
    );
    const read = await readFileTool.execute(
      readFileTool.parse({ path: 'src/deep/file.ts' }),
      context,
    );

    expect(read.content).toContain('src/deep/file.ts');
    expect(read.content).not.toContain('src\\deep');
    expect(listing.ok).toBe(true);
  });

  it('parses ripgrep output on both platforms', () => {
    expect(parseRipgrepLine('/work/src/a.ts:12:hit', '/work')).toEqual({
      file: 'src/a.ts',
      line: 12,
      text: 'hit',
    });
    // A Windows drive letter contains a colon, which must not be mistaken for
    // the field separator.
    const windows = parseRipgrepLine('C:\\work\\src\\a.ts:7:hit', 'C:\\work');
    expect(windows?.line).toBe(7);
    expect(windows?.text).toBe('hit');
  });

  it('matches globs against forward-slash paths', () => {
    expect(matchesGlob('src/deep/file.ts', 'src/**/*.ts')).toBe(true);
    // Callers normalise separators before matching.
    expect(matchesGlob('src\\deep\\file.ts', 'src/**/*.ts')).toBe(true);
  });

  it('shortens home paths for display without native separators', () => {
    const inHome = path.join(os.homedir(), 'projects', 'orbit');
    expect(tildify(inHome)).toBe('~/projects/orbit');
    expect(tildify(inHome)).not.toContain('\\');
    expect(shortenPath(inHome, 12).length).toBeLessThanOrEqual(13);
  });
});

describe('terminal capability detection', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('honours NO_COLOR everywhere', () => {
    process.env.NO_COLOR = '1';
    expect(detectColorSupport()).toBe(false);
  });

  it('honours FORCE_COLOR everywhere', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '3';
    expect(detectColorSupport()).toBe(true);
  });

  it('lets ORBIT_ASCII force the ASCII symbol set', () => {
    process.env.ORBIT_ASCII = '1';
    expect(detectUnicodeSupport()).toBe(false);
  });

  it.runIf(isWindows)('only assumes Unicode on a modern Windows host', () => {
    delete process.env.ORBIT_ASCII;
    delete process.env.WT_SESSION;
    delete process.env.TERM_PROGRAM;
    delete process.env.WSLENV;
    expect(detectUnicodeSupport()).toBe(false);

    process.env.WT_SESSION = '1';
    expect(detectUnicodeSupport()).toBe(true);
  });

  it.runIf(!isWindows)('assumes Unicode on a UTF-8 POSIX locale', () => {
    delete process.env.ORBIT_ASCII;
    process.env.LANG = 'en_US.UTF-8';
    expect(detectUnicodeSupport()).toBe(true);
  });
});

describe('config and state locations', () => {
  it('puts everything under the user home directory', async () => {
    const home = await makeTempWorkspace('orbit-home-');
    process.env.ORBIT_HOME = home;
    try {
      const { orbitPaths, ensureOrbitHome } = await import('../src/util/paths.js');
      await ensureOrbitHome();

      for (const location of [orbitPaths.credentials, orbitPaths.sessions, orbitPaths.logs]) {
        expect(location.startsWith(home)).toBe(true);
        await expect(fs.access(location)).resolves.toBeUndefined();
      }
    } finally {
      delete process.env.ORBIT_HOME;
      await removeTempWorkspace(home);
    }
  });

  it('writes files atomically, which works on every filesystem', async () => {
    const { writeFileAtomic } = await import('../src/config/manager.js');
    const target = path.join(workspace, 'nested', 'config.json');

    await writeFileAtomic(target, '{"a":1}\n', 0o600);
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":1}\n');

    // Overwriting must replace, not append or fail on a locked handle.
    await writeFileAtomic(target, '{"a":2}\n', 0o600);
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":2}\n');

    // No temp files are left behind.
    const leftovers = (await fs.readdir(path.dirname(target))).filter((name) =>
      name.includes('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('entry-point detection', () => {
  // Regression: `npm link` puts a symlink in the global prefix. The launcher
  // passes that symlink as argv[1], while Node resolves import.meta.url to the
  // link's target, so a naive string comparison decided the CLI was being
  // imported rather than run — and `orbit` exited 0 without printing anything.
  it('sees through a symlinked entry point', async () => {
    const root = await makeTempWorkspace();
    const argv = process.argv[1];
    try {
      const real = path.join(root, 'real');
      const entry = path.join(real, 'index.js');
      await fs.mkdir(real, { recursive: true });
      await fs.writeFile(entry, '// entry\n', 'utf8');

      const link = path.join(root, 'linked');
      try {
        await fs.symlink(real, link, 'junction');
      } catch {
        return; // No permission to create links (unprivileged Windows).
      }

      const metaUrl = pathToFileURL(entry).href;

      process.argv[1] = path.join(link, 'index.js');
      expect(isMainModule(metaUrl)).toBe(true);

      // The direct path still matches, of course.
      process.argv[1] = entry;
      expect(isMainModule(metaUrl)).toBe(true);

      // A genuinely different module is still not the entry point.
      const other = path.join(real, 'other.js');
      await fs.writeFile(other, '// other\n', 'utf8');
      process.argv[1] = other;
      expect(isMainModule(metaUrl)).toBe(false);
    } finally {
      process.argv[1] = argv as string;
      await removeTempWorkspace(root);
    }
  });

  it.runIf(isWindows)('ignores drive-letter and directory casing', async () => {
    const root = await makeTempWorkspace();
    const argv = process.argv[1];
    try {
      const entry = path.join(root, 'Index.js');
      await fs.writeFile(entry, '// entry\n', 'utf8');

      process.argv[1] = entry.toUpperCase();
      expect(isMainModule(pathToFileURL(entry).href)).toBe(true);
    } finally {
      process.argv[1] = argv as string;
      await removeTempWorkspace(root);
    }
  });

  it('reports false when there is no entry argument at all', () => {
    const argv = process.argv[1];
    try {
      // Happens under `node --eval` and some embedders.
      delete (process.argv as (string | undefined)[])[1];
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = argv as string;
    }
  });
});
