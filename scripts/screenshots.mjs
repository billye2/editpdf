// Generate Chrome Web Store screenshots (1280x800) of the built extension.
// Same framing as sibling PDF Mana's screenshots.mjs: gradient background +
// benefit headline, with the live UI captured 1:1 at 1050x640 inset below.
// Run:  npm run build && node scripts/screenshots.mjs  → release/screenshots/*.png
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, '..', 'dist');
const outDir = join(here, '..', 'release', 'screenshots');
rmSync(outDir, { recursive: true, force: true }); // no stale shots
mkdirSync(outDir, { recursive: true });

const FRAME = { width: 1280, height: 800 };
const RAW = { width: 1050, height: 640 };

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
});
await ctx.newPage();
let sw = ctx.serviceWorkers()[0];
for (let i = 0; i < 40 && !sw; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  sw = ctx.serviceWorkers()[0];
}
const id = sw.url().split('/')[2];

const page = await ctx.newPage();
page.on('dialog', (d) => void d.accept()); // "open over unsaved edits?" confirms
await page.setViewportSize(RAW);
await page.goto(`chrome-extension://${id}/viewer.html`);
// Toasts would photobomb the captures — hide them for good. Same for the
// auto-open opt-in row: it's install-state noise, not part of the pitch.
await page.addStyleTag({ content: '#toast, #drop-extra { display: none !important; }' });

// ---- Helpers -----------------------------------------------------------------

