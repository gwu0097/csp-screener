import { NextRequest, NextResponse } from "next/server";
import {
  extractTextSection,
  fetchFilingTextFull,
  fetchFilingTextPlain,
  findFilingByForm,
  getCIK,
  listFilingFiles,
  primaryDocumentUrl,
} from "@/lib/sec-edgar";
import { geminiSummarize } from "@/lib/gemini";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/research/[symbol]/export-filing
//
// Builds a clipboard-ready markdown document combining:
//   1. System context (earnings history + recent earnings releases +
//      prior journal notes pulled from Supabase)
//   2. The filing-specific body:
//      - 8-K  → press-release exhibit, stripped to plain text
//      - 10-Q → MD&A section (Item 2) only
//      - 10-K → AI summary of Business / MD&A / Risk Factors
//   3. A "FOR CLAUDE REVIEW" prompt block at the bottom
//
// Returns { markdown: string }. The client copies the value to the
// clipboard and pastes it into a Claude chat for review.

type Body = {
  type?: "8-K" | "10-Q" | "10-K";
  accessionNumber?: string;
  quarter?: string;
  periodEnd?: string;
};

const WORDS_PER_8K = 4_000;
const WORDS_PER_10Q_MDA = 5_000;
// The 10-K full document can clear 1M chars; we cap higher than the
// default so the section extractor sees the whole thing before slicing.
const TENK_CAP = 2_000_000;

function validSymbol(s: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + " […]";
}

function fmtMillionsOrDash(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}B`;
  return `$${v.toFixed(0)}M`;
}

function fmtPctOrDash(v: number | null | undefined, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = signed ? (v >= 0 ? "+" : "") : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtRatioOrDash(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}×`;
}

// --------------- System context ---------------

type EarningsHistRow = {
  earnings_date: string;
  actual_move_pct: number | null;
  implied_move_pct: number | null;
  move_ratio: number | null;
};

type EarningsReleaseLite = {
  quarter: string;
  reported_date: string;
  revenue: number | null;
  eps_diluted: number | null;
};

type JournalNoteRow = {
  quarter: string | null;
  filing_type: string | null;
  notes: string;
  trade_relevance: string | null;
  created_at: string | null;
};

