// LWW-element-set merge for detected masks (clozes), so concurrent mask edits on two devices don't
// clobber each other (改修案 P0-2). Before this, clozes rode in the content JSON and were merged
// whole-blob by `contentAt` (last-write-wins on the WHOLE set), so editing masks on two devices lost
// one device's edits entirely.
//
// THE FIX mirrors progressMerge: a cloze is identified by its POSITION (page + quantized bbox top-
// left — the same formula as sync/cardKeys.cardKey) and carries { t, d } for per-KEY last-write-wins.
// Adds union; a delete is a tombstone that propagates. The whole-blob fields (name / color / page
// geometry) keep LWW by `contentAt`.
//
// The map is the SYNC source of truth (maintained in parallel with the local cards table, exactly
// like starsLww parallels the ★ id-set); the cards table is its materialization.
//
// Pure + self-contained (no repo-specific imports) so the backend / web / iOS copies stay byte-
// identical (verified by check-shared.mjs).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Cloze {
  pageIndex: number;
  rects: Rect[];
  bbox: Rect;
  text?: string;
}
export interface ClozeEntry extends Cloze {
  t: number;
  d?: 1;
}
export type ClozeMap = Record<string, ClozeEntry>;

export interface ContentBlob {
  name?: string;
  color?: unknown;
  pageCount?: number;
  pageW?: number;
  pageH?: number;
  /** Clock for the whole-blob fields (name/color/geometry). Larger wins on merge. */
  contentAt?: number;
  clozesLww?: ClozeMap;
  /** Legacy whole-set (pre-P0-2 / old clients) + the GET compat mirror; folded by normalizeContent. */
  clozes?: Cloze[];
  /** Download seed only — the live bookmark source is the progress blob's bmLww. */
  bookmarks?: { title: string; pageIndex: number }[];
}

/** Cloze identity = page + quantized bbox position AND size. MUST match sync/cardKeys.cardKey so a ★
 * and the answer it sits on share an anchor. Including w/h avoids key collisions between two answers
 * whose top-left rounds to the same px on a dense page (which would drop a mask on merge). */
export function clozeKey(pageIndex: number, bbox: Rect): string {
  return `${pageIndex}:${Math.round(bbox.y)}:${Math.round(bbox.x)}:${Math.round(bbox.w)}:${Math.round(bbox.h)}`;
}

/** Live (non-tombstoned) clozes. */
export function activeClozes(b: ContentBlob): ClozeEntry[] {
  const m = b.clozesLww ?? {};
  return Object.values(m).filter((e) => !e.d);
}

/** The tombstone set (deleted cloze key -> delete time) of a map — what the client persists locally. */
export function tombstonesOf(map: ClozeMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, e] of Object.entries(map)) if (e.d) out[k] = e.t;
  return out;
}

/** Build the element-set from the LIVE cards (each carries its own t = card.createdAt) plus the
 * persisted tombstones. This is how a client derives what to upload. */
export function clozeMapFromCards(
  cards: readonly { pageIndex: number; rects: Rect[]; bbox: Rect; text?: string; t: number }[],
  tomb: Record<string, number>,
): ClozeMap {
  const map: ClozeMap = {};
  for (const c of cards) {
    const k = clozeKey(c.pageIndex, c.bbox);
    if (!map[k] || map[k].t < c.t)
      map[k] = { t: c.t, pageIndex: c.pageIndex, rects: c.rects, bbox: c.bbox, text: c.text };
  }
  for (const [k, t] of Object.entries(tomb)) {
    const prev = map[k];
    if (!prev || prev.t < t)
      map[k] = prev
        ? { ...prev, t, d: 1 }
        : { t, d: 1, pageIndex: 0, rects: [], bbox: { x: 0, y: 0, w: 0, h: 0 } };
  }
  return map;
}

/** Fold a legacy clozes[] array into the map when no map exists yet (old client / GET mirror is
 * ignored once a map is present, so it can't resurrect a tombstone). */
export function normalizeContent(b: ContentBlob, baseline: number): ContentBlob {
  // Re-key every entry to the CANONICAL clozeKey from its bbox. This makes the merge independent of
  // the stored key format, so a key-scheme change (e.g. adding w/h) or an old client can't leave two
  // entries for the SAME answer (which would duplicate the mask). Payload-less tombstones (bbox
  // 0,0,0,0, from a clozeTomb with no live card) keep their stored key.
  const map: ClozeMap = {};
  for (const [k, e] of Object.entries(b.clozesLww ?? {})) {
    const ck = e.bbox && (e.bbox.w > 0 || e.bbox.h > 0) ? clozeKey(e.pageIndex, e.bbox) : k;
    if (!map[ck] || map[ck].t < e.t) map[ck] = e;
  }
  if (Object.keys(map).length === 0)
    for (const c of b.clozes ?? []) {
      const k = clozeKey(c.pageIndex, c.bbox);
      if (!map[k] || map[k].t < baseline)
        map[k] = { t: baseline, pageIndex: c.pageIndex, rects: c.rects, bbox: c.bbox, text: c.text };
    }
  return { ...b, clozesLww: map, clozes: undefined };
}

function pick(x: ClozeEntry | undefined, y: ClozeEntry | undefined): ClozeEntry {
  if (!x) return y as ClozeEntry;
  if (!y) return x;
  return y.t > x.t ? y : x;
}

/** Merge two NORMALIZED content blobs: clozes per-key LWW; whole-blob fields by contentAt. */
export function mergeContent(a: ContentBlob, b: ContentBlob): ContentBlob {
  const map: ClozeMap = { ...(a.clozesLww ?? {}) };
  for (const [k, e] of Object.entries(b.clozesLww ?? {})) map[k] = pick(map[k], e);
  const meta = (b.contentAt ?? 0) > (a.contentAt ?? 0) ? b : a;
  return {
    name: meta.name,
    color: meta.color,
    pageCount: meta.pageCount,
    pageW: meta.pageW,
    pageH: meta.pageH,
    contentAt: meta.contentAt ?? 0,
    bookmarks: meta.bookmarks,
    clozesLww: map,
  };
}

/** Add/refresh a cloze in the map at `now`. Mutates+returns. */
export function addCloze(map: ClozeMap, c: Cloze, now: number): ClozeMap {
  map[clozeKey(c.pageIndex, c.bbox)] = {
    t: now,
    pageIndex: c.pageIndex,
    rects: c.rects,
    bbox: c.bbox,
    text: c.text,
  };
  return map;
}

/** Tombstone a cloze in the map at `now`. Mutates+returns. */
export function removeCloze(map: ClozeMap, pageIndex: number, bbox: Rect, now: number): ClozeMap {
  const k = clozeKey(pageIndex, bbox);
  const prev = map[k];
  map[k] = prev
    ? { ...prev, t: now, d: 1 }
    : { t: now, d: 1, pageIndex, rects: [], bbox };
  return map;
}

/** Reconcile the map toward a desired live set (re-detect): detected clozes become/refresh live at
 * `now`; live clozes NOT in the detected set are tombstoned. Mutates+returns. */
export function setActiveClozes(map: ClozeMap, clozes: readonly Cloze[], now: number): ClozeMap {
  const next = new Set(clozes.map((c) => clozeKey(c.pageIndex, c.bbox)));
  for (const c of clozes) addCloze(map, c, now);
  for (const e of activeClozes({ clozesLww: map }))
    if (!next.has(clozeKey(e.pageIndex, e.bbox))) removeCloze(map, e.pageIndex, e.bbox, now);
  return map;
}
