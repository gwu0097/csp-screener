import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  gradeFromRatio,
  type CrushHistoryEvent,
} from "@/lib/earnings-history-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Polygon's free tier caps aggs at 5/min. Each event makes 2 aggs
// calls (call leg + put leg) with a 13 s spacer between, so wall
// clock per event ≈ 27 s. Vercel Hobby caps at 60 s, so we cap the
// per-invocation event count at 2 and let the client auto-loop the
// route until remainingMissing hits 0.
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
const EVENTS_PER_CALL = 2;
const STRIKE_BAND = 0.05;

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
  results?: Array<{ c?: number }>;
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

type ProcessOutcome =
  | { kind: "populated"; emPct: number; strike: number }
  | { kind: "skip_too_old" }
  | { kind: "skip_no_contracts"; reason: string }
  | { kind: "skip_no_data"; reason: string }
  | { kind: "error"; reason: string };

async function processEvent(row: EarningsRow): Promise<ProcessOutcome> {
  const { symbol, earnings_date } = row;
  const spot = row.price_before;
  if (spot === null || !Number.isFinite(spot) || spot <= 0) {
    return { kind: "skip_no_data", reason: "price_before missing" };
  }
  const priorClose = priorBusinessDayIso(earnings_date);
  const expiry = nextFridayOnOrAfter(earnings_date);

  const lo = Math.floor(spot * (1 - STRIKE_BAND));
  const hi = Math.ceil(spot * (1 + STRIKE_BAND));
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
  if (contracts.status === 403) return { kind: "skip_too_old" };
  if (contracts.status !== 200) {
    return {
      kind: "error",
      reason: `contracts list status=${contracts.status} ${contracts.body?.message ?? contracts.rawSnippet}`,
    };
  }
  const list = contracts.body?.results ?? [];
  if (list.length === 0) {
    return {
      kind: "skip_no_contracts",
      reason: `no contracts in $${lo}-$${hi} band on ${expiry}`,
    };
  }
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

  const callBar = await poly<Aggs>(
    `/v2/aggs/ticker/${encodeURIComponent(callTicker)}/range/1/day/${priorClose}/${priorClose}`,
  );
  if (callBar.status === 403) return { kind: "skip_too_old" };
  if (callBar.status !== 200 || callBar.body?.results?.[0]?.c === undefined) {
    return {
      kind: "skip_no_data",
      reason: `call bar status=${callBar.status}`,
    };
  }
  const callClose = callBar.body.results[0].c as number;

  await sleep(SLEEP_BETWEEN_AGGS_MS);

  const putBar = await poly<Aggs>(
    `/v2/aggs/ticker/${encodeURIComponent(putTicker)}/range/1/day/${priorClose}/${priorClose}`,
  );
  if (putBar.status === 403) return { kind: "skip_too_old" };
  if (putBar.status !== 200 || putBar.body?.results?.[0]?.c === undefined) {
    return {
      kind: "skip_no_data",
      reason: `put bar status=${putBar.status}`,
    };
  }
  const putClose = putBar.body.results[0].c as number;

  await sleep(SLEEP_BETWEEN_AGGS_MS);

  const straddle = callClose + putClose;
  return { kind: "populated", emPct: straddle / spot, strike: atm };
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
  const r = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
    )
    .eq("symbol", symbol)
    .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
    .order("earnings_date", { ascending: false });
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const rows = (r.data ?? []) as EarningsRow[];
  const targets = rows.filter(
    (row) =>
      row.actual_move_pct !== null && row.implied_move_pct === null,
  );

  // No more than EVENTS_PER_CALL processed per invocation — keeps
  // total wall-clock under the 60 s ceiling. The client loops the
  // route until remainingMissing === 0.
  const slice = targets.slice(0, EVENTS_PER_CALL);
  let populated = 0;
  let skipped = 0;
  const messages: string[] = [];

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
          `${row.earnings_date}: EM=${(outcome.emPct * 100).toFixed(2)}% @ strike $${outcome.strike}`,
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
