import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
// Vite resolves this to the worker's asset URL (a sibling file:// at runtime).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { DeckColorConfig, DetectedCloze } from "../types";
import { DETECT_SCALE } from "../types";
import { detectPage, type RunCandidate } from "../detect/detectPage";
import { runBox } from "../detect/runGeometry";
import { filterByHeight } from "../detect/heightFilter";
import type { PagePixels } from "../detect/pixelSampler";

// A real Worker loaded directly from a sibling file:// URL throws SecurityError in
// WKWebView (each file:// document is an opaque origin), and pdfjs v6 removed
// `disableWorker`. So we fetch the worker code via XHR and run it from a blob: URL
// (allowed), falling back to main-thread execution if even that fails.
let workerReady: Promise<void> | null = null;
function ensureWorker(): Promise<void> {
  if (!workerReady) {
    workerReady = (async () => {
      try {
        const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", workerUrl, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => {
            const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
            if (ok && xhr.response) resolve(xhr.response as ArrayBuffer);
            else reject(new Error("worker " + xhr.status));
          };
          xhr.onerror = () => reject(new Error("worker load failed"));
          xhr.send();
        });
        const blob = new Blob([buf], { type: "text/javascript" });
        pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), {
          type: "module",
        });
      } catch {
        // Last resort: run pdf.js on the main thread (slower, but always works).
        await import("pdfjs-dist/build/pdf.worker.min.mjs");
      }
    })();
  }
  return workerReady;
}

// cMaps + standard fonts are copied into public/pdfjs (see scripts/copy-pdfjs-assets.mjs).
// They are REQUIRED: without them, CJK (CID) fonts neither render nor extract text.
const CMAP_URL = new URL("pdfjs/cmaps/", document.baseURI).toString();
const STANDARD_FONT_URL = new URL("pdfjs/standard_fonts/", document.baseURI).toString();

export async function loadPdf(data: ArrayBuffer | Blob): Promise<PDFDocumentProxy> {
  await ensureWorker();
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  return pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
  }).promise;
}

export interface PageSize {
  width: number;
  height: number;
}

