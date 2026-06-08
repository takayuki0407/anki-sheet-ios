// SQLite handle + schema. Replaces the web app's Dexie/IndexedDB with native, durable
// storage (not subject to iOS's Safari/IndexedDB eviction). PDFs live as files on disk;
// the DB keeps their paths plus decks, detected answers (cards), bookmarks, covers, meta.
import * as SQLite from "expo-sqlite";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

// Serialize multi-statement writes (import / redetect / delete / restore) so a concurrent
// read or write can't interleave inside withTransactionAsync's non-exclusive BEGIN/COMMIT
// window (which could roll back or read uncommitted rows on this shared handle).
let writeChain: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function init(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync("ankiSheet.db");
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS decks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL,
      createdAt INTEGER NOT NULL,
      color     TEXT    NOT NULL,
      lastPage  INTEGER,
      lastMode  TEXT
    );

    CREATE TABLE IF NOT EXISTS pdfs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      deckId    INTEGER NOT NULL,
      name      TEXT    NOT NULL,
      filePath  TEXT    NOT NULL,
      pageCount INTEGER NOT NULL,
      pageW     REAL    NOT NULL,
      pageH     REAL    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      deckId     INTEGER NOT NULL,
      pdfId      INTEGER NOT NULL,
      pageIndex  INTEGER NOT NULL,
      rects      TEXT    NOT NULL,
      answerRect TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      createdAt  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cards_deck_page ON cards (deckId, pageIndex);

    CREATE TABLE IF NOT EXISTS bookmarks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      deckId    INTEGER NOT NULL,
      pageIndex INTEGER NOT NULL,
      title     TEXT    NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_deck_page ON bookmarks (deckId, pageIndex);

    CREATE TABLE IF NOT EXISTS covers (
      deckId  INTEGER PRIMARY KEY,
      dataUrl TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS questions (
      id          TEXT    PRIMARY KEY,
      bookId      TEXT    NOT NULL,
      pageIndex   INTEGER NOT NULL,
      statement   TEXT    NOT NULL,
      answer      TEXT    NOT NULL,
      explanation TEXT,
      source      TEXT,
      createdAt   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_questions_book_page ON questions (bookId, pageIndex);
  `);
  return db;
}
