# PDF Edna Privacy

PDF Edna runs entirely in your browser. Your PDFs are never uploaded anywhere.

- **No network use.** Parsing, editing, rendering, and saving all happen
  locally. The extension makes no requests to any server. The only fetch it
  can ever perform is downloading a `.pdf` URL _you_ navigated to, into the
  local viewer — and only if you enabled auto-open (below).
- **No telemetry, no analytics, no accounts.**
- **No standing site access.** The extension installs with zero host
  permissions. The optional "auto-open PDF links" feature requires the
  `<all_urls>` host permission (Chrome has no narrower way to match "any URL
  ending in .pdf"); it is requested only when you click **Enable auto-open**
  on the start screen, and can be revoked any time at
  `chrome://extensions` → PDF Edna → Site access.

## What is stored locally on your device

- **Crash recovery**: after you edit a document, a snapshot of the edited PDF
  is kept in the browser's IndexedDB so an accidental tab close doesn't lose
  your work. It is deleted when you save or click Discard on the restore offer.
- **Recent files**: opened PDFs are cached locally (max 10 files / 100 MB,
  oldest evicted first) so you can reopen them quickly. Turn this off or clear
  it in the **Recents** dialog; pinned entries are never auto-evicted.
- **Preferences**: theme-independent UI switches (e.g. "remember recent
  files") in localStorage.

Clearing the extension's site data in Chrome removes all of the above.