/** Page size in page coordinates (PDF points). */
export function pageSize(page: PDFPageProxy): PageSize {
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Serialize page renders: pdf.js rejects overlapping render() calls on one canvas,
// and rendering the same page proxy concurrently is unsafe. A simple promise chain
// keeps every render strictly sequential across the whole app.
let renderLock: Promise<unknown> = Promise.resolve();

/** Render a page into a 2D canvas at the given scale (serialized app-wide). The
 * optional shouldCancel is checked once the mutex frees, so a render queued for a
 * page that has since scrolled away / unmounted is skipped instead of rasterized. */
export async function renderPage(
  page: PDFPageProxy,
  scale: number,
  canvas?: HTMLCanvasElement,
  shouldCancel?: () => boolean,
): Promise<HTMLCanvasElement> {
  const run = async () => {
    if (shouldCancel?.()) return canvas ?? makeCanvas(1, 1);
    const viewport = page.getViewport({ scale });
    const c = canvas ?? makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    c.width = Math.ceil(viewport.width);
    c.height = Math.ceil(viewport.height);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    await page.render({ canvasContext: ctx, viewport, canvas: c }).promise;
    return c;
  };
  const result = renderLock.then(run, run);
  renderLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function pixelsFrom(canvas: HTMLCanvasElement): PagePixels {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Build sampling boxes (device px) for each text run on the page. */
export async function runCandidates(
  page: PDFPageProxy,
  scale: number,
): Promise<RunCandidate[]> {
  const viewport = page.getViewport({ scale });
  const tc = await page.getTextContent();
  const out: RunCandidate[] = [];
  for (const item of tc.items) {
    if (!("transform" in item)) continue; // skip TextMarkedContent
    const str = item.str;
    if (!str || !str.trim()) continue;
    const box = runBox(viewport.transform as number[], item.transform, item.width, scale);
    if (box.h <= 0) continue;
    out.push({ str, deviceBox: box });
  }
  return out;
}

// Render detection at a lower scale on memory-constrained touch devices (iOS Safari
// jettisons the page otherwise). Answer-term detection is unaffected: a glyph's
// in-band pixel count stays well above the threshold even at this scale.
const MOBILE_DETECT_SCALE = 1.5;
function detectScale(): number {
  try {
    if (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches)
      return MOBILE_DETECT_SCALE;
  } catch {
    /* fall through to desktop scale */
  }
  return DETECT_SCALE;
}

/** Render page 1 of a PDF to a small JPEG cover thumbnail. */
export async function renderCover(data: ArrayBuffer | Blob, maxWidth = 240): Promise<Blob> {
  const doc = await loadPdf(data);
  try {
    const page = await doc.getPage(1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp1 = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, (maxWidth / vp1.width) * dpr);
    page.cleanup();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error("cover render failed");
    return blob;
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** Detect colored answers on a single already-open page (used by the live tuner). */
export async function detectOnPage(
  page: PDFPageProxy,
  cfg: DeckColorConfig,
  scale: number,
  canvas?: HTMLCanvasElement,
): Promise<DetectedCloze[]> {
  const c = await renderPage(page, scale, canvas);
  const px = pixelsFrom(c);
  const runs = await runCandidates(page, scale);
  return detectPage(page.pageNumber - 1, px, runs, cfg, scale);
}

/** Detect on one page of an open document (for tuner preview). */
export async function detectSinglePage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  cfg: DeckColorConfig,
): Promise<DetectedCloze[]> {
  const page = await doc.getPage(pageIndex + 1);
  try {
    return await detectOnPage(page, cfg, detectScale());
  } finally {
    page.cleanup();
  }
}

export interface PdfDetectionResult {
  pageCount: number;
  pageW: number;
  pageH: number;
  clozes: DetectedCloze[];
}

const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Render + detect colored answers across every page of a PDF. Cleans up each page
 * as it goes (bounded memory) and yields between pages so the UI stays responsive.
 * Pass an AbortSignal to cancel mid-run. A height-outlier pass drops heading
 * false-positives at the end.
 */
export async function detectClozesInPdf(
  data: ArrayBuffer | Blob,
  cfg: DeckColorConfig,
  onProgress?: (page: number, total: number, found: number) => void,
  signal?: AbortSignal,
): Promise<PdfDetectionResult> {
  // Breadcrumb so a failure on a device reports which step/page broke (the message is
  // surfaced in the import error UI; the full stack is mapped via sourcemaps).
  let stage = "loadPdf";
  try {
    const doc = await loadPdf(data);
    const pageCount = doc.numPages;
    const canvas = makeCanvas(1, 1);
    const scale = detectScale();
    const cleanupEvery = scale < DETECT_SCALE ? 8 : 16;
    let clozes: DetectedCloze[] = [];
    let pageW = 0;
    let pageH = 0;
    try {
      for (let p = 1; p <= pageCount; p++) {
        if (signal?.aborted) throw new CancelledError();
        stage = `getPage ${p}`;
        const page = await doc.getPage(p);
        try {
          if (p === 1) {
            const sz = pageSize(page);
            pageW = sz.width;
            pageH = sz.height;
          }
          stage = `detect ${p}`;
          clozes.push(...(await detectOnPage(page, cfg, scale, canvas)));
        } finally {
          page.cleanup();
        }
        onProgress?.(p, pageCount, clozes.length);
        await yieldToUI();
        // Periodically flush pdf.js caches to keep memory bounded (matters on iOS,
        // which kills the page if a long render run uses too much memory).
        if (p % cleanupEvery === 0) await doc.cleanup();
      }
      stage = "filterByHeight";
      clozes = filterByHeight(clozes, cfg.maxHeightRatio);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      await doc.loadingTask.destroy();
    }
    return { pageCount, pageW, pageH, clozes };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (e instanceof Error) e.message = `${e.message} [stage=${stage}, build=${__BUILD_ID__}]`;
    throw e;
  }
}
