import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, toolOk, type Tool } from './registry.js';
import { readGitState, summarizeGitState } from './git.js';
import { pluralize, truncateWidth } from '../util/format.js';

export interface WorkspaceInfo {
  root: string;
  name: string;
  languages: string[];
  frameworks: string[];
  runtime?: string;
  packageManager?: string;
  buildSystem?: string;
  testFramework?: string;
  manifests: string[];
  scripts: Record<string, string>;
  git: boolean;
  gitSummary?: string;
  readmeTitle?: string;
  topLevel: string[];
}

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'tsconfig.json',
  'deno.json',
  'CMakeLists.txt',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
];

const LOCKFILE_TO_MANAGER: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['poetry.lock', 'poetry'],
  ['uv.lock', 'uv'],
  ['Pipfile.lock', 'pipenv'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go modules'],
  ['composer.lock', 'composer'],
  ['Gemfile.lock', 'bundler'],
];

const FRAMEWORK_DEPS: Array<[RegExp, string]> = [
  [/^next$/, 'Next.js'],
  [/^nuxt$/, 'Nuxt'],
  [/^react$/, 'React'],
  [/^vue$/, 'Vue'],
  [/^svelte$/, 'Svelte'],
  [/^@angular\/core$/, 'Angular'],
  [/^express$/, 'Express'],
  [/^fastify$/, 'Fastify'],
  [/^koa$/, 'Koa'],
  [/^@nestjs\/core$/, 'NestJS'],
  [/^hono$/, 'Hono'],
  [/^ink$/, 'Ink'],
  [/^electron$/, 'Electron'],
  [/^django$/, 'Django'],
  [/^flask$/, 'Flask'],
  [/^fastapi$/, 'FastAPI'],
  [/^axum$/, 'Axum'],
  [/^actix-web$/, 'Actix'],
  [/^rocket$/, 'Rocket'],
  [/^gin-gonic\/gin$/, 'Gin'],
  [/^spring-boot/, 'Spring Boot'],
];

const TEST_DEPS: Array<[RegExp, string]> = [
  [/^vitest$/, 'Vitest'],
  [/^jest$/, 'Jest'],
  [/^mocha$/, 'Mocha'],
  [/^ava$/, 'AVA'],
  [/^@playwright\/test$/, 'Playwright'],
  [/^cypress$/, 'Cypress'],
  [/^pytest$/, 'pytest'],
  [/^unittest$/, 'unittest'],
  [/^rspec$/, 'RSpec'],
];

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.sh': 'Shell',
};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Inspect a workspace using only its top level plus a handful of manifests.
 * Deliberately shallow: entering a directory must never trigger a deep scan.
 */
