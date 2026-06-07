// In-WebView red-sheet viewer. Renders PDF pages to canvases and overlays the red-sheet
// masks over each detected answer (page coordinates * fitScale), reusing the exact
// mapping the original PageOverlay used. Native scrolling drives 縦読み (scroll mode);
// left/right tap zones drive 横読み (paged mode). The React Native screen supplies the
// chrome (page slider, zoom, fit, sheet toggle) by calling the public methods here, and
// receives page-changed / book-ready events to update its controls and persist position.
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf, renderPage } from "../pdf/pdfEngine";
import { loadText, pdfBytes } from "../io";
import type { Rect } from "../types";

export interface ViewerCard {
  id: number;
  pageIndex: number;
  rects: Rect[];
}

export interface OpenBookArgs {
  url?: string;
  base64?: string;
  pageCount: number;
  pageW: number;
  pageH: number;
  /** Answer rects inline, or (preferred for large books) a file:// URL to their JSON. */
  cards?: ViewerCard[];
  cardsUrl?: string;
  mode?: ViewMode;
  page?: number;
  fit?: FitMode;
  zoom?: number;
  sheetOn?: boolean;
}

export type ViewMode = "scroll" | "paged";
export type FitMode = "width" | "page";
type Emit = (msg: Record<string, unknown>) => void;

const MAX_DEVICE_W = 2800; // cap rendered bitmap width (memory)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface PageView {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  maskLayer: HTMLElement;
  rendered: boolean;
  rendering: boolean;
  dirty: boolean;
  token: number;
  cards: ViewerCard[];
}

export class Viewer {
  private root: HTMLElement;
  private emit: Emit;
  private doc: PDFDocumentProxy | null = null;
  private pageCount = 0;
  private pageW = 1;
  private pageH = 1;
  private aspect = 0.7;
  private byPage = new Map<number, ViewerCard[]>();
  private revealed = new Set<number>();
  private mode: ViewMode = "scroll";
  private fit: FitMode = "width";
  private zoom = 1;
  private sheetOn = true;
  private current = 0;
  private views: PageView[] = [];
  private io: IntersectionObserver | null = null;
  private scrollRaf = 0;

  constructor(root: HTMLElement, emit: Emit) {
    this.root = root;
    this.emit = emit;
    this.root.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
  }

  async open(a: OpenBookArgs): Promise<void> {
    this.destroyDoc();
    const data = await pdfBytes(a);
    this.doc = await loadPdf(data);
    this.pageCount = a.pageCount || this.doc.numPages;
    this.pageW = a.pageW || 1;
    this.pageH = a.pageH || 1;
    this.aspect = this.pageH > 0 ? this.pageW / this.pageH : 0.7;
    this.mode = a.mode ?? "scroll";
    this.fit = a.fit ?? "width";
    this.zoom = a.zoom ?? 1;
    this.sheetOn = a.sheetOn ?? true;
    this.revealed.clear();
    this.current = clamp(a.page ?? 0, 0, this.pageCount - 1);

    let cards: ViewerCard[] = [];
    try {
      cards = a.cardsUrl ? (JSON.parse(await loadText(a.cardsUrl)) as ViewerCard[]) : (a.cards ?? []);
    } catch {
      cards = []; // masks are non-essential — render the PDF even if the rects fail to load
    }
    this.byPage = new Map();
    for (const c of cards) {
      const arr = this.byPage.get(c.pageIndex) ?? [];
      arr.push(c);
      this.byPage.set(c.pageIndex, arr);
    }

    this.build();
    this.applySheetClass();
    this.relayout();
    requestAnimationFrame(() => this.goToPage(this.current, false));
    this.emit({ type: "book-ready", pageCount: this.pageCount, page: this.current });
  }

