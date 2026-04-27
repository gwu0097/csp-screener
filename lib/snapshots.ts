// Shared position_snapshots row builder. Used by:
//   - /api/screener/analyze: snapshots every open position on Run Analysis
//   - /api/trades/bulk-create: snapshots the position at close time
//
// Keep the per-field math in one place so the intraday time series has
// consistent units across both call sites.
import {
  getOptionsChain,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "@/lib/schwab";
import { remainingContracts, type Fill } from "@/lib/positions";
import { createServerClient } from "@/lib/supabase";

// Rate limit for "Refresh live data" snapshot writes. Prevents the
// table from flooding if the user mashes the button. One snapshot per
// position per 60 minutes; Run Analysis (a less frequent trigger) is
// not rate-limited and takes precedence.
export const SNAPSHOT_RATE_LIMIT_MINUTES = 60;

// Returns true when no snapshot exists for the position OR the most
// recent one is at least SNAPSHOT_RATE_LIMIT_MINUTES old. Used to
// gate per-refresh writes.
export async function shouldWriteSnapshot(positionId: string): Promise<boolean> {
  const sb = createServerClient();
  const r = await sb
    .from("position_snapshots")
    .select("snapshot_time")
    .eq("position_id", positionId)
    .order("snapshot_time", { ascending: false })
    .limit(1);
  const rows = (r.data ?? []) as Array<{ snapshot_time: string | null }>;
  if (rows.length === 0) return true;
  const last = rows[0].snapshot_time;
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (!Number.isFinite(lastMs)) return true;
  const ageMinutes = (Date.now() - lastMs) / 60000;
  return ageMinutes >= SNAPSHOT_RATE_LIMIT_MINUTES;
}

export type SnapshotPosition = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  avg_premium_sold: number | null;
  opened_date: string | null;
  entry_stock_price: number | null;
  entry_em_pct: number | null;
};

export type SnapshotRow = {
  position_id: string;
  snapshot_time: string;
  stock_price: number | null;
  option_price: number | null;
  pnl_pct: number | null;
  pnl_dollars: number | null;
  current_iv: number | null;
  current_delta: number | null;
  current_theta: number | null;
  actual_move_pct: number | null;
  move_ratio: number | null;
  days_since_entry: number | null;
  pct_premium_remaining: number | null;
  close_snapshot: boolean;
};

// Pull the put at the given strike out of a Schwab chain.
//
// Resilient matching, because two kinds of drift show up in the wild:
//   - Stored expiry can land on a Sat/Sun (settlement date parsed off a
//     broker screenshot instead of the Friday expiry). We tolerate up to
//     ±7 days and pick the closest available expiry.
//   - Stored strike can be an integer ("310") while Schwab keys are
//     "310.0". We try several string formats, then fuzzy-match to the
//     closest strike within $0.50.
//
// Warns on every fallback so we can spot systemic drift in the logs.
const EXPIRY_TOLERANCE_DAYS = 7;
const STRIKE_TOLERANCE = 0.5;

