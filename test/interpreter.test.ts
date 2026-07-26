import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { parseContent } from '../src/engine/content-stream/parser';
import { interpret } from '../src/engine/content-stream/interpreter';
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

  it('records per-show-op geometry (tmAtShow / tlmAfter / ctm)', () => {
    const run = (content: string) => interpret(parseContent(new TextEncoder().encode(content)), new Map());

    // Tj after Td: tm at show = tlm
    let { showOps } = run('BT 10 20 Td (A) Tj ET');
    let g = showOps.get(2)!;
    expect([g.tmAtShow[4], g.tmAtShow[5]]).toEqual([10, 20]);
    expect([g.tlmAfter[4], g.tlmAfter[5]]).toEqual([10, 20]);
    expect(g.ctm).toEqual([1, 0, 0, 1, 0, 0]);

    // quote: recorded AFTER the leading move
    ({ showOps } = run("BT 14 TL 0 100 Td (A) ' ET"));
    g = showOps.get(3)!;
    expect(g.tmAtShow[5]).toBe(86);
    expect(g.tlmAfter[5]).toBe(86);

    // dblquote: same, and recorded even with spacing args
    ({ showOps } = run('BT 14 TL 0 100 Td 2 1 (A) " ET'));
    g = showOps.get(3)!;
    expect(g.tmAtShow[5]).toBe(86);

    // TJ: recorded at op start, before any kern advances
    ({ showOps } = run('BT 5 7 Td [(A) -1000 (B)] TJ ET'));
    g = showOps.get(2)!;
    expect([g.tmAtShow[4], g.tmAtShow[5]]).toEqual([5, 7]);
    expect([g.tlmAfter[4], g.tlmAfter[5]]).toEqual([5, 7]);

    // under cm: the active CTM is captured
    ({ showOps } = run('q 2 0 0 2 10 10 cm BT 10 20 Td (A) Tj ET Q'));
    g = showOps.get(4)!;
    expect(g.ctm).toEqual([2, 0, 0, 2, 10, 10]);

    // tm continuation: the second Tj's tmAtShow is the ADVANCED matrix, not the tlm
    ({ showOps } = run('BT /F1 12 Tf 10 20 Td (A) Tj (B) Tj ET'));
    const first = showOps.get(3)!;
    const second = showOps.get(4)!;
    expect(second.tmAtShow[4]).toBeGreaterThan(first.tmAtShow[4]);
    expect(second.tlmAfter[4]).toBe(10);
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
