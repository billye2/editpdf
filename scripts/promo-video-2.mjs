// Records promo video #2: a five-scene text-editing tour of the sample PDF —
// edit two paragraphs, recolor the title, drag it to center, then delete two
// paragraphs and undo both. Same rig as promo-video.mjs (real viewer, fake
// cursor, captions, title/end cards).
//
// Usage: node scripts/promo-video-2.mjs   (starts its own vite dev server)
// Output: release/promo/pdf-edna-promo-2.webm (+ .mp4 when system ffmpeg exists)

import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 4375;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = 'release/promo';
const W = 1280;
const H = 800;

async function startServer() {
  const proc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/viewer.html`);
      if (r.ok) return proc;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('dev server did not start');
}

const OVERLAY_INIT = () => {
  const cur = document.createElement('div');
  cur.id = 'promo-cursor';
  cur.style.cssText = `position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;
    background:rgba(46,42,38,.28);border:2.5px solid #2E2A26;pointer-events:none;
    transform:translate(-50%,-50%);left:-40px;top:-40px;transition:none`;
  document.body.append(cur);
  document.addEventListener('mousemove', (e) => {
    cur.style.left = `${e.clientX}px`;
    cur.style.top = `${e.clientY}px`;
  });
  document.addEventListener(
    'mousedown',
    () => {
      cur.animate(
        [
          { transform: 'translate(-50%,-50%) scale(1)' },
          { transform: 'translate(-50%,-50%) scale(.6)' },
          { transform: 'translate(-50%,-50%) scale(1)' },
        ],
        { duration: 260, easing: 'ease-out' },
      );
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;z-index:99998;width:22px;height:22px;border-radius:50%;
        border:3px solid #3D8BFD;pointer-events:none;transform:translate(-50%,-50%);
        left:${cur.style.left};top:${cur.style.top}`;
      document.body.append(r);
      r.animate(
        [
          { opacity: 0.9, scale: 1 },
          { opacity: 0, scale: 2.6 },
        ],
        { duration: 450, easing: 'ease-out' },
      ).onfinish = () => r.remove();
    },
    true,
  );

  const cap = document.createElement('div');
  cap.id = 'promo-caption';
  cap.style.cssText = `position:fixed;z-index:99997;top:150px;left:50%;transform:translateX(-50%);
    max-width:70vw;padding:12px 26px;border-radius:999px;background:#2E2A26;color:#FDF8EC;
    font:800 21px Nunito,sans-serif;opacity:0;transition:opacity .4s ease;text-align:center;
    box-shadow:0 8px 24px rgba(46,42,38,.35);white-space:nowrap`;
  document.body.append(cap);

  window.__promo = {
    caption(text) {
      if (!text) {
        cap.style.opacity = '0';
        return;
      }
      cap.textContent = text;
      cap.style.opacity = '1';
    },
    card(title, sub, lines = [], hold = true) {
      let el = document.getElementById('promo-card');
      if (!title) {
        el?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: 'ease' }).finished.then(() => el.remove());
        return;
      }
      el = document.createElement('div');
      el.id = 'promo-card';
      el.style.cssText = `position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:14px;background:#FDF8EC;
        background-image:radial-gradient(rgba(46,42,38,.055) 1.4px,transparent 1.4px);
        background-size:22px 22px;opacity:0`;
      el.innerHTML =
        `<div style="font:800 64px 'Baloo 2',sans-serif;color:#2E2A26">${title}</div>` +
        (sub ? `<div style="font:800 24px Nunito,sans-serif;color:#3D8BFD;letter-spacing:.5px">${sub}</div>` : '') +
        lines.map((l) => `<div style="font:600 17px Nunito,sans-serif;color:rgba(46,42,38,.6)">${l}</div>`).join('');
      document.body.append(el);
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: hold ? 500 : 400, easing: 'ease', fill: 'forwards' });
    },
  };
};

async function glide(page, x, y, ms = 700) {
  await page.mouse.move(x, y, { steps: Math.max(12, Math.floor(ms / 16)) });
}

const sleep = (page, ms) => page.waitForTimeout(ms);

/** Para boxes classified by shape: tall multi-line bodies vs the big single-
 *  line title (the 22pt heading is the only ~28-45px-tall wide box). */
async function findBoxes(page) {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.para-box')]
      .map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      })
      .sort((a, b) => a.y - b.y);
    const bodies = boxes.filter((b) => b.h > 45);
    const header = boxes.find((b) => b.h > 26 && b.h < 50 && b.w > 250);
    return { bodies, header };
  });
}

