// Dev-only engine validation screen (reached from the bookshelf footer). Exercises the
// full render + detection pipeline on a picked PDF using the shared headless engine.
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { useApp } from "../store/session";
import { useDetectionEngine } from "../engine/EngineProvider";
import { stagePdf } from "../engine/setupEngine";
import type { PdfDetectionResult } from "../engine/protocol";
import { colors } from "../ui/theme";

export function EngineTest() {
  const setView = useApp((s) => s.setView);
  const engine = useDetectionEngine();
  const [status, setStatus] = useState("PDFを選んで検出を試せます");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PdfDetectionResult | null>(null);

  const run = useCallback(async () => {
    try {
      setBusy(true);
      setResult(null);
      setStatus("PDF選択中…");
      const res = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) {
        setStatus("キャンセル");
        return;
      }
      const url = await stagePdf(res.assets[0].uri);
      setStatus("検出中…");
      const t0 = Date.now();
      const det = await engine.detectAll({ url }, (p) =>
        setStatus(`検出 ${p.page}/${p.total} … ${p.found}件`),
      );
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      setResult(det);
      setStatus(`完了 ${det.clozes.length}件 / ${det.pageCount}ページ (${s}s)`);
    } catch (e) {
      setStatus("エラー: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, [engine]);

  return (
    <View style={styles.c}>
      <Pressable onPress={() => setView({ name: "decks" })}>
        <Text style={styles.back}>← 本棚</Text>
      </Pressable>
      <Text style={styles.title}>エンジン検証 (M0)</Text>
      <Text style={styles.sub}>engine: {engine.buildId ?? (engine.error ? "ERROR" : "準備中…")}</Text>
      {engine.error ? <Text style={styles.err}>{engine.error}</Text> : null}
      <Pressable
        style={[styles.btn, (busy || !engine.ready) && styles.btnOff]}
        disabled={busy || !engine.ready}
        onPress={run}
      >
        <Text style={styles.btnText}>{busy ? "処理中…" : "PDFを選んで検出"}</Text>
      </Pressable>
      <Text style={styles.status}>{status}</Text>
      {result ? (
        <View style={styles.card}>
          <Text style={styles.line}>
            ページ: {result.pageCount} / サイズ {Math.round(result.pageW)}×{Math.round(result.pageH)} pt
          </Text>
          <Text style={styles.strong}>検出: {result.clozes.length} 件</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 20, gap: 10 },
  back: { color: colors.ocean, fontSize: 16, marginBottom: 8 },
  title: { fontSize: 20, fontWeight: "700", color: colors.text },
  sub: { fontSize: 12, color: colors.textSub },
  err: { color: colors.error, fontSize: 13 },
  btn: { backgroundColor: colors.sand, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 8 },
  btnOff: { opacity: 0.5 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  status: { fontSize: 14, color: colors.textSub },
  card: { padding: 14, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, gap: 4 },
  line: { fontSize: 14, color: colors.text },
  strong: { fontSize: 16, fontWeight: "700", color: colors.forest },
});
