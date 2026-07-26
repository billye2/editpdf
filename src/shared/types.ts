// Serializable protocol between the viewer (DOM) and the engine (worker).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RGB = [number, number, number];

export interface ParagraphView {
  id: string;
  bbox: Rect;
  text: string;
  fontSize: number;
  leading: number;
  fontKind: 'serif' | 'sans' | 'mono';
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  color: RGB;
  lineCount: number;
  fontRes: string; // dominant font resource name (for embedded-font overlay styling)
}

export interface OcrWordView {
  runId: string;
  text: string;
  bbox: Rect;
  fontSize: number;
}

export interface RunView {
  id: string;
  text: string;
  bbox: Rect;
  renderMode: number;
  color: RGB;
}

export interface ImageView {
  /** Opaque placement id; valid only for the current PageView generation. */
  id: string;
  bbox: Rect;
  resourceName: string;
}

/** Character range (offsets into the edited text) with an explicit color. */
export interface ColorRange {
  start: number;
  end: number;
  color: RGB;
}

export interface PageView {
  index: number;
  width: number;
  height: number;
  paragraphs: ParagraphView[];
  ocrWords: OcrWordView[];
  images: ImageView[];
  runs: RunView[]; // for the debug overlay
  hasVisibleText: boolean;
  hasOcrLayer: boolean;
}

export type EditStatus = 'ok' | 'overflow-shrunk' | 'overflow-flagged' | 'error';

export interface EditOutcome {
  status: EditStatus;
  message?: string;
  usedFallback?: boolean;
  bytes?: Uint8Array; // updated whole-document bytes on success
}

export interface LoadOutcome {
  ok: boolean;
  pageCount: number;
  encrypted: boolean;
  error?: string;
}

export interface EngineAPI {
  /** Register bundled look-alike fallback font files (key → TTF bytes) —
   *  fire-and-forget at startup; editing works without it (standard-14 only). */
  registerFallbackFonts(files: Record<string, Uint8Array>): Promise<void>;
  load(bytes: Uint8Array): Promise<LoadOutcome>;
  getPage(index: number): Promise<PageView>;
  editParagraph(
    pageIndex: number,
    paragraphId: string,
    newText: string,
    color?: RGB,
    colorRanges?: ColorRange[],
  ): Promise<EditOutcome>;
  deleteParagraph(pageIndex: number, paragraphId: string): Promise<EditOutcome>;
  /** Move a paragraph by (dx, dy) in page space (y-up) — translate-only, so
   *  kerning/justification/fonts are untouched. */
  moveParagraph(pageIndex: number, paragraphId: string, dx: number, dy: number): Promise<EditOutcome>;
  editOcrWord(pageIndex: number, runId: string, newText: string, patchColor: RGB, textColor?: RGB): Promise<EditOutcome>;
  /** Move an image placement by (dx, dy) in page space (y-up). */
  moveImage(pageIndex: number, imageId: string, dx: number, dy: number): Promise<EditOutcome>;
  deleteImage(pageIndex: number, imageId: string): Promise<EditOutcome>;
  undo(): Promise<Uint8Array | null>;
  redo(): Promise<Uint8Array | null>;
  canUndo(): Promise<boolean>;
  canRedo(): Promise<boolean>;
  save(): Promise<Uint8Array>;
  /** Embedded TrueType bytes usable as a browser FontFace, or null. */
  getFontBytes(pageIndex: number, fontRes: string, sample: string): Promise<Uint8Array | null>;
}
