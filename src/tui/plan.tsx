/**
 * PlanView — a scrollable, collapsible view of the agent's plan.
 *
 * Data model: a list of PlanStep objects with status. The runtime
 * emits `plan_update` events; the TUI aggregates them into a single
 * current plan and renders the steps with status glyphs.
 *
 *   ◯ read src/auth/service.ts
 *   ● edit src/auth/service.ts        (in progress)
 *   ✓ run tests                       (done)
 *   ✗ run lint                        (failed)
 *
 * The view is collapsible so it doesn't take over the screen while
 * the agent is mid-stream.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanStep } from '../agent/runtime.js';

export interface PlanViewProps {
  steps: PlanStep[];
  /** When true, render the full plan; when false, render only the in-progress step. */
  expanded: boolean;
  onToggle: () => void;
}

const GLYPHS: Record<PlanStep['status'], string> = {
  pending: '◯',
  in_progress: '●',
  done: '✓',
  failed: '✗',
  skipped: '⊘',
};

const COLORS: Record<PlanStep['status'], 'gray' | 'cyan' | 'green' | 'red' | 'yellow'> = {
  pending: 'gray',
  in_progress: 'cyan',
  done: 'green',
  failed: 'red',
  skipped: 'yellow',
};

export function PlanView({ steps, expanded, onToggle }: PlanViewProps): React.JSX.Element | null {
  if (steps.length === 0) return null;

  if (!expanded) {
    const current = steps.find((s) => s.status === 'in_progress') ?? steps[0]!;
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color={COLORS[current.status]}>{GLYPHS[current.status]} </Text>
        <Text dimColor>
          [{steps.filter((s) => s.status === 'done').length}/{steps.length}] {current.title}
        </Text>
        <Text color="gray">  (press /plan to expand)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box>
        <Text color="cyan" bold>📋 Plan </Text>
        <Text color="gray">  ({steps.filter((s) => s.status === 'done').length}/{steps.length} done)</Text>
        <Text color="gray">  press /plan to collapse</Text>
      </Box>
      {steps.map((s) => (
        <Box key={s.id} paddingLeft={2}>
          <Text color={COLORS[s.status]}>{GLYPHS[s.status]} </Text>
          <Text color={s.status === 'in_progress' ? 'cyan' : undefined} bold={s.status === 'in_progress'}>
            {s.title}
          </Text>
          {s.files && s.files.length > 0 ? (
            <Text color="gray">  ({s.files.join(', ')})</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
