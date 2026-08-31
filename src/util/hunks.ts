import { applyPatch, structuredPatch } from 'diff';
import { normalizeEol } from './diff.js';
import type { DiffLine } from './diff.js';

/** One contiguous change, as a user would think of it. */
export interface Hunk {
  /** Position in the list, and the number shown in the prompt. */
  index: number;
  /** The `@@ -a,b +c,d @@` header. */
  header: string;
  /** Lines for rendering, in the same shape the diff view already takes. */
  lines: DiffLine[];
  added: number;
  removed: number;
  /** First line of the file this hunk touches, for a one-line label. */
  startLine: number;
}

const FILE_LABEL = 'file';

/**
 * Split a proposed change into the hunks a user can accept or reject
 * separately.
 *
 * A model that gets four things right and one thing wrong currently forces an
 * all-or-nothing decision, so the useful unit is the hunk. jsdiff's structured
 * patch is what makes this exact rather than approximate: the same hunks it
 * produces here are the ones `applyHunks` feeds back to it.
 */
export function splitHunks(before: string, after: string, context = 3): Hunk[] {
  const patch = structuredPatch(
    FILE_LABEL,
    FILE_LABEL,
    normalizeEol(before),
    normalizeEol(after),
    undefined,
    undefined,
    { context },
  );

  return patch.hunks.map((hunk, index) => {
    const lines: DiffLine[] = [];
    let added = 0;
    let removed = 0;

    for (const raw of hunk.lines) {
      if (raw.startsWith('+')) {
        lines.push({ type: 'add', text: raw.slice(1) });
        added += 1;
      } else if (raw.startsWith('-')) {
        lines.push({ type: 'remove', text: raw.slice(1) });
        removed += 1;
      } else if (raw.startsWith('\\')) {
        // "\ No newline at end of file" — real, but not something to show or count.
        continue;
      } else {
        lines.push({ type: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
      }
    }

    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    return { index, header, lines, added, removed, startLine: hunk.oldStart };
  });
}

/**
 * Rebuild the file with only the chosen hunks applied.
 *
 * Returns undefined when the result cannot be produced exactly. That happens
 * when hunks overlap in a way that makes a partial application ambiguous, and
 * it has to be a refusal rather than a best effort: writing a file that is
 * neither what the model proposed nor what the user chose would be the worst
 * available outcome.
 */
export function applyHunks(before: string, after: string, selected: number[], context = 3): string | undefined {
  const original = normalizeEol(before);
  const target = normalizeEol(after);

  const wanted = new Set(selected);
  if (wanted.size === 0) return original;

  const patch = structuredPatch(FILE_LABEL, FILE_LABEL, original, target, undefined, undefined, {
    context,
  });
  if (wanted.size >= patch.hunks.length) return target;

  const chosen = patch.hunks.filter((_hunk, index) => wanted.has(index));
  if (chosen.length === 0) return original;

  const result = applyPatch(original, { ...patch, hunks: chosen });
  // jsdiff returns false when a hunk does not apply cleanly.
  return typeof result === 'string' ? result : undefined;
}

/** A one-line description of a hunk, for the selection list. */
export function describeHunk(hunk: Hunk): string {
  const counts: string[] = [];
  if (hunk.added > 0) counts.push(`+${hunk.added}`);
  if (hunk.removed > 0) counts.push(`-${hunk.removed}`);

  // The first changed line says more about what the hunk does than its header.
  const firstChange = hunk.lines.find((line) => line.type === 'add' || line.type === 'remove');
  const gist = firstChange?.text.trim() ?? '';
  const shortened = gist.length > 48 ? `${gist.slice(0, 45)}…` : gist;

  return `line ${hunk.startLine}  ${counts.join(' ') || 'no change'}${shortened ? `  ${shortened}` : ''}`;
}
