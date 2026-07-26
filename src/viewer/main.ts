// Viewer entry point: imports wire the toolbar, dialogs, editors, and render
// pipeline (each module attaches its own listeners at import time); this file
// keeps only what's left — the empty-state actions, window-level drag & drop,
// the optional auto-open permission opt-in, and boot (?file= / session
// restore).
//
// Module map (imports point strictly left → right; state's re-render hooks
// and the document-opened event keep it acyclic):
//   engine · util · prefs · ui → state → editors · images → render
//     → open-save → dialogs → toolbar → main

import './toolbar';
import { $, dropzone, dropError, banner, toast } from './ui';
import { openBytes, openViaPicker } from './open-save';
import { offerRestoreIfAny } from './dialogs';

// ---------- empty-state actions ----------

$<HTMLButtonElement>('btn-choose').addEventListener('click', () => void openViaPicker());

const sampleBtn = $<HTMLButtonElement>('btn-sample');
sampleBtn.addEventListener('click', async () => {
  sampleBtn.disabled = true;
  const label = sampleBtn.textContent;
  sampleBtn.textContent = 'Opening…';
  try {
    const resp = await fetch('samples/sample.pdf');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const opened = await openBytes(new Uint8Array(await resp.arrayBuffer()), 'sample.pdf');
    if (!opened) {
      sampleBtn.disabled = false;
      sampleBtn.textContent = label;
    }
  } catch (e) {
    toast(`Could not load the sample: ${e instanceof Error ? e.message : e}`, 'error');
    sampleBtn.disabled = false;
    sampleBtn.textContent = label;
  }
});

// ---------- window-level drag & drop ----------
// Drag-over treatment lives on the whole window (the design accepts drops
// anywhere on the canvas), with a counter to survive nested dragenter/leave.

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.classList.add('drag-over');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzone.classList.remove('drag-over');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.pdf$/i.test(file.name)) {
    dropError.hidden = true;
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  } else if (file) {
    // inline message in the drop zone, per the design — no modal alerts
    if (dropzone.isConnected) {
      dropError.textContent = `"${file.name}" isn't a PDF — drop a .pdf file instead.`;
      dropError.hidden = false;
    } else {
      toast('That file isn’t a PDF — drop a .pdf file instead.', 'warn');
    }
  }
});

// ---------- optional auto-open permission ----------
// The extension ships with no standing host permissions; redirecting .pdf
// navigations into the viewer needs <all_urls>, offered here as an opt-in.

const chromePerms = typeof chrome !== 'undefined' ? chrome.permissions : undefined;

function offerAutoOpenOptIn(): void {
  if (!chromePerms || !dropzone.isConnected) return;
  void chromePerms
    .contains({ origins: ['<all_urls>'] })
    .then((granted) => {
      if (granted || !dropzone.isConnected) return;
      const p = document.createElement('p');
      p.className = 'hint';
      p.append('Want .pdf links to open here automatically? ');
      const btn = document.createElement('button');
      btn.className = 'autopen-btn';
      btn.textContent = 'Enable auto-open';
      btn.addEventListener('click', () => {
        void chromePerms
          .request({ origins: ['<all_urls>'] })
          .then((ok) => {
            if (ok) {
              p.remove();
              toast('Auto-open enabled — PDF links will now open in PDF Edna.', 'info', 5000);
            }
          })
          .catch(() => {});
      });
      p.append(btn);
      dropzone.querySelector('#drop-extra')?.append(p);
    })
    .catch(() => {});
}
offerAutoOpenOptIn();

// ---------- boot ----------
// ?file=<url> — used by the navigation-intercept redirect

const fileParam = new URLSearchParams(location.search).get('file');
if (!fileParam) {
  offerRestoreIfAny();
} else {
  (async () => {
    try {
      const resp = await fetch(fileParam);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const name = decodeURIComponent(fileParam.split('/').pop() ?? 'document.pdf').split('?')[0];
      await openBytes(buf, name);
    } catch (e) {
      let hint = '';
      if (chromePerms) {
        const granted = await chromePerms.contains({ origins: ['<all_urls>'] }).catch(() => false);
        if (!granted) hint = ' PDF Edna may need the auto-open permission to fetch PDFs from websites.';
      }
      banner(`Could not fetch ${fileParam}: ${e instanceof Error ? e.message : e}.${hint}`);
    }
  })();
}
