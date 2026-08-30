import fs from 'node:fs/promises';

export type FreshnessVerdict = 'ok' | 'never-read' | 'stale';

export interface FreshnessCheck {
  verdict: FreshnessVerdict;
  /** When the agent last read the file, if it did. */
  readAt?: number;
  /** Modification time recorded at that read. */
  knownMtimeMs?: number;
  currentMtimeMs?: number;
}

/**
 * Remembers what the agent has read and how fresh that read is.
 *
 * Without this, an agent that read a file at the start of a long turn can
 * overwrite edits the user made in their editor in the meantime — silently,
 * because `edit_file` only checks that its `old_string` still matches.
 */
export class FileReadTracker {
  private readonly reads = new Map<string, { mtimeMs: number; at: number; size: number }>();

  noteRead(absolutePath: string, mtimeMs: number, size = 0): void {
    this.reads.set(key(absolutePath), { mtimeMs, at: Date.now(), size });
  }

  /** Record a write Orbit performed, so its own change does not look stale. */
  noteWrite(absolutePath: string, mtimeMs: number, size = 0): void {
    this.noteRead(absolutePath, mtimeMs, size);
  }

  forget(absolutePath: string): void {
    this.reads.delete(key(absolutePath));
  }

  hasRead(absolutePath: string): boolean {
    return this.reads.has(key(absolutePath));
  }

  /**
   * Compare the file on disk with what the agent last saw. A file that does
   * not exist is never stale — creating it is not a conflict.
   */
  async check(absolutePath: string): Promise<FreshnessCheck> {
    const known = this.reads.get(key(absolutePath));

    let currentMtimeMs: number | undefined;
    let currentSize: number | undefined;
    try {
      const stat = await fs.stat(absolutePath);
      currentMtimeMs = stat.mtimeMs;
      currentSize = stat.size;
    } catch {
      return { verdict: known ? 'ok' : 'never-read' };
    }

    if (!known) return { verdict: 'never-read', currentMtimeMs };

    // Filesystems differ in mtime resolution; a millisecond of slack avoids
    // false positives without missing a real external edit.
    const mtimeChanged = Math.abs(currentMtimeMs - known.mtimeMs) > 1;

    // Size is checked as well because mtime granularity is coarse on some
    // filesystems — HFS+ stores whole seconds — so an edit made moments after
    // the read can leave mtime looking unchanged.
    const sizeChanged = currentSize !== known.size;

    return {
      verdict: mtimeChanged || sizeChanged ? 'stale' : 'ok',
      readAt: known.at,
      knownMtimeMs: known.mtimeMs,
      currentMtimeMs,
    };
  }

  clear(): void {
    this.reads.clear();
  }

  get size(): number {
    return this.reads.size;
  }
}

/** Windows paths are case-insensitive; normalise so the map agrees. */
function key(absolutePath: string): string {
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

export function staleWriteMessage(relativePath: string): string {
  return [
    `${relativePath} changed on disk after you read it.`,
    'Someone (probably the user, in their editor) edited it since. Read the file again and re-apply your change to the current contents — do not overwrite it blind.',
  ].join(' ');
}
