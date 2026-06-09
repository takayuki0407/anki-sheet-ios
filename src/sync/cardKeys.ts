// Device-portable answer identity + re-detect carry-over (改修案 §4.4).
//
// ★ and revealed answers anchor to a detected answer by its POSITION on the page, not by the old
// "ordinal" (its sorted index on the page). Position is STABLE when OTHER answers on the page are
// added or removed, and is identical across devices because the detected answerRect is synced exactly
// (the content JSON carries the bbox). Crucially, a STALE position key — left over after a re-detect
// moved/removed an answer — maps to NO current card, so it is inert; a stale ordinal instead silently
// pointed at a DIFFERENT answer (and a stale tombstone could delete the wrong star).
//
// On re-detect the cards are replaced (new ids), so the LOCAL id sets (★/revealed) are carried over
// to the new cards by geometric overlap (correspondCards); unmatched answers are dropped.
//
// Pure + self-contained (no repo-specific imports) so the Web and iOS copies stay byte-identical
// (verified by check-shared.mjs).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface CardLike {
  id?: number;
  pageIndex: number;
  answerRect: Rect;
}

/** Portable answer key = page + quantized answer position (round absorbs sub-point detection jitter). */
export function cardKey(pageIndex: number, r: Rect): string {
  return `${pageIndex}:${Math.round(r.y)}:${Math.round(r.x)}`;
}

/** id <-> portable-key maps for a set of cards (cards without an id are skipped). */
export function cardKeyMaps(cards: readonly CardLike[]): {
  idToKey: Map<number, string>;
  keyToId: Map<string, number>;
} {
  const idToKey = new Map<number, string>();
  const keyToId = new Map<string, number>();
  for (const c of cards) {
    if (c.id == null) continue;
    const k = cardKey(c.pageIndex, c.answerRect);
    idToKey.set(c.id, k);
    keyToId.set(k, c.id);
  }
  return { idToKey, keyToId };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Map each old card to the best-overlapping new card on the same page (greedy by overlap area),
 * for carrying ★/revealed across a re-detect. Unmatched old cards are absent from the result. */
export function correspondCards(
  oldCards: readonly CardLike[],
  newCards: readonly CardLike[],
): Map<number, number> {
  const newByPage = new Map<number, CardLike[]>();
  for (const n of newCards) {
    if (n.id == null) continue;
    const arr = newByPage.get(n.pageIndex);
    if (arr) arr.push(n);
    else newByPage.set(n.pageIndex, [n]);
  }
  const pairs: { o: number; n: number; s: number }[] = [];
  for (const o of oldCards) {
    if (o.id == null) continue;
    for (const n of newByPage.get(o.pageIndex) ?? []) {
      const s = overlapArea(o.answerRect, n.answerRect);
      if (s > 0) pairs.push({ o: o.id, n: n.id as number, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  const out = new Map<number, number>();
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  for (const p of pairs) {
    if (usedOld.has(p.o) || usedNew.has(p.n)) continue;
    out.set(p.o, p.n);
    usedOld.add(p.o);
    usedNew.add(p.n);
  }
  return out;
}
