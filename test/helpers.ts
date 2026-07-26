// Test helpers: generate PDFs (born-digital and fake OCR-sandwich) with pdf-lib.

import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';

/** 1×1 PNG (valid, embeds via pdf-lib's pure-JS embedPng — no fixtures). */
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function tinyPngBytes(): Uint8Array {
  const bin = atob(TINY_PNG_B64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export interface ImagePlacementSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  rotateDeg?: number;
}

/** One embedded PNG drawn at each placement (same XObject, multiple Do ops). */
export async function makeImagePdf(placements: ImagePlacementSpec[], opts?: { withText?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const img = await doc.embedPng(tinyPngBytes());
  for (const p of placements) {
    page.drawImage(img, { x: p.x, y: p.y, width: p.w, height: p.h, rotate: degrees(p.rotateDeg ?? 0) });
  }
  if (opts?.withText) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Some anchor text here', { x: 72, y: 750, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

/** A page whose only Do is a Form XObject (not an image); the form paints a
 *  filled square and optionally contains a nested image Do of its own. */
export async function makeFormXObjectPdf(opts?: { nestedImage?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;

  let formContent = '0 0 1 rg 0 0 100 100 re f';
  let imgRef;
  if (opts?.nestedImage) {
    const img = await doc.embedPng(tinyPngBytes());
    imgRef = img.ref;
    formContent += '\nq 50 0 0 50 25 25 cm /ImNest Do Q';
  }
  const form = ctx.flateStream(formContent, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 100, 100],
    ...(imgRef ? { Resources: { XObject: { ImNest: imgRef } } } : {}),
  });
  const formRef = ctx.register(form);

  // append a content stream that paints the form (Contents may be a ref or an array)
  const stream = ctx.flateStream('q 1 0 0 1 50 50 cm /Fm1 Do Q');
  const ref = ctx.register(stream);
  const existing = page.node.get(PDFName.of('Contents'));
  const resolved = existing instanceof PDFArray ? existing : ctx.lookup(existing);
  if (resolved instanceof PDFArray) resolved.push(ref);
  else page.node.set(PDFName.of('Contents'), ctx.obj([existing, ref]));

  // register the form under /Resources /XObject
  const resources = page.node.Resources?.();
  if (!resources) throw new Error('page has no Resources dict');
  const xobj = ctx.obj({}) as unknown as { set: (k: unknown, v: unknown) => void };
  xobj.set(PDFName.of('Fm1'), formRef);
  (resources as unknown as { set: (k: unknown, v: unknown) => void }).set(PDFName.of('XObject'), xobj);

  return doc.save({ useObjectStreams: false });
}

export async function makeSimplePdf(opts?: { text?: string; x?: number; y?: number; size?: number }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(opts?.text ?? 'Hello World', {
    x: opts?.x ?? 72,
    y: opts?.y ?? 700,
    size: opts?.size ?? 12,
    font,
    color: rgb(0, 0, 0),
  });
  return doc.save({ useObjectStreams: false });
}

export async function makeParagraphPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const lines1 = [
    'The quick brown fox jumps over the lazy dog while the',
    'sun sets slowly behind the tall mountains in the west',
    'casting long shadows over the quiet valley below.',
  ];
  const lines2 = [
    'A second paragraph sits here after a clear gap and',
    'should be detected as separate from the first one.',
  ];
  let y = 700;
  for (const line of lines1) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 14.4;
  }
  y -= 24; // paragraph gap
  for (const line of lines2) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 14.4;
  }
  return doc.save({ useObjectStreams: false });
}

/** Fake OCR sandwich: light-gray "scan" background + invisible (Tr 3) text layer. */
export async function makeOcrPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontRef = (font as unknown as { ref: unknown }).ref;

  // draw a background rectangle standing in for the scanned image
  page.drawRectangle({ x: 50, y: 650, width: 500, height: 100, color: rgb(0.96, 0.95, 0.93) });

  // invisible OCR text layer, one word per Tj (like tesseract output)
  const content = [
    'BT',
    '3 Tr',
    '/FOCR 14 Tf',
    '1 0 0 1 72 700 Tm',
    '(Invoice) Tj',
    '1 0 0 1 130 700 Tm',
    '(Number) Tj',
    '1 0 0 1 192 700 Tm',
    '(12345) Tj',
    'ET',
  ].join('\n');
  const ctx = doc.context;
  const stream = ctx.flateStream(content);
  const ref = ctx.register(stream);
  // Contents may already be an array — append, don't nest (a nested array is
  // invalid; pdf.js drops the inner element and blanks the "scan" layer)
  const existing = page.node.get(PDFName.of('Contents'));
  const resolved = ctx.lookup(existing);
  if (resolved instanceof PDFArray) resolved.push(ref);
  else page.node.set(PDFName.of('Contents'), ctx.obj([existing, ref]));

  // register the OCR font resource
  const resources = page.node.Resources?.() ?? undefined;
  if (resources) {
    const fontDict = resources.lookup?.(PDFName.of('Font')) ?? undefined;
    if (fontDict && 'set' in (fontDict as object)) {
      (fontDict as unknown as { set: (k: unknown, v: unknown) => void }).set(PDFName.of('FOCR'), fontRef);
    } else {
      const fd = ctx.obj({}) as unknown as { set: (k: unknown, v: unknown) => void };
      fd.set(PDFName.of('FOCR'), fontRef);
      (resources as unknown as { set: (k: unknown, v: unknown) => void }).set(PDFName.of('Font'), fd);
    }
  }
  return doc.save({ useObjectStreams: false });
}
