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
    onError,
  },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const ready = useRef(false);
  const opened = useRef(false);

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
    }),
    [dispatch],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
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
      onError,
    ],
  );

  return (
    <View style={styles.fill}>
      <WebView
        ref={webRef}
        source={{ uri: engineUri }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowingReadAccessToURL={documentDirUri()}
        onMessage={onMessage}
        onError={(e) => onError?.("webview: " + e.nativeEvent.description)}
        // The viewer manages its own scrolling inside the WebView.
        scrollEnabled={false}
        style={styles.fill}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#525659" },
});
