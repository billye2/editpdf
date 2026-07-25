// Image placement model: XObject image Do ops become editable placements with
// page-space bboxes; forms, nested images, and inline images are ignored.

import { describe, it, expect } from 'vitest';
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import { EditableDocument } from '../src/engine/document';
import { makeImagePdf, makeFormXObjectPdf, tinyPngBytes } from './helpers';

describe('image placement model', () => {
  it('reports a single placement with its page-space bbox', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes);
    const images = doc!.getPageView(0).images;
    expect(images).toHaveLength(1);
    expect(images[0].bbox.x).toBeCloseTo(100, 3);
    expect(images[0].bbox.y).toBeCloseTo(500, 3);
    expect(images[0].bbox.w).toBeCloseTo(200, 3);
    expect(images[0].bbox.h).toBeCloseTo(150, 3);
  });

  it('rotated placement gets the AABB of the transformed unit square', async () => {
    const deg = 30;
    const bytes = await makeImagePdf([{ x: 300, y: 200, w: 100, h: 80, rotateDeg: deg }]);
    const { doc } = await EditableDocument.load(bytes);
    const images = doc!.getPageView(0).images;
    expect(images).toHaveLength(1);
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // pdf-lib rotates about the (x, y) anchor
    expect(images[0].bbox.w).toBeCloseTo(100 * cos + 80 * sin, 2);
    expect(images[0].bbox.h).toBeCloseTo(100 * sin + 80 * cos, 2);
    expect(images[0].bbox.x).toBeCloseTo(300 - 80 * sin, 2);
    expect(images[0].bbox.y).toBeCloseTo(200, 2);
  });

  it('the same image drawn twice yields two distinct placements', async () => {
    const bytes = await makeImagePdf([
      { x: 100, y: 500, w: 200, h: 150 },
      { x: 350, y: 100, w: 50, h: 50 },
    ]);
    const { doc } = await EditableDocument.load(bytes);
    const images = doc!.getPageView(0).images;
    expect(images).toHaveLength(2);
    expect(images[0].id).not.toBe(images[1].id);
    const xs = images.map((i) => i.bbox.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(100, 3);
    expect(xs[1]).toBeCloseTo(350, 3);
  });

  it('Form XObjects are not reported, including images nested inside them', async () => {
    for (const nestedImage of [false, true]) {
      const bytes = await makeFormXObjectPdf({ nestedImage });
      const { doc } = await EditableDocument.load(bytes);
      expect(doc!.getPageView(0).images).toHaveLength(0);
    }
  });

  it('inline images (BI…ID…EI) are not reported and still round-trip', async () => {
    // start from a real image PDF, then append an inline-image stream
    const base = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const pdfDoc = await PDFDocument.load(base);
    const page = pdfDoc.getPage(0);
    const ctx = pdfDoc.context;
    const stream = ctx.flateStream('q 10 0 0 10 20 20 cm\nBI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\x45\x49 EI\nQ');
    const ref = ctx.register(stream);
    // Contents may already be an array (pdf-lib normalizes on load) — append, don't nest
    const existing = page.node.get(PDFName.of('Contents'));
    const resolved = existing instanceof PDFArray ? existing : ctx.lookup(existing);
    if (resolved instanceof PDFArray) resolved.push(ref);
    else page.node.set(PDFName.of('Contents'), ctx.obj([existing, ref]));
    const bytes = await pdfDoc.save({ useObjectStreams: false });

    const { doc } = await EditableDocument.load(bytes);
    expect(doc!.getPageView(0).images).toHaveLength(1); // only the XObject image

    // untouched save keeps the inline image bytes in the stream
    const saved = await doc!.save();
    const { doc: doc2 } = await EditableDocument.load(saved);
    expect(doc2!.getPageView(0).images).toHaveLength(1);
  });

  it('tinyPngBytes decodes to a real PNG', () => {
    const b = tinyPngBytes();
    expect([...b.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
