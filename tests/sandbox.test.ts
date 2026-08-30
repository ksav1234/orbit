import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Sandbox, isSensitivePath } from '../src/permissions/sandbox.js';
import { SandboxError } from '../src/util/errors.js';
import { makeTempWorkspace, removeTempWorkspace, writeFiles } from './helpers.js';

describe('Sandbox', () => {
  let root: string;
  let sandbox: Sandbox;

  beforeAll(async () => {
    root = await makeTempWorkspace();
    sandbox = new Sandbox({ root });
    await writeFiles(root, {
      'src/index.ts': 'export const answer = 42;\n',
      'nested/deep/file.txt': 'hello\n',
    });
  });

  afterAll(async () => {
    await removeTempWorkspace(root);
  });

  it('resolves paths relative to the workspace root', () => {
    const resolved = sandbox.resolve('src/index.ts');
    expect(resolved.relative).toBe('src/index.ts');
    expect(resolved.absolute).toBe(path.join(root, 'src', 'index.ts'));
    expect(resolved.external).toBe(false);
  });

  it('normalises interior traversal that stays inside the root', () => {
    const resolved = sandbox.resolve('src/../nested/deep/file.txt');
    expect(resolved.relative).toBe('nested/deep/file.txt');
  });

  it('rejects traversal above the workspace root', () => {
    expect(() => sandbox.resolve('../../etc/passwd')).toThrow(SandboxError);
    expect(() => sandbox.resolve('../')).toThrow(SandboxError);
    expect(() => sandbox.resolve('src/../../..')).toThrow(SandboxError);
  });

  it('rejects absolute paths outside the workspace', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
    expect(() => sandbox.resolve(outside)).toThrow(SandboxError);
  });

  it('rejects the home directory shorthand when it escapes the root', () => {
    expect(() => sandbox.resolve('~/.ssh/id_rsa')).toThrow(SandboxError);
  });

  it('rejects an empty path', () => {
    expect(() => sandbox.resolve('   ')).toThrow(SandboxError);
  });

  it('allows an explicitly authorised extra root', async () => {
    const other = await makeTempWorkspace('orbit-extra-');
    try {
      const widened = new Sandbox({ root, extraRoots: [other] });
      const resolved = widened.resolve(path.join(other, 'notes.md'));
      expect(resolved.external).toBe(true);
    } finally {
      await removeTempWorkspace(other);
    }
  });

  it('detects escapes made through a symlink', async () => {
    const outside = await makeTempWorkspace('orbit-outside-');
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'sensitive');
      const linkPath = path.join(root, 'escape-link');
      try {
        await fs.symlink(outside, linkPath, 'dir');
      } catch {
        return; // Symlink creation needs privileges on some Windows setups.
      }
      await expect(sandbox.resolveReal('escape-link/secret.txt')).rejects.toThrow(SandboxError);
    } finally {
      await removeTempWorkspace(outside);
    }
  });

  it('flags sensitive files by pattern', () => {
    expect(isSensitivePath('/project/.env')).toBe(true);
    expect(isSensitivePath('/project/.env.production')).toBe(true);
    expect(isSensitivePath('/project/certs/server.pem')).toBe(true);
    expect(isSensitivePath('/home/user/.ssh/id_rsa')).toBe(true);
    expect(isSensitivePath('/project/src/environment.ts')).toBe(false);
    expect(isSensitivePath('/project/README.md')).toBe(false);
  });

  it('reports sensitivity on resolved paths', () => {
    expect(sandbox.resolve('.env').sensitive).toBe(true);
    expect(sandbox.resolve('src/index.ts').sensitive).toBe(false);
  });

  it('skips ignored directories', () => {
    expect(sandbox.shouldIgnoreDir('node_modules')).toBe(true);
    expect(sandbox.shouldIgnoreDir('.git')).toBe(true);
    expect(sandbox.shouldIgnoreDir('src')).toBe(false);
  });
});
