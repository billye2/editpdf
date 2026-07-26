// Serializes an Op[] back to content-stream bytes. Strings are emitted as hex
// strings (binary-safe); numbers re-emit their original text when unmodified.

import type { Op, PdfVal } from './parser';

const enc = new TextEncoder();

export function writeContent(ops: Op[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let line = '';
  const flush = () => {
    if (line) {
      chunks.push(enc.encode(line));
      line = '';
    }
  };
  for (const op of ops) {
    if (op.op === '__RAW__' && op.raw) {
      flush();
      chunks.push(op.raw);
      chunks.push(enc.encode('\n'));
      continue;
    }
    for (const a of op.args) line += serializeVal(a) + ' ';
    line += op.op + '\n';
    if (line.length > 4096) flush();
  }
  flush();
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function serializeVal(v: PdfVal): string {
  switch (v.k) {
    case 'num':
      return v.raw ?? fmtNum(v.v);
    case 'str':
      return '<' + toHex(v.bytes) + '>';
    case 'name':
      return '/' + escapeName(v.v);
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'arr':
      return '[' + v.items.map(serializeVal).join(' ') + ']';
    case 'dict':
      return '<<' + v.entries.map(([k, val]) => '/' + escapeName(k) + ' ' + serializeVal(val)).join(' ') + '>>';
  }
}

export function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function escapeName(name: string): string {
  let s = '';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) {
      s += '#' + c.toString(16).padStart(2, '0');
    } else {
      s += ch;
    }
  }
  return s;
}

// Convenience constructors used by the edit pipeline.
export const num = (v: number): PdfVal => ({ k: 'num', v, raw: fmtNum(v) });

/** Full-precision number: fmtNum's 4 decimals get amplified by transform
 *  scales (unit-space delta × CTM), drifting repeated moves by visible
 *  fractions. PDF numbers cannot use exponent notation. */
export const pnum = (v: number): PdfVal => {
  let raw = String(v);
  if (raw.includes('e') || raw.includes('E')) raw = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return { k: 'num', v, raw };
};
export const name = (v: string): PdfVal => ({ k: 'name', v });
export const str = (bytes: Uint8Array): PdfVal => ({ k: 'str', bytes });
export const mkOp = (op: string, ...args: PdfVal[]): Op => ({ op, args });
