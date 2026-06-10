// One quiz run-through (○× and 4択), shared by the per-book 演習 tab and the cross-book
// 今日の復習 screen. EVERY answer is recorded locally via recordAnswer() (SM-2 + lastOk —
// drives 間違いのみ復習 / 今日の復習); Premium accounts also sync the records (debounced).
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { flushReviewPushes, recordAnswer } from "../sync/reviews";
import type { QuestionRow } from "../db/rows";
import { colors } from "../ui/theme";

export function SolveSession({
  questions,
  onExit,
  onAnswered,
}: {
  questions: QuestionRow[];
  onExit: () => void;
  /** Fired after each recorded answer (lets the parent refresh due/wrong counts). */
  onAnswered?: (questionId: string, ok: boolean) => void;
}) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const correct = useRef(0);

  // Push any queued review records when the session unmounts (exit / finish).
  useEffect(() => flushReviewPushes, []);

  const q = questions[i];

  if (i >= questions.length)
    return (
      <View style={styles.empty}>
        <Text style={styles.doneTitle}>おつかれさまでした</Text>
        <Text style={styles.doneScore}>
          正解 {correct.current} / {questions.length}
        </Text>
        <Pressable
          style={styles.primary}
          onPress={() => {
            correct.current = 0;
            setI(0);
            setPicked(null);
          }}
        >
          <Text style={styles.primaryText}>もう一度</Text>
        </Pressable>
        <Pressable onPress={onExit} hitSlop={8}>
          <Text style={styles.link}>一覧へ戻る</Text>
        </Pressable>
      </View>
    );

  const pick = (a: string) => {
    if (picked) return;
    setPicked(a);
    const ok = a === q.answer;
    if (ok) correct.current += 1;
    void recordAnswer(q, ok).then(() => onAnswered?.(q.id, ok));
  };
  const isRight = picked === q.answer;

  return (
    <ScrollView contentContainerStyle={styles.session}>
      <View style={styles.sessionTop}>
        <Text style={styles.muted}>
          {i + 1} / {questions.length}（P.{q.pageIndex + 1}・{q.qtype === "mc4" ? "4択" : "○×"}）
        </Text>
        <Pressable onPress={onExit} hitSlop={8}>
          <Text style={styles.link}>中断</Text>
        </Pressable>
      </View>
      <Text style={styles.statement}>{q.statement}</Text>
      {!picked ? (
        q.qtype === "mc4" && q.choices ? (
          <View style={styles.mc4}>
            {q.choices.map((c, idx) => (
              <Pressable key={idx} style={styles.mc4Choice} onPress={() => pick(c)}>
                <View style={styles.mc4No}>
                  <Text style={styles.mc4NoText}>{idx + 1}</Text>
                </View>
                <Text style={styles.mc4Text}>{c}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={styles.choices}>
            <Pressable style={[styles.choice, styles.maru]} onPress={() => pick("正")}>
              <Text style={styles.maruText}>○ 正しい</Text>
            </Pressable>
            <Pressable style={[styles.choice, styles.batsu]} onPress={() => pick("誤")}>
              <Text style={styles.batsuText}>× 誤り</Text>
            </Pressable>
          </View>
        )
      ) : (
        <View style={styles.reveal}>
          <Text style={[styles.verdict, isRight ? styles.right : styles.wrong]}>
            {isRight ? "正解！" : "不正解"} —{" "}
            {q.qtype === "mc4" ? `正解は「${q.answer}」` : `この文は「${q.answer}」`}
          </Text>
          {q.qtype === "mc4" && !isRight ? (
            <Text style={styles.muted}>あなたの解答：{picked}</Text>
          ) : null}
          {q.explanation ? <Text style={styles.explain}>{q.explanation}</Text> : null}
          {q.source ? <Text style={styles.muted}>根拠：{q.source}</Text> : null}
          <Pressable
            style={styles.primary}
            onPress={() => {
              setPicked(null);
              setI((n) => n + 1);
            }}
          >
            <Text style={styles.primaryText}>次へ</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  doneTitle: { fontSize: 20, fontWeight: "800", color: colors.text },
  doneScore: { fontSize: 16, color: colors.text },
  link: { color: colors.ocean, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17, marginVertical: 2 },
  session: { gap: 16, paddingBottom: 24 },
  sessionTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statement: { fontSize: 18, lineHeight: 28, color: colors.text, padding: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  choices: { flexDirection: "row", gap: 12 },
  choice: { flex: 1, paddingVertical: 16, borderRadius: 12, alignItems: "center", borderWidth: 1 },
  maru: { backgroundColor: "#e7f3ff", borderColor: colors.ocean },
  maruText: { color: colors.ocean, fontSize: 16, fontWeight: "700" },
  batsu: { backgroundColor: "#fdeaea", borderColor: "#c0392b" },
  batsuText: { color: "#c0392b", fontSize: 16, fontWeight: "700" },
  mc4: { gap: 10 },
  mc4Choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  mc4No: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  mc4NoText: { fontSize: 13, fontWeight: "800", color: colors.text },
  mc4Text: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.text },
  reveal: { gap: 10 },
  verdict: { fontSize: 16, fontWeight: "800" },
  right: { color: "#1f7a3d" },
  wrong: { color: "#c0392b" },
  explain: { fontSize: 15, lineHeight: 23, color: colors.text },
  primary: { backgroundColor: colors.sand, paddingVertical: 13, paddingHorizontal: 18, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
