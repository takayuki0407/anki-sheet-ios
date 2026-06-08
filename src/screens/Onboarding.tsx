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
    title: "Anki-sheet へようこそ",
    body: "色付きの答え（赤・マゼンタなど）が印刷されたPDFを取り込むと、答えの部分を自動で検出して隠せます。タップで確認しながら暗記。PDFの解析は端末内で完結します。クラウド同期（Pro）を使う場合のみ、ご自身の端末間共有のためにアカウントへ保存されます。",
  },
  {
    emoji: "👆",
    title: "隠す・めくる・拡大",
    body: "答えをタップで表示／もう一度タップで再び隠す。隠し方は『赤マスク』と『赤シート』から選べます。2本指ピンチで拡大、倍率をタップで100%。縦読み・横読み・目次（しおり）にも対応。",
  },
  {
    emoji: "🎯",
    title: "色の調整で精度アップ",
    body: "うまく検出されない時は、ビューアの⚙設定で答えの色（赤／マゼンタ／橙／青）やしきい値を調整して『再検出』。1ページのプレビューで確認しながら追い込めます。",
  },
  {
    emoji: "🎁",
    title: "まず7日間は無料",
    body: "7日間の無料トライアルですべての機能を試せます。その後も続けるにはサブスクリプション（Standard：本10冊まで／Pro：無制限）が必要です。いつでも解約できます。",
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
