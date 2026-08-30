import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { orbitPaths, ensureOrbitHome, tildify } from '../util/paths.js';
import { writeFileAtomic } from '../config/manager.js';
import { sessionId as makeSessionId, slugify } from '../util/id.js';
import { createLogger } from '../util/logger.js';
import type { ContextEntry } from '../context/manager.js';
import type { Usage } from '../providers/provider.js';

const log = createLogger('sessions');

export interface ToolHistoryEntry {
  name: string;
  at: string;
  ok: boolean;
  summary: string;
}

export interface SessionRecord {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  /** Provider identity only — credentials are never written to a session. */
  provider: { id: string; label: string; model: string };
  entries: ContextEntry[];
  toolHistory: ToolHistoryEntry[];
  usage: Usage;
  messageCount: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  workspace: string;
  model: string;
  provider: string;
  messageCount: number;
  file: string;
}

const RecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  workspace: z.string(),
  provider: z.object({ id: z.string(), label: z.string(), model: z.string() }),
  entries: z.array(z.any()),
  toolHistory: z.array(z.any()).default([]),
  usage: z
    .object({
      promptTokens: z.number().default(0),
      completionTokens: z.number().default(0),
      totalTokens: z.number().default(0),
    })
    .default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  messageCount: z.number().default(0),
});

export class SessionManager {
  private readonly dir = orbitPaths.sessions;

  async list(options: { workspace?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    await ensureOrbitHome();
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const full = path.join(this.dir, file);
      const record = await this.readRecord(full);
      if (!record) continue;
      if (options.workspace && path.resolve(record.workspace) !== path.resolve(options.workspace)) {
        continue;
      }
      summaries.push({
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        workspace: record.workspace,
        model: record.provider.model,
        provider: record.provider.label,
        messageCount: record.messageCount || record.entries.length,
        file: full,
      });
    }

    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return options.limit ? summaries.slice(0, options.limit) : summaries;
  }

  private async readRecord(file: string): Promise<SessionRecord | null> {
    try {
      const parsed = RecordSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (!parsed.success) {
        log.warn('ignoring malformed session file', { file: path.basename(file) });
        return null;
      }
      return parsed.data as SessionRecord;
    } catch {
      return null;
    }
  }

  /** Accepts a full id, a filename, or a unique prefix. */
  async load(idOrPrefix: string): Promise<SessionRecord | null> {
    const direct = path.join(this.dir, `${idOrPrefix.replace(/\.json$/, '')}.json`);
    const record = await this.readRecord(direct);
    if (record) return record;

    const summaries = await this.list();
    const matches = summaries.filter((s) => s.id.startsWith(idOrPrefix) || s.title.includes(idOrPrefix));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const exact = matches.find((s) => s.id === idOrPrefix);
      if (!exact) {
        log.warn('ambiguous session id', { idOrPrefix, matches: matches.length });
      }
      return this.readRecord((exact ?? matches[0]!).file);
    }
    return this.readRecord(matches[0]!.file);
  }

  async latest(workspace?: string): Promise<SessionRecord | null> {
    const summaries = await this.list(workspace ? { workspace } : {});
    const first = summaries[0];
    return first ? this.readRecord(first.file) : null;
  }

  async save(record: SessionRecord): Promise<string> {
    await ensureOrbitHome();
    const file = path.join(this.dir, `${record.id}.json`);
    const serializable: SessionRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      entries: record.entries.map(stripBinaryContent),
    };
    await writeFileAtomic(file, JSON.stringify(serializable, null, 2) + '\n', 0o600);
    return file;
  }

  async delete(id: string): Promise<boolean> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      await fs.unlink(file);
      return true;
    } catch {
      return false;
    }
  }

  async deleteAll(): Promise<number> {
    const summaries = await this.list();
    let removed = 0;
    for (const summary of summaries) {
      try {
        await fs.unlink(summary.file);
        removed++;
      } catch {
        // Ignore files that vanished between listing and deletion.
      }
    }
    return removed;
  }

  /** Keep the newest `maxStored` sessions and drop the rest. */
  async prune(maxStored: number): Promise<number> {
    const summaries = await this.list();
    const excess = summaries.slice(maxStored);
    for (const session of excess) {
      try {
        await fs.unlink(session.file);
      } catch {
        // Best effort.
      }
    }
    return excess.length;
  }
}

/**
 * Base64 image payloads would bloat session files by megabytes; keep a
 * human-readable placeholder instead.
 */
function stripBinaryContent(entry: ContextEntry): ContextEntry {
  const { message } = entry;
  if (!Array.isArray(message.content)) return entry;
  const content = message.content.map((part) =>
    part.type === 'image'
      ? { type: 'text' as const, text: `[image not stored in session: ${part.name ?? part.mediaType}]` }
      : part,
  );
  return { ...entry, message: { ...message, content } };
}

export function newSessionRecord(input: {
  workspace: string;
  provider: { id: string; label: string; model: string };
  title?: string;
}): SessionRecord {
  const now = new Date().toISOString();
  const title = input.title ?? path.basename(input.workspace);
  return {
    version: 1,
    id: makeSessionId(title),
    title,
    createdAt: now,
    updatedAt: now,
    workspace: input.workspace,
    provider: input.provider,
    entries: [],
    toolHistory: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messageCount: 0,
  };
}

/** Derive a readable title from the first user message. */
export function titleFromPrompt(prompt: string, fallback: string): string {
  const slug = slugify(prompt, 5).replace(/-/g, ' ');
  return slug || fallback;
}

export function describeSession(summary: SessionSummary): string {
  return `${summary.id}  ${summary.model}  ${tildify(summary.workspace)}  ${summary.messageCount} messages`;
}
