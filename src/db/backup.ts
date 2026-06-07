// Backup export / import in the SAME JSON shape as the web app (app:"anki-sheet",
// version 2, PDFs as base64 data URLs, color/rects inline). This makes backups
// interchangeable: a JSON exported from the web app imports here and vice versa.
import { Directory, File, Paths } from "expo-file-system";
import * as Legacy from "expo-file-system/legacy";
import { getDb, withWriteLock } from "./database";
import { deckPdfFile } from "./files";
import type { DeckColorConfig, Rect } from "../types";

const PDF_PREFIX = "data:application/pdf;base64,";

interface BackupDeck {
  id: number;
  name: string;
  createdAt: number;
  color: DeckColorConfig;
  lastPage: number | null;
  lastMode: string | null;
}
interface BackupPdf {
  id: number;
  deckId: number;
  name: string;
  pageCount: number;
  pageW: number;
  pageH: number;
  blobDataUrl: string;
}
interface BackupCard {
  id: number;
  deckId: number;
  pdfId: number;
  pageIndex: number;
  rects: Rect[];
  answerRect: Rect;
  text: string;
  createdAt: number;
}
interface BackupBookmark {
  id: number;
  deckId: number;
  pageIndex: number;
  title: string;
  createdAt: number;
}
interface BackupFile {
  app: "anki-sheet";
  version: number;
  exportedAt: number;
  decks: BackupDeck[];
  pdfs: BackupPdf[];
  cards: BackupCard[];
  bookmarks: BackupBookmark[];
  meta: { key: string; value: unknown }[];
}

function safeParse(s: string | null): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Serialize the whole DB (incl. PDFs as base64) to a JSON file; returns its file:// URI. */
export async function exportBackup(): Promise<string> {
  const db = await getDb();

  const decksRaw = await db.getAllAsync<{
    id: number;
    name: string;
    createdAt: number;
    color: string;
    lastPage: number | null;
    lastMode: string | null;
  }>("SELECT * FROM decks");
  const decks: BackupDeck[] = decksRaw.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    color: JSON.parse(d.color) as DeckColorConfig,
    lastPage: d.lastPage,
    lastMode: d.lastMode,
  }));

  const pdfsRaw = await db.getAllAsync<{
    id: number;
    deckId: number;
    name: string;
    filePath: string;
    pageCount: number;
    pageW: number;
    pageH: number;
  }>("SELECT * FROM pdfs");
  const pdfs: BackupPdf[] = [];
  for (const p of pdfsRaw) {
    const base64 = await new File(p.filePath).base64();
    pdfs.push({
      id: p.id,
      deckId: p.deckId,
      name: p.name,
      pageCount: p.pageCount,
      pageW: p.pageW,
      pageH: p.pageH,
      blobDataUrl: PDF_PREFIX + base64,
    });
  }

  const cardsRaw = await db.getAllAsync<{
    id: number;
    deckId: number;
    pdfId: number;
    pageIndex: number;
    rects: string;
    answerRect: string;
    text: string;
    createdAt: number;
  }>("SELECT * FROM cards");
  const cards: BackupCard[] = cardsRaw.map((c) => ({
    id: c.id,
    deckId: c.deckId,
    pdfId: c.pdfId,
    pageIndex: c.pageIndex,
    rects: JSON.parse(c.rects),
    answerRect: JSON.parse(c.answerRect),
    text: c.text,
    createdAt: c.createdAt,
  }));

  const bookmarks = await db.getAllAsync<BackupBookmark>("SELECT * FROM bookmarks");
  const metaRaw = await db.getAllAsync<{ key: string; value: string | null }>("SELECT * FROM meta");
  const meta = metaRaw.map((m) => ({ key: m.key, value: safeParse(m.value) }));

  const data: BackupFile = {
    app: "anki-sheet",
    version: 2,
    exportedAt: Date.now(),
    decks,
    pdfs,
    cards,
    bookmarks,
    meta,
  };

  const out = new File(Paths.document, "anki-sheet-backup.json");
  if (out.exists) out.delete();
  out.create();
  out.write(JSON.stringify(data));
  return out.uri;
}

/** Replace the entire DB (and PDF files) from a backup JSON file. */
export async function importBackup(fileUri: string): Promise<void> {
  const text = await new File(fileUri).text();
  const data = JSON.parse(text) as BackupFile;
  if (data.app !== "anki-sheet") throw new Error("Anki-sheetのバックアップではありません");
  if (data.version !== 2) {
    throw new Error("対応していないバックアップ形式です (version " + String(data.version) + ")");
  }

  // Decode PDFs into a STAGING dir first, so a decode/DB failure never touches the existing
  // library — the live decks/ dir is replaced only after the DB commit succeeds.
  const staging = new Directory(Paths.document, "decks.import");
  if (staging.exists) staging.delete();
  staging.create({ intermediates: true, idempotent: true });
  for (const p of data.pdfs) {
    const base64 = String(p.blobDataUrl).replace(/^data:[^,]+,/, "");
    await Legacy.writeAsStringAsync(
      new File(Paths.document, "decks.import", `${p.deckId}.pdf`).uri,
      base64,
      { encoding: Legacy.EncodingType.Base64 },
    );
  }

  await withWriteLock(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const t of ["cards", "bookmarks", "pdfs", "covers", "meta", "decks"]) {
      await db.runAsync(`DELETE FROM ${t}`);
    }
    for (const d of data.decks) {
      await db.runAsync(
        "INSERT INTO decks (id, name, createdAt, color, lastPage, lastMode) VALUES (?, ?, ?, ?, ?, ?)",
        [d.id, d.name, d.createdAt, JSON.stringify(d.color), d.lastPage ?? null, d.lastMode ?? null],
      );
    }
    for (const p of data.pdfs) {
      await db.runAsync(
        "INSERT INTO pdfs (id, deckId, name, filePath, pageCount, pageW, pageH) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [p.id, p.deckId, p.name, deckPdfFile(p.deckId).uri, p.pageCount, p.pageW, p.pageH],
      );
    }
    for (const c of data.cards) {
      await db.runAsync(
        "INSERT INTO cards (id, deckId, pdfId, pageIndex, rects, answerRect, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          c.id,
          c.deckId,
          c.pdfId,
          c.pageIndex,
          JSON.stringify(c.rects),
          JSON.stringify(c.answerRect),
          c.text,
          c.createdAt,
        ],
      );
    }
    for (const b of data.bookmarks ?? []) {
      await db.runAsync(
        "INSERT INTO bookmarks (id, deckId, pageIndex, title, createdAt) VALUES (?, ?, ?, ?, ?)",
        [b.id, b.deckId, b.pageIndex, b.title, b.createdAt],
      );
    }
    for (const m of data.meta ?? []) {
      await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
        m.key,
        m.value != null ? JSON.stringify(m.value) : null,
      ]);
    }
    });

    // DB committed — atomically replace the live PDF dir from staging.
    const decksDir = new Directory(Paths.document, "decks");
    if (decksDir.exists) decksDir.delete();
    decksDir.create({ intermediates: true, idempotent: true });
    for (const p of data.pdfs) {
      new File(Paths.document, "decks.import", `${p.deckId}.pdf`).moveSync(deckPdfFile(p.deckId));
    }
    if (staging.exists) staging.delete();
  });
}
