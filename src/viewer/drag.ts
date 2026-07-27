// Shared drag-to-move machinery for overlay boxes (images, paragraphs):
// pointer capture, a 3px threshold to disambiguate drag from click, live
// transform preview, and Escape-cancel. Drop deltas are converted through the
// viewport so page /Rotate is handled. A drop the validator refuses does NOT
// snap back — the box stays FLOATING at the drop spot (warn toast) so the
// user can keep dragging toward an empty area, or press Esc to put it back
// where it started.

import { toast } from './ui';
import type { PageUI } from './state';

let activeDrag: { cancel: () => void } | null = null;
let floating: { box: HTMLElement; cancel: () => void } | null = null;

export function wireDragToMove(
  box: HTMLElement,
  ui: PageUI,
  h: {
    onClick: () => void;
    onDrop: (dxPage: number, dyPage: number) => void;
    /** Return false to refuse a drop at this delta (box floats instead). */
    validate?: (dxPage: number, dyPage: number) => boolean;
  },
): void {
  // accumulated offset while the box floats between refused drops
  let baseCssX = 0;
  let baseCssY = 0;
  let basePdfX = 0;
  let basePdfY = 0;

  const putBack = () => {
    baseCssX = baseCssY = basePdfX = basePdfY = 0;
    box.classList.remove('dragging', 'floating');
    box.style.transform = '';
    if (floating?.box === box) floating = null;
  };

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (floating && floating.box !== box) floating.cancel(); // one floater at a time
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      // pointer may already be gone (fast click); listeners below still work
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;

    const stopListening = () => {
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      activeDrag = null;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!dragging && Math.hypot(dx, dy) > 3) {
        dragging = true;
        box.classList.add('dragging');
        activeDrag = {
          cancel: () => {
            stopListening();
            putBack();
          },
        };
      }
      if (dragging) box.style.transform = `translate(${baseCssX + dx}px, ${baseCssY + dy}px)`;
    };

    const onUp = (ev: PointerEvent) => {
      const wasDragging = dragging;
      stopListening();
      box.classList.remove('dragging');
      if (!wasDragging) {
        // while floating, a bare click neither commits nor opens the editor
        if (!floating || floating.box !== box) h.onClick();
        return;
      }
      // convert both endpoints through the viewport so page /Rotate is handled
      const r = ui.canvas.getBoundingClientRect();
      const [px0, py0] = ui.viewport.convertToPdfPoint(x0 - r.left, y0 - r.top);
      const [px1, py1] = ui.viewport.convertToPdfPoint(ev.clientX - r.left, ev.clientY - r.top);
      const dx = basePdfX + (px1 - px0);
      const dy = basePdfY + (py1 - py0);
      if (Math.hypot(dx, dy) < 0.01) {
        putBack();
        return;
      }
      if (h.validate && !h.validate(dx, dy)) {
        // refuse the drop but keep the box parked where it was dropped
        baseCssX += ev.clientX - x0;
        baseCssY += ev.clientY - y0;
        basePdfX = dx;
        basePdfY = dy;
        box.style.transform = `translate(${baseCssX}px, ${baseCssY}px)`;
        box.classList.add('floating');
        floating = { box, cancel: putBack };
        toast('That spot overlaps other text — drag it to an empty area, or press Esc to put it back.', 'warn', 6000);
        return;
      }
      putBack(); // the re-render draws the box at its new home
      h.onDrop(dx, dy);
    };

    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (activeDrag) {
    e.preventDefault();
    activeDrag.cancel();
    return;
  }
  if (floating) {
    e.preventDefault();
    floating.cancel();
  }
});
