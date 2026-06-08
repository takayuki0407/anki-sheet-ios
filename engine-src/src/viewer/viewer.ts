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
  /** Revealed card ids to restore from the last session (whole answer reveals together). */
  revealed?: number[];
  /** Starred answer ids (review-only mode masks just these). */
  starred?: number[];
  /** Manual red sheet: whether it was on, and its band position/height, last session. */
  manualOn?: boolean;
  band?: { top: number; height: number };
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
  // Revealed card ids — the whole answer (card) reveals together.
  private revealed = new Set<number>();
  private mode: ViewMode = "scroll";
  private fit: FitMode = "width";
  private zoom = 1;
  private sheetOn = true;
  private current = 0;
  private views: PageView[] = [];
  private io: IntersectionObserver | null = null;
  private scrollRaf = 0;
  // two-finger pinch zoom (smooth: CSS transform during the gesture, real relayout on end)
  private pinch = { active: false, startDist: 1, startZoom: 1, fcx: 0, fcy: 0, scale: 1 };
  // Soft axis lock: scrolling stays fully native, but a near-vertical one-finger swipe (within ~20°
  // of straight up/down) ignores horizontal — scrollLeft is pinned to its gesture-start value so a
  // careless vertical flick doesn't drift sideways. Diagonal/horizontal swipes follow the finger.
  private glock = { x: 0, y: 0, lastX: 0, axis: "none" as "none" | "vlock" | "free" };
  private static readonly VLOCK_TAN = 1.0; // tan(45°)=1: |dx| < |dy| → vertical-dominant → lock
  private contentEl: HTMLElement | null = null;
  // Manual red sheet (縦読み): a draggable / resizable band fixed over the viewport.
  private manualSheetEl: HTMLElement | null = null;
  private manualGripEl: HTMLElement | null = null; // small handle centred on the top edge
  private band = { top: 80, height: 150 };
  // Manual mask editing: masks become outlines tappable to delete; a drag draws a rect (add /
  // 範囲削除). The staged buffer + undo live on the native side; the viewer just shows the cards it
  // is given and reports taps / drawn rects.
  private editMode = false;
  private drawMode: "add" | "delete" | null = null;
  private draw: {
    pageIndex: number;
    left: number;
    top: number;
    w: number;
    x0: number;
    y0: number;
    x: number;
    y: number;
    el: HTMLElement;
  } | null = null;
  // Study tracking: starred answers (long-press a mask) + a review-only mode that masks just them.
  private starred = new Set<number>();
  private starReview = false;
  // touchmove is attached only while pinching / drawing (a non-passive touchmove listener slows the
  // browser's native scroll). One-finger scrolling runs with NO touchmove listener → full Safari-like.
  private moveAttached = false;

  constructor(root: HTMLElement, emit: Emit) {
    this.root = root;
    this.emit = emit;
    this.root.addEventListener("scroll", this.onScroll, { passive: true });
    this.root.addEventListener("touchstart", this.onTouchStart, { passive: false });
    // Passive (no scroll penalty): classifies one-finger swipes for the soft axis lock above.
    this.root.addEventListener("touchmove", this.onMove, { passive: true });
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
    this.revealed = new Set(a.revealed ?? []); // restore last session's reveal state
    this.starred = new Set(a.starred ?? []);
    if (a.band) this.band = { top: a.band.top, height: a.band.height };
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
    this.setManualSheet(a.manualOn ?? false); // restore the manual red sheet if it was on
    requestAnimationFrame(() => this.goToPage(this.current, false));
    this.emit({ type: "book-ready", pageCount: this.pageCount, page: this.current });
  }

  private build(): void {
    this.io?.disconnect();
    this.root.innerHTML = "";
    this.views = [];
    this.root.className = this.mode === "paged" ? "paged" : "";
    this.root.style.display = this.mode === "paged" ? "flex" : "block";

    // All pages live in one wrapper so pinch can scale it (CSS transform) smoothly.
    const content = document.createElement("div");
    content.className = "vcontent";
    this.contentEl = content;
    this.root.appendChild(content);

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
      content.appendChild(el);
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

    // No edge tap-zones: in 横読み the page-flip is driven by the native ‹ › / slider so a tap on a
    // mask near the screen edge reveals/stars it instead of accidentally turning the page.

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
    if (this.manualSheetEl) this.manualReveal(); // layoutMasks rebuilt masks from the set; re-gate
  }

  private layoutMasks(v: PageView, w: number): void {
    const fitScale = w / this.pageW;
    v.maskLayer.innerHTML = "";
    for (const c of v.cards) {
      // ★復習: mask only the starred answers; the rest stay shown (no mask).
      if (this.starReview && !this.editMode && !this.starred.has(c.id)) continue;
      // The whole answer (card) reveals together — a wrapped answer stays one card, while
      // detection keeps genuinely separate answers as separate cards.
      const rev = !this.editMode && this.revealed.has(c.id);
      const starred = !this.editMode && this.starred.has(c.id);
      c.rects.forEach((r, i) => {
        const m = document.createElement("div");
        m.className = this.editMode ? "vmask vedit" : rev ? "vmask revealed" : "vmask";
        m.dataset.cardId = String(c.id);
        m.style.left = `${r.x * fitScale}px`;
        m.style.top = `${r.y * fitScale}px`;
        m.style.width = `${r.w * fitScale}px`;
        m.style.height = `${r.h * fitScale}px`;
        if (starred && i === 0) {
          const badge = document.createElement("span");
          badge.className = "vstar";
          badge.textContent = "★";
          m.appendChild(badge);
        }
        this.attachMaskPress(m, c.id);
        v.maskLayer.appendChild(m);
      });
    }
  }

  // Tap = reveal (delete in edit mode); a ~500ms hold = star (★). A drag cancels both.
  private attachMaskPress(m: HTMLElement, id: number): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let long = false;
    let sx = 0;
    let sy = 0;
    const clear = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    m.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        long = false;
        const t = e.touches[0];
        sx = t.clientX;
        sy = t.clientY;
        clear();
        timer = setTimeout(() => {
          timer = null;
          if (!this.editMode) {
            long = true;
            this.toggleStar(id);
          }
        }, 500);
      },
      { passive: true },
    );
    m.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) clear();
      },
      { passive: true },
    );
    m.addEventListener("touchend", clear, { passive: true });
    m.addEventListener("touchcancel", clear, { passive: true });
    m.onclick = (e) => {
      e.stopPropagation();
      if (long) {
        long = false; // the hold already starred; swallow the click so it doesn't also reveal
        return;
      }
      if (this.editMode) this.emit({ type: "mask-tapped", id });
      else this.toggleCard(id);
    };
  }

  // Flip the star locally + update the ★ badge in place (no relayout → don't destroy the element
  // mid-press) and report it so the native side persists it. The ★復習 filter re-applies on the
  // next natural relayout.
  private toggleStar(id: number): void {
    const on = !this.starred.has(id);
    if (on) this.starred.add(id);
    else this.starred.delete(id);
    for (const v of this.views) {
      v.maskLayer.querySelectorAll(`[data-card-id="${id}"]`).forEach((el, i) => {
        const node = el as HTMLElement;
        node.querySelector(".vstar")?.remove();
        if (on && i === 0 && !this.editMode) {
          const badge = document.createElement("span");
          badge.className = "vstar";
          badge.textContent = "★";
          node.appendChild(badge);
        }
      });
    }
    this.emit({ type: "mask-starred", id, starred: [...this.starred] });
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
    this.emitReveal();
  }

  /** Report the current reveal state so the native screen can persist it across sessions. */
  private emitReveal(): void {
    this.emit({ type: "reveal-changed", revealed: [...this.revealed], sheetOn: this.sheetOn });
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
      if (this.manualSheetEl) this.manualReveal(); // scrolling past the sheet edge reveals answers
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

  // Attach the (non-passive) touchmove handler only while a pinch / draw is in progress, so plain
  // one-finger scrolling never has a non-passive touchmove slowing the native scroller.
  private startMove(): void {
    if (!this.moveAttached) {
      this.root.addEventListener("touchmove", this.onTouchMove, { passive: false });
      this.moveAttached = true;
    }
  }
  private stopMove(): void {
    if (this.moveAttached) {
      this.root.removeEventListener("touchmove", this.onTouchMove);
      this.moveAttached = false;
    }
  }

  // Soft axis lock. Vertical is native (touch-action: pan-y); horizontal is NEVER native, so we
  // drive it here ONLY for a horizontal-dominant swipe (>45° from vertical). A vertical-dominant
  // swipe gets no horizontal at all — nothing to fight or snap back, so vertical stays smooth.
  // Passive (no preventDefault): scrollLeft is independent of the native vertical scroller.
  private onMove = (e: TouchEvent): void => {
    if (this.drawMode || this.pinch.active || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (this.glock.axis === "none") {
      const dx = t.clientX - this.glock.x;
      const dy = t.clientY - this.glock.y;
      if (Math.hypot(dx, dy) < 10) return; // wait until the swipe direction is clear
      // Vertical-dominant (within 45° of vertical) → lock out horizontal; else follow finger (free).
      this.glock.axis = Math.abs(dx) < Math.abs(dy) * Viewer.VLOCK_TAN ? "vlock" : "free";
    }
    if (this.glock.axis === "free") this.root.scrollLeft -= t.clientX - this.glock.lastX;
    this.glock.lastX = t.clientX;
  };

  private onTouchStart = (e: TouchEvent): void => {
    // Reset the soft axis lock for this gesture (classified on the first move; see onMove).
    const ft = e.touches[0];
    this.glock = { x: ft.clientX, y: ft.clientY, lastX: ft.clientX, axis: "none" };
    // Mask editing: a drag draws a rectangle on the page under the finger (add / 範囲削除).
    if (this.editMode && this.drawMode && e.touches.length === 1) {
      const t = e.touches[0];
      const pageEl = (
        document.elementFromPoint(t.clientX, t.clientY) as HTMLElement | null
      )?.closest(".vpage") as HTMLElement | null;
      if (pageEl) {
        const r = pageEl.getBoundingClientRect();
        const el = document.createElement("div");
        el.className = this.drawMode === "delete" ? "vdrawrect del" : "vdrawrect";
        pageEl.appendChild(el);
        const x = t.clientX - r.left;
        const y = t.clientY - r.top;
        this.draw = {
          pageIndex: Number(pageEl.dataset.page),
          left: r.left,
          top: r.top,
          w: r.width,
          x0: x,
          y0: y,
          x,
          y,
          el,
        };
        this.startMove();
        this.positionDraw();
        e.preventDefault();
        return;
      }
    }
    if (e.touches.length >= 2) {
      this.pinch.active = true;
      this.pinch.startDist = this.touchDist(e.touches[0], e.touches[1]) || 1;
      this.pinch.startZoom = this.zoom;
      this.pinch.scale = 1;
      const rect = this.root.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      this.pinch.fcx = this.root.scrollLeft + (cx - rect.left);
      this.pinch.fcy = this.root.scrollTop + (cy - rect.top);
      if (this.contentEl)
        this.contentEl.style.transformOrigin = `${this.pinch.fcx}px ${this.pinch.fcy}px`;
      this.startMove();
      e.preventDefault();
    }
    // One-finger drag → fully native 2D scrolling (browser/UIScrollView); nothing to do here.
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (this.draw && e.touches.length >= 1) {
      const t = e.touches[0];
      this.draw.x = t.clientX - this.draw.left;
      this.draw.y = t.clientY - this.draw.top;
      this.positionDraw();
      e.preventDefault();
      return;
    }
    if (this.pinch.active && e.touches.length >= 2) {
      const d = this.touchDist(e.touches[0], e.touches[1]);
      const target = clamp(this.pinch.startZoom * (d / this.pinch.startDist), 0.5, 4);
      this.pinch.scale = target / this.pinch.startZoom;
      // GPU-composited scale of the whole content — smooth, no per-frame relayout.
      if (this.contentEl) this.contentEl.style.transform = `scale(${this.pinch.scale})`;
      e.preventDefault();
      return;
    }
    // One-finger move → let the browser scroll natively in 2D (Safari-like momentum).
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (this.draw) {
      const d = this.draw;
      this.draw = null;
      d.el.remove();
      const fitScale = d.w / this.pageW;
      const x = Math.min(d.x0, d.x);
      const y = Math.min(d.y0, d.y);
      const rw = Math.abs(d.x - d.x0);
      const rh = Math.abs(d.y - d.y0);
      if (rw > 6 && rh > 6 && fitScale > 0) {
        this.emit({
          type: "draw-rect",
          page: d.pageIndex,
          mode: this.drawMode,
          rect: { x: x / fitScale, y: y / fitScale, w: rw / fitScale, h: rh / fitScale },
        });
      }
      this.drawMode = null;
      this.root.classList.remove("drawing");
    } else if (this.pinch.active && e.touches.length < 2) {
      this.pinch.active = false;
      this.commitPinch();
    }
    if (e.touches.length === 0) this.stopMove(); // all fingers up → back to pure-native scrolling
  };

  /** Commit a pinch: replace the transient transform with a real relayout at the final
   * zoom, keeping the pinch focal content point under the same screen point. */
  private commitPinch(): void {
    const target = clamp(this.pinch.startZoom * this.pinch.scale, 0.5, 4);
    if (this.contentEl) {
      this.contentEl.style.transform = "";
      this.contentEl.style.transformOrigin = "";
    }
    this.pinch.scale = 1;
    if (Math.abs(target - this.zoom) < 0.001) return;
    const fracX = this.pinch.fcx / (this.root.scrollWidth || 1);
    const fracY = this.pinch.fcy / (this.root.scrollHeight || 1);
    const screenX = this.pinch.fcx - this.root.scrollLeft;
    const screenY = this.pinch.fcy - this.root.scrollTop;
    this.zoom = target;
    this.relayout();
    this.root.scrollLeft = fracX * (this.root.scrollWidth || 1) - screenX;
    this.root.scrollTop = fracY * (this.root.scrollHeight || 1) - screenY;
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
    this.emitReveal();
  }

  // ---- manual mask editing ----
  setEditMode(on: boolean): void {
    this.editMode = on;
    if (on) {
      // Edit masks must be visible + tappable regardless of the red mode.
      this.root.classList.remove("sheet-off", "manual");
    } else {
      this.drawMode = null;
      this.root.classList.remove("drawing");
      this.applySheetClass(); // restore sheet-off / manual per the current state
    }
    this.root.classList.toggle("editing", on);
    const w = this.cssW();
    for (const v of this.views) this.layoutMasks(v, w);
  }

  /** Replace the displayed cards — used to push the staged add/delete set while editing. */
  setEditCards(cards: ViewerCard[]): void {
    this.byPage = new Map();
    for (const c of cards) {
      const arr = this.byPage.get(c.pageIndex) ?? [];
      arr.push(c);
      this.byPage.set(c.pageIndex, arr);
    }
    const w = this.cssW();
    for (let i = 0; i < this.views.length; i++) {
      this.views[i].cards = this.byPage.get(i) ?? [];
      this.layoutMasks(this.views[i], w);
    }
  }

  setDrawMode(mode: "add" | "delete" | null): void {
    this.drawMode = mode;
    this.root.classList.toggle("drawing", mode != null);
  }

  // ---- study tracking ----
  setStarred(ids: number[]): void {
    this.starred = new Set(ids);
    const w = this.cssW();
    for (const v of this.views) this.layoutMasks(v, w);
  }

  setStarReview(on: boolean): void {
    this.starReview = on;
    const w = this.cssW();
    for (const v of this.views) this.layoutMasks(v, w);
  }

  private positionDraw(): void {
    const d = this.draw;
    if (!d) return;
    d.el.style.left = `${Math.min(d.x0, d.x)}px`;
    d.el.style.top = `${Math.min(d.y0, d.y)}px`;
    d.el.style.width = `${Math.abs(d.x - d.x0)}px`;
    d.el.style.height = `${Math.abs(d.y - d.y0)}px`;
  }

  private applySheetClass(): void {
    // In 赤シート (manual band) mode the detection masks stay visible and the band's position
    // decides what's revealed — so don't blank them with sheet-off; mark the root "manual" so
    // the masks become non-interactive (the page scrolls through them).
    this.root.classList.toggle("sheet-off", !this.sheetOn && !this.manualSheetEl);
    this.root.classList.toggle("manual", !!this.manualSheetEl);
  }

  /** Toggle the manual red sheet — a band slid over the page (縦読み). Fixed to the viewport.
   * The band itself only tints; the detection masks do the hiding, gated by the band position. */
  setManualSheet(on: boolean): void {
    if (on === !!this.manualSheetEl) return;
    if (!on) {
      this.manualSheetEl?.remove();
      this.manualGripEl?.remove();
      this.manualSheetEl = null;
      this.manualGripEl = null;
      this.applySheetClass(); // drop "manual"; masks go back to sheetOn / tap-reveal behaviour
      const w = this.cssW();
      for (const v of this.views) this.layoutMasks(v, w); // restore the tap-based reveal state
      return;
    }
    const sheet = document.createElement("div");
    sheet.className = "rsheet";
    document.body.appendChild(sheet);
    this.manualSheetEl = sheet;
    // A small handle centred on the top edge resizes it; the sheet body is pointer-events:none so
    // touches fall through for scrolling/paging.
    const grip = document.createElement("div");
    grip.className = "rsheet-grip";
    document.body.appendChild(grip);
    this.attachSheetDrag(grip);
    this.manualGripEl = grip;
    this.applySheetClass(); // masks visible + non-interactive (the band controls reveal)
    this.layoutManualSheet();
    this.manualReveal(); // reveal/cover the masks for the band's current position
  }

  private layoutManualSheet(): void {
    if (!this.manualSheetEl || !this.manualGripEl) return;
    this.manualSheetEl.style.top = `${this.band.top}px`; // bottom pinned via CSS (bottom: 0)
    this.manualGripEl.style.top = `${this.band.top - 10}px`; // centred on the TOP edge (height 20)
  }

  /** Reveal answers above the sheet's top edge and cover those below it — like sliding a physical
   * red sheet. Only the red detection masks change; the black body text is never touched. Cheap:
   * pure arithmetic from offsets (no getBoundingClientRect), and skips off-screen pages. */
  private manualReveal(): void {
    if (!this.manualSheetEl || this.mode !== "scroll" || this.pinch.active) return;
    const scrollTop = this.root.scrollTop;
    const vh = this.root.clientHeight || 1;
    const line = this.band.top; // the band's top edge, in viewport coordinates
    for (const v of this.views) {
      const pageTop = v.el.offsetTop - scrollTop; // viewport Y of this page's top
      if (pageTop + v.el.offsetHeight < -40 || pageTop > vh + 40) continue; // off-screen
      const masks = v.maskLayer.children;
      for (let j = 0; j < masks.length; j++) {
        const m = masks[j] as HTMLElement;
        const cy = pageTop + parseFloat(m.style.top) + parseFloat(m.style.height) / 2;
        m.classList.toggle("revealed", cy < line); // above the edge -> revealed
      }
    }
  }

  // The grip drags the TOP edge; the bottom edge stays pinned to the viewport bottom.
  private attachSheetDrag(el: HTMLElement): void {
    let startY = 0;
    let startTop = 0;
    let active = false;
    el.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        active = true;
        startY = e.touches[0].clientY;
        startTop = this.band.top;
        e.preventDefault();
        e.stopPropagation();
      },
      { passive: false },
    );
    el.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (!active || e.touches.length !== 1) return;
        const vh = window.innerHeight || 1;
        this.band.top = Math.max(0, Math.min(vh - 28, startTop + (e.touches[0].clientY - startY)));
        this.band.height = vh - this.band.top;
        this.layoutManualSheet();
        this.manualReveal(); // re-reveal/cover as the sheet's top edge moves
        e.preventDefault();
        e.stopPropagation();
      },
      { passive: false },
    );
    const end = () => {
      if (active) this.emit({ type: "band-changed", top: this.band.top, height: this.band.height });
      active = false;
    };
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }

  private destroyDoc(): void {
    this.setManualSheet(false);
    this.io?.disconnect();
    this.io = null;
    if (this.scrollRaf) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    this.stopMove();
    if (this.doc) {
      this.doc.loadingTask.destroy().catch(() => undefined);
      this.doc = null;
    }
    this.root.innerHTML = "";
    this.views = [];
  }
}
