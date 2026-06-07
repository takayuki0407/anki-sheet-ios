import type { DetectedCloze } from "../types";

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A cloze's representative LINE height = its tallest per-line rect (not the bbox,
 * which for a wrapped answer spans multiple lines). */
function lineHeight(c: DetectedCloze): number {
  return c.rects.length ? Math.max(...c.rects.map((r) => r.h)) : c.bbox.h;
}

/**
 * Drop answers whose line height is much taller than the median — these are almost
 * always magenta HEADINGS / chapter titles, not fill-in-the-blank answers. Uses the
 * per-line height so multi-line (wrapped) answers are not mistaken for headings.
 * No-ops on very small inputs.
 */
export function filterByHeight(clozes: DetectedCloze[], maxRatio: number): DetectedCloze[] {
  if (clozes.length < 8 || maxRatio <= 0) return clozes;
  const med = median(clozes.map(lineHeight));
  if (med <= 0) return clozes;
  const limit = med * maxRatio;
  return clozes.filter((c) => lineHeight(c) <= limit);
}
