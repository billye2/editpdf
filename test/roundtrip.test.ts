import { describe, it, expect } from 'vitest';
import { parseContent, type Op, type PdfVal } from '../src/engine/content-stream/parser';
import { writeContent } from '../src/engine/content-stream/writer';

const enc = new TextEncoder();

function stripRaw(v: PdfVal): unknown {
  switch (v.k) {
    case 'num':
      return { k: 'num', v: Math.round(v.v * 1e6) / 1e6 };
    case 'str':
      return { k: 'str', bytes: [...v.bytes] };
    case 'arr':
      return { k: 'arr', items: v.items.map(stripRaw) };
    case 'dict':
      return { k: 'dict', entries: v.entries.map(([k, val]) => [k, stripRaw(val)]) };
    default:
      return v;
  }
}

function normalize(ops: Op[]): unknown[] {
  return ops.map((o) => ({ op: o.op, args: o.args.map(stripRaw), raw: o.raw ? [...o.raw] : undefined }));
}

function roundtrip(src: string | Uint8Array): void {
  const bytes = typeof src === 'string' ? enc.encode(src) : src;
  const ops1 = parseContent(bytes);
  const out = writeContent(ops1);
  const ops2 = parseContent(out);
  expect(normalize(ops2)).toEqual(normalize(ops1));
}

describe('content-stream round-trip', () => {
  it('simple text block', () => {
    roundtrip('BT /F1 12 Tf 72 700 Td (Hello World) Tj ET');
  });

  it('strings with escapes and nesting', () => {
    roundtrip('BT (Paren \\(nested\\) and (balanced) plus \\\\ backslash \\101 octal) Tj ET');
  });

  it('hex strings, odd digits', () => {
    roundtrip('BT <48656C6C6F> Tj <48656C6C6F2> Tj ET');
  });

  it('TJ array with kerning', () => {
    roundtrip('BT /F2 10.5 Tf [(He)-24 (llo) 120 (Wor) -3.5 (ld)] TJ ET');
  });

  it('graphics ops, matrices, colors', () => {
    roundtrip('q 0.9505 0 0 0.9505 18 18.36 cm 1 0 0 RG 0.2 0.4 0.6 rg 72 700 100 50 re f Q');
  });

  it('inline dicts and names with # escapes', () => {
    roundtrip('/GS0#20odd gs << /Type /ExtGState /CA 0.5 >> /Foo BDC EMC');
  });

  it('quote operators', () => {
    roundtrip('BT /F1 12 Tf 14 TL (line one) Tj (line two) \' 2 0.5 (line three) " ET');
  });

  it('inline image passthrough', () => {
    const head = enc.encode('q BI /W 2 /H 2 /CS /G /BPC 8 ID ');
    const data = new Uint8Array([0x00, 0xff, 0x45, 0x49, 0x20, 0x99]); // contains "EI " inside data mid-way? keep safe: EI preceded by non-ws
    const tail = enc.encode(' EI Q 1 0 0 1 5 5 cm');
    const bytes = new Uint8Array(head.length + data.length + tail.length);
    bytes.set(head, 0);
    bytes.set(data, head.length);
    bytes.set(tail, head.length + data.length);
    const ops = parseContent(bytes);
    const rawOp = ops.find((o) => o.op === '__RAW__');
    expect(rawOp).toBeTruthy();
    roundtrip(bytes);
  });

  it('comments are dropped but stream still parses', () => {
    const ops = parseContent(enc.encode('% a comment\nBT (x) Tj ET'));
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tj', 'ET']);
  });

  it('negative and decimal numbers preserve value', () => {
    const ops = parseContent(enc.encode('-0.00072 0.0007 -42 +3 .5 -.25 cm'));
    expect(ops[0].args.map((a) => (a.k === 'num' ? a.v : NaN))).toEqual([-0.00072, 0.0007, -42, 3, 0.5, -0.25]);
    roundtrip('-0.00072 0.0007 -42 +3 .5 -.25 cm');
  });
});
