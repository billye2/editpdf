# Chrome Web Store listing material

Paste-ready copy for the developer dashboard. Keep in sync with
`public/manifest.json` and `PRIVACY.md`.

## Description

The store's description field is PLAIN TEXT (no markdown/HTML). Copy the
block below verbatim — structure comes from caps headers, bullets (•), and
blank lines, which the dashboard preserves.

Format mirrors the live PDF Mana listing: hook line, short intro, terse
emoji one-liner bullets, USE CASES, PRIVATE BY DESIGN.

```
Edit the text of any PDF — fully local, nothing uploaded.

Click a paragraph, retype it, done: the words reflow to fit and nothing else on the page shifts. Fix typos, update details, move text and images — WITHOUT ever uploading your PDFs to a server. Everything happens right in your browser 100%.

PDF Edna — real text editing in one place

✏️ Edit — click any paragraph and just type; it reflows in the document's own fonts.
📄 Fix scans — if the scan has an OCR text layer, click a word and retype it; a page-matched patch covers the old print and search stays in sync.
🧲 Move — drag paragraphs and images anywhere; spacing, kerning, and fonts are preserved exactly, with a warning before text lands on text.
🎨 Recolor — select text, pick a color; one word or the whole paragraph.
🗑️ Delete — remove a paragraph or an image cleanly.
↩️ Undo — step back through every edit (Ctrl+Z / ⌘Z).
💾 Safe saves — always a new copy; your original file is never touched.

USE CASES

⚡ Fix the typo in an invoice, report, or flyer seconds before sending — no source file needed.
📝 Update a date, price, name, or address on a PDF someone else made.
🔍 Correct OCR mistakes so scanned paperwork finally searches right.
🖼️ Tidy a layout — nudge a heading, move a logo, rearrange sections.
🔒 Keep it private — no upload, no account, no watermark.

PRIVATE BY DESIGN

Your files never leave your computer. PDF Edna has no servers, no accounts, no analytics, and no tracking — all PDF reading and writing happens locally in your browser. It installs with no access to any website; auto-opening .pdf links is an optional, revocable opt-in.
```

## Assets

- **Icon**: `src/icons/icon.svg` (coral-red rounded tile, bold E — same
  visual language and palette as sibling PDF Mana). `npm run gen:icons` rasterizes it to
  `public/icons/icon{16,32,48,128}.png`, which the manifest references and
  the build copies into `dist/`. The 128px PNG is the store-listing icon.
- **Screenshots** (5 × 1280×800): `npm run build && npm run shots` →
  `release/screenshots/0{1..5}-*.png`. Branded frames: live captures for
  open/drop, retype-reflow, and recolor; abstract illustrations for
  drag-to-rearrange (A·B·C → C·A·B) and typo fixes.
- **Promo tiles**: `npm run promo` → `release/promo/small-440x280.png` and
  `release/promo/marquee-1400x560.png` (coral gradient, inverse white E
  tile, wordmark + "Edit Text ’n Arrange" — same layout as PDF Mana's
  tiles).
- **Promo videos**: `node scripts/promo-video.mjs` → the general tour
  (`release/promo/pdf-edna-promo.webm`); `npm run promo:video2` → the
  five-scene text-editing tour (edit two paragraphs, recolor + center the
  title, delete two paragraphs + double undo,
  `release/promo/pdf-edna-promo-2.webm`, ~42 s). The dashboard's video
  field takes a YouTube URL — upload the webm there first.

## Permission justifications

**`declarativeNetRequest`**
Used solely to redirect top-frame navigations to `*.pdf` URLs into the
extension's local viewer page, and only after the user opts in to auto-open.
No request contents are read or modified; the single dynamic rule is a
redirect on `^https?://.*\.pdf(\?.*)?$` main-frame navigations. The rule is
removed whenever the optional host permission is revoked.

**`<all_urls>` (optional host permission)**
Requested at runtime, only when the user clicks "Enable auto-open" on the
start screen. Required for two things: (1) declarativeNetRequest redirect
actions need host access for the redirected URL, and PDF links can live on
any origin — there is no narrower match pattern for "any URL ending in
.pdf"; (2) fetching the user-navigated PDF into the viewer tab. The
extension installs and is fully functional (file picker, drag-and-drop)
without this permission.

## Single purpose (required field)

> Edit PDF files locally in the browser — retype and recolor text, patch
> OCR'd words in scans, and move or delete text and images — entirely
> on-device, with no server processing.

## Remote code

Select **"No, I am not using remote code."** All code and assets (the pdf.js
worker, pdf-lib, fonts) are bundled in the package; the extension executes
no remotely hosted or dynamically fetched code. The only network fetch is
the PDF _data_ the user chooses to open (data, not code), and only after the
optional auto-open opt-in.

## Data usage (privacy tab checkboxes)

- **Data collected:** check NOTHING. The extension collects none of the
  dashboard's categories (no personal info, no web history, no user
  activity, no website content leaves the device — PDFs are processed
  locally and never transmitted).
- **Certifications (check all three):**
  - I do not sell or transfer user data to third parties, outside of the
    approved use cases.
  - I do not use or transfer user data for purposes that are unrelated to
    my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or
    for lending purposes.
- Local-only storage (not "collection": never transmitted): IndexedDB for
  crash-recovery snapshots and the user-controllable recent-files cache;
  localStorage for UI preferences. See `PRIVACY.md` for the inventory and
  how users clear each.
- **Privacy policy URL:** required by the dashboard — PRIVACY.md needs a
  public home first (the repo is private); host it (e.g. a public gist,
  GitHub Pages, or making the repo public) and paste that URL.