async function clickPara(page, pt) {
  await glide(page, pt.cx, pt.cy, 800);
  await sleep(page, 350);
  await page.mouse.click(pt.cx, pt.cy);
  await page.locator('.edit-box.edit-rich').waitFor({ state: 'visible' });
  await sleep(page, 500);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // crashed runs leave hashed page@….webm recordings behind — clear them so
  // the rename below can't grab a stale one
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.webm') && !f.startsWith('pdf-edna')) rmSync(path.join(OUT_DIR, f));
  }
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  const caption = (t) => page.evaluate((text) => window.__promo.caption(text), t);
  const waitApplied = async () => {
    await page.locator('#toast').waitFor({ state: 'visible' });
    await sleep(page, 1400);
  };

  try {
    // Title card over the freshly opened sample
    await page.goto(`${BASE}/viewer.html?file=/samples/sample.pdf`);
    await page.evaluate(OVERLAY_INIT);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.para-box').first().waitFor({ state: 'visible' });
    await page.evaluate(() =>
      window.__promo.card('PDF Edna', 'Edit Text ’n Arrange', ['Real PDF text editing — right in your browser']),
    );
    await sleep(page, 2600);
    await page.evaluate(() => window.__promo.card(null));
    await sleep(page, 1000);

    // Scene 1 — edit the intro paragraph
    await caption('Click a paragraph — and just type');
    let { bodies } = await findBoxes(page);
    await clickPara(page, bodies[0]);
    await page.keyboard.press('ControlOrMeta+a');
    await sleep(page, 250);
    await page.keyboard.type(
      'Need to fix a PDF? Click the paragraph and simply retype it. The words wrap and reflow to fit this box, the document keeps its own fonts, and nothing else on the page shifts around while you type. It is just text — edit it.',
      { delay: 20 },
    );
    await sleep(page, 600);
    await page.keyboard.press('ControlOrMeta+Enter');
    await waitApplied();

    // Scene 2 — edit a second paragraph
    await caption('Edit as many blocks as you like');
    ({ bodies } = await findBoxes(page));
    await clickPara(page, bodies[1]);
    await page.keyboard.press('ControlOrMeta+a');
    await sleep(page, 250);
    await page.keyboard.type(
      'Numbers changed after the review? Retype them right here in place. The layout, the fonts, and the spacing all take care of themselves, and the rest of the page stays exactly where it was. No exports, no converters, no fuss.',
      { delay: 20 },
    );
    await sleep(page, 600);
    await page.keyboard.press('ControlOrMeta+Enter');
    await waitApplied();

    // Scene 3 — recolor the title
    await caption('Recolor a heading in two clicks');
    let { header } = await findBoxes(page);
    await clickPara(page, header);
    const red = page.locator('.color-swatch').nth(2);
    const rb = await red.boundingBox();
    await glide(page, rb.x + rb.width / 2, rb.y + rb.height / 2, 700);
    await sleep(page, 250);
    await red.click();
    await sleep(page, 700);
    await page.keyboard.press('ControlOrMeta+Enter');
    await waitApplied();

    // Scene 4 — drag the title to center
    await caption('Drag text anywhere — center that title');
    ({ header } = await findBoxes(page));
    const canvas = await page.evaluate(() => {
      const r = document.querySelector('.page canvas').getBoundingClientRect();
      return { x: r.x, w: r.width };
    });
    const targetCx = canvas.x + canvas.w / 2;
    await glide(page, header.cx, header.cy, 800);
    await sleep(page, 300);
    await page.mouse.down();
    await glide(page, targetCx, header.cy, 1100);
    await sleep(page, 250);
    await page.mouse.up();
    await waitApplied();

    // Scene 5 — delete two paragraphs, then undo both
    await caption('Delete whole paragraphs…');
    ({ bodies } = await findBoxes(page));
    await clickPara(page, bodies[0]);
    await page.locator('.edit-delete-btn').click();
    await waitApplied();
    ({ bodies } = await findBoxes(page));
    await clickPara(page, bodies[0]); // the next body is now the first
    await page.locator('.edit-delete-btn').click();
    await waitApplied();

    await caption('…and Undo brings them right back');
    const undo = await page.locator('#btn-undo').boundingBox();
    await glide(page, undo.x + undo.width / 2, undo.y + undo.height / 2, 800);
    await sleep(page, 300);
    await page.mouse.click(undo.x + undo.width / 2, undo.y + undo.height / 2);
    await sleep(page, 1500);
    await page.mouse.click(undo.x + undo.width / 2, undo.y + undo.height / 2);
    await sleep(page, 1800);

    // End card
    await page.evaluate(() =>
      window.__promo.card('PDF Edna', 'Edit Text ’n Arrange', [
        'Free · Private · Everything stays on your device',
        'Get it for Chrome',
      ]),
    );
    await sleep(page, 3200);
  } finally {
    await context.close(); // flushes the video
    await browser.close();
    server.kill();
  }

  // rename the fresh recording (leave earlier pdf-edna-promo*.webm alone)
  const webm = readdirSync(OUT_DIR).find((f) => f.endsWith('.webm') && !f.startsWith('pdf-edna'));
  const webmPath = path.join(OUT_DIR, 'pdf-edna-promo-2.webm');
  renameSync(path.join(OUT_DIR, webm), webmPath);
  let mp4Note;
  try {
    const mp4Path = path.join(OUT_DIR, 'pdf-edna-promo-2.mp4');
    execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4Path], {
      stdio: 'ignore',
    });
    mp4Note = ` and ${mp4Path}`;
  } catch {
    mp4Note = ' (no system ffmpeg with libx264 — webm only)';
  }
  console.log(`Wrote ${webmPath}${mp4Note}`);
}

await main();
