import type { Rect } from "../types";

/** 2D affine multiply, matching pdfjs `Util.transform(m1, m2)`. */
export function multiplyTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Device-space sampling box for a text run, derived from the page viewport
 * transform and the run's text-space transform/width. Works for rotated and
 * vertical text by spanning the advance along the run's writing direction and the
 * font height along its ascent direction, then taking the axis-aligned bounds. For
 * upright text this reduces to the simple {x, baseline-fontH, width, 1.18*fontH}.
 * The box is generous; the mask rect is later re-tightened from in-band pixels.
 */
export function runBox(
  viewportTransform: number[],
  itemTransform: number[],
  itemWidth: number,
  scale: number,
): Rect {
  const tx = multiplyTransform(viewportTransform, itemTransform);
  const ox = tx[4];
  const oy = tx[5]; // baseline origin (device)
  const advLen = (itemWidth > 0 ? itemWidth : 0) * scale;

  // Unit writing direction (x-basis) and unit ascent direction (y-basis).
  const aLen = Math.hypot(tx[0], tx[1]) || 1;
  const ux = tx[0] / aLen;
  const uy = tx[1] / aLen;
  const fontH = Math.hypot(tx[2], tx[3]) || advLen || 1;
  const vx = tx[2] / fontH; // points toward ascent (up for upright text)
  const vy = tx[3] / fontH;

  const adv = advLen > 0 ? advLen : fontH;
  const asc = fontH; // above baseline
  const desc = fontH * 0.18; // below baseline

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of [0, adv]) {
    for (const s of [asc, -desc]) {
      const px = ox + ux * t + vx * s;
      const py = oy + uy * t + vy * s;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
