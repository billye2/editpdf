// Text-color edits: paragraph color override, color-only edits, undo, and
// OCR patch text color.

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { EditableDocument } from '../src/engine/document';
import { makeParagraphPdf, makeOcrPdf } from './helpers';

const RED: [number, number, number] = [0.8, 0, 0];
const BLUE: [number, number, number] = [0, 0, 0.8];

describe('text color edits', () => {
  it('applies a color override with a text change', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('fox'))!;
    const result = await doc!.editParagraph(0, para.id, para.text.replace('fox', 'wolf'), RED);
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const view2 = doc2!.getPageView(0);
    const edited = view2.paragraphs.find((p) => p.text.includes('wolf'))!;
    expect(edited.color[0]).toBeCloseTo(0.8, 2);
    expect(edited.color[1]).toBeCloseTo(0, 2);
    // the other paragraph keeps its original black
    const other = view2.paragraphs.find((p) => p.text.startsWith('A second'))!;
    expect(other.color[0]).toBeCloseTo(0, 2);
  });

  it('color-only edit (same text) applies and is undoable', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, para.text, RED);
    expect(result.status).toBe('ok');
    expect(result.bytes).toBeTruthy();

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    expect(doc2!.getPageView(0).paragraphs.find((p) => p.text === para.text)!.color[0]).toBeCloseTo(0.8, 2);

    expect(doc!.canUndo()).toBe(true);
    const undone = await doc!.undo();
    const { doc: doc3 } = await EditableDocument.load(undone!);
    expect(doc3!.getPageView(0).paragraphs[0].color[0]).toBeCloseTo(0, 2);
  });

  it('edit without a color keeps the original color', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('fox'))!;
    const result = await doc!.editParagraph(0, para.id, para.text.replace('fox', 'wolf'));
    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const edited = doc2!.getPageView(0).paragraphs.find((p) => p.text.includes('wolf'))!;
    expect(edited.color[0]).toBeCloseTo(0, 2);
  });

  it('same text + same color is a no-op (no undo entry)', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs[0];
    const result = await doc!.editParagraph(0, para.id, para.text, [0, 0, 0]);
    expect(result.status).toBe('ok');
    expect(doc!.canUndo()).toBe(false);
  });

  it('colorRanges colors only the selected word', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('fox'))!;
    const start = para.text.indexOf('fox');
    const result = await doc!.editParagraph(0, para.id, para.text, undefined, [
      { start, end: start + 3, color: RED },
    ]);
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const runs = doc2!.getPageView(0).runs;
    const foxRun = runs.find((r) => r.text.trim() === 'fox')!;
    expect(foxRun).toBeTruthy();
    expect(foxRun.color[0]).toBeCloseTo(0.8, 2);
    // neighbors stay black
    const before = runs.find((r) => r.text.includes('quick brown'))!;
    expect(before.color[0]).toBeCloseTo(0, 2);
    // the paragraph is still one paragraph and reads correctly
    const para2 = doc2!.getPageView(0).paragraphs.find((p) => p.text.includes('quick brown fox'))!;
    expect(para2).toBeTruthy();
  });

  it('existing mixed word colors survive an unrelated edit', async () => {
    // build a paragraph with one red word amid black text
    const pdoc = await PDFDocument.create();
    const page = pdoc.addPage([612, 792]);
    const font = await pdoc.embedFont(StandardFonts.Helvetica);
    const words1: [string, ReturnType<typeof rgb>][] = [
      ['Alpha', rgb(0, 0, 0)],
      ['URGENT', rgb(0.8, 0, 0)],
      ['bravo', rgb(0, 0, 0)],
      ['charlie', rgb(0, 0, 0)],
    ];
    let x = 72;
    for (const [w, c] of words1) {
      page.drawText(w, { x, y: 700, size: 12, font, color: c });
      x += font.widthOfTextAtSize(w + ' ', 12);
    }
    page.drawText('delta echo foxtrot golf hotel india juliet kilo', { x: 72, y: 685.6, size: 12, font });
    const bytes = await pdoc.save({ useObjectStreams: false });

    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('URGENT'))!;
    const result = await doc!.editParagraph(0, para.id, para.text.replace('kilo', 'kilogram'));
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const runs2 = doc2!.getPageView(0).runs;
    const urgent = runs2.find((r) => r.text.includes('URGENT'))!;
    expect(urgent.color[0]).toBeCloseTo(0.8, 2); // red word still red
    const kilogram = runs2.find((r) => r.text.includes('kilogram'))!;
    expect(kilogram.color[0]).toBeCloseTo(0, 2); // edited word black
  });

  it('OCR patch honors a custom text color', async () => {
    const bytes = await makeOcrPdf();
    const { doc } = await EditableDocument.load(bytes);
    const word = doc!.getPageView(0).ocrWords.find((w) => w.text === 'Number')!;
    const result = await doc!.editOcrWord(0, word.runId, 'Reference', [0.96, 0.95, 0.93], BLUE);
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const visible = doc2!.getPageView(0).paragraphs.find((p) => p.text === 'Reference')!;
    expect(visible.color[2]).toBeCloseTo(0.8, 2);
    expect(visible.color[0]).toBeCloseTo(0, 2);
  });
});
