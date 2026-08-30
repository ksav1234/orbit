import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool } from './registry.js';
import { clampChars, formatBytes, pluralize } from '../util/format.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('tools:pdf');

export interface PdfPage {
  number: number;
  text: string;
}

export interface PdfDocument {
  pageCount: number;
  pages: PdfPage[];
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
  };
  totalCharacters: number;
  /** True when the document has no usable text layer (likely scanned). */
  scanned: boolean;
}

let pdfjsModule: any | null = null;

async function loadPdfjs(): Promise<any> {
  if (pdfjsModule) return pdfjsModule;

  // The legacy build is the one that runs under plain Node. pdf.js still wants
  // a worker entry point even when it falls back to running in-process, so
  // point it at the worker file that ships with the package.
  const module = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const lib = (module as any).default ?? module;

  if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    try {
      const require = createRequire(import.meta.url);
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    } catch (error) {
      log.warn('could not resolve the pdf.js worker; extraction may fail', {
        error: String(error),
      });
    }
  }

  pdfjsModule = lib;
  return lib;
}

export interface ExtractOptions {
  pageNumbers?: number[];
  maxPages?: number;
  signal?: AbortSignal;
  onProgress?: (page: number, total: number) => void;
}

export async function extractPdf(
  filePath: string,
  options: ExtractOptions = {},
): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fs.readFile(filePath));

  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const document = await task.promise;

  const pageCount: number = document.numPages;
  const requested =
    options.pageNumbers && options.pageNumbers.length > 0
      ? options.pageNumbers.filter((n) => n >= 1 && n <= pageCount)
      : Array.from({ length: Math.min(pageCount, options.maxPages ?? pageCount) }, (_, i) => i + 1);

  const pages: PdfPage[] = [];
  let totalCharacters = 0;

  for (const number of requested) {
    if (options.signal?.aborted) break;
    options.onProgress?.(number, requested.length);
    try {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = joinTextItems(content.items as Array<Record<string, unknown>>);
      totalCharacters += text.length;
      pages.push({ number, text });
      page.cleanup();
    } catch (error) {
      log.warn('failed to extract a page', { page: number, error: String(error) });
      pages.push({ number, text: '' });
    }
  }

  let metadata: PdfDocument['metadata'] = {};
  try {
    const meta = await document.getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    metadata = {
      title: asString(info.Title),
      author: asString(info.Author),
      subject: asString(info.Subject),
      creator: asString(info.Creator),
      producer: asString(info.Producer),
      creationDate: asString(info.CreationDate),
    };
  } catch {
    metadata = {};
  }

  await document.destroy();

  // A scanned document yields essentially nothing on every page. Judging by a
  // per-page average would misclassify short but genuine text pages.
  const pagesWithText = pages.filter((page) => page.text.trim().length >= 8).length;

  return {
    pageCount,
    pages,
    metadata,
    totalCharacters,
    scanned: pages.length > 0 && pagesWithText === 0,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * pdf.js returns positioned text runs. Reassemble lines using the vertical
 * position so the extracted text keeps its reading order.
 */
function joinTextItems(items: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  let currentY: number | null = null;
  let current = '';

  for (const item of items) {
    const str = typeof item.str === 'string' ? item.str : '';
    const transform = item.transform as number[] | undefined;
    const y = transform?.[5];

    if (currentY !== null && typeof y === 'number' && Math.abs(y - currentY) > 2) {
      lines.push(current.trimEnd());
      current = '';
    }
    current += str;
    if (item.hasEOL === true) {
      lines.push(current.trimEnd());
      current = '';
      currentY = null;
    } else if (typeof y === 'number') {
      currentY = y;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());

  return lines
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse "1-5", "3", "2,7,9-11" into a page number list. */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.min(pageCount, Number(range[2]));
      for (let i = start; i <= end; i++) out.add(i);
    } else {
      const single = Number(trimmed);
      if (Number.isInteger(single) && single >= 1 && single <= pageCount) out.add(single);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Score pages against a query so large documents send only relevant sections
 * to the model instead of the whole text.
 */
export function rankPages(pages: PdfPage[], query: string, limit: number): PdfPage[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
  if (terms.length === 0) return pages.slice(0, limit);

  const scored = pages.map((page) => {
    const haystack = page.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let index = haystack.indexOf(term);
      while (index !== -1) {
        score += 1;
        index = haystack.indexOf(term, index + term.length);
      }
    }
    // Reward pages matching several distinct terms over one repeated term.
    const distinct = terms.filter((term) => haystack.includes(term)).length;
    return { page, score: score + distinct * 5 };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.number - b.page.number)
    .slice(0, limit)
    .map((entry) => entry.page)
    .sort((a, b) => a.number - b.number);
}

const pdfSchema = z.object({
  path: z.string().describe('PDF file to read, relative to the workspace root.'),
  pages: z
    .string()
    .optional()
    .describe('Page selection such as "1-5", "3" or "2,8-10". Defaults to the most relevant pages.'),
  query: z
    .string()
    .optional()
    .describe('What to look for. Pages are ranked by relevance to this text.'),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(12)
    .describe('Maximum number of pages to include in the result.'),
});

export const readPdfTool: Tool = defineTool({
  name: 'read_pdf',
  description:
    'Extract text and metadata from a PDF. For long documents, pass a query so only the most relevant pages are returned instead of the whole file.',
  parameters: pdfSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);
    if (path.extname(resolved.absolute).toLowerCase() !== '.pdf') {
      return toolError(`${resolved.relative} is not a PDF. Use read_file instead.`);
    }

    let stat;
    try {
      stat = await fs.stat(resolved.absolute);
    } catch {
      return toolError(`PDF not found: ${resolved.relative}`);
    }

    context.progress(`Extracting ${resolved.relative}`);

    let document: PdfDocument;
    try {
      document = await extractPdf(resolved.absolute, {
        signal: context.signal,
        onProgress: (page, total) => context.progress(`Extracting page ${page}/${total}`),
      });
    } catch (error) {
      return toolError(
        `Could not read ${resolved.relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (document.scanned) {
      const ocr = await tryOcrHint();
      return toolError(
        `${resolved.relative} has ${pluralize(document.pageCount, 'page')} but no extractable text layer — it is most likely a scanned document. ${ocr}`,
        { kind: 'pdf', summary: `${resolved.relative} — ${document.pageCount} pages, no text layer` },
      );
    }

    let selected: PdfPage[];
    let selectionNote: string;

    if (args.pages) {
      const numbers = parsePageRange(args.pages, document.pageCount);
      selected = document.pages.filter((p) => numbers.includes(p.number));
      selectionNote = `pages ${args.pages}`;
    } else if (args.query) {
      selected = rankPages(document.pages, args.query, args.max_pages);
      selectionNote =
        selected.length > 0
          ? `${pluralize(selected.length, 'page')} most relevant to "${args.query}"`
          : `no page matched "${args.query}"`;
      if (selected.length === 0) selected = document.pages.slice(0, Math.min(3, args.max_pages));
    } else {
      selected = document.pages.slice(0, args.max_pages);
      selectionNote =
        document.pageCount > selected.length
          ? `first ${pluralize(selected.length, 'page')} of ${document.pageCount}`
          : `all ${pluralize(document.pageCount, 'page')}`;
    }

    const meta = document.metadata;
    const header = [
      `${resolved.relative}`,
      `${pluralize(document.pageCount, 'page')}, ${document.totalCharacters.toLocaleString()} characters extracted, ${formatBytes(stat.size)}`,
      meta.title ? `Title: ${meta.title}` : '',
      meta.author ? `Author: ${meta.author}` : '',
      `Included: ${selectionNote}`,
    ]
      .filter(Boolean)
      .join('\n');

    const body = selected
      .map((page) => `--- page ${page.number} ---\n${page.text || '(no text on this page)'}`)
      .join('\n\n');

    const clamped = clampChars(body, context.config.maxFileReadChars);
    const summary = `${resolved.relative} — ${pluralize(document.pageCount, 'page')}, ${document.totalCharacters.toLocaleString()} characters`;

    return toolOk(
      `${header}\n\n${clamped.text}`,
      {
        kind: 'pdf',
        summary,
        lines: [
          `${pluralize(document.pageCount, 'page')}`,
          `${document.totalCharacters.toLocaleString()} characters extracted`,
          selectionNote,
        ],
        detail: clamped.text,
      },
      {
        metadata: {
          pageCount: document.pageCount,
          characters: document.totalCharacters,
          includedPages: selected.map((p) => p.number),
          truncated: clamped.truncated,
        },
      },
    );
  },
});

/** OCR is optional: report honestly whether it is available rather than guessing. */
async function tryOcrHint(): Promise<string> {
  try {
    const specifier = 'tesseract.js';
    await import(/* @vite-ignore */ specifier);
    return 'OCR support is installed; rasterised extraction is not enabled in this build.';
  } catch {
    return 'Install an OCR tool (for example `npm i tesseract.js`) or supply a text-based version of the document.';
  }
}

export const pdfTools: Tool[] = [readPdfTool];
