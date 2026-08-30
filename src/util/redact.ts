/**
 * Redaction is applied to everything that can reach a log file or the screen.
 * Orbit never renders or persists API keys, tokens or authorization headers.
 */

const SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Provider key formats.
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: 'sk-***' },
  { re: /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g, replace: 'sk-or-v1-***' },
  { re: /\bnvapi-[A-Za-z0-9_-]{16,}\b/g, replace: 'nvapi-***' },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replace: 'AIza***' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: 'ghp_***' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: 'xox*-***' },
  // Headers.
  { re: /(authorization"?\s*[:=]\s*"?)(bearer\s+)?[^"\s,}]+/gi, replace: '$1***' },
  { re: /(x-api-key"?\s*[:=]\s*"?)[^"\s,}]+/gi, replace: '$1***' },
  // Generic key/value assignments.
  {
    re: /((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|private[_-]?key)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi,
    replace: '$1***',
  },
  // PEM blocks.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[redacted private key]',
  },
];

/** Extra literal values (the configured API keys) registered at runtime. */
const literalSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.trim().length >= 8) literalSecrets.add(value.trim());
}

export function clearRegisteredSecrets(): void {
  literalSecrets.clear();
}

export function redact(input: string): string {
  let out = input;
  for (const secret of literalSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('***');
  }
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** Deep-redact an arbitrary value for logging. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(apikey|api_key|authorization|x-api-key|token|secret|password)$/i.test(k)) {
        out[k] = '***';
      } else {
        out[k] = redactValue(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Mask a key for display: keeps enough to identify it, never enough to use it. */
export function maskKey(key: string | undefined): string {
  if (!key) return 'not set';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '*'.repeat(Math.max(trimmed.length, 4));
  return `${'*'.repeat(12)}${trimmed.slice(-4)}`;
}
