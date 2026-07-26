import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { makeParagraphPdf, makeOcrPdf, makeSimplePdf } from './helpers';

describe('end-to-end editing', () => {
  it('replaces a word 1→3 characters longer and reflows within the paragraph box', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const para = view.paragraphs.find((p) => p.text.includes('quick brown fox'))!;
    const newText = para.text.replace('fox', 'velociraptor');

    const result = await doc!.editParagraph(0, para.id, newText);
    expect(result.status).not.toBe('error');
    expect(result.bytes).toBeTruthy();

    // independent check: re-load the saved bytes from scratch
    const { doc: doc2, outcome } = await EditableDocument.load(result.bytes!);
    expect(outcome.ok).toBe(true);
    const view2 = doc2!.getPageView(0);
    const para2 = view2.paragraphs.find((p) => p.text.includes('velociraptor'))!;
    expect(para2).toBeTruthy();
    expect(para2.text).not.toContain(' fox ');
    // reflowed text must stay within the original box width (small tolerance)
    expect(para2.bbox.x).toBeGreaterThan(para.bbox.x - 2);
    expect(para2.bbox.w).toBeLessThan(para.bbox.w + para.fontSize);
    // the second paragraph must be untouched
    expect(view2.paragraphs.some((p) => p.text.startsWith('A second'))).toBe(true);
  });

  it('deletes a paragraph, leaving the other intact; undo restores it', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const target = view.paragraphs.find((p) => p.text.includes('quick brown fox'))!;

    const result = await doc!.deleteParagraph(0, target.id);
    expect(result.status).toBe('ok');

    // independent check on freshly re-loaded bytes
    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const view2 = doc2!.getPageView(0);
    expect(view2.paragraphs.some((p) => p.text.includes('quick brown fox'))).toBe(false);
    const second = view2.paragraphs.find((p) => p.text.startsWith('A second'))!;
    expect(second).toBeTruthy();
    // the surviving paragraph must not have moved (removeShowOps keeps side effects)
    const secondBefore = view.paragraphs.find((p) => p.text.startsWith('A second'))!;
    expect(second.bbox.x).toBeCloseTo(secondBefore.bbox.x, 1);
    expect(second.bbox.y).toBeCloseTo(secondBefore.bbox.y, 1);

    // third-party extractor agrees (invariant 8)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdoc = await pdfjs.getDocument({ data: result.bytes!.slice(), useSystemFonts: true }).promise;
    const content = await (await pdoc.getPage(1)).getTextContent();
    const text = content.items.map((i) => ('str' in i ? (i as { str: string }).str : '')).join(' ');
    await pdoc.destroy();
    expect(text).not.toContain('quick brown fox');
    expect(text).toContain('A second paragraph');

    // undo brings the paragraph back
    const undone = await doc!.undo();
    expect(undone).toBeTruthy();
    expect(doc!.getPageView(0).paragraphs.some((p) => p.text.includes('quick brown fox'))).toBe(true);
  });

  it('keeps unedited words in their original font', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const para = view.paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, para.text.replace('dog', 'dinosaur'));
    expect(result.status).not.toBe('error');
    expect(result.usedFallback).toBe(false); // 'dinosaur' chars all exist in the doc font
  });

  it('rejects characters no font can encode', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, para.text.replace('dog', '恐竜'));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/isn't supported|not supported/i);
  });

  it('patch-over edits an OCR word: visible replacement + old invisible text gone', async () => {
    const bytes = await makeOcrPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const word = view.ocrWords.find((w) => w.text === 'Number')!;

    const result = await doc!.editOcrWord(0, word.runId, 'Reference', [0.96, 0.95, 0.93]);
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const view2 = doc2!.getPageView(0);
    // old invisible word gone; replacement is now VISIBLE text (serves as the new text layer)
    expect(view2.ocrWords.map((w) => w.text)).not.toContain('Number');
    const visible = view2.runs.filter((r) => r.renderMode !== 3).map((r) => r.text);
    expect(visible).toContain('Reference');
    // remaining OCR words intact
    expect(view2.ocrWords.map((w) => w.text)).toEqual(expect.arrayContaining(['Invoice', '12345']));
  });

  it('undo restores the previous content', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, para.text.replace('fox', 'wolf'));
    expect(result.status).not.toBe('error');
    expect(doc!.canUndo()).toBe(true);
    const undone = await doc!.undo();
    expect(undone).toBeTruthy();
    const { doc: doc2 } = await EditableDocument.load(undone!);
    expect(doc2!.getPageView(0).paragraphs[0].text).toContain('fox');
  });

  it('zero-change round trip: load + save still renders the same text', async () => {
    const bytes = await makeSimplePdf({ text: 'Stability check 123', x: 100, y: 500 });
    const { doc } = await EditableDocument.load(bytes);
    const saved = await doc!.save();
    const { doc: doc2 } = await EditableDocument.load(saved);
    const texts = doc2!
      .getPageView(0)
      .runs.map((r) => r.text)
      .join('');
    expect(texts).toContain('Stability check 123');
  });
});
