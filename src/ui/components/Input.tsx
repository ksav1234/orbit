import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import { useBufferedInput } from '../input-buffer.js';
import { useTheme } from '../context.js';
import type { Completion, CompletionResult, InputHistory } from '../../cli/input.js';
import { commonPrefix } from '../../cli/input.js';
import { truncateWidth } from '../../util/format.js';

export interface PromptInputProps {
  columns: number;
  history: InputHistory;
  placeholder?: string;
  disabled?: boolean;
  onSubmit: (value: string) => void;
  /** Fired on Escape with an empty buffer. */
  onEscape?: () => void;
  complete?: (text: string, cursor: number) => Promise<CompletionResult | null>;
  /** Live feedback about the buffer, e.g. detected attachments. */
  hint?: string;
}

const MAX_SUGGESTIONS = 8;

/**
 * The prompt line.
 *
 * The buffer lives in refs rather than state: keystrokes can arrive faster than
 * React re-renders (paste, or a script driving the terminal), and a handler
 * closing over stale state would drop them.
 */
export function PromptInput({
  columns,
  history,
  placeholder = 'What would you like to build?',
  disabled = false,
  onSubmit,
  onEscape,
  complete,
  hint,
}: PromptInputProps): React.ReactElement {
  const theme = useTheme();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  const value = useRef('');
  const cursor = useRef(0);
  const suggestions = useRef<CompletionResult | null>(null);
  const selected = useRef(0);
  const completionToken = useRef(0);

  const setBuffer = useCallback(
    (text: string, position = text.length) => {
      value.current = text;
      cursor.current = Math.max(0, Math.min(position, text.length));
      forceRender();
    },
    [],
  );

  const clearSuggestions = useCallback(() => {
    if (suggestions.current === null && selected.current === 0) return;
    suggestions.current = null;
    selected.current = 0;
    forceRender();
  }, []);

  const applyCompletion = useCallback(
    (result: CompletionResult, item: Completion) => {
      const next = value.current.slice(0, result.start) + item.value + value.current.slice(result.end);
      suggestions.current = null;
      selected.current = 0;
      setBuffer(next, result.start + item.value.length);
    },
    [setBuffer],
  );

  const requestCompletions = useCallback(async () => {
    if (!complete) return;
    const token = ++completionToken.current;
    const result = await complete(value.current, cursor.current);
    if (token !== completionToken.current) return;

    if (!result || result.items.length === 0) {
      clearSuggestions();
      return;
    }
    if (result.items.length === 1) {
      applyCompletion(result, result.items[0]!);
      return;
    }

    // Fill in the unambiguous part, then show the remaining choices.
    const shared = commonPrefix(result.items.map((item) => item.value));
    const current = value.current.slice(result.start, result.end);
    selected.current = 0;
    if (shared.length > current.length) {
      const next = value.current.slice(0, result.start) + shared + value.current.slice(result.end);
      suggestions.current = { ...result, end: result.start + shared.length };
      setBuffer(next, result.start + shared.length);
    } else {
      suggestions.current = result;
      forceRender();
    }
  }, [complete, applyCompletion, clearSuggestions, setBuffer]);

  useEffect(() => {
    if (disabled) clearSuggestions();
  }, [disabled, clearSuggestions]);

  useBufferedInput(
    (input, key) => {
      if (disabled) return;

      const text = value.current;
      const at = cursor.current;
      const insert = (fragment: string): void => {
        clearSuggestionsQuietly();
        setBuffer(text.slice(0, at) + fragment + text.slice(at), at + fragment.length);
      };
      const clearSuggestionsQuietly = (): void => {
        suggestions.current = null;
        selected.current = 0;
      };

      // ── completion navigation ──
      const active = suggestions.current;
      if (active) {
        if (key.escape) {
          clearSuggestions();
          return;
        }
        if (key.tab || key.downArrow) {
          selected.current = (selected.current + 1) % active.items.length;
          forceRender();
          return;
        }
        if (key.upArrow) {
          selected.current = (selected.current - 1 + active.items.length) % active.items.length;
          forceRender();
          return;
        }
        if (key.return) {
          const item = active.items[selected.current];
          if (item) applyCompletion(active, item);
          return;
        }
      }

      if (key.tab) {
        void requestCompletions();
        return;
      }

      // ── submission and newlines ──
      if (key.return) {
        // Shift/Alt+Enter inserts a newline where the terminal reports it;
        // a trailing backslash is the portable fallback.
        if (key.shift || key.meta) {
          insert('\n');
          return;
        }
        if (text.endsWith('\\')) {
          setBuffer(text.slice(0, -1) + '\n');
          return;
        }
        const trimmed = text.trim();
        if (!trimmed) return;
        history.add(trimmed);
        clearSuggestionsQuietly();
        setBuffer('', 0);
        onSubmit(trimmed);
        return;
      }

      if (key.ctrl && input === 'j') {
        insert('\n');
        return;
      }

      if (key.escape) {
        if (text) setBuffer('', 0);
        else onEscape?.();
        return;
      }

      // ── editing ──
      if (key.backspace) {
        if (at > 0) setBuffer(text.slice(0, at - 1) + text.slice(at), at - 1);
        return;
      }
      if (key.delete) {
        // Some terminals send DEL for backspace; treat it as a forward delete
        // only when there is text ahead of the cursor.
        if (at < text.length) setBuffer(text.slice(0, at) + text.slice(at + 1), at);
        else if (at > 0) setBuffer(text.slice(0, at - 1) + text.slice(at), at - 1);
        return;
      }

      // Ctrl+Shift+A is the auto-mode toggle, handled globally.
      if (key.ctrl && input === 'a' && !key.shift) {
        setBuffer(text, lineStart(text, at));
        return;
      }
      if (key.ctrl && input === 'e') {
        setBuffer(text, lineEnd(text, at));
        return;
      }
      if (key.ctrl && input === 'u') {
        const start = lineStart(text, at);
        setBuffer(text.slice(0, start) + text.slice(at), start);
        return;
      }
      if (key.ctrl && input === 'k') {
        setBuffer(text.slice(0, at) + text.slice(lineEnd(text, at)), at);
        return;
      }
      if (key.ctrl && input === 'w') {
        const start = wordStart(text, at);
        setBuffer(text.slice(0, start) + text.slice(at), start);
        return;
      }

      // ── movement ──
      if (key.leftArrow) {
        setBuffer(text, key.meta || key.ctrl ? wordStart(text, at) : Math.max(0, at - 1));
        return;
      }
      if (key.rightArrow) {
        setBuffer(text, key.meta || key.ctrl ? wordEnd(text, at) : Math.min(text.length, at + 1));
        return;
      }

      // ── history ──
      if (key.upArrow) {
        if (text.includes('\n') && at > lineStart(text, at)) {
          setBuffer(text, Math.max(0, lineStart(text, at) - 1));
          return;
        }
        const previous = history.previous(text);
        if (previous !== null) setBuffer(previous);
        return;
      }
      if (key.downArrow) {
        const next = history.next();
        if (next !== null) setBuffer(next);
        return;
      }

      // ── printable input ──
      // A chunk containing newlines is a paste: keep the text, drop the CRs.
      if (input && !key.ctrl && !key.meta) {
        insert(input.replace(/\r\n?/g, '\n'));
      }
    },
    { isActive: !disabled },
  );

  const text = value.current;
  const lines = text.split('\n');
  const width = Math.max(20, columns - 3);
  const active = suggestions.current;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {text.length === 0 ? (
          <Box>
            <Text color={theme.colors.primary} bold>
              {theme.symbols.prompt}{' '}
            </Text>
            <Text color={theme.colors.border}>{truncateWidth(placeholder, width)}</Text>
          </Box>
        ) : (
          lines.map((line, index) => (
            <Box key={index}>
              <Text color={theme.colors.primary} bold>
                {index === 0 ? `${theme.symbols.prompt} ` : '  '}
              </Text>
              <RenderedLine
                line={line}
                cursorIndex={cursorForLine(text, cursor.current, index)}
                width={width}
                showCursor={!disabled}
              />
            </Box>
          ))
        )}
      </Box>

      {hint && (
        <Box marginLeft={2}>
          <Text color={theme.colors.muted}>{truncateWidth(hint, width)}</Text>
        </Box>
      )}

      {active && (
        <Box flexDirection="column" marginLeft={2}>
          {active.items.slice(0, MAX_SUGGESTIONS).map((item, index) => (
            <Box key={item.value}>
              <Text
                color={index === selected.current ? theme.colors.primary : theme.colors.muted}
                bold={index === selected.current}
              >
                {index === selected.current
                  ? theme.symbols.arrow
                  : ' '.repeat(theme.symbols.arrow.length)}{' '}
                {truncateWidth(item.label, 32)}
              </Text>
              {item.description && (
                <Text color={theme.colors.border}>
                  {'  '}
                  {truncateWidth(item.description, Math.max(10, width - 40))}
                </Text>
              )}
            </Box>
          ))}
          {active.items.length > MAX_SUGGESTIONS && (
            <Text color={theme.colors.border}>
              {`  … ${active.items.length - MAX_SUGGESTIONS} more`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function RenderedLine({
  line,
  cursorIndex,
  width,
  showCursor,
}: {
  line: string;
  cursorIndex: number | null;
  width: number;
  showCursor: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const clipped = truncateWidth(line, width);

  if (cursorIndex === null || !showCursor) {
    return <Text color={theme.colors.text}>{clipped}</Text>;
  }

  const before = line.slice(0, cursorIndex);
  const at = line.slice(cursorIndex, cursorIndex + 1) || ' ';
  const after = line.slice(cursorIndex + 1);

  return (
    <Text color={theme.colors.text}>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

/** Column of the cursor within a given rendered line, or null if elsewhere. */
function cursorForLine(value: string, cursor: number, lineIndex: number): number | null {
  const lines = value.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const length = lines[i]!.length;
    if (i === lineIndex) {
      if (cursor >= offset && cursor <= offset + length) return cursor - offset;
      return null;
    }
    offset += length + 1;
  }
  return null;
}

function lineStart(value: string, cursor: number): number {
  const index = value.lastIndexOf('\n', Math.max(0, cursor - 1));
  return index === -1 ? 0 : index + 1;
}

function lineEnd(value: string, cursor: number): number {
  const index = value.indexOf('\n', cursor);
  return index === -1 ? value.length : index;
}

function wordStart(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(value[index - 1] ?? '')) index--;
  while (index > 0 && !/\s/.test(value[index - 1] ?? '')) index--;
  return index;
}

function wordEnd(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && /\s/.test(value[index] ?? '')) index++;
  while (index < value.length && !/\s/.test(value[index] ?? '')) index++;
  return index;
}
