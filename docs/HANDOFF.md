# PDF Edna (formerly EditPDF) — Maintainer Handoff

Chrome extension (MV3) for true PDF text and image editing, fully
client-side. Current version: see `package.json` (bumped by every release).
Repo: `github.com/billye2/editpdf`
(private). CI runs type-check + lint (ESLint type-aware + Prettier) + tests + build, plus a Playwright e2e job, on every push
(`.github/workflows/ci.yml`). `npm run release` bumps, builds, zips the
Chrome Web Store upload into gitignored `release/`, commits, tags, pushes.

## What it does

- **Born-digital PDFs**: click a paragraph → edit its text in place → the
  paragraph reflows inside its original box plus any measured free space
  below it (font shrink to a 90% floor on overflow). Edits that would
  overlap the content below are REJECTED with an error — overflow lines are
  never drawn over other content (`freeHeightBelow` in document.ts +
  `extraHeight` in reflow.ts; regression: test/overflow.test.ts). Word-level
  and paragraph-level text coloring. Paragraph delete via the edit box ✕.
  Paragraphs can also be **dragged to move** (translate-only: kerning,
  justification, fonts, and paint order are untouched — see invariant 11).
  Free placement like images — no destination overlap check; dropping flush
  against same-styled text may merge the outlines on the next render
  (paragraph detection is heuristic and generation-scoped).
- **Scanned PDFs with an OCR layer**: click a word → a background-matched
  patch covers the original pixels and crisp replacement text (which becomes
  the new searchable text layer) is drawn on top.
- **Images (XObject)**: drag to move, click-select + Delete/✕ to remove. Each
  `Do` of a `/Subtype /Image` XObject is an independent placement (bbox = CTM
  × unit square). Inline images (`BI…EI`) and images nested in Form XObjects
  are untouched (round-trip byte-exactly).
- **FreeText annotations** (text added by Edge/Acrobat/Preview text tools)
  are flattened into the page content stream at load (`annotations.ts`:
  spec 12.5.5 BBox→Rect transform, resource merge with rename-on-collision,
  annotation removed) — so that text is editable like any other paragraph.
  Gotcha encoded there: graphics state persists ACROSS content streams, so
  the original streams are first sandwiched in their own q/Q (real files
  leave a scaled CTM dangling). Other annotation types are untouched.
- Save is always Save As (File System Access picker, `-edited` suggested name;
  falls back to a browser download) — the original file is never overwritten.
  There is no separate Download button. Opening a PDF over a document with
  unsaved edits (drop/picker/recents/sample) asks for confirmation first.
- Viewer UI (July 2026): "Sunny" restyle per the approved design in
  `docs/EditPDF UI style directions.zip` (Nunito/Baloo 2 bundled in
  `public/fonts/` — extension pages must not hit CDNs). "?" button cycles
  help tips through the toast; thumbtack icon-button next to Save PDF opens
  previously-opened files; "Show boxes" switch is always visible and
  persisted (formerly `?debug`). Keyboard: ⌘/Ctrl O · S · Z · ⇧Z · +/− · 0.

## Architecture

