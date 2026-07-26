// Independent verification with pdf.js: after an edit, a THIRD-PARTY extractor
// must still see spaces between words. This is the regression test for the
// "all spaces are gone after an edit" bug (per-word Tj ops without real space
// glyphs render fine but extract as run-together words).

import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { makeParagraphPdf } from './helpers';

async function extractTextWithPdfJs(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  // join with NO separator: spaces must come from real space glyphs in the
  // PDF, not from this test stitching items together
  const text = content.items
    .map((i) =>
      'str' in i ? (i as { str: string; hasEOL?: boolean }).str + ((i as { hasEOL?: boolean }).hasEOL ? '\n' : '') : '',
    )
    .join('')
    .replace(/\s+/g, ' ');
  await doc.destroy();
  return text;
}

describe('third-party text extraction after edits', () => {
  it('pdf.js still sees spaces between words in an edited paragraph', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('quick brown fox'))!;
    const result = await doc!.editParagraph(0, para.id, para.text.replace('fox', 'velociraptor'));
    expect(result.status).not.toBe('error');

    const extracted = await extractTextWithPdfJs(result.bytes!);
    expect(extracted).toContain('quick brown velociraptor jumps over the lazy dog');
    expect(extracted).toContain('A second paragraph');
    expect(extracted).not.toMatch(/velociraptorjumps|brownvelociraptor/);
  });

  it('emitted runs contain real space glyphs (grouped words, not per-word ops)', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('quick brown fox'))!;
    const result = await doc!.editParagraph(0, para.id, para.text.replace('fox', 'velociraptor'));

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const runs = doc2!.getPageView(0).runs.filter((r) => r.renderMode !== 3);
    // whole lines should now be single runs containing spaces
    const spacey = runs.filter((r) => r.text.includes(' '));
    expect(spacey.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.text.includes('velociraptor jumps'))).toBe(true);
  });
});
