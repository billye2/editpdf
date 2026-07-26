// Lazy page-model building (the viewer's load mode): models build on first
// access; edits on never-viewed pages self-ensure.

import { describe, it, expect } from 'vitest';
import { EditableDocument } from '../src/engine/document';
import { makeParagraphPdf, makeImagePdf } from './helpers';

describe('lazy page models', () => {
  it('getPageView throws before ensurePageReady, works after', async () => {
    const bytes = await makeParagraphPdf();
    const { doc, outcome } = await EditableDocument.load(bytes, { lazy: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.pageCount).toBe(1);
    expect(() => doc!.getPageView(0)).toThrow(/not built/);
    await doc!.ensurePageReady(0);
    expect(doc!.getPageView(0).paragraphs.length).toBeGreaterThan(0);
  });

  it('ensurePageReady is idempotent and race-safe', async () => {
    const bytes = await makeParagraphPdf();
    const { doc } = await EditableDocument.load(bytes, { lazy: true });
    await Promise.all([doc!.ensurePageReady(0), doc!.ensurePageReady(0), doc!.ensurePageReady(0)]);
    expect(doc!.getPageView(0).paragraphs.length).toBeGreaterThan(0);
  });

  it('image edits self-ensure the page model', async () => {
    const bytes = await makeImagePdf([{ x: 100, y: 500, w: 200, h: 150 }]);
    const { doc } = await EditableDocument.load(bytes, { lazy: true });
    await doc!.ensurePageReady(0);
    const img = doc!.getPageView(0).images[0];

    // fresh lazy doc: edit without ever calling ensurePageReady/getPageView
    const { doc: doc2 } = await EditableDocument.load(bytes, { lazy: true });
    const result = await doc2!.deleteImage(0, img.id);
    expect(result.status).toBe('ok');
    const { doc: doc3 } = await EditableDocument.load(result.bytes!);
    expect(doc3!.getPageView(0).images).toHaveLength(0);
  });
});
