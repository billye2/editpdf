// Document lifecycle: opening bytes into the viewer and saving them back out.
// Opening dispatches a `pdfedna:document-opened` event on `document` so
// decoupled UI (the session-restore bar) can react without an import cycle.

import { engine } from './engine';
import { toolbar, statusPill, dropzone, banner, toast } from './ui';
import { doc, pageUIs, cancelAutosave, markClean, refreshHistoryButtons } from './state';
import { reloadPdfJs, renderAllPages, renderPage, captureThumb } from './render';
import { resetFontCache } from './editors';
import { recentsEnabled } from './prefs';
import { recordRecent } from './persist';

export const DOCUMENT_OPENED_EVENT = 'pdfedna:document-opened';

/** Replaces the current document. Returns false if the user kept their
 *  unsaved edits instead — the beforeunload guard only covers closing the
 *  tab, so in-app opens need their own warning. */
export async function openBytes(bytes: Uint8Array, name: string): Promise<boolean> {
  if (doc.dirty && doc.currentBytes) {
    const proceed = window.confirm(
      `You have unsaved edits to "${doc.fileName}".\n\nOpen "${name}" anyway? Your unsaved edits will be lost.`,
    );
    if (!proceed) return false;
  }
  doc.currentBytes = bytes;
  doc.fileName = name;
  doc.dirty = false;
  cancelAutosave();
  document.dispatchEvent(new CustomEvent(DOCUMENT_OPENED_EVENT)); // dismisses any restore offer
  toolbar.fileName.textContent = name;
  statusPill.classList.add('loaded');
  dropzone.remove();
  banner(null);
  doc.editingDisabled = false;
  resetFontCache();

  const outcome = await engine.load(bytes.slice());
  if (!outcome.ok) {
    doc.editingDisabled = true;
    banner(
      outcome.encrypted
        ? 'This PDF is encrypted — viewing only, editing is not supported.'
        : `This PDF could not be opened for editing (${outcome.error ?? 'unknown error'}) — viewing only.`,
    );
  }

  await reloadPdfJs();
  toolbar.fileName.textContent = `${name} · ${doc.pdf!.numPages} page${doc.pdf!.numPages === 1 ? '' : 's'}`;
  await renderAllPages(true);
  if (pageUIs.length) await renderPage(0); // first page eagerly: banner logic below needs its view

  toolbar.zoomIn.disabled = false;
  toolbar.zoomOut.disabled = false;
  toolbar.fitWidth.disabled = false;
  toolbar.fitPage.disabled = false;
  toolbar.save.disabled = false;
  await refreshHistoryButtons();

  if (!doc.editingDisabled && doc.pdf) {
    const first = pageUIs[0]?.view;
    if (first && !first.hasVisibleText && !first.hasOcrLayer) {
      banner('This page has no editable text layer — it is likely a scan without OCR. Run OCR on it first, then edit here.');
    } else if (first && !first.hasVisibleText && first.hasOcrLayer) {
      toast('Scanned PDF with OCR layer detected — click a highlighted word to patch-edit it.', 'info', 6000);
    }
  }

  // recents bookkeeping is strictly best-effort — never let it break an open
  if (recentsEnabled() && outcome.ok) {
    void recordRecent(bytes, { name, pageCount: outcome.pageCount, thumb: captureThumb() }).catch(() => {});
  }
  return true;
}

export async function openViaPicker(): Promise<void> {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (
        window as unknown as {
          showOpenFilePicker: (o: object) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({
        types: [{ description: 'PDF files', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const file = await handle.getFile();
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // fall through to input fallback
    }
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  };
  input.click();
}

/** Always Save As — the original file is never overwritten. */
export async function saveAs(): Promise<void> {
  if (!doc.currentBytes) return;
  const suggestedName = doc.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
  if (!('showSaveFilePicker' in window)) {
    download();
    return;
  }
  try {
    const handle = await (
      window as unknown as {
        showSaveFilePicker: (o: object) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker({
      suggestedName,
      types: [{ description: 'PDF files', accept: { 'application/pdf': ['.pdf'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(doc.currentBytes.slice());
    await writable.close();
    markClean();
    toast(`Saved ${handle.name}.`);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    toast(`Save failed: ${e instanceof Error ? e.message : String(e)} — downloading a copy instead.`, 'warn', 6000);
    download();
  }
}

function download(): void {
  if (!doc.currentBytes) return;
  markClean(); // the downloaded copy carries the edits
  const copy = doc.currentBytes.slice();
  const blob = new Blob([copy.buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
