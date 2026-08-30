import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import { Spinner, StatusGlyph } from './Spinner.js';
import { DiffView } from './DiffView.js';
import type { ToolResult } from '../../tools/registry.js';
import { oneLine, truncateWidth } from '../../util/format.js';

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied';

export interface ToolCallViewProps {
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: ToolResult;
  progress?: string;
  durationMs?: number;
  columns: number;
  startedAt?: number;
  /** Show the full captured output instead of the clipped preview. */
  expanded?: boolean;
  deniedReason?: string;
}

/**
 * One tool invocation in the transcript. The rendering is driven entirely by
 * the real ToolResult, so what the user sees is what actually happened.
 */
export function ToolCallView({
  name,
  args,
  status,
  result,
  progress,
  durationMs,
  columns,
  startedAt,
  expanded = false,
  deniedReason,
}: ToolCallViewProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(20, columns - 4);
  const argLine = describeToolArgs(name, args);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {status === 'running' ? (
          <Spinner label={undefined} startedAt={startedAt} />
        ) : (
          <StatusGlyph state={status === 'ok' ? 'ok' : status === 'denied' ? 'warn' : 'error'} />
        )}
        <Text> </Text>
        <Text color={theme.colors.accent} bold>
          {name}
        </Text>
        {durationMs !== undefined && durationMs > 1000 && (
          <Text color={theme.colors.muted}>{` ${(durationMs / 1000).toFixed(1)}s`}</Text>
        )}
      </Box>

      {argLine && (
        <Box marginLeft={2}>
          <Text color={theme.colors.muted}>{truncateWidth(argLine, width)}</Text>
        </Box>
      )}

      {status === 'running' && progress && (
        <Box marginLeft={2}>
          <Text color={theme.colors.muted}>{truncateWidth(progress, width)}</Text>
        </Box>
      )}

      {status === 'denied' && (
        <Box marginLeft={2}>
          <Text color={theme.colors.warning}>
            {truncateWidth(deniedReason ?? 'Denied by the user.', width)}
          </Text>
        </Box>
      )}

      {result && status !== 'running' && status !== 'denied' && (
        <ToolResultView result={result} columns={columns} expanded={expanded} />
      )}
    </Box>
  );
}

function ToolResultView({
  result,
  columns,
  expanded,
}: {
  result: ToolResult;
  columns: number;
  expanded: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(20, columns - 6);
  const { display } = result;

  if (!result.ok) {
    return (
      <Box marginLeft={2}>
        <Text color={theme.colors.danger}>{truncateWidth(result.error ?? display.summary, width)}</Text>
      </Box>
    );
  }

  if (display.kind === 'diff' && display.detail) {
    return <DiffView patch={display.detail} columns={columns} maxLines={expanded ? 400 : 24} indent={2} />;
  }

  const lines = expanded && display.detail ? display.detail.split('\n') : (display.lines ?? []);
  const shown = expanded ? lines.slice(0, 400) : lines.slice(0, 12);
  const hidden = expanded
    ? Math.max(0, lines.length - shown.length)
    : (display.hiddenLines ?? Math.max(0, lines.length - shown.length));

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={theme.colors.muted}>{truncateWidth(display.summary, width)}</Text>
      {shown.map((line, index) => (
        <Text key={index} color={theme.colors.text} dimColor>
          {truncateWidth(`  ${line}`, width)}
        </Text>
      ))}
      {hidden > 0 && (
        <Text color={theme.colors.muted}>
          {`  … ${hidden} lines hidden `}
          <Text color={theme.colors.border}>{'(ctrl+o to expand)'}</Text>
        </Text>
      )}
    </Box>
  );
}

/**
 * Compact one-line argument summary. Shows the argument that matters for each
 * tool rather than dumping JSON at the user.
 */
export function describeToolArgs(name: string, args: Record<string, unknown>): string {
  const get = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
  };

  switch (name) {
    case 'read_file':
    case 'list_files':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'read_pdf':
    case 'read_image':
      return get('path') ?? '';
    case 'move_file':
      return `${get('source') ?? ''} -> ${get('destination') ?? ''}`;
    case 'search_files':
      return `${get('query') ?? ''}${args.glob ? `  in ${String(args.glob)}` : ''}`;
    case 'find_files':
      return get('pattern') ?? '';
    case 'execute_command':
      return `$ ${get('command') ?? ''}`;
    case 'git_diff':
      return args.staged ? 'staged' : '';
    case 'git_log':
      return args.limit ? `${String(args.limit)} commits` : '';
    case 'update_plan':
      return '';
    default: {
      const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== false);
      if (entries.length === 0) return '';
      return oneLine(
        entries
          .slice(0, 3)
          .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
          .join(', '),
      );
    }
  }
}
