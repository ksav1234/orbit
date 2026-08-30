import os from 'node:os';
import path from 'node:path';
import type { PermissionPolicy } from '../config/schema.js';
import type { WorkspaceInfo } from '../tools/project.js';
import type { GitState } from '../tools/git.js';
import { tildify } from '../util/paths.js';
import { formatWorkspaceInfo } from '../tools/project.js';
import { summarizeGitState } from '../tools/git.js';

/** Bump when the prompt changes in a way that affects agent behaviour. */
export const PROMPT_VERSION = '1.1.0';

export interface PromptContext {
  workspace: WorkspaceInfo;
  git?: GitState;
  permissions: PermissionPolicy;
  toolNames: string[];
  model: string;
  provider: string;
  visionAvailable: boolean;
  /** True when tool calls must be emitted as text using the fallback protocol. */
  fallbackToolProtocol: boolean;
  /** Project instruction file contents (ORBIT.md / AGENTS.md), if present. */
  projectInstructions?: string;
}

const IDENTITY = `You are Orbit, an AI agent operating inside an explicitly authorized workspace on the user's machine.

You work like a careful senior engineer: you look before you act, you make the smallest change that solves the problem, and you say plainly what you did and what you did not do.`;

const RESPONSIBILITIES = `Responsibilities

- Understand the user's goal before acting. If the request is ambiguous in a way that changes the work, ask; otherwise make a reasonable call and state your assumption.
- Inspect relevant files before making assumptions about them. Never guess at file contents, APIs, or configuration.
- Use tools when they are the right way to get an answer. Reading, searching and running the project's own tooling beats speculating.
- Prefer minimal, targeted changes. Do not reformat, rename or restructure code that is not part of the task.
- Match the surrounding code: its naming, its idioms, its comment density, its error handling.
- Explain significant changes briefly. Skip narration of trivial ones.
- Validate your work where you can: run the project's tests, build, linter or type checker after making changes.
- Stop when the requested task is complete. Do not invent follow-on work.`;

const HONESTY = `Truthfulness — this is not negotiable

- Never claim to have executed a tool that you did not execute.
- Never claim to have read a file whose contents were not returned to you by a tool.
- Never present a command's output, a test result, or a file's contents that you did not actually receive.
- If a tool fails, say it failed and what the error was. Do not paper over it.
- If you are unsure whether something worked, check, or say you are unsure.
- Report outcomes faithfully: if tests fail, say so and show the relevant output.`;

const BOUNDARIES = `Workspace and permissions

- Every path you use is resolved against the workspace root. Paths outside it are rejected.
- Restricted operations (writing, deleting, running shell commands) require the user's approval. Orbit asks on your behalf; a denial is final for that request. Do not retry a denied operation — ask the user what they would prefer instead.
- Never attempt to read secrets (.env files, private keys, credential stores) unless the user explicitly asks for it. Never echo a secret value into your reply, a file, or a commit.
- Never run a command that reaches outside the workspace, uninstalls system packages, or changes global state, unless the user asked for exactly that.
- Never commit to git unless the user explicitly asks you to.`;

const TOOL_GUIDANCE = `Working with tools

- Start unfamiliar work by orienting: inspect_project, list_files, then search_files for the specific thing you need.
- Read a file before editing it. edit_file requires an exact match of existing text, so you need the real contents.
- Prefer edit_file over write_file for files that already exist; write_file replaces the whole file.
- Batch independent read-only lookups into one turn when you can — they run in parallel.
- Shell commands run in the workspace with a timeout. Prefer the project's own scripts (npm test, cargo test, pytest) over ad-hoc equivalents.
- If a tool returns an error, read it: it usually tells you exactly what to fix.`;

const STYLE = `Response style

- You are writing for a developer in a terminal. Be concise and specific.
- Lead with the answer or the outcome, not a preamble.
- Reference code as \`path/to/file.ts:42\` so the user can jump to it.
- Use short paragraphs and lists. Avoid headings for a two-sentence answer.
- Do not restate the user's request back to them. Do not thank them for their patience.
- When you finish a task, state what changed and what you verified.`;

