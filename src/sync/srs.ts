// SM-2 spaced repetition driven by a correctness-only signal (no self-grading), plus the per-key
// LWW merge for review records (機能拡張 §A-2/§D-3).
//
// A "review" is one (question → SM-2 state) record. Answering maps correctness to SM-2 quality:
// correct → q=4, wrong → q=1. Wrong resets the interval to 1 day (a lapse); correct grows it
// 1日 → 6日 → round(interval × ease). Ease only ever decays here (q=4 leaves it unchanged,
// q=1 subtracts 0.54) and is floored at 1.3 — the classic SM-2 update with q ∈ {1, 4}.
//
// Sync is per-key (questionId) last-write-wins on `updatedAt`, same shape as progressMerge's
// element-sets: commutative + idempotent, so server SQL upserts and client merges converge.
//
// Pure module, no platform deps — copied verbatim into src/sync (web) and the iOS app
// (no shared package yet — §5.1). Keep the copies in sync (`npm run check:shared`).

export const DAY_MS = 86_400_000;

/** One question's SM-2 state. Field names mirror the server `reviews` table (camelCased). */
export interface ReviewState {
  ease: number; // SM-2 easiness factor, ≥ 1.3
  intervalD: number; // current interval in days (0 = never answered correctly yet)
  reps: number; // consecutive-correct count (reset on a wrong answer)
  lapses: number; // total wrong answers
  dueAt: number; // next due (epoch ms)
  lastAt: number; // last answered (epoch ms)
  lastOk: 0 | 1; // last answer correctness (drives 間違いのみ復習)
  updatedAt: number; // LWW clock (ms)
}

export type ReviewMap = Record<string, ReviewState>;

/**
 * Apply one answer to a question's SM-2 state. `prev` is undefined for the first answer.
 * Correct → q=4, wrong → q=1 (§D-3):
 *   wrong:   reps=0, lapses+1, interval=1日
 *   correct: reps==0 → 1日, reps==1 → 6日, else round(interval × ease); reps+1
 *   ease' = max(1.3, ease + (0.1 − (5−q) × (0.08 + (5−q) × 0.02)))
 */
export function answerReview(prev: ReviewState | undefined, ok: boolean, now: number): ReviewState {
  const ease0 = prev?.ease ?? 2.5;
  const q = ok ? 4 : 1;
  const ease = Math.max(1.3, ease0 + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  let reps = prev?.reps ?? 0;
  let lapses = prev?.lapses ?? 0;
  let intervalD: number;
  if (!ok) {
    intervalD = 1;
    lapses += 1;
    reps = 0;
  } else {
    intervalD = reps === 0 ? 1 : reps === 1 ? 6 : Math.round((prev?.intervalD ?? 1) * ease);
    reps += 1;
  }
  return {
    ease,
    intervalD,
    reps,
    lapses,
    dueAt: now + intervalD * DAY_MS,
    lastAt: now,
    lastOk: ok ? 1 : 0,
    updatedAt: now,
  };
}

/** LWW pick: the record with the larger updatedAt wins (ties keep the first argument). */
export function mergeReview(a: ReviewState | undefined, b: ReviewState | undefined): ReviewState {
  if (!a) return b as ReviewState;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** Merge two review maps per-key. Commutative + idempotent. */
export function mergeReviewMaps(a: ReviewMap, b: ReviewMap): ReviewMap {
  const out: ReviewMap = { ...a };
  for (const [k, r] of Object.entries(b)) out[k] = mergeReview(out[k], r);
  return out;
}

/** Whether a question is due for SM-2 review. */
export function isDue(r: ReviewState, now: number): boolean {
  return r.dueAt <= now;
}

/** Due question ids, most-overdue first (the SM-2 presentation order). */
export function dueQuestionIds(map: ReviewMap, now: number): string[] {
  return Object.entries(map)
    .filter(([, r]) => isDue(r, now))
    .sort(([, x], [, y]) => x.dueAt - y.dueAt)
    .map(([id]) => id);
}

/** Question ids whose LAST answer was wrong (間違いのみ復習 — all plans, local data). */
export function wrongQuestionIds(map: ReviewMap): string[] {
  return Object.entries(map)
    .filter(([, r]) => r.lastOk === 0)
    .map(([id]) => id);
}
