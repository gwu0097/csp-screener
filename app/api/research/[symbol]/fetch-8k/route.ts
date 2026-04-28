import { NextRequest, NextResponse } from "next/server";
import {
  fetchFilingTextPlain,
  filingArchiveDirUrl,
  getCIK,
  getRecentFilings,
  listFilingFiles,
  type SecFiling,
} from "@/lib/sec-edgar";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/research/[symbol]/fetch-8k
//
// Pulls the most recent 8-K filed in the last 90 days, finds the
// earnings press release exhibit (typically *exhibit991*.htm), strips
// it to plain text, asks Perplexity to extract structured numbers,
// and upserts a row into earnings_releases keyed on (symbol, quarter).
// The caller then reads the latest releases via the GET sibling at
// /earnings-releases.

const NINETY_DAYS_MS = 90 * 86_400_000;

function validSymbol(s: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s);
}

// Heuristic: an earnings release is the 99.1 exhibit and almost always
// contains the substring "exhibit991" or "ex991" or "ex99-1" / "ex99_1"
// in the filename. Fall back to "press" / "earnings" / "results" when
// the filer uses an idiosyncratic naming scheme.
function pickEarningsExhibit(
  files: Array<{ url: string; name: string }>,
): { url: string; name: string } | null {
  const lower = files.map((f) => ({ ...f, n: f.name.toLowerCase() }));
  const byPriority = [
    /(?:^|[^a-z0-9])(?:ex|exhibit)[-_]?99[-_]?1(?:[^a-z0-9]|$)/,
    /press.*release/,
    /earnings/,
    /results/,
  ];
  for (const re of byPriority) {
    const hit = lower.find((f) => re.test(f.n));
    if (hit) return { url: hit.url, name: hit.name };
  }
  return null;
}

type ExtractedRelease = {
  quarter?: string;
  period_end?: string;
  reported_date?: string;
  revenue_millions?: number | null;
  revenue_growth_pct?: number | null;
  net_income_millions?: number | null;
  eps_diluted?: number | null;
  op_income_millions?: number | null;
  op_margin_pct?: number | null;
  net_margin_pct?: number | null;
  guidance_notes?: string | null;
  key_metrics?: Record<string, unknown> | null;
};

function buildPrompt(symbol: string, pressText: string): string {
  return `You are extracting one quarter of earnings results from a public-company press release.

Company ticker: ${symbol}

Return ONLY a single JSON object, no prose, no markdown fences, with these fields:
{
  "quarter": "Q1 2026" or similar fiscal-quarter label,
  "period_end": "YYYY-MM-DD" of the quarter end,
  "reported_date": "YYYY-MM-DD" of the press release,
  "revenue_millions": number (USD millions; convert if billions appear),
  "revenue_growth_pct": number (year-over-year, percent — e.g. 15 not 0.15),
  "net_income_millions": number (USD millions; negative for a loss),
  "eps_diluted": number (USD/share; negative for a loss),
  "op_income_millions": number (USD millions; null if not disclosed),
  "op_margin_pct": number (percent; null if not disclosed),
  "net_margin_pct": number (percent; null if not disclosed),
  "guidance_notes": one short paragraph summarizing forward guidance the company gave (next quarter, full-year, expense plan, etc.); null if no guidance,
  "key_metrics": {} object holding any other notable company-specific KPIs the release highlighted (e.g. funded customers, ARR, daily active users, net deposits, subscriber count, segment revenue) as { snake_case_name: number } — keep the keys descriptive but short
}

Use null for fields the press release truly doesn't disclose. Don't invent numbers. If multiple revenue lines appear, use TOTAL net revenues / total revenues for "revenue_millions".

Press release text (may be truncated):
"""
${pressText}
"""`;
}

