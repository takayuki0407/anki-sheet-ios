// Visible engine instance running in viewer mode. Loads the same WebView bundle, sends
// one openBook command once the engine is ready, then forwards control calls
// (setMode/goToPage/setFit/setZoom/setSheet) as fire-and-forget injects and surfaces
// book-ready / page-changed events to the screen.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { documentDirUri } from "./setupEngine";
import type { Rect } from "../types";

/** A card the viewer should display while editing (id<0 = a staged, not-yet-saved add). */
export interface ViewerEditCard {
  id: number;
  pageIndex: number;
  rects: Rect[];
}

export interface ViewerOpenArgs {
  url: string;
  pageCount: number;
  pageW: number;
  pageH: number;
  cardsUrl: string;
  mode: "scroll" | "paged";
  page: number;
  fit: "width" | "page";
  zoom: number;
  sheetOn: boolean;
  /** Revealed card ids to restore from the last session. */
  revealed?: number[];
  /** Starred answer ids to restore (review-only mode masks just these). */
  starred?: number[];
  /** Manual red sheet: whether it was on, and its band position/height, last session. */
  manualOn?: boolean;
  band?: { top: number; height: number };
}

export interface ViewerHandle {
  setMode(mode: "scroll" | "paged"): void;
  goToPage(page: number): void;
  setFit(fit: "width" | "page"): void;
  setZoom(zoom: number): void;
  setSheet(on: boolean): void;
  setManualSheet(on: boolean): void;
  setEditMode(on: boolean): void;
  setEditCards(cards: ViewerEditCard[]): void;
  setDrawMode(mode: "add" | "delete" | null): void;
  setStarred(ids: number[]): void;
  setStarReview(on: boolean): void;
}

interface Props {
  engineUri: string;
  open: ViewerOpenArgs | null;
  onBookReady?: (pageCount: number, page: number) => void;
  onPageChanged?: (page: number) => void;
  onZoomChanged?: (zoom: number) => void;
  onRevealChanged?: (revealed: number[], sheetOn: boolean) => void;
  onBandChanged?: (top: number, height: number) => void;
  onMaskTapped?: (id: number) => void;
  onDrawRect?: (page: number, mode: "add" | "delete", rect: Rect) => void;
  onMaskStarred?: (id: number, starred: number[]) => void;
  onError?: (msg: string) => void;
}

