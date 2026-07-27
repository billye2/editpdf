// Generates sample PDFs into public/samples/ for manual testing:
//  - sample.pdf      born-digital 2-page report ("Try a sample"): paragraphs,
//                    headers, and three embedded PNG images (logo/chart/photo)
//  - scanned.pdf     fake OCR sandwich (gray "scan" + invisible text layer)
//  - images.pdf      embedded PNG at two placements (one rotated) + text
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

mkdirSync('public/samples', { recursive: true });

// ---------- minimal PNG encoder (RGBA, no deps) ----------
// Enough to render the sample's images programmatically so the repo ships no
// binary assets and the samples stay reproducible.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** pixelFn(x, y) → [r, g, b, a] (0–255). */
function encodePng(width, height, pixelFn) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Rounded-square gradient logo mark with a white dot. */
function logoPng() {
  const S = 96;
  const R = 22;
  return encodePng(S, S, (x, y) => {
    const cx = Math.min(Math.max(x, R), S - R);
    const cy = Math.min(Math.max(y, R), S - R);
    if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) return [0, 0, 0, 0];
    const t = (x + y) / (2 * S);
    const base = [lerp(79, 27, t), lerp(220, 154, t), lerp(162, 170, t)];
    const dot = (x - 62) ** 2 + (y - 34) ** 2 <= 13 ** 2;
    return dot ? [255, 255, 255, 255] : [...base, 255];
  });
}

/** Bar chart: two series, light warm background, baseline + gridlines. */
function chartPng() {
  const W = 560;
  const H = 320;
  const M = 42; // margin
  const bars = [104, 128, 96, 150, 172, 158, 208, 232]; // px heights
  const bw = 44;
  const gap = 20;
  return encodePng(W, H, (x, y) => {
    if (y >= H - M && y < H - M + 3 && x >= M - 6 && x <= W - M + 6) return [58, 53, 50, 255]; // baseline
    if ((H - M - y) % 64 === 0 && y < H - M && x >= M - 6 && x <= W - M + 6) return [228, 221, 208, 255]; // gridline
    const i = Math.floor((x - M) / (bw + gap));
    if (i >= 0 && i < bars.length) {
      const x0 = M + i * (bw + gap);
      if (x >= x0 && x < x0 + bw && y < H - M && H - M - y <= bars[i]) {
        return i % 2 === 0 ? [61, 139, 253, 255] : [34, 192, 138, 255];
      }
    }
    return [253, 250, 243, 255];
  });
}

/** "Site photo" placeholder: dusk sky gradient, sun, dark ridge silhouette. */
function photoPng() {
  const W = 560;
  const H = 320;
  return encodePng(W, H, (x, y) => {
    const ridge = 210 + 26 * Math.sin(x / 52) + 14 * Math.sin(x / 19 + 2);
    if (y > ridge) return [46, 42, 38, 255];
    const t = y / H;
    const sky = [lerp(255, 251, t), lerp(214, 139, t), lerp(153, 139, t)];
    const sun = (x - 420) ** 2 + (y - 96) ** 2 <= 30 ** 2;
    return sun ? [255, 246, 223, 255] : [...sky, 255];
  });
}

// ---------- sample.pdf — two-page fictional quarterly review ----------

