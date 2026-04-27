import { NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { getQuoteEnrichment } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
// Three Perplexity calls in parallel + Yahoo enrichment per returned
// symbol. Typical run is 15-25s but bursty Perplexity latency or a
// long candidate list can push past 60s. Pro-plan ceiling.
export const maxDuration = 300;

// ------------------------------------------------------------
// Prompts — three passes targeting different flavors of setup.
// ------------------------------------------------------------

// Shared "less obvious" steering shipped on every prompt — pushes the
// model away from the standard mega-cap roster the trader has already
// seen everywhere. Includes the price/market-cap floor so the model
// stops returning penny stocks and micro-cap biotechs.
const UNDER_THE_RADAR_NOTE = `Important: the trader already knows about mega-cap tech like NVDA, AAPL, MSFT, GOOGL, META, AMZN. Do not include these unless there is a very specific near-term catalyst that is NOT already priced in. Prioritize mid-cap and small-cap names ($1B-$50B market cap) with strong catalysts that haven't been fully covered by mainstream financial media.

Include at least 2-3 less widely-covered names that analysts are quietly upgrading or that have strong fundamental momentum not yet reflected in widespread coverage. Do not just return the most obvious large-cap names everyone already knows.

Exclude any stock with a current price below $10 or market cap below $500M. The trader does not trade penny stocks or micro-caps. Only include stocks with real institutional ownership and sufficient liquidity.`;

const PROMPT_MOMENTUM = `You are a financial analyst helping a swing trader find 1-6 month opportunities.

The trader's style:
- Quality companies temporarily mispriced
- Catalyst-driven moves (product launches, partnerships, earnings beats, sector rotation)
- Prefers beaten-down quality names with recovery potential over pure momentum chases
- 1-6 month time horizon
- Avoids: penny stocks (<$10), pure meme plays, crypto-adjacent without real business

Find 8-10 US stocks with the strongest bullish catalyst momentum RIGHT NOW. Focus on:
- Recent analyst upgrades or price target raises
- Specific near-term product/partnership catalysts
- Stocks that haven't fully priced in the narrative

${UNDER_THE_RADAR_NOTE}

Return ONLY a JSON array, no markdown, no preamble:
[{
  "symbol": "AMD",
  "catalyst": "MI350 chip launch + Microsoft partnership",
  "sentiment": "bullish",
  "timeframe": "3months",
  "thesis": "one sentence why this could move",
  "confidence": "high|medium|low",
  "risk": "one sentence main downside risk",
  "signal_basis": "2-3 words: what is this based on e.g. analyst upgrades, earnings beat, reddit buzz, X trending, insider buying, options flow",
  "category": "momentum"
}]`;

const PROMPT_RECOVERY = `You are a financial analyst helping a swing trader.

Find 8-10 quality US stocks (market cap >$5B) that are:
- Trading significantly below 52-week highs
- Have a specific recovery catalyst in next 6 months
- Fundamental business is still strong despite price drop
- Beaten down by macro/sentiment not by broken thesis

Examples of what this trader already holds as long-term: CRM, NOW, NKE, ELF, RKT — similar quality/recovery profile preferred.

${UNDER_THE_RADAR_NOTE}

Return ONLY a JSON array, no markdown:
[{
  "symbol": "NKE",
  "catalyst": "Tariff resolution + new CEO turnaround",
  "sentiment": "bullish",
  "timeframe": "6months",
  "thesis": "one sentence recovery thesis",
  "confidence": "high|medium|low",
  "risk": "one sentence main risk",
  "signal_basis": "2-3 words: what this is based on (analyst upgrades, sector rotation, insider buying, etc.)",
  "category": "recovery"
}]`;

const PROMPT_THEMES = `What are the 2-3 strongest sector themes in the US market RIGHT NOW with specific stock examples that haven't fully priced in the narrative?

For each theme, give 8-10 stock examples spread across the themes (so 3-4 per theme).

${UNDER_THE_RADAR_NOTE}

Return ONLY a JSON array, no markdown:
[{
  "theme": "AI Infrastructure Buildout",
  "momentum": "strong|moderate|fading",
  "symbol": "NVDA",
  "catalyst": "specific reason this stock fits theme",
  "sentiment": "bullish|mixed|bearish",
  "timeframe": "1month|3months|6months",
  "thesis": "one sentence",
  "confidence": "high|medium|low",
  "risk": "one sentence",
  "signal_basis": "2-3 words: what this is based on (sector rotation, theme momentum, etc.)",
  "category": "theme"
}]`;

const PROMPT_SOCIAL = `You are helping a swing trader find stocks with strong retail and social media momentum RIGHT NOW.

Search across: X/Twitter trading communities, Reddit (r/wallstreetbets, r/stocks, r/investing, r/SecurityAnalysis), YouTube financial creators, Stocktwits, financial Substacks, and trading blogs.

Find 6-8 stocks where:
- Retail traders and financial social media are showing unusual excitement or attention
- The retail thesis has REAL fundamental backing (not just a pure meme pump)
- Retail sentiment appears to be AHEAD of analyst consensus — the crowd sees something institutions haven't caught up to yet
- There is unusual options activity or volume being discussed in trading communities

Exclude: pure meme stocks with no business fundamentals, crypto tokens, stocks already up >40% in the last month with no new catalyst.

Exclude any stock with a current price below $10 or market cap below $500M. The trader does not trade penny stocks or micro-caps. Only include stocks with real institutional ownership and sufficient liquidity.

The trader's style: quality companies, catalyst-driven, 1-6 month horizon. Medium conviction in fundamentals.

Return ONLY a JSON array, no markdown, no preamble:
[{
  "symbol": "HOOD",
  "catalyst": "specific social/retail catalyst",
  "sentiment": "bullish|bearish|mixed",
  "timeframe": "1month|3months|6months",
  "thesis": "one sentence — why retail is excited",
  "confidence": "high|medium|low",
  "risk": "one sentence main risk",
  "signal_basis": "2-3 words: where the signal is coming from (reddit buzz, X trending, options flow, youtube creator, etc.)",
  "category": "social"
}]`;

// ------------------------------------------------------------
// JSON extraction cascade. Models wrap arrays inconsistently —
// walks direct parse → ```json fence → any fence → outer [] regex.
// ------------------------------------------------------------

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeJson(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([\]}])/g, "$1")
    .replace(/[﻿​]/g, "");
}

function extractJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (Array.isArray(direct)) return direct;
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) {
    const parsed = tryParse(sanitizeJson(jsonFence[1].trim()));
    if (Array.isArray(parsed)) return parsed;
  }
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence) {
    const parsed = tryParse(sanitizeJson(anyFence[1].trim()));
    if (Array.isArray(parsed)) return parsed;
  }
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const parsed = tryParse(arrayMatch[0]);
    if (Array.isArray(parsed)) return parsed;
    const sanitized = tryParse(sanitizeJson(arrayMatch[0]));
    if (Array.isArray(sanitized)) return sanitized;
  }
  return [];
}

// ------------------------------------------------------------
// Candidate shaping
// ------------------------------------------------------------

type Category = "momentum" | "recovery" | "theme" | "social";

type RawCandidate = {
  symbol: string;
  catalyst: string;
  sentiment: string;
  timeframe: string;
  thesis: string;
  confidence: string;
  risk: string;
  signal_basis: string;
  sources: string[];
  category: Category;
  theme?: string | null;
  theme_momentum?: string | null;
};

type MarketCapCategory = "large" | "mid" | "small" | null;

type EnrichedCandidate = RawCandidate & {
  company_name: string | null;
  current_price: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  forward_pe: number | null;
  analyst_target: number | null;
  price_change_pct: number | null;
  pct_from_52w_high: number | null;
  upside_to_target: number | null;
  fifty_day_ma: number | null;
  vs_50d_ma_pct: number | null;
  market_cap: number | null;
  market_cap_category: MarketCapCategory;
};

function categorizeMarketCap(cap: number | null): MarketCapCategory {
  if (cap === null || !Number.isFinite(cap) || cap <= 0) return null;
  if (cap > 50_000_000_000) return "large";
  if (cap >= 2_000_000_000) return "mid";
  return "small";
}

function coerceCategory(raw: unknown, fallback: Category): Category {
  if (
    raw === "momentum" ||
    raw === "recovery" ||
    raw === "theme" ||
    raw === "social"
  ) {
    return raw;
  }
  return fallback;
}

function coerceSentiment(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "bullish" || s === "bearish" || s === "mixed" || s === "neutral") return s;
  return "neutral";
}

