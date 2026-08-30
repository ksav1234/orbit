import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import {
  ORBIT_RING,
  TAGLINE,
  BYLINE,
  currentUserName,
  greeting,
  selectLogo,
  type LayoutSize,
} from '../theme.js';
import { shortenPath } from '../../util/paths.js';
import { formatCount, truncateWidth } from '../../util/format.js';

export interface BannerModelInfo {
  model: string;
  provider: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface HeaderInfo {
  model: string;
  provider: string;
  workspace: string;
  session: string;
  workspaceSummary?: string;
  warnings?: string[];
}

export interface BannerProps extends HeaderInfo {
  columns: number;
  layout: LayoutSize;
  /** Capability detail shown next to the model. */
  modelInfo?: BannerModelInfo;
  version?: string;
  autoMode?: boolean;
  /** Overridable so the banner is deterministic under test. */
  userName?: string;
  now?: Date;
  /** Lifetime token usage, when it is worth showing. */
  usageSummary?: string;
}

/**
 * The launch screen: wordmark, a welcome, and everything the user needs to know
 * about the session they are about to start — which model, which provider, what
 * it can do, and where it is allowed to work.
 */
export function Banner({
  columns,
  layout,
  model,
  provider,
  workspace,
  session,
  workspaceSummary,
  warnings = [],
  modelInfo,
  version,
  autoMode = false,
  userName,
  now,
  usageSummary,
}: BannerProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.min(columns - 2, 76);
  const rule = theme.symbols.divider.repeat(Math.max(10, width));

  const logo = selectLogo({ columns, unicode: theme.unicode, narrow: layout === 'narrow' });
  const showRing = layout !== 'narrow' && logo.lines.length > 1;
  const person = userName ?? currentUserName();

  const capabilities: string[] = [];
  if (modelInfo) {
    capabilities.push(modelInfo.supportsTools ? 'tools' : 'tools (text protocol)');
    if (modelInfo.supportsVision) capabilities.push('vision');
    capabilities.push(`${formatCount(modelInfo.contextWindow)} ctx`);
  }

  const rows: Array<[string, string, string?]> = [
    ['Model', model, capabilities.join(` ${theme.symbols.dot} `)],
    ['Provider', provider],
    ['Workspace', shortenPath(workspace, Math.max(20, width - 16))],
    ['Session', session],
  ];
  if (workspaceSummary) rows.push(['Detected', workspaceSummary]);
  if (usageSummary) rows.push(['Tokens', usageSummary]);
  rows.push(['Auto mode', autoMode ? 'on' : 'off', autoMode ? undefined : 'ctrl+shift+a to toggle']);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Wordmark, swept through the palette line by line. */}
      <Box flexDirection="column">
        {logo.lines.map((line, index) => (
          <Text
            key={index}
            color={theme.gradient[index % theme.gradient.length] ?? theme.colors.primary}
            bold
          >
            {truncateWidth(line, columns - 1)}
          </Text>
        ))}
      </Box>

      {showRing && (
        <Box marginTop={0}>
          <Text color={theme.colors.accent} dimColor>
            {'  '}
            {truncateWidth(theme.unicode ? ORBIT_RING.unicode : ORBIT_RING.ascii, columns - 3)}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.colors.muted}>{'  '}{truncateWidth(TAGLINE, columns - 4)}</Text>
          {version && layout === 'wide' && (
            <Text color={theme.colors.border}>{`   v${version}`}</Text>
          )}
        </Box>
        <Text color={theme.colors.accent} dimColor>
          {'  '}
          {BYLINE}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.colors.border}>{rule}</Text>
      </Box>

      {/* Welcome line. */}
      <Box marginTop={1} marginBottom={1}>
        <Text color={theme.colors.primary}>{'  '}{greeting(now)}, </Text>
        <Text color={theme.colors.accent} bold>
          {truncateWidth(person, 24)}
        </Text>
        <Text color={theme.colors.muted}>
          {layout === 'narrow' ? '.' : ` ${theme.symbols.dot} ready when you are.`}
        </Text>
      </Box>

      {/* Session facts. */}
      <Box flexDirection="column" marginBottom={1}>
        {rows.map(([label, value, hint]) => (
          <Box key={label}>
            <Text color={theme.colors.muted}>{'  '}</Text>
            <Box width={12}>
              <Text color={theme.colors.muted}>{label}</Text>
            </Box>
            <Text color={theme.colors.text}>
              {truncateWidth(value, Math.max(12, width - 16 - (hint ? 0 : 0)))}
            </Text>
            {hint && layout !== 'narrow' && (
              <Text color={theme.colors.border}>{`  ${truncateWidth(hint, 34)}`}</Text>
            )}
          </Box>
        ))}
      </Box>

      {warnings.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {warnings.map((warning, index) => (
            <Text key={index} color={theme.colors.warning}>
              {'  '}
              {theme.symbols.warning} {truncateWidth(warning, columns - 5)}
            </Text>
          ))}
        </Box>
      )}

      <Text color={theme.colors.border}>{rule}</Text>

      <Box marginTop={1}>
        <Text color={theme.colors.border}>
          {'  '}
          {truncateWidth(
            layout === 'narrow'
              ? '/help for commands'
              : `/help for commands ${theme.symbols.dot} /auto or ctrl+shift+a for auto mode ${theme.symbols.dot} ctrl+c to cancel`,
            columns - 4,
          )}
        </Text>
      </Box>
    </Box>
  );
}

export interface HeaderBarProps extends HeaderInfo {
  columns: number;
  layout: LayoutSize;
  autoMode?: boolean;
}

/** Slim boxed bar used when the banner is disabled or after a screen clear. */
export function HeaderBar({
  columns,
  layout,
  model,
  provider,
  workspace,
  autoMode = false,
}: HeaderBarProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.min(columns - 1, 100);
  const inner = width - 2;

  const line =
    layout === 'narrow'
      ? [model, shortenPath(workspace, inner - 2)]
      : [
          `${model} ${theme.symbols.dot} ${provider} ${theme.symbols.dot} ${shortenPath(workspace, 34)}${autoMode ? ` ${theme.symbols.dot} AUTO` : ''}`,
        ];

  const title = ' Orbit ';
  const top =
    theme.symbols.topLeft +
    theme.symbols.horizontal +
    title +
    theme.symbols.horizontal.repeat(Math.max(0, inner - title.length - 1)) +
    theme.symbols.topRight;
  const bottom =
    theme.symbols.bottomLeft + theme.symbols.horizontal.repeat(inner) + theme.symbols.bottomRight;

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.border}>{top}</Text>
      {line.map((text, index) => (
        <Box key={index}>
          <Text color={theme.colors.border}>{theme.symbols.vertical}</Text>
          <Text color={theme.colors.muted}> {truncateWidth(text, inner - 2)}</Text>
        </Box>
      ))}
      <Text color={theme.colors.border}>{bottom}</Text>
    </Box>
  );
}
