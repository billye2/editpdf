import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { makeSimplePdf, makeParagraphPdf, makeOcrPdf } from './helpers';

describe('interpreter + text model', () => {
  it('extracts text with correct geometry from a pdf-lib document', async () => {
    const bytes = await makeSimplePdf({ text: 'Hello World', x: 72, y: 700, size: 12 });
    const { doc, outcome } = await EditableDocument.load(bytes);
    expect(outcome.ok).toBe(true);
    const view = doc!.getPageView(0);
    expect(view.hasVisibleText).toBe(true);
    const runTexts = view.runs.map((r) => r.text).join('');
    expect(runTexts).toContain('Hello World');
    const run = view.runs.find((r) => r.text.includes('Hello'))!;
    // baseline at y=700 → bbox bottom = 700 + descent (≈ -0.25*12 = -3)
    expect(run.bbox.x).toBeCloseTo(72, 0);
    expect(run.bbox.y).toBeGreaterThan(694);
    expect(run.bbox.y).toBeLessThan(700);
    expect(run.bbox.w).toBeGreaterThan(40);
  });

  it('clusters lines into two paragraphs', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    expect(view.paragraphs.length).toBe(2);
    const p1 = view.paragraphs.find((p) => p.text.startsWith('The quick'))!;
    expect(p1.lineCount).toBe(3);
    expect(p1.text).toContain('quiet valley below');
    const p2 = view.paragraphs.find((p) => p.text.startsWith('A second'))!;
    expect(p2.lineCount).toBe(2);
  });

  it('detects an invisible OCR layer and exposes word boxes', async () => {
    const bytes = await makeOcrPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    expect(view.hasOcrLayer).toBe(true);
    const words = view.ocrWords.map((w) => w.text);
    expect(words).toEqual(['Invoice', 'Number', '12345']);
    const inv = view.ocrWords[0];
    expect(inv.bbox.x).toBeCloseTo(72, 0);
    expect(inv.bbox.y).toBeGreaterThan(692);
    expect(inv.bbox.y).toBeLessThan(700);
  });
});
