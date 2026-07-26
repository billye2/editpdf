# EditPDF

A Chrome extension (Manifest V3) that edits the **actual text** of a PDF — including scanned PDFs that have an OCR text layer — entirely client-side. When an edit changes text length (e.g. 3 characters replace 1), the paragraph **reflows** inside its original bounding box.

Maintainers: start with **[docs/HANDOFF.md](docs/HANDOFF.md)** — architecture, invariants, and release process.

## How it works

- **Born-digital PDFs** — the page's content stream is parsed into operators, a graphics-state interpreter reconstructs every text run's exact position, runs are clustered into words → lines → paragraphs, and edits regenerate the paragraph's text-showing operators with greedy line-wrapping inside the original paragraph box. Unedited words keep their original font; new words inherit a neighbor's font, falling back to an embedded standard font (Helvetica/Times/Courier family, style-matched) when the original subset font can't encode a character.
- **Scanned PDFs with an OCR layer** — the visible "text" in a scan is image pixels; the OCR text is invisible (text render mode 3). Editing a word paints a background-color-matched patch over the original pixels and draws crisp replacement text on top. The replacement is real, visible text, so search/copy stay in sync automatically.
- **Overflow policy** — if reflowed text doesn't fit the paragraph box, the font shrinks down to a 90% floor and the paragraph may grow into measured free space below it; an edit that would overlap other content is rejected with a clear error (overflow is never drawn over other content).
- **Images** — XObject image placements are editable objects: drag to move (the content stream is mutated in place at the `Do` operator, preserving z-order), click-select and delete.

Stack: [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, a custom content-stream engine (lexer → parser → interpreter → writer) as the single source of truth for text geometry, [pdf-lib](https://pdf-lib.js.org/) for document surgery and saving. The whole engine runs in a Web Worker (Comlink).

## Development

```sh
npm install
npm test              # engine test suite (round-trip, geometry, reflow, e2e edits)
npm run gen:samples   # writes public/samples/{sample,scanned,cid-fonts}.pdf
npm run dev           # vite dev server — open /viewer.html?file=/samples/sample.pdf
npm run build         # builds the extension into dist/
```

CI (GitHub Actions) runs type-check, tests, and the extension build on every push. Tests that need macOS system fonts or local-only corpus PDFs skip automatically elsewhere.

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
4. Click the EditPDF toolbar button (or navigate to any `.pdf` URL — navigation is redirected to the viewer, best-effort)

## Using it

- **Open** a PDF (file picker, drag-and-drop, or `.pdf` URL interception).
- Hover shows paragraph outlines; **click a paragraph** to edit its text in place. `⌘/Ctrl+Enter` applies, `Esc` cancels. The paragraph reflows to fit. The edit box uses the document's real embedded font when the browser can render it, and grows with your text. The **✕** at the edit box corner deletes the whole paragraph.
- **Images**: hover shows purple outlines; **drag** an image to move it, **click** to select and delete it (✕ button or Delete key).
- **Colors**: a swatch column appears beside the edit box. Pick with nothing selected to recolor the whole paragraph; **select text first to color just those words**. Existing mixed-color words keep their colors through edits.
- On scanned+OCR pages, words show **dashed amber boxes**; click one to patch-edit it (with its own ink-color picker).
- **Save As** opens a save dialog (suggesting `<name>-edited.pdf`) — the original file is never overwritten. **Undo/Redo** step through edits one at a time.
- **Crash recovery**: edits are snapshotted locally (IndexedDB); if the tab closes before you save, the viewer offers to restore them on next open. Closing with unsaved edits also warns first.
- **Recents**: reopen recently used files from the toolbar (content-hashed cache, max 10 files / 100 MB, pinnable, with an off switch). Everything stays on your device — see `PRIVACY.md`.
- The extension installs with **no site access**; automatic opening of `.pdf` links is an explicit opt-in on the start screen and can be revoked in `chrome://extensions`.
- **Debug boxes** (maintainer feature, hidden by default — open the viewer with `?debug` to reveal the toolbar checkbox) draws every detected text run (green = invisible OCR layer).

## Known limitations (v1)

- Fonts: new characters keep the document's embedded font whenever its font program contains their glyphs (verified against the font's own `cmap`; ToUnicode and CID widths are updated on save). Genuinely pruned subset fonts fall back to a standard font matched on real style signals — OS/2 weight class, italic angle, and (when licensing-munged subsets scrub all metadata) a stem-glyph outline probe that detects serifs — with an explanatory notice.
- Patch-over text on scans won't visually match the scanned typeface, and patch color sampling fails on textured/gradient backgrounds.
- Reflow is strictly within one detected paragraph — tables, text wrapped around images, and cross-column/cross-page flows are out of scope. Justified paragraphs are re-emitted left-aligned per-word (fine kerning from the original `TJ` arrays is lost in reflowed lines).
- Text inside Form XObjects is not editable (common in Illustrator-generated PDFs).
- Encrypted PDFs are view-only. Editing a signed PDF invalidates its signature.
- The tagged-PDF structure tree is not updated (screen-reader desync on edited paragraphs).
- Latin scripts only: RTL, CJK, and complex shaping are out of scope; characters not present in the document's fonts or the standard-14 fallbacks are rejected.
- Image-only scans (no OCR layer) are view-only — the viewer shows a notice.
- MV3 URL interception is best-effort (PDFs served without a `.pdf` extension may open in Chrome's native viewer); the file picker path always works.
