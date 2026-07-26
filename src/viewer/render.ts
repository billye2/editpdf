// pdf.js rendering pipeline: page canvases, lazy rendering, the interaction
// overlay, and zoom. Fills in state.rerender so the edit pipeline can trigger
// re-renders without importing this module.

import * as pdfjsLib from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { engine } from './engine';
import { toolbar, pagesEl } from './ui';
import { rectToCss, cssPx } from './util';
import { doc, pageUIs, baseDims, rerender, applyEdit } from './state';
import { beginParagraphEdit, beginOcrEdit } from './editors';
import { wireImageBox, dropImageSelectionForPage } from './images';
import { wireDragToMove } from './drag';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let pageObserver: IntersectionObserver | null = null;

export async function reloadPdfJs(): Promise<void> {
  const old = doc.pdf;
  doc.pdf = await pdfjsLib.getDocument({ data: doc.currentBytes!.slice() }).promise;
  if (old) void old.destroy();
}

/** Pages render lazily: every page gets a correctly-sized placeholder (so
 *  scroll geometry is right), and an IntersectionObserver renders pages as
 *  they come within 300px of the viewport. A 200-page PDF paints its first
 *  screen without rendering the other 199. */
export async function renderAllPages(rebuild: boolean): Promise<void> {
  if (!doc.pdf) return;
  if (rebuild) {
    pageUIs.forEach((p) => p.wrap.remove());
    pageUIs.length = 0;
    baseDims.length = 0;
    for (let i = 0; i < doc.pdf.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'page';
      const canvas = document.createElement('canvas');
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      wrap.append(canvas, overlay);
      pagesEl.append(wrap);
      pageUIs.push({ wrap, canvas, overlay, viewport: null as unknown as PageViewport, view: null, rendered: false });
      // getPage parses only the page dict — cheap compared to rendering
      const page = await doc.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      baseDims.push({ w: vp.width, h: vp.height });
    }
  }
  pageObserver?.disconnect();
  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = pageUIs.findIndex((p) => p.wrap === entry.target);
        if (idx >= 0 && !pageUIs[idx].rendered) void renderPage(idx);
      }
    },
    { rootMargin: '300px' },
  );
  for (let i = 0; i < pageUIs.length; i++) {
    const ui = pageUIs[i];
    ui.rendered = false;
    ui.wrap.style.width = `${baseDims[i].w * doc.zoom}px`;
    ui.wrap.style.height = `${baseDims[i].h * doc.zoom}px`;
    pageObserver.observe(ui.wrap);
  }
}

export async function renderPage(index: number): Promise<void> {
  if (!doc.pdf) return;
  const ui = pageUIs[index];
  ui.rendered = true;
  const page = await doc.pdf.getPage(index + 1);
  const viewport = page.getViewport({ scale: doc.zoom });
  ui.viewport = viewport;
  const dpr = window.devicePixelRatio || 1;
  ui.canvas.width = Math.floor(viewport.width * dpr);
  ui.canvas.height = Math.floor(viewport.height * dpr);
  ui.canvas.style.width = `${viewport.width}px`;
  ui.canvas.style.height = `${viewport.height}px`;
  ui.wrap.style.width = `${viewport.width}px`;
  ui.wrap.style.height = `${viewport.height}px`;
  const ctx = ui.canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;

  if (!doc.editingDisabled) {
    try {
      ui.view = await engine.getPage(index);
    } catch {
      ui.view = null;
    }
  }
  buildOverlay(index);
}

export function buildOverlay(index: number): void {
  const ui = pageUIs[index];
  ui.overlay.innerHTML = '';
  dropImageSelectionForPage(index); // boxes are being replaced
  const view = ui.view;
  if (!view) return;

  // image boxes first, so overlapping text boxes (later siblings) win pointer hits
  for (const img of view.images) {
    const box = document.createElement('div');
    box.className = 'img-box';
    Object.assign(box.style, cssPx(rectToCss(img.bbox, ui.viewport)));
    box.title = 'Drag to move · click to select, then press Delete to remove';
    wireImageBox(index, img, box, ui);
    ui.overlay.append(box);
  }

  for (const para of view.paragraphs) {
    const box = document.createElement('div');
    box.className = 'para-box';
    Object.assign(box.style, cssPx(rectToCss(para.bbox, ui.viewport)));
    box.title = 'Click to edit · drag to move';
    wireDragToMove(box, ui, {
      onClick: () => beginParagraphEdit(index, para),
      onDrop: (dx, dy) => void applyEdit(() => engine.moveParagraph(index, para.id, dx, dy), index),
    });
    ui.overlay.append(box);
  }

  for (const word of view.ocrWords) {
    const box = document.createElement('div');
    box.className = 'ocr-box';
    Object.assign(box.style, cssPx(rectToCss(word.bbox, ui.viewport)));
    box.title = `OCR text: "${word.text}" — click to patch-edit`;
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      beginOcrEdit(index, word);
    });
    ui.overlay.append(box);
  }

  if (toolbar.debug.checked) {
    for (const run of view.runs) {
      const d = document.createElement('div');
      d.className = 'debug-run' + (run.renderMode === 3 ? ' invisible-run' : '');
      Object.assign(d.style, cssPx(rectToCss(run.bbox, ui.viewport)));
      ui.overlay.append(d);
    }
  }
}

export async function setZoom(z: number): Promise<void> {
  doc.zoom = Math.min(4, Math.max(0.25, z));
  toolbar.zoomLabel.textContent = `${Math.round(doc.zoom * 100)}%`;
  await renderAllPages(false);
}

/** First page's size in CSS px at zoom 1. */
export function basePageSize(): { w: number; h: number } | null {
  const vp = pageUIs[0]?.viewport;
  if (!vp) return null;
  return { w: vp.width / doc.zoom, h: vp.height / doc.zoom };
}

/** 96px-wide JPEG thumbnail from the already-rendered first-page canvas. */
export function captureThumb(): string | undefined {
  const src = pageUIs[0]?.canvas;
  if (!src || !src.width) return undefined;
  try {
    const w = 96;
    const h = Math.max(1, Math.round((src.height / src.width) * w));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined;
  }
}

// wire the edit pipeline's re-render hooks (state.ts cannot import upward)
rerender.reload = reloadPdfJs;
rerender.page = renderPage;
rerender.all = renderAllPages;
