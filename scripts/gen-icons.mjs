// Rasterize src/icons/icon.svg to the extension's PNG icon sizes (into
// public/icons/, which vite copies into dist). Run: node scripts/gen-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'src/icons/icon.svg'), 'utf8');

for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(root, `public/icons/icon${size}.png`), png);
  console.log(`icon${size}.png  (${png.length} bytes)`);
}