```
viewer (DOM, src/viewer/)  ←Comlink→  engine worker (pure TS, src/engine/)
  main.ts        entry: boot, drag-drop,          worker.ts     API surface
                 empty state, auto-open opt-in    document.ts   EditableDocument (orchestrator)
  engine.ts      Comlink handle to the worker
  ui.ts          DOM refs, toast, banner
  util.ts        geometry + color helpers (pure)
  prefs.ts       localStorage UI preferences
  state.ts       doc state, dirty/autosave, edit
                 pipeline (applyEdit/applyHistory)
  editors.ts     paragraph + OCR edit surfaces
  images.ts      image select/drag/delete
  drag.ts        shared drag-to-move machinery
                 (images + paragraphs)
  render.ts      pdf.js pipeline, overlays, zoom
  open-save.ts   openBytes / pickers / save-as
  dialogs.ts     recents, restore bar, help tips
  toolbar.ts     control wiring + shortcuts
  viewer.css
                                                  content-stream/  lexer → parser → interpreter → writer
                                                  text-model/      paragraphs.ts (words/lines/paras)
                                                  fonts/           font-info.ts, truetype.ts, encoding.ts
                                                  reflow/          reflow.ts (LCS diff + greedy wrap)
                                                  annotations.ts   FreeText → page-content flattening
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
   WRONG glyphs, which is worse than the look-alike fallback. On success,
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
10. **Never nest a page's `/Contents` array.** Appending a stream by wrapping
    the existing value (`ctx.obj([existing, ref])`) produces `[[6 0 R] 7 0 R]`
    when Contents is already an array — invalid PDF that pdf.js silently
    drops (the sample's whole "scan" layer rendered blank) while our engine
    tolerates it, so no test caught it. Look up the existing value and `push`
    into the array (see gen-samples.mjs / test/helpers.ts makeOcrPdf).
11. **Paragraph move is translate-only and IN PLACE** (`moveParagraph`) —
    never routed through reflow/re-encode (that would silently re-align
    justified text and drop TJ kerning) and never appended at stream end
    (invariant 9's z-order rule). Each original show op is sandwiched between
    an absolute `Tm` (the interpreter-recorded `tmAtShow` — the tm when the
    first glyph paints, NOT the tlm, since a show op can continue another's
    advanced tm — plus the page delta through the inverse of the CTM's linear
    part) and a restore `Tm` (the recorded original tlm), so every downstream
    op sees the original text-line-matrix chain. `'`/`"` convert to
    `Tw Tc Tj` with the leading move already baked into the recorded matrix.
    A `Tj`/`TJ` outside the paragraph that continued a tm chain the restore
    reset gets pinned with its own original matrices; a TJ shared across
    column-split paragraphs refuses to move (it would drag the other column
    along — the same latent hazard exists in removeShowOps-based edits).
    All matrix numbers use full-precision `pnum` (writer.ts). The enabling
    data is `InterpretResult.showOps` (per-show-op tm/tlm/CTM snapshots).
    Regression: test/move-paragraph.test.ts.

## Paragraph heuristics (text-model/paragraphs.ts)

Lines: baseline grouping (0.35×size tolerance) → column split on 3×size gaps.
Paragraph merge is refused on: leading > 1.9×size, poor x-overlap, font-size
discontinuity > 15%, differing per-line dominant fonts, short-header rule
(block much narrower than incoming line), short-last-line rule. Single-line
paragraphs may grow toward the page text-area's right edge when edited.
Word boundaries: whitespace-class glyphs, undecodable glyphs with space-sized
advances (≥ 0.15em), or inter-run gaps > 0.2×size.

## Testing

