import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import * as Comlink from 'comlink';
import type { EngineAPI, PageView, ParagraphView, OcrWordView, ImageView, RGB, Rect, ColorRange } from '../shared/types';
import {
  saveSession,
  loadSession,
  clearSession,
  recordRecent,
  listRecents,
  getRecentBytes,
  setRecentPinned,
  removeRecent,
  clearRecents,
  type SessionSnapshot,
} from './persist';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const engineWorker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
const engine = Comlink.wrap<EngineAPI>(engineWorker);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toolbar = {
  open: $<HTMLButtonElement>('btn-open'),
  recents: $<HTMLButtonElement>('btn-recents'),
  save: $<HTMLButtonElement>('btn-save'),
  undo: $<HTMLButtonElement>('btn-undo'),
  redo: $<HTMLButtonElement>('btn-redo'),
  zoomIn: $<HTMLButtonElement>('btn-zoom-in'),
  zoomOut: $<HTMLButtonElement>('btn-zoom-out'),
  fitWidth: $<HTMLButtonElement>('btn-fit-width'),
  fitPage: $<HTMLButtonElement>('btn-fit-page'),
  zoomLabel: $<HTMLSpanElement>('zoom-label'),
  debug: $<HTMLInputElement>('chk-debug'),
  fileName: $<HTMLSpanElement>('file-name'),
};
const pagesEl = $<HTMLDivElement>('pages');
const dropzone = $<HTMLDivElement>('dropzone');
const statusPill = $<HTMLDivElement>('status-pill');
const dropError = $<HTMLParagraphElement>('drop-error');
const bannerEl = $<HTMLDivElement>('banner');
const toastEl = $<HTMLDivElement>('toast');

let currentBytes: Uint8Array | null = null;
let pdf: PDFDocumentProxy | null = null;
let fileName = 'document.pdf';
let zoom = 1.25;
let editingDisabled = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// ---------- unsaved-edit tracking + autosave ----------

let dirty = false; // an edit was applied and not yet saved anywhere
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

/** Called after every committed edit/undo/redo: arms the unload guard and
 *  debounces a crash-recovery snapshot into IndexedDB (best-effort). */
function markDirty(): void {
  dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (!dirty || !currentBytes) return;
    void saveSession({ bytes: currentBytes.slice(), fileName, savedAt: Date.now() }).catch(() => {});
  }, 800);
}

function markClean(): void {
  dirty = false;
  clearTimeout(autosaveTimer);
  void clearSession().catch(() => {});
}

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = ''; // required by Chrome to show the prompt
});

interface PageUI {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  viewport: PageViewport;
  view: PageView | null;
  rendered: boolean;
}
const pageUIs: PageUI[] = [];
const baseDims: { w: number; h: number }[] = []; // per-page size at zoom 1
let pageObserver: IntersectionObserver | null = null;

function toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 4000): void {
  toastEl.textContent = msg;
  toastEl.className = kind === 'info' ? '' : kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

function banner(msg: string | null): void {
  if (msg) {
    bannerEl.textContent = msg;
    bannerEl.hidden = false;
  } else {
    bannerEl.hidden = true;
  }
}

function rectToCss(bbox: Rect, viewport: PageViewport): { left: number; top: number; width: number; height: number } {
  const [x1, y1] = viewport.convertToViewportPoint(bbox.x, bbox.y + bbox.h);
  const [x2, y2] = viewport.convertToViewportPoint(bbox.x + bbox.w, bbox.y);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** Replaces the current document. Returns false if the user kept their
 *  unsaved edits instead — the beforeunload guard only covers closing the
 *  tab, so in-app opens need their own warning. */
async function openBytes(bytes: Uint8Array, name: string): Promise<boolean> {
  if (dirty && currentBytes) {
    const proceed = window.confirm(
      `You have unsaved edits to "${fileName}".\n\nOpen "${name}" anyway? Your unsaved edits will be lost.`,
    );
    if (!proceed) return false;
  }
  currentBytes = bytes;
  fileName = name;
  dirty = false;
  clearTimeout(autosaveTimer);
  removeRestoreBar(); // opening a file supersedes any pending restore offer
  toolbar.fileName.textContent = name;
  statusPill.classList.add('loaded');
  dropzone.remove();
  banner(null);
  editingDisabled = false;
  fontFaceGen++;
  fontFaceCache.clear();

  const outcome = await engine.load(bytes.slice());
  if (!outcome.ok) {
    editingDisabled = true;
    banner(
      outcome.encrypted
        ? 'This PDF is encrypted — viewing only, editing is not supported.'
        : `This PDF could not be opened for editing (${outcome.error ?? 'unknown error'}) — viewing only.`,
    );
  }

  await reloadPdfJs();
  toolbar.fileName.textContent = `${name} · ${pdf!.numPages} page${pdf!.numPages === 1 ? '' : 's'}`;
  await renderAllPages(true);
  if (pageUIs.length) await renderPage(0); // first page eagerly: banner logic below needs its view

  toolbar.zoomIn.disabled = false;
  toolbar.zoomOut.disabled = false;
  toolbar.fitWidth.disabled = false;
  toolbar.fitPage.disabled = false;
  toolbar.save.disabled = false;
  await refreshHistoryButtons();

  if (!editingDisabled && pdf) {
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

async function reloadPdfJs(): Promise<void> {
  const old = pdf;
  pdf = await pdfjsLib.getDocument({ data: currentBytes!.slice() }).promise;
  if (old) void old.destroy();
}

/** Pages render lazily: every page gets a correctly-sized placeholder (so
 *  scroll geometry is right), and an IntersectionObserver renders pages as
 *  they come within 300px of the viewport. A 200-page PDF paints its first
 *  screen without rendering the other 199. */
async function renderAllPages(rebuild: boolean): Promise<void> {
  if (!pdf) return;
  if (rebuild) {
    pageUIs.forEach((p) => p.wrap.remove());
    pageUIs.length = 0;
    baseDims.length = 0;
    for (let i = 0; i < pdf.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'page';
      const canvas = document.createElement('canvas');
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      wrap.append(canvas, overlay);
      pagesEl.append(wrap);
      pageUIs.push({ wrap, canvas, overlay, viewport: null as unknown as PageViewport, view: null, rendered: false });
      // getPage parses only the page dict — cheap compared to rendering
      const page = await pdf.getPage(i + 1);
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
    ui.wrap.style.width = `${baseDims[i].w * zoom}px`;
    ui.wrap.style.height = `${baseDims[i].h * zoom}px`;
    pageObserver.observe(ui.wrap);
  }
}

async function renderPage(index: number): Promise<void> {
  if (!pdf) return;
  const ui = pageUIs[index];
  ui.rendered = true;
  const page = await pdf.getPage(index + 1);
  const viewport = page.getViewport({ scale: zoom });
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

  if (!editingDisabled) {
    try {
      ui.view = await engine.getPage(index);
    } catch {
      ui.view = null;
    }
  }
  buildOverlay(index);
}

function buildOverlay(index: number): void {
  const ui = pageUIs[index];
  ui.overlay.innerHTML = '';
  if (selectedImg?.pageIndex === index) selectedImg = null; // boxes are being replaced
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
    box.title = 'Click to edit this paragraph';
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      beginParagraphEdit(index, para);
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

// ---------- image move/delete ----------

let selectedImg: { pageIndex: number; imageId: string; box: HTMLDivElement } | null = null;
let activeImgDrag: { cancel: () => void } | null = null;

function deselectImage(): void {
  if (!selectedImg) return;
  selectedImg.box.classList.remove('selected');
  selectedImg.box.querySelector('.img-delete-btn')?.remove();
  selectedImg = null;
}

function selectImage(pageIndex: number, img: ImageView, box: HTMLDivElement): void {
  deselectImage();
  box.classList.add('selected');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'img-delete-btn';
  btn.textContent = '✕';
  btn.title = 'Delete this image';
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    deselectImage();
    void applyEdit(() => engine.deleteImage(pageIndex, img.id), pageIndex);
  });
  box.append(btn);
  selectedImg = { pageIndex, imageId: img.id, box };
}

function wireImageBox(pageIndex: number, img: ImageView, box: HTMLDivElement, ui: PageUI): void {
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      // pointer may already be gone (fast click); listeners below still work
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;

    const reset = () => {
      box.classList.remove('dragging');
      box.style.transform = '';
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      activeImgDrag = null;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!dragging && Math.hypot(dx, dy) > 3) {
        dragging = true;
        box.classList.add('dragging');
        activeImgDrag = { cancel: reset };
      }
      if (dragging) box.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const onUp = (ev: PointerEvent) => {
      const wasDragging = dragging;
      reset();
      if (!wasDragging) {
        selectImage(pageIndex, img, box);
        return;
      }
      // convert both endpoints through the viewport so page /Rotate is handled
      const r = ui.canvas.getBoundingClientRect();
      const [px0, py0] = ui.viewport.convertToPdfPoint(x0 - r.left, y0 - r.top);
      const [px1, py1] = ui.viewport.convertToPdfPoint(ev.clientX - r.left, ev.clientY - r.top);
      const dx = px1 - px0;
      const dy = py1 - py0;
      if (Math.hypot(dx, dy) < 0.01) return;
      void applyEdit(() => engine.moveImage(pageIndex, img.id, dx, dy), pageIndex);
    };

    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
  });
}

const isTypingTarget = (el: Element | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeImgDrag) {
    e.preventDefault();
    activeImgDrag.cancel();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImg && !isTypingTarget(document.activeElement)) {
    e.preventDefault();
    const { pageIndex, imageId } = selectedImg;
    deselectImage();
    void applyEdit(() => engine.deleteImage(pageIndex, imageId), pageIndex);
  }
});