async function buildSystemContext(
  symbol: string,
  type: string,
  quarter: string | undefined,
  periodEnd: string | undefined,
): Promise<string> {
  const sb = createServerClient();
  const lines: string[] = [];
  lines.push(`## SYSTEM CONTEXT`);
  lines.push(`**Symbol:** ${symbol}`);
  lines.push(`**Export date:** ${todayIso()}`);
  lines.push(
    `**Filing:** ${type}${quarter ? ` ${quarter}` : ""}${
      periodEnd ? ` (period end ${periodEnd})` : ""
    }`,
  );
  lines.push("");

  // --- Earnings history (joined with releases for revenue/EPS) ---
  let histRows: EarningsHistRow[] = [];
  let releaseRows: EarningsReleaseLite[] = [];
  try {
    const r = await sb
      .from("earnings_history")
      .select("earnings_date, actual_move_pct, implied_move_pct, move_ratio")
      .eq("symbol", symbol)
      .order("earnings_date", { ascending: false })
      .limit(6);
    if (!r.error) histRows = (r.data ?? []) as EarningsHistRow[];
  } catch {
    /* table may not exist — skip silently */
  }
  try {
    const r = await sb
      .from("earnings_releases")
      .select("quarter, reported_date, revenue, eps_diluted")
      .eq("symbol", symbol)
      .order("reported_date", { ascending: false })
      .limit(6);
    if (!r.error) releaseRows = (r.data ?? []) as EarningsReleaseLite[];
  } catch {
    /* table may not exist — skip silently */
  }

  if (histRows.length > 0 || releaseRows.length > 0) {
    lines.push(`### Earnings History (last 6 quarters)`);
    lines.push(
      `| Quarter | Revenue | EPS | Actual Move | vs EM | IV Crush |`,
    );
    lines.push(`|---|---|---|---|---|---|`);
    // Index releases by reported_date for join (closest to earnings date).
    const byDate = new Map<string, EarningsReleaseLite>();
    for (const rel of releaseRows) byDate.set(rel.reported_date, rel);
    if (histRows.length > 0) {
      for (const h of histRows) {
        // Match release row whose reported_date is within 7 days of
        // the earnings_date — robust to BMO/AMC offsets.
        const rel = (() => {
          for (const r of releaseRows) {
            const a = new Date(h.earnings_date + "T12:00:00Z").getTime();
            const b = new Date(r.reported_date + "T12:00:00Z").getTime();
            if (Math.abs(a - b) <= 7 * 86_400_000) return r;
          }
          return null;
        })();
        const ratio =
          h.move_ratio ??
          (h.actual_move_pct !== null &&
          h.implied_move_pct !== null &&
          h.implied_move_pct > 0
            ? Math.abs(h.actual_move_pct) / h.implied_move_pct
            : null);
        const crushLabel =
          ratio === null
            ? "—"
            : ratio < 0.7
              ? "✓ crush"
              : ratio > 1.0
                ? "✗ overshot"
                : "neutral";
        lines.push(
          `| ${rel?.quarter ?? h.earnings_date} | ${fmtMillionsOrDash(rel?.revenue ?? null)} | ${
            rel?.eps_diluted !== undefined && rel?.eps_diluted !== null
              ? `$${rel.eps_diluted.toFixed(2)}`
              : "—"
          } | ${fmtPctOrDash(h.actual_move_pct === null ? null : h.actual_move_pct * 100)} | ${
            h.implied_move_pct === null
              ? "—"
              : fmtPctOrDash(h.implied_move_pct * 100, false)
          } | ${fmtRatioOrDash(ratio)} ${crushLabel} |`,
        );
      }
    } else {
      // No earnings_history — at least surface the release rows we have.
      for (const r of releaseRows) {
        lines.push(
          `| ${r.quarter} | ${fmtMillionsOrDash(r.revenue)} | ${
            r.eps_diluted !== null ? `$${r.eps_diluted.toFixed(2)}` : "—"
          } | — | — | — |`,
        );
      }
    }
    lines.push("");
  }

  // --- Prior journal notes ---
  let notes: JournalNoteRow[] = [];
  try {
    const r = await sb
      .from("filing_notes")
      .select("quarter, filing_type, notes, trade_relevance, created_at")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(2);
    if (!r.error) notes = (r.data ?? []) as JournalNoteRow[];
  } catch {
    /* table may not exist — skip silently */
  }
  lines.push(`### Prior Journal Notes`);
  if (notes.length === 0) {
    lines.push(`None yet — this is the first review.`);
  } else {
    for (const n of notes) {
      const tag = [n.filing_type, n.quarter].filter(Boolean).join(" ");
      const stamp = n.created_at ? n.created_at.slice(0, 10) : "";
      const rel = n.trade_relevance ? ` · ${n.trade_relevance}` : "";
      lines.push(`**${tag || "Note"}** (${stamp}${rel})`);
      lines.push(n.notes);
      lines.push("");
    }
  }
  lines.push("");
  return lines.join("\n");
}

// --------------- 8-K body ---------------

const PRESS_RX = /ex(?:hibit)?[-_.]?99[-_.]?1/;

