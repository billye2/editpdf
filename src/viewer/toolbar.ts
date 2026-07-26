// Toolbar wiring: open/save, undo/redo, zoom and fit, the Show boxes switch,
// and the global keyboard shortcuts. Pure event plumbing — behavior lives in
// the modules this one calls into.

import { engine } from './engine';
import { toolbar, pagesEl, isTypingTarget } from './ui';
import { doc, pageUIs, applyHistory } from './state';
import { setZoom, basePageSize, buildOverlay } from './render';
import { openViaPicker, saveAs } from './open-save';
import { openRecentsDialog } from './dialogs';
import { getShowBoxes, setShowBoxes } from './prefs';

toolbar.open.addEventListener('click', () => void openViaPicker());
toolbar.recents.addEventListener('click', () => void openRecentsDialog());
toolbar.save.addEventListener('click', () => void saveAs());
toolbar.undo.addEventListener('click', () => void applyHistory(() => engine.undo(), 'Undone.'));
toolbar.redo.addEventListener('click', () => void applyHistory(() => engine.redo(), 'Redone.'));

toolbar.zoomIn.addEventListener('click', () => void setZoom(doc.zoom + 0.25));
toolbar.zoomOut.addEventListener('click', () => void setZoom(doc.zoom - 0.25));
toolbar.fitWidth.addEventListener('click', () => {
  const base = basePageSize();
  if (!base) return;
  const availW = pagesEl.clientWidth - 24 - 2; // #pages side padding + page border
  void setZoom(availW / base.w);
});
toolbar.fitPage.addEventListener('click', () => {
  void (async () => {
    const base = basePageSize();
    if (!base) return;
    const availW = pagesEl.clientWidth - 24 - 2;
    // The header is sticky, so its height — not #pages' scrolled-away top —
    // is what limits the visible area; the old top-based math broke mid-scroll.
    const chromeH = document.getElementById('chrome')!.getBoundingClientRect().height;
    const availH = window.innerHeight - chromeH - 24 - 18 - 2;
    // remember the page the user is on (the one under the viewport's center —
    // a sliver of the previous page may still be visible above it), then snap
    // it fully into view
    const mid = (chromeH + window.innerHeight) / 2;
    let topIdx = pageUIs.findIndex((p) => {
      const r = p.wrap.getBoundingClientRect();
      return r.top <= mid && r.bottom >= mid;
    });
    if (topIdx < 0) {
      topIdx = Math.max(
        0,
        pageUIs.findIndex((p) => p.wrap.getBoundingClientRect().bottom > chromeH),
      );
    }
    await setZoom(Math.min(availW / base.w, availH / base.h));
    const wrap = pageUIs[topIdx]?.wrap;
    if (wrap) {
      window.scrollTo({ top: window.scrollY + wrap.getBoundingClientRect().top - chromeH - 24 });
    }
  })();
});

// "Show boxes" switch — first-class control in the new design, persisted
toolbar.debug.checked = getShowBoxes();
toolbar.debug.addEventListener('change', () => {
  setShowBoxes(toolbar.debug.checked);
  pageUIs.forEach((_, i) => buildOverlay(i));
});

toolbar.zoomLabel.textContent = `${Math.round(doc.zoom * 100)}%`;

// ---------- keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || isTypingTarget(document.activeElement)) return;
  const k = e.key.toLowerCase();
  if (k === 'o') {
    e.preventDefault();
    void openViaPicker();
  } else if (k === 's') {
    e.preventDefault();
    if (!toolbar.save.disabled) void saveAs();
  } else if (k === 'z') {
    e.preventDefault();
    const btn = e.shiftKey ? toolbar.redo : toolbar.undo;
    if (!btn.disabled) btn.click();
  } else if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    if (!toolbar.zoomIn.disabled) void setZoom(doc.zoom + 0.25);
  } else if (e.key === '-') {
    e.preventDefault();
    if (!toolbar.zoomOut.disabled) void setZoom(doc.zoom - 0.25);
  } else if (e.key === '0') {
    e.preventDefault();
    if (!toolbar.fitPage.disabled) toolbar.fitPage.click();
  }
});
