// Engine worker: hosts EditableDocument off the UI thread via Comlink.

import * as Comlink from 'comlink';
import { EditableDocument } from './document';
import type { EngineAPI, EditOutcome, LoadOutcome, PageView, RGB } from '../shared/types';

let doc: EditableDocument | null = null;

const api: EngineAPI = {
  async load(bytes: Uint8Array): Promise<LoadOutcome> {
    const { doc: d, outcome } = await EditableDocument.load(bytes);
    doc = d;
    return outcome;
  },
  async getPage(index: number): Promise<PageView> {
    if (!doc) throw new Error('No document loaded');
    return doc.getPageView(index);
  },
  async editParagraph(
    pageIndex: number,
    paragraphId: string,
    newText: string,
    color?: RGB,
    colorRanges?: import('../shared/types').ColorRange[],
  ): Promise<EditOutcome> {
    if (!doc) throw new Error('No document loaded');
    return doc.editParagraph(pageIndex, paragraphId, newText, color, colorRanges);
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
