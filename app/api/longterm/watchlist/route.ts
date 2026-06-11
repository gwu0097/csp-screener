// Long-term portfolio watchlist API. The DB row stores symbol +
// allocation + notes; live Yahoo quote enrichment is layered on at
// request time so the table doesn't have to be rebuilt every market
// tick. PATCH/DELETE accept id in body / ?id= per the spec — the
// /longterm/ideas route uses a per-id subpath; here we keep all four
// verbs on one file because the watchlist row shape is narrower.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  batchRefreshSnapshots,
  type SymbolSnapshot,
} from "@/lib/market-snapshot";
import { requireUserId, authErrorResponse } from "@/lib/auth";

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

type Action = "TAKE_PROFIT" | "DCA" | "CUT" | "HOLD";

// Multi-flag system replaces the prior Bull/Neutral/Bear classifier.
// Multiple flags can fire on a single row; the UI shows up to two and
// stuffs the rest into a tooltip.
type FlagKind =
  | "COMPOUNDER"
  | "TURNAROUND"
  | "VALUE_TRAP"
  | "STRETCHED"
  | "DEAD_WEIGHT"
  | "FALLING_KNIFE";

type Flag = {
  kind: FlagKind;
  label: string;
  description: string;
};

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
  return3yPct: number | null;
  vsSpy3yPct: number | null;
  rsi14: number | null;
  buyZone: { low: number; high: number } | null;
  sellZone: { low: number; high: number } | null;
  flags: Flag[];
  action: Action;
  hasEncyclopedia: boolean;
};

type Alert = {
  kind: "big_move" | "falling_knife" | "extended";
  symbol: string;
  message: string;
  changePct: number | null;
  timeframeForCatalyst: "1d" | "1w" | "1m";
};

