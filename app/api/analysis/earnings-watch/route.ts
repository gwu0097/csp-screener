// Earnings Watch: pre-earnings position review for names across every
// watchlist reporting soon. Answers "do I want to be holding this
// through the event" — NOT a CSP candidate screen. Default view is
// every watchlist symbol with earnings in the next 7 days, deduped,
// soonest first, cross-referenced against open positions. ?symbol=
// looks up one ticker regardless of watchlist membership or date.
//
// Every per-name computation here reuses an existing helper rather
// than rebuilding it: directionalMoveCoverage()/getCrushHistory() for
// downside history (lib/earnings-history-table.ts), computeFlags() for
// the Portfolio thesis flag (lib/watchlists.ts), batchRefreshSnapshots
// for price/company-name/fundamentals (lib/market-snapshot.ts), and
// getFinnhubNextEarningsDate() for the calendar (lib/earnings.ts). The
// only genuinely new logic is the composite badge/data-quality/IV-
// richness scoring in lib/earnings-watch.ts, and the watchlist∩
// earnings∩positions join itself, which nothing in the app already did.
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { batchRefreshSnapshots, type SymbolSnapshot } from "@/lib/market-snapshot";
import { ensurePortfolioWatchlist, computeFlags, type Flag } from "@/lib/watchlists";
import { getFinnhubNextEarningsDate } from "@/lib/earnings";
import {
  getCrushHistory,
  directionalMoveCoverage,
  type CrushHistoryEvent,
} from "@/lib/earnings-history-table";
import {
  computeEarningsWatchBadge,
  assessDataQuality,
  summarizeDownside,
  type SizeTier,
  type IvRichnessLabel,
  type EarningsWatchBadge,
  type DataQuality,
  type DownsideSummary,
} from "@/lib/earnings-watch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LOOKAHEAD_DAYS = 7;
const HISTORY_LIMIT = 9; // 8 past quarters + 1 possible not-yet-reported row

type ItemRow = { symbol: string; watchlist_id: string; allocation: string | null; notes: string | null };

type PositionRow = {
  id: string;
  symbol: string;
  position_type: string | null;
  status: string;
  total_contracts: number;
  avg_premium_sold: number | null;
  strike: number | null;
  expiry: string | null;
  entry_stock_price: number | null;
  direction: string | null;
};

type HeldPosition = {
  positionType: "stock_long" | "stock_short" | "option";
  contracts: number;
  strike: number | null;
  expiry: string | null;
  costBasis: number | null;
  currentGainLossPct: number | null;
  avgPremiumSold: number | null;
};

// Portfolio watchlist membership IS the stock-holding signal for
// long-term equity — those shares were never imported as a broker
// position, they just live in this watchlist. Distinct from
// heldPositions (below), which come from the positions table (broker-
// imported options, or stock assigned from one) and DO carry a real
// cost basis. A name can have either, both, or neither.
type PortfolioStockHolding = {
  allocation: "Large" | "Medium" | "Small" | null;
  notes: string | null;
};

