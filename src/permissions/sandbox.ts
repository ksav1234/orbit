import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SandboxError } from '../util/errors.js';
import { tildify } from '../util/paths.js';

/** Directories that are never walked unless the user names them explicitly. */
export const DEFAULT_IGNORE_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode-test',
  'Pods',
  '.terraform',
];

/**
 * Files whose contents are assumed to be secret. Orbit will not hand these to
 * the model without an explicit, per-file confirmation from the user.
 */
export const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])credentials?(\.[a-z0-9]+)?$/i,
  /(^|[\\/])secrets?(\.[a-z0-9]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.aws[\\/]credentials$/i,
  /(^|[\\/])service-account.*\.json$/i,
  /(^|[\\/])\.htpasswd$/i,
];

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/');
  return SENSITIVE_PATTERNS.some((re) => re.test(normalized));
}

export interface SandboxOptions {
  root: string;
  /** Additional roots the user has explicitly authorized. */
  extraRoots?: string[];
  extraIgnore?: string[];
}

export interface ResolvedPath {
  /** Absolute, normalized path. */
  absolute: string;
  /** Path relative to the workspace root, using forward slashes. */
  relative: string;
  /** True when the path is covered by an authorized root other than the primary one. */
  external: boolean;
  sensitive: boolean;
}

/**
 * Enforces the workspace boundary. Every filesystem tool resolves user- and
 * model-supplied paths through this class; nothing escapes an authorized root,
 * including via `..` segments, absolute paths, or symlinks.
 */
export class Sandbox {
  readonly root: string;
  private readonly roots: string[];
  private readonly ignoreDirs: Set<string>;

  constructor(options: SandboxOptions) {
    this.root = path.resolve(options.root);
    this.roots = [this.root, ...(options.extraRoots ?? []).map((r) => path.resolve(r))];
    this.ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(options.extraIgnore ?? [])]);
  }

  get authorizedRoots(): readonly string[] {
    return this.roots;
  }

  /** Authorize an additional directory for this session. */
  addRoot(dir: string): void {
    const resolved = path.resolve(dir);
    if (!this.roots.includes(resolved)) this.roots.push(resolved);
  }

  private containedBy(absolute: string): string | null {
    for (const root of this.roots) {
      const relative = path.relative(root, absolute);
      const inside =
        relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (inside) return root;
    }
    return null;
  }

  isInside(candidate: string): boolean {
    return this.containedBy(path.resolve(this.root, candidate)) !== null;
  }

  /**
   * Resolve a path against the workspace root and verify containment.
   * Throws SandboxError with an explanatory message on any escape attempt.
   */
  resolve(input: string): ResolvedPath {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new SandboxError('A file path is required.');
    }

    const expanded = expandHome(input.trim());
    const absolute = path.resolve(this.root, expanded);
    const root = this.containedBy(absolute);

    if (!root) {
      throw new SandboxError(
        `Path is outside the authorized workspace: ${tildify(absolute)}`,
        `Workspace root is ${tildify(this.root)}. Use /permissions or restart Orbit in the directory you want to work in.`,
      );
    }

    const relative = path.relative(this.root, absolute).split(path.sep).join('/');
    return {
      absolute,
      relative: relative === '' ? '.' : relative,
      external: root !== this.root,
      sensitive: isSensitivePath(absolute),
    };
  }

  /**
   * Resolve and additionally verify that symlinks do not point outside the
   * workspace. Used before reading or writing file contents.
   */
  async resolveReal(input: string): Promise<ResolvedPath> {
    const resolved = this.resolve(input);
    const real = await realpathOfNearestExisting(resolved.absolute);
    if (real && !this.containedBy(real)) {
      throw new SandboxError(
        `Path resolves outside the workspace through a symlink: ${tildify(resolved.absolute)}`,
        `It points to ${tildify(real)}.`,
      );
    }
    return resolved;
  }

  /** True when a directory entry should be skipped during traversal. */
  shouldIgnoreDir(name: string): boolean {
    return this.ignoreDirs.has(name);
  }

  ignoredDirNames(): string[] {
    return [...this.ignoreDirs];
  }

  displayPath(absolute: string): string {
    const relative = path.relative(this.root, absolute);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
    return tildify(absolute);
  }
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * realpath() the deepest existing ancestor. A file that does not exist yet
 * (a pending write) still has its parent directory checked.
 */
async function realpathOfNearestExisting(target: string): Promise<string | null> {
  let current = target;
  const missing: string[] = [];

  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  return null;
}
