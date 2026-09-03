import { describe, expect, it, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  childEnv,
  drainPerformanceEntries,
  nodeEnvWasDefaulted,
  stopDrainingPerformanceEntries,
  stripInjectedNodeEnv,
} from '../src/util/env.js';
import { runCommand } from '../src/util/process.js';

const isWindows = process.platform === 'win32';

afterEach(() => {
  stopDrainingPerformanceEntries();
});

describe('choosing the React build', () => {
  it('leaves the process with a NODE_ENV set either way', () => {
    // Vitest sets NODE_ENV=test, so the module will not have defaulted it here.
    // Either way, something must be set or React picks the development build.
    expect(process.env.NODE_ENV).toBeTruthy();
  });
});

describe('what child processes inherit', () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it('passes through a NODE_ENV the user set', () => {
    process.env.NODE_ENV = 'staging';
    // Orbit never overrides the user's choice, so it is never stripped either.
    expect(childEnv().NODE_ENV).toBe('staging');
  });

  // The case vitest cannot reach on its own: it sets NODE_ENV=test, so the
  // module never defaults and the stripping branch is never taken. Testing the
  // decision directly covers both sides of it.
  it('strips the value Orbit injected, and nothing else', () => {
    const injected = stripInjectedNodeEnv({ NODE_ENV: 'production', KEEP: 'yes' }, true);
    expect(injected.NODE_ENV).toBeUndefined();
    expect(injected.KEEP).toBe('yes');

    // Same value, but the user set it: it stays.
    const chosen = stripInjectedNodeEnv({ NODE_ENV: 'production' }, false);
    expect(chosen.NODE_ENV).toBe('production');

    // A different value is never Orbit's, whatever the flag says.
    expect(stripInjectedNodeEnv({ NODE_ENV: 'development' }, true).NODE_ENV).toBe('development');
    expect(stripInjectedNodeEnv({ NODE_ENV: 'test' }, true).NODE_ENV).toBe('test');
  });

  it('leaves an explicit production value alone when the user chose it', () => {
    process.env.NODE_ENV = 'production';
    const env = childEnv();
    // Only meaningful when Orbit did not default it; under vitest it did not.
    if (!nodeEnvWasDefaulted) expect(env.NODE_ENV).toBe('production');
  });

  it('does not mutate the environment it was handed', () => {
    const supplied = { ...process.env, ORBIT_MARKER: 'kept' };
    const result = childEnv(supplied);
    expect(result.ORBIT_MARKER).toBe('kept');
    expect(supplied.ORBIT_MARKER).toBe('kept');
  });

  // The hazard this guards: Orbit runs the user's tests and builds, and a
  // NODE_ENV it invented for its own renderer would change how they behave.
  it('reaches a real child process with the right value', async () => {
    process.env.NODE_ENV = 'staging';
    const command = isWindows ? 'echo [%NODE_ENV%]' : 'echo "[$NODE_ENV]"';
    const result = await runCommand({ command, shell: true, timeoutMs: 20_000 });
    expect(result.stdout).toContain('staging');
  });
});

describe('keeping the performance buffer bounded', () => {
  it('clears entries as they arrive', async () => {
    drainPerformanceEntries();

    // Stand in for React's development reconciler, which emits one of these per
    // render — a few hundred a second for a live terminal UI.
    for (let i = 0; i < 5_000; i++) {
      performance.mark(`orbit-test-${i}`);
      performance.measure(`orbit-test-measure-${i}`, `orbit-test-${i}`);
    }

    // Poll rather than sleep a fixed interval: the observer fires on the event
    // loop, and a fixed wait measures machine load instead of correctness.
    const deadline = Date.now() + 5_000;
    while (performance.getEntriesByType('measure').length >= 1_000 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Without draining this would be 5,000 and climbing; Node warns at a
    // million, and the entries are genuinely retained until then.
    expect(performance.getEntriesByType('measure').length).toBeLessThan(1_000);
  });

  it('is safe to call more than once', () => {
    drainPerformanceEntries();
    expect(() => drainPerformanceEntries()).not.toThrow();
  });

  it('stops cleanly', () => {
    drainPerformanceEntries();
    expect(() => stopDrainingPerformanceEntries()).not.toThrow();
    // And stopping when nothing is running is not an error either.
    expect(() => stopDrainingPerformanceEntries()).not.toThrow();
  });
});
