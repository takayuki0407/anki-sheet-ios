// 本棚 — imported books. View styles (Explorer-like): 特大/大/中アイコン grids + 一覧 list,
// persisted. Tap to read; long-press for settings/delete. "＋ 取り込む" enforces the
// free-tier deck limit. Restored decks regenerate their cover thumbnails lazily.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useApp } from "../store/session";
import { canAddDeck, useEffectiveTier } from "../iap/entitlements";
import { useDetectionEngine } from "../engine/EngineProvider";
import { deckPdfFile } from "../db/files";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import {
  answerCount,
  deckCountTotal,
  deleteDeck,
  getCover,
  getMeta,
  listDecks,
  setCover,
  setMeta,
} from "../db/repo";
import { exportBackup, importBackup } from "../db/backup";
import { listBooks, unregisterBook, type AccountBook } from "../sync/api";
import { deckBookId, downloadDeck, localBookIds } from "../sync/deck";
import type { DeckRow } from "../db/rows";
import { colors } from "../ui/theme";

interface DeckVM {
  deck: DeckRow;
  cover?: string;
  count: number;
}

type ViewMode = "xl" | "l" | "m" | "list";
const COLS: Record<ViewMode, number> = { xl: 2, l: 3, m: 4, list: 1 };
const VIEW_LABELS: Record<ViewMode, string> = {
  xl: "特大アイコン",
  l: "大アイコン",
  m: "中アイコン",
  list: "一覧",
};
const VIEW_ORDER: ViewMode[] = ["xl", "l", "m", "list"];
const isViewMode = (v: unknown): v is ViewMode =>
  v === "xl" || v === "l" || v === "m" || v === "list";

