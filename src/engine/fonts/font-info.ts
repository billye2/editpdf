// Builds a FontInfo (decode/encode/widths/style) for every font in a page's
// resources, from the raw PDF font dictionaries.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFRawStream,
  PDFFont,
  StandardFonts,
} from 'pdf-lib';
import * as pdfLib from 'pdf-lib';
import { parseToUnicode, winAnsiToUnicode, glyphNameToUnicode } from './encoding';
import { parseTrueType, type TTFont } from './truetype';

export interface FontStyle {
  kind: 'serif' | 'sans' | 'mono';
  bold: boolean;
  italic: boolean;
}

export interface FontInfo {
  res: string;
  baseFont: string;
  twoByte: boolean;
  ascent: number; // fraction of em
  descent: number; // fraction of em (negative)
  style: FontStyle;
  widthOf(code: number): number; // in 1/1000 em
  decode(bytes: Uint8Array): { code: number; u: string }[];
  encode(text: string): Uint8Array | null;
  widthOfText(text: string, size: number): number | null; // null if not encodable
  /** New code→unicode/width mappings minted from the embedded font's cmap; must be flushed to the PDF's ToUnicode + W. */
  pendingExt: Map<number, { u: string; w1000: number }>;
  /** In-session widths for extended codes (survives flush). */
  extWidths: Map<number, number>;
  /** Live decode map (code → unicode) — used to regenerate ToUnicode on flush. */
  toUnicodeMap: Map<number, string>;
  /** Underlying dictionaries, for flushing extensions. */
  dicts?: { fontDict: PDFDict; cidFont?: PDFDict };
  /** Raw embedded TrueType program (FontFile2), when present. */
  fontFile2?: Uint8Array;
}

/** Generate a complete ToUnicode CMap stream body from a code→unicode map. */
export function generateToUnicodeCMap(map: Map<number, string>): string {
  const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
  const hexUtf16 = (s: string) => {
    let out = '';
    for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i));
    return out;
  };
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(
      `${chunk.length} beginbfchar\n` +
        chunk.map(([code, u]) => `<${hex4(code)}> <${hexUtf16(u)}>`).join('\n') +
        '\nendbfchar',
    );
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

type Ctx = ReturnType<PDFDocument['context']['lookup']> extends never ? never : PDFDocument['context'];

function lookup(ctx: Ctx, v: unknown): unknown {
  if (v instanceof PDFRef) return ctx.lookup(v);
  return v;
}

function asDict(ctx: Ctx, v: unknown): PDFDict | undefined {
  const r = lookup(ctx, v);
  return r instanceof PDFDict ? r : undefined;
}

function asNum(ctx: Ctx, v: unknown): number | undefined {
  const r = lookup(ctx, v);
  return r instanceof PDFNumber ? r.asNumber() : undefined;
}

function asArr(ctx: Ctx, v: unknown): PDFArray | undefined {
  const r = lookup(ctx, v);
  return r instanceof PDFArray ? r : undefined;
}

