/**
 * Build a small, valid PDF in memory so the PDF tool can be tested without
 * committing a binary fixture.
 */
export function buildPdf(pages: string[], title = 'Orbit Test Document'): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;

  // 1: catalog, 2: pages, 3: font, then one page object and one content
  // stream per page.
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const contentObjectIds = pages.map((_, index) => 5 + index * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pages.forEach((text, index) => {
    const pageId = pageObjectIds[index]!;
    const contentId = contentObjectIds[index]!;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';

    const lines = text.split('\n');
    const body = [
      'BT',
      '/F1 14 Tf',
      '72 720 Td',
      '18 TL',
      ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');
    objects[contentId] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  });

  const infoId = objects.length;
  objects[infoId] = `<< /Title (${escapePdfText(title)}) /Author (Orbit Tests) >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id++) {
    const object = objects[id];
    if (!object) continue;
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  const maxId = objects.length;
  pdf += `xref\n0 ${maxId}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id < maxId; id++) {
    const offset = offsets[id] ?? 0;
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}
