// Viewer entry point: imports wire the toolbar, dialogs, editors, and render
// pipeline (each module attaches its own listeners at import time); this file
// keeps only what's left — the empty-state actions, window-level drag & drop,
// and boot (session restore).
//
// Module map (imports point strictly left → right; state's re-render hooks
// and the document-opened event keep it acyclic):
//   engine · util · prefs · ui → state → editors · images → render
//     → open-save → dialogs → toolbar → main

import './toolbar';
import { $, dropzone, dropError, toast } from './ui';
import { openBytes, openViaPicker } from './open-save';
import { offerRestoreIfAny } from './dialogs';

// ---------- empty-state actions ----------

$<HTMLButtonElement>('btn-choose').addEventListener('click', () => void openViaPicker());

// like PDF Mana, the whole dashed box is one big "open a file" button; inner
// buttons/links (choose, sample) keep their own actions
$<HTMLDivElement>('drop-card').addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('button, a, input')) return;
  void openViaPicker();
});

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
    toast(`Could not load the sample: ${e instanceof Error ? e.message : String(e)}`, 'error');
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

// ---------- boot ----------

offerRestoreIfAny();
