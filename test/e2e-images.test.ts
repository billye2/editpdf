// End-to-end image move/delete: verified on freshly reloaded bytes AND with
// pdf.js as an independent third-party renderer (never only our own model).

import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { makeImagePdf } from './helpers';

async function pdfjsImagePaintCount(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const opList = await page.getOperatorList();
  const count = opList.fnArray.filter((fn: number) => fn === pdfjs.OPS.paintImageXObject).length;
  await doc.destroy();
  return count;
}

describe('image delete', () => {
  it('removes the image from the saved PDF (engine + pdf.js agree), text untouched', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }], { withText: true });
    expect(await pdfjsImagePaintCount(bytes)).toBe(1);

    const { doc } = await EditableDocument.load(bytes);
    const img = doc!.getPageView(0).images[0];
    const result = await doc!.deleteImage(0, img.id);
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const view = doc2!.getPageView(0);
    expect(view.images).toHaveLength(0);
    expect(view.paragraphs.some((p) => p.text.includes('anchor text'))).toBe(true);
    expect(await pdfjsImagePaintCount(result.bytes!)).toBe(0);
  });

  it('deleting one of two placements keeps the other', async () => {
    const bytes = await makeImagePdf([
      { x: 100, y: 500, w: 200, h: 150 },
      { x: 350, y: 100, w: 50, h: 50 },
    ]);
    const { doc } = await EditableDocument.load(bytes);
    const target = doc!.getPageView(0).images.find((i) => Math.abs(i.bbox.x - 100) < 1)!;
    const result = await doc!.deleteImage(0, target.id);
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const images = doc2!.getPageView(0).images;
    expect(images).toHaveLength(1);
    expect(images[0].bbox.x).toBeCloseTo(350, 3);
    expect(await pdfjsImagePaintCount(result.bytes!)).toBe(1);
  });
});

describe('image move', () => {
  it('shifts the bbox by (dx, dy), size unchanged, still one paint op', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes);
    const img = doc!.getPageView(0).images[0];
    const result = await doc!.moveImage(0, img.id, 50, -30);
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const moved = doc2!.getPageView(0).images[0];
    expect(moved.bbox.x).toBeCloseTo(150, 3);
    expect(moved.bbox.y).toBeCloseTo(470, 3);
    expect(moved.bbox.w).toBeCloseTo(200, 3);
    expect(moved.bbox.h).toBeCloseTo(150, 3);
    expect(await pdfjsImagePaintCount(result.bytes!)).toBe(1);
  });

  it('rotated placement: bbox center shifts by exactly (dx, dy)', async () => {
    const bytes = await makeImagePdf([{ x: 300, y: 200, w: 100, h: 80, rotateDeg: 30 }]);
    const { doc } = await EditableDocument.load(bytes);
    const img = doc!.getPageView(0).images[0];
    const cx0 = img.bbox.x + img.bbox.w / 2;
    const cy0 = img.bbox.y + img.bbox.h / 2;
    const result = await doc!.moveImage(0, img.id, 40, 25);
    expect(result.status).toBe('ok');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const moved = doc2!.getPageView(0).images[0];
    expect(moved.bbox.x + moved.bbox.w / 2).toBeCloseTo(cx0 + 40, 2);
    expect(moved.bbox.y + moved.bbox.h / 2).toBeCloseTo(cy0 + 25, 2);
    expect(moved.bbox.w).toBeCloseTo(img.bbox.w, 2);
    expect(moved.bbox.h).toBeCloseTo(img.bbox.h, 2);
  });

  it('two moves compose', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes);
    let img = doc!.getPageView(0).images[0];
    await doc!.moveImage(0, img.id, 10, 10);
    img = doc!.getPageView(0).images[0];
    const result = await doc!.moveImage(0, img.id, 10, 10);

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const moved = doc2!.getPageView(0).images[0];
    expect(moved.bbox.x).toBeCloseTo(120, 3);
    expect(moved.bbox.y).toBeCloseTo(520, 3);
  });

  it('undo restores a move and a delete', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes);
    const img = doc!.getPageView(0).images[0];

    await doc!.moveImage(0, img.id, 50, 50);
    let undone = await doc!.undo();
    expect(undone).toBeTruthy();
    const view = doc!.getPageView(0);
    expect(view.images[0].bbox.x).toBeCloseTo(100, 3);
    expect(view.images[0].bbox.y).toBeCloseTo(500, 3);

    await doc!.deleteImage(0, view.images[0].id);
    expect(doc!.getPageView(0).images).toHaveLength(0);
    undone = await doc!.undo();
    expect(undone).toBeTruthy();
    expect(doc!.getPageView(0).images).toHaveLength(1);
  });

  it('redo re-applies an undone edit; a fresh edit clears the redo stack', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes);
    const img = doc!.getPageView(0).images[0];

    await doc!.moveImage(0, img.id, 50, 50);
    expect(doc!.canRedo()).toBe(false);
    await doc!.undo();
    expect(doc!.canRedo()).toBe(true);
    expect(doc!.getPageView(0).images[0].bbox.x).toBeCloseTo(100, 3);

    const redone = await doc!.redo();
    expect(redone).toBeTruthy();
    const view = doc!.getPageView(0);
    expect(view.images[0].bbox.x).toBeCloseTo(150, 3);
    expect(view.images[0].bbox.y).toBeCloseTo(550, 3);

    // undo the redo, then make a NEW edit — redo history must be gone
    await doc!.undo();
    await doc!.deleteImage(0, doc!.getPageView(0).images[0].id);
    expect(doc!.canRedo()).toBe(false);
    expect(await doc!.redo()).toBeNull();
  });
});

describe('image z-order and round-trip safety', () => {
  it('zero-edit save preserves the image', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes);
    const saved = await doc!.save();
    const { doc: doc2 } = await EditableDocument.load(saved);
    const img = doc2!.getPageView(0).images[0];
    expect(img.bbox.x).toBeCloseTo(100, 3);
    expect(await pdfjsImagePaintCount(saved)).toBe(1);
  });

  it('a paragraph edit on the same page leaves the image untouched', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }], { withText: true });
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text.includes('anchor'))!;
    const result = await doc!.editParagraph(0, para.id, para.text.replace('anchor', 'replaced'));
    expect(result.status).not.toBe('error');

    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    const img = doc2!.getPageView(0).images[0];
    expect(img.bbox.x).toBeCloseTo(100, 3);
    expect(img.bbox.y).toBeCloseTo(500, 3);
    expect(await pdfjsImagePaintCount(result.bytes!)).toBe(1);
  });
});
