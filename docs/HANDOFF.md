# EditPDF — Maintainer Handoff

Chrome extension (MV3) for true PDF text editing, fully client-side. Current
version **1.5.5**. Repo: `github.com/billye2/editpdf` (private). CI runs
type-check + tests + build on every push (`.github/workflows/ci.yml`).

## What it does

- **Born-digital PDFs**: click a paragraph → edit its text in place → the
  paragraph reflows inside its original box (font shrink to a 90% floor on
  overflow, then flagged). Word-level and paragraph-level text coloring.
- **Scanned PDFs with an OCR layer**: click a word → a background-matched
  patch covers the original pixels and crisp replacement text (which becomes
  the new searchable text layer) is drawn on top.
- **Images (XObject)**: drag to move, click-select + Delete/✕ to remove. Each
  `Do` of a `/Subtype /Image` XObject is an independent placement (bbox = CTM
  × unit square). Inline images (`BI…EI`) and images nested in Form XObjects
  are untouched (round-trip byte-exactly).
- Save is always Save As (File System Access picker, `-edited` suggested name;
  falls back to a browser download) — the original file is never overwritten.
  There is no separate Download button.

## Architecture

```
viewer (DOM, src/viewer/)  ←Comlink→  engine worker (pure TS, src/engine/)
  main.ts        UI, overlays, editors            worker.ts     API surface
  viewer.css                                      document.ts   EditableDocument (orchestrator)
                                                  content-stream/  lexer → parser → interpreter → writer
                                                  text-model/      paragraphs.ts (words/lines/paras)
                                                  fonts/           font-info.ts, truetype.ts, encoding.ts
                                                  reflow/          reflow.ts (LCS diff + greedy wrap)
  background/background.ts  MV3 .pdf-URL redirect (installed only while the
                            optional <all_urls> grant exists; synced on
                            permissions.onAdded/onRemoved)
  shared/types.ts           serializable protocol between the two sides
  viewer/persist.ts         IndexedDB: crash-recovery session snapshot +
                            content-hashed recents cache (best-effort only —
                            persistence must never break viewing/editing)
```

**Data flow of an edit**: viewer builds an edit request → `document.ts` plans
reflow (`planReflow`), resolves fonts, regenerates the paragraph's operators
(grouped `Tj`s with REAL space glyphs), removes the old show-ops, flushes any
font extensions, rewrites the page content stream via pdf-lib, saves → viewer
reloads pdf.js from the new bytes and re-renders the page.

The custom interpreter — not pdf.js — is the single source of truth for text
geometry. pdf.js only renders and serves as an independent cross-check in tests.

## Hard-won invariants (violating any of these re-introduces a shipped bug)

1. **`q`/`Q` saves the FULL graphics state** including text state (`Tr`
   render mode, font, spacing). Only saving CTM/color leaks invisible-text
   mode into appended ops.
2. **Emit real space glyphs** between words (grouped `Tj`s). Per-word
   absolutely-positioned `Tj`s render fine but extractors see words run
   together (copy/paste/search break).
3. **Resource names are NOT font identity.** Generators mint a fresh name per
   op for the same font. Compare stripped `BaseFont` (see `fontIdentity` in
   `document.ts`).
4. **Never filter whitespace-only runs out of the text model.** Browser
   print-to-PDF emits every glyph — including every space — as its own op.
   Space runs carry word boundaries and must be removed with the paragraph on
   edit. Geometry/statistics use ink runs only (`isInkRun`).
5. **Always pass `bytes.slice()` to pdf.js** — it transfers the buffer to its
   worker and detaches it.
6. **Page content streams are merged and wrapped in `q…Q` at load**
   (`getContentBytes`), so appended edit blocks start from pristine state.
7. **CID font extension is trust-gated**: new chars are encoded via the
   embedded TrueType's own cmap (Identity-H ⇒ code == gid) only when the cmap
   agrees with existing ToUnicode samples — a reordered subset would draw
   WRONG glyphs, which is worse than the standard-font fallback. On success,
   ToUnicode + W arrays are flushed to the PDF (`flushFontExtensions`).
   Known wart: undo restores content streams but not font-dict mutations
   (harmless — unused mappings).
8. **Verify UI claims with an independent extractor** (pdf.js legacy build in
   tests) **and canvas pixel analysis** — never with the engine's own model
   (that's circular; it hid the missing-spaces bug once).
9. **Image ops mutate IN PLACE at the `Do`'s op index — never append at
   stream end.** Text edits append (safe: new text paints last), but an
   appended image would repaint above everything drawn after it. Move replaces
   the `Do` with `q cm Do Q` at the same index (`D = M·T(dx,dy)·M⁻¹`, a pure
   translation in local space, emitted at full precision — `fmtNum`'s 4
   decimals drift under large CTM scales); delete drops just the `Do` (no
   graphics-state side effects).

## Paragraph heuristics (text-model/paragraphs.ts)

Lines: baseline grouping (0.35×size tolerance) → column split on 3×size gaps.
Paragraph merge is refused on: leading > 1.9×size, poor x-overlap, font-size
discontinuity > 15%, differing per-line dominant fonts, short-header rule
(block much narrower than incoming line), short-last-line rule. Single-line
paragraphs may grow toward the page text-area's right edge when edited.
Word boundaries: whitespace-class glyphs, undecodable glyphs with space-sized
advances (≥ 0.15em), or inter-run gaps > 0.2×size.

## Testing

`npx vitest run` — 53 tests. Two groups auto-skip off-macOS/CI:
- `fonts-cid.test.ts` needs `/System/Library/Fonts/Supplemental/Arial Bold.ttf`.
- `per-glyph-pdf.test.ts` needs `test/corpus-EDIT_SAMPLE.pdf` — a **local-only
  user document** (gitignored via `test/corpus-*.pdf`; do not commit user PDFs).

Sample PDFs for manual testing: `npm run gen:samples` → `public/samples/`
(born-digital, fake OCR sandwich, real embedded CID fonts). Manual test script
in `docs/manual-checklist.md`. In-browser verification pattern: drive the vite
dev server (`viewer.html?file=/samples/…`) with browser automation, assert via
DOM + canvas `getImageData` pixel counts.

## Versioning & release

Decimal rollover, NOT semver: `1.5.9 → 1.6.0` (and `1.9.9 → 2.0.0`).
- `npm run bump` — bump `package.json` + `public/manifest.json` in lockstep.
- `npm run release` — clean-tree check, type-check, tests, bump, build,
  commit `Release vX.Y.Z`, tag, push. `-- --dry-run` runs checks only.

## Known limitations / next work (rough priority)

1. **Form XObject recursion** — text and images inside Form XObjects are
   invisible to the engine (Illustrator/InDesign PDFs). Largest real-world
   coverage gap.
2. **Performance** — every edit does a full `pdfDoc.save()` + full pdf.js
   reload of the edited page. Page rendering is lazy (IntersectionObserver,
   300px margin) and engine page models build on first access
   (`EditableDocument.load(bytes, {lazy:true})` in the worker;
   `ensurePageReady`), so open cost scales with the first screen, not the
   document. Remaining ceiling: `pdfDoc.save()` is whole-document.
3. Viewer is a ~800-line monolith (`main.ts`) with no automated UI tests.
4. CFF/Type1 fonts can't be extended (TrueType only); RTL/CJK/shaping out of
   scope; justified text re-emitted left-aligned; tagged-PDF structure tree
   not updated; signatures invalidated on save (full save, not incremental);
   encrypted PDFs view-only; sub-word coloring not supported (word granularity).
