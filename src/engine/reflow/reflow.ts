// Within-paragraph reflow: word-diffs the edited text against the original,
// assigns fonts (original where a word survives, neighbor's font for new
// words), then greedily re-wraps into the paragraph's original bounding box.
// Overflow shrinks the font down to a 90% floor, then flags.

import type { ParaMeta } from '../text-model/paragraphs';

export interface FontChoiceOrig {
  t: 'orig';
  res: string;
}
export interface FontChoiceStd {
  t: 'std';
  forRes: string; // the original font this replaces (drives style matching)
}
export type FontChoice = FontChoiceOrig | FontChoiceStd;

export type RGB = [number, number, number];

export interface ColorRange {
  start: number;
  end: number;
  color: RGB;
}

export interface PlacedWord {
  text: string;
  x: number;
  y: number; // baseline
  size: number;
  font: FontChoice;
  color: RGB;
}

export interface ReflowPlan {
  placed: PlacedWord[];
  scale: number;
  status: 'ok' | 'overflow-shrunk' | 'overflow-flagged';
  usedFallback: boolean;
}

export interface Measurer {
  /** Width of text at size with the original font `res`; null if not encodable. */
  measureOrig(res: string, text: string, size: number): number | null;
  /** Width with the standard fallback matched to font `forRes`; null if not encodable at all. */
  measureStd(forRes: string, text: string, size: number): number | null;
}