export async function detectWorkspace(root: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
  const info: WorkspaceInfo = {
    root,
    name: path.basename(root),
    languages: [],
    frameworks: [],
    manifests: [],
    scripts: {},
    git: false,
    topLevel: [],
  };

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return info;
  }

  const names = new Set(entries.map((e) => e.name));
  info.topLevel = entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.github')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .slice(0, 40);

  info.manifests = MANIFESTS.filter((m) => names.has(m));

  for (const [lockfile, manager] of LOCKFILE_TO_MANAGER) {
    if (names.has(lockfile)) {
      info.packageManager = manager;
      break;
    }
  }

  const languages = new Set<string>();
  const frameworks = new Set<string>();

  if (names.has('package.json')) {
    const pkg = await readJson(path.join(root, 'package.json'));
    if (pkg) {
      info.runtime = 'Node.js';
      info.packageManager ??= typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : 'npm';
      if (typeof pkg.name === 'string' && pkg.name) info.name = pkg.name;
      const scripts = pkg.scripts;
      if (scripts && typeof scripts === 'object') {
        for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
          if (typeof value === 'string') info.scripts[key] = value;
        }
      }
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const dep of Object.keys(deps ?? {})) {
        for (const [re, label] of FRAMEWORK_DEPS) if (re.test(dep)) frameworks.add(label);
        for (const [re, label] of TEST_DEPS) if (re.test(dep)) info.testFramework ??= label;
      }
      languages.add(names.has('tsconfig.json') || 'typescript' in (deps ?? {}) ? 'TypeScript' : 'JavaScript');
    }
  }

  if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('Pipfile')) {
    languages.add('Python');
    info.runtime ??= 'Python';
    const manifest = names.has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt';
    const text = await fs.readFile(path.join(root, manifest), 'utf8').catch(() => '');
    for (const [re, label] of FRAMEWORK_DEPS) {
      if (new RegExp(`(^|[\\s"'])${re.source.replace(/[$^]/g, '')}`, 'im').test(text)) frameworks.add(label);
    }
    if (/pytest/i.test(text)) info.testFramework ??= 'pytest';
    info.packageManager ??= names.has('pyproject.toml') ? 'pip/poetry' : 'pip';
  }

  if (names.has('Cargo.toml')) {
    languages.add('Rust');
    info.runtime ??= 'Rust';
    info.buildSystem ??= 'Cargo';
    info.testFramework ??= 'cargo test';
    const text = await fs.readFile(path.join(root, 'Cargo.toml'), 'utf8').catch(() => '');
    for (const [re, label] of FRAMEWORK_DEPS) if (re.test(text)) frameworks.add(label);
  }

  if (names.has('go.mod')) {
    languages.add('Go');
    info.runtime ??= 'Go';
    info.buildSystem ??= 'go build';
    info.testFramework ??= 'go test';
  }

  if (names.has('pom.xml')) {
    languages.add('Java');
    info.buildSystem ??= 'Maven';
  }
  if (names.has('build.gradle') || names.has('build.gradle.kts')) {
    languages.add('Java');
    info.buildSystem ??= 'Gradle';
  }
  if (names.has('Gemfile')) languages.add('Ruby');
  if (names.has('composer.json')) languages.add('PHP');
  if (names.has('Makefile')) info.buildSystem ??= 'Make';
  if (names.has('CMakeLists.txt')) info.buildSystem ??= 'CMake';

  // Fall back to file extensions when no manifest identifies the language.
  if (languages.size === 0) {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const language = EXTENSION_LANGUAGES[path.extname(entry.name).toLowerCase()];
      if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
    for (const [language] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
      languages.add(language);
    }
  }

  if (names.has('.git')) {
    info.git = true;
    const state = await readGitState(root, signal);
    info.gitSummary = summarizeGitState(state);
  }

  const readme = ['README.md', 'readme.md', 'README.rst', 'README.txt'].find((f) => names.has(f));
  if (readme) {
    const text = await fs.readFile(path.join(root, readme), 'utf8').catch(() => '');
    const firstHeading = text.split('\n').find((line) => line.trim().length > 0);
    if (firstHeading) info.readmeTitle = truncateWidth(firstHeading.replace(/^#+\s*/, '').trim(), 100);
  }

  if (info.scripts.test) info.testFramework ??= 'npm test';
  if (info.scripts.build) info.buildSystem ??= `${info.packageManager ?? 'npm'} run build`;

  info.languages = [...languages];
  info.frameworks = [...frameworks];
  return info;
}

export function formatWorkspaceInfo(info: WorkspaceInfo): string {
  const rows: Array<[string, string]> = [];
  if (info.languages.length) rows.push(['Language', info.languages.join(', ')]);
  if (info.frameworks.length) rows.push(['Framework', info.frameworks.join(', ')]);
  if (info.runtime) rows.push(['Runtime', info.runtime]);
  if (info.packageManager) rows.push(['Package', info.packageManager]);
  if (info.buildSystem) rows.push(['Build', info.buildSystem]);
  if (info.testFramework) rows.push(['Tests', info.testFramework]);
  rows.push(['Git', info.git ? (info.gitSummary ?? 'enabled') : 'not a repository']);
  if (info.manifests.length) rows.push(['Manifests', info.manifests.join(', ')]);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

// ── inspect_project ────────────────────────────────────────────────────────

export const inspectProjectTool: Tool = defineTool({
  name: 'inspect_project',
  description:
    'Detect the workspace language, framework, package manager, build and test tooling, and git state. Use this before assuming how a project is built or tested.',
  parameters: z.object({}),
  permission: 'read',
  readOnly: true,
  async execute(_args, context) {
    const info = context.workspace ?? (await detectWorkspace(context.cwd, context.signal));
    const body = formatWorkspaceInfo(info);
    const scripts = Object.entries(info.scripts).slice(0, 15);
    const scriptText = scripts.length
      ? `\n\nScripts:\n${scripts.map(([k, v]) => `  ${k}: ${truncateWidth(v, 80)}`).join('\n')}`
      : '';
    const readme = info.readmeTitle ? `\n\nREADME: ${info.readmeTitle}` : '';

    return toolOk(
      `Workspace: ${info.name}\n\n${body}${scriptText}${readme}`,
      {
        kind: 'text',
        summary: `${info.name} — ${info.languages.join(', ') || 'unknown language'}`,
        lines: body.split('\n'),
        detail: `${body}${scriptText}`,
      },
      { metadata: { languages: info.languages, frameworks: info.frameworks } },
    );
  },
});

// ── project_structure ──────────────────────────────────────────────────────

const structureSchema = z.object({
  depth: z.number().int().min(1).max(4).default(2).describe('Directory depth to summarise.'),
});

export const projectStructureTool: Tool = defineTool({
  name: 'project_structure',
  description:
    'Summarise the workspace layout: top-level directories with file counts and the dominant file types in each.',
  parameters: structureSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const root = context.sandbox.root;
    const lines: string[] = [];
    let totalFiles = 0;

    const summarize = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > args.depth || context.signal.aborted) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const dirs = entries
        .filter((e) => e.isDirectory() && !context.sandbox.shouldIgnoreDir(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((e) => e.isFile());
      totalFiles += files.length;

      for (const child of dirs) {
        const childPath = path.join(dir, child.name);
        const stats = await directoryStats(childPath, context.sandbox.shouldIgnoreDir.bind(context.sandbox));
        const kinds = stats.extensions.slice(0, 3).map(([ext, count]) => `${ext || 'no ext'} ×${count}`);
        lines.push(
          `${prefix}${child.name}/  ${pluralize(stats.files, 'file')}${kinds.length ? `  [${kinds.join(', ')}]` : ''}`,
        );
        await summarize(childPath, `${prefix}  `, depth + 1);
      }
    };

    const rootFiles = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();

    await summarize(root, '', 1);

    const body = [
      `${path.basename(root)}/`,
      ...lines,
      '',
      `Root files: ${rootFiles.slice(0, 25).join(', ') || 'none'}`,
    ].join('\n');

    return toolOk(body, {
      kind: 'tree',
      summary: `${pluralize(lines.length, 'directory', 'directories')}, ${pluralize(totalFiles, 'file')}`,
      lines: lines.slice(0, 12),
      hiddenLines: Math.max(0, lines.length - 12),
      detail: body,
    });
  },
});

async function directoryStats(
  dir: string,
  ignore: (name: string) => boolean,
): Promise<{ files: number; extensions: Array<[string, number]> }> {
  let files = 0;
  const extensions = new Map<string, number>();
  const stack = [dir];
  let guard = 0;

  while (stack.length > 0 && guard++ < 2000) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignore(entry.name)) stack.push(path.join(current, entry.name));
      } else if (entry.isFile()) {
        files++;
        const ext = path.extname(entry.name).toLowerCase();
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      }
    }
  }

  return {
    files,
    extensions: [...extensions.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export const projectTools: Tool[] = [inspectProjectTool, projectStructureTool];
