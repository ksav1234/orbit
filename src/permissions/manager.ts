import path from 'node:path';
import type { PermissionDecision, PermissionPolicy } from '../config/schema.js';
import type { Hunk } from '../util/hunks.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('permissions');

/** The permission classes a tool can request. */
export type PermissionCategory = 'read' | 'search' | 'write' | 'delete' | 'shell' | 'network';

export interface PermissionRequest {
  category: PermissionCategory;
  /** Tool that triggered the request. */
  tool: string;
  /** Short line shown as the prompt title, e.g. `Write src/auth.ts`. */
  title: string;
  /** Optional supporting lines (working directory, file size, …). */
  details?: Array<{ label: string; value: string }>;
  /** Unified diff or command preview rendered inside the prompt. */
  preview?: string;
  previewKind?: 'diff' | 'command' | 'text';
  /** Stable key for "allow for session" grants; defaults to category + target. */
  target?: string;
  /** Destructive requests never offer a session-wide grant. */
  destructive?: boolean;
  /**
   * The proposed change broken into separately acceptable pieces. When present,
   * the prompt offers to apply a subset instead of all-or-nothing.
   */
  hunks?: Hunk[];
  /**
   * Set when the target matched a sensitive-file pattern. These always prompt,
   * even if the category policy is `allow`.
   */
  sensitive?: boolean;
}

export type PermissionChoice = 'once' | 'session' | 'deny' | 'auto' | 'redirect' | 'partial';

export interface PermissionResult {
  granted: boolean;
  choice: PermissionChoice;
  /** Explanation handed back to the model when denied. */
  reason?: string;
  /**
   * Hunk indices the user accepted, when they approved only part of a change.
   * The tool narrows its own arguments to these.
   */
  selectedHunks?: number[];
}

/** The UI supplies this; it renders the prompt and resolves with the choice. */
export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionChoice>;

/**
 * Auto mode's approval rule. Returns true to approve without prompting;
 * anything it declines falls through to the normal prompt.
 */
export type AutoApprover = (request: PermissionRequest) => boolean;

export interface PermissionManagerOptions {
  policy: PermissionPolicy;
  prompter?: PermissionPrompter;
  /** When false, an `ask` policy resolves to denial instead of hanging. */
  interactive?: boolean;
}

/**
 * Decides whether a tool call may proceed. Policy comes from config; the user
 * can widen it for the lifetime of the session but never silently.
 */
export class PermissionManager {
  private policy: PermissionPolicy;
  private prompter: PermissionPrompter | undefined;
  private interactive: boolean;
  private autoApprover: AutoApprover | null = null;
  private autoApprovals = 0;
  private readonly sessionGrants = new Set<string>();
  private readonly sensitiveGrants = new Set<string>();

  constructor(options: PermissionManagerOptions) {
    this.policy = options.policy;
    this.prompter = options.prompter;
    this.interactive = options.interactive ?? true;
  }

  setPrompter(prompter: PermissionPrompter | undefined): void {
    this.prompter = prompter;
    this.interactive = Boolean(prompter);
  }

  /**
   * Install (or clear) auto mode's approval rule. A `deny` policy still wins,
   * and the rule itself decides what it is willing to approve.
   */
  setAutoApprover(approver: AutoApprover | null): void {
    this.autoApprover = approver;
    if (!approver) this.autoApprovals = 0;
  }

  get autoApprovalCount(): number {
    return this.autoApprovals;
  }

