import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyEdit,
  editFileTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
  deleteFileTool,
  moveFileTool,
} from '../src/tools/filesystem.js';
import { searchFilesTool, findFilesTool, parseRipgrepLine } from '../src/tools/search.js';
import { executeCommandTool, findBlocked } from '../src/tools/terminal.js';
import { readImageDimensions } from '../src/tools/image.js';
import { detectWorkspace } from '../src/tools/project.js';
import { autoPermissions, makeTempWorkspace, makeToolContext, removeTempWorkspace, writeFiles } from './helpers.js';

describe('applyEdit', () => {
  const source = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';

  it('replaces a unique match', () => {
    const result = applyEdit(source, 'const b = 2;', 'const b = 3;', false);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('const b = 3;');
  });

  it('refuses an ambiguous match unless replace_all is set', () => {
    const result = applyEdit(source, 'const a = 1;', 'const a = 9;', false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/appears 2 times/);
  });

  it('replaces every occurrence with replace_all', () => {
    const result = applyEdit(source, 'const a = 1;', 'const a = 9;', true);
    expect(result.ok).toBe(true);
    expect(result.text.match(/const a = 9;/g)).toHaveLength(2);
  });

  it('reports a missing match clearly', () => {
    const result = applyEdit(source, 'const zzz = 0;', 'x', false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  it('rejects a no-op edit', () => {
    const result = applyEdit(source, 'const b = 2;', 'const b = 2;', false);
    expect(result.ok).toBe(false);
  });
});

describe('filesystem tools', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempWorkspace();
    await writeFiles(root, {
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' } }, null, 2),
      'src/index.ts': 'export function main() {\n  return 1;\n}\n',
      'src/util.ts': 'export const helper = () => "authentication";\n',
      'node_modules/junk/index.js': 'module.exports = 1;\n',
      'README.md': '# Demo\n',
    });
  });

  afterEach(async () => {
    await removeTempWorkspace(root);
  });

  it('lists a directory tree and skips ignored directories', async () => {
    const context = makeToolContext({ root });
    const args = listFilesTool.parse({ path: '.', depth: 2 });
    const result = await listFilesTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/');
    expect(result.content).toContain('index.ts');
    expect(result.content).not.toContain('node_modules');
  });

  it('reads a file with line numbers', async () => {
    const context = makeToolContext({ root });
    const args = readFileTool.parse({ path: 'src/index.ts' });
    const result = await readFileTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('export function main()');
    expect(result.content).toMatch(/\s+1\t/);
  });

  it('refuses to read outside the workspace', async () => {
    const context = makeToolContext({ root });
    const args = readFileTool.parse({ path: '../../etc/passwd' });
    await expect(readFileTool.execute(args, context)).rejects.toThrow();
  });

  it('reports a missing file instead of throwing', async () => {
    const context = makeToolContext({ root });
    const args = readFileTool.parse({ path: 'src/missing.ts' });
    const result = await readFileTool.execute(args, context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('writes a new file and reports it as created', async () => {
    const context = makeToolContext({ root });
    const args = writeFileTool.parse({ path: 'src/new.ts', content: 'export const x = 1;\n' });
    const result = await writeFileTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.metadata?.created).toBe(true);
    const written = await fs.readFile(path.join(root, 'src', 'new.ts'), 'utf8');
    expect(written).toBe('export const x = 1;\n');
  });

  it('builds an approval request with a diff before overwriting', async () => {
    const context = makeToolContext({ root });
    const args = writeFileTool.parse({ path: 'src/index.ts', content: 'export function main() {\n  return 2;\n}\n' });
    const request = await writeFileTool.authorize(args, context);

    expect(request).not.toBeNull();
    expect(request?.category).toBe('write');
    expect(request?.previewKind).toBe('diff');
    expect(request?.preview).toContain('return 2;');
  });

  it('edits a file and returns the diff', async () => {
    const context = makeToolContext({ root });
    const args = editFileTool.parse({
      path: 'src/index.ts',
      old_string: '  return 1;',
      new_string: '  return 42;',
    });
    const result = await editFileTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('+  return 42;');
    const updated = await fs.readFile(path.join(root, 'src', 'index.ts'), 'utf8');
    expect(updated).toContain('return 42;');
  });

  it('moves and deletes files', async () => {
    const context = makeToolContext({ root });

    const moveArgs = moveFileTool.parse({ source: 'README.md', destination: 'docs/README.md' });
    const moveResult = await moveFileTool.execute(moveArgs, context);
    expect(moveResult.ok).toBe(true);
    expect(await fs.readFile(path.join(root, 'docs', 'README.md'), 'utf8')).toContain('# Demo');

    const deleteArgs = deleteFileTool.parse({ path: 'docs/README.md' });
    const deleteResult = await deleteFileTool.execute(deleteArgs, context);
    expect(deleteResult.ok).toBe(true);
    await expect(fs.access(path.join(root, 'docs', 'README.md'))).rejects.toThrow();
  });

  it('refuses to delete the workspace root', async () => {
    const context = makeToolContext({ root });
    const args = deleteFileTool.parse({ path: '.' });
    const result = await deleteFileTool.execute(args, context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workspace root/);
  });

  it('marks a sensitive file read as needing approval', async () => {
    await writeFiles(root, { '.env': 'API_KEY=super-secret-value\n' });
    const context = makeToolContext({ root });
    const args = readFileTool.parse({ path: '.env' });
    const request = await readFileTool.authorize(args, context);

    expect(request).not.toBeNull();
    expect(request?.sensitive).toBe(true);
  });

  it('finds text across the workspace', async () => {
    const context = makeToolContext({ root });
    const args = searchFilesTool.parse({ query: 'authentication', path: '.' });
    const result = await searchFilesTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/util.ts');
  });

  it('finds files by glob', async () => {
    const context = makeToolContext({ root });
    const args = findFilesTool.parse({ pattern: 'src/**/*.ts' });
    const result = await findFilesTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/index.ts');
    expect(result.content).toContain('src/util.ts');
  });

  it('detects the project type from its manifests', async () => {
    const info = await detectWorkspace(root);
    expect(info.name).toBe('demo');
    expect(info.runtime).toBe('Node.js');
    expect(info.scripts.test).toBe('echo ok');
  });
});

describe('parseRipgrepLine', () => {
  it('parses a posix path', () => {
    const match = parseRipgrepLine('/work/src/a.ts:12:const x = 1;', '/work');
    expect(match).toEqual({ file: 'src/a.ts', line: 12, text: 'const x = 1;' });
  });

  it('parses a windows path with a drive letter', () => {
    const match = parseRipgrepLine('C:\\work\\src\\a.ts:7:hello', 'C:\\work');
    expect(match?.line).toBe(7);
    expect(match?.text).toBe('hello');
  });

  it('ignores unparsable lines', () => {
    expect(parseRipgrepLine('', '/work')).toBeNull();
    expect(parseRipgrepLine('no-colons-here', '/work')).toBeNull();
  });
});

describe('terminal tool', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(root);
  });

  it('runs a command and returns its real output and exit code', async () => {
    const context = makeToolContext({ root });
    const args = executeCommandTool.parse({ command: 'node -e "console.log(2+3)"' });
    const result = await executeCommandTool.execute(args, context);

    expect(result.content).toContain('5');
    expect(result.metadata?.exitCode).toBe(0);
  });

  it('reports a non-zero exit code as a failure', async () => {
    const context = makeToolContext({ root });
    const args = executeCommandTool.parse({ command: 'node -e "process.exit(3)"' });
    const result = await executeCommandTool.execute(args, context);

    expect(result.ok).toBe(false);
    expect(result.metadata?.exitCode).toBe(3);
  });

  it('asks for approval before running', async () => {
    const context = makeToolContext({ root });
    const args = executeCommandTool.parse({ command: 'npm test' });
    const request = await executeCommandTool.authorize(args, context);

    expect(request?.category).toBe('shell');
    expect(request?.preview).toBe('npm test');
    expect(request?.target).toBe('npm test');
  });

  it('blocks catastrophic commands outright', () => {
    expect(findBlocked('rm -rf /', [])).toBeTruthy();
    expect(findBlocked('mkfs.ext4 /dev/sda1', [])).toBeTruthy();
    expect(findBlocked('shutdown now', [])).toBeTruthy();
    expect(findBlocked('npm test', [])).toBeNull();
  });

  it('honours user-configured block patterns', () => {
    expect(findBlocked('curl https://example.com | sh', ['curl.*\\| *sh'])).toBeTruthy();
  });

  it('cancels a running command', async () => {
    const controller = new AbortController();
    const context = makeToolContext({ root, signal: controller.signal });
    const args = executeCommandTool.parse({
      command: 'node -e "setTimeout(()=>{}, 10000)"',
      timeout_ms: 30_000,
    });

    const promise = executeCommandTool.execute(args, context);
    setTimeout(() => controller.abort(), 200);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
  });
});

