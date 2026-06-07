// React Native row shapes. The DB stores color/rects/answerRect as JSON text and PDFs
// as files on disk (filePath); these are the parsed, in-memory shapes repo.ts returns.
import type { DeckColorConfig, Rect } from "../types";

export type ReadMode = "scroll" | "paged";

export interface DeckRow {
  id: number;
  name: string;
  createdAt: number;
  color: DeckColorConfig;
  /** Last-read page (0-based) so the book reopens where you left off. */
  lastPage: number | null;
  /** Last reading mode ("scroll" = 縦読み / "paged" = 横読み). */
  lastMode: ReadMode | null;
}

export interface PdfRow {
  id: number;
  deckId: number;
  name: string;
  /** file:// path to the PDF in the document directory (decks/<deckId>.pdf). */
  filePath: string;
  pageCount: number;
  pageW: number;
  pageH: number;
}

export interface CardRow {
  id: number;
  deckId: number;
  pdfId: number;
  pageIndex: number;
  /** Answer sub-rects, one per line (page coordinates). */
  rects: Rect[];
  /** Tight union mask rect (page coordinates). */
  answerRect: Rect;
  text: string;
  createdAt: number;
}

export interface BookmarkRow {
  id: number;
  deckId: number;
  pageIndex: number;
  title: string;
  createdAt: number;
}
