// Pure helpers: page-space ↔ CSS-space geometry and color conversions.
// Nothing here touches the DOM or holds state.

import type { PageViewport } from 'pdfjs-dist';
import type { ParagraphView, RGB, Rect } from '../shared/types';

/** Viewer-side mirror of the engine's overlap guard (`overlapsOtherText` in
 *  document.ts): would placing `self` at (dx, dy) intersect — or come within
 *  the paragraph detector's merge window of (vertical margin 1.9 × font
 *  size) — another paragraph? Lets the drag UI refuse a drop instantly; the
 *  engine check remains the backstop. */
export function moveWouldOverlap(paragraphs: ParagraphView[], self: ParagraphView, dx: number, dy: number): boolean {
  const dest = { x: self.bbox.x + dx, y: self.bbox.y + dy, w: self.bbox.w, h: self.bbox.h };
  for (const other of paragraphs) {
    if (other.id === self.id) continue;
    const margin = 1.9 * Math.max(self.fontSize, other.fontSize);
    if (dest.x + dest.w <= other.bbox.x || dest.x >= other.bbox.x + other.bbox.w) continue;
    if (dest.y + dest.h <= other.bbox.y - margin || dest.y >= other.bbox.y + other.bbox.h + margin) continue;
    return true;
  }
  return false;
}

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function rectToCss(bbox: Rect, viewport: PageViewport): CssRect {
  const [x1, y1] = viewport.convertToViewportPoint(bbox.x, bbox.y + bbox.h);
  const [x2, y2] = viewport.convertToViewportPoint(bbox.x + bbox.w, bbox.y);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function cssPx(r: CssRect): Partial<CSSStyleDeclaration> {
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}

export function rgbToHex(c: RGB): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export const sameRgb = (a: RGB, b: RGB): boolean => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

export function cssColorToRgb(s: string): RGB | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  if (s.startsWith('#')) return hexToRgb(s);
  return null;
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
