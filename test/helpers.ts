// Test helpers: generate PDFs (born-digital and fake OCR-sandwich) with pdf-lib.

import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

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
  const lines2 = ['A second paragraph sits here after a clear gap and', 'should be detected as separate from the first one.'];
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
  const existing = page.node.get(PDFName.of('Contents'));
  const arr = ctx.obj([existing, ref]);
  page.node.set(PDFName.of('Contents'), arr);

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
