import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import type { LayoutSize } from '../theme.js';
import { shortenPath } from '../../util/paths.js';
import { formatCount, truncateWidth } from '../../util/format.js';

export interface FooterProps {
  model: string;
  provider: string;
  workspace: string;
  usedTokens: number;
  contextWindow: number;
  session: string;
  columns: number;
  layout: LayoutSize;
  /** Transient hint replacing the normal status text (e.g. "esc to cancel"). */
  hint?: string;
  branch?: string;
  /** Auto-working mode indicator. */
  autoMode?: boolean;
  /** Latest optimizer reading, shown when the window is under strain. */
  pressure?: string;
}

/** Bottom status bar: identity on the left, context pressure on the right. */
export function Footer({
  model,
  provider,
  workspace,
  usedTokens,
  contextWindow,
  session,
  columns,
  layout,
  hint,
  branch,
  autoMode = false,
  pressure,
}: FooterProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(20, columns - 1);
  const ratio = contextWindow > 0 ? usedTokens / contextWindow : 0;
  const percent = Math.min(100, Math.round(ratio * 100));

  const pressureColor =
    ratio >= 0.9 ? theme.colors.danger : ratio >= 0.75 ? theme.colors.warning : theme.colors.muted;

  const separator = ` ${theme.symbols.dot} `;
  const contextLabel = `${formatCount(usedTokens)}/${formatCount(contextWindow)} (${percent}%${
    pressure && pressure !== 'low' && layout === 'wide' ? ` ${pressure}` : ''
  })`;

  // Identity on the left; context pressure is always the rightmost item so it
  // stays visible as the terminal narrows.
  const left =
    layout === 'narrow'
      ? [model]
      : layout === 'normal'
        ? [model, provider, shortenPath(workspace, 22)]
        : [model, provider, shortenPath(workspace, 34), ...(branch ? [branch] : []), session];

  const autoBadge = autoMode ? `AUTO${separator}` : '';
  const leftBudget = Math.max(
    8,
    width - contextLabel.length - separator.length - autoBadge.length - 2,
  );

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.border}>{theme.symbols.divider.repeat(width)}</Text>
      <Box>
        {hint ? (
          <Text color={theme.colors.muted}>
            {' '}
            {autoMode && <Text color={theme.colors.success} bold>{`AUTO${separator}`}</Text>}
            {truncateWidth(hint, width - 2 - autoBadge.length)}
          </Text>
        ) : (
          <Text color={theme.colors.muted}>
            {' '}
            {autoMode && <Text color={theme.colors.success} bold>{`AUTO${separator}`}</Text>}
            {truncateWidth(left.join(separator), leftBudget)}
            {separator}
            <Text color={pressureColor}>{contextLabel}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