document.addEventListener('pointerdown', (e) => {
  if (selectedImg && !(e.target instanceof Element && e.target.closest('.img-box'))) deselectImage();
});

function cssPx(r: { left: number; top: number; width: number; height: number }): Partial<CSSStyleDeclaration> {
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}

function rgbToHex(c: RGB): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

const sameRgb = (a: RGB, b: RGB) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

/** Swatch row + custom picker. Returns the row element and a getter for the
 *  chosen color (null while unchanged from the default). */
function buildColorRow(defaultColor: RGB, onPick: (c: RGB) => void): { row: HTMLDivElement; chosen: () => RGB | null } {
  let chosen: RGB | null = null;
  const row = document.createElement('div');
  row.className = 'color-row';
  // don't let clicks in the row blur the edit box into a premature commit
  row.addEventListener('mousedown', (e) => e.preventDefault());

  const presets: RGB[] = [defaultColor, [0, 0, 0], [0.77, 0.06, 0.06], [0.05, 0.25, 0.7], [0.05, 0.45, 0.15], [0.45, 0.45, 0.45]];
  const seen = new Set<string>();
  const swatches: HTMLButtonElement[] = [];
  const select = (c: RGB, el: HTMLElement) => {
    chosen = sameRgb(c, defaultColor) ? null : c;
    swatches.forEach((s) => s.classList.remove('selected'));
    el.classList.add('selected');
    onPick(c);
  };
  for (const c of presets) {
    const key = rgbToHex(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-swatch';
    b.style.background = key;
    b.title = sameRgb(c, defaultColor) ? 'Original color' : key;
    if (sameRgb(c, defaultColor)) b.classList.add('selected');
    b.addEventListener('click', () => select(c, b));
    swatches.push(b);
    row.append(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'color-custom';
  custom.value = rgbToHex(defaultColor);
  custom.title = 'Custom color';
  custom.addEventListener('input', () => select(hexToRgb(custom.value), custom));
  swatches.push(custom as unknown as HTMLButtonElement);
  row.append(custom);

  return { row, chosen: () => chosen };
}

function fontFamilyFor(view: ParagraphView): string {
  const base = view.fontKind === 'mono' ? 'ui-monospace, monospace' : view.fontKind === 'serif' ? 'Georgia, serif' : 'Helvetica, Arial, sans-serif';
  return base;
}

// Embedded-font overlay styling: pull the document's actual TrueType program
// out of the PDF and register it as a web font, so the edit box shows the
// REAL font instead of a generic look-alike. Cached per document generation.
let fontFaceGen = 0;
const fontFaceCache = new Map<string, Promise<string | null>>();

function embeddedFamilyFor(pageIndex: number, para: ParagraphView): Promise<string | null> {
  const key = `${fontFaceGen}:${pageIndex}:${para.fontRes}`;
  let p = fontFaceCache.get(key);
  if (!p) {
    p = (async () => {
      const bytes = await engine.getFontBytes(pageIndex, para.fontRes, para.text.slice(0, 80));
      if (!bytes) return null;
      const family = 'EPDF-' + key.replace(/[^a-zA-Z0-9]/g, '-');
      const face = new FontFace(family, bytes.slice().buffer as ArrayBuffer);
      await face.load();
      document.fonts.add(face);
      return family;
    })().catch(() => null);
    fontFaceCache.set(key, p);
  }
  return p;
}

function cssColorToRgb(s: string): RGB | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  if (s.startsWith('#')) return hexToRgb(s);
  return null;
}

/** Flatten a rich edit surface into plain text + character color ranges
 *  (colors that differ from `base`). Block boundaries become spaces. */
function serializeRich(root: HTMLElement, base: RGB): { text: string; ranges: ColorRange[] } {
  let text = '';
  const ranges: ColorRange[] = [];
  const walk = (node: Node, color: RGB): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (!t) return;
      if (!sameRgb(color, base)) {
        const last = ranges[ranges.length - 1];
        if (last && last.end === text.length && sameRgb(last.color, color)) last.end = text.length + t.length;
        else ranges.push({ start: text.length, end: text.length + t.length, color });
      }
      text += t;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      if (text && !text.endsWith(' ')) text += ' ';
      return;
    }
    let c = color;
    if (node.style.color) c = cssColorToRgb(node.style.color) ?? c;
    else if (node.tagName === 'FONT' && node.getAttribute('color')) c = hexToRgb(node.getAttribute('color')!);
    const isBlock = node.tagName === 'DIV' || node.tagName === 'P';
    if (isBlock && text && !text.endsWith(' ')) text += ' ';
    for (const child of node.childNodes) walk(child, c);
    if (isBlock && text && !text.endsWith(' ')) text += ' ';
  };
  for (const child of root.childNodes) walk(child, base);
  return { text, ranges };
}

