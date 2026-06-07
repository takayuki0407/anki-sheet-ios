// PDF file storage. PDFs are too large for SQLite and the viewer needs a file:// URL,
// so each deck's PDF lives at documents/decks/<deckId>.pdf. Covers are small and stored
// as data URLs in the DB instead (see repo.ts), so no cover files here.
import { Directory, File, Paths } from "expo-file-system";

const DECKS = "decks";

function ensureDir(name: string): Directory {
  const d = new Directory(Paths.document, name);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function deckPdfFile(deckId: number): File {
  return new File(Paths.document, DECKS, `${deckId}.pdf`);
}

/**
 * Move a staged import (documents/import.pdf) into the deck's permanent path and return
 * its file:// URL. The viewer loads this URL; it stays inside the document directory so a
 * single allowingReadAccessToURL grant covers it.
 */
export function savePdfForDeck(deckId: number, stagedUri: string): string {
  ensureDir(DECKS);
  const dest = deckPdfFile(deckId);
  if (dest.exists) dest.delete();
  // Sync move: File.move() is async in SDK 56, and callers consume the URI immediately.
  new File(stagedUri).moveSync(dest);
  return dest.uri;
}

export function deleteDeckPdf(deckId: number): void {
  const f = deckPdfFile(deckId);
  if (f.exists) f.delete();
}