// Multi-flag classifier. Each rule checks for a specific
// long-horizon pattern and the combination of flags on a row tells the
// story. Severity-ordered so DEAD_WEIGHT and FALLING_KNIFE land first
// when both are visible (only 2 fit on the row).
function computeFlags(input: {
  pctFromFiftyTwoWeekHigh: number | null;
  pctVs200dSma: number | null;
  momentum3mPct: number | null;
  return3yPct: number | null;
  vsSpy3yPct: number | null;
  trailingPE: number | null;
  pegRatio: number | null;
}): Flag[] {
  const out: Flag[] = [];
  const offHigh = input.pctFromFiftyTwoWeekHigh;
  const sma = input.pctVs200dSma;
  const mom = input.momentum3mPct;
  const r3y = input.return3yPct;
  const vsSpy = input.vsSpy3yPct;
  const pe = input.trailingPE;
  const peg = input.pegRatio;

  // Severity-ordered. Visible slot 1+2 belong to the top two flags on
  // the row; everything else falls into the tooltip.

  // DEAD_WEIGHT — chronic underperformer, no recovery signal.
  if (
    vsSpy !== null && vsSpy < -30 &&
    mom !== null && mom < -5 &&
    sma !== null && sma < -10
  ) {
    out.push({
      kind: "DEAD_WEIGHT",
      label: "Dead Weight",
      description: "Chronically underperforming SPY with no recovery signal.",
    });
  }
  // FALLING_KNIFE — deep drawdown, vs200d weak, momentum negative.
  if (
    offHigh !== null && offHigh < -50 &&
    sma !== null && sma < -20 &&
    mom !== null && mom < -20
  ) {
    out.push({
      kind: "FALLING_KNIFE",
      label: "Falling Knife",
      description: "Down 50%+ from highs and still falling — review position.",
    });
  }
  // VALUE_TRAP — cheap on PEG but the market disagrees.
  if (
    peg !== null && peg < 2 &&
    r3y !== null && r3y < 0 &&
    vsSpy !== null && vsSpy < -20
  ) {
    out.push({
      kind: "VALUE_TRAP",
      label: "Value Trap",
      description: "Low valuation but the market disagrees — multi-year underperformance.",
    });
  }
  // STRETCHED — at highs and expensive.
  if (
    offHigh !== null && offHigh > -5 &&
    pe !== null && pe > 35
  ) {
    out.push({
      kind: "STRETCHED",
      label: "Stretched",
      description: "Within 5% of 52w high and trading at >35× earnings — consider trimming.",
    });
  }
  // TURNAROUND — beaten down long-term, recent recovery.
  if (
    r3y !== null && r3y < -20 &&
    mom !== null && mom > 15
  ) {
    out.push({
      kind: "TURNAROUND",
      label: "Turnaround",
      description: "Down >20% over 3 years, but the last quarter has flipped positive.",
    });
  }
  // COMPOUNDER — consistently beating the market.
  if (
    vsSpy !== null && vsSpy > 20 &&
    sma !== null && sma > 0 &&
    mom !== null && mom > 0
  ) {
    out.push({
      kind: "COMPOUNDER",
      label: "Compounder",
      description: "Beats SPY by >20% over 3 years, above 200d, positive momentum.",
    });
  }

  return out;
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

// V1 buy/sell zones. Conservative bands tied to 52w + 200d landmarks.
// Only surface when the current price is within 15% of the zone so the
// row doesn't show stale guidance for stocks deep in the middle of
// their range.
function computeZones(input: {
  price: number | null;
  low52: number | null;
  high52: number | null;
  sma200: number | null;
}): {
  buyZone: { low: number; high: number } | null;
  sellZone: { low: number; high: number } | null;
} {
  const price = input.price;
  const low = input.low52;
  const high = input.high52;
  const sma = input.sma200;
  if (price === null) return { buyZone: null, sellZone: null };

  let buyZone: { low: number; high: number } | null = null;
  if (low !== null && sma !== null) {
    const bLow = low * 1.05;
    const bHigh = sma * 0.98;
    if (bHigh > bLow) {
      // Within 15% of the band (above the high end of the band still
      // counts when the price hasn't quite dropped in yet).
      const dist = price < bLow ? (bLow - price) / bLow : price > bHigh ? (price - bHigh) / bHigh : 0;
      if (dist <= 0.15) buyZone = { low: bLow, high: bHigh };
    }
  }
  let sellZone: { low: number; high: number } | null = null;
  if (sma !== null && high !== null) {
    const sLow = sma * 1.15;
    const sHigh = high * 0.98;
    if (sHigh > sLow) {
      const dist = price < sLow ? (sLow - price) / sLow : price > sHigh ? (price - sHigh) / sHigh : 0;
      if (dist <= 0.15) sellZone = { low: sLow, high: sHigh };
    }
  }
  return { buyZone, sellZone };
}

const ALLOCATION_ORDER: Record<Allocation, number> = {
  Large: 0,
  Medium: 1,
  Small: 2,
};

// Map a cached snapshot onto the EnrichedRow shape the UI already
// expects. All market data now comes from symbol_market_snapshot (one
// batched refresh per load) instead of per-row Yahoo calls — the
// downstream computations (flags / action / zones / alerts) are
// unchanged, they just read these mapped fields.
function enrichFromSnapshot(
  row: WatchlistRow,
  snapshot: SymbolSnapshot | null,
  encyclopediaSet: Set<string>,
): EnrichedRow {
  const price = snapshot?.price ?? null;
  const sma200 = snapshot?.sma200 ?? null;
  const fiftyTwoWeekLow = snapshot?.week52_low ?? null;
  const fiftyTwoWeekHigh = snapshot?.week52_high ?? null;
  const pctFromFiftyTwoWeekHigh = snapshot?.pct_from_52w_high ?? null;
  const pctVs200dSma = snapshot?.vs_sma200_pct ?? null;
  const trailingPE = snapshot?.trailing_pe ?? null;
  const forwardPE = snapshot?.forward_pe ?? null;
  const pegRatio = snapshot?.peg_ratio ?? null;
  const momentum3mPct = snapshot?.return_3m ?? null;
  const return3yPct = snapshot?.return_3y ?? null;
  const vsSpy3yPct = snapshot?.vs_spy_3y ?? null;
  const action = computeAction({
    pctFromFiftyTwoWeekHigh,
    pctVs200dSma,
    momentum3mPct,
    trailingPE,
    pegRatio,
  });
  const flags = computeFlags({
    pctFromFiftyTwoWeekHigh,
    pctVs200dSma,
    momentum3mPct,
    return3yPct,
    vsSpy3yPct,
    trailingPE,
    pegRatio,
  });
  const { buyZone, sellZone } = computeZones({
    price,
    low52: fiftyTwoWeekLow,
    high52: fiftyTwoWeekHigh,
    sma200,
  });
  return {
    ...row,
    companyName: snapshot?.company_name ?? null,
    price,
    changePct: snapshot?.change_pct ?? null,
    fiftyTwoWeekLow,
    fiftyTwoWeekHigh,
    pctFromFiftyTwoWeekHigh,
    marketCap: snapshot?.market_cap ?? null,
    trailingPE,
    forwardPE,
    pegRatio,
    twoHundredDayAverage: sma200,
    pctVs200dSma,
    momentum3mPct,
    return3yPct,
    vsSpy3yPct,
    rsi14: snapshot?.rsi14 ?? null,
    buyZone,
    sellZone,
    flags,
    action,
    hasEncyclopedia: encyclopediaSet.has(row.symbol),
  };
}

// Pure alert builder — runs over the enriched list and returns the
// rows that match each rule. Same severity ordering as computeAction.
// timeframeForCatalyst hints the catalyst route at the right window:
// 1d for today's moves, 1m for chronic drawdowns.
function buildAlerts(rows: EnrichedRow[]): Alert[] {
  const alerts: Alert[] = [];
  for (const r of rows) {
    if (r.changePct !== null && Math.abs(r.changePct) > 5) {
      const sign = r.changePct >= 0 ? "+" : "";
      alerts.push({
        kind: "big_move",
        symbol: r.symbol,
        changePct: r.changePct,
        timeframeForCatalyst: "1d",
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
        changePct: r.momentum3mPct,
        timeframeForCatalyst: "1m",
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
        changePct: r.changePct,
        timeframeForCatalyst: "1w",
        message: `${r.symbol} near highs and expensive (P/E ${r.trailingPE.toFixed(1)}) — consider taking profits.`,
      });
    }
  }
  return alerts;
}

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .select("id,symbol,allocation,notes,created_at,updated_at")
    .eq("user_id", userId);
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
  // flag the AI Signal badge with 📚. Cheap single-query lookup.
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

  // Single batched snapshot refresh for the whole watchlist (Phase 2):
  // cached rows return instantly, only stale/missing symbols hit Yahoo,
  // and SPY's 3Y benchmark is fetched once inside the batch. This
  // replaces the old ~3-Yahoo-calls-per-symbol fan-out.
  const snapshots = await batchRefreshSnapshots(symbols, 15);
  const snapBySymbol = new Map<string, SymbolSnapshot>();
  for (const s of snapshots) snapBySymbol.set(s.symbol.toUpperCase(), s);

  const enriched = rows.map((r) =>
    enrichFromSnapshot(r, snapBySymbol.get(r.symbol.toUpperCase()) ?? null, encyclopediaSet),
  );
  const alerts = buildAlerts(enriched);
  // spy3yPct is now baked into each row's vsSpy3yPct via the snapshot;
  // kept in the response (null) for backward-compatible shape.
  return NextResponse.json({ watchlist: enriched, alerts, spy3yPct: null });
}

type CreateBody = { symbol?: unknown; allocation?: unknown; notes?: unknown };

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
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
    .insert({ user_id: userId, symbol, allocation: body.allocation as Allocation, notes })
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
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
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
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ row: res.data });
}

export async function DELETE(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