function parseExpiryKeyDate(expKey: string): number | null {
  // Schwab keys look like "2026-04-24:1" — strip the ":DTE" suffix.
  const iso = expKey.slice(0, 10);
  const ms = new Date(iso + "T00:00:00Z").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function pickPutContract(
  chain: SchwabOptionsChain,
  strike: number,
  expiry: string,
): SchwabOptionContract | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  if (keys.length === 0) return null;

  // 1. Expiry match. Order:
  //    a) exact startsWith
  //    b) if requested date is Sat/Sun, snap to preceding Friday and retry
  //       (broker screenshots sometimes show "settlement date" = Fri + 2)
  //    c) nearest expiry within ±7 days as a last-resort fuzzy match
  //       — but only when the matched expiry is today or later. Past
  //       expiries don't exist in the chain anymore, so a fuzzy match
  //       would silently pull a live future-expiry contract's price
  //       and report it as the expired position's value. Auto-expire
  //       relies on null option_price for "no chain data" — so we
  //       must return null here, not a wrong contract.
  const today = todayIsoUtc();
  let expKey = keys.find((k) => k.startsWith(expiry));
  if (!expKey) {
    const d = new Date(expiry + "T00:00:00Z");
    const day = Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
    if (day === 6 || day === 0) {
      const snap = new Date(d);
      snap.setUTCDate(snap.getUTCDate() - (day === 6 ? 1 : 2));
      const fridayIso = snap.toISOString().slice(0, 10);
      expKey = keys.find((k) => k.startsWith(fridayIso));
      if (expKey) {
        console.warn(
          `[snapshots] weekend expiry ${expiry} → snapping to preceding Friday ${fridayIso} (${expKey})`,
        );
      }
    }
  }
  if (!expKey) {
    // If the requested expiry is in the past, the contract no longer
    // exists in any live chain. Fuzzy-matching across the expiration
    // boundary picks a different (live) contract whose price has
    // nothing to do with this position. Auto-expire relies on null
    // option_price for "no chain data" — so we must return null here.
    if (expiry < today) {
      console.warn(
        `[snapshots] requested expiry ${expiry} is in the past and not in chain — returning null (no fuzzy fallback for past expiries)`,
      );
      return null;
    }
    const targetMs = new Date(expiry + "T00:00:00Z").getTime();
    if (!Number.isFinite(targetMs)) return null;
    let bestKey: string | null = null;
    let bestDiff = Infinity;
    for (const k of keys) {
      const ms = parseExpiryKeyDate(k);
      if (ms === null) continue;
      const diff = Math.abs(ms - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestKey = k;
      }
    }
    if (!bestKey || bestDiff > EXPIRY_TOLERANCE_DAYS * 86400000) {
      console.warn(
        `[snapshots] no expiry within ±${EXPIRY_TOLERANCE_DAYS}d of ${expiry}; available=[${keys.slice(0, 5).join(",")}...]`,
      );
      return null;
    }
    // Reject any fuzzy match whose ISO date is strictly before today.
    // (Belt-and-suspenders alongside the past-requested-expiry guard
    // above — covers an edge case where Schwab returns a stale chain.)
    const matchedIso = bestKey.slice(0, 10);
    if (matchedIso < today) {
      console.warn(
        `[snapshots] fuzzy expiry match ${matchedIso} for requested ${expiry} is in the past — returning null`,
      );
      return null;
    }
    console.warn(
      `[snapshots] expiry drift: requested=${expiry} → using=${bestKey} (Δ ${Math.round(bestDiff / 86400000)}d)`,
    );
    expKey = bestKey;
  }

  const strikes = chain.putExpDateMap[expKey];

  // 2. Strike match — try several string formats before falling back to
  // a numeric scan. Schwab uses "345.0" / "347.5" for half-strikes, and
  // positions stored with integer strikes produce "310" via String(Number(...)).
  const candidates = [
    String(Number(strike)),
    Number(strike).toFixed(1),
    Number(strike).toFixed(2),
  ];
  for (const key of candidates) {
    const arr = strikes[key];
    if (arr && arr.length > 0) return arr[0];
  }

  // 3. Fuzzy match within the $0.50 tolerance window.
  let best: SchwabOptionContract | null = null;
  let bestDiff = Infinity;
  for (const arr of Object.values(strikes)) {
    for (const c of arr) {
      const d = Math.abs(c.strikePrice - strike);
      if (d < bestDiff) {
        best = c;
        bestDiff = d;
      }
    }
  }
  if (!best || bestDiff > STRIKE_TOLERANCE) {
    console.warn(
      `[snapshots] no strike within $${STRIKE_TOLERANCE.toFixed(2)} of ${strike} at ${expKey}; closest=${best?.strikePrice ?? "none"} Δ=${bestDiff.toFixed(2)}`,
    );
    return null;
  }
  console.warn(
    `[snapshots] strike drift: requested=${strike} → using=${best.strikePrice} (Δ $${bestDiff.toFixed(2)})`,
  );
  return best;
}

