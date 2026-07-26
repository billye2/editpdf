// Regression for "typing lots of text garbles the page": overflow lines used
// to be placed straight through the content below the paragraph (status
// 'overflow-flagged'), rendering as interleaved text. Now a paragraph may grow
// only into measured free space below it; an edit that still doesn't fit is
// REJECTED with a clear error and the document is left untouched.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { EditableDocument } from '../src/engine/document';
import { makeParagraphPdf } from './helpers';

const LOTS = Array.from({ length: 80 }, (_, i) => `overflow${i} filler words`).join(' ');

describe('paragraph overflow protection', () => {
  it('rejects an edit that cannot fit above the next paragraph', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const first = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('quick brown fox'))!;

    const result = await doc!.editParagraph(0, first.id, first.text + ' ' + LOTS);
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/overlap/i);
    // nothing written, nothing on the undo stack
    expect(doc!.canUndo()).toBe(false);
    expect(doc!.getPageView(0).paragraphs.some((p) => p.text.includes('quick brown fox'))).toBe(true);
  });

  it('lets the last paragraph grow into the empty space below it', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const last = view.paragraphs.find((p) => p.text.startsWith('A second'))!;

    // several extra lines' worth of text — fits easily in the blank half-page below
    const extra = last.text + ' ' + Array.from({ length: 30 }, (_, i) => `grow${i}`).join(' ');
    const result = await doc!.editParagraph(0, last.id, extra);
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const grown = doc2!.getPageView(0).paragraphs.find((p) => p.text.includes('grow0'))!;
    expect(grown).toBeTruthy();
    expect(grown.lineCount).toBeGreaterThan(last.lineCount);
  });

  it('grown text never overlaps the paragraph below', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const first = view.paragraphs.find((p) => p.text.includes('quick brown fox'))!;

    // add a little text — allowed to use the inter-paragraph gap, not more
    const result = await doc!.editParagraph(0, first.id, first.text + ' plus a few extra trailing words here');
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const v2 = doc2!.getPageView(0);
    const editedPara = v2.paragraphs.find((p) => p.text.includes('trailing'))!;
    const secondAfter = v2.paragraphs.find((p) => p.text.startsWith('A second'))!;
    const secondTop = secondAfter.bbox.y + secondAfter.bbox.h;
    // edited paragraph's bottom edge stays above the second paragraph's top
    expect(editedPara.bbox.y).toBeGreaterThan(secondTop - 1);
  });
});

const CORPUS = 'test/corpus-EDIT_SAMPLE.pdf';

describe.skipIf(!existsSync(CORPUS))('overflow protection on the corpus document', () => {
  it('rejects the garbling headline edit from the bug report', async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS));
    const { doc } = await EditableDocument.load(bytes);
    const head = doc!.getPageView(0).paragraphs.find((p) => p.text.startsWith('Iranian Threat'))!;
    const junk = head.text.replace('Threat to', 'Threat t jhj hj hjkh jhjkhjk hj hjkhjk hjk hjk hjk hjkh jkhjh jh jko');
    const result = await doc!.editParagraph(0, head.id, junk);
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/overlap/i);
  });

  it('still allows a small headline edit', async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS));
    const { doc } = await EditableDocument.load(bytes);
    const head = doc!.getPageView(0).paragraphs.find((p) => p.text.startsWith('Iranian Threat'))!;
    const result = await doc!.editParagraph(0, head.id, head.text.replace('Iranian', 'Persian'));
    expect(result.status).not.toBe('error');
  });
});
