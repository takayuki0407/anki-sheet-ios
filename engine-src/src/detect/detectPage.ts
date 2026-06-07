import { DETECT_SCALE, type DeckColorConfig, type DetectedCloze, type Rect } from "../types";
import { sampleSegments, type PagePixels } from "./pixelSampler";

/** A text run with the device-space box to sample (computed from a pdf.js item). */
export interface RunCandidate {
  str: string;
  deviceBox: Rect;
}

const yc = (r: Rect) => r.y + r.h / 2;

function deviceToPage(r: Rect, scale: number): Rect {
  return { x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale };
}

function union(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether `next` is a plausible continuation of a colored run ending at `prev`:
 * same line to the right, a horizontal wrap (next line, restarting near the left),
 * or a vertical stack (next char below at ~same x). Guards against merging across
 * out-of-flow jumps when there is no black text separator.
 */
export function plausibleContinuation(prev: Rect, next: Rect): boolean {
  const h = Math.max(prev.h, next.h);
  const dy = yc(next) - yc(prev);
  if (Math.abs(dy) <= 0.6 * h) {
    // same line: merge only if (nearly) adjacent — a real black-text gap separates answers
    const gap = next.x - (prev.x + prev.w);
    return gap <= 0.3 * h && next.x + next.w >= prev.x - 0.3 * h;
  }
  if (dy > 0 && dy <= 2.4 * h) {
    if (next.x <= prev.x) return true; // horizontal wrap to a new line
    if (Math.abs(next.x - prev.x) <= 0.7 * h) return true; // vertical stack
  }
  return false;
}

interface Answer {
  rects: Rect[];
  text: string;
}

/** Union rects that share a text line into one rect per line. */
export function mergePerLine(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => yc(a) - yc(b) || a.x - b.x);
  const out: Rect[] = [];
  let cur: Rect | null = null;
  for (const r of sorted) {
    if (cur && Math.abs(yc(r) - yc(cur)) <= 0.6 * Math.max(cur.h, r.h)) {
      cur = union([cur, r]);
    } else {
      if (cur) out.push(cur);
      cur = { ...r };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Core detection: walk text runs in READING ORDER. A maximal run of colored items
 * with no black-text separator between them is ONE answer — this naturally joins
 * multi-glyph terms AND answers that wrap across a line break (the user-reported
 * case). Each answer keeps one rect per line. Pure and environment-agnostic.
 */
export function detectPage(
  pageIndex: number,
  pixels: PagePixels,
  runs: RunCandidate[],
  cfg: DeckColorConfig,
  scale: number,
): DetectedCloze[] {
  const answers: Answer[] = [];
  // In-band pixel counts scale with render scale²; rescale the floor so detection at the
  // mobile render scale (1.5x) matches the desktop DETECT_SCALE (2x) calibration.
  const minBand = cfg.minBandPx * (scale / DETECT_SCALE) ** 2;
  let cur: Answer | null = null;
  let prevDarkAfter = false; // did the previous colored run have black text after its answer?

  for (const run of runs) {
    if (!run.str || !run.str.trim()) continue; // skip whitespace-only runs
    const s = sampleSegments(pixels, run.deviceBox, cfg);
    // Segmentation isolates the colored pixels per span, so the run-level ink-ratio gate
    // (which dropped a small red phrase inside a mostly-black run) is no longer needed.
    const colored = s.segments.length > 0 && s.bandPx >= minBand;

    if (colored) {
      // Each colored span is its own piece; spans within a run are split by black text, so
      // they become distinct answers and the black between them is NOT masked.
      s.segments.forEach((seg, si) => {
        const rect = deviceToPage(seg, scale);
        // A line-wrap is a genuine continuation only if NO text sits between the two colored
        // parts. Block the merge when there's black ink after the previous run's answer
        // ("代物弁済[による]") or before this run's first answer ("[る]資産の譲渡").
        const interveningText = si === 0 && (prevDarkAfter || s.darkBefore);
        if (cur && !interveningText && plausibleContinuation(cur.rects[cur.rects.length - 1], rect)) {
          cur.rects.push(rect);
        } else {
          if (cur) answers.push(cur);
          cur = { rects: [rect], text: run.str };
        }
      });
      prevDarkAfter = s.darkAfter;
    } else if (s.inkPx >= 3) {
      // Real (black) ink with no colored span ends the current answer.
      if (cur) {
        answers.push(cur);
        cur = null;
      }
      prevDarkAfter = false;
    }
    // faint / no-ink runs neither extend nor break an answer
  }
  if (cur) answers.push(cur);

  return answers.map((a) => {
    const rects = mergePerLine(a.rects);
    return { pageIndex, rects, bbox: union(rects), text: a.text };
  });
}
