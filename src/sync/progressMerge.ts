// LWW-element-set merge for cross-device ★ (stars) and しおり (bookmarks). (改修案 §4.2)
//
// THE BUG THIS FIXES: ★ and bookmarks used to ride in the progress blob as plain arrays merged
// whole-blob by updated_at (last-write-wins on the ENTIRE set). A union can't express a deletion,
// and a stale whole-set push silently clobbers another device's adds. So a star added on phone A
// could be wiped when tablet B (which never saw it) pushed its own set.
//
// THE FIX: model ★ and しおり as a map  key -> { t, d }  where `t` is the op time (ms) and `d:1`
// is a tombstone (deleted). Merge is per-KEY last-write-wins (= LWW-element-set): union the keys,
// for each key keep the entry with the larger `t`. This is commutative + idempotent, so the SERVER
// (PUT /progress) and every CLIENT can merge in any order and converge — adds and deletes both
// propagate, and an offline edit is never lost.
//
// Position fields (lastPage/mode/redMode/band/revealed) keep whole-blob LWW, but gated by `posAt`
// so a star-only push from a device sitting on an OLD page can't drag everyone back (latent bug too).
//
// Pure module, no platform deps — copied verbatim into functions/_lib (backend), src/sync (web),
// and the iOS app (no shared package yet — §5.1). Keep the three copies in sync.

/** One element's state: op timestamp (ms) + optional tombstone flag. Presence w/o `d` = live. */
export interface LwwEntry {
  t: number;
  d?: 1;
}
/** ★ set: portable card key -> entry. */
export type StarMap = Record<string, LwwEntry>;
/** しおり: bmKey -> entry carrying the bookmark payload (so a tombstone still knows what it was). */
export interface BmEntry extends LwwEntry {
  title: string;
  pageIndex: number;
}
export type BmMap = Record<string, BmEntry>;

export interface ProgressBlob {
  // ---- position group: whole-blob LWW by posAt ----
  lastPage?: number;
  lastMode?: "scroll" | "paged";
  redMode?: "mask" | "sheet" | "off";
  sheetBand?: { top: number; height: number };
  revealedKeys?: string[];
  /** Clock for the position group (ms). Larger wins on merge. */
  posAt?: number;
  // ---- element-sets (per-key LWW) ----
  starsLww?: StarMap;
  bmLww?: BmMap;
  // ---- legacy fields (old clients / pre-§4.2 cloud rows); folded in by normalize() ----
  starredKeys?: string[];
  bookmarks?: { title: string; pageIndex: number }[];
}

/** Stable portable identity for a bookmark. pageIndex is digits-only so the first space delimits
 * it unambiguously from the title — collision-free even if the title itself contains spaces. */
export const bmKey = (title: string, pageIndex: number): string =>
  `${pageIndex} ${title}`;

/** Live (non-tombstoned) star keys. */
export function activeStarKeys(b: ProgressBlob): string[] {
  const m = b.starsLww ?? {};
  return Object.keys(m).filter((k) => !m[k].d);
}

/** Live bookmarks, page-ordered (stable display order across devices). */
export function activeBookmarks(b: ProgressBlob): { title: string; pageIndex: number }[] {
  const m = b.bmLww ?? {};
  return Object.values(m)
    .filter((e) => !e.d)
    .sort((a, z) => a.pageIndex - z.pageIndex || a.title.localeCompare(z.title))
    .map((e) => ({ title: e.title, pageIndex: e.pageIndex }));
}

/**
 * Fold legacy array fields into the maps and return a blob in canonical (maps-only) form.
 * `baseline` is the effective timestamp for legacy data (use the cloud row's updated_at, or 1 for
 * a brand-new local blob). A newer map entry (incl. a tombstone) beats the legacy array entry.
 */
export function normalize(b: ProgressBlob, baseline: number): ProgressBlob {
  // Legacy arrays are folded ONLY when no map exists yet (true pre-§4.2 data). When a map is already
  // present, the arrays are just a derived mirror (e.g. the GET compat shim below) — folding them at
  // `baseline` would resurrect tombstoned entries, so we ignore them.
  const stars: StarMap = { ...(b.starsLww ?? {}) };
  if (Object.keys(stars).length === 0)
    for (const k of b.starredKeys ?? []) {
      if (!stars[k] || stars[k].t < baseline) stars[k] = { t: baseline };
    }
  const bms: BmMap = { ...(b.bmLww ?? {}) };
  if (Object.keys(bms).length === 0)
    for (const bm of b.bookmarks ?? []) {
      const k = bmKey(bm.title, bm.pageIndex);
      if (!bms[k] || bms[k].t < baseline)
        bms[k] = { t: baseline, title: bm.title, pageIndex: bm.pageIndex };
    }
  return {
    lastPage: b.lastPage,
    lastMode: b.lastMode,
    redMode: b.redMode,
    sheetBand: b.sheetBand,
    revealedKeys: b.revealedKeys,
    posAt: b.posAt ?? 0,
    starsLww: stars,
    bmLww: bms,
  };
}

