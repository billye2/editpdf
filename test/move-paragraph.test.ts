// Translate-only paragraph move: original show ops stay in place (z-order,
// kerning, justification untouched), sandwiched between an absolute Tm and a
// restore Tm. Verified on freshly reloaded bytes AND with pdf.js as an
// independent extractor (never only our own model).

import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { makeParagraphPdf, makeContentPdf } from './helpers';
import type { Rect } from '../src/shared/types';

interface TextItem {
  str: string;
  x: number;
  y: number;
}

async function pdfjsTextItems(bytes: Uint8Array): Promise<TextItem[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const items = (tc.items as { str?: string; transform?: number[] }[])
    .filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
    .map((it) => ({ str: it.str!, x: it.transform![4], y: it.transform![5] }));
  await doc.destroy();
  return items;
}

async function reload(bytes: Uint8Array): Promise<EditableDocument> {
  const { doc } = await EditableDocument.load(bytes);
  return doc!;
}

const center = (b: Rect) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

describe('moveParagraph: Tm-positioned text (pdf-lib output)', () => {
  it('shifts the paragraph bbox by (dx, dy); the other paragraph is untouched', async () => {
    const bytes = await makeParagraphPdf();
    const doc = await reload(bytes);
    const before = doc.getPageView(0);
    const p1 = before.paragraphs.find((p) => p.text.startsWith('The quick'))!;
    const p2 = before.paragraphs.find((p) => p.text.startsWith('A second'))!;

    // move far enough that the paragraph detector can't merge the blocks
    const result = await doc.moveParagraph(0, p1.id, 50, -200);
    expect(result.status).toBe('ok');

    const after = (await reload(result.bytes!)).getPageView(0);
    const m1 = after.paragraphs.find((p) => p.text.startsWith('The quick'))!;
    const m2 = after.paragraphs.find((p) => p.text.startsWith('A second'))!;
    expect(m1.bbox.x).toBeCloseTo(p1.bbox.x + 50, 3);
    expect(m1.bbox.y).toBeCloseTo(p1.bbox.y - 200, 3);
    expect(m1.bbox.w).toBeCloseTo(p1.bbox.w, 3);
    expect(m1.bbox.h).toBeCloseTo(p1.bbox.h, 3);
    expect(m2.bbox.x).toBeCloseTo(p2.bbox.x, 6);
    expect(m2.bbox.y).toBeCloseTo(p2.bbox.y, 6);
  });

  it('pdf.js sees every moved line shifted uniformly and other text byte-stable', async () => {
    const bytes = await makeParagraphPdf();
    const doc = await reload(bytes);
    const itemsBefore = await pdfjsTextItems(bytes);
    const p1 = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;

    const result = await doc.moveParagraph(0, p1.id, 50, -30);
    const itemsAfter = await pdfjsTextItems(result.bytes!);
    expect(itemsAfter.length).toBe(itemsBefore.length);
    for (const b of itemsBefore) {
      const a = itemsAfter.find((it) => it.str === b.str)!;
      expect(a).toBeTruthy();
      if (p1.text.includes(b.str.trim())) {
        expect(a.x).toBeCloseTo(b.x + 50, 4);
        expect(a.y).toBeCloseTo(b.y - 30, 4);
      } else {
        expect(a.x).toBeCloseTo(b.x, 6);
        expect(a.y).toBeCloseTo(b.y, 6);
      }
    }
  });
});