export type EarningsWatchRow = {
  symbol: string;
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  earningsDate: string | null;
  earningsTiming: "BMO" | "AMC" | "DMH" | "unknown" | null;
  daysUntilEarnings: number | null;
  watchlistNames: string[];
  onPortfolioWatchlist: boolean;
  thesisFlags: Flag[];
  held: boolean;
  portfolioStockHolding: PortfolioStockHolding | null;
  heldPositions: HeldPosition[];
  sizeTier: SizeTier;
  downside: DownsideSummary;
  dataQuality: DataQuality;
  ivRichness: {
    label: IvRichnessLabel;
    currentEmPct: number | null;
    historicalAvgEmPct: number | null;
    richnessRatio: number | null;
    note: string;
  };
  badge: EarningsWatchBadge | null; // null when not held — nothing to cut/trim
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function notionalOf(p: PositionRow): number {
  if (p.position_type === "option") {
    return Math.abs((p.strike ?? 0) * p.total_contracts * 100);
  }
  // stock_long / stock_short
  return Math.abs((p.entry_stock_price ?? 0) * p.total_contracts);
}

// Prefers a real position's notional-percentile tier (live, precise)
// when one exists; falls back to the Portfolio watchlist's own
// allocation field for watchlist-only holdings, which has no notional
// to rank at all (no share count or cost basis stored there) but
// already encodes a size tier the user set directly — reusing it beats
// fabricating a number from data that doesn't exist.
function sizeTierFor(
  notional: number,
  allNotionals: number[],
  watchlistAllocation: string | null,
): SizeTier {
  if (notional > 0 && allNotionals.length > 0) {
    const sorted = [...allNotionals].sort((a, b) => a - b);
    const rank = sorted.filter((n) => n <= notional).length / sorted.length;
    if (rank >= 2 / 3) return "large";
    if (rank >= 1 / 3) return "medium";
    return "small";
  }
  if (watchlistAllocation === "Large") return "large";
  if (watchlistAllocation === "Medium") return "medium";
  if (watchlistAllocation === "Small") return "small";
  return null;
}

async function buildRow(
  symbol: string,
  ctx: {
    watchlistNames: string[];
    onPortfolioWatchlist: boolean;
    portfolioAllocation: string | null;
    portfolioNotes: string | null;
    snap: SymbolSnapshot | null;
    positionsBySymbol: Map<string, PositionRow[]>;
    allNotionals: number[];
  },
): Promise<EarningsWatchRow> {
  const sym = symbol.toUpperCase();
  const [nextEarnings, history] = await Promise.all([
    getFinnhubNextEarningsDate(sym),
    getCrushHistory(sym, HISTORY_LIMIT),
  ]);

  const today = todayIso();
  const daysUntilEarnings = nextEarnings ? daysBetween(today, nextEarnings.date) : null;

  // A capture cron can pre-populate the row for the upcoming date once
  // it's close (see the crush-t0 cron) — if the newest history row IS
  // the upcoming date, it's the live current-cycle read, not a past
  // quarter, and must not be double-counted into the historical stats.
  const currentRow: CrushHistoryEvent | null =
    nextEarnings && history[0]?.earningsDate === nextEarnings.date ? history[0] : null;
  const pastQuarters = currentRow ? history.slice(1) : history;

  const coverage = directionalMoveCoverage(pastQuarters, 0); // strikeDistancePct unused here — no strike in this view
  const downside = summarizeDownside(coverage, pastQuarters);
  const dataQuality = assessDataQuality(pastQuarters);

  const historicalEms = pastQuarters
    .map((h) => h.impliedMovePct)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const historicalAvgEmPct =
    historicalEms.length > 0 ? historicalEms.reduce((s, v) => s + v, 0) / historicalEms.length : null;
  const currentEmPct = currentRow?.impliedMovePct ?? null;
  const richnessRatio =
    currentEmPct !== null && historicalAvgEmPct !== null && historicalAvgEmPct > 0
      ? currentEmPct / historicalAvgEmPct
      : null;
  let ivLabel: IvRichnessLabel = "unavailable";
  // True IV-percentile-vs-own-history infrastructure doesn't exist in
  // this codebase (no options-chain fetch outside the Schwab-gated CSP
  // screener pipeline) — this is a proxy built entirely from
  // earnings_history rows already fetched above for downside history,
  // and it has two distinct, actionable "unavailable" causes below.
  // Neither is a dead end: both are fixable, and the copy says how.
  let ivNote =
    "Current pre-earnings IV/EM hasn't been captured yet — that normally happens automatically the trading day of the report (the crush-t0 cron), so this fills in on its own as the date gets closer. It can't be backfilled early.";
  if (richnessRatio !== null) {
    if (richnessRatio >= 1.15) {
      ivLabel = "elevated";
      ivNote = `Current implied move ${(currentEmPct! * 100).toFixed(1)}% is ${((richnessRatio - 1) * 100).toFixed(0)}% above this name's own ${historicalEms.length}-quarter average (${(historicalAvgEmPct! * 100).toFixed(1)}%).`;
    } else if (richnessRatio <= 0.85) {
      ivLabel = "low";
      ivNote = `Current implied move ${(currentEmPct! * 100).toFixed(1)}% is below this name's own ${historicalEms.length}-quarter average (${(historicalAvgEmPct! * 100).toFixed(1)}%).`;
    } else {
      ivLabel = "normal";
      ivNote = `Current implied move ${(currentEmPct! * 100).toFixed(1)}% is in line with this name's own ${historicalEms.length}-quarter average (${(historicalAvgEmPct! * 100).toFixed(1)}%).`;
    }
  } else if (historicalAvgEmPct === null) {
    ivNote =
      "No historical implied-move data on file for this name to compare against, even if a current reading existed. Fill in past quarters' EM in the editable table below (same editor as the CSP screener) to build a baseline — richness can only be judged against real history, not fabricated.";
  }

  const openPositions = ctx.positionsBySymbol.get(sym) ?? [];
  const heldPositions: HeldPosition[] = openPositions.map((p) => {
    const isStock = p.position_type === "stock_long" || p.position_type === "stock_short";
    const costBasis = isStock ? p.entry_stock_price : null;
    const currentPrice = ctx.snap?.price ?? null;
    let currentGainLossPct: number | null = null;
    if (isStock && costBasis !== null && costBasis > 0 && currentPrice !== null) {
      const diff = p.position_type === "stock_long" ? currentPrice - costBasis : costBasis - currentPrice;
      currentGainLossPct = (diff / costBasis) * 100;
    }
    return {
      positionType: (p.position_type as HeldPosition["positionType"]) ?? "option",
      contracts: p.total_contracts,
      strike: p.strike,
      expiry: p.expiry,
      costBasis,
      currentGainLossPct,
      avgPremiumSold: isStock ? null : p.avg_premium_sold,
    };
  });
  // Portfolio watchlist membership is a distinct, real holding signal
  // — long-term stock tracked there was never imported as a broker
  // position, so heldPositions alone would miss it entirely. No cost
  // basis exists for it (the watchlist only stores allocation/notes),
  // so nothing is fabricated for that side — just allocation + notes.
  const portfolioStockHolding = ctx.onPortfolioWatchlist
    ? {
        allocation: (ctx.portfolioAllocation as PortfolioStockHolding["allocation"]) ?? null,
        notes: ctx.portfolioNotes,
      }
    : null;
  const held = openPositions.length > 0 || portfolioStockHolding !== null;
  const totalNotional = openPositions.reduce((s, p) => s + notionalOf(p), 0);
  const sizeTier = held ? sizeTierFor(totalNotional, ctx.allNotionals, ctx.portfolioAllocation) : null;

  const flags = ctx.onPortfolioWatchlist
    ? computeFlags({
        pctFromFiftyTwoWeekHigh: ctx.snap?.pct_from_52w_high ?? null,
        pctVs200dSma: ctx.snap?.vs_sma200_pct ?? null,
        momentum3mPct: ctx.snap?.return_3m ?? null,
        return3yPct: ctx.snap?.return_3y ?? null,
        vsSpy3yPct: ctx.snap?.vs_spy_3y ?? null,
        trailingPE: ctx.snap?.trailing_pe ?? null,
        pegRatio: ctx.snap?.peg_ratio ?? null,
      })
    : [];

  const badge = held
    ? computeEarningsWatchBadge({
        worstDownsidePct: downside.worstDownsidePct,
        sizeTier,
        held,
        ivRichnessLabel: ivLabel,
      })
    : null;

  return {
    symbol: sym,
    companyName: ctx.snap?.company_name ?? null,
    price: ctx.snap?.price ?? null,
    changePct: ctx.snap?.change_pct ?? null,
    earningsDate: nextEarnings?.date ?? null,
    earningsTiming: nextEarnings?.timing ?? null,
    daysUntilEarnings,
    watchlistNames: ctx.watchlistNames,
    onPortfolioWatchlist: ctx.onPortfolioWatchlist,
    thesisFlags: flags,
    held,
    portfolioStockHolding,
    heldPositions,
    sizeTier,
    downside,
    dataQuality,
    ivRichness: {
      label: ivLabel,
      currentEmPct,
      historicalAvgEmPct,
      richnessRatio,
      note: ivNote,
    },
    badge,
  };
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  await ensurePortfolioWatchlist(userId);
  const lookupSymbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() || null;

  const sb = createServerClient();
  const listsRes = await sb.from("watchlists").select("id,name,is_portfolio").eq("user_id", userId);
  if (listsRes.error) return NextResponse.json({ error: listsRes.error.message }, { status: 500 });
  const lists = (listsRes.data ?? []) as Array<{ id: string; name: string; is_portfolio: boolean }>;
  const nameById = new Map(lists.map((w) => [w.id, w.name]));
  const portfolioListId = lists.find((w) => w.is_portfolio)?.id ?? null;

  const itemsRes = await sb
    .from("long_term_watchlist")
    .select("symbol,watchlist_id,allocation,notes")
    .eq("user_id", userId);
  if (itemsRes.error) return NextResponse.json({ error: itemsRes.error.message }, { status: 500 });
  const items = (itemsRes.data ?? []) as ItemRow[];

  const bySymbol = new Map<string, Set<string>>();
  const portfolioSymbols = new Set<string>();
  // Only the Portfolio watchlist's own row represents real ownership —
  // a symbol can also sit on a custom watchlist (e.g. "Prospects")
  // with its own unrelated allocation/notes, which must not leak in
  // here as if it meant the user holds the stock.
  const portfolioMetaBySymbol = new Map<string, { allocation: string | null; notes: string | null }>();
  for (const it of items) {
    const sym = it.symbol.toUpperCase();
    const name = nameById.get(it.watchlist_id) ?? it.watchlist_id;
    if (!bySymbol.has(sym)) bySymbol.set(sym, new Set());
    bySymbol.get(sym)!.add(name);
    if (portfolioListId && it.watchlist_id === portfolioListId) {
      portfolioSymbols.add(sym);
      portfolioMetaBySymbol.set(sym, { allocation: it.allocation, notes: it.notes });
    }
  }

  // All of the user's open positions, once — used both to determine
  // "held" for the symbols in view and as the reference distribution
  // for relative size-tier bucketing (no portfolio-NAV concept exists
  // to compare against, so peers are the only grounded reference).
  const posRes = await sb
    .from("positions")
    .select("id,symbol,position_type,status,total_contracts,avg_premium_sold,strike,expiry,entry_stock_price,direction")
    .eq("user_id", userId)
    .eq("status", "open");
  if (posRes.error) return NextResponse.json({ error: posRes.error.message }, { status: 500 });
  const allOpenPositions = (posRes.data ?? []) as PositionRow[];
  const positionsBySymbol = new Map<string, PositionRow[]>();
  for (const p of allOpenPositions) {
    const sym = p.symbol.toUpperCase();
    if (!positionsBySymbol.has(sym)) positionsBySymbol.set(sym, []);
    positionsBySymbol.get(sym)!.push(p);
  }
  const allNotionals = allOpenPositions.map(notionalOf).filter((n) => n > 0);

  if (lookupSymbol) {
    const snaps = await batchRefreshSnapshots([lookupSymbol], 15);
    const snap = snaps[0] ?? null;
    const row = await buildRow(lookupSymbol, {
      watchlistNames: Array.from(bySymbol.get(lookupSymbol) ?? []).sort(),
      onPortfolioWatchlist: portfolioSymbols.has(lookupSymbol),
      portfolioAllocation: portfolioMetaBySymbol.get(lookupSymbol)?.allocation ?? null,
      portfolioNotes: portfolioMetaBySymbol.get(lookupSymbol)?.notes ?? null,
      snap,
      positionsBySymbol,
      allNotionals,
    });
    return NextResponse.json({ row });
  }

  // Default view: every watchlist symbol, next-earnings-date fetched
  // per symbol (cached 8h — lib/earnings.ts), filtered to the next
  // LOOKAHEAD_DAYS days.
  const allSymbols = Array.from(bySymbol.keys());
  const withDates = await Promise.all(
    allSymbols.map(async (sym) => ({ sym, next: await getFinnhubNextEarningsDate(sym) })),
  );
  const today = todayIso();
  const upcoming = withDates.filter(({ next }) => {
    if (!next) return false;
    const d = daysBetween(today, next.date);
    return d >= 0 && d <= LOOKAHEAD_DAYS;
  });
  const upcomingSymbols = upcoming.map((u) => u.sym);

  const snapshots = await batchRefreshSnapshots(upcomingSymbols, 15);
  const snapMap = new Map<string, SymbolSnapshot>();
  for (const s of snapshots) snapMap.set(s.symbol.toUpperCase(), s);

  const rows = await Promise.all(
    upcomingSymbols.map((sym) =>
      buildRow(sym, {
        watchlistNames: Array.from(bySymbol.get(sym) ?? []).sort(),
        onPortfolioWatchlist: portfolioSymbols.has(sym),
        portfolioAllocation: portfolioMetaBySymbol.get(sym)?.allocation ?? null,
        portfolioNotes: portfolioMetaBySymbol.get(sym)?.notes ?? null,
        snap: snapMap.get(sym) ?? null,
        positionsBySymbol,
        allNotionals,
      }),
    ),
  );
  rows.sort((a, b) => (a.daysUntilEarnings ?? 999) - (b.daysUntilEarnings ?? 999));

  return NextResponse.json({
    rows,
    watchlists: lists
      .slice()
      .sort((a, b) => (a.is_portfolio === b.is_portfolio ? a.name.localeCompare(b.name) : a.is_portfolio ? -1 : 1))
      .map((w) => ({ id: w.id, name: w.name, isPortfolio: w.is_portfolio })),
  });
}
