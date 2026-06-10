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

/** AI question type: ○× (true/false) or 4択 (multiple choice). The two sets on a page are
 * generated and managed independently. */
export type Qtype = "tf" | "mc4";

/** An AI-generated question, keyed by the cross-device bookId (syncs for Pro+). One page holds at
 * most 6 per type; regeneration replaces one (page × type) group. */
export interface QuestionRow {
  id: string;
  bookId: string;
  pageIndex: number;
  qtype: Qtype;
  statement: string; // tf: 記述文 / mc4: 設問文
  answer: string; // tf: '正'|'誤' / mc4: 正解の選択肢文字列
  choices: string[] | null; // mc4 only (4 entries; stored as JSON TEXT in sqlite)
  explanation: string;
  source: string;
  createdAt: number;
}

/** Local SM-2 / answer-history record for one question (機能拡張 §A-2). All plans record locally
 * (drives 間違いのみ復習); Premium also syncs these (今日の復習). Semantics in sync/srs.ts. */
export interface ReviewRow {
  questionId: string;
  bookId: string;
  ease: number;
  intervalD: number;
  reps: number;
  lapses: number;
  dueAt: number;
  lastAt: number;
  lastOk: 0 | 1;
  updatedAt: number;
}
