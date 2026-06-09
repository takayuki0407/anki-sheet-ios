// 取り込み — pick a red-sheet PDF, choose the answer color (自動 / preset), run color
// detection (live progress + cancel), preview ANY page of the result, name the book, and save.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { syncNewDeck } from "../sync/deck";
import { COLOR_PRESETS, DEFAULT_MAGENTA_BAND, type DeckColorConfig } from "../types";
import type { PdfDetectionResult } from "../engine/protocol";
import { colors } from "../ui/theme";

type Phase = "idle" | "configuring" | "detecting" | "review" | "error";

// Per-file size cap (Pro cloud sync is bounded to 5GB total; a 100MB/file ceiling keeps any
// single book reasonable for storage + on-device memory during detection).
const MAX_PDF_MB = 100;
const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;

function colorForPreset(key: string): DeckColorConfig {
  const p = COLOR_PRESETS.find((x) => x.key === key);
  return p ? { ...DEFAULT_MAGENTA_BAND, hueTarget: p.hueTarget, hueTol: p.hueTol } : DEFAULT_MAGENTA_BAND;
}

export function ImportWizard() {
  const setView = useApp((s) => s.setView);
  const engine = useDetectionEngine();
  const [phase, setPhase] = useState<Phase>("idle");
  const [name, setName] = useState("");
  const [stagedUri, setStagedUri] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<PdfDetectionResult | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const [saving, setSaving] = useState(false);
  // Answer-color choice made BEFORE detecting (the user picks; no silent auto-detect):
  // 自動 (probe + pick one) OR a single manual preset.
  const [useAuto, setUseAuto] = useState(true);
  const [manualKey, setManualKey] = useState("red");
  const [primaryColor, setPrimaryColor] = useState<DeckColorConfig>(DEFAULT_MAGENTA_BAND);
  // Result-screen preview: a rendered page (with detection) the user can flip through (any page).
  const [previewPage, setPreviewPage] = useState(0);
  const [preview, setPreview] = useState<{ dataUrl: string; count: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runToken = useRef(0);

  // Detect for the chosen color: 自動 probes + picks one; manual uses the selected preset.
  // Cancel returns to the color chooser so the user can adjust + retry.
  const runDetect = useCallback(
    async (uri: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const myRun = ++runToken.current;
      setPhase("detecting");
      setResult(null);
      try {
        let res: PdfDetectionResult;
        let primary: DeckColorConfig;
        if (useAuto) {
          setProgress("答えの色を判定中…");
          const det = await engine.detectAll(
            { url: uri, auto: true },
            (p) => {
              if (myRun === runToken.current) setProgress(`検出 ${p.page}/${p.total} … ${p.found}件`);
            },
            ac.signal,
          );
          if (myRun !== runToken.current) return;
          res = det;
          primary = det.color ?? DEFAULT_MAGENTA_BAND;
        } else {
          const cfg = colorForPreset(manualKey);
          const r = await engine.detectAll(
            { url: uri, color: cfg },
            (p) => {
              if (myRun === runToken.current) setProgress(`検出 ${p.page}/${p.total} … ${p.found}件`);
            },
            ac.signal,
          );
          if (myRun !== runToken.current) return;
          res = r;
          primary = cfg;
        }
        setPrimaryColor(primary);
        setResult(res);
        setPreviewPage(0);
        setPreview(null);
        setPhase("review");
      } catch (e) {
        if (myRun !== runToken.current) return;
        if (e instanceof Error && e.message === "cancelled") {
          setPhase("configuring");
          return;
        }
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [engine, useAuto, manualKey],
  );

  const pick = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    if (asset.size != null && asset.size > MAX_PDF_BYTES) {
      setErrMsg(
        `PDFが大きすぎます（${Math.round(asset.size / 1024 / 1024)}MB）。1ファイル ${MAX_PDF_MB}MB までです。`,
      );
      setPhase("error");
      return;
    }
    const uri = await stagePdf(asset.uri);
    setStagedUri(uri);
    setName(asset.name.replace(/\.pdf$/i, ""));
    setPhase("configuring"); // choose the answer color(s), then 取り込む
  }, []);

  // Render the preview page (with detection) whenever the page / primary color changes (debounced).
  // Uses the primary color — for a multi-color import the saved deck still has the full union.
  useEffect(() => {
    if (phase !== "review" || !stagedUri || !engine.ready) return;
    let cancelled = false;
    setPreviewing(true);
    const id = setTimeout(async () => {
      try {
        const r = await engine.preview({ url: stagedUri, color: primaryColor, page: previewPage });
        if (!cancelled) setPreview(r);
      } catch {
        /* preview is best-effort */
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [phase, stagedUri, primaryColor, previewPage, engine]);

  const save = useCallback(async () => {
    if (!result || !stagedUri) return;
    setSaving(true);
    try {
      const cover = await engine.cover({ url: stagedUri }).catch(() => undefined);
      const deckId = await importDeck({
        name: name.trim() || "無題",
        stagedPdfUri: stagedUri,
        pageCount: result.pageCount,
        pageW: result.pageW,
        pageH: result.pageH,
        color: primaryColor,
        clozes: result.clozes,
        coverDataUrl: cover,
      });
      if (result.outline.length) await importBookmarks(deckId, result.outline);
      // Cloud sync (Pro): reserve the slot + upload in the background; best-effort + fail-open.
      void syncNewDeck(deckId, name.trim() || "無題", result.pageCount).catch(() => {});
      setView({ name: "viewer", deckId }); // 保存して開く
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStagedUri(null); // staged file may have been consumed; force a fresh pick
      setResult(null);
      setPhase("error");
    } finally {
      setSaving(false);
    }
  }, [result, stagedUri, name, primaryColor, engine, setView]);

  // 答えの色: 自動 + the presets (manual is multi-select). Shared by configure + review screens.
  const ColorChooser = (
    <View style={styles.presets}>
      <Pressable style={[styles.chip, useAuto && styles.chipOn]} onPress={() => setUseAuto(true)}>
        <Text style={[styles.chipText, useAuto && styles.chipTextOn]}>自動</Text>
      </Pressable>
      {COLOR_PRESETS.map((p) => {
        const on = !useAuto && manualKey === p.key;
        return (
          <Pressable
            key={p.key}
            style={[styles.chip, on && styles.chipOn]}
            onPress={() => {
              setUseAuto(false);
              setManualKey(p.key);
            }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const pageCount = result?.pageCount ?? 1;

  return (
    <View style={styles.c}>
      <Pressable onPress={() => setView({ name: "decks" })}>
        <Text style={styles.back}>← 本棚</Text>
      </Pressable>
      <Text style={styles.title}>PDFを取り込む</Text>

      {phase === "idle" && (
        <ScrollView
          contentContainerStyle={styles.pad}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.help}>
            赤シート対応PDF（色付きの答えを赤シートで隠すタイプ）を選び、次の画面で答えの色（自動／赤・マゼンタなど）を選んで検出します。
          </Text>
          <Pressable style={styles.primary} onPress={pick} disabled={!engine.ready}>
            <Text style={styles.primaryText}>{engine.ready ? "PDFを選ぶ" : "エンジン準備中…"}</Text>
          </Pressable>
        </ScrollView>
      )}

      {phase === "configuring" && (
        <ScrollView
          contentContainerStyle={styles.pad}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.help}>「{name || "無題"}」を取り込みます。答えの色を選んでください。</Text>
          <Text style={styles.label}>答えの色</Text>
          {ColorChooser}
          <Text style={styles.muted}>
            自動はシステムが答えの色を判定します。手動で色を選ぶこともできます。
          </Text>
          <Pressable style={styles.primary} onPress={() => stagedUri && runDetect(stagedUri)}>
            <Text style={styles.primaryText}>取り込む</Text>
          </Pressable>
          <Pressable style={styles.ghost} onPress={pick}>
            <Text style={styles.ghostText}>別のPDFを選ぶ</Text>
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
        <ScrollView
          contentContainerStyle={styles.pad}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.detected}>{result.clozes.length} 件の答えを検出</Text>
          <Text style={styles.muted}>
            {result.pageCount} ページ
            {result.outline.length > 0 ? ` ・ 目次 ${result.outline.length} 件を取り込み` : ""}
          </Text>

          <View style={styles.previewBox}>
            {preview ? (
              <Image source={{ uri: preview.dataUrl }} style={styles.preview} resizeMode="contain" />
            ) : (
              <View style={styles.previewPh}>
                <ActivityIndicator color={colors.sand} />
              </View>
            )}
          </View>
          <View style={styles.navRow}>
            <Pressable
              style={[styles.navBtn, previewPage <= 0 && styles.navOff]}
              disabled={previewPage <= 0}
              onPress={() => setPreviewPage((p) => Math.max(0, p - 1))}
            >
              <Text style={styles.navText}>← 前</Text>
            </Pressable>
            <Text style={styles.muted}>
              p.{previewPage + 1}/{pageCount}
              {preview ? ` ・ 検出 ${preview.count} 個` : ""}
              {previewing ? "（更新中）" : ""}
            </Text>
            <Pressable
              style={[styles.navBtn, previewPage >= pageCount - 1 && styles.navOff]}
              disabled={previewPage >= pageCount - 1}
              onPress={() => setPreviewPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              <Text style={styles.navText}>次 →</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>本の名前</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="例: 財務諸表論" />

          <Text style={styles.label}>答えの色（変更すると再検出）</Text>
          {ColorChooser}
          <Pressable style={styles.ghost} onPress={() => stagedUri && runDetect(stagedUri)}>
            <Text style={styles.ghostText}>この色で再検出</Text>
          </Pressable>

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
  detected: { fontSize: 18, fontWeight: "700", color: colors.forest },
  muted: { color: colors.muted, fontSize: 13 },
  previewBox: {
    height: 380,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
    marginTop: 4,
  },
  preview: { width: "100%", height: "100%" },
  previewPh: { flex: 1, alignItems: "center", justifyContent: "center" },
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  navBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  navOff: { opacity: 0.4 },
  navText: { color: colors.ocean, fontSize: 14 },
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