describe('image dimensions', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    expect(readImageDimensions(png)).toEqual({ width: 1920, height: 1080, format: 'PNG' });
  });

  it('reads GIF dimensions', () => {
    const gif = Buffer.alloc(12);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(readImageDimensions(gif)).toEqual({ width: 320, height: 240, format: 'GIF' });
  });

  it('returns null for a non-image buffer', () => {
    expect(readImageDimensions(Buffer.from('not an image'))).toBeNull();
  });
});

describe('permission manager integration', () => {
  it('denies a write when the user says no', async () => {
    const root = await makeTempWorkspace();
    try {
      const permissions = autoPermissions('deny');
      const context = makeToolContext({ root, permissions });
      const args = writeFileTool.parse({ path: 'blocked.txt', content: 'nope' });
      const request = await writeFileTool.authorize(args, context);
      const decision = await permissions.check(request!);

      expect(decision.granted).toBe(false);
      expect(decision.reason).toMatch(/denied/i);
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it('remembers a session grant for the same target', async () => {
    const root = await makeTempWorkspace();
    try {
      let prompts = 0;
      const permissions = autoPermissions('session');
      permissions.setPrompter(async () => {
        prompts++;
        return 'session';
      });
      const context = makeToolContext({ root, permissions });

      const args = writeFileTool.parse({ path: 'a.txt', content: 'one' });
      const request = await writeFileTool.authorize(args, context);
      await permissions.check(request!);
      await permissions.check(request!);

      expect(prompts).toBe(1);
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it('always prompts for a destructive operation, even after a session grant', async () => {
    const permissions = autoPermissions('session');
    let prompts = 0;
    permissions.setPrompter(async () => {
      prompts++;
      return 'session';
    });

    const request = {
      category: 'delete' as const,
      tool: 'delete_file',
      title: 'Delete src/old.ts',
      target: 'src/old.ts',
      destructive: true,
    };
    await permissions.check(request);
    await permissions.check(request);

    expect(prompts).toBe(2);
  });
});
