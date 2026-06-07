import type { DeckColorConfig, Rect } from "../types";
import { isBackground, isInBand } from "./colorBand";

/** A rendered page's raw pixels (RGBA), at DETECT_SCALE. */
export interface PagePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface SampleResult {
  /** Non-background (ink) pixel count inside the box. */
  inkPx: number;
  /** In-band (answer color) pixel count inside the box. */
  bandPx: number;
  /** Tight bounding box (device px) of the in-band pixels, or null if none. */
  tightDeviceRect: Rect | null;
}

/**
 * Scan a device-space box and measure ink vs in-band color, returning the tight
 * bbox of the in-band pixels. The tight bbox is what we mask, so the mask hugs the
 * actual colored glyphs rather than pdf.js's (often too tall) em box.
 */
export function sampleBox(
  px: PagePixels,
  box: Rect,
  cfg: DeckColorConfig,
): SampleResult {
  const { width, height, data } = px;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w));
  const y1 = Math.min(height, Math.ceil(box.y + box.h));

  let inkPx = 0;
  let bandPx = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isBackground(r, g, b)) continue;
      inkPx++;
      if (isInBand(r, g, b, cfg)) {
        bandPx++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const tightDeviceRect =
    bandPx > 0
      ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : null;

  return { inkPx, bandPx, tightDeviceRect };
}

export interface SegmentResult {
  inkPx: number;
  bandPx: number;
  /** Tight rects (device px) of each contiguous in-band span within the box. */
  segments: Rect[];
}

/**
 * Like sampleBox, but splits the box into the contiguous horizontal spans of in-band
 * ("answer color") pixels, ending each span at a column of real black ink. This masks
 * only the colored glyphs and NOT the black text sitting between two colored phrases on
 * the same line (e.g. punctuation/particles between red answers). Empty (background)
 * columns inside a span are bridged so a single colored word stays one segment.
 */
export function sampleSegments(px: PagePixels, box: Rect, cfg: DeckColorConfig): SegmentResult {
  const { width, height, data } = px;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w));
  const y1 = Math.min(height, Math.ceil(box.y + box.h));

  let inkPx = 0;
  let bandPx = 0;
  const segments: Rect[] = [];
  const minSegW = Math.max(2, Math.round((box.h || 0) * 0.18)); // drop antialiasing slivers
  // A colored span is ended only by a *substantial* run of black ink (a real separator like
  // a full-width "（" or a kanji). A thin black mark inside an answer (中点・, 、, etc.) is
  // bridged so a contiguous red phrase stays ONE mask. A very wide gap also ends the span.
  const blackBudget = Math.max(30, (box.h || 0) * (box.h || 0) * 0.05);
  const maxGap = Math.max(minSegW, Math.round((box.h || 0) * 1.4));

  let start = -1;
  let lastRed = -1;
  let segMinY = Infinity;
  let segMaxY = -Infinity;
  let gapBlack = 0; // black pixels accumulated since the last colored column
  const close = () => {
    if (start >= 0 && lastRed >= start && segMaxY >= segMinY) {
      const w = lastRed - start + 1;
      if (w >= minSegW) segments.push({ x: start, y: segMinY, w, h: segMaxY - segMinY + 1 });
    }
    start = -1;
    lastRed = -1;
    segMinY = Infinity;
    segMaxY = -Infinity;
    gapBlack = 0;
  };

  for (let x = x0; x < x1; x++) {
    let colRed = false;
    let colBlack = 0;
    let colMinY = Infinity;
    let colMaxY = -Infinity;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isBackground(r, g, b)) continue;
      inkPx++;
      if (isInBand(r, g, b, cfg)) {
        colRed = true;
        bandPx++;
        if (y < colMinY) colMinY = y;
        if (y > colMaxY) colMaxY = y;
      } else {
        colBlack++;
      }
    }
    if (colRed) {
      if (start < 0) start = x;
      lastRed = x;
      gapBlack = 0;
      if (colMinY < segMinY) segMinY = colMinY;
      if (colMaxY > segMaxY) segMaxY = colMaxY;
    } else if (start >= 0) {
      // non-colored column: bridge thin marks, but end the span at real black separators
      gapBlack += colBlack;
      if (gapBlack > blackBudget || x - lastRed > maxGap) close();
    }
  }
  close();
  return { inkPx, bandPx, segments };
}
