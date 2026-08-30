import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import type { OrbitError } from '../../util/errors.js';
import { truncateWidth } from '../../util/format.js';

export interface ErrorAction {
  key: string;
  label: string;
}

export interface ErrorBoxProps {
  error: OrbitError;
  columns: number;
  actions?: ErrorAction[];
  /** Show the raw detail. Enabled by `orbit --debug`. */
  debug?: boolean;
}

/**
 * Human-readable failure. Raw transport codes and stack traces stay in the log
 * file unless the user asked for debug output.
 */
export function ErrorBox({
  error,
  columns,
  actions = [],
  debug = false,
}: ErrorBoxProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.min(columns - 2, 78);
  const inner = width - 2;
  const label = ` ${titleFor(error)} `;

  const top =
    theme.symbols.topLeft +
    theme.symbols.horizontal +
    label +
    theme.symbols.horizontal.repeat(Math.max(0, inner - label.length - 1)) +
    theme.symbols.topRight;
  const bottom =
    theme.symbols.bottomLeft + theme.symbols.horizontal.repeat(inner) + theme.symbols.bottomRight;

  const detailLines = (debug && error.detail ? error.detail : (error.detail ?? ''))
    .split('\n')
    .filter(Boolean)
    .slice(0, debug ? 12 : 3);

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.colors.danger}>{top}</Text>

      <Line theme={theme}>
        <Text color={theme.colors.text}>{truncateWidth(error.message, inner - 3)}</Text>
      </Line>

      {detailLines.length > 0 && (
        <>
          <Line theme={theme} />
          {detailLines.map((line, index) => (
            <Line key={index} theme={theme}>
              <Text color={theme.colors.muted}>{truncateWidth(line, inner - 3)}</Text>
            </Line>
          ))}
        </>
      )}

      {error.hints.length > 0 && (
        <>
          <Line theme={theme} />
          {error.hints.map((hint, index) => (
            <Line key={index} theme={theme}>
              <Text color={theme.colors.muted}>
                {theme.symbols.arrow} {truncateWidth(hint, inner - 5)}
              </Text>
            </Line>
          ))}
        </>
      )}

      {actions.length > 0 && (
        <>
          <Line theme={theme} />
          <Line theme={theme}>
            <Text>
              {actions.map((action) => (
                <Text key={action.key}>
                  <Text color={theme.colors.primary} bold>
                    [{action.key}]
                  </Text>
                  <Text color={theme.colors.text}>{` ${action.label}   `}</Text>
                </Text>
              ))}
            </Text>
          </Line>
        </>
      )}

      <Text color={theme.colors.danger}>{bottom}</Text>
    </Box>
  );
}

function Line({
  theme,
  children,
}: {
  theme: ReturnType<typeof useTheme>;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text color={theme.colors.border}>{theme.symbols.vertical} </Text>
      {children ?? <Text> </Text>}
    </Box>
  );
}

function titleFor(error: OrbitError): string {
  switch (error.kind) {
    case 'auth':
      return 'Authentication Error';
    case 'network':
      return 'Network Error';
    case 'rate-limit':
      return 'Rate Limited';
    case 'provider':
      return 'Provider Error';
    case 'permission':
      return 'Permission Denied';
    case 'sandbox':
      return 'Workspace Boundary';
    case 'config':
      return 'Configuration Error';
    case 'tool':
      return 'Tool Error';
    case 'context':
      return 'Context Error';
    default:
      return 'Error';
  }
}
