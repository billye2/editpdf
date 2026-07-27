// Full release: verify clean tree, run checks, bump version (decimal
// rollover), build, zip for the Chrome Web Store, commit, tag, push.
//
//   npm run release            # do it
//   npm run release -- --dry-run   # run checks, show what would happen
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const capture = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

// 1. refuse to sweep unrelated uncommitted work into a release commit
const dirty = capture('git status --porcelain');
if (dirty) {
  console.error('Working tree is not clean — commit or stash first:\n' + dirty);
  process.exit(1);
}

// 2. checks
run('npx tsc --noEmit');
run('npx eslint .');
run('npx prettier --check .');
run('npx vitest run');

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (dryRun) {
  console.log(`\n[dry-run] checks passed. Would bump from ${current}, build, commit, tag, push.`);
  process.exit(0);
}

// 3. bump (updates package.json + public/manifest.json)
run('node scripts/bump-version.mjs');
const next = JSON.parse(readFileSync('package.json', 'utf8')).version;

// 4. build the extension with the new manifest version
run('npx vite build');

// 5. zip dist/ for the Chrome Web Store (release/ is gitignored)
mkdirSync('release', { recursive: true });
const zipName = `release/editpdf-v${next}.zip`;
run(`cd dist && zip -qr "../${zipName}" .`);

// 6. commit, tag, push
run('git add package.json public/manifest.json');
run(`git commit -m "Release v${next}"`);
// annotated, not lightweight: `git push --follow-tags` only pushes annotated
// tags — lightweight ones silently stayed local for a dozen releases
run(`git tag -a v${next} -m "Release v${next}"`);
run('git push --follow-tags');

console.log(`\nReleased v${next} (was ${current}). Store upload: ${zipName}; load dist/ in Chrome to test.`);
