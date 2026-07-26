// Bundled look-alike fallback fonts (first tier of the fallback ladder).
//
// The standard-14 fallback has two weaknesses the shipped news-site case
// exposed: it caps coverage at WinAnsi (any Latin-Ext/Greek/Cyrillic char is
// a hard reject) and it maps every serif to Times — so a sturdy news serif
// (NYT Cheltenham et al.) degrades into visibly wrong Times words. The
// extension therefore ships open-licensed look-alikes with much wider
// character sets:
//   serif — Gelasio (metric-compatible with Georgia; SIL OFL)
//   sans  — Liberation Sans (metric-compatible with Arial/Helvetica; SIL OFL)
// mono keeps the standard Courier — code samples in PDFs are rare and Courier
// is a faithful look for them.
//
// The engine never does I/O: the viewer fetches the TTFs and registers the
// bytes here over Comlink (node tests call registerFallbackFonts directly
// with readFileSync bytes). If nothing is registered, every caller falls
// through to the standard-14 tier — the pre-bundled behavior.

import { parseTrueType, type TTFont } from './truetype';
import type { FontStyle } from './font-info';

export type BundledKey =
  | 'serif-regular'
  | 'serif-bold'
  | 'serif-italic'
  | 'serif-bolditalic'
  | 'sans-regular'
  | 'sans-bold'
  | 'sans-italic'
  | 'sans-bolditalic';

interface BundledFont {
  bytes: Uint8Array;
  tt: TTFont;
}

const VALID_KEYS: ReadonlySet<string> = new Set([
  'serif-regular',
  'serif-bold',
  'serif-italic',
  'serif-bolditalic',
  'sans-regular',
  'sans-bold',
  'sans-italic',
  'sans-bolditalic',
]);

const registry = new Map<BundledKey, BundledFont>();

/** Register bundled fallback font files. Unknown keys and unparseable entries
 *  are skipped — a bad font file must never break editing, only degrade it to
 *  standard-14. */
export function registerFallbackFonts(files: Record<string, Uint8Array>): void {
  for (const [key, bytes] of Object.entries(files)) {
    if (!bytes || !VALID_KEYS.has(key)) continue;
    const tt = parseTrueType(bytes);
    if (tt) registry.set(key as BundledKey, { bytes, tt });
  }
}

/** Test hook: forget everything registered (module state is process-wide). */
export function clearFallbackFonts(): void {
  registry.clear();
}

export function bundledKeyFor(style: FontStyle): BundledKey | null {
  if (style.kind === 'mono') return null; // Courier stays the mono fallback
  const face = style.bold && style.italic ? 'bolditalic' : style.bold ? 'bold' : style.italic ? 'italic' : 'regular';
  const key = `${style.kind}-${face}` as BundledKey;
  return registry.has(key) ? key : null;
}

export function isBundledKey(key: string): key is BundledKey {
  return VALID_KEYS.has(key);
}

export function bundledBytes(key: BundledKey): Uint8Array {
  return registry.get(key)!.bytes;
}

/** True when every character of `text` has a real glyph in the bundled font.
 *  Checked against the font's own cmap (fontkit/pdf-lib map missing chars to
 *  .notdef instead of failing — silently rendering tofu is never acceptable). */
export function bundledCanEncode(key: BundledKey, text: string): boolean {
  const tt = registry.get(key)!.tt;
  for (const ch of text) {
    const gid = tt.gidFor(ch.codePointAt(0)!);
    if (gid <= 0 || gid >= tt.numGlyphs) return false;
  }
  return true;
}

/** Width of `text` at `size`, from the font's own cmap+hmtx — sync and with
 *  no pdf-lib embedding, so measurement never forces unused faces into the
 *  saved file. Matches the embedded result because pdf-lib writes the same
 *  hmtx advances into the CID /W array. */
export function bundledWidth(key: BundledKey, text: string, size: number): number {
  const tt = registry.get(key)!.tt;
  let units = 0;
  for (const ch of text) units += tt.advanceFor(tt.gidFor(ch.codePointAt(0)!));
  return (units / tt.unitsPerEm) * size;
}
