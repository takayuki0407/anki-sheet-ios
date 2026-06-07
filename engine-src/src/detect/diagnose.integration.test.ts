// Diagnostic (not a real test): renders one page of a real PDF and dumps each text run's
// color-sampling result + the final detected answers, so detection issues (e.g. masks
// covering black text between red answers) can be inspected against real data.
//   $env:ANKI_SHEET_DIAGNOSE_PDF="C:\path\to.pdf"; $env:ANKI_SHEET_DIAGNOSE_PAGE="19"; npx vitest run diagnose
import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectPage, type RunCandidate } from "./detectPage";
import { runBox } from "./runGeometry";
import { sampleBox, type PagePixels } from "./pixelSampler";
import { DEFAULT_MAGENTA_BAND, DETECT_SCALE } from "../types";

const PDF = process.env.ANKI_SHEET_DIAGNOSE_PDF;
const PAGE = Number(process.env.ANKI_SHEET_DIAGNOSE_PAGE ?? "1"); // 1-based

describe.skipIf(!PDF)("diagnose detection on a real page", () => {
  it(
    "dumps runs + answers",
    async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { createCanvas } = await import("@napi-rs/canvas");
      const cMapUrl = resolve("node_modules/pdfjs-dist/cmaps") + "/";
      const standardFontDataUrl = resolve("node_modules/pdfjs-dist/standard_fonts") + "/";

      const data = new Uint8Array(readFileSync(PDF!));
      const doc = await pdfjs.getDocument({
        data,
        disableWorker: true,
        cMapUrl,
        cMapPacked: true,
        standardFontDataUrl,
        verbosity: 0,
      }).promise;

      const page = await doc.getPage(PAGE);
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
        const box = runBox(viewport.transform as number[], item.transform, item.width, DETECT_SCALE);
        runs.push({ str: item.str, deviceBox: box });
      }

      const cfg = {
        ...DEFAULT_MAGENTA_BAND,
        hueTarget: Number(process.env.ANKI_SHEET_HUE ?? "2"),
        hueTol: Number(process.env.ANKI_SHEET_HUETOL ?? "22"),
      };
      let out = `\n=== page ${PAGE}: ${runs.length} runs (R = detected colored) ===\n`;
      for (const r of runs) {
        const s = sampleBox(px, r.deviceBox, cfg);
        const colored =
          !!s.tightDeviceRect && s.bandPx >= cfg.minBandPx && s.bandPx >= s.inkPx * cfg.inkRatioFloor;
        const tight = s.tightDeviceRect
          ? `${s.tightDeviceRect.x | 0}+${s.tightDeviceRect.w | 0}`
          : "-";
        out += `${colored ? "R" : " "} band=${String(s.bandPx).padStart(4)} ink=${String(s.inkPx).padStart(4)} boxX=${(r.deviceBox.x | 0).toString().padStart(4)} boxW=${(r.deviceBox.w | 0).toString().padStart(4)} tight=${tight}  "${r.str}"\n`;
      }

      const answers = detectPage(PAGE - 1, px, runs, cfg, DETECT_SCALE);
      out += `\n=== ${answers.length} answers ===\n`;
      for (const a of answers) {
        out += `  rects=[${a.rects.map((r) => `${r.x | 0}+${r.w | 0}`).join(", ")}]  "${a.text}"\n`;
      }
      process.stdout.write(out);

      page.cleanup();
      await doc.loadingTask.destroy();
    },
    180000,
  );
});
