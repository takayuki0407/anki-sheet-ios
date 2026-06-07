// 赤シートビューア — hosts the WebView viewer and supplies native chrome (back/settings,
// page nav, sheet/mode/fit/zoom toggles, 目次 bookmarks). Opens at the last-read page and
// mode, and persists position as you read.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  listBookmarks,
  updateDeck,
} from "../db/repo";
import type { BookmarkRow, ReadMode } from "../db/rows";
import { colors } from "../ui/theme";

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
  const [fit, setFit] = useState<"width" | "page">("width");
  const [zoom, setZoom] = useState(1);
  const [sheetOn, setSheetOn] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [bmOpen, setBmOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [uri, deck, pdf, cards] = await Promise.all([
          ensureEngine(),
          getDeck(deckId),
          getDeckPdf(deckId),
          deckCards(deckId),
        ]);
        if (!alive) return;
        if (!deck || !pdf) {
          setErr("デッキが見つかりません");
          return;
        }
        const startPage = deck.lastPage ?? (await firstAnswerPage(deckId));
        const startMode: ReadMode = deck.lastMode ?? "scroll";
        const cardsUrl = stageJson(
          cards.map((c) => ({ id: c.id, pageIndex: c.pageIndex, rects: c.rects })),
          `viewer-cards-${deckId}.json`,
        );
        setName(deck.name);
        setPage(startPage);
        setMode(startMode);
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
          sheetOn: true,
        });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
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

  const onPageChanged = useCallback(
    (p: number) => {
      setPage(p);
      persist({ lastPage: p });
    },
    [persist],
  );

  const goPrev = () => ref.current?.goToPage(Math.max(0, page - 1));
  const goNext = () => ref.current?.goToPage(Math.min(pageCount - 1, page + 1));
  const toggleSheet = () => {
    const v = !sheetOn;
    setSheetOn(v);
    ref.current?.setSheet(v);
  };
  const toggleMode = () => {
    const m: ReadMode = mode === "scroll" ? "paged" : "scroll";
    setMode(m);
    ref.current?.setMode(m);
    void updateDeck(deckId, { lastMode: m });
  };
  const toggleFit = () => {
    const f = fit === "width" ? "page" : "width";
    setFit(f);
    ref.current?.setFit(f);
  };
  const zoomBy = (d: number) => {
    const z = Math.max(0.5, Math.min(4, Math.round((zoom + d) * 100) / 100));
    setZoom(z);
    ref.current?.setZoom(z);
  };

  const back = useCallback(() => {
    void updateDeck(deckId, { lastPage: page, lastMode: mode });
    setView({ name: "decks" });
  }, [deckId, page, mode, setView]);

  const openBookmarks = useCallback(async () => {
    setBookmarks(await listBookmarks(deckId));
    setBmOpen(true);
  }, [deckId]);
  const addCurrent = useCallback(async () => {
    await addBookmark(deckId, page, `${page + 1}ページ`);
    setBookmarks(await listBookmarks(deckId));
  }, [deckId, page]);
  const removeBm = useCallback(
    async (id: number) => {
      await deleteBookmark(id);
      setBookmarks(await listBookmarks(deckId));
    },
    [deckId],
  );

  const percent = pageCount > 0 ? Math.round(((page + 1) / pageCount) * 100) : 0;

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
        <View style={styles.toolRow}>
          <Tool label="赤シート" on={sheetOn} onPress={toggleSheet} />
          <Tool label={mode === "scroll" ? "縦読み" : "横読み"} onPress={toggleMode} />
          <Tool label={fit === "width" ? "幅" : "全体"} onPress={toggleFit} />
          <Tool label="−" onPress={() => zoomBy(-0.2)} />
          <Tool label="＋" onPress={() => zoomBy(0.2)} />
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
            <Text style={styles.addBmTxt}>＋ 現在のページ（{page + 1}）を追加</Text>
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
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingVertical: 6 },
  navBtn: { paddingHorizontal: 16 },
  navTxt: { fontSize: 26, color: colors.sand, fontWeight: "700" },
  pageTxt: { fontSize: 14, color: colors.text, minWidth: 120, textAlign: "center" },
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
  bmRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  bmJump: { flex: 1 },
  bmTitle: { fontSize: 15, color: colors.text },
  bmDel: { color: colors.error, fontSize: 14 },
});
