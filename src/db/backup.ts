// Backup export / import in the SAME JSON shape as the web app (app:"anki-sheet",
// version 2, PDFs as base64 data URLs, color/rects inline). This makes backups
// interchangeable: a JSON exported from the web app imports here and vice versa.
import { Directory, File, Paths } from "expo-file-system";
import * as Legacy from "expo-file-system/legacy";
import { getDb, withWriteLock } from "./database";
import { deckPdfFile } from "./files";
import type { DeckColorConfig, Rect } from "../types";
import type { QuestionRow, ReviewRow } from "./rows";

// Account/device/cloud-sync binding meta is NOT portable user content — restoring it corrupts
// the device's relationship to the account:
//   - ownerUid → the cross-account wipe guard (account.ts) fires on the next cold start and
//     silently destroys the just-restored library.
//   - book:<deckId> / reg:<deckId> → a restored deck would inherit a stale cloud bookId + the
//     "registered" flag, so the bookshelf reconcile sees it as retained/trimmed (non-active) on
//     the server and re-deletes it — breaking the advertised "back up first, then restore" escape.
//     Dropping these makes a restored deck a fresh LOCAL-ONLY book (immune to reconcile).
//   - contentAt:/progressAt:/clozeTomb: → cloud-sync baselines that are meaningless once the deck
//     is unregistered. quotaCache/deviceNamePrev → transient sync state.
// Everything else (local prefs/caches: reveal:, autoToc:, fav:, opened:, genQtype, onboarded…) is
// portable and round-trips.
const NON_PORTABLE_META_KEYS = new Set(["ownerUid", "quotaCache", "deviceNamePrev"]);
const NON_PORTABLE_META_PREFIXES = ["book:", "reg:", "contentAt:", "progressAt:", "clozeTomb:"];
function isNonPortableMeta(key: string): boolean {
  return (
    NON_PORTABLE_META_KEYS.has(key) || NON_PORTABLE_META_PREFIXES.some((p) => key.startsWith(p))
  );
}

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
  // Optional (added 2026-06): AI-generated questions + SM-2 review state. Absent in web backups
  // and older iOS backups — importers must tolerate undefined.
  questions?: QuestionRow[];
  reviews?: ReviewRow[];
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
    // Resolve from the current container — the stored filePath may be stale after an app update.
    const base64 = await new File(deckPdfFile(p.deckId).uri).base64();
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
  const meta = metaRaw
    .filter((m) => !isNonPortableMeta(m.key))
    .map((m) => ({ key: m.key, value: safeParse(m.value) }));

  const questionsRaw = await db.getAllAsync<
    Omit<QuestionRow, "qtype" | "choices"> & { qtype: string; choices: string | null }
  >(
    "SELECT id, bookId, pageIndex, qtype, statement, answer, choices, explanation, source, createdAt FROM questions",
  );
  const questions: QuestionRow[] = questionsRaw.map((r) => {
    let choices: string[] | null = null;
    if (r.choices) {
      try {
        const p = JSON.parse(r.choices) as unknown;
        if (Array.isArray(p)) choices = p.filter((c): c is string => typeof c === "string");
      } catch {
        /* corrupt choices → treat as tf-style */
      }
    }
    return {
      id: r.id,
      bookId: r.bookId,
      pageIndex: r.pageIndex,
      qtype: r.qtype === "mc4" ? "mc4" : "tf",
      statement: r.statement,
      answer: r.answer,
      choices,
      explanation: r.explanation,
      source: r.source,
      createdAt: r.createdAt,
    };
  });
  const reviews = await db.getAllAsync<ReviewRow>(
    "SELECT questionId, bookId, ease, intervalD, reps, lapses, dueAt, lastAt, lastOk, updatedAt FROM reviews",
  );

  const data: BackupFile = {
    app: "anki-sheet",
    version: 2,
    exportedAt: Date.now(),
    decks,
    pdfs,
    cards,
    bookmarks,
    meta,
    questions,
    reviews,
  };

  const out = new File(Paths.document, "kiokumate-backup.json");
  if (out.exists) out.delete();
  out.create();
  out.write(JSON.stringify(data));
  return out.uri;
}

/** Replace the entire DB (and PDF files) from a backup JSON file. */
export async function importBackup(fileUri: string): Promise<void> {
  const text = await new File(fileUri).text();
  const data = JSON.parse(text) as BackupFile;
  // The on-disk marker stays "anki-sheet" for cross-version/web backup compat; only the message changes.
  if (data.app !== "anki-sheet") throw new Error("Kiokumate のバックアップではありません");
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
      for (const t of ["cards", "bookmarks", "pdfs", "covers", "meta", "decks", "questions", "reviews"]) {
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
      // Account/device-binding keys never restore (a backup's ownerUid would make the next cold
      // start treat this device as "switched accounts" and wipe the imported library).
      if (isNonPortableMeta(m.key)) continue;
      // Round-trip fix: setMeta stores RAW strings, but export ran safeParse on them. A plain
      // string must be written back as-is — JSON.stringify would add quotes and corrupt keys like
      // book:<deckId> / deviceName, breaking the deck↔account mapping after a restore.
      const value =
        m.value == null ? null : typeof m.value === "string" ? m.value : JSON.stringify(m.value);
      await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [m.key, value]);
    }
    for (const q of data.questions ?? []) {
      await db.runAsync(
        "INSERT OR REPLACE INTO questions (id, bookId, pageIndex, qtype, statement, answer, choices, explanation, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          q.id,
          q.bookId,
          q.pageIndex,
          q.qtype === "mc4" ? "mc4" : "tf",
          q.statement,
          q.answer,
          q.choices ? JSON.stringify(q.choices) : null,
          q.explanation ?? "",
          q.source ?? "",
          q.createdAt ?? Date.now(),
        ],
      );
    }
    for (const r of data.reviews ?? []) {
      await db.runAsync(
        "INSERT OR REPLACE INTO reviews (questionId, bookId, ease, intervalD, reps, lapses, dueAt, lastAt, lastOk, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [r.questionId, r.bookId, r.ease, r.intervalD, r.reps, r.lapses, r.dueAt, r.lastAt, r.lastOk, r.updatedAt],
      );
    }
    });

    // DB committed — atomically replace the live PDF dir from staging.
    const decksDir = new Directory(Paths.document, "decks");
    if (decksDir.exists) decksDir.delete();
    decksDir.create({ intermediates: true, idempotent: true });
    for (const p of data.pdfs) {
      await new File(Paths.document, "decks.import", `${p.deckId}.pdf`).move(deckPdfFile(p.deckId));
    }
    if (staging.exists) staging.delete();
  });
}

/** Erase ALL local data (decks / PDFs / covers / bookmarks / sync meta) — used on logout / account
 * deletion so the bookshelf is empty for the next account. Pro books re-download from the cloud. */
export async function clearAllLocalData(): Promise<void> {
  await withWriteLock(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      // questions/reviews included: leaving them would leak the previous account's AI questions
      // and SM-2 history into the next account (and sync/reviews would even push them to its cloud).
      for (const t of ["cards", "bookmarks", "pdfs", "covers", "meta", "decks", "questions", "reviews"]) {
        await db.runAsync(`DELETE FROM ${t}`);
      }
    });
  });
  const decksDir = new Directory(Paths.document, "decks");
  if (decksDir.exists) decksDir.delete();
}
