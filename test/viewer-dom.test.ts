// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/" }
//
// Viewer DOM harness: loads the real viewer.html markup and the real main.ts
// wiring into jsdom, with pdf.js and the engine worker replaced by fakes.
// This covers the UI logic the engine suite can't reach (toolbar state,
// empty-state interactions, persistence of UI toggles). Pixel-level behavior
// (layout, fit/zoom geometry, real rendering) lives in the Playwright suite.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { fakeEngine, fakePdf } = vi.hoisted(() => {
  const makeViewport = (scale: number) => ({
    width: 612 * scale,
    height: 792 * scale,
    scale,
    convertToViewportPoint: (x: number, y: number) => [x * scale, (792 - y) * scale],
    convertToPdfPoint: (x: number, y: number) => [x / scale, 792 - y / scale],
  });
  const fakePage = {
    getViewport: ({ scale }: { scale: number }) => makeViewport(scale),
    render: () => ({ promise: Promise.resolve() }),
  };
  const fakePdf = {
    numPages: 1,
    getPage: async () => fakePage,
    destroy: () => {},
  };
  const pageView = {
    paragraphs: [
      {
        id: 'p1',
        bbox: { x: 72, y: 600, w: 400, h: 50 },
        text: 'Hello world',
        fontSize: 12,
        leading: 14,
        fontKind: 'sans',
        bold: false,
        italic: false,
        align: 'left',
        color: [0, 0, 0],
        lineCount: 2,
        fontRes: 'F1',
      },
    ],
    ocrWords: [],
    images: [],
    runs: [],
    hasVisibleText: true,
    hasOcrLayer: false,
  };
  const fakeEngine = {
    load: async () => ({ ok: true, pageCount: 1 }),
    getPage: async () => pageView,
    canUndo: async () => false,
    canRedo: async () => false,
  };
  return { fakeEngine, fakePdf };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.resolve(fakePdf) }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'stub-worker-url' }));
vi.mock('comlink', () => ({ wrap: () => fakeEngine }));

const $ = (id: string) => document.getElementById(id)!;

// vitest re-populates jsdom globals around module evaluation, which detaches
// the localStorage accessor from its backing window (its methods then fail
// their brand checks). Install a plain in-memory stub at collection time —
// before any dynamic import — so main.ts's persistence paths see a working
// storage from its very first statement.
const lsStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
    removeItem: (k: string) => void lsStore.delete(k),
    clear: () => lsStore.clear(),
  },
});

beforeAll(async () => {
  // real markup, minus the module script (we import main.ts ourselves)
  const html = readFileSync(resolve(__dirname, '../viewer.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;

  // jsdom has neither Worker nor IntersectionObserver
  class FakeWorker {
    postMessage(): void {}
    addEventListener(): void {}
    terminate(): void {}
  }
  class FakeIO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('IntersectionObserver', FakeIO);

  await import('../src/viewer/main');
});

describe('empty state', () => {
  it('starts with nothing open: muted status, Save disabled, viewer controls disabled', () => {
    expect($('file-name').textContent).toBe('Nothing open yet');
    expect($('status-pill').classList.contains('loaded')).toBe(false);
    expect(($('btn-save') as HTMLButtonElement).disabled).toBe(true);
    expect(($('btn-zoom-in') as HTMLButtonElement).disabled).toBe(true);
    expect(($('btn-fit-page') as HTMLButtonElement).disabled).toBe(true);
    expect($('dropzone').isConnected).toBe(true);
  });

  it('cycles help tips through the toast on ?', () => {
    $('btn-help').click();
    const toast = $('toast');
    expect(toast.hidden).toBe(false);
    const first = toast.textContent;
    expect(first).toMatch(/^Tip:/);
    $('btn-help').click();
    expect(toast.textContent).toMatch(/^Tip:/);
    expect(toast.textContent).not.toBe(first);
  });

  it('opens the previously-opened-files dialog from the thumbtack', async () => {
    $('btn-recents').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.recents-panel')).not.toBeNull();
    });
    expect(document.querySelector('.recents-panel')!.textContent).toContain('Recent files');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.recents-panel')).toBeNull();
  });

  it('keeps hidden elements hidden despite display classes on them', () => {
    // regression: `.pill { display:inline-flex }` would override the UA
    // `[hidden]` rule without an explicit guard
    const css = readFileSync(resolve(__dirname, '../src/viewer/viewer.css'), 'utf8');
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('persists the Show boxes switch to localStorage', () => {
    const chk = $('chk-debug') as HTMLInputElement;
    expect(chk.checked).toBe(false);
    chk.click();
    expect(localStorage.getItem('editpdf-show-boxes')).toBe('1');
    chk.click();
    expect(localStorage.getItem('editpdf-show-boxes')).toBe('0');
  });

  it('shows the drag-over treatment while a file is dragged', () => {
    const enter = new Event('dragenter', { bubbles: true });
    Object.defineProperty(enter, 'dataTransfer', { value: { types: ['Files'] } });
    document.dispatchEvent(enter);
    expect($('dropzone').classList.contains('drag-over')).toBe(true);

    document.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect($('dropzone').classList.contains('drag-over')).toBe(false);
  });

  it('rejects a non-PDF drop with an inline message, not a dialog', () => {
    const drop = new Event('drop', { cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File(['not a pdf'], 'notes.txt')] },
    });
    document.dispatchEvent(drop);
    const err = $('drop-error');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('notes.txt');
  });

  it('opens the file picker on Cmd/Ctrl+O', async () => {
    const picker = vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' }));
    (window as unknown as Record<string, unknown>).showOpenFilePicker = picker;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true }));
    await vi.waitFor(() => expect(picker).toHaveBeenCalled());
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });
});

describe('opening a document', () => {
  it('flips the UI to the loaded state', async () => {
    const drop = new Event('drop', { cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File([new Uint8Array([1, 2, 3])], 'test.pdf')] },
    });
    document.dispatchEvent(drop);

    await vi.waitFor(() => {
      expect($('file-name').textContent).toBe('test.pdf · 1 page');
    });
    expect($('status-pill').classList.contains('loaded')).toBe(true);
    expect(($('btn-save') as HTMLButtonElement).disabled).toBe(false);
    expect(($('btn-zoom-in') as HTMLButtonElement).disabled).toBe(false);
    expect(($('btn-fit-page') as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('dropzone')).toBeNull();
  });

  it('renders the first page eagerly with a clickable paragraph overlay', () => {
    expect(document.querySelectorAll('.page').length).toBe(1);
    expect(document.querySelectorAll('.para-box').length).toBe(1);
  });

  it('zoom controls update the label', () => {
    expect($('zoom-label').textContent).toBe('125%');
    $('btn-zoom-in').click();
    expect($('zoom-label').textContent).toBe('150%');
    $('btn-zoom-out').click();
    expect($('zoom-label').textContent).toBe('125%');
  });
});
