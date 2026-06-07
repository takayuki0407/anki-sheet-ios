import { describe, expect, it } from "vitest";
import { filterByHeight, median } from "./heightFilter";
import type { DetectedCloze } from "../types";

const cloze = (h: number): DetectedCloze => ({
  pageIndex: 0,
  rects: [{ x: 0, y: 0, w: 10, h }],
  bbox: { x: 0, y: 0, w: 10, h },
  text: "",
});

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("filterByHeight", () => {
  it("drops heading-height outliers above the ratio", () => {
    const body = Array.from({ length: 20 }, () => cloze(10));
    const headings = [cloze(30), cloze(28)];
    const out = filterByHeight([...body, ...headings], 1.8); // median 10, limit 18
    expect(out).toHaveLength(20);
    expect(out.every((c) => c.bbox.h <= 18)).toBe(true);
  });

  it("no-ops on tiny populations", () => {
    const few = [cloze(10), cloze(40)];
    expect(filterByHeight(few, 1.8)).toHaveLength(2);
  });
});
