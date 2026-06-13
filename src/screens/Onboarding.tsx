// First-run onboarding: a 3-slide intro explaining the red-sheet concept, viewer gestures,
// and color tuning. Shown once (gated by the "onboarded" meta flag in App.tsx).
import { useRef, useState } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { colors } from "../ui/theme";

const SLIDES = [
  {
    emoji: "📕",
    title: "Kiokumate へようこそ",
    body: "隠して覚え、解いて確かめる。色付きの答え（赤・マゼンタなど）が印刷されたPDFを取り込むと、答えの部分を自動で検出して赤シートで隠せます。タップで確認しながら暗記。色の検出は端末内で完結します。",
  },
  {
    emoji: "👆",
    title: "隠す・めくる・拡大",
    body: "答えをタップで表示／もう一度タップで再び隠す。隠し方は『赤マスク』と『赤シート』から選べます。2本指ピンチで拡大、倍率をタップで100%。縦読み・横読み・目次・★復習にも対応。",
  },
  {
    emoji: "🎯",
    title: "自動検出＋微調整",
    body: "取り込み時は『自動検出（おまかせ）』で色を自動判定。うまくいかない時は⚙設定で色（赤／マゼンタ／橙／青）やしきい値を調整して『再検出』。1ページのプレビューで確認しながら追い込めます。",
  },
  {
    emoji: "🤖",
    title: "AIで問題を作る（○×・4択）",
    body: "本の「問題」から、ページの本文と隠す語句をもとにAIが○×・4択問題を自動生成。間違えた問題だけの復習や、章ごとの演習もできます。生成時のみ本文と語句をサーバー経由でAIに送信します（初回に同意確認）。プラン別に月間の生成枠があります。",
  },
  {
    emoji: "🎁",
    title: "まずは無料で",
    body: "サインインだけで Free（本1冊・AI生成 月1回）として使えます。未契約でもロックされません。もっと使うなら Standard（本10冊）／ Pro（無制限・クラウド同期）／ Premium（AI 月100回・「今日の復習」・初回7日間無料）。いつでも解約できます。",
  },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [idx, setIdx] = useState(0);
  const ref = useRef<ScrollView>(null);
  const w = Dimensions.get("window").width;

  const onMomentum = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIdx(Math.round(e.nativeEvent.contentOffset.x / w));
  };
  const next = () => {
    if (idx < SLIDES.length - 1) ref.current?.scrollTo({ x: (idx + 1) * w, animated: true });
    else onDone();
  };

  return (
    <View style={styles.c}>
      <ScrollView
        ref={ref}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentum}
      >
        {SLIDES.map((s, i) => (
          <View key={i} style={[styles.slide, { width: w }]}>
            <Text style={styles.emoji}>{s.emoji}</Text>
            <Text style={styles.title}>{s.title}</Text>
            <Text style={styles.body}>{s.body}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.dots}>
        {SLIDES.map((_, i) => (
          <View key={i} style={[styles.dot, i === idx && styles.dotOn]} />
        ))}
      </View>
      <Pressable style={styles.btn} onPress={next}>
        <Text style={styles.btnText}>{idx < SLIDES.length - 1 ? "次へ" : "始める"}</Text>
      </Pressable>
      <Pressable style={styles.skip} onPress={onDone} hitSlop={8}>
        <Text style={styles.skipText}>スキップ</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: colors.bg },
  slide: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 36, gap: 18 },
  emoji: { fontSize: 72 },
  title: { fontSize: 24, fontWeight: "800", color: colors.text, textAlign: "center" },
  body: { fontSize: 15, color: colors.textSub, textAlign: "center", lineHeight: 24 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 8, marginBottom: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotOn: { backgroundColor: colors.sand, width: 20 },
  btn: {
    backgroundColor: colors.sand,
    marginHorizontal: 28,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  skip: { alignItems: "center", paddingVertical: 14 },
  skipText: { color: colors.muted, fontSize: 14 },
});
