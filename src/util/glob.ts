/**
 * Small glob matcher for tool arguments. Supports `*`, `?`, `**`, `{a,b}` and
 * character classes — enough for `src/**\/*.ts` style patterns without pulling
 * in a dependency.
 */

export interface GlobOptions {
  /** Match case-insensitively (default on Windows). */
  caseInsensitive?: boolean;
  /** Allow `*` to cross path separators. */
  dot?: boolean;
}

export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled) {
        const followedBySlash = pattern[i + 2] === '/';
        // `**/` matches zero or more directories; bare `**` matches anything.
        out += followedBySlash ? '(?:[^/]*\\/)*' : '.*';
        i += followedBySlash ? 3 : 2;
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      out += `[${body}]`;
      i = close + 1;
      continue;
    }

    if (char === '{') {
      const close = findClosingBrace(pattern, i);
      if (close === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const alternatives = splitAlternatives(pattern.slice(i + 1, close));
      out += `(?:${alternatives.map((alt) => globToRegExp(alt, options).source.replace(/^\^|\$$/g, '')).join('|')})`;
      i = close + 1;
      continue;
    }

    out += escapeRegExp(char);
    i += 1;
  }

  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

export function matchesGlob(filePath: string, pattern: string, options?: GlobOptions): boolean {
  const normalized = filePath.split('\\').join('/');
  const regex = globToRegExp(pattern, options);
  if (regex.test(normalized)) return true;
  // A bare pattern with no separator also matches by basename, as users expect.
  if (!pattern.includes('/')) {
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    return globToRegExp(pattern, options).test(base);
  }
  return false;
}

export function matchesAnyGlob(filePath: string, patterns: string[], options?: GlobOptions): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern, options));
}

function findClosingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