`npx vitest run` — 108 tests, including the jsdom viewer harness
(`test/viewer-dom.test.ts`: real viewer.html + main.ts with pdf.js/Comlink/
Worker mocked; localStorage must be stubbed at test-file top level — vitest
detaches jsdom's accessor from its window). Some groups auto-skip off-macOS/CI:

- `fonts-cid.test.ts` needs `/System/Library/Fonts/Supplemental/Arial Bold.ttf`.
- `per-glyph-pdf.test.ts`, parts of `overflow.test.ts`, and
  `fallback-style.test.ts` need `test/corpus-EDIT_SAMPLE.pdf` — a **local-only
  user document** (gitignored via `test/corpus-*.pdf` and `test/*.pdf`; do not
  commit user PDFs).
- `persist.test.ts` runs against `fake-indexeddb` (dev dependency).

`npm run test:e2e` — Playwright suite (`e2e/viewer.spec.ts`, Chromium against
the vite dev server on port 4273, real engine + real pdf.js): empty state,
sample load, fit-page-while-scrolled regression, paragraph edit→undo→redo
round-trip, unsaved-edits warning, persistence. CI runs it as a separate job
(gen:samples first — `public/samples/` is gitignored).

Sample PDFs for manual testing: `npm run gen:samples` → `public/samples/`
(sample.pdf is a born-digital 2-page report with embedded PNG images — the
"Try a sample" document; plus a fake OCR sandwich and real embedded CID
fonts; images are drawn by a dependency-free PNG encoder in the script, so
no binary assets live in the repo). Manual test script
in `docs/manual-checklist.md`. In-browser verification pattern: drive the vite
dev server (`viewer.html?file=/samples/…`) with browser automation, assert via
DOM + canvas `getImageData` pixel counts.

`node scripts/promo-video.mjs` — records the store promo video (webm) by
driving the real viewer with Playwright: injected cursor/captions/title
cards, no post-production. Re-record after any visual redesign.

## Versioning & release

Decimal rollover, NOT semver: `1.5.9 → 1.6.0` (and `1.9.9 → 2.0.0`).

- `npm run bump` — bump `package.json` + `public/manifest.json` in lockstep.
- `npm run release` — clean-tree check, type-check, tests, bump, build,
  commit `Release vX.Y.Z`, tag, push. `-- --dry-run` runs checks only.

## Known limitations / next work (rough priority)

0. **Annotation ADDING — DROPPED** (user decision, July 2026): annotation
   tools are freely available in existing viewers, so building one here
   adds no differentiated value. Do not re-propose. The flatten-at-load
   behavior for existing FreeText annotations stays as-is.
1. **Form XObject recursion** — text and images inside Form XObjects are
   invisible to the engine (Illustrator/InDesign PDFs). Largest real-world
   coverage gap.
2. **Performance** — every edit does a full `pdfDoc.save()` + full pdf.js
   reload of the edited page. Page rendering is lazy (IntersectionObserver,
   300px margin) and engine page models build on first access
   (`EditableDocument.load(bytes, {lazy:true})` in the worker;
   `ensurePageReady`), so open cost scales with the first screen, not the
   document. Remaining ceiling: `pdfDoc.save()` is whole-document.
3. Viewer modularization done (July 2026): 12 modules, imports strictly
   one-way (engine/util/prefs/ui → state → editors/images → render →
   open-save → dialogs → toolbar → main). Two seams keep it acyclic: state's
   injected `rerender` hooks (filled by render.ts) and the
   `pdfedna:document-opened` event (open-save → dialogs' restore bar). Keep
   imports pointing down this chain. Gotcha that motivated the viewer test
   harness: a hoisted function referencing a later `const` (TDZ) had the
   ReferenceError swallowed by its own try/catch — module-scope startup code
   must run after the consts it depends on.
4. CFF/Type1 fonts can't be extended (TrueType only); RTL/CJK/shaping out of
   scope; justified text re-emitted left-aligned; tagged-PDF structure tree
   not updated; signatures invalidated on save (full save, not incremental);
   encrypted PDFs view-only; sub-word coloring not supported (word granularity).
5. **Fallback style matching** (font-info.ts style refinement): glyphs absent
   from a pruned subset can never be recovered — the fallback face is matched
   via OS/2 usWeightClass / StemV (weight), ItalicAngle / fsSelection (slant),
   and, when metadata is scrubbed (munged news-site subsets zero familyClass
   AND PANOSE), a stem-glyph outline probe ('l'/'I' point count ≥ 10 ⇒ serif;
   `pointCountFor` in truetype.ts). Regression: test/fallback-style.test.ts.
6. **Bundled look-alike fallbacks** (July 2026, `fonts/fallback-fonts.ts`):
   the fallback ladder is original-font extension (CID trust gate) → bundled
   look-alike → standard-14. Bundled faces: Gelasio (Georgia-metric serif)
   and Liberation Sans (Arial-metric), 4 styles each, SIL OFL, shipped in
   `public/fonts/fallback/` with their licenses. The viewer fetches them and
   registers bytes over Comlink (`registerFallbackFonts`; the engine still
   does zero I/O — node tests register from disk). Per-WORD tier choice in
   `document.ts fallbackKeyFor`: bundled iff every char has a real glyph in
   the face's own cmap (fontkit maps missing chars to .notdef — tofu — so
   pdf-lib's encoder can't be the gate). Measurement reads the TTF's own
   cmap+hmtx (`bundledWidth`) so unused faces are never embedded; emit
   embeds lazily via pdf-lib+fontkit `{subset: true}` (fontkit is a RUNTIME
   dependency now). Mono stays Courier. Regression: fallback-bundled.test.ts.
