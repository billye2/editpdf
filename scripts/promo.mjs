// Generate Chrome Web Store promo tiles (small 440x280, marquee 1400x560).
// Same framing as sibling PDF Mana's promo.mjs. Run:
//   node scripts/promo.mjs  → release/promo/*.png
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'promo');
mkdirSync(outDir, { recursive: true });

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';

// White rounded tile with the coral "E" (inverse of the app icon, for contrast
// on the coral background). `s` = tile size in px.
const mark = (x, y, s) => `
  <g transform="translate(${x},${y}) scale(${s / 128})">
    <rect width="128" height="128" rx="30" fill="#ffffff"/>
    <path d="M 88 40 L 42 40 L 42 92 L 88 92 M 42 66 L 76 66" fill="none"
          stroke="#e94b43" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/>
  </g>`;

function tile(w, h, { tileX, tileY, tileS, tx, titleY, titleSize, tagY, tagSize, subY, subSize, decor }) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ff8369"/>
        <stop offset="1" stop-color="#e94b43"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${decor}
    ${mark(tileX, tileY, tileS)}
    <text x="${tx}" y="${titleY}" font-family="${FONT}" font-weight="800" font-size="${titleSize}" fill="#ffffff">PDF Edna</text>
    <text x="${tx + 2}" y="${tagY}" font-family="${FONT}" font-weight="700" font-size="${tagSize}" fill="#ffffff" opacity="0.95">Edit Text ’n Arrange</text>
    <text x="${tx + 2}" y="${subY}" font-family="${FONT}" font-weight="600" font-size="${subSize}" fill="#ffffff" opacity="0.82">Edit PDF text — 100% on your device</text>
  </svg>`;
}

const small = tile(440, 280, {
  tileX: 34,
  tileY: 96,
  tileS: 88,
  tx: 146,
  titleY: 130,
  titleSize: 40,
  tagY: 160,
  tagSize: 17,
  subY: 188,
  subSize: 13,
  decor: `
    <circle cx="402" cy="46" r="34" fill="#ffffff" opacity="0.08"/>
    <circle cx="44" cy="250" r="20" fill="#ffffff" opacity="0.08"/>
    <rect x="362" y="212" width="40" height="40" rx="11" fill="#ffffff" opacity="0.07" transform="rotate(15 382 232)"/>`,
});

const marquee = tile(1400, 560, {
  tileX: 130,
  tileY: 180,
  tileS: 200,
  tx: 380,
  titleY: 280,
  titleSize: 104,
  tagY: 344,
  tagSize: 42,
  subY: 404,
  subSize: 28,
  decor: `
    <circle cx="1300" cy="110" r="80" fill="#ffffff" opacity="0.08"/>
    <circle cx="120" cy="470" r="44" fill="#ffffff" opacity="0.07"/>
    <rect x="1180" y="380" width="90" height="90" rx="22" fill="#ffffff" opacity="0.06" transform="rotate(15 1225 425)"/>
    <circle cx="1360" cy="430" r="26" fill="#ffffff" opacity="0.09"/>`,
});

for (const [name, svg, w] of [
  ['small-440x280', small, 440],
  ['marquee-1400x560', marquee, 1400],
]) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: w },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();
  writeFileSync(join(outDir, `${name}.png`), png);
  console.log(`${name}.png  (${png.length} bytes)`);
}
