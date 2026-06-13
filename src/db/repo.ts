// Data access — the SQLite port of the web app's Dexie repo. Same function surface so
// screens stay close to the original; JSON columns (color/rects/answerRect) are parsed
// here, and PDFs are moved to disk on import.
import type { SQLiteDatabase } from "expo-sqlite";
import { DEFAULT_MAGENTA_BAND, type DeckColorConfig, type DetectedCloze, type Rect } from "../types";
import type { BookmarkRow, CardRow, DeckRow, PdfRow, QuestionRow, Qtype, ReadMode, ReviewRow } from "./rows";
import { getDb, withWriteLock } from "./database";
import { deckPdfFile, deleteDeckPdf, savePdfForDeck } from "./files";
import { cardKey, correspondCards } from "../sync/cardKeys";
import { setActiveStars, type StarMap } from "../sync/progressMerge";

export interface ImportParams {
  name: string;
  /** Staged PDF (documents/import.pdf); moved into the deck's permanent path on import. */
  stagedPdfUri: string;
  pageCount: number;
  pageW: number;
  pageH: number;
  color: DeckColorConfig;
  clozes: DetectedCloze[];
  /** Optional page-1 cover thumbnail as a data: URL (from the engine's renderCover). */
  coverDataUrl?: string;
}

// ---- row mappers (DB text -> typed objects) ----

// One malformed/legacy JSON column must not reject an entire listDecks/deckCards.
function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface DeckSql {
  id: number;
  name: string;
  createdAt: number;
  color: string;
  lastPage: number | null;
  lastMode: string | null;
}
function mapDeck(r: DeckSql): DeckRow {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    color: safeJson(r.color, DEFAULT_MAGENTA_BAND),
    lastPage: r.lastPage,
    lastMode: (r.lastMode as ReadMode | null) ?? null,
  };
}

interface CardSql {
  id: number;
  deckId: number;
  pdfId: number;
  pageIndex: number;
  rects: string;
  answerRect: string;
  text: string;
  createdAt: number;
}
function mapCard(r: CardSql): CardRow {
  return {
    id: r.id,
    deckId: r.deckId,
    pdfId: r.pdfId,
    pageIndex: r.pageIndex,
    rects: safeJson(r.rects, [] as Rect[]),
    answerRect: safeJson(r.answerRect, { x: 0, y: 0, w: 0, h: 0 }),
    text: r.text,
    createdAt: r.createdAt,
  };
}

async function insertCards(
  db: SQLiteDatabase,
  deckId: number,
  pdfId: number,
  clozes: DetectedCloze[],
  now: number,
): Promise<void> {
  const CHUNK = 100; // 7 bound vars/row -> 700, safely under SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < clozes.length; i += CHUNK) {
    const slice = clozes.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "(?,?,?,?,?,?,?)").join(",");
    const params: (string | number)[] = [];
    for (const c of slice) {
      params.push(
        deckId,
        pdfId,
        c.pageIndex,
        JSON.stringify(c.rects),
        JSON.stringify(c.bbox),
        c.text,
        // createdAt doubles as the cloze LWW timestamp (P0-2): sync-materialize passes the merged t.
        c.t ?? now,
      );
    }
    await db.runAsync(
      `INSERT INTO cards (deckId, pdfId, pageIndex, rects, answerRect, text, createdAt) VALUES ${placeholders}`,
      params,
    );
  }
}

