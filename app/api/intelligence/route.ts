import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PositionRow = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  total_contracts: number;
  avg_premium_sold: number | null;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  entry_final_grade: string | null;
  entry_crush_grade: string | null;
  entry_opportunity_grade: string | null;
  entry_iv_edge: number | null;
  entry_em_pct: number | null;
  entry_vix: number | null;
  status: string;
  broker: string | null;
  position_type: string | null;
  assignment_source_id: string | null;
  entry_stock_price: number | null;
  direction: "short" | "long" | null;
  entry_dte: number | null;
  campaign_id: string | null;
  trade_chain_id: string | null;
};

type RecRow = {
  position_id: string;
  recommendation: string;
  confidence: string;
  was_system_aligned: boolean | null;
  analysis_date: string;
};

// ROC = realized_pnl / (strike × contracts × 100). Returns a decimal
// fraction (0.0042 = 0.42%). null when any input is missing or the
// denominator is zero.
function computeROC(
  realizedPnl: number | null,
  strike: number | null,
  contracts: number | null,
): number | null {
  if (realizedPnl === null || strike === null || contracts === null) return null;
  const capital = Number(strike) * Number(contracts) * 100;
  if (!Number.isFinite(capital) || capital <= 0) return null;
  return realizedPnl / capital;
}

