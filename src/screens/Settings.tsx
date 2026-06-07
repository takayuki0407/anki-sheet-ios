// 設定・再検出 — rename, tune the answer-color band with a live single-page preview
// (the engine renders a sample page with the would-be answers masked), then re-detect the
// whole PDF under the new config, or delete the deck.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useApp } from "../store/session";
import { useDetectionEngine } from "../engine/EngineProvider";
import {
  deleteDeck,
  firstAnswerPage,
  getDeck,
  getDeckPdf,
  redetectDeck,
  updateDeck,
} from "../db/repo";
import { COLOR_PRESETS, DEFAULT_MAGENTA_BAND, type DeckColorConfig } from "../types";
import { colors } from "../ui/theme";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

function Stepper({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{label}</Text>
      <View style={styles.stepCtrls}>
        <Pressable style={styles.stepBtn} onPress={onDec} hitSlop={6}>
          <Text style={styles.stepBtnTxt}>−</Text>
        </Pressable>
        <Text style={styles.stepVal}>{value}</Text>
        <Pressable style={styles.stepBtn} onPress={onInc} hitSlop={6}>
          <Text style={styles.stepBtnTxt}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function Settings({ deckId }: { deckId: number }) {
  const setView = useApp((s) => s.setView);
  const engine = useDetectionEngine();
  const [url, setUrl] = useState<string | null>(null);
  const [samplePage, setSamplePage] = useState(0);
  const [name, setName] = useState("");
  const [color, setColor] = useState<DeckColorConfig>(DEFAULT_MAGENTA_BAND);
  const [preview, setPreview] = useState<{ dataUrl: string; count: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [redetecting, setRedetecting] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [deck, pdf, fp] = await Promise.all([
        getDeck(deckId),
        getDeckPdf(deckId),
        firstAnswerPage(deckId),
      ]);
      if (!alive) return;
      if (!deck || !pdf) {
        setErr("デッキが見つかりません");
        return;
      }
      setName(deck.name);
      setColor(deck.color);
      setUrl(pdf.filePath);
      setSamplePage(fp);
    })();
    return () => {
      alive = false;
    };
  }, [deckId]);

  // Live preview: re-render the sample page whenever the color config changes (debounced).
  useEffect(() => {
    if (!url || !engine.ready) return;
    let cancelled = false;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        setPreviewing(true);
        const r = await engine.preview({ url, color, page: samplePage });
        if (!cancelled) setPreview(r);
      } catch {
        /* preview is best-effort */
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 350);
    return () => {
      cancelled = true; // ignore a slower-resolving preview from a superseded config
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [url, color, samplePage, engine.ready, engine.preview]);

  const applyPreset = (key: string) => {
    const p = COLOR_PRESETS.find((x) => x.key === key);
    if (p) setColor((c) => ({ ...c, hueTarget: p.hueTarget, hueTol: p.hueTol }));
  };
  const patch = (p: Partial<DeckColorConfig>) => setColor((c) => ({ ...c, ...p }));

  const redetect = useCallback(async () => {
    if (!url) return;
    try {
      setRedetecting(true);
      setProgress("再検出中…");
      await updateDeck(deckId, { name: name.trim() || "無題" });
      const det = await engine.detectAll({ url, color }, (pr) =>
        setProgress(`検出 ${pr.page}/${pr.total} … ${pr.found}件`),
      );
      const n = await redetectDeck(deckId, color, det.clozes);
      Alert.alert("再検出が完了", `${n} 件の答えを検出しました。`, [
        { text: "OK", onPress: () => setView({ name: "viewer", deckId }) },
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRedetecting(false);
    }
  }, [url, color, deckId, name, engine, setView]);

  const back = useCallback(async () => {
    await updateDeck(deckId, { name: name.trim() || "無題" });
    setView({ name: "decks" });
  }, [deckId, name, setView]);

  const confirmDelete = () =>
    Alert.alert("削除しますか?", `「${name}」と検出結果を削除します。`, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          await deleteDeck(deckId);
          setView({ name: "decks" });
        },
      },
    ]);

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
          <Text style={styles.link}>← 本棚</Text>
        </Pressable>
        <Text style={styles.title}>設定・再検出</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView contentContainerStyle={styles.pad}>
        <View style={styles.previewBox}>
          {preview ? (
            <Image source={{ uri: preview.dataUrl }} style={styles.preview} resizeMode="contain" />
          ) : (
            <View style={styles.previewPh}>
              <ActivityIndicator color={colors.sand} />
            </View>
          )}
          <View style={styles.previewBar}>
            <Text style={styles.previewTxt}>
              プレビュー: {preview ? `${preview.count} 件` : "…"}
              {previewing ? "（更新中）" : ""}
            </Text>
          </View>
        </View>

        <Text style={styles.label}>本の名前</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} />

        <Text style={styles.label}>答えの色（プリセット）</Text>
        <View style={styles.presets}>
          {COLOR_PRESETS.map((p) => (
            <Pressable
              key={p.key}
              style={[styles.chip, hueDist(color.hueTarget, p.hueTarget) < 4 && styles.chipOn]}
              onPress={() => applyPreset(p.key)}
            >
              <Text
                style={[
                  styles.chipText,
                  hueDist(color.hueTarget, p.hueTarget) < 4 && styles.chipTextOn,
                ]}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>詳細調整</Text>
        <Stepper
          label="色相 (hue)"
          value={`${Math.round(color.hueTarget)}°`}
          onDec={() => patch({ hueTarget: (color.hueTarget + 358) % 360 })}
          onInc={() => patch({ hueTarget: (color.hueTarget + 2) % 360 })}
        />
        <Stepper
          label="許容幅 (±°)"
          value={`${Math.round(color.hueTol)}`}
          onDec={() => patch({ hueTol: clamp(color.hueTol - 2, 4, 60) })}
          onInc={() => patch({ hueTol: clamp(color.hueTol + 2, 4, 60) })}
        />
        <Stepper
          label="彩度の下限"
          value={color.satMin.toFixed(2)}
          onDec={() => patch({ satMin: clamp(+(color.satMin - 0.05).toFixed(2), 0.1, 0.9) })}
          onInc={() => patch({ satMin: clamp(+(color.satMin + 0.05).toFixed(2), 0.1, 0.9) })}
        />
        <Stepper
          label="見出し除外（小さいほど強い）"
          value={color.maxHeightRatio >= 9 ? "オフ" : color.maxHeightRatio.toFixed(1)}
          onDec={() =>
            patch({
              maxHeightRatio:
                color.maxHeightRatio >= 9 ? 2.8 : clamp(+(color.maxHeightRatio - 0.2).toFixed(1), 1, 9),
            })
          }
          onInc={() =>
            patch({
              maxHeightRatio:
                color.maxHeightRatio >= 2.8 ? 9 : clamp(+(color.maxHeightRatio + 0.2).toFixed(1), 1, 9),
            })
          }
        />

        <Pressable
          style={[styles.primary, redetecting && styles.disabled]}
          onPress={redetect}
          disabled={redetecting}
        >
          <Text style={styles.primaryText}>
            {redetecting ? progress || "再検出中…" : "このPDFを再検出して保存"}
          </Text>
        </Pressable>
        <Text style={styles.note}>
          ※ 詳細調整やプリセットを変えたら「再検出」で全ページに反映されます。
        </Text>

        <Pressable style={styles.delete} onPress={confirmDelete}>
          <Text style={styles.deleteText}>このデッキを削除</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  err: { color: colors.error, fontSize: 14 },
  link: { color: colors.ocean, fontSize: 16, width: 60 },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  pad: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  previewBox: {
    backgroundColor: "#525659",
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 8,
  },
  preview: { width: "100%", height: 320, backgroundColor: "#525659" },
  previewPh: { height: 320, alignItems: "center", justifyContent: "center" },
  previewBar: { padding: 8, backgroundColor: "rgba(0,0,0,0.35)" },
  previewTxt: { color: "#fff", fontSize: 13, textAlign: "center" },
  label: { fontSize: 13, fontWeight: "600", color: colors.text, marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.sand, borderColor: colors.sand },
  chipText: { color: colors.text, fontSize: 14 },
  chipTextOn: { color: "#fff", fontWeight: "700" },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  stepLabel: { fontSize: 14, color: colors.text, flex: 1 },
  stepCtrls: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnTxt: { fontSize: 20, color: colors.sand, fontWeight: "700" },
  stepVal: { fontSize: 15, color: colors.text, minWidth: 54, textAlign: "center" },
  primary: {
    backgroundColor: colors.sand,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 18,
  },
  disabled: { opacity: 0.6 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  note: { fontSize: 12, color: colors.textSub, marginTop: 8 },
  delete: { marginTop: 28, alignItems: "center", paddingVertical: 12 },
  deleteText: { color: colors.error, fontSize: 15 },
});
