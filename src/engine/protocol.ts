// Shared shapes for the React Native <-> WebView engine bridge.
import type { DetectedCloze } from "../types";

/** Result of detecting colored answers across a whole PDF (from detectClozesInPdf). */
export interface PdfDetectionResult {
  pageCount: number;
  pageW: number;
  pageH: number;
  clozes: DetectedCloze[];
}

/** Per-page progress streamed during detection. */
export interface DetectProgress {
  page: number;
  total: number;
  found: number;
}
