import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool, type ToolContext, type ToolResult } from './registry.js';
import { targetForFile } from '../permissions/manager.js';
import { SandboxError } from '../util/errors.js';
import { applyEol, detectEol, normalizeEol, unifiedDiff } from '../util/diff.js';
import { staleWriteMessage } from './tracker.js';
import { clampChars, formatBytes, pluralize } from '../util/format.js';

const MAX_TREE_ENTRIES = 400;
const BINARY_SNIFF_BYTES = 8192;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

// ── list_files ─────────────────────────────────────────────────────────────

const listSchema = z.object({
  path: z.string().default('.').describe('Directory to list, relative to the workspace root.'),
  depth: z.number().int().min(1).max(6).default(2).describe('How many directory levels to descend.'),
  include_ignored: z
    .boolean()
    .default(false)
    .describe('Include node_modules, .git, build output and other ignored directories.'),
});

export const listFilesTool: Tool = defineTool({
  name: 'list_files',
  description:
    'List the contents of a directory as a tree. Use this first to understand an unfamiliar workspace. Ignores node_modules, .git and build output by default.',
  parameters: listSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const resolved = context.sandbox.resolve(args.path);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved.absolute);
    } catch {
      return toolError(`Directory not found: ${resolved.relative}`);
    }
    if (!stat.isDirectory()) {
      return toolError(`Not a directory: ${resolved.relative}. Use read_file instead.`);
    }

    const entries: string[] = [];
    let truncated = false;
    let fileCount = 0;
    let dirCount = 0;

    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > args.depth || truncated) return;
      let children: Dirent[];
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const visible = children
        .filter((child) => args.include_ignored || !context.sandbox.shouldIgnoreDir(child.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      for (let i = 0; i < visible.length; i++) {
        if (context.signal.aborted) return;
        if (entries.length >= MAX_TREE_ENTRIES) {
          truncated = true;
          return;
        }
        const child = visible[i]!;
        const last = i === visible.length - 1;
        const branch = last ? '└─ ' : '├─ ';
        const isDir = child.isDirectory();
        if (isDir) dirCount++;
        else fileCount++;
        entries.push(`${prefix}${branch}${child.name}${isDir ? '/' : ''}`);
        if (isDir) {
          await walk(path.join(dir, child.name), `${prefix}${last ? '   ' : '│  '}`, depth + 1);
        }
      }
    };

    await walk(resolved.absolute, '', 1);

    const header = `${resolved.relative === '.' ? './' : resolved.relative + '/'}`;
    const body = entries.join('\n');
    const summary = `${pluralize(dirCount, 'directory', 'directories')}, ${pluralize(fileCount, 'file')}${truncated ? ' (truncated)' : ''}`;

    return toolOk(
      `${header}\n${body}${truncated ? `\n… listing truncated at ${MAX_TREE_ENTRIES} entries; list a subdirectory for more.` : ''}`,
      {
        kind: 'tree',
        summary: `${header} — ${summary}`,
        lines: entries.slice(0, 12),
        hiddenLines: Math.max(0, entries.length - 12),
        detail: body,
      },
      { metadata: { files: fileCount, directories: dirCount, truncated } },
    );
  },
});

// ── read_file ──────────────────────────────────────────────────────────────

const readSchema = z.object({
  path: z.string().describe('File to read, relative to the workspace root.'),
  offset: z.number().int().min(1).optional().describe('First line to read (1-indexed).'),
  limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines to read.'),
});

