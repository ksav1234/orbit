import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionManager } from '../src/permissions/manager.js';
import { Sandbox } from '../src/permissions/sandbox.js';
import type { CheckpointManager } from '../src/checkpoints/manager.js';
import { ToolsConfigSchema, PermissionPolicySchema } from '../src/config/schema.js';
import type { ToolContext } from '../src/tools/registry.js';

export async function makeTempWorkspace(prefix = 'orbit-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fs.realpath(dir);
}

export async function removeTempWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
}

export interface TestContextOptions {
  root: string;
  permissions?: PermissionManager;
  signal?: AbortSignal;
  visionAvailable?: boolean;
  progress?: (message: string) => void;
  /** Attach a real checkpoint manager to exercise undo through the tools. */
  checkpoints?: CheckpointManager;
}

export function makeToolContext(options: TestContextOptions): ToolContext {
  const sandbox = new Sandbox({ root: options.root });
  const permissions =
    options.permissions ??
    new PermissionManager({
      policy: PermissionPolicySchema.parse({}),
      interactive: false,
    });

  return {
    sandbox,
    permissions,
    config: ToolsConfigSchema.parse({}),
    cwd: options.root,
    signal: options.signal ?? new AbortController().signal,
    progress: options.progress ?? (() => {}),
    visionAvailable: options.visionAvailable ?? false,
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
  };
}

/** Permission manager that answers every prompt the same way. */
export function autoPermissions(choice: 'once' | 'session' | 'deny'): PermissionManager {
  const manager = new PermissionManager({
    policy: PermissionPolicySchema.parse({}),
  });
  manager.setPrompter(async () => choice);
  return manager;
}
