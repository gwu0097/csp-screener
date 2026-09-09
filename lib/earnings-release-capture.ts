// Shared 8-K earnings-release capture: find the newest earnings 8-K,
// locate its press-release exhibit, extract structured numbers via
// Perplexity, and upsert earnings_releases. Extracted from
// app/api/research/[symbol]/fetch-8k/route.ts (2026-09-09) so a second
// caller — the automated Stage A courier (lib/filing-analysis-capture.ts)
// — can reuse the exact same logic instead of drifting a duplicate.
// The route stays a thin wrapper around this function; behavior for
// the existing manual "Fetch latest 8-K" button is unchanged.
import {
  fetchFilingTextPlain,
  filingArchiveDirUrl,
  getCIK,
  getRecentFilings,
  listFilingFilesWithSize,
  type SecFiling,
} from "./sec-edgar";
import { askPerplexityRaw } from "./perplexity";
import { createServerClient } from "./supabase";

const NINETY_DAYS_MS = 90 * 86_400_000;

// Heuristic: an earnings release is the 99.1 exhibit and almost always
// contains some variant of "ex99-1" / "ex991" / "exhibit991" in the
// filename. Some filers concatenate the word straight after the ticker
// (HOOD's exhibit is `q12026robinhoodexhibit991.htm`) so we don't
// require a word boundary before "ex"/"exhibit". Falls back to
// "press" / "earnings" / "results" for filers using a less standard
// naming scheme.
function pickEarningsExhibit(
  files: Array<{ url: string; name: string }>,
): { url: string; name: string } | null {
  const lower = files.map((f) => ({ ...f, n: f.name.toLowerCase() }));
  const byPriority = [
    /ex(?:hibit)?[-_.]?99[-_.]?1/,
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

// EDGAR's auto-generated rendered-XBRL-viewer files (R1.htm, R2.htm, ...)
// — small boilerplate, never the actual exhibit, must be excluded from
// the size comparison below or one of these could occasionally outrank
// a genuinely small real exhibit.
const XBRL_VIEWER_FILE_PATTERN = /^R\d+\.html?$/i;

// Fallback when filename matching finds nothing (2026-09-09 audit:
// verified four independent, unrelated naming failures — NVDA's "pr"
// abbreviation, ELF's exhibit number without an "ex" prefix, CBRS's
// filename truncated by EDGAR mid-word, DG's exhibit missing its
// sub-number — no single regex tweak covers all four, and widening the
// pattern to fit them risks a fifth false match). The real signal that
// held across all four: the actual exhibit is always dramatically
// larger than the boilerplate 8-K body (7-20x, in the four cases
// checked), and EDGAR's own filing metadata already names that body
// (primaryDocument) — no guessing needed to exclude it.
//
// Deliberately NOT a replacement for the regex, which is unambiguous
// and cheap when it hits (~80% of filers per the 2026-09-09 sample) —
// this only runs once that's already failed.
function pickEarningsExhibitBySize(
  files: Array<{ url: string; name: string; size: number }>,
  primaryDocument: string,
): { url: string; name: string } | null {
  const candidates = files.filter((f) => {
    const lower = f.name.toLowerCase();
    if (!(lower.endsWith(".htm") || lower.endsWith(".html"))) return false;
    if (f.name === primaryDocument) return false;
    if (XBRL_VIEWER_FILE_PATTERN.test(f.name)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.size - a.size);
  return { url: candidates[0].url, name: candidates[0].name };
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
  // Many fintech / SaaS / consumer issuers don't disclose GAAP operating
  // income on the press release headline — they report Adj EBITDA
  // instead. Pulling it as a top-level field (rather than burying it in
  // key_metrics) lets the card surface it deterministically as a fallback
  // for op_income.
  adj_ebitda_millions?: number | null;
  adj_ebitda_growth_pct?: number | null;
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
  "op_income_millions": number (USD millions; null if GAAP operating income isn't disclosed),
  "op_margin_pct": number (percent; null if not disclosed),
  "net_margin_pct": number (percent; null if not disclosed),
  "adj_ebitda_millions": number (USD millions; adjusted EBITDA / non-GAAP EBITDA if the release reports it; null otherwise),
  "adj_ebitda_growth_pct": number (year-over-year percent for Adj EBITDA; null if not stated),
  "guidance_notes": one short paragraph summarizing forward guidance the company gave (next quarter, full-year, expense plan, etc.); null if no guidance,
  "key_metrics": {} object holding any other notable company-specific KPIs the release highlighted (e.g. funded customers, ARR, daily active users, net deposits, subscriber count, segment revenue) as { snake_case_name: number } — keep the keys descriptive but short
}

Use null for fields the press release truly doesn't disclose. Don't invent numbers. If multiple revenue lines appear, use TOTAL net revenues / total revenues for "revenue_millions". Adj EBITDA is the non-GAAP earnings figure that adds back interest, taxes, depreciation, amortization, and other adjustments — only fill it if the release explicitly labels a number "Adjusted EBITDA" (or equivalent like "Adjusted EBITDA (non-GAAP)").

Press release text (may be truncated):
"""
${pressText}
"""`;
}

// Exported — also used by lib/earnings-analysis-cards.ts to parse the
// claude -p card-generation response, same balanced-brace/code-fence
// handling, no reason to duplicate it a third time in this codebase.
export function extractJsonObject(s: string): unknown | null {
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

export type EarningsReleaseCaptureResult =
  | {
      ok: true;
      quarter: string;
      accessionNumber: string;
      filingDate: string;
      exhibitUrl: string;
      archiveUrl: string;
      // "regex" when the filename heuristic matched directly;
      // "size_fallback" when it didn't and the largest non-primary
      // .htm/.html file was used instead — a caller should flag rows
      // sourced this way as less certain than a clean regex hit.
      exhibitSource: "regex" | "size_fallback";
      // The stripped press-release text this call already fetched —
      // returned so a second-stage caller (the Stage A filing-analysis
      // courier) doesn't have to re-fetch the same document.
      pressText: string;
      row: Record<string, unknown>;
    }
  | { ok: false; status: number; error: string; reason: EarningsReleaseCaptureFailureReason; scanned?: number; rawSnippet?: string };

// Machine-readable failure classification, alongside the human-readable
// `error` string — added 2026-09-09 so a caller (Stage A's courier)
// can tell "the 8-K legitimately doesn't exist yet" (not_yet_filed)
// apart from every other reason, instead of string-matching prose.
// Only not_yet_filed is ever routine; everything else means something
// that WAS available failed to process cleanly and is worth a look.
export type EarningsReleaseCaptureFailureReason =
  | "no_cik"
  | "not_yet_filed"
  | "no_exhibit_found"
  | "document_too_short"
  | "perplexity_failed"
  | "perplexity_bad_json"
  | "missing_required_fields"
  | "db_error";

// Finds the newest earnings (item 2.02) 8-K within 90 days, its press-
// release exhibit, extracts structured numbers via Perplexity, and
// upserts earnings_releases keyed on (symbol, quarter). When
// earningsHistoryId is passed, stamps it on the row (see
// migrations/2026-09-09-earnings-releases-history-link.sql) so a
// consumer never has to fall back to a nearest-date join.
export async function fetchAndStoreEarningsRelease(
  symbol: string,
  opts: {
    earningsHistoryId?: string | null;
    // Stricter floor than the default 200 chars, for callers (Stage A)
    // that want the write itself refused — not just a downstream step
    // skipped — on a document too short to trust. Checked before
    // Perplexity runs and before any DB write, so a rejected document
    // never gets linked via earnings_history_id and stays eligible for
    // retry on the next run. The manual "Fetch latest 8-K" button
    // passes nothing and keeps the original 200-char behavior exactly.
    minPressTextChars?: number;
  } = {},
): Promise<EarningsReleaseCaptureResult> {
  const sym = symbol.trim().toUpperCase();

  const cik = await getCIK(sym);
  console.log(`[earnings-release-capture] ${sym}: CIK=${cik ?? "(none)"}`);
  if (!cik) {
    return { ok: false, status: 404, error: "No EDGAR CIK for this symbol", reason: "no_cik" };
  }
  const recent = await getRecentFilings(cik, ["8-K"], 25, { requireItem: "2.02" });
  const cutoff = Date.now() - NINETY_DAYS_MS;
  const within90 = recent.filter((f) => {
    const t = new Date(f.filingDate + "T12:00:00Z").getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  console.log(
    `[earnings-release-capture] ${sym}: earnings (item 2.02) 8-Ks in last 90 days = ${within90.length} of ${recent.length} total. Most recent: ${
      within90
        .slice(0, 5)
        .map((f) => `${f.filingDate} (${f.accessionNumber}) [${f.items.join(",")}]`)
        .join(", ") || "(none)"
    }`,
  );
  if (within90.length === 0) {
    return { ok: false, status: 404, error: "No earnings 8-K (item 2.02) filed in the last 90 days", reason: "not_yet_filed" };
  }

  let chosen: SecFiling | null = null;
  let exhibit: { url: string; name: string } | null = null;
  let exhibitSource: "regex" | "size_fallback" | null = null;
  for (const f of within90) {
    // One fetch (index.json, carries size) feeds both the regex pass
    // and the size fallback — no second request when the fallback
    // fires. pickEarningsExhibit only reads {url,name}; the extra
    // `size` field is ignored there and used only by the fallback.
    //
    // index.json lists EVERY file in the filing — XBRL exhibits,
    // images, the index/txt wrappers — unlike the old listFilingFiles,
    // which implicitly filtered to document files via its href regex.
    // Caught live (2026-09-09, DG): without restoring that filter here,
    // the regex matched tm2623914d1_ex99-1img001.jpg — an image whose
    // filename happens to contain "ex99-1" — before ever reaching the
    // real .htm exhibit. Restrict to .htm/.html for both the regex and
    // size-fallback passes; fetchFilingTextPlain only knows how to
    // strip HTML anyway, so anything else would mishandle downstream
    // even if it somehow matched.
    const files = (await listFilingFilesWithSize(cik, f.accessionNumber)).filter((x) => {
      const lower = x.name.toLowerCase();
      return lower.endsWith(".htm") || lower.endsWith(".html");
    });
    let hit = pickEarningsExhibit(files);
    let source: "regex" | "size_fallback" = "regex";
    if (!hit) {
      hit = pickEarningsExhibitBySize(files, f.primaryDocument);
      if (hit) source = "size_fallback";
    }
    console.log(
      `[earnings-release-capture] ${sym}: ${f.filingDate} ${f.accessionNumber} — ${files.length} files [${files
        .map((x) => x.name)
        .slice(0, 6)
        .join(", ")}${files.length > 6 ? ", …" : ""}] → ${hit ? `MATCH ${hit.name} (${source})` : "no exhibit match"}`,
    );
    if (hit) {
      chosen = f;
      exhibit = hit;
      exhibitSource = source;
      break;
    }
  }
  if (!chosen || !exhibit) {
    return {
      ok: false,
      status: 404,
      error: "Could not find an earnings press-release exhibit in any recent 8-K",
      reason: "no_exhibit_found",
      scanned: within90.length,
    };
  }
  console.log(`[earnings-release-capture] ${sym}: chose ${chosen.accessionNumber} exhibit=${exhibit.name}`);

  const pressText = await fetchFilingTextPlain(exhibit.url, 60_000);
  const minChars = opts.minPressTextChars ?? 200;
  if (!pressText || pressText.length < minChars) {
    return {
      ok: false,
      status: 502,
      error: `Press release exhibit too short (${pressText?.length ?? 0} chars, floor ${minChars})`,
      reason: "document_too_short",
    };
  }

  const ppl = await askPerplexityRaw(buildPrompt(sym, pressText), {
    maxTokens: 1200,
    label: `fetch-8k:${sym}`,
  });
  if (!ppl) {
    return { ok: false, status: 502, error: "Perplexity extraction failed", reason: "perplexity_failed" };
  }
  const parsed = extractJsonObject(ppl.text) as ExtractedRelease | null;
  if (!parsed) {
    return {
      ok: false,
      status: 502,
      error: "Perplexity returned non-JSON",
      reason: "perplexity_bad_json",
      rawSnippet: ppl.text.slice(0, 400),
    };
  }

  const quarter = str(parsed.quarter);
  const periodEnd = str(parsed.period_end);
  if (!quarter || !periodEnd) {
    return {
      ok: false,
      status: 502,
      error: "Extracted release is missing quarter or period_end",
      reason: "missing_required_fields",
    };
  }
  const reportedDate = str(parsed.reported_date) ?? chosen.filingDate;

  const rawMetrics: Record<string, unknown> = { ...(parsed.key_metrics ?? {}) };
  const adjEbitda = num(parsed.adj_ebitda_millions);
  if (adjEbitda !== null) rawMetrics.adj_ebitda = adjEbitda;
  const adjEbitdaGrowth = num(parsed.adj_ebitda_growth_pct);
  if (adjEbitdaGrowth !== null) rawMetrics.adj_ebitda_growth_pct = adjEbitdaGrowth;

  const row: Record<string, unknown> = {
    symbol: sym,
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
    raw_metrics: Object.keys(rawMetrics).length > 0 ? rawMetrics : null,
    source: "8-K",
  };
  if (opts.earningsHistoryId !== undefined) {
    row.earnings_history_id = opts.earningsHistoryId;
  }

  const sb = createServerClient();
  const upsert = await sb.from("earnings_releases").upsert(row, { onConflict: "symbol,quarter" });
  if (upsert.error) {
    return { ok: false, status: 500, error: `DB upsert failed: ${upsert.error.message}`, reason: "db_error" };
  }

  return {
    ok: true,
    quarter,
    accessionNumber: chosen.accessionNumber,
    filingDate: chosen.filingDate,
    exhibitUrl: exhibit.url,
    archiveUrl: filingArchiveDirUrl(cik, chosen.accessionNumber),
    // Guaranteed non-null here: the only path to this point set it
    // alongside chosen/exhibit in the same loop iteration.
    exhibitSource: exhibitSource ?? "regex",
    pressText,
    row,
  };
}
