// Shared drag-to-move machinery for overlay boxes (images, paragraphs):
// pointer capture, a 3px threshold to disambiguate drag from click, live
// transform preview, and Escape-cancel. Drop deltas are converted through the
// viewport so page /Rotate is handled.

import type { PageUI } from './state';

let activeDrag: { cancel: () => void } | null = null;

export function wireDragToMove(
  box: HTMLElement,
  ui: PageUI,
  h: { onClick: () => void; onDrop: (dxPage: number, dyPage: number) => void },
): void {
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
      activeDrag = null;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!dragging && Math.hypot(dx, dy) > 3) {
        dragging = true;
        box.classList.add('dragging');
        activeDrag = { cancel: reset };
      }
      if (dragging) box.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const onUp = (ev: PointerEvent) => {
      const wasDragging = dragging;
      reset();
      if (!wasDragging) {
        h.onClick();
        return;
      }
      // convert both endpoints through the viewport so page /Rotate is handled
      const r = ui.canvas.getBoundingClientRect();
      const [px0, py0] = ui.viewport.convertToPdfPoint(x0 - r.left, y0 - r.top);
      const [px1, py1] = ui.viewport.convertToPdfPoint(ev.clientX - r.left, ev.clientY - r.top);
      const dx = px1 - px0;
      const dy = py1 - py0;
      if (Math.hypot(dx, dy) < 0.01) return;
      h.onDrop(dx, dy);
    };

    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeDrag) {
    e.preventDefault();
    activeDrag.cancel();
  }
});
