// App-wide headless detection engine. Mounts one hidden WebView (the pdf.js engine) for
// the whole app so any screen can run import detection / cover rendering without
// re-extracting or reloading. The visible red-sheet viewer (M2) uses its own engine
// instance in viewer mode.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DeckColorConfig } from "../types";
import { EngineWebView, type EngineHandle } from "./EngineWebView";
import { ensureEngine } from "./setupEngine";
import type { DetectProgress, PdfDetectionResult } from "./protocol";

interface EngineApi {
  ready: boolean;
  buildId: string | null;
  error: string | null;
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
}

const Ctx = createContext<EngineApi | null>(null);

export function useDetectionEngine(): EngineApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDetectionEngine must be used within EngineProvider");
  return c;
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const [engineUri, setEngineUri] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<EngineHandle>(null);

  useEffect(() => {
    ensureEngine()
      .then(setEngineUri)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const detectAll = useCallback<EngineApi["detectAll"]>((args, onProgress, signal) => {
    if (!ref.current) return Promise.reject(new Error("エンジン準備中です"));
    return ref.current.detectAll(args, onProgress, signal);
  }, []);

  const cover = useCallback<EngineApi["cover"]>((args) => {
    if (!ref.current) return Promise.reject(new Error("エンジン準備中です"));
    return ref.current.cover(args);
  }, []);

  const preview = useCallback<EngineApi["preview"]>((args) => {
    if (!ref.current) return Promise.reject(new Error("エンジン準備中です"));
    return ref.current.preview(args);
  }, []);

  const pageText = useCallback<EngineApi["pageText"]>((args) => {
    if (!ref.current) return Promise.reject(new Error("エンジン準備中です"));
    return ref.current.pageText(args);
  }, []);

  return (
    <Ctx.Provider value={{ ready, buildId, error, detectAll, cover, preview, pageText }}>
      {children}
      {engineUri && (
        <EngineWebView
          ref={ref}
          engineUri={engineUri}
          visible={false}
          onReady={(b) => {
            setBuildId(b);
            setReady(true);
          }}
        />
      )}
    </Ctx.Provider>
  );
}
