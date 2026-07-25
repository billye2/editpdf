// Regression tests for "the font is lost after editing a header": embedded
// Type0/CID fonts must keep the ORIGINAL font for new characters whenever the
// embedded font program actually contains their glyphs. Only genuinely pruned
// subset fonts may fall back (with an explanatory message).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream } from 'pdf-lib';
import * as pdfLib from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { EditableDocument } from '../src/engine/document';
import { parseToUnicode } from '../src/engine/fonts/encoding';
import { generateToUnicodeCMap } from '../src/engine/fonts/font-info';

const ARIAL_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const haveFont = existsSync(ARIAL_BOLD);

async function makeCidPdf(subset: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(readFileSync(ARIAL_BOLD), { subset });
  page.drawText('Quarterly Report', { x: 72, y: 700, size: 16, font });
  return doc.save({ useObjectStreams: false });
}

/** Replace the Type0 font's complete ToUnicode with a sparse one that covers
 *  only the characters actually used — like most real-world generators. */
async function sparsifyToUnicode(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const page = doc.getPage(0);
  const res = (page.node as unknown as { Resources: () => PDFDict }).Resources();
  const fontDict = ctx.lookup(res.get(PDFName.of('Font'))) as PDFDict;
  for (const [, ref] of fontDict.entries()) {
    const fd = ctx.lookup(ref) as PDFDict;
    const subtype = fd.get(PDFName.of('Subtype'));
    if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Type0') continue;
    const tuVal = fd.get(PDFName.of('ToUnicode'));
    const tuStream = (tuVal instanceof PDFRef ? ctx.lookup(tuVal) : tuVal) as PDFRawStream;
    const dec = (pdfLib as unknown as { decodePDFRawStream: (s: PDFRawStream) => { decode(): Uint8Array } })
      .decodePDFRawStream;
    const full = parseToUnicode(dec(tuStream).decode());
    const used = new Set('Quarterly Report');
    const sparse = new Map<number, string>();
    for (const [code, u] of full) if (used.has(u)) sparse.set(code, u);
    expect(sparse.size).toBeGreaterThan(5);
    const newStream = ctx.flateStream(generateToUnicodeCMap(sparse));
    fd.set(PDFName.of('ToUnicode'), ctx.register(newStream));
  }
  return doc.save({ useObjectStreams: false });
}

async function extractWithPdfJs(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((i) => ('str' in i ? i.str : '')).join('');
  await doc.destroy();
  return text;
}

describe.skipIf(!haveFont)('CID font preservation on edit', () => {
  it('full-embedded font with SPARSE ToUnicode: new chars keep the original font', async () => {
    const bytes = await sparsifyToUnicode(await makeCidPdf(false));
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    expect(para.text).toBe('Quarterly Report');

    // 'Z' and 'b' were never used in the document — the sparse ToUnicode
    // can't encode them; only the embedded font's cmap can.
    const result = await doc!.editParagraph(0, para.id, 'Quarterly Zebra');
    expect(result.status).toBe('ok');
    expect(result.usedFallback).toBe(false); // ← original font kept

    // engine re-parse of saved bytes decodes the extended codes
    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const view2 = doc2!.getPageView(0);
    expect(view2.paragraphs[0].text).toBe('Quarterly Zebra');

    // extended-code widths came from hmtx, not the DW=1000 default: the run
    // width must match ground truth measured directly from the TTF
    const zebraRun = view2.runs.find((r) => r.text.includes('Zebra'))!;
    const tt = fontkit.create(readFileSync(ARIAL_BOLD) as unknown as Parameters<typeof fontkit.create>[0]);
    let exact = 0;
    for (const ch of 'Quarterly Zebra') {
      exact += (tt.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth / tt.unitsPerEm) * 16;
    }
    expect(Math.abs(zebraRun.bbox.w - exact)).toBeLessThan(2);

    // independent check: pdf.js reads the flushed ToUnicode
    const extracted = await extractWithPdfJs(result.bytes!);
    expect(extracted).toContain('Quarterly Zebra');
  });

  it('full-embedded font WITHOUT any new chars: unchanged path still works', async () => {
    const bytes = await makeCidPdf(false);
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, 'Report Quarterly');
    expect(result.status).toBe('ok');
    expect(result.usedFallback).toBe(false);
  });

  it('serves embedded font bytes for overlay styling (and null for standard fonts)', async () => {
    const bytes = await makeCidPdf(false);
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const fb = doc!.getEmbeddedFontBytes(0, para.fontRes, para.text);
    expect(fb).toBeTruthy();
    expect(fb!.length).toBeGreaterThan(10000); // a real TTF program

    // standard-14 fonts have no embedded program — overlay falls back to look-alikes
    const { makeParagraphPdf } = await import('./helpers');
    const { doc: stdDoc } = await EditableDocument.load(await makeParagraphPdf());
    const stdPara = stdDoc!.getPageView(0).paragraphs[0];
    expect(stdDoc!.getEmbeddedFontBytes(0, stdPara.fontRes, stdPara.text)).toBeNull();
  });

  it('pruned SUBSET font: falls back safely with an explanatory message', async () => {
    const bytes = await makeCidPdf(true);
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, 'Quarterly Zebra');
    expect(result.status).toBe('ok');
    expect(result.usedFallback).toBe(true); // glyphs genuinely absent from the subset
    expect(result.message).toMatch(/standard font was substituted/);
    // matched word must still be in the original font; text intact either way
    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    expect(doc2!.getPageView(0).paragraphs[0].text).toBe('Quarterly Zebra');
  });
});
