import type { OptimizerConfig, ToolsConfig } from '../config/schema.js';
import { formatCount } from '../util/format.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('optimizer');

export type ContextPressure = 'low' | 'moderate' | 'high' | 'critical';

export interface OptimizationInput {
  /** Model context window, in tokens. */
  window: number;
  /** Tokens the next request would consume before the reply. */
  used: number;
  /** The user's configured ceiling for a response. */
  configuredMaxTokens: number;
  /** Observed completion sizes, used to right-size the budget. */
  averageCompletion: number;
  peakCompletion: number;
  /** Number of requests observed so far, to know how much to trust the stats. */
  samples: number;
}

export interface OptimizationDecision {
  /** max_tokens to send for this request. */
  responseTokens: number;
  /** Compact before sending: the reply would not otherwise fit. */
  compactFirst: boolean;
  /** Tool output limits for this turn. */
  toolOutputChars: number;
  fileReadChars: number;
  pressure: ContextPressure;
  utilization: number;
  /** True when this decision differs materially from the previous one. */
  changed: boolean;
  /** One line explaining the change, when there is one worth reporting. */
  reason?: string;
}

/** Reserve a slice of the window so a long reply never overruns it. */
const SAFETY_MARGIN = 0.04;

export function pressureFor(utilization: number): ContextPressure {
  if (utilization >= 0.9) return 'critical';
  if (utilization >= 0.75) return 'high';
  if (utilization >= 0.5) return 'moderate';
  return 'low';
}

/**
 * Sizes each request to the window that is actually left.
 *
 * A fixed max_tokens is wrong in both directions: too large and the provider
 * rejects the request once the conversation grows, too small and long answers
 * get cut off. This measures what the model really produces and adapts.
 */
export class TokenOptimizer {
  private config: OptimizerConfig;
  private tools: ToolsConfig;
  private previous: OptimizationDecision | null = null;

  constructor(config: OptimizerConfig, tools: ToolsConfig) {
    this.config = config;
    this.tools = tools;
  }

  setConfig(config: OptimizerConfig): void {
    this.config = config;
  }

  getConfig(): OptimizerConfig {
    return this.config;
  }

  setToolDefaults(tools: ToolsConfig): void {
    this.tools = tools;
  }

  last(): OptimizationDecision | null {
    return this.previous;
  }

  reset(): void {
    this.previous = null;
  }

  decide(input: OptimizationInput): OptimizationDecision {
    const window = Math.max(1, input.window);
    const utilization = Math.min(1, input.used / window);
    const pressure = pressureFor(utilization);

    if (!this.config.enabled) {
      const decision: OptimizationDecision = {
        responseTokens: input.configuredMaxTokens,
        compactFirst: false,
        toolOutputChars: this.tools.maxOutputChars,
        fileReadChars: this.tools.maxFileReadChars,
        pressure,
        utilization,
        changed: false,
      };
      this.previous = decision;
      return decision;
    }

    const margin = Math.max(512, Math.floor(window * SAFETY_MARGIN));
    const available = Math.max(0, window - input.used - margin);

    // A large window is a resource, not just headroom: a 1M-token model should
    // be allowed longer replies and fuller tool output than a 32k one, instead
    // of being held to the same fixed ceiling.
    const large = this.isLargeWindow(window);
    const ceiling = Math.min(
      large ? this.config.largeWindowMaxResponseTokens : this.config.maxResponseTokens,
      // The user's configured value still wins when it is the smaller number,
      // unless they left it at a default that a large window makes silly.
      large ? Math.max(input.configuredMaxTokens, this.config.maxResponseTokens) : input.configuredMaxTokens,
    );

    // Size the reply from observed behaviour once there is anything to observe:
    // the peak covers outliers, the average keeps the common case tight.
    const observed =
      input.samples >= 2
        ? Math.max(input.peakCompletion * 1.35, input.averageCompletion * 2)
        : input.configuredMaxTokens;

    const wanted = clamp(
      Math.ceil(observed || input.configuredMaxTokens),
      this.config.minResponseTokens,
      ceiling,
    );

    const responseTokens = Math.max(
      Math.min(wanted, available),
      Math.min(this.config.minResponseTokens, available),
    );

    // If even the floor does not fit, the conversation has to shrink first.
    const compactFirst = available < this.config.minResponseTokens;

    const scale = toolOutputScale(pressure, this.config.adaptiveToolOutput);
    const windowScale = this.windowScale(window);
    const toolOutputChars = Math.max(
      4_000,
      Math.floor(this.tools.maxOutputChars * scale * windowScale),
    );
    const fileReadChars = Math.max(
      8_000,
      Math.floor(this.tools.maxFileReadChars * scale * windowScale),
    );

    const decision: OptimizationDecision = {
      responseTokens: Math.max(1, responseTokens),
      compactFirst,
      toolOutputChars,
      fileReadChars,
      pressure,
      utilization,
      changed: false,
    };

    decision.changed = this.isMaterialChange(decision);
    if (decision.changed) decision.reason = this.describe(decision, input);

    if (decision.changed) {
      log.info('token budget adjusted', {
        responseTokens: decision.responseTokens,
        pressure: decision.pressure,
        utilization: Number(decision.utilization.toFixed(2)),
      });
    }

    this.previous = decision;
    return decision;
  }

