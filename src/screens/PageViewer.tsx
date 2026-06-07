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
import { ViewerWebView, type ViewerHandle, type ViewerOpenArgs } from "../engine/ViewerWebView";
import {
  addBookmark,
  deckCards,
  deleteBookmark,
  firstAnswerPage,
  getDeck,
  getDeckPdf,
  getMeta,
  listBookmarks,
  renameBookmark,
  setMeta,
  updateDeck,
} from "../db/repo";
import type { BookmarkRow, ReadMode } from "../db/rows";
import { colors } from "../ui/theme";

type FitMode = "width" | "page";

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
  const [bmOpen, setBmOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealStateRef = useRef<{
    revealed: number[];
    redMode: "mask" | "sheet" | "off";
    band: { top: number; height: number };
  }>({ revealed: [], redMode: "mask", band: { top: 80, height: 150 } });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [uri, deck, pdf, cards, revealRaw] = await Promise.all([
          ensureEngine(),
          getDeck(deckId),
          getDeckPdf(deckId),
          deckCards(deckId),
          getMeta(`reveal:${deckId}`),
        ]);
        if (!alive) return;
        if (!deck || !pdf) {
          setErr("デッキが見つかりません");
          return;
        }
        const startPage = deck.lastPage ?? (await firstAnswerPage(deckId));
        const startMode: ReadMode = deck.lastMode ?? "scroll";
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
        revealStateRef.current = { revealed: savedRevealed, redMode: savedMode, band: savedBand };
        const cardsUrl = stageJson(
          cards.map((c) => ({ id: c.id, pageIndex: c.pageIndex, rects: c.rects })),
          `viewer-cards-${deckId}.json`,
        );
        setName(deck.name);
        setPage(startPage);
        setMode(startMode);
        setRedMode(savedMode);
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
    };
  }, [deckId]);

  const persist = useCallback(
    (patch: { lastPage?: number; lastMode?: ReadMode }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void updateDeck(deckId, patch);
      }, 400);
    },
    [deckId],
  );

  // Persist the red overlay state (debounced) so reopening the book restores it.
  const saveViewerState = useCallback(() => {
    if (revealSaveTimer.current) clearTimeout(revealSaveTimer.current);
    revealSaveTimer.current = setTimeout(() => {
      void setMeta(`reveal:${deckId}`, JSON.stringify(revealStateRef.current));
    }, 400);
  }, [deckId]);

  const onPageChanged = useCallback(
    (p: number) => {
      setPage(p);
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
    ref.current?.setMode(m);
    // 赤シート is 縦読み-only: show the band only in scroll + sheet mode (redMode preserved).
    ref.current?.setManualSheet(m === "scroll" && redMode === "sheet");
    void updateDeck(deckId, { lastMode: m });
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
    setView({ name: "decks" });
  }, [deckId, page, mode, setView]);

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
        <Pressable onPress={back} hitSlop={10}>
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

        <View style={styles.toolRow}>
          <Tool label="赤マスク" on={redMode === "mask"} onPress={selectMask} />
          {mode === "scroll" && (
            <Tool label="赤シート" on={redMode === "sheet"} onPress={selectSheet} />
          )}
          <Tool label={mode === "scroll" ? "縦読み" : "横読み"} onPress={toggleMode} />
          <Tool label="目次" onPress={openBookmarks} />
        </View>
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
