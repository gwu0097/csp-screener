// Shared watchlist metadata helpers. Each user has one non-deletable
// "Portfolio" watchlist (allocation/flags/action/catalyst/digest) plus
// any number of simpler custom watchlists (symbol + thesis + Buy Zone
// only). See migrations/2026-07-21-add-watchlists.sql.
import { createServerClient } from "@/lib/supabase";

export type WatchlistMeta = {
  id: string;
  user_id: string;
  name: string;
  is_portfolio: boolean;
  created_at: string;
  updated_at: string;
};

// Portfolio-watchlist thesis flags. Moved here (out of
// app/api/longterm/watchlist/route.ts, which can only export HTTP
// handlers) so other routes — e.g. Earnings Watch — can display the
// same flags without a second copy drifting out of sync.
export type FlagKind =
  | "COMPOUNDER"
  | "TURNAROUND"
  | "VALUE_TRAP"
  | "STRETCHED"
  | "DEAD_WEIGHT"
  | "FALLING_KNIFE";

export type Flag = {
  kind: FlagKind;
  label: string;
  description: string;
};

// Multi-flag classifier. Each rule checks for a specific
// long-horizon pattern and the combination of flags on a row tells the
// story. Severity-ordered so DEAD_WEIGHT and FALLING_KNIFE land first
// when both are visible (only 2 fit on the row).
export function computeFlags(input: {
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

// Idempotent create-if-missing so a brand-new user (no backfilled row)
// still always has a Portfolio watchlist to resolve against.
export async function ensurePortfolioWatchlist(userId: string): Promise<WatchlistMeta> {
  const sb = createServerClient();
  const existing = await sb
    .from("watchlists")
    .select("*")
    .eq("user_id", userId)
    .eq("is_portfolio", true)
    .limit(1);
  if (!existing.error && existing.data && existing.data.length > 0) {
    return existing.data[0] as WatchlistMeta;
  }
  const ins = await sb
    .from("watchlists")
    .insert({ user_id: userId, name: "Portfolio", is_portfolio: true })
    .select()
    .single();
  if (!ins.error && ins.data) {
    return ins.data as WatchlistMeta;
  }
  // Concurrent first-request race — the unique partial index on
  // (user_id) WHERE is_portfolio rejected a second insert. Re-fetch
  // the one that won.
  if (ins.error?.code === "23505") {
    const retry = await sb
      .from("watchlists")
      .select("*")
      .eq("user_id", userId)
      .eq("is_portfolio", true)
      .limit(1)
      .single();
    if (!retry.error && retry.data) return retry.data as WatchlistMeta;
  }
  throw new Error(`Failed to ensure Portfolio watchlist: ${ins.error?.message}`);
}
