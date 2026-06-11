// Page-topic labels: derive a short "which chapter / what is this page about?" label for each page
// that has questions, so practice setup and the question list aren't page-number-only (P.14 alone
// tells the user nothing). Sources, in order:
//   1. The deck's 目次 (bookmarks — imported PDF outline or user-added): the last entry at or
//      before the page is the chapter the page belongs to.
//   2. Fallback: the page's own text — the first plausible heading line, skipping lines that repeat
//      across many pages (running headers such as the book title) and number-only lines.
// Pure module — kept byte-identical between web and iOS (scripts/check-shared.mjs).

export interface TopicBookmark {
  pageIndex: number;
  title: string;
}

const MAX_LABEL = 22;

function truncate(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s;
}

/** Candidate heading lines of one page's raw text (pdf.js text, line breaks from hasEOL). */
function headingCandidates(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 2)
    .filter((l) => !/^[0-9０-９\s\-‐–—―・.,，。、/／()（）〔〕[\]§|©:：;；]+$/.test(l))
    .slice(0, 6);
}

/** Map pageIndex -> topic label for the pages in `texts` (value may be "" when the PDF text is
 * unavailable — bookmark labels still apply). `bookmarks` is the deck's 目次 (may be empty). */
export function pageTopics(
  texts: Map<number, string>,
  bookmarks: TopicBookmark[],
): Map<number, string> {
  const marks = bookmarks
    .filter((b) => b.title.trim().length > 0)
    .sort((a, b) => a.pageIndex - b.pageIndex);

  // Running headers: lines that repeat on ≥3 and ≥30% of the supplied pages (book title etc.).
  const lines = new Map<number, string[]>();
  const freq = new Map<string, number>();
  for (const [page, text] of texts) {
    const ls = headingCandidates(text);
    lines.set(page, ls);
    for (const l of new Set(ls)) freq.set(l, (freq.get(l) ?? 0) + 1);
  }
  const n = texts.size;
  const isRunningHeader = (l: string) =>
    n >= 3 && (freq.get(l) ?? 0) >= Math.max(3, Math.ceil(n * 0.3));

  const out = new Map<number, string>();
  for (const [page] of texts) {
    let label = "";
    for (const b of marks) {
      if (b.pageIndex > page) break;
      label = b.title.trim(); // nearest 目次 entry at or before the page wins
    }
    if (!label) {
      const ls = lines.get(page) ?? [];
      label = ls.find((l) => !isRunningHeader(l)) ?? ls[0] ?? "";
    }
    if (label) out.set(page, truncate(label));
  }
  return out;
}