function coerceConfidence(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "high" || s === "medium" || s === "low") return s;
  return "medium";
}

function coerceTimeframe(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase().replace(/\s/g, "") : "";
  if (s === "1month" || s === "3months" || s === "6months") return s;
  return "3months";
}

function coerceCandidate(
  raw: unknown,
  fallbackCategory: Category,
): RawCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol =
    typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return null;
  return {
    symbol,
    catalyst: typeof r.catalyst === "string" ? r.catalyst.trim() : "",
    sentiment: coerceSentiment(r.sentiment),
    timeframe: coerceTimeframe(r.timeframe),
    thesis: typeof r.thesis === "string" ? r.thesis.trim() : "",
    confidence: coerceConfidence(r.confidence),
    risk: typeof r.risk === "string" ? r.risk.trim() : "",
    signal_basis:
      typeof r.signal_basis === "string" ? r.signal_basis.trim() : "",
    // sources are not produced by the model; runQuery fills them in from
    // the Perplexity response citations after the row coerces.
    sources: [],
    category: coerceCategory(r.category, fallbackCategory),
    theme: typeof r.theme === "string" ? r.theme.trim() : null,
    theme_momentum:
      typeof r.momentum === "string" ? r.momentum.toLowerCase() : null,
  };
}

async function runQuery(
  prompt: string,
  fallbackCategory: Category,
  label: string,
): Promise<RawCandidate[]> {
  const res = await askPerplexityRaw(prompt, { maxTokens: 1800, label });
  if (!res) {
    console.warn(`[swings/discover] ${label}: no response`);
    return [];
  }
  const arr = extractJsonArray(res.text);
  console.log(
    `[swings/discover] ${label} parsed ${arr.length} rows from ${res.text.length} chars (citations=${res.citations.length})`,
  );
  // Top 3 citations from the Perplexity response are shared across every
  // candidate parsed from that query. Perplexity citations are tied to
  // the whole query, not per-row, so this is the closest approximation
  // we have to a per-candidate source list.
  const sources = res.citations.slice(0, 3);
  return arr
    .map((r) => coerceCandidate(r, fallbackCategory))
    .filter((c): c is RawCandidate => c !== null)
    .map((c) => ({ ...c, sources }));
}

// Small deterministic sleep — Yahoo tolerates bursts but the spec asks
// for a 100ms stagger to stay polite.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enrichCandidates(
  candidates: RawCandidate[],
): Promise<EnrichedCandidate[]> {
  const out: EnrichedCandidate[] = [];
  for (const c of candidates) {
    const q = await getQuoteEnrichment(c.symbol);
    const current = q?.regularMarketPrice ?? null;
    const high = q?.fiftyTwoWeekHigh ?? null;
    const low = q?.fiftyTwoWeekLow ?? null;
    const target = q?.targetMeanPrice ?? null;
    const pctFromHigh =
      current !== null && high !== null && high > 0
        ? ((current - high) / high) * 100
        : null;
    const upsideToTarget =
      current !== null && target !== null && current > 0
        ? ((target - current) / current) * 100
        : null;
    const fiftyDayMa = q?.fiftyDayAverage ?? null;
    const vs50dMa =
      current !== null && fiftyDayMa !== null && fiftyDayMa > 0
        ? ((current - fiftyDayMa) / fiftyDayMa) * 100
        : null;
    const marketCap = q?.marketCap ?? null;
    out.push({
      ...c,
      company_name: q?.companyName ?? null,
      current_price: current,
      week_52_low: low,
      week_52_high: high,
      forward_pe: q?.forwardPE ?? null,
      analyst_target: target,
      price_change_pct: q?.regularMarketChangePercent ?? null,
      pct_from_52w_high: pctFromHigh,
      upside_to_target: upsideToTarget,
      fifty_day_ma: fiftyDayMa,
      vs_50d_ma_pct: vs50dMa,
      market_cap: marketCap,
      market_cap_category: categorizeMarketCap(marketCap),
    });
    await sleep(100);
  }
  return out;
}

// ------------------------------------------------------------
// Persistence helpers
// ------------------------------------------------------------

const SCANNABLE: Category[] = ["momentum", "recovery", "theme", "social"];

const PROMPT_FOR: Record<Category, string> = {
  momentum: PROMPT_MOMENTUM,
  recovery: PROMPT_RECOVERY,
  theme: PROMPT_THEMES,
  social: PROMPT_SOCIAL,
};

