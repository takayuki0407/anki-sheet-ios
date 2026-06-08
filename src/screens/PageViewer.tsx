// 赤シートビューア — hosts the WebView viewer and supplies native chrome (back/settings,
// page nav, zoom with one-tap 100% reset, 幅/全体 fit, sheet/mode toggles, 目次 bookmarks
// with custom names + editing). Pinch-zoom and axis-locked panning are handled in-engine.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
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
  getDeck,
  getDeckPdf,
  getMeta,
  listBookmarks,
  renameBookmark,
  setMeta,
  updateDeck,
} from "../db/repo";
import type { BookmarkRow, CardRow, ReadMode } from "../db/rows";
import type { Rect } from "../types";
import { getProgress, idToken, putProgress } from "../sync/api";
import { deckBookId } from "../sync/deck";
import { colors } from "../ui/theme";

type FitMode = "width" | "page";

/** Device-portable reveal keys (pageIndex:ordinal, ordinal = position-sorted index on the page) —
 * identical across devices for the same detected book, so revealed answers map despite local ids. */
function cardKeyMaps(cards: CardRow[]) {
  const byPage = new Map<number, CardRow[]>();
  for (const c of cards) {
    const arr = byPage.get(c.pageIndex) ?? [];
    arr.push(c);
    byPage.set(c.pageIndex, arr);
  }
  const idToKey = new Map<number, string>();
  const keyToId = new Map<string, number>();
  for (const [page, list] of byPage) {
    [...list]
      .sort((a, b) => a.answerRect.y - b.answerRect.y || a.answerRect.x - b.answerRect.x)
      .forEach((c, i) => {
        const key = `${page}:${i}`;
        idToKey.set(c.id, key);
        keyToId.set(key, c.id);
      });
  }
  return { idToKey, keyToId };
}

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

