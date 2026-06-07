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
