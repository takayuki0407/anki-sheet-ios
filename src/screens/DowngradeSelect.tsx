// 強制トリム — shown (forced, by App's gate) when the server flags `trim_required` after a downgrade
// left the account over its book cap. The list is the ACCOUNT-WIDE book set (all devices), so the
// user picks the global kept set even for books not on this device. POST /api/sync/trim makes the
// kept set authoritative; this device then deletes its local copies of the non-kept books. Other
// devices follow on their next sync. Escape: back up first, or upgrade.
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Sharing from "expo-sharing";
import { useApp } from "../store/session";
import { deleteBookQuestions, deleteDeck } from "../db/repo";
import { downloadDeck, localBookIds } from "../sync/deck";
import { listBooks, submitTrim, updateBookMeta, type AccountBook } from "../sync/api";
import { deviceLabel } from "../sync/device";
import { exportBackup } from "../db/backup";
import { DevTierSwitch } from "../components/DevTierSwitch";
import { colors } from "../ui/theme";

export function DowngradeSelect({
  keepLimit,
  onResolved,
}: {
  keepLimit: number;
  onResolved: () => Promise<void> | void;
}) {
  const setView = useApp((s) => s.setView);
  const [books, setBooks] = useState<AccountBook[] | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [backedUp, setBackedUp] = useState(false);

  useEffect(() => {
    void listBooks()
      .then((u) => setBooks(u.books))
      .catch(() => setBooks([]));
  }, []);

  const toggle = useCallback(
    (id: string) =>
      setKeep((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else if (next.size < keepLimit) next.add(id);
        return next;
      }),
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
    if (!books) return;
    const removeCount = books.length - keep.size;
    const warn = backedUp ? "" : "⚠ バックアップはまだ書き出していません。\n";
    Alert.alert(
      "確認",
      `${warn}選んだ ${keep.size} 冊をこの端末に保存します。外した ${removeCount} 冊のうち、クラウド保存がある本はクラウドに退避し、Proに戻すと復元できます（保持〜約6ヶ月）。クラウド保存の無い本（端末のみ）は完全に削除されます。Standardは端末間同期がないため、他の端末のローカルコピーは次回起動時に削除されます。`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "残して続ける",
          style: "destructive",
          onPress: async () => {
            try {
              setBusy(true);
              await submitTrim([...keep]);
              // Reconcile THIS device: delete local copies of books that weren't kept.
              const ids = await localBookIds(); // Map<bookId, deckId>
              for (const [bid, deckId] of ids) {
                if (!keep.has(bid)) {
                  await deleteDeck(deckId);
                  void deleteBookQuestions(bid).catch(() => {});
                }
              }
              // Materialize kept books not on THIS device (now allowed on any tier for active books),
              // then CLAIM the holder — but only AFTER a successful download, so a failure never
              // leaves the book with no device (it stays in the cloud section as "ダウンロード待ち").
              const me = deviceLabel();
              for (const b of books) {
                if (keep.has(b.book_id) && !ids.has(b.book_id) && b.size > 0) {
                  try {
                    await downloadDeck(b);
                    await updateBookMeta(b.book_id, { device: me }).catch(() => {});
                  } catch {
                    /* offline / large → retry from the bookshelf cloud section */
                  }
                }
              }
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
  }, [books, keep, backedUp, onResolved, setView]);

  if (!books)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.sand} />
      </View>
    );

  const target = Math.min(keepLimit, books.length);
  const canApply = keep.size === target && !busy;

  return (
    <View style={styles.c}>
      <Text style={styles.title}>残す本を選んでください</Text>
      <Text style={styles.lead}>
        現在のプランの上限は {keepLimit} 冊です。アカウント全体（すべての端末）の本から、残す{" "}
        {keepLimit} 冊を選んでください。残した本はこの端末に保存されます。選ばなかった本のうち、
        クラウド保存がある本はクラウドに退避し、Proに戻すと復元できます（保持〜約6ヶ月）。クラウド
        保存の無い本（端末のみ）は完全に削除されます。
      </Text>
      <Text style={styles.counter}>
        {keep.size} / {target} 冊を選択
      </Text>

      <FlatList
        data={books}
        keyExtractor={(b) => b.book_id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const sel = keep.has(item.book_id);
          return (
            <Pressable style={[styles.row, sel && styles.rowSel]} onPress={() => toggle(item.book_id)}>
              <View style={[styles.check, sel && styles.checkSel]}>
                {sel ? <Text style={styles.checkText}>✓</Text> : null}
              </View>
              <Text style={styles.name} numberOfLines={1}>
                {item.name || "（無題）"}
              </Text>
              {item.device ? <Text style={styles.device}>{item.device}</Text> : null}
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
            <Text style={styles.secondary}>アップグレード</Text>
          </Pressable>
        </View>
        <Pressable style={[styles.primary, !canApply && styles.disabled]} disabled={!canApply} onPress={apply}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryText}>選んだ {target} 冊を残す</Text>
          )}
        </Pressable>
        <DevTierSwitch />
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
  list: { paddingBottom: 12, gap: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowSel: { borderColor: colors.sand, backgroundColor: "rgba(212,163,115,0.12)" },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkSel: { backgroundColor: colors.sand, borderColor: colors.sand },
  checkText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  name: { flex: 1, fontSize: 15, color: colors.text },
  device: { fontSize: 11, color: colors.muted },
  actions: { gap: 10, paddingTop: 8 },
  secondaryRow: { flexDirection: "row", justifyContent: "space-around" },
  secondary: { color: colors.ocean, fontSize: 14, textAlign: "center", paddingVertical: 6 },
  primary: { backgroundColor: colors.sand, paddingVertical: 15, borderRadius: 12, alignItems: "center" },
  disabled: { opacity: 0.5 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