const PRICE_FLOOR = 10;
const MARKET_CAP_FLOOR = 500_000_000;

// Strip penny stocks / micro-caps + symbols Yahoo couldn't verify.
function applyFloor(c: EnrichedCandidate): boolean {
  if (c.current_price === null || c.current_price < PRICE_FLOOR) return false;
  if (c.market_cap === null || c.market_cap < MARKET_CAP_FLOOR) return false;
  return true;
}

// Dedupe a list of RawCandidates by symbol, first occurrence wins.
function dedupeBySymbol(rows: RawCandidate[]): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const c of rows) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    out.push(c);
  }
  return out;
}

// Run a single category's pipeline (Perplexity → coerce → enrich → floor).
// Returns the cleaned candidate list ready to persist + ship to the client.
async function scanCategory(cat: Category): Promise<EnrichedCandidate[]> {
  const raw = await runQuery(PROMPT_FOR[cat], cat, cat);
  if (raw.length === 0) return [];
  const enriched = await enrichCandidates(raw);
  const filtered = enriched.filter(applyFloor);
  const dropped = enriched.length - filtered.length;
  if (dropped > 0) {
    console.log(
      `[swings/discover] ${cat}: floor filter dropped ${dropped} of ${enriched.length}`,
    );
  }
  return filtered;
}

// Replace one category's persisted row. Delete + insert because we don't
// rely on a unique index on category — keeps the migration permissive.
async function persistCategoryRow(
  sb: ReturnType<typeof createServerClient>,
  category: Category,
  candidates: EnrichedCandidate[],
  scannedAt: string,
): Promise<string | null> {
  const del = await sb
    .from("swing_scan_results")
    .delete()
    .eq("category", category);
  if (del.error) return `delete ${category}: ${del.error.message}`;
  const ins = await sb
    .from("swing_scan_results")
    .insert({ category, candidates, scanned_at: scannedAt });
  if (ins.error) return `insert ${category}: ${ins.error.message}`;
  return null;
}

