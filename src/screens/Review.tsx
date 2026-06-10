// 今日の復習 (Premium) — one cross-book SM-2 session: every question whose review is due
// (dueAt <= now), most-overdue first. Reached from the bookshelf card. The server keeps the
// review SYNC Premium-only; this screen additionally locks the UI for known non-premium tiers
// (unknown/offline falls open so an offline Premium user isn't punished).
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useApp } from "../store/session";
import { dueReviews, questionsByIds } from "../db/repo";
import { getGenUsage } from "../ai/generate";
import { SolveSession } from "./SolveSession";
import type { QuestionRow } from "../db/rows";
import { colors } from "../ui/theme";

export function Review() {
  const setView = useApp((s) => s.setView);
  const [questions, setQuestions] = useState<QuestionRow[] | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let live = true;
    void getGenUsage()
      .then((u) => {
        if (live && u.tier !== "premium" && u.tier !== "admin") setLocked(true);
      })
      .catch(() => {}); // unknown → fall open
    void (async () => {
      const due = await dueReviews(Date.now());
      const qs = await questionsByIds(due.map((r) => r.questionId));
      if (live) setQuestions(qs); // questionsByIds preserves the due order (most overdue first)
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <View style={styles.c}>
      <View style={styles.head}>
        <Pressable onPress={() => setView({ name: "decks" })} hitSlop={8}>
          <Text style={styles.back}>← 本棚へ</Text>
        </Pressable>
        <Text style={styles.title}>今日の復習</Text>
      </View>
      {locked ? (
        <View style={styles.empty}>
          <Text style={styles.lead}>
            「今日の復習」はPremiumの機能です。{"\n"}
            間違えやすい問題を、忘れる直前の最適なタイミングで再出題します。
          </Text>
          <Pressable style={styles.primary} onPress={() => setView({ name: "paywall" })}>
            <Text style={styles.primaryText}>プランを見る</Text>
          </Pressable>
        </View>
      ) : questions === null ? (
        <Text style={styles.muted}>読み込み中…</Text>
      ) : !questions.length ? (
        <View style={styles.empty}>
          <Text style={styles.lead}>いま復習が必要な問題はありません 🎉</Text>
          <Pressable onPress={() => setView({ name: "decks" })} hitSlop={8}>
            <Text style={styles.back}>本棚へ戻る</Text>
          </Pressable>
        </View>
      ) : (
        <SolveSession questions={questions} onExit={() => setView({ name: "decks" })} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  back: { color: colors.ocean, fontSize: 15 },
  title: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  lead: { fontSize: 15, lineHeight: 24, color: colors.text, textAlign: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 20 },
  primary: { backgroundColor: colors.sand, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
