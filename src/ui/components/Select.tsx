import React, { useMemo, useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import { useBufferedInput } from '../input-buffer.js';
import { useTheme } from '../context.js';
import { truncateWidth } from '../../util/format.js';

export interface SelectOption<T> {
  value: T;
  label: string;
  description?: string;
  /** Rendered dim on the right, e.g. a key status or context size. */
  badge?: string;
  /** Marks the current choice. */
  current?: boolean;
}

export interface SelectPromptProps<T> {
  title: string;
  options: Array<SelectOption<T>>;
  columns: number;
  onSelect: (value: T) => void;
  onCancel: () => void;
  /** Shown under the title. */
  hint?: string;
  /** Rows visible at once before the list scrolls. */
  pageSize?: number;
  /** Allow typing to narrow a long list. Enabled above this many options. */
  filterThreshold?: number;
}

/**
 * A keyboard-driven picker.
 *
 * Long lists are the normal case here — OpenRouter alone exposes hundreds of
 * models — so it filters as you type and scrolls a window rather than dumping
 * everything on screen.
 */
export function SelectPrompt<T>({
  title,
  options,
  columns,
  onSelect,
  onCancel,
  hint,
  pageSize = 10,
  filterThreshold = 8,
}: SelectPromptProps<T>): React.ReactElement {
  const theme = useTheme();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // Refs, not state: keystrokes can arrive faster than React re-renders.
  const query = useRef('');
  const index = useRef(Math.max(0, options.findIndex((option) => option.current)));

  const filterable = options.length > filterThreshold;

  const visible = useMemo(() => {
    const needle = query.current.toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.description?.toLowerCase().includes(needle),
    );
    // `query` is a ref, so re-filtering is driven by forceRender below.
  }, [options, query.current]);

  const clamp = (value: number): number =>
    visible.length === 0 ? 0 : Math.max(0, Math.min(value, visible.length - 1));

  useBufferedInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const choice = visible[clamp(index.current)];
      if (choice) onSelect(choice.value);
      else onCancel();
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      index.current = clamp(index.current - 1);
      forceRender();
      return;
    }
    if (key.downArrow || key.tab || (key.ctrl && input === 'n')) {
      index.current = clamp(index.current + 1);
      forceRender();
      return;
    }
    if (key.pageUp) {
      index.current = clamp(index.current - pageSize);
      forceRender();
      return;
    }
    if (key.pageDown) {
      index.current = clamp(index.current + pageSize);
      forceRender();
      return;
    }

    // A number key jumps straight to that row, which is the fastest path for
    // a short list.
    if (!filterable && /^[1-9]$/.test(input)) {
      const target = Number(input) - 1;
      const choice = visible[target];
      if (choice) {
        onSelect(choice.value);
        return;
      }
    }

    if (!filterable) return;

    if (key.backspace || key.delete) {
      query.current = query.current.slice(0, -1);
      index.current = 0;
      forceRender();
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      query.current += input.replace(/[\r\n]/g, '');
      index.current = 0;
      forceRender();
    }
  });

  const selected = clamp(index.current);
  // Scroll the window so the cursor stays inside it.
  const start = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), visible.length - pageSize));
  const page = visible.slice(Math.max(0, start), Math.max(0, start) + pageSize);
  const width = Math.max(24, Math.min(columns - 4, 90));

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={theme.colors.primary} bold>
          {title}
        </Text>
        {hint && <Text color={theme.colors.border}>{`  ${truncateWidth(hint, width - title.length - 4)}`}</Text>}
      </Box>

      {filterable && (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>{'  filter '}</Text>
          <Text color={theme.colors.text}>{query.current}</Text>
          <Text inverse> </Text>
          <Text color={theme.colors.border}>
            {`  ${visible.length} of ${options.length}`}
          </Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={theme.colors.warning}>{'  nothing matches that filter'}</Text>
        ) : (
          page.map((option, offset) => {
            const position = Math.max(0, start) + offset;
            const active = position === selected;
            return (
              <Box key={`${option.label}-${position}`}>
                <Text color={active ? theme.colors.primary : theme.colors.border}>
                  {active ? ` ${theme.symbols.arrow} ` : '   '}
                </Text>
                <Text
                  color={active ? theme.colors.text : theme.colors.muted}
                  bold={active}
                >
                  {option.current ? `${theme.symbols.bullet} ` : '  '}
                  {truncateWidth(option.label, Math.max(12, width - 30))}
                </Text>
                {option.badge && (
                  <Text color={theme.colors.border}>{`  ${truncateWidth(option.badge, 26)}`}</Text>
                )}
                {!option.badge && option.description && (
                  <Text color={theme.colors.border}>
                    {`  ${truncateWidth(option.description, 26)}`}
                  </Text>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {visible.length > page.length && (
        <Text color={theme.colors.border}>
          {`   … ${visible.length - page.length} more`}
        </Text>
      )}

      <Box marginTop={1}>
        <Text color={theme.colors.border}>
          {filterable
            ? '   ↑↓ move · type to filter · enter select · esc cancel'
            : '   ↑↓ move · 1-9 jump · enter select · esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}

export interface SecretPromptProps {
  title: string;
  columns: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  hint?: string;
}

/**
 * Masked single-line input for API keys. The value is never rendered, only its
 * length, so a key cannot end up in a screenshot or scrollback.
 */
export function SecretPrompt({
  title,
  columns,
  onSubmit,
  onCancel,
  hint,
}: SecretPromptProps): React.ReactElement {
  const theme = useTheme();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const value = useRef('');

  useBufferedInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const text = value.current.trim();
      if (text) onSubmit(text);
      else onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      value.current = value.current.slice(0, -1);
      forceRender();
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      value.current += input.replace(/[\r\n]/g, '');
      forceRender();
    }
  });

  const width = Math.max(24, Math.min(columns - 4, 80));

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.colors.primary} bold>
        {title}
      </Text>
      {hint && (
        <Text color={theme.colors.border}>{`  ${truncateWidth(hint, width - 2)}`}</Text>
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>{'  '}</Text>
        <Text color={theme.colors.text}>
          {'•'.repeat(Math.min(value.current.length, width - 10))}
        </Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.border}>
          {'  enter to save · esc to cancel · input is hidden and stored 0600'}
        </Text>
      </Box>
    </Box>
  );
}