/** Longest common subsequence match between old and new word lists. */
function lcsMatch(oldWords: string[], newWords: string[]): (number | null)[] {
  const n = oldWords.length;
  const m = newWords.length;
  // avoid O(n*m) blowup on huge paragraphs
  if (n * m > 250_000) {
    return newWords.map((w, i) => (i < n && oldWords[i] === w ? i : null));
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oldWords[i] === newWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const match: (number | null)[] = new Array(m).fill(null);
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (oldWords[i] === newWords[j]) {
      match[j] = i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return match;
}

export interface ReflowOpts {
  /** Wrap width override in page units (e.g. let a single-line header grow toward the text-area right edge). */
  maxWidth?: number;
  /** Whole-paragraph color override (loses to colorRanges where they overlap). */
  baseColor?: RGB;
  /** Character ranges of newText with explicit colors (word granularity: any overlap colors the whole word). */
  colorRanges?: ColorRange[];
}

export function planReflow(
  para: ParaMeta,
  newText: string,
  measurer: Measurer,
  opts?: ReflowOpts,
): ReflowPlan | { error: string } {
  // split with character offsets so colorRanges can be mapped to words
  const newWords: { text: string; start: number; end: number }[] = [];
  const wordRe = /\S+/g;
  let wm: RegExpExecArray | null;
  while ((wm = wordRe.exec(newText))) newWords.push({ text: wm[0], start: wm.index, end: wm.index + wm[0].length });
  if (!newWords.length) return { error: 'Paragraph cannot be empty (delete is not supported yet).' };

  const oldWords = para.words;
  const match = lcsMatch(
    oldWords.map((w) => w.text),
    newWords.map((w) => w.text),
  );

  // assign a source font + size + color to each new word
  interface WordPlan {
    text: string;
    res: string;
    size: number;
    color: RGB;
  }
  const inherit = (j: number): { res: string; size: number; color: RGB } => {
    for (let k = j - 1; k >= 0; k--)
      if (match[k] !== null) {
        const w = oldWords[match[k]!];
        return { res: w.fontRes, size: w.size, color: w.color };
      }
    for (let k = j + 1; k < newWords.length; k++)
      if (match[k] !== null) {
        const w = oldWords[match[k]!];
        return { res: w.fontRes, size: w.size, color: w.color };
      }
    return { res: para.fontRes, size: para.fontSize, color: para.color };
  };
  const plans: WordPlan[] = newWords.map((nw, j) => {
    const mi = match[j];
    const src = mi !== null ? { res: oldWords[mi].fontRes, size: oldWords[mi].size, color: oldWords[mi].color } : inherit(j);
    let color = opts?.baseColor ?? src.color;
    const range = opts?.colorRanges?.find((r) => r.start < nw.end && r.end > nw.start);
    if (range) color = range.color;
    return { text: nw.text, res: src.res, size: src.size, color };
  });

  // resolve fonts + measure at scale 1
  let usedFallback = false;
  const resolved: { text: string; font: FontChoice; size: number; width: number; spaceW: number; color: RGB }[] = [];
  for (const p of plans) {
    let font: FontChoice = { t: 'orig', res: p.res };
    let width = measurer.measureOrig(p.res, p.text, p.size);
    if (width === null) {
      font = { t: 'std', forRes: p.res };
      width = measurer.measureStd(p.res, p.text, p.size);
      usedFallback = true;
      if (width === null) {
        const bad = [...p.text].find(
          (ch) => measurer.measureStd(p.res, ch, p.size) === null && measurer.measureOrig(p.res, ch, p.size) === null,
        );
        return { error: `Character "${bad ?? '?'}" isn't supported by this document's fonts or the built-in fallbacks.` };
      }
    }
    const spaceW =
      (font.t === 'orig' ? measurer.measureOrig(p.res, ' ', p.size) : null) ??
      measurer.measureStd(p.res, ' ', p.size) ??
      p.size * 0.25;
    resolved.push({ text: p.text, font, size: p.size, width, spaceW, color: p.color });
  }

  const maxWidth = (opts?.maxWidth ?? para.bbox.w) * 1.015 + 0.5;
  const firstIndent = para.firstLineX - para.bbox.x;

  const tryLayout = (scale: number) => {
    const lines: { words: typeof resolved; width: number }[] = [];
    let cur: typeof resolved = [];
    let curW = 0;
    let avail = maxWidth - firstIndent * (lines.length === 0 ? 1 : 0);
    for (const w of resolved) {
      const ww = w.width * scale;
      const sw = cur.length ? w.spaceW * scale : 0;
      const lineAvail = lines.length === 0 ? maxWidth - firstIndent : maxWidth;
      if (cur.length && curW + sw + ww > lineAvail) {
        lines.push({ words: cur, width: curW });
        cur = [];
        curW = 0;
      }
      curW += (cur.length ? w.spaceW * scale : 0) + ww;
      cur.push(w);
    }
    if (cur.length) lines.push({ words: cur, width: curW });
    void avail;
    return lines;
  };

  const availHeight = para.bbox.h + para.leading * 0.35;
  let scale = 1;
  let lines = tryLayout(scale);
  let status: ReflowPlan['status'] = 'ok';
  const heightAt = (s: number, n: number) => (n - 1) * para.leading * s + para.fontSize; // baseline span + first line
  if (heightAt(scale, lines.length) > availHeight) {
    for (const s of [0.97, 0.95, 0.92, 0.9]) {
      lines = tryLayout(s);
      scale = s;
      if (heightAt(s, lines.length) <= availHeight) break;
    }
    status = heightAt(scale, lines.length) <= availHeight ? 'overflow-shrunk' : 'overflow-flagged';
  }

  // place words
  const placed: PlacedWord[] = [];
  const topBaseline = para.lines[0].baselineY;
  lines.forEach((line, li) => {
    let x = para.bbox.x + (li === 0 ? firstIndent : 0);
    if (para.align === 'right') x = para.bbox.x + para.bbox.w - line.width;
    else if (para.align === 'center') x = para.bbox.x + (para.bbox.w - line.width) / 2;
    const y = topBaseline - li * para.leading * scale;
    for (const w of line.words) {
      placed.push({ text: w.text, x, y, size: w.size * scale, font: w.font, color: w.color });
      x += (w.width + w.spaceW) * scale;
    }
  });

  return { placed, scale, status, usedFallback };
}