  private build(): void {
    this.io?.disconnect();
    this.root.innerHTML = "";
    this.views = [];
    this.root.className = this.mode === "paged" ? "paged" : "";
    this.root.style.display = this.mode === "paged" ? "flex" : "block";

    for (let i = 0; i < this.pageCount; i++) {
      const el = document.createElement("div");
      el.className = "vpage";
      el.dataset.page = String(i);
      const canvas = document.createElement("canvas");
      canvas.className = "vcanvas";
      const maskLayer = document.createElement("div");
      maskLayer.className = "vmasks";
      el.appendChild(canvas);
      el.appendChild(maskLayer);
      this.root.appendChild(el);
      this.views.push({
        el,
        canvas,
        maskLayer,
        rendered: false,
        rendering: false,
        dirty: false,
        token: 0,
        cards: this.byPage.get(i) ?? [],
      });
    }

    if (this.mode === "paged") {
      const left = document.createElement("div");
      left.className = "tapzone left";
      left.onclick = () => this.goToPage(this.current - 1);
      const right = document.createElement("div");
      right.className = "tapzone right";
      right.onclick = () => this.goToPage(this.current + 1);
      this.root.appendChild(left);
      this.root.appendChild(right);
    }

    this.io = new IntersectionObserver(this.onIntersect, {
      root: this.root,
      rootMargin: this.mode === "paged" ? "0px" : "150% 0px",
    });
    for (const v of this.views) this.io.observe(v.el);
  }

  private cssW(): number {
    const cw = this.root.clientWidth || 1;
    const ch = this.root.clientHeight || 1;
    const base = this.fit === "page" ? Math.min(cw, ch * this.aspect) : cw;
    return Math.max(1, base * this.zoom);
  }

  private relayout(): void {
    const w = this.cssW();
    const h = w / this.aspect;
    for (const v of this.views) {
      v.el.style.width = `${w}px`;
      v.el.style.height = `${h}px`;
      this.layoutMasks(v, w);
      v.token++; // invalidate any in-flight render queued at the old scale
      v.rendered = false; // scale changed; bitmap is stale (CSS still scales it meanwhile)
      if (v.rendering) v.dirty = true; // re-render once the in-flight render bails out
    }
    this.renderVisible();
  }

  private layoutMasks(v: PageView, w: number): void {
    const fitScale = w / this.pageW;
    v.maskLayer.innerHTML = "";
    for (const c of v.cards) {
      const rev = this.revealed.has(c.id);
      for (const r of c.rects) {
        const m = document.createElement("div");
        m.className = rev ? "vmask revealed" : "vmask";
        m.dataset.cardId = String(c.id);
        m.style.left = `${r.x * fitScale}px`;
        m.style.top = `${r.y * fitScale}px`;
        m.style.width = `${r.w * fitScale}px`;
        m.style.height = `${r.h * fitScale}px`;
        m.onclick = (e) => {
          e.stopPropagation();
          this.toggleCard(c.id);
        };
        v.maskLayer.appendChild(m);
      }
    }
  }

  private toggleCard(id: number): void {
    if (!this.sheetOn) return; // nothing to reveal when the sheet is off
    const rev = !this.revealed.has(id);
    if (rev) this.revealed.add(id);
    else this.revealed.delete(id);
    for (const v of this.views) {
      v.maskLayer.querySelectorAll(`[data-card-id="${id}"]`).forEach((n) => {
        (n as HTMLElement).classList.toggle("revealed", rev);
      });
    }
  }

  private async renderView(v: PageView, index: number): Promise<void> {
    if (!this.doc || v.rendering || v.rendered) return;
    v.rendering = true;
    v.dirty = false;
    const token = ++v.token;
    const dpr = window.devicePixelRatio || 1;
    const renderScale = Math.min((this.cssW() / this.pageW) * dpr, MAX_DEVICE_W / this.pageW);
    try {
      const page = await this.doc.getPage(index + 1);
      if (token !== v.token) {
        page.cleanup();
        return;
      }
      await renderPage(page, renderScale, v.canvas, () => token !== v.token);
      page.cleanup();
      if (token === v.token) v.rendered = true;
    } catch {
      /* a single page failing to render must not break the viewer */
    } finally {
      v.rendering = false;
      // A relayout (zoom/fit/resize) during the render marked us dirty — redo at new scale.
      if (v.dirty) {
        v.dirty = false;
        void this.renderView(v, index);
      }
    }
  }