describe('moveParagraph: relative positioning chains', () => {
  it('Td-chain: moving the first block leaves the Td-anchored follower in place', async () => {
    const bytes = await makeContentPdf(
      [
        'BT /F1 12 Tf 72 714 Td (First block line one here) Tj',
        '0 -14 Td (first block line two text) Tj',
        '0 -60 Td (Far below separate block) Tj ET',
      ].join('\n'),
    );
    const doc = await reload(bytes);
    const view = doc.getPageView(0);
    expect(view.paragraphs).toHaveLength(2);
    const p1 = view.paragraphs.find((p) => p.text.startsWith('First block'))!;
    const follower = view.paragraphs.find((p) => p.text.startsWith('Far below'))!;

    const result = await doc.moveParagraph(0, p1.id, 25, 40);
    expect(result.status).toBe('ok');

    const after = (await reload(result.bytes!)).getPageView(0);
    const m1 = after.paragraphs.find((p) => p.text.startsWith('First block'))!;
    const mf = after.paragraphs.find((p) => p.text.startsWith('Far below'))!;
    expect(m1.bbox.x).toBeCloseTo(p1.bbox.x + 25, 3);
    expect(m1.bbox.y).toBeCloseTo(p1.bbox.y + 40, 3);
    expect(m1.bbox.h).toBeCloseTo(p1.bbox.h, 3); // line spacing preserved
    expect(mf.bbox.x).toBeCloseTo(follower.bbox.x, 6);
    expect(mf.bbox.y).toBeCloseTo(follower.bbox.y, 6);
  });

  it('quote chain (TL + \' and "): block moves as a unit, Tw/Tc widths preserved, follower pinned', async () => {
    const bytes = await makeContentPdf(
      [
        'BT /F1 12 Tf 14 TL 72 714 Td (First line of words here) Tj',
        '1.5 0.4 (second line with spacing) "',
        "(third line follows on fine) '",
        '0 -60 Td (Far below separate block) Tj ET',
      ].join('\n'),
    );
    const doc = await reload(bytes);
    const view = doc.getPageView(0);
    const p1 = view.paragraphs.find((p) => p.text.startsWith('First line'))!;
    expect(p1.lineCount).toBe(3);
    const follower = view.paragraphs.find((p) => p.text.startsWith('Far below'))!;
    const runsBefore = doc.getPageView(0).runs.filter((r) => r.text.trim());

    const result = await doc.moveParagraph(0, p1.id, 12, 30);
    expect(result.status).toBe('ok');

    const afterDoc = await reload(result.bytes!);
    const after = afterDoc.getPageView(0);
    const m1 = after.paragraphs.find((p) => p.text.startsWith('First line'))!;
    const mf = after.paragraphs.find((p) => p.text.startsWith('Far below'))!;
    expect(m1.bbox.x).toBeCloseTo(p1.bbox.x + 12, 3);
    expect(m1.bbox.y).toBeCloseTo(p1.bbox.y + 30, 3);
    expect(mf.bbox.y).toBeCloseTo(follower.bbox.y, 6);
    // run widths capture Tw/Tc effects — they must survive the move exactly
    for (const rb of runsBefore) {
      const ra = after.runs.find((r) => r.text === rb.text)!;
      expect(ra.bbox.w).toBeCloseTo(rb.bbox.w, 6);
    }
  });

  it("pins an invisible run that continues the moved paragraph's tm chain", async () => {
    const bytes = await makeContentPdf(
      'BT /F1 12 Tf 72 700 Td (Visible paragraph text here) Tj 3 Tr ( hidden tail) Tj 0 Tr ET',
    );
    const doc = await reload(bytes);
    const view = doc.getPageView(0);
    const para = view.paragraphs.find((p) => p.text.startsWith('Visible'))!;
    const hiddenBefore = view.runs.find((r) => r.renderMode === 3)!;

    const result = await doc.moveParagraph(0, para.id, 40, -20);
    expect(result.status).toBe('ok');

    const after = (await reload(result.bytes!)).getPageView(0);
    const moved = after.paragraphs.find((p) => p.text.startsWith('Visible'))!;
    const hiddenAfter = after.runs.find((r) => r.renderMode === 3)!;
    expect(moved.bbox.x).toBeCloseTo(para.bbox.x + 40, 3);
    expect(hiddenAfter.bbox.x).toBeCloseTo(hiddenBefore.bbox.x, 4);
    expect(hiddenAfter.bbox.y).toBeCloseTo(hiddenBefore.bbox.y, 4);
  });
});

describe('moveParagraph: transforms and kerning', () => {
  it('under a scaling cm, a page-space delta lands exactly in page space', async () => {
    const bytes = await makeContentPdf('q 2 0 0 2 0 0 cm BT /F1 12 Tf 100 300 Td (Scaled text sample here) Tj ET Q');
    const doc = await reload(bytes);
    const para = doc.getPageView(0).paragraphs[0];
    expect(para.bbox.x).toBeCloseTo(200, 1);

    const result = await doc.moveParagraph(0, para.id, 10, 20);
    expect(result.status).toBe('ok');

    const moved = (await reload(result.bytes!)).getPageView(0).paragraphs[0];
    expect(moved.bbox.x).toBeCloseTo(para.bbox.x + 10, 3);
    expect(moved.bbox.y).toBeCloseTo(para.bbox.y + 20, 3);
    expect(moved.bbox.w).toBeCloseTo(para.bbox.w, 3);
  });

  it('TJ kern gaps are preserved exactly', async () => {
    const bytes = await makeContentPdf('BT /F1 24 Tf 72 500 Td [(V) 120 (AV) -50 (A)] TJ ET');
    const doc = await reload(bytes);
    const runsBefore = [...doc.getPageView(0).runs].sort((a, b) => a.bbox.x - b.bbox.x);
    const para = doc.getPageView(0).paragraphs[0];

    const result = await doc.moveParagraph(0, para.id, 30, 40);
    expect(result.status).toBe('ok');

    const runsAfter = [...(await reload(result.bytes!)).getPageView(0).runs].sort((a, b) => a.bbox.x - b.bbox.x);
    expect(runsAfter.length).toBe(runsBefore.length);
    for (let i = 0; i < runsBefore.length; i++) {
      expect(runsAfter[i].bbox.x).toBeCloseTo(runsBefore[i].bbox.x + 30, 4);
      expect(runsAfter[i].bbox.y).toBeCloseTo(runsBefore[i].bbox.y + 40, 4);
      expect(runsAfter[i].bbox.w).toBeCloseTo(runsBefore[i].bbox.w, 6);
    }
  });

  it('refuses to move a paragraph that shares a TJ with another column', async () => {
    const bytes = await makeContentPdf('BT /F1 12 Tf 72 700 Td [(LeftColumnWords) -20000 (RightColumnWords)] TJ ET');
    const doc = await reload(bytes);
    const view = doc.getPageView(0);
    expect(view.paragraphs.length).toBe(2); // column split on the huge kern
    for (const p of view.paragraphs) {
      const result = await doc.moveParagraph(0, p.id, 10, 10);
      expect(result.status).toBe('error');
    }
  });
});

