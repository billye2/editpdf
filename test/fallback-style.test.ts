// Fallback-font style matching for subset fonts with munged/meaningless names
// (news-site licensing): the name heuristic knows nothing, so weight comes
// from OS/2 usWeightClass (or StemV), slant from ItalicAngle/fsSelection, and
// serif-ness — scrubbed from all metadata — from the outline complexity of a
// stem glyph ('l'/'I': sans ≈ 4-6 points, serifs ≈ 12+). Regression for
// "fallback words in the bold serif headline render as light Helvetica".

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { EditableDocument } from '../src/engine/document';
import { stdFontFor } from '../src/engine/fonts/font-info';
import { parseTrueType } from '../src/engine/fonts/truetype';
import { StandardFonts } from 'pdf-lib';

const CORPUS = 'test/corpus-EDIT_SAMPLE.pdf';

describe.skipIf(!existsSync(CORPUS))('fallback style detection on munged subset fonts', () => {
  it('the heavy italic headline font falls back to Times-BoldItalic', async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS));
    const { doc } = await EditableDocument.load(bytes);
    const st = (doc as unknown as { pages: { fonts: Map<string, { baseFont: string; style: unknown }> }[] }).pages[0];
    const headline = [...st.fonts.values()].find((f) => f.baseFont.includes('Munged-aE29'))!;
    expect(headline).toBeTruthy();
    expect(headline.style).toEqual({ kind: 'serif', bold: true, italic: true });
    expect(stdFontFor(headline.style as never)).toBe(StandardFonts.TimesRomanBoldItalic);
  });

  it('sans faces with plain stem glyphs stay sans; named fonts keep name-derived style', async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS));
    const { doc } = await EditableDocument.load(bytes);
    const st = (doc as unknown as { pages: { fonts: Map<string, { baseFont: string; style: { kind: string } }> }[] })
      .pages[0];
    for (const f of st.fonts.values()) {
      if (f.baseFont.includes('TN_Web_Use_Only')) {
        // the alias hides both sans and slab faces — verify via the glyph probe
        const tt = parseTrueType((f as unknown as { fontFile2: Uint8Array }).fontFile2);
        const pts = tt?.pointCountFor('l'.codePointAt(0)!) ?? tt?.pointCountFor('I'.codePointAt(0)!);
        if (pts !== null && pts !== undefined) {
          expect(f.style.kind).toBe(pts >= 10 ? 'serif' : 'sans');
        }
      }
      if (f.baseFont.includes('Times-Roman')) expect(f.style.kind).toBe('serif');
    }
  });
});