function dayOfWeek(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

function daysBetweenInclusive(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.floor((b - a) / 86400000);
}

type Granularity = "day" | "week" | "month";

function granularityFor(days: number): Granularity {
  if (days <= 90) return "day";
  if (days <= 365) return "week";
  return "month";
}

// ISO week — Monday is the first day.
function startOfISOWeekIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

function startOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function bucketKeyFor(closedDate: string, g: Granularity): string {
  if (g === "day") return closedDate;
  if (g === "week") return startOfISOWeekIso(closedDate);
  return startOfMonthIso(closedDate);
}

function labelFor(bucketKey: string, g: Granularity): string {
  const d = new Date(bucketKey + "T00:00:00Z");
  if (g === "month") {
    return d.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Four buckets: the old calm/elevated/panic trichotomy put every trade
// in this account's history (VIX 15-25 throughout) into one "elevated"
// bar. Splitting 15-25 into 15-20 / 20-25 makes the panel actually
// differentiate within the regime the user trades in.
function vixBucket(
  vix: number | null,
): "calm" | "15-20" | "20-25" | "panic" | null {
  if (vix === null || !Number.isFinite(vix)) return null;
  if (vix > 25) return "panic";
  if (vix >= 20) return "20-25";
  if (vix >= 15) return "15-20";
  return "calm";
}

// Days-to-expiration at entry. Uses the stamped entry_dte when present
// and derives from the dates otherwise, so all history participates.
type DteBucketKey = "0-2d" | "3-5d" | "6-10d" | ">10d";
function dteBucket(p: {
  entry_dte: number | null;
  opened_date: string;
  expiry: string;
}): DteBucketKey | null {
  let dte = p.entry_dte;
  if (dte === null || !Number.isFinite(dte)) {
    dte = daysBetweenInclusive(p.opened_date, p.expiry);
  }
  if (dte === null || dte < 0) return null;
  if (dte <= 2) return "0-2d";
  if (dte <= 5) return "3-5d";
  if (dte <= 10) return "6-10d";
  return ">10d";
}

// ISO YYYY-MM-DD validation — anything else is ignored and we fall back.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validIsoDate(s: string | null): string | null {
  if (!s || !ISO_DATE.test(s)) return null;
  // Guard against nonsense like 2026-13-45
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const params = req.nextUrl.searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  // Default: this month → today. Callers override via ?from=&to=.
  const fromParam = validIsoDate(params.get("from"));
  const toParam = validIsoDate(params.get("to"));
  const from = fromParam ?? `${todayIso.slice(0, 7)}-01`;
  const to = toParam ?? todayIso;

  const brokerRaw = (params.get("broker") ?? "all").toLowerCase();
  const broker = brokerRaw === "all" || brokerRaw === "" ? null : brokerRaw;

  const sb = createServerClient();

  // All closed positions (all-time), optionally broker-filtered. We need
  // both the in-range set (for window stats + equity curve) and the full
  // set (for all-time ticker rankings + pattern intelligence).
  let query = sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,total_contracts,avg_premium_sold,opened_date,closed_date,realized_pnl,entry_final_grade,entry_crush_grade,entry_opportunity_grade,entry_iv_edge,entry_em_pct,entry_vix,status,broker,position_type,assignment_source_id,entry_stock_price,direction,entry_dte,campaign_id,trade_chain_id",
    )
    .eq("user_id", userId)
    .in("status", ["closed", "expired_worthless", "assigned"])
    .order("closed_date", { ascending: true });
  if (broker) query = query.eq("broker", broker);
  const allClosedRes = await query;
  if (allClosedRes.error) {
    return NextResponse.json({ error: allClosedRes.error.message }, { status: 500 });
  }
  const allClosedRaw = (allClosedRes.data ?? []) as PositionRow[];
  // Partition by position_type. Pre-migration NULL is treated as
  // option. stock_long / stock_short rows have option-shaped columns
  // populated as placeholders (strike=0, option_type='put') and would
  // poison ROC / ticker rankings if included in the option aggregates
  // — we surface them via paired_assignments[] instead.
  const allClosed: PositionRow[] = [];
  const closedStocks: PositionRow[] = [];
  for (const r of allClosedRaw) {
    if (r.position_type === "stock_long" || r.position_type === "stock_short") {
      closedStocks.push(r);
    } else {
      allClosed.push(r);
    }
  }

  // Still-open positions with banked realized P&L from a partial close
  // (some contracts bought back / sold, the rest still open). Fetched
  // here — earlier than the "partial closes" display section further
  // down — because the equity curve needs it too: these fills feed the
  // Total series (bucketed by their own fill_date, see below) but never
  // the Realized series, matching the same "resolved trades only" rule
  // win_rate/ROC/expectancy already follow. The display section reuses
  // this array instead of re-querying.
  let stillOpenQuery = sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,total_contracts,avg_premium_sold,opened_date,closed_date,realized_pnl,entry_final_grade,entry_crush_grade,entry_opportunity_grade,entry_iv_edge,entry_em_pct,entry_vix,status,broker,position_type,assignment_source_id,entry_stock_price,direction,entry_dte,campaign_id,trade_chain_id,updated_at",
    )
    .eq("user_id", userId)
    .eq("status", "open");
  if (broker) stillOpenQuery = stillOpenQuery.eq("broker", broker);
  const stillOpenRes = await stillOpenQuery;
  if (stillOpenRes.error) {
    return NextResponse.json({ error: stillOpenRes.error.message }, { status: 500 });
  }
  type StillOpenRow = PositionRow & { updated_at: string };
  // Filter in JS — matches the SQL guard: realized_pnl IS NOT NULL AND
  // realized_pnl != 0 AND closed_date IS NULL. status='open' rows
  // should already have a null closed_date, but don't assume it.
  const stillOpenPartialRows = ((stillOpenRes.data ?? []) as StillOpenRow[]).filter(
    (p) =>
      p.closed_date === null &&
      p.realized_pnl !== null &&
      Math.abs(Number(p.realized_pnl)) > 0.001,
  );
  const stillOpenPartialIds = new Set(stillOpenPartialRows.map((p) => p.id));

  // In-range: filter by closed_date within [from, to] inclusive.
  const windowed = allClosed.filter((p) => {
    const cd = p.closed_date ?? "";
    return cd >= from && cd <= to;
  });
  const windowedStocks = closedStocks.filter((p) => {
    const cd = p.closed_date ?? "";
    return cd >= from && cd <= to;
  });
  // Stock realized P&L from closed stock_long / stock_short rows in
  // window. Kept separate from `totals` (option aggregates) so
  // option-only metrics (win_rate, ROC, expectancy, best/worst,
  // ticker rankings) stay pure — stocks have different shape and
  // would distort those. Used to compute the combined headline +
  // injected into the equity curve so the curve reflects actual
  // book P&L instead of option-only.
  const stockTotalPnl = windowedStocks.reduce(
    (s, p) => s + Number(p.realized_pnl ?? 0),
    0,
  );

  // ---------- Section 1: stats + equity curve ----------
  const totals = windowed.reduce(
    (acc, p) => {
      const pnl = Number(p.realized_pnl ?? 0);
      acc.total_pnl += pnl;
      if (pnl > 0) {
        acc.wins += 1;
        acc.sumWinPnl += pnl;
      } else if (pnl < 0) {
        acc.losses += 1;
        acc.sumLossPnl += pnl;
      }
      const roc = computeROC(pnl, p.strike, p.total_contracts);
      if (roc !== null) {
        acc.rocSum += roc;
        acc.rocCount += 1;
      }
      if (acc.best === null || pnl > acc.best.pnl) {
        acc.best = { symbol: p.symbol, pnl, roc };
      }
      if (acc.worst === null || pnl < acc.worst.pnl) {
        acc.worst = { symbol: p.symbol, pnl, roc };
      }
      return acc;
    },
    {
      total_pnl: 0,
      wins: 0,
      losses: 0,
      sumWinPnl: 0,
      sumLossPnl: 0,
      rocSum: 0,
      rocCount: 0,
      best: null as { symbol: string; pnl: number; roc: number | null } | null,
      worst: null as { symbol: string; pnl: number; roc: number | null } | null,
    },
  );
  // win_rate / avg_roc / expectancy / best / worst used to be derived
  // from `totals` here (row-level, option-only). That's now entirely
  // superseded by the campaign-level block below — `totals` itself is
  // still used for total_pnl (the row-level Total P&L card, which must
  // not move), just not for outcome scoring anymore.

  // ---------- Campaign-level outcome stats ----------
  // Win rate / expectancy / avg ROC / best-worst move from "one row =
  // one trade" to "one campaign = one outcome" — a campaign (unbroken
  // exposure from an earnings event to flat, spanning rolls,
  // assignments, and added strikes) nets ALL its legs, option and
  // stock, into one number before it's scored a win or a loss. Row-
  // level totals above (total_pnl / stock_total_pnl /
  // combined_realized_pnl) are untouched — those stay windowed sums
  // over individual rows so period totals never move.
  //
  // Grouping key mirrors lib/screener.ts's personalStats precedent:
  // campaign_id when resolved, else trade_chain_id, else the position
  // is its own solo group. ~15 chains account-wide have no resolvable
  // earnings event (campaign_id stays NULL forever for those, see
  // migrations/2026-08-21-add-campaign-layer.sql) — they fall back to
  // trade_chain_id here rather than disappearing from the stats, but
  // are additionally surfaced in unresolved_campaigns below.
  const campaignKey = (p: { campaign_id: string | null; trade_chain_id: string | null; id: string }): string =>
    p.campaign_id ?? p.trade_chain_id ?? `solo:${p.id}`;

  // A campaign is only a resolved "outcome" once every leg across its
  // whole history — not just the ones in this window — has closed.
  // Matches the user's own definition: a campaign ends when size
  // returns to zero across all legs. One still-open leg means the
  // campaign hasn't happened yet.
  const openKeys = new Set(
    ((stillOpenRes.data ?? []) as PositionRow[])
      .filter((p) => !broker || p.broker === broker)
      .map((p) => campaignKey(p)),
  );

  type CampaignAgg = {
    key: string;
    symbol: string;
    netPnl: number;
    terminalDate: string;
    optionLegs: Array<{ opened_date: string; closed_date: string | null; strike: number; total_contracts: number }>;
    unresolvedEarnings: boolean;
  };
  const campaignMap = new Map<string, CampaignAgg>();
  for (const p of allClosedRaw) {
    const key = campaignKey(p);
    const cd = p.closed_date ?? "";
    let agg = campaignMap.get(key);
    if (!agg) {
      agg = {
        key,
        symbol: p.symbol,
        netPnl: 0,
        terminalDate: cd,
        optionLegs: [],
        unresolvedEarnings: p.campaign_id === null,
      };
      campaignMap.set(key, agg);
    }
    agg.netPnl += Number(p.realized_pnl ?? 0);
    if (cd > agg.terminalDate) agg.terminalDate = cd;
    if (p.campaign_id !== null) agg.unresolvedEarnings = false;
    if (p.position_type !== "stock_long" && p.position_type !== "stock_short") {
      agg.optionLegs.push({
        opened_date: p.opened_date,
        closed_date: p.closed_date,
        strike: Number(p.strike),
        total_contracts: Number(p.total_contracts),
      });
    }
  }

  // Peak concurrent option capital across a campaign's whole life —
  // handles same-day rolls (old leg closes, new leg opens: both count
  // as deployed that day) and multi-strike scale-ins (several legs
  // open at once) the way a single position's strike×contracts×100
  // never could. Capital is freed the day AFTER a leg's closed_date
  // (it was still at risk through the close itself).
  function peakCampaignCapital(
    legs: Array<{ opened_date: string; closed_date: string | null; strike: number; total_contracts: number }>,
  ): number {
    const deltas = new Map<string, number>();
    for (const leg of legs) {
      const capital = leg.strike * leg.total_contracts * 100;
      if (!Number.isFinite(capital) || capital <= 0) continue;
      const start = leg.opened_date;
      const endExclusive = leg.closed_date ? addDaysIso(leg.closed_date, 1) : start;
      deltas.set(start, (deltas.get(start) ?? 0) + capital);
      deltas.set(endExclusive, (deltas.get(endExclusive) ?? 0) - capital);
    }
    const dates = Array.from(deltas.keys()).sort();
    let running = 0;
    let peak = 0;
    for (const d of dates) {
      running += deltas.get(d) ?? 0;
      if (running > peak) peak = running;
    }
    return peak;
  }

  const resolvedCampaigns = Array.from(campaignMap.values()).filter(
    (c) => !openKeys.has(c.key),
  );
  const windowedCampaigns = resolvedCampaigns.filter(
    (c) => c.terminalDate >= from && c.terminalDate <= to,
  );
  const unresolvedEarningsCampaigns = resolvedCampaigns.filter((c) => c.unresolvedEarnings);

  const campaignTotals = windowedCampaigns.reduce(
    (acc, c) => {
      const pnl = c.netPnl;
      if (pnl > 0) {
        acc.wins += 1;
        acc.sumWinPnl += pnl;
      } else if (pnl < 0) {
        acc.losses += 1;
        acc.sumLossPnl += pnl;
      }
      const peakCapital = peakCampaignCapital(c.optionLegs);
      const roc = peakCapital > 0 ? pnl / peakCapital : null;
      if (roc !== null) {
        acc.rocSum += roc;
        acc.rocCount += 1;
      }
      if (acc.best === null || pnl > acc.best.pnl) acc.best = { symbol: c.symbol, pnl, roc };
      if (acc.worst === null || pnl < acc.worst.pnl) acc.worst = { symbol: c.symbol, pnl, roc };
      return acc;
    },
    {
      wins: 0,
      losses: 0,
      sumWinPnl: 0,
      sumLossPnl: 0,
      rocSum: 0,
      rocCount: 0,
      best: null as { symbol: string; pnl: number; roc: number | null } | null,
      worst: null as { symbol: string; pnl: number; roc: number | null } | null,
    },
  );
  const campaignTotalCount = windowedCampaigns.length;
  const campaignWinRate = campaignTotalCount > 0 ? campaignTotals.wins / campaignTotalCount : 0;
  const campaignAvgRoc = campaignTotals.rocCount > 0 ? campaignTotals.rocSum / campaignTotals.rocCount : 0;
  const campaignAvgWinPnl = campaignTotals.wins > 0 ? campaignTotals.sumWinPnl / campaignTotals.wins : 0;
  const campaignAvgLossPnl = campaignTotals.losses > 0 ? campaignTotals.sumLossPnl / campaignTotals.losses : 0;
  const campaignExpectancy =
    campaignTotalCount > 0
      ? campaignWinRate * campaignAvgWinPnl + (1 - campaignWinRate) * campaignAvgLossPnl
      : 0;
  const windowedUnresolvedCampaigns = windowedCampaigns.filter((c) => c.unresolvedEarnings);
  const unresolvedCampaignsPnlInWindow =
    Math.round(windowedUnresolvedCampaigns.reduce((s, c) => s + c.netPnl, 0) * 100) / 100;
  // All-time (not window-scoped) — for the account-wide "how much P&L
  // sits in unresolved campaigns" question, independent of any date
  // filter the user happens to have selected.
  const unresolvedCampaignsPnlAllTime =
    Math.round(unresolvedEarningsCampaigns.reduce((s, c) => s + c.netPnl, 0) * 100) / 100;

  // Equity curve is bucketed so multiple trades on the same date collapse
  // into a single data point. Granularity stretches with range length so
  // a "year" view doesn't render 250 daily ticks.
  const granularity = granularityFor(daysBetweenInclusive(from, to));
  type BucketAcc = {
    bucketKey: string;
    label: string;
    tradePnl: number;
    tradeCount: number;
    trades: Array<{ symbol: string; pnl: number }>;
  };
  // Two parallel bucket maps. Realized mirrors the pre-existing
  // behavior exactly (resolved trades only — must keep matching
  // combined_realized_pnl / win_rate / ROC's "resolved only" scope).
  // Total additionally includes still-open positions' already-banked
  // partial-close fills, bucketed on their own fill_date — that money
  // is real and current, but the position hasn't fully resolved, so it
  // stays out of Realized/win_rate/ROC/best-worst by the same rule that
  // already excludes it from those (see stillOpenPartialRows above).
  const bucketMapRealized = new Map<string, BucketAcc>();
  const bucketMapTotal = new Map<string, BucketAcc>();
  const pushIntoBucket = (
    map: Map<string, BucketAcc>,
    closedDate: string,
    pnl: number,
    label: string,
  ) => {
    const key = bucketKeyFor(closedDate, granularity);
    let b = map.get(key);
    if (!b) {
      b = {
        bucketKey: key,
        label: labelFor(key, granularity),
        tradePnl: 0,
        tradeCount: 0,
        trades: [],
      };
      map.set(key, b);
    }
    b.tradePnl += pnl;
    b.tradeCount += 1;
    b.trades.push({ symbol: label, pnl });
  };
  // Fill-level bucketing for fully-closed option positions + stock
  // sales + still-open positions' banked partial closes. Partial
  // closes land on their OWN fill_date rather than getting lumped onto
  // the position's final closed_date (or, for still-open positions,
  // not appearing at all until full resolution). expired_worthless +
  // assigned positions stay position-level because the expire / assign
  // flows never insert close fills — their P&L lives on the row, not
  // in the fills table.
  //
  // Old vs new total can diverge ONLY when a fully-closed position has
  // partial-close fills straddling the window boundary. The log line
  // below prints both (Realized-scoped, unchanged) so it's visible.
  const fillLevelOptionPositions = allClosed.filter((p) => p.status === "closed");
  const rowLevelOptionPositions = allClosed.filter((p) => p.status !== "closed");
  const parentById = new Map<string, PositionRow>();
  for (const p of fillLevelOptionPositions) parentById.set(p.id, p);
  for (const p of closedStocks) parentById.set(p.id, p);
  for (const p of stillOpenPartialRows) parentById.set(p.id, p);

  let fillLevelOptionsTotal = 0;
  let fillLevelStocksTotal = 0;
  // Sum of pnl from stillOpenPartialRows' fills that fall inside
  // [from, to] — i.e. the slice of "current banked-but-unresolved
  // money" already represented in equity_curve_total's dated buckets.
  // The StatCard/Now-point client logic needs this to avoid counting
  // the same dollars twice: once here (on their real date) and again
  // via the undated, non-windowed total_partial_pnl snapshot.
  let partialClosePnlInWindow = 0;
  const fillLevelIds = [
    ...fillLevelOptionPositions.map((p) => p.id),
    ...closedStocks.map((p) => p.id),
    ...stillOpenPartialRows.map((p) => p.id),
  ];
  if (fillLevelIds.length > 0) {
    const fillsRes = await sb
      .from("fills")
      .select("position_id,fill_date,contracts,premium")
      .eq("fill_type", "close")
      .in("position_id", fillLevelIds)
      .gte("fill_date", from)
      .lte("fill_date", to);
    if (fillsRes.error) {
      console.warn(
        `[intelligence] close fills fetch failed — falling back to row-level: ${fillsRes.error.message}`,
      );
    } else {
      const fillRows = (fillsRes.data ?? []) as Array<{
        position_id: string;
        fill_date: string;
        contracts: number;
        premium: number;
      }>;
      for (const f of fillRows) {
        const parent = parentById.get(f.position_id);
        if (!parent) continue;
        const isStillOpenPartial = stillOpenPartialIds.has(f.position_id);
        const isStock =
          parent.position_type === "stock_long" ||
          parent.position_type === "stock_short";
        let pnl: number;
        if (isStock) {
          // Stock per-share: (sale price − cost basis) × shares. No
          // × 100 multiplier here — premium IS the per-share dollar
          // value and contracts is the share count.
          const basis = Number(parent.entry_stock_price ?? 0);
          pnl = (Number(f.premium) - basis) * Number(f.contracts);
          if (!isStillOpenPartial) fillLevelStocksTotal += pnl;
        } else {
          // Options: avg open premium against this close fill's
          // premium, sign-flipped for longs. Uses the row's stored
          // avg_premium_sold so this matches the existing
          // realizedPnl(fills, direction) math (recomputed on the
          // server every recalc).
          const avg = Number(parent.avg_premium_sold ?? 0);
          const direction = parent.direction === "long" ? "long" : "short";
          const diff =
            direction === "long"
              ? Number(f.premium) - avg
              : avg - Number(f.premium);
          pnl = diff * Number(f.contracts) * 100;
          if (!isStillOpenPartial) fillLevelOptionsTotal += pnl;
        }
        const label = isStock ? `${parent.symbol} (stock)` : parent.symbol;
        // Total always gets it. Realized only gets it when the
        // position has actually resolved — still-open partial closes
        // are current, banked, real money, but not a finished trade.
        pushIntoBucket(bucketMapTotal, f.fill_date, pnl, label);
        if (isStillOpenPartial) {
          partialClosePnlInWindow += pnl;
        } else {
          pushIntoBucket(bucketMapRealized, f.fill_date, pnl, label);
        }
      }
    }
  }

  // expired_worthless + assigned (no fills) — bucket on closed_date.
  // Always fully resolved by definition (drawn from allClosed, which
  // excludes status='open'), so both series get it.
  let rowLevelTotal = 0;
  for (const p of rowLevelOptionPositions) {
    if (!p.closed_date) continue;
    if (p.closed_date < from || p.closed_date > to) continue;
    const pnl = Number(p.realized_pnl ?? 0);
    rowLevelTotal += pnl;
    pushIntoBucket(bucketMapRealized, p.closed_date, pnl, p.symbol);
    pushIntoBucket(bucketMapTotal, p.closed_date, pnl, p.symbol);
  }

  const oldEquityTotal =
    windowed.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) +
    windowedStocks.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);
  const newEquityTotal =
    fillLevelOptionsTotal + fillLevelStocksTotal + rowLevelTotal;
  const equityDelta =
    Math.round((newEquityTotal - oldEquityTotal) * 100) / 100;
  console.log(
    `[intelligence] equity_curve totals: old=${oldEquityTotal.toFixed(2)} new=${newEquityTotal.toFixed(2)} delta=${equityDelta.toFixed(2)} (delta != 0 ⇒ partial closes straddling window boundary)`,
  );

  // Zero-fill only on day granularity so the line stays continuous across
  // weekends / no-trade days. Week + month buckets skip the fill — empty
  // months would stretch the x-axis without adding information.
  if (granularity === "day") {
    let cursor = from;
    while (cursor <= to) {
      for (const map of [bucketMapRealized, bucketMapTotal]) {
        if (!map.has(cursor)) {
          map.set(cursor, {
            bucketKey: cursor,
            label: labelFor(cursor, "day"),
            tradePnl: 0,
            tradeCount: 0,
            trades: [],
          });
        }
      }
      cursor = addDaysIso(cursor, 1);
    }
  }

  function buildCurve(map: Map<string, BucketAcc>) {
    const sortedKeys = Array.from(map.keys()).sort();
    let running = 0;
    return sortedKeys.map((k) => {
      const b = map.get(k)!;
      running += b.tradePnl;
      return {
        bucketKey: b.bucketKey,
        label: b.label,
        tradePnl: b.tradePnl,
        tradeCount: b.tradeCount,
        trades: b.trades,
        cumulativePnl: Math.round(running * 100) / 100,
      };
    });
  }
  const equity_curve = buildCurve(bucketMapRealized);
  const equity_curve_total = buildCurve(bucketMapTotal);

  // ---------- Section 2: ticker rankings (uses ALL closed within broker filter) ----------
  type TickerBucket = {
    symbol: string;
    trades: number;
    wins: number;
    rocs: number[];
    bestRoc: number | null;
    grades: Record<string, number>;
    positionIds: string[];
    closedTrades: Array<{
      opened_date: string;
      closed_date: string | null;
      avg_premium_sold: number | null;
      realized_pnl: number | null;
      roc: number | null;
      grade: string | null;
    }>;
  };
  const bySymbol = new Map<string, TickerBucket>();
  for (const p of allClosed) {
    const b = bySymbol.get(p.symbol) ?? {
      symbol: p.symbol,
      trades: 0,
      wins: 0,
      rocs: [],
      bestRoc: null,
      grades: {},
      positionIds: [],
      closedTrades: [],
    };
    b.trades += 1;
    b.positionIds.push(p.id);
    const pnl = Number(p.realized_pnl ?? 0);
    if (pnl > 0) b.wins += 1;
    const roc = computeROC(pnl, p.strike, p.total_contracts);
    if (roc !== null) {
      b.rocs.push(roc);
      if (b.bestRoc === null || roc > b.bestRoc) b.bestRoc = roc;
    }
    const g = p.entry_final_grade ?? "?";
    b.grades[g] = (b.grades[g] ?? 0) + 1;
    b.closedTrades.push({
      opened_date: p.opened_date,
      closed_date: p.closed_date,
      avg_premium_sold: p.avg_premium_sold,
      realized_pnl: p.realized_pnl,
      roc,
      grade: p.entry_final_grade,
    });
    bySymbol.set(p.symbol, b);
  }

  const allPositionIds = Array.from(bySymbol.values()).flatMap((b) => b.positionIds);
  // aligned/total count only SCORED recs (was_system_aligned set, i.e.
  // an actionable CLOSE/HOLD verdict whose outcome resolved). count is
  // every rec including DATA_GATE/MONITOR — the UI uses it to show
  // "n recs · unscored" instead of a bare "—" so a wired-but-not-yet-
  // scoreable engine is distinguishable from "no recs at all".
  const recsBySymbol = new Map<string, { aligned: number; total: number; count: number }>();
  if (allPositionIds.length > 0) {
    const recsRes = await sb
      .from("post_earnings_recommendations")
      .select("position_id,recommendation,confidence,was_system_aligned,analysis_date")
      .in("position_id", allPositionIds);
    const allRecs = (recsRes.data ?? []) as RecRow[];
    const positionIdToSymbol = new Map<string, string>();
    for (const [sym, b] of Array.from(bySymbol.entries())) {
      for (const pid of b.positionIds) positionIdToSymbol.set(pid, sym);
    }
    for (const r of allRecs) {
      const sym = positionIdToSymbol.get(r.position_id);
      if (!sym) continue;
      const cur = recsBySymbol.get(sym) ?? { aligned: 0, total: 0, count: 0 };
      cur.count += 1;
      if (r.was_system_aligned !== null) {
        cur.total += 1;
        if (r.was_system_aligned === true) cur.aligned += 1;
      }
      recsBySymbol.set(sym, cur);
    }
  }

  const ticker_rankings = Array.from(bySymbol.values())
    .map((b) => {
      const avg_roc = b.rocs.length > 0 ? b.rocs.reduce((s, v) => s + v, 0) / b.rocs.length : null;
      const mostCommonGrade = Object.entries(b.grades).sort(
        (a, b2) => b2[1] - a[1],
      )[0]?.[0] ?? null;
      const recInfo = recsBySymbol.get(b.symbol) ?? null;
      return {
        symbol: b.symbol,
        trades: b.trades,
        wins: b.wins,
        win_rate: b.trades > 0 ? b.wins / b.trades : 0,
        avg_roc,
        best_roc: b.bestRoc,
        top_grade: mostCommonGrade === "?" ? null : mostCommonGrade,
        rec_aligned: recInfo?.aligned ?? null,
        rec_total: recInfo?.total ?? null,
        rec_count: recInfo?.count ?? null,
        closed_trades: b.closedTrades.sort((a, b2) =>
          (b2.closed_date ?? "").localeCompare(a.closed_date ?? ""),
        ),
      };
    })
    .sort((a, b) => {
      const ar = a.avg_roc ?? -Infinity;
      const br = b.avg_roc ?? -Infinity;
      return br - ar;
    });

  // ---------- Section 3: pattern intelligence (10+ trade threshold) ----------
  const totalClosedAllTime = allClosed.length;
  const patternsEnabled = totalClosedAllTime >= 10;

  function bucket<K extends string>(
    rows: PositionRow[],
    key: (p: PositionRow) => K | null,
    keys: K[],
  ) {
    const out: Array<{ key: K; trades: number; wins: number; win_rate: number; avg_roc: number | null }> = [];
    for (const k of keys) {
      const subset = rows.filter((p) => key(p) === k);
      const wins = subset.filter((p) => Number(p.realized_pnl ?? 0) > 0).length;
      const rocs = subset
        .map((p) => computeROC(p.realized_pnl, p.strike, p.total_contracts))
        .filter((v): v is number => v !== null);
      const avg_roc = rocs.length > 0 ? rocs.reduce((s, v) => s + v, 0) / rocs.length : null;
      out.push({
        key: k,
        trades: subset.length,
        wins,
        win_rate: subset.length > 0 ? wins / subset.length : 0,
        avg_roc,
      });
    }
    return out;
  }

  const by_grade = bucket(
    allClosed,
    (p) => p.entry_final_grade as "A" | "B" | "C" | "F" | null,
    ["A", "B", "C", "F"],
  );
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const by_day_of_week = bucket(
    allClosed.filter((p) => p.closed_date !== null),
    (p) => DOW_LABELS[dayOfWeek(p.closed_date as string)] as (typeof DOW_LABELS)[number],
    ["Mon", "Tue", "Wed", "Thu", "Fri"],
  );
  const by_vix_regime = bucket(
    allClosed,
    (p) => vixBucket(p.entry_vix),
    ["calm", "15-20", "20-25", "panic"],
  );
  const by_dte = bucket(allClosed, (p) => dteBucket(p), [
    "0-2d",
    "3-5d",
    "6-10d",
    ">10d",
  ]);

  // Win rate / ROC by industry via stock_profiles (shared table, 689
  // symbols with industry + market cap). Industries with <2 trades are
  // dropped — one trade tells you nothing about the industry.
  const industryBySymbol = new Map<string, string>();
  {
    const symbols = Array.from(new Set(allClosed.map((p) => p.symbol)));
    if (symbols.length > 0) {
      const profRes = await sb
        .from("stock_profiles")
        .select("symbol,industry")
        .in("symbol", symbols);
      for (const r of (profRes.data ?? []) as Array<{ symbol: string; industry: string | null }>) {
        if (r.industry) industryBySymbol.set(r.symbol.toUpperCase(), r.industry);
      }
    }
  }
  const industryKeys = Array.from(
    new Set(
      allClosed
        .map((p) => industryBySymbol.get(p.symbol) ?? null)
        .filter((v): v is string => v !== null),
    ),
  );
  const by_industry = bucket(
    allClosed,
    (p) => (industryBySymbol.get(p.symbol) ?? null) as string | null,
    industryKeys,
  )
    .filter((b) => b.trades >= 2)
    .sort((x, y) => y.trades - x.trades)
    .slice(0, 10);

  const gradeLookup = new Map(by_grade.map((g) => [g.key, g]));
  const a = gradeLookup.get("A");
  const b = gradeLookup.get("B");
  const calibrationDrift =
    !!a && !!b && a.trades > 0 && b.trades > 0 && a.win_rate < b.win_rate;

  let rec_accuracy: {
    close_correct: number;
    close_total: number;
    hold_correct: number;
    hold_total: number;
    overall_pct: number;
  } | null = null;
  if (allPositionIds.length > 0) {
    const recsRes = await sb
      .from("post_earnings_recommendations")
      .select("recommendation,was_system_aligned")
      .in("position_id", allPositionIds);
    const allRecs = ((recsRes.data ?? []) as Array<{
      recommendation: string;
      was_system_aligned: boolean | null;
    }>).filter((r) => r.was_system_aligned !== null);
    if (allRecs.length >= 5) {
      const close = allRecs.filter((r) => r.recommendation === "CLOSE");
      const hold = allRecs.filter((r) => r.recommendation === "HOLD");
      const correct = allRecs.filter((r) => r.was_system_aligned === true).length;
      rec_accuracy = {
        close_correct: close.filter((r) => r.was_system_aligned === true).length,
        close_total: close.length,
        hold_correct: hold.filter((r) => r.was_system_aligned === true).length,
        hold_total: hold.length,
        overall_pct: correct / allRecs.length,
      };
    }
  }

  // ---------- Section: earnings implied-move calibration ----------
  // The core edge of the strategy, measured: for every symbol with 3+
  // (implied, actual) move pairs in earnings_history, how does the
  // options market's priced-in move compare with what actually printed?
  // avg_ratio < 1 ⇒ the market systematically overprices this symbol's
  // earnings move ⇒ its pre-earnings premium is systematically rich —
  // exactly what a CSP seller wants. Shared market data, not user-scoped;
  // `traded` marks symbols in the caller's own closed history.
  type EmCalRow = {
    symbol: string;
    events: number;
    avg_ratio: number;
    within_implied_pct: number;
    avg_implied_pct: number;
    avg_actual_pct: number;
    last_event: string;
    traded: boolean;
  };
  let em_calibration: EmCalRow[] = [];
  {
    const emRes = await sb
      .from("earnings_history")
      .select("symbol,earnings_date,implied_move_pct,actual_move_pct")
      .gt("implied_move_pct", 0);
    if (emRes.error) {
      console.warn(`[intelligence] em calibration fetch failed: ${emRes.error.message}`);
    } else {
      const pairs = ((emRes.data ?? []) as Array<{
        symbol: string;
        earnings_date: string;
        implied_move_pct: number | string;
        actual_move_pct: number | string | null;
      }>).filter((r) => r.actual_move_pct !== null);
      type Acc = {
        ratios: number[];
        within: number;
        implieds: number[];
        actuals: number[];
        last: string;
      };
      const bySym = new Map<string, Acc>();
      for (const r of pairs) {
        const implied = Number(r.implied_move_pct);
        const actual = Math.abs(Number(r.actual_move_pct));
        if (!Number.isFinite(implied) || implied <= 0 || !Number.isFinite(actual)) continue;
        const sym = r.symbol.toUpperCase();
        const acc = bySym.get(sym) ?? {
          ratios: [],
          within: 0,
          implieds: [],
          actuals: [],
          last: r.earnings_date,
        };
        acc.ratios.push(actual / implied);
        if (actual < implied) acc.within += 1;
        acc.implieds.push(implied);
        acc.actuals.push(actual);
        if (r.earnings_date > acc.last) acc.last = r.earnings_date;
        bySym.set(sym, acc);
      }
      const tradedSymbols = new Set(allClosed.map((p) => p.symbol));
      em_calibration = Array.from(bySym.entries())
        .filter(([, a]) => a.ratios.length >= 3)
        .map(([symbol, a]) => ({
          symbol,
          events: a.ratios.length,
          avg_ratio: a.ratios.reduce((s, v) => s + v, 0) / a.ratios.length,
          within_implied_pct: a.within / a.ratios.length,
          avg_implied_pct: a.implieds.reduce((s, v) => s + v, 0) / a.implieds.length,
          avg_actual_pct: a.actuals.reduce((s, v) => s + v, 0) / a.actuals.length,
          last_event: a.last,
          traded: tradedSymbols.has(symbol),
        }))
        .sort((x, y) => x.avg_ratio - y.avg_ratio)
        .slice(0, 60);
    }
  }

  // ---------- Section 4: export payload ----------
  const vixMap = new Map(by_vix_regime.map((v) => [v.key, v]));
  const export_payload = {
    export_date: new Date().toISOString(),
    date_range: { from, to },
    broker_filter: broker ?? "all",
    summary: {
      total_closed_trades: totalClosedAllTime,
      overall_win_rate:
        totalClosedAllTime > 0
          ? allClosed.filter((p) => Number(p.realized_pnl ?? 0) > 0).length / totalClosedAllTime
          : 0,
      overall_avg_roc: (() => {
        const rocs = allClosed
          .map((p) => computeROC(p.realized_pnl, p.strike, p.total_contracts))
          .filter((v): v is number => v !== null);
        return rocs.length > 0 ? rocs.reduce((s, v) => s + v, 0) / rocs.length : 0;
      })(),
      total_realized_pnl: allClosed.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0),
    },
    closed_positions: allClosed.map((p) => ({
      symbol: p.symbol,
      strike: Number(p.strike),
      expiry: p.expiry,
      contracts: p.total_contracts,
      avg_premium_sold: p.avg_premium_sold,
      realized_pnl: p.realized_pnl,
      roc: computeROC(p.realized_pnl, p.strike, p.total_contracts),
      opened_date: p.opened_date,
      closed_date: p.closed_date,
      entry_final_grade: p.entry_final_grade,
      entry_crush_grade: p.entry_crush_grade,
      entry_iv_edge: p.entry_iv_edge,
      entry_em_pct: p.entry_em_pct,
      entry_vix: p.entry_vix,
      broker: p.broker,
    })),
    grade_accuracy: Object.fromEntries(
      by_grade
        .filter((g) => g.trades > 0)
        .map((g) => [g.key, { trades: g.trades, wins: g.wins, win_rate: g.win_rate }]),
    ),
    ticker_rankings: ticker_rankings.map((t) => ({
      symbol: t.symbol,
      trades: t.trades,
      win_rate: t.win_rate,
      avg_roc: t.avg_roc,
    })),
    patterns: {
      best_day_of_week:
        by_day_of_week.length > 0 && by_day_of_week.some((d) => d.trades > 0)
          ? by_day_of_week.reduce((best, d) => (d.win_rate > best.win_rate ? d : best))
              .key
          : null,
      best_grade:
        by_grade.length > 0 && by_grade.some((g) => g.trades > 0)
          ? by_grade
              .filter((g) => g.trades > 0)
              .reduce((best, g) => (g.win_rate > best.win_rate ? g : best)).key
          : null,
      vix_calm_win_rate: vixMap.get("calm")?.win_rate ?? null,
      // Combined 15-25 band, preserving the old export field's meaning
      // after the bucket split.
      vix_elevated_win_rate: (() => {
        const lo = vixMap.get("15-20");
        const hi = vixMap.get("20-25");
        const trades = (lo?.trades ?? 0) + (hi?.trades ?? 0);
        const wins = (lo?.wins ?? 0) + (hi?.wins ?? 0);
        return trades > 0 ? wins / trades : null;
      })(),
      vix_panic_win_rate: vixMap.get("panic")?.win_rate ?? null,
    },
  };

  // ---------- Section: paired assignments ----------
  // For each closed stock_long that came from a put assignment,
  // surface the linked put + stock pair as a combined trade
  // summary. Driven by assignment_source_id. Open stocks are not
  // included — the closing P&L only crystallizes on sale.
  const putById = new Map<string, PositionRow>();
  for (const r of allClosedRaw) {
    if (r.position_type === "stock_long" || r.position_type === "stock_short") continue;
    putById.set(r.id, r);
  }
  type PairedAssignment = {
    symbol: string;
    broker: string | null;
    parent: {
      positionId: string;
      strike: number;
      expiry: string;
      contracts: number;
      avgPremiumSold: number | null;
      realizedPnl: number;
      closedDate: string | null;
    } | null;
    stock: {
      positionId: string;
      shares: number;
      costBasis: number | null;
      realizedPnl: number;
      closedDate: string | null;
    };
    totalPnl: number;
  };
  const paired_assignments: PairedAssignment[] = [];
  for (const s of closedStocks) {
    if (!s.assignment_source_id) continue;
    const parent = putById.get(s.assignment_source_id) ?? null;
    const stockPnl = Number(s.realized_pnl ?? 0);
    const parentPnl = parent ? Number(parent.realized_pnl ?? 0) : 0;
    paired_assignments.push({
      symbol: s.symbol,
      broker: s.broker,
      parent: parent
        ? {
            positionId: parent.id,
            strike: Number(parent.strike),
            expiry: parent.expiry,
            contracts: Number(parent.total_contracts ?? 0),
            avgPremiumSold:
              parent.avg_premium_sold !== null
                ? Number(parent.avg_premium_sold)
                : null,
            realizedPnl: parentPnl,
            closedDate: parent.closed_date,
          }
        : null,
      stock: {
        positionId: s.id,
        shares: Number(s.total_contracts ?? 0),
        costBasis:
          s.entry_stock_price !== null ? Number(s.entry_stock_price) : null,
        realizedPnl: stockPnl,
        closedDate: s.closed_date,
      },
      totalPnl: Math.round((stockPnl + parentPnl) * 100) / 100,
    });
  }
  paired_assignments.sort((a, b) =>
    (b.stock.closedDate ?? "").localeCompare(a.stock.closedDate ?? ""),
  );

  // ---------- Section: partial closes ----------
  // Open positions that already have a non-zero realized_pnl —
  // someone bought back / sold a portion but left the rest open.
  // Surfaced separately (NOT rolled into total_pnl / win_rate /
  // ROC) because the position hasn't fully resolved yet and the
  // realized number is provisional. Broker filter respected.
  // Reuses stillOpenPartialRows (fetched earlier, same filter — status
  // 'open' + nonzero realized_pnl + null closed_date) rather than
  // re-querying; that array already feeds the equity curve's Total
  // series with the exact same position set, so this can't drift from
  // it.

  // Compute remaining contracts (or shares) per position from fills.
  const remainingByPosition = new Map<string, number>();
  if (stillOpenPartialRows.length > 0) {
    const ids = stillOpenPartialRows.map((p) => p.id);
    const fillsRes = await sb
      .from("fills")
      .select("position_id,fill_type,contracts")
      .in("position_id", ids);
    type FillProbe = {
      position_id: string;
      fill_type: string;
      contracts: number;
    };
    const byPos = new Map<string, FillProbe[]>();
    for (const f of (fillsRes.data ?? []) as FillProbe[]) {
      const arr = byPos.get(f.position_id) ?? [];
      arr.push(f);
      byPos.set(f.position_id, arr);
    }
    for (const id of ids) {
      const fills = byPos.get(id) ?? [];
      const opened = fills
        .filter((f) => f.fill_type === "open")
        .reduce((s, f) => s + Number(f.contracts), 0);
      const closed = fills
        .filter((f) => f.fill_type === "close")
        .reduce((s, f) => s + Number(f.contracts), 0);
      remainingByPosition.set(id, Math.max(0, opened - closed));
    }
  }

  type PartialClose = {
    positionId: string;
    symbol: string;
    strike: number;
    broker: string | null;
    positionType: "option" | "stock_long" | "stock_short";
    realizedPnl: number;
    remainingContracts: number;
    updatedAt: string;
  };
  const partial_closes: PartialClose[] = stillOpenPartialRows
    .map((p) => {
      const remaining = remainingByPosition.get(p.id) ?? 0;
      const pt =
        p.position_type === "stock_long" || p.position_type === "stock_short"
          ? (p.position_type as "stock_long" | "stock_short")
          : ("option" as const);
      return {
        positionId: p.id,
        symbol: p.symbol,
        strike: Number(p.strike ?? 0),
        broker: p.broker,
        positionType: pt,
        realizedPnl: Number(p.realized_pnl),
        remainingContracts: remaining,
        updatedAt: p.updated_at,
      };
    })
    .filter((p) => p.remainingContracts > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const total_partial_pnl =
    Math.round(
      partial_closes.reduce((s, p) => s + p.realizedPnl, 0) * 100,
    ) / 100;

  return NextResponse.json({
    date_range: { from, to },
    broker: broker ?? "all",
    granularity,
    stats: {
      total_pnl: totals.total_pnl,
      // Combined headline includes closed stock_long realized so the
      // Realized P&L card reflects actual book P&L. These three stay
      // row-level and windowed exactly as before — period totals must
      // not move regardless of how outcomes below get grouped.
      stock_total_pnl: stockTotalPnl,
      combined_realized_pnl:
        Math.round((totals.total_pnl + stockTotalPnl) * 100) / 100,
      // Win rate / expectancy / avg ROC / best-worst are campaign-level:
      // one outcome per unbroken earnings-to-flat exposure (all legs,
      // option and stock, netted), not one per row. A campaign counts
      // toward this window if its LAST leg closed in [from, to] — see
      // the campaign-level computation above. total_trades here means
      // total campaigns, not total rows.
      win_rate: campaignWinRate,
      wins: campaignTotals.wins,
      total_trades: campaignTotalCount,
      avg_roc: campaignAvgRoc,
      expectancy: campaignExpectancy,
      best_trade: campaignTotals.best,
      worst_trade: campaignTotals.worst,
      // ~15 chains account-wide have no resolvable earnings event and
      // fall back to chain-level grouping above rather than vanishing
      // from win_rate/expectancy — this reports how many of the
      // in-window campaigns are really unresolved single chains, and
      // how much of the window's outcome P&L sits in them.
      unresolved_campaigns: {
        count: windowedUnresolvedCampaigns.length,
        pnl: unresolvedCampaignsPnlInWindow,
        all_time_count: unresolvedEarningsCampaigns.length,
        all_time_pnl: unresolvedCampaignsPnlAllTime,
      },
    },
    equity_curve,
    // Total-mode series: same bucketing, but still-open positions'
    // already-banked partial-close fills are included on their own
    // fill_date (equity_curve stays resolved-trades-only, unchanged).
    equity_curve_total,
    // Sum of still-open partial-close pnl whose fill_date falls inside
    // [from, to] — i.e. the slice already reflected in
    // equity_curve_total's dated buckets. The client subtracts this
    // from total_partial_pnl (which is a non-windowed "right now"
    // snapshot) before adding the remainder to the "Now" point, so
    // in-window banked money isn't counted both on its real date and
    // again in the snapshot.
    partial_close_pnl_in_window:
      Math.round(partialClosePnlInWindow * 100) / 100,
    ticker_rankings,
    patterns: {
      enabled: patternsEnabled,
      total_closed: totalClosedAllTime,
      by_grade,
      by_day_of_week,
      by_vix_regime,
      by_dte,
      by_industry,
      calibration: {
        drift: calibrationDrift,
        summary: calibrationDrift
          ? "⚠ Calibration drift: Grade B outperforming Grade A. Review your A-grade selection criteria."
          : a && b && a.trades > 0
            ? "Screener is calibrated: higher grades are winning at higher rates."
            : "Need more A/B trades to assess calibration.",
      },
      rec_accuracy,
    },
    em_calibration,
    paired_assignments,
    partial_closes,
    total_partial_pnl,
    export_payload,
  });
}
