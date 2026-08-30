import type { AutoModeConfig } from '../config/schema.js';
import type { AutoApprover, PermissionRequest } from '../permissions/manager.js';
import type { Planner } from './planner.js';
import type { TurnEndReason } from './loop.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('autopilot');

export interface AutoModeStatus {
  enabled: boolean;
  continuations: number;
  maxContinuations: number;
  approves: string[];
  requiresApproval: string[];
}

/**
 * Auto-working mode.
 *
 * Two behaviours, both off by default:
 *   1. approvals inside a declared envelope are granted without prompting;
 *   2. when the model's own plan still has open steps, Orbit continues by
 *      itself instead of waiting for the user to say "keep going".
 *
 * Deletions and secret files stay outside the envelope unless the user
 * explicitly widens it, and the shell block list still applies. Auto mode
 * widens *approval*, never the workspace boundary.
 */
export class AutoMode {
  private config: AutoModeConfig;
  private on: boolean;
  private continuations = 0;
  private listeners = new Set<(enabled: boolean) => void>();

  constructor(config: AutoModeConfig) {
    this.config = config;
    this.on = config.enabled;
  }

  get enabled(): boolean {
    return this.on;
  }

  setConfig(config: AutoModeConfig): void {
    this.config = config;
  }

  getConfig(): AutoModeConfig {
    return this.config;
  }

  onChange(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(enabled: boolean): boolean {
    if (this.on === enabled) return this.on;
    this.on = enabled;
    this.continuations = 0;
    log.info(enabled ? 'auto mode enabled' : 'auto mode disabled');
    for (const listener of this.listeners) listener(this.on);
    return this.on;
  }

  toggle(): boolean {
    return this.set(!this.on);
  }

  /** The approval rule handed to the PermissionManager while auto mode is on. */
  approver: AutoApprover = (request: PermissionRequest): boolean => {
    if (!this.on) return false;

    // Destructive and secret-sharing decisions stay with the human unless the
    // user has explicitly opted in.
    if (request.destructive) return this.config.approveDeletes;
    if (request.sensitive) return this.config.approveSensitive;

    switch (request.category) {
      case 'read':
      case 'search':
        return true;
      case 'write':
        return this.config.approveWrites;
      case 'shell':
        return this.config.approveShell;
      case 'delete':
        return this.config.approveDeletes;
      case 'network':
        return false;
      default:
        return false;
    }
  };

  resetContinuations(): void {
    this.continuations = 0;
  }

  get continuationCount(): number {
    return this.continuations;
  }

  get continuationsLeft(): number {
    return Math.max(0, this.config.maxContinuations - this.continuations);
  }

  /**
   * Decide whether to keep working after a turn ends. Continues only while the
   * model's own plan still has open steps, and only up to the configured limit.
   */
  nextContinuation(planner: Planner, reason: TurnEndReason): string | null {
    if (!this.on) return null;
    if (reason !== 'complete' && reason !== 'max-iterations') return null;
    if (this.continuations >= this.config.maxContinuations) return null;

    if (reason === 'max-iterations') {
      this.continuations++;
      return 'Continue from where you stopped. Keep going until the task is done.';
    }

    if (planner.isEmpty || planner.isComplete) return null;

    const next = planner.current.find(
      (step) => step.status === 'active' || step.status === 'pending',
    );
    if (!next) return null;

    this.continuations++;
    return [
      'Continue with your plan without waiting for further input.',
      `The next open step is: ${next.title}`,
      'Work through the remaining steps, update the plan as you go, and stop when every step is done or you need a decision only the user can make.',
    ].join('\n');
  }

  status(): AutoModeStatus {
    const approves: string[] = ['read', 'search'];
    const requires: string[] = [];

    (this.config.approveWrites ? approves : requires).push('write');
    (this.config.approveShell ? approves : requires).push('shell');
    (this.config.approveDeletes ? approves : requires).push('delete');
    (this.config.approveSensitive ? approves : requires).push('secrets');
    requires.push('network');

    return {
      enabled: this.on,
      continuations: this.continuations,
      maxContinuations: this.config.maxContinuations,
      approves,
      requiresApproval: requires,
    };
  }

  describe(): string {
    const status = this.status();
    if (!status.enabled) return 'off — every restricted operation asks first';
    return `on — auto-approves ${status.approves.join(', ')}; still asks for ${status.requiresApproval.join(', ')}; up to ${status.maxContinuations} self-continuations`;
  }
}
