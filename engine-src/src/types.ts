// Shared types for Anki-sheet.
//
// Coordinate convention: every rect is in "page coordinates" = PDF points with a
// TOP-LEFT origin and y growing downward (i.e. pdf.js viewport coordinates at
// scale 1). pageW/pageH are the page size in those same units. To draw at a given
// render scale S, multiply a page rect by S. Detection renders at DETECT_SCALE and
// divides device pixels by that scale to get back to page coordinates.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tunable color band describing the "answer" ink a red sheet would hide. */
export interface DeckColorConfig {
  /** Target hue in degrees (0..360). Magenta default. */
  hueTarget: number;
  /** Half-width of the accepted hue band, in degrees. */
  hueTol: number;
  /** Minimum saturation (0..1) — rejects greyish body text. */
  satMin: number;
  /** Accepted lightness range (0..1) — rejects white and near-black. */
  lightMin: number;
  lightMax: number;
  /** A text run is an answer only if this fraction of its ink is in-band. */
  inkRatioFloor: number;
  /** Absolute minimum in-band pixel count (at DETECT_SCALE) to count as an answer. */
  minBandPx: number;
  /** Merge same-line answer runs whose horizontal gap is below this (in em units). */
  spanGapEm: number;
  /** Drop answers taller than this multiple of the median height (filters headings). */
  maxHeightRatio: number;
}

/** A detected answer (one or more merged colored text runs). */
export interface DetectedCloze {
  pageIndex: number; // 0-based
  /** The individual sub-rects of the merged answer, in page coordinates. */
  rects: Rect[];
  /** Union bounding box of rects, in page coordinates. */
  bbox: Rect;
  /** Recovered answer text when available (pdf.js + cMaps); may be empty. */
  text: string;
}

// ---- Dexie row types (all dates are epoch-ms numbers) ----

export interface DeckRow {
  id?: number;
  name: string;
  createdAt: number;
  color: DeckColorConfig;
  /** Last-read page (0-based) so the book reopens where you left off. */
  lastPage?: number;
  /** Last reading mode ("scroll" = 縦読み / "paged" = 横読み). Default 縦読み. */
  lastMode?: "scroll" | "paged";
}

export interface PdfRow {
  id?: number;
  deckId: number;
  name: string;
  blob: Blob;
  pageCount: number;
  pageW: number;
  pageH: number;
}

/** One detected answer (the thing hidden under the red sheet). */
export interface CardRow {
  id?: number;
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

/** A user-defined bookmark/chapter entry to jump to in the viewer (the "目次"). */
export interface BookmarkRow {
  id?: number;
  deckId: number;
  pageIndex: number;
  title: string;
  createdAt: number;
}

/** Cached cover thumbnail (page 1) per deck — regenerable, not backed up. */
export interface CoverRow {
  deckId: number;
  blob: Blob;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export const DETECT_SCALE = 2;

export const DEFAULT_MAGENTA_BAND: DeckColorConfig = {
  hueTarget: 326,
  hueTol: 30,
  satMin: 0.4,
  lightMin: 0.18,
  lightMax: 0.82,
  inkRatioFloor: 0.22,
  minBandPx: 6 * DETECT_SCALE, // scales with render resolution
  spanGapEm: 0.6,
  maxHeightRatio: 1.8,
};

/** Quick-start color presets for different books (the answer ink a red sheet hides). */
export interface ColorPreset {
  key: string;
  label: string;
  hueTarget: number;
  hueTol: number;
}

export const COLOR_PRESETS: ColorPreset[] = [
  { key: "magenta", label: "マゼンタ", hueTarget: 326, hueTol: 30 },
  { key: "red", label: "赤", hueTarget: 2, hueTol: 22 },
  { key: "orange", label: "橙", hueTarget: 28, hueTol: 18 },
  { key: "blue", label: "青", hueTarget: 215, hueTol: 28 },
];
