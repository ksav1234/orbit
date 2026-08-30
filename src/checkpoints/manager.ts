import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { orbitPaths, ensureOrbitHome } from '../util/paths.js';
import { writeFileAtomic } from '../config/manager.js';
import { createLogger } from '../util/logger.js';
import { formatBytes } from '../util/format.js';
import type { CheckpointsConfig } from '../config/schema.js';

const log = createLogger('checkpoints');

/** What happened to one file inside a turn. */
export type FileChangeKind = 'created' | 'modified' | 'deleted' | 'moved';

export interface FileSnapshot {
  /** Workspace-relative path. */
  path: string;
  kind: FileChangeKind;
  /** Content before the change; null when the file did not exist. */
  beforeRef: string | null;
  /** For moves, where the file went. */
  toPath?: string;
  /** Set when the file was too large to snapshot. */
  skipped?: string;
  bytes: number;
}

export interface Checkpoint {
  id: string;
  /** Turn index within the session, starting at 1. */
  turn: number;
  at: string;
  /** The user prompt that started the turn. */
  label: string;
  files: FileSnapshot[];
}

const FileSnapshotSchema = z.object({
  path: z.string(),
  kind: z.enum(['created', 'modified', 'deleted', 'moved']),
  beforeRef: z.string().nullable(),
  toPath: z.string().optional(),
  skipped: z.string().optional(),
  bytes: z.number().default(0),
});

const CheckpointFileSchema = z.object({
  version: z.literal(1).default(1),
  session: z.string(),
  workspace: z.string(),
  checkpoints: z.array(
    z.object({
      id: z.string(),
      turn: z.number(),
      at: z.string(),
      label: z.string(),
      files: z.array(FileSnapshotSchema).default([]),
    }),
  ).default([]),
});

export interface RestoreResult {
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Records the previous contents of every file a turn touches, so the turn can
 * be undone.
 *
 * Content is stored once per hash in a shared blob directory, which makes
 * repeated edits to the same file cheap. This is deliberately not a git
 * dependency: the workspace may not be a repository, and Orbit must never
 * touch the user's index or stash.
 */
export class CheckpointManager {
  private readonly config: CheckpointsConfig;
  private readonly sessionId: string;
  private readonly workspaceRoot: string;
  private checkpoints: Checkpoint[] = [];
  /** Files captured for the turn currently in progress. */
  private pending = new Map<string, FileSnapshot>();
  private turnCounter = 0;
  private loaded = false;

  constructor(options: {
    config: CheckpointsConfig;
    sessionId: string;
    workspaceRoot: string;
  }) {
    this.config = options.config;
    this.sessionId = options.sessionId;
    this.workspaceRoot = options.workspaceRoot;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private get dir(): string {
    return path.join(orbitPaths.root, 'checkpoints');
  }

  private get blobDir(): string {
    return path.join(this.dir, 'blobs');
  }

  private get indexFile(): string {
    return path.join(this.dir, `${this.sessionId}.json`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = CheckpointFileSchema.safeParse(
        JSON.parse(await fs.readFile(this.indexFile, 'utf8')),
      );
      if (parsed.success) {
        this.checkpoints = parsed.data.checkpoints as Checkpoint[];
        this.turnCounter = this.checkpoints.at(-1)?.turn ?? 0;
      }
    } catch {
      // No history for this session yet.
    }
  }

  list(): Checkpoint[] {
    return this.checkpoints;
  }

  latest(): Checkpoint | undefined {
    return this.checkpoints.at(-1);
  }

  find(turn: number): Checkpoint | undefined {
    return this.checkpoints.find((checkpoint) => checkpoint.turn === turn);
  }

  /**
   * Capture a file's current state before a tool modifies it. Safe to call
   * repeatedly: only the first capture in a turn is kept, which is the state
   * the turn started from.
   */
  async capture(absolutePath: string, kind: FileChangeKind, toPath?: string): Promise<void> {
    if (!this.config.enabled) return;

    const relative = this.relativize(absolutePath);
    if (this.pending.has(relative)) return;

    let beforeRef: string | null = null;
    let bytes = 0;
    let skipped: string | undefined;

    try {
      const stat = await fs.stat(absolutePath);
      bytes = stat.size;
      if (stat.isDirectory()) {
        skipped = 'directory';
      } else if (stat.size > this.config.maxFileBytes) {
        skipped = `larger than ${formatBytes(this.config.maxFileBytes)}`;
      } else {
        beforeRef = await this.storeBlob(await fs.readFile(absolutePath));
      }
    } catch {
      // The file does not exist yet: the change created it, and undoing means
      // deleting it again.
      beforeRef = null;
    }

    this.pending.set(relative, {
      path: relative,
      kind,
      beforeRef,
      ...(toPath ? { toPath: this.relativize(toPath) } : {}),
      ...(skipped ? { skipped } : {}),
      bytes,
    });
  }

  /** True when the turn in progress has touched anything. */
  get hasPendingChanges(): boolean {
    return this.pending.size > 0;
  }

  /** Close the current turn. Returns null when nothing was changed. */
  async commitTurn(label: string): Promise<Checkpoint | null> {
    if (!this.config.enabled || this.pending.size === 0) {
      this.pending.clear();
      return null;
    }

    this.turnCounter += 1;
    const checkpoint: Checkpoint = {
      id: `${this.sessionId}-${this.turnCounter}`,
      turn: this.turnCounter,
      at: new Date().toISOString(),
      label: label.slice(0, 120),
      files: [...this.pending.values()],
    };
    this.pending.clear();

    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > this.config.maxPerSession) {
      this.checkpoints = this.checkpoints.slice(-this.config.maxPerSession);
    }

    await this.persist();
    log.info('checkpoint recorded', { turn: checkpoint.turn, files: checkpoint.files.length });
    return checkpoint;
  }

