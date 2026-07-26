// Static DOM references and the two feedback primitives (toast, banner).
// This module owns lookups into viewer.html; everything else imports from
// here instead of calling getElementById.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const toolbar = {
  open: $<HTMLButtonElement>('btn-open'),
  recents: $<HTMLButtonElement>('btn-recents'),
  save: $<HTMLButtonElement>('btn-save'),
  undo: $<HTMLButtonElement>('btn-undo'),
  redo: $<HTMLButtonElement>('btn-redo'),
  zoomIn: $<HTMLButtonElement>('btn-zoom-in'),
  zoomOut: $<HTMLButtonElement>('btn-zoom-out'),
  fitWidth: $<HTMLButtonElement>('btn-fit-width'),
  fitPage: $<HTMLButtonElement>('btn-fit-page'),
  zoomLabel: $<HTMLSpanElement>('zoom-label'),
  debug: $<HTMLInputElement>('chk-debug'),
  fileName: $<HTMLSpanElement>('file-name'),
};

export const pagesEl = $<HTMLDivElement>('pages');
export const dropzone = $<HTMLDivElement>('dropzone');
export const statusPill = $<HTMLDivElement>('status-pill');
export const dropError = $<HTMLParagraphElement>('drop-error');

const bannerEl = $<HTMLDivElement>('banner');
const toastEl = $<HTMLDivElement>('toast');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 4000): void {
  toastEl.textContent = msg;
  toastEl.className = kind === 'info' ? '' : kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

export function banner(msg: string | null): void {
  if (msg) {
    bannerEl.textContent = msg;
    bannerEl.hidden = false;
  } else {
    bannerEl.hidden = true;
  }
}

export const isTypingTarget = (el: Element | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
