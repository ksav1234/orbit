import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a path to its canonical on-disk form for comparison: symlinks
 * followed, and case-folded on Windows where the filesystem is.
 */
function canonicalPath(value: string): string {
  let resolved = path.resolve(value);
  try {
    // `.native` also normalises the drive-letter and directory casing on
    // Windows, which `resolve()` leaves exactly as the caller typed it.
    resolved = fsSync.realpathSync.native(resolved);
  } catch {
    try {
      resolved = fsSync.realpathSync(resolved);
    } catch {
      // Not on disk, or not readable. The resolved path is the best we have.
    }
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True when the module identified by `metaUrl` is the process entry point.
 *
 * This cannot be a plain string comparison. `process.argv[1]` is whatever the
 * launcher passed, but Node resolves `import.meta.url` through symlinks -- so
 * for a globally linked package the two disagree:
 *
 *   argv[1]           %APPDATA%\npm\node_modules\orbit-cli\dist\index.js
 *   import.meta.url   C:\Users\me\src\orbit\dist\index.js
 *
 * Comparing those literally makes an `npm link`-ed CLI exit silently with
 * status 0, which is exactly as confusing as it sounds. Both sides go through
 * realpath first.
 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return canonicalPath(entry) === canonicalPath(fileURLToPath(metaUrl));
}

/** Root of Orbit's user-level state: `~/.orbit`. Overridable for tests. */
export function orbitHome(): string {
  return process.env.ORBIT_HOME ?? path.join(os.homedir(), '.orbit');
}

export const orbitPaths = {
  get root() {
    return orbitHome();
  },
  get config() {
    return path.join(orbitHome(), 'config.json');
  },
  get credentials() {
    return path.join(orbitHome(), 'credentials');
  },
  get credentialsFile() {
    return path.join(orbitHome(), 'credentials', 'providers.json');
  },
  get sessions() {
    return path.join(orbitHome(), 'sessions');
  },
  get cache() {
    return path.join(orbitHome(), 'cache');
  },
  get logs() {
    return path.join(orbitHome(), 'logs');
  },
};

/** Create the `~/.orbit` tree. Credentials dir is created 0700 where supported. */
export async function ensureOrbitHome(): Promise<void> {
  await fs.mkdir(orbitPaths.root, { recursive: true });
  await fs.mkdir(orbitPaths.credentials, { recursive: true, mode: 0o700 });
  await fs.mkdir(orbitPaths.sessions, { recursive: true });
  await fs.mkdir(orbitPaths.cache, { recursive: true });
  await fs.mkdir(orbitPaths.logs, { recursive: true });
}

/** Replace the home directory prefix with `~` for display. */
export function tildify(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length).split(path.sep).join('/');
  return p.split(path.sep).join('/');
}

/** Shorten a path for constrained widths by eliding leading segments. */
export function shortenPath(p: string, max: number): string {
  const t = tildify(p);
  if (t.length <= max) return t;
  const parts = t.split('/');
  while (parts.length > 2 && parts.join('/').length > max) parts.shift();
  const out = parts.join('/');
  return out.length <= max ? '…/' + out : '…' + out.slice(-(max - 1));
}
