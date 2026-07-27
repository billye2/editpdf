import { test, expect, type Page } from '@playwright/test';

// Full-stack viewer E2E: real engine worker, real pdf.js rendering, real
// bundled sample PDF (regenerate with `npm run gen:samples` if missing).

test.beforeEach(async ({ page }) => {
  await page.goto('/viewer.html');
});

async function loadSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Try a sample' }).click();
  await expect(page.locator('#file-name')).toHaveText('sample.pdf · 2 pages');
  await expect(page.locator('.page canvas').first()).toBeVisible();
}

test('empty state: brand, hero copy, disabled controls', async ({ page }) => {
  await expect(page).toHaveTitle('PDF Edna');
  await expect(page.locator('#brand')).toHaveText('PDF Edna');
  await expect(page.getByRole('heading', { name: 'Drop a PDF right here' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a file' })).toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('Nothing open yet');
  await expect(page.locator('#btn-save')).toBeDisabled();
  await expect(page.locator('#btn-fit-page')).toBeDisabled();
});

test('help button cycles tips in the toast', async ({ page }) => {
  await page.locator('#btn-help').click();
  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  const first = await toast.textContent();
  expect(first).toMatch(/^Tip:/);
  await page.locator('#btn-help').click();
  await expect(toast).not.toHaveText(first!);
});

test('thumbtack opens the previously-opened-files dialog', async ({ page }) => {
  await page.locator('#btn-recents').click();
  await expect(page.locator('.recents-panel')).toBeVisible();
  await expect(page.locator('.recents-panel h2')).toHaveText('Recent files');
  await page.keyboard.press('Escape');
  await expect(page.locator('.recents-panel')).toHaveCount(0);
});

test('loads the bundled sample into the loaded state', async ({ page }) => {
  await loadSample(page);
  await expect(page.locator('#status-pill')).toHaveClass(/loaded/);
  await expect(page.locator('#btn-save')).toBeEnabled();
  await expect(page.locator('#dropzone')).toHaveCount(0);
});

test('non-PDF drop shows an inline error in the drop zone', async ({ page }) => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['plain text'], 'notes.txt', { type: 'text/plain' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
  });
  const err = page.locator('#drop-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('notes.txt');
});

test('Fit page fits the page even when zoomed in and scrolled', async ({ page }) => {
  await loadSample(page);
  await page.locator('#btn-zoom-in').click();
  await page.locator('#btn-zoom-in').click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.locator('#btn-fit-page').click();
  // fit-page snaps the page you were reading into view — with a multi-page
  // document scrolled to the bottom that's the last page, so assert that
  // SOME page ends up fully visible below the sticky header
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const chromeH = document.getElementById('chrome')!.getBoundingClientRect().height;
        return [...document.querySelectorAll('.page')].some((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= chromeH - 1 && r.bottom <= window.innerHeight + 1;
        });
      }),
    )
    .toBe(true);
});

test('paragraph edit round-trip: edit, undo, redo', async ({ page }) => {
  await loadSample(page);
  const para = page.locator('.para-box').first();
  await expect(para).toBeVisible();
  await para.click();

  const editor = page.locator('.edit-box.edit-rich');
  await expect(editor).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Replaced by the e2e suite');
  await page.keyboard.press('ControlOrMeta+Enter');

  await expect(page.locator('#toast')).toHaveText('Edit applied.');
  await expect(page.locator('#btn-undo')).toBeEnabled();

  await page.locator('#btn-undo').click();
  await expect(page.locator('#toast')).toHaveText('Undone.');
  await expect(page.locator('#btn-redo')).toBeEnabled();

  await page.locator('#btn-redo').click();
  await expect(page.locator('#toast')).toHaveText('Redone.');
});

