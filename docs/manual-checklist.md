# Manual verification checklist

Run `npm run gen:samples && npm run build`, load `dist/` as an unpacked extension.

## Born-digital (sample.pdf)
- [ ] Open via toolbar button → file picker; page renders, 3 paragraph outlines on hover
- [ ] Click body paragraph → textarea appears seeded with paragraph text
- [ ] Replace a short word with a long one (`fox` → `velociraptor`), ⌘+Enter → paragraph reflows inside its box, line count may grow
- [ ] Escape cancels without changes
- [ ] Undo restores the original text
- [ ] Download → open the copy in Chrome's native viewer, macOS Preview, AND Acrobat Reader — text renders, no errors
- [ ] Search (⌘F in Preview/Acrobat) finds the edited word in the saved copy
- [ ] Type a character not in the doc font (e.g. `→`) → clear error toast, no corrupt output
- [ ] Type CJK (e.g. `恐竜`) → rejected with "not supported" message

## Scanned + OCR (scanned.pdf)
- [ ] Dashed amber boxes on each OCR word; toast announces scan mode
- [ ] Click `10482`, type a replacement, Enter → smudge covered by patch, crisp new text drawn
- [ ] Saved copy: old word not searchable, new word searchable
- [ ] Replacement longer than original → warning toast about patch width

## Colors
- [ ] Edit a paragraph, pick red with no selection → whole paragraph red after commit
- [ ] Select one word, pick a color → only that word changes; neighbors keep theirs
- [ ] Color-only change (no text edit) applies and undoes
- [ ] OCR patch with a custom ink color renders in that color

## Fonts & editors
- [ ] Edit box shows the document's embedded font (cid-fonts.pdf) — no Arial flash on commit
- [ ] Long paste grows the edit box; nothing clips; hint follows below
- [ ] Per-glyph PDF (browser print-to-PDF): spaces intact in the edit box and after edits

## General
- [ ] Zoom in/out re-renders pages and overlays stay aligned
- [ ] Debug boxes: red boxes on visible runs, green on OCR layer
- [ ] Encrypted PDF → banner, view-only, no crash
- [ ] Image-only scan (no text layer) → "no editable text layer" banner
- [ ] Navigate to a real `.pdf` URL → redirected into the viewer (best-effort)
- [ ] Save (picker-opened file) overwrites in place; drag-dropped file → Save disabled, Download works
