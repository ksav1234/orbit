import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LessonStore, looksLikeStandingCorrection } from '../src/agent/lessons.js';
import { isOwnSource, verifyConfigFor } from '../src/agent/verify.js';
import { VerifyConfigSchema } from '../src/config/schema.js';
import type { WorkspaceInfo } from '../src/tools/project.js';
import { makeTempWorkspace, removeTempWorkspace } from './helpers.js';

let home = '';

beforeEach(async () => {
  home = await makeTempWorkspace('orbit-lessons-home-');
  process.env.ORBIT_HOME = home;
});

afterEach(async () => {
  delete process.env.ORBIT_HOME;
  await removeTempWorkspace(home);
});

describe('remembering corrections between sessions', () => {
  it('keeps what it was told and reads it back next time', async () => {
    const first = LessonStore.create('/work/repo');
    await first.load();
    first.add('Use make deploy, never npm publish', 'correction', 'Run npm publish');
    await first.save();

    // A new session, a new store object — the same workspace.
    const second = LessonStore.create('/work/repo');
    await second.load();

    expect(second.count).toBe(1);
    expect(second.list()[0]?.text).toBe('Use make deploy, never npm publish');
    expect(second.list()[0]?.source).toBe('correction');
  });

  // Advice about one repository is usually wrong about another.
  it('does not carry advice between workspaces', async () => {
    const a = LessonStore.create('/work/repo-a');
    await a.load();
    a.add('Tabs, not spaces', 'manual');
    await a.save();

    const b = LessonStore.create('/work/repo-b');
    await b.load();
    expect(b.count).toBe(0);
  });

  // Being told the same thing twice is a signal it matters, not a reason to
  // spend twice the prompt on it.
  it('folds a near-duplicate into the existing entry', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    store.add('Use make deploy, never npm publish', 'correction');
    store.add('use MAKE DEPLOY, never NPM PUBLISH!!', 'manual');

    expect(store.count).toBe(1);
  });

  it('moves a repeated lesson to the end so it survives trimming', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    store.add('first thing', 'manual');
    store.add('second thing', 'manual');
    store.add('FIRST THING.', 'manual');

    expect(store.list().map((lesson) => lesson.text)).toEqual(['second thing', 'first thing']);
  });

  it('refuses noise and clips a wall of text', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();

    expect(store.add('  ', 'manual')).toBeNull();
    expect(store.add('ok', 'manual')).toBeNull();

    store.add('x'.repeat(5_000), 'manual');
    expect(store.list()[0]!.text.length).toBeLessThan(520);
  });

  it('forgets one by position, or all of them', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    store.add('alpha lesson', 'manual');
    store.add('beta lesson', 'manual');

    expect(store.remove(99)).toBeNull();
    expect(store.remove(1)?.text).toBe('alpha lesson');
    expect(store.count).toBe(1);

    expect(store.clear()).toBe(1);
    expect(store.count).toBe(0);
  });

  it('caps how many it keeps', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    for (let i = 0; i < 80; i++) store.add(`lesson number ${i} about something`, 'manual');

    expect(store.count).toBeLessThanOrEqual(50);
    // The newest survive, because recent advice is likeliest to still be true.
    expect(store.list().at(-1)?.text).toContain('79');
  });

  it('writes under the Orbit home, never into the project', async () => {
    const workspace = await makeTempWorkspace('orbit-lessons-ws-');
    try {
      const store = LessonStore.create(workspace);
      await store.load();
      store.add('something worth keeping', 'manual');
      await store.save();

      expect(LessonStore.fileFor(workspace).startsWith(home)).toBe(true);
      // Nothing was added to the user's repository.
      expect(await fs.readdir(workspace)).not.toContain('.orbit');
    } finally {
      await removeTempWorkspace(workspace);
    }
  });

  it('survives a corrupt store rather than failing the session', async () => {
    const file = LessonStore.fileFor('/work/repo');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json at all', 'utf8');

    const store = LessonStore.create('/work/repo');
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.count).toBe(0);
  });
});

