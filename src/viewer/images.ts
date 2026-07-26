// Image placement editing: click-select with a delete affordance, and
// drag-to-move. Selection and drag state are page-overlay-scoped, so the
// overlay builder tells us when it wipes a page's boxes.

import type { ImageView } from '../shared/types';
import { engine } from './engine';
import { isTypingTarget } from './ui';
import { applyEdit, type PageUI } from './state';

let selectedImg: { pageIndex: number; imageId: string; box: HTMLDivElement } | null = null;
let activeImgDrag: { cancel: () => void } | null = null;

function deselectImage(): void {
  if (!selectedImg) return;
  selectedImg.box.classList.remove('selected');
  selectedImg.box.querySelector('.img-delete-btn')?.remove();
  selectedImg = null;
}

/** Called by the overlay builder before it replaces a page's boxes. */
export function dropImageSelectionForPage(pageIndex: number): void {
  if (selectedImg?.pageIndex === pageIndex) selectedImg = null;
}

function selectImage(pageIndex: number, img: ImageView, box: HTMLDivElement): void {
  deselectImage();
  box.classList.add('selected');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'img-delete-btn';
  btn.textContent = '✕';
  btn.title = 'Delete this image';
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    deselectImage();
    void applyEdit(() => engine.deleteImage(pageIndex, img.id), pageIndex);
  });
  box.append(btn);
  selectedImg = { pageIndex, imageId: img.id, box };
}

export function wireImageBox(pageIndex: number, img: ImageView, box: HTMLDivElement, ui: PageUI): void {
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      // pointer may already be gone (fast click); listeners below still work
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;

    const reset = () => {
      box.classList.remove('dragging');
      box.style.transform = '';
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      activeImgDrag = null;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!dragging && Math.hypot(dx, dy) > 3) {
        dragging = true;
        box.classList.add('dragging');
        activeImgDrag = { cancel: reset };
      }
      if (dragging) box.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const onUp = (ev: PointerEvent) => {
      const wasDragging = dragging;
      reset();
      if (!wasDragging) {
        selectImage(pageIndex, img, box);
        return;
      }
      // convert both endpoints through the viewport so page /Rotate is handled
      const r = ui.canvas.getBoundingClientRect();
      const [px0, py0] = ui.viewport.convertToPdfPoint(x0 - r.left, y0 - r.top);
      const [px1, py1] = ui.viewport.convertToPdfPoint(ev.clientX - r.left, ev.clientY - r.top);
      const dx = px1 - px0;
      const dy = py1 - py0;
      if (Math.hypot(dx, dy) < 0.01) return;
      void applyEdit(() => engine.moveImage(pageIndex, img.id, dx, dy), pageIndex);
    };

    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeImgDrag) {
    e.preventDefault();
    activeImgDrag.cancel();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImg && !isTypingTarget(document.activeElement)) {
    e.preventDefault();
    const { pageIndex, imageId } = selectedImg;
    deselectImage();
    void applyEdit(() => engine.deleteImage(pageIndex, imageId), pageIndex);
  }
});

document.addEventListener('pointerdown', (e) => {
  if (selectedImg && !(e.target instanceof Element && e.target.closest('.img-box'))) deselectImage();
});