type SeenEntry = {
  appearance_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

// Load the last-30-days scan history aggregated by symbol+category.
// Supabase doesn't expose GROUP BY directly through the PostgREST client,
// so we pull the rows and reduce in memory. Volume is bounded by category
// count × candidates per scan × scans/month — well under 50k rows.
async function loadSeenMap(
  sb: ReturnType<typeof createServerClient>,
): Promise<Map<string, SeenEntry>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sb
    .from("swing_scan_history")
    .select("symbol, category, scanned_at")
    .gte("scanned_at", since);
  if (res.error) {
    console.warn(
      `[swings/discover] scan history fetch: ${res.error.message}`,
    );
    return new Map();
  }
  const map = new Map<string, SeenEntry>();
  const rows = (res.data ?? []) as Array<{
    symbol: string;
    category: string;
    scanned_at: string;
  }>;
  for (const row of rows) {
    const key = `${row.symbol}::${row.category}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        appearance_count: 1,
        first_seen_at: row.scanned_at,
        last_seen_at: row.scanned_at,
      });
    } else {
      existing.appearance_count += 1;
      if (row.scanned_at < existing.first_seen_at) {
        existing.first_seen_at = row.scanned_at;
      }
      if (row.scanned_at > existing.last_seen_at) {
        existing.last_seen_at = row.scanned_at;
      }
    }
  }
  return map;
}

type SeenAttached = EnrichedCandidate & {
  appearance_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

function attachSeen(
  cands: EnrichedCandidate[],
  cat: Category,
  seenMap: Map<string, SeenEntry>,
): SeenAttached[] {
  return cands.map((c) => {
    const entry = seenMap.get(`${c.symbol}::${cat}`);
    return {
      ...c,
      appearance_count: entry?.appearance_count ?? 0,
      first_seen_at: entry?.first_seen_at ?? null,
      last_seen_at: entry?.last_seen_at ?? null,
    };
  });
}

// Append one row per candidate to the permanent scan history log.
// Failure here is non-fatal — the SEEN indicator just won't update.
async function appendScanHistory(
  sb: ReturnType<typeof createServerClient>,
  category: Category,
  candidates: EnrichedCandidate[],
  scannedAt: string,
): Promise<void> {
  if (candidates.length === 0) return;
  const rows = candidates.map((c) => ({
    symbol: c.symbol,
    category,
    scanned_at: scannedAt,
    confidence: c.confidence || null,
    signal_basis: c.signal_basis || null,
  }));
  const ins = await sb.from("swing_scan_history").insert(rows);
  if (ins.error) {
    console.warn(
      `[swings/discover] scan history insert ${category}: ${ins.error.message}`,
    );
  }
}

// Wipe any pre-migration "all"-tagged rows so they don't shadow the new
// per-category rows on subsequent reads. Called after a full scan.
async function clearLegacyAllRow(
  sb: ReturnType<typeof createServerClient>,
): Promise<void> {
  const del = await sb.from("swing_scan_results").delete().eq("category", "all");
  if (del.error) {
    console.warn(`[swings/discover] clear legacy 'all' row: ${del.error.message}`);
  }
}

// ------------------------------------------------------------
// POST — run a scan (single category or all four), persist, return.
// ------------------------------------------------------------

export async function POST(req: Request) {
  let body: { category?: unknown } = {};
  try {
    body = (await req.json()) as { category?: unknown };
  } catch {
    // Empty body is fine — defaults to a full scan.
  }
  const requested =
    body.category === "momentum" ||
    body.category === "recovery" ||
    body.category === "theme" ||
    body.category === "social"
      ? (body.category as Category)
      : "all";

  const sb = createServerClient();
  const scannedAt = new Date().toISOString();
  const errors: string[] = [];
  const perCategory: Record<Category, EnrichedCandidate[]> = {
    momentum: [],
    recovery: [],
    theme: [],
    social: [],
  };

  if (requested === "all") {
    // Run all 4 sequentially (Perplexity rate limits favor it).
    const momentumRaw = await runQuery(PROMPT_MOMENTUM, "momentum", "momentum");
    const recoveryRaw = await runQuery(PROMPT_RECOVERY, "recovery", "recovery");
    const themeRaw = await runQuery(PROMPT_THEMES, "theme", "themes");
    const socialRaw = await runQuery(PROMPT_SOCIAL, "social", "social");

    // Dedupe across the union — momentum > recovery > theme > social.
    const unique = dedupeBySymbol([
      ...momentumRaw,
      ...recoveryRaw,
      ...themeRaw,
      ...socialRaw,
    ]);
    if (unique.length === 0) {
      return NextResponse.json(
        {
          error:
            "No candidates returned — Perplexity may be unavailable or the model produced no parseable output.",
        },
        { status: 502 },
      );
    }
    const enriched = await enrichCandidates(unique);
    const filtered = enriched.filter(applyFloor);
    for (const c of filtered) perCategory[c.category].push(c);

    // Persist 4 per-category rows.
    for (const cat of SCANNABLE) {
      const err = await persistCategoryRow(sb, cat, perCategory[cat], scannedAt);
      if (err) errors.push(err);
      await appendScanHistory(sb, cat, perCategory[cat], scannedAt);
    }
    // Drop any pre-migration row tagged 'all' — its data is now split
    // into per-category rows and we don't want it to shadow them.
    await clearLegacyAllRow(sb);
  } else {
    const filtered = await scanCategory(requested);
    perCategory[requested] = filtered;
    if (filtered.length === 0) {
      return NextResponse.json(
        {
          error: `No ${requested} candidates returned — Perplexity may be unavailable or the model produced no parseable output.`,
        },
        { status: 502 },
      );
    }
    const err = await persistCategoryRow(sb, requested, filtered, scannedAt);
    if (err) errors.push(err);
    await appendScanHistory(sb, requested, filtered, scannedAt);
  }

  if (errors.length > 0) {
    console.warn(`[swings/discover] persist errors: ${errors.join("; ")}`);
  }

  // Pull scan history once after the new rows have been written, so the
  // returned candidates reflect their up-to-date appearance counts (the
  // scan we just ran is included).
  const seenMap = await loadSeenMap(sb);
  const perCategorySeen: Record<Category, SeenAttached[]> = {
    momentum: attachSeen(perCategory.momentum, "momentum", seenMap),
    recovery: attachSeen(perCategory.recovery, "recovery", seenMap),
    theme: attachSeen(perCategory.theme, "theme", seenMap),
    social: attachSeen(perCategory.social, "social", seenMap),
  };

  // Per-category response: each scanned slot gets the new scannedAt.
  const perCategoryResponse: Record<
    Category,
    { candidates: SeenAttached[]; scanned_at: string }
  > = {} as Record<
    Category,
    { candidates: SeenAttached[]; scanned_at: string }
  >;
  for (const cat of SCANNABLE) {
    if (requested === "all" || requested === cat) {
      perCategoryResponse[cat] = {
        candidates: perCategorySeen[cat],
        scanned_at: scannedAt,
      };
    }
  }

  // Flat candidates: union for "all", just the scanned category for partial.
  const flat: SeenAttached[] =
    requested === "all"
      ? SCANNABLE.flatMap((c) => perCategorySeen[c])
      : perCategorySeen[requested];

  return NextResponse.json({
    category: requested,
    scanned_at: scannedAt,
    candidates: flat,
    per_category: perCategoryResponse,
    counts: {
      momentum: perCategory.momentum.length,
      recovery: perCategory.recovery.length,
      theme: perCategory.theme.length,
      social: perCategory.social.length,
      total: flat.length,
    },
  });
}

// ------------------------------------------------------------
// GET — assemble per-category snapshots from persisted rows.
// Backward compat: if a pre-migration row exists with category='all'
// (or anything outside the scannable set), we split its candidates
// across the per-category buckets on read so the user keeps seeing
// data until they trigger their first new scan.
// ------------------------------------------------------------

type ScanRow = {
  category?: string | null;
  scanned_at: string;
  candidates: EnrichedCandidate[];
};

export async function GET() {
  const sb = createServerClient();
  // Use select("*") instead of explicit columns so the read still works
  // before the user has run ALTER TABLE ADD COLUMN category. Pre-migration
  // rows fall through to the "legacy" branch below and get split by their
  // candidate-level `category` field.
  const res = await sb
    .from("swing_scan_results")
    .select("*")
    .order("scanned_at", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as ScanRow[];

  // Newest row per category (rows are already sorted desc).
  const perCategoryRow: Record<Category, ScanRow | null> = {
    momentum: null,
    recovery: null,
    theme: null,
    social: null,
  };
  let legacyAll: ScanRow | null = null;
  for (const row of rows) {
    const cat = row.category;
    if (
      cat === "momentum" ||
      cat === "recovery" ||
      cat === "theme" ||
      cat === "social"
    ) {
      if (!perCategoryRow[cat]) perCategoryRow[cat] = row;
    } else if (!legacyAll) {
      // 'all', null, or any pre-migration value — keep the newest.
      legacyAll = row;
    }
  }

  // Backfill missing per-category buckets from the legacy 'all' row.
  if (legacyAll) {
    for (const cat of SCANNABLE) {
      if (perCategoryRow[cat]) continue;
      const subset = (legacyAll.candidates ?? []).filter(
        (c) => c.category === cat,
      );
      if (subset.length > 0) {
        perCategoryRow[cat] = {
          category: cat,
          scanned_at: legacyAll.scanned_at,
          candidates: subset,
        };
      }
    }
  }

  // Pull aggregated history before assembling the response so each
  // candidate carries appearance_count / first_seen_at / last_seen_at.
  const seenMap = await loadSeenMap(sb);

  // Build response.
  const perCategory: Record<
    Category,
    { candidates: SeenAttached[]; scanned_at: string | null }
  > = {
    momentum: { candidates: [], scanned_at: null },
    recovery: { candidates: [], scanned_at: null },
    theme: { candidates: [], scanned_at: null },
    social: { candidates: [], scanned_at: null },
  };
  const merged: SeenAttached[] = [];
  const seen = new Set<string>();
  for (const cat of SCANNABLE) {
    const row = perCategoryRow[cat];
    const attached = attachSeen(row?.candidates ?? [], cat, seenMap);
    perCategory[cat] = {
      candidates: attached,
      scanned_at: row?.scanned_at ?? null,
    };
    for (const c of attached) {
      if (seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      merged.push(c);
    }
  }

  // Newest scanned_at across all categories — kept as the top-level
  // `scanned_at` so older clients reading just that field still work.
  const newest = SCANNABLE.map((c) => perCategory[c].scanned_at)
    .filter((s): s is string => s !== null)
    .sort()
    .pop() ?? null;

  return NextResponse.json({
    candidates: merged,
    scanned_at: newest,
    per_category: perCategory,
  });
}