function beginParagraphEdit(pageIndex: number, para: ParagraphView): void {
  const ui = pageUIs[pageIndex];
  const rect = rectToCss(para.bbox, ui.viewport);
  const scale = ui.viewport.scale;

  const ed = document.createElement('div');
  ed.className = 'edit-box edit-rich';
  ed.contentEditable = 'true';
  Object.assign(ed.style, cssPx(rect));
  ed.style.height = 'auto';
  ed.style.minHeight = `${Math.max(rect.height + 8, 40)}px`;
  ed.style.minWidth = '120px';
  ed.style.font = `${para.italic ? 'italic ' : ''}${para.bold ? '700 ' : '400 '}${para.fontSize * scale}px/${(para.leading / para.fontSize) * 1.0 * para.fontSize * scale}px ${fontFamilyFor(para)}`;
  ed.textContent = para.text;

  const hint = document.createElement('div');
  hint.className = 'edit-hint';
  hint.textContent = '⌘/Ctrl+Enter to apply · Esc to cancel · select text, then pick a color';
  hint.style.left = `${rect.left}px`;

  // Base color = whole-paragraph choice; selecting text first scopes the pick
  // to just that selection (colored spans, word granularity on commit).
  let baseColor: RGB = para.color;
  let baseChosen: RGB | null = null;
  ed.style.color = rgbToHex(para.color);
  const colorRow = buildColorRow(para.color, (c) => {
    const sel = window.getSelection();
    const hasSel =
      sel && !sel.isCollapsed && sel.rangeCount > 0 && ed.contains(sel.anchorNode) && ed.contains(sel.focusNode);
    if (hasSel) {
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('foreColor', false, rgbToHex(c));
    } else {
      baseChosen = sameRgb(c, para.color) ? null : c;
      baseColor = c;
      ed.style.color = rgbToHex(c);
    }
  });
  colorRow.row.style.left = `${rect.left + rect.width - 4}px`;
  colorRow.row.style.top = `${rect.top}px`;

  // The browser font renders the text taller/shorter than the PDF layout did,
  // and typing adds lines — grow the box to fit its content so nothing is
  // ever clipped. It floats above the page, so growing is safe.
  const autosize = () => {
    if (!ed.isConnected) return;
    const h = Math.max(rect.height + 8, ed.scrollHeight + 6);
    hint.style.top = `${rect.top + h + 8}px`;
  };
  ed.addEventListener('input', autosize);

  // swap in the document's real embedded font once it's registered (fast, local)
  void embeddedFamilyFor(pageIndex, para).then((family) => {
    if (family && ed.isConnected) {
      ed.style.fontFamily = `"${family}", ${fontFamilyFor(para)}`;
      // the embedded program already carries its weight/slant — don't let the
      // browser synthesize double-bold/double-italic on top
      ed.style.fontWeight = 'normal';
      ed.style.fontStyle = 'normal';
      autosize(); // metrics changed with the font
    }
  });

  // ✕ at the box's top-left corner deletes the whole paragraph (mirrors the
  // image delete affordance)
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'edit-delete-btn';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete this paragraph';
  delBtn.style.left = `${rect.left - 10}px`;
  delBtn.style.top = `${rect.top - 10}px`;
  // keep the click from blurring the edit box into a premature commit
  delBtn.addEventListener('mousedown', (e) => e.preventDefault());
  delBtn.addEventListener('click', () => {
    cleanup();
    void applyEdit(() => engine.deleteParagraph(pageIndex, para.id), pageIndex);
  });

  let done = false;
  const cleanup = () => {
    done = true;
    ed.remove();
    hint.remove();
    colorRow.row.remove();
    delBtn.remove();
  };
  const commit = async () => {
    if (done) return;
    const { text: newText, ranges } = serializeRich(ed, baseColor);
    const color = baseChosen ?? undefined;
    cleanup();
    if (newText.trim() === para.text.trim() && !color && !ranges.length) return;
    await applyEdit(
      () => engine.editParagraph(pageIndex, para.id, newText, color, ranges.length ? ranges : undefined),
      pageIndex,
    );
  };
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  });
  ed.addEventListener('blur', () => void commit());

  ui.wrap.append(ed, hint, colorRow.row, delBtn);
  autosize();
  ed.focus();
  const sel = window.getSelection();
  if (sel && ed.firstChild) sel.collapse(ed.firstChild, 0);
}

