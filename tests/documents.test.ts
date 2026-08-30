import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdf, readPdfTool } from '../src/tools/pdf.js';
import { readImageTool } from '../src/tools/image.js';
import { buildPdf } from './make-pdf.js';
import { makeTempWorkspace, makeToolContext, removeTempWorkspace } from './helpers.js';

let root = '';

beforeEach(async () => {
  root = await makeTempWorkspace('orbit-docs-');
});

afterEach(async () => {
  await removeTempWorkspace(root);
});

describe('pdf extraction', () => {
  it('extracts text, page count and metadata from a real PDF', async () => {
    const file = path.join(root, 'report.pdf');
    await fs.writeFile(
      file,
      buildPdf(
        [
          'Introduction\nThis document describes the system.',
          'Findings\nThe authentication middleware checks the session before it is initialised.',
          'Appendix\nNothing of note.',
        ],
        'Security Report',
      ),
    );

    const document = await extractPdf(file);

    expect(document.pageCount).toBe(3);
    expect(document.scanned).toBe(false);
    expect(document.metadata.title).toBe('Security Report');
    expect(document.pages[1]?.text).toContain('authentication middleware');
    expect(document.totalCharacters).toBeGreaterThan(50);
  });

  it('returns only the most relevant pages for a query', async () => {
    const file = path.join(root, 'big.pdf');
    const pages = Array.from({ length: 12 }, (_, i) =>
      i === 7
        ? 'Session fixation vulnerability in the authentication flow.'
        : `Filler page ${i} with unrelated prose about deployment.`,
    );
    await fs.writeFile(file, buildPdf(pages));

    const context = makeToolContext({ root });
    const args = readPdfTool.parse({
      path: 'big.pdf',
      query: 'authentication session fixation',
      max_pages: 2,
    });
    const result = await readPdfTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('Session fixation vulnerability');
    expect(result.metadata?.pageCount).toBe(12);
    expect(result.metadata?.includedPages).toEqual([8]);
  });

  it('honours an explicit page range', async () => {
    const file = path.join(root, 'ranged.pdf');
    await fs.writeFile(file, buildPdf(['alpha page', 'beta page', 'gamma page', 'delta page']));

    const context = makeToolContext({ root });
    const args = readPdfTool.parse({ path: 'ranged.pdf', pages: '2-3' });
    const result = await readPdfTool.execute(args, context);

    expect(result.content).toContain('beta page');
    expect(result.content).toContain('gamma page');
    expect(result.content).not.toContain('delta page');
  });

  it('refuses a non-PDF file', async () => {
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    const context = makeToolContext({ root });
    const args = readPdfTool.parse({ path: 'notes.txt' });
    const result = await readPdfTool.execute(args, context);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a PDF/);
  });
});

describe('image tool', () => {
  const png = (() => {
    // 1×1 transparent PNG.
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
  })();

  it('attaches an image when the model supports vision', async () => {
    await fs.writeFile(path.join(root, 'diagram.png'), png);
    const context = makeToolContext({ root, visionAvailable: true });
    const args = readImageTool.parse({ path: 'diagram.png' });
    const result = await readImageTool.execute(args, context);

    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mediaType).toBe('image/png');
    expect(result.metadata?.width).toBe(1);
  });

  it('refuses, rather than pretends, when the model has no vision support', async () => {
    await fs.writeFile(path.join(root, 'diagram.png'), png);
    const context = makeToolContext({ root, visionAvailable: false });
    const args = readImageTool.parse({ path: 'diagram.png' });
    const result = await readImageTool.execute(args, context);

    expect(result.ok).toBe(false);
    expect(result.images).toBeUndefined();
    expect(result.error).toMatch(/does not support image input/);
  });

  it('rejects an unsupported file type', async () => {
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    const context = makeToolContext({ root, visionAvailable: true });
    const args = readImageTool.parse({ path: 'notes.txt' });
    const result = await readImageTool.execute(args, context);

    expect(result.ok).toBe(false);
  });
});