export function PageViewer({ deckId }: { deckId: number }) {
  const setView = useApp((s) => s.setView);
  const ref = useRef<ViewerHandle>(null);
  const [engineUri, setEngineUri] = useState<string | null>(null);
  const [openArgs, setOpenArgs] = useState<ViewerOpenArgs | null>(null);
  const [name, setName] = useState("");
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [mode, setMode] = useState<ReadMode>("scroll");
  const [fit, setFit] = useState<FitMode>("width");
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
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [uri, deck, pdf, cards, revealRaw, starRaw] = await Promise.all([
          ensureEngine(),
          getDeck(deckId),
          getDeckPdf(deckId),
          deckCards(deckId),
          getMeta(`reveal:${deckId}`),
          getMeta(`star:${deckId}`),
        ]);
        if (!alive) return;
        if (!deck || !pdf) {
          setErr("デッキが見つかりません");
          return;
        }
        pdfIdRef.current = pdf.id;
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
        // Pro cross-device progress: if the cloud copy is newer, resume from it (position / mode /
        // red-sheet / revealed). Fail-open: signed-out or offline just keeps the local state.
        if (bookIdRef.current && (await idToken())) {
          const cloud = await getProgress(bookIdRef.current).catch(() => null);
          if (alive && cloud && cloud.updatedAt > progressAtRef.current) {
            const c = cloud.data;
            if (typeof c.lastPage === "number")
              startPage = Math.max(0, Math.min(pdf.pageCount - 1, c.lastPage));
            if (c.lastMode) startMode = c.lastMode;
            if (c.redMode) savedMode = c.redMode;
            if (c.sheetBand) savedBand = c.sheetBand;
            if (c.revealedKeys) {
              const { keyToId } = cardKeyMaps(cards);
              savedRevealed = c.revealedKeys
                .map((k) => keyToId.get(k))
                .filter((x): x is number => x != null);
            }
            progressAtRef.current = cloud.updatedAt;
            void updateDeck(deckId, { lastPage: startPage, lastMode: startMode });
            void setMeta(
              `reveal:${deckId}`,
              JSON.stringify({ revealed: savedRevealed, redMode: savedMode, band: savedBand }),
            );
            void setMeta(`progressAt:${deckId}`, String(cloud.updatedAt));
          }
        }
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
      const revealedKeys = revealStateRef.current.revealed
        .map((i) => idToKey.get(i))
        .filter((x): x is string => !!x);
      const at = Date.now();
      progressAtRef.current = at;
      void setMeta(`progressAt:${deckId}`, String(at));
      void putProgress(bookIdRef.current!, {
        lastPage: pmRef.current.page,
        lastMode: pmRef.current.mode,
        redMode: revealStateRef.current.redMode,
        sheetBand: revealStateRef.current.band,
        revealedKeys,
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
  const setFitMode = (f: FitMode) => {
    setFit(f);
    ref.current?.setFit(f);
  };
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
        void setMeta(`progressAt:${deckId}`, String(Date.now()));
        void putProgress(bookIdRef.current!, {
          lastPage: page,
          lastMode: mode,
          redMode: revealStateRef.current.redMode,
          sheetBand: revealStateRef.current.band,
          revealedKeys: revealStateRef.current.revealed
            .map((i) => idToKey.get(i))
            .filter((x): x is string => !!x),
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
    for (const id of editDels) await deleteCard(id);
    for (const a of editAdds) await addCard(deckId, pdfIdRef.current, a.pageIndex, a.rect);
    cardsRef.current = await deckCards(deckId); // refresh base set (also feeds reveal keys)
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
      void setMeta(`star:${deckId}`, JSON.stringify(all));
    },
    [deckId],
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
        setBookmarks(await listBookmarks(deckId));
      },
      "plain-text",
      `${page + 1}ページ`,
    );
  }, [deckId, page]);

  const renameBm = useCallback(
    (b: BookmarkRow) => {
      Alert.prompt(
        "名前を変更",
        undefined,
        async (text) => {
          const title = (text ?? "").trim();
          if (!title) return;
          await renameBookmark(b.id, title);
          setBookmarks(await listBookmarks(deckId));
        },
        "plain-text",
        b.title,
      );
    },
    [deckId],
  );

  const removeBm = useCallback(
    async (id: number) => {
      await deleteBookmark(id);
      setBookmarks(await listBookmarks(deckId));
    },
    [deckId],
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
        <Pressable onPress={() => setView({ name: "settings", deckId })} hitSlop={10}>
          <Text style={styles.topBtn}>⚙</Text>
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
          <Text style={styles.pageTxt}>
            {page + 1} / {pageCount}　{percent}%
          </Text>
          <Pressable onPress={goNext} style={styles.navBtn} hitSlop={8}>
            <Text style={styles.navTxt}>›</Text>
          </Pressable>
        </View>

        <View style={styles.zoomRow}>
          <View style={styles.seg}>
            <Pressable
              style={[styles.segBtn, fit === "width" && styles.segOn]}
              onPress={() => setFitMode("width")}
            >
              <Text style={[styles.segTxt, fit === "width" && styles.segTxtOn]}>幅</Text>
            </Pressable>
            <Pressable
              style={[styles.segBtn, fit === "page" && styles.segOn]}
              onPress={() => setFitMode("page")}
            >
              <Text style={[styles.segTxt, fit === "page" && styles.segTxtOn]}>全体</Text>
            </Pressable>
          </View>
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
            <Tool label="★復習" on={starMode} onPress={toggleStarReview} />
            <Tool label="目次" onPress={openBookmarks} />
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topBtn: { color: colors.ocean, fontSize: 16 },
  title: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: colors.text },
  viewerWrap: { flex: 1 },
  bottom: { backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: 6 },
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingVertical: 5 },
  navBtn: { paddingHorizontal: 16 },
  navTxt: { fontSize: 26, color: colors.sand, fontWeight: "700" },
  pageTxt: { fontSize: 14, color: colors.text, minWidth: 120, textAlign: "center" },
  zoomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 4 },
  seg: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: "hidden" },
  segBtn: { paddingHorizontal: 16, paddingVertical: 7, backgroundColor: colors.surface },
  segOn: { backgroundColor: colors.sand },
  segTxt: { fontSize: 14, color: colors.text },
  segTxtOn: { color: "#fff", fontWeight: "700" },
  zoomCtrls: { flexDirection: "row", alignItems: "center", gap: 6 },
  zBtn: { width: 38, height: 36, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  zTxt: { fontSize: 20, color: colors.sand, fontWeight: "700" },
  zPctBtn: { minWidth: 60, paddingVertical: 7, borderRadius: 8, alignItems: "center" },
  zPctOn: { backgroundColor: colors.sand },
  zPct: { fontSize: 14, color: colors.text },
  zPctTxtOn: { color: "#fff", fontWeight: "700" },
  toolRow: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 4 },
  tool: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  toolOn: { backgroundColor: colors.sand },
  toolTxt: { fontSize: 14, color: colors.text },
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