export async function importDeck(p: ImportParams): Promise<number> {
  return withWriteLock(async () => {
    const db = await getDb();
    const now = Date.now();
    let deckId = 0;
    // lastPage starts NULL so the first open resolves to firstAnswerPage (0 would defeat it).
    await db.withTransactionAsync(async () => {
      const deck = await db.runAsync(
        "INSERT INTO decks (name, createdAt, color, lastPage, lastMode) VALUES (?, ?, ?, ?, ?)",
        [p.name, now, JSON.stringify(p.color), null, "scroll"],
      );
      deckId = deck.lastInsertRowId;
      const pdf = await db.runAsync(
        "INSERT INTO pdfs (deckId, name, filePath, pageCount, pageW, pageH) VALUES (?, ?, ?, ?, ?, ?)",
        [deckId, p.name, deckPdfFile(deckId).uri, p.pageCount, p.pageW, p.pageH],
      );
      await insertCards(db, deckId, pdf.lastInsertRowId, p.clozes, now);
      if (p.coverDataUrl) {
        await db.runAsync("INSERT OR REPLACE INTO covers (deckId, dataUrl) VALUES (?, ?)", [
          deckId,
          p.coverDataUrl,
        ]);
      }
    });
    // Move the staged PDF into place AFTER commit, so a rolled-back import never consumes it
    // (leaving import.pdf intact for a retry). If the move fails, undo the just-committed deck so we
    // never leave a book that shows in the shelf but can't open (no PDF). We still hold the lock.
    try {
      await savePdfForDeck(deckId, p.stagedPdfUri);
    } catch (e) {
      await db.withTransactionAsync(async () => {
        await db.runAsync("DELETE FROM cards WHERE deckId = ?", [deckId]);
        await db.runAsync("DELETE FROM bookmarks WHERE deckId = ?", [deckId]);
        await db.runAsync("DELETE FROM pdfs WHERE deckId = ?", [deckId]);
        await db.runAsync("DELETE FROM covers WHERE deckId = ?", [deckId]);
        await db.runAsync("DELETE FROM decks WHERE id = ?", [deckId]);
      });
      throw e;
    }
    return deckId;
  });
}

export async function listDecks(): Promise<DeckRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<DeckSql>("SELECT * FROM decks ORDER BY createdAt DESC");
  return rows.map(mapDeck);
}

export async function deckCountTotal(): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM decks");
  return r?.n ?? 0;
}

export async function getDeck(deckId: number): Promise<DeckRow | undefined> {
  const db = await getDb();
  const r = await db.getFirstAsync<DeckSql>("SELECT * FROM decks WHERE id = ?", [deckId]);
  return r ? mapDeck(r) : undefined;
}

export async function getDeckPdf(deckId: number): Promise<PdfRow | undefined> {
  const db = await getDb();
  const r = await db.getFirstAsync<PdfRow>("SELECT * FROM pdfs WHERE deckId = ? LIMIT 1", [deckId]);
  // `filePath` was stored at import as an ABSOLUTE file:// path, but iOS can reassign the app's
  // data-container path on update — leaving that stored path stale (the book shows but won't open).
  // The file itself persists at decks/<deckId>.pdf, so always resolve from the CURRENT document dir.
  return r ? { ...r, filePath: deckPdfFile(deckId).uri } : undefined;
}

export async function answerCount(deckId: number): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cards WHERE deckId = ?",
    [deckId],
  );
  return r?.n ?? 0;
}

/** Add a manual answer mask on a page (user fixing a detection miss). Returns the new card id. */
export async function addCard(
  deckId: number,
  pdfId: number,
  pageIndex: number,
  rect: Rect,
): Promise<number> {
  const db = await getDb();
  const r = await db.runAsync(
    "INSERT INTO cards (deckId, pdfId, pageIndex, rects, answerRect, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [deckId, pdfId, pageIndex, JSON.stringify([rect]), JSON.stringify(rect), "", Date.now()],
  );
  return r.lastInsertRowId;
}

/** Remove a single answer mask (user fixing a false positive). */
export async function deleteCard(cardId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM cards WHERE id = ?", [cardId]);
}

