// Pro cloud sync of a whole deck on iOS = PDF blob (R2 .pdf, via expo-file-system upload/download)
// + content JSON (R2 .json: name/color/geometry/clozes/bookmarks) so another device rebuilds it
// without re-detecting. Mirrors the web app's sync/deck.ts. The cross-device book id is stored in
// the meta table (`book:<deckId>`) — the iOS decks table has no bookId column.
import * as Legacy from "expo-file-system/legacy";
import { File, Paths } from "expo-file-system";
import { deckPdfFile } from "../db/files";
import {
  deckCards,
  getClozeTomb,
  getDeck,
  getDeckPdf,
  getMeta,
  importBookmarks,
  importDeck,
  listBookmarks,
  listDecks,
  materializeContent,
  setMeta,
  updateDeck,
} from "../db/repo";
import {
  SYNC_BASE,
  getContent,
  idToken,
  listBooks,
  putContent,
  registerBook,
  retainBook,
  unregisterBook,
  updateBookMeta,
  type AccountBook,
} from "./api";
import {
  activeClozes,
  clozeMapFromCards,
  mergeContent,
  normalizeContent,
  tombstonesOf,
  type ClozeMap,
} from "./contentMerge";
import { clearPreviousDeviceLabel, deviceLabel } from "./device";
import type { DeckColorConfig, DetectedCloze } from "../types";

// §2.2(a) Offline import enforcement: each sync caches the account's used/total slots; when offline
// we block import on this LAST-SEEN server quota instead of the local deck count. A stale cache errs
// toward blocking (never a bypass); the paid value (sync/AI/storage) is server-gated regardless.
export interface QuotaCache {
  count: number;
  limit: number;
  unlimited: boolean;
  /** Last-seen server tier — lets Premium-gated features (今日の復習) stay available offline, where
   * a fresh listBooks fails and there's no other tier source. */
  tier?: string;
}
export async function cacheQuota(b: {
  count: number;
  limit: number;
  unlimited: boolean;
  tier?: string;
}): Promise<void> {
  await setMeta(
    "quotaCache",
    JSON.stringify({ count: b.count, limit: b.limit, unlimited: b.unlimited, tier: b.tier }),
  ).catch(() => {});
}
/** The last-seen server quota (or null if we've never synced on this device). */
export async function cachedQuota(): Promise<QuotaCache | null> {
  const s = await getMeta("quotaCache");
  if (!s) return null;
  try {
    return JSON.parse(s) as QuotaCache;
  } catch {
    return null;
  }
}

interface DeckContent {
  name: string;
  color: DeckColorConfig;
  pageCount: number;
  pageW: number;
  pageH: number;
  /** Legacy whole-set (GET compat mirror + old-client download). Live source = clozesLww. */
  clozes: DetectedCloze[];
  /** Masks as an LWW-element-set so concurrent edits merge per-key (P0-2). */
  clozesLww?: ClozeMap;
  bookmarks: { title: string; pageIndex: number }[];
  /** Local edit time of this content (epoch ms), set on upload — drives content last-write-wins. */
  contentAt?: number;
}

const blobUrl = (bookId: string) => `${SYNC_BASE}/books/${encodeURIComponent(bookId)}/blob`;
const bookKey = (deckId: number) => `book:${deckId}`;
const contentKey = (deckId: number) => `contentAt:${deckId}`; // local copy's content version
const regKey = (deckId: number) => `reg:${deckId}`; // "1" once GENUINELY in the account registry

/** True once this deck has been in the account registry (genuine register / download / seen-known).
 * Lets reconcile distinguish an orphan (registered but now gone → unregistered elsewhere → delete)
 * from a fresh local-only import (offline / fail-open register → keep). */
export async function isRegistered(deckId: number): Promise<boolean> {
  return (await getMeta(regKey(deckId))) === "1";
}
export async function setRegistered(deckId: number): Promise<void> {
  await setMeta(regKey(deckId), "1");
}

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function deckBookId(deckId: number): Promise<string | undefined> {
  return getMeta(bookKey(deckId));
}

