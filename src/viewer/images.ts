// Image placement editing: click-select with a delete affordance, and
// drag-to-move (shared machinery in drag.ts). Selection state is
// page-overlay-scoped, so the overlay builder tells us when it wipes a
// page's boxes.

import type { ImageView } from '../shared/types';
import { engine } from './engine';
import { isTypingTarget } from './ui';
import { applyEdit, type PageUI } from './state';
import { wireDragToMove } from './drag';

let selectedImg: { pageIndex: number; imageId: string; box: HTMLDivElement } | null = null;

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
  wireDragToMove(box, ui, {
    onClick: () => selectImage(pageIndex, img, box),
    onDrop: (dx, dy) => void applyEdit(() => engine.moveImage(pageIndex, img.id, dx, dy), pageIndex),
  });
}

document.addEventListener('keydown', (e) => {
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