export interface DeckPatch {
  name?: string;
  color?: DeckColorConfig;
  lastPage?: number;
  lastMode?: ReadMode;
}
export async function updateDeck(deckId: number, patch: DeckPatch): Promise<void> {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.color !== undefined) {
    sets.push("color = ?");
    params.push(JSON.stringify(patch.color));
  }
  if (patch.lastPage !== undefined) {
    sets.push("lastPage = ?");
    params.push(patch.lastPage);
  }
  if (patch.lastMode !== undefined) {
    sets.push("lastMode = ?");
    params.push(patch.lastMode);
  }
  if (!sets.length) return;
  params.push(deckId);
  const db = await getDb();
  await db.runAsync(`UPDATE decks SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** Re-run detection for a deck under a new color config: replace all its answers (carrying ★ over),
 * and tombstone the masks the re-detect removed so the deletion propagates cross-device (P0-2/§4.4). */
export async function redetectDeck(
  deckId: number,
  color: DeckColorConfig,
  clozes: DetectedCloze[],
): Promise<number> {
  return withWriteLock(async () => {
    const db = await getDb();
    const now = Date.now();
    const oldCards = await deckCards(deckId); // snapshot positions for ★/revealed carry-over
    let count = 0;
    await db.withTransactionAsync(async () => {
      await db.runAsync("UPDATE decks SET color = ? WHERE id = ?", [JSON.stringify(color), deckId]);
      const pdf = await db.getFirstAsync<{ id: number }>(
        "SELECT id FROM pdfs WHERE deckId = ? LIMIT 1",
        [deckId],
      );
      if (!pdf) throw new Error("PDFが見つかりません");
      await db.runAsync("DELETE FROM cards WHERE deckId = ?", [deckId]);
      await insertCards(db, deckId, pdf.id, clozes, now);
      count = clozes.length;
    });
    const newCards = await deckCards(deckId); // new ids after re-insert
    await carryStarsRevealedOnRedetect(deckId, oldCards, newCards, now);
    await tombstoneRemovedClozes(deckId, oldCards, newCards, now); // removed masks -> tombstones
    return count;
  });
}

/** Materialize the server-MERGED mask set (P0-2): replace cards with the active clozes (preserving
 * their merged `t` via cloze.t), carry ★ over, and adopt the merged tombstones. */
export async function materializeContent(
  deckId: number,
  color: DeckColorConfig,
  active: DetectedCloze[],
  tombs: Record<string, number>,
): Promise<void> {
  await withWriteLock(async () => {
    const db = await getDb();
    const now = Date.now();
    const oldCards = await deckCards(deckId);
    await db.withTransactionAsync(async () => {
      await db.runAsync("UPDATE decks SET color = ? WHERE id = ?", [JSON.stringify(color), deckId]);
      const pdf = await db.getFirstAsync<{ id: number }>(
        "SELECT id FROM pdfs WHERE deckId = ? LIMIT 1",
        [deckId],
      );
      if (!pdf) throw new Error("PDFが見つかりません");
      await db.runAsync("DELETE FROM cards WHERE deckId = ?", [deckId]);
      await insertCards(db, deckId, pdf.id, active, now); // active carries t -> createdAt
    });
    const newCards = await deckCards(deckId);
    await carryStarsRevealedOnRedetect(deckId, oldCards, newCards, now);
    await setMeta(clozeTombKey(deckId), JSON.stringify(tombs));
  });
}

const clozeTombKey = (deckId: number) => `clozeTomb:${deckId}`;

/** Read the deck's mask tombstone store (clozeKey -> delete time). */
export async function getClozeTomb(deckId: number): Promise<Record<string, number>> {
  const raw = await getMeta(clozeTombKey(deckId));
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Tombstone masks present before a re-detect but gone after; clear tombstones for re-added ones. */
async function tombstoneRemovedClozes(
  deckId: number,
  oldCards: CardRow[],
  newCards: CardRow[],
  now: number,
): Promise<void> {
  const newKeys = new Set(newCards.map((c) => cardKey(c.pageIndex, c.answerRect)));
  const tomb = await getClozeTomb(deckId);
  for (const c of oldCards) {
    const k = cardKey(c.pageIndex, c.answerRect);
    if (!newKeys.has(k)) tomb[k] = now;
  }
  for (const k of newKeys) delete tomb[k];
  await setMeta(clozeTombKey(deckId), JSON.stringify(tomb));
}

/** After a re-detect replaces a deck's cards, move ★/revealed (local card ids, in meta) onto the new
 * cards by geometric overlap, and re-anchor the ★ LWW map to the new position keys (§4.4). */
async function carryStarsRevealedOnRedetect(
  deckId: number,
  oldCards: CardRow[],
  newCards: CardRow[],
  now: number,
): Promise<void> {
  const corr = correspondCards(oldCards, newCards);
  const remap = (ids: number[]) =>
    ids.map((id) => corr.get(id)).filter((x): x is number => x != null);
  const parseNums = (s?: string): number[] => {
    try {
      const v = JSON.parse(s ?? "[]") as unknown;
      return Array.isArray(v) ? (v as number[]) : [];
    } catch {
      return [];
    }
  };
  // ★ ids
  const starRaw = await getMeta(`star:${deckId}`);
  const newStarred = remap(parseNums(starRaw));
  if (starRaw !== undefined) await setMeta(`star:${deckId}`, JSON.stringify(newStarred));
  // revealed (stored inside reveal:{revealed,redMode,band})
  const revRaw = await getMeta(`reveal:${deckId}`);
  if (revRaw) {
    try {
      const o = JSON.parse(revRaw) as { revealed?: number[] };
      if (Array.isArray(o.revealed)) {
        o.revealed = remap(o.revealed);
        await setMeta(`reveal:${deckId}`, JSON.stringify(o));
      }
    } catch {
      /* ignore corrupt reveal state */
    }
  }
  // ★ LWW map: re-anchor to the carried-over stars' new position keys (stale keys -> inert tombstones).
  const lwwRaw = await getMeta(`starsLww:${deckId}`);
  if (lwwRaw !== undefined || newStarred.length) {
    let starMap: StarMap = {};
    try {
      const m = JSON.parse(lwwRaw ?? "{}") as unknown;
      if (m && typeof m === "object") starMap = m as StarMap;
    } catch {
      /* ignore corrupt map */
    }
    const byId = new Map(newCards.map((c) => [c.id, c] as const));
    setActiveStars(
      starMap,
      newStarred.map((id) => cardKey(byId.get(id)!.pageIndex, byId.get(id)!.answerRect)),
      now,
    );
    await setMeta(`starsLww:${deckId}`, JSON.stringify(starMap));
  }
}

/** Lowest page index that has any answer (so the viewer opens on a useful page). */
export async function firstAnswerPage(deckId: number): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ pageIndex: number }>(
    "SELECT pageIndex FROM cards WHERE deckId = ? ORDER BY pageIndex ASC LIMIT 1",
    [deckId],
  );
  return r?.pageIndex ?? 0;
}

/** All answers on a given page (for the red-sheet viewer). */
export async function cardsOnPage(deckId: number, pageIndex: number): Promise<CardRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CardSql>(
    "SELECT * FROM cards WHERE deckId = ? AND pageIndex = ?",
    [deckId, pageIndex],
  );
  return rows.map(mapCard);
}

/** All answers in a deck (grouped by page in the viewer). */
export async function deckCards(deckId: number): Promise<CardRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CardSql>(
    "SELECT * FROM cards WHERE deckId = ? ORDER BY pageIndex ASC",
    [deckId],
  );
  return rows.map(mapCard);
}

export async function deleteDeck(deckId: number): Promise<void> {
  await withWriteLock(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync("DELETE FROM cards WHERE deckId = ?", [deckId]);
      await db.runAsync("DELETE FROM bookmarks WHERE deckId = ?", [deckId]);
      await db.runAsync("DELETE FROM pdfs WHERE deckId = ?", [deckId]);
      await db.runAsync("DELETE FROM covers WHERE deckId = ?", [deckId]);
      await db.runAsync("DELETE FROM decks WHERE id = ?", [deckId]);
      // Also drop this deck's per-deck meta rows so they don't orphan (and can't mis-seed a future
      // deck that reuses the id).
      const mk = [
        "book:", "reg:", "contentAt:", "progressAt:", "clozeTomb:", "starsLww:",
        "star:", "reveal:", "bmLww:", "fav:", "opened:", "autoToc:",
      ].map((pfx) => pfx + deckId);
      await db.runAsync(`DELETE FROM meta WHERE key IN (${mk.map(() => "?").join(",")})`, mk);
    });
    deleteDeckPdf(deckId);
  });
}

// ---- cover thumbnails (page-1 render as a data URL, regenerable) ----

export async function getCover(deckId: number): Promise<string | undefined> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ dataUrl: string }>(
    "SELECT dataUrl FROM covers WHERE deckId = ?",
    [deckId],
  );
  return r?.dataUrl;
}

export async function setCover(deckId: number, dataUrl: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("INSERT OR REPLACE INTO covers (deckId, dataUrl) VALUES (?, ?)", [
    deckId,
    dataUrl,
  ]);
}

// ---- bookmarks (the user-built 目次) ----

export async function addBookmark(
  deckId: number,
  pageIndex: number,
  title: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT INTO bookmarks (deckId, pageIndex, title, createdAt) VALUES (?, ?, ?, ?)",
    [deckId, pageIndex, title, Date.now()],
  );
}

/** Bulk-add bookmarks (e.g. imported from a PDF's built-in outline). */
export async function importBookmarks(
  deckId: number,
  items: { title: string; pageIndex: number }[],
): Promise<void> {
  if (!items.length) return;
  await withWriteLock(async () => {
    const db = await getDb();
    const now = Date.now();
    await db.withTransactionAsync(async () => {
      for (const b of items) {
        await db.runAsync(
          "INSERT INTO bookmarks (deckId, pageIndex, title, createdAt) VALUES (?, ?, ?, ?)",
          [deckId, b.pageIndex, b.title, now],
        );
      }
    });
  });
}

export async function listBookmarks(deckId: number): Promise<BookmarkRow[]> {
  const db = await getDb();
  return db.getAllAsync<BookmarkRow>(
    "SELECT * FROM bookmarks WHERE deckId = ? ORDER BY pageIndex ASC",
    [deckId],
  );
}

export async function renameBookmark(id: number, title: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE bookmarks SET title = ? WHERE id = ?", [title, id]);
}

export async function deleteBookmark(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM bookmarks WHERE id = ?", [id]);
}

/** Replace ALL of a deck's bookmarks (used when pulling synced bookmarks from the cloud). */
export async function replaceBookmarks(
  deckId: number,
  items: { title: string; pageIndex: number }[],
): Promise<void> {
  await withWriteLock(async () => {
    const db = await getDb();
    const now = Date.now();
    await db.withTransactionAsync(async () => {
      await db.runAsync("DELETE FROM bookmarks WHERE deckId = ?", [deckId]);
      for (const b of items) {
        await db.runAsync(
          "INSERT INTO bookmarks (deckId, pageIndex, title, createdAt) VALUES (?, ?, ?, ?)",
          [deckId, b.pageIndex, b.title, now],
        );
      }
    });
  });
}

// ---- app preferences (meta) ----

export async function getMeta(key: string): Promise<string | undefined> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ value: string | null }>(
    "SELECT value FROM meta WHERE key = ?",
    [key],
  );
  return r?.value ?? undefined;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
}

// ---- AI-generated questions (keyed by the cross-device bookId) ----

const Q_COLS =
  "id, bookId, pageIndex, qtype, statement, answer, choices, explanation, source, createdAt";
const Q_INSERT =
  "INSERT OR REPLACE INTO questions (id, bookId, pageIndex, qtype, statement, answer, choices, explanation, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const qBinds = (q: QuestionRow): (string | number | null)[] => [
  q.id,
  q.bookId,
  q.pageIndex,
  q.qtype,
  q.statement,
  q.answer,
  q.choices ? JSON.stringify(q.choices) : null,
  q.explanation,
  q.source,
  q.createdAt,
];
/** sqlite row → QuestionRow (choices TEXT → array; legacy rows have qtype='tf'/choices NULL). */
function qFromRow(r: Omit<QuestionRow, "qtype" | "choices"> & { qtype: string; choices: string | null }): QuestionRow {
  let choices: string[] | null = null;
  if (r.choices) {
    try {
      const parsed = JSON.parse(r.choices) as unknown;
      if (Array.isArray(parsed)) choices = parsed.filter((c): c is string => typeof c === "string");
    } catch {
      /* corrupt → treat as tf-style */
    }
  }
  return { ...r, qtype: r.qtype === "mc4" ? "mc4" : "tf", choices };
}
type QSqlRow = Omit<QuestionRow, "qtype" | "choices"> & { qtype: string; choices: string | null };

/** Replace one (page × type) question group (initial generation or regeneration). The other
 * type's questions on the same page are untouched; reviews of the replaced ids go with them. */
export async function savePageQuestions(
  bookId: string,
  pageIndex: number,
  qtype: Qtype,
  qs: QuestionRow[],
): Promise<void> {
  const db = await getDb();
  await withWriteLock(async () => {
    await db.runAsync(
      "DELETE FROM reviews WHERE questionId IN (SELECT id FROM questions WHERE bookId = ? AND pageIndex = ? AND qtype = ?)",
      [bookId, pageIndex, qtype],
    );
    await db.runAsync("DELETE FROM questions WHERE bookId = ? AND pageIndex = ? AND qtype = ?", [
      bookId,
      pageIndex,
      qtype,
    ]);
    for (const q of qs) await db.runAsync(Q_INSERT, qBinds(q));
  });
}

/** Delete one (page × type) question group + its reviews (問題一覧の削除). */
export async function deleteQuestionGroup(
  bookId: string,
  pageIndex: number,
  qtype: Qtype,
): Promise<void> {
  await savePageQuestions(bookId, pageIndex, qtype, []);
}

/** All questions in a book (the quiz set). */
export async function getBookQuestions(bookId: string): Promise<QuestionRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<QSqlRow>(
    `SELECT ${Q_COLS} FROM questions WHERE bookId = ? ORDER BY pageIndex, createdAt`,
    [bookId],
  );
  return rows.map(qFromRow);
}

/** Questions by id (cross-book 今日の復習 session assembly). Preserves the input order. */
export async function questionsByIds(ids: string[]): Promise<QuestionRow[]> {
  if (!ids.length) return [];
  const db = await getDb();
  const out = new Map<string, QuestionRow>();
  // Chunk to stay under sqlite's bind-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.getAllAsync<QSqlRow>(
      `SELECT ${Q_COLS} FROM questions WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const r of rows) out.set(r.id, qFromRow(r));
  }
  return ids.map((id) => out.get(id)).filter((q): q is QuestionRow => !!q);
}

