import { PerformanceObserver, performance } from 'node:perf_hooks';

/**
 * Process environment setup that has to happen before anything else loads.
 *
 * React ships two builds and chooses between them by reading `NODE_ENV` **at
 * import time**. With it unset, Ink loads the development reconciler, which
 * calls `performance.measure()` on every render — around 330 entries a second
 * for a live terminal UI. Nothing drains Node's global user-timing buffer, so
 * after roughly an hour of use the process prints:
 *
 *   MaxPerformanceEntryBufferExceededWarning: Possible perf_hooks memory leak
 *   detected. 1000001 measure entries added to the global performance entry
 *   buffer.
 *
 * The entries are also genuinely retained, so it is a slow leak rather than
 * just a noisy warning — and the development build is slower besides.
 *
 * Because the check happens at import time, this module must be imported first
 * in the entry point. ES module imports are evaluated in source order, so the
 * assignment below runs before `ink` and `react` are pulled in.
 */

/**
 * Whether Orbit chose `NODE_ENV` rather than the user. Kept so the value can be
 * stripped from child processes: Orbit runs the user's tests, builds and hooks,
 * and those must see the environment the user has, not one Orbit invented for
 * its own renderer.
 */
export const nodeEnvWasDefaulted = process.env.NODE_ENV === undefined;

if (nodeEnvWasDefaulted) {
  process.env.NODE_ENV = 'production';
}

/**
 * Remove an injected `NODE_ENV` from a child's environment.
 *
 * A `NODE_ENV` the user set themselves is left exactly as it is — only Orbit's
 * own default is stripped. Without this, `npm test` run from a hook would
 * silently execute in production mode, `npm install` would skip
 * devDependencies, and bundlers would take a different code path.
 */
export function childEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return stripInjectedNodeEnv(env ?? process.env, nodeEnvWasDefaulted);
}

/**
 * The decision on its own, separated from the module-level flag so it can be
 * tested both ways. The flag is fixed at import time, and a test cannot rewind
 * that.
 */
export function stripInjectedNodeEnv(
  env: NodeJS.ProcessEnv,
  wasDefaulted: boolean,
): NodeJS.ProcessEnv {
  if (!wasDefaulted) return env;
  // Only the exact value Orbit injects is removed. Anything else came from the
  // user, even if Orbit also happened to default on this run.
  if (env.NODE_ENV !== 'production') return env;

  const copy = { ...env };
  delete copy.NODE_ENV;
  return copy;
}

let drainObserver: PerformanceObserver | undefined;

/**
 * Keep the user-timing buffer from growing without bound.
 *
 * The `NODE_ENV` default above removes the cause in the normal case, but a user
 * whose shell already exports `NODE_ENV=development` gets React's development
 * build regardless — Orbit will not override a value the user set. This is the
 * backstop for that case: entries are cleared as they arrive, which keeps the
 * buffer at a handful of entries instead of a million.
 *
 * Idempotent, and the observer is unref'd so it never holds the process open.
 */
export function drainPerformanceEntries(): void {
  if (drainObserver) return;
  try {
    drainObserver = new PerformanceObserver(() => {
      performance.clearMeasures();
      performance.clearMarks();
    });
    drainObserver.observe({ entryTypes: ['measure', 'mark'] });
    // Nothing here is worth keeping the event loop alive for.
    (drainObserver as unknown as { unref?: () => void }).unref?.();
  } catch {
    // perf_hooks is unavailable or restricted. Nothing to drain, nothing to do.
    drainObserver = undefined;
  }
}

/** Stop draining. Used by tests; harmless otherwise. */
export function stopDrainingPerformanceEntries(): void {
  drainObserver?.disconnect();
  drainObserver = undefined;
}
