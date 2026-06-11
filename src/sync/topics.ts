// Page-topic labels: give each page a human label ("which chapter is this page from?") so question
// groups and practice setup aren't page-number-only. The deck's real 目次 (bookmarks — imported PDF
// outline or user-added) wins when present; otherwise a TOC is AUTO-DETECTED from the whole book's
// page texts (study PDFs print section banners like 「❖ 1 一般原則」「第3章 …」 inline) and labels
// carry FORWARD: a page that starts mid-sentence belongs to the most recent heading before it.
// Chapter-opener pages need extra care — the big chapter number and the 重要度 ★★★ badge extract
// as lines like 「１ 重要度」「★★★一般原則」, so badges are stripped and a number-only line is
// stitched back onto the title line(s) that follow. There is deliberately NO body-text fallback —
// a wrong label (a mid-sentence fragment) is worse than none.
// Pure module — kept byte-identical between web and iOS (scripts/check-shared.mjs).

export interface TopicBookmark {
  pageIndex: number;
  title: string;
}

/** Bump when the detection below changes — cached auto-TOCs from older versions are recomputed. */
export const TOPICS_VERSION = 2;

const MAX_LABEL = 22;

function truncate(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s;
}

/** Leading section markers (❖ ■ ◆ …) — their presence marks a heading; stripped from the title. */
const MARKER = /^[❖◆■●▲▶►○◎☆★・•＊*§]+\s*/;

/** Other heading shapes in Japanese study PDFs: 第3章/第２節…, 1. / １　/ (1) / 【…】 starts. */
const HEADING_START =
  /^(?:第[0-9０-９一二三四五六七八九十百]+[編章節款部]|[0-9０-９]{1,3}[ 　.．、]|（[0-9０-９]{1,3}）|\([0-9０-９]{1,3}\)|[【〔])/;

/** Decoration / page-number-only lines (never headings, never useful). */
const NOISE = /^[0-9０-９\s\-‐–—―・.,，。、/／()（）〔〕[\]§|©:：;；]+$/;

/** Rating badges printed beside chapter banners (重要度 ★★★) — stripped before heading checks. */
function stripBadges(l: string): string {
  return l
    .replace(/重要度/g, "")
    .replace(/[★☆]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NUM_ONLY = /^[0-9０-９]{1,3}$/;

/** Decoration built from one short token repeated (会計原則会計原則会計原則). */
const REPEATED = /^(.{2,8})\1+$/;

function isHeadingLine(line: string): boolean {
  if (line.length < 2 || line.length > 36) return false;
  if (/[。．，、,]$/.test(line)) return false; // sentence end / mid-sentence continuation
  if (NOISE.test(line)) return false;
  const body = line.replace(MARKER, "");
  if (body.length < 2) return false;
  return MARKER.test(line) || HEADING_START.test(body);
}

/** The page's heading, if its top lines contain one. */
function pageHeading(lines: string[], isRunningHeader: (l: string) => boolean): string | null {
  const top = lines.slice(0, 12).map(stripBadges); // headings live near the top of a page
  for (let i = 0; i < top.length; i++) {
    const l = top[i];
    if (!l || isRunningHeader(l)) continue;
    if (isHeadingLine(l)) return l.replace(MARKER, "").trim();
    // A chapter banner can split across lines —「１」(big number) /「★★★一般原則」(badge+title) /
    // possibly a continuation line — stitch the number back onto the following title line(s).
    if (NUM_ONLY.test(l) && i + 1 < top.length) {
      let title = "";
      let joins = 0;
      for (let j = i + 1; j < top.length && joins < 2; j++) {
        const next = top[j];
        if (!next) continue;
        if (next.length < 2 || next.length > 24) break;
        if (/[。．，、,]$/.test(next) || NOISE.test(next) || REPEATED.test(next)) break;
        if (isRunningHeader(next)) break;
        title += (title ? " " : "") + next;
        joins += 1;
      }
      const joined = `${l} ${title}`;
      if (title && isHeadingLine(joined)) return joined;
    }
  }
  return null;
}

/** Auto-detect a 目次 from the whole book's page texts. A banner repeating page after page is the
 * SAME section continuing — consecutive entries whose titles match (or where one is a prefix of
 * the other, e.g. the opener's split banner vs the full banner) collapse into one entry at the
 * earliest page, keeping the longer wording. */
export function extractHeadings(texts: Map<number, string>): TopicBookmark[] {
  const pages = [...texts.keys()].sort((a, b) => a - b);
  const linesOf = new Map<number, string[]>();
  const freq = new Map<string, number>();
  for (const p of pages) {
    const ls = (texts.get(p) ?? "")
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length >= 2);
    linesOf.set(p, ls);
    for (const l of new Set(ls)) freq.set(l, (freq.get(l) ?? 0) + 1);
  }
  const n = pages.length;
  // Only BOOK-WIDE running headers (柱 / book title) are excluded by frequency. The threshold is
  // high on purpose: a section banner repeats on every page of its own section, and long sections
  // must survive — they collapse via the consecutive-dedupe instead.
  const isRunningHeader = (l: string) =>
    n >= 8 && (freq.get(l) ?? 0) >= Math.max(8, Math.ceil(n * 0.4));

  const norm = (t: string) => t.replace(/\s+/g, "");
  const toc: TopicBookmark[] = [];
  for (const p of pages) {
    const title = pageHeading(linesOf.get(p) ?? [], isRunningHeader);
    if (!title) continue;
    const prev = toc[toc.length - 1];
    if (prev) {
      const a = norm(prev.title);
      const b = norm(title);
      if (a === b || a.startsWith(b) || b.startsWith(a)) {
        if (b.length > a.length) prev.title = title;
        continue;
      }
    }
    toc.push({ pageIndex: p, title });
  }
  return toc;
}

/** Label the given pages from a 目次 (real bookmarks or extractHeadings output): the nearest
 * entry at or before each page. Pages before the first entry get no label. */
export function pageTopics(pages: number[], toc: TopicBookmark[]): Map<number, string> {
  const marks = toc
    .filter((b) => b.title.trim().length > 0)
    .sort((a, b) => a.pageIndex - b.pageIndex);
  const out = new Map<number, string>();
  for (const page of [...pages].sort((a, b) => a - b)) {
    let label = "";
    for (const b of marks) {
      if (b.pageIndex > page) break;
      label = b.title.trim();
    }
    if (label) out.set(page, truncate(label));
  }
  return out;
}
