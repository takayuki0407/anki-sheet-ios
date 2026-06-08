// Client for the sync backend (https://anki-sheet.pages.dev/api/sync/*), mirroring the web app.
// The Firebase ID token authenticates each call; the Worker maps it to the account uid. JSON
// endpoints use fetch here; the PDF blob (binary) is uploaded/downloaded via expo-file-system in
// sync/deck.ts (RN can't build a Blob from a file the way the web does).
import { getFirebaseAuth } from "../auth/firebase";

export const SYNC_BASE = "https://anki-sheet.pages.dev/api/sync";

/** Current Firebase ID token, or null when signed out / auth not configured. */
export async function idToken(): Promise<string | null> {
  const user = getFirebaseAuth()?.currentUser;
  return user ? user.getIdToken() : null;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await idToken();
  if (!token) throw new Error("not_signed_in");
  return fetch(`${SYNC_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export interface RegisterResult {
  ok: boolean;
  limitReached?: boolean;
  count?: number;
  limit?: number;
}

/** Reserve an account-global slot for a book. ok:false + limitReached when the cap is hit. */
export async function registerBook(
  bookId: string,
  name: string,
  pageCount: number,
  device: string,
): Promise<RegisterResult> {
  const res = await authedFetch("/books", {
    method: "POST",
    body: JSON.stringify({ book_id: bookId, name, page_count: pageCount, device }),
  });
  if (res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as { count?: number; limit?: number };
    return { ok: false, limitReached: true, count: b.count, limit: b.limit };
  }
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return { ok: true };
}

/** Free an account-global slot (idempotent; 404 is fine). */
export async function unregisterBook(bookId: string): Promise<void> {
  const res = await authedFetch(`/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`unregister failed: ${res.status}`);
}

/** Sync per-book bookshelf state (favorite / last-opened) for the account. Best-effort: callers
 * ignore errors, and a missing/standard book is a harmless no-op on the server. */
export async function updateBookMeta(
  bookId: string,
  patch: { favorite?: boolean; openedAt?: number },
): Promise<void> {
  const body: { favorite?: boolean; opened_at?: number } = {};
  if (patch.favorite !== undefined) body.favorite = patch.favorite;
  if (patch.openedAt !== undefined) body.opened_at = patch.openedAt;
  const res = await authedFetch(`/books/${encodeURIComponent(bookId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404 && res.status !== 403)
    throw new Error(`updateBookMeta failed: ${res.status}`);
}

export interface AccountBook {
  book_id: string;
  name: string;
  size: number;
  page_count: number;
  device: string | null;
  updated_at: number;
  /** Pinned to the top of the bookshelf when 1 (synced across the account's devices). */
  favorite: number;
  /** Last-opened time (epoch ms) — drives 最近開いた順; server keeps the MAX across devices. */
  opened_at: number;
}

export interface AccountBooks {
  books: AccountBook[];
  count: number;
  limit: number;
  tier: "standard" | "pro" | "admin";
  unlimited: boolean;
}

/** List the account's books (across all devices) with count + cap + tier. */
export async function listBooks(): Promise<AccountBooks> {
  const res = await authedFetch("/books");
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

/** Erase ALL of the account's cloud data (R2 PDFs/content + D1 books/progress/tier). Call this
 * before deleting the auth user so account deletion also removes everything stored in the cloud. */
export async function deleteAccountData(): Promise<void> {
  const res = await authedFetch("/account", { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`);
}

/** Upload deck content JSON (name/color/geometry/clozes/bookmarks). 403 (standard) is a no-op. */
export async function putContent(bookId: string, json: string): Promise<void> {
  const res = await authedFetch(`/books/${encodeURIComponent(bookId)}/content`, {
    method: "PUT",
    body: json,
  });
  if (res.status === 403) return;
  if (!res.ok) throw new Error(`putContent failed: ${res.status}`);
}

export async function getContent(bookId: string): Promise<unknown> {
  const res = await authedFetch(`/books/${encodeURIComponent(bookId)}/content`);
  if (!res.ok) throw new Error(`getContent failed: ${res.status}`);
  return res.json();
}

// Progress sync (device-independent fields + revealed as portable keys; same shape as web).
export interface ProgressData {
  lastPage?: number;
  lastMode?: "scroll" | "paged";
  redMode?: "mask" | "sheet" | "off";
  sheetBand?: { top: number; height: number };
  revealedKeys?: string[];
  /** Starred answers as portable keys (★ review) — synced cross-device like revealedKeys. */
  starredKeys?: string[];
}

export async function getProgress(
  bookId: string,
): Promise<{ data: ProgressData; updatedAt: number } | null> {
  const res = await authedFetch(`/progress/${encodeURIComponent(bookId)}`);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`getProgress failed: ${res.status}`);
  const row = (await res.json()) as { data: string; updated_at: number };
  try {
    return { data: JSON.parse(row.data) as ProgressData, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export async function putProgress(bookId: string, data: ProgressData): Promise<void> {
  const res = await authedFetch(`/progress/${encodeURIComponent(bookId)}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
  if (res.status === 403) return;
  if (!res.ok) throw new Error(`putProgress failed: ${res.status}`);
}
