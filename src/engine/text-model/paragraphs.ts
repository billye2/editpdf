// Reconstructs words / lines / paragraphs from positioned text runs.
// PDF has no paragraph model, so this is heuristic: baseline grouping for
// lines, leading + x-overlap for paragraphs, glyph gaps for word boundaries.

import type { RawRun, RGB } from '../content-stream/interpreter';
import type { FontStyle } from '../fonts/font-info';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WordMeta {
  text: string;
  fontRes: string;
  size: number;
  bbox: Rect;
  lineIdx: number;
  color: RGB;
}

export interface LineMeta {
  baselineY: number;
  x: number;
  endX: number;
  text: string;
  ascent: number;
  descent: number;
}

export interface ParaMeta {
  id: string;
  bbox: Rect;
  lines: LineMeta[];
  words: WordMeta[];
  opIndices: Set<number>;
  runIds: string[];
  leading: number;
  fontSize: number;
  fontRes: string;
  style: FontStyle;
  color: RGB;
  align: 'left' | 'center' | 'right' | 'justify';
  firstLineX: number;
  text: string;
}

interface LineGroup {
  y: number;
  runs: RawRun[];
}

function runBBox(r: RawRun): Rect {
  return {
    x: r.baseline.x,
    y: r.baseline.y + r.descent,
    w: r.endX - r.baseline.x,
    h: r.ascent - r.descent,
  };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Split runs on one baseline into visually separate segments (columns). */
function splitSegments(runs: RawRun[]): RawRun[][] {
  const sorted = [...runs].sort((a, b) => a.baseline.x - b.baseline.x);
  const segs: RawRun[][] = [];
  let cur: RawRun[] = [];
  for (const r of sorted) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = r.baseline.x - prev.endX;
      if (gap > 3 * Math.max(r.sizeEff, prev.sizeEff)) {
        segs.push(cur);
        cur = [];
      }
    }
    cur.push(r);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/** Extract words from the runs of a single line (runs sorted by x). */
function lineWords(runs: RawRun[], lineIdx: number): WordMeta[] {
  const words: WordMeta[] = [];
  let text = '';
  let fontRes = '';
  let size = 0;
  let color: RGB = [0, 0, 0];
  let x0 = 0;
  let x1 = 0;
  let yTop = 0;
  let yBot = 0;

  const flush = () => {
    if (text.trim().length) {
      words.push({
        text: text.trim(),
        fontRes,
        size,
        color,
        bbox: { x: x0, y: yBot, w: x1 - x0, h: yTop - yBot },
        lineIdx,
      });
    }
    text = '';
  };

  let prevEnd: number | null = null;
  for (const r of runs) {
    const gap = prevEnd === null ? 0 : r.baseline.x - prevEnd;
    if (prevEnd !== null && gap > 0.2 * r.sizeEff) flush();
    for (const g of r.glyphs) {
      // word boundary: any whitespace-class glyph, or an undecodable glyph
      // (empty unicode, e.g. an unmapped space in a sparse ToUnicode) whose
      // advance is space-sized
      if ((g.u !== '' && /^\s+$/.test(g.u)) || (g.u === '' && g.w > 0.15 * r.sizeEff)) {
        flush();
        continue;
      }
      if (!text) {
        fontRes = r.fontRes;
        size = r.sizeEff;
        color = r.color;
        x0 = g.x;
        yTop = r.baseline.y + r.ascent;
        yBot = r.baseline.y + r.descent;
      }
      text += g.u;
      x1 = g.x + g.w;
      yTop = Math.max(yTop, r.baseline.y + r.ascent);
      yBot = Math.min(yBot, r.baseline.y + r.descent);
    }
    prevEnd = r.endX;
  }
  flush();
  return words;
}

const isInkRun = (r: RawRun) => r.text.trim().length > 0;

export function buildParagraphs(runs: RawRun[], fontIdentity?: (res: string) => string): ParaMeta[] {
  // Whitespace-only runs MUST stay in the pipeline: per-glyph PDFs (e.g.
  // browser print-to-PDF) emit every space as its own run — dropping them
  // both loses word boundaries and leaves orphan ops behind on edit. Only
  // geometry/statistics computations below restrict themselves to ink runs.
  const visible = runs.filter((r) => r.renderMode !== 3 && !r.rotated && r.glyphs.length > 0);
  if (!visible.some(isInkRun)) return [];
  // Resource NAMES are not a reliable font identity (generators may mint a new
  // name per text operation for the same font) — callers map them to a
  // canonical key such as the stripped BaseFont name.
  const fontKey = fontIdentity ?? ((res: string) => res);

  // 1. group into baselines
  const byY = [...visible].sort((a, b) => b.baseline.y - a.baseline.y || a.baseline.x - b.baseline.x);
  const lines: LineGroup[] = [];
  for (const r of byY) {
    const tol = 0.35 * r.sizeEff;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.baseline.y) < tol) last.runs.push(r);
    else lines.push({ y: r.baseline.y, runs: [r] });
  }

  // 2. split multi-column baselines into segments; keep reading order (top-down)
  interface Seg {
    y: number;
    runs: RawRun[];
    x: number;
    endX: number;
    size: number;
    domFont: string;
  }
  const segs: Seg[] = [];
  for (const lg of lines) {
    for (const segRuns of splitSegments(lg.runs)) {
      // geometry and font statistics come from ink runs only — trailing or
      // isolated space runs shouldn't stretch line extents or shift fonts
      const ink = segRuns.filter(isInkRun);
      if (!ink.length) continue; // whitespace-only line: nothing to model
      const x = Math.min(...ink.map((r) => r.baseline.x));
      const endX = Math.max(...ink.map((r) => r.endX));
      const size = Math.max(...ink.map((r) => r.sizeEff));
      // dominant font of the line, weighted by characters shown in it
      const weight = new Map<string, number>();
      for (const r of ink) {
        const k = fontKey(r.fontRes);
        weight.set(k, (weight.get(k) ?? 0) + r.text.trim().length);
      }
      let domFont = '';
      let domW = -1;
      for (const [k, v] of weight)
        if (v > domW) {
          domW = v;
          domFont = k;
        }
      segs.push({ y: lg.y, runs: segRuns, x, endX, size, domFont });
    }
  }

  // 3. group segments into paragraphs
  interface Building {
    segs: Seg[];
  }
  const paras: Building[] = [];
  const open: Building[] = [];
  for (const seg of segs) {
    let best: Building | null = null;
    let bestGap = Infinity;
    for (const p of open) {
      const last = p.segs[p.segs.length - 1];
      const gap = last.y - seg.y;
      if (gap <= 0.01) continue; // same or above — not a continuation
      const maxLeading = 1.9 * Math.max(seg.size, last.size);
      if (gap > maxLeading) continue;
      const overlap = Math.min(last.endX, seg.endX) - Math.max(last.x, seg.x);
      const minW = Math.min(last.endX - last.x, seg.endX - seg.x);
      if (overlap < 0.3 * minW && Math.abs(seg.x - last.x) > 2.5 * seg.size) continue;
      // font discontinuity between whole lines → header vs body, don't merge.
      // (Inline style changes don't trigger this: the check compares each
      // line's DOMINANT font, weighted by character count.)
      if (Math.abs(seg.size - last.size) > 0.15 * Math.max(seg.size, last.size)) continue;
      if (seg.domFont !== last.domFont) continue;
      const blockMinX = Math.min(...p.segs.map((s) => s.x));
      const blockMaxEnd = Math.max(...p.segs.map((s) => s.endX));
      const blockW = blockMaxEnd - blockMinX;
      const segW = seg.endX - seg.x;
      // block so far is much narrower than the incoming line → it was a short
      // header (or other standalone line); start a new paragraph
      if (blockW < 0.7 * segW && seg.endX - blockMaxEnd > 2.5 * seg.size) continue;
      // previous line ended far short of the block's right edge → the
      // paragraph ended there; the incoming line belongs to a new one
      if (p.segs.length >= 2 && blockMaxEnd - last.endX > Math.max(0.25 * blockW, 3 * seg.size)) continue;
      if (gap < bestGap) {
        best = p;
        bestGap = gap;
      }
    }
    if (best) best.segs.push(seg);
    else {
      const b = { segs: [seg] };
      paras.push(b);
      open.push(b);
    }
    // prune paragraphs that can no longer be continued (too far above)
    for (let i = open.length - 1; i >= 0; i--) {
      const last = open[i].segs[open[i].segs.length - 1];
      if (last.y - seg.y > 4 * seg.size) open.splice(i, 1);
    }
  }

  // 4. build ParaMeta
  return paras.map((p, idx) => {
    const allRuns = p.segs.flatMap((s) => s.runs);
    // geometry from ink runs; runIds/opIndices from ALL runs so space-only
    // ops are removed too when the paragraph is regenerated
    const inkRuns = allRuns.filter(isInkRun);
    let bbox = runBBox(inkRuns[0]);
    for (const r of inkRuns.slice(1)) bbox = union(bbox, runBBox(r));

    const lineMetas: LineMeta[] = p.segs.map((s) => ({
      baselineY: s.y,
      x: s.x,
      endX: s.endX,
      text: '',
      ascent: Math.max(...s.runs.filter(isInkRun).map((r) => r.ascent)),
      descent: Math.min(...s.runs.filter(isInkRun).map((r) => r.descent)),
    }));

    const words: WordMeta[] = [];
    p.segs.forEach((s, li) => {
      const w = lineWords(
        [...s.runs].sort((a, b) => a.baseline.x - b.baseline.x),
        li,
      );
      lineMetas[li].text = w.map((x) => x.text).join(' ');
      words.push(...w);
    });

    // dominant font: weight by text length
    const fontWeight = new Map<string, number>();
    for (const w of words) {
      const key = `${w.fontRes}@@${w.size.toFixed(2)}`;
      fontWeight.set(key, (fontWeight.get(key) ?? 0) + w.text.length);
    }
    let domKey = '';
    let domW = -1;
    for (const [k, v] of fontWeight)
      if (v > domW) {
        domW = v;
        domKey = k;
      }
    const [fontRes, sizeStr] = domKey.split('@@');
    const fontSize = parseFloat(sizeStr || '12');

    // leading: median baseline delta
    const deltas: number[] = [];
    for (let i = 1; i < lineMetas.length; i++) deltas.push(lineMetas[i - 1].baselineY - lineMetas[i].baselineY);
    deltas.sort((a, b) => a - b);
    const leading = deltas.length ? deltas[Math.floor(deltas.length / 2)] : fontSize * 1.2;

    // alignment
    let align: ParaMeta['align'] = 'left';
    if (lineMetas.length > 1) {
      const bodyLines = lineMetas.slice(0, -1); // last line of justified text is ragged
      const dev = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
      const leftDev = dev(lineMetas.map((l) => l.x));
      const rightDev = dev(bodyLines.map((l) => l.endX));
      const centerDev = dev(lineMetas.map((l) => (l.x + l.endX) / 2));
      const tol = fontSize * 0.8;
      if (leftDev < tol && rightDev < tol && bodyLines.length > 1) align = 'justify';
      else if (leftDev < tol) align = 'left';
      else if (rightDev < tol) align = 'right';
      else if (centerDev < tol) align = 'center';
    }

    const dominant = inkRuns.find((r) => r.fontRes === fontRes) ?? inkRuns[0];

    return {
      id: `p${idx}`,
      bbox,
      lines: lineMetas,
      words,
      opIndices: new Set(allRuns.map((r) => r.opIndex)),
      runIds: allRuns.map((r) => r.id),
      leading: Math.max(leading, fontSize * 0.8),
      fontSize,
      fontRes,
      style: { kind: 'sans', bold: false, italic: false }, // caller patches from FontInfo
      color: dominant.color,
      align,
      firstLineX: lineMetas[0].x,
      text: lineMetas.map((l) => l.text).join(' '),
    };
  });
}

/** OCR word boxes: run-level boxes for invisible (Tr 3) text. */
export interface OcrWordMeta {
  runId: string;
  opIndex: number;
  text: string;
  bbox: Rect;
  baseline: { x: number; y: number };
  fontSize: number;
}

export function buildOcrWords(runs: RawRun[]): OcrWordMeta[] {
  return runs
    .filter((r) => r.renderMode === 3 && r.text.trim().length > 0 && !r.rotated)
    .map((r) => ({
      runId: r.id,
      opIndex: r.opIndex,
      text: r.text,
      bbox: runBBox(r),
      baseline: r.baseline,
      fontSize: r.sizeEff,
    }));
}
