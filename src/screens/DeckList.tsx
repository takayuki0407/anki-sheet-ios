// 本棚 — imported books as a cover-thumbnail grid. Tap to read; long-press for
// settings/delete. The "＋ 取り込む" action enforces the free-tier deck limit.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useApp } from "../store/session";
import { canAddDeck, useEntitlements } from "../iap/entitlements";
import { useDetectionEngine } from "../engine/EngineProvider";
import { deckPdfFile } from "../db/files";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { answerCount, deckCountTotal, deleteDeck, getCover, listDecks, setCover } from "../db/repo";
import { exportBackup, importBackup } from "../db/backup";
import type { DeckRow } from "../db/rows";
import { colors } from "../ui/theme";

interface DeckVM {
  deck: DeckRow;
  cover?: string;
  count: number;
}

export function DeckList() {
  const setView = useApp((s) => s.setView);
  const isPremium = useEntitlements((s) => s.isPremium);
  const engine = useDetectionEngine();
  const [items, setItems] = useState<DeckVM[] | null>(null);
  const regenRef = useRef(false);

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

  useEffect(() => {
    load();
  }, [load]);

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
    if (!canAddDeck(n, isPremium)) {
      setView({ name: "paywall" });
      return;
    }
    setView({ name: "import" });
  }, [isPremium, setView]);

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
            await deleteDeck(deck.id);
            load();
          },
        },
      ]);
    },
    [load],
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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>Anki-sheet</Text>
          <Text style={styles.brandSub}>赤シート暗記</Text>
        </View>
        <Pressable style={styles.addBtn} onPress={onImport}>
          <Text style={styles.addBtnText}>＋ 取り込む</Text>
        </Pressable>
      </View>

      {items === null ? (
        <View style={styles.center}>
          <Text style={styles.muted}>読み込み中…</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>本棚は空です</Text>
          <Text style={styles.muted}>「＋ 取り込む」から赤シート対応PDFを追加</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => String(it.deck.id)}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
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
          )}
        />
      )}

      <View style={styles.footer}>
        <Pressable onPress={onBackup} hitSlop={8}>
          <Text style={styles.footerLinkText}>バックアップ</Text>
        </Pressable>
        <Pressable onPress={() => setView({ name: "engineTest" })} hitSlop={8}>
          <Text style={styles.footerLinkText}>⚙︎ エンジン検証</Text>
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
  brand: { fontSize: 22, fontWeight: "800", color: colors.text },
  brandSub: { fontSize: 12, color: colors.textSub },
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
  cardName: { marginTop: 6, fontSize: 14, fontWeight: "600", color: colors.text },
  cardCount: { fontSize: 12, color: colors.textSub },
  footer: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 10 },
  footerLinkText: { color: colors.muted, fontSize: 13 },
});