/** Map cloud bookId -> local deckId, for decks that have been synced/downloaded on this device. */
export async function localBookIds(): Promise<Map<string, number>> {
  const decks = await listDecks();
  const m = new Map<string, number>();
  for (const d of decks) {
    const bid = await getMeta(bookKey(d.id));
    if (bid) m.set(bid, d.id);
  }
  return m;
}

/** Account-side cleanup when a single book is deleted locally (from anywhere — the bookshelf or the
 * book's settings). Fetches the account view itself, so callers without the bookshelf's cached cloud
 * state can free the slot correctly: no cloud copy → unregister (permanent, frees the slot); a
 * Standard/Free cloud-backed book → retain (frees the slot, keeps R2 for re-Pro); a Pro+ holder →
 * keep the book active (re-downloadable) and just release the holder. Best-effort; offline leaves
 * the slot to be reconciled later (never throws). */
export async function releaseLocalBookSlot(bookId: string): Promise<void> {
  if (!(await idToken())) return;
  let acct;
  try {
    acct = await listBooks();
  } catch {
    return; // offline — keep the registry as-is; reconcile/next sync handles it
  }
  const b = acct.books.find((x) => x.book_id === bookId);
  if (!b) return; // never registered (fail-open import) → no account slot to free
  if (b.size === 0) {
    await unregisterBook(bookId).catch(() => {}); // no cloud copy → free the slot (permanent)
  } else if (!acct.unlimited) {
    await retainBook(bookId).catch(() => {}); // Standard/Free → retain (free slot, keep R2)
  } else if (b.device === deviceLabel()) {
    await updateBookMeta(bookId, { device: null }).catch(() => {}); // Pro+ holder → release holder
  }
}

/** On logout, release THIS device's book slots that have NO cloud file (size 0 = a Standard
 * slot-only registration) — so a local wipe doesn't leave orphaned slots counting toward the cap.
 * Books WITH a cloud file (uploaded while Pro — incl. a since-downgraded account) are KEPT, since
 * GET is owner-open so they stay downloadable after re-login / on other devices. Best-effort. */
export async function releaseLocalSlotsOnLogout(): Promise<void> {
  if (!(await idToken())) return;
  let books: AccountBook[];
  try {
    books = (await listBooks()).books;
  } catch {
    return; // can't tell which have files → keep everything (never delete a downloadable file)
  }
  const hasFile = new Map(books.map((b) => [b.book_id, b.size > 0]));
  const ids = await localBookIds();
  for (const bookId of ids.keys()) {
    if (hasFile.get(bookId) === false) await unregisterBook(bookId).catch(() => {});
  }
}

/** Pro/admin only: upload any LOCAL book that has no cloud file yet (e.g. imported while Standard,
 * then upgraded to Pro). Idempotent — skips books that already have a cloud file. Best-effort; never
 * throws. Backfills the cloud after an upgrade so the books reach the account's other devices. */
export async function backfillCloudIfPro(): Promise<void> {
  if (!(await idToken())) return;
  let acct;
  try {
    acct = await listBooks();
  } catch {
    return;
  }
  if (!acct.unlimited) return; // cloud upload is pro / premium / admin (server: isUnlimited)
  const size = new Map(acct.books.map((b) => [b.book_id, b.size]));
  const ids = await localBookIds(); // Map<bookId, deckId>
  for (const [bookId, deckId] of ids) {
    if ((size.get(bookId) ?? 0) > 0) continue; // already has a cloud file
    await uploadDeck(bookId, deckId).catch(() => {});
  }
}

/** Stamp THIS device's current name on every book it holds locally (in the account registry), so the
 * cloud list shows where a book is NOW — not just who first imported it. Called after the user
 * renames this device; only touches rows whose label differs. Best-effort; never throws.
 * Only once EVERY row is confirmed re-stamped is the pending previous label cleared — until then
 * the reconcile keeps treating books stamped with the old name as held by this device. */
