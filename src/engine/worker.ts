// Engine worker: hosts EditableDocument off the UI thread via Comlink.

import * as Comlink from 'comlink';
import { EditableDocument } from './document';
import { registerFallbackFonts } from './fonts/fallback-fonts';
import type { EngineAPI, EditOutcome, LoadOutcome, PageView, RGB } from '../shared/types';

let doc: EditableDocument | null = null;

const api: EngineAPI = {
  async registerFallbackFonts(files: Record<string, Uint8Array>): Promise<void> {
    registerFallbackFonts(files);
  },
  async load(bytes: Uint8Array): Promise<LoadOutcome> {
    // lazy: page models build on first getPage, so huge PDFs open instantly
    const { doc: d, outcome } = await EditableDocument.load(bytes, { lazy: true });
    doc = d;
    return outcome;
  },
  async getPage(index: number): Promise<PageView> {
    if (!doc) throw new Error('No document loaded');
    await doc.ensurePageReady(index);
    return doc.getPageView(index);
  },
  async editParagraph(
    pageIndex: number,
    paragraphId: string,
    newText: string,
    color?: RGB,
    colorRanges?: import('../shared/types').ColorRange[],
    offset?: { dx: number; dy: number },
  ): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.editParagraph(pageIndex, paragraphId, newText, color, colorRanges, offset);
  },
  async deleteParagraph(pageIndex: number, paragraphId: string): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.deleteParagraph(pageIndex, paragraphId);
  },
  async moveParagraph(pageIndex: number, paragraphId: string, dx: number, dy: number): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.moveParagraph(pageIndex, paragraphId, dx, dy);
  },
  async editOcrWord(
    pageIndex: number,
    runId: string,
    newText: string,
    patchColor: RGB,
    textColor?: RGB,
  ): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.editOcrWord(pageIndex, runId, newText, patchColor, textColor);
  },
  async moveImage(pageIndex: number, imageId: string, dx: number, dy: number): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.moveImage(pageIndex, imageId, dx, dy);
  },
  async deleteImage(pageIndex: number, imageId: string): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.deleteImage(pageIndex, imageId);
  },
  async undo(): Promise<Uint8Array | null> {
    if (!doc) return null;
    return doc.undo();
  },
  async redo(): Promise<Uint8Array | null> {
    if (!doc) return null;
    return doc.redo();
  },
  async canUndo(): Promise<boolean> {
    return doc?.canUndo() ?? false;
  },
  async canRedo(): Promise<boolean> {
    return doc?.canRedo() ?? false;
  },
  async save(): Promise<Uint8Array> {
    if (!doc) throw new Error('No document loaded');
    return doc.save();
  },
  async getFontBytes(pageIndex: number, fontRes: string, sample: string): Promise<Uint8Array | null> {
    if (!doc) return null;
    return doc.getEmbeddedFontBytes(pageIndex, fontRes, sample);
  },
};

Comlink.expose(api);
