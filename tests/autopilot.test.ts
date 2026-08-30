import { describe, expect, it } from 'vitest';
import { AutoMode } from '../src/agent/autopilot.js';
import { Planner } from '../src/agent/planner.js';
import { PermissionManager } from '../src/permissions/manager.js';
import { AutoModeConfigSchema, PermissionPolicySchema } from '../src/config/schema.js';
import type { PermissionRequest } from '../src/permissions/manager.js';

function makeAuto(overrides = {}) {
  return new AutoMode(AutoModeConfigSchema.parse(overrides));
}

const writeRequest: PermissionRequest = {
  category: 'write',
  tool: 'write_file',
  title: 'Write src/a.ts',
  target: 'src/a.ts',
};

const shellRequest: PermissionRequest = {
  category: 'shell',
  tool: 'execute_command',
  title: 'Run a shell command',
  target: 'npm test',
};

const deleteRequest: PermissionRequest = {
  category: 'delete',
  tool: 'delete_file',
  title: 'Delete src/old.ts',
  target: 'src/old.ts',
  destructive: true,
};

const secretRequest: PermissionRequest = {
  category: 'read',
  tool: 'read_file',
  title: 'Share .env',
  target: '.env',
  sensitive: true,
};

describe('AutoMode', () => {
  it('is off until turned on', () => {
    const auto = makeAuto();
    expect(auto.enabled).toBe(false);
    expect(auto.approver(writeRequest)).toBe(false);
  });

  it('toggles and notifies listeners', () => {
    const auto = makeAuto();
    const seen: boolean[] = [];
    auto.onChange((enabled) => seen.push(enabled));

    expect(auto.toggle()).toBe(true);
    expect(auto.toggle()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('approves writes and shell commands when on', () => {
    const auto = makeAuto();
    auto.set(true);
    expect(auto.approver(writeRequest)).toBe(true);
    expect(auto.approver(shellRequest)).toBe(true);
  });

  it('still refuses deletions and secrets by default', () => {
    const auto = makeAuto();
    auto.set(true);
    expect(auto.approver(deleteRequest)).toBe(false);
    expect(auto.approver(secretRequest)).toBe(false);
  });

  it('honours a widened envelope when the user opts in', () => {
    const auto = makeAuto({ approveDeletes: true, approveSensitive: true });
    auto.set(true);
    expect(auto.approver(deleteRequest)).toBe(true);
    expect(auto.approver(secretRequest)).toBe(true);
  });

  it('respects a narrowed envelope', () => {
    const auto = makeAuto({ approveWrites: false, approveShell: false });
    auto.set(true);
    expect(auto.approver(writeRequest)).toBe(false);
    expect(auto.approver(shellRequest)).toBe(false);
    // Read-only work never needed approval anyway.
    expect(auto.approver({ category: 'read', tool: 'read_file', title: 'read' })).toBe(true);
  });

  it('never approves network access', () => {
    const auto = makeAuto();
    auto.set(true);
    expect(auto.approver({ category: 'network', tool: 'fetch', title: 'fetch' })).toBe(false);
  });

  describe('self-continuation', () => {
    it('does nothing while off', () => {
      const auto = makeAuto();
      const planner = new Planner();
      planner.set([{ title: 'step', status: 'active' }]);
      expect(auto.nextContinuation(planner, 'complete')).toBeNull();
    });

    it('continues while the plan has open steps', () => {
      const auto = makeAuto({ maxContinuations: 2 });
      auto.set(true);
      const planner = new Planner();
      planner.set([
        { title: 'Inspect', status: 'done' },
        { title: 'Fix the bug', status: 'active' },
      ]);

      const first = auto.nextContinuation(planner, 'complete');
      expect(first).toContain('Fix the bug');
      expect(auto.continuationCount).toBe(1);
    });

    it('stops once the plan is complete', () => {
      const auto = makeAuto();
      auto.set(true);
      const planner = new Planner();
      planner.set([{ title: 'Done thing', status: 'done' }]);
      expect(auto.nextContinuation(planner, 'complete')).toBeNull();
    });

    it('stops when there is no plan at all', () => {
      const auto = makeAuto();
      auto.set(true);
      expect(auto.nextContinuation(new Planner(), 'complete')).toBeNull();
    });

    it('respects the continuation limit', () => {
      const auto = makeAuto({ maxContinuations: 2 });
      auto.set(true);
      const planner = new Planner();
      planner.set([{ title: 'Keep going', status: 'active' }]);

      expect(auto.nextContinuation(planner, 'complete')).not.toBeNull();
      expect(auto.nextContinuation(planner, 'complete')).not.toBeNull();
      expect(auto.nextContinuation(planner, 'complete')).toBeNull();
      expect(auto.continuationsLeft).toBe(0);
    });

    it('never continues after a cancellation or an error', () => {
      const auto = makeAuto();
      auto.set(true);
      const planner = new Planner();
      planner.set([{ title: 'Keep going', status: 'active' }]);

      expect(auto.nextContinuation(planner, 'cancelled')).toBeNull();
      expect(auto.nextContinuation(planner, 'error')).toBeNull();
    });

    it('continues after hitting the per-turn iteration limit', () => {
      const auto = makeAuto();
      auto.set(true);
      const message = auto.nextContinuation(new Planner(), 'max-iterations');
      expect(message).toContain('Continue');
    });

    it('resets its counter when the user sends a new prompt', () => {
      const auto = makeAuto({ maxContinuations: 1 });
      auto.set(true);
      const planner = new Planner();
      planner.set([{ title: 'Work', status: 'active' }]);

      auto.nextContinuation(planner, 'complete');
      expect(auto.continuationsLeft).toBe(0);
      auto.resetContinuations();
      expect(auto.continuationsLeft).toBe(1);
    });
  });

  it('describes what it will and will not do', () => {
    const auto = makeAuto();
    expect(auto.describe()).toContain('off');
    auto.set(true);
    expect(auto.describe()).toContain('auto-approves');
    expect(auto.describe()).toContain('still asks for');
  });
});

describe('PermissionManager with auto approval', () => {
  function manager() {
    return new PermissionManager({
      policy: PermissionPolicySchema.parse({ write: 'ask', delete: 'ask', shell: 'ask' }),
    });
  }

  it('skips the prompt for anything the rule approves', async () => {
    const permissions = manager();
    let prompted = 0;
    permissions.setPrompter(async () => {
      prompted++;
      return 'deny';
    });

    const auto = makeAuto();
    auto.set(true);
    permissions.setAutoApprover(auto.approver);

    const result = await permissions.check(writeRequest);
    expect(result.granted).toBe(true);
    expect(result.choice).toBe('auto');
    expect(prompted).toBe(0);
    expect(permissions.autoApprovalCount).toBe(1);
  });

  it('still prompts for what the rule declines', async () => {
    const permissions = manager();
    let prompted = 0;
    permissions.setPrompter(async () => {
      prompted++;
      return 'deny';
    });

    const auto = makeAuto();
    auto.set(true);
    permissions.setAutoApprover(auto.approver);

    const result = await permissions.check(deleteRequest);
    expect(result.granted).toBe(false);
    expect(prompted).toBe(1);
  });

  it('cannot override a deny policy', async () => {
    const permissions = new PermissionManager({
      policy: PermissionPolicySchema.parse({ write: 'deny' }),
    });
    const auto = makeAuto();
    auto.set(true);
    permissions.setAutoApprover(auto.approver);

    const result = await permissions.check(writeRequest);
    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/set to deny/);
  });

  it('falls back to prompting if the rule throws', async () => {
    const permissions = manager();
    let prompted = 0;
    permissions.setPrompter(async () => {
      prompted++;
      return 'once';
    });
    permissions.setAutoApprover(() => {
      throw new Error('bad rule');
    });

    const result = await permissions.check(writeRequest);
    expect(result.granted).toBe(true);
    expect(prompted).toBe(1);
  });

  it('stops auto-approving as soon as the rule is removed', async () => {
    const permissions = manager();
    let prompted = 0;
    permissions.setPrompter(async () => {
      prompted++;
      return 'once';
    });

    const auto = makeAuto();
    auto.set(true);
    permissions.setAutoApprover(auto.approver);
    await permissions.check(writeRequest);
    expect(prompted).toBe(0);

    permissions.setAutoApprover(null);
    await permissions.check({ ...writeRequest, target: 'src/b.ts' });
    expect(prompted).toBe(1);
    expect(permissions.isAutoApproving()).toBe(false);
  });
});
