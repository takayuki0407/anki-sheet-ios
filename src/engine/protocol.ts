// Shared shapes for the React Native <-> WebView engine bridge.
import type { DeckColorConfig, DetectedCloze } from "../types";

/** A bookmark derived from the PDF's built-in outline (目次). */
export interface OutlineBookmark {
  title: string;
  pageIndex: number;
}

/** Result of detecting colored answers across a whole PDF (from detectClozesInPdf). */
export interface PdfDetectionResult {
  pageCount: number;
  pageW: number;
  pageH: number;
  clozes: DetectedCloze[];
  /** The PDF's built-in outline (目次) as bookmarks, if any. */
  outline: OutlineBookmark[];
  /** The answer color used — set by the engine when it auto-picked it (first import). */
  color?: DeckColorConfig;
}

/** Per-page progress streamed during detection. */
export interface DetectProgress {
  page: number;
  total: number;
  found: number;
}