async function buildEightKBody(
  symbol: string,
  cik: string,
  accessionNumber: string,
  quarter: string | undefined,
): Promise<string | null> {
  const files = await listFilingFiles(cik, accessionNumber);
  const exhibit =
    files.find((f) => PRESS_RX.test(f.name.toLowerCase())) ??
    files.find((f) => /press|earnings|results/i.test(f.name)) ??
    null;
  if (!exhibit) return null;
  const text = await fetchFilingTextPlain(exhibit.url, 1_000_000);
  if (!text || text.length < 200) return null;
  const truncated = truncateWords(text, WORDS_PER_8K);

  const sb = createServerClient();
  let reportedDate: string | null = null;
  try {
    const r = await sb
      .from("earnings_releases")
      .select("reported_date")
      .eq("symbol", symbol)
      .eq("accession_number", accessionNumber)
      .limit(1);
    if (!r.error && r.data && (r.data as Array<{ reported_date: string }>)[0]) {
      reportedDate = (r.data as Array<{ reported_date: string }>)[0].reported_date;
    }
  } catch {
    /* ignore */
  }

  const lines: string[] = [];
  lines.push(`## FILING: ${quarter ?? ""} 8-K Earnings Release`);
  if (reportedDate) lines.push(`**Reported:** ${reportedDate}`);
  lines.push(`**Source:** SEC EDGAR ${accessionNumber}`);
  lines.push(`**Exhibit:** ${exhibit.name}`);
  lines.push("");
  lines.push(truncated);
  lines.push("");
  return lines.join("\n");
}

// --------------- 10-Q body ---------------

async function buildTenQBody(
  cik: string,
  periodEnd: string | undefined,
  quarter: string | undefined,
): Promise<string | null> {
  const filing = await findFilingByForm(cik, ["10-Q"], periodEnd);
  if (!filing) return null;
  const docUrl = primaryDocumentUrl(
    cik,
    filing.accessionNumber,
    filing.primaryDocument,
  );
  const text = await fetchFilingTextFull(docUrl);
  if (!text) return null;

  // Item 2 of a 10-Q is "Management's Discussion and Analysis…".
  // End-marker: the next Item header (3, 4, 5) — Part II for some
  // filers — anything that looks like "Item N." with a digit after.
  const mda = extractTextSection(
    text,
    /(item\s*2[\.\s]+management['’]?s?\s+discussion|management['’]?s?\s+discussion\s+and\s+analysis)/i,
    /item\s*[3-9][\.\s]/i,
  );
  if (!mda) return null;
  const truncated = truncateWords(mda, WORDS_PER_10Q_MDA);

  const lines: string[] = [];
  lines.push(`## FILING: ${quarter ?? ""} 10-Q — MD&A Section`);
  if (periodEnd) lines.push(`**Period end:** ${periodEnd}`);
  lines.push(`**Filed:** ${filing.filingDate}`);
  lines.push(`**Source:** SEC EDGAR ${filing.accessionNumber}`);
  lines.push("");
  lines.push(truncated);
  lines.push("");
  return lines.join("\n");
}

// --------------- 10-K body (Gemini summarized) ---------------

const SUMMARY_PROMPT = (sectionName: string, body: string) =>
  `You are analyzing a 10-K SEC filing for a stock options trader who sells cash-secured puts. Summarize the following ${sectionName} section in 300-400 words. Focus on: business model and revenue drivers, key risks to near-term earnings, any guidance or forward-looking statements, anything that would affect stock price volatility around earnings. Be direct and specific. No filler, no preamble.

${sectionName}:
"""
${body}
"""`;

