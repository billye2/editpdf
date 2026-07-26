# Chrome Web Store listing material

Paste-ready copy for the developer dashboard. Keep in sync with
`public/manifest.json` and `PRIVACY.md`.

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
