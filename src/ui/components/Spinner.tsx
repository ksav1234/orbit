import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import cliSpinners from 'cli-spinners';
import { useTheme } from '../context.js';

export interface SpinnerProps {
  label?: string;
  color?: string;
  /** Elapsed-time hint shown after the label. */
  startedAt?: number;
}

/**
 * A frame-based spinner. Uses a dot spinner where Unicode is available and a
 * plain rotating bar otherwise so it stays legible over SSH and in cmd.exe.
 */
export function Spinner({ label, color, startedAt }: SpinnerProps): React.ReactElement {
  const theme = useTheme();
  const spinner = theme.unicode ? cliSpinners.dots : cliSpinners.line;
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), spinner.interval);
    return () => clearInterval(timer);
  }, [spinner.interval]);

  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const glyph = spinner.frames[frame % spinner.frames.length] ?? theme.symbols.pending;

  return (
    <Text color={color ?? theme.colors.primary}>
      {glyph}
      {label ? ` ${label}` : ''}
      {startedAt && elapsed >= 2 ? <Text color={theme.colors.muted}>{` ${elapsed}s`}</Text> : null}
    </Text>
  );
}

/** Static equivalent used inside completed transcript entries. */
export function StatusGlyph({ state }: { state: 'pending' | 'ok' | 'error' | 'warn' }): React.ReactElement {
  const theme = useTheme();
  switch (state) {
    case 'ok':
      return <Text color={theme.colors.success}>{theme.symbols.success}</Text>;
    case 'error':
      return <Text color={theme.colors.danger}>{theme.symbols.failure}</Text>;
    case 'warn':
      return <Text color={theme.colors.warning}>{theme.symbols.warning}</Text>;
    default:
      return <Text color={theme.colors.muted}>{theme.symbols.pending}</Text>;
  }
}
