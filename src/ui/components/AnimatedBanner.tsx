import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { useTheme } from '../context.js';
import { BYLINE, TAGLINE, orbitTrack, selectLogo } from '../logo.js';
import { greeting, currentUserName, type LayoutSize } from '../theme.js';
import { truncateWidth } from '../../util/format.js';

export interface AnimatedBannerProps {
  columns: number;
  layout: LayoutSize;
  /** Called once the intro has settled, so the caller can commit a static frame. */
  onComplete: () => void;
  userName?: string;
  now?: Date;
  /** Milliseconds between frames. */
  frameMs?: number;
}

const REVEAL_FRAMES = 16;
const SHIMMER_FRAMES = 22;
const HOLD_FRAMES = 8;
const TOTAL_FRAMES = REVEAL_FRAMES + SHIMMER_FRAMES + HOLD_FRAMES;

/**
 * The launch animation: the wordmark wipes in column by column, a highlight
 * sweeps across it once, and a satellite orbits underneath throughout.
 *
 * It runs in the live region rather than the scrollback, and it is skippable —
 * an intro that cannot be interrupted is an intro that wastes the user's time.
 */
export function AnimatedBanner({
  columns,
  layout,
  onComplete,
  userName,
  now,
  frameMs = 55,
}: AnimatedBannerProps): React.ReactElement {
  const theme = useTheme();
  const { isRawModeSupported } = useStdin();
  const [frame, setFrame] = useState(0);
  const finished = useRef(false);

  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    onComplete();
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((value) => (value >= TOTAL_FRAMES ? value : value + 1));
    }, frameMs);
    return () => clearInterval(timer);
  }, [frameMs]);

  // Completion is signalled from an effect, not from inside the state updater:
  // the updater runs during render, and telling the parent to re-render from
  // there is invalid.
  useEffect(() => {
    if (frame >= TOTAL_FRAMES) finish();
    // `finish` is idempotent and stable for the life of the component.
  }, [frame]);

  // Any key skips straight to the finished state. Only bound when the terminal
  // can actually give us raw input — piping into Orbit must not crash it.
  //
  // The Boolean() matters: Ink reads `isRawModeSupported` from `stdin.isTTY`,
  // which Node leaves *undefined* rather than false for a non-TTY, and Ink
  // only honours a strict `false` here.
  useInput(() => finish(), { isActive: Boolean(isRawModeSupported) });

  const logo = selectLogo({
    columns,
    unicode: theme.unicode,
    narrow: layout === 'narrow',
  });
  const width = logo.lines[0]?.length ?? 0;

  // Phase 1: wipe in from the left.
  const revealed =
    frame >= REVEAL_FRAMES ? width : Math.round((frame / REVEAL_FRAMES) * width);

  // Phase 2: a highlight column sweeps across once the mark is whole.
  const shimmerFrame = frame - REVEAL_FRAMES;
  const shimmer =
    shimmerFrame >= 0 && shimmerFrame < SHIMMER_FRAMES
      ? (shimmerFrame / SHIMMER_FRAMES) * (width + 12) - 6
      : null;

  const trackWidth = Math.min(Math.max(width, 20), Math.max(20, columns - 4));
  const track = orbitTrack({
    width: trackWidth,
    phase: frame * 0.28,
    unicode: theme.unicode,
  });

  const showTagline = frame > REVEAL_FRAMES * 0.6;
  const showByline = frame > REVEAL_FRAMES + 3;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column">
        {logo.lines.map((line, row) => (
          <LogoLine
            key={row}
            line={line}
            row={row}
            revealed={revealed}
            shimmer={shimmer}
            baseColor={theme.gradient[row % theme.gradient.length] ?? theme.colors.primary}
            highlight={theme.colors.text}
            columns={columns}
          />
        ))}
      </Box>

      <Box>
        <Text>{'  '}</Text>
        {track.map((cell, index) => (
          <Text
            key={index}
            color={cell.intensity >= 0.75 ? theme.colors.primary : theme.colors.accent}
            bold={cell.intensity === 1}
            dimColor={cell.intensity > 0 && cell.intensity < 0.5}
          >
            {cell.char}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted}>
          {'  '}
          {showTagline ? truncateWidth(TAGLINE, columns - 4) : ''}
        </Text>
        <Text color={theme.colors.accent} dimColor>
          {'  '}
          {showByline ? BYLINE : ''}
        </Text>
      </Box>

      {showByline && (
        <Box marginTop={1}>
          <Text color={theme.colors.primary}>
            {'  '}
            {greeting(now)},{' '}
          </Text>
          <Text color={theme.colors.accent} bold>
            {truncateWidth(userName ?? currentUserName(), 24)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

interface LogoLineProps {
  line: string;
  row: number;
  revealed: number;
  shimmer: number | null;
  baseColor: string;
  highlight: string;
  columns: number;
}

/**
 * One row of the wordmark. Split into three runs — before the highlight, the
 * highlight itself, and after — so a sweep costs three Text nodes rather than
 * one per character.
 */
function LogoLine({
  line,
  revealed,
  shimmer,
  baseColor,
  highlight,
  columns,
}: LogoLineProps): React.ReactElement {
  const visible = truncateWidth(line.slice(0, revealed), columns - 1);

  if (shimmer === null) {
    return (
      <Text color={baseColor} bold>
        {visible}
      </Text>
    );
  }

  const start = Math.max(0, Math.round(shimmer) - 2);
  const end = Math.min(visible.length, Math.round(shimmer) + 3);

  if (start >= visible.length || end <= 0) {
    return (
      <Text color={baseColor} bold>
        {visible}
      </Text>
    );
  }

  return (
    <Text bold>
      <Text color={baseColor}>{visible.slice(0, start)}</Text>
      <Text color={highlight}>{visible.slice(start, end)}</Text>
      <Text color={baseColor}>{visible.slice(end)}</Text>
    </Text>
  );
}

/** Frames the intro runs for, used to size test waits and skip logic. */
export const ANIMATION_FRAMES = TOTAL_FRAMES;