// Open a bundled sample by dropping it on the window (the product's own path).
async function openSample(name) {
  await page.evaluate(async (n) => {
    const resp = await fetch('samples/' + n);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], n, { type: 'application/pdf' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, name);
  await page.waitForSelector('.page canvas');
  await page.waitForSelector('.para-box, .ocr-box');
  await page.waitForTimeout(900); // let the canvas finish painting
}

// Capture the app at 1050x640, then re-shoot it inset on a 1280x800 branded
// frame. Runs inside the extension page so the bundled Baloo 2/Nunito fonts
// are available to the caption.
async function shoot(file, headline, sub) {
  const raw = await page.screenshot();
  await page.setViewportSize(FRAME);
  await page.evaluate(
    ([b64, h, s]) => {
      const frame = document.createElement('div');
      frame.id = 'shot-frame';
      frame.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;' +
        'flex-direction:column;align-items:center;text-align:center;' +
        'background:linear-gradient(135deg,#ff8369,#e94b43);color:#fff;';
      const head = document.createElement('div');
      head.style.cssText =
        "font:700 44px/1.2 'Baloo 2', Nunito, 'Helvetica Neue', sans-serif;" + 'margin-top:24px;letter-spacing:0.3px;';
      head.textContent = h;
      const tag = document.createElement('div');
      tag.style.cssText = "font:600 21px/1.3 Nunito, 'Helvetica Neue', sans-serif;" + 'margin-top:7px;opacity:0.94;';
      tag.textContent = s;
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${b64}`;
      img.width = 1050;
      img.height = 640;
      img.style.cssText = 'margin-top:18px;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,0.35);';
      frame.append(head, tag, img);
      document.body.append(frame);
    },
    [raw.toString('base64'), headline, sub],
  );
  await page.waitForFunction(
    () => document.querySelector('#shot-frame img')?.complete && document.fonts.status === 'loaded',
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(outDir, file) });
  await page.evaluate(() => document.getElementById('shot-frame').remove());
  await page.setViewportSize(RAW);
}

const paraBox = (nth) => page.locator('.para-box').nth(nth);

// ---- 1: empty state ----------------------------------------------------------

await shoot(
  '01-open.png',
  'Edit the actual text of any PDF',
  'Everything runs in your browser — files never leave your device',
);

// ---- 2: click a paragraph and type -------------------------------------------

await openSample('sample.pdf');
await paraBox(3).click();
await page.waitForSelector('.edit-box');
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type(
  'Click any paragraph and simply retype it. The words reflow to fit the box — nothing else on the page shifts around.',
  { delay: 4 },
);
await page.waitForTimeout(300);
await shoot('02-retype.png', 'Click a paragraph and just type', 'The words reflow to fit — nothing else shifts');
await page.keyboard.press('Escape');

// ---- 3: abstract — sections A·B·C rearranged to C·A·B, images 1·2 → 2·1 ------
// Full-frame illustration (no app capture), same pattern as PDF Mana's
// shootMergeAbstract: drawn in-page so the bundled fonts are available.

async function shootMoveAbstract(file, headline, sub) {
  await page.setViewportSize(FRAME);
  await page.evaluate(
    ([h, s]) => {
      const SECTION = { A: '#3d8bfd', B: '#1e9b72', C: '#7b54d3' };
      const IMG = { 1: '#e3a51e', 2: '#0e8f8f' };
      // a document section: big colored letter + placeholder text lines
      const section = (letter) => {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:14px;padding:12px 14px;' +
          `border-radius:12px;background:${SECTION[letter]}18;`;
        const l = document.createElement('div');
        l.style.cssText = `font:700 38px/1 'Baloo 2', Nunito, sans-serif;color:${SECTION[letter]};width:32px;`;
        l.textContent = letter;
        const lines = document.createElement('div');
        lines.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:7px;';
        for (const w of [92, 74, 84]) {
          const line = document.createElement('div');
          line.style.cssText = `height:8px;border-radius:4px;background:#ddd5c9;width:${w}%;`;
          lines.append(line);
        }
        row.append(l, lines);
        return row;
      };
      // an image thumbnail: gradient "photo" with a numeral badge
      const imgTile = (n) => {
        const t = document.createElement('div');
        t.style.cssText =
          `flex:1;height:64px;border-radius:10px;` +
          `background:linear-gradient(135deg,${IMG[n]}55,${IMG[n]});` +
          'display:flex;align-items:center;justify-content:center;' +
          "font:700 30px/1 'Baloo 2', Nunito, sans-serif;color:#fff;";
        t.textContent = n;
        return t;
      };
      const card = (letters, imgs, label) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:15px;';
        const c = document.createElement('div');
        c.style.cssText =
          'width:390px;padding:24px;display:flex;flex-direction:column;gap:14px;' +
          'background:#fff;border-radius:20px;box-shadow:0 18px 50px rgba(0,0,0,0.3);';
        letters.forEach((x) => c.append(section(x)));
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:12px;';
        imgs.forEach((n) => row.append(imgTile(n)));
        c.append(row);
        const cap = document.createElement('div');
        cap.style.cssText = "font:700 24px/1 'Baloo 2', Nunito, sans-serif;color:#fff;opacity:0.95;";
        cap.textContent = label;
        wrap.append(c, cap);
        return wrap;
      };
      const frame = document.createElement('div');
      frame.id = 'shot-frame';
      frame.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;' +
        'flex-direction:column;align-items:center;text-align:center;' +
        'background:linear-gradient(135deg,#ff8369,#e94b43);color:#fff;';
      const head = document.createElement('div');
      head.style.cssText =
        "font:700 44px/1.2 'Baloo 2', Nunito, 'Helvetica Neue', sans-serif;" + 'margin-top:24px;letter-spacing:0.3px;';
      head.textContent = h;
      const tag = document.createElement('div');
      tag.style.cssText = "font:600 21px/1.3 Nunito, 'Helvetica Neue', sans-serif;" + 'margin-top:7px;opacity:0.94;';
      tag.textContent = s;
      const board = document.createElement('div');
      board.style.cssText = 'flex:1;display:flex;align-items:center;gap:56px;padding-bottom:26px;';
      const arrow = document.createElement('div');
      arrow.style.cssText = "font:700 62px/1 'Baloo 2', Nunito, sans-serif;color:#fff;";
      arrow.textContent = '➜';
      board.append(card(['A', 'B', 'C'], [1, 2], 'Before'), arrow, card(['C', 'A', 'B'], [2, 1], 'After'));
      frame.append(head, tag, board);
      document.body.append(frame);
    },
    [headline, sub],
  );
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(outDir, file) });
  await page.evaluate(() => document.getElementById('shot-frame').remove());
  await page.setViewportSize(RAW);
}

await shootMoveAbstract(
  '03-move.png',
  'Drag text and images anywhere',
  'Rearrange sections and images — exact spacing and fonts preserved',
);

