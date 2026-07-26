// Parses a token stream into a list of operators with operands.

import { tokenize } from './lexer';

export type PdfVal =
  | { k: 'num'; v: number; raw?: string }
  | { k: 'str'; bytes: Uint8Array }
  | { k: 'name'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'arr'; items: PdfVal[] }
  | { k: 'dict'; entries: [string, PdfVal][] };

export interface Op {
  op: string; // '__RAW__' for inline images and other verbatim passthrough
  args: PdfVal[];
  raw?: Uint8Array;
}

export function parseContent(bytes: Uint8Array): Op[] {
  const toks = tokenize(bytes);
  const ops: Op[] = [];
  let i = 0;

  const parseVal = (): PdfVal => {
    const tok = toks[i++];
    switch (tok.t) {
      case 'num':
        return { k: 'num', v: tok.v, raw: tok.raw };
      case 'str':
        return { k: 'str', bytes: tok.v };
      case 'hex':
        return { k: 'str', bytes: tok.v };
      case 'name':
        return { k: 'name', v: tok.v };
      case 'arrOpen': {
        const items: PdfVal[] = [];
        while (i < toks.length && toks[i].t !== 'arrClose') items.push(parseVal());
        i++; // arrClose
        return { k: 'arr', items };
      }
      case 'dictOpen': {
        const entries: [string, PdfVal][] = [];
        while (i < toks.length && toks[i].t !== 'dictClose') {
          const keyTok = toks[i++];
          if (keyTok.t !== 'name') continue; // malformed — skip
          entries.push([keyTok.v, parseVal()]);
        }
        i++; // dictClose
        return { k: 'dict', entries };
      }
      case 'word':
        if (tok.v === 'true') return { k: 'bool', v: true };
        if (tok.v === 'false') return { k: 'bool', v: false };
        return { k: 'null' }; // 'null' or malformed
      default:
        return { k: 'null' };
    }
  };

  let args: PdfVal[] = [];
  while (i < toks.length) {
    const tok = toks[i];
    if (tok.t === 'word' && tok.v !== 'true' && tok.v !== 'false' && tok.v !== 'null') {
      i++;
      ops.push({ op: tok.v, args });
      args = [];
    } else if (tok.t === 'inline') {
      i++;
      if (args.length) args = []; // shouldn't happen; BI has no operands
      ops.push({ op: '__RAW__', args: [], raw: tok.raw });
    } else {
      args.push(parseVal());
    }
  }
  return ops;
}
