/** Categories drive how the UI renders a failure and which recovery actions it offers. */
export type ErrorKind =
  | 'provider'
  | 'auth'
  | 'network'
  | 'rate-limit'
  | 'permission'
  | 'sandbox'
  | 'tool'
  | 'config'
  | 'cancelled'
  | 'context'
  | 'internal';

export interface OrbitErrorOptions {
  kind?: ErrorKind;
  /** Short, human-readable explanation shown in the UI. */
  detail?: string;
  /** Concrete next steps offered to the user. */
  hints?: string[];
  cause?: unknown;
  /** Whether an automatic retry could plausibly succeed. */
  retryable?: boolean;
}

export class OrbitError extends Error {
  readonly kind: ErrorKind;
  readonly detail?: string;
  readonly hints: string[];
  readonly retryable: boolean;

  constructor(message: string, options: OrbitErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OrbitError';
    this.kind = options.kind ?? 'internal';
    this.detail = options.detail;
    this.hints = options.hints ?? [];
    this.retryable = options.retryable ?? false;
  }
}

export class CancelledError extends OrbitError {
  constructor(message = 'Operation cancelled') {
    super(message, { kind: 'cancelled' });
    this.name = 'CancelledError';
  }
}

export class SandboxError extends OrbitError {
  constructor(message: string, detail?: string) {
    super(message, { kind: 'sandbox', detail });
    this.name = 'SandboxError';
  }
}

export class PermissionDeniedError extends OrbitError {
  constructor(message = 'Permission denied by user') {
    super(message, { kind: 'permission' });
    this.name = 'PermissionDeniedError';
  }
}

export function isCancellation(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  if (err instanceof OrbitError) return err.kind === 'cancelled';
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    return name === 'AbortError' || name === 'CancelledError';
  }
  return false;
}

/** Best-effort message extraction from unknown throwables. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Convert low-level transport failures into an OrbitError with guidance.
 * Raw codes like ECONNRESET are never surfaced to the user on their own.
 */
export function toFriendlyError(err: unknown, context: { provider?: string } = {}): OrbitError {
  if (err instanceof OrbitError) return err;
  if (isCancellation(err)) return new CancelledError();

  const raw = errorMessage(err);
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const where = context.provider ? ` ${context.provider}` : ' the provider';

  const networkCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);

  if (networkCodes.has(code) || /fetch failed|network|socket hang up/i.test(raw)) {
    return new OrbitError(`Unable to reach${where}.`, {
      kind: 'network',
      detail: 'The request did not complete.',
      hints: ['Check your network connection.', 'Verify the provider base URL is reachable.'],
      cause: err,
      retryable: true,
    });
  }

  return new OrbitError(`Unexpected error from${where}.`, {
    kind: 'internal',
    detail: raw,
    cause: err,
  });
}
