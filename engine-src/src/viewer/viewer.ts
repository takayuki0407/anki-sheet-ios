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
  // one-finger axis-locked pan + inertial fling (ported from the original viewerGestures)
  private pan = {
    active: false,
    mode: "none" as "none" | "vertical" | "free",
    panned: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    vx: 0,
    vy: 0,
    raf: 0,
  };
  // two-finger pinch zoom
  private pinch = { active: false, startDist: 1, startZoom: 1 };

  constructor(root: HTMLElement, emit: Emit) {
    this.root = root;
    this.emit = emit;
    this.root.addEventListener("scroll", this.onScroll, { passive: true });
    this.root.addEventListener("touchstart", this.onTouchStart, { passive: false });
    this.root.addEventListener("touchmove", this.onTouchMove, { passive: false });
    this.root.addEventListener("touchend", this.onTouchEnd, { passive: true });
    this.root.addEventListener("touchcancel", this.onTouchEnd, { passive: true });
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

  // ---- touch gestures: axis-locked one-finger pan + fling, two-finger pinch zoom ----

  private touchDist(a: Touch, b: Touch): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private stopFling(): void {
    if (this.pan.raf) cancelAnimationFrame(this.pan.raf);
    this.pan.raf = 0;
  }

  private onTouchStart = (e: TouchEvent): void => {
    this.stopFling();
    if (e.touches.length >= 2) {
      this.pan.active = false;
      this.pinch.active = true;
      this.pinch.startDist = this.touchDist(e.touches[0], e.touches[1]) || 1;
      this.pinch.startZoom = this.zoom;
      e.preventDefault();
      return;
    }
    const t = e.touches[0];
    this.pan.active = true;
    this.pan.mode = "none";
    this.pan.panned = false;
    this.pan.startX = this.pan.lastX = t.clientX;
    this.pan.startY = this.pan.lastY = t.clientY;
    this.pan.vx = this.pan.vy = 0;
    this.pan.lastT = performance.now();
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (this.pinch.active && e.touches.length >= 2) {
      const d = this.touchDist(e.touches[0], e.touches[1]);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      this.zoomAt(clamp(this.pinch.startZoom * (d / this.pinch.startDist), 0.5, 4), cx, cy);
      e.preventDefault();
      return;
    }
    if (!this.pan.active || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (this.pan.mode === "none") {
      const dx = t.clientX - this.pan.startX;
      const dy = t.clientY - this.pan.startY;
      if (Math.hypot(dx, dy) < 6) return; // a tap (under threshold) still clicks a mask
      // initial drag steeper than 45deg -> vertical-only (no sideways drift); else free 2D
      this.pan.mode = Math.abs(dx) >= Math.abs(dy) ? "free" : "vertical";
      this.pan.panned = true;
    }
    const now = performance.now();
    const dt = Math.max(1, now - this.pan.lastT);
    const mdx = t.clientX - this.pan.lastX;
    const mdy = t.clientY - this.pan.lastY;
    this.pan.lastX = t.clientX;
    this.pan.lastY = t.clientY;
    this.pan.lastT = now;
    this.pan.vy = 0.8 * (mdy / dt) + 0.2 * this.pan.vy;
    this.pan.vx = this.pan.mode === "free" ? 0.8 * (mdx / dt) + 0.2 * this.pan.vx : 0;
    this.root.scrollTop -= mdy;
    if (this.pan.mode === "free") this.root.scrollLeft -= mdx;
    e.preventDefault();
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (this.pinch.active) {
      if (e.touches.length >= 2) return;
      this.pinch.active = false;
      if (e.touches.length === 1) {
        const t = e.touches[0]; // one finger remains -> begin a fresh pan from it
        this.pan.active = true;
        this.pan.mode = "none";
        this.pan.panned = false;
        this.pan.startX = this.pan.lastX = t.clientX;
        this.pan.startY = this.pan.lastY = t.clientY;
        this.pan.lastT = performance.now();
      }
      return;
    }
    if (!this.pan.active || e.touches.length > 0) return;
    this.pan.active = false;
    if (!this.pan.panned) return;
    // swallow the click some WebKit builds synthesize after a drag (don't toggle a mask)
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    this.root.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => this.root.removeEventListener("click", swallow, true), 0);
    if (performance.now() - this.pan.lastT > 80) this.pan.vx = this.pan.vy = 0;
    let mvx = clamp(this.pan.vx, -5, 5);
    let mvy = clamp(this.pan.vy, -5, 5);
    if (Math.hypot(mvx, mvy) < 0.05) return;
    let prev = performance.now();
    const step = (): void => {
      const now = performance.now();
      const dt = now - prev;
      prev = now;
      const decay = Math.pow(0.997, dt);
      mvx *= decay;
      mvy *= decay;
      const bt = this.root.scrollTop;
      const bl = this.root.scrollLeft;
      this.root.scrollTop -= mvy * dt;
      if (this.pan.mode === "free") this.root.scrollLeft -= mvx * dt;
      const moved = this.root.scrollTop !== bt || this.root.scrollLeft !== bl;
      this.pan.raf = moved && Math.hypot(mvx, mvy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    this.pan.raf = requestAnimationFrame(step);
  };

  /** Zoom toward a screen point (pinch), keeping that content point under the fingers. */
  private zoomAt(nz: number, cx: number, cy: number): void {
    if (Math.abs(nz - this.zoom) < 0.001) return;
    const rect = this.root.getBoundingClientRect();
    const fracX = (this.root.scrollLeft + (cx - rect.left)) / (this.root.scrollWidth || 1);
    const fracY = (this.root.scrollTop + (cy - rect.top)) / (this.root.scrollHeight || 1);
    this.zoom = clamp(nz, 0.5, 4);
    this.relayout();
    this.root.scrollLeft = fracX * (this.root.scrollWidth || 1) - (cx - rect.left);
    this.root.scrollTop = fracY * (this.root.scrollHeight || 1) - (cy - rect.top);
    this.emit({ type: "zoom-changed", zoom: this.zoom });
  }

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
    this.emit({ type: "zoom-changed", zoom: this.zoom });
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
    this.stopFling();
    if (this.doc) {
      this.doc.loadingTask.destroy().catch(() => undefined);
      this.doc = null;
    }
    this.root.innerHTML = "";
    this.views = [];
  }
}
