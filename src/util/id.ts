import { randomBytes } from 'node:crypto';

export function shortId(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

export function slugify(input: string, maxWords = 4): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-')
    .slice(0, 48);
}

/** Session ids read like `2026-08-29-auth-fix-3f2a`. */
export function sessionId(title?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title ?? '') || 'session';
  return `${date}-${slug}-${shortId(2)}`;
}
