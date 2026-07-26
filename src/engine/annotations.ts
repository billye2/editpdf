// FreeText annotation flattening: text "added" by Edge/Acrobat/Preview text
// tools lives in /Annots appearance streams (Form XObjects), not the page
// content stream — invisible to the content-stream engine. At load we inline
// each FreeText appearance into the page content (spec 12.5.5 BBox→Rect
// transform), merge its resources (renaming on collision), and drop the
// annotation. The text then behaves like any other paragraph: editable,
// reflowable, deletable.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFPage, PDFRawStream, PDFRef } from 'pdf-lib';
import * as pdfLib from 'pdf-lib';
import { parseContent } from './content-stream/parser';
import { writeContent, mkOp, num } from './content-stream/writer';
import { mul, IDENTITY, apply, type Mat } from './content-stream/interpreter';

function lookup(pdfDoc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? pdfDoc.context.lookup(v) : v;
}

function decodeStream(v: unknown): Uint8Array | null {
  if (!(v instanceof PDFRawStream)) return null;
  const dec = (pdfLib as unknown as { decodePDFRawStream?: (s: PDFRawStream) => { decode(): Uint8Array } })
    .decodePDFRawStream;
  return dec ? dec(v).decode() : v.getContents();
}

function numsOf(pdfDoc: PDFDocument, v: unknown, n: number): number[] | null {
  if (!(v instanceof PDFArray) || v.size() < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = lookup(pdfDoc, v.get(i)) as { asNumber?: () => number };
    if (typeof e?.asNumber !== 'function') return null;
    out.push(e.asNumber());
  }
  return out;
}

/** Ensure the page has a DIRECT /Resources dict we can safely extend. */
function directResources(pdfDoc: PDFDocument, page: PDFPage): PDFDict {
  const ctx = pdfDoc.context;
  const direct = lookup(pdfDoc, page.node.get(PDFName.of('Resources')));
  if (direct instanceof PDFDict) return direct;
  const clone = ctx.obj({});
  const node = page.node as unknown as { Resources?: () => PDFDict | undefined };
  try {
    const inherited = node.Resources?.();
    if (inherited instanceof PDFDict) for (const [k, v] of inherited.entries()) clone.set(k, v);
  } catch {
    // no inherited resources
  }
  page.node.set(PDFName.of('Resources'), clone);
  return clone;
}

/** Merge one category (/Font, /XObject, /ExtGState) of the appearance's
 *  resources into the page's, renaming on collision. Returns oldName→newName
 *  for entries that had to be renamed. */
function mergeCategory(
  pdfDoc: PDFDocument,
  pageRes: PDFDict,
  apRes: PDFDict,
  category: string,
  uniq: () => string,
): Map<string, string> {
  const renames = new Map<string, string>();
  const ctx = pdfDoc.context;
  const src = lookup(pdfDoc, apRes.get(PDFName.of(category)));
  if (!(src instanceof PDFDict)) return renames;
  let dst = lookup(pdfDoc, pageRes.get(PDFName.of(category)));
  if (!(dst instanceof PDFDict)) {
    dst = ctx.obj({});
    pageRes.set(PDFName.of(category), dst as PDFDict);
  }
  for (const [key, val] of src.entries()) {
    const name = key.decodeText();
    const existing = (dst as PDFDict).get(PDFName.of(name));
    if (existing === undefined) {
      (dst as PDFDict).set(PDFName.of(name), val);
    } else if (existing !== val) {
      const fresh = uniq();
      (dst as PDFDict).set(PDFName.of(fresh), val);
      renames.set(name, fresh);
    } // same ref under same name: nothing to do
  }
  return renames;
}