export async function applyDeviceNameToLocalBooks(): Promise<void> {
  if (!(await idToken())) return;
  const me = deviceLabel();
  let acct;
  try {
    acct = await listBooks();
  } catch {
    return; // offline — the pending previous label stays, so nothing gets misclassified
  }
  const ids = await localBookIds(); // Map<bookId, deckId>
  let allOk = true;
  for (const b of acct.books) {
    if (ids.has(b.book_id) && b.device !== me) {
      try {
        await updateBookMeta(b.book_id, { device: me });
      } catch {
        allOk = false;
      }
    }
  }
  if (allOk) await clearPreviousDeviceLabel();
}

/** Build the content JSON (everything needed to rebuild the deck except the PDF) from local state. */
async function buildContent(deckId: number): Promise<DeckContent | null> {
  const [deck, pdf, cards, bms] = await Promise.all([
    getDeck(deckId),
    getDeckPdf(deckId),
    deckCards(deckId),
    listBookmarks(deckId),
  ]);
  if (!deck || !pdf) return null;
  // Masks as the LWW-element-set: live cards (t = createdAt) + persisted tombstones (P0-2). Also emit
  // the active clozes[] mirror for the GET shim / old-client download.
  const clozesLww = clozeMapFromCards(
    cards.map((c) => ({
      pageIndex: c.pageIndex,
      rects: c.rects,
      bbox: c.answerRect,
      text: c.text,
      t: c.createdAt,
    })),
    await getClozeTomb(deckId),
  );
  return {
    name: deck.name,
    color: deck.color,
    pageCount: pdf.pageCount,
    pageW: pdf.pageW,
    pageH: pdf.pageH,
    clozes: activeClozes({ clozesLww }).map((e) => ({
      pageIndex: e.pageIndex,
      rects: e.rects,
      bbox: e.bbox,
      text: e.text ?? "",
    })),
    clozesLww,
    bookmarks: bms.map((b) => ({ title: b.title, pageIndex: b.pageIndex })),
  };
}

/** Upload a local deck's PDF + content to the cloud (Pro). Best-effort; callers ignore errors. */
export async function uploadDeck(bookId: string, deckId: number): Promise<void> {
  const content = await buildContent(deckId);
  if (!content) return;
  content.contentAt = Date.now();
  await putContent(bookId, JSON.stringify(content));
  await setMeta(contentKey(deckId), String(content.contentAt)); // record our own version
  const token = await idToken();
  if (!token) return;
  const res = await Legacy.uploadAsync(blobUrl(bookId), deckPdfFile(deckId).uri, {
    httpMethod: "PUT",
    uploadType: Legacy.FileSystemUploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" },
  });
  if (res.status >= 400 && res.status !== 403) throw new Error(`upload blob failed: ${res.status}`);
}

/** Re-sync ONLY the content JSON (masks/bookmarks/name/color), not the PDF blob. Use after editing
 * masks or re-detecting — the PDF is unchanged. The download side rebuilds the whole clozes set, so
 * added AND removed masks both propagate. Stamps contentAt so other devices pull it (and so this
 * device doesn't re-pull its own write). Best-effort; no-op when signed out. */
export async function uploadContent(bookId: string, deckId: number): Promise<void> {
  if (!(await idToken())) return;
  const content = await buildContent(deckId);
  if (!content) return;
  content.contentAt = Date.now();
  await putContent(bookId, JSON.stringify(content));
  await setMeta(contentKey(deckId), String(content.contentAt));
}

/** Pull newer content from the cloud and replace local masks (last-write-wins). Returns true if it
 * applied a newer version. Best-effort: callers wrap in catch so offline / signed-out keeps local. */
