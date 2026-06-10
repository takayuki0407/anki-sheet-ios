// Answer recording + Premium review-state sync (機能拡張 §D/§E). Mirrors the web app's
// src/sync/reviews.ts (only the repo/type imports differ — the SM-2 + LWW core is the byte-shared
// sync/srs.ts).
//
// EVERY answer (all plans) runs through recordAnswer(): SM-2 step → local row — that local history
// drives 間違いのみ復習 and the due counts. Premium additionally syncs the records to
// /api/sync/reviews (per-key LWW): pushes are debounced+batched; the server answers 403
// premium_required for everyone else, which we treat as "local-only mode" (fail-open).
import { authedFetch } from "./api";
import { answerReview, mergeReview } from "./srs";
import { allReviews, getBookReviews, putReview } from "../db/repo";
import type { QuestionRow, ReviewRow } from "../db/rows";

interface ServerReview {
  question_id: string;
  ease: number;
  interval_d: number;
  reps: number;
  lapses: number;
  due_at: number;
  last_at: number;
  last_ok: 0 | 1;
  updated_at: number;
}

const toServer = (r: ReviewRow): ServerReview => ({
  question_id: r.questionId,
  ease: r.ease,
  interval_d: r.intervalD,
  reps: r.reps,
  lapses: r.lapses,
  due_at: r.dueAt,
  last_at: r.lastAt,
  last_ok: r.lastOk,
  updated_at: r.updatedAt,
});

// ---- debounced push queue ----------------------------------------------------------------------

const dirty = new Map<string, ReviewRow>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushNow(): Promise<void> {
  if (!dirty.size) return;
  const batch = [...dirty.values()];
  dirty.clear();
  try {
    await authedFetch("/reviews", {
      method: "POST",
      body: JSON.stringify({ reviews: batch.map(toServer) }),
    });
  } catch {
    /* offline / signed-out / non-premium → records stay local; next session retries via pull-push */
  }
}

/** Queue one record for a debounced batch push (no-op net effect for non-premium: server 403s). */
function queuePush(row: ReviewRow): void {
  dirty.set(row.questionId, row);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushNow(), 2000);
}

/** Flush pending pushes immediately (call on session end / screen exit). */
export function flushReviewPushes(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void flushNow();
}

// ---- recording ----------------------------------------------------------------------------------

/** Record one answer: SM-2 step → local row → queue a sync push. Returns the new state. */
export async function recordAnswer(q: QuestionRow, ok: boolean): Promise<ReviewRow> {
  const prev = (await getBookReviews(q.bookId)).get(q.id);
  const next = answerReview(prev, ok, Date.now());
  const row: ReviewRow = { questionId: q.id, bookId: q.bookId, ...next };
  await putReview(row);
  queuePush(row);
  return row;
}

// ---- pull/merge ----------------------------------------------------------------------------------

/** Pull the account's review records and LWW-merge them into local rows; push back any local rows
 * that are newer than the cloud's. Premium-only on the server (403 → silently local-only). The
 * server rows carry no bookId, so only records whose question exists locally are applied. */
export async function syncReviews(bookIdOf: Map<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await authedFetch("/reviews");
  } catch {
    return;
  }
  if (!res.ok) return; // 403 premium_required / transient — local-only
  const data = (await res.json().catch(() => ({ reviews: [] }))) as { reviews: ServerReview[] };
  const cloudByIdRaw = new Map((data.reviews ?? []).map((r) => [r.question_id, r]));
  const local = await allReviews();
  const localById = new Map(local.map((r) => [r.questionId, r]));

  // Cloud → local (newer cloud rows, for questions we know about).
  for (const [qid, c] of cloudByIdRaw) {
    const bookId = bookIdOf.get(qid) ?? localById.get(qid)?.bookId;
    if (!bookId) continue;
    const incoming: ReviewRow = {
      questionId: qid,
      bookId,
      ease: c.ease,
      intervalD: c.interval_d,
      reps: c.reps,
      lapses: c.lapses,
      dueAt: c.due_at,
      lastAt: c.last_at,
      lastOk: c.last_ok,
      updatedAt: c.updated_at,
    };
    const cur = localById.get(qid);
    if (mergeReview(cur, incoming) === incoming) await putReview(incoming);
  }

  // Local → cloud (rows the cloud is missing or has older).
  const toPush = local.filter((r) => {
    const c = cloudByIdRaw.get(r.questionId);
    return !c || r.updatedAt > c.updated_at;
  });
  if (toPush.length) {
    try {
      await authedFetch("/reviews", {
        method: "POST",
        body: JSON.stringify({ reviews: toPush.map(toServer) }),
      });
    } catch {
      /* best-effort */
    }
  }
}