function pick<T extends LwwEntry>(x: T | undefined, y: T | undefined): T {
  if (!x) return y as T;
  if (!y) return x;
  return y.t > x.t ? y : x;
}

/** Merge two NORMALIZED blobs (call normalize first). Commutative + idempotent. */
export function mergeBlobs(a: ProgressBlob, b: ProgressBlob): ProgressBlob {
  const stars: StarMap = { ...(a.starsLww ?? {}) };
  for (const [k, e] of Object.entries(b.starsLww ?? {})) stars[k] = pick(stars[k], e);
  const bms: BmMap = { ...(a.bmLww ?? {}) };
  for (const [k, e] of Object.entries(b.bmLww ?? {})) bms[k] = pick(bms[k], e);
  // Position group: the blob with the larger posAt wins as a unit.
  const pos = (b.posAt ?? 0) > (a.posAt ?? 0) ? b : a;
  return {
    lastPage: pos.lastPage,
    lastMode: pos.lastMode,
    redMode: pos.redMode,
    sheetBand: pos.sheetBand,
    revealedKeys: pos.revealedKeys,
    posAt: pos.posAt ?? 0,
    starsLww: stars,
    bmLww: bms,
  };
}

/** Reconcile the star map toward a desired live set, stamping adds/removes at `now`. Mutates+returns. */
export function setActiveStars(map: StarMap, nextKeys: string[], now: number): StarMap {
  const next = new Set(nextKeys);
  const prevActive = new Set(activeStarKeys({ starsLww: map }));
  for (const k of next) if (!prevActive.has(k)) map[k] = { t: now };
  for (const k of prevActive) if (!next.has(k)) map[k] = { t: now, d: 1 };
  return map;
}

/** Reconcile the bookmark map toward a desired live set, stamping adds/removes at `now`. Mutates+
 * returns. A rename shows up as old-key gone + new-key present → tombstone old, add new. */
export function setActiveBookmarks(
  map: BmMap,
  next: { title: string; pageIndex: number }[],
  now: number,
): BmMap {
  const nextKeys = new Set(next.map((b) => bmKey(b.title, b.pageIndex)));
  const prevActive = new Set(
    activeBookmarks({ bmLww: map }).map((b) => bmKey(b.title, b.pageIndex)),
  );
  for (const b of next) if (!prevActive.has(bmKey(b.title, b.pageIndex))) addBm(map, b.title, b.pageIndex, now);
  for (const b of activeBookmarks({ bmLww: map }))
    if (!nextKeys.has(bmKey(b.title, b.pageIndex))) removeBm(map, b.title, b.pageIndex, now);
  return map;
}

/** Add/refresh a bookmark in the map at `now`. Mutates+returns. */
export function addBm(map: BmMap, title: string, pageIndex: number, now: number): BmMap {
  map[bmKey(title, pageIndex)] = { t: now, title, pageIndex };
  return map;
}

/** Tombstone a bookmark in the map at `now`. Mutates+returns. */
export function removeBm(map: BmMap, title: string, pageIndex: number, now: number): BmMap {
  map[bmKey(title, pageIndex)] = { t: now, d: 1, title, pageIndex };
  return map;
}

/** True if `local` carries any star/bm entry strictly newer than `cloud` (→ worth pushing back). */
export function hasLocalNewer(local: ProgressBlob, cloud: ProgressBlob): boolean {
  const cs = cloud.starsLww ?? {};
  for (const [k, e] of Object.entries(local.starsLww ?? {}))
    if (!cs[k] || e.t > cs[k].t) return true;
  const cb = cloud.bmLww ?? {};
  for (const [k, e] of Object.entries(local.bmLww ?? {}))
    if (!cb[k] || e.t > cb[k].t) return true;
  return (local.posAt ?? 0) > (cloud.posAt ?? 0);
}