  isAutoApproving(): boolean {
    return this.autoApprover !== null;
  }

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy;
  }

  getPolicy(): PermissionPolicy {
    return this.policy;
  }

  decisionFor(category: PermissionCategory): PermissionDecision {
    return this.policy[category] ?? 'ask';
  }

  /** Grants added by the user during this session, for `/permissions`. */
  listSessionGrants(): string[] {
    return [...this.sessionGrants].sort();
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
    this.sensitiveGrants.clear();
  }

  private grantKey(request: PermissionRequest): string {
    return `${request.category}:${request.target ?? '*'}`;
  }

  private wildcardKey(request: PermissionRequest): string {
    return `${request.category}:*`;
  }

  async check(request: PermissionRequest): Promise<PermissionResult> {
    const policy = this.decisionFor(request.category);

    if (policy === 'deny') {
      return {
        granted: false,
        choice: 'deny',
        reason: `Denied by configuration: the "${request.category}" permission is set to deny. The user can change this with /permissions.`,
      };
    }

    // Sensitive files bypass a blanket `allow` and always require confirmation.
    if (request.sensitive) {
      const key = `secret:${request.target ?? request.title}`;
      if (this.sensitiveGrants.has(key)) {
        return { granted: true, choice: 'session' };
      }
      if (this.autoApprove(request)) return { granted: true, choice: 'auto' };
      const choice = await this.prompt(request);
      if (choice === 'deny') {
        return {
          granted: false,
          choice,
          reason: 'The user declined to share this sensitive file.',
        };
      }
      if (choice === 'session') this.sensitiveGrants.add(key);
      return { granted: true, choice };
    }

    if (policy === 'allow') return { granted: true, choice: 'once' };

    if (this.sessionGrants.has(this.wildcardKey(request))) {
      return { granted: true, choice: 'session' };
    }
    if (request.target && this.sessionGrants.has(this.grantKey(request))) {
      return { granted: true, choice: 'session' };
    }

    if (this.autoApprove(request)) return { granted: true, choice: 'auto' };

    const choice = await this.prompt(request);
    if (choice === 'deny') {
      return {
        granted: false,
        choice,
        reason: 'The user denied this operation. Do not retry it; ask what they would prefer.',
      };
    }
    if (choice === 'redirect') {
      // The user rejected the operation but told the agent what to do instead.
      return {
        granted: false,
        choice,
        reason: this.lastRedirect
          ? `The user rejected this and asked for something different instead: "${this.lastRedirect}"`
          : 'The user rejected this and wants a different approach.',
      };
    }
    if (choice === 'partial') {
      const selected = this.lastHunkSelection ?? [];
      if (selected.length === 0) {
        // Choosing nothing is a refusal, and saying so plainly beats writing an
        // unchanged file and calling it a success.
        return {
          granted: false,
          choice: 'deny',
          reason: 'The user reviewed the change and accepted none of it.',
        };
      }
      const total = request.hunks?.length ?? 0;
      return {
        granted: true,
        choice,
        selectedHunks: selected,
        reason:
          total > 0 && selected.length < total
            ? `The user accepted ${selected.length} of ${total} changes. The rest were rejected — do not reapply them without asking.`
            : undefined,
      };
    }
    if (choice === 'session' && !request.destructive) {
      this.sessionGrants.add(request.target ? this.grantKey(request) : this.wildcardKey(request));
    }
    return { granted: true, choice };
  }

  /** Instruction captured by the UI's "edit instruction" option. */
  private lastRedirect: string | null = null;

  setRedirect(instruction: string | null): void {
    this.lastRedirect = instruction?.trim() || null;
  }

  /** Hunks the UI's per-hunk picker settled on, read by the next `check`. */
  private lastHunkSelection: number[] | null = null;

  setHunkSelection(indices: number[] | null): void {
    this.lastHunkSelection = indices ? [...indices] : null;
  }

  /** Consult auto mode's rule, counting the approvals it grants. */
  private autoApprove(request: PermissionRequest): boolean {
    if (!this.autoApprover) return false;
    let approved = false;
    try {
      approved = this.autoApprover(request);
    } catch (error) {
      log.warn('auto-approval rule threw; falling back to prompting', { error: String(error) });
      return false;
    }
    if (approved) {
      this.autoApprovals++;
      log.info('auto-approved', { category: request.category, tool: request.tool });
    }
    return approved;
  }

  private async prompt(request: PermissionRequest): Promise<PermissionChoice> {
    if (!this.interactive || !this.prompter) {
      log.warn('permission required but no interactive prompter is attached', {
        category: request.category,
        tool: request.tool,
      });
      return 'deny';
    }
    log.debug('prompting for permission', { category: request.category, tool: request.tool });
    return this.prompter(request);
  }
}

/**
 * Session grants are keyed per file for writes and per command for shell, so
 * "allow for session" does not quietly widen into "allow everything".
 */
export function targetForFile(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : absolutePath;
}

/** Group commands by their program so repeated `npm test` runs share a grant. */
export function targetForCommand(command: string): string {
  const trimmed = command.trim();
  const [program = '', sub = ''] = trimmed.split(/\s+/);
  const base = path.basename(program).replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const multi = new Set(['npm', 'pnpm', 'yarn', 'git', 'cargo', 'go', 'dotnet', 'poetry', 'uv', 'bun', 'make', 'docker']);
  return multi.has(base) && sub ? `${base} ${sub}` : base || trimmed;
}