function samplePatchColor(pageIndex: number, bbox: Rect): RGB {
  const ui = pageUIs[pageIndex];
  const rect = rectToCss(bbox, ui.viewport);
  const dpr = window.devicePixelRatio || 1;
  const ctx = ui.canvas.getContext('2d')!;
  const pad = 3;
  const x0 = Math.max(0, Math.floor((rect.left - pad) * dpr));
  const y0 = Math.max(0, Math.floor((rect.top - pad) * dpr));
  const x1 = Math.min(ui.canvas.width - 1, Math.ceil((rect.left + rect.width + pad) * dpr));
  const y1 = Math.min(ui.canvas.height - 1, Math.ceil((rect.top + rect.height + pad) * dpr));
  try {
    const img = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const w = img.width;
    const h = img.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // ring only: skip interior pixels (they contain the ink we're replacing)
        const border = x < pad * dpr || y < pad * dpr || x >= w - pad * dpr || y >= h - pad * dpr;
        if (!border) continue;
        const o = (y * w + x) * 4;
        rs.push(img.data[o]);
        gs.push(img.data[o + 1]);
        bs.push(img.data[o + 2]);
      }
    }
    const median = (arr: number[]) => {
      arr.sort((a, b) => a - b);
      return arr.length ? arr[Math.floor(arr.length / 2)] / 255 : 1;
    };
    return [median(rs), median(gs), median(bs)];
  } catch {
    return [1, 1, 1];
  }
}