{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(logoPng());
  const chart = await doc.embedPng(chartPng());
  const photo = await doc.embedPng(photoPng());

  const ink = rgb(0.18, 0.16, 0.15);
  const gray = rgb(0.45, 0.42, 0.4);
  const ruleColor = rgb(0.88, 0.85, 0.8);

  const drawPara = (page, lines, x, y, size, opts = {}) => {
    for (const line of lines) {
      page.drawText(line, { x, y, size, font: opts.bold ? bold : font, color: opts.color ?? ink });
      y -= size * 1.25;
    }
    return y;
  };

  const footer = (page, n) => {
    page.drawText('Lifemana Store · Q2 2026 Review · Confidential', { x: 72, y: 46, size: 8.5, font, color: gray });
    page.drawText(`Page ${n} of 2`, { x: 493, y: 46, size: 8.5, font, color: gray });
  };

  // ----- page 1 -----
  const p1 = doc.addPage([612, 792]);
  p1.drawImage(logo, { x: 72, y: 706, width: 40, height: 40 });
  p1.drawText('Lifemana Store', { x: 124, y: 728, size: 16, font: bold, color: ink });
  p1.drawText('Insight for mid-market retail', { x: 124, y: 711, size: 9.5, font, color: gray });
  p1.drawRectangle({ x: 72, y: 692, width: 468, height: 1.5, color: ruleColor });

  p1.drawText('Quarterly Performance Review', { x: 72, y: 652, size: 22, font: bold, color: ink });
  p1.drawText('Q2 2026 · Prepared by the Insights Team · July 14, 2026', { x: 72, y: 632, size: 10.5, font, color: gray });

  let y = drawPara(
    p1,
    [
      'Lifemana Store helps mid-market retailers turn raw transaction data',
      'into clear, confident decisions. This review summarizes our second',
      'quarter: what we shipped, where revenue landed, and what we are',
      'watching as we head into the back half of the year.',
    ],
    72,
    598,
    11.5,
  );

  y -= 26;
  p1.drawText('Revenue Highlights', { x: 72, y, size: 13, font: bold, color: ink });
  y -= 19;
  y = drawPara(
    p1,
    [
      'Recurring revenue closed the quarter at $4.8 million, up 14 percent from',
      'Q1 and 31 percent year over year. Growth was led by the Coastal region,',
      'where the new forecasting module reached general availability in April',
      'and now accounts for roughly a fifth of new bookings.',
    ],
    72,
    y,
    11.5,
  );

  y -= 14;
  p1.drawImage(chart, { x: 72, y: y - 212, width: 371, height: 212 });
  y -= 212 + 16;
  p1.drawText('Figure 1 — Monthly recurring revenue by region (USD, thousands).', { x: 72, y, size: 9, font, color: gray });
  footer(p1, 1);

  // ----- page 2 -----
  const p2 = doc.addPage([612, 792]);
  p2.drawImage(logo, { x: 72, y: 730, width: 22, height: 22 });
  p2.drawText('Quarterly Performance Review — Q2 2026', { x: 102, y: 737, size: 9.5, font, color: gray });
  p2.drawRectangle({ x: 72, y: 720, width: 468, height: 1.5, color: ruleColor });

  y = 684;
  p2.drawText('Regional Operations', { x: 72, y, size: 13, font: bold, color: ink });
  y -= 19;
  y = drawPara(
    p2,
    [
      'Operations expanded on two fronts this quarter. The Halvorsen fulfillment',
      'site came online in May, cutting average delivery times in the northern',
      'markets from six days to four. Meanwhile the support team completed its',
      'move to follow-the-sun coverage, and first-response times fell below two',
      'hours for the first time in company history.',
    ],
    72,
    y,
    11.5,
  );

  y -= 14;
  p2.drawImage(photo, { x: 72, y: y - 212, width: 371, height: 212 });
  y -= 212 + 16;
  p2.drawText('Figure 2 — The Halvorsen fulfillment site, photographed at first light in May.', {
    x: 72,
    y,
    size: 9,
    font,
    color: gray,
  });

  y -= 34;
  p2.drawText('Outlook', { x: 72, y, size: 13, font: bold, color: ink });
  y -= 19;
  drawPara(
    p2,
    [
      'We enter the third quarter with a strong pipeline and one clear risk:',
      'renewal pricing in the Plains region remains under pressure from regional',
      'competitors. The pricing council meets in August with a recommendation',
      'due before the September board review. Elsewhere, we expect the',
      'forecasting module to keep compounding and plan to open early access to',
      'the inventory planner in October.',
    ],
    72,
    y,
    11.5,
  );
  footer(p2, 2);

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
  // Contents may already be an array — append, don't nest ([[6 0 R] 7 0 R]
  // is invalid and pdf.js drops the nested element, blanking the "scan")
  const existing = page.node.get(PDFName.of('Contents'));
  const resolved = ctx.lookup(existing);
  if (resolved?.constructor?.name === 'PDFArray') resolved.push(ref);
  else page.node.set(PDFName.of('Contents'), ctx.obj([existing, ref]));
  const resources = page.node.Resources();
  const fontDict = resources.lookup(PDFName.of('Font'));
  fontDict.set(PDFName.of('FOCR'), fontRef);
  writeFileSync('public/samples/scanned.pdf', await doc.save({ useObjectStreams: false }));
}

{
  // 1×1 PNG scaled up per placement — enough to drag/delete visibly
  const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
