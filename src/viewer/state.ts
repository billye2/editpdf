// Mutable document state shared across the viewer, plus the edit/undo
// pipeline that mutates it. Rendering is injected via `rerender` (render.ts
// fills it in) so this module never imports upward — the import graph stays
// acyclic: engine/util/ui → state → editors/images → render → open-save →
// dialogs → toolbar → main.

import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { PageView } from '../shared/types';
import { saveSession, clearSession } from './persist';
import { engine } from './engine';
import { toolbar, toast } from './ui';

export interface PageUI {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  viewport: PageViewport;
  view: PageView | null;
  rendered: boolean;
}

export const pageUIs: PageUI[] = [];
export const baseDims: { w: number; h: number }[] = []; // per-page size at zoom 1

/** The single mutable document record. Mutate fields in place — modules hold
 *  a reference to this object, never to its fields. */
export const doc = {
  currentBytes: null as Uint8Array | null,
  pdf: null as PDFDocumentProxy | null,
  fileName: 'document.pdf',
  zoom: 1.25,
  editingDisabled: false,
  dirty: false, // an edit was applied and not yet saved anywhere
};

/** Re-render entry points, injected by render.ts at startup. */
export const rerender = {
  reload: async (): Promise<void> => {},
  page: async (_index: number): Promise<void> => {},
  all: async (_rebuild: boolean): Promise<void> => {},
};

// ---------- unsaved-edit tracking + autosave ----------

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

/** Called after every committed edit/undo/redo: arms the unload guard and
 *  debounces a crash-recovery snapshot into IndexedDB (best-effort). */
export function markDirty(): void {
  doc.dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (!doc.dirty || !doc.currentBytes) return;
    void saveSession({ bytes: doc.currentBytes.slice(), fileName: doc.fileName, savedAt: Date.now() }).catch(() => {});
  }, 800);
}

export function markClean(): void {
  doc.dirty = false;
  clearTimeout(autosaveTimer);
  void clearSession().catch(() => {});
}

export function cancelAutosave(): void {
  clearTimeout(autosaveTimer);
}

window.addEventListener('beforeunload', (e) => {
  if (!doc.dirty) return;
  e.preventDefault();
  e.returnValue = ''; // required by Chrome to show the prompt
});

// ---------- edit pipeline ----------

export async function refreshHistoryButtons(): Promise<void> {
  const [u, r] = await Promise.all([engine.canUndo(), engine.canRedo()]);
  toolbar.undo.disabled = doc.editingDisabled || !u;
  toolbar.redo.disabled = doc.editingDisabled || !r;
}

export async function applyEdit(
  fn: () => Promise<{ status: string; message?: string; bytes?: Uint8Array }>,
  pageIndex: number,
): Promise<void> {
  try {
    const result = await fn();
    if (result.status === 'error') {
      toast(result.message ?? 'Edit failed.', 'error', 6000);
      return;
    }
    if (result.bytes) {
      doc.currentBytes = result.bytes;
      markDirty();
      await rerender.reload();
      await rerender.page(pageIndex);
      await refreshHistoryButtons();
    }
    if (result.message) toast(result.message, result.status === 'ok' ? 'info' : 'warn', 6000);
    else toast('Edit applied.', 'info', 1800);
  } catch (e) {
    toast(`Edit failed: ${e instanceof Error ? e.message : e}`, 'error', 6000);
  }
}

export async function applyHistory(fn: () => Promise<Uint8Array | null>, doneMsg: string): Promise<void> {
  const bytes = await fn();
  if (bytes) {
    doc.currentBytes = bytes;
    markDirty();
    await rerender.reload();
    await rerender.all(false);
    await refreshHistoryButtons();
    toast(doneMsg);
  }
}
