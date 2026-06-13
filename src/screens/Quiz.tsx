// Per-deck AI quiz screen (RN). Mirrors the web QuizScreen. Three tabs:
//   演習 (practice)  — settings (種類/範囲/出題) → SolveSession. Every answer is recorded (SM-2),
//                      so 間違いのみ復習 works on all plans and 今日の復習 on Premium.
//   問題一覧 (list)  — browse generated questions grouped by page × type; per-group practice /
//                      regenerate / delete.
//   問題を作る (gen) — pick the question TYPE (○×/4択) + pages and generate in bulk, with a
//                      progress panel + per-page status overlays. One generation = page × type.
// Page text comes from the WebView engine (engine.pageText), thumbnails from engine.cover.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  deckCards,
  deleteQuestionGroup,
  getBookQuestions,
  getBookReviews,
  getDeck,
  getDeckPdf,
  getMeta,
  listBookmarks,
  setMeta,
} from "../db/repo";
import { cachedQuota, deckBookId } from "../sync/deck";
import { TOPICS_VERSION, extractHeadings, pageTopics, type TopicBookmark } from "../sync/topics";
import {
  AiUnavailableError,
  QuotaError,
  deleteCloudQuestions,
  generatePage,
  getGenUsage,
  hasAiConsent,
  restoreCloudQuestions,
  setAiConsent,
  type Density,
  type GenUsage,
} from "../ai/generate";
import { syncReviews } from "../sync/reviews";
import { SolveSession } from "./SolveSession";
import type { QuestionRow, Qtype, ReviewRow } from "../db/rows";
import { colors } from "../ui/theme";

const DENSITIES: { key: Density; label: string }[] = [
  { key: "auto", label: "おまかせ" },
  { key: "few", label: "少なめ" },
  { key: "normal", label: "標準" },
  { key: "many", label: "多め" },
];

const QTYPES: { key: Qtype; label: string }[] = [
  { key: "tf", label: "○×問題" },
  { key: "mc4", label: "4択問題" },
];
const qtypeShort = (t: Qtype) => (t === "mc4" ? "4択" : "○×");

type PageFilter = "all" | "todo" | "done";
const FILTERS: { key: PageFilter; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "todo", label: "未生成" },
  { key: "done", label: "生成済み" },
];

const CONTEXT_CHARS = 700;

// ---- page-thumbnail cache + concurrency limiter (module scope) --------------------------------
// pdf.js serializes render() on ONE canvas, so firing cover() for 200+ pages at mount stalls the
// whole list. We (a) cache resolved data URIs per book+page, (b) fetch a row only once it scrolls
// into view, (c) cap in-flight cover() calls. Card body renders immediately, never blocked.
const thumbCache = new Map<string, string>();
const thumbKey = (url: string, page: number) => `${url}#${page}`;
const MAX_THUMB_INFLIGHT = 2;
let thumbInFlight = 0;
const thumbQueue: Array<() => void> = [];
function pumpThumbs() {
  while (thumbInFlight < MAX_THUMB_INFLIGHT && thumbQueue.length) thumbQueue.shift()!();
}
function loadThumb(
  engine: ReturnType<typeof useDetectionEngine>,
  url: string,
  page: number,
  onDone: (uri: string) => void,
): () => void {
  const key = thumbKey(url, page);
  const cached = thumbCache.get(key);
  if (cached) {
    onDone(cached);
    return () => {};
  }
  let cancelled = false;
  thumbQueue.push(() => {
    if (cancelled) return pumpThumbs();
    thumbInFlight++;
    void engine
      .cover({ url, page, maxWidth: 160 })
      .then((u) => {
        thumbCache.set(key, u);
        if (!cancelled) onDone(u);
      })
      .catch(() => {})
      .finally(() => {
        thumbInFlight--;
        pumpThumbs();
      });
  });
  pumpThumbs();
  return () => {
    cancelled = true;
  };
}

