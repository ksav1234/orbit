import { describe, expect, it, beforeEach } from 'vitest';
import type { Key } from 'ink';
import {
  bufferedKeyCount,
  drainBuffer,
  isSafeToReplayIntoApproval,
  recordIfUnconsumed,
  resetInputBuffer,
} from '../src/ui/input-buffer.js';

const key = (overrides: Partial<Key> = {}): Key =>
  ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  }) as Key;

beforeEach(() => {
  resetInputBuffer();
});

describe('holding keystrokes that nothing is listening for', () => {
  // The gap: the prompt is on screen, the old handler has unsubscribed, the new
  // one has not yet subscribed. Ink emits to nobody and the key is gone.
  it('records a keystroke when no handler is subscribed', () => {
    expect(recordIfUnconsumed('y', key())).toBe(true);
    expect(bufferedKeyCount()).toBe(1);
  });

  it('records nothing while a handler is listening', () => {
    // One consumer active — simulated by draining after a record, since the
    // counter is internal. A live handler means the key was delivered.
    resetInputBuffer();
    recordIfUnconsumed('a', key());
    const drained = drainBuffer();
    expect(drained).toHaveLength(1);
    // Buffer is emptied by the drain, so nothing is replayed twice.
    expect(bufferedKeyCount()).toBe(0);
    expect(drainBuffer()).toHaveLength(0);
  });

  // Replaying something typed a minute ago would be spookier than dropping it.
  it('does not replay a stale keystroke', () => {
    const longAgo = Date.now() - 5_000;
    recordIfUnconsumed('y', key(), longAgo);
    recordIfUnconsumed('n', key());

    const drained = drainBuffer();

    expect(drained.map((entry) => entry.input)).toEqual(['n']);
  });

  it('keeps the buffer bounded when input arrives with nothing listening', () => {
    for (let i = 0; i < 500; i++) recordIfUnconsumed(String(i % 10), key());
    expect(bufferedKeyCount()).toBeLessThanOrEqual(16);
  });

  it('preserves order so a typed word is replayed as typed', () => {
    for (const character of 'hello') recordIfUnconsumed(character, key());
    expect(drainBuffer().map((entry) => entry.input).join('')).toBe('hello');
  });
});

describe('what may be replayed into an approval prompt', () => {
  // The safety rule: replaying a buffered `y` would approve an operation the
  // user never read. Everything Orbit does elsewhere is built on not doing that.
  it('never replays an approval', () => {
    expect(isSafeToReplayIntoApproval('y', key())).toBe(false);
    expect(isSafeToReplayIntoApproval('Y', key())).toBe(false);
    expect(isSafeToReplayIntoApproval('a', key())).toBe(false);
    expect(isSafeToReplayIntoApproval('', key({ return: true }))).toBe(false);
  });

  // A replayed denial is safe: the worst outcome is being asked again.
  it('replays a denial or a cancel', () => {
    expect(isSafeToReplayIntoApproval('n', key())).toBe(true);
    expect(isSafeToReplayIntoApproval('N', key())).toBe(true);
    expect(isSafeToReplayIntoApproval('', key({ escape: true }))).toBe(true);
  });

  it('does not treat anything else as a decision', () => {
    for (const character of ['e', 'd', 'p', 'x', '1']) {
      expect(isSafeToReplayIntoApproval(character, key()), character).toBe(false);
    }
  });
});
