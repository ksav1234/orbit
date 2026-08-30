import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../context.js';
import type { PlanStep } from '../../agent/planner.js';
import { truncateWidth } from '../../util/format.js';

export interface PlanViewProps {
  steps: PlanStep[];
  columns: number;
  title?: string;
}

/**
 * The plan the model declared via update_plan. Never synthesised by the UI.
 */
export function PlanView({ steps, columns, title = 'Plan' }: PlanViewProps): React.ReactElement | null {
  const theme = useTheme();
  if (steps.length === 0) return null;

  const width = Math.min(columns - 2, 72);
  const inner = width - 2;
  const label = ` ${title} `;
  const top =
    theme.symbols.topLeft +
    theme.symbols.horizontal +
    label +
    theme.symbols.horizontal.repeat(Math.max(0, inner - label.length - 1)) +
    theme.symbols.topRight;
  const bottom =
    theme.symbols.bottomLeft + theme.symbols.horizontal.repeat(inner) + theme.symbols.bottomRight;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.border}>{top}</Text>
      {steps.map((step, index) => (
        <Box key={index}>
          <Text color={theme.colors.border}>{theme.symbols.vertical} </Text>
          <StepGlyph status={step.status} />
          <Text color={statusColor(step.status, theme)}>
            {' '}
            {truncateWidth(`${index + 1}. ${step.title}`, inner - 5)}
          </Text>
        </Box>
      ))}
      <Text color={theme.colors.border}>{bottom}</Text>
    </Box>
  );
}

function StepGlyph({ status }: { status: PlanStep['status'] }): React.ReactElement {
  const theme = useTheme();
  switch (status) {
    case 'done':
      return <Text color={theme.colors.success}>{theme.symbols.success}</Text>;
    case 'active':
      return <Text color={theme.colors.primary}>{theme.symbols.bullet}</Text>;
    case 'skipped':
      return <Text color={theme.colors.muted}>{theme.symbols.dot}</Text>;
    default:
      return <Text color={theme.colors.muted}>{theme.symbols.pending}</Text>;
  }
}

function statusColor(status: PlanStep['status'], theme: ReturnType<typeof useTheme>): string {
  if (status === 'done') return theme.colors.muted;
  if (status === 'active') return theme.colors.text;
  if (status === 'skipped') return theme.colors.muted;
  return theme.colors.muted;
}
