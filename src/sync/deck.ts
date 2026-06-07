// Pro cloud sync of a whole deck on iOS = PDF blob (R2 .pdf, via expo-file-system upload/download)
// + content JSON (R2 .json: name/color/geometry/clozes/bookmarks) so another device rebuilds it
// without re-detecting. Mirrors the web app's sync/deck.ts. The cross-device book id is stored in
// the meta table (`book:<deckId>`) — the iOS decks table has no bookId column.
import * as Legacy from "expo-file-system/legacy";
import { File, Paths } from "expo-file-system";
import { deckPdfFile } from "../db/files";
import {
  deckCards,
  getDeck,
  getDeckPdf,
  getMeta,
  importBookmarks,
  importDeck,
  listBookmarks,
  listDecks,
  setMeta,
} from "../db/repo";
import { SYNC_BASE, getContent, idToken, putContent, registerBook, type AccountBook } from "./api";
import { deviceLabel } from "./device";
import type { DeckColorConfig, DetectedCloze } from "../types";

interface DeckContent {
  name: string;
  color: DeckColorConfig;
  pageCount: number;
  pageW: number;
  pageH: number;
  clozes: DetectedCloze[];
  bookmarks: { title: string; pageIndex: number }[];
}

const blobUrl = (bookId: string) => `${SYNC_BASE}/books/${encodeURIComponent(bookId)}/blob`;
const bookKey = (deckId: number) => `book:${deckId}`;

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

/** Upload a local deck's PDF + content to the cloud (Pro). Best-effort; callers ignore errors. */
export async function uploadDeck(bookId: string, deckId: number): Promise<void> {
  const [deck, pdf, cards, bms] = await Promise.all([
    getDeck(deckId),
    getDeckPdf(deckId),
    deckCards(deckId),
    listBookmarks(deckId),
  ]);
  if (!deck || !pdf) return;
  const content: DeckContent = {
    name: deck.name,
    color: deck.color,
    pageCount: pdf.pageCount,
    pageW: pdf.pageW,
    pageH: pdf.pageH,
    clozes: cards.map((c) => ({ pageIndex: c.pageIndex, rects: c.rects, bbox: c.answerRect, text: c.text })),
    bookmarks: bms.map((b) => ({ title: b.title, pageIndex: b.pageIndex })),
  };
  await putContent(bookId, JSON.stringify(content));
  const token = await idToken();
  if (!token) return;
  const res = await Legacy.uploadAsync(blobUrl(bookId), deckPdfFile(deckId).uri, {
    httpMethod: "PUT",
    uploadType: Legacy.FileSystemUploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" },
  });
  if (res.status >= 400 && res.status !== 403) throw new Error(`upload blob failed: ${res.status}`);
}

/** On import: reserve an account-global slot, remember the bookId, and upload. All best-effort
 * (fail-open) so a sync hiccup never breaks the local import. No-op when signed out. */
export async function syncNewDeck(deckId: number, name: string, pageCount: number): Promise<void> {
  if (!(await idToken())) return;
  const bookId = uuid();
  await setMeta(bookKey(deckId), bookId);
  try {
    await registerBook(bookId, name, pageCount, deviceLabel());
  } catch {
    /* registry hiccup — keep the local deck */
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
  if (content.bookmarks?.length) await importBookmarks(deckId, content.bookmarks);
  return deckId;
}
