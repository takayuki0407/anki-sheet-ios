import { describe, expect, it } from "vitest";
import { iou } from "./rect";

describe("iou", () => {
  it("is 1 for identical rects", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
  });
  it("is 0 for disjoint rects", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(0);
  });
  it("computes partial overlap", () => {
    // two 10x10 rects overlapping in a 5x10 strip: inter=50, union=150 -> 1/3
    const v = iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 });
    expect(v).toBeCloseTo(1 / 3, 5);
  });
});
