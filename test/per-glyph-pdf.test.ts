// Regression for "one space goes missing": per-glyph PDFs (browser
// print-to-PDF emits every character — including every SPACE — as its own
// positioned Tj). Space-only runs must survive into the word model and be
// removed with the paragraph on edit. Corpus file: user-reported document
// where "in April" lost its space (kerned 'A' shrank the positional gap
// below the old heuristic threshold after space runs were filtered out).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { EditableDocument } from '../src/engine/document';

const CORPUS = 'test/corpus-EDIT_SAMPLE.pdf';
const have = existsSync(CORPUS);

describe.skipIf(!have)('per-glyph print-to-PDF documents', () => {
  it('keeps every space in the reconstructed paragraph text', async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS));
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(4);
    const para = view.paragraphs.find((p) => p.text.includes('April'))!;
    expect(para.text).toContain('interrupted in April when');
    expect(para.text).not.toMatch(/inApril|Aprilwhen/);
  });

  it('editing the paragraph preserves spaces and leaves no orphan space ops', async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS));
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(4);
    const para = view.paragraphs.find((p) => p.text.includes('in April'))!;
    const result = await doc!.editParagraph(4, para.id, para.text.replace('gunman', 'intruder'));
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const para2 = doc2!.getPageView(4).paragraphs.find((p) => p.text.includes('in April'))!;
    expect(para2.text).toContain('in April when a intruder rushed');
    // no leftover single-space runs from the original per-glyph paragraph
    // (they must be removed with the paragraph's other ops)
    const strayInPara = doc2!
      .getPageView(4)
      .runs.filter(
        (r) =>
          r.text === ' ' &&
          r.bbox.y > para.bbox.y - 2 &&
          r.bbox.y < para.bbox.y + para.bbox.h + 2 &&
          r.bbox.x > para.bbox.x - 2,
      );
    expect(strayInPara.length).toBe(0);
  });
});
