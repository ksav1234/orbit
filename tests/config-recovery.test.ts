import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigManager, salvageConfig } from '../src/config/manager.js';
import { orbitPaths } from '../src/util/paths.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

let home = '';

beforeEach(async () => {
  home = await makeTempWorkspace('orbit-cfg-');
  process.env.ORBIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(home);
});

async function writeConfig(value: unknown): Promise<void> {
  await fs.writeFile(orbitPaths.config, JSON.stringify(value, null, 2), 'utf8');
}

const goodProvider = {
  id: 'good',
  label: 'Good',
  kind: 'openai-compatible',
  baseURL: 'http://127.0.0.1:1/v1',
  model: 'm',
  models: ['m'],
  headers: {},
};

describe('salvaging a config that fails validation', () => {
  it('keeps the sections that parse', () => {
    const { config, issues } = salvageConfig({
      version: 1,
      activeProvider: 'good',
      providers: { good: goodProvider },
      ui: { theme: 'not-a-theme' },
    });

    expect(config.providers.good?.label).toBe('Good');
    expect(config.activeProvider).toBe('good');
    // The bad section fell back rather than taking the file down with it.
    expect(config.ui.theme).toBe('orbit');
    expect(issues.map((issue) => issue.section)).toEqual(['ui']);
    expect(issues[0]?.message).toContain('theme');
  });

  // The case that locked the CLI: one typo in a hand-written hook.
  it('drops only the broken hook and keeps the rest running', () => {
    const { config, issues } = salvageConfig({
      version: 1,
      hooks: {
        enabled: true,
        entries: [
          { name: 'keeper', on: 'turn-end', command: 'echo ok' },
          { name: 'typo', on: 'not-an-event', command: 'echo bad' },
          { name: 'also-fine', on: 'session-start', command: 'echo hi' },
        ],
      },
    });

    expect(config.hooks.enabled).toBe(true);
    expect(config.hooks.entries.map((hook) => hook.name)).toEqual(['keeper', 'also-fine']);
    expect(issues.map((issue) => issue.section)).toEqual(['hooks.entries[1]']);
  });

  it('drops only the broken provider', () => {
    const { config, issues } = salvageConfig({
      version: 1,
      providers: {
        good: goodProvider,
        broken: { id: 'broken', label: 'Broken', baseURL: 'not-a-url' },
      },
    });

    expect(Object.keys(config.providers)).toEqual(['good']);
    expect(issues.map((issue) => issue.section)).toEqual(['providers.broken']);
  });

  it('falls back entirely when the file is not an object', () => {
    for (const bad of [null, 42, 'text', ['a']]) {
      const { config, issues } = salvageConfig(bad);
      expect(config.providers).toEqual({});
      expect(issues[0]?.section).toBe('root');
    }
  });

  it('changes nothing when the config is already valid', () => {
    const { issues } = salvageConfig({ version: 1, providers: { good: goodProvider } });
    expect(issues).toEqual([]);
  });
});

describe('loading a damaged config through the manager', () => {
  it('loads, reports the damage, and stays usable', async () => {
    await writeConfig({
      version: 1,
      activeProvider: 'good',
      providers: { good: goodProvider },
      hooks: { enabled: true, entries: [{ on: 'nope', command: 'x' }] },
    });

    const manager = new ConfigManager();
    // The whole point: this used to throw, which locked the user out of every
    // command including the one the error told them to run.
    await manager.load();

    expect(manager.getProvider('good')?.label).toBe('Good');
    expect(manager.validationIssues().map((issue) => issue.section)).toEqual([
      'hooks.entries[0]',
    ]);
  });

  it('still refuses a file that is not JSON at all', async () => {
    await fs.writeFile(orbitPaths.config, '{ not json', 'utf8');
    const manager = new ConfigManager();
    // Nothing to salvage: there is no way to guess what was meant.
    await expect(manager.load()).rejects.toThrow(/not valid JSON/i);
  });

  it('starts from defaults when there is no file', async () => {
    const manager = new ConfigManager();
    await manager.load();
    expect(manager.validationIssues()).toEqual([]);
    expect(manager.get().providers).toEqual({});
  });

  // The salvaged version is what gets written, so the original has to survive
  // somewhere or a nearly-correct section would be lost for good.
  it('copies the damaged file aside before overwriting it', async () => {
    await writeConfig({
      version: 1,
      providers: { good: goodProvider },
      hooks: { enabled: true, entries: [{ on: 'nope', command: 'x' }] },
    });

    const manager = new ConfigManager();
    await manager.load();
    await manager.update((draft) => {
      draft.ui.compact = true;
    });

    const backups = (await fs.readdir(home)).filter((name) => name.includes('.invalid-'));
    expect(backups).toHaveLength(1);

    const original = JSON.parse(
      await fs.readFile(path.join(home, backups[0]!), 'utf8'),
    ) as { hooks: { entries: unknown[] } };
    expect(original.hooks.entries).toHaveLength(1);

    // And the live file is the salvaged, valid one.
    const saved = JSON.parse(await fs.readFile(orbitPaths.config, 'utf8')) as {
      ui: { compact: boolean };
      hooks: { entries: unknown[] };
    };
    expect(saved.ui.compact).toBe(true);
    expect(saved.hooks.entries).toEqual([]);
  });

  it('backs up once, not on every write', async () => {
    await writeConfig({
      version: 1,
      providers: { good: goodProvider },
      ui: { theme: 'nope' },
    });

    const manager = new ConfigManager();
    await manager.load();
    await manager.update((draft) => {
      draft.ui.compact = true;
    });
    await manager.update((draft) => {
      draft.ui.compact = false;
    });

    const backups = (await fs.readdir(home)).filter((name) => name.includes('.invalid-'));
    expect(backups).toHaveLength(1);
  });

  it('does not back up a config that was fine', async () => {
    await writeConfig({ version: 1, providers: { good: goodProvider } });

    const manager = new ConfigManager();
    await manager.load();
    await manager.update((draft) => {
      draft.ui.compact = true;
    });

    const backups = (await fs.readdir(home)).filter((name) => name.includes('.invalid-'));
    expect(backups).toEqual([]);
  });
});
