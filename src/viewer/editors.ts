// In-place edit surfaces: the rich paragraph edit box, the OCR patch input,
// and their shared color picker. Commits go through state.applyEdit.

import type { ParagraphView, OcrWordView, RGB, Rect, ColorRange } from '../shared/types';
import { engine } from './engine';
import { rectToCss, cssPx, rgbToHex, hexToRgb, sameRgb, cssColorToRgb } from './util';
import { pageUIs, applyEdit } from './state';

/** Swatch row + custom picker. Returns the row element and a getter for the
 *  chosen color (null while unchanged from the default). */
function buildColorRow(defaultColor: RGB, onPick: (c: RGB) => void): { row: HTMLDivElement; chosen: () => RGB | null } {
  let chosen: RGB | null = null;
  const row = document.createElement('div');
  row.className = 'color-row';
  // don't let clicks in the row blur the edit box into a premature commit
  row.addEventListener('mousedown', (e) => e.preventDefault());

  const presets: RGB[] = [
    defaultColor,
    [0, 0, 0],
    [0.77, 0.06, 0.06],
    [0.05, 0.25, 0.7],
    [0.05, 0.45, 0.15],
    [0.45, 0.45, 0.45],
  ];
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
  const base =
    view.fontKind === 'mono'
      ? 'ui-monospace, monospace'
      : view.fontKind === 'serif'
        ? 'Georgia, serif'
        : 'Helvetica, Arial, sans-serif';
  return base;
}

// Embedded-font overlay styling: pull the document's actual TrueType program
// out of the PDF and register it as a web font, so the edit box shows the
// REAL font instead of a generic look-alike. Cached per document generation.
let fontFaceGen = 0;
const fontFaceCache = new Map<string, Promise<string | null>>();

/** Invalidate the embedded-font cache — call when a new document is opened. */
export function resetFontCache(): void {
  fontFaceGen++;
  fontFaceCache.clear();
}

function embeddedFamilyFor(pageIndex: number, para: ParagraphView): Promise<string | null> {
  const key = `${fontFaceGen}:${pageIndex}:${para.fontRes}`;
  let p = fontFaceCache.get(key);
  if (!p) {
    p = (async () => {
      const bytes = await engine.getFontBytes(pageIndex, para.fontRes, para.text.slice(0, 80));
      if (!bytes) return null;
      const family = 'EPDF-' + key.replace(/[^a-zA-Z0-9]/g, '-');
      const face = new FontFace(family, bytes.slice().buffer);
      await face.load();
      document.fonts.add(face);
      return family;
    })().catch(() => null);
    fontFaceCache.set(key, p);
  }
  return p;
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

export function beginParagraphEdit(pageIndex: number, para: ParagraphView): void {
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

export function beginOcrEdit(pageIndex: number, word: OcrWordView): void {
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