export const readFileTool: Tool = defineTool({
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns the contents with line numbers. For PDFs use read_pdf, for images use read_image.',
  parameters: readSchema,
  permission: 'read',
  readOnly: true,
  async authorize(args, context) {
    // Only sensitive files interrupt the user; ordinary reads are pre-approved.
    let resolved;
    try {
      resolved = context.sandbox.resolve(args.path);
    } catch {
      return null;
    }
    if (!resolved.sensitive) return null;
    return {
      category: 'read',
      tool: 'read_file',
      title: `Share ${resolved.relative} with the model?`,
      details: [
        { label: 'Reason', value: 'This file matches a credentials/secrets pattern.' },
        { label: 'Model', value: 'Contents would be sent to your selected provider.' },
      ],
      target: targetForFile(context.sandbox.root, resolved.absolute),
      sensitive: true,
    };
  },
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved.absolute);
    } catch {
      return toolError(`File not found: ${resolved.relative}`);
    }
    if (stat.isDirectory()) {
      return toolError(`${resolved.relative} is a directory. Use list_files instead.`);
    }

    const extension = path.extname(resolved.absolute).toLowerCase();
    if (extension === '.pdf') {
      return toolError(`${resolved.relative} is a PDF. Use the read_pdf tool.`);
    }
    if (IMAGE_EXTENSIONS.has(extension)) {
      return toolError(`${resolved.relative} is an image. Use the read_image tool.`);
    }

    const buffer = await fs.readFile(resolved.absolute);
    if (looksBinary(buffer)) {
      return toolError(
        `${resolved.relative} appears to be a binary file (${formatBytes(stat.size)}). Orbit did not read it.`,
      );
    }

    const text = normalizeEol(buffer.toString('utf8'));
    const allLines = text.split('\n');
    const start = (args.offset ?? 1) - 1;
    const limit = args.limit ?? 2000;
    const slice = allLines.slice(start, start + limit);

    if (slice.length === 0) {
      return toolError(
        `${resolved.relative} has ${allLines.length} lines; offset ${args.offset ?? 1} is past the end.`,
      );
    }

    // Remember what the agent saw, so a later write can detect an edit made
    // outside Orbit in the meantime.
    context.fileTracker?.noteRead(resolved.absolute, stat.mtimeMs, stat.size);

    const numbered = slice
      .map((line, index) => `${String(start + index + 1).padStart(6)}\t${line}`)
      .join('\n');
    const clamped = clampChars(numbered, context.config.maxFileReadChars);

    const notes: string[] = [];
    if (start > 0 || start + slice.length < allLines.length) {
      notes.push(
        `Showing lines ${start + 1}-${start + slice.length} of ${allLines.length}.`,
      );
    }
    if (clamped.truncated) notes.push('Content was truncated to fit the context budget.');

    const content = [`${resolved.relative}`, ...notes, '', clamped.text].join('\n');

    return toolOk(
      content,
      {
        kind: 'text',
        summary: `${resolved.relative} — ${pluralize(allLines.length, 'line')}, ${formatBytes(stat.size)}`,
        detail: clamped.text,
      },
      { metadata: { lines: allLines.length, bytes: stat.size, sensitive: resolved.sensitive } },
    );
  },
});

// ── write_file ─────────────────────────────────────────────────────────────

const writeSchema = z.object({
  path: z.string().describe('File to write, relative to the workspace root.'),
  content: z.string().describe('Full contents to write. Existing files are overwritten.'),
});

export const writeFileTool: Tool = defineTool({
  name: 'write_file',
  description:
    'Create a file, or replace an existing file entirely. Prefer edit_file for targeted changes to a file that already exists.',
  parameters: writeSchema,
  permission: 'write',
  readOnly: false,
  async authorize(args, context) {
    const resolved = context.sandbox.resolve(args.path);
    const existing = await readIfExists(resolved.absolute);
    const isNew = existing === null;
    const diff = isNew
      ? previewNewFile(resolved.relative, args.content)
      : unifiedDiff(resolved.relative, existing, args.content).patch;

    if (!isNew && normalizeEol(existing) === normalizeEol(args.content)) {
      return null; // No-op writes do not need approval.
    }

    return {
      category: 'write',
      tool: 'write_file',
      title: `${isNew ? 'Create' : 'Overwrite'} ${resolved.relative}`,
      details: [
        { label: 'Size', value: formatBytes(Buffer.byteLength(args.content)) },
        ...(isNew ? [] : [{ label: 'Existing', value: `${normalizeEol(existing).split('\n').length} lines` }]),
      ],
      preview: diff,
      previewKind: 'diff',
      target: targetForFile(context.sandbox.root, resolved.absolute),
      sensitive: resolved.sensitive,
    };
  },
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);

    const stale = await checkFreshness(resolved.absolute, resolved.relative, context);
    if (stale) return stale;

    const existing = await readIfExists(resolved.absolute);
    const isNew = existing === null;
    const eol = existing ? detectEol(existing) : '\n';
    const next = applyEol(args.content, eol);

    await context.checkpoints?.capture(resolved.absolute, isNew ? 'created' : 'modified');

    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await fs.writeFile(resolved.absolute, next, 'utf8');
    await noteWritten(resolved.absolute, context);

    const diff = isNew ? null : unifiedDiff(resolved.relative, existing, args.content);
    const lines = normalizeEol(args.content).split('\n').length;
    const summary = isNew
      ? `Created ${resolved.relative} (${pluralize(lines, 'line')})`
      : `Updated ${resolved.relative} (+${diff?.added ?? 0} −${diff?.removed ?? 0})`;

    return toolOk(
      summary,
      {
        kind: isNew ? 'status' : 'diff',
        summary,
        detail: diff?.patch,
      },
      { metadata: { created: isNew, lines } },
    );
  },
});

// ── edit_file ──────────────────────────────────────────────────────────────

const editSchema = z.object({
  path: z.string().describe('File to edit, relative to the workspace root.'),
  old_string: z
    .string()
    .min(1)
    .describe('Exact text to replace, including indentation. Must appear in the file.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of requiring a unique match.'),
});

