import { describe, expect, it } from "vitest";
import { mergePerLine, plausibleContinuation } from "./detectPage";
import type { Rect } from "../types";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("mergePerLine", () => {
  it("unions rects on the same line into one", () => {
    const out = mergePerLine([r(10, 100, 10, 12), r(21, 100, 10, 12), r(32, 100, 10, 12)]);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(10);
    expect(out[0].w).toBe(32);
  });
  it("keeps one rect per line for a wrapped answer", () => {
    const out = mergePerLine([r(300, 100, 30, 12), r(10, 118, 30, 12)]);
    expect(out).toHaveLength(2);
  });
});

describe("plausibleContinuation", () => {
  it("accepts same-line-to-the-right", () => {
    expect(plausibleContinuation(r(10, 100, 10, 12), r(21, 100, 10, 12))).toBe(true);
  });
  it("accepts a horizontal wrap (next line, restart at left)", () => {
    // prev ends at the right margin, next starts far left on the line below
    expect(plausibleContinuation(r(300, 100, 30, 12), r(10, 118, 30, 12))).toBe(true);
  });
  it("accepts a vertical stack (below, same x)", () => {
    expect(plausibleContinuation(r(800, 100, 12, 12), r(800, 116, 12, 12))).toBe(true);
  });
  it("rejects a far/implausible jump", () => {
    expect(plausibleContinuation(r(10, 100, 10, 12), r(800, 400, 10, 12))).toBe(false);
  });
});
