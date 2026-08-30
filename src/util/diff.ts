import { createTwoFilesPatch, diffLines } from 'diff';

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk' | 'meta';
  text: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  patch: string;
  lines: DiffLine[];
}

/** Unified diff for the approval UI and for describing edits to the model. */
export function unifiedDiff(
  filePath: string,
  before: string,
  after: string,
  context = 3,
): DiffSummary {
  const patch = createTwoFilesPatch(
    filePath,
    filePath,
    normalizeEol(before),
    normalizeEol(after),
    undefined,
    undefined,
    { context },
  );
  const lines = parsePatch(patch);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'remove') removed++;
  }
  return { added, removed, patch, lines };
}

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index:') || raw.startsWith('===')) {
      out.push({ type: 'meta', text: raw });
    } else if (raw.startsWith('@@')) {
      out.push({ type: 'hunk', text: raw });
    } else if (raw.startsWith('+')) {
      out.push({ type: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      out.push({ type: 'remove', text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      continue;
    } else {
      out.push({ type: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }
  return out;
}

/** Drop the file headers so the UI can render its own title. */
export function diffBody(lines: DiffLine[]): DiffLine[] {
  return lines.filter((line) => line.type !== 'meta');
}

export function changeStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(normalizeEol(before), normalizeEol(after))) {
    const count = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }
  return { added, removed };
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Preserve the file's dominant line ending when writing edits back. */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function applyEol(text: string, eol: '\n' | '\r\n'): string {
  const normalized = normalizeEol(text);
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}