export const editFileTool: Tool = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact string in a file. The old_string must match the file byte-for-byte and, unless replace_all is set, must appear exactly once. Prefer this over write_file for existing files.',
  parameters: editSchema,
  permission: 'write',
  readOnly: false,
  async authorize(args, context) {
    const resolved = context.sandbox.resolve(args.path);
    const existing = await readIfExists(resolved.absolute);
    if (existing === null) return null; // execute() reports the missing file.
    const applied = applyEdit(existing, args.old_string, args.new_string, args.replace_all);
    if (!applied.ok) return null; // execute() reports the match failure.

    const diff = unifiedDiff(resolved.relative, existing, applied.text);
    return {
      category: 'write',
      tool: 'edit_file',
      title: `Edit ${resolved.relative}`,
      details: [
        { label: 'Change', value: `+${diff.added} −${diff.removed}` },
        ...(applied.count > 1 ? [{ label: 'Occurrences', value: String(applied.count) }] : []),
      ],
      preview: diff.patch,
      previewKind: 'diff',
      target: targetForFile(context.sandbox.root, resolved.absolute),
      sensitive: resolved.sensitive,
    };
  },
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);

    const stale = await checkFreshness(resolved.absolute, resolved.relative, context);
    if (stale) return stale;

    const existing = await readIfExists(resolved.absolute);
    if (existing === null) {
      return toolError(`File not found: ${resolved.relative}. Use write_file to create it.`);
    }

    const applied = applyEdit(existing, args.old_string, args.new_string, args.replace_all);
    if (!applied.ok) {
      return toolError(applied.reason);
    }

    await context.checkpoints?.capture(resolved.absolute, 'modified');

    const eol = detectEol(existing);
    await fs.writeFile(resolved.absolute, applyEol(applied.text, eol), 'utf8');
    await noteWritten(resolved.absolute, context);

    const diff = unifiedDiff(resolved.relative, existing, applied.text);
    const summary = `${resolved.relative} (+${diff.added} −${diff.removed}${applied.count > 1 ? `, ${applied.count} occurrences` : ''})`;

    return toolOk(
      `Edited ${summary}\n\n${diff.patch}`,
      { kind: 'diff', summary: `Edited ${summary}`, detail: diff.patch },
      { metadata: { added: diff.added, removed: diff.removed, occurrences: applied.count } },
    );
  },
});

interface EditOutcome {
  ok: boolean;
  text: string;
  count: number;
  reason: string;
}

/** Exact-match replacement with clear failure messages the model can recover from. */
export function applyEdit(
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditOutcome {
  const text = normalizeEol(source);
  const needle = normalizeEol(oldString);
  const replacement = normalizeEol(newString);

  if (needle === replacement) {
    return { ok: false, text, count: 0, reason: 'old_string and new_string are identical.' };
  }

  const occurrences = countOccurrences(text, needle);
  if (occurrences === 0) {
    return {
      ok: false,
      text,
      count: 0,
      reason:
        'old_string was not found in the file. Read the file again and copy the exact text, including indentation.',
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      text,
      count: occurrences,
      reason: `old_string appears ${occurrences} times. Include more surrounding context to make it unique, or set replace_all.`,
    };
  }

  const next = replaceAll ? text.split(needle).join(replacement) : text.replace(needle, replacement);
  return { ok: true, text: next, count: occurrences, reason: '' };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// ── delete_file ────────────────────────────────────────────────────────────

const deleteSchema = z.object({
  path: z.string().describe('File or directory to delete, relative to the workspace root.'),
  recursive: z.boolean().default(false).describe('Required to delete a non-empty directory.'),
});

export const deleteFileTool: Tool = defineTool({
  name: 'delete_file',
  description:
    'Delete a file or directory inside the workspace. This cannot be undone automatically, so it always requires explicit approval.',
  parameters: deleteSchema,
  permission: 'delete',
  readOnly: false,
  async authorize(args, context) {
    const resolved = context.sandbox.resolve(args.path);
    if (resolved.absolute === context.sandbox.root) return null; // execute() refuses this.
    const stat = await statOrNull(resolved.absolute);
    if (!stat) return null;

    const details = [
      { label: 'Type', value: stat.isDirectory() ? 'Directory' : 'File' },
      { label: 'Size', value: formatBytes(stat.size) },
    ];
    if (stat.isDirectory()) {
      const count = await countEntries(resolved.absolute);
      details.push({ label: 'Contains', value: pluralize(count, 'entry', 'entries') });
    }

    return {
      category: 'delete',
      tool: 'delete_file',
      title: `Delete ${resolved.relative}`,
      details,
      destructive: true,
      target: targetForFile(context.sandbox.root, resolved.absolute),
    };
  },
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);
    if (resolved.absolute === context.sandbox.root) {
      return toolError('Refusing to delete the workspace root.');
    }
    const stat = await statOrNull(resolved.absolute);
    if (!stat) return toolError(`Path not found: ${resolved.relative}`);

    if (stat.isDirectory()) {
      if (!args.recursive) {
        const count = await countEntries(resolved.absolute);
        if (count > 0) {
          return toolError(
            `${resolved.relative} is a directory containing ${pluralize(count, 'entry', 'entries')}. Set recursive to delete it.`,
          );
        }
      }
      await context.checkpoints?.capture(resolved.absolute, 'deleted');
      await fs.rm(resolved.absolute, { recursive: true, force: false });
    } else {
      await context.checkpoints?.capture(resolved.absolute, 'deleted');
      await fs.unlink(resolved.absolute);
    }
    context.fileTracker?.forget(resolved.absolute);

    const summary = `Deleted ${resolved.relative}`;
    return toolOk(summary, { kind: 'status', summary });
  },
});