describe('putting lessons in front of the model', () => {
  it('renders nothing when there is nothing to say', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    expect(store.render()).toBe('');
  });

  it('states that they came from before and can be overridden', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    store.add('Use make deploy, never npm publish', 'correction');

    const rendered = store.render();
    expect(rendered).toContain('Use make deploy, never npm publish');
    expect(rendered).toMatch(/earlier sessions/i);
    // It must not read as an absolute rule that outranks the live conversation.
    expect(rendered).toMatch(/unless the current|conversation says otherwise/i);
  });

  it('fits the budget, keeping the most recent', async () => {
    const store = LessonStore.create('/work/repo');
    await store.load();
    for (let i = 0; i < 40; i++) store.add(`lesson ${'word '.repeat(20)} ${i}`, 'manual');

    const rendered = store.render(120);
    expect(rendered).toContain('39');
    expect(rendered).not.toContain('lesson word word word word word word word word word word word word word word word word word word word word 0\n');
  });
});

// ── Orbit working on itself ───────────────────────────────────────────────

const workspaceLike = (overrides: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  root: '/w',
  name: 'something',
  languages: [],
  frameworks: [],
  manifests: [],
  scripts: {},
  git: false,
  topLevel: [],
  ...overrides,
});

describe('editing its own source', () => {
  it('recognises itself by package name, wherever it is checked out', () => {
    expect(isOwnSource(workspaceLike({ name: 'orbit-cli', manifests: ['package.json'] }))).toBe(true);
    // A fork under a different path is still Orbit.
    expect(
      isOwnSource(workspaceLike({ root: '/tmp/fork', name: 'orbit-cli', manifests: ['package.json'] })),
    ).toBe(true);
  });

  it('is not fooled by a directory that merely looks like it', () => {
    expect(isOwnSource(workspaceLike({ root: '/home/me/orbit', name: 'my-app', manifests: ['package.json'] }))).toBe(
      false,
    );
    expect(isOwnSource(workspaceLike({ name: 'orbit-cli' }))).toBe(false);
  });

  // A broken change here breaks the tool needed to fix it.
  it('turns verification and rollback on for its own source', () => {
    const base = VerifyConfigSchema.parse({});
    expect(base.enabled).toBe(false);

    const tightened = verifyConfigFor(
      base,
      workspaceLike({ name: 'orbit-cli', manifests: ['package.json'] }),
    );
    expect(tightened.enabled).toBe(true);
    expect(tightened.rollbackOnFailure).toBe(true);
  });

  it('never overrides a choice the user made deliberately', () => {
    const chosen = VerifyConfigSchema.parse({ rollbackOnFailure: false, enabled: false });
    const result = verifyConfigFor(
      chosen,
      workspaceLike({ name: 'orbit-cli', manifests: ['package.json'] }),
      new Set(['rollbackOnFailure', 'enabled']),
    );
    // They said false and meant it.
    expect(result.rollbackOnFailure).toBe(false);
    expect(result.enabled).toBe(false);
  });

  it('leaves every other project exactly as configured', () => {
    const base = VerifyConfigSchema.parse({});
    expect(verifyConfigFor(base, workspaceLike({ name: 'their-app' }))).toEqual(base);
  });
});

describe('spotting a correction in an ordinary message', () => {
  const rule = looksLikeStandingCorrection;

  // The commonest way a rule arrives: not a rejected tool call, just the next
  // thing you type.
  it('recognises a rule stated as a correction', () => {
    expect(rule('no, never edit the lockfile by hand')).toBe(true);
    expect(rule('do not commit directly to main, always open a PR')).toBe(true);
    expect(rule('actually, always run the tests first')).toBe(true);
  });

  it('recognises a rule stated outright', () => {
    expect(rule('Always run the tests before you say done')).toBe(true);
    expect(rule('from now on prefer async/await over .then chains')).toBe(true);
    expect(rule('Never touch anything under generated/')).toBe(true);
  });

  // Capturing too eagerly would fill the prompt with noise, which is worse than
  // capturing nothing.
  it('ignores a correction that is only about this moment', () => {
    expect(rule('no, use the other file')).toBe(false);
    expect(rule('no, fix that typo on line 4')).toBe(false);
    expect(rule('stop')).toBe(false);
    expect(rule('wrong')).toBe(false);
  });

  it('ignores ordinary requests, however long', () => {
    expect(rule('Please refactor the auth middleware and add tests for the retry path')).toBe(false);
    expect(rule('add a button')).toBe(false);
    expect(rule('')).toBe(false);
  });

  // A paragraph that happens to contain "always" is a task, not a rule.
  it('ignores anything long enough to be a task', () => {
    const long = `no, always ${'do the thing '.repeat(40)}`;
    expect(rule(long)).toBe(false);
  });
});
