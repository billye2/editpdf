# EditPDF

A Chrome extension (Manifest V3) that edits the **actual text** of a PDF — including scanned PDFs that have an OCR text layer — entirely client-side. When an edit changes text length (e.g. 3 characters replace 1), the paragraph **reflows** inside its original bounding box.

## How it works

- **Born-digital PDFs** — the page's content stream is parsed into operators, a graphics-state interpreter reconstructs every text run's exact position, runs are clustered into words → lines → paragraphs, and edits regenerate the paragraph's text-showing operators with greedy line-wrapping inside the original paragraph box. Unedited words keep their original font; new words inherit a neighbor's font, falling back to an embedded standard font (Helvetica/Times/Courier family, style-matched) when the original subset font can't encode a character.
- **Scanned PDFs with an OCR layer** — the visible "text" in a scan is image pixels; the OCR text is invisible (text render mode 3). Editing a word paints a background-color-matched patch over the original pixels and draws crisp replacement text on top. The replacement is real, visible text, so search/copy stay in sync automatically.
- **Overflow policy** — if reflowed text doesn't fit the paragraph box, the font shrinks down to a 90% floor; beyond that the edit is applied and flagged.

Stack: [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, a custom content-stream engine (lexer → parser → interpreter → writer) as the single source of truth for text geometry, [pdf-lib](https://pdf-lib.js.org/) for document surgery and saving. The whole engine runs in a Web Worker (Comlink).

## Development

```sh
npm install
npm test              # engine test suite (round-trip, geometry, reflow, e2e edits)
npm run gen:samples   # writes public/samples/{sample,scanned}.pdf
npm run dev           # vite dev server — open /viewer.html?file=/samples/sample.pdf
npm run build         # builds the extension into dist/
```

## Install the extension

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Click the EditPDF toolbar button (or navigate to any `.pdf` URL — navigation is redirected to the viewer, best-effort)

## Using it

- **Open** a PDF (file picker, drag-and-drop, or `.pdf` URL interception).
- Hover shows paragraph outlines; **click a paragraph** to edit its text in place. `⌘/Ctrl+Enter` applies, `Esc` cancels. The paragraph reflows to fit.
- On scanned+OCR pages, words show **dashed amber boxes**; click one to patch-edit it.
- **Save** overwrites the opened file (only when opened via the file picker); **Download** always works. **Undo** reverts edits one at a time.
- **Debug boxes** in the toolbar draws every detected text run (green = invisible OCR layer).

## Known limitations (v1)

- Fonts: new characters keep the document's embedded font whenever its font program contains their glyphs (verified against the font's own `cmap`; ToUnicode and CID widths are updated on save). Genuinely pruned subset fonts fall back to a style-matched standard font for the affected words, with an explanatory notice.
- Patch-over text on scans won't visually match the scanned typeface, and patch color sampling fails on textured/gradient backgrounds.
- Reflow is strictly within one detected paragraph — tables, text wrapped around images, and cross-column/cross-page flows are out of scope. Justified paragraphs are re-emitted left-aligned per-word (fine kerning from the original `TJ` arrays is lost in reflowed lines).
- Text inside Form XObjects is not editable (common in Illustrator-generated PDFs).
- Encrypted PDFs are view-only. Editing a signed PDF invalidates its signature.
- The tagged-PDF structure tree is not updated (screen-reader desync on edited paragraphs).
- Latin scripts only: RTL, CJK, and complex shaping are out of scope; characters not present in the document's fonts or the standard-14 fallbacks are rejected.
- Image-only scans (no OCR layer) are view-only — the viewer shows a notice.
- MV3 URL interception is best-effort (PDFs served without a `.pdf` extension may open in Chrome's native viewer); the file picker path always works.
