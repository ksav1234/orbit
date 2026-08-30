import { useCallback, useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';

export interface GlobalKeyHandlers {
  /** Called for Ctrl+C while an operation is running. */
  onCancel(): void;
  onExit(): void;
  onClearScreen(): void;
  onToggleExpand(): void;
  /** Toggle auto-working agent mode. */
  onToggleAuto(): void;
  /** True while the agent is streaming or running tools. */
  busy: boolean;
  /** Disable while a modal (permission prompt) owns the keyboard. */
  active?: boolean;
}

export interface GlobalKeyState {
  /** Message to surface in the footer, e.g. "press ctrl+c again to exit". */
  hint: string | null;
}

const DOUBLE_PRESS_WINDOW_MS = 2000;

/**
 * Global shortcuts. Ctrl+C cancels work rather than killing Orbit; exiting
 * takes a deliberate second press so an interrupted command never loses the
 * session by accident.
 */
export function useGlobalKeys(handlers: GlobalKeyHandlers): GlobalKeyState {
  const [hint, setHint] = useState<string | null>(null);
  const lastCtrlC = useRef(0);
  const timer = useRef<NodeJS.Timeout | null>(null);

  const flashHint = useCallback((message: string) => {
    setHint(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHint(null), DOUBLE_PRESS_WINDOW_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useInput(
    (input, key) => {
      if (!key.ctrl) return;

      // Auto mode: Ctrl+Shift+A where the terminal reports the shift modifier
      // (Windows Terminal, kitty, iTerm with modifyOtherKeys), Ctrl+G
      // everywhere else. Most terminals cannot distinguish Ctrl+Shift+A from
      // Ctrl+A, so a modifier-free binding has to exist.
      if ((key.shift && (input === 'a' || input === 'A')) || input === 'A' || input === 'g') {
        handlers.onToggleAuto();
        return;
      }

      switch (input) {
        case 'c': {
          if (handlers.busy) {
            handlers.onCancel();
            flashHint('cancelling…');
            return;
          }
          const now = Date.now();
          if (now - lastCtrlC.current < DOUBLE_PRESS_WINDOW_MS) {
            handlers.onExit();
            return;
          }
          lastCtrlC.current = now;
          flashHint('press ctrl+c again to exit');
          return;
        }
        case 'd': {
          handlers.onExit();
          return;
        }
        case 'l': {
          handlers.onClearScreen();
          return;
        }
        case 'o': {
          handlers.onToggleExpand();
          return;
        }
        default:
          break;
      }
    },
    { isActive: handlers.active ?? true },
  );

  return { hint };
}

/** Clear the scrollback the way Ctrl+L does in a shell. */
export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}
