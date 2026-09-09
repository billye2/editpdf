# PDF Edna: Edit PDF Text, Fix Typos, Color and Move Text

A Chrome extension (Manifest V3) that edits the **actual text** of a PDF — including scanned PDFs that have an OCR text layer — entirely client-side. When an edit changes text length (e.g. 3 characters replace 1), the paragraph **reflows** inside its original bounding box. (Internal identifiers and the repo keep the original working name `editpdf`.)

Source: https://github.com/billye2/pdfedna · Privacy: [PRIVACY.md](PRIVACY.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

## How it works

- **Born-digital PDFs** — the page's content stream is parsed into operators, a graphics-state interpreter reconstructs every text run's exact position, runs are clustered into words → lines → paragraphs, and edits regenerate the paragraph's text-showing operators with greedy line-wrapping inside the original paragraph box. Unedited words keep their original font; new words inherit a neighbor's font, falling back to an embedded standard font (Helvetica/Times/Courier family, style-matched) when the original subset font can't encode a character.
- **Scanned PDFs with an OCR layer** — the visible "text" in a scan is image pixels; the OCR text is invisible (text render mode 3). Editing a word paints a background-color-matched patch over the original pixels and draws crisp replacement text on top. The replacement is real, visible text, so search/copy stay in sync automatically.
- **Overflow policy** — if reflowed text doesn't fit the paragraph box, the font shrinks down to a 90% floor and the paragraph may grow into measured free space below it; an edit that would overlap other content is rejected with a clear error (overflow is never drawn over other content).
- **Moving text** — paragraphs can be dragged to a new position. Moves are translate-only: the original text operators are re-anchored in place (never re-encoded), so kerning, justification, fonts, and paint order survive the move exactly. Destinations that overlap (or nearly touch) other text are refused with a warning — the box stays floating at the drop spot so you can keep dragging to an empty area, or press `Esc` to put it back. (Dropping text onto text would otherwise merge the blocks in the editor's paragraph model.)
- **Images** — XObject image placements are editable objects: drag to move (the content stream is mutated in place at the `Do` operator, preserving z-order), click-select and delete.
- **Text added by other tools** — FreeText annotations (Edge / Acrobat / Preview "add text") are flattened into real page content at load, so that text is editable, reflowable, and deletable like any native paragraph. Links and other annotations are preserved.

Stack: [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, a custom content-stream engine (lexer → parser → interpreter → writer) as the single source of truth for text geometry, [pdf-lib](https://pdf-lib.js.org/) for document surgery and saving. The whole engine runs in a Web Worker (Comlink).

## Development

```sh
npm install
npm test              # engine + viewer-DOM test suite (round-trip, geometry, reflow, UI wiring)
npm run test:e2e      # Playwright end-to-end suite (real engine + rendering in Chromium)
npm run lint          # ESLint (type-aware) + Prettier check; lint:fix to auto-fix
npm run gen:samples   # writes public/samples/{sample,scanned,cid-fonts}.pdf
npm run dev           # vite dev server — open /viewer.html?file=/samples/sample.pdf
npm run build         # builds the extension into dist/
```

CI (GitHub Actions) runs type-check, tests, the extension build, and the Playwright e2e suite on every push. Tests that need macOS system fonts or local-only corpus PDFs skip automatically elsewhere.

## Versioning & releases

Versions use **decimal rollover**, not semver: `1.5.9 → 1.6.0`, `1.9.9 → 2.0.0`.

```sh
npm run bump                  # next version in package.json + manifest
npm run release               # checks → bump → build → commit → tag → push
npm run release -- --dry-run  # run the checks, touch nothing
```

## Install the extension

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Click the PDF Edna toolbar button (or navigate to any `.pdf` URL — navigation is redirected to the viewer, best-effort)

## Using it

- **Open** a PDF (file picker, drag-and-drop, or `.pdf` URL interception).
- Hover shows paragraph outlines; **click a paragraph** to edit its text in place. `⌘/Ctrl+Enter` applies, `Esc` cancels. The paragraph reflows to fit. The edit box uses the document's real embedded font when the browser can render it, and grows with your text. The **✕** at the edit box corner deletes the whole paragraph. **Drag a paragraph** to move it (`Esc` mid-drag cancels) — the text keeps its exact spacing and fonts. While editing, press and drag the **✥** handle next to the ✕ to move the paragraph without leaving the editor; committing applies your text changes and the move together.
- **Images**: hover shows purple outlines; **drag** an image to move it, **click** to select and delete it (✕ button or Delete key).
- **Colors**: a swatch column appears beside the edit box. Pick with nothing selected to recolor the whole paragraph; **select text first to color just those words**. Existing mixed-color words keep their colors through edits.
- On scanned+OCR pages, words show **dashed purple boxes**; click one to patch-edit it (with its own ink-color picker).
- **Save PDF** opens a save dialog (suggesting `<name>-edited.pdf`) — the original file is never overwritten. **Undo/Redo** step through edits one at a time.
- **Crash recovery**: edits are snapshotted locally (IndexedDB); if the tab closes before you save, the viewer offers to restore them on next open. Closing with unsaved edits also warns first.
- **Previously opened files**: the thumbtack button next to Save PDF reopens recently used files (content-hashed cache, max 10 files / 100 MB, pinnable, with an off switch). Everything stays on your device — see `PRIVACY.md`.
- The **?** button cycles through usage tips.
- The extension installs with **no site access**; automatic opening of `.pdf` links is an explicit opt-in on the start screen and can be revoked in `chrome://extensions`.
- **Show boxes** (toolbar switch, persisted) outlines every detected text run (green = invisible OCR layer).

## Known limitations (v1)

- Fonts: new characters keep the document's embedded font whenever its font program contains their glyphs (verified against the font's own `cmap`; ToUnicode and CID widths are updated on save). Genuinely pruned subset fonts fall back to a **bundled open-licensed look-alike** — Gelasio (Georgia-metric serif) or Liberation Sans (Arial-metric), both SIL OFL, embedded as subsets — matched on real style signals: OS/2 weight class, italic angle, and (when licensing-munged subsets scrub all metadata) a stem-glyph outline probe that detects serifs. The bundled faces cover Latin-Extended, Greek, and Cyrillic; the standard-14 fonts remain a last tier. An explanatory notice is shown whenever a substitute is used.
- Patch-over text on scans won't visually match the scanned typeface, and patch color sampling fails on textured/gradient backgrounds.
- Reflow is strictly within one detected paragraph — tables, text wrapped around images, and cross-column/cross-page flows are out of scope. Justified paragraphs are re-emitted left-aligned per-word (fine kerning from the original `TJ` arrays is lost in reflowed lines).
- Text inside Form XObjects is not editable (common in Illustrator-generated PDFs).
- Encrypted PDFs are view-only. Editing a signed PDF invalidates its signature.
- The tagged-PDF structure tree is not updated (screen-reader desync on edited paragraphs).
- RTL, CJK, and complex shaping are out of scope; characters not present in the document's fonts or the bundled fallback faces are rejected.
- Image-only scans (no OCR layer) are view-only — the viewer shows a notice.
- MV3 URL interception is best-effort (PDFs served without a `.pdf` extension may open in Chrome's native viewer); the file picker path always works.

## License

MIT — see [LICENSE](LICENSE). Bundled dependencies and fonts are listed with
their licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The name
**PDF Edna**, the icons, and the promo assets are not part of the MIT grant;
forks must ship under a different name and icon.
