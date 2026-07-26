// Executes a content stream's graphics/text state machine to produce
// positioned text runs (page/user space, y-up). This is the single source of
// truth for text geometry in the engine.

import type { Op, PdfVal } from './parser';
import type { FontInfo } from '../fonts/font-info';

export type Mat = [number, number, number, number, number, number]; // a b c d e f

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m1: Mat, m2: Mat): Mat {
  // row-vector convention: p' = p × m1 × m2
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

const translate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];

export type RGB = [number, number, number];

export type ShowKind = 'Tj' | 'TJ' | 'quote' | 'dblquote';

export interface RawGlyph {
  code: number;
  u: string;
  x: number; // page-space x of glyph origin
  w: number; // page-space advance width
}

export interface RawRun {
  id: string;
  opIndex: number;
  tjIndex: number; // element index within a TJ array; 0 for Tj/quote forms
  opKind: ShowKind;
  fontRes: string;
  sizeEff: number; // effective on-page font size
  renderMode: number;
  color: RGB;
  rotated: boolean;
  baseline: { x: number; y: number };
  endX: number;
  ascent: number; // page units above baseline
  descent: number; // page units below baseline (negative)
  text: string;
  glyphs: RawGlyph[];
}

/** An XObject paint (`/Name Do`) with the CTM in effect at that op. The
 *  interpreter records every top-level Do (image and form alike); filtering by
 *  resource subtype is the caller's job. */
export interface DoPlacement {
  opIndex: number;
  name: string;
  ctm: Mat;
}

/** Matrix snapshot at a show op (Tj/TJ/'/"), keyed by op index. Recorded for
 *  every show op — even empty strings and numbers-only TJs — because the
 *  translate-only move path needs to pin ANY op whose position depends on a
 *  tm chain it disturbed. Matrices are never mutated in place by the
 *  interpreter (always reassigned), so storing references is safe. */
export interface ShowOpGeom {
  tmAtShow: Mat; // tm when the first glyph would paint (post-leading for '/")
  tlmAfter: Mat; // tlm after the op completes (shows never advance tlm)
  ctm: Mat; // CTM in effect at the op
}

export interface InterpretResult {
  runs: RawRun[];
  doPlacements: DoPlacement[];
  showOps: Map<number, ShowOpGeom>;
}

const numArg = (v: PdfVal | undefined, d = 0): number => (v && v.k === 'num' ? v.v : d);

