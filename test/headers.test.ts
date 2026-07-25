// Regression tests for the "short header loses its line break" bug: a short
// heading directly above a paragraph must be its own block, and editing it
// must not merge it into (or disturb) the body below.

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EditableDocument } from '../src/engine/document';

async function makeHeaderPdf(headerSize: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // short header immediately above the body, tight leading (old clustering merged these)
  page.drawText('Quarterly Report', { x: 72, y: 700, size: headerSize, font });
  const body = [
    'Revenue grew steadily across all regions this quarter with',
    'particularly strong performance in the northern markets and',
    'a modest but consistent improvement in customer retention.',
  ];
  let y = 700 - headerSize * 1.3;
  for (const line of body) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 14.4;
  }
  return doc.save({ useObjectStreams: false });
}

describe('header/paragraph separation', () => {
  it('keeps a same-size short header as its own paragraph', async () => {
    const bytes = await makeHeaderPdf(12);
    const { doc } = await EditableDocument.load(bytes);
    const paras = doc!.getPageView(0).paragraphs;
    expect(paras.length).toBe(2);
    expect(paras.some((p) => p.text === 'Quarterly Report')).toBe(true);
    expect(paras.some((p) => p.text.startsWith('Revenue grew'))).toBe(true);
  });

  it('keeps a larger-font header as its own paragraph', async () => {
    const bytes = await makeHeaderPdf(16);
    const { doc } = await EditableDocument.load(bytes);
    const paras = doc!.getPageView(0).paragraphs;
    expect(paras.some((p) => p.text === 'Quarterly Report')).toBe(true);
    expect(paras.some((p) => p.text.startsWith('Revenue grew'))).toBe(true);
  });

  it('editing the header keeps its line break and leaves the body untouched', async () => {
    const bytes = await makeHeaderPdf(12);
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const header = view.paragraphs.find((p) => p.text === 'Quarterly Report')!;
    const bodyBefore = view.paragraphs.find((p) => p.text.startsWith('Revenue grew'))!.text;

    const result = await doc!.editParagraph(0, header.id, 'Quarterly Financial Report');
    expect(result.status).toBe('ok'); // header may grow — width extension, no shrink

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const view2 = doc2!.getPageView(0);
    const header2 = view2.paragraphs.find((p) => p.text === 'Quarterly Financial Report')!;
    expect(header2).toBeTruthy();
    expect(header2.lineCount).toBe(1); // still its own single line
    const body2 = view2.paragraphs.find((p) => p.text.startsWith('Revenue grew'))!;
    expect(body2.text).toBe(bodyBefore); // body byte-for-byte untouched
  });

  it('keeps a LONG bold header separate from the body (dominant-font rule)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    // header nearly as wide as the body, same size, tight leading — only the
    // bold font distinguishes it
    page.drawText('Second Section With A Much Longer Title Here', { x: 72, y: 700, size: 12, font: bold });
    page.drawText('A body line that follows immediately below with text', { x: 72, y: 685, size: 12, font });
    page.drawText('and one more body line to make it a real paragraph.', { x: 72, y: 670.6, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });

    const { doc: edoc } = await EditableDocument.load(bytes);
    const paras = edoc!.getPageView(0).paragraphs;
    expect(paras.length).toBe(2);
    expect(paras.some((p) => p.text === 'Second Section With A Much Longer Title Here')).toBe(true);
  });

  it('editing the body does not swallow the header', async () => {
    const bytes = await makeHeaderPdf(12);
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const body = view.paragraphs.find((p) => p.text.startsWith('Revenue grew'))!;

    const result = await doc!.editParagraph(0, body.id, body.text.replace('modest', 'remarkable'));
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const paras2 = doc2!.getPageView(0).paragraphs;
    expect(paras2.some((p) => p.text === 'Quarterly Report')).toBe(true);
    expect(paras2.some((p) => p.text.includes('remarkable'))).toBe(true);
  });
});