async function buildTenKBody(cik: string): Promise<string | null> {
  const filing = await findFilingByForm(cik, ["10-K", "20-F", "40-F"]);
  if (!filing) return null;
  const docUrl = primaryDocumentUrl(
    cik,
    filing.accessionNumber,
    filing.primaryDocument,
  );
  const text = await fetchFilingTextFull(docUrl, TENK_CAP);
  if (!text) return null;

  const businessRaw = extractTextSection(
    text,
    /item\s*1[\.\s]+business/i,
    /item\s*1a[\.\s]+risk/i,
  );
  const risksRaw = extractTextSection(
    text,
    /item\s*1a[\.\s]+risk\s*factors/i,
    /item\s*1b[\.\s]/i,
  );
  const mdaRaw = extractTextSection(
    text,
    /item\s*7[\.\s]+management['’]?s?\s+discussion/i,
    /item\s*7a[\.\s]/i,
  );

  // Cap each section to ~30k chars before sending to Gemini — well
  // under the model's input limits and keeps latency tight.
  const cap = (s: string | null) => (s ? s.slice(0, 30_000) : null);
  const business = cap(businessRaw);
  const risks = cap(risksRaw);
  const mda = cap(mdaRaw);

  const [businessSum, mdaSum, risksSum] = await Promise.all([
    business
      ? geminiSummarize(SUMMARY_PROMPT("Business Overview", business), {
          label: "10k:business",
        })
      : Promise.resolve(null),
    mda
      ? geminiSummarize(SUMMARY_PROMPT("MD&A Highlights", mda), {
          label: "10k:mda",
        })
      : Promise.resolve(null),
    risks
      ? geminiSummarize(SUMMARY_PROMPT("Key Risk Factors", risks), {
          label: "10k:risks",
        })
      : Promise.resolve(null),
  ]);

  const year = filing.reportDate
    ? filing.reportDate.slice(0, 4)
    : filing.filingDate.slice(0, 4);

  const lines: string[] = [];
  lines.push(`## FILING: FY ${year} 10-K — AI Summary`);
  lines.push(`**Source:** SEC EDGAR ${filing.accessionNumber}`);
  lines.push(`**Filed:** ${filing.filingDate}`);
  lines.push(
    `**Note:** Summaries generated by Gemini Flash from full 10-K text. Sections: Business Overview, MD&A, Risk Factors.`,
  );
  lines.push("");
  lines.push(`### Business Overview`);
  lines.push(businessSum ?? "(section not extracted or summarizer unavailable)");
  lines.push("");
  lines.push(`### MD&A Highlights`);
  lines.push(mdaSum ?? "(section not extracted or summarizer unavailable)");
  lines.push("");
  lines.push(`### Key Risk Factors`);
  lines.push(risksSum ?? "(section not extracted or summarizer unavailable)");
  lines.push("");
  return lines.join("\n");
}

// --------------- Closing prompt ---------------

function closingPrompt(symbol: string): string {
  return `---
## FOR CLAUDE REVIEW

I am evaluating ${symbol} for a cash-secured put trade around their next earnings. Based on the filing and system context above:

1. What are the key risks and tailwinds for next quarter?
2. Does anything in this filing change the IV crush thesis?
3. What specific metrics should I track before the next earnings date?
4. Any red flags that would make you avoid this trade?
`;
}

// --------------- POST handler ---------------

export async function POST(
  req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const type = body.type;
  if (type !== "8-K" && type !== "10-Q" && type !== "10-K") {
    return NextResponse.json(
      { error: "type must be one of 8-K, 10-Q, 10-K" },
      { status: 400 },
    );
  }

  const cik = await getCIK(symbol);
  if (!cik) {
    return NextResponse.json(
      { error: "No EDGAR CIK for this symbol" },
      { status: 404 },
    );
  }

  const sysCtx = await buildSystemContext(
    symbol,
    type,
    body.quarter,
    body.periodEnd,
  );

  let filingBody: string | null = null;
  try {
    if (type === "8-K") {
      if (!body.accessionNumber) {
        return NextResponse.json(
          { error: "8-K export requires accessionNumber in body" },
          { status: 400 },
        );
      }
      filingBody = await buildEightKBody(
        symbol,
        cik,
        body.accessionNumber,
        body.quarter,
      );
    } else if (type === "10-Q") {
      filingBody = await buildTenQBody(cik, body.periodEnd, body.quarter);
    } else {
      filingBody = await buildTenKBody(cik);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[export-filing] ${symbol} ${type} threw:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!filingBody) {
    return NextResponse.json(
      {
        error: `Could not build ${type} body. Filing or section may be missing.`,
      },
      { status: 404 },
    );
  }

  const markdown = [
    sysCtx,
    filingBody,
    closingPrompt(symbol),
  ].join("\n");
  return NextResponse.json({ markdown });
}
