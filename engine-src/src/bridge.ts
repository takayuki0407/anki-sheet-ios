// WebView engine bridge.
//
// index.html loads this module inside react-native-webview. It receives JSON command
// strings from the React Native host (window.ankiEngine.dispatch, injected by the host)
// and posts JSON event strings back (window.ReactNativeWebView.postMessage). All heavy
// work — pdf.js rendering, pixel sampling, color detection, and the red-sheet viewer —
// happens here in the WebView's JS VM; only small JSON crosses the bridge.
//
// Two roles share this one bundle: a headless instance does import detection / cover
// rendering (detectAll/cover), and a visible instance drives the viewer (openBook + the
// setMode/goToPage/setFit/setZoom/setSheet controls), emitting book-ready / page-changed.
import "./polyfills";
import {
  autoDetectColorConfig,
  CancelledError,
  detectClozesInPdf,
  detectOnPage,
  loadPdf,
  renderCover,
} from "./pdf/pdfEngine";
import { DEFAULT_MAGENTA_BAND, type DeckColorConfig } from "./types";
import { blobToDataURL, pdfBytes } from "./io";
import { Viewer, type FitMode, type OpenBookArgs, type ViewMode } from "./viewer/viewer";

interface HostBridge {
  postMessage(data: string): void;
}
const host: HostBridge | undefined = (
  window as unknown as { ReactNativeWebView?: HostBridge }
).ReactNativeWebView;

/** Send a JSON event to the React Native host (falls back to parent frame in a browser). */
function post(msg: Record<string, unknown>): void {
  const s = JSON.stringify(msg);
  if (host?.postMessage) host.postMessage(s);
  else if (window.parent !== window) window.parent.postMessage(s, "*");
}

function setStatus(t: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = t;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Cmd {
  cmd: string;
  reqId: string;
  url?: string;
  base64?: string;
  color?: DeckColorConfig;
  auto?: boolean; // first import: auto-pick the answer color before detecting
  maxWidth?: number;
  // viewer / openBook
  mode?: ViewMode;
  page?: number;
  fit?: FitMode;
  zoom?: number;
  on?: boolean;
}

const aborters = new Map<string, AbortController>();

/** Render + detect colored answers across an entire PDF, streaming progress. */
async function detectAll(m: Cmd): Promise<void> {
  const ac = new AbortController();
  aborters.set(m.reqId, ac);
  try {
    setStatus("PDFを読み込み中…");
    const bytes = await pdfBytes(m);
    // Wrap in a Blob: with auto-color we loadPdf twice (probe + full), and pdf.js may transfer the
    // backing ArrayBuffer to its worker (neutering it). A Blob hands a fresh copy to each loadPdf.
    const data = new Blob([bytes], { type: "application/pdf" });
    let color = m.color ?? DEFAULT_MAGENTA_BAND;
    if (m.auto) {
      setStatus("答えの色を判定中…");
      color = await autoDetectColorConfig(data, ac.signal);
    }
    const result = await detectClozesInPdf(
      data,
      color,
      (page, total, found) => {
        setStatus(`検出 ${page}/${total} … ${found}`);
        post({ type: "progress", reqId: m.reqId, page, total, found });
      },
      ac.signal,
    );
    // Include the (possibly auto-picked) color so the host can show/persist it.
    post({ type: "detected", reqId: m.reqId, result: { ...result, color } });
    setStatus(`完了: ${result.clozes.length} 件`);
  } catch (e) {
    if (e instanceof CancelledError) {
      post({ type: "cancelled", reqId: m.reqId });
      setStatus("中止しました");
    } else {
      post({ type: "error", reqId: m.reqId, message: errMsg(e) });
      setStatus(`エラー: ${errMsg(e)}`);
    }
  } finally {
    aborters.delete(m.reqId);
  }
}

/** Render page 1 to a small JPEG cover thumbnail (returned as a data URL). */
async function cover(m: Cmd): Promise<void> {
  try {
    const data = await pdfBytes(m);
    const blob = await renderCover(data, m.maxWidth ?? 240);
    post({ type: "cover", reqId: m.reqId, dataUrl: await blobToDataURL(blob) });
  } catch (e) {
    post({ type: "error", reqId: m.reqId, message: errMsg(e) });
  }
}

/** Render one page with the given color config, draw the detected answers as red masks,
 * and return it as a JPEG data URL — used by the settings color tuner's live preview. */
async function previewPage(m: Cmd): Promise<void> {
  try {
    const data = await pdfBytes(m);
    const doc = await loadPdf(data);
    try {
      const idx = typeof m.page === "number" ? m.page : 0;
      const page = await doc.getPage(idx + 1);
      // Detect at the same scale full-PDF detection uses on touch devices (1.5x) so the
      // preview count matches the actual re-detect result.
      const scale = 1.5;
      const canvas = document.createElement("canvas");
      const clozes = await detectOnPage(page, m.color ?? DEFAULT_MAGENTA_BAND, scale, canvas);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "rgba(226,59,59,0.82)";
        for (const c of clozes) for (const r of c.rects) ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      canvas.width = 0; // free the full-page bitmap (avoid WKWebView memory pressure)
      canvas.height = 0;
      page.cleanup();
      post({ type: "preview", reqId: m.reqId, dataUrl, count: clozes.length });
    } finally {
      await doc.loadingTask.destroy();
    }
  } catch (e) {
    post({ type: "error", reqId: m.reqId, message: errMsg(e) });
  }
}

let viewer: Viewer | null = null;
function getViewer(): Viewer {
  if (!viewer) {
    const root = document.getElementById("viewer") as HTMLElement;
    viewer = new Viewer(root, post);
  }
  return viewer;
}

const handlers: Record<string, (m: Cmd) => void> = {
  detectAll,
  cover,
  previewPage,
  cancel: (m) => aborters.get(m.reqId)?.abort(),
  ping: (m) => post({ type: "pong", reqId: m.reqId, buildId: __BUILD_ID__ }),
  openBook: (m) => {
    void getViewer()
      .open(m as unknown as OpenBookArgs)
      .catch((e) => post({ type: "error", reqId: m.reqId, message: errMsg(e) }));
  },
  setMode: (m) => {
    if (m.mode) getViewer().setMode(m.mode);
  },
  goToPage: (m) => {
    if (typeof m.page === "number") getViewer().goToPage(m.page);
  },
  setFit: (m) => {
    if (m.fit) getViewer().setFit(m.fit);
  },
  setZoom: (m) => {
    if (typeof m.zoom === "number") getViewer().setZoom(m.zoom);
  },
  setSheet: (m) => {
    if (typeof m.on === "boolean") getViewer().setSheet(m.on);
  },
  setManualSheet: (m) => {
    if (typeof m.on === "boolean") getViewer().setManualSheet(m.on);
  },
};

interface Engine {
  dispatch(json: string): void;
}
// The host injects window.ankiEngine.dispatch("<json>") to send commands.
(window as unknown as { ankiEngine: Engine }).ankiEngine = {
  dispatch(json: string) {
    let m: Cmd;
    try {
      m = JSON.parse(json) as Cmd;
    } catch {
      return;
    }
    handlers[m.cmd]?.(m);
  },
};

setStatus("エンジン準備完了");
post({ type: "ready", buildId: __BUILD_ID__ });
