// Records the PDF Edna promo video by driving the real viewer (real engine,
// real pdf.js, bundled sample) in Chromium with Playwright's video recorder.
// A fake cursor, click ripples, captions, and title/end cards are injected
// into the page so the capture needs no post-production.
//
// Usage: node scripts/promo-video.mjs   (starts its own vite dev server)
// Output: release/promo/pdf-edna-promo.webm (+ .mp4 when Playwright's
// bundled ffmpeg is found)

import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

const PORT = 4374;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = 'release/promo';
const W = 1280;
const H = 800;

// ---------- dev server ----------

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

// ---------- in-page overlay kit ----------

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

// ---------- choreography helpers ----------

async function glide(page, x, y, ms = 700) {
  await page.mouse.move(x, y, { steps: Math.max(12, Math.floor(ms / 16)) });
}

async function centerOf(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const sleep = (page, ms) => page.waitForTimeout(ms);

// ---------- the shoot ----------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  const overlays = async () => {
    await page.evaluate(OVERLAY_INIT);
    await page.evaluate(() => document.fonts.ready);
  };
  const caption = (t) => page.evaluate((text) => window.__promo.caption(text), t);

  try {
    // Scene 0 — title card over the empty state
    await page.goto(`${BASE}/viewer.html`);
    await overlays();
    await page.evaluate(() =>
      window.__promo.card('PDF Edna', 'Edit PDF Text, Fix Typos, Move Any Text', [
        'A Chrome extension that edits the actual text of your PDFs',
      ]),
    );
    await sleep(page, 2800);
    await page.evaluate(() => window.__promo.card(null));
    await sleep(page, 1200);

    // Scene 1 — open the sample
    await caption('Drop in any PDF — or try the sample');
    const sample = page.getByRole('button', { name: 'Try a sample' });
    const s = await centerOf(sample);
    await glide(page, s.x, s.y, 900);
    await sleep(page, 350);
    await page.mouse.click(s.x, s.y);
    await page.locator('.page canvas').first().waitFor({ state: 'visible' });
    await sleep(page, 1400);

    // Scene 2 — the hero: live paragraph reflow
    await caption('Click a paragraph — and just type');
    const para = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.para-box')];
      const best = boxes
        .map((b) => ({ b, r: b.getBoundingClientRect() }))
        .sort((a, z) => z.r.width * z.r.height - a.r.width * a.r.height)[0];
      return { x: best.r.x + best.r.width / 2, y: best.r.y + best.r.height / 2 };
    });
    await glide(page, para.x, para.y, 900);
    await sleep(page, 500);
    await page.mouse.click(para.x, para.y);
    await page.locator('.edit-box.edit-rich').waitFor({ state: 'visible' });
    await sleep(page, 600);
    await page.keyboard.press('ControlOrMeta+a');
    await sleep(page, 250);
    await caption('The paragraph reflows to fit — nothing else shifts');
    await page.keyboard.type(
      'Watch this: every word here is real, editable PDF text. Type as much as you like — the paragraph reflows to fit, and nothing else on the page moves.',
      { delay: 26 },
    );
    await sleep(page, 700);
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.locator('#toast').waitFor({ state: 'visible' });
    await sleep(page, 1800);

    // Scene 3 — undo
    await caption('Undo anything — your original stays safe');
    const undo = await centerOf(page.locator('#btn-undo'));
    await glide(page, undo.x, undo.y, 800);
    await sleep(page, 300);
    await page.mouse.click(undo.x, undo.y);
    await sleep(page, 1600);

    // Scene 4 — drag an image
    await caption('Images are editable too — drag to move');
    const img = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.img-box')];
      const best = boxes
        .map((b) => ({ b, r: b.getBoundingClientRect() }))
        .sort((a, z) => z.r.width * z.r.height - a.r.width * a.r.height)[0];
      return { x: best.r.x + best.r.width / 2, y: best.r.y + best.r.height / 2 };
    });
    await glide(page, img.x, img.y, 800);
    await sleep(page, 300);
    await page.mouse.down();
    await glide(page, img.x + 70, img.y - 30, 900);
    await sleep(page, 200);
    await page.mouse.up();
    await sleep(page, 1600);

    // Scene 5 — scanned PDF patch
    await caption(null);
    await page.goto(`${BASE}/viewer.html?file=/samples/scanned.pdf`);
    await overlays();
    await page.locator('.ocr-box').first().waitFor({ state: 'visible' });
    await caption('Scanned PDF? Patch words right on the page');
    await sleep(page, 900);
    const word = await centerOf(page.locator('.ocr-box[title*="10482"]'));
    await glide(page, word.x, word.y, 900);
    await sleep(page, 350);
    await page.mouse.click(word.x, word.y);
    await page.locator('input.edit-box').waitFor({ state: 'visible' });
    await sleep(page, 400);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('10483', { delay: 110 });
    await sleep(page, 400);
    await page.keyboard.press('Enter');
    await sleep(page, 2000);

    // Scene 6 — end card
    await page.evaluate(() =>
      window.__promo.card('PDF Edna', 'Edit PDF Text, Fix Typos, Move Any Text', [
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

  // rename the recorded file, convert to mp4 with Playwright's own ffmpeg
  const webm = readdirSync(OUT_DIR).find((f) => f.endsWith('.webm'));
  const webmPath = path.join(OUT_DIR, 'pdf-edna-promo.webm');
  renameSync(path.join(OUT_DIR, webm), webmPath);
  // mp4 needs an h264 encoder — Playwright's bundled ffmpeg only has VP8, so
  // convert with the system ffmpeg when one exists, else ship the webm alone
  let mp4Note;
  try {
    const mp4Path = path.join(OUT_DIR, 'pdf-edna-promo.mp4');
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