/** Replace ALL of a book's questions (cloud restore for Pro+). Reviews of ids that no longer
 * exist are pruned so a regeneration on another device can't leave orphaned SM-2 state. */
export async function putBookQuestions(bookId: string, qs: QuestionRow[]): Promise<void> {
  const db = await getDb();
  await withWriteLock(async () => {
    await db.runAsync("DELETE FROM questions WHERE bookId = ?", [bookId]);
    for (const q of qs) await db.runAsync(Q_INSERT, qBinds(q));
    await db.runAsync(
      "DELETE FROM reviews WHERE bookId = ? AND questionId NOT IN (SELECT id FROM questions WHERE bookId = ?)",
      [bookId, bookId],
    );
  });
}

/** Delete a book's questions + reviews (on book delete). */
export async function deleteBookQuestions(bookId: string): Promise<void> {
  const db = await getDb();
  await withWriteLock(async () => {
    await db.runAsync("DELETE FROM questions WHERE bookId = ?", [bookId]);
    await db.runAsync("DELETE FROM reviews WHERE bookId = ?", [bookId]);
  });
}

// ---- SM-2 review records (機能拡張 §A-2/§D — all plans record locally) ----

const R_COLS = "questionId, bookId, ease, intervalD, reps, lapses, dueAt, lastAt, lastOk, updatedAt";

