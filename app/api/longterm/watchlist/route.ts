// Long-term portfolio watchlist API. The DB row stores symbol +
// allocation + notes; live Yahoo quote enrichment is layered on at
// request time so the table doesn't have to be rebuilt every market
// tick. PATCH/DELETE accept id in body / ?id= per the spec — the
// /longterm/ideas route uses a per-id subpath; here we keep all four
// verbs on one file because the watchlist row shape is narrower.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getHistoricalPrices, getQuoteEnrichment } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOCATIONS = ["Large", "Medium", "Small"] as const;
type Allocation = (typeof ALLOCATIONS)[number];

type WatchlistRow = {
  id: string;
  symbol: string;
  allocation: Allocation;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type AiSignal = "Bull" | "Neutral" | "Bear";
type Action = "TAKE_PROFIT" | "DCA" | "CUT" | "HOLD";

type EnrichedRow = WatchlistRow & {
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  twoHundredDayAverage: number | null;
  pctVs200dSma: number | null;
  momentum3mPct: number | null;
  aiSignal: AiSignal;
  aiScore: number;
  action: Action;
  hasEncyclopedia: boolean;
};

type Alert = {
  kind: "big_move" | "falling_knife" | "extended";
  symbol: string;
  message: string;
};

// Pure scorer — server-computed so the badge is stable across browser
// reloads and so the rule cascade is auditable in one place. Returns
// the final signal plus the underlying integer score for debugging.
function computeAiSignal(input: {
  pegRatio: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  pctVs200dSma: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
}): { aiSignal: AiSignal; aiScore: number } {
  let score = 0;

  // Valuation
  const peg = input.pegRatio;
  if (peg !== null) {
    if (peg < 1.0) score += 2;
    else if (peg < 1.5) score += 1;
    else if (peg < 2.0) score += 0;
    else score -= 1;
  }
  const pe = input.trailingPE;
  if (pe !== null) {
    if (pe < 15) score += 1;
    else if (pe > 40) score -= 1;
  }
  const fwd = input.forwardPE;
  if (pe !== null && fwd !== null) {
    if (fwd < pe) score += 1;
    else if (fwd > pe) score -= 1;
  }

  // Momentum
  const sma = input.pctVs200dSma;
  if (sma !== null) {
    if (sma > 5) score += 1;
    else if (sma < -10) score -= 1;
  }
  const off52 = input.pctFromFiftyTwoWeekHigh;
  if (off52 !== null) {
    if (off52 < -50) score -= 1;
    else if (off52 > -10) score += 1;
  }

  const aiSignal: AiSignal =
    score >= 2 ? "Bull" : score <= -1 ? "Bear" : "Neutral";
  return { aiSignal, aiScore: score };
}

// Action signal — order of evaluation matches severity. CUT first
// (most actionable warning), then DCA (opportunity), then TAKE_PROFIT
// (extended), else HOLD. Each rule needs every input non-null to fire
// — a missing fundamentals signal collapses to HOLD instead of false
// positives.
function computeAction(input: {
  pctFromFiftyTwoWeekHigh: number | null;
  pctVs200dSma: number | null;
  momentum3mPct: number | null;
  trailingPE: number | null;
  pegRatio: number | null;
}): Action {
  const offHigh = input.pctFromFiftyTwoWeekHigh;
  const sma = input.pctVs200dSma;
  const mom = input.momentum3mPct;
  const pe = input.trailingPE;
  const peg = input.pegRatio;

  // CUT — falling knife: deep drawdown, below 200d, still decaying.
  if (
    offHigh !== null && offHigh < -50 &&
    sma !== null && sma < -20 &&
    mom !== null && mom < -20
  ) {
    return "CUT";
  }
  // DCA — 30%+ off highs, fundamentals intact, not in freefall.
  if (
    offHigh !== null && offHigh < -30 &&
    peg !== null && peg < 2.5 &&
    sma !== null && sma > -25
  ) {
    return "DCA";
  }
  // TAKE_PROFIT — near 52w high AND (expensive OR very extended trend).
  if (
    offHigh !== null && offHigh > -10 &&
    ((pe !== null && pe > 35) || (sma !== null && sma > 20))
  ) {
    return "TAKE_PROFIT";
  }
  return "HOLD";
}

// Approx 90 calendar days back. Yahoo bars only land on trading days,
// so we ask for a slightly wider window and use the earliest close.
function ninetyDaysAgo(): Date {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
}

async function getMomentum3m(symbol: string): Promise<number | null> {
  try {
    const bars = await getHistoricalPrices(symbol, ninetyDaysAgo(), new Date());
    if (bars.length === 0) return null;
    const sorted = [...bars].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const earliest = sorted[0]?.close;
    const latest = sorted[sorted.length - 1]?.close;
    if (
      typeof earliest !== "number" ||
      typeof latest !== "number" ||
      earliest <= 0
    ) {
      return null;
    }
    return ((latest - earliest) / earliest) * 100;
  } catch {
    return null;
  }
}

const ALLOCATION_ORDER: Record<Allocation, number> = {
  Large: 0,
  Medium: 1,
  Small: 2,
};

// Live-enrich one row from Yahoo. Failures fall back to null fields
// so a single dead symbol doesn't blank the entire watchlist.
async function enrich(
  row: WatchlistRow,
  encyclopediaSet: Set<string>,
): Promise<EnrichedRow> {
  // Quote + 3-month historical run in parallel — saves ~half the
  // cold-load time per row (2-call symbols).
  const [quote, momentum3mPct] = await Promise.all([
    getQuoteEnrichment(row.symbol).catch((e) => {
      console.warn(
        `[watchlist] getQuoteEnrichment(${row.symbol}) threw: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }),
    getMomentum3m(row.symbol),
  ]);

  const price = quote?.regularMarketPrice ?? null;
  const sma200 = quote?.twoHundredDayAverage ?? null;
  const fiftyTwoWeekHigh = quote?.fiftyTwoWeekHigh ?? null;
  const pctFromFiftyTwoWeekHigh =
    price !== null && fiftyTwoWeekHigh !== null && fiftyTwoWeekHigh > 0
      ? ((price - fiftyTwoWeekHigh) / fiftyTwoWeekHigh) * 100
      : null;
  const pctVs200dSma =
    price !== null && sma200 !== null && sma200 > 0
      ? ((price - sma200) / sma200) * 100
      : null;
  const trailingPE = quote?.trailingPE ?? null;
  const forwardPE = quote?.forwardPE ?? null;
  const pegRatio = quote?.pegRatio ?? null;
  const { aiSignal, aiScore } = computeAiSignal({
    pegRatio,
    trailingPE,
    forwardPE,
    pctVs200dSma,
    pctFromFiftyTwoWeekHigh,
  });
  const action = computeAction({
    pctFromFiftyTwoWeekHigh,
    pctVs200dSma,
    momentum3mPct,
    trailingPE,
    pegRatio,
  });
  return {
    ...row,
    companyName: quote?.companyName ?? null,
    price,
    changePct: quote?.regularMarketChangePercent ?? null,
    fiftyTwoWeekLow: quote?.fiftyTwoWeekLow ?? null,
    fiftyTwoWeekHigh,
    pctFromFiftyTwoWeekHigh,
    marketCap: quote?.marketCap ?? null,
    trailingPE,
    forwardPE,
    pegRatio,
    twoHundredDayAverage: sma200,
    pctVs200dSma,
    momentum3mPct,
    aiSignal,
    aiScore,
    action,
    hasEncyclopedia: encyclopediaSet.has(row.symbol),
  };
}

// Pure alert builder — runs over the enriched list and returns the
// rows that match each rule. Same severity ordering as computeAction.
function buildAlerts(rows: EnrichedRow[]): Alert[] {
  const alerts: Alert[] = [];
  for (const r of rows) {
    // Big moves first so they sit at the top of the panel — they're
    // the most time-sensitive signal.
    if (r.changePct !== null && Math.abs(r.changePct) > 5) {
      const sign = r.changePct >= 0 ? "+" : "";
      alerts.push({
        kind: "big_move",
        symbol: r.symbol,
        message: `${r.symbol} moved ${sign}${r.changePct.toFixed(2)}% today.`,
      });
    }
    if (
      r.pctFromFiftyTwoWeekHigh !== null &&
      r.pctFromFiftyTwoWeekHigh < -50 &&
      r.momentum3mPct !== null &&
      r.momentum3mPct < 0
    ) {
      alerts.push({
        kind: "falling_knife",
        symbol: r.symbol,
        message: `${r.symbol} down ${Math.abs(r.pctFromFiftyTwoWeekHigh).toFixed(1)}% from highs and still falling (3M ${r.momentum3mPct.toFixed(1)}%) — review position.`,
      });
    }
    if (
      r.pctFromFiftyTwoWeekHigh !== null &&
      r.pctFromFiftyTwoWeekHigh > -5 &&
      r.trailingPE !== null &&
      r.trailingPE > 30
    ) {
      alerts.push({
        kind: "extended",
        symbol: r.symbol,
        message: `${r.symbol} near highs and expensive (P/E ${r.trailingPE.toFixed(1)}) — consider taking profits.`,
      });
    }
  }
  return alerts;
}

export async function GET() {
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .select("id,symbol,allocation,notes,created_at,updated_at");
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as WatchlistRow[];
  // Sort Large → Medium → Small, alphabetical within each group.
  rows.sort((a, b) => {
    const ao = ALLOCATION_ORDER[a.allocation] ?? 99;
    const bo = ALLOCATION_ORDER[b.allocation] ?? 99;
    if (ao !== bo) return ao - bo;
    return a.symbol.localeCompare(b.symbol);
  });
  // Pull the set of symbols that have an encyclopedia row so we can
  // flag the AI Signal badge with 📚. Cheap single-query lookup; runs
  // before the Yahoo pulls because the Set is needed inside enrich().
  const symbols = rows.map((r) => r.symbol);
  const encyclopediaSet = new Set<string>();
  if (symbols.length > 0) {
    const encRes = await sb
      .from("stock_encyclopedia")
      .select("symbol")
      .in("symbol", symbols);
    if (!encRes.error) {
      for (const r of (encRes.data ?? []) as Array<{ symbol: string }>) {
        encyclopediaSet.add(r.symbol);
      }
    } else {
      console.warn(
        `[watchlist] stock_encyclopedia lookup failed: ${encRes.error.message}`,
      );
    }
  }
  // Parallel Yahoo enrichment — keeps the cold-load under ~3s.
  const enriched = await Promise.all(
    rows.map((r) => enrich(r, encyclopediaSet)),
  );
  const alerts = buildAlerts(enriched);
  return NextResponse.json({ watchlist: enriched, alerts });
}

type CreateBody = { symbol?: unknown; allocation?: unknown; notes?: unknown };

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  const symbol = body.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  if (
    typeof body.allocation !== "string" ||
    !(ALLOCATIONS as readonly string[]).includes(body.allocation)
  ) {
    return NextResponse.json(
      { error: "allocation must be Large / Medium / Small" },
      { status: 400 },
    );
  }
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const sb = createServerClient();
  const ins = await sb
    .from("long_term_watchlist")
    .insert({ symbol, allocation: body.allocation as Allocation, notes })
    .select()
    .single();
  if (ins.error) {
    // Unique-violation on symbol comes back as 23505. Surface a clear
    // message so the UI can show "Already in watchlist".
    const status = ins.error.code === "23505" ? 409 : 400;
    return NextResponse.json(
      { error: ins.error.message },
      { status },
    );
  }
  return NextResponse.json({ row: ins.data });
}

type PatchBody = {
  id?: unknown;
  allocation?: unknown;
  notes?: unknown;
};

export async function PATCH(req: NextRequest) {
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.allocation !== undefined) {
    if (
      typeof body.allocation !== "string" ||
      !(ALLOCATIONS as readonly string[]).includes(body.allocation)
    ) {
      return NextResponse.json(
        { error: "allocation must be Large / Medium / Small" },
        { status: 400 },
      );
    }
    patch.allocation = body.allocation;
  }
  if (body.notes !== undefined) {
    patch.notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim()
        : null;
  }
  if (Object.keys(patch).length === 1) {
    return NextResponse.json(
      { error: "Nothing to update" },
      { status: 400 },
    );
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ row: res.data });
}

export async function DELETE(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .delete()
    .eq("id", id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
