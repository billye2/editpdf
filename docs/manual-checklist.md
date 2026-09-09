# Manual verification checklist

Run `npm run gen:samples && npm run build`, load `dist/` as an unpacked extension.

## Born-digital (sample.pdf)

- [ ] Open via toolbar button → file picker; both report pages render (page 2 lazily on scroll), paragraph outlines on hover, logo/chart/photo images show purple outlines and drag
- [ ] Click body paragraph → textarea appears seeded with paragraph text
- [ ] Replace a short word with a long one (`fox` → `velociraptor`), ⌘+Enter → paragraph reflows inside its box, line count may grow
- [ ] Paste far too much text into a paragraph with content right below it → clear "would overlap" error toast, document unchanged (no garbled overlap)
- [ ] Escape cancels without changes
- [ ] Undo restores the original text; Redo re-applies it; a new edit after Undo disables Redo
- [ ] ✕ on the paragraph edit box deletes the whole paragraph; neighbors don't shift; undo restores it
- [ ] Save As → open the copy in Chrome's native viewer, macOS Preview, AND Acrobat Reader — text renders, no errors
- [ ] Search (⌘F in Preview/Acrobat) finds the edited word in the saved copy
- [ ] Type a character not in the doc font (e.g. `→`) → clear error toast, no corrupt output
- [ ] In a bold/italic/serif headline with a pruned subset font, type letters outside the subset → substituted words match the surrounding weight, slant, and serif style, rendered in the bundled Georgia-like serif (not Times)
- [ ] Type Latin-Extended text (e.g. `Świętokrzyska` or `Łódź`) into any paragraph → succeeds with the "substitute font was used" notice (was a hard reject before the bundled fonts); saved copy renders and searches correctly
- [ ] Type CJK (e.g. `恐竜`) → rejected with "not supported" message
- [ ] Drag a paragraph → box follows the pointer, text lands where dropped; a plain click still opens the editor
- [ ] In the open edit box, press-and-drag the ✥ handle (next to ✕) → the whole edit surface follows; release, keep typing, drag again — deltas stack; commit applies text + move together (unchanged text = exact translate-only move); Esc discards both
- [ ] Escape mid-drag cancels; paragraph stays put
- [ ] Zoom into moved text: spacing/kerning identical to before the move (justified paragraphs stay justified — a drag must never re-encode the text)
- [ ] Drag a paragraph over an image drawn after it → the image still paints ON TOP (moved in place, z-order preserved)
- [ ] Undo restores the moved paragraph to its old spot; Redo re-applies
- [ ] Saved copy shows the move in Preview/Acrobat and the moved text is still searchable
- [ ] Drag a paragraph onto (or within a line-height of) other text → the box stays FLOATING (amber dashed) at the drop spot with an orange warning bubble anchored on it (plus toast); the document is unchanged and Undo stays disabled
- [ ] From the floating box: drag on to an empty area → move applies; or press Esc → box returns to its original spot
- [ ] Clicking a floating box does NOT open the editor; starting to drag a different paragraph puts the floating one back first
- [ ] Same via the ✥ handle: commit with the edit box over other text → warning toast and the edit session STAYS OPEN at its floating spot (typed text kept); drag ✥ onward or Esc to cancel
- [ ] Dropping text over an image is still allowed (only text-on-text is blocked)
- [ ] A large heading can slide sideways past its smaller subtitle (e.g. center the sample's title) — the merge margin only applies between similar font sizes; strict text-on-text overlap is still refused

## Scanned + OCR (scanned.pdf)

- [ ] The "scan" renders as dark unreadable ink smudges on a beige page (regression: a nested /Contents array once blanked this layer entirely)
- [ ] Dashed purple boxes on each OCR word; toast announces scan mode
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

## Images (images.pdf)

- [ ] Hover an image → purple outline; drag it → box follows the pointer, lands where dropped after re-render
- [ ] Drag the rotated image → its center moves by exactly the drag distance
- [ ] Escape mid-drag cancels; image stays put
- [ ] Click an image → selected state with ✕ button; ✕ deletes it; Delete/Backspace key also deletes
- [ ] Delete/Backspace while a text edit box is focused does NOT delete the selected image
- [ ] Undo restores a moved image to its old spot and restores a deleted image
- [ ] Move an image so it overlaps text drawn after it → the text still paints ON TOP (z-order preserved)
- [ ] Saved copy opens in Preview/Chrome with the image moved/removed as expected

## Annotations

- [ ] Add text to a PDF in Edge (… menu → Add text), open it in PDF Edna → the added text has a paragraph outline and is editable
- [ ] After Save As, the FreeText annotation is gone (flattened); links in the document still work

## Persistence & permissions

- [ ] Edit a doc, close the tab → warning prompt; reopen viewer → restore bar offers the unsaved edits; Restore brings them back
- [ ] Discard on the restore bar, then reload → no offer reappears
- [ ] Save As after edits → no unload warning, no restore offer on next open
- [ ] Previously opened files (thumbtack button next to Save PDF): opened files appear (thumbnail, page count, size); click reopens; pin survives eviction; Clear all empties; off-switch stops new entries
- [ ] With unsaved edits, opening another PDF (drop, picker, thumbtack, sample) → confirm dialog; Cancel keeps the edited document, OK replaces it
- [ ] Fresh install: chrome://extensions shows no permissions and no site access; navigating to a .pdf URL opens Chrome's built-in viewer, never PDF Edna
- [ ] Start screen shows no "Enable auto-open" offer; toolbar button opens the viewer in a new tab
- [ ] Open a 60+ page PDF → first screen paints immediately; scrolling renders pages as they approach; zoom re-renders only visible pages

## General

- [ ] Header shows the PDF Edna wordmark + tagline; status pill reads "Nothing open yet" empty / "name · N pages" with a green dot when loaded
- [ ] Empty state: floating page-card cluster animates; "Try a sample" loads the bundled sample; dropping a non-PDF shows an inline message in the drop zone (no dialog)
- [ ] Empty state: the dashed box fills most of the window (~80%) and clicking anywhere inside it opens the file picker; the Choose/sample buttons inside still do their own thing (no double picker)
- [ ] "?" button cycles through different tips in the toast
- [ ] Zoom in/out re-renders pages and overlays stay aligned; ⌘/Ctrl +/−/0 and ⌘/Ctrl O/S/Z/⇧Z shortcuts work
- [ ] Fit width fills the window width; Fit page shows the whole page; overlays stay aligned after both
- [ ] Fit page while zoomed in AND scrolled down → the page you were reading ends up fully visible below the toolbar (regression)
- [ ] Show boxes switch: red boxes on visible runs, green on OCR layer; state survives a reload
- [ ] Encrypted PDF → banner, view-only, no crash
- [ ] Image-only scan (no text layer) → "no editable text layer" banner
- [ ] Navigate to a real `.pdf` URL → redirected into the viewer (best-effort)
- [ ] Save As opens a save dialog with `<name>-edited.pdf` suggested; the original file on disk is unchanged afterwards
- [ ] Save As works for drag-dropped files too; cancelling the dialog does nothing
