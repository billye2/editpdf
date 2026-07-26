// Generates sample PDFs into public/samples/ for manual testing:
//  - sample.pdf      born-digital, multi-paragraph
//  - scanned.pdf     fake OCR sandwich (gray "scan" + invisible text layer)
//  - images.pdf      embedded PNG at two placements (one rotated) + text
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('public/samples', { recursive: true });

{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  page.drawText('PDF Edna Demo Document', { x: 72, y: 720, size: 20, font: bold });
  const para1 = [
    'The quick brown fox jumps over the lazy dog while the',
    'sun sets slowly behind the tall mountains in the west,',
    'casting long shadows over the quiet valley below. Each',
    'evening the same scene repeats itself with small changes',
    'in color and light that nobody ever writes down.',
  ];
  const para2 = [
    'A second paragraph sits here after a clear gap and should',
    'be detected as a separate block. Try replacing a short',
    'word with a much longer one to watch the text reflow.',
  ];
  let y = 680;
  for (const line of para1) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 14.5;
  }
  y -= 22;
  // short same-size header with tight leading right above the paragraph —
  // must stay its own block when either it or the body is edited
  page.drawText('Second Section', { x: 72, y, size: 12, font: bold });
  y -= 15;
  for (const line of para2) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 14.5;
  }
  writeFileSync('public/samples/sample.pdf', await doc.save({ useObjectStreams: false }));
}

{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontRef = font.ref;
  page.drawRectangle({ x: 40, y: 40, width: 532, height: 712, color: rgb(0.955, 0.945, 0.92) });
  // Simulate unreadable "printed" ink with vector smudges (the engine ignores
  // paths), then add an invisible OCR layer on top (one word per Tj), like a
  // tesseract sandwich PDF. Patch-over edits cover the smudge and draw crisp text.
  const words = [
    ['INVOICE', 72, 700, 22],
    ['No.', 72, 660, 13],
    ['10482', 100, 660, 13],
    ['Date:', 72, 640, 13],
    ['2026-07-23', 110, 640, 13],
    ['Total:', 72, 620, 13],
    ['$1,250.00', 112, 620, 13],
  ];
  for (const [text, x, y, size] of words) {
    const w = font.widthOfTextAtSize(String(text), Number(size));
    page.drawRectangle({
      x: Number(x),
      y: Number(y) - 1,
      width: w,
      height: Number(size) * 0.66,
      color: rgb(0.25, 0.24, 0.23),
      opacity: 0.8,
    });
  }
  const ctx = doc.context;
  const lines = ['BT', '3 Tr', '/FOCR 1 Tf'];
  for (const [text, x, y, size] of words) {
    lines.push(`/FOCR ${size} Tf`, `1 0 0 1 ${x} ${y} Tm`, `(${String(text).replace(/([()\\])/g, '\\$1')}) Tj`);
  }
  lines.push('ET');
  const stream = ctx.flateStream(lines.join('\n'));
  const ref = ctx.register(stream);
  const existing = page.node.get(PDFName.of('Contents'));
  page.node.set(PDFName.of('Contents'), ctx.obj([existing, ref]));
  const resources = page.node.Resources();
  const fontDict = resources.lookup(PDFName.of('Font'));
  fontDict.set(PDFName.of('FOCR'), fontRef);
  writeFileSync('public/samples/scanned.pdf', await doc.save({ useObjectStreams: false }));
}

{
  // 1×1 PNG scaled up per placement — enough to drag/delete visibly
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(Buffer.from(TINY_PNG_B64, 'base64'));
  page.drawText('Drag an image to move it; click it, then press Delete to remove it.', {
    x: 72,
    y: 740,
    size: 12,
    font,
  });
  page.drawImage(img, { x: 100, y: 450, width: 200, height: 150 });
  page.drawImage(img, { x: 380, y: 150, width: 120, height: 120, rotate: degrees(30) });
  writeFileSync('public/samples/images.pdf', await doc.save({ useObjectStreams: false }));
}

console.log('Wrote public/samples/sample.pdf, scanned.pdf and images.pdf');

// cid-sample: real embedded TrueType (CID/Type0) font — only when the system
// font is available; used to verify font preservation on header edits.
try {
  const { readFileSync, existsSync } = await import('node:fs');
  const ARIAL_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
  const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (existsSync(ARIAL_BOLD) && existsSync(ARIAL)) {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const page = doc.addPage([612, 792]);
    const bold = await doc.embedFont(readFileSync(ARIAL_BOLD), { subset: false });
    const reg = await doc.embedFont(readFileSync(ARIAL), { subset: false });
    page.drawText('Quarterly Report', { x: 72, y: 700, size: 18, font: bold });
    const lines = [
      'Revenue grew steadily across all regions this quarter with',
      'particularly strong performance in the northern markets.',
    ];
    let y = 676;
    for (const line of lines) {
      page.drawText(line, { x: 72, y, size: 12, font: reg });
      y -= 14.5;
    }
    writeFileSync('public/samples/cid-fonts.pdf', await doc.save({ useObjectStreams: false }));
    console.log('Wrote public/samples/cid-fonts.pdf');
  }
} catch (e) {
  console.warn('cid-fonts sample skipped:', e.message);
}