function beginOcrEdit(pageIndex: number, word: OcrWordView): void {
  const ui = pageUIs[pageIndex];
  const rect = rectToCss(word.bbox, ui.viewport);

  const input = document.createElement('input');
  input.className = 'edit-box';
  Object.assign(input.style, cssPx({ ...rect, width: Math.max(rect.width + 30, 90), height: rect.height + 6 }));
  input.style.font = `${Math.max(11, rect.height * 0.75)}px Helvetica, Arial, sans-serif`;
  input.value = word.text;
  // grow with the typed text so it never clips
  const measureCtx = document.createElement('canvas').getContext('2d')!;
  const autosizeInput = () => {
    if (!input.isConnected) return;
    measureCtx.font = getComputedStyle(input).font;
    const w = measureCtx.measureText(input.value).width + 28;
    input.style.width = `${Math.max(rect.width + 30, 90, w)}px`;
  };
  input.addEventListener('input', autosizeInput);

  const hint = document.createElement('div');
  hint.className = 'edit-hint';
  hint.textContent = 'Enter to apply · Esc to cancel — replaces the scanned word with a patch';
  hint.style.left = `${rect.left}px`;
  hint.style.top = `${rect.top + rect.height + 10}px`;

  const patchColor = samplePatchColor(pageIndex, word.bbox);

  const defaultInk: RGB = [0.05, 0.05, 0.05];
  input.style.color = rgbToHex(defaultInk);
  const colorRow = buildColorRow(defaultInk, (c) => {
    input.style.color = rgbToHex(c);
  });
  colorRow.row.style.left = `${rect.left + Math.max(rect.width + 30, 90) + 6}px`;
  colorRow.row.style.top = `${rect.top}px`;

  let done = false;
  const cleanup = () => {
    done = true;
    input.remove();
    hint.remove();
    colorRow.row.remove();
  };
  const commit = async () => {
    if (done) return;
    const newText = input.value;
    const textColor = colorRow.chosen() ?? undefined;
    cleanup();
    if (newText.trim() === word.text.trim() || !newText.trim()) return;
    await applyEdit(() => engine.editOcrWord(pageIndex, word.runId, newText, patchColor, textColor), pageIndex);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
  });
  input.addEventListener('blur', () => void commit());

  ui.wrap.append(input, hint, colorRow.row);
  autosizeInput();
  input.focus();
  input.select();
}

async function applyEdit(fn: () => Promise<{ status: string; message?: string; bytes?: Uint8Array }>, pageIndex: number): Promise<void> {
  try {
    const result = await fn();
    if (result.status === 'error') {
      toast(result.message ?? 'Edit failed.', 'error', 6000);
      return;
    }
    if (result.bytes) {
      currentBytes = result.bytes;
      markDirty();
      await reloadPdfJs();
      await renderPage(pageIndex);
      await refreshHistoryButtons();
    }
    if (result.message) toast(result.message, result.status === 'ok' ? 'info' : 'warn', 6000);
    else toast('Edit applied.', 'info', 1800);
  } catch (e) {
    toast(`Edit failed: ${e instanceof Error ? e.message : e}`, 'error', 6000);
  }
}

async function refreshHistoryButtons(): Promise<void> {
  const [u, r] = await Promise.all([engine.canUndo(), engine.canRedo()]);
  toolbar.undo.disabled = editingDisabled || !u;
  toolbar.redo.disabled = editingDisabled || !r;
}

// ---------- file handling ----------

async function openViaPicker(): Promise<void> {
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
async function saveAs(): Promise<void> {
  if (!currentBytes) return;
  const suggestedName = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
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
    await writable.write(currentBytes.slice() as unknown as ArrayBuffer & Uint8Array);
    await writable.close();
    markClean();
    toast(`Saved ${handle.name}.`);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    toast(`Save failed: ${e instanceof Error ? e.message : e} — downloading a copy instead.`, 'warn', 6000);
    download();
  }
}