export function DeckList() {
  const setView = useApp((s) => s.setView);
  const bumpDecks = useApp((s) => s.bumpDecks);
  const tier = useEffectiveTier();
  const engine = useDetectionEngine();
  const [items, setItems] = useState<DeckVM[] | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("l");
  const regenRef = useRef(false);
  // Books in the account that aren't on THIS device yet → one-tap cloud download (Pro).
  const [cloud, setCloud] = useState<AccountBook[]>([]);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const decks = await listDecks();
    const vms = await Promise.all(
      decks.map(async (deck) => ({
        deck,
        cover: await getCover(deck.id),
        count: await answerCount(deck.id),
      })),
    );
    setItems(vms);
  }, []);

  const loadCloud = useCallback(async () => {
    try {
      const [acct, local] = await Promise.all([listBooks(), localBookIds()]);
      setCloud(acct.books.filter((b) => !local.has(b.book_id)));
    } catch {
      setCloud([]); // signed out / offline — no cloud section
    }
  }, []);

  useEffect(() => {
    load();
    void loadCloud();
  }, [load, loadCloud]);

  const onDownload = useCallback(
    async (b: AccountBook) => {
      setDownloading((s) => new Set(s).add(b.book_id));
      try {
        await downloadDeck(b);
        bumpDecks();
        await load();
        setCloud((c) => c.filter((x) => x.book_id !== b.book_id));
      } catch (e) {
        Alert.alert("取り込みエラー", e instanceof Error ? e.message : String(e));
      } finally {
        setDownloading((s) => {
          const n = new Set(s);
          n.delete(b.book_id);
          return n;
        });
      }
    },
    [load, bumpDecks],
  );

  useEffect(() => {
    getMeta("bookshelfView").then((v) => {
      if (isViewMode(v)) setViewMode(v);
    });
  }, []);

  // Restored decks have no cover (backup omits them) — regenerate lazily in the background.
  useEffect(() => {
    if (!items || !engine.ready || regenRef.current) return;
    const missing = items.filter((it) => !it.cover);
    if (!missing.length) return;
    regenRef.current = true;
    let alive = true;
    (async () => {
      for (const it of missing) {
        try {
          const dataUrl = await engine.cover({ url: deckPdfFile(it.deck.id).uri });
          if (!alive) return;
          await setCover(it.deck.id, dataUrl);
          setItems((prev) =>
            prev ? prev.map((x) => (x.deck.id === it.deck.id ? { ...x, cover: dataUrl } : x)) : prev,
          );
        } catch {
          /* keep the placeholder */
        }
      }
      regenRef.current = false;
    })();
    return () => {
      alive = false;
    };
  }, [items, engine]);

  const onImport = useCallback(async () => {
    const n = await deckCountTotal();
    if (!canAddDeck(n, tier)) {
      setView({ name: "paywall" });
      return;
    }
    setView({ name: "import" });
  }, [tier, setView]);

  const pickView = useCallback(() => {
    Alert.alert("表示方法", undefined, [
      ...VIEW_ORDER.map((m) => ({
        text: VIEW_LABELS[m] + (viewMode === m ? "  ✓" : ""),
        onPress: () => {
          setViewMode(m);
          void setMeta("bookshelfView", m);
        },
      })),
      { text: "キャンセル", style: "cancel" as const },
    ]);
  }, [viewMode]);

  const onBackup = useCallback(() => {
    Alert.alert("バックアップ", "全データ（PDF含む）をJSONで入出力します。", [
      {
        text: "書き出す",
        onPress: async () => {
          try {
            const uri = await exportBackup();
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(uri, {
                mimeType: "application/json",
                dialogTitle: "バックアップを書き出す",
              });
            }
          } catch (e) {
            Alert.alert("エラー", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        text: "読み込む",
        onPress: async () => {
          try {
            const res = await DocumentPicker.getDocumentAsync({
              type: "application/json",
              copyToCacheDirectory: true,
            });
            if (res.canceled || !res.assets?.[0]) return;
            await importBackup(res.assets[0].uri);
            bumpDecks();
            load();
            Alert.alert("読み込み完了", "バックアップを復元しました。");
          } catch (e) {
            Alert.alert("エラー", e instanceof Error ? e.message : String(e));
          }
        },
      },
      { text: "キャンセル", style: "cancel" },
    ]);
  }, [load]);

  const confirmDelete = useCallback(
    (deck: DeckRow) => {
      Alert.alert("削除しますか?", `「${deck.name}」と検出結果を削除します。`, [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: async () => {
            const bid = await deckBookId(deck.id);
            await deleteDeck(deck.id);
            if (bid) void unregisterBook(bid).catch(() => {}); // free the account-global slot
            bumpDecks();
            load();
            void loadCloud();
          },
        },
      ]);
    },
    [load, loadCloud],
  );

  const onLongPress = useCallback(
    (deck: DeckRow) => {
      Alert.alert(deck.name, undefined, [
        { text: "開く", onPress: () => setView({ name: "viewer", deckId: deck.id }) },
        { text: "設定・再検出", onPress: () => setView({ name: "settings", deckId: deck.id }) },
        { text: "削除", style: "destructive", onPress: () => confirmDelete(deck) },
        { text: "キャンセル", style: "cancel" },
      ]);
    },
    [confirmDelete, setView],
  );

  const cols = COLS[viewMode];

  const renderGrid = ({ item }: { item: DeckVM }) => (
    <Pressable
      style={styles.card}
      onPress={() => setView({ name: "viewer", deckId: item.deck.id })}
      onLongPress={() => onLongPress(item.deck)}
    >
      <View style={styles.coverWrap}>
        {item.cover ? (
          <Image source={{ uri: item.cover }} style={styles.cover} resizeMode="cover" />
        ) : (
          <View style={[styles.cover, styles.coverPlaceholder]}>
            <Text style={styles.muted}>PDF</Text>
          </View>
        )}
      </View>
      <Text style={styles.cardName} numberOfLines={2}>
        {item.deck.name}
      </Text>
      <Text style={styles.cardCount}>{item.count} 問</Text>
    </Pressable>
  );

  const renderList = ({ item }: { item: DeckVM }) => (
    <Pressable
      style={styles.listRow}
      onPress={() => setView({ name: "viewer", deckId: item.deck.id })}
      onLongPress={() => onLongPress(item.deck)}
    >
      {item.cover ? (
        <Image source={{ uri: item.cover }} style={styles.listCover} resizeMode="cover" />
      ) : (
        <View style={[styles.listCover, styles.coverPlaceholder]}>
          <Text style={styles.muted}>PDF</Text>
        </View>
      )}
      <View style={styles.listInfo}>
        <Text style={styles.listName} numberOfLines={1}>
          {item.deck.name}
        </Text>
        <Text style={styles.cardCount}>{item.count} 問</Text>
      </View>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Image source={require("../../assets/icon.png")} style={styles.brandIcon} />
          <View>
            <Text style={styles.brand}>Anki-sheet</Text>
            <Text style={styles.brandSub}>赤シート暗記</Text>
          </View>
        </View>
        <View style={styles.headerBtns}>
          <Pressable style={styles.viewBtn} onPress={pickView} hitSlop={6}>
            <Text style={styles.viewBtnText}>表示</Text>
          </Pressable>
          <Pressable style={styles.addBtn} onPress={onImport}>
            <Text style={styles.addBtnText}>＋ 取り込む</Text>
          </Pressable>
        </View>
      </View>

      {items === null ? (
        <View style={styles.center}>
          <Text style={styles.muted}>読み込み中…</Text>
        </View>
      ) : items.length === 0 && cloud.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>本棚は空です</Text>
          <Text style={styles.muted}>「＋ 取り込む」から赤シート対応PDFを追加</Text>
        </View>
      ) : (
        <FlatList
          key={viewMode}
          data={items}
          keyExtractor={(it) => String(it.deck.id)}
          numColumns={cols}
          columnWrapperStyle={cols > 1 ? styles.row : undefined}
          contentContainerStyle={styles.grid}
          renderItem={viewMode === "list" ? renderList : renderGrid}
          ListFooterComponent={
            cloud.length > 0 ? (
              <View style={styles.cloudSection}>
                <Text style={styles.cloudTitle}>クラウド（他の端末の本）</Text>
                {cloud.map((b) => (
                  <View key={b.book_id} style={styles.cloudRow}>
                    <View style={styles.cloudInfo}>
                      <Text style={styles.cloudName} numberOfLines={1}>
                        {b.name || "（無題）"}
                      </Text>
                      {b.device ? <Text style={styles.cloudDevice}>{b.device}</Text> : null}
                    </View>
                    <Pressable
                      style={styles.cloudBtn}
                      disabled={downloading.has(b.book_id)}
                      onPress={() => onDownload(b)}
                    >
                      <Text style={styles.cloudBtnText}>
                        {downloading.has(b.book_id) ? "取り込み中…" : "取り込む"}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null
          }
        />
      )}

      <View style={styles.footer}>
        <Pressable onPress={onBackup} hitSlop={8}>
          <Text style={styles.footerLinkText}>バックアップ</Text>
        </Pressable>
        <Pressable onPress={() => setView({ name: "info" })} hitSlop={8}>
          <Text style={styles.footerLinkText}>ヘルプ・情報</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandIcon: { width: 34, height: 34, borderRadius: 8 },
  brand: { fontSize: 22, fontWeight: "800", color: "#b9824f" },
  brandSub: { fontSize: 12, color: colors.textSub },
  headerBtns: { flexDirection: "row", alignItems: "center", gap: 8 },
  viewBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  viewBtnText: { color: colors.text, fontWeight: "600" },
  addBtn: { backgroundColor: colors.sand, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  addBtnText: { color: "#fff", fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  grid: { paddingBottom: 24 },
  row: { gap: 12 },
  card: { flex: 1, marginBottom: 16 },
  coverWrap: {
    aspectRatio: 0.72,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cover: { width: "100%", height: "100%" },
  coverPlaceholder: { alignItems: "center", justifyContent: "center" },
  cardName: { marginTop: 6, fontSize: 13, fontWeight: "600", color: colors.text },
  cardCount: { fontSize: 12, color: colors.textSub },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  listCover: {
    width: 44,
    height: 60,
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  listInfo: { flex: 1 },
  listName: { fontSize: 15, fontWeight: "600", color: colors.text },
  footer: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 10 },
  footerLinkText: { color: colors.muted, fontSize: 13 },
  cloudSection: {
    marginTop: 8,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  cloudTitle: { fontSize: 13, fontWeight: "700", color: colors.textSub, marginBottom: 2 },
  cloudRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  cloudInfo: { flex: 1 },
  cloudName: { fontSize: 14, fontWeight: "600", color: colors.text },
  cloudDevice: { fontSize: 11, color: colors.muted },
  cloudBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  cloudBtnText: { color: colors.ocean, fontSize: 13, fontWeight: "600" },
});
