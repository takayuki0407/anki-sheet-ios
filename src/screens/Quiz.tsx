// Per-deck AI ○× quiz screen (RN). Mirrors the web QuizScreen: 演習 (solve) + 生成 (generate, with
// page previews + range select + bulk generate). Page text is pulled from the WebView engine
// (engine.pageText), thumbnails from engine.cover. Generation is manual and consumes the monthly
// page budget (1 per newly-generated page).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useApp, type View as AppView } from "../store/session";
import { useAccount } from "../auth/account";
import { useDetectionEngine } from "../engine/EngineProvider";
import { deckCards, getDeck, getDeckPdf, getBookQuestions } from "../db/repo";
import { deckBookId } from "../sync/deck";
import {
  AiUnavailableError,
  QuotaError,
  generatePage,
  getGenUsage,
  hasAiConsent,
  restoreCloudQuestions,
  setAiConsent,
  type Density,
  type GenUsage,
} from "../ai/generate";
import type { QuestionRow } from "../db/rows";
import { colors } from "../ui/theme";

const DENSITIES: { key: Density; label: string }[] = [
  { key: "auto", label: "おまかせ" },
  { key: "few", label: "少なめ" },
  { key: "normal", label: "標準" },
  { key: "many", label: "多め" },
];

export function Quiz({ deckId, from }: { deckId: number; from?: AppView }) {
  const setView = useApp((s) => s.setView);
  const user = useAccount((s) => s.user);
  const engine = useDetectionEngine();

  const [name, setName] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [bookId, setBookId] = useState<string | null>(null);
  const [termsByPage, setTermsByPage] = useState<Map<number, string[]>>(new Map());
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [usage, setUsage] = useState<GenUsage | null>(null);
  const [tab, setTab] = useState<"solve" | "generate">("solve");

  const reloadQuestions = useCallback(async (bid: string) => {
    setQuestions(await getBookQuestions(bid));
  }, []);
  const refreshUsage = useCallback(() => {
    void getGenUsage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const [d, pdf, cards, bid] = await Promise.all([
        getDeck(deckId),
        getDeckPdf(deckId),
        deckCards(deckId),
        deckBookId(deckId),
      ]);
      if (!live) return;
      setName(d?.name ?? "");
      setPdfUrl(pdf?.filePath ?? null);
      setBookId(bid ?? null);
      // Register EVERY page that has an answer (memorization spot), pushing the recovered answer text
      // only when present. The page list keys off this map, so pages whose answers have no recovered
      // text (e.g. CID fonts without ToUnicode) still appear — the AI reads full page text separately.
      const m = new Map<number, string[]>();
      for (const c of cards) {
        const arr = m.get(c.pageIndex) ?? [];
        if (c.text?.trim()) arr.push(c.text);
        m.set(c.pageIndex, arr);
      }
      setTermsByPage(m);
      if (bid) {
        if (user) await restoreCloudQuestions(bid).catch(() => {});
        if (live) await reloadQuestions(bid);
        if (live) refreshUsage();
      }
    })();
    return () => {
      live = false;
    };
  }, [deckId, user, reloadQuestions, refreshUsage]);

  const countsByPage = useMemo(() => {
    const m = new Map<number, number>();
    for (const q of questions) m.set(q.pageIndex, (m.get(q.pageIndex) ?? 0) + 1);
    return m;
  }, [questions]);

  return (
    <View style={styles.c}>
      <View style={styles.head}>
        <Pressable onPress={() => setView(from ?? { name: "decks" })} hitSlop={8}>
          <Text style={styles.back}>← 戻る</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          AI問題 — {name}
        </Text>
      </View>

      <Text style={styles.quota}>
        {usage
          ? usage.unlimited
            ? `今月の生成：${usage.count} ページ（無制限）`
            : `今月の生成枠：残り ${usage.remaining} / ${usage.limit} ページ`
          : "枠を確認中…"}
      </Text>

      <View style={styles.tabs}>
        <Tab label={`演習（${questions.length}問）`} on={tab === "solve"} onPress={() => setTab("solve")} />
        <Tab label="問題を作る" on={tab === "generate"} onPress={() => setTab("generate")} />
      </View>

      {tab === "solve" ? (
        <SolveTab questions={questions} onGenerate={() => setTab("generate")} />
      ) : (
        <GenerateTab
          bookId={bookId}
          pdfUrl={pdfUrl}
          engine={engine}
          termsByPage={termsByPage}
          countsByPage={countsByPage}
          usage={usage}
          defaultHint={name}
          onGenerated={async () => {
            if (bookId) await reloadQuestions(bookId);
            refreshUsage();
          }}
        />
      )}
    </View>
  );
}

function Tab({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tab, on && styles.tabOn]} onPress={onPress}>
      <Text style={[styles.tabText, on && styles.tabTextOn]}>{label}</Text>
    </Pressable>
  );
}

