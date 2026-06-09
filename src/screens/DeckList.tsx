// 本棚 — imported books. View styles (Explorer-like): 特大/大/中アイコン grids + 一覧 list,
// persisted. Tap to read; long-press for settings/delete. "＋ 取り込む" enforces the
// free-tier deck limit. Restored decks regenerate their cover thumbnails lazily.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useApp } from "../store/session";
import { useDetectionEngine } from "../engine/EngineProvider";
import { deckPdfFile } from "../db/files";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import {
  answerCount,
  deckCountTotal,
  deleteBookQuestions,
  deleteDeck,
  getCover,
  getMeta,
  listDecks,
  setCover,
  setMeta,
} from "../db/repo";
import { exportBackup, importBackup } from "../db/backup";
import {
  listBooks,
  retainBook,
  syncErrorMessage,
  unregisterBook,
  updateBookMeta,
  type AccountBook,
} from "../sync/api";
import {
  backfillCloudIfPro,
  cacheQuota,
  cachedQuota,
  deckBookId,
  downloadDeck,
  isRegistered,
  localBookIds,
  setRegistered,
} from "../sync/deck";
import { deviceLabel } from "../sync/device";
import type { DeckRow } from "../db/rows";
import { colors } from "../ui/theme";

interface DeckVM {
  deck: DeckRow;
  cover?: string;
  count: number;
  favorite: boolean;
  openedAt: number;
}

type ViewMode = "xl" | "l" | "m" | "list";
const COLS: Record<ViewMode, number> = { xl: 2, l: 3, m: 4, list: 1 };
const VIEW_LABELS: Record<ViewMode, string> = {
  xl: "特大アイコン",
  l: "大アイコン",
  m: "中アイコン",
  list: "一覧",
};
const VIEW_ORDER: ViewMode[] = ["xl", "l", "m", "list"];
const isViewMode = (v: unknown): v is ViewMode =>
  v === "xl" || v === "l" || v === "m" || v === "list";

type SortMode = "new" | "name" | "recent";
const SORT_LABELS: Record<SortMode, string> = {
  new: "新しい順",
  name: "名前順",
  recent: "最近開いた順",
};
const SORT_ORDER: SortMode[] = ["new", "name", "recent"];
const isSortMode = (v: unknown): v is SortMode =>
  v === "new" || v === "name" || v === "recent";

// Per-book bookshelf state. favorite + opened time are kept in meta locally and mirrored to the
// account (books.favorite / books.opened_at) so they follow you across devices.
const favKey = (deckId: number) => `fav:${deckId}`;
const openedKey = (deckId: number) => `opened:${deckId}`;

/** Favorites pinned to the top, then ordered by the chosen mode. */
function sortItems(items: DeckVM[], mode: SortMode): DeckVM[] {
  return [...items].sort((a, b) => {
    const fav = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    if (fav !== 0) return fav;
    if (mode === "name") return a.deck.name.localeCompare(b.deck.name, "ja");
    if (mode === "recent") return b.openedAt - a.openedAt;
    return b.deck.createdAt - a.deck.createdAt;
  });
}