// Fetch the full chain for a symbol with graceful fallback. Deliberately
// does NOT filter by expiry at the Schwab level — a stored expiry that's
// slightly off (e.g. Sunday settlement date) would cause Schwab to return
// an empty putExpDateMap. pickPutContract handles expiry matching in-memory
// with tolerance, so we fetch everything and let it pick.
export async function fetchChainSafe(
  symbol: string,
): Promise<SchwabOptionsChain | null> {
  try {
    return await getOptionsChain(symbol);
  } catch (e) {
    console.warn(
      `[snapshots] chain(${symbol}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// Builds the full snapshot row for a position + live chain snapshot.
// Every computed field is null-safe: a position missing entry_stock_price
// or a missing chain just yields nulls on the dependent fields, we never
// throw. `closeSnapshot` tags rows captured at the moment the user closed
// so downstream analytics can separate "final condition" from "intraday".
export function buildSnapshotRow(
  position: SnapshotPosition,
  chain: SchwabOptionsChain | null,
  fills: Fill[],
  opts: { nowIso: string; closeSnapshot: boolean },
): SnapshotRow {
  const contract = chain ? pickPutContract(chain, Number(position.strike), position.expiry) : null;
  const optionPrice = contract?.mark ?? null;
  const stockPrice =
    chain?.underlying?.mark ??
    chain?.underlying?.last ??
    chain?.underlyingPrice ??
    null;

  const remaining = remainingContracts(fills);
  const soldPremium = Number(position.avg_premium_sold ?? 0);
  let pnlDollars: number | null = null;
  let pnlPct: number | null = null;
  if (optionPrice !== null && soldPremium > 0 && remaining > 0) {
    pnlDollars = (soldPremium - optionPrice) * remaining * 100;
    pnlPct = (soldPremium - optionPrice) / soldPremium;
  }

  // Schwab returns volatility as a percent (193.2 = 193.2% IV). Store as
  // decimal to match entry_em_pct / entry_iv_edge conventions.
  const currentIv =
    contract && Number.isFinite(contract.volatility) ? contract.volatility / 100 : null;
  const currentDelta =
    contract && Number.isFinite(contract.delta) ? contract.delta : null;
  const currentTheta =
    contract && Number.isFinite(contract.theta) ? contract.theta : null;

  const entryPx = Number(position.entry_stock_price ?? 0);
  const actualMovePct =
    stockPrice !== null && entryPx > 0 ? Math.abs(stockPrice - entryPx) / entryPx : null;
  const entryEm = Number(position.entry_em_pct ?? 0);
  const moveRatio =
    actualMovePct !== null && entryEm > 0 ? actualMovePct / entryEm : null;

  // opened_date is YYYY-MM-DD; parse as UTC midnight to avoid TZ drift.
  let daysSinceEntry: number | null = null;
  if (position.opened_date) {
    const openedMs = new Date(position.opened_date + "T00:00:00Z").getTime();
    const todayMs = new Date(opts.nowIso.slice(0, 10) + "T00:00:00Z").getTime();
    if (Number.isFinite(openedMs) && Number.isFinite(todayMs)) {
      daysSinceEntry = Math.max(0, Math.floor((todayMs - openedMs) / 86400000));
    }
  }

  // 1.0 = no decay, 0.0 = fully decayed, >1.0 = option now priced above entry.
  const pctPremiumRemaining =
    optionPrice !== null && soldPremium > 0 ? optionPrice / soldPremium : null;

  return {
    position_id: position.id,
    snapshot_time: opts.nowIso,
    stock_price: stockPrice,
    option_price: optionPrice,
    pnl_pct: pnlPct,
    pnl_dollars: pnlDollars,
    current_iv: currentIv,
    current_delta: currentDelta,
    current_theta: currentTheta,
    actual_move_pct: actualMovePct,
    move_ratio: moveRatio,
    days_since_entry: daysSinceEntry,
    pct_premium_remaining: pctPremiumRemaining,
    close_snapshot: opts.closeSnapshot,
  };
}