function download(): void {
  if (!currentBytes) return;
  markClean(); // the downloaded copy carries the edits
  const copy = currentBytes.slice();
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- wire up ----------

toolbar.open.addEventListener('click', () => void openViaPicker());
toolbar.recents.addEventListener('click', () => void openRecentsDialog());
toolbar.save.addEventListener('click', () => void saveAs());
async function applyHistory(fn: () => Promise<Uint8Array | null>, doneMsg: string): Promise<void> {
  const bytes = await fn();
  if (bytes) {
    currentBytes = bytes;
    markDirty();
    await reloadPdfJs();
    await renderAllPages(false);
    await refreshHistoryButtons();
    toast(doneMsg);
  }
}
toolbar.undo.addEventListener('click', () => void applyHistory(() => engine.undo(), 'Undone.'));
toolbar.redo.addEventListener('click', () => void applyHistory(() => engine.redo(), 'Redone.'));

async function setZoom(z: number): Promise<void> {
  zoom = Math.min(4, Math.max(0.25, z));
  toolbar.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  await renderAllPages(false);
}
/** First page's size in CSS px at zoom 1. */
function basePageSize(): { w: number; h: number } | null {
  const vp = pageUIs[0]?.viewport;
  if (!vp) return null;
  return { w: vp.width / zoom, h: vp.height / zoom };
}
toolbar.zoomIn.addEventListener('click', () => void setZoom(zoom + 0.25));
toolbar.zoomOut.addEventListener('click', () => void setZoom(zoom - 0.25));
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
const SHOW_BOXES_KEY = 'editpdf-show-boxes';
try {
  toolbar.debug.checked = localStorage.getItem(SHOW_BOXES_KEY) === '1';
} catch {
  // ignore
}
toolbar.debug.addEventListener('change', () => {
  try {
    localStorage.setItem(SHOW_BOXES_KEY, toolbar.debug.checked ? '1' : '0');
  } catch {
    // ignore
  }
  pageUIs.forEach((_, i) => buildOverlay(i));
});

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

toolbar.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

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
    if (!toolbar.zoomIn.disabled) void setZoom(zoom + 0.25);
  } else if (e.key === '-') {
    e.preventDefault();
    if (!toolbar.zoomOut.disabled) void setZoom(zoom - 0.25);
  } else if (e.key === '0') {
    e.preventDefault();
    if (!toolbar.fitPage.disabled) toolbar.fitPage.click();
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

// ---------- recent files ----------

const REMEMBER_RECENTS_KEY = 'editpdf-remember-recents';

function recentsEnabled(): boolean {
  try {
    return localStorage.getItem(REMEMBER_RECENTS_KEY) !== '0';
  } catch {
    return false;
  }
}

function setRecentsEnabled(on: boolean): void {
  try {
    localStorage.setItem(REMEMBER_RECENTS_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

/** 96px-wide JPEG thumbnail from the already-rendered first-page canvas. */
function captureThumb(): string | undefined {
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

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let recentsDialog: HTMLDivElement | null = null;

function closeRecentsDialog(): void {
  recentsDialog?.remove();
  recentsDialog = null;
}

async function openRecentsDialog(): Promise<void> {
  closeRecentsDialog();
  const backdrop = document.createElement('div');
  backdrop.className = 'recents-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeRecentsDialog();
  });

  const panel = document.createElement('div');
  panel.className = 'recents-panel';
  const title = document.createElement('h2');
  title.textContent = 'Recent files';
  panel.append(title);

  const list = document.createElement('div');
  list.className = 'recents-list';
  const entries = await listRecents().catch(() => []);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'recents-empty';
    empty.textContent = recentsEnabled() ? 'No recent files yet.' : 'Remembering recent files is turned off.';
    list.append(empty);
  }
  for (const m of entries) {
    const row = document.createElement('div');
    row.className = 'recents-row';
    const thumb = document.createElement('img');
    thumb.className = 'recents-thumb';
    if (m.thumb) thumb.src = m.thumb;
    thumb.alt = '';
    const info = document.createElement('div');
    info.className = 'recents-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'recents-name';
    nameEl.textContent = m.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'recents-meta';
    metaEl.textContent = `${m.pageCount} page${m.pageCount === 1 ? '' : 's'} · ${fmtSize(m.size)} · ${new Date(m.openedAt).toLocaleDateString()}`;
    info.append(nameEl, metaEl);
    const pinBtn = document.createElement('button');
    pinBtn.className = 'recents-pin' + (m.pinned ? ' pinned' : '');
    pinBtn.textContent = '★';
    pinBtn.title = m.pinned ? 'Unpin (pinned files are never auto-removed)' : 'Pin (never auto-remove)';
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await setRecentPinned(m.hash, !m.pinned).catch(() => {});
      void openRecentsDialog(); // rebuild with fresh state
    });
    const rmBtn = document.createElement('button');
    rmBtn.className = 'recents-remove';
    rmBtn.textContent = '✕';
    rmBtn.title = 'Remove from recents';
    rmBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeRecent(m.hash).catch(() => {});
      void openRecentsDialog();
    });
    row.append(thumb, info, pinBtn, rmBtn);
    row.addEventListener('click', async () => {
      const bytes = await getRecentBytes(m.hash).catch(() => null);
      closeRecentsDialog();
      if (bytes) await openBytes(bytes, m.name);
      else toast('This file is no longer cached — open it from disk instead.', 'warn', 5000);
    });
    list.append(row);
  }
  panel.append(list);

  const footer = document.createElement('div');
  footer.className = 'recents-footer';
  const rememberLabel = document.createElement('label');
  const rememberChk = document.createElement('input');
  rememberChk.type = 'checkbox';
  rememberChk.checked = recentsEnabled();
  rememberChk.addEventListener('change', () => setRecentsEnabled(rememberChk.checked));
  rememberLabel.append(rememberChk, document.createTextNode(' Remember recent files'));
  const clearBtn = document.createElement('button');
  clearBtn.className = 'recents-clear';
  clearBtn.textContent = 'Clear all';
  clearBtn.addEventListener('click', async () => {
    await clearRecents().catch(() => {});
    void openRecentsDialog();
  });
  footer.append(rememberLabel, clearBtn);
  panel.append(footer);

  backdrop.append(panel);
  document.body.append(backdrop);
  recentsDialog = backdrop;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recentsDialog) closeRecentsDialog();
});

