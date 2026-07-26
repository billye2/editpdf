// Bundled look-alike fallback fonts (Gelasio serif / Liberation Sans): when
// registered, they replace the standard-14 tier for fallback words — fixing
// the news-site case (serif headlines degrading into Times) and lifting the
// WinAnsi ceiling (Latin-Ext etc. were hard rejects before).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { EditableDocument } from '../src/engine/document';
import { registerFallbackFonts, clearFallbackFonts } from '../src/engine/fonts/fallback-fonts';
import { makeSimplePdf } from './helpers';

const FONT_DIR = 'public/fonts/fallback';

beforeAll(() => {
  registerFallbackFonts({
    'serif-regular': readFileSync(`${FONT_DIR}/Gelasio-Regular.ttf`),
    'serif-bold': readFileSync(`${FONT_DIR}/Gelasio-Bold.ttf`),
    'serif-italic': readFileSync(`${FONT_DIR}/Gelasio-Italic.ttf`),
    'serif-bolditalic': readFileSync(`${FONT_DIR}/Gelasio-BoldItalic.ttf`),
    'sans-regular': readFileSync(`${FONT_DIR}/LiberationSans-Regular.ttf`),
    'sans-bold': readFileSync(`${FONT_DIR}/LiberationSans-Bold.ttf`),
    'sans-italic': readFileSync(`${FONT_DIR}/LiberationSans-Italic.ttf`),
    'sans-bolditalic': readFileSync(`${FONT_DIR}/LiberationSans-BoldItalic.ttf`),
  });
});

// registry is module-level state — don't leak into other test files' behavior
afterAll(() => clearFallbackFonts());

async function makeBoldSerifPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRomanBold);
  page.drawText('An Important Bold Headline', { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

async function extractText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdoc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  const content = await (await pdoc.getPage(1)).getTextContent();
  const text = content.items.map((i) => ('str' in i ? (i as { str: string }).str : '')).join(' ');
  await pdoc.destroy();
  return text;
}

function fontNamesIn(bytes: Uint8Array): string {
  // BaseFont names appear as plain /Name tokens in the saved file
  return new TextDecoder('latin1').decode(bytes);
}

describe('bundled fallback fonts', () => {
  it('uses the bundled serif (not Times) for fallback words in a serif doc, beyond WinAnsi', async () => {
    const bytes = await makeBoldSerifPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const para = view.paragraphs.find((p) => p.text.includes('Headline'))!;

    // Świętokrzyska: ś/ę are Latin Extended-A — a hard reject under WinAnsi
    const result = await doc!.editParagraph(0, para.id, 'An Important Świętokrzyska Headline');
    expect(result.status).not.toBe('error');
    expect(result.usedFallback).toBe(true);
    expect(result.message).toMatch(/substitute font was used/);

    // the substituted face is the bundled bold serif, embedded as a subset
    const raw = fontNamesIn(result.bytes!);
    expect(raw).toContain('Gelasio-Bold');
    expect(raw).not.toContain('Gelasio-Regular');

    // a third-party extractor sees the new text intact
    const text = await extractText(result.bytes!);
    expect(text).toContain('Świętokrzyska');
  });

  it('uses the bundled sans for fallback words in a sans doc', async () => {
    const bytes = await makeSimplePdf({ text: 'Warsaw central station' });
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const para = view.paragraphs[0];

    const result = await doc!.editParagraph(0, para.id, 'Łódź Fabryczna station');
    expect(result.status).not.toBe('error');
    expect(result.usedFallback).toBe(true);
    expect(fontNamesIn(result.bytes!)).toContain('LiberationSans');
    expect(await extractText(result.bytes!)).toContain('Łódź');
  });

  it('still rejects characters missing from both tiers (CJK)', async () => {
    const bytes = await makeSimplePdf({ text: 'Plain sans text' });
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];

    const result = await doc!.editParagraph(0, para.id, 'Plain 恐竜 text');
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/isn't supported/);
  });

  it('round-trips a second edit after a bundled-fallback edit (subset accumulates)', async () => {
    const bytes = await makeSimplePdf({ text: 'First body line' });
    const { doc } = await EditableDocument.load(bytes);
    let para = doc!.getPageView(0).paragraphs[0];

    const r1 = await doc!.editParagraph(0, para.id, 'Kraków body line');
    expect(r1.status).not.toBe('error');
    para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('Kraków'))!;
    const r2 = await doc!.editParagraph(0, para.id, 'Kraków and Gdańsk line');
    expect(r2.status).not.toBe('error');
    expect(await extractText(r2.bytes!)).toContain('Gdańsk');
  });
});