// ── move_file ──────────────────────────────────────────────────────────────

const moveSchema = z.object({
  source: z.string().describe('Existing path, relative to the workspace root.'),
  destination: z.string().describe('New path, relative to the workspace root.'),
  overwrite: z.boolean().default(false).describe('Allow replacing an existing destination.'),
});

export const moveFileTool: Tool = defineTool({
  name: 'move_file',
  description: 'Move or rename a file or directory within the workspace.',
  parameters: moveSchema,
  permission: 'write',
  readOnly: false,
  async authorize(args, context) {
    const from = context.sandbox.resolve(args.source);
    const to = context.sandbox.resolve(args.destination);
    return {
      category: 'write',
      tool: 'move_file',
      title: `Move ${from.relative} → ${to.relative}`,
      details: [{ label: 'Overwrite', value: args.overwrite ? 'yes' : 'no' }],
      target: targetForFile(context.sandbox.root, to.absolute),
      sensitive: from.sensitive || to.sensitive,
    };
  },
  async execute(args, context) {
    const from = await context.sandbox.resolveReal(args.source);
    const to = await context.sandbox.resolveReal(args.destination);

    if (!(await statOrNull(from.absolute))) {
      return toolError(`Source not found: ${from.relative}`);
    }
    if (!args.overwrite && (await statOrNull(to.absolute))) {
      return toolError(`Destination already exists: ${to.relative}. Set overwrite to replace it.`);
    }

    await context.checkpoints?.capture(from.absolute, 'moved', to.absolute);
    if (await statOrNull(to.absolute)) {
      // The destination is about to be replaced, so its contents need saving too.
      await context.checkpoints?.capture(to.absolute, 'modified');
    }

    await fs.mkdir(path.dirname(to.absolute), { recursive: true });
    await fs.rename(from.absolute, to.absolute);
    context.fileTracker?.forget(from.absolute);

    const summary = `Moved ${from.relative} → ${to.relative}`;
    return toolOk(summary, { kind: 'status', summary });
  },
});

// ── shared helpers ─────────────────────────────────────────────────────────

/**
 * Refuse a write when the file changed on disk after the agent read it —
 * usually because the user edited it in their editor mid-turn.
 */
async function checkFreshness(
  absolute: string,
  relative: string,
  context: ToolContext,
): Promise<ToolResult | null> {
  if (!context.config.detectStaleWrites || !context.fileTracker) return null;
  const check = await context.fileTracker.check(absolute);
  if (check.verdict !== 'stale') return null;
  return toolError(staleWriteMessage(relative), { summary: 'file changed on disk' });
}

/** Record the mtime Orbit just produced so its own write is not seen as stale. */
async function noteWritten(absolute: string, context: ToolContext): Promise<void> {
  if (!context.fileTracker) return;
  const stat = await statOrNull(absolute);
  if (stat) context.fileTracker.noteWrite(absolute, stat.mtimeMs, stat.size);
}

export async function readIfExists(absolute: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(absolute);
    if (looksBinary(buffer)) {
      throw new SandboxError(`${path.basename(absolute)} is a binary file; Orbit will not edit it.`);
    }
    return buffer.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SandboxError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return null;
    throw error;
  }
}

export async function statOrNull(absolute: string) {
  try {
    return await fs.stat(absolute);
  } catch {
    return null;
  }
}

async function countEntries(dir: string): Promise<number> {
  try {
    return (await fs.readdir(dir)).length;
  } catch {
    return 0;
  }
}

/** A NUL byte in the first 8 KB is a reliable enough signal of binary content. */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function previewNewFile(relative: string, content: string): string {
  const lines = normalizeEol(content).split('\n').slice(0, 60);
  return [`--- /dev/null`, `+++ ${relative}`, `@@ new file @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

export const filesystemTools: Tool[] = [
  listFilesTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  moveFileTool,
];