describe('moveParagraph: z-order, composition, history', () => {
  it('moves in place — the moved ops stay before later-drawn content', async () => {
    const bytes = await makeContentPdf(
      [
        'BT /F1 12 Tf 72 700 Td (Movable paragraph text here) Tj ET',
        'BT /F1 12 Tf 72 600 Td (Later drawn text stays after) Tj ET',
      ].join('\n'),
    );
    const doc = await reload(bytes);
    const para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('Movable'))!;
    const result = await doc.moveParagraph(0, para.id, 20, 20);

    // runs are reported in op order — the moved text must not have been
    // appended at stream end
    const runs = (await reload(result.bytes!)).getPageView(0).runs.filter((r) => r.text.trim());
    const iMoved = runs.findIndex((r) => r.text.includes('Movable'));
    const iLater = runs.findIndex((r) => r.text.includes('Later'));
    expect(iMoved).toBeGreaterThanOrEqual(0);
    expect(iMoved).toBeLessThan(iLater);
  });

  it('two moves compose', async () => {
    const bytes = await makeParagraphPdf();
    const doc = await reload(bytes);
    let para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;
    const orig = center(para.bbox);
    await doc.moveParagraph(0, para.id, 20, 10);
    para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;
    const result = await doc.moveParagraph(0, para.id, 15, -5);

    const moved = (await reload(result.bytes!)).getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;
    const c = center(moved.bbox);
    expect(c.x).toBeCloseTo(orig.x + 35, 3);
    expect(c.y).toBeCloseTo(orig.y + 5, 3);
  });

  it('a moved paragraph can then be edited at its new location', async () => {
    const bytes = await makeParagraphPdf();
    const doc = await reload(bytes);
    let para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('A second'))!;
    await doc.moveParagraph(0, para.id, 0, -100);

    para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('A second'))!;
    const result = await doc.editParagraph(0, para.id, para.text.replace('second', 'edited'));
    expect(result.status).not.toBe('error');
    const after = (await reload(result.bytes!)).getPageView(0);
    const edited = after.paragraphs.find((p) => p.text.includes('edited'))!;
    expect(Math.abs(edited.bbox.y - para.bbox.y)).toBeLessThan(5);
  });

  it('an edited (appended-block) paragraph can then be moved', async () => {
    const bytes = await makeParagraphPdf();
    const doc = await reload(bytes);
    let para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('A second'))!;
    await doc.editParagraph(0, para.id, para.text.replace('second', 'edited'));

    para = doc.getPageView(0).paragraphs.find((p) => p.text.includes('edited'))!;
    const result = await doc.moveParagraph(0, para.id, 33, -150);
    expect(result.status).toBe('ok');
    const moved = (await reload(result.bytes!)).getPageView(0).paragraphs.find((p) => p.text.includes('edited'))!;
    expect(moved.bbox.x).toBeCloseTo(para.bbox.x + 33, 3);
    expect(moved.bbox.y).toBeCloseTo(para.bbox.y - 150, 3);
  });

  it('undo restores the original position; redo re-applies the move', async () => {
    const bytes = await makeParagraphPdf();
    const doc = await reload(bytes);
    const para = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;

    await doc.moveParagraph(0, para.id, 50, -200);
    expect(doc.canUndo()).toBe(true);
    await doc.undo();
    let now = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;
    expect(now.bbox.x).toBeCloseTo(para.bbox.x, 4);
    expect(now.bbox.y).toBeCloseTo(para.bbox.y, 4);

    await doc.redo();
    now = doc.getPageView(0).paragraphs.find((p) => p.text.startsWith('The quick'))!;
    expect(now.bbox.x).toBeCloseTo(para.bbox.x + 50, 4);
    expect(now.bbox.y).toBeCloseTo(para.bbox.y - 200, 4);
  });
});