  isLargeWindow(window: number): boolean {
    return this.config.scaleWithWindow && window >= this.config.largeWindowThreshold;
  }

  /**
   * Tool output allowance relative to a 128k baseline, so a big window is
   * actually used and a small one is protected. Capped so a 1M-token model
   * cannot dump a whole repository into one result.
   */
  private windowScale(window: number): number {
    if (!this.config.scaleWithWindow) return 1;
    const ratio = window / 128_000;
    return Math.min(4, Math.max(0.5, ratio));
  }

  private isMaterialChange(next: OptimizationDecision): boolean {
    const previous = this.previous;
    if (!previous) return false; // The first decision is the baseline, not news.
    if (previous.pressure !== next.pressure) return true;
    if (next.compactFirst && !previous.compactFirst) return true;
    const ratio = next.responseTokens / Math.max(1, previous.responseTokens);
    return ratio < 0.6 || ratio > 1.7;
  }

  private describe(decision: OptimizationDecision, input: OptimizationInput): string {
    const parts: string[] = [];
    parts.push(
      `context ${Math.round(decision.utilization * 100)}% (${decision.pressure})`,
      `reply budget ${formatCount(decision.responseTokens)} tokens`,
    );
    if (decision.compactFirst) parts.push('compacting to make room');
    else if (decision.toolOutputChars < this.tools.maxOutputChars) {
      parts.push(`tool output capped at ${formatCount(decision.toolOutputChars)} chars`);
    } else if (decision.toolOutputChars > this.tools.maxOutputChars) {
      parts.push(`large window: tool output raised to ${formatCount(decision.toolOutputChars)} chars`);
    }
    if (input.samples >= 2) {
      parts.push(`based on ${formatCount(input.averageCompletion)} avg reply`);
    }
    return parts.join(' · ');
  }

  /** Tool limits for the current turn, for building a ToolContext. */
  toolLimits(): Pick<ToolsConfig, 'maxOutputChars' | 'maxFileReadChars'> {
    return {
      maxOutputChars: this.previous?.toolOutputChars ?? this.tools.maxOutputChars,
      maxFileReadChars: this.previous?.fileReadChars ?? this.tools.maxFileReadChars,
    };
  }
}

function toolOutputScale(pressure: ContextPressure, adaptive: boolean): number {
  if (!adaptive) return 1;
  switch (pressure) {
    case 'critical':
      return 0.25;
    case 'high':
      return 0.5;
    case 'moderate':
      return 0.8;
    default:
      return 1;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
