// PDF content-stream lexer. Tokenizes operators, numbers, names, strings,
// arrays, dicts, and passes inline images (BI...EI) through as opaque bytes.

export type Token =
  | { t: 'num'; v: number; raw: string }
  | { t: 'str'; v: Uint8Array }
  | { t: 'hex'; v: Uint8Array }
  | { t: 'name'; v: string }
  | { t: 'arrOpen' }
  | { t: 'arrClose' }
  | { t: 'dictOpen' }
  | { t: 'dictClose' }
  | { t: 'word'; v: string }
  | { t: 'inline'; raw: Uint8Array };

const isWS = (c: number) =>
  c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;

const DELIMS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));
const isDelim = (c: number) => DELIMS.has(c);
const isRegular = (c: number) => !isWS(c) && !isDelim(c);

export function tokenize(bytes: Uint8Array): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = bytes.length;

  const readLiteralString = (): Uint8Array => {
    // at '(' — consume it
    i++;
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      let c = bytes[i];
      if (c === 0x5c /* \ */) {
        i++;
        if (i >= n) break;
        const e = bytes[i];
        if (e === 0x6e) out.push(0x0a); // \n
        else if (e === 0x72) out.push(0x0d); // \r
        else if (e === 0x74) out.push(0x09); // \t
        else if (e === 0x62) out.push(0x08); // \b
        else if (e === 0x66) out.push(0x0c); // \f
        else if (e === 0x28 || e === 0x29 || e === 0x5c) out.push(e);
        else if (e >= 0x30 && e <= 0x37) {
          // octal, up to 3 digits
          let v = e - 0x30;
          let k = 1;
          while (k < 3 && i + 1 < n && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37) {
            i++;
            v = v * 8 + (bytes[i] - 0x30);
            k++;
          }
          out.push(v & 0xff);
        } else if (e === 0x0a) {
          // line continuation
        } else if (e === 0x0d) {
          if (i + 1 < n && bytes[i + 1] === 0x0a) i++;
        } else {
          out.push(e);
        }
        i++;
      } else if (c === 0x28) {
        depth++;
        out.push(c);
        i++;
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
        out.push(c);
        i++;
      } else if (c === 0x0d) {
        // CR or CRLF in a string is one LF
        out.push(0x0a);
        i++;
        if (i < n && bytes[i] === 0x0a) i++;
      } else {
        out.push(c);
        i++;
      }
    }
    return new Uint8Array(out);
  };

  const readHexString = (): Uint8Array => {
    // at '<' (already known not '<<') — consume it
    i++;
    const digits: number[] = [];
    while (i < n && bytes[i] !== 0x3e /* > */) {
      const c = bytes[i];
      if (!isWS(c)) {
        const d = hexVal(c);
        if (d >= 0) digits.push(d);
      }
      i++;
    }
    i++; // consume '>'
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
    return out;
  };

  const readName = (): string => {
    // at '/'
    i++;
    let s = '';
    while (i < n && isRegular(bytes[i])) {
      let c = bytes[i];
      if (c === 0x23 /* # */ && i + 2 < n) {
        const h1 = hexVal(bytes[i + 1]);
        const h2 = hexVal(bytes[i + 2]);
        if (h1 >= 0 && h2 >= 0) {
          c = h1 * 16 + h2;
          i += 2;
        }
      }
      s += String.fromCharCode(c);
      i++;
    }
    return s;
  };

  const readInline = (biStart: number): Uint8Array => {
    // Scan past the image dict to 'ID', skip one whitespace byte, then find
    // 'EI' bounded by whitespace. Everything is passed through verbatim.
    while (i < n) {
      // fast scan for 'ID' as a standalone word (not inside strings — inline
      // image dicts don't contain literal strings in practice)
      if (
        bytes[i] === 0x49 &&
        bytes[i + 1] === 0x44 &&
        (i === 0 || isWS(bytes[i - 1]) || isDelim(bytes[i - 1])) &&
        (i + 2 >= n || isWS(bytes[i + 2]))
      ) {
        i += 2;
        if (i < n && isWS(bytes[i])) i++;
        break;
      }
      i++;
    }
    // find EI
    while (i < n) {
      if (
        bytes[i] === 0x45 &&
        bytes[i + 1] === 0x49 &&
        isWS(bytes[i - 1]) &&
        (i + 2 >= n || isWS(bytes[i + 2]) || isDelim(bytes[i + 2]))
      ) {
        i += 2;
        break;
      }
      i++;
    }
    return bytes.slice(biStart, i);
  };

  while (i < n) {
    const c = bytes[i];
    if (isWS(c)) {
      i++;
      continue;
    }
    if (c === 0x25 /* % */) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28 /* ( */) {
      toks.push({ t: 'str', v: readLiteralString() });
      continue;
    }
    if (c === 0x3c /* < */) {
      if (bytes[i + 1] === 0x3c) {
        toks.push({ t: 'dictOpen' });
        i += 2;
      } else {
        toks.push({ t: 'hex', v: readHexString() });
      }
      continue;
    }
    if (c === 0x3e /* > */) {
      if (bytes[i + 1] === 0x3e) {
        toks.push({ t: 'dictClose' });
        i += 2;
      } else {
        i++; // stray '>' — skip
      }
      continue;
    }
    if (c === 0x5b /* [ */) {
      toks.push({ t: 'arrOpen' });
      i++;
      continue;
    }
    if (c === 0x5d /* ] */) {
      toks.push({ t: 'arrClose' });
      i++;
      continue;
    }
    if (c === 0x2f /* / */) {
      toks.push({ t: 'name', v: readName() });
      continue;
    }
    if (c === 0x7b || c === 0x7d) {
      // { } — Type4 function syntax, never in page content; skip
      i++;
      continue;
    }
    if (
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2d ||
      (c === 0x2e && i + 1 < n && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x39)
    ) {
      let s = '';
      while (i < n && isRegular(bytes[i]) && /[0-9+\-.eE]/.test(String.fromCharCode(bytes[i]))) {
        s += String.fromCharCode(bytes[i]);
        i++;
      }
      const v = parseFloat(s);
      toks.push({ t: 'num', v: Number.isFinite(v) ? v : 0, raw: s });
      continue;
    }
    // regular word (operator or keyword)
    if (isRegular(c)) {
      const start = i;
      let s = '';
      while (i < n && isRegular(bytes[i])) {
        s += String.fromCharCode(bytes[i]);
        i++;
      }
      if (s === 'BI') {
        toks.push({ t: 'inline', raw: readInline(start) });
      } else {
        toks.push({ t: 'word', v: s });
      }
      continue;
    }
    i++; // unknown byte — skip
  }
  return toks;
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}
