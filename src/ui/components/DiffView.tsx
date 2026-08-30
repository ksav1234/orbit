import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import { diffBody, parsePatch, type DiffLine } from '../../util/diff.js';
import { truncateWidth } from '../../util/format.js';

export interface DiffViewProps {
  patch: string;
  columns: number;
  /** Lines to render before collapsing the rest. */
  maxLines?: number;
  /** Prefix each line with the file path header. */
  title?: string;
  indent?: number;
}

/**
 * Render a unified diff. Context lines are dimmed so added and removed lines
 * carry the eye, and long lines are clipped rather than wrapped.
 */
export function DiffView({
  patch,
  columns,
  maxLines = 40,
  title,
  indent = 2,
}: DiffViewProps): React.ReactElement {
  const theme = useTheme();
  const lines = diffBody(parsePatch(patch));
  const width = Math.max(20, columns - indent - 2);

  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;

  return (
    <Box flexDirection="column" marginLeft={indent}>
      {title && (
        <Text color={theme.colors.muted} bold>
          {truncateWidth(title, width)}
        </Text>
      )}
      {visible.map((line, index) => (
        <DiffLineView key={index} line={line} width={width} />
      ))}
      {hidden > 0 && (
        <Text color={theme.colors.muted}>{`… ${hidden} more diff lines`}</Text>
      )}
    </Box>
  );
}

function DiffLineView({ line, width }: { line: DiffLine; width: number }): React.ReactElement {
  const theme = useTheme();

  if (line.type === 'hunk') {
    return <Text color={theme.colors.primary}>{truncateWidth(line.text, width)}</Text>;
  }
  if (line.type === 'add') {
    return (
      <Text color={theme.colors.added}>
        {truncateWidth(`+ ${line.text}`, width)}
      </Text>
    );
  }
  if (line.type === 'remove') {
    return (
      <Text color={theme.colors.removed}>
        {truncateWidth(`- ${line.text}`, width)}
      </Text>
    );
  }
  return (
    <Text color={theme.colors.muted} dimColor>
      {truncateWidth(`  ${line.text}`, width)}
    </Text>
  );
}

/** One-line change summary, e.g. `+12 −3`. */
export function DiffStat({ added, removed }: { added: number; removed: number }): React.ReactElement {
  const theme = useTheme();
  return (
    <Text>
      <Text color={theme.colors.added}>+{added}</Text>
      <Text color={theme.colors.muted}> </Text>
      <Text color={theme.colors.removed}>{theme.unicode ? '−' : '-'}{removed}</Text>
    </Text>
  );
}