test('bundled fallback fonts: typing beyond WinAnsi succeeds with a substitute notice', async ({ page }) => {
  await loadSample(page);
  const para = page.locator('.para-box').first();
  await expect(para).toBeVisible();
  await para.click();
  await expect(page.locator('.edit-box.edit-rich')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  // Ł and ó are outside WinAnsi — a hard reject before the bundled fonts
  await page.keyboard.type('Łódź Fabryczna quarterly review');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#toast')).toContainText('substitute font was used');
  await expect(page.locator('#btn-undo')).toBeEnabled();
});

test('warns before replacing a document that has unsaved edits', async ({ page }) => {
  await loadSample(page);
  await page.locator('.para-box').first().click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Dirty unsaved edit');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#toast')).toHaveText('Edit applied.');

  const dropOther = () =>
    page.evaluate(async () => {
      const resp = await fetch('samples/scanned.pdf');
      const dt = new DataTransfer();
      dt.items.add(new File([await resp.arrayBuffer()], 'scanned.pdf', { type: 'application/pdf' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
    });

  // decline → the edited document stays open
  let dialogSeen = page.waitForEvent('dialog');
  await dropOther();
  let dialog = await dialogSeen;
  expect(dialog.message()).toContain('unsaved edits');
  await dialog.dismiss();
  await expect(page.locator('#file-name')).toHaveText('sample.pdf · 2 pages');

  // accept → the new document replaces it
  dialogSeen = page.waitForEvent('dialog');
  await dropOther();
  dialog = await dialogSeen;
  await dialog.accept();
  await expect(page.locator('#file-name')).toHaveText('scanned.pdf · 1 page');
});

test('Show boxes switch persists across reload', async ({ page }) => {
  const switchInput = page.locator('#chk-debug');
  await expect(switchInput).not.toBeChecked();
  await page.locator('#debug-wrap').click();
  await expect(switchInput).toBeChecked();
  await page.reload();
  await expect(page.locator('#chk-debug')).toBeChecked();
});

test('keyboard zoom shortcuts work once a document is open', async ({ page }) => {
  await loadSample(page);
  await expect(page.locator('#zoom-label')).toHaveText('125%');
  await page.keyboard.press('ControlOrMeta+=');
  await expect(page.locator('#zoom-label')).toHaveText('150%');
  await page.keyboard.press('ControlOrMeta+-');
  await expect(page.locator('#zoom-label')).toHaveText('125%');
});

test('overlapping drop warns and keeps the box floating; Esc puts it back', async ({ page }) => {
  await loadSample(page);
  const boxes = page.locator('.para-box');
  await expect(boxes.nth(4)).toBeVisible();
  const from = (await boxes.nth(3).boundingBox())!;
  const to = (await boxes.nth(4).boundingBox())!;

  await page.mouse.move(from.x + 20, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(to.x + 25, to.y + 12, { steps: 8 });
  await page.mouse.up();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('overlaps other text');
  // the box stays FLOATING at the drop spot with an anchored warning bubble
  await expect(boxes.nth(3)).toHaveClass(/floating/);
  await expect(page.locator('.overlap-warn')).toBeVisible();
  await expect(page.locator('.overlap-warn')).toContainText('press Esc');
  const parked = (await boxes.nth(3).boundingBox())!;
  expect(Math.abs(parked.y - from.y)).toBeGreaterThan(10);

  // Esc returns it to where it started
  await page.keyboard.press('Escape');
  await expect(boxes.nth(3)).not.toHaveClass(/floating/);
  const back = (await boxes.nth(3).boundingBox())!;
  expect(Math.abs(back.x - from.x)).toBeLessThan(1);
  expect(Math.abs(back.y - from.y)).toBeLessThan(1);
});

test('a floating box can be dragged on to an empty spot and applies', async ({ page }) => {
  await loadSample(page);
  const boxes = page.locator('.para-box');
  const from = (await boxes.nth(3).boundingBox())!;
  const to = (await boxes.nth(4).boundingBox())!;

  // first drop overlaps → floats
  await page.mouse.move(from.x + 20, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(to.x + 25, to.y + 12, { steps: 8 });
  await page.mouse.up();
  await expect(boxes.nth(3)).toHaveClass(/floating/);

  // continue the drag from the floating box to empty space → applies
  const parked = (await boxes.nth(3).boundingBox())!;
  await page.mouse.move(parked.x + 20, parked.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + 250, from.y + 330, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toHaveText('Edit applied.');
});

test('drag-moving a paragraph into empty space applies', async ({ page }) => {
  await loadSample(page);
  const from = (await page.locator('.para-box').nth(3).boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + 230, from.y + 320, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toHaveText('Edit applied.');
});
