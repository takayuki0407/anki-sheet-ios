// 赤シートビューア — hosts the WebView viewer and supplies native chrome (back/settings,
// page nav, zoom with one-tap 100% reset, 幅/全体 fit, sheet/mode toggles, 目次 bookmarks
// with custom names + editing). Pinch-zoom and axis-locked panning are handled in-engine.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useApp } from "../store/session";
import { ensureEngine, stageJson } from "../engine/setupEngine";
import {
  ViewerWebView,
  type ViewerEditCard,
  type ViewerHandle,
  type ViewerOpenArgs,
} from "../engine/ViewerWebView";
import {
  addBookmark,
  addCard,
  deckCards,
  deleteBookmark,
  deleteCard,
  firstAnswerPage,
  getClozeTomb,
  getDeck,
  getDeckPdf,
  getMeta,
  listBookmarks,
  renameBookmark,
  replaceBookmarks,
  setMeta,
  updateDeck,
} from "../db/repo";
import type { BookmarkRow, CardRow, ReadMode } from "../db/rows";
import type { Rect } from "../types";
import { getProgress, idToken, putProgress } from "../sync/api";
import {
  type StarMap,
  type BmMap,
  normalize,
  mergeBlobs,
  activeStarKeys,
  activeBookmarks,
  setActiveStars,
  addBm as bmAdd,
  removeBm as bmRemove,
} from "../sync/progressMerge";
import { deckBookId, refreshContent, uploadContent } from "../sync/deck";
import { cardKey, cardKeyMaps } from "../sync/cardKeys";
import { colors } from "../ui/theme";


/** Do two page-coordinate rects overlap? (used by 範囲一括削除). */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function Tool({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tool, on && styles.toolOn]} onPress={onPress} hitSlop={6}>
      <Text style={[styles.toolTxt, on && styles.toolTxtOn]}>{label}</Text>
    </Pressable>
  );
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Pure-JS page slider (no native dependency): drag to scrub, bubble previews the target page,
 * the jump fires on release. */
