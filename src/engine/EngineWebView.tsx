// Hosts the WebView PDF engine and exposes a small typed, promise-based API to React
// Native. Commands are injected as window.ankiEngine.dispatch("<json>"); the engine
// replies via window.ReactNativeWebView.postMessage("<json>"), routed back to the
// awaiting promise by reqId. All heavy work stays inside the WebView.
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { DeckColorConfig } from "../types";
import type { DetectProgress, PdfDetectionResult } from "./protocol";
import { documentDirUri } from "./setupEngine";

export interface EngineHandle {
  detectAll(
    args: { url?: string; base64?: string; color?: DeckColorConfig; auto?: boolean },
    onProgress?: (p: DetectProgress) => void,
    signal?: AbortSignal,
  ): Promise<PdfDetectionResult>;
  cover(args: { url?: string; base64?: string; maxWidth?: number; page?: number }): Promise<string>;
  preview(args: {
    url?: string;
    base64?: string;
    color?: DeckColorConfig;
    page?: number;
    maxWidth?: number;
  }): Promise<{ dataUrl: string; count: number }>;
  pageText(args: {
    url?: string;
    base64?: string;
    pages: number[];
  }): Promise<{ page: number; text: string }[]>;
  ping(): Promise<{ buildId: string }>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: DetectProgress) => void;
}

interface Props {
  engineUri: string;
  visible?: boolean;
  onReady?: (buildId: string) => void;
  onLog?: (msg: string) => void;
}

export const EngineWebView = forwardRef<EngineHandle, Props>(function EngineWebView(
  { engineUri, visible = false, onReady, onLog },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const pending = useRef(new Map<string, Pending>());
  const counter = useRef(0);

  const dispatch = useCallback((payload: Record<string, unknown>) => {
    const json = JSON.stringify(payload);
    webRef.current?.injectJavaScript(
      `window.ankiEngine&&window.ankiEngine.dispatch(${JSON.stringify(json)});true;`,
    );
  }, []);

  const send = useCallback(
    <T,>(
      cmd: string,
      payload: Record<string, unknown>,
      onProgress?: (p: DetectProgress) => void,
      signal?: AbortSignal,
    ): Promise<T> => {
      const reqId = String(++counter.current);
      return new Promise<T>((resolve, reject) => {
        pending.current.set(reqId, { resolve: resolve as (v: unknown) => void, reject, onProgress });
        dispatch({ cmd, reqId, ...payload });
        if (signal) {
          const abort = () => dispatch({ cmd: "cancel", reqId });
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
    },
    [dispatch],
  );

  useImperativeHandle(
    ref,
    () => ({
      detectAll: (args, onProgress, signal) =>
        send<PdfDetectionResult>("detectAll", args, onProgress, signal),
      cover: (args) => send<string>("cover", args),
      preview: (args) => send<{ dataUrl: string; count: number }>("previewPage", args),
      pageText: (args) => send<{ page: number; text: string }[]>("pageText", args),
      ping: () => send<{ buildId: string }>("ping", {}),
    }),
    [send],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let m: { type?: string; reqId?: string; [k: string]: unknown };
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (m.type === "ready") {
        onReady?.(String(m.buildId ?? ""));
        return;
      }
      const p = m.reqId ? pending.current.get(m.reqId) : undefined;
      if (!p) return;
      switch (m.type) {
        case "progress":
          p.onProgress?.(m as unknown as DetectProgress);
          break;
        case "detected":
          p.resolve(m.result);
          pending.current.delete(m.reqId!);
          break;
        case "cover":
          p.resolve(m.dataUrl);
          pending.current.delete(m.reqId!);
          break;
        case "preview":
          p.resolve({ dataUrl: m.dataUrl, count: m.count });
          pending.current.delete(m.reqId!);
          break;
        case "pageText":
          p.resolve(m.texts);
          pending.current.delete(m.reqId!);
          break;
        case "pong":
          p.resolve({ buildId: m.buildId });
          pending.current.delete(m.reqId!);
          break;
        case "cancelled":
          p.reject(new Error("cancelled"));
          pending.current.delete(m.reqId!);
          break;
        case "error":
          p.reject(new Error(String(m.message ?? "engine error")));
          pending.current.delete(m.reqId!);
          break;
      }
    },
    [onReady],
  );

  return (
    <View style={visible ? styles.visible : styles.hidden} pointerEvents={visible ? "auto" : "none"}>
      <WebView
        ref={webRef}
        source={{ uri: engineUri }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        // iOS: let the file:// engine read sibling assets (cMaps, worker) and staged PDFs.
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowingReadAccessToURL={documentDirUri()}
        onMessage={onMessage}
        onError={(e) => onLog?.("webview error: " + e.nativeEvent.description)}
        onHttpError={(e) => onLog?.("http " + e.nativeEvent.statusCode)}
        onRenderProcessGone={() => {
          // iOS jettisoned the WebView (e.g. memory) — fail any awaiting requests instead
          // of leaving them to hang forever.
          pending.current.forEach((p) => p.reject(new Error("WebViewが再起動しました。もう一度お試しください。")));
          pending.current.clear();
          onLog?.("webview process gone");
        }}
        style={styles.fill}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  // Offscreen 1x1 so the engine keeps running JS for headless detection.
  hidden: { position: "absolute", left: -9999, top: 0, width: 1, height: 1, opacity: 0 },
  visible: { flex: 1 },
  fill: { flex: 1, backgroundColor: "#fffdf7" },
});
