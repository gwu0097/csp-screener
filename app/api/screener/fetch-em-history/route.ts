import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  gradeFromRatio,
  type CrushHistoryEvent,
} from "@/lib/earnings-history-table";
import {
  getFinnhubEarningsPeriods,
} from "@/lib/earnings";
import {
  fetchYahooPriceAction,
  updateEncyclopedia,
} from "@/lib/encyclopedia";
import { getYahooPastAnnouncements } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Polygon's free tier caps aggs at 5/min. Each event now makes 3 aggs
// calls (unadjusted spot + call leg + put leg) with 13 s spacers, so
// wall-clock per event ≈ 40 s. Vercel Hobby caps at 60 s, so we cap
// the per-invocation event count at 1 and let the client auto-loop
// the route until remainingMissing hits 0.
export const maxDuration = 60;

const POLY_BASE = "https://api.polygon.io";
// .env.local doesn't carry POLYGON_API_KEY (the app routes never
// needed it before this); fall back to the same key the existing
// Test/bulk-polygon-em.ts probe uses so the button works without a
// new env-var setup step. Hard-cap is the same Polygon free-tier
// account either way.
const POLYGON_KEY =
  process.env.POLYGON_API_KEY ?? "g7yEjbwyHy16DkqDi75guYEXgiSHvuVF";
