import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import { formatCount, truncateWidth } from '../../util/format.js';

export interface UserMessageProps {
  text: string;
  columns: number;
  attachments?: string[];
}

export function UserMessage({ text, columns, attachments = [] }: UserMessageProps): React.ReactElement {
  const theme = useTheme();
  const lines = text.split('\n');

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, index) => (
        <Box key={index}>
          <Text color={theme.colors.primary} bold>
            {index === 0 ? `${theme.symbols.prompt} ` : '  '}
          </Text>
          <Text color={theme.colors.text}>{line}</Text>
        </Box>
      ))}
      {attachments.map((attachment) => (
        <Box key={attachment} marginLeft={2}>
          <Text color={theme.colors.muted}>{`${theme.symbols.dot} ${attachment}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

export interface AssistantMessageProps {
  text: string;
  columns: number;
  /** Streaming messages get a trailing cursor. */
  streaming?: boolean;
}

export function AssistantMessage({
  text,
  columns,
  streaming = false,
}: AssistantMessageProps): React.ReactElement | null {
  const theme = useTheme();
  if (!text.trim() && !streaming) return null;

  return (
    <Box flexDirection="column" marginBottom={streaming ? 0 : 1}>
      <Markdown text={text} columns={columns} />
      {streaming && <Text color={theme.colors.muted}>{theme.symbols.pending}</Text>}
    </Box>
  );
}

export interface ReasoningProps {
  text: string;
  columns: number;
  /** Live estimate of what the thinking has cost so far, in tokens. */
  tokens?: number;
}

/**
 * Reasoning traces are dimmed and clipped: context, not content.
 *
 * The token count beside it is what a long think is actually costing. While the
 * stream is open the provider has not billed yet, so the figure is Orbit's own
 * estimate of the text received so far and is marked `~`; the provider's real
 * number replaces it once the request completes.
 */
export function ReasoningTrace({
  text,
  columns,
  tokens,
}: ReasoningProps): React.ReactElement | null {
  const theme = useTheme();
  if (!text.trim()) return null;
  const lines = text.trim().split('\n').slice(-3);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {tokens !== undefined && tokens > 0 && (
        <Text color={theme.colors.muted} dimColor>
          {`thinking ${theme.symbols.dot} ~${formatCount(tokens)} tokens`}
        </Text>
      )}
      {lines.map((line, index) => (
        <Text key={index} color={theme.colors.muted} dimColor italic>
          {truncateWidth(line, columns - 2)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * What one model request cost, printed into the transcript after it finishes.
 *
 * These are the provider's own numbers rather than an estimate, so the line
 * appears only for providers that report usage, and `thinking` only for the
 * ones that separate reasoning out.
 */
export function RequestCost({
  promptTokens,
  completionTokens,
  reasoningTokens,
  cachedTokens,
  window: contextWindow,
  used,
  durationMs,
}: {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  window?: number;
  used?: number;
  durationMs?: number;
}): React.ReactElement | null {
  const theme = useTheme();
  if (promptTokens === 0 && completionTokens === 0) return null;

  const parts = [`up ${formatCount(promptTokens)}`, `down ${formatCount(completionTokens)}`];
  if (reasoningTokens) parts.push(`${formatCount(reasoningTokens)} thinking`);
  if (cachedTokens) parts.push(`${formatCount(cachedTokens)} cached`);
  if (used !== undefined && contextWindow) {
    parts.push(`${formatCount(used)}/${formatCount(contextWindow)} ctx`);
  }
  if (durationMs !== undefined && durationMs > 0) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }

  return (
    <Box marginBottom={1}>
      <Text color={theme.colors.muted} dimColor>
        {`  ${parts.join(`  ${theme.symbols.dot}  `)}`}
      </Text>
    </Box>
  );
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

export function Notice({
  text,
  tone = 'info',
  columns,
}: {
  text: string;
  tone?: NoticeTone;
  columns: number;
}): React.ReactElement {
  const theme = useTheme();
  const color =
    tone === 'success'
      ? theme.colors.success
      : tone === 'warning'
        ? theme.colors.warning
        : tone === 'danger'
          ? theme.colors.danger
          : theme.colors.muted;
  const glyph =
    tone === 'success'
      ? theme.symbols.success
      : tone === 'warning' || tone === 'danger'
        ? theme.symbols.warning
        : theme.symbols.dot;

  return (
    <Box marginBottom={1}>
      <Text color={color}>
        {glyph} {truncateWidth(text, columns - 3)}
      </Text>
    </Box>
  );
}

// ── minimal markdown ───────────────────────────────────────────────────────

interface MarkdownProps {
  text: string;
  columns: number;
}

/**
 * A deliberately small markdown renderer: fenced code, inline code, bold,
 * italics, headings and lists. Anything else is passed through unchanged,
 * which is the right default for terminal output.
 */
export function Markdown({ text, columns }: MarkdownProps): React.ReactElement {
  const theme = useTheme();
  const blocks = splitFences(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) =>
        block.type === 'code' ? (
          <Box key={index} flexDirection="column" marginY={1} marginLeft={2}>
            {block.language && (
              <Text color={theme.colors.border}>{block.language}</Text>
            )}
            {block.content.split('\n').map((line, lineIndex) => (
              <Text key={lineIndex} color={theme.colors.primary}>
                {truncateWidth(line, columns - 4)}
              </Text>
            ))}
          </Box>
        ) : (
          <Box key={index} flexDirection="column">
            {block.content.split('\n').map((line, lineIndex) => (
              <MarkdownLine key={lineIndex} line={line} columns={columns} />
            ))}
          </Box>
        ),
      )}
    </Box>
  );
}

function MarkdownLine({ line, columns }: { line: string; columns: number }): React.ReactElement {
  const theme = useTheme();

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return (
      <Text color={theme.colors.primary} bold>
        {heading[2]}
      </Text>
    );
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) {
    return (
      <Box>
        <Text color={theme.colors.muted}>{`${bullet[1] ?? ''}${theme.symbols.dot} `}</Text>
        <Text>{renderInline(line.replace(/^(\s*)[-*+]\s+/, ''), theme.colors)}</Text>
      </Box>
    );
  }

  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (numbered) {
    return (
      <Box>
        <Text color={theme.colors.muted}>{`${numbered[1] ?? ''}${numbered[2]}. `}</Text>
        <Text>{renderInline(numbered[3] ?? '', theme.colors)}</Text>
      </Box>
    );
  }

  if (!line.trim()) return <Text> </Text>;

  return <Text>{renderInline(line, theme.colors)}</Text>;
}

interface Block {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

export function splitFences(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let buffer: string[] = [];
  let inCode = false;
  let language = '';

  const flush = (type: 'text' | 'code') => {
    if (buffer.length === 0) return;
    const content = buffer.join('\n');
    if (content.trim() || type === 'code') {
      blocks.push(type === 'code' ? { type, content, language } : { type, content });
    }
    buffer = [];
  };

  for (const line of lines) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        flush('code');
        inCode = false;
        language = '';
      } else {
        flush('text');
        inCode = true;
        language = fence[1] ?? '';
      }
      continue;
    }
    buffer.push(line);
  }
  flush(inCode ? 'code' : 'text');

  return blocks;
}

/** Inline formatting: `code`, **bold**, *italic*. */
export function renderInline(
  line: string,
  colors: { primary: string; text: string },
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let lastIndex = 0;
  let key = 0;

  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(line.slice(lastIndex, index));

    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <Text key={key++} color={colors.primary}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <Text key={key++} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={key++} italic>
          {token.slice(1, -1)}
        </Text>,
      );
    }
    lastIndex = index + token.length;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
}
