// Minimal TrueType parser: just enough to map unicode -> glyph id (cmap
// formats 4 and 12) and glyph id -> advance width (hhea/hmtx), so new
// characters can be encoded against a document's embedded font.

export interface TTFont {
  unitsPerEm: number;
  numGlyphs: number;
  gidFor(cp: number): number; // 0 = missing
  advanceFor(gid: number): number; // in font units
  /** Outline point count of a simple glyph, or null (missing/composite/no
   *  glyf access). Stem glyphs ('l', 'I') have ~4-6 points in sans faces and
   *  12+ with serifs — a last-resort serif signal when metadata is scrubbed. */
  pointCountFor(cp: number): number | null;
  /** OS/2 table style signals (absent when the subset drops the table). */
  os2?: {
    weightClass: number; // usWeightClass: 400 regular, 700 bold
    familyClass: number; // sFamilyClass high byte: 1-5,7 serif; 8 sans
    panose: Uint8Array; // 10 bytes; [0]==2 text-and-display, [1] 2-10 serif
    italic: boolean; // fsSelection bit 0
  };
}

export function parseTrueType(bytes: Uint8Array): TTFont | null {
  try {
    return parse(bytes);
  } catch {
    return null;
  }
}

function parse(bytes: Uint8Array): TTFont | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sfnt = dv.getUint32(0);
  // 0x00010000 = TrueType, 'true' = Apple TrueType. 'OTTO' (CFF) not supported.
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) return null;
  const numTables = dv.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    tables.set(tag, { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
  }
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');
  if (!head || !maxp || !hhea || !hmtx || !cmap) return null;

  const unitsPerEm = dv.getUint16(head.offset + 18);
  const numGlyphs = dv.getUint16(maxp.offset + 4);
  const numHMetrics = dv.getUint16(hhea.offset + 34);

  const advanceFor = (gid: number): number => {
    if (gid < 0 || numHMetrics === 0) return 0;
    const idx = Math.min(gid, numHMetrics - 1);
    return dv.getUint16(hmtx.offset + idx * 4);
  };

  // pick best cmap subtable: (3,10) fmt12 > (3,1) fmt4 > (0,*)
  const nSub = dv.getUint16(cmap.offset + 2);
  let best: { score: number; offset: number } | null = null;
  for (let i = 0; i < nSub; i++) {
    const o = cmap.offset + 4 + i * 8;
    const platform = dv.getUint16(o);
    const encoding = dv.getUint16(o + 2);
    const offset = cmap.offset + dv.getUint32(o + 4);
    let score = 0;
    if (platform === 3 && encoding === 10) score = 5;
    else if (platform === 3 && encoding === 1) score = 4;
    else if (platform === 0) score = 3;
    else if (platform === 3 && encoding === 0) score = 2; // symbol
    if (score && (!best || score > best.score)) best = { score, offset };
  }
  if (!best) return null;

  const format = dv.getUint16(best.offset);
  let gidFor: (cp: number) => number;

  if (format === 4) {
    const o = best.offset;
    const segCount = dv.getUint16(o + 6) / 2;
    const endO = o + 14;
    const startO = endO + segCount * 2 + 2;
    const deltaO = startO + segCount * 2;
    const rangeO = deltaO + segCount * 2;
    gidFor = (cp: number): number => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < segCount; s++) {
        const end = dv.getUint16(endO + s * 2);
        if (cp > end) continue;
        const start = dv.getUint16(startO + s * 2);
        if (cp < start) return 0;
        const delta = dv.getInt16(deltaO + s * 2);
        const rangeOffset = dv.getUint16(rangeO + s * 2);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const glyphO = rangeO + s * 2 + rangeOffset + (cp - start) * 2;
        if (glyphO + 1 >= bytes.byteLength) return 0;
        const gid = dv.getUint16(glyphO);
        return gid === 0 ? 0 : (gid + delta) & 0xffff;
      }
      return 0;
    };
  } else if (format === 12) {
    const o = best.offset;
    const nGroups = dv.getUint32(o + 12);
    gidFor = (cp: number): number => {
      let lo = 0;
      let hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = o + 16 + mid * 12;
        const start = dv.getUint32(g);
        const end = dv.getUint32(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return dv.getUint32(g + 8) + (cp - start);
      }
      return 0;
    };
  } else {
    return null;
  }

  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  const longLoca = dv.getInt16(head.offset + 50) !== 0;
  const pointCountFor = (cp: number): number | null => {
    if (!loca || !glyf) return null;
    const gid = gidFor(cp);
    if (gid <= 0 || gid >= numGlyphs) return null;
    try {
      const at = (i: number) => (longLoca ? dv.getUint32(loca.offset + i * 4) : dv.getUint16(loca.offset + i * 2) * 2);
      const o = at(gid);
      const next = at(gid + 1);
      if (next <= o) return null; // empty glyph
      const nContours = dv.getInt16(glyf.offset + o);
      if (nContours <= 0) return null; // composite
      return dv.getUint16(glyf.offset + o + 10 + (nContours - 1) * 2) + 1;
    } catch {
      return null;
    }
  };

  let os2: TTFont['os2'];
  const os2T = tables.get('OS/2');
  if (os2T && os2T.length >= 64) {
    const o = os2T.offset;
    os2 = {
      weightClass: dv.getUint16(o + 4),
      familyClass: dv.getInt16(o + 30) >> 8,
      panose: bytes.slice(o + 32, o + 42),
      italic: (dv.getUint16(o + 62) & 1) !== 0,
    };
  }

  return { unitsPerEm: unitsPerEm || 1000, numGlyphs, gidFor, advanceFor, pointCountFor, os2 };
}