const POLYGON_DEPTH_CUTOFF = "2024-06-01";
const SLEEP_BETWEEN_AGGS_MS = 13_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const EVENTS_PER_CALL = 1;
// Primary strike band ±5% (matches bulk-polygon-em.ts default for the
// HOOD-style reruns) with an ±8% fallback for high-priced names where
// strikes are wider — e.g. BKNG-class tickers where the ±5% band can
// land between listed strikes when only the third-Friday weekly is
// listed for that earnings week.
const STRIKE_BAND_PRIMARY = 0.05;
const STRIKE_BAND_FALLBACK = 0.08;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function priorBusinessDayIso(dateIso: string): string {
  const d = new Date(dateIso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

function nextFridayOnOrAfter(dateIso: string): string {
  const d = new Date(dateIso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  const dow = d.getUTCDay();
  const delta = (5 - dow + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function lookbackBusinessDays(dateIso: string, n: number): string {
  const d = new Date(dateIso + "T12:00:00Z");
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d.toISOString().slice(0, 10);
}

// Pull the latest valid close from a Polygon aggs response. Polygon
// returns ascending by `t`, so the last entry is the most recent.
function latestCloseFromAggs(body: Aggs | null): number | null {
  const list = body?.results;
  if (!list || list.length === 0) return null;
  const last = list[list.length - 1];
  return typeof last.c === "number" ? last.c : null;
}

function quarterLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

type EarningsRow = {
  symbol: string;
  earnings_date: string;
  actual_move_pct: number | null;
  implied_move_pct: number | null;
  implied_move_source: string | null;
  move_ratio: number | null;
  price_before: number | null;
};

type Aggs = {
  results?: Array<{ c?: number; t?: number }>;
  status?: string;
  message?: string;
};

type Contracts = {
  results?: Array<{
    ticker?: string;
    contract_type?: string;
    strike_price?: number;
    expiration_date?: string;
  }>;
  status?: string;
  message?: string;
};

async function polyOnce<T>(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<{ status: number; body: T | null; rawSnippet: string }> {
  const u = new URL(POLY_BASE + path);
  u.searchParams.set("apiKey", POLYGON_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString());
  const text = await res.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    /* leave body null */
  }
  return { status: res.status, body, rawSnippet: text.slice(0, 240) };
}

async function poly<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ status: number; body: T | null; rawSnippet: string }> {
  let r = await polyOnce<T>(path, params);
  if (r.status === 429) {
    await sleep(RATE_LIMIT_BACKOFF_MS);
    r = await polyOnce<T>(path, params);
  }
  return r;
}

// Single-day option close with a 5-business-day range fallback for
// thinly traded strikes. Polygon's daily aggs omit zero-volume bars
// entirely, so an ATM strike with no Tue-pre-earnings prints comes
// back status=200, results=[]. Falling back to a 5-BD range and
// taking the latest available close keeps the EM% computable; cost
// is one extra aggs call only when the single-day is empty.
type LegFetch =
  | { kind: "ok"; close: number; usedFallback: boolean }
  | { kind: "too_old" }
  | { kind: "empty_even_with_fallback" }
  | { kind: "error"; reason: string };

async function fetchLegClose(
  ticker: string,
  priorClose: string,
): Promise<LegFetch> {
  const single = await poly<Aggs>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${priorClose}/${priorClose}`,
    { adjusted: "false" },
  );
  if (single.status === 403) return { kind: "too_old" };
  if (single.status !== 200) {
    return {
      kind: "error",
      reason: `bar status=${single.status} ${single.body?.message ?? single.rawSnippet}`,
    };
  }
  if (single.body?.results?.[0]?.c !== undefined) {
    return { kind: "ok", close: single.body.results[0].c as number, usedFallback: false };
  }
  // Single-day empty — retry with a 5-business-day lookback range.
  const start = lookbackBusinessDays(priorClose, 5);
  const range = await poly<Aggs>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${start}/${priorClose}`,
    { adjusted: "false" },
  );
  if (range.status === 403) return { kind: "too_old" };
  if (range.status !== 200) {
    return {
      kind: "error",
      reason: `range status=${range.status} ${range.body?.message ?? range.rawSnippet}`,
    };
  }
  const close = latestCloseFromAggs(range.body);
  if (close === null) return { kind: "empty_even_with_fallback" };
  return { kind: "ok", close, usedFallback: true };
}

type ProcessOutcome =
  | { kind: "populated"; emPct: number; strike: number; usedFallback: boolean }
  | { kind: "skip_too_old" }
  | { kind: "skip_no_contracts"; reason: string }
  | { kind: "skip_no_data"; reason: string }
  | { kind: "error"; reason: string };

type ContractsAttempt =
  | { kind: "ok"; list: NonNullable<Contracts["results"]>; band: number; lo: number; hi: number }
  | { kind: "too_old" }
  | { kind: "error"; reason: string }
  | { kind: "empty"; band: number; lo: number; hi: number };

async function fetchContractsForBand(
  symbol: string,
  expiry: string,
  priorClose: string,
  spot: number,
  band: number,
): Promise<ContractsAttempt> {
  const lo = Math.floor(spot * (1 - band));
  const hi = Math.ceil(spot * (1 + band));
  const contracts = await poly<Contracts>(
    `/v3/reference/options/contracts`,
    {
      underlying_ticker: symbol,
      expiration_date: expiry,
      "strike_price.gte": lo,
      "strike_price.lte": hi,
      contract_type: "call",
      as_of: priorClose,
      limit: 50,
    },
  );
  if (contracts.status === 403) return { kind: "too_old" };
  if (contracts.status !== 200) {
    return {
      kind: "error",
      reason: `contracts list status=${contracts.status} ${contracts.body?.message ?? contracts.rawSnippet}`,
    };
  }
  const list = contracts.body?.results ?? [];
  if (list.length === 0) return { kind: "empty", band, lo, hi };
  return { kind: "ok", list, band, lo, hi };
}

async function processEvent(row: EarningsRow): Promise<ProcessOutcome> {
  const { symbol, earnings_date } = row;
  const priorClose = priorBusinessDayIso(earnings_date);
  const expiry = nextFridayOnOrAfter(earnings_date);

  // Fetch the unadjusted close from Polygon as our spot. The DB's
  // price_before is split-adjusted (Yahoo behavior), but Polygon's
  // options reference table preserves the unadjusted strikes that
  // were listed at that time — so we MUST band/score against the
  // unadjusted historical price or every post-split symbol misses.
  // adjusted=false makes Polygon return the true closing print.
  const spotBar = await poly<Aggs>(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${priorClose}/${priorClose}`,
    { adjusted: "false" },
  );
  if (spotBar.status === 403) return { kind: "skip_too_old" };
  if (spotBar.status !== 200 || spotBar.body?.results?.[0]?.c === undefined) {
    return {
      kind: "skip_no_data",
      reason: `unadjusted spot bar status=${spotBar.status} ${spotBar.body?.message ?? "(no body)"}`,
    };
  }
  const spot = spotBar.body.results[0].c as number;
  if (!Number.isFinite(spot) || spot <= 0) {
    return { kind: "skip_no_data", reason: "spot from polygon non-positive" };
  }

  await sleep(SLEEP_BETWEEN_AGGS_MS);

  // Try the ±5% band first; fall back to ±8% if no listed strikes
  // landed inside (high-priced names with wide strike spacing).
  let attempt = await fetchContractsForBand(
    symbol,
    expiry,
    priorClose,
    spot,
    STRIKE_BAND_PRIMARY,
  );
  if (attempt.kind === "empty") {
    attempt = await fetchContractsForBand(
      symbol,
      expiry,
      priorClose,
      spot,
      STRIKE_BAND_FALLBACK,
    );
  }
  if (attempt.kind === "too_old") return { kind: "skip_too_old" };
  if (attempt.kind === "error") {
    return { kind: "error", reason: attempt.reason };
  }
  if (attempt.kind === "empty") {
    return {
      kind: "skip_no_contracts",
      reason: `no contracts in $${attempt.lo}-$${attempt.hi} band (±${(attempt.band * 100).toFixed(0)}%) on ${expiry}`,
    };
  }
  const list = attempt.list;
  const strikes = list
    .map((c) => c.strike_price)
    .filter((s): s is number => typeof s === "number");
  const atm = strikes.reduce(
    (best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best),
    strikes[0],
  );
  const callTicker = list.find((c) => c.strike_price === atm)?.ticker ?? null;
  const putTicker = callTicker?.replace(/C(\d{8})$/, "P$1") ?? null;
  if (!callTicker || !putTicker) {
    return {
      kind: "skip_no_contracts",
      reason: `couldn't derive call/put pair at strike $${atm}`,
    };
  }

  const callRes = await fetchLegClose(callTicker, priorClose);
  if (callRes.kind === "too_old") return { kind: "skip_too_old" };
  if (callRes.kind === "error") {
    return { kind: "skip_no_data", reason: `call ${callRes.reason}` };
  }
  if (callRes.kind === "empty_even_with_fallback") {
    return { kind: "skip_no_data", reason: `call bar empty even with 5-BD lookback to ${lookbackBusinessDays(priorClose, 5)}` };
  }
  const callClose = callRes.close;

  await sleep(SLEEP_BETWEEN_AGGS_MS);

  const putRes = await fetchLegClose(putTicker, priorClose);
  if (putRes.kind === "too_old") return { kind: "skip_too_old" };
  if (putRes.kind === "error") {
    return { kind: "skip_no_data", reason: `put ${putRes.reason}` };
  }
  if (putRes.kind === "empty_even_with_fallback") {
    return { kind: "skip_no_data", reason: `put bar empty even with 5-BD lookback to ${lookbackBusinessDays(priorClose, 5)}` };
  }
  const putClose = putRes.close;

  const straddle = callClose + putClose;
  return {
    kind: "populated",
    emPct: straddle / spot,
    strike: atm,
    usedFallback: callRes.usedFallback || putRes.usedFallback,
  };
}

// Seeds historical earnings_history rows when the table has no
// actual_move_pct events for the symbol. Tries Finnhub /stock/earnings
// first (which gives fiscal quarter-end periods that updateEncyclopedia
// then maps to real announcement dates via Yahoo), then falls back to
// Yahoo's earningsChart.quarterly[].reportedDate when Finnhub returns
// nothing. Either path computes actual move % from Yahoo price bars.
type SeedReport = {
  finnhubPeriods: number;
  yahooDates: number;
  rowsAdded: number;
  source: "finnhub" | "yahoo" | "none";
  detail: string;
};

async function seedHistoricalRows(symbol: string): Promise<SeedReport> {
  const sb = createServerClient();
  const finnhubPeriods = await getFinnhubEarningsPeriods(symbol);
  if (finnhubPeriods.length > 0) {
    try {
      const summary = await updateEncyclopedia(symbol);
      return {
        finnhubPeriods: finnhubPeriods.length,
        yahooDates: 0,
        rowsAdded: summary.newRecords + summary.updatedRecords,
        source: "finnhub",
        detail: `finnhub returned ${finnhubPeriods.length} periods; encyclopedia ingest added ${summary.newRecords} new + ${summary.updatedRecords} updated`,
      };
    } catch (e) {
      console.warn(
        `[fetch-em] seed via Finnhub/encyclopedia failed for ${symbol}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Yahoo fallback: pull announcement dates directly, then compute
  // actual move % from Yahoo bars and upsert into earnings_history.
  const yahooAnnouncements = await getYahooPastAnnouncements(symbol);
  if (yahooAnnouncements.length === 0) {
    return {
      finnhubPeriods: finnhubPeriods.length,
      yahooDates: 0,
      rowsAdded: 0,
      source: "none",
      detail: `finnhub=${finnhubPeriods.length} periods; yahoo=0 announcements — nothing to seed`,
    };
  }

  let added = 0;
  for (const ann of yahooAnnouncements) {
    const price = await fetchYahooPriceAction(symbol, ann.iso);
    const payload: Record<string, unknown> = {
      symbol,
      earnings_date: ann.iso,
      price_before: price.price_before,
      price_after: price.price_after,
      price_at_expiry: price.price_at_expiry,
      actual_move_pct: price.actual_move_pct,
      data_source: "yahoo",
      is_complete:
        price.price_before !== null && price.price_after !== null,
    };
    const up = await sb
      .from("earnings_history")
      .upsert(payload, { onConflict: "symbol,earnings_date" });
    if (up.error) {
      console.warn(
        `[fetch-em] yahoo seed upsert failed for ${symbol}@${ann.iso}: ${up.error.message}`,
      );
      continue;
    }
    added += 1;
  }
  return {
    finnhubPeriods: finnhubPeriods.length,
    yahooDates: yahooAnnouncements.length,
    rowsAdded: added,
    source: "yahoo",
    detail: `finnhub=${finnhubPeriods.length} periods; yahoo=${yahooAnnouncements.length} announcements; upserted ${added} rows`,
  };
}

type Body = { symbol?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbol =
    typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  console.log(
    `[fetch-em] symbol: ${symbol} key exists: ${!!process.env.POLYGON_API_KEY} using fallback: ${!process.env.POLYGON_API_KEY}`,
  );

  const sb = createServerClient();
  // Pull every row for the symbol in the Polygon window — we need
  // the full list both to pick targets and to recompute the crush
  // events the UI consumes.
  const initialRead = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
    )
    .eq("symbol", symbol)
    .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
    .order("earnings_date", { ascending: false });
  if (initialRead.error) {
    return NextResponse.json({ error: initialRead.error.message }, { status: 500 });
  }
  let rows = (initialRead.data ?? []) as EarningsRow[];

  // Seed step. If we have fewer than 3 historical rows with an actual
  // move, the polygon EM-populate step has nothing to chew on. Seed
  // historical events from Finnhub (preferred) or Yahoo (fallback)
  // before computing targets so the button can recover from a cold
  // earnings_history table.
  const historicalCount = rows.filter(
    (row) => row.actual_move_pct !== null,
  ).length;
  let seedReport: SeedReport | null = null;
  let seededThisCall = false;
  if (historicalCount < 3) {
    seedReport = await seedHistoricalRows(symbol);
    console.log(
      `[fetch-em] seed ${symbol}: ${seedReport.detail}`,
    );
    if (seedReport.rowsAdded > 0) {
      seededThisCall = true;
      const reread = await sb
        .from("earnings_history")
        .select(
          "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
        )
        .eq("symbol", symbol)
        .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
        .order("earnings_date", { ascending: false });
      if (!reread.error) {
        rows = (reread.data ?? []) as EarningsRow[];
      }
    }
  }

  const targets = rows.filter(
    (row) =>
      row.actual_move_pct !== null && row.implied_move_pct === null,
  );

  // No more than EVENTS_PER_CALL processed per invocation — keeps
  // total wall-clock under the 60 s ceiling. The client loops the
  // route until remainingMissing === 0. When we just seeded fresh
  // historical rows we skip polygon this iteration to leave headroom
  // under the 60 s cap; the client's loop will pick up the new
  // targets on the next call.
  const slice = seededThisCall ? [] : targets.slice(0, EVENTS_PER_CALL);
  let populated = seededThisCall ? (seedReport?.rowsAdded ?? 0) : 0;
  let skipped = 0;
  const messages: string[] = [];
  if (seedReport) {
    messages.push(`seed (${seedReport.source}): ${seedReport.detail}`);
  }

  for (const row of slice) {
    let outcome: ProcessOutcome;
    try {
      outcome = await processEvent(row);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[fetch-em] ${symbol} ${row.earnings_date} threw:`, e);
      outcome = { kind: "error", reason };
    }
    if (outcome.kind === "error" || outcome.kind === "skip_no_contracts" || outcome.kind === "skip_no_data") {
      console.log(
        `[fetch-em] ${symbol} ${row.earnings_date} ${outcome.kind}: ${"reason" in outcome ? outcome.reason : ""}`,
      );
    }
    if (outcome.kind === "populated") {
      const upd = await sb
        .from("earnings_history")
        .update({
          implied_move_pct: outcome.emPct,
          implied_move_source: "polygon",
        })
        .eq("symbol", symbol)
        .eq("earnings_date", row.earnings_date);
      if (upd.error) {
        messages.push(`${row.earnings_date}: DB write failed`);
      } else {
        populated += 1;
        messages.push(
          `${row.earnings_date}: EM=${(outcome.emPct * 100).toFixed(2)}% @ strike $${outcome.strike}${outcome.usedFallback ? " (used 5-BD fallback)" : ""}`,
        );
      }
    } else if (outcome.kind === "skip_too_old") {
      skipped += 1;
      messages.push(`${row.earnings_date}: outside 24-month window`);
    } else if (outcome.kind === "skip_no_contracts") {
      skipped += 1;
      messages.push(`${row.earnings_date}: ${outcome.reason}`);
    } else if (outcome.kind === "skip_no_data") {
      skipped += 1;
      messages.push(`${row.earnings_date}: ${outcome.reason}`);
    } else {
      skipped += 1;
      messages.push(`${row.earnings_date}: ${outcome.reason}`);
    }
  }

  // Re-fetch the full crush history so the client can drop-in
  // replace its rendered events list with the latest grades.
  const refreshed = await sb
    .from("earnings_history")
    .select(
      "earnings_date,implied_move_pct,actual_move_pct,move_ratio,implied_move_source",
    )
    .eq("symbol", symbol)
    .order("earnings_date", { ascending: false })
    .limit(8);
  const events: CrushHistoryEvent[] = ((refreshed.data ?? []) as Array<{
    earnings_date: string;
    implied_move_pct: number | null;
    actual_move_pct: number | null;
    move_ratio: number | null;
    implied_move_source: string | null;
  }>).map((row) => {
    const ratio =
      row.move_ratio ??
      (row.actual_move_pct !== null &&
      row.implied_move_pct !== null &&
      row.implied_move_pct > 0
        ? Math.abs(row.actual_move_pct) / row.implied_move_pct
        : null);
    return {
      earningsDate: row.earnings_date,
      qtrLabel: quarterLabel(row.earnings_date),
      impliedMovePct: row.implied_move_pct,
      actualMovePct: row.actual_move_pct,
      ratio,
      grade: gradeFromRatio(ratio),
      impliedMoveSource: row.implied_move_source,
    };
  });

  const remainingMissing = events.filter(
    (e) => e.actualMovePct !== null && e.impliedMovePct === null,
  ).length;

  console.log(
    `[fetch-em-history] ${symbol}: populated=${populated} skipped=${skipped} remaining=${remainingMissing} (processed ${slice.length}/${targets.length})`,
  );

  return NextResponse.json({
    populated,
    skipped,
    remainingMissing,
    processed: slice.length,
    totalMissingAtStart: targets.length,
    events,
    messages,
  });
}