// ---- 生成タブ ----------------------------------------------------------------------------------

function GenerateTab({
  bookId,
  pdfUrl,
  engine,
  termsByPage,
  countsByPage,
  usage,
  defaultHint,
  onGenerated,
}: {
  bookId: string | null;
  pdfUrl: string | null;
  engine: ReturnType<typeof useDetectionEngine>;
  termsByPage: Map<number, string[]>;
  countsByPage: Map<number, number>;
  usage: GenUsage | null;
  defaultHint: string;
  onGenerated: () => Promise<void> | void;
}) {
  const [density, setDensity] = useState<Density>("auto");
  const [hint, setHint] = useState(defaultHint);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const pages = useMemo(() => [...termsByPage.keys()].sort((a, b) => a - b), [termsByPage]);
  const toGenerate = useMemo(
    () => [...selected].filter((p) => !(countsByPage.get(p) ?? 0)).sort((a, b) => a - b),
    [selected, countsByPage],
  );

  const toggle = (p: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const applyRange = () => {
    const a = parseInt(from, 10);
    const b = parseInt(to, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const lo = Math.min(a, b) - 1;
    const hi = Math.max(a, b) - 1;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of pages) if (p >= lo && p <= hi) next.add(p);
      return next;
    });
  };

  const ensureConsent = (): Promise<boolean> =>
    new Promise((resolve) => {
      void hasAiConsent().then((ok) => {
        if (ok) return resolve(true);
        Alert.alert(
          "AI問題生成について",
          "この機能では、選んだページの本文と暗記語句を、当アプリのサーバー経由で AI（Anthropic）に送信して問題を作成します。赤シート・色の検出など他の機能は、これまでどおり端末内だけで完結します。\n\n同意して続けますか？",
          [
            { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
            { text: "同意して続ける", onPress: () => void setAiConsent().then(() => resolve(true)) },
          ],
        );
      });
    });

  const run = async () => {
    if (!bookId || !pdfUrl || !toGenerate.length || progress) return;
    if (!(await ensureConsent())) return;
    setMsg(null);
    let texts: { page: number; text: string }[] = [];
    try {
      texts = await engine.pageText({ url: pdfUrl, pages: toGenerate });
    } catch (e) {
      setMsg("本文の取得に失敗しました：" + (e instanceof Error ? e.message : String(e)));
      return;
    }
    const textMap = new Map(texts.map((t) => [t.page, t.text]));
    const errors: number[] = [];
    let done = 0;
    for (const p of toGenerate) {
      setProgress({ done, total: toGenerate.length });
      const terms = termsByPage.get(p) ?? [];
      const text = textMap.get(p) ?? "";
      if (!terms.length || !text.trim()) {
        errors.push(p);
        continue;
      }
      try {
        await generatePage({ bookId, pageIndex: p, pageText: text, markedTerms: terms, density, subjectHint: hint, regenerate: false });
        done++;
        await onGenerated();
      } catch (e) {
        if (e instanceof QuotaError) {
          setMsg(`今月の生成枠を使い切りました（${e.limit}ページ）。来月またご利用いただくか、上位プランをご検討ください。`);
          break;
        }
        if (e instanceof AiUnavailableError) {
          setMsg("AI生成が未設定です。少し時間をおいてお試しください。");
          break;
        }
        errors.push(p);
      }
    }
    setProgress(null);
    setSelected(new Set());
    await onGenerated();
    if (!msg) {
      const parts = [`${done}ページ分の問題を作成しました。`];
      if (errors.length) parts.push(`${errors.length}ページは本文が取得できず作成できませんでした。`);
      setMsg(parts.join(""));
    }
  };

  if (!bookId)
    return (
      <Text style={styles.muted}>
        この本はまだアカウントに登録されていません（取り込み直すと有効になります）。
      </Text>
    );

  const remaining = usage && !usage.unlimited ? usage.remaining : Infinity;

  const header = (
    <View>
      <View style={styles.genRow}>
        <Text style={styles.genLabel}>問題の量</Text>
        <View style={styles.presetRow}>
          {DENSITIES.map((d) => (
            <Pressable key={d.key} style={[styles.preset, density === d.key && styles.presetOn]} onPress={() => setDensity(d.key)}>
              <Text style={[styles.presetText, density === d.key && styles.presetTextOn]}>{d.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={styles.genRow}>
        <Text style={styles.genLabel}>科目ヒント</Text>
        <TextInput style={styles.hintInput} value={hint} onChangeText={setHint} placeholder="任意（例：日本史B）" placeholderTextColor={colors.muted} />
      </View>
      <View style={styles.genRow}>
        <Text style={styles.genLabel}>ページ範囲</Text>
        <TextInput style={styles.rangeNum} value={from} onChangeText={setFrom} keyboardType="number-pad" placeholder="開始" placeholderTextColor={colors.muted} />
        <Text>〜</Text>
        <TextInput style={styles.rangeNum} value={to} onChangeText={setTo} keyboardType="number-pad" placeholder="終了" placeholderTextColor={colors.muted} />
        <Pressable style={styles.smBtn} onPress={applyRange}>
          <Text style={styles.smBtnText}>範囲選択</Text>
        </Pressable>
        <Pressable style={styles.smBtn} onPress={() => setSelected(new Set())}>
          <Text style={styles.smBtnText}>クリア</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>
        暗記箇所のあるページのみ表示（{pages.length}ページ）。選んで「まとめて生成」。生成済みは枠を消費しません。
      </Text>
    </View>
  );

  return (
    <View style={styles.flex}>
      <FlatList
        data={pages}
        keyExtractor={(p) => String(p)}
        numColumns={3}
        columnWrapperStyle={styles.pickerRow}
        contentContainerStyle={styles.pickerContent}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        renderItem={({ item: p }) => (
          <PageCard
            engine={engine}
            pdfUrl={pdfUrl}
            pageIndex={p}
            terms={termsByPage.get(p)?.length ?? 0}
            generated={countsByPage.get(p) ?? 0}
            selected={selected.has(p)}
            onToggle={() => toggle(p)}
          />
        )}
      />
      <View style={styles.genFooter}>
        {progress ? (
          <Text>生成中… {progress.done}/{progress.total}</Text>
        ) : (
          <Pressable
            style={[styles.primary, (!toGenerate.length || !pdfUrl) && styles.disabled]}
            disabled={!toGenerate.length || !pdfUrl}
            onPress={() => void run()}
          >
            <Text style={styles.primaryText}>選んだ {toGenerate.length} ページをまとめて生成</Text>
          </Pressable>
        )}
        {toGenerate.length > remaining && !progress ? (
          <Text style={styles.warn}>残り枠 {remaining} ページを超える分は生成されません。</Text>
        ) : null}
        {msg ? <Text style={styles.msg}>{msg}</Text> : null}
      </View>
    </View>
  );
}

function PageCard({
  engine,
  pdfUrl,
  pageIndex,
  terms,
  generated,
  selected,
  onToggle,
}: {
  engine: ReturnType<typeof useDetectionEngine>;
  pdfUrl: string | null;
  pageIndex: number;
  terms: number;
  generated: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    if (!pdfUrl || !engine.ready) return;
    let live = true;
    void engine
      .cover({ url: pdfUrl, page: pageIndex, maxWidth: 160 })
      .then((u) => live && setUri(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [engine, pdfUrl, pageIndex]);
  return (
    <Pressable style={[styles.card, selected && styles.cardSel]} onPress={onToggle}>
      <View style={styles.thumb}>
        {uri ? <Image source={{ uri }} style={styles.thumbImg} resizeMode="cover" /> : <ActivityIndicator color={colors.sand} />}
        {selected ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>✓</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.cardMeta}>
        <Text style={styles.cardP}>P.{pageIndex + 1}</Text>
        <Text style={styles.muted}>{generated ? `✓${generated}問` : `暗記${terms}`}</Text>
      </View>
    </Pressable>
  );
}

// ---- 演習タブ ----------------------------------------------------------------------------------

function SolveTab({ questions, onGenerate }: { questions: QuestionRow[]; onGenerate: () => void }) {
  const [session, setSession] = useState<QuestionRow[] | null>(null);
  const byPage = useMemo(() => {
    const m = new Map<number, QuestionRow[]>();
    for (const q of questions) {
      const arr = m.get(q.pageIndex) ?? [];
      arr.push(q);
      m.set(q.pageIndex, arr);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [questions]);

  if (session) return <SolveSession questions={session} onExit={() => setSession(null)} />;
  if (!questions.length)
    return (
      <View style={styles.empty}>
        <Text style={styles.muted}>まだ問題がありません。</Text>
        <Pressable style={styles.primary} onPress={onGenerate}>
          <Text style={styles.primaryText}>問題を作る</Text>
        </Pressable>
      </View>
    );
  return (
    <ScrollView contentContainerStyle={styles.solveList}>
      <Pressable style={styles.primary} onPress={() => setSession(questions)}>
        <Text style={styles.primaryText}>全問を解く（{questions.length}問）</Text>
      </Pressable>
      {byPage.map(([page, qs]) => (
        <Pressable key={page} style={styles.solvePageBtn} onPress={() => setSession(qs)}>
          <Text style={styles.solvePageText}>P.{page + 1}</Text>
          <Text style={styles.muted}>{qs.length}問</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SolveSession({ questions, onExit }: { questions: QuestionRow[]; onExit: () => void }) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<"正" | "誤" | null>(null);
  const correct = useRef(0);
  const q = questions[i];

  if (i >= questions.length)
    return (
      <View style={styles.empty}>
        <Text style={styles.doneTitle}>おつかれさまでした</Text>
        <Text>
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
          <Text style={styles.back}>一覧へ戻る</Text>
        </Pressable>
      </View>
    );

  const pick = (a: "正" | "誤") => {
    if (picked) return;
    if (a === q.answer) correct.current += 1;
    setPicked(a);
  };
  const isRight = picked === q.answer;
  return (
    <ScrollView contentContainerStyle={styles.session}>
      <View style={styles.sessionTop}>
        <Text style={styles.muted}>
          {i + 1} / {questions.length}（P.{q.pageIndex + 1}）
        </Text>
        <Pressable onPress={onExit} hitSlop={8}>
          <Text style={styles.back}>中断</Text>
        </Pressable>
      </View>
      <Text style={styles.statement}>{q.statement}</Text>
      {!picked ? (
        <View style={styles.choices}>
          <Pressable style={[styles.choice, styles.maru]} onPress={() => pick("正")}>
            <Text style={styles.maruText}>○ 正しい</Text>
          </Pressable>
          <Pressable style={[styles.choice, styles.batsu]} onPress={() => pick("誤")}>
            <Text style={styles.batsuText}>× 誤り</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.reveal}>
          <Text style={[styles.verdict, isRight ? styles.right : styles.wrong]}>
            {isRight ? "正解！" : "不正解"} — この文は「{q.answer}」
          </Text>
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
  c: { flex: 1, padding: 14 },
  flex: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  back: { color: colors.ocean, fontSize: 15 },
  title: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.text },
  quota: { fontSize: 14, color: colors.text, marginBottom: 10 },
  tabs: { flexDirection: "row", gap: 8, marginBottom: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  tabOn: { backgroundColor: colors.sand, borderColor: colors.sand },
  tabText: { fontSize: 14, fontWeight: "600", color: colors.text },
  tabTextOn: { color: "#fff" },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17, marginVertical: 4 },
  genRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 },
  genLabel: { fontSize: 13, fontWeight: "700", color: colors.text, minWidth: 64 },
  presetRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  preset: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  presetOn: { backgroundColor: colors.sand, borderColor: colors.sand },
  presetText: { fontSize: 13, color: colors.text },
  presetTextOn: { color: "#fff", fontWeight: "700" },
  hintInput: { flex: 1, minWidth: 150, fontSize: 15, color: colors.text, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  rangeNum: { width: 70, fontSize: 15, color: colors.text, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8 },
  smBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  smBtnText: { fontSize: 13, color: colors.ocean, fontWeight: "600" },
  pickerRow: { gap: 10 },
  pickerContent: { paddingBottom: 16, gap: 12 },
  card: { flex: 1 / 3, maxWidth: "31%", marginBottom: 10 },
  cardSel: {},
  thumb: { aspectRatio: 0.7, borderRadius: 6, overflow: "hidden", backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  thumbImg: { width: "100%", height: "100%" },
  badge: { position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.sand, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  cardMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 },
  cardP: { fontSize: 12, color: colors.text, fontWeight: "600" },
  genFooter: { paddingTop: 8, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  primary: { backgroundColor: colors.sand, paddingVertical: 13, paddingHorizontal: 18, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  warn: { color: colors.sand, fontSize: 12 },
  msg: { backgroundColor: colors.surface, padding: 10, borderRadius: 8, fontSize: 14, color: colors.text },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  solveList: { gap: 8, paddingBottom: 16 },
  solvePageBtn: { flexDirection: "row", justifyContent: "space-between", padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface },
  solvePageText: { fontSize: 15, color: colors.text, fontWeight: "600" },
  session: { gap: 16, paddingBottom: 24 },
  sessionTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statement: { fontSize: 18, lineHeight: 28, color: colors.text, padding: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  choices: { flexDirection: "row", gap: 12 },
  choice: { flex: 1, paddingVertical: 16, borderRadius: 12, alignItems: "center", borderWidth: 1 },
  maru: { backgroundColor: "#e7f3ff", borderColor: colors.ocean },
  maruText: { color: colors.ocean, fontSize: 16, fontWeight: "700" },
  batsu: { backgroundColor: "#fdeaea", borderColor: "#c0392b" },
  batsuText: { color: "#c0392b", fontSize: 16, fontWeight: "700" },
  reveal: { gap: 10 },
  verdict: { fontSize: 16, fontWeight: "800" },
  right: { color: "#1f7a3d" },
  wrong: { color: "#c0392b" },
  explain: { fontSize: 15, lineHeight: 23, color: colors.text },
  doneTitle: { fontSize: 20, fontWeight: "800", color: colors.text },
});
