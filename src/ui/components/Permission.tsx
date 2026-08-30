import React, { useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../context.js';
import { DiffView } from './DiffView.js';
import type { PermissionChoice, PermissionRequest } from '../../permissions/manager.js';
import { truncateWidth } from '../../util/format.js';

export interface PermissionPromptProps {
  request: PermissionRequest;
  columns: number;
  /** `instruction` is set only for the `redirect` choice. */
  onDecide: (choice: PermissionChoice, instruction?: string) => void;
}

/**
 * Modal approval prompt. Destructive requests never offer a session-wide grant,
 * so a single keystroke can never widen permission beyond one operation.
 */
export function PermissionPrompt({
  request,
  columns,
  onDecide,
}: PermissionPromptProps): React.ReactElement {
  const theme = useTheme();
  const [showPreview, setShowPreview] = useState(true);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  /**
   * When non-null, the user is typing a replacement instruction. Held in a ref
   * for the same reason the prompt input is: keystrokes can arrive faster than
   * React re-renders, and a stale closure would drop them.
   */
  const instruction = useRef<string | null>(null);
  const width = Math.min(columns - 2, 78);
  const inner = width - 2;

  const allowSession = !request.destructive;

  const setInstruction = (value: string | null): void => {
    instruction.current = value;
    forceRender();
  };

  useInput((input, key) => {
    // Editing mode: capture the instruction, then hand it back as a rejection
    // that tells the model what to do instead.
    const current = instruction.current;
    if (current !== null) {
      if (key.escape) {
        setInstruction(null);
        return;
      }
      if (key.return) {
        const text = current.trim();
        if (text) onDecide('redirect', text);
        else setInstruction(null);
        return;
      }
      if (key.backspace || key.delete) {
        setInstruction(current.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInstruction(current + input.replace(/\r\n?/g, ''));
      }
      return;
    }

    const value = input.toLowerCase();
    if (value === 'y' || key.return) onDecide('once');
    else if (value === 'a' && allowSession) onDecide('session');
    else if (value === 'n' || key.escape) onDecide('deny');
    else if (value === 'e') setInstruction('');
    else if (value === 'd' && request.preview) setShowPreview((v) => !v);
  });

  const editing = instruction.current;

  const heading = request.destructive
    ? `${theme.symbols.warning} Destructive operation`
    : request.sensitive
      ? `${theme.symbols.warning} Sensitive file`
      : 'Permission required';

  const headingColor = request.destructive
    ? theme.colors.danger
    : request.sensitive
      ? theme.colors.warning
      : theme.colors.primary;

  const top =
    theme.symbols.topLeft + theme.symbols.horizontal.repeat(inner) + theme.symbols.topRight;
  const bottom =
    theme.symbols.bottomLeft + theme.symbols.horizontal.repeat(inner) + theme.symbols.bottomRight;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={headingColor}>{top}</Text>

      <Row theme={theme} width={inner}>
        <Text color={headingColor} bold>
          {heading}
        </Text>
      </Row>

      <Row theme={theme} width={inner} />

      <Row theme={theme} width={inner}>
        <Text color={theme.colors.text}>{truncateWidth(request.title, inner - 3)}</Text>
      </Row>

      {request.details && request.details.length > 0 && (
        <>
          <Row theme={theme} width={inner} />
          {request.details.map((detail) => (
            <Row key={detail.label} theme={theme} width={inner}>
              <Text color={theme.colors.muted}>{detail.label.padEnd(11)}</Text>
              <Text color={theme.colors.text}>
                {truncateWidth(detail.value, Math.max(10, inner - 14))}
              </Text>
            </Row>
          ))}
        </>
      )}

      {request.preview && showPreview && (
        <>
          <Row theme={theme} width={inner} />
          {request.previewKind === 'diff' ? (
            <Box flexDirection="column" marginLeft={2}>
              <DiffView patch={request.preview} columns={width} maxLines={20} indent={0} />
            </Box>
          ) : (
            <Box flexDirection="column" marginLeft={2}>
              {request.preview
                .split('\n')
                .slice(0, 12)
                .map((line, index) => (
                  <Text key={index} color={theme.colors.primary}>
                    {truncateWidth(request.previewKind === 'command' ? `$ ${line}` : line, inner - 2)}
                  </Text>
                ))}
            </Box>
          )}
        </>
      )}

      <Row theme={theme} width={inner} />

      {editing !== null ? (
        <>
          <Row theme={theme} width={inner}>
            <Text color={theme.colors.muted}>What should Orbit do instead?</Text>
          </Row>
          <Row theme={theme} width={inner}>
            <Text color={theme.colors.primary} bold>
              {theme.symbols.prompt}{' '}
            </Text>
            <Text color={theme.colors.text}>{truncateWidth(editing, inner - 6)}</Text>
            <Text inverse> </Text>
          </Row>
          <Row theme={theme} width={inner} />
          <Row theme={theme} width={inner}>
            <Text color={theme.colors.border}>
              enter to send · esc to go back
            </Text>
          </Row>
        </>
      ) : (
        <Row theme={theme} width={inner}>
          <Text>
            <Key theme={theme}>Y</Key>
            <Text color={theme.colors.text}>
              {request.destructive ? ' Confirm   ' : ' Allow once   '}
            </Text>
            {allowSession && (
              <>
                <Key theme={theme}>A</Key>
                <Text color={theme.colors.text}> Allow for session   </Text>
              </>
            )}
            <Key theme={theme}>N</Key>
            <Text color={theme.colors.text}> {request.destructive ? 'Cancel' : 'Deny'}   </Text>
            <Key theme={theme}>E</Key>
            <Text color={theme.colors.text}> Edit instruction</Text>
            {request.preview && (
              <>
                <Text color={theme.colors.muted}>{'   '}</Text>
                <Key theme={theme}>D</Key>
                <Text color={theme.colors.text}> {showPreview ? 'Hide' : 'Show'} details</Text>
              </>
            )}
          </Text>
        </Row>
      )}

      <Text color={headingColor}>{bottom}</Text>
    </Box>
  );
}

function Row({
  theme,
  width,
  children,
}: {
  theme: ReturnType<typeof useTheme>;
  width: number;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text color={theme.colors.border}>{theme.symbols.vertical} </Text>
      <Box width={Math.max(1, width - 2)}>{children ?? <Text> </Text>}</Box>
    </Box>
  );
}

function Key({
  theme,
  children,
}: {
  theme: ReturnType<typeof useTheme>;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Text color={theme.colors.primary} bold>
      [{children}]
    </Text>
  );
}

/** Compact record of a decision, kept in the transcript for auditability. */
export function PermissionRecord({
  request,
  choice,
  columns,
}: {
  request: PermissionRequest;
  choice: PermissionChoice;
  columns: number;
}): React.ReactElement {
  const theme = useTheme();
  const label =
    choice === 'deny'
      ? 'denied'
      : choice === 'redirect'
        ? 'redirected'
        : choice === 'session'
          ? 'allowed for session'
          : choice === 'auto'
            ? 'auto-approved'
            : 'allowed';
  const rejected = choice === 'deny' || choice === 'redirect';
  const color = rejected ? theme.colors.warning : theme.colors.success;

  return (
    <Box marginBottom={1}>
      <Text color={color}>
        {rejected ? theme.symbols.failure : theme.symbols.success}{' '}
      </Text>
      <Text color={theme.colors.muted}>
        {truncateWidth(`${request.title} — ${label}`, columns - 4)}
      </Text>
    </Box>
  );
}