  private freeView(v: PageView): void {
    v.rendered = false;
    v.dirty = false; // don't let an in-flight render's finally re-raster a page we just freed
    v.token++;
    v.canvas.width = 0;
    v.canvas.height = 0;
  }

  private renderVisible(): void {
    const top = this.root.scrollTop;
    const bottom = top + this.root.clientHeight;
    const margin = this.root.clientHeight;
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      if (this.mode === "paged" && i !== this.current) continue;
      const eTop = v.el.offsetTop;
      const eBottom = eTop + v.el.offsetHeight;
      if (eBottom >= top - margin && eTop <= bottom + margin) this.renderView(v, i);
    }
  }

  private onIntersect = (entries: IntersectionObserverEntry[]): void => {
    for (const e of entries) {
      const idx = Number((e.target as HTMLElement).dataset.page);
      const v = this.views[idx];
      if (!v) continue;
      if (e.isIntersecting) this.renderView(v, idx);
      else this.freeView(v);
    }
  };

  private onScroll = (): void => {
    if (this.mode !== "scroll" || this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const mid = this.root.scrollTop + this.root.clientHeight / 2;
      let best = this.current;
      for (let i = 0; i < this.views.length; i++) {
        const v = this.views[i];
        if (v.el.offsetTop <= mid && v.el.offsetTop + v.el.offsetHeight >= mid) {
          best = i;
          break;
        }
      }
      if (best !== this.current) {
        this.current = best;
        this.emit({ type: "page-changed", page: best });
      }
    });
  };

  private onResize = (): void => {
    this.relayout();
    if (this.mode === "scroll") {
      const v = this.views[this.current];
      if (v) this.root.scrollTop = v.el.offsetTop;
    }
  };

  // ---- public command surface (called from the bridge) ----

  goToPage(n: number, doEmit = true): void {
    const p = clamp(n, 0, this.pageCount - 1);
    this.current = p;
    if (this.mode === "scroll") {
      const v = this.views[p];
      if (v) this.root.scrollTop = v.el.offsetTop;
    } else {
      for (let i = 0; i < this.views.length; i++) {
        this.views[i].el.style.display = i === p ? "" : "none";
      }
      const v = this.views[p];
      if (v) this.renderView(v, p);
    }
    if (doEmit) this.emit({ type: "page-changed", page: p });
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const cur = this.current;
    this.build();
    this.applySheetClass();
    this.relayout();
    requestAnimationFrame(() => this.goToPage(cur, false));
    this.emit({ type: "mode-changed", mode });
  }

  setFit(fit: FitMode): void {
    this.fit = fit;
    this.relayout();
    this.goToPage(this.current, false);
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.5, 4);
    this.relayout();
    if (this.mode === "scroll") {
      const v = this.views[this.current];
      if (v) this.root.scrollTop = v.el.offsetTop;
    }
  }

  setSheet(on: boolean): void {
    this.sheetOn = on;
    if (on) this.revealed.clear();
    this.applySheetClass();
    const w = this.cssW();
    for (const v of this.views) this.layoutMasks(v, w);
  }

  private applySheetClass(): void {
    this.root.classList.toggle("sheet-off", !this.sheetOn);
  }

  private destroyDoc(): void {
    this.io?.disconnect();
    this.io = null;
    if (this.scrollRaf) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    if (this.doc) {
      this.doc.loadingTask.destroy().catch(() => undefined);
      this.doc = null;
    }
    this.root.innerHTML = "";
    this.views = [];
  }
}
