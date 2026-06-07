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
  /** Real (dark) text exists to the LEFT of the first answer span in this run. */
  darkBefore: boolean;
  /** Real (dark) text exists to the RIGHT of the last answer span in this run. */
  darkAfter: boolean;
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
  // A colored span ends only at a *tall, dark* mark — a real separator such as a full-width
  // "（" or a kanji that spans most of the line height. Light pixels (antialiasing at red
  // glyph edges) are ignored, and short dark marks inside an answer (中点・, 、, 。) are
  // bridged so a contiguous red phrase stays ONE mask. A very wide gap also ends the span.
  const heightThresh = (box.h || 0) * 0.45; // dark mark this tall ⇒ separator
  const minMarkPx = Math.max(6, Math.round((box.h || 0) * 0.25)); // ...with enough ink, not antialiasing
  const darkBudget = Math.max(40, (box.h || 0) * (box.h || 0) * 0.12); // dense backup
  const maxGap = Math.max(minSegW, Math.round((box.h || 0) * 1.4));
  // Track the x-extent of red vs real-dark columns, to tell whether there is text BEFORE the
  // first / AFTER the last answer in this run — used to reject bogus line-wrap merges.
  const darkColThresh = Math.max(4, Math.round((box.h || 0) * 0.2));
  let redMinX = -1;
  let redMaxX = -1;
  let darkMinX = -1;
  let darkMaxX = -1;

  let start = -1;
  let lastRed = -1;
  let segMinY = Infinity;
  let segMaxY = -Infinity;
  let gapDark = 0;
  let gapDarkMinY = Infinity;
  let gapDarkMaxY = -Infinity;
  const resetGap = () => {
    gapDark = 0;
    gapDarkMinY = Infinity;
    gapDarkMaxY = -Infinity;
  };
  const close = () => {
    if (start >= 0 && lastRed >= start && segMaxY >= segMinY) {
      const w = lastRed - start + 1;
      if (w >= minSegW) segments.push({ x: start, y: segMinY, w, h: segMaxY - segMinY + 1 });
    }
    start = -1;
    lastRed = -1;
    segMinY = Infinity;
    segMaxY = -Infinity;
    resetGap();
  };

  for (let x = x0; x < x1; x++) {
    let colRed = false;
    let colDark = 0;
    let colMinY = Infinity;
    let colMaxY = -Infinity;
    let dMinY = Infinity;
    let dMaxY = -Infinity;
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
      } else if (r + g + b < 360) {
        // dark ink (real black text); light non-red pixels (antialiasing) are ignored
        colDark++;
        if (y < dMinY) dMinY = y;
        if (y > dMaxY) dMaxY = y;
      }
    }
    if (colDark >= darkColThresh) {
      if (darkMinX < 0) darkMinX = x;
      darkMaxX = x;
    }
    if (colRed) {
      if (redMinX < 0) redMinX = x;
      redMaxX = x;
      if (start < 0) start = x;
      lastRed = x;
      resetGap();
      if (colMinY < segMinY) segMinY = colMinY;
      if (colMaxY > segMaxY) segMaxY = colMaxY;
    } else if (start >= 0) {
      gapDark += colDark;
      if (colDark > 0) {
        if (dMinY < gapDarkMinY) gapDarkMinY = dMinY;
        if (dMaxY > gapDarkMaxY) gapDarkMaxY = dMaxY;
      }
      const tallSeparator = gapDarkMaxY - gapDarkMinY >= heightThresh && gapDark >= minMarkPx;
      if (tallSeparator || gapDark > darkBudget || x - lastRed > maxGap) close();
    }
  }
  close();
  const darkBefore = redMinX >= 0 && darkMinX >= 0 && darkMinX < redMinX;
  const darkAfter = redMaxX >= 0 && darkMaxX > redMaxX;
  return { inkPx, bandPx, segments, darkBefore, darkAfter };
}
