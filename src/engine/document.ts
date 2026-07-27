// EditableDocument: owns the pdf-lib document, the per-page op lists and text
// models, and applies edits (paragraph reflow, OCR patch-over) by rewriting
// page content streams.

import { PDFArray, PDFDict, PDFDocument, PDFFont, PDFName, PDFPage, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib';
import * as pdfLib from 'pdf-lib';
import { parseContent, type Op } from './content-stream/parser';
import { writeContent, mkOp, num, pnum, name, str } from './content-stream/writer';
import { interpret, apply, type RawRun, type Mat, type ShowOpGeom } from './content-stream/interpreter';
import fontkit from '@pdf-lib/fontkit';
import { parsePageFonts, stdFontFor, styleFromName, generateToUnicodeCMap, type FontInfo } from './fonts/font-info';
import { bundledKeyFor, bundledBytes, bundledCanEncode, bundledWidth, isBundledKey } from './fonts/fallback-fonts';
import { parseTrueType } from './fonts/truetype';
import { buildParagraphs, buildOcrWords, type ParaMeta, type OcrWordMeta } from './text-model/paragraphs';
import { planReflow, type Measurer } from './reflow/reflow';
import { flattenFreeText } from './annotations';
import type { EditOutcome, LoadOutcome, PageView, Rect, RGB } from '../shared/types';

const enc = new TextEncoder();

/** One editable image paint: a `Do` of an image XObject, keyed by op index
 *  (the same resource can be drawn multiple times). */
interface ImagePlacement {
  id: string;
  opIndex: number;
  resourceName: string;
  ctm: Mat;
  bbox: Rect; // page space, y-up; AABB of the CTM-transformed unit square
}

interface PageState {
  page: PDFPage;
  ops: Op[];
  fonts: Map<string, FontInfo>;
  imageNames: Set<string>; // /Resources /XObject entries with /Subtype /Image
  runs: RawRun[];
  runIndex: Map<string, RawRun>;
  showOps: Map<number, ShowOpGeom>;
  paras: Map<string, ParaMeta>;
  ocrWords: Map<string, OcrWordMeta>;
  images: Map<string, ImagePlacement>;
  stdFontRes: Map<string, string>; // fallback font key (StandardFonts value or bundled key) -> resource name in this page
}

interface UndoEntry {
  pageIndex: number;
  ops: Op[];
}

function hexToBytes(hexStr: string): Uint8Array {
  const clean = hexStr.replace(/[<>\s]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class EditableDocument {
  private pdfDoc!: PDFDocument;
  private pages: (PageState | null)[] = [];
  private pageList: PDFPage[] = [];
  private building = new Map<number, Promise<PageState>>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private stdFonts = new Map<string, PDFFont>();
  private nextResIdx = 1;

  /** With `lazy`, per-page models (content-stream parse, fonts, text model)
   *  are built on first access instead of up front — the viewer uses this so
   *  a 200-page PDF opens as fast as its first page. Tests use the eager
   *  default so the sync getPageView call-sites keep working. */
  static async load(
    bytes: Uint8Array,
    opts?: { lazy?: boolean },
  ): Promise<{ doc: EditableDocument | null; outcome: LoadOutcome }> {
    const doc = new EditableDocument();
    try {
      doc.pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
      doc.pdfDoc.registerFontkit(fontkit); // bundled fallback fonts embed as subset TTFs
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const encrypted = /encrypt/i.test(msg);
      return { doc: null, outcome: { ok: false, pageCount: 0, encrypted, error: msg } };
    }
    try {
      doc.pageList = doc.pdfDoc.getPages();
      // FreeText annotations (text added by Edge/Acrobat/Preview text tools)
      // become ordinary — and therefore editable — page content. Cheap: only
      // pages that actually carry FreeText annotations do any work.
      for (const page of doc.pageList) flattenFreeText(doc.pdfDoc, page);
      doc.pages = doc.pageList.map(() => null);
      if (!opts?.lazy) {
        for (let i = 0; i < doc.pageList.length; i++) await doc.buildPage(i);
      }
    } catch (e) {
      return {
        doc: null,
        outcome: { ok: false, pageCount: 0, encrypted: false, error: e instanceof Error ? e.message : String(e) },
      };
    }
    return { doc, outcome: { ok: true, pageCount: doc.pageList.length, encrypted: false } };
  }

  /** Build the page model on first access (idempotent, race-safe). */
  async ensurePageReady(index: number): Promise<void> {
    if (this.pages[index]) return;
    let p = this.building.get(index);
    if (!p) {
      p = this.buildPage(index);
      this.building.set(index, p);
      void p.finally(() => this.building.delete(index));
    }
    await p;
  }

  private ctx() {
    return this.pdfDoc.context;
  }

  private lookup(v: unknown): unknown {
    return v instanceof PDFRef ? this.ctx().lookup(v) : v;
  }

  private getContentBytes(page: PDFPage): Uint8Array {
    const contents = this.lookup(page.node.get(PDFName.of('Contents')));
    const streams: Uint8Array[] = [];
    const pushStream = (v: unknown) => {
      const s = this.lookup(v);
      if (s instanceof PDFRawStream) {
        const dec = (pdfLib as unknown as { decodePDFRawStream?: (x: PDFRawStream) => { decode(): Uint8Array } })
          .decodePDFRawStream;
        streams.push(dec ? dec(s).decode() : s.getContents());
      }
    };
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) pushStream(contents.get(i));
    } else {
      pushStream(contents);
    }
    // merge, isolating each stream and the whole page in q/Q so appended edit
    // blocks always start from a pristine graphics state
    const parts: Uint8Array[] = [enc.encode('q\n')];
    for (const s of streams) {
      parts.push(s, enc.encode('\n'));
    }
    parts.push(enc.encode('Q\n'));
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  private pageResources(page: PDFPage): PDFDict | undefined {
    const direct = this.lookup(page.node.get(PDFName.of('Resources')));
    if (direct instanceof PDFDict) return direct;
    // inherited
    const node = page.node as unknown as { Resources?: () => PDFDict | undefined };
    try {
      const r = node.Resources?.();
      if (r instanceof PDFDict) return r;
    } catch {
      // fall through
    }
    return undefined;
  }

  /** Names in /Resources /XObject whose stream is /Subtype /Image. */
  private pageImageNames(page: PDFPage): Set<string> {
    const out = new Set<string>();
    const res = this.pageResources(page);
    const xobj = this.lookup(res?.get(PDFName.of('XObject')));
    if (!(xobj instanceof PDFDict)) return out;
    for (const [key, val] of xobj.entries()) {
      const s = this.lookup(val);
      if (s instanceof PDFRawStream && s.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        out.add(key.decodeText());
      }
    }
    return out;
  }

  private async buildPage(index: number): Promise<PageState> {
    const page = this.pageList[index];
    const bytes = this.getContentBytes(page);
    const ops = parseContent(bytes);
    const st: PageState = {
      page,
      ops,
      fonts: await parsePageFonts(this.pdfDoc, this.pageResources(page)),
      imageNames: this.pageImageNames(page),
      runs: [],
      runIndex: new Map(),
      showOps: new Map(),
      paras: new Map(),
      ocrWords: new Map(),
      images: new Map(),
      stdFontRes: new Map(),
    };
    this.reinterpret(st);
    this.pages[index] = st;
    return st;
  }

  private reinterpret(st: PageState): void {
    const { runs, doPlacements, showOps } = interpret(st.ops, st.fonts);
    st.runs = runs;
    st.runIndex = new Map(st.runs.map((r) => [r.id, r]));
    st.showOps = showOps;
    st.images = new Map();
    for (const p of doPlacements) {
      if (!st.imageNames.has(p.name)) continue; // form XObjects etc.
      const [a, b, c, d] = p.ctm;
      if (Math.abs(a * d - b * c) < 1e-9) continue; // degenerate → invisible, not editable
      const corners = [apply(p.ctm, 0, 0), apply(p.ctm, 1, 0), apply(p.ctm, 0, 1), apply(p.ctm, 1, 1)];
      const xs = corners.map((c2) => c2[0]);
      const ys = corners.map((c2) => c2[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const bbox: Rect = { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      const id = `img-${p.opIndex}`;
      st.images.set(id, { id, opIndex: p.opIndex, resourceName: p.name, ctm: p.ctm, bbox });
    }
    st.paras = new Map();
    const fontIdentity = (res: string) => {
      const f = st.fonts.get(res);
      if (!f || !f.baseFont) return res;
      return f.baseFont.replace(/^[A-Z]{6}\+/, '');
    };
    for (const p of buildParagraphs(st.runs, fontIdentity)) {
      const f = st.fonts.get(p.fontRes);
      if (f) p.style = f.style;
      st.paras.set(p.id, p);
    }
    st.ocrWords = new Map(buildOcrWords(st.runs).map((w) => [w.runId, w]));
  }

  pageCount(): number {
    return this.pages.length;
  }

  getPageView(index: number): PageView {
    const st = this.pages[index];
    if (!st) throw new Error(`Page ${index} model not built — call ensurePageReady first.`);
    const { width, height } = st.page.getSize();
    return {
      index,
      width,
      height,
      paragraphs: [...st.paras.values()].map((p) => ({
        id: p.id,
        bbox: p.bbox,
        text: p.text,
        fontSize: p.fontSize,
        leading: p.leading,
        fontKind: p.style.kind,
        bold: p.style.bold,
        italic: p.style.italic,
        align: p.align,
        color: p.color,
        lineCount: p.lines.length,
        fontRes: p.fontRes,
      })),
      ocrWords: [...st.ocrWords.values()].map((w) => ({
        runId: w.runId,
        text: w.text,
        bbox: w.bbox,
        fontSize: w.fontSize,
      })),
      images: [...st.images.values()].map((p) => ({
        id: p.id,
        bbox: p.bbox,
        resourceName: p.resourceName,
      })),
      runs: st.runs.map((r) => ({
        id: r.id,
        text: r.text,
        bbox: {
          x: r.baseline.x,
          y: r.baseline.y + r.descent,
          w: r.endX - r.baseline.x,
          h: r.ascent - r.descent,
        },
        renderMode: r.renderMode,
        color: r.color,
      })),
      hasVisibleText: st.runs.some((r) => r.renderMode !== 3 && r.text.trim().length > 0),
      hasOcrLayer: st.runs.some((r) => r.renderMode === 3 && r.text.trim().length > 0),
    };
  }

  /** Which fallback tier serves `text` for this style: a bundled look-alike
   *  face when one is registered AND has every glyph, else the standard-14
   *  font. Measurement and emit both route through this so they can never
   *  disagree about which font a word lands in. */
  private fallbackKeyFor(style: ReturnType<typeof styleFromName>, text: string): string {
    const bk = bundledKeyFor(style);
    if (bk && bundledCanEncode(bk, text + ' ')) return bk;
    return stdFontFor(style);
  }

  private async embedFallback(key: string): Promise<PDFFont> {
    let font = this.stdFonts.get(key);
    if (!font) {
      font = isBundledKey(key)
        ? await this.pdfDoc.embedFont(bundledBytes(key), { subset: true })
        : await this.pdfDoc.embedFont(key);
      this.stdFonts.set(key, font);
    }
    return font;
  }

  /** Embed (once) the fallback font matched to original font `forRes` and able
   *  to render `text`, return its resource name on the page. */
  private async ensureFallbackFont(
    st: PageState,
    forRes: string,
    text: string,
  ): Promise<{ resName: string; font: PDFFont }> {
    const orig = st.fonts.get(forRes);
    const style = orig?.style ?? styleFromName(forRes);
    const key = this.fallbackKeyFor(style, text);
    const font = await this.embedFallback(key);
    let resName = st.stdFontRes.get(key);
    if (!resName) {
      resName = `EPDF${this.nextResIdx++}`;
      // ensure a direct, page-level Resources dict we can safely extend
      let res = this.lookup(st.page.node.get(PDFName.of('Resources')));
      if (!(res instanceof PDFDict)) {
        const inherited = this.pageResources(st.page);
        const clone = this.ctx().obj({});
        if (inherited) for (const [k, v] of inherited.entries()) clone.set(k, v);
        st.page.node.set(PDFName.of('Resources'), clone);
        res = clone;
      }
      let fontDict = this.lookup((res as PDFDict).get(PDFName.of('Font')));
      if (!(fontDict instanceof PDFDict)) {
        fontDict = this.ctx().obj({});
        (res as PDFDict).set(PDFName.of('Font'), fontDict as PDFDict);
      }
      (fontDict as PDFDict).set(PDFName.of(resName), font.ref);
      st.stdFontRes.set(key, resName);
    }
    return { resName, font };
  }

  private stdEncode(font: PDFFont, text: string): Uint8Array | null {
    try {
      return hexToBytes(font.encodeText(text).toString());
    } catch {
      return null;
    }
  }

  private stdWidth(font: PDFFont, text: string, size: number): number | null {
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      return null;
    }
  }

  private async measurerFor(st: PageState): Promise<Measurer> {
    // make sure all potentially needed fallback fonts exist — both tiers per
    // style, since the tier is chosen per WORD (embed is async, measurement
    // must be sync)
    const keys = new Set<string>();
    for (const f of st.fonts.values()) keys.add(stdFontFor(f.style));
    keys.add(StandardFonts.Helvetica);
    for (const k of keys) await this.embedFallback(k);
    return {
      measureOrig: (res, text, size) => st.fonts.get(res)?.widthOfText(text, size) ?? null,
      measureStd: (forRes, text, size) => {
        const style = st.fonts.get(forRes)?.style ?? styleFromName(forRes);
        const key = this.fallbackKeyFor(style, text);
        // bundled tier measures from its own cmap/hmtx — no embed until a
        // word actually lands in the font at emit time
        if (isBundledKey(key)) return bundledWidth(key, text, size);
        const f = this.stdFonts.get(key)!;
        return this.stdWidth(f, text, size);
      },
    };
  }

  /** Remove the visual output of the given show-ops while preserving their positioning side effects. */
  private removeShowOps(ops: Op[], opIndices: Set<number>): Op[] {
    const out: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!opIndices.has(i)) {
        out.push(op);
        continue;
      }
      if (op.op === 'Tj' || op.op === 'TJ') continue; // no positioning side effects on Tlm
      if (op.op === "'") {
        out.push(mkOp("'", str(new Uint8Array(0))));
        continue;
      }
      if (op.op === '"') {
        out.push(mkOp('"', op.args[0] ?? num(0), op.args[1] ?? num(0), str(new Uint8Array(0))));
        continue;
      }
      out.push(op);
    }
    return out;
  }

  private rebuildStream(st: PageState): void {
    const bytes = writeContent(st.ops);
    const stream = this.ctx().flateStream(bytes);
    const ref = this.ctx().register(stream);
    st.page.node.set(PDFName.of('Contents'), ref);
    this.reinterpret(st);
  }

  /** Write newly minted code→unicode/width mappings into the PDF's ToUnicode
   *  CMap and CID W array, so search/copy/extraction see the extended codes. */
  private flushFontExtensions(st: PageState): void {
    const ctx = this.ctx();
    for (const f of st.fonts.values()) {
      if (!f.pendingExt.size || !f.dicts) continue;
      const cmapText = generateToUnicodeCMap(f.toUnicodeMap);
      const stream = ctx.flateStream(cmapText);
      f.dicts.fontDict.set(PDFName.of('ToUnicode'), ctx.register(stream));
      if (f.dicts.cidFont) {
        const wVal = this.lookup(f.dicts.cidFont.get(PDFName.of('W')));
        const newW = ctx.obj([]);
        if (wVal instanceof PDFArray) {
          for (let i = 0; i < wVal.size(); i++) newW.push(wVal.get(i));
        }
        for (const [cid, e] of f.pendingExt) {
          newW.push(ctx.obj(cid));
          newW.push(ctx.obj([e.w1000]));
        }
        f.dicts.cidFont.set(PDFName.of('W'), newW);
      }
      f.pendingExt.clear();
    }
  }

  /** Free vertical space (page units, y-up) between a paragraph's bottom edge
   *  and the nearest visible content below it that overlaps horizontally —
   *  the room overflow lines may grow into without covering anything. Only
   *  runs and image placements are modeled (paths/rules are not), so keep a
   *  safety margin. */
  private freeHeightBelow(st: PageState, para: ParaMeta): number {
    const left = para.bbox.x;
    const right = para.bbox.x + para.bbox.w;
    const bottom = para.bbox.y;
    let highestTopBelow = 36; // page bottom margin when nothing is below
    const consider = (bb: { x: number; y: number; w: number; h: number }) => {
      const top = bb.y + bb.h;
      if (top > bottom + 1) return; // not below (or the paragraph itself)
      if (bb.x + bb.w < left || bb.x > right) return; // no horizontal overlap
      if (top > highestTopBelow) highestTopBelow = top;
    };
    for (const r of st.runs) {
      if (para.opIndices.has(r.opIndex)) continue; // the paragraph's own runs
      if (r.renderMode === 3 || !r.text.trim()) continue; // invisible OCR layer
      consider({ x: r.baseline.x, y: r.baseline.y + r.descent, w: r.endX - r.baseline.x, h: r.ascent - r.descent });
    }
    for (const img of st.images.values()) consider(img.bbox);
    return Math.max(0, bottom - highestTopBelow - 4);
  }

  /** True if placing text at `bbox` would collide with another paragraph:
   *  strict bbox intersection (text painting over text) is always refused;
   *  the wider merge-guard margin (vertical 1.9 × font size — the window
   *  where buildParagraphs would fuse the blocks on the next generation)
   *  applies only between MERGEABLE font sizes, mirroring the detector's
   *  >15% size-discontinuity refusal — so a 22pt heading can be re-centered
   *  beside its 10pt subtitle. Keep in sync with moveWouldOverlap
   *  (viewer, util.ts). */
  private overlapsOtherText(st: PageState, selfId: string, bbox: Rect, fontSize: number): boolean {
    for (const other of st.paras.values()) {
      if (other.id === selfId) continue;
      if (bbox.x + bbox.w <= other.bbox.x || bbox.x >= other.bbox.x + other.bbox.w) continue;
      if (bbox.y + bbox.h > other.bbox.y && bbox.y < other.bbox.y + other.bbox.h) return true;
      if (Math.abs(fontSize - other.fontSize) > 0.15 * Math.max(fontSize, other.fontSize)) continue;
      const margin = 1.9 * Math.max(fontSize, other.fontSize);
      if (bbox.y + bbox.h <= other.bbox.y - margin || bbox.y >= other.bbox.y + other.bbox.h + margin) continue;
      return true;
    }
    return false;
  }

  private snapshot(pageIndex: number): void {
    // edit paths ensure the page model exists before snapshotting
    this.undoStack.push({ pageIndex, ops: [...this.pages[pageIndex]!.ops] });
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = []; // a fresh edit invalidates the redo history
  }

  async editParagraph(
    pageIndex: number,
    paragraphId: string,
    newText: string,
    color?: RGB,
    colorRanges?: import('../shared/types').ColorRange[],
    offset?: { dx: number; dy: number },
  ): Promise<EditOutcome> {
    await this.ensurePageReady(pageIndex);
    const st = this.pages[pageIndex];
    const para = st?.paras.get(paragraphId);
    if (!st || !para) return { status: 'error', message: 'Paragraph not found (the page may have changed).' };
    // page-space (y-up) shift applied to the regenerated text; the emitted
    // block runs under the page-level q/Q wrap (CTM identity), so page delta
    // IS text delta. Overflow/width checks stay anchored to the source
    // position. For an unchanged-text pure move use moveParagraph instead —
    // it preserves the original operators exactly.
    const odx = offset?.dx ?? 0;
    const ody = offset?.dy ?? 0;
    const moved = Math.hypot(odx, ody) > 1e-6;
    const sameColor = !color || color.every((c, i) => Math.abs(c - para.color[i]) < 1e-3);
    if (newText.trim() === para.text.trim() && sameColor && !colorRanges?.length && !moved) {
      return { status: 'ok', bytes: await this.save() };
    }
    if (moved) {
      const dest: Rect = { x: para.bbox.x + odx, y: para.bbox.y + ody, w: para.bbox.w, h: para.bbox.h };
      if (this.overlapsOtherText(st, para.id, dest, para.fontSize)) {
        return { status: 'error', message: 'That spot overlaps other text — the paragraph was not moved.' };
      }
    }

    const measurer = await this.measurerFor(st);
    // Single-line paragraphs (headers, captions) may grow toward the page's
    // text-area right edge instead of being trapped in their own tight bbox.
    const opts: {
      maxWidth?: number;
      extraHeight?: number;
      baseColor?: RGB;
      colorRanges?: import('../shared/types').ColorRange[];
    } = {
      baseColor: color,
      colorRanges,
      extraHeight: this.freeHeightBelow(st, para),
    };
    if (para.lines.length === 1) {
      const pageRight = Math.max(...[...st.paras.values()].map((pp) => pp.bbox.x + pp.bbox.w));
      if (pageRight > para.bbox.x + para.bbox.w) opts.maxWidth = pageRight - para.bbox.x;
    }
    const plan = planReflow(para, newText, measurer, opts);
    if ('error' in plan) return { status: 'error', message: plan.error };

    // Resolve each placed word to a resource name + encoder, then group
    // consecutive same-line/same-font words into a single Tj containing REAL
    // space glyphs. Absolute per-word positioning without space characters
    // renders fine but destroys copy/paste and search — extractors see the
    // words run together.
    interface RWord {
      text: string;
      x: number;
      y: number;
      size: number;
      color: RGB;
      resName: string;
      encode: (t: string) => Uint8Array | null;
    }
    const rwords: RWord[] = [];
    for (const w of plan.placed) {
      if (w.font.t === 'orig') {
        const f = st.fonts.get(w.font.res);
        if (!f) return { status: 'error', message: `Font ${w.font.res} missing — edit cancelled.` };
        rwords.push({
          text: w.text,
          x: w.x,
          y: w.y,
          size: w.size,
          color: w.color,
          resName: w.font.res,
          encode: (t) => f.encode(t),
        });
      } else {
        const { resName, font } = await this.ensureFallbackFont(st, w.font.forRes, w.text);
        rwords.push({
          text: w.text,
          x: w.x,
          y: w.y,
          size: w.size,
          color: w.color,
          resName,
          encode: (t) => this.stdEncode(font, t),
        });
      }
    }

    const sameRgb = (a: RGB, b: RGB) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
    interface Group {
      resName: string;
      size: number;
      x: number;
      y: number;
      color: RGB;
      words: RWord[];
    }
    const groups: Group[] = [];
    for (const w of rwords) {
      const g = groups[groups.length - 1];
      if (
        g &&
        g.resName === w.resName &&
        Math.abs(g.size - w.size) < 1e-6 &&
        Math.abs(g.y - w.y) < 1e-6 &&
        sameRgb(g.color, w.color) &&
        w.encode(' ') !== null
      ) {
        g.words.push(w);
      } else {
        groups.push({ resName: w.resName, size: w.size, x: w.x, y: w.y, color: w.color, words: [w] });
      }
    }

    const blocks: Op[] = [mkOp('q'), mkOp('BT'), mkOp('Tr', num(0))];
    let lastFontKey = '';
    let lastColor: RGB | null = null;
    for (const g of groups) {
      const joined = g.words.map((w) => w.text).join(' ');
      const bytes = g.words[0].encode(joined);
      if (!bytes) return { status: 'error', message: `Could not encode "${joined}" — edit cancelled.` };
      const fontKey = `${g.resName}@${g.size.toFixed(3)}`;
      if (fontKey !== lastFontKey) {
        blocks.push(mkOp('Tf', name(g.resName), num(g.size)));
        lastFontKey = fontKey;
      }
      if (!lastColor || !sameRgb(lastColor, g.color)) {
        blocks.push(mkOp('rg', num(g.color[0]), num(g.color[1]), num(g.color[2])));
        lastColor = g.color;
      }
      blocks.push(mkOp('Tm', num(1), num(0), num(0), num(1), num(g.x + odx), num(g.y + ody)));
      blocks.push(mkOp('Tj', str(bytes)));
    }
    blocks.push(mkOp('ET'), mkOp('Q'));

    this.snapshot(pageIndex);
    st.ops = this.removeShowOps(st.ops, para.opIndices);
    st.ops.push(...blocks);
    this.flushFontExtensions(st);
    this.rebuildStream(st);

    const msgs: string[] = [];
    if (plan.status === 'overflow-shrunk')
      msgs.push(`Text was shrunk to ${Math.round(plan.scale * 100)}% to fit the paragraph.`);
    if (plan.usedFallback)
      msgs.push(
        "Some characters aren't available in the document's embedded (subset) font — a similar substitute font was used for those words.",
      );

    return {
      status: plan.status,
      usedFallback: plan.usedFallback,
      message: msgs.length ? msgs.join(' ') : undefined,
      bytes: await this.save(),
    };
  }

  /** Delete a whole paragraph: remove its show-ops (removeShowOps preserves
   *  the ops' positioning side effects, so surrounding text is unaffected). */
  async deleteParagraph(pageIndex: number, paragraphId: string): Promise<EditOutcome> {
    await this.ensurePageReady(pageIndex);
    const st = this.pages[pageIndex];
    const para = st?.paras.get(paragraphId);
    if (!st || !para) return { status: 'error', message: 'Paragraph not found (the page may have changed).' };
    this.snapshot(pageIndex);
    st.ops = this.removeShowOps(st.ops, para.opIndices);
    this.rebuildStream(st);
    return { status: 'ok', bytes: await this.save() };
  }

  /** Move a paragraph by (dx, dy) in page space — translate-only, IN PLACE.
   *  Never routed through reflow/re-encode: each of the paragraph's show ops
   *  is sandwiched between an absolute Tm (the recorded tm-at-show plus the
   *  delta pushed through the inverse of the CTM's linear part, same math as
   *  moveImage) and a restore Tm (the recorded original tlm). Kerning,
   *  justification, fonts, and paint order are untouched, and every op after
   *  the paragraph sees the original text-line-matrix chain. Quote forms
   *  convert to Tw/Tc/Tj — their leading move is already baked into the
   *  recorded matrix, and the spacing args are persistent state the explicit
   *  Tw/Tc reproduce. */
  async moveParagraph(pageIndex: number, paragraphId: string, dx: number, dy: number): Promise<EditOutcome> {
    await this.ensurePageReady(pageIndex);
    const st = this.pages[pageIndex];
    const para = st?.paras.get(paragraphId);
    if (!st || !para) return { status: 'error', message: 'Paragraph not found (the page may have changed).' };

    // Refuse destinations that overlap (or nearly touch) other text — the
    // paragraph detector would merge the blocks on the next generation, and
    // a later edit would re-encode both texts as one.
    const dest: Rect = { x: para.bbox.x + dx, y: para.bbox.y + dy, w: para.bbox.w, h: para.bbox.h };
    if (this.overlapsOtherText(st, para.id, dest, para.fontSize)) {
      return { status: 'error', message: 'That spot overlaps other text — the paragraph was not moved.' };
    }

    // A single TJ can span two detected paragraphs (column split on a huge
    // kern) — translating the whole op would drag the other column along.
    // (editParagraph/deleteParagraph share this hazard via removeShowOps.)
    const runIds = new Set(para.runIds);
    for (const r of st.runs) {
      if (para.opIndices.has(r.opIndex) && !runIds.has(r.id)) {
        return {
          status: 'error',
          message: "This text shares a drawing operation with another block and can't be moved on its own.",
        };
      }
    }

    interface Sandwich {
      before: Mat;
      after: Mat;
    }
    const plan = new Map<number, Sandwich>();
    for (const opIndex of para.opIndices) {
      const g = st.showOps.get(opIndex);
      if (!g) return { status: 'error', message: 'Paragraph not found (the page may have changed).' };
      const [a, b, c, d] = g.ctm;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-9) {
        return { status: 'error', message: 'This text has a degenerate transform and cannot be moved.' };
      }
      // tm' = tm · (C·T(dx,dy)·C⁻¹); C·T·C⁻¹ is a pure translation by the
      // page delta through the inverse of the CTM's linear part.
      const dxp = (dx * d - dy * c) / det;
      const dyp = (dy * a - dx * b) / det;
      const t = g.tmAtShow;
      plan.set(opIndex, { before: [t[0], t[1], t[2], t[3], t[4] + dxp, t[5] + dyp], after: g.tlmAfter });
    }

    // Pin followers whose position continued from a tm advance the restore-Tm
    // discards: after a sandwiched op, tm = tlm rather than the glyph-advanced
    // matrix, so a Tj/TJ that ran before the next positioning op (per-glyph
    // generators do this) must be re-anchored at its original position.
    let chainDirty = false;
    for (let i = 0; i < st.ops.length; i++) {
      const { op } = st.ops[i];
      if (para.opIndices.has(i)) {
        chainDirty = true;
        continue;
      }
      if (op === 'BT' || op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*') {
        chainDirty = false;
      } else if (op === "'" || op === '"') {
        chainDirty = false; // repositions from tlm, which the restore keeps correct
      } else if ((op === 'Tj' || op === 'TJ') && chainDirty) {
        const g = st.showOps.get(i);
        if (g) plan.set(i, { before: g.tmAtShow, after: g.tlmAfter }); // pinned, unshifted
        // stays dirty: the pin's own restore also leaves tm = tlm
      }
    }

    this.snapshot(pageIndex);
    const tmOp = (m: Mat) => mkOp('Tm', pnum(m[0]), pnum(m[1]), pnum(m[2]), pnum(m[3]), pnum(m[4]), pnum(m[5]));
    const out: Op[] = [];
    for (let i = 0; i < st.ops.length; i++) {
      const s = plan.get(i);
      if (!s) {
        out.push(st.ops[i]);
        continue;
      }
      const op = st.ops[i];
      out.push(tmOp(s.before));
      if (op.op === "'") {
        out.push(mkOp('Tj', op.args[0] ?? str(new Uint8Array(0))));
      } else if (op.op === '"') {
        out.push(
          mkOp('Tw', op.args[0] ?? num(0)),
          mkOp('Tc', op.args[1] ?? num(0)),
          mkOp('Tj', op.args[2] ?? str(new Uint8Array(0))),
        );
      } else {
        out.push(op);
      }
      out.push(tmOp(s.after));
    }
    st.ops = out;
    this.rebuildStream(st);
    return { status: 'ok', bytes: await this.save() };
  }

  async editOcrWord(
    pageIndex: number,
    runId: string,
    newText: string,
    patchColor: RGB,
    textColor?: RGB,
  ): Promise<EditOutcome> {
    await this.ensurePageReady(pageIndex);
    const st = this.pages[pageIndex];
    const word = st?.ocrWords.get(runId);
    const run = st?.runIndex.get(runId);
    if (!st || !word || !run) return { status: 'error', message: 'Word not found (the page may have changed).' };
    const text = newText.trim();
    if (!text) return { status: 'error', message: 'Replacement text cannot be empty.' };

    const { resName, font } = await this.ensureFallbackFont(st, run.fontRes, text);
    const bytes = this.stdEncode(font, text);
    if (!bytes) {
      return { status: 'error', message: 'The replacement text contains characters the fallback font cannot render.' };
    }

    // size: fit height first, then shrink (floor 70%) to fit width
    let size = Math.max(4, word.bbox.h * 0.92);
    let w = this.stdWidth(font, text, size) ?? size * text.length * 0.5;
    let status: EditOutcome['status'] = 'ok';
    if (w > word.bbox.w) {
      const shrunk = Math.max(size * 0.7, (size * word.bbox.w) / w);
      size = shrunk;
      w = this.stdWidth(font, text, size) ?? w;
    }
    const patchW = Math.max(word.bbox.w, w) + 2;
    if (w > word.bbox.w * 1.02) status = 'overflow-flagged';

    this.snapshot(pageIndex);
    st.ops = this.removeShowOps(st.ops, new Set([run.opIndex]));
    st.ops.push(
      mkOp('q'),
      mkOp('rg', num(patchColor[0]), num(patchColor[1]), num(patchColor[2])),
      mkOp('re', num(word.bbox.x - 1), num(word.bbox.y - 1), num(patchW), num(word.bbox.h + 2)),
      mkOp('f'),
      mkOp('Q'),
      mkOp('q'),
      mkOp('BT'),
      mkOp('Tr', num(0)),
      mkOp('rg', num(textColor?.[0] ?? 0.05), num(textColor?.[1] ?? 0.05), num(textColor?.[2] ?? 0.05)),
      mkOp('Tf', name(resName), num(size)),
      mkOp('Tm', num(1), num(0), num(0), num(1), num(word.baseline.x), num(word.baseline.y)),
      mkOp('Tj', str(bytes)),
      mkOp('ET'),
      mkOp('Q'),
    );
    this.rebuildStream(st);

    return {
      status,
      message:
        status === 'overflow-flagged'
          ? 'The replacement is wider than the original word — the patch may cover neighboring content.'
          : undefined,
      bytes: await this.save(),
    };
  }

  /** Validate an image placement id against the current op list. */
  private imagePlacement(st: PageState, imageId: string): ImagePlacement | null {
    const pl = st.images.get(imageId);
    if (!pl) return null;
    const doOp = st.ops[pl.opIndex];
    if (doOp?.op !== 'Do' || doOp.args[0]?.k !== 'name' || doOp.args[0].v !== pl.resourceName) return null;
    return pl;
  }

  /** Move an image placement by (dx, dy) in page space. The Do is replaced in
   *  place with `q cm Do Q` — never appended at stream end, which would repaint
   *  the image above content drawn after it. The inserted cm acts in the local
   *  space at the Do (effective matrix D×M), so the page delta is pushed
   *  through the inverse of the CTM's linear part: D = M·T(dx,dy)·M⁻¹, a pure
   *  translation. */
  async moveImage(pageIndex: number, imageId: string, dx: number, dy: number): Promise<EditOutcome> {
    await this.ensurePageReady(pageIndex);
    const st = this.pages[pageIndex];
    const pl = st ? this.imagePlacement(st, imageId) : null;
    if (!st || !pl) return { status: 'error', message: 'Image not found (the page may have changed).' };
    const [a, b, c, d] = pl.ctm;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) {
      return { status: 'error', message: 'This image has a degenerate transform and cannot be moved.' };
    }
    const dxp = (dx * d - dy * c) / det;
    const dyp = (dy * a - dx * b) / det;

    this.snapshot(pageIndex);
    const doOp = st.ops[pl.opIndex];
    st.ops.splice(
      pl.opIndex,
      1,
      mkOp('q'),
      mkOp('cm', num(1), num(0), num(0), num(1), pnum(dxp), pnum(dyp)),
      doOp,
      mkOp('Q'),
    );
    this.rebuildStream(st);
    return { status: 'ok', bytes: await this.save() };
  }

  /** Delete an image placement. `Do` has no graphics-state side effects, so
   *  dropping just the op is safe; surrounding q/cm/Q stay as harmless no-ops. */
  async deleteImage(pageIndex: number, imageId: string): Promise<EditOutcome> {
    await this.ensurePageReady(pageIndex);
    const st = this.pages[pageIndex];
    const pl = st ? this.imagePlacement(st, imageId) : null;
    if (!st || !pl) return { status: 'error', message: 'Image not found (the page may have changed).' };
    this.snapshot(pageIndex);
    st.ops.splice(pl.opIndex, 1);
    this.rebuildStream(st);
    return { status: 'ok', bytes: await this.save() };
  }

  /** Embedded TrueType bytes for styling the edit overlay with the REAL
   *  document font — only when the browser could actually use it (the font
   *  program needs a cmap that covers the text being edited). */
  getEmbeddedFontBytes(pageIndex: number, fontRes: string, sample: string): Uint8Array | null {
    const f = this.pages[pageIndex]?.fonts.get(fontRes);
    if (!f?.fontFile2) return null;
    const tt = parseTrueType(f.fontFile2);
    if (!tt) return null; // no usable cmap → browser would render tofu
    const chars = [...new Set(sample.replace(/\s/g, ''))].slice(0, 40);
    if (!chars.length) return null;
    const covered = chars.filter((ch) => tt.gidFor(ch.codePointAt(0)!) > 0).length;
    if (covered / chars.length < 0.9) return null;
    return f.fontFile2;
  }

  async undo(): Promise<Uint8Array | null> {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const st = this.pages[entry.pageIndex]!; // edits only exist on built pages
    this.redoStack.push({ pageIndex: entry.pageIndex, ops: [...st.ops] });
    st.ops = entry.ops;
    this.rebuildStream(st);
    return this.save();
  }

  async redo(): Promise<Uint8Array | null> {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const st = this.pages[entry.pageIndex]!; // edits only exist on built pages
    // push directly (not via snapshot(), which would wipe the redo stack)
    this.undoStack.push({ pageIndex: entry.pageIndex, ops: [...st.ops] });
    st.ops = entry.ops;
    this.rebuildStream(st);
    return this.save();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  async save(): Promise<Uint8Array> {
    return this.pdfDoc.save({ useObjectStreams: false });
  }
}
