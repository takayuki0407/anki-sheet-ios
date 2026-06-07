// Shown (forced, by App's Gate) when a Standard subscriber holds more books than the plan
// allows — e.g. after downgrading from Pro or after the trial. The user picks which books to
// keep; the rest are deleted. Escapes: back up first, or upgrade to Pro to keep everything.
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Sharing from "expo-sharing";
import { useApp } from "../store/session";
import { deleteDeck, getCover, listDecks } from "../db/repo";
import { exportBackup } from "../db/backup";
import type { DeckRow } from "../db/rows";
import { colors } from "../ui/theme";

interface VM {
  deck: DeckRow;
  cover?: string;
}

export function DowngradeSelect({
  keepLimit,
  onResolved,
}: {
  keepLimit: number;
  onResolved: () => Promise<void> | void;
}) {
  const setView = useApp((s) => s.setView);
  const [items, setItems] = useState<VM[] | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [backedUp, setBackedUp] = useState(false);

  useEffect(() => {
    (async () => {
      const decks = await listDecks();
      const vms = await Promise.all(
        decks.map(async (deck) => ({ deck, cover: await getCover(deck.id) })),
      );
      setItems(vms);
    })();
  }, []);

  const toggle = useCallback(
    (id: number) => {
      setKeep((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else if (next.size < keepLimit) next.add(id);
        return next;
      });
    },
    [keepLimit],
  );

  const backup = useCallback(async () => {
    try {
      const uri = await exportBackup();
      if (await Sharing.isAvailableAsync())
        await Sharing.shareAsync(uri, {
          mimeType: "application/json",
          dialogTitle: "バックアップを書き出す",
        });
      setBackedUp(true);
    } catch (e) {
      Alert.alert("エラー", e instanceof Error ? e.message : String(e));
    }
  }, []);

  const apply = useCallback(() => {
    if (!items) return;
    const remove = items.filter((it) => !keep.has(it.deck.id));
    const warn = backedUp ? "" : "⚠ バックアップはまだ書き出していません。\n";
    Alert.alert(
      "確認",
      `${warn}選んだ ${keep.size} 冊を残し、ほかの ${remove.length} 冊を削除します。この操作は元に戻せません。`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除して続ける",
          style: "destructive",
          onPress: async () => {
            try {
              setBusy(true);
              for (const it of remove) await deleteDeck(it.deck.id);
              await onResolved();
              setView({ name: "decks" });
            } catch (e) {
              Alert.alert("エラー", e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [items, keep, backedUp, onResolved, setView]);

  if (!items)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.sand} />
      </View>
    );

  const target = Math.min(keepLimit, items.length);
  const canApply = keep.size === target && !busy;

  return (
    <View style={styles.c}>
      <Text style={styles.title}>残す本を選んでください</Text>
      <Text style={styles.lead}>
        Standardプランは本を {keepLimit} 冊まで保存できます。残す本を {keepLimit} 冊選んでください。
        選ばなかった本は削除されます。すべて残したい場合は Pro（無制限）にアップグレードできます。
      </Text>
      <Text style={styles.counter}>
        {keep.size} / {target} 冊を選択
      </Text>

      <FlatList
        data={items}
        keyExtractor={(it) => String(it.deck.id)}
        numColumns={3}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => {
          const sel = keep.has(item.deck.id);
          return (
            <Pressable style={styles.card} onPress={() => toggle(item.deck.id)}>
              <View style={[styles.coverWrap, sel && styles.coverSel]}>
                {item.cover ? (
                  <Image source={{ uri: item.cover }} style={styles.cover} resizeMode="cover" />
                ) : (
                  <View style={[styles.cover, styles.ph]}>
                    <Text style={styles.muted}>PDF</Text>
                  </View>
                )}
                {sel ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>✓</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.name} numberOfLines={2}>
                {item.deck.name}
              </Text>
            </Pressable>
          );
        }}
      />

      <View style={styles.actions}>
        <View style={styles.secondaryRow}>
          <Pressable onPress={backup} hitSlop={8} disabled={busy}>
            <Text style={styles.secondary}>
              {backedUp ? "✓ バックアップ済み" : "バックアップを書き出す"}
            </Text>
          </Pressable>
          <Pressable onPress={() => setView({ name: "paywall" })} hitSlop={8} disabled={busy}>
            <Text style={styles.secondary}>Proにアップグレード</Text>
          </Pressable>
        </View>
        <Pressable style={[styles.primary, !canApply && styles.disabled]} disabled={!canApply} onPress={apply}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryText}>選んだ {target} 冊を残して削除</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "800", color: colors.text, textAlign: "center", marginTop: 8 },
  lead: { fontSize: 13, color: colors.textSub, textAlign: "center", lineHeight: 20, marginTop: 8 },
  counter: { fontSize: 14, fontWeight: "700", color: colors.sand, textAlign: "center", marginVertical: 10 },
  grid: { paddingBottom: 12 },
  row: { gap: 10 },
  card: { flex: 1, marginBottom: 14 },
  coverWrap: {
    aspectRatio: 0.72,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
  },
  coverSel: { borderColor: colors.sand },
  cover: { width: "100%", height: "100%" },
  ph: { alignItems: "center", justifyContent: "center" },
  muted: { color: colors.muted, fontSize: 13 },
  badge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.sand,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  name: { marginTop: 6, fontSize: 12, fontWeight: "600", color: colors.text },
  actions: { gap: 10, paddingTop: 8 },
  secondaryRow: { flexDirection: "row", justifyContent: "space-around" },
  secondary: { color: colors.ocean, fontSize: 14, textAlign: "center", paddingVertical: 6 },
  primary: { backgroundColor: colors.sand, paddingVertical: 15, borderRadius: 12, alignItems: "center" },
  disabled: { opacity: 0.5 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