  /** Discard captures for an abandoned turn. */
  discardPending(): void {
    this.pending.clear();
  }

  /**
   * Roll the workspace back to the state before `turn`. Restoring turn N also
   * restores every later turn, because a file changed in N+1 must go back to
   * the state N started from.
   */
  async restoreTo(turn: number): Promise<RestoreResult> {
    const index = this.checkpoints.findIndex((checkpoint) => checkpoint.turn === turn);
    if (index === -1) {
      return { restored: [], skipped: [{ path: '', reason: `no checkpoint for turn ${turn}` }] };
    }

    const affected = this.checkpoints.slice(index);
    const result: RestoreResult = { restored: [], skipped: [] };

    // Walk oldest-first and keep the first snapshot of each file: that is the
    // state it had before the earliest turn being undone. Taking the newest
    // would only rewind one turn's worth of change.
    const seen = new Set<string>();

    for (const checkpoint of affected) {
      for (const file of checkpoint.files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        await this.restoreFile(file, result);
      }
    }

    this.checkpoints = this.checkpoints.slice(0, index);
    this.turnCounter = this.checkpoints.at(-1)?.turn ?? 0;
    await this.persist();

    return result;
  }

  /** Undo just the most recent turn. */
  async undoLast(): Promise<{ checkpoint: Checkpoint; result: RestoreResult } | null> {
    const last = this.latest();
    if (!last) return null;
    const result = await this.restoreTo(last.turn);
    return { checkpoint: last, result };
  }

  private async restoreFile(file: FileSnapshot, result: RestoreResult): Promise<void> {
    const absolute = path.join(this.workspaceRoot, file.path);

    if (file.skipped) {
      result.skipped.push({ path: file.path, reason: `not snapshotted (${file.skipped})` });
      return;
    }

    try {
      // A move leaves a file at the destination that has to go back.
      if (file.kind === 'moved' && file.toPath) {
        await fs.rm(path.join(this.workspaceRoot, file.toPath), { force: true });
      }

      if (file.beforeRef === null) {
        // The file did not exist before the turn.
        await fs.rm(absolute, { force: true });
        result.restored.push(file.path);
        return;
      }

      const content = await this.readBlob(file.beforeRef);
      if (content === null) {
        result.skipped.push({ path: file.path, reason: 'snapshot data is missing' });
        return;
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content);
      result.restored.push(file.path);
    } catch (error) {
      result.skipped.push({ path: file.path, reason: String(error) });
    }
  }

  private relativize(absolute: string): string {
    const relative = path.relative(this.workspaceRoot, absolute);
    return relative && !relative.startsWith('..')
      ? relative.split(path.sep).join('/')
      : absolute.split(path.sep).join('/');
  }

  private async storeBlob(content: Buffer): Promise<string> {
    const hash = createHash('sha256').update(content).digest('hex');
    const file = path.join(this.blobDir, hash.slice(0, 2), hash.slice(2));
    try {
      await fs.access(file);
      return hash; // Already stored: identical content is written once.
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { mode: 0o600 });
      return hash;
    }
  }

  private async readBlob(hash: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(path.join(this.blobDir, hash.slice(0, 2), hash.slice(2)));
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    try {
      await ensureOrbitHome();
      await fs.mkdir(this.dir, { recursive: true });
      await writeFileAtomic(
        this.indexFile,
        JSON.stringify(
          {
            version: 1,
            session: this.sessionId,
            workspace: this.workspaceRoot,
            checkpoints: this.checkpoints,
          },
          null,
          2,
        ) + '\n',
        0o600,
      );
    } catch (error) {
      log.warn('could not persist checkpoints', { error: String(error) });
    }
  }

  /** Remove this session's checkpoint index. Blobs are shared, so they stay. */
  async clear(): Promise<void> {
    this.checkpoints = [];
    this.pending.clear();
    this.turnCounter = 0;
    await fs.rm(this.indexFile, { force: true }).catch(() => {});
  }

  describe(checkpoint: Checkpoint): string {
    const counts = checkpoint.files.reduce<Record<string, number>>((totals, file) => {
      totals[file.kind] = (totals[file.kind] ?? 0) + 1;
      return totals;
    }, {});
    const parts = Object.entries(counts).map(([kind, count]) => `${count} ${kind}`);
    return parts.join(', ') || 'no changes';
  }
}