export function Quiz({ deckId, from }: { deckId: number; from?: AppView }) {
  const setView = useApp((s) => s.setView);
  const user = useAccount((s) => s.user);
  const engine = useDetectionEngine();

  const [name, setName] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [bookId, setBookId] = useState<string | null>(null);
  const [termsByPage, setTermsByPage] = useState<Map<number, string[]>>(new Map());
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [reviews, setReviews] = useState<Map<string, ReviewRow>>(new Map());
  const [usage, setUsage] = useState<GenUsage | null>(null);
  // Last-seen tier as an offline fallback: getGenUsage fails offline, and without this a paid
  // Premium user would lose 今日の復習 whenever the network is down.
  const [cachedTier, setCachedTier] = useState<string | null>(null);
  const [tab, setTab] = useState<"solve" | "list" | "generate">("solve");
  const [pendingSession, setPendingSession] = useState<QuestionRow[] | null>(null);

  const reloadQuestions = useCallback(async (bid: string) => {
    setQuestions(await getBookQuestions(bid));
    setReviews(await getBookReviews(bid));
  }, []);
  const refreshReviews = useCallback(() => {
    if (bookId) void getBookReviews(bookId).then(setReviews);
  }, [bookId]);
  const refreshUsage = useCallback(() => {
    void getGenUsage().then(setUsage).catch(() => {});
  }, []);

  // Seed the offline-fallback tier from the last-seen server quota cache (set by listBooks).
  useEffect(() => {
    void cachedQuota().then((q) => q?.tier && setCachedTier(q.tier));
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
      setPageCount(pdf?.pageCount ?? 0);
      setBookId(bid ?? null);
      const m = new Map<number, string[]>();
      for (const c of cards) {
        const arr = m.get(c.pageIndex) ?? [];
        if (c.text?.trim()) arr.push(c.text);
        m.set(c.pageIndex, arr);
      }
      setTermsByPage(m);
      if (bid) {
        if (user) {
          await restoreCloudQuestions(bid).catch(() => {});
          const qs = await getBookQuestions(bid);
          await syncReviews(new Map(qs.map((q) => [q.id, q.bookId])));
        }
        if (live) await reloadQuestions(bid);
        if (live) refreshUsage();
      }
    })();
    return () => {
      live = false;
    };
  }, [deckId, user, reloadQuestions, refreshUsage]);

  // Prefer the live server tier; fall back to the last-seen tier when offline (usage===null).
  const effTier = usage?.tier ?? cachedTier;
  const premium = effTier === "premium" || effTier === "admin";

  // Topic labels for pages that have questions ("P.14" alone doesn't tell the user which chapter
  // it is). The deck's real 目次 (bookmarks) wins; otherwise a TOC is auto-detected from the whole
  // book's text once and cached in meta. Labels carry forward (see src/sync/topics.ts).
  // `topicSource` drives the hint that nudges users toward maintaining the 目次 themselves.
  const [topics, setTopics] = useState<Map<number, string>>(new Map());
  const [topicSource, setTopicSource] = useState<TopicSource>("none");
  const topicPagesKey = useMemo(
    () => [...new Set(questions.map((q) => q.pageIndex))].sort((a, b) => a - b).join(","),
    [questions],
  );
  useEffect(() => {
    if (!topicPagesKey || !pageCount) {
      setTopics(new Map());
      return;
    }
    let live = true;
    void (async () => {
      const pages = topicPagesKey.split(",").map(Number);
      let toc: TopicBookmark[] = (await listBookmarks(deckId).catch(() => [])).filter((b) =>
        b.title.trim(),
      );
      const fromBookmarks = toc.length > 0;
      if (!toc.length) {
        const cacheKey = `autoToc:${deckId}`;
        let cachedValid = false;
        try {
          const cached = JSON.parse((await getMeta(cacheKey)) ?? "null") as {
            v?: number;
            pageCount: number;
            toc: TopicBookmark[];
          } | null;
          if (cached && cached.v === TOPICS_VERSION && cached.pageCount === pageCount) {
            toc = cached.toc;
            cachedValid = true;
          }
        } catch {
          /* recompute below */
        }
        if (!cachedValid && engine.ready && pdfUrl) {
          const texts = new Map<number, string>();
          try {
            for (let start = 0; start < pageCount && live; start += 50) {
              const chunk = Array.from(
                { length: Math.min(50, pageCount - start) },
                (_, i) => start + i,
              );
              const got = await engine.pageText({ url: pdfUrl, pages: chunk });
              for (const t of got) texts.set(t.page, t.text);
            }
            if (!live) return;
            toc = extractHeadings(texts);
            await setMeta(cacheKey, JSON.stringify({ v: TOPICS_VERSION, pageCount, toc }));
          } catch {
            /* no labels this time — retried on next open */
          }
        }
      }
      if (live) {
        setTopics(pageTopics(pages, toc));
        setTopicSource(toc.length ? (fromBookmarks ? "bookmarks" : "auto") : "none");
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicPagesKey, engine.ready, pdfUrl, pageCount, deckId]);

  const openToc = useCallback(() => setView({ name: "viewer", deckId }), [setView, deckId]);

  const startPractice = (rows: QuestionRow[]) => {
    setPendingSession(rows);
    setTab("solve");
  };

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
            ? `今月の生成：${usage.count} 回（無制限）`
            : `今月の生成枠：残り ${usage.remaining} / ${usage.limit} 回`
          : "枠を確認中…"}
      </Text>

      <View style={styles.tabs}>
        <Tab label="演習" on={tab === "solve"} onPress={() => setTab("solve")} />
        <Tab label={`問題一覧（${questions.length}）`} on={tab === "list"} onPress={() => setTab("list")} />
        <Tab label="問題を作る" on={tab === "generate"} onPress={() => setTab("generate")} />
      </View>

      {tab === "solve" ? (
        <PracticeTab
          questions={questions}
          reviews={reviews}
          premium={premium}
          topics={topics}
          topicSource={topicSource}
          onOpenToc={openToc}
          pendingSession={pendingSession}
          clearPending={() => setPendingSession(null)}
          onAnswered={refreshReviews}
          onGenerate={() => setTab("generate")}
          onPaywall={() => setView({ name: "paywall" })}
        />
      ) : tab === "list" ? (
        <ListTab
          questions={questions}
          bookId={bookId}
          pdfUrl={pdfUrl}
          pageCount={pageCount}
          engine={engine}
          termsByPage={termsByPage}
          topics={topics}
          topicSource={topicSource}
          onOpenToc={openToc}
          onChanged={async () => {
            if (bookId) await reloadQuestions(bookId);
            refreshUsage();
          }}
          onPractice={startPractice}
        />
      ) : (
        <GenerateTab
          bookId={bookId}
          pdfUrl={pdfUrl}
          pageCount={pageCount}
          engine={engine}
          termsByPage={termsByPage}
          questions={questions}
          usage={usage}
          defaultHint={name}
          onGenerated={async () => {
            if (bookId) await reloadQuestions(bookId);
            refreshUsage();
          }}
          onPractice={startPractice}
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

/** Where the chapter labels came from — drives the "maintain your own 目次" nudge. */
type TopicSource = "bookmarks" | "auto" | "none";

function TocHint({ source, onOpen }: { source: TopicSource; onOpen: () => void }) {
  return (
    <Text style={styles.muted}>
      {source === "bookmarks"
        ? "章の見出しはこの本の目次にもとづいています。編集すると、ここにも反映されます。"
        : source === "auto"
          ? "章の見出しは本文からの自動推定です。目次を作ると、そちらが優先され正確になります。"
          : "目次を追加すると、問題を章ごとに表示できます。"}
      <Text style={styles.tocLink} onPress={onOpen}>
        {" "}
        目次を開く →
      </Text>
    </Text>
  );
}

// ---- 演習タブ（開始設定 → セッション） ---------------------------------------------------------

type PracticeType = "tf" | "mc4" | "both";
type PracticeMode = "all" | "wrong" | "due";

function PracticeTab({
  questions,
  reviews,
  premium,
  topics,
  topicSource,
  onOpenToc,
  pendingSession,
  clearPending,
  onAnswered,
  onGenerate,
  onPaywall,
}: {
  questions: QuestionRow[];
  reviews: Map<string, ReviewRow>;
  premium: boolean;
  topics: Map<number, string>;
  topicSource: TopicSource;
  onOpenToc: () => void;
  pendingSession: QuestionRow[] | null;
  clearPending: () => void;
  onAnswered: () => void;
  onGenerate: () => void;
  onPaywall: () => void;
}) {
  const [ptype, setPtype] = useState<PracticeType>("both");
  const [mode, setMode] = useState<PracticeMode>("all");
  const [useRange, setUseRange] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [session, setSession] = useState<QuestionRow[] | null>(null);

  const now = Date.now();
  const matches = useCallback(
    (t: PracticeType, m: PracticeMode) => {
      let list = questions.filter((q) => t === "both" || q.qtype === t);
      if (useRange) {
        const a = parseInt(rangeFrom, 10);
        const b = parseInt(rangeTo, 10);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          const lo = Math.min(a, b) - 1;
          const hi = Math.max(a, b) - 1;
          list = list.filter((q) => q.pageIndex >= lo && q.pageIndex <= hi);
        }
      }
      if (m === "wrong") list = list.filter((q) => reviews.get(q.id)?.lastOk === 0);
      if (m === "due") {
        list = list
          .filter((q) => {
            const r = reviews.get(q.id);
            return !!r && r.dueAt <= now;
          })
          .sort((a, b) => reviews.get(a.id)!.dueAt - reviews.get(b.id)!.dueAt);
      } else {
        list = list.slice().sort((a, b) => a.pageIndex - b.pageIndex || a.createdAt - b.createdAt);
      }
      return list;
    },
    [questions, reviews, useRange, rangeFrom, rangeTo, now],
  );

  if (pendingSession)
    return <SolveSession questions={pendingSession} onExit={clearPending} onAnswered={onAnswered} />;
  if (session)
    return <SolveSession questions={session} onExit={() => setSession(null)} onAnswered={onAnswered} />;

  if (!questions.length)
    return (
      <View style={styles.empty}>
        <Text style={styles.muted}>まだ問題がありません。</Text>
        <Pressable style={styles.primary} onPress={onGenerate}>
          <Text style={styles.primaryText}>問題を作る</Text>
        </Pressable>
      </View>
    );

  const target = matches(ptype, mode);
  const wrongCount = matches(ptype, "wrong").length;
  const dueCount = matches(ptype, "due").length;

  // Group the current target by chapter label (pages without a label stand alone as "P.x"),
  // so the user can see at a glance WHAT is in range — and tap a chapter to drill just it.
  const chapterGroups: { key: string; title: string; rows: QuestionRow[] }[] = [];
  {
    const idx = new Map<string, number>();
    for (const q of target) {
      const label = topics.get(q.pageIndex);
      const key = label ?? `p${q.pageIndex}`;
      const at = idx.get(key);
      if (at === undefined) {
        idx.set(key, chapterGroups.length);
        chapterGroups.push({ key, title: label ?? `P.${q.pageIndex + 1}`, rows: [q] });
      } else {
        chapterGroups[at].rows.push(q);
      }
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.setup}>
      <View style={styles.genRow}>
        <Text style={styles.genLabel}>種類</Text>
        <View style={styles.presetRow}>
          {(
            [
              { key: "both", label: "両方ミックス" },
              { key: "tf", label: "○×のみ" },
              { key: "mc4", label: "4択のみ" },
            ] as { key: PracticeType; label: string }[]
          ).map((t) => (
            <Pressable key={t.key} style={[styles.preset, ptype === t.key && styles.presetOn]} onPress={() => setPtype(t.key)}>
              <Text style={[styles.presetText, ptype === t.key && styles.presetTextOn]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.genRow}>
        <Text style={styles.genLabel}>範囲</Text>
        <View style={styles.presetRow}>
          <Pressable style={[styles.preset, !useRange && styles.presetOn]} onPress={() => setUseRange(false)}>
            <Text style={[styles.presetText, !useRange && styles.presetTextOn]}>全ページ</Text>
          </Pressable>
          <Pressable style={[styles.preset, useRange && styles.presetOn]} onPress={() => setUseRange(true)}>
            <Text style={[styles.presetText, useRange && styles.presetTextOn]}>ページ範囲</Text>
          </Pressable>
        </View>
      </View>
      {useRange ? (
        <View style={styles.genRow}>
          <Text style={styles.genLabel} />
          <TextInput style={styles.rangeNum} value={rangeFrom} onChangeText={setRangeFrom} keyboardType="number-pad" placeholder="開始" placeholderTextColor={colors.muted} />
          <Text>〜</Text>
          <TextInput style={styles.rangeNum} value={rangeTo} onChangeText={setRangeTo} keyboardType="number-pad" placeholder="終了" placeholderTextColor={colors.muted} />
        </View>
      ) : null}

      <View style={styles.genRow}>
        <Text style={styles.genLabel}>出題</Text>
        <View style={styles.presetRow}>
          <Pressable style={[styles.preset, mode === "all" && styles.presetOn]} onPress={() => setMode("all")}>
            <Text style={[styles.presetText, mode === "all" && styles.presetTextOn]}>すべて</Text>
          </Pressable>
          <Pressable style={[styles.preset, mode === "wrong" && styles.presetOn]} onPress={() => setMode("wrong")}>
            <Text style={[styles.presetText, mode === "wrong" && styles.presetTextOn]}>
              間違えた問題だけ（{wrongCount}）
            </Text>
          </Pressable>
          {premium ? (
            <Pressable style={[styles.preset, mode === "due" && styles.presetOn]} onPress={() => setMode("due")}>
              <Text style={[styles.presetText, mode === "due" && styles.presetTextOn]}>
                今日の復習（{dueCount}）
              </Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.preset, styles.lockedPreset]}
              onPress={() =>
                Alert.alert(
                  "今日の復習（Premium）",
                  "間違えやすい問題を、忘れる直前の最適なタイミングで再出題するPremiumの機能です。",
                  [
                    { text: "閉じる", style: "cancel" },
                    { text: "プランを見る", onPress: onPaywall },
                  ],
                )
              }
            >
              <Text style={styles.presetText}>🔒 今日の復習</Text>
            </Pressable>
          )}
        </View>
      </View>

      {chapterGroups.length ? (
        <View style={styles.genRow}>
          <Text style={styles.genLabel}>内容</Text>
          <View style={styles.chapterChips}>
            {chapterGroups.map((c) => (
              <Pressable key={c.key} style={styles.chapterChip} onPress={() => setSession(c.rows)}>
                <Text style={styles.chapterChipTitle}>{c.title}</Text>
                <Text style={styles.chapterChipCount}>{c.rows.length}問</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {chapterGroups.length ? (
        <Text style={styles.muted}>章をタップすると、その範囲だけすぐに演習できます。</Text>
      ) : null}
      <TocHint source={topicSource} onOpen={onOpenToc} />

      <Pressable
        style={[styles.primary, !target.length && styles.disabled]}
        disabled={!target.length}
        onPress={() => setSession(target)}
      >
        <Text style={styles.primaryText}>演習をはじめる（{target.length}問）</Text>
      </Pressable>
      {mode === "due" && !target.length ? (
        <Text style={styles.muted}>いま復習が必要な問題はありません。</Text>
      ) : null}
    </ScrollView>
  );
}

// ---- 問題一覧タブ -------------------------------------------------------------------------------

function ListTab({
  questions,
  bookId,
  pdfUrl,
  pageCount,
  engine,
  termsByPage,
  topics,
  topicSource,
  onOpenToc,
  onChanged,
  onPractice,
}: {
  questions: QuestionRow[];
  bookId: string | null;
  pdfUrl: string | null;
  pageCount: number;
  engine: ReturnType<typeof useDetectionEngine>;
  termsByPage: Map<number, string[]>;
  topics: Map<number, string>;
  topicSource: TopicSource;
  onOpenToc: () => void;
  onChanged: () => Promise<void> | void;
  onPractice: (rows: QuestionRow[]) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const byPage = useMemo(() => {
    const m = new Map<number, { tf: QuestionRow[]; mc4: QuestionRow[] }>();
    for (const q of questions) {
      const g = m.get(q.pageIndex) ?? { tf: [], mc4: [] };
      g[q.qtype].push(q);
      m.set(q.pageIndex, g);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [questions]);
  const tfTotal = useMemo(() => questions.filter((q) => q.qtype === "tf").length, [questions]);
  const mc4Total = questions.length - tfTotal;

  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const regenerate = (page: number, qtype: Qtype) => {
    if (!bookId || !pdfUrl || busyKey) return;
    Alert.alert(
      "再生成",
      `P.${page + 1} の${qtypeShort(qtype)}問題を作り直します（今の問題は置き換わり、生成枠を1回消費します）。よろしいですか？`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "作り直す",
          onPress: () => {
            void (async () => {
              const key = `${page}:${qtype}`;
              setBusyKey(key);
              setMsg(null);
              try {
                const need = [page - 1, page, page + 1].filter((p) => p >= 0 && p < pageCount);
                const texts = await engine.pageText({ url: pdfUrl, pages: need });
                const textMap = new Map(texts.map((t) => [t.page, t.text]));
                const text = textMap.get(page) ?? "";
                if (!text.trim()) throw new Error("本文を取得できませんでした");
                await generatePage({
                  bookId,
                  pageIndex: page,
                  qtype,
                  pageText: text,
                  markedTerms: termsByPage.get(page) ?? [],
                  density: "auto",
                  regenerate: true,
                  prevContext: (textMap.get(page - 1) ?? "").slice(-CONTEXT_CHARS),
                  nextContext: (textMap.get(page + 1) ?? "").slice(0, CONTEXT_CHARS),
                });
                await onChanged();
              } catch (e) {
                if (e instanceof QuotaError) setMsg(`今月の生成枠を使い切りました（${e.limit}回）。`);
                else if (e instanceof AiUnavailableError) setMsg("AI生成が未設定です。少し時間をおいてお試しください。");
                else setMsg(`作り直せませんでした：${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setBusyKey(null);
              }
            })();
          },
        },
      ],
    );
  };

  const remove = (page: number, qtype: Qtype) => {
    if (!bookId || busyKey) return;
    Alert.alert("削除", `P.${page + 1} の${qtypeShort(qtype)}問題を削除します。よろしいですか？`, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除する",
        style: "destructive",
        onPress: () => {
          void (async () => {
            await deleteQuestionGroup(bookId, page, qtype);
            void deleteCloudQuestions(bookId, page, qtype);
            await onChanged();
          })();
        },
      },
    ]);
  };

  if (!questions.length)
    return <Text style={styles.muted}>まだ問題がありません（「問題を作る」から生成できます）。</Text>;

  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      <Text style={styles.muted}>
        ○× {tfTotal}問 ・ 4択 {mc4Total}問
      </Text>
      <TocHint source={topicSource} onOpen={onOpenToc} />
      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
      {byPage.map(([page, g], i) => (
        <Fragment key={page}>
          {topics.get(page) && topics.get(page) !== (i > 0 ? topics.get(byPage[i - 1][0]) : undefined) ? (
            <Text style={styles.listChapter}>{topics.get(page)}</Text>
          ) : null}
        <View style={styles.listPage}>
          <Text style={styles.listPageHead}>P.{page + 1}</Text>
          {(["tf", "mc4"] as Qtype[]).map((t) => {
            const qs = g[t];
            if (!qs.length) return null;
            const key = `${page}:${t}`;
            return (
              <View style={styles.listGroup} key={key}>
                <Pressable style={styles.listGroupHead} onPress={() => toggleOpen(key)}>
                  <Text style={styles.listGroupTitle}>
                    {qtypeShort(t)} {qs.length}問
                  </Text>
                  <Text style={styles.muted}>{open.has(key) ? "▲ 閉じる" : "▼ 内容を見る"}</Text>
                </Pressable>
                {open.has(key) ? (
                  <View style={styles.listBody}>
                    {qs.map((q, qi) => (
                      <View key={q.id} style={styles.listItem}>
                        <Text style={styles.listStmt}>
                          {qi + 1}. {q.statement}
                        </Text>
                        {q.choices ? (
                          q.choices.map((c, ci) => (
                            <Text key={ci} style={c === q.answer ? styles.listAns : styles.listChoice}>
                              {ci + 1}. {c}
                              {c === q.answer ? "（正解）" : ""}
                            </Text>
                          ))
                        ) : (
                          <Text style={styles.listAns}>答え：{q.answer}</Text>
                        )}
                        {q.explanation ? <Text style={styles.muted}>{q.explanation}</Text> : null}
                      </View>
                    ))}
                    <View style={styles.listActions}>
                      <Pressable style={styles.smBtn} onPress={() => onPractice(qs)}>
                        <Text style={styles.smBtnText}>このグループを演習</Text>
                      </Pressable>
                      <Pressable style={styles.smBtn} disabled={busyKey !== null} onPress={() => regenerate(page, t)}>
                        <Text style={styles.smBtnText}>{busyKey === key ? "生成中…" : "再生成"}</Text>
                      </Pressable>
                      <Pressable style={[styles.smBtn, styles.dangerBtn]} disabled={busyKey !== null} onPress={() => remove(page, t)}>
                        <Text style={styles.dangerBtnText}>削除</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
        </Fragment>
      ))}
    </ScrollView>
  );
}

// ---- 生成タブ ----------------------------------------------------------------------------------

type PageRunState = "wait" | "run" | "done" | "fail";

interface GenRun {
  total: number;
  done: number;
  current: number | null;
  created: number;
  finished: boolean;
  cancelled: boolean;
}

function GenerateTab({
  bookId,
  pdfUrl,
  pageCount,
  engine,
  termsByPage,
  questions,
  usage,
  defaultHint,
  onGenerated,
  onPractice,
}: {
  bookId: string | null;
  pdfUrl: string | null;
  pageCount: number;
  engine: ReturnType<typeof useDetectionEngine>;
  termsByPage: Map<number, string[]>;
  questions: QuestionRow[];
  usage: GenUsage | null;
  defaultHint: string;
  onGenerated: () => Promise<void> | void;
  onPractice: (rows: QuestionRow[]) => void;
}) {
  const [qtype, setQtype] = useState<Qtype>("tf");
  const [density, setDensity] = useState<Density>("auto");
  const [hint, setHint] = useState(defaultHint);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filter, setFilter] = useState<PageFilter>("all");
  const [run, setRun] = useState<GenRun | null>(null);
  const [pageStates, setPageStates] = useState<Map<number, PageRunState>>(new Map());
  const [failures, setFailures] = useState<number[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const createdRef = useRef<QuestionRow[]>([]);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const onViewRef = useRef((info: { viewableItems: Array<{ item: number; isViewable: boolean }> }) => {
    setVisiblePages(new Set(info.viewableItems.filter((v) => v.isViewable).map((v) => v.item)));
  });
  const viewCfgRef = useRef({ itemVisiblePercentThreshold: 10 });

  // Remember the last-used question type (初回は○×).
  useEffect(() => {
    void getMeta("genQtype").then((v) => {
      if (v === "mc4") setQtype("mc4");
    });
  }, []);
  const pickQtype = (t: Qtype) => {
    setQtype(t);
    void setMeta("genQtype", t);
  };

  const counts = useMemo(() => {
    const tf = new Map<number, number>();
    const mc4 = new Map<number, number>();
    for (const q of questions) {
      const m = q.qtype === "mc4" ? mc4 : tf;
      m.set(q.pageIndex, (m.get(q.pageIndex) ?? 0) + 1);
    }
    return { tf, mc4 };
  }, [questions]);
  const selCounts = counts[qtype];

  const pages = useMemo(() => [...termsByPage.keys()].sort((a, b) => a - b), [termsByPage]);
  const genCountTf = useMemo(() => pages.filter((p) => (counts.tf.get(p) ?? 0) > 0).length, [pages, counts]);
  const genCountMc4 = useMemo(() => pages.filter((p) => (counts.mc4.get(p) ?? 0) > 0).length, [pages, counts]);
  const displayPages = useMemo(() => {
    if (filter === "all") return pages;
    return pages.filter((p) => ((selCounts.get(p) ?? 0) > 0) === (filter === "done"));
  }, [pages, selCounts, filter]);
  const toGenerate = useMemo(
    () => [...selected].filter((p) => !(selCounts.get(p) ?? 0)).sort((a, b) => a - b),
    [selected, selCounts],
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
          "この機能では、選んだページの本文と暗記語句を、当アプリのサーバー経由で外部のAIに送信して問題を作成します。生成された問題は誤りを含む場合があります。赤シート・色の検出など他の機能は、これまでどおり端末内だけで完結します。\n\n同意して続けますか？",
          [
            { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
            { text: "同意して続ける", onPress: () => void setAiConsent().then(() => resolve(true)) },
          ],
        );
      });
    });

  const runBatch = async (targets: number[]) => {
    if (!bookId || !pdfUrl || !targets.length || run) return;
    if (!(await ensureConsent())) return;
    setMsg(null);
    cancelRef.current = false;
    createdRef.current = [];
    setFailures([]);
    setPageStates(new Map(targets.map((p) => [p, "wait"])));
    setRun({ total: targets.length, done: 0, current: null, created: 0, finished: false, cancelled: false });

    // Fetch all needed page texts (targets + neighbors) up-front via the engine.
    const need = new Set<number>();
    for (const p of targets) {
      need.add(p);
      if (p - 1 >= 0) need.add(p - 1);
      if (p + 1 < pageCount) need.add(p + 1);
    }
    let texts: { page: number; text: string }[] = [];
    try {
      texts = await engine.pageText({ url: pdfUrl, pages: [...need].sort((a, b) => a - b) });
    } catch (e) {
      setMsg("本文の取得に失敗しました：" + (e instanceof Error ? e.message : String(e)));
      setRun(null);
      setPageStates(new Map());
      return;
    }
    const textMap = new Map(texts.map((t) => [t.page, t.text]));

    const fails: number[] = [];
    let done = 0;
    for (const p of targets) {
      if (cancelRef.current) break;
      setRun((r) => r && { ...r, current: p, done });
      setPageStates((m) => new Map(m).set(p, "run"));
      const terms = termsByPage.get(p) ?? [];
      const text = textMap.get(p) ?? "";
      let ok = false;
      try {
        if (terms.length && text.trim()) {
          const res = await generatePage({
            bookId,
            pageIndex: p,
            qtype,
            pageText: text,
            markedTerms: terms,
            density,
            subjectHint: hint,
            regenerate: false,
            prevContext: (textMap.get(p - 1) ?? "").slice(-CONTEXT_CHARS),
            nextContext: (textMap.get(p + 1) ?? "").slice(0, CONTEXT_CHARS),
          });
          createdRef.current.push(...res.questions);
          ok = true;
          done++;
          await onGenerated();
        }
      } catch (e) {
        if (e instanceof QuotaError) {
          setMsg(`今月の生成枠を使い切りました（${e.limit}回）。来月またご利用いただくか、上位プランをご検討ください。`);
          setPageStates((m) => new Map(m).set(p, "fail"));
          fails.push(p);
          break;
        }
        if (e instanceof AiUnavailableError) {
          setMsg("AI生成が未設定です。少し時間をおいてお試しください。");
          setPageStates((m) => new Map(m).set(p, "fail"));
          fails.push(p);
          break;
        }
      }
      if (!ok) fails.push(p);
      setPageStates((m) => new Map(m).set(p, ok ? "done" : "fail"));
      setRun((r) => r && { ...r, done: ok ? done : r.done, created: createdRef.current.length });
    }
    setFailures(fails);
    setSelected(new Set());
    setRun((r) =>
      r && { ...r, current: null, done, created: createdRef.current.length, finished: true, cancelled: cancelRef.current },
    );
    await onGenerated();
  };

  const closeRun = () => {
    setRun(null);
    setPageStates(new Map());
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
        <Text style={styles.genLabel}>問題の種類</Text>
        <View style={styles.presetRow}>
          {QTYPES.map((t) => (
            <Pressable
              key={t.key}
              style={[styles.preset, qtype === t.key && styles.presetOn]}
              disabled={!!run && !run.finished}
              onPress={() => pickQtype(t.key)}
            >
              <Text style={[styles.presetText, qtype === t.key && styles.presetTextOn]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
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
      <View style={styles.genRow}>
        <Text style={styles.genLabel}>表示</Text>
        <View style={styles.presetRow}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              style={[styles.preset, filter === f.key && styles.presetOn]}
              onPress={() => setFilter(f.key)}
            >
              <Text style={[styles.presetText, filter === f.key && styles.presetTextOn]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={styles.muted}>
        ○×: 済 {genCountTf} / {pages.length} ・ 4択: 済 {genCountMc4} / {pages.length} ページ。
        暗記箇所のあるページを選んで「まとめて生成」（同じページでも ○× と 4択 は別カウント。生成済みの再表示は枠を消費しません）。
      </Text>
      <Text style={styles.muted}>
        ⚠ 生成された問題はAIによるもので、誤りを含む場合があります。内容は必ずご自身で確認してください。
      </Text>
    </View>
  );

  return (
    <View style={styles.flex}>
      <FlatList
        data={displayPages}
        keyExtractor={(p) => String(p)}
        numColumns={3}
        columnWrapperStyle={styles.pickerRow}
        contentContainerStyle={styles.pickerContent}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        onViewableItemsChanged={onViewRef.current}
        viewabilityConfig={viewCfgRef.current}
        initialNumToRender={9}
        maxToRenderPerBatch={9}
        windowSize={5}
        renderItem={({ item: p }) => (
          <PageCard
            engine={engine}
            pdfUrl={pdfUrl}
            pageIndex={p}
            terms={termsByPage.get(p)?.length ?? 0}
            tfCount={counts.tf.get(p) ?? 0}
            mc4Count={counts.mc4.get(p) ?? 0}
            qtype={qtype}
            state={pageStates.get(p)}
            selected={selected.has(p)}
            active={visiblePages.has(p)}
            onToggle={() => toggle(p)}
          />
        )}
      />
      <View style={styles.genFooter}>
        {run ? (
          !run.finished ? (
            <View style={styles.runPanel}>
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: `${(run.done / Math.max(1, run.total)) * 100}%` }]} />
              </View>
              <View style={styles.runRow}>
                <Text style={styles.runText}>
                  生成中 {run.done}/{run.total} ページ
                  {run.current !== null ? `（P.${run.current + 1}）` : ""}
                </Text>
                <Pressable style={styles.smBtn} disabled={cancelRef.current} onPress={() => (cancelRef.current = true)}>
                  <Text style={styles.smBtnText}>{cancelRef.current ? "停止中…" : "キャンセル"}</Text>
                </Pressable>
              </View>
              <Text style={styles.muted}>キャンセルは実行中のページが終わってから停止します（以後のページは枠を消費しません）。</Text>
            </View>
          ) : (
            <View style={styles.runPanel}>
              <Text style={styles.runText}>
                {run.cancelled ? "キャンセルしました。" : ""}
                {run.done}ページ・{run.created}問を作成しました。
                {failures.length ? `（${failures.length}ページは失敗）` : ""}
              </Text>
              <View style={styles.runRow}>
                {createdRef.current.length ? (
                  <Pressable style={styles.primarySm} onPress={() => onPractice(createdRef.current)}>
                    <Text style={styles.primaryText}>演習をはじめる</Text>
                  </Pressable>
                ) : null}
                {failures.length ? (
                  <Pressable
                    style={styles.smBtn}
                    onPress={() => {
                      const f = failures;
                      closeRun();
                      void runBatch(f);
                    }}
                  >
                    <Text style={styles.smBtnText}>失敗した{failures.length}ページを再試行</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.smBtn} onPress={closeRun}>
                  <Text style={styles.smBtnText}>閉じる</Text>
                </Pressable>
              </View>
            </View>
          )
        ) : (
          <Pressable
            style={[styles.primary, (!toGenerate.length || !pdfUrl) && styles.disabled]}
            disabled={!toGenerate.length || !pdfUrl}
            onPress={() => void runBatch(toGenerate)}
          >
            <Text style={styles.primaryText}>
              選んだ {toGenerate.length} ページの{qtypeShort(qtype)}問題をまとめて生成
            </Text>
          </Pressable>
        )}
        {toGenerate.length > remaining && !run ? (
          <Text style={styles.warn}>残り枠 {remaining} 回を超える分は生成されません。</Text>
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
  tfCount,
  mc4Count,
  qtype,
  state,
  selected,
  active,
  onToggle,
}: {
  engine: ReturnType<typeof useDetectionEngine>;
  pdfUrl: string | null;
  pageIndex: number;
  terms: number;
  tfCount: number;
  mc4Count: number;
  qtype: Qtype;
  state?: PageRunState;
  selected: boolean;
  /** true once this row has scrolled into view — only then do we request its (serialized) thumbnail. */
  active: boolean;
  onToggle: () => void;
}) {
  const [uri, setUri] = useState<string | null>(() =>
    pdfUrl ? thumbCache.get(thumbKey(pdfUrl, pageIndex)) ?? null : null,
  );
  useEffect(() => {
    if (uri || !pdfUrl || !engine.ready || !active) return;
    return loadThumb(engine, pdfUrl, pageIndex, setUri);
  }, [engine, pdfUrl, pageIndex, active, uri]);
  const selTypeCount = qtype === "mc4" ? mc4Count : tfCount;
  return (
    <Pressable style={styles.card} onPress={onToggle} disabled={state === "run"}>
      <View style={[styles.thumb, selected && styles.thumbSel]}>
        {uri ? (
          <Image source={{ uri }} style={styles.thumbImg} resizeMode="cover" />
        ) : (
          <Text style={styles.thumbPhText}>P.{pageIndex + 1}</Text>
        )}
        <View style={styles.pills}>
          {tfCount > 0 ? (
            <View style={styles.genPill}>
              <Text style={styles.genPillText}>○済</Text>
            </View>
          ) : null}
          {mc4Count > 0 ? (
            <View style={[styles.genPill, styles.mc4Pill]}>
              <Text style={styles.genPillText}>④済</Text>
            </View>
          ) : null}
        </View>
        {selected && !state ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>✓</Text>
          </View>
        ) : null}
        {state === "wait" ? <View style={[styles.stateOverlay, styles.stateWait]} /> : null}
        {state === "run" ? (
          <View style={[styles.stateOverlay, styles.stateRun]}>
            <ActivityIndicator color="#0f766e" />
          </View>
        ) : null}
        {state === "done" ? (
          <View style={[styles.stateOverlay, styles.stateDone]}>
            <Text style={styles.stateMark}>✓</Text>
          </View>
        ) : null}
        {state === "fail" ? (
          <View style={[styles.stateOverlay, styles.stateFail]}>
            <Text style={styles.stateMark}>⚠</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.cardMeta}>
        <Text style={styles.cardP}>P.{pageIndex + 1}</Text>
        <Text style={selTypeCount > 0 ? styles.genText : styles.muted}>
          {selTypeCount > 0 ? `✓${selTypeCount}問` : `暗記${terms}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 14 },
  flex: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  back: { color: colors.ocean, fontSize: 15 },
  title: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.text },
  quota: { fontSize: 14, color: colors.text, marginBottom: 10 },
  tabs: { flexDirection: "row", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  tab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  tabOn: { backgroundColor: colors.sand, borderColor: colors.sand },
  tabText: { fontSize: 14, fontWeight: "600", color: colors.text },
  tabTextOn: { color: "#fff" },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17, marginVertical: 4 },
  genRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 },
  genLabel: { fontSize: 13, fontWeight: "700", color: colors.text, minWidth: 64 },
  presetRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", flexShrink: 1 },
  preset: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  presetOn: { backgroundColor: colors.sand, borderColor: colors.sand },
  presetText: { fontSize: 13, color: colors.text },
  presetTextOn: { color: "#fff", fontWeight: "700" },
  lockedPreset: { opacity: 0.75 },
  hintInput: { flex: 1, minWidth: 150, fontSize: 15, color: colors.text, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  rangeNum: { width: 70, fontSize: 15, color: colors.text, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8 },
  smBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  smBtnText: { fontSize: 13, color: colors.ocean, fontWeight: "600" },
  dangerBtn: { borderColor: "#e0a99f" },
  dangerBtnText: { fontSize: 13, color: "#c0392b", fontWeight: "600" },
  pickerRow: { gap: 10 },
  pickerContent: { paddingBottom: 16, gap: 12 },
  card: { width: "31%", marginBottom: 10 },
  thumb: { width: "100%", height: 150, borderRadius: 6, overflow: "hidden", backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  thumbSel: { borderColor: colors.sand },
  thumbImg: { width: "100%", height: "100%" },
  thumbPhText: { fontSize: 13, fontWeight: "700", color: colors.muted },
  badge: { position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.sand, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  pills: { position: "absolute", top: 4, left: 4, flexDirection: "row", gap: 3 },
  genPill: { backgroundColor: "#0f766e", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  mc4Pill: { backgroundColor: "#7c3aed" },
  genPillText: { color: "#fff", fontWeight: "800", fontSize: 10 },
  genText: { color: "#0f766e", fontSize: 12, fontWeight: "700", marginVertical: 4 },
  stateOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  stateWait: { backgroundColor: "rgba(120,110,95,0.25)" },
  stateRun: { backgroundColor: "rgba(255,253,247,0.55)" },
  stateDone: { backgroundColor: "rgba(15,118,110,0.45)" },
  stateFail: { backgroundColor: "rgba(192,57,43,0.4)" },
  stateMark: { color: "#fff", fontSize: 24, fontWeight: "800" },
  cardMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 },
  cardP: { fontSize: 12, color: colors.text, fontWeight: "600" },
  genFooter: { paddingTop: 8, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  runPanel: { gap: 8 },
  bar: { height: 10, borderRadius: 5, backgroundColor: colors.border, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: colors.sand },
  runRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  runText: { fontSize: 14, color: colors.text, flexShrink: 1 },
  primary: { backgroundColor: colors.sand, paddingVertical: 13, paddingHorizontal: 18, borderRadius: 12, alignItems: "center" },
  primarySm: { backgroundColor: colors.sand, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  warn: { color: colors.sand, fontSize: 12 },
  msg: { backgroundColor: colors.surface, padding: 10, borderRadius: 8, fontSize: 14, color: colors.text },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  setup: { gap: 4, paddingBottom: 16 },
  listContent: { paddingBottom: 16, gap: 8 },
  listPage: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface, overflow: "hidden" },
  listPageHead: { paddingHorizontal: 12, paddingVertical: 8, fontWeight: "800", color: colors.text, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  listChapter: { marginTop: 10, marginBottom: 2, marginHorizontal: 2, fontSize: 14.5, fontWeight: "800", color: colors.text },
  tocLink: { color: colors.ocean, textDecorationLine: "underline" },
  chapterChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, flexShrink: 1, flex: 1 },
  chapterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  chapterChipTitle: { fontSize: 13.5, fontWeight: "700", color: colors.text },
  chapterChipCount: { fontSize: 12, color: colors.muted },
  listGroup: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  listGroupHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 },
  listGroupTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  listBody: { paddingHorizontal: 12, paddingBottom: 10, gap: 10 },
  listItem: { gap: 2 },
  listStmt: { fontSize: 14, lineHeight: 21, color: colors.text },
  listChoice: { fontSize: 13, lineHeight: 19, color: colors.text, paddingLeft: 12 },
  listAns: { fontSize: 13, lineHeight: 19, fontWeight: "800", color: "#1f7a3d", paddingLeft: 12 },
  listActions: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 4 },
});
