import { describe, expect, it } from "vitest";
import { hueDistance, isInBand, isBackground, rgb2hsl } from "./colorBand";
import { DEFAULT_MAGENTA_BAND } from "../types";

describe("rgb2hsl", () => {
  it("converts the primary magenta answer color", () => {
    const [h, s, l] = rgb2hsl(236, 0, 140);
    expect(h).toBeGreaterThan(315);
    expect(h).toBeLessThan(335);
    expect(s).toBeGreaterThan(0.9);
    expect(l).toBeGreaterThan(0.4);
    expect(l).toBeLessThan(0.5);
  });
  it("black has ~zero saturation", () => {
    const [, s] = rgb2hsl(35, 31, 32);
    expect(s).toBeLessThan(0.1);
  });
});

describe("hueDistance", () => {
  it("wraps around 360", () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(10, 350)).toBe(20);
    expect(hueDistance(326, 326)).toBe(0);
  });
});

describe("isInBand (default magenta)", () => {
  const cfg = DEFAULT_MAGENTA_BAND;
  it("accepts all three magenta variants from the textbook", () => {
    expect(isInBand(236, 0, 140, cfg)).toBe(true);
    expect(isInBand(177, 0, 105, cfg)).toBe(true);
    expect(isInBand(239, 91, 161, cfg)).toBe(true);
  });
  it("rejects body black, white, and unrelated hues", () => {
    expect(isInBand(35, 31, 32, cfg)).toBe(false);
    expect(isInBand(255, 255, 255, cfg)).toBe(false);
    expect(isInBand(30, 110, 220, cfg)).toBe(false); // blue
    expect(isInBand(40, 160, 70, cfg)).toBe(false); // green
  });
});

describe("isBackground", () => {
  it("flags near-white only", () => {
    expect(isBackground(255, 255, 255)).toBe(true);
    expect(isBackground(240, 240, 240)).toBe(true);
    expect(isBackground(200, 200, 200)).toBe(false);
    expect(isBackground(236, 0, 140)).toBe(false);
  });
});
