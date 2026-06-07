// Visible engine instance running in viewer mode. Loads the same WebView bundle, sends
// one openBook command once the engine is ready, then forwards control calls
// (setMode/goToPage/setFit/setZoom/setSheet) as fire-and-forget injects and surfaces
// book-ready / page-changed events to the screen.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { documentDirUri } from "./setupEngine";

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
}

export interface ViewerHandle {
  setMode(mode: "scroll" | "paged"): void;
  goToPage(page: number): void;
  setFit(fit: "width" | "page"): void;
  setZoom(zoom: number): void;
  setSheet(on: boolean): void;
}

interface Props {
  engineUri: string;
  open: ViewerOpenArgs | null;
  onBookReady?: (pageCount: number, page: number) => void;
  onPageChanged?: (page: number) => void;
  onError?: (msg: string) => void;
}

export const ViewerWebView = forwardRef<ViewerHandle, Props>(function ViewerWebView(
  { engineUri, open, onBookReady, onPageChanged, onError },
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
    }),
    [dispatch],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let m: { type?: string; page?: number; pageCount?: number; message?: string };
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
        case "error":
          onError?.(String(m.message ?? "engine error"));
          break;
      }
    },
    [sendOpen, onBookReady, onPageChanged, onError],
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
