// Client for the sync backend (https://anki-sheet.pages.dev/api/sync/*), mirroring the web app.
// The Firebase ID token authenticates each call; the Worker maps it to the account uid. JSON
// endpoints use fetch here; the PDF blob (binary) is uploaded/downloaded via expo-file-system in
// sync/deck.ts (RN can't build a Blob from a file the way the web does).
import { getFirebaseAuth } from "../auth/firebase";
import type { ProgressBlob } from "./progressMerge";

export const SYNC_BASE = "https://anki-sheet.pages.dev/api/sync";

/** Current Firebase ID token, or null when signed out / auth not configured. */
export async function idToken(): Promise<string | null> {
  const user = getFirebaseAuth()?.currentUser;
  return user ? user.getIdToken() : null;
}

/** Translate a sync/cloud error into a clear, user-facing message (the raw text is jargon). */
export function syncErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === "not_signed_in") return "サインインが必要です。ログインしてからお試しください。";
  if (/\b404\b/.test(m))
    return "このPDFはクラウドに保存されていません（クラウド保存はProプランで取り込んだ本に作られます）。";
  if (/\b403\b/.test(m))
    return "この操作にはProプランが必要です（クラウドへの保存や、退避した本の復元など）。";
  if (/\b5\d\d\b/.test(m)) return "サーバーで一時的なエラーが発生しました。時間をおいて再試行してください。";
  if (/network|fetch|timeout/i.test(m))
    return "ネットワークに接続できません。通信環境を確認して再試行してください。";
  return `取得に失敗しました（${m}）。`;
}

export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
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
  if (res.status === 402) {
    // Account-wide cap reached (the slot was NOT reserved).
    const b = (await res.json().catch(() => ({}))) as { count?: number; limit?: number };
    return { ok: false, limitReached: true, count: b.count, limit: b.limit };
  }
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return { ok: true };
}

/** Non-destructive release from the cap: flip an ACTIVE cloud-backed (size>0) book to 'retained'
 * (R2 kept, slot freed, re-Pro restorable). Used by a non-sync (Standard/Free) local delete so it
 * actually frees a slot instead of leaving a stuck cloud-only active row. 404 is a harmless no-op. */
export async function retainBook(bookId: string): Promise<void> {
  const res = await authedFetch(`/books/${encodeURIComponent(bookId)}/retain`, { method: "POST" });
  if (!res.ok && res.status !== 404) throw new Error(`retain failed: ${res.status}`);
}

/** Resolve a downgrade trim: keep these book ids (server makes the kept set authoritative).
 * `skipped: true` = the server found the trim no longer required (e.g. the user re-upgraded while
 * the trim screen was open) and demoted NOTHING — the caller must skip its local reconcile too. */
export async function submitTrim(keep: string[]): Promise<{ skipped?: boolean }> {
  const res = await authedFetch("/trim", { method: "POST", body: JSON.stringify({ keep }) });
  if (!res.ok) throw new Error(`trim failed: ${res.status}`);
  return (await res.json()) as { skipped?: boolean };
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
  patch: { favorite?: boolean; openedAt?: number; device?: string | null },
): Promise<void> {
  const body: { favorite?: boolean; opened_at?: number; device?: string | null } = {};
  if (patch.favorite !== undefined) body.favorite = patch.favorite;
  if (patch.openedAt !== undefined) body.opened_at = patch.openedAt;
  if (patch.device !== undefined) body.device = patch.device; // null/"" clears the holder
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
  /** active | retained | trimmed | pending. Only `active` books count toward the cap + are usable. */
  status?: string;
  /** Pinned to the top of the bookshelf when 1 (synced across the account's devices). */
  favorite: number;
  /** Last-opened time (epoch ms) — drives 最近開いた順; server keeps the MAX across devices. */
  opened_at: number;
}

export type AccountTier = "free" | "standard" | "pro" | "premium" | "admin";

export interface AccountBooks {
  books: AccountBook[];
  /** Count of ACTIVE books (the cap-relevant, account-wide count). */
  count: number;
  limit: number;
  tier: AccountTier;
  unlimited: boolean;
  /** Set after a downgrade leaves the account over its cap — the client forces the trim screen. */
  trimRequired?: boolean;
  /** The kept-set target (book cap) after a downgrade. */
  cap?: number;
}

/** List the account's books (across all devices) with count + cap + tier. */
export async function listBooks(): Promise<AccountBooks> {
  const res = await authedFetch("/books");
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

/** Admin-only TEST helper: set the signed-in account's OWN server tier (and optionally backdate
 * downgraded_at to exercise the 6-month retention job). The backend rejects non-admins (verified
 * token), so this is safe even in production. Drives the real account-wide cap / trim / AI / sync. */
export async function setDevTier(
  tier: AccountTier,
  downgradedAt?: number | null,
): Promise<void> {
  const body: { tier: string; downgradedAt?: number | null } = { tier };
  if (downgradedAt !== undefined) body.downgradedAt = downgradedAt;
  const res = await authedFetch("/dev/tier", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`setDevTier failed: ${res.status}`);
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

// Progress sync. The wire shape IS the merge blob: position fields + ★/しおり element-sets
// (starsLww/bmLww) with per-key tombstones, merged per-key on the server (改修案 §4.2). Legacy
// starredKeys/bookmarks arrays are still accepted/folded for old clients.
export type ProgressData = ProgressBlob;

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
