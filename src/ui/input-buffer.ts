import { useEffect, useRef } from 'react';
import { useInput, type Key } from 'ink';

/**
 * Keystrokes typed in the moment a prompt appears, held until something can
 * read them.
 *
 * Ink dispatches input through an EventEmitter, which has no replay. A handler
 * subscribes in an effect, which runs *after* the frame that announced the
 * prompt is already on screen — so there is a window where the prompt is
 * visible, the previous handler has already unsubscribed, and the new one has
 * not yet subscribed. Anything typed in that window is emitted to nobody and
 * lost. The user sees a prompt that ignored them.
 *
 * This records input during exactly that window and hands it to the next
 * handler that appears.
 */

export interface BufferedKey {
  input: string;
  key: Key;
  at: number;
}

/**
 * Old keystrokes are not worth replaying: if half a second has passed, the user
 * has seen the prompt and will type again. Replaying stale input would be
 * spookier than dropping it.
 */
const MAX_AGE_MS = 500;
const MAX_PENDING = 16;

const pending: BufferedKey[] = [];
/** How many consumers are currently subscribed. Zero means the gap. */
let consumers = 0;

/** Test seam. Never needed in a real session. */
export function resetInputBuffer(): void {
  pending.length = 0;
  consumers = 0;
}

export function bufferedKeyCount(): number {
  return pending.length;
}

/**
 * Record a keystroke when nothing is listening.
 *
 * Exported for tests; the recorder hook is the real caller.
 */
export function recordIfUnconsumed(input: string, key: Key, now = Date.now()): boolean {
  if (consumers > 0) return false;
  pending.push({ input, key, at: now });
  if (pending.length > MAX_PENDING) pending.shift();
  return true;
}

/** Take everything still fresh enough to be worth delivering. */
export function drainBuffer(now = Date.now()): BufferedKey[] {
  const fresh = pending.filter((entry) => now - entry.at <= MAX_AGE_MS);
  pending.length = 0;
  return fresh;
}

/**
 * Watch stdin for the whole session, so the gap between handlers is covered.
 *
 * Mounted once at the root. It subscribes before any prompt does, so it sees
 * every keystroke first and can tell whether anything else was listening.
 */
export function useInputRecorder(isActive: boolean): void {
  useInput(
    (input, key) => {
      recordIfUnconsumed(input, key);
    },
    { isActive },
  );
}

export interface BufferedInputOptions {
  isActive?: boolean;
  /**
   * Whether a *replayed* keystroke may be acted on. Live input is never
   * filtered.
   *
   * The permission prompt uses this. Replaying a buffered `y` into an approval
   * that appeared a moment ago would approve an operation the user never read,
   * which is exactly the thing Orbit is careful about everywhere else. A
   * replayed denial is safe: the worst outcome is being asked again.
   */
  acceptReplay?: (input: string, key: Key) => boolean;
}

/**
 * `useInput`, plus whatever was typed just before this handler existed.
 */
export function useBufferedInput(
  handler: (input: string, key: Key) => void,
  options: BufferedInputOptions = {},
): void {
  const isActive = options.isActive !== false;

  // Held in refs so the effect below can stay keyed on `isActive` alone: it
  // must run when a prompt appears, not every time a parent re-renders.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const acceptRef = useRef(options.acceptReplay);
  acceptRef.current = options.acceptReplay;

  useEffect(() => {
    if (!isActive) return;

    consumers += 1;
    for (const entry of drainBuffer()) {
      if (acceptRef.current && !acceptRef.current(entry.input, entry.key)) continue;
      handlerRef.current(entry.input, entry.key);
    }

    return () => {
      consumers = Math.max(0, consumers - 1);
    };
  }, [isActive]);

  useInput((input, key) => handlerRef.current(input, key), { isActive });
}

/**
 * Keystrokes that can only ever reduce what happens: deny, cancel, dismiss.
 *
 * Used to decide what may be replayed into an approval prompt.
 */
export function isSafeToReplayIntoApproval(input: string, key: Key): boolean {
  if (key.escape) return true;
  return input.toLowerCase() === 'n';
}