function extractJsonObject(s: string): unknown | null {
  // Strip optional code fences and find the first balanced { ... } block.
  const trimmed = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function num(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x.replace(/[, $]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(x: unknown): string | null {
  if (typeof x === "string" && x.trim().length > 0) return x.trim();
  return null;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  // 1. CIK + recent 8-K list (data.sec.gov is the stable path; the
  //    full-text efts.sec.gov endpoint returns 500 unauthenticated).
  const cik = await getCIK(symbol);
  if (!cik) {
    return NextResponse.json(
      { error: "No EDGAR CIK for this symbol" },
      { status: 404 },
    );
  }
  const recent = await getRecentFilings(cik, ["8-K"], 25);
  const cutoff = Date.now() - NINETY_DAYS_MS;
  const within90 = recent.filter((f) => {
    const t = new Date(f.filingDate + "T12:00:00Z").getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  if (within90.length === 0) {
    return NextResponse.json(
      { error: "No 8-K filed in the last 90 days" },
      { status: 404 },
    );
  }

  // 2. Walk filings newest-first looking for one that actually carries
  //    a 99.1 / press-release exhibit. Many 8-Ks are non-earnings
  //    events (departures, debt issuance) without an exhibit we can use.
  let chosen: SecFiling | null = null;
  let exhibit: { url: string; name: string } | null = null;
  for (const f of within90) {
    const files = await listFilingFiles(cik, f.accessionNumber);
    const hit = pickEarningsExhibit(files);
    if (hit) {
      chosen = f;
      exhibit = hit;
      break;
    }
  }
  if (!chosen || !exhibit) {
    return NextResponse.json(
      { error: "Could not find an earnings press-release exhibit in any recent 8-K" },
      { status: 404 },
    );
  }

  // 3. Fetch the exhibit text and ask Perplexity to extract.
  const pressText = await fetchFilingTextPlain(exhibit.url, 60_000);
  if (!pressText || pressText.length < 200) {
    return NextResponse.json(
      { error: "Failed to fetch or parse the press release exhibit" },
      { status: 502 },
    );
  }

  const ppl = await askPerplexityRaw(buildPrompt(symbol, pressText), {
    maxTokens: 1200,
    label: `fetch-8k:${symbol}`,
  });
  if (!ppl) {
    return NextResponse.json(
      { error: "Perplexity extraction failed" },
      { status: 502 },
    );
  }
  const parsed = extractJsonObject(ppl.text) as ExtractedRelease | null;
  if (!parsed) {
    return NextResponse.json(
      {
        error: "Perplexity returned non-JSON",
        rawSnippet: ppl.text.slice(0, 400),
      },
      { status: 502 },
    );
  }

  // 4. Coerce + upsert. (symbol, quarter) is the unique key — re-fetch
  //    overrides the prior row so a corrected press release cleans up
  //    on its own. reported_date defaults to the filing date when the
  //    model didn't extract one.
  const quarter = str(parsed.quarter);
  const periodEnd = str(parsed.period_end);
  if (!quarter || !periodEnd) {
    return NextResponse.json(
      { error: "Extracted release is missing quarter or period_end" },
      { status: 502 },
    );
  }
  const reportedDate = str(parsed.reported_date) ?? chosen.filingDate;

  const row = {
    symbol,
    quarter,
    period_end: periodEnd,
    reported_date: reportedDate,
    accession_number: chosen.accessionNumber,
    revenue: num(parsed.revenue_millions),
    revenue_growth_pct: num(parsed.revenue_growth_pct),
    op_income: num(parsed.op_income_millions),
    op_margin_pct: num(parsed.op_margin_pct),
    net_income: num(parsed.net_income_millions),
    net_margin_pct: num(parsed.net_margin_pct),
    eps_diluted: num(parsed.eps_diluted),
    guidance_notes: str(parsed.guidance_notes),
    raw_metrics: parsed.key_metrics ?? null,
    source: "8-K",
  };

  const sb = createServerClient();
  const upsert = await sb
    .from("earnings_releases")
    .upsert(row, { onConflict: "symbol,quarter" });
  if (upsert.error) {
    return NextResponse.json(
      { error: `DB upsert failed: ${upsert.error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    quarter,
    accessionNumber: chosen.accessionNumber,
    filingDate: chosen.filingDate,
    exhibitUrl: exhibit.url,
    archiveUrl: filingArchiveDirUrl(cik, chosen.accessionNumber),
    row,
  });
}