function PageSlider({
  page,
  pageCount,
  onSeek,
}: {
  page: number;
  pageCount: number;
  onSeek: (p: number) => void;
}) {
  const [trackW, setTrackW] = useState(0);
  const [drag, setDrag] = useState<number | null>(null); // 0..1 while scrubbing
  const wrapRef = useRef<View>(null);
  // max is floored to 1 only for the percentage math — seeks are clamped to the REAL last page
  // (a 1-page book must not be able to seek to page 2).
  const live = useRef({ trackW: 0, trackX: 0, pct: 0, max: 1, last: 0, onSeek });
  live.current.trackW = trackW;
  live.current.max = Math.max(1, pageCount - 1);
  live.current.last = Math.max(0, pageCount - 1);
  live.current.onSeek = onSeek;

  // Track origin in WINDOW coordinates. Positions must be computed from the absolute pageX —
  // locationX is relative to whichever CHILD the finger lands on, so grabbing the thumb itself
  // would read ~0 and jump the book to page 1.
  const measure = () => {
    wrapRef.current?.measureInWindow((x) => {
      if (typeof x === "number") live.current.trackX = x;
    });
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        measure(); // refresh for subsequent moves (layout may have shifted)
        const p = clamp01(
          (e.nativeEvent.pageX - live.current.trackX) / Math.max(1, live.current.trackW),
        );
        live.current.pct = p;
        setDrag(p);
      },
      onPanResponderMove: (e) => {
        const p = clamp01(
          (e.nativeEvent.pageX - live.current.trackX) / Math.max(1, live.current.trackW),
        );
        live.current.pct = p;
        setDrag(p);
      },
      onPanResponderRelease: () => {
        setDrag(null);
        live.current.onSeek(
          Math.min(live.current.last, Math.round(live.current.pct * live.current.max)),
        );
      },
      onPanResponderTerminate: () => setDrag(null),
    }),
  ).current;

  const pct = drag ?? page / live.current.max;
  const thumbX = Math.max(0, pct * trackW - 9);
  const bubbleX = Math.max(0, Math.min(trackW - 56, pct * trackW - 28));
  return (
    <View
      ref={wrapRef}
      style={styles.sliderWrap}
      onLayout={(e) => {
        setTrackW(e.nativeEvent.layout.width);
        measure();
      }}
      {...pan.panHandlers}
    >
      <View style={styles.sliderTrack} />
      <View style={[styles.sliderFill, { width: Math.max(0, pct * trackW) }]} />
      <View style={[styles.sliderThumb, { left: thumbX }, drag !== null && styles.sliderThumbOn]} />
      {drag !== null ? (
        <View style={[styles.sliderBubble, { left: bubbleX }]}>
          <Text style={styles.sliderBubbleTxt}>
            P.{Math.min(live.current.last, Math.round(pct * live.current.max)) + 1}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function PageViewer({ deckId }: { deckId: number }) {
  const setView = useApp((s) => s.setView);
  const ref = useRef<ViewerHandle>(null);
  const [engineUri, setEngineUri] = useState<string | null>(null);
  const [openArgs, setOpenArgs] = useState<ViewerOpenArgs | null>(null);
  const [name, setName] = useState("");
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [mode, setMode] = useState<ReadMode>("scroll");
  const [zoom, setZoom] = useState(1);
  const [redMode, setRedMode] = useState<"mask" | "sheet" | "off">("mask");
  const [err, setErr] = useState<string | null>(null);
  // Manual mask editing (staged buffer; saved/cancelled explicitly, like the web version).
  type EditAdd = { tempId: number; pageIndex: number; rect: Rect };
  const [editMode, setEditMode] = useState(false);
  const [drawMode, setDrawMode] = useState<"add" | "delete" | null>(null);
  const [editAdds, setEditAdds] = useState<EditAdd[]>([]);
  const [editDels, setEditDels] = useState<Set<number>>(new Set());
  const [editHistory, setEditHistory] = useState<{ adds: EditAdd[]; dels: Set<number> }[]>([]);
  const tempIdRef = useRef(-1);
  const pdfIdRef = useRef(0);
  // Study tracking: starred answers (long-press a mask) + a review-only mode.
  const [starred, setStarred] = useState<Set<number>>(new Set());
  const [starMode, setStarMode] = useState(false);
  const [bmOpen, setBmOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealStateRef = useRef<{
    revealed: number[];
    redMode: "mask" | "sheet" | "off";
    band: { top: number; height: number };
  }>({ revealed: [], redMode: "mask", band: { top: 80, height: 150 } });
  // Cross-device progress sync (Pro): bookId + cards (for reveal keys) + last-write-wins timestamp,
  // and a live mirror of page/mode for the debounced push.
  const bookIdRef = useRef<string | undefined>(undefined);
  const cardsRef = useRef<CardRow[]>([]);
  const progressAtRef = useRef(0);
  const pmRef = useRef<{ page: number; mode: ReadMode }>({ page: 0, mode: "scroll" });
  const starredRef = useRef<number[]>([]); // latest starred ids for the debounced progress push
  const starMapRef = useRef<StarMap>({}); // ★ LWW-element-set (key -> {t,d}) for §4.2 merge sync
  const bmMapRef = useRef<BmMap>({}); // しおり LWW-element-set
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [uri, deck, pdf] = await Promise.all([
          ensureEngine(),
          getDeck(deckId),
          getDeckPdf(deckId),
        ]);
        if (!alive) return;
        if (!deck || !pdf) {
          setErr("デッキが見つかりません");
          return;
        }
        pdfIdRef.current = pdf.id;
        // Pro: pull newer masks from the cloud BEFORE reading cards (last-write-wins; fail-open so
        // signed-out / offline / no-change just keeps the local set).
        await refreshContent(deckId).catch(() => {});
        if (!alive) return;
        const [cards, revealRaw, starRaw, starsLwwRaw, bmLwwRaw] = await Promise.all([
          deckCards(deckId),
          getMeta(`reveal:${deckId}`),
          getMeta(`star:${deckId}`),
          getMeta(`starsLww:${deckId}`),
          getMeta(`bmLww:${deckId}`),
        ]);
        if (!alive) return;
        let startPage = deck.lastPage ?? (await firstAnswerPage(deckId));
        let startMode: ReadMode = deck.lastMode ?? "scroll";
        // Restore the red overlay (mode + reveals + band) from last session.
        let savedRevealed: number[] = [];
        let savedMode: "mask" | "sheet" | "off" = "mask";
        let savedBand = { top: 80, height: 150 };
        if (revealRaw) {
          try {
            const o = JSON.parse(revealRaw) as {
              revealed?: number[];
              redMode?: "mask" | "sheet" | "off";
              sheetOn?: boolean;
              band?: { top: number; height: number };
            };
            savedRevealed = o.revealed ?? [];
            savedMode = o.redMode ?? (o.sheetOn === false ? "off" : "mask");
            if (o.band) savedBand = o.band;
          } catch {
            /* ignore corrupt state */
          }
        }
        let savedStarred: number[] = [];
        if (starRaw) {
          try {
            savedStarred = JSON.parse(starRaw) as number[];
          } catch {
            /* ignore corrupt state */
          }
        }
        cardsRef.current = cards;
        bookIdRef.current = await deckBookId(deckId);
        progressAtRef.current = Number(await getMeta(`progressAt:${deckId}`)) || 0;
        const { idToKey, keyToId } = cardKeyMaps(cards);
        const toIds = (keys: string[]) =>
          keys.map((k) => keyToId.get(k)).filter((x): x is number => x != null);
        const toKeys = (ids: number[]) =>
          ids.map((i) => idToKey.get(i)).filter((x): x is string => !!x);
        // ★・しおり sync as LWW-element-sets (§4.2): per-key tombstones so a delete on one device
        // isn't undone by another's stale set. Load the local maps; seed them (stamped "now", so the
        // user's existing local picks survive migration) for pre-§4.2 installs that only have the old
        // id-array / bookmark table.
        let starMap: StarMap = {};
        let bmMap: BmMap = {};
        try {
          if (starsLwwRaw) starMap = JSON.parse(starsLwwRaw) as StarMap;
        } catch {
          /* ignore corrupt map */
        }
        try {
          if (bmLwwRaw) bmMap = JSON.parse(bmLwwRaw) as BmMap;
        } catch {
          /* ignore corrupt map */
        }
        const seedAt = Date.now();
        // The ★ key scheme is page:y:x:w:h (5 parts); any other shape (old ordinal / earlier 3-part
        // position key) is legacy and won't resolve — rebuild from the local id set so ★ survive.
        const starLegacy = Object.keys(starMap).some((k) => k.split(":").length !== 5);
        if (!starsLwwRaw || starLegacy) {
          starMap = {};
          setActiveStars(starMap, toKeys(savedStarred), seedAt);
        }
        if (!bmLwwRaw)
          for (const b of await listBookmarks(deckId)) bmAdd(bmMap, b.title, b.pageIndex, seedAt);
        // Pro cross-device progress: MERGE the cloud blob into our local one (position resolves by
        // posAt; ★・しおり per-key LWW). Fail-open: signed-out / offline just keeps local.
        if (bookIdRef.current && (await idToken())) {
          const cloud = await getProgress(bookIdRef.current).catch(() => null);
          if (alive && cloud) {
            const localNorm = normalize(
              {
                lastPage: startPage,
                lastMode: startMode,
                redMode: savedMode,
                sheetBand: savedBand,
                revealedKeys: toKeys(savedRevealed),
                posAt: progressAtRef.current,
                starsLww: starMap,
                bmLww: bmMap,
              },
              seedAt,
            );
            const merged = mergeBlobs(localNorm, normalize(cloud.data, cloud.updatedAt));
            starMap = merged.starsLww ?? {};
            bmMap = merged.bmLww ?? {};
            if (typeof merged.lastPage === "number")
              startPage = Math.max(0, Math.min(pdf.pageCount - 1, merged.lastPage));
            if (merged.lastMode) startMode = merged.lastMode;
            if (merged.redMode) savedMode = merged.redMode;
            if (merged.sheetBand) savedBand = merged.sheetBand;
            if (merged.revealedKeys) {
              // Keep local reveals when the cloud set is non-empty but fully unresolvable (legacy
              // ordinal keys after the §4.4 key change) — don't let it wipe them.
              const rids = toIds(merged.revealedKeys);
              if (merged.revealedKeys.length === 0 || rids.length > 0) savedRevealed = rids;
            }
            savedStarred = toIds(activeStarKeys(merged));
            progressAtRef.current = merged.posAt ?? progressAtRef.current;
            void replaceBookmarks(deckId, activeBookmarks(merged)).catch(() => {});
            void setMeta(`star:${deckId}`, JSON.stringify(savedStarred));
            void updateDeck(deckId, { lastPage: startPage, lastMode: startMode });
            void setMeta(
              `reveal:${deckId}`,
              JSON.stringify({ revealed: savedRevealed, redMode: savedMode, band: savedBand }),
            );
            void setMeta(`progressAt:${deckId}`, String(progressAtRef.current));
          }
        }
        // Persist the (seeded or merged) maps; refs feed the debounced push + on-close push.
        starMapRef.current = starMap;
        bmMapRef.current = bmMap;
        void setMeta(`starsLww:${deckId}`, JSON.stringify(starMap));
        void setMeta(`bmLww:${deckId}`, JSON.stringify(bmMap));
        revealStateRef.current = { revealed: savedRevealed, redMode: savedMode, band: savedBand };
        pmRef.current = { page: startPage, mode: startMode };
        const cardsUrl = stageJson(
          cards.map((c) => ({ id: c.id, pageIndex: c.pageIndex, rects: c.rects })),
          `viewer-cards-${deckId}.json`,
        );
        setName(deck.name);
        setPage(startPage);
        setMode(startMode);
        setRedMode(savedMode);
        setStarred(new Set(savedStarred));
        starredRef.current = savedStarred;
        setPageCount(pdf.pageCount);
        setEngineUri(uri);
        setOpenArgs({
          url: pdf.filePath,
          pageCount: pdf.pageCount,
          pageW: pdf.pageW,
          pageH: pdf.pageH,
          cardsUrl,
          mode: startMode,
          page: startPage,
          fit: "width",
          zoom: 1,
          sheetOn: savedMode === "mask",
          revealed: savedRevealed,
          starred: savedStarred,
          manualOn: savedMode === "sheet" && startMode === "scroll",
          band: savedBand,
        });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (revealSaveTimer.current) clearTimeout(revealSaveTimer.current);
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, [deckId]);

  // Pro cross-device progress push (debounced, best-effort, fail-open). Reads the latest values
  // from refs so the delayed callback isn't stale; revealed is sent as portable keys.
  const pushProgress = useCallback(() => {
    if (!bookIdRef.current) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(async () => {
      if (!(await idToken())) return;
      const { idToKey } = cardKeyMaps(cardsRef.current);
      const toKeys = (ids: number[]) => ids.map((i) => idToKey.get(i)).filter((x): x is string => !!x);
      const at = Date.now();
      progressAtRef.current = at;
      void setMeta(`progressAt:${deckId}`, String(at));
      void putProgress(bookIdRef.current!, {
        lastPage: pmRef.current.page,
        lastMode: pmRef.current.mode,
        redMode: revealStateRef.current.redMode,
        sheetBand: revealStateRef.current.band,
        revealedKeys: toKeys(revealStateRef.current.revealed),
        posAt: at,
        starsLww: starMapRef.current,
        bmLww: bmMapRef.current,
      }).catch(() => {});
    }, 1600);
  }, [deckId]);

  const persist = useCallback(
    (patch: { lastPage?: number; lastMode?: ReadMode }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void updateDeck(deckId, patch);
      }, 400);
      pushProgress();
    },
    [deckId, pushProgress],
  );

  // Persist the red overlay state (debounced) so reopening the book restores it.
  const saveViewerState = useCallback(() => {
    if (revealSaveTimer.current) clearTimeout(revealSaveTimer.current);
    revealSaveTimer.current = setTimeout(() => {
      void setMeta(`reveal:${deckId}`, JSON.stringify(revealStateRef.current));
    }, 400);
    pushProgress();
  }, [deckId, pushProgress]);

  const onPageChanged = useCallback(
    (p: number) => {
      setPage(p);
      pmRef.current.page = p;
      persist({ lastPage: p });
    },
    [persist],
  );

  const goPrev = () => ref.current?.goToPage(Math.max(0, page - 1));
  const goNext = () => ref.current?.goToPage(Math.min(pageCount - 1, page + 1));
  // 赤マスク and 赤シート are separate, mutually-exclusive (no combining); tap the active one to
  // turn it off. 赤シート is 縦読み only.
  const applyRed = (next: "mask" | "sheet" | "off") => {
    setRedMode(next);
    revealStateRef.current.redMode = next;
    ref.current?.setSheet(next === "mask");
    ref.current?.setManualSheet(next === "sheet" && mode === "scroll");
    saveViewerState();
  };
  const selectMask = () => applyRed(redMode === "mask" ? "off" : "mask");
  const selectSheet = () => applyRed(redMode === "sheet" ? "off" : "sheet");
  const toggleMode = () => {
    const m: ReadMode = mode === "scroll" ? "paged" : "scroll";
    setMode(m);
    pmRef.current.mode = m;
    ref.current?.setMode(m);
    // 赤シート is 縦読み-only: show the band only in scroll + sheet mode (redMode preserved).
    ref.current?.setManualSheet(m === "scroll" && redMode === "sheet");
    void updateDeck(deckId, { lastMode: m });
    pushProgress();
  };
  // Fit is fixed to "width" (matching the web viewer — Kindle-style: magnification is the ±/%
  // controls and pinch; there is no 全体表示 toggle).
  // Zoom is owned by the engine (so pinch and buttons stay in sync): ask it to change,
  // then the zoom-changed event updates our displayed %.
  const zoomBy = (d: number) =>
    ref.current?.setZoom(Math.max(0.5, Math.min(4, Math.round((zoom + d) * 100) / 100)));
  const resetZoom = () => ref.current?.setZoom(1);

  const back = useCallback(() => {
    void updateDeck(deckId, { lastPage: page, lastMode: mode });
    void setMeta(`reveal:${deckId}`, JSON.stringify(revealStateRef.current));
    // Best-effort immediate progress push so the latest state syncs even though we're leaving.
    if (bookIdRef.current) {
      void (async () => {
        if (!(await idToken())) return;
        const { idToKey } = cardKeyMaps(cardsRef.current);
        const toKeys = (ids: number[]) =>
          ids.map((i) => idToKey.get(i)).filter((x): x is string => !!x);
        const at = Date.now();
        void setMeta(`progressAt:${deckId}`, String(at));
        void putProgress(bookIdRef.current!, {
          lastPage: page,
          lastMode: mode,
          redMode: revealStateRef.current.redMode,
          sheetBand: revealStateRef.current.band,
          revealedKeys: toKeys(revealStateRef.current.revealed),
          posAt: at,
          starsLww: starMapRef.current,
          bmLww: bmMapRef.current,
        }).catch(() => {});
      })();
    }
    setView({ name: "decks" });
  }, [deckId, page, mode, setView]);

  // ---- manual mask editing ----
  const editDirty = editAdds.length > 0 || editDels.size > 0;
  const buildStaged = useCallback((adds: EditAdd[], dels: Set<number>): ViewerEditCard[] => {
    const out: ViewerEditCard[] = [];
    for (const c of cardsRef.current)
      if (!dels.has(c.id)) out.push({ id: c.id, pageIndex: c.pageIndex, rects: c.rects });
    for (const a of adds) out.push({ id: a.tempId, pageIndex: a.pageIndex, rects: [a.rect] });
    return out;
  }, []);
  const applyEdit = useCallback(
    (adds: EditAdd[], dels: Set<number>) => {
      setEditHistory((h) => [...h, { adds: editAdds, dels: editDels }]);
      setEditAdds(adds);
      setEditDels(dels);
      ref.current?.setEditCards(buildStaged(adds, dels)); // reflect immediately in the viewer
    },
    [editAdds, editDels, buildStaged],
  );
  const undoEdit = useCallback(() => {
    if (editHistory.length === 0) return;
    const prev = editHistory[editHistory.length - 1];
    setEditAdds(prev.adds);
    setEditDels(prev.dels);
    setEditHistory(editHistory.slice(0, -1));
    ref.current?.setEditCards(buildStaged(prev.adds, prev.dels));
  }, [editHistory, buildStaged]);
  const onMaskTapped = useCallback(
    (id: number) => {
      if (id < 0) applyEdit(editAdds.filter((a) => a.tempId !== id), editDels);
      else applyEdit(editAdds, new Set(editDels).add(id));
    },
    [applyEdit, editAdds, editDels],
  );
  const onDrawRect = useCallback(
    (pg: number, m: "add" | "delete", rect: Rect) => {
      if (m === "delete") {
        const dels = new Set(editDels);
        for (const c of cardsRef.current) {
          const rs = c.rects.length ? c.rects : [c.answerRect];
          if (!dels.has(c.id) && rs.some((r) => rectsOverlap(r, rect))) dels.add(c.id);
        }
        const adds = editAdds.filter((a) => !(a.pageIndex === pg && rectsOverlap(a.rect, rect)));
        applyEdit(adds, dels);
      } else {
        applyEdit([...editAdds, { tempId: tempIdRef.current--, pageIndex: pg, rect }], editDels);
      }
      setDrawMode(null); // the viewer auto-disarms after a draw; mirror that here
    },
    [applyEdit, editAdds, editDels],
  );
  const pickDraw = useCallback(
    (m: "add" | "delete") => {
      const next = drawMode === m ? null : m;
      setDrawMode(next);
      ref.current?.setDrawMode(next);
    },
    [drawMode],
  );
  const discardEdits = useCallback(() => {
    setEditAdds([]);
    setEditDels(new Set());
    setEditHistory([]);
    setDrawMode(null);
  }, []);
  const restoreAfterEdit = useCallback(() => {
    ref.current?.setEditMode(false);
    ref.current?.setEditCards(
      cardsRef.current.map((c) => ({ id: c.id, pageIndex: c.pageIndex, rects: c.rects })),
    );
    ref.current?.setManualSheet(redMode === "sheet" && mode === "scroll"); // restore the band
  }, [redMode, mode]);
  const enterEdit = useCallback(() => {
    discardEdits();
    setEditMode(true);
    ref.current?.setManualSheet(false); // hide the band while editing
    ref.current?.setEditMode(true);
    ref.current?.setEditCards(buildStaged([], new Set()));
  }, [discardEdits, buildStaged]);
  const cancelEdit = useCallback(() => {
    discardEdits();
    setEditMode(false);
    restoreAfterEdit();
  }, [discardEdits, restoreAfterEdit]);
  const saveEdit = useCallback(async () => {
    const now = Date.now();
    const tomb = await getClozeTomb(deckId);
    for (const id of editDels) {
      const c = cardsRef.current.find((x) => x.id === id);
      if (c) tomb[cardKey(c.pageIndex, c.answerRect)] = now; // tombstone the deleted mask (P0-2)
      await deleteCard(id);
    }
    for (const a of editAdds) {
      delete tomb[cardKey(a.pageIndex, a.rect)]; // a re-added position is live again
      await addCard(deckId, pdfIdRef.current, a.pageIndex, a.rect);
    }
    await setMeta(`clozeTomb:${deckId}`, JSON.stringify(tomb));
    cardsRef.current = await deckCards(deckId); // refresh base set (also feeds reveal keys)
    // Pro: re-sync content so the mask add/delete reaches other devices (best-effort; PDF unchanged).
    void (async () => {
      const bid = await deckBookId(deckId);
      if (bid) await uploadContent(bid, deckId);
    })().catch(() => {});
    discardEdits();
    setEditMode(false);
    restoreAfterEdit();
  }, [editAdds, editDels, deckId, discardEdits, restoreAfterEdit]);
  const tryBack = useCallback(() => {
    if (editMode && editDirty) {
      Alert.alert("編集を破棄しますか？", "保存していない編集があります。", [
        { text: "編集に戻る", style: "cancel" },
        {
          text: "破棄して終了",
          style: "destructive",
          onPress: () => {
            discardEdits();
            setEditMode(false);
            back();
          },
        },
      ]);
      return;
    }
    back();
  }, [editMode, editDirty, discardEdits, back]);

  // ---- study tracking ----
  // The viewer toggled the star locally (immediate badge) and reported the full set; mirror + persist.
  const onMaskStarred = useCallback(
    (_id: number, all: number[]) => {
      setStarred(new Set(all));
      starredRef.current = all;
      void setMeta(`star:${deckId}`, JSON.stringify(all));
      // Reconcile the ★ LWW map toward the new live set (per-key add/tombstone) for §4.2 merge sync.
      const { idToKey } = cardKeyMaps(cardsRef.current);
      setActiveStars(
        starMapRef.current,
        all.map((i) => idToKey.get(i)).filter((x): x is string => !!x),
        Date.now(),
      );
      void setMeta(`starsLww:${deckId}`, JSON.stringify(starMapRef.current));
      pushProgress(); // sync ★ cross-device (LWW-element-set)
    },
    [deckId, pushProgress],
  );
  const toggleStarReview = useCallback(() => {
    const next = !starMode;
    setStarMode(next);
    ref.current?.setStarReview(next);
  }, [starMode]);

  const openBookmarks = useCallback(async () => {
    setBookmarks(await listBookmarks(deckId));
    setBmOpen(true);
  }, [deckId]);

  const addCurrent = useCallback(() => {
    Alert.prompt(
      "しおりを追加",
      "名前を入力してください",
      async (text) => {
        const title = (text ?? "").trim() || `${page + 1}ページ`;
        await addBookmark(deckId, page, title);
        bmAdd(bmMapRef.current, title, page, Date.now());
        void setMeta(`bmLww:${deckId}`, JSON.stringify(bmMapRef.current));
        setBookmarks(await listBookmarks(deckId));
        pushProgress(); // sync しおり cross-device (LWW-element-set)
      },
      "plain-text",
      `${page + 1}ページ`,
    );
  }, [deckId, page, pushProgress]);

  const renameBm = useCallback(
    (b: BookmarkRow) => {
      Alert.prompt(
        "名前を変更",
        undefined,
        async (text) => {
          const title = (text ?? "").trim();
          if (!title) return;
          await renameBookmark(b.id, title);
          // Rename = tombstone the old key + add the new (title is part of the bmKey).
          const now = Date.now();
          bmRemove(bmMapRef.current, b.title, b.pageIndex, now);
          bmAdd(bmMapRef.current, title, b.pageIndex, now);
          void setMeta(`bmLww:${deckId}`, JSON.stringify(bmMapRef.current));
          setBookmarks(await listBookmarks(deckId));
          pushProgress();
        },
        "plain-text",
        b.title,
      );
    },
    [deckId, pushProgress],
  );

  const removeBm = useCallback(
    async (id: number) => {
      const row = bookmarks.find((b) => b.id === id);
      await deleteBookmark(id);
      if (row) {
        bmRemove(bmMapRef.current, row.title, row.pageIndex, Date.now()); // tombstone for §4.2 sync
        void setMeta(`bmLww:${deckId}`, JSON.stringify(bmMapRef.current));
      }
      setBookmarks(await listBookmarks(deckId));
      pushProgress();
    },
    [deckId, pushProgress, bookmarks],
  );

  const percent = pageCount > 0 ? Math.round(((page + 1) / pageCount) * 100) : 0;
  const zoomPct = Math.round(zoom * 100);

  if (err) {
    return (
      <View style={styles.center}>
        <Text style={styles.err}>{err}</Text>
        <Pressable onPress={() => setView({ name: "decks" })}>
          <Text style={styles.link}>← 本棚</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.c}>
      <View style={styles.top}>
        <Pressable onPress={tryBack} hitSlop={10}>
          <Text style={styles.topBtn}>← 本棚</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        <Pressable onPress={toggleStarReview} hitSlop={10}>
          <Text style={[styles.starBtn, starMode && styles.starBtnOn]}>
            {starMode ? "★" : "☆"}
          </Text>
        </Pressable>
        <Pressable onPress={openBookmarks} hitSlop={10}>
          <Text style={styles.topBtn}>目次</Text>
        </Pressable>
        <Pressable
          onPress={() => setView({ name: "quiz", deckId, from: { name: "viewer", deckId } })}
          hitSlop={10}
        >
          <Text style={styles.topBtn}>問題</Text>
        </Pressable>
        <Pressable
          onPress={() => setView({ name: "settings", deckId, from: { name: "viewer", deckId } })}
          hitSlop={10}
        >
          <Text style={styles.gearBtn}>⚙</Text>
        </Pressable>
      </View>

      <View style={styles.viewerWrap}>
        {engineUri ? (
          <ViewerWebView
            ref={ref}
            engineUri={engineUri}
            open={openArgs}
            onBookReady={(pc, p) => {
              setPageCount(pc);
              setPage(p);
            }}
            onPageChanged={onPageChanged}
            onZoomChanged={setZoom}
            onRevealChanged={(revealed) => {
              revealStateRef.current.revealed = revealed;
              saveViewerState();
            }}
            onBandChanged={(top, height) => {
              revealStateRef.current.band = { top, height };
              saveViewerState();
            }}
            onMaskTapped={onMaskTapped}
            onDrawRect={onDrawRect}
            onMaskStarred={onMaskStarred}
            onError={(m) => setErr(m)}
          />
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={colors.sand} />
          </View>
        )}
      </View>

      <View style={styles.bottom}>
        <View style={styles.navRow}>
          <Pressable onPress={goPrev} style={styles.navBtn} hitSlop={8}>
            <Text style={styles.navTxt}>‹</Text>
          </Pressable>
          <PageSlider
            page={page}
            pageCount={pageCount}
            onSeek={(p) => ref.current?.goToPage(p)}
          />
          <Pressable onPress={goNext} style={styles.navBtn} hitSlop={8}>
            <Text style={styles.navTxt}>›</Text>
          </Pressable>
        </View>

        <View style={styles.infoRow}>
          <Text style={styles.pageTxt}>
            {page + 1} / {pageCount}・{percent}%
          </Text>
          <View style={styles.zoomCtrls}>
            <Pressable style={styles.zBtn} onPress={() => zoomBy(-0.2)} hitSlop={6}>
              <Text style={styles.zTxt}>−</Text>
            </Pressable>
            <Pressable
              style={[styles.zPctBtn, zoomPct !== 100 && styles.zPctOn]}
              onPress={resetZoom}
              hitSlop={6}
            >
              <Text style={[styles.zPct, zoomPct !== 100 && styles.zPctTxtOn]}>{zoomPct}%</Text>
            </Pressable>
            <Pressable style={styles.zBtn} onPress={() => zoomBy(0.2)} hitSlop={6}>
              <Text style={styles.zTxt}>＋</Text>
            </Pressable>
          </View>
        </View>

        {editMode ? (
          <View style={styles.toolRow}>
            <Tool
              label={drawMode === "add" ? "囲んで…" : "＋追加"}
              on={drawMode === "add"}
              onPress={() => pickDraw("add")}
            />
            <Tool
              label={drawMode === "delete" ? "囲んで…" : "範囲削除"}
              on={drawMode === "delete"}
              onPress={() => pickDraw("delete")}
            />
            <Tool label="↶戻す" onPress={undoEdit} />
            <Tool label="キャンセル" onPress={cancelEdit} />
            <Tool label="保存" on onPress={() => void saveEdit()} />
          </View>
        ) : (
          <View style={styles.toolRow}>
            <Tool label="赤マスク" on={redMode === "mask"} onPress={selectMask} />
            {mode === "scroll" && (
              <Tool label="赤シート" on={redMode === "sheet"} onPress={selectSheet} />
            )}
            <Tool label={mode === "scroll" ? "縦読み" : "横読み"} onPress={toggleMode} />
            <Tool label="編集" onPress={enterEdit} />
          </View>
        )}
      </View>

      <Modal visible={bmOpen} animationType="slide" onRequestClose={() => setBmOpen(false)}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>目次（しおり）</Text>
            <Pressable onPress={() => setBmOpen(false)} hitSlop={10}>
              <Text style={styles.link}>閉じる</Text>
            </Pressable>
          </View>
          <Pressable style={styles.addBm} onPress={addCurrent}>
            <Text style={styles.addBmTxt}>＋ 現在のページ（{page + 1}）をしおりに追加</Text>
          </Pressable>
          <FlatList
            data={bookmarks}
            keyExtractor={(b) => String(b.id)}
            ListEmptyComponent={<Text style={styles.muted}>しおりはまだありません</Text>}
            renderItem={({ item }) => (
              <View style={styles.bmRow}>
                <Pressable
                  style={styles.bmJump}
                  onPress={() => {
                    ref.current?.goToPage(item.pageIndex);
                    setBmOpen(false);
                  }}
                >
                  <Text style={styles.bmTitle}>{item.title}</Text>
                  <Text style={styles.muted}>{item.pageIndex + 1} ページ</Text>
                </Pressable>
                <Pressable onPress={() => renameBm(item)} hitSlop={8}>
                  <Text style={styles.bmEdit}>編集</Text>
                </Pressable>
                <Pressable onPress={() => removeBm(item.id)} hitSlop={8}>
                  <Text style={styles.bmDel}>削除</Text>
                </Pressable>
              </View>
            )}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#525659" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  err: { color: "#fff", fontSize: 14, textAlign: "center", paddingHorizontal: 24 },
  link: { color: colors.ocean, fontSize: 15 },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topBtn: { color: colors.ocean, fontSize: 16 },
  gearBtn: { color: colors.ocean, fontSize: 18 },
  starBtn: { color: colors.muted, fontSize: 19, marginTop: -1 },
  starBtnOn: { color: colors.sand },
  title: { flex: 1, textAlign: "left", fontSize: 15, fontWeight: "700", color: colors.text },
  viewerWrap: { flex: 1 },
  bottom: { backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 2, paddingBottom: 6 },
  navRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4, paddingVertical: 2 },
  navBtn: { paddingHorizontal: 12, paddingVertical: 2 },
  navTxt: { fontSize: 24, color: colors.sand, fontWeight: "700" },
  pageTxt: { fontSize: 12.5, color: colors.textSub, fontVariant: ["tabular-nums"] },
  sliderWrap: { flex: 1, height: 32, justifyContent: "center" },
  sliderTrack: { position: "absolute", left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: colors.border },
  sliderFill: { position: "absolute", left: 0, height: 4, borderRadius: 2, backgroundColor: colors.sand },
  sliderThumb: {
    position: "absolute",
    top: 7,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.sand,
    borderWidth: 2,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  sliderThumbOn: { transform: [{ scale: 1.25 }] },
  sliderBubble: {
    position: "absolute",
    top: -26,
    width: 56,
    alignItems: "center",
    backgroundColor: colors.text,
    borderRadius: 7,
    paddingVertical: 3,
  },
  sliderBubbleTxt: { color: "#fff", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  infoRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 3, gap: 8 },
  zoomCtrls: { flexDirection: "row", alignItems: "center", gap: 5 },
  zBtn: { width: 32, height: 30, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  zTxt: { fontSize: 18, color: colors.sand, fontWeight: "700" },
  zPctBtn: { minWidth: 50, paddingVertical: 5, borderRadius: 8, alignItems: "center" },
  zPctOn: { backgroundColor: colors.sand },
  zPct: { fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  zPctTxtOn: { color: "#fff", fontWeight: "700" },
  toolRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 5 },
  tool: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  toolOn: { backgroundColor: colors.sand, borderColor: colors.sand },
  toolTxt: { fontSize: 12.5, color: colors.text, fontWeight: "600" },
  toolTxtOn: { color: "#fff", fontWeight: "700" },
  modal: { flex: 1, backgroundColor: colors.bg, paddingTop: 54, paddingHorizontal: 20 },
  modalHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  addBm: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 8 },
  addBmTxt: { color: colors.ocean, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13, paddingVertical: 8 },
  bmRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 },
  bmJump: { flex: 1 },
  bmTitle: { fontSize: 15, color: colors.text },
  bmEdit: { color: colors.ocean, fontSize: 14 },
  bmDel: { color: colors.error, fontSize: 14 },
});
