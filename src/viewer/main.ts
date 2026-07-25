import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import * as Comlink from 'comlink';
import type { EngineAPI, PageView, ParagraphView, OcrWordView, RGB, Rect, ColorRange } from '../shared/types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const engineWorker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
const engine = Comlink.wrap<EngineAPI>(engineWorker);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toolbar = {
  open: $<HTMLButtonElement>('btn-open'),
  save: $<HTMLButtonElement>('btn-save'),
  download: $<HTMLButtonElement>('btn-download'),
  undo: $<HTMLButtonElement>('btn-undo'),
  zoomIn: $<HTMLButtonElement>('btn-zoom-in'),
  zoomOut: $<HTMLButtonElement>('btn-zoom-out'),
  zoomLabel: $<HTMLSpanElement>('zoom-label'),
  debug: $<HTMLInputElement>('chk-debug'),
  fileName: $<HTMLSpanElement>('file-name'),
};
const pagesEl = $<HTMLDivElement>('pages');
const dropzone = $<HTMLDivElement>('dropzone');
const bannerEl = $<HTMLDivElement>('banner');
const toastEl = $<HTMLDivElement>('toast');

let currentBytes: Uint8Array | null = null;
let pdf: PDFDocumentProxy | null = null;
let fileHandle: FileSystemFileHandle | null = null;
let fileName = 'document.pdf';
let zoom = 1.25;
let editingDisabled = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

interface PageUI {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  viewport: PageViewport;
  view: PageView | null;
}
const pageUIs: PageUI[] = [];

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

async function openBytes(bytes: Uint8Array, name: string, handle: FileSystemFileHandle | null): Promise<void> {
  currentBytes = bytes;
  fileHandle = handle;
  fileName = name;
  toolbar.fileName.textContent = name;
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
  await renderAllPages(true);

  toolbar.download.disabled = false;
  toolbar.zoomIn.disabled = false;
  toolbar.zoomOut.disabled = false;
  toolbar.save.disabled = !fileHandle || editingDisabled;
  await refreshUndoButton();

  if (!editingDisabled && pdf) {
    const first = pageUIs[0]?.view;
    if (first && !first.hasVisibleText && !first.hasOcrLayer) {
      banner('This page has no editable text layer — it is likely a scan without OCR. Run OCR on it first, then edit here.');
    } else if (first && !first.hasVisibleText && first.hasOcrLayer) {
      toast('Scanned PDF with OCR layer detected — click a highlighted word to patch-edit it.', 'info', 6000);
    }
  }
}

async function reloadPdfJs(): Promise<void> {
  const old = pdf;
  pdf = await pdfjsLib.getDocument({ data: currentBytes!.slice() }).promise;
  if (old) void old.destroy();
}

async function renderAllPages(rebuild: boolean): Promise<void> {
  if (!pdf) return;
  if (rebuild) {
    pageUIs.forEach((p) => p.wrap.remove());
    pageUIs.length = 0;
    for (let i = 0; i < pdf.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'page';
      const canvas = document.createElement('canvas');
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      wrap.append(canvas, overlay);
      pagesEl.append(wrap);
      pageUIs.push({ wrap, canvas, overlay, viewport: null as unknown as PageViewport, view: null });
    }
  }
  for (let i = 0; i < pdf.numPages; i++) await renderPage(i);
}

async function renderPage(index: number): Promise<void> {
  if (!pdf) return;
  const ui = pageUIs[index];
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
  const view = ui.view;
  if (!view) return;

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

  let done = false;
  const cleanup = () => {
    done = true;
    ed.remove();
    hint.remove();
    colorRow.row.remove();
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

  ui.wrap.append(ed, hint, colorRow.row);
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
      await reloadPdfJs();
      await renderPage(pageIndex);
      await refreshUndoButton();
    }
    if (result.message) toast(result.message, result.status === 'ok' ? 'info' : 'warn', 6000);
    else toast('Edit applied.', 'info', 1800);
  } catch (e) {
    toast(`Edit failed: ${e instanceof Error ? e.message : e}`, 'error', 6000);
  }
}

async function refreshUndoButton(): Promise<void> {
  toolbar.undo.disabled = editingDisabled || !(await engine.canUndo());
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
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, handle);
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
    if (file) await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, null);
  };
  input.click();
}

async function saveToHandle(): Promise<void> {
  if (!fileHandle || !currentBytes) return;
  try {
    const writable = await fileHandle.createWritable();
    await writable.write(currentBytes.slice() as unknown as ArrayBuffer & Uint8Array);
    await writable.close();
    toast(`Saved ${fileName}.`);
  } catch (e) {
    toast(`Save failed: ${e instanceof Error ? e.message : e}. Use Download instead.`, 'error', 6000);
  }
}

function download(): void {
  if (!currentBytes) return;
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
toolbar.save.addEventListener('click', () => void saveToHandle());
toolbar.download.addEventListener('click', download);
toolbar.undo.addEventListener('click', async () => {
  const bytes = await engine.undo();
  if (bytes) {
    currentBytes = bytes;
    await reloadPdfJs();
    await renderAllPages(false);
    await refreshUndoButton();
    toast('Undone.');
  }
});
toolbar.zoomIn.addEventListener('click', async () => {
  zoom = Math.min(4, zoom + 0.25);
  toolbar.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  await renderAllPages(false);
});
toolbar.zoomOut.addEventListener('click', async () => {
  zoom = Math.max(0.5, zoom - 0.25);
  toolbar.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  await renderAllPages(false);
});
toolbar.debug.addEventListener('change', () => {
  pageUIs.forEach((_, i) => buildOverlay(i));
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.pdf$/i.test(file.name)) {
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, null);
  }
});

toolbar.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

// ?file=<url> — used by the navigation-intercept redirect
const fileParam = new URLSearchParams(location.search).get('file');
if (fileParam) {
  (async () => {
    try {
      const resp = await fetch(fileParam);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const name = decodeURIComponent(fileParam.split('/').pop() ?? 'document.pdf').split('?')[0];
      await openBytes(buf, name, null);
    } catch (e) {
      banner(`Could not fetch ${fileParam}: ${e instanceof Error ? e.message : e}`);
    }
  })();
}
