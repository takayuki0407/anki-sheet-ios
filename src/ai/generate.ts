// Client for the AI ○× question generator (mirrors the web app's src/ai/generate.ts). Generation
// happens server-side (/api/sync/generate); this persists the result locally (expo-sqlite). Pro+
// also has the questions in D1 (restoreCloudQuestions pulls them on a new device). Quota is enforced
// server-side; a 402 surfaces as QuotaError for the upgrade prompt. (iOS targets the PRODUCTION
// backend — ANTHROPIC_API_KEY must be set on Production.)
import { authedFetch } from "../sync/api";
import { getMeta, putBookQuestions, savePageQuestions, setMeta } from "../db/repo";
import type { QuestionRow, Qtype } from "../db/rows";

export type Density = "auto" | "few" | "normal" | "many";

export interface GenUsage {
  tier: string;
  count: number;
  limit: number;
  remaining: number;
  unlimited: boolean;
}

export class QuotaError extends Error {
  constructor(
    public count: number,
    public limit: number,
  ) {
    super("quota_exceeded");
    this.name = "QuotaError";
  }
}
export class AiUnavailableError extends Error {
  constructor() {
    super("ai_not_configured");
    this.name = "AiUnavailableError";
  }
}

interface ServerQ {
  id: string;
  statement: string;
  answer: string;
  qtype?: string;
  choices?: string[] | null;
  explanation?: string;
  source?: string;
}

export async function getGenUsage(): Promise<GenUsage> {
  const res = await authedFetch("/generate");
  if (!res.ok) throw new Error(`usage_failed_${res.status}`);
  return res.json();
}

export async function generatePage(opts: {
  bookId: string;
  pageIndex: number;
  qtype: Qtype;
  pageText: string;
  markedTerms: string[];
  density: Density;
  subjectHint?: string;
  regenerate?: boolean;
  /** Reference-only excerpts of the neighbor pages (tail of p-1 / head of p+1), to resolve content
   * split across a page boundary. Questions still come only from THIS page's marked terms. */
  prevContext?: string;
  nextContext?: string;
}): Promise<{ questions: QuestionRow[]; remaining?: number; cached?: boolean }> {
  const res = await authedFetch("/generate", {
    method: "POST",
    body: JSON.stringify({
      bookId: opts.bookId,
      pageIndex: opts.pageIndex,
      qtype: opts.qtype,
      pageText: opts.pageText,
      markedTerms: opts.markedTerms,
      density: opts.density,
      subjectHint: opts.subjectHint ?? "",
      regenerate: !!opts.regenerate,
      prevContext: opts.prevContext ?? "",
      nextContext: opts.nextContext ?? "",
    }),
  });
  if (res.status === 402) {
    const b = (await res.json().catch(() => ({}))) as { count?: number; limit?: number };
    throw new QuotaError(b.count ?? 0, b.limit ?? 0);
  }
  if (res.status === 503) throw new AiUnavailableError();
  if (!res.ok) throw new Error(`generate_failed_${res.status}`);
  const data = (await res.json()) as { questions: ServerQ[]; remaining?: number; cached?: boolean };
  const now = Date.now();
  const rows: QuestionRow[] = (data.questions ?? []).map((q) => ({
    id: q.id,
    bookId: opts.bookId,
    pageIndex: opts.pageIndex,
    qtype: opts.qtype,
    statement: q.statement,
    answer: q.answer,
    choices: opts.qtype === "mc4" && Array.isArray(q.choices) ? q.choices : null,
    explanation: q.explanation ?? "",
    source: q.source ?? "",
    createdAt: now,
  }));
  await savePageQuestions(opts.bookId, opts.pageIndex, opts.qtype, rows);
  return { questions: rows, remaining: data.remaining, cached: data.cached };
}

/** Delete one (page × type) group on the server too (Pro+ keeps questions in D1 — without this a
 * local delete would resurrect on the next cloud restore). Best-effort. */
export async function deleteCloudQuestions(
  bookId: string,
  pageIndex: number,
  qtype: Qtype,
): Promise<void> {
  try {
    await authedFetch(
      `/questions?bookId=${encodeURIComponent(bookId)}&pageIndex=${pageIndex}&qtype=${qtype}`,
      { method: "DELETE" },
    );
  } catch {
    /* offline → the cloud copy survives; acceptable (re-delete later) */
  }
}

/** Pro+ restore: pull a book's whole question set from D1 onto this device. Best-effort. */
export async function restoreCloudQuestions(bookId: string): Promise<void> {
  let res: Response;
  try {
    res = await authedFetch(`/questions?bookId=${encodeURIComponent(bookId)}`);
  } catch {
    return;
  }
  if (!res.ok) return;
  const data = (await res.json().catch(() => ({ questions: [] }))) as {
    questions: {
      id: string;
      page_index: number;
      qtype?: string;
      statement: string;
      answer: string;
      choices?: string[] | null;
      explanation?: string;
      source?: string;
      created_at?: number;
    }[];
  };
  if (!data.questions?.length) return;
  const rows: QuestionRow[] = data.questions.map((q) => ({
    id: q.id,
    bookId,
    pageIndex: q.page_index,
    qtype: q.qtype === "mc4" ? "mc4" : "tf",
    statement: q.statement,
    answer: q.answer,
    choices: q.qtype === "mc4" && Array.isArray(q.choices) ? q.choices : null,
    explanation: q.explanation ?? "",
    source: q.source ?? "",
    createdAt: q.created_at ?? Date.now(),
  }));
  await putBookQuestions(bookId, rows);
}

/** One-time AI opt-in, stored in meta. */
export async function hasAiConsent(): Promise<boolean> {
  return (await getMeta("aiConsent")) === "1";
}
export async function setAiConsent(): Promise<void> {
  await setMeta("aiConsent", "1");
}