export function DeckList() {
  const setView = useApp((s) => s.setView);
  const bumpDecks = useApp((s) => s.bumpDecks);
  const engine = useDetectionEngine();
  const [items, setItems] = useState<DeckVM[] | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("l");
  const [sortMode, setSortMode] = useState<SortMode>("new");
  const regenRef = useRef(false);
  // Books in the account that aren't on THIS device yet → one-tap cloud download (Pro).
  const [cloud, setCloud] = useState<AccountBook[]>([]);
  const [cloudPro, setCloudPro] = useState(false); // cloud section is Pro-only (download/restore)
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  // Book ids the account has a downloadable cloud blob for (size>0), from the last loadCloud. A local
  // delete of a book NOT in this set (Standard / upload never finished) must also free its account
  // slot, or it lingers as a phantom that counts toward the cap and can't be restored.
  const cloudBlobIdsRef = useRef<Set<string>>(new Set());
  const cloudReadyRef = useRef(false);
  const cloudDeviceByDeckRef = useRef<Map<number, string | null>>(new Map()); // deckId -> holder name
  // Per-deck cloud-backed status for the bookshelf badge + delete warning: deckIds whose account book
  // has a cloud copy (size>0). cloudKnown=false until the first successful listBooks (→ warn safe-side).
  const [cloudBackedDecks, setCloudBackedDecks] = useState<Set<number>>(new Set());
  const [cloudKnown, setCloudKnown] = useState(false);

  const load = useCallback(async () => {
    const decks = await listDecks();
    const vms = await Promise.all(
      decks.map(async (deck) => ({
        deck,
        cover: await getCover(deck.id),
        count: await answerCount(deck.id),
        favorite: (await getMeta(favKey(deck.id))) === "1",
        openedAt: Number((await getMeta(openedKey(deck.id))) ?? 0),
      })),
    );
    setItems(vms);
  }, []);

  const loadCloud = useCallback(async () => {
    try {
      const [acct, local] = await Promise.all([listBooks(), localBookIds()]);
      void cacheQuota(acct); // remember the cap for offline import enforcement (§2.2a)
      cloudBlobIdsRef.current = new Set(
        acct.books.filter((b) => b.size > 0).map((b) => b.book_id),
      );
      cloudReadyRef.current = true;
      // Per-deck cloud-backed set (size>0 → restorable) for the bookshelf badge + delete warning.
      const backed = new Set<number>();
      for (const b of acct.books) {
        if (b.size > 0) {
          const did = local.get(b.book_id);
          if (did != null) backed.add(did);
        }
      }
      setCloudBackedDecks(backed);
      setCloudKnown(true);
      const known = new Set(acct.books.map((b) => b.book_id));
      const active = new Set(
        acct.books.filter((b) => (b.status ?? "active") === "active").map((b) => b.book_id),
      );
      const me = deviceLabel();
      const singleHome = !acct.unlimited; // Standard/Free: a book lives on ONE device (the holder)
      // Cloud section = ACTIVE account books not on this device.
      //  • Pro+ (sync): every active book not held locally (downloadable/restore, incl. zero-holder).
      //  • Standard/Free (non-sync): ONLY books held by ANOTHER device (`device` set, ≠ me) — so a
      //    size=0 device-only book can be cleared from here to free the slot. Zero-holder/retained
      //    books are NOT shown (nothing to download; managed from the bookshelf).
      setCloud(
        acct.books.filter((b) => {
          if (!active.has(b.book_id) || local.has(b.book_id)) return false;
          if (acct.unlimited) return true;
          return !!b.device && b.device !== me;
        }),
      );
      setCloudPro(acct.unlimited); // cloud download/restore is Pro/admin-only
      void backfillCloudIfPro(); // Pro: upload any local book that has no cloud file yet
      // Per-deck holder name (for the delete-clears-holder logic).
      const devMap = new Map<number, string | null>();
      const devByBook = new Map(acct.books.map((b) => [b.book_id, b.device ?? null] as const));
      for (const [bid, deckId] of local) devMap.set(deckId, devByBook.get(bid) ?? null);
      cloudDeviceByDeckRef.current = devMap;
      // Only a NON-empty response is authoritative for the *destructive* orphan cleanup below.
      const canPrune = acct.books.length > 0;
      // Account-wide trim follow: delete local copies of books the server marked non-active; on a
      // non-sync tier ALSO drop active books now held by another device (single-home), and prune
      // orphans — a book we PREVIOUSLY registered that's now gone from the account (unregistered on
      // another device). A never-registered local-only import (offline / fail-open) is left alone.
      let removed = false;
      for (const [bid, deckId] of local) {
        const nonActive = known.has(bid) && !active.has(bid);
        const heldElsewhere =
          singleHome && active.has(bid) && !!devByBook.get(bid) && devByBook.get(bid) !== me;
        const orphan = singleHome && canPrune && !known.has(bid) && (await isRegistered(deckId));
        if (nonActive || heldElsewhere || orphan) {
          await deleteDeck(deckId);
          void deleteBookQuestions(bid).catch(() => {});
          removed = true;
        } else if (active.has(bid) && !(await isRegistered(deckId))) {
          await setRegistered(deckId); // seen in the account → enable future orphan cleanup
        }
      }
      // Adopt favorite / latest-opened state set on other devices for books we still have locally.
      let changed = false;
      for (const b of acct.books) {
        const deckId = local.get(b.book_id);
        if (deckId == null || !active.has(b.book_id)) continue;
        if (((await getMeta(favKey(deckId))) === "1") !== !!b.favorite) {
          await setMeta(favKey(deckId), b.favorite ? "1" : "0");
          changed = true;
        }
        if ((b.opened_at ?? 0) > Number((await getMeta(openedKey(deckId))) ?? 0)) {
          await setMeta(openedKey(deckId), String(b.opened_at));
          changed = true;
        }
      }
      if (changed || removed) await load();
    } catch {
      setCloud([]); // signed out / offline — no cloud section
      setCloudPro(false);
    }
  }, [load]);

  useEffect(() => {
    load();
    void loadCloud();
  }, [load, loadCloud]);

  const onDownload = useCallback(
    async (b: AccountBook) => {
      setDownloading((s) => new Set(s).add(b.book_id));
      try {
        await downloadDeck(b);
        // Stamp THIS device as the current holder so the cloud list (on other devices) shows where
        // the book is now, not just who first imported it.
        void updateBookMeta(b.book_id, { device: deviceLabel() }).catch(() => {});
        bumpDecks();
        await load();
        setCloud((c) => c.filter((x) => x.book_id !== b.book_id));
      } catch (e) {
        Alert.alert("クラウドから取り込めませんでした", syncErrorMessage(e));
      } finally {
        setDownloading((s) => {
          const n = new Set(s);
          n.delete(b.book_id);
          return n;
        });
      }
    },
    [load, bumpDecks],
  );

  // Pro+ : permanently remove a book from the CLOUD (R2 file + registry row + progress) for the whole
  // account — the deliberate counterpart to the bookshelf's local-only delete. Always confirms.
  const onRemoveCloud = useCallback((b: AccountBook) => {
    Alert.alert(
      "クラウドから完全に削除しますか?",
      `「${b.name || "（無題）"}」をクラウドから完全に削除します。すべての端末から取り込めなくなります。元に戻せません。`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: async () => {
            try {
              await unregisterBook(b.book_id);
              setCloud((c) => c.filter((x) => x.book_id !== b.book_id));
            } catch (e) {
              Alert.alert("クラウドから削除できませんでした", syncErrorMessage(e));
            }
          },
        },
      ],
    );
  }, []);

  // Standard/Free : single action — free the account slot another device is holding. size>0 → retain
  // (frees the slot, keeps R2 for re-Pro restore); size=0 → unregister (permanent). Always confirms,
  // warns harder when there's no cloud copy, and defaults focus to キャンセル (style:"cancel").
  const onReleaseCloud = useCallback((b: AccountBook) => {
    const hasBlob = b.size > 0;
    const where = b.device ? `「${b.device}」` : "別の端末";
    const title = b.name || "（無題）";
    const msg = hasBlob
      ? `${where}に保存中の「${title}」を削除して枠を空けます。\nProに戻すと復元できます（保持〜約6ヶ月）。`
      : `${where}に保存中の「${title}」を削除して枠を空けます。\n⚠ クラウドに保存がないため、削除すると復元できません。`;
    Alert.alert("枠を空けますか?", msg, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: hasBlob ? "default" : "destructive",
        onPress: async () => {
          try {
            if (hasBlob) await retainBook(b.book_id);
            else await unregisterBook(b.book_id);
            setCloud((c) => c.filter((x) => x.book_id !== b.book_id));
          } catch (e) {
            Alert.alert("枠を空けられませんでした", syncErrorMessage(e));
          }
        },
      },
    ]);
  }, []);

  useEffect(() => {
    getMeta("bookshelfView").then((v) => {
      if (isViewMode(v)) setViewMode(v);
    });
    getMeta("bookshelfSort").then((v) => {
      if (isSortMode(v)) setSortMode(v);
    });
  }, []);

  // Restored decks have no cover (backup omits them) — regenerate lazily in the background.
  useEffect(() => {
    if (!items || !engine.ready || regenRef.current) return;
    const missing = items.filter((it) => !it.cover);
    if (!missing.length) return;
    regenRef.current = true;
    let alive = true;
    (async () => {
      for (const it of missing) {
        try {
          const dataUrl = await engine.cover({ url: deckPdfFile(it.deck.id).uri });
          if (!alive) return;
          await setCover(it.deck.id, dataUrl);
          setItems((prev) =>
            prev ? prev.map((x) => (x.deck.id === it.deck.id ? { ...x, cover: dataUrl } : x)) : prev,
          );
        } catch {
          /* keep the placeholder */
        }
      }
      regenRef.current = false;
    })();
    return () => {
      alive = false;
    };
  }, [items, engine]);

  const onImport = useCallback(async () => {
    // Account-wide cap: block past the tier's allowance ACROSS THE WHOLE ACCOUNT (Free 1 / Standard
    // 10 / Pro+ unlimited). Fail open if unreachable — the server re-checks atomically on register.
    try {
      const acct = await listBooks();
      void cacheQuota(acct);
      if (!acct.unlimited && acct.count >= acct.limit) {
        Alert.alert(
          "上限に達しています",
          `本はプランの上限（${acct.limit} 冊）に達しています。不要な本を削除するか、上位プランにアップグレードしてください。`,
          [
            { text: "閉じる", style: "cancel" },
            { text: "アップグレード", onPress: () => setView({ name: "paywall" }) },
          ],
        );
        return;
      }
    } catch {
      // Offline: enforce the LAST-SEEN server quota (§2.2a). Stale cache errs toward blocking; no
      // cache yet (never synced) falls open and the server re-checks on register.
      const q = await cachedQuota();
      if (q && !q.unlimited && q.count >= q.limit) {
        Alert.alert(
          "上限に達しています",
          `本はプランの上限（${q.limit} 冊）に達しています（オフラインのため最後に確認した枠で判定）。オンラインに戻るか、不要な本を削除してください。`,
          [{ text: "閉じる", style: "cancel" }],
        );
        return;
      }
    }
    setView({ name: "import" });
  }, [setView]);

  const pickView = useCallback(() => {
    Alert.alert("表示方法", undefined, [
      ...VIEW_ORDER.map((m) => ({
        text: VIEW_LABELS[m] + (viewMode === m ? "  ✓" : ""),
        onPress: () => {
          setViewMode(m);
          void setMeta("bookshelfView", m);
        },
      })),
      { text: "キャンセル", style: "cancel" as const },
    ]);
  }, [viewMode]);

  const pickSort = useCallback(() => {
    Alert.alert("並び替え", undefined, [
      ...SORT_ORDER.map((m) => ({
        text: SORT_LABELS[m] + (sortMode === m ? "  ✓" : ""),
        onPress: () => {
          setSortMode(m);
          void setMeta("bookshelfSort", m);
        },
      })),
      { text: "キャンセル", style: "cancel" as const },
    ]);
  }, [sortMode]);

  // Toggle favorite (pinned to top). Persists locally and mirrors to the account (best-effort).
  const toggleFavorite = useCallback((deck: DeckRow) => {
    setItems((prev) => {
      if (!prev) return prev;
      const next = prev.map((x) =>
        x.deck.id === deck.id ? { ...x, favorite: !x.favorite } : x,
      );
      const nv = next.find((x) => x.deck.id === deck.id);
      if (nv) {
        void setMeta(favKey(deck.id), nv.favorite ? "1" : "0");
        void (async () => {
          const bid = await deckBookId(deck.id);
          if (bid) await updateBookMeta(bid, { favorite: nv.favorite });
        })().catch(() => {});
      }
      return next;
    });
  }, []);

  // Open a book: stamp the last-opened time (for 最近開いた順), mirror it to the account, navigate.
  const openDeck = useCallback(
    (deck: DeckRow) => {
      const now = Date.now();
      void setMeta(openedKey(deck.id), String(now));
      setItems((prev) =>
        prev ? prev.map((x) => (x.deck.id === deck.id ? { ...x, openedAt: now } : x)) : prev,
      );
      void (async () => {
        const bid = await deckBookId(deck.id);
        if (bid) await updateBookMeta(bid, { openedAt: now });
      })().catch(() => {});
      setView({ name: "viewer", deckId: deck.id });
    },
    [setView],
  );

  const onBackup = useCallback(() => {
    Alert.alert("バックアップ", "全データ（PDF含む）をJSONで入出力します。", [
      {
        text: "書き出す",
        onPress: async () => {
          try {
            const uri = await exportBackup();
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(uri, {
                mimeType: "application/json",
                dialogTitle: "バックアップを書き出す",
              });
            }
          } catch (e) {
            Alert.alert("エラー", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        text: "読み込む",
        onPress: async () => {
          try {
            const res = await DocumentPicker.getDocumentAsync({
              type: "application/json",
              copyToCacheDirectory: true,
            });
            if (res.canceled || !res.assets?.[0]) return;
            await importBackup(res.assets[0].uri);
            bumpDecks();
            load();
            Alert.alert("読み込み完了", "バックアップを復元しました。");
          } catch (e) {
            Alert.alert("エラー", e instanceof Error ? e.message : String(e));
          }
        },
      },
      { text: "キャンセル", style: "cancel" },
    ]);
  }, [load]);

  const confirmDelete = useCallback(
    (deck: DeckRow) => {
      // Warn based on whether the account has a cloud copy (size>0). Device-only books (or
      // unknown/offline → safe side) are UNRECOVERABLE; cloud-backed books restore on re-Pro.
      const backed = cloudKnown ? cloudBackedDecks.has(deck.id) : null;
      const nonSync = !cloudPro; // Standard/Free: a cloud-backed local delete retains (frees a slot)
      const msg =
        backed !== true
          ? `「${deck.name}」をこの端末から削除します。\n⚠ この本は端末内だけにあります。削除すると復元できません。`
          : nonSync
            ? `「${deck.name}」をこの端末から削除し、クラウドに退避します（枠が空きます）。Proに戻すと復元できます（保持〜約6ヶ月）。`
            : `「${deck.name}」をこの端末から削除します。\nこの本はクラウドにバックアップがあります。Proに戻せば、あとで「クラウド」から取り込み直せます。`;
      Alert.alert(
        "この端末から削除しますか?",
        msg,
        [
          { text: "キャンセル", style: "cancel" },
          {
            text: "削除",
            style: "destructive",
            onPress: async () => {
              // size=0 (no cloud copy) → unregister (permanent, frees the slot). size>0 on a non-sync
              // tier → retain (active→retained: frees the slot, keeps R2, restorable on re-Pro).
              // size>0 on Pro+ → keep active (re-downloadable); just release the holder if we held it.
              const bid = await deckBookId(deck.id);
              await deleteDeck(deck.id);
              if (bid) {
                void deleteBookQuestions(bid).catch(() => {}); // drop this device's AI questions
                if (cloudReadyRef.current && !cloudBlobIdsRef.current.has(bid)) {
                  void unregisterBook(bid).catch(() => {}); // no cloud copy → free the slot
                } else if (cloudReadyRef.current && cloudBlobIdsRef.current.has(bid) && nonSync) {
                  void retainBook(bid).catch(() => {}); // Standard/Free → retain (free slot, keep R2)
                } else if (
                  cloudReadyRef.current &&
                  cloudBlobIdsRef.current.has(bid) &&
                  cloudDeviceByDeckRef.current.get(deck.id) === deviceLabel()
                ) {
                  // Pro+ holder → keep active, just release the holder (now cloud-only).
                  void updateBookMeta(bid, { device: null }).catch(() => {});
                }
              }
              bumpDecks();
              load();
              void loadCloud();
            },
          },
        ],
      );
    },
    [load, loadCloud, cloudKnown, cloudBackedDecks, cloudPro],
  );

  const onLongPress = useCallback(
    (vm: DeckVM) => {
      const deck = vm.deck;
      Alert.alert(deck.name, undefined, [
        { text: "開く", onPress: () => openDeck(deck) },
        {
          text: vm.favorite ? "お気に入りを解除" : "お気に入りに追加",
          onPress: () => toggleFavorite(deck),
        },
        { text: "AI問題", onPress: () => setView({ name: "quiz", deckId: deck.id }) },
        { text: "設定・再検出", onPress: () => setView({ name: "settings", deckId: deck.id }) },
        { text: "削除", style: "destructive", onPress: () => confirmDelete(deck) },
        { text: "キャンセル", style: "cancel" },
      ]);
    },
    [confirmDelete, setView, toggleFavorite, openDeck],
  );

  const cols = COLS[viewMode];
  const sorted = items ? sortItems(items, sortMode) : null;

  // true = account has a cloud copy (restorable on re-Pro); false = device-only (delete = permanent);
  // null = unknown (offline / not yet fetched) → no badge, and the delete warning errs safe-side.
  const cloudBackedOf = (deckId: number): boolean | null =>
    cloudKnown ? cloudBackedDecks.has(deckId) : null;
  const cloudBadge = (deckId: number) => {
    const b = cloudBackedOf(deckId);
    if (b === true) return <Text style={styles.badgeCloud}>☁️ クラウドあり</Text>;
    if (b === false) return <Text style={styles.badgeLocal}>端末のみ</Text>;
    return null;
  };

  const renderGrid = ({ item }: { item: DeckVM }) => (
    <Pressable
      style={styles.card}
      onPress={() => openDeck(item.deck)}
      onLongPress={() => onLongPress(item)}
    >
      <View style={styles.coverWrap}>
        {item.cover ? (
          <Image source={{ uri: item.cover }} style={styles.cover} resizeMode="cover" />
        ) : (
          <View style={[styles.cover, styles.coverPlaceholder]}>
            <Text style={styles.muted}>PDF</Text>
          </View>
        )}
        <Pressable style={styles.favBadge} onPress={() => toggleFavorite(item.deck)} hitSlop={8}>
          <Text style={[styles.favStar, item.favorite && styles.favStarOn]}>
            {item.favorite ? "★" : "☆"}
          </Text>
        </Pressable>
      </View>
      <Text style={styles.cardName} numberOfLines={2}>
        {item.deck.name}
      </Text>
      <Text style={styles.cardCount}>{item.count} 問</Text>
      {cloudBadge(item.deck.id)}
    </Pressable>
  );

  const renderList = ({ item }: { item: DeckVM }) => (
    <Pressable
      style={styles.listRow}
      onPress={() => openDeck(item.deck)}
      onLongPress={() => onLongPress(item)}
    >
      {item.cover ? (
        <Image source={{ uri: item.cover }} style={styles.listCover} resizeMode="cover" />
      ) : (
        <View style={[styles.listCover, styles.coverPlaceholder]}>
          <Text style={styles.muted}>PDF</Text>
        </View>
      )}
      <View style={styles.listInfo}>
        <Text style={styles.listName} numberOfLines={1}>
          {item.deck.name}
        </Text>
        <View style={styles.listMetaRow}>
          <Text style={styles.cardCount}>{item.count} 問</Text>
          {cloudBadge(item.deck.id)}
        </View>
      </View>
      <Pressable style={styles.favBadgeList} onPress={() => toggleFavorite(item.deck)} hitSlop={8}>
        <Text style={[styles.favStar, item.favorite && styles.favStarOn]}>
          {item.favorite ? "★" : "☆"}
        </Text>
      </Pressable>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Image source={require("../../assets/icon.png")} style={styles.brandIcon} />
          <Text style={styles.brand}>Kiokumate</Text>
        </View>
        <View style={styles.headerBtns}>
          <Pressable style={styles.addBtn} onPress={onImport}>
            <Text style={styles.addBtnText}>＋ 取り込む</Text>
          </Pressable>
        </View>
      </View>

      {sorted && sorted.length > 0 && (
        <View style={styles.toolbar}>
          <Pressable style={styles.toolBtn} onPress={pickSort} hitSlop={6}>
            <Text style={styles.toolBtnText}>並び替え：{SORT_LABELS[sortMode]}</Text>
          </Pressable>
          <Pressable style={styles.toolBtn} onPress={pickView} hitSlop={6}>
            <Text style={styles.toolBtnText}>表示：{VIEW_LABELS[viewMode]}</Text>
          </Pressable>
        </View>
      )}

      {items === null ? (
        <View style={styles.center}>
          <Text style={styles.muted}>読み込み中…</Text>
        </View>
      ) : items.length === 0 && cloud.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>本棚は空です</Text>
          <Text style={styles.muted}>「＋ 取り込む」から赤シート対応PDFを追加</Text>
        </View>
      ) : (
        <FlatList
          key={viewMode}
          data={sorted ?? items}
          keyExtractor={(it) => String(it.deck.id)}
          numColumns={cols}
          columnWrapperStyle={cols > 1 ? styles.row : undefined}
          contentContainerStyle={styles.grid}
          renderItem={viewMode === "list" ? renderList : renderGrid}
          ListFooterComponent={
            cloud.length > 0 ? (
              <View style={styles.cloudSection}>
                <Text style={styles.cloudTitle}>クラウド（この端末にない本）</Text>
                <Text style={styles.cloudNote}>
                  {cloudPro
                    ? "同じアカウントの本です。「取り込む」で追加、「クラウドから完全に削除」ですべての端末から削除します。"
                    : "他の端末にある本です。各本の「…から削除」で、この端末のアカウント枠を空けられます。クラウド保存がある本はProに戻すと復元できますが、ない本（端末のみ）は復元できません。"}
                </Text>
                {cloud.map((b) => (
                  <View key={b.book_id} style={styles.cloudRow}>
                    <View style={styles.cloudInfo}>
                      <Text style={styles.cloudName} numberOfLines={1}>
                        {b.name || "（無題）"}
                      </Text>
                      <View style={styles.cloudMetaRow}>
                        <Text style={b.size > 0 ? styles.badgeCloud : styles.badgeLocal}>
                          {b.size > 0 ? "☁️ クラウドあり" : "端末のみ（復元不可）"}
                        </Text>
                        <Text style={styles.cloudDevice}>
                          {b.device ? `「${b.device}」に保存` : "クラウドのみ"}
                        </Text>
                      </View>
                    </View>
                    {cloudPro ? (
                      <>
                        {b.size > 0 ? (
                          <Pressable
                            style={styles.cloudBtn}
                            disabled={downloading.has(b.book_id)}
                            onPress={() => onDownload(b)}
                          >
                            <Text style={styles.cloudBtnText}>
                              {downloading.has(b.book_id) ? "取り込み中…" : "取り込む"}
                            </Text>
                          </Pressable>
                        ) : null}
                        <Pressable style={styles.cloudDeleteBtn} onPress={() => onRemoveCloud(b)}>
                          <Text style={styles.cloudDeleteText}>クラウドから完全に削除</Text>
                        </Pressable>
                      </>
                    ) : (
                      <Pressable style={styles.cloudBtn} onPress={() => onReleaseCloud(b)}>
                        <Text style={styles.cloudBtnText}>
                          {b.device ? `「${b.device}」から削除` : "削除して枠を空ける"}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
            ) : null
          }
        />
      )}

      <View style={styles.footer}>
        <Pressable onPress={onBackup} hitSlop={8}>
          <Text style={styles.footerLinkText}>バックアップ</Text>
        </Pressable>
        <Pressable onPress={() => setView({ name: "info" })} hitSlop={8}>
          <Text style={styles.footerLinkText}>情報・ヘルプ</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandIcon: { width: 34, height: 34, borderRadius: 8 },
  brand: { fontSize: 22, fontWeight: "800", color: "#b9824f" },
  headerBtns: { flexDirection: "row", alignItems: "center", gap: 8 },
  addBtn: { backgroundColor: colors.sand, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  addBtnText: { color: "#fff", fontWeight: "700" },
  toolbar: { flexDirection: "row", gap: 8, marginBottom: 10 },
  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  toolBtnText: { color: colors.textSub, fontSize: 13, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  grid: { paddingBottom: 24 },
  row: { gap: 12 },
  card: { flex: 1, marginBottom: 16 },
  coverWrap: {
    aspectRatio: 0.72,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cover: { width: "100%", height: "100%" },
  coverPlaceholder: { alignItems: "center", justifyContent: "center" },
  favBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  favBadgeList: { paddingHorizontal: 6, paddingVertical: 6 },
  favStar: { fontSize: 16, color: colors.muted },
  favStarOn: { color: colors.sand },
  cardName: { marginTop: 6, fontSize: 13, fontWeight: "600", color: colors.text },
  cardCount: { fontSize: 12, color: colors.textSub },
  listMetaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  badgeCloud: {
    fontSize: 10,
    fontWeight: "700",
    color: "#2a6f97",
    backgroundColor: "#e3f0f7",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 7,
    overflow: "hidden",
    marginTop: 2,
  },
  badgeLocal: {
    fontSize: 10,
    fontWeight: "700",
    color: "#9a6a00",
    backgroundColor: "#fbf0d9",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 7,
    overflow: "hidden",
    marginTop: 2,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  listCover: {
    width: 44,
    height: 60,
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  listInfo: { flex: 1 },
  listName: { fontSize: 15, fontWeight: "600", color: colors.text },
  footer: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 10 },
  footerLinkText: { color: colors.muted, fontSize: 13 },
  cloudSection: {
    marginTop: 8,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  cloudTitle: { fontSize: 13, fontWeight: "700", color: colors.textSub, marginBottom: 2 },
  cloudNote: { fontSize: 12, color: colors.muted, marginBottom: 4, lineHeight: 17 },
  cloudLocked: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  cloudRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  cloudInfo: { flex: 1 },
  cloudName: { fontSize: 14, fontWeight: "600", color: colors.text },
  cloudMetaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 2 },
  cloudDevice: { fontSize: 11, color: colors.muted },
  cloudBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  cloudBtnText: { color: colors.ocean, fontSize: 13, fontWeight: "600" },
  cloudDeleteBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  cloudDeleteText: { color: "#c0392b", fontSize: 13, fontWeight: "600" },
});