export function interpret(ops: Op[], fonts: Map<string, FontInfo>): InterpretResult {
  const runs: RawRun[] = [];
  const doPlacements: DoPlacement[] = [];
  const showOps = new Map<number, ShowOpGeom>();
  let inTextObject = false;

  let ctm: Mat = IDENTITY;
  let fillColor: RGB = [0, 0, 0];

  // text state (part of the saved graphics state, per the PDF spec)
  let tm: Mat = IDENTITY;
  let tlm: Mat = IDENTITY;
  let fontRes = '';
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let leading = 0;
  let rise = 0;
  let renderMode = 0;

  interface GState {
    ctm: Mat;
    fillColor: RGB;
    fontRes: string;
    fontSize: number;
    charSpacing: number;
    wordSpacing: number;
    hScale: number;
    leading: number;
    rise: number;
    renderMode: number;
  }
  const gsStack: GState[] = [];

  let runCounter = 0;

  const showString = (bytes: Uint8Array, opIndex: number, tjIndex: number, opKind: ShowKind) => {
    const font = fonts.get(fontRes);
    const trmStart = mul(mul([fontSize * hScale, 0, 0, fontSize, 0, rise], tm), ctm);
    const rotated = Math.abs(trmStart[1]) > 1e-4 || Math.abs(trmStart[2]) > 1e-4 || trmStart[0] <= 0 || trmStart[3] <= 0;
    const sizeEff = Math.hypot(trmStart[2], trmStart[3]);

    const glyphs: RawGlyph[] = [];
    let text = '';
    const decoded = font ? font.decode(bytes) : Array.from(bytes, (code) => ({ code, u: String.fromCharCode(code) }));

    for (const g of decoded) {
      const w1000 = font ? font.widthOf(g.code) : 500;
      const isSpace = !font?.twoByte && g.code === 32;
      const advText = ((w1000 / 1000) * fontSize + charSpacing + (isSpace ? wordSpacing : 0)) * hScale;
      const trm = mul(mul([fontSize * hScale, 0, 0, fontSize, 0, rise], tm), ctm);
      const [gx] = apply(trm, 0, 0);
      const wPage = Math.abs(advText * ctm[0] + 0 * ctm[2]); // horizontal advance in page space
      glyphs.push({ code: g.code, u: g.u, x: gx, w: wPage });
      text += g.u;
      tm = mul(translate(advText, 0), tm);
    }

    if (!text.length) return;
    const [bx, by] = apply(trmStart, 0, 0);
    const trmEnd = mul(mul([fontSize * hScale, 0, 0, fontSize, 0, rise], tm), ctm);
    const [ex] = apply(trmEnd, 0, 0);
    const asc = (font?.ascent ?? 0.75) * sizeEff;
    const desc = (font?.descent ?? -0.25) * sizeEff;

    runs.push({
      id: `r${opIndex}-${tjIndex}-${runCounter++}`,
      opIndex,
      tjIndex,
      opKind,
      fontRes,
      sizeEff,
      renderMode,
      color: fillColor,
      rotated,
      baseline: { x: bx, y: by },
      endX: ex,
      ascent: asc,
      descent: desc,
      text,
      glyphs,
    });
  };

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const { op, args } = ops[opIndex];
    switch (op) {
      case 'q':
        gsStack.push({ ctm, fillColor, fontRes, fontSize, charSpacing, wordSpacing, hScale, leading, rise, renderMode });
        break;
      case 'Q': {
        const s = gsStack.pop();
        if (s) {
          ({ ctm, fillColor, fontRes, fontSize, charSpacing, wordSpacing, hScale, leading, rise, renderMode } = s);
        }
        break;
      }
      case 'cm':
        ctm = mul(
          [numArg(args[0], 1), numArg(args[1]), numArg(args[2]), numArg(args[3], 1), numArg(args[4]), numArg(args[5])],
          ctm,
        );
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        inTextObject = true;
        break;
      case 'ET':
        inTextObject = false;
        break;
      case 'Tf':
        fontRes = args[0]?.k === 'name' ? args[0].v : fontRes;
        fontSize = numArg(args[1], fontSize);
        break;
      case 'Td': {
        tlm = mul(translate(numArg(args[0]), numArg(args[1])), tlm);
        tm = tlm;
        break;
      }
      case 'TD': {
        leading = -numArg(args[1]);
        tlm = mul(translate(numArg(args[0]), numArg(args[1])), tlm);
        tm = tlm;
        break;
      }
      case 'Tm': {
        tlm = [numArg(args[0], 1), numArg(args[1]), numArg(args[2]), numArg(args[3], 1), numArg(args[4]), numArg(args[5])];
        tm = tlm;
        break;
      }
      case 'T*':
        tlm = mul(translate(0, -leading), tlm);
        tm = tlm;
        break;
      case 'TL':
        leading = numArg(args[0]);
        break;
      case 'Tc':
        charSpacing = numArg(args[0]);
        break;
      case 'Tw':
        wordSpacing = numArg(args[0]);
        break;
      case 'Tz':
        hScale = numArg(args[0], 100) / 100;
        break;
      case 'Ts':
        rise = numArg(args[0]);
        break;
      case 'Tr':
        renderMode = numArg(args[0]);
        break;
      case 'Tj':
        showOps.set(opIndex, { tmAtShow: tm, tlmAfter: tlm, ctm });
        if (args[0]?.k === 'str') showString(args[0].bytes, opIndex, 0, 'Tj');
        break;
      case "'":
        tlm = mul(translate(0, -leading), tlm);
        tm = tlm;
        showOps.set(opIndex, { tmAtShow: tm, tlmAfter: tlm, ctm });
        if (args[0]?.k === 'str') showString(args[0].bytes, opIndex, 0, 'quote');
        break;
      case '"':
        wordSpacing = numArg(args[0]);
        charSpacing = numArg(args[1]);
        tlm = mul(translate(0, -leading), tlm);
        tm = tlm;
        showOps.set(opIndex, { tmAtShow: tm, tlmAfter: tlm, ctm });
        if (args[2]?.k === 'str') showString(args[2].bytes, opIndex, 0, 'dblquote');
        break;
      case 'TJ': {
        showOps.set(opIndex, { tmAtShow: tm, tlmAfter: tlm, ctm });
        const arr = args[0];
        if (arr?.k === 'arr') {
          for (let e = 0; e < arr.items.length; e++) {
            const el = arr.items[e];
            if (el.k === 'str') {
              showString(el.bytes, opIndex, e, 'TJ');
            } else if (el.k === 'num') {
              const adv = (-el.v / 1000) * fontSize * hScale;
              tm = mul(translate(adv, 0), tm);
            }
          }
        }
        break;
      }
      case 'g':
        fillColor = [numArg(args[0]), numArg(args[0]), numArg(args[0])];
        break;
      case 'rg':
        fillColor = [numArg(args[0]), numArg(args[1]), numArg(args[2])];
        break;
      case 'k': {
        const [c, m, y, kk] = [numArg(args[0]), numArg(args[1]), numArg(args[2]), numArg(args[3])];
        fillColor = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)];
        break;
      }
      case 'sc':
      case 'scn': {
        const nums = args.filter((a) => a.k === 'num') as { k: 'num'; v: number }[];
        if (nums.length === 1) fillColor = [nums[0].v, nums[0].v, nums[0].v];
        else if (nums.length === 3) fillColor = [nums[0].v, nums[1].v, nums[2].v];
        else if (nums.length === 4) {
          const [c, m, y, kk] = nums.map((x) => x.v);
          fillColor = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)];
        }
        break;
      }
      case 'Do':
        // Do inside BT…ET is spec-invalid; skip so we never wrap it in q/Q.
        if (!inTextObject && args[0]?.k === 'name') doPlacements.push({ opIndex, name: args[0].v, ctm });
        break;
      default:
        break; // paths, inline images, shading — irrelevant to the model
    }
  }
  return { runs, doPlacements, showOps };
}