export const ViewerWebView = forwardRef<ViewerHandle, Props>(function ViewerWebView(
  {
    engineUri,
    open,
    onBookReady,
    onPageChanged,
    onZoomChanged,
    onRevealChanged,
    onBandChanged,
    onMaskTapped,
    onDrawRect,
    onMaskStarred,
    onError,
  },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const ready = useRef(false);
  const opened = useRef(false);
  const goneCount = useRef(0); // consecutive WebView-process crashes (reset on a successful open)

  const dispatch = useCallback((payload: Record<string, unknown>) => {
    const json = JSON.stringify(payload);
    webRef.current?.injectJavaScript(
      `window.ankiEngine&&window.ankiEngine.dispatch(${JSON.stringify(json)});true;`,
    );
  }, []);

  const sendOpen = useCallback(() => {
    if (!open || !ready.current || opened.current) return;
    opened.current = true;
    dispatch({ cmd: "openBook", reqId: "open", ...open });
  }, [open, dispatch]);

  useEffect(() => {
    opened.current = false; // a new book (open changed) must re-dispatch openBook
    sendOpen();
  }, [open, sendOpen]);

  const onProcessGone = useCallback(() => {
    ready.current = false;
    opened.current = false; // allow a fresh openBook once the reloaded engine signals "ready"
    goneCount.current += 1;
    if (goneCount.current > 2) {
      // Repeated crashes (a PDF too large for this device) → surface a real error instead of a
      // silent reload loop. A transient jettison (count 1–2) recovers below via "ready" → sendOpen,
      // so DON'T flash a terminal error for it — that was hiding the successfully-reloaded viewer.
      onError?.("このPDFを表示できませんでした（メモリ不足の可能性）。");
      return;
    }
    webRef.current?.reload();
  }, [onError]);

  useImperativeHandle(
    ref,
    () => ({
      setMode: (mode) => dispatch({ cmd: "setMode", reqId: "c", mode }),
      goToPage: (page) => dispatch({ cmd: "goToPage", reqId: "c", page }),
      setFit: (fit) => dispatch({ cmd: "setFit", reqId: "c", fit }),
      setZoom: (zoom) => dispatch({ cmd: "setZoom", reqId: "c", zoom }),
      setSheet: (on) => dispatch({ cmd: "setSheet", reqId: "c", on }),
      setManualSheet: (on) => dispatch({ cmd: "setManualSheet", reqId: "c", on }),
      setEditMode: (on) => dispatch({ cmd: "setEditMode", reqId: "c", editOn: on }),
      setEditCards: (cards) => dispatch({ cmd: "setEditCards", reqId: "c", editCards: cards }),
      setDrawMode: (mode) => dispatch({ cmd: "setDrawMode", reqId: "c", drawMode: mode }),
      setStarred: (ids) => dispatch({ cmd: "setStarred", reqId: "c", starred: ids }),
      setStarReview: (on) => dispatch({ cmd: "setStarReview", reqId: "c", starReview: on }),
    }),
    [dispatch],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      // Defense in depth: only trust messages from the local engine's file:// origin.
      if (!e.nativeEvent.url.startsWith("file://")) return;
      let m: {
        type?: string;
        page?: number;
        pageCount?: number;
        zoom?: number;
        message?: string;
        revealed?: number[];
        sheetOn?: boolean;
        top?: number;
        height?: number;
        id?: number;
        mode?: "add" | "delete";
        rect?: Rect;
        starred?: number[];
      };
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      switch (m.type) {
        case "ready":
          ready.current = true;
          sendOpen();
          break;
        case "book-ready":
          goneCount.current = 0; // a successful open clears the crash streak
          onBookReady?.(m.pageCount ?? 0, m.page ?? 0);
          break;
        case "page-changed":
          onPageChanged?.(m.page ?? 0);
          break;
        case "zoom-changed":
          onZoomChanged?.(m.zoom ?? 1);
          break;
        case "reveal-changed":
          onRevealChanged?.(m.revealed ?? [], m.sheetOn ?? true);
          break;
        case "band-changed":
          if (typeof m.top === "number" && typeof m.height === "number")
            onBandChanged?.(m.top, m.height);
          break;
        case "mask-tapped":
          if (typeof m.id === "number") onMaskTapped?.(m.id);
          break;
        case "draw-rect":
          if (typeof m.page === "number" && m.rect && (m.mode === "add" || m.mode === "delete"))
            onDrawRect?.(m.page, m.mode, m.rect);
          break;
        case "mask-starred":
          if (typeof m.id === "number") onMaskStarred?.(m.id, m.starred ?? []);
          break;
        case "error":
          onError?.(String(m.message ?? "engine error"));
          break;
      }
    },
    [
      sendOpen,
      onBookReady,
      onPageChanged,
      onZoomChanged,
      onRevealChanged,
      onBandChanged,
      onMaskTapped,
      onDrawRect,
      onMaskStarred,
      onError,
    ],
  );

  return (
    <View style={styles.fill}>
      <WebView
        ref={webRef}
        source={{ uri: engineUri }}
        originWhitelist={["file://*"]}
        // The engine is a local, trusted bundle that never navigates off its file:// origin. Block
        // any non-file:// navigation (e.g. a link smuggled into a PDF) so it can't reach the network.
        // pdf.js's PDF read is a subresource XHR, not a navigation, so it does NOT pass through here.
        onShouldStartLoadWithRequest={(req) => req.url.startsWith("file://")}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        // Required: the engine (<documents>/engine/) XHRs staged PDFs in <documents>/ — a different
        // file:// directory ⇒ cross-origin, needing universal access. Removing it breaks PDF loading
        // unless PDFs are staged same-origin. Mitigated by the file://-only nav guard + onMessage
        // origin check above; the engine loads only local, trusted content.
        allowUniversalAccessFromFileURLs
        allowingReadAccessToURL={documentDirUri()}
        onMessage={onMessage}
        onError={(e) => onError?.("webview: " + e.nativeEvent.description)}
        // If the WebView process is jettisoned (memory pressure), reset the ready/opened latches and
        // reload so the recovered engine re-emits "ready" → sendOpen re-dispatches openBook. Without
        // this the viewer goes permanently blank (opened.current stays true, so no re-open fires).
        // onRenderProcessGone = Android; onContentProcessDidTerminate = iOS (WKWebView) — bind both.
        onRenderProcessGone={onProcessGone}
        onContentProcessDidTerminate={onProcessGone}
        // The page content scrolls via THIS native WKWebView scroll view, so iOS provides
        // Safari-grade momentum AND directional lock (a near-vertical swipe won't drift sideways).
        // directionalLockEnabled = UIScrollView.isDirectionalLockEnabled. Custom pinch-zoom is done
        // in-page (the viewport disables native zoom); insets are off so doc (0,0) = WebView top.
        scrollEnabled
        directionalLockEnabled
        // Lower scroll resistance so a flick glides farther (1=frictionless). iOS default is
        // 'normal' (0.998); 0.999 ≈ doubles the coast distance for long 縦読み documents.
        decelerationRate={0.999}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        style={styles.fill}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#525659" },
});
