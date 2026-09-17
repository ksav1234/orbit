import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { orbitPaths } from '../util/paths.js';
import { createLogger } from '../util/logger.js';
import { estimateTokens } from '../context/tokenizer.js';

const log = createLogger('lessons');

export const LessonSchema = z.object({
  text: z.string().min(1),
  at: z.string(),
  /** How it was learned: you said it outright, or you rejected something. */
  source: z.enum(['manual', 'correction']).default('manual'),
  /** What was being attempted when the correction happened. */
  about: z.string().optional(),
});
export type Lesson = z.infer<typeof LessonSchema>;

const LessonFileSchema = z.object({
  version: z.literal(1).default(1),
  workspace: z.string().default(''),
  lessons: z.array(LessonSchema).default([]),
});

/** Beyond this the prompt cost outweighs the value, and old advice goes stale. */
const MAX_LESSONS = 50;
const MAX_TEXT = 500;

/**
 * What Orbit has been told to do differently, remembered between sessions.
 *
 * The agent already reads a turn's worth of corrections — this is for the ones
 * worth keeping. When you reject an operation and say what you wanted instead,
 * that instruction is the most valuable sentence in the session: it is a rule,
 * not a request. Without somewhere to put it, the same mistake returns next
 * week.
 *
 * Kept per workspace. Advice about one repository is usually wrong about
 * another, and a rule like "deploy with make, never npm" should not follow you
 * somewhere it does not apply.
 *
 * Stored under `~/.orbit`, not in the repository, because Orbit should not
 * write files into a project nobody asked it to write to.
 */
export class LessonStore {
  private lessons: Lesson[] = [];
  private dirty = false;
  private loaded = false;

  private constructor(
    private readonly file: string,
    private readonly workspace: string,
  ) {}

  static fileFor(workspace: string): string {
    const key = createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16);
    return path.join(orbitPaths.root, 'lessons', `${key}.json`);
  }

  static create(workspace: string, file?: string): LessonStore {
    return new LessonStore(file ?? LessonStore.fileFor(workspace), workspace);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = LessonFileSchema.safeParse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      if (parsed.success) this.lessons = parsed.data.lessons;
    } catch {
      // Missing or unreadable. Lessons are an optimisation, never a dependency.
    }
  }

  list(): readonly Lesson[] {
    return this.lessons;
  }

  get count(): number {
    return this.lessons.length;
  }

  /**
   * Record something to do differently next time.
   *
   * Near-duplicates are folded into the existing entry rather than stacking up:
   * being told the same thing twice is a signal it matters, not a reason to
   * spend twice the prompt on it.
   */
  add(text: string, source: Lesson['source'], about?: string): Lesson | null {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 4) return null;

    const clipped = trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
    const key = normalize(clipped);

    const existing = this.lessons.findIndex((lesson) => normalize(lesson.text) === key);
    if (existing !== -1) {
      // Move it to the end so the most recently reinforced advice survives
      // trimming, and refresh when it was last heard.
      const [lesson] = this.lessons.splice(existing, 1);
      const refreshed: Lesson = { ...lesson!, at: new Date().toISOString() };
      this.lessons.push(refreshed);
      this.dirty = true;
      return refreshed;
    }

    const lesson: Lesson = {
      text: clipped,
      at: new Date().toISOString(),
      source,
      ...(about ? { about } : {}),
    };
    this.lessons.push(lesson);
    if (this.lessons.length > MAX_LESSONS) this.lessons = this.lessons.slice(-MAX_LESSONS);
    this.dirty = true;
    return lesson;
  }

  /** Remove by 1-based position, as `orbit lessons` displays them. */
  remove(position: number): Lesson | null {
    const index = position - 1;
    if (index < 0 || index >= this.lessons.length) return null;
    const [removed] = this.lessons.splice(index, 1);
    this.dirty = true;
    return removed ?? null;
  }

  clear(): number {
    const count = this.lessons.length;
    this.lessons = [];
    this.dirty = count > 0;
    return count;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const payload = { version: 1 as const, workspace: this.workspace, lessons: this.lessons };
      await fs.writeFile(this.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      this.dirty = false;
    } catch (error) {
      log.warn('could not save lessons', { error: String(error) });
    }
  }

  /**
   * The block added to the system prompt, or empty when there is nothing to
   * say. Newest last, within a token budget: recent advice is the advice most
   * likely to still be true.
   */
  render(maxTokens = 600): string {
    if (this.lessons.length === 0) return '';

    const chosen: string[] = [];
    let used = 0;
    for (let i = this.lessons.length - 1; i >= 0; i--) {
      const line = `- ${this.lessons[i]!.text}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) break;
      chosen.unshift(line);
      used += cost;
    }
    if (chosen.length === 0) return '';

    return [
      'What this user has told you before',
      '',
      'These came from earlier sessions in this workspace — things you were',
      'corrected on, or asked to remember. Follow them unless the current',
      'conversation says otherwise, and say so if one of them conflicts with',
      'what you are being asked to do now.',
      '',
      ...chosen,
    ].join('\n');
  }
}

/** Compare lessons on meaning, not punctuation or casing. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a message reads as a correction worth keeping.
 *
 * Most corrections are not a rejected tool call — they are the next thing you
 * type: "no, use the other file". Capturing those makes lessons useful rather
 * than rare, but capturing too eagerly fills the prompt with noise, so this is
 * deliberately narrow.
 *
 * It looks for two things together: a corrective opener, and language that
 * generalises. "no, fix that typo" is about this moment and is not a rule;
 * "no, never edit the lockfile by hand" is.
 */
const CORRECTIVE_OPENER = /^(no|nope|don'?t|do not|stop|actually|wrong|not like that)\b/i;

const GENERALISING =
  /\b(always|never|from now on|in future|going forward|prefer|instead of|rather than|remember to|make sure to|by default)\b/i;

export function looksLikeStandingCorrection(text: string): boolean {
  const trimmed = text.trim();
  // Long messages are tasks that happen to start with "no", not rules.
  if (trimmed.length < 8 || trimmed.length > 300) return false;
  if (trimmed.split(/\s+/).length > 40) return false;

  // A rule needs to generalise. Without that it is about this moment only.
  if (!GENERALISING.test(trimmed)) return false;

  // Either phrased as a correction, or stated outright as a standing rule.
  return CORRECTIVE_OPENER.test(trimmed) || /^(always|never|from now on)\b/i.test(trimmed);
}