// ---- 4: recolor a word --------------------------------------------------------

await paraBox(2).click();
await page.waitForSelector('.edit-box');
// select one word and pick the red preset — the real color flow
await page.locator('.edit-box').dblclick({ position: { x: 100, y: 14 } });
await page.locator('.color-swatch').nth(2).click();
await page.waitForTimeout(200);
await shoot('04-color.png', 'Recolor a word or a whole paragraph', 'Select text, pick a color — undo anything');
await page.keyboard.press('Escape');

// ---- 5: abstract — typo fixes inside a PDF page -------------------------------
// One big PDF page (folded corner) with placeholder text lines and three
// inline typo corrections: struck-through red word ➜ green fix.

async function shootTypoAbstract(file, headline, sub) {
  await page.setViewportSize(FRAME);
  await page.evaluate(
    ([h, s]) => {
      const bar = (w) => {
        const b = document.createElement('div');
        b.style.cssText = `height:9px;border-radius:5px;background:#ddd5c9;width:${w}%;`;
        return b;
      };
      const chip = (text, kind) => {
        const c = document.createElement('span');
        const styles =
          kind === 'bad'
            ? 'color:#c0392b;background:#c0392b14;text-decoration:line-through;' + 'text-decoration-thickness:2.5px;'
            : 'color:#1e9b72;background:#1e9b7214;';
        c.style.cssText =
          `${styles}font:700 21px/1 Nunito, 'Helvetica Neue', sans-serif;` + 'padding:6px 10px;border-radius:8px;';
        c.textContent = text;
        return c;
      };
      const typoRow = (bad, good) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;';
        const arrow = document.createElement('span');
        arrow.style.cssText = "font:700 22px/1 'Baloo 2', Nunito, sans-serif;color:#b9b0a2;";
        arrow.textContent = '➜';
        row.append(chip(bad, 'bad'), arrow, chip(good, 'good'), bar(24));
        return row;
      };
      const pageCard = document.createElement('div');
      pageCard.style.cssText =
        'position:relative;width:560px;padding:34px 36px;display:flex;flex-direction:column;' +
        'gap:17px;background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,0.3);' +
        'overflow:hidden;text-align:left;';
      // folded page corner
      const fold = document.createElement('div');
      fold.style.cssText =
        'position:absolute;top:0;right:0;width:0;height:0;' +
        'border-left:44px solid #dfe7f5;border-top:44px solid #2f7ce0;';
      pageCard.append(fold);
      pageCard.append(bar(56), bar(88), typoRow('teh', 'the'), bar(92), bar(78));
      pageCard.append(typoRow('recieve', 'receive'), bar(84), bar(90), typoRow('adress', 'address'), bar(62));
      const frame = document.createElement('div');
      frame.id = 'shot-frame';
      frame.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;' +
        'flex-direction:column;align-items:center;text-align:center;' +
        'background:linear-gradient(135deg,#ff8369,#e94b43);color:#fff;';
      const head = document.createElement('div');
      head.style.cssText =
        "font:700 44px/1.2 'Baloo 2', Nunito, 'Helvetica Neue', sans-serif;" + 'margin-top:24px;letter-spacing:0.3px;';
      head.textContent = h;
      const tag = document.createElement('div');
      tag.style.cssText = "font:600 21px/1.3 Nunito, 'Helvetica Neue', sans-serif;" + 'margin-top:7px;opacity:0.94;';
      tag.textContent = s;
      const board = document.createElement('div');
      board.style.cssText = 'flex:1;display:flex;align-items:center;padding-bottom:26px;';
      board.append(pageCard);
      frame.append(head, tag, board);
      document.body.append(frame);
    },
    [headline, sub],
  );
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(outDir, file) });
  await page.evaluate(() => document.getElementById('shot-frame').remove());
  await page.setViewportSize(RAW);
}

await shootTypoAbstract(
  '05-typo.png',
  'Fix PDF typos in seconds',
  'Click the word in a PDF, retype it — the layout never breaks',
);

await ctx.close();
console.log(`Wrote 5 screenshots to ${outDir}`);