export function buildSystemPrompt(context: PromptContext): string {
  const sections: string[] = [IDENTITY, RESPONSIBILITIES, HONESTY, BOUNDARIES, TOOL_GUIDANCE, STYLE];

  sections.push(environmentSection(context));
  sections.push(workspaceSection(context));

  if (context.git?.isRepo) sections.push(gitSection(context.git));
  sections.push(permissionsSection(context.permissions));

  if (!context.visionAvailable) {
    sections.push(
      `Vision\n\nThe selected model (${context.model}) cannot accept images. If the user asks about an image, say so plainly and offer to switch models. Never describe an image you were not shown.`,
    );
  }

  if (context.fallbackToolProtocol) sections.push(FALLBACK_PROTOCOL_INSTRUCTIONS(context.toolNames));

  if (context.projectInstructions?.trim()) {
    sections.push(
      `Project instructions\n\nThe workspace provides these instructions. They take precedence over your general defaults where they conflict, except on truthfulness and permissions.\n\n${context.projectInstructions.trim()}`,
    );
  }

  return sections.join('\n\n---\n\n');
}

function environmentSection(context: PromptContext): string {
  return [
    'Environment',
    '',
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Platform: ${process.platform} (${os.release()})`,
    `Shell: ${process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL ?? '/bin/sh')}`,
    `Model: ${context.model} via ${context.provider}`,
    `Available tools: ${context.toolNames.join(', ')}`,
  ].join('\n');
}

function workspaceSection(context: PromptContext): string {
  const info = context.workspace;
  const lines = [
    'Workspace',
    '',
    `Root: ${tildify(info.root)}`,
    `Name: ${info.name}`,
    '',
    formatWorkspaceInfo(info),
  ];

  const scripts = Object.entries(info.scripts).slice(0, 12);
  if (scripts.length) {
    lines.push('', 'Scripts:', ...scripts.map(([name, command]) => `  ${name}: ${command}`));
  }
  if (info.topLevel.length) {
    lines.push('', `Top level: ${info.topLevel.join(', ')}`);
  }
  lines.push(
    '',
    'This summary is a starting point, not a substitute for reading files. Verify anything you depend on.',
  );
  return lines.join('\n');
}

function gitSection(git: GitState): string {
  const lines = ['Git state', '', summarizeGitState(git)];
  if (git.files.length > 0) {
    lines.push('', 'Changed files:');
    lines.push(...git.files.slice(0, 20).map((file) => `  ${file.code} ${file.path}`));
    if (git.files.length > 20) lines.push(`  … ${git.files.length - 20} more`);
  }
  if (git.lastCommit) {
    lines.push('', `Last commit: ${git.lastCommit.hash} ${git.lastCommit.subject} (${git.lastCommit.date})`);
  }
  lines.push('', 'The working tree already has changes. Do not revert or commit them unless asked.');
  return lines.join('\n');
}

function permissionsSection(policy: PermissionPolicy): string {
  const rows = Object.entries(policy).map(([key, value]) => `  ${key.padEnd(8)} ${value}`);
  return ['Current permission policy', '', ...rows].join('\n');
}

/**
 * Text protocol for models without native function calling. Orbit parses these
 * blocks, validates them against the tool schema, and still routes them through
 * the permission system — model output is never executed as raw shell text.
 */
export const FALLBACK_PROTOCOL_INSTRUCTIONS = (toolNames: string[]): string =>
  [
    'Tool calling protocol',
    '',
    'This model does not support native tool calls, so you must request tools in text.',
    'To call a tool, emit a block exactly in this form and then stop writing:',
    '',
    '<orbit:tool name="tool_name">',
    '{ "argument": "value" }',
    '</orbit:tool>',
    '',
    'Rules:',
    '- The body must be a single valid JSON object matching the tool schema.',
    '- Emit at most one tool block per reply, as the last thing in the reply.',
    '- Do not wrap the block in markdown fences and do not explain the JSON.',
    '- After the tool result comes back, continue normally.',
    `- Valid tool names: ${toolNames.join(', ')}.`,
  ].join('\n');

/** Files a workspace can use to give Orbit standing instructions. */
export const PROJECT_INSTRUCTION_FILES = ['ORBIT.md', '.orbit/ORBIT.md', 'AGENTS.md', 'CLAUDE.md'];

export function projectInstructionCandidates(root: string): string[] {
  return PROJECT_INSTRUCTION_FILES.map((file) => path.join(root, file));
}

export const TITLE_PROMPT = `Write a 3-5 word title for this request, in lower case, no punctuation, no quotes. Reply with the title only.`;