// ---------- help tips ----------
// The ? button cycles through short tips in the toast (same pattern as the
// sibling product PDF Mana).

const HELP_TIPS = [
  'Tip: click any paragraph and just type — the words reflow to fit, nothing else shifts.',
  'Tip: ⌘/Ctrl+Enter applies an edit, Esc cancels it.',
  'Tip: select some text in the edit box first to color just those words.',
  'Tip: on scanned PDFs, click a highlighted word to patch-fix it in place.',
  'Tip: drag an image to move it; click it, then press Delete to remove it.',
  'Tip: the ✕ at an edit box corner deletes the whole paragraph.',
  'Tip: Save PDF never overwrites your original — it always writes a new file.',
  'Tip: drop a PDF anywhere on the page to open it.',
  'Tip: ⌘/Ctrl+Z undoes any edit; your history survives until you close the tab.',
  'Tip: the Show boxes switch outlines everything the editor detected on the page.',
];
let tipIndex = 0;
$<HTMLButtonElement>('btn-help').addEventListener('click', () => {
  toast(HELP_TIPS[tipIndex], 'info', 6000);
  tipIndex = (tipIndex + 1) % HELP_TIPS.length;
});

// ---------- session restore offer ----------

let restoreBar: HTMLDivElement | null = null;

function removeRestoreBar(): void {
  restoreBar?.remove();
  restoreBar = null;
}

function offerRestore(s: SessionSnapshot): void {
  const bar = document.createElement('div');
  bar.className = 'restore-bar';
  const msg = document.createElement('span');
  const when = new Date(s.savedAt).toLocaleString();
  msg.textContent = `You have unsaved edits to "${s.fileName}" from ${when}.`;
  const restoreBtn = document.createElement('button');
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', async () => {
    removeRestoreBar();
    await openBytes(s.bytes, s.fileName);
    dirty = true; // the restored edits are still unsaved
    toast('Session restored — remember to Save As.', 'info', 5000);
  });
  const discardBtn = document.createElement('button');
  discardBtn.className = 'secondary';
  discardBtn.textContent = 'Discard';
  discardBtn.addEventListener('click', async () => {
    // await the clear BEFORE dismissing, so a fast reload can't resurrect the offer
    await clearSession().catch(() => {});
    removeRestoreBar();
  });
  bar.append(msg, restoreBtn, discardBtn);
  document.body.insertBefore(bar, pagesEl);
  restoreBar = bar;
}

// ?file=<url> — used by the navigation-intercept redirect
const fileParam = new URLSearchParams(location.search).get('file');
if (!fileParam) {
  // offer to restore unsaved edits from a previous session (crash/closed tab)
  void loadSession()
    .then((s) => {
      if (s && !currentBytes) offerRestore(s);
    })
    .catch(() => {});
}
if (fileParam) {
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