export async function refreshContent(deckId: number): Promise<boolean> {
  const bookId = await deckBookId(deckId);
  if (!bookId || !(await idToken())) return false; // not a synced deck / signed out
  const localAt = Number(await getMeta(contentKey(deckId))) || 0;
  const cloud = (await getContent(bookId)) as DeckContent;
  const cloudAt = cloud.contentAt ?? 0;
  if (!cloudAt || cloudAt <= localAt) return false; // local already current
  // MERGE the (already server-merged) cloud set with our LOCAL set per-key, then materialize cards
  // from the result (preserving each cloze's t) and adopt the merged tombstones (P0-2).
  const [deck, cards, tomb] = await Promise.all([
    getDeck(deckId),
    deckCards(deckId),
    getClozeTomb(deckId),
  ]);
  if (!deck) return false;
  const localMap = clozeMapFromCards(
    cards.map((c) => ({
      pageIndex: c.pageIndex,
      rects: c.rects,
      bbox: c.answerRect,
      text: c.text,
      t: c.createdAt,
    })),
    tomb,
  );
  const merged = mergeContent(
    normalizeContent(
      { clozesLww: localMap, name: deck.name, color: deck.color, contentAt: localAt },
      1,
    ),
    normalizeContent(cloud, cloudAt),
  );
  const active = activeClozes(merged).map((e) => ({
    pageIndex: e.pageIndex,
    rects: e.rects,
    bbox: e.bbox,
    text: e.text ?? "",
    t: e.t,
  }));
  await materializeContent(
    deckId,
    (merged.color ?? deck.color) as DeckColorConfig,
    active,
    tombstonesOf(merged.clozesLww ?? {}),
  );
  if (merged.name) await updateDeck(deckId, { name: merged.name });
  await setMeta(contentKey(deckId), String(cloudAt));
  return true;
}

/** On import: reserve an account-global slot, remember the bookId, and upload. All best-effort
 * (fail-open) so a sync hiccup never breaks the local import. No-op when signed out. */
export async function syncNewDeck(deckId: number, name: string, pageCount: number): Promise<void> {
  if (!(await idToken())) return;
  const bookId = uuid();
  await setMeta(bookKey(deckId), bookId);
  try {
    const r = await registerBook(bookId, name, pageCount, deviceLabel());
    if (r.ok) await setRegistered(deckId); // GENUINE registration → reconcile may follow an unregister
  } catch {
    /* registry hiccup — keep the local deck; NOT registered (the server doesn't know it yet) */
  }
  try {
    await uploadDeck(bookId, deckId);
  } catch {
    /* upload hiccup — content reconciles on a later sync */
  }
}

/** Download an account book and reconstruct it locally. Returns the new local deckId. */
export async function downloadDeck(book: AccountBook): Promise<number> {
  const content = (await getContent(book.book_id)) as DeckContent;
  const token = await idToken();
  if (!token) throw new Error("not_signed_in");
  const staged = new File(Paths.document, `sync-import-${Date.now()}.pdf`);
  if (staged.exists) staged.delete();
  const res = await Legacy.downloadAsync(blobUrl(book.book_id), staged.uri, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status >= 400) throw new Error(`download blob failed: ${res.status}`);
  const deckId = await importDeck({
    name: content.name,
    stagedPdfUri: staged.uri,
    pageCount: content.pageCount,
    pageW: content.pageW,
    pageH: content.pageH,
    color: content.color,
    clozes: content.clozes,
  });
  await setMeta(bookKey(deckId), book.book_id);
  await setRegistered(deckId); // came from the account registry → orphan-cleanup eligible
  await setMeta(contentKey(deckId), String(content.contentAt ?? 0)); // baseline so we don't re-pull it
  // Adopt any cloud tombstones so a mask deleted elsewhere isn't re-added locally later (P0-2).
  await setMeta(`clozeTomb:${deckId}`, JSON.stringify(tombstonesOf(content.clozesLww ?? {})));
  if (content.bookmarks?.length) await importBookmarks(deckId, content.bookmarks);
  return deckId;
}
