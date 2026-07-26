// Character encoding tables: WinAnsi differences from Latin-1, a practical
// subset of the Adobe Glyph List for /Differences arrays, and ToUnicode CMap
// parsing (bfchar/bfrange).

import { tokenize } from '../content-stream/lexer';

const WIN_ANSI_DIFF: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

export function winAnsiToUnicode(code: number): string {
  if (code in WIN_ANSI_DIFF) return String.fromCharCode(WIN_ANSI_DIFF[code]);
  return String.fromCharCode(code); // latin-1 elsewhere
}

// Practical AGL subset. Single letters and 'uniXXXX' handled programmatically.
const GLYPH_NAMES: Record<string, string> = {
  space: ' ',
  exclam: '!',
  quotedbl: '"',
  numbersign: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  quotesingle: "'",
  parenleft: '(',
  parenright: ')',
  asterisk: '*',
  plus: '+',
  comma: ',',
  hyphen: '-',
  period: '.',
  slash: '/',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  colon: ':',
  semicolon: ';',
  less: '<',
  equal: '=',
  greater: '>',
  question: '?',
  at: '@',
  bracketleft: '[',
  backslash: '\\',
  bracketright: ']',
  asciicircum: '^',
  underscore: '_',
  grave: '`',
  braceleft: '{',
  bar: '|',
  braceright: '}',
  asciitilde: '~',
  quoteleft: '‘',
  quoteright: '’',
  quotedblleft: '“',
  quotedblright: '”',
  quotesinglbase: '‚',
  quotedblbase: '„',
  endash: '–',
  emdash: '—',
  bullet: '•',
  ellipsis: '…',
  dagger: '†',
  daggerdbl: '‡',
  perthousand: '‰',
  guilsinglleft: '‹',
  guilsinglright: '›',
  guillemotleft: '«',
  guillemotright: '»',
  fi: 'ﬁ',
  fl: 'ﬂ',
  florin: 'ƒ',
  fraction: '⁄',
  trademark: '™',
  minus: '−',
  degree: '°',
  copyright: '©',
  registered: '®',
  section: '§',
  paragraph: '¶',
  cent: '¢',
  sterling: '£',
  yen: '¥',
  Euro: '€',
  currency: '¤',
  exclamdown: '¡',
  questiondown: '¿',
  periodcentered: '·',
  middot: '·',
  multiply: '×',
  divide: '÷',
  plusminus: '±',
  onehalf: '½',
  onequarter: '¼',
  threequarters: '¾',
  mu: 'µ',
  nbspace: ' ',
  circumflex: 'ˆ',
  tilde: '˜',
  caron: 'ˇ',
  breve: '˘',
  dotaccent: '˙',
  ring: '˚',
  ogonek: '˛',
  hungarumlaut: '˝',
  cedilla: '¸',
  dieresis: '¨',
  macron: '¯',
  acute: '´',
  brokenbar: '¦',
  logicalnot: '¬',
  ordfeminine: 'ª',
  ordmasculine: 'º',
  dotlessi: 'ı',
  Aacute: 'Á',
  Agrave: 'À',
  Acircumflex: 'Â',
  Adieresis: 'Ä',
  Atilde: 'Ã',
  Aring: 'Å',
  AE: 'Æ',
  Ccedilla: 'Ç',
  Eacute: 'É',
  Egrave: 'È',
  Ecircumflex: 'Ê',
  Edieresis: 'Ë',
  Iacute: 'Í',
  Igrave: 'Ì',
  Icircumflex: 'Î',
  Idieresis: 'Ï',
  Eth: 'Ð',
  Ntilde: 'Ñ',
  Oacute: 'Ó',
  Ograve: 'Ò',
  Ocircumflex: 'Ô',
  Odieresis: 'Ö',
  Otilde: 'Õ',
  Oslash: 'Ø',
  Uacute: 'Ú',
  Ugrave: 'Ù',
  Ucircumflex: 'Û',
  Udieresis: 'Ü',
  Yacute: 'Ý',
  Thorn: 'Þ',
  germandbls: 'ß',
  aacute: 'á',
  agrave: 'à',
  acircumflex: 'â',
  adieresis: 'ä',
  atilde: 'ã',
  aring: 'å',
  ae: 'æ',
  ccedilla: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecircumflex: 'ê',
  edieresis: 'ë',
  iacute: 'í',
  igrave: 'ì',
  icircumflex: 'î',
  idieresis: 'ï',
  eth: 'ð',
  ntilde: 'ñ',
  oacute: 'ó',
  ograve: 'ò',
  ocircumflex: 'ô',
  odieresis: 'ö',
  otilde: 'õ',
  oslash: 'ø',
  uacute: 'ú',
  ugrave: 'ù',
  ucircumflex: 'û',
  udieresis: 'ü',
  yacute: 'ý',
  thorn: 'þ',
  ydieresis: 'ÿ',
  Scaron: 'Š',
  scaron: 'š',
  Zcaron: 'Ž',
  zcaron: 'ž',
  OE: 'Œ',
  oe: 'œ',
  Ydieresis: 'Ÿ',
  Lslash: 'Ł',
  lslash: 'ł',
};

export function glyphNameToUnicode(gname: string): string {
  if (gname.length === 1) return gname;
  if (gname in GLYPH_NAMES) return GLYPH_NAMES[gname];
  const m = /^uni([0-9A-Fa-f]{4})/.exec(gname);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  const m2 = /^u([0-9A-Fa-f]{4,6})$/.exec(gname);
  if (m2) return String.fromCodePoint(parseInt(m2[1], 16));
  return '';
}

function bytesToCode(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function utf16beToString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] * 256 + b[i + 1]);
  if (b.length === 1) s += String.fromCharCode(b[0]);
  return s;
}

/** Parse a ToUnicode CMap stream into code -> unicode string. */
export function parseToUnicode(bytes: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const toks = tokenize(bytes);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'word') continue;
    if (t.v === 'beginbfchar') {
      i++;
      while (i + 1 < toks.length) {
        const a = toks[i];
        if (a.t === 'word' && a.v === 'endbfchar') break;
        const b = toks[i + 1];
        if (a.t === 'hex' && b && b.t === 'hex') {
          map.set(bytesToCode(a.v), utf16beToString(b.v));
        }
        i += 2;
      }
    } else if (t.v === 'beginbfrange') {
      i++;
      while (i < toks.length) {
        const a = toks[i];
        if (a.t === 'word' && a.v === 'endbfrange') break;
        const b = toks[i + 1];
        const c = toks[i + 2];
        if (a.t === 'hex' && b && b.t === 'hex') {
          const lo = bytesToCode(a.v);
          const hi = bytesToCode(b.v);
          if (c && c.t === 'hex') {
            const base = c.v.slice();
            for (let code = lo; code <= hi && code - lo < 65536; code++) {
              const s = utf16beToString(base);
              const last = s.charCodeAt(s.length - 1) + (code - lo);
              map.set(code, s.slice(0, -1) + String.fromCharCode(last));
            }
            i += 3;
          } else if (c && c.t === 'arrOpen') {
            i += 3;
            let code = lo;
            while (i < toks.length && toks[i].t !== 'arrClose') {
              const el = toks[i];
              if (el.t === 'hex') map.set(code++, utf16beToString(el.v));
              i++;
            }
            i++; // arrClose
          } else {
            i += 3;
          }
        } else {
          i++;
        }
      }
    }
  }
  return map;
}
