import { CancelledError, OrbitError } from './errors.js';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Combine caller cancellation with a deadline into one signal. */
export function withTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      reject(new OrbitError(label + ' timed out after ' + seconds + 's', {
        kind: 'tool',
        retryable: true,
      }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with jitter; never retries after cancellation. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      const retryable = options.shouldRetry ? options.shouldRetry(error, attempt) : true;
      if (!retryable || attempt === attempts) throw error;
      const delay = Math.min(max, base * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

/** A promise plus the handles needed to settle it elsewhere (permission prompts). */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Run tasks with bounded concurrency, preserving input order in the results. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
