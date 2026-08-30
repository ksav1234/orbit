import stringWidth from 'string-width';

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const delta = Date.now() - then;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** Truncate to a display width, accounting for wide/emoji characters. */
export function truncateWidth(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (stringWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  const limit = Math.max(0, max - stringWidth(ellipsis));
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w > limit) break;
    out += ch;
    width += w;
  }
  return out + ellipsis;
}

/** Collapse a value to a single display line (used for tool argument summaries). */
export function oneLine(text: string, max = 80): string {
  return truncateWidth(text.replace(/\s+/g, ' ').trim(), max);
}

export interface LineClamp {
  text: string;
  hiddenLines: number;
  totalLines: number;
}

/** Keep the first `head` and last `tail` lines, reporting how much was hidden. */
export function clampLines(text: string, head: number, tail = 0): LineClamp {
  const lines = text.split('\n');
  if (lines.length <= head + tail) {
    return { text, hiddenLines: 0, totalLines: lines.length };
  }
  const hidden = lines.length - head - tail;
  const parts = [...lines.slice(0, head)];
  parts.push(`... ${hidden} lines hidden ...`);
  if (tail > 0) parts.push(...lines.slice(-tail));
  return { text: parts.join('\n'), hiddenLines: hidden, totalLines: lines.length };
}

/** Truncate by characters, keeping the head and tail of the content. */
export function clampChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 40);
  const omitted = text.length - head - tail;
  const middle = `\n\n... ${omitted.toLocaleString()} characters omitted ...\n\n`;
  return { text: text.slice(0, head) + middle + (tail > 0 ? text.slice(-tail) : ''), truncated: true };
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function padEndWidth(text: string, width: number): string {
  const w = stringWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}