function nameOf(v: unknown): string | undefined {
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function decodeStream(v: unknown): Uint8Array | undefined {
  if (v instanceof PDFRawStream) {
    const dec = (pdfLib as unknown as { decodePDFRawStream?: (s: PDFRawStream) => { decode(): Uint8Array } })
      .decodePDFRawStream;
    if (dec) return dec(v).decode();
    return v.getContents();
  }
  return undefined;
}

export function styleFromName(baseFont: string): FontStyle {
  const n = baseFont.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const kind: FontStyle['kind'] =
    /courier|mono|consol/.test(n) ? 'mono'
    : /times|serif|roman|georgia|garamond|book|palatino|cambria|minion/.test(n) ? 'serif'
    : 'sans';
  return {
    kind,
    bold: /bold|black|heavy|semib/.test(n),
    italic: /italic|oblique/.test(n),
  };
}

export function stdFontFor(style: FontStyle): StandardFonts {
  const { kind, bold, italic } = style;
  if (kind === 'mono') {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (kind === 'serif') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

// Scratch document for measuring standard-14 fonts that appear in loaded PDFs
// without a /Widths array.
let scratchDoc: PDFDocument | null = null;
const scratchFonts = new Map<string, PDFFont>();

async function metricsFontFor(style: FontStyle): Promise<PDFFont> {
  const std = stdFontFor(style);
  const cached = scratchFonts.get(std);
  if (cached) return cached;
  if (!scratchDoc) scratchDoc = await PDFDocument.create();
  const f = await scratchDoc.embedFont(std);
  scratchFonts.set(std, f);
  return f;
}

/** Parse a CID /W array into a width lookup. */
function parseCidWidths(ctx: Ctx, wArr: PDFArray | undefined, dw: number): (code: number) => number {
  const singles = new Map<number, number>();
  const ranges: { lo: number; hi: number; w: number }[] = [];
  if (wArr) {
    const items: unknown[] = [];
    for (let i = 0; i < wArr.size(); i++) items.push(lookup(ctx, wArr.get(i)));
    let i = 0;
    while (i < items.length) {
      const a = items[i];
      if (!(a instanceof PDFNumber)) { i++; continue; }
      const c = a.asNumber();
      const b = items[i + 1];
      if (b instanceof PDFArray) {
        for (let k = 0; k < b.size(); k++) {
          const w = asNum(ctx, b.get(k));
          if (w !== undefined) singles.set(c + k, w);
        }
        i += 2;
      } else if (b instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
        ranges.push({ lo: c, hi: b.asNumber(), w: (items[i + 2] as PDFNumber).asNumber() });
        i += 3;
      } else {
        i++;
      }
    }
  }
  return (code: number) => {
    const s = singles.get(code);
    if (s !== undefined) return s;
    for (const r of ranges) if (code >= r.lo && code <= r.hi) return r.w;
    return dw;
  };
}

export async function parseFont(pdfDoc: PDFDocument, res: string, fontDict: PDFDict): Promise<FontInfo> {
  const ctx = pdfDoc.context;
  const subtype = nameOf(fontDict.get(PDFName.of('Subtype'))) ?? '';
  const baseFont = nameOf(fontDict.get(PDFName.of('BaseFont'))) ?? '';
  const style = styleFromName(baseFont);

  const toUniStream = decodeStream(lookup(ctx, fontDict.get(PDFName.of('ToUnicode'))));
  const toUni = toUniStream ? parseToUnicode(toUniStream) : new Map<number, string>();

  let twoByte = false;
  let widthOf: (code: number) => number;
  let ascent = 0.75;
  let descent = -0.25;
  let encMap = new Map<number, string>(); // code -> unicode (from encoding, not ToUnicode)

  let stemV: number | undefined;
  let italicAngle: number | undefined;
  const applyDescriptor = (desc: PDFDict | undefined) => {
    if (!desc) return;
    const a = asNum(ctx, desc.get(PDFName.of('Ascent')));
    const d = asNum(ctx, desc.get(PDFName.of('Descent')));
    if (a !== undefined && a !== 0) ascent = a / 1000;
    if (d !== undefined && d !== 0) descent = d / 1000;
    stemV = asNum(ctx, desc.get(PDFName.of('StemV'))) ?? stemV;
    italicAngle = asNum(ctx, desc.get(PDFName.of('ItalicAngle'))) ?? italicAngle;
    const flags = asNum(ctx, desc.get(PDFName.of('Flags')));
    if (flags !== undefined) {
      if (flags & 1) style.kind = 'mono';
      else if (flags & 2) style.kind = 'serif';
      if (flags & 0x40000) style.bold = true;
      if (flags & 0x40) style.italic = true;
    }
  };

  let tt: TTFont | null = null;
  let ttTrusted = false;
  let dicts: FontInfo['dicts'];
  let fontFile2: Uint8Array | undefined;

  if (subtype === 'Type0') {
    twoByte = true; // supported case: Identity-H (and best-effort otherwise)
    const descArr = asArr(ctx, fontDict.get(PDFName.of('DescendantFonts')));
    const cidFont = descArr ? asDict(ctx, descArr.get(0)) : undefined;
    const dw = cidFont ? asNum(ctx, cidFont.get(PDFName.of('DW'))) ?? 1000 : 1000;
    const wArr = cidFont ? asArr(ctx, cidFont.get(PDFName.of('W'))) : undefined;
    widthOf = parseCidWidths(ctx, wArr, dw);
    applyDescriptor(cidFont ? asDict(ctx, cidFont.get(PDFName.of('FontDescriptor'))) : undefined);
    // For Identity-H, code == CID == glyph index. ToUnicode is the decode
    // path; the embedded font program's own cmap lets us ENCODE characters
    // the ToUnicode table doesn't cover (sparse/missing ToUnicode, or chars
    // never used before) — but only when the cmap can be trusted.
    if (cidFont) {
      dicts = { fontDict, cidFont };
      const cidSubtype = nameOf(cidFont.get(PDFName.of('Subtype')));
      const c2g = cidFont.get(PDFName.of('CIDToGIDMap'));
      const c2gIdentity = c2g === undefined || (c2g instanceof PDFName && c2g.decodeText() === 'Identity');
      if (cidSubtype === 'CIDFontType2' && c2gIdentity) {
        const desc = asDict(ctx, cidFont.get(PDFName.of('FontDescriptor')));
        const ff2 = desc ? decodeStream(lookup(ctx, desc.get(PDFName.of('FontFile2')))) : undefined;
        if (ff2) {
          fontFile2 = ff2;
          tt = parseTrueType(ff2);
        }
      }
      if (tt) {
        // Trust check: the cmap must agree with existing ToUnicode mappings
        // (a pruned/reordered subset font would disagree — extending it would
        // draw the WRONG glyphs, which is far worse than a fallback font).
        let checked = 0;
        let matches = 0;
        let mismatches = 0;
        for (const [code, u] of toUni) {
          if (checked >= 8) break;
          if ([...u].length !== 1) continue;
          const gid = tt.gidFor(u.codePointAt(0)!);
          if (gid === 0) continue; // inconclusive
          checked++;
          if (gid === code) matches++;
          else mismatches++;
        }
        const subsetTagged = /^[A-Z]{6}\+/.test(baseFont);
        ttTrusted = mismatches === 0 && (matches >= 1 || (toUni.size === 0 && !subsetTagged));
      }
    }
  } else {
    // Simple font (Type1 / TrueType / Type3-approx)
    const firstChar = asNum(ctx, fontDict.get(PDFName.of('FirstChar'))) ?? 0;
    const widthsArr = asArr(ctx, fontDict.get(PDFName.of('Widths')));
    const desc = asDict(ctx, fontDict.get(PDFName.of('FontDescriptor')));
    applyDescriptor(desc);
    fontFile2 = desc ? decodeStream(lookup(ctx, desc.get(PDFName.of('FontFile2')))) : undefined;
    const missingWidth = desc ? asNum(ctx, desc.get(PDFName.of('MissingWidth'))) ?? 0 : 0;

    // Encoding: base + differences
    let baseEncodingIsWinAnsi = true;
    const encVal = lookup(ctx, fontDict.get(PDFName.of('Encoding')));
    const diffs = new Map<number, string>();
    if (encVal instanceof PDFName) {
      baseEncodingIsWinAnsi = encVal.decodeText() !== 'MacRomanEncoding';
    } else if (encVal instanceof PDFDict) {
      const be = nameOf(encVal.get(PDFName.of('BaseEncoding')));
      baseEncodingIsWinAnsi = be !== 'MacRomanEncoding';
      const diffArr = asArr(ctx, encVal.get(PDFName.of('Differences')));
      if (diffArr) {
        let code = 0;
        for (let i = 0; i < diffArr.size(); i++) {
          const el = lookup(ctx, diffArr.get(i));
          if (el instanceof PDFNumber) code = el.asNumber();
          else if (el instanceof PDFName) {
            const u = glyphNameToUnicode(el.decodeText());
            if (u) diffs.set(code, u);
            code++;
          }
        }
      }
    }
    for (let c = 32; c < 256; c++) {
      encMap.set(c, baseEncodingIsWinAnsi ? winAnsiToUnicode(c) : String.fromCharCode(c));
    }
    for (const [c, u] of diffs) encMap.set(c, u);

    if (widthsArr) {
      const widths: number[] = [];
      for (let i = 0; i < widthsArr.size(); i++) widths.push(asNum(ctx, widthsArr.get(i)) ?? 0);
      widthOf = (code: number) => {
        const w = widths[code - firstChar];
        return w !== undefined && w > 0 ? w : missingWidth || 500;
      };
    } else {
      // Standard-14 font without Widths: use pdf-lib metrics via a scratch font.
      const metricsFont = await metricsFontFor(style);
      const local = encMap;
      widthOf = (code: number) => {
        const u = toUni.get(code) ?? local.get(code) ?? '';
        if (!u) return 500;
        try {
          return metricsFont.widthOfTextAtSize(u, 1000);
        } catch {
          return 500;
        }
      };
    }
  }

  // Style refinement beyond the name heuristic: subset fonts often carry
  // munged/meaningless names (news-site licensing), so the fallback face was
  // picked badly — e.g. a heavy serif headline falling back to light
  // Helvetica. The descriptor (StemV, ItalicAngle) and the font program's
  // OS/2 table (weight class, serif family class, PANOSE) are authoritative.
  const ttForStyle = tt ?? (fontFile2 ? parseTrueType(fontFile2) : null);
  const os2 = ttForStyle?.os2;
  let serifKnown = style.kind !== 'sans'; // name/flags already decided
  if (os2) {
    if (os2.weightClass >= 600) style.bold = true;
    if (os2.italic) style.italic = true;
    const serifByClass = (os2.familyClass >= 1 && os2.familyClass <= 5) || os2.familyClass === 7;
    const serifByPanose = os2.panose[0] === 2 && os2.panose[1] >= 2 && os2.panose[1] <= 10;
    if ((serifByClass || serifByPanose) && style.kind !== 'mono') {
      style.kind = 'serif';
      serifKnown = true;
    }
    if (os2.panose[0] === 2 && os2.panose[1] >= 11) serifKnown = true; // PANOSE says sans explicitly
  } else if (stemV !== undefined && stemV >= 150) {
    style.bold = true; // no OS/2 to consult; heavy stems ⇒ bold-ish fallback
  }
  if (italicAngle !== undefined && Math.abs(italicAngle) > 4) style.italic = true;
  // Explicitly-sans family names are trusted; otherwise, when metadata gave no
  // serif verdict (munged subsets zero it out), sniff a stem glyph's outline.
  const strippedName = baseFont.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (/helvetica|arial|verdana|tahoma|segoe|roboto|futura|gill|franklin|grotes|gothic|lato|open ?sans|noto ?sans/.test(strippedName)) {
    serifKnown = true;
  }
  if (!serifKnown && ttForStyle) {
    for (const ch of ['l', 'I']) {
      const pts = ttForStyle.pointCountFor(ch.codePointAt(0)!);
      if (pts === null) continue;
      if (pts >= 10) style.kind = 'serif';
      break; // first measurable stem glyph decides
    }
  }

  // reverse map for encoding new text: unicode -> code
  const reverse = new Map<string, number>();
  for (const [c, u] of encMap) if (u && !reverse.has(u)) reverse.set(u, c);
  for (const [c, u] of toUni) if (u && !reverse.has(u)) reverse.set(u, c);

  const decode = (bytes: Uint8Array): { code: number; u: string }[] => {
    const out: { code: number; u: string }[] = [];
    if (twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = bytes[i] * 256 + bytes[i + 1];
        out.push({ code, u: toUni.get(code) ?? '' });
      }
    } else {
      for (const code of bytes) {
        out.push({ code, u: toUni.get(code) ?? encMap.get(code) ?? String.fromCharCode(code) });
      }
    }
    return out;
  };

  const pendingExt = new Map<number, { u: string; w1000: number }>();
  const extWidths = new Map<number, number>();

  const baseWidthOf = widthOf;
  widthOf = (code: number) => extWidths.get(code) ?? baseWidthOf(code);

  const encode = (text: string): Uint8Array | null => {
    const codes: number[] = [];
    for (const ch of text) {
      let c = reverse.get(ch);
      if (c === undefined && twoByte && tt && ttTrusted) {
        // mint a new code from the embedded font's own cmap (Identity-H: code == gid)
        const gid = tt.gidFor(ch.codePointAt(0)!);
        if (gid > 0 && gid <= 0xffff && gid < tt.numGlyphs) {
          c = gid;
          const w1000 = Math.round((tt.advanceFor(gid) * 1000) / tt.unitsPerEm);
          pendingExt.set(gid, { u: ch, w1000 });
          extWidths.set(gid, w1000);
          reverse.set(ch, gid);
          if (!toUni.has(gid)) toUni.set(gid, ch);
        }
      }
      if (c === undefined) return null;
      codes.push(c);
    }
    if (twoByte) {
      const out = new Uint8Array(codes.length * 2);
      codes.forEach((c, i) => {
        out[i * 2] = (c >> 8) & 0xff;
        out[i * 2 + 1] = c & 0xff;
      });
      return out;
    }
    if (codes.some((c) => c > 255)) return null;
    return new Uint8Array(codes);
  };

  const widthOfText = (text: string, size: number): number | null => {
    const enc = encode(text);
    if (!enc) return null;
    let w = 0;
    if (twoByte) {
      for (let i = 0; i + 1 < enc.length; i += 2) w += widthOf(enc[i] * 256 + enc[i + 1]);
    } else {
      for (const c of enc) w += widthOf(c);
    }
    return (w / 1000) * size;
  };

  return {
    res,
    baseFont,
    twoByte,
    ascent,
    descent,
    style,
    widthOf,
    decode,
    encode,
    widthOfText,
    pendingExt,
    extWidths,
    toUnicodeMap: toUni,
    dicts,
    fontFile2,
  };
}

/** Parse all fonts in a page's resources. */
export async function parsePageFonts(
  pdfDoc: PDFDocument,
  resources: PDFDict | undefined,
): Promise<Map<string, FontInfo>> {
  const fonts = new Map<string, FontInfo>();
  if (!resources) return fonts;
  const ctx = pdfDoc.context;
  const fontDict = asDict(ctx, resources.get(PDFName.of('Font')));
  if (!fontDict) return fonts;
  for (const [key, val] of fontDict.entries()) {
    const resName = key.decodeText();
    const fd = asDict(ctx, val);
    if (!fd) continue;
    try {
      fonts.set(resName, await parseFont(pdfDoc, resName, fd));
    } catch {
      // unparseable font — leave it out; interpreter falls back to defaults
    }
  }
  return fonts;
}
