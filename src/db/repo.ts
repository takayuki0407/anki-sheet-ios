// Data access — the SQLite port of the web app's Dexie repo. Same function surface so
// screens stay close to the original; JSON columns (color/rects/answerRect) are parsed
// here, and PDFs are moved to disk on import.
import type { SQLiteDatabase } from "expo-sqlite";
import { DEFAULT_MAGENTA_BAND, type DeckColorConfig, type DetectedCloze, type Rect } from "../types";
import type { BookmarkRow, CardRow, DeckRow, PdfRow, ReadMode } from "./rows";
import { getDb, withWriteLock } from "./database";
import { deckPdfFile, deleteDeckPdf, savePdfForDeck } from "./files";

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
        now,
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
    // Move the staged PDF into place AFTER commit, so a rolled-back import never consumes
    // it (leaving import.pdf intact for a retry).
    await savePdfForDeck(deckId, p.stagedPdfUri);
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
  return r ?? undefined;
}

export async function answerCount(deckId: number): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cards WHERE deckId = ?",
    [deckId],
  );
  return r?.n ?? 0;
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

/** Re-run detection for a deck under a new color config: replace all its answers. */
export async function redetectDeck(
  deckId: number,
  color: DeckColorConfig,
  clozes: DetectedCloze[],
): Promise<number> {
  return withWriteLock(async () => {
    const db = await getDb();
    const now = Date.now();
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
    return count;
  });
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
