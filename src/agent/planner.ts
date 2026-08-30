import { z } from 'zod';
import { defineTool, toolOk, type Tool } from '../tools/registry.js';

export type PlanStepStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
}

/**
 * The plan shown in the UI is always the model's own declared plan, recorded
 * through a real tool call. Orbit never fabricates a plan for display.
 */
export class Planner {
  private steps: PlanStep[] = [];
  private listeners = new Set<(steps: PlanStep[]) => void>();

  get current(): PlanStep[] {
    return this.steps;
  }

  get isEmpty(): boolean {
    return this.steps.length === 0;
  }

  get isComplete(): boolean {
    return this.steps.length > 0 && this.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  }

  set(steps: PlanStep[]): void {
    this.steps = steps;
    for (const listener of this.listeners) listener(this.steps);
  }

  clear(): void {
    this.set([]);
  }

  onChange(listener: (steps: PlanStep[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Compact description handed back to the model so it stays oriented. */
  describe(): string {
    if (this.steps.length === 0) return 'No plan recorded.';
    return this.steps
      .map((step, index) => `${index + 1}. [${statusLabel(step.status)}] ${step.title}`)
      .join('\n');
  }
}

function statusLabel(status: PlanStepStatus): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'active':
      return 'in progress';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

const planSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(120).describe('Short imperative description of the step.'),
        status: z
          .enum(['pending', 'active', 'done', 'skipped'])
          .default('pending')
          .describe('Progress of this step.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('The full plan. Send the complete list every time, not just the changed steps.'),
});

/**
 * Multi-step work benefits from a visible plan; trivial work does not. The tool
 * description says so explicitly to keep the model from over-planning.
 */
export function createPlanTool(planner: Planner): Tool {
  return defineTool({
    name: 'update_plan',
    description:
      'Record or update your plan for a multi-step task so the user can follow along. Send the complete step list each time, marking exactly one step as active. Skip this tool entirely for simple requests that need one or two tool calls.',
    parameters: planSchema,
    readOnly: true,
    async execute(args) {
      planner.set(args.steps);
      const active = args.steps.find((step) => step.status === 'active');
      const done = args.steps.filter((step) => step.status === 'done').length;
      const summary = active
        ? `${active.title} (${done}/${args.steps.length} done)`
        : `${done}/${args.steps.length} steps done`;

      return toolOk(
        `Plan updated.\n${planner.describe()}`,
        {
          kind: 'status',
          summary,
          lines: args.steps.map(
            (step, index) => `${index + 1}. [${statusLabel(step.status)}] ${step.title}`,
          ),
        },
        { metadata: { steps: args.steps.length, done } },
      );
    },
  });
}
