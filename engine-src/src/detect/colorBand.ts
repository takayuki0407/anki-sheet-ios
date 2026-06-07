import type { DeckColorConfig } from "../types";

/** Fast RGB (0..255) -> HSL with h in [0,360), s/l in [0,1]. */
export function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

/** Smallest absolute distance between two hues, in degrees (0..180). */
export function hueDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** True if a pixel falls in the deck's "answer ink" color band. */
export function isInBand(r: number, g: number, b: number, cfg: DeckColorConfig): boolean {
  const [h, s, l] = rgb2hsl(r, g, b);
  return (
    hueDistance(h, cfg.hueTarget) <= cfg.hueTol &&
    s >= cfg.satMin &&
    l >= cfg.lightMin &&
    l <= cfg.lightMax
  );
}

/** True if a pixel is effectively white page background (ignored when sampling). */
export function isBackground(r: number, g: number, b: number): boolean {
  return r > 235 && g > 235 && b > 235;
}
