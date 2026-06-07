import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectPage, type RunCandidate } from "./detectPage";
import { runBox } from "./runGeometry";
import type { PagePixels } from "./pixelSampler";
import { DEFAULT_MAGENTA_BAND, DETECT_SCALE, type DetectedCloze } from "../types";

// Set ANKI_SHEET_TEST_PDF to a red-sheet PDF path to run this against the real
// rendering + detection pipeline in Node (uses @napi-rs/canvas + pdf.js legacy).
const PDF_PATH = process.env.ANKI_SHEET_TEST_PDF;
const MAX_PAGES = process.env.ANKI_SHEET_TEST_PAGES
  ? Number(process.env.ANKI_SHEET_TEST_PAGES)
  : Infinity;

describe.skipIf(!PDF_PATH)("detect against a real PDF", () => {
  it(
    "renders pages and detects colored clozes",
    async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { createCanvas } = await import("@napi-rs/canvas");
      const cMapUrl = resolve("node_modules/pdfjs-dist/cmaps") + "/";
      const standardFontDataUrl = resolve("node_modules/pdfjs-dist/standard_fonts") + "/";

      const data = new Uint8Array(readFileSync(PDF_PATH!));
      const doc = await pdfjs.getDocument({
        data,
        disableWorker: true,
        cMapUrl,
        cMapPacked: true,
        standardFontDataUrl,
        verbosity: 0,
      }).promise;

      const pageCount = Math.min(doc.numPages, MAX_PAGES);
      const all: DetectedCloze[] = [];
      let pagesWithClozes = 0;

      for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: DETECT_SCALE });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport, canvas: null }).promise;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px: PagePixels = {
          width: img.width,
          height: img.height,
          data: img.data as unknown as Uint8ClampedArray,
        };

        const tc = await page.getTextContent();
        const runs: RunCandidate[] = [];
        for (const item of tc.items) {
          if (!("transform" in item) || !item.str?.trim()) continue;
          const box = runBox(
            viewport.transform as number[],
            item.transform,
            item.width,
            DETECT_SCALE,
          );
          runs.push({ str: item.str, deviceBox: box });
        }

        const found = detectPage(p - 1, px, runs, DEFAULT_MAGENTA_BAND, DETECT_SCALE);
        if (found.length) pagesWithClozes++;
        all.push(...found);
        page.cleanup();
      }
      await doc.loadingTask.destroy();

      process.stdout.write(
        `\n[integration] ${pageCount} pages -> ${all.length} clozes on ${pagesWithClozes} pages\n`,
      );

      // The financial-statements book has ~3,560 magenta answers across 210/252 pages.
      if (pageCount > 200) {
        expect(all.length).toBeGreaterThan(2000);
        expect(all.length).toBeLessThan(6000);
        expect(pagesWithClozes).toBeGreaterThan(120);
      } else {
        expect(all.length).toBeGreaterThan(0);
      }
      // Every detected cloze has a positive-area mask and recovered (or empty) text.
      for (const c of all.slice(0, 50)) {
        expect(c.bbox.w).toBeGreaterThan(0);
        expect(c.bbox.h).toBeGreaterThan(0);
        expect(c.rects.length).toBeGreaterThan(0);
      }
    },
    600_000,
  );
});
