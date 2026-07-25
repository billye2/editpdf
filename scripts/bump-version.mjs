// Bumps the project version using decimal-style rollover:
//   1.5.5 → 1.5.6 → ... → 1.5.9 → 1.6.0 → ... → 1.9.9 → 2.0.0
// Updates package.json and public/manifest.json in lockstep.
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = ['package.json', 'public/manifest.json'];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

let [M, m, p] = [major, minor, patch + 1];
if (p > 9) {
  p = 0;
  m++;
}
if (m > 9) {
  m = 0;
  M++;
}
const next = `${M}.${m}.${p}`;

for (const file of FILES) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = next;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
console.log(`${pkg.version} -> ${next}`);
