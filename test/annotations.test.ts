// FreeText annotation flattening: text added by Edge/Acrobat/Preview text
// tools lives in annotation appearance streams — invisible to the
// content-stream engine until flattened into page content at load.

import { describe, it, expect } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFObject, StandardFonts, rgb } from 'pdf-lib';
import { EditableDocument } from '../src/engine/document';

/** A page with normal text, a FreeText annotation (Edge-style: AP form whose
 *  Matrix maps the Rect to origin), a Link annotation, and — crucially — a
 *  trailing content stream that LEAKS a scaled CTM (real print-to-PDF streams
 *  do this; appended content must not inherit it). */
async function makeAnnotatedPdf(opts?: { leakCtm?: boolean; withAp?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Body content text', { x: 72, y: 700, size: 12, font, color: rgb(0, 0, 0) });
  const ctx = doc.context;

  if (opts?.leakCtm) {
    // top-level scale left dangling at the end of the page's content
    const leak = ctx.flateStream('0.5 0 0 0.5 0 0 cm');
    const leakRef = ctx.register(leak);
    const existing = page.node.get(PDFName.of('Contents'));
    const resolved = existing instanceof PDFArray ? existing : ctx.lookup(existing);
    if (resolved instanceof PDFArray) resolved.push(leakRef);
    else page.node.set(PDFName.of('Contents'), ctx.obj([existing, leakRef]));
  }

  const annots: PDFObject[] = [];
  if (opts?.withAp !== false) {
    const ap = ctx.flateStream('BT /F0 12 Tf 202 507 Td (annotation text here) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [200, 500, 340, 520],
      Matrix: [1, 0, 0, 1, -200, -500],
      Resources: { Font: { F0: font.ref } },
    });
    annots.push(
      ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'FreeText',
          Rect: [200, 500, 340, 520],
          Contents: 'annotation text here',
          F: 4,
          AP: { N: ctx.register(ap) },
        }),
      ),
    );
  } else {
    annots.push(
      ctx.register(
        ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [200, 500, 340, 520], Contents: 'no appearance', F: 4 }),
      ),
    );
  }
  annots.push(
    ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [72, 690, 200, 712],
        A: { Type: 'Action', S: 'URI', URI: 'https://example.com' },
      }),
    ),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  return doc.save({ useObjectStreams: false });
}

describe('FreeText flattening', () => {
  it('annotation text becomes an editable paragraph at the annotation position', async () => {
    const bytes = await makeAnnotatedPdf();
    const { doc } = await EditableDocument.load(bytes);
    const view = doc!.getPageView(0);
    const para = view.paragraphs.find((p) => p.text === 'annotation text here')!;
    expect(para).toBeTruthy();
    expect(para.bbox.x).toBeGreaterThan(195);
    expect(para.bbox.x).toBeLessThan(215);
    expect(para.bbox.y).toBeGreaterThan(495);
    expect(para.bbox.y).toBeLessThan(520);

    const result = await doc!.editParagraph(0, para.id, 'annotation text edited');
    expect(result.status).toBe('ok');
    const { doc: doc2 } = await EditableDocument.load(result.bytes!);
    expect(doc2!.getPageView(0).paragraphs.some((p) => p.text.includes('edited'))).toBe(true);
  });

  it('is immune to a leaked CTM at the end of the page content (state-leak regression)', async () => {
    const bytes = await makeAnnotatedPdf({ leakCtm: true });
    const { doc } = await EditableDocument.load(bytes);
    const para = doc!.getPageView(0).paragraphs.find((p) => p.text === 'annotation text here')!;
    expect(para).toBeTruthy();
    // full size and true position — NOT scaled/displaced by the leaked cm
    expect(para.fontSize).toBeGreaterThan(10);
    expect(para.bbox.y).toBeGreaterThan(495);
    expect(para.bbox.y).toBeLessThan(520);
  });

  it('removes the FreeText annotation on save but keeps other annotations', async () => {
    const bytes = await makeAnnotatedPdf();
    const { doc } = await EditableDocument.load(bytes);
    const saved = await doc!.save();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pd = await pdfjs.getDocument({ data: saved.slice(), useSystemFonts: true }).promise;
    const annots = (await (await pd.getPage(1)).getAnnotations()) as { subtype: string }[];
    await pd.destroy();
    expect(annots.some((a) => a.subtype === 'FreeText')).toBe(false);
    expect(annots.some((a) => a.subtype === 'Link')).toBe(true);
  });

  it('leaves a FreeText without an appearance stream untouched', async () => {
    const bytes = await makeAnnotatedPdf({ withAp: false });
    const { doc } = await EditableDocument.load(bytes);
    expect(doc!.getPageView(0).paragraphs.some((p) => p.text.includes('no appearance'))).toBe(false);
    const saved = await doc!.save();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pd = await pdfjs.getDocument({ data: saved.slice(), useSystemFonts: true }).promise;
    const annots = (await (await pd.getPage(1)).getAnnotations()) as { subtype: string }[];
    await pd.destroy();
    expect(annots.some((a) => a.subtype === 'FreeText')).toBe(true); // preserved, not dropped
  });
});
