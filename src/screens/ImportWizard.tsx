// 取り込み — pick a red-sheet PDF, run color detection (with live progress + cancel),
// preview the result, choose a color preset (re-detects), name the book, and save.
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { useApp } from "../store/session";
import { useDetectionEngine } from "../engine/EngineProvider";
import { stagePdf } from "../engine/setupEngine";
import { importBookmarks, importDeck } from "../db/repo";
import { COLOR_PRESETS, DEFAULT_MAGENTA_BAND, type DeckColorConfig } from "../types";
import type { PdfDetectionResult } from "../engine/protocol";
import { colors } from "../ui/theme";

type Phase = "idle" | "detecting" | "review" | "error";

function colorForPreset(key: string): DeckColorConfig {
  const p = COLOR_PRESETS.find((x) => x.key === key);
  return p ? { ...DEFAULT_MAGENTA_BAND, hueTarget: p.hueTarget, hueTol: p.hueTol } : DEFAULT_MAGENTA_BAND;
}

export function ImportWizard() {
  const setView = useApp((s) => s.setView);
  const engine = useDetectionEngine();
  const [phase, setPhase] = useState<Phase>("idle");
  const [presetKey, setPresetKey] = useState("magenta");
  const [name, setName] = useState("");
  const [stagedUri, setStagedUri] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<PdfDetectionResult | null>(null);
  const [cover, setCover] = useState<string | undefined>(undefined);
  const [errMsg, setErrMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runToken = useRef(0);

  const runDetect = useCallback(
    async (uri: string, key: string) => {
      abortRef.current?.abort(); // cancel any in-flight run (e.g. rapid preset switch)
      const ac = new AbortController();
      abortRef.current = ac;
      const myRun = ++runToken.current;
      setPhase("detecting");
      setProgress("PDFを解析中…");
      setResult(null);
      try {
        const color = colorForPreset(key);
        // Detect first, then render the cover — they share one engine, so running them
        // sequentially avoids contention (and a cancelled run won't keep rendering a cover).
        const detection = await engine.detectAll(
          { url: uri, color },
          (p) => {
            if (myRun === runToken.current) setProgress(`検出 ${p.page}/${p.total} … ${p.found}件`);
          },
          ac.signal,
        );
        if (myRun !== runToken.current) return; // superseded by a newer run
        const coverUrl = await engine.cover({ url: uri }).catch(() => undefined);
        if (myRun !== runToken.current) return;
        setResult(detection);
        setCover(coverUrl);
        setPhase("review");
      } catch (e) {
        if (myRun !== runToken.current) return;
        if (e instanceof Error && e.message === "cancelled") {
          setPhase("idle");
          return;
        }
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [engine],
  );

  const pick = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    const uri = await stagePdf(asset.uri);
    setStagedUri(uri);
    setName(asset.name.replace(/\.pdf$/i, ""));
    runDetect(uri, presetKey);
  }, [presetKey, runDetect]);

  const changePreset = useCallback(
    (key: string) => {
      setPresetKey(key);
      if (stagedUri) runDetect(stagedUri, key);
    },
    [stagedUri, runDetect],
  );

  const save = useCallback(async () => {
    if (!result || !stagedUri) return;
    setSaving(true);
    try {
      const deckId = await importDeck({
        name: name.trim() || "無題",
        stagedPdfUri: stagedUri,
        pageCount: result.pageCount,
        pageW: result.pageW,
        pageH: result.pageH,
        color: colorForPreset(presetKey),
        clozes: result.clozes,
        coverDataUrl: cover,
      });
      // Import the PDF's built-in outline (目次) as bookmarks, if it has one.
      if (result.outline.length) await importBookmarks(deckId, result.outline);
      setView({ name: "viewer", deckId });
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStagedUri(null); // staged file may have been consumed; force a fresh pick
      setResult(null);
      setPhase("error");
    } finally {
      setSaving(false);
    }
  }, [result, stagedUri, name, presetKey, cover, setView]);

  const Presets = (
    <View style={styles.presets}>
      {COLOR_PRESETS.map((p) => (
        <Pressable
          key={p.key}
          style={[styles.chip, presetKey === p.key && styles.chipOn]}
          onPress={() => changePreset(p.key)}
        >
          <Text style={[styles.chipText, presetKey === p.key && styles.chipTextOn]}>{p.label}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <View style={styles.c}>
      <Pressable onPress={() => setView({ name: "decks" })}>
        <Text style={styles.back}>← 本棚</Text>
      </Pressable>
      <Text style={styles.title}>PDFを取り込む</Text>

      {phase === "idle" && (
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={styles.help}>
            赤シート対応PDF（色付きの答えを赤シートで隠すタイプ）を選ぶと、色付きの答えを自動検出します。
          </Text>
          <Text style={styles.label}>答えの色</Text>
          {Presets}
          <Pressable style={styles.primary} onPress={pick} disabled={!engine.ready}>
            <Text style={styles.primaryText}>
              {engine.ready ? "PDFを選ぶ" : "エンジン準備中…"}
            </Text>
          </Pressable>
        </ScrollView>
      )}

      {phase === "detecting" && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.sand} size="large" />
          <Text style={styles.status}>{progress}</Text>
          <Pressable style={styles.ghost} onPress={() => abortRef.current?.abort()}>
            <Text style={styles.ghostText}>中止</Text>
          </Pressable>
        </View>
      )}

      {phase === "review" && result && (
        <ScrollView contentContainerStyle={styles.pad}>
          <View style={styles.reviewRow}>
            {cover ? (
              <Image source={{ uri: cover }} style={styles.coverThumb} resizeMode="cover" />
            ) : (
              <View style={[styles.coverThumb, styles.coverPh]}>
                <Text style={styles.muted}>PDF</Text>
              </View>
            )}
            <View style={styles.reviewInfo}>
              <Text style={styles.detected}>{result.clozes.length} 件の答えを検出</Text>
              <Text style={styles.muted}>{result.pageCount} ページ</Text>
              {result.outline.length > 0 && (
                <Text style={styles.muted}>目次 {result.outline.length} 件を取り込み</Text>
              )}
            </View>
          </View>

          <Text style={styles.label}>本の名前</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="例: 財務諸表論" />

          <Text style={styles.label}>答えの色（変更すると再検出）</Text>
          {Presets}

          <Pressable style={styles.primary} onPress={save} disabled={saving}>
            <Text style={styles.primaryText}>{saving ? "保存中…" : "保存して開く"}</Text>
          </Pressable>
          <Pressable style={styles.ghost} onPress={pick}>
            <Text style={styles.ghostText}>別のPDFを選ぶ</Text>
          </Pressable>
        </ScrollView>
      )}

      {phase === "error" && (
        <View style={styles.center}>
          <Text style={styles.err}>{errMsg}</Text>
          <Pressable style={styles.ghost} onPress={() => setPhase("idle")}>
            <Text style={styles.ghostText}>戻る</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 20 },
  back: { color: colors.ocean, fontSize: 16 },
  title: { fontSize: 20, fontWeight: "700", color: colors.text, marginTop: 8, marginBottom: 12 },
  pad: { gap: 12, paddingBottom: 24 },
  help: { fontSize: 14, color: colors.textSub, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: "600", color: colors.text, marginTop: 8 },
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
  primary: { backgroundColor: colors.sand, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 16 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  ghost: { paddingVertical: 12, alignItems: "center" },
  ghostText: { color: colors.ocean, fontSize: 15 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  status: { fontSize: 14, color: colors.textSub },
  reviewRow: { flexDirection: "row", gap: 14, alignItems: "center" },
  coverThumb: { width: 90, height: 125, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  coverPh: { alignItems: "center", justifyContent: "center" },
  reviewInfo: { flex: 1, gap: 4 },
  detected: { fontSize: 18, fontWeight: "700", color: colors.forest },
  muted: { color: colors.muted, fontSize: 13 },
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
  err: { color: colors.error, fontSize: 14, textAlign: "center" },
});
