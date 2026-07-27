# Chrome Web Store listing material

Paste-ready copy for the developer dashboard. Keep in sync with
`public/manifest.json` and `PRIVACY.md`.

## Assets

- **Icon**: `src/icons/icon.svg` (blue rounded tile, bold E — same visual
  language as sibling PDF Mana). `npm run gen:icons` rasterizes it to
  `public/icons/icon{16,32,48,128}.png`, which the manifest references and
  the build copies into `dist/`. The 128px PNG is the store-listing icon.
- **Screenshots** (5 × 1280×800): `npm run build && npm run shots` →
  `release/screenshots/0{1..5}-*.png`. Branded frames: live captures for
  open/drop, retype-reflow, and recolor; abstract illustrations for
  drag-to-rearrange (A·B·C → C·A·B) and typo fixes.

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

## Data use disclosures

- No user data is collected or transmitted. All processing is local.
- Local storage only: IndexedDB for crash-recovery snapshots and the
  user-controllable recent-files cache; localStorage for UI preferences.
  See `PRIVACY.md` for the full inventory and how users clear each.

## Single purpose

Edit the text and images of PDF files locally in the browser.