/** Compute the spec 12.5.5 transform: form space → page space filling /Rect. */
function appearanceMatrix(rect: number[], bbox: number[], matrix: Mat): Mat {
  const corners = [
    apply(matrix, bbox[0], bbox[1]),
    apply(matrix, bbox[2], bbox[1]),
    apply(matrix, bbox[2], bbox[3]),
    apply(matrix, bbox[0], bbox[3]),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const tbx = Math.min(...xs);
  const tby = Math.min(...ys);
  const tbw = Math.max(...xs) - tbx;
  const tbh = Math.max(...ys) - tby;
  const rx = Math.min(rect[0], rect[2]);
  const ry = Math.min(rect[1], rect[3]);
  const rw = Math.abs(rect[2] - rect[0]);
  const rh = Math.abs(rect[3] - rect[1]);
  const sx = tbw > 1e-6 ? rw / tbw : 1;
  const sy = tbh > 1e-6 ? rh / tbh : 1;
  const A: Mat = [sx, 0, 0, sy, rx - tbx * sx, ry - tby * sy];
  return mul(matrix, A); // apply Matrix, then A (row-vector convention)
}

/** Flatten this page's FreeText annotations into its content stream.
 *  Returns how many were flattened. Best-effort: a malformed annotation is
 *  left in place rather than risking the document. */
export function flattenFreeText(pdfDoc: PDFDocument, page: PDFPage): number {
  const ctx = pdfDoc.context;
  const annotsVal = page.node.get(PDFName.of('Annots'));
  const annots = lookup(pdfDoc, annotsVal);
  if (!(annots instanceof PDFArray)) return 0;

  let uniqCounter = 1;
  const uniq = () => `APR${uniqCounter++}`;
  const keep: PDFObject[] = [];
  let flattened = 0;
  let wrapped = false;

  // Graphics state persists ACROSS a page's content streams, and real-world
  // streams leave the CTM modified (e.g. a top-level 0.24 scale in
  // print-to-PDF output). Before appending any appearance content, sandwich
  // the ORIGINAL streams in their own q/Q so ours starts from pristine state.
  const wrapExistingContent = () => {
    if (wrapped) return;
    wrapped = true;
    const qRef = ctx.register(ctx.flateStream('q\n'));
    const QRef = ctx.register(ctx.flateStream('Q\n'));
    const contents = page.node.get(PDFName.of('Contents'));
    const resolved = contents instanceof PDFArray ? contents : lookup(pdfDoc, contents);
    if (resolved instanceof PDFArray) {
      const items: PDFObject[] = [qRef];
      for (let k = 0; k < resolved.size(); k++) items.push(resolved.get(k));
      items.push(QRef);
      page.node.set(PDFName.of('Contents'), ctx.obj(items));
    } else {
      page.node.set(PDFName.of('Contents'), ctx.obj([qRef, contents, QRef]));
    }
  };

  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    const a = lookup(pdfDoc, ref);
    const isFreeText = a instanceof PDFDict && a.get(PDFName.of('Subtype')) === PDFName.of('FreeText');
    if (!isFreeText) {
      keep.push(ref);
      continue;
    }
    try {
      const ap = lookup(pdfDoc, a.get(PDFName.of('AP')));
      const n = ap instanceof PDFDict ? lookup(pdfDoc, ap.get(PDFName.of('N'))) : null;
      const bytes = decodeStream(n);
      const rect = numsOf(pdfDoc, lookup(pdfDoc, a.get(PDFName.of('Rect'))), 4);
      if (!bytes || !rect || !(n instanceof PDFRawStream)) {
        keep.push(ref);
        continue;
      }
      const bbox = numsOf(pdfDoc, lookup(pdfDoc, n.dict.get(PDFName.of('BBox'))), 4) ?? [0, 0, 1, 1];
      const matrixNums = numsOf(pdfDoc, lookup(pdfDoc, n.dict.get(PDFName.of('Matrix'))), 6);
      const matrix: Mat = matrixNums ? (matrixNums as Mat) : IDENTITY;
      const cm = appearanceMatrix(rect, bbox, matrix);

      // merge appearance resources into the page, renaming collisions
      const pageRes = directResources(pdfDoc, page);
      const apRes = lookup(pdfDoc, n.dict.get(PDFName.of('Resources')));
      const renames = new Map<string, { category: string; to: string }>();
      if (apRes instanceof PDFDict) {
        for (const category of ['Font', 'XObject', 'ExtGState']) {
          for (const [from, to] of mergeCategory(pdfDoc, pageRes, apRes, category, uniq)) {
            renames.set(`${category}:${from}`, { category, to });
          }
        }
      }

      // rewrite renamed resource references inside the appearance ops
      const ops = parseContent(bytes);
      if (renames.size) {
        const opCategory: Record<string, string> = { Tf: 'Font', Do: 'XObject', gs: 'ExtGState' };
        for (const op of ops) {
          const cat = opCategory[op.op];
          if (!cat || op.args[0]?.k !== 'name') continue;
          const r = renames.get(`${cat}:${op.args[0].v}`);
          if (r) op.args[0] = { k: 'name', v: r.to };
        }
      }

      // q <cm> cm <BBox clip> ...appearance ops... Q
      const wrappedOps: ReturnType<typeof mkOp>[] = [
        mkOp('q'),
        mkOp('cm', num(cm[0]), num(cm[1]), num(cm[2]), num(cm[3]), num(cm[4]), num(cm[5])),
        mkOp('re', num(bbox[0]), num(bbox[1]), num(bbox[2] - bbox[0]), num(bbox[3] - bbox[1])),
        mkOp('W'),
        mkOp('n'),
        ...ops,
        mkOp('Q'),
      ];
      wrapExistingContent();
      const streamBytes = writeContent(wrappedOps);
      const stream = ctx.flateStream(streamBytes);
      const streamRef = ctx.register(stream);

      // append to the page's Contents (now guaranteed to be an array)
      const contents = page.node.get(PDFName.of('Contents'));
      const resolved = contents instanceof PDFArray ? contents : lookup(pdfDoc, contents);
      if (resolved instanceof PDFArray) resolved.push(streamRef);
      else page.node.set(PDFName.of('Contents'), ctx.obj([contents, streamRef]));

      flattened++; // annotation intentionally not kept
    } catch {
      keep.push(ref); // malformed: leave it alone
    }
  }

  if (flattened) {
    const arr = ctx.obj(keep);
    page.node.set(PDFName.of('Annots'), arr);
  }
  return flattened;
}
