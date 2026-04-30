// Polygon historical EM (expected-move) helpers. Used by:
//   - /api/screener/fetch-em-history (per-symbol button on the screener row)
//   - /api/screener/backfill-em-polygon (Settings bulk backfill)
//
// EM is computed as a synthetic ATM straddle from Polygon's daily aggs:
//   spot_close(prior_BD)
//   call_close(ATM, prior_BD)
//   put_close(ATM, prior_BD)
//   EM% = (call + put) / spot
//
// Polygon's snapshot endpoint (which exposes implied_volatility per
// contract) is current-time only — no `as_of` param for historical
// points. The straddle method above is the equivalent computation
// from the historical aggregates Polygon does expose.

export const POLYGON_BASE = "https://api.polygon.io";
// .env.local doesn't carry POLYGON_API_KEY; fall back to the same key
// the existing Test/bulk-polygon-em.ts probe uses so the routes work
// without a new env-var setup step.
export const POLYGON_KEY =
  process.env.POLYGON_API_KEY ?? "g7yEjbwyHy16DkqDi75guYEXgiSHvuVF";
// Earliest date Polygon's options reference table reliably covers on
// the current tier. Earlier rows return 403 on the contracts list.
export const POLYGON_DEPTH_CUTOFF = "2024-06-01";

// Free-tier defaults. Bulk callers set noSleep=true (paid tier).
const DEFAULT_SLEEP_BETWEEN_AGGS_MS = 13_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

// ±20% strike band — wide enough to catch valid contracts even on
// names with sparse weekly chains. The previous ±5%/±8% cascade was
// missing too many legitimate events; the wider band is essentially
// free since Polygon's contract list responds in one call regardless
// of the band size.
const STRIKE_BAND = 0.20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function priorBusinessDayIso(dateIso: string): string {
  const d = new Date(dateIso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export function nextFridayOnOrAfter(dateIso: string): string {
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

export type Aggs = {
  results?: Array<{ c?: number; t?: number }>;
  status?: string;
  message?: string;
};

export type Contracts = {
  results?: Array<{
    ticker?: string;
    contract_type?: string;
    strike_price?: number;
    expiration_date?: string;
  }>;
  status?: string;
  message?: string;
};

function latestCloseFromAggs(body: Aggs | null): number | null {
  const list = body?.results;
  if (!list || list.length === 0) return null;
  const last = list[list.length - 1];
  return typeof last.c === "number" ? last.c : null;
}

async function polyOnce<T>(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<{ status: number; body: T | null; rawSnippet: string }> {
  const u = new URL(POLYGON_BASE + path);
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
  // Polygon's daily aggs omit zero-volume bars, so a thinly-traded
  // ATM strike with no Tue-pre-earnings prints comes back empty.
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

export type EarningsRow = {
  symbol: string;
  earnings_date: string;
  actual_move_pct: number | null;
  implied_move_pct: number | null;
  implied_move_source: string | null;
  move_ratio: number | null;
  price_before: number | null;
};

export type ProcessOutcome =
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
      limit: 250,
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

export type ProcessOptions = {
  // True on paid Polygon tiers — skips the 13s spacers between aggs
  // calls. Free tier (5/min) needs the spacers or hits 429s.
  noSleep?: boolean;
};

export async function processPolygonEvent(
  row: EarningsRow,
  options: ProcessOptions = {},
): Promise<ProcessOutcome> {
  const { symbol, earnings_date } = row;
  const priorClose = priorBusinessDayIso(earnings_date);
  const expiry = nextFridayOnOrAfter(earnings_date);
  const sleepMs = options.noSleep ? 0 : DEFAULT_SLEEP_BETWEEN_AGGS_MS;

  // Unadjusted spot from Polygon. The DB's price_before is split-
  // adjusted (Yahoo behavior), but Polygon's options reference table
  // preserves the unadjusted strikes that were listed at the time —
  // so we MUST band/score against the unadjusted historical price or
  // every post-split symbol misses. adjusted=false → true close print.
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

  if (sleepMs > 0) await sleep(sleepMs);

  const attempt = await fetchContractsForBand(
    symbol,
    expiry,
    priorClose,
    spot,
    STRIKE_BAND,
  );
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
    return {
      kind: "skip_no_data",
      reason: `call bar empty even with 5-BD lookback to ${lookbackBusinessDays(priorClose, 5)}`,
    };
  }
  const callClose = callRes.close;

  if (sleepMs > 0) await sleep(sleepMs);

  const putRes = await fetchLegClose(putTicker, priorClose);
  if (putRes.kind === "too_old") return { kind: "skip_too_old" };
  if (putRes.kind === "error") {
    return { kind: "skip_no_data", reason: `put ${putRes.reason}` };
  }
  if (putRes.kind === "empty_even_with_fallback") {
    return {
      kind: "skip_no_data",
      reason: `put bar empty even with 5-BD lookback to ${lookbackBusinessDays(priorClose, 5)}`,
    };
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