/** All review records for a book, as a questionId-keyed map. */
export async function getBookReviews(bookId: string): Promise<Map<string, ReviewRow>> {
  const db = await getDb();
  const rows = await db.getAllAsync<ReviewRow>(
    `SELECT ${R_COLS} FROM reviews WHERE bookId = ?`,
    [bookId],
  );
  return new Map(rows.map((r) => [r.questionId, r]));
}

/** Upsert one review record (after an answer, or from a cloud pull). */
export async function putReview(r: ReviewRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO reviews (${R_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.questionId, r.bookId, r.ease, r.intervalD, r.reps, r.lapses, r.dueAt, r.lastAt, r.lastOk, r.updatedAt],
  );
}

/** All review records (cross-book — drives the 今日の復習 card + sync push). */
export async function allReviews(): Promise<ReviewRow[]> {
  const db = await getDb();
  return db.getAllAsync<ReviewRow>(`SELECT ${R_COLS} FROM reviews`);
}

/** Due review records across all books, most-overdue first (今日の復習). */
export async function dueReviews(now: number): Promise<ReviewRow[]> {
  const db = await getDb();
  return db.getAllAsync<ReviewRow>(
    `SELECT ${R_COLS} FROM reviews WHERE dueAt <= ? ORDER BY dueAt`,
    [now],
  );
}
