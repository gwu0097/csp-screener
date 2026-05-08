// Expiry classification + user-confirmed close for positions past
// their expiry date. The classifier tags each position as:
//   - auto_expire: clearly OTM at the latest snapshot — safe to mark
//     worthless. The user still confirms in a modal; nothing closes
//     silently.
//   - verify_assignment: too close to strike at last snapshot —
//     surfaced in the modal with a warning so the user can verify
//     against their broker before closing or recording assignment.
import { createServerClient } from "@/lib/supabase";
import { recordPositionOutcome } from "@/lib/post-earnings";
import { fetchChainSafe, pickPutContract } from "@/lib/snapshots";
import { realizedPnl, type Fill } from "@/lib/positions";

export type ExpiryClassification = "auto_expire" | "verify_assignment" | "pending";

// Pure classifier — inputs only, no DB. Exposed so tests can hit the
// rule logic in isolation and so classifyExpiredPosition stays a thin
// wrapper over a snapshot fetch.
//
// Rule cascade (first match wins):
//   1. pctFromStrike > 0.05                           → auto_expire
//      Stock is >5% OTM at expiry — a put that far out is certainly
//      worthless, so we don't need an option_price to confirm. This
//      catches deep-OTM strikes that drop out of the chain entirely
//      (option_price is null in the snapshot).
//   2. pctFromStrike > 0.02 AND optionPrice < $0.15   → auto_expire
//      Moderately OTM with a confirmed near-zero option price.
//      $0.15 (not $0.05) tolerates intraday snapshots that haven't
//      decayed all the way to zero by close.
//   3. pctFromStrike < 0.02                           → verify_assignment
//      Within 2% of strike — assignment is plausible, user must confirm.
//   4. else                                           → pending
//      Ambiguous (e.g. 2-5% OTM with no option_price): we don't auto-
//      close, but flag for review.
export function classifyFromSnapshot(
  strike: number,
  snapshot: { stock_price: number | null; option_price: number | null } | null,
): {
  classification: ExpiryClassification;
  pctFromStrike: number | null;
} {
  if (!snapshot) return { classification: "pending", pctFromStrike: null };
  const stockPrice = snapshot.stock_price;
  const optionPrice = snapshot.option_price;
  if (stockPrice === null || !Number.isFinite(stockPrice) || strike <= 0) {
    return { classification: "pending", pctFromStrike: null };
  }
  const pctFromStrike = (stockPrice - strike) / strike;
  if (pctFromStrike > 0.05) {
    return { classification: "auto_expire", pctFromStrike };
  }
  if (pctFromStrike > 0.02 && optionPrice !== null && optionPrice < 0.15) {
    return { classification: "auto_expire", pctFromStrike };
  }
  if (pctFromStrike < 0.02) {
    return { classification: "verify_assignment", pctFromStrike };
  }
  return { classification: "pending", pctFromStrike };
}

export function isWeekendUTC(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// US/Eastern wall-clock check — true at or after 4:00pm ET, which is
// the equity option close. Uses Intl.DateTimeFormat with explicit
// timezone instead of UTC arithmetic so DST and the UTC date-rollover
// (UTC date increments at 8pm ET in summer / 7pm ET in winter) don't
// produce false-positive same-day-after-close hits before market
// actually closes.
export function isAfterMarketCloseET(d: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  })
    .format(d)
    .split(":")
    .map((s) => Number(s.trim()));
  const hour = parts[0];
  const minute = parts[1] ?? 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  // 4:00pm ET. Hour can come back as "24" in the 12-hour-cycle edge
  // (midnight ET); treat anything >= 16 as after close.
  if (hour > 16) return true;
  if (hour === 16 && minute >= 0) return true;
  return false;
}

// Today's calendar date in US/Eastern. Used to decide whether a
// position with expiry === todayET is in its expiry day. UTC-based
// today rolls forward at 8pm ET (summer) / 7pm ET (winter), which
// would briefly mis-classify Friday-evening positions as past-expiry
// before market close — using ET keeps the boundary at midnight ET.
export function todayEasternIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

// P&L math, exposed for tests. Auto-expire = full premium kept.
// Assignment = premium minus ITM delta at strike.
export function computeAutoExpirePnl(
  avgPremiumSold: number,
  totalContracts: number,
): number {
  return Math.round(avgPremiumSold * totalContracts * 100 * 100) / 100;
}
export function computeAssignmentPnl(
  strike: number,
  stockPriceAtExpiry: number,
  avgPremiumSold: number,
  totalContracts: number,
): number {
  const optionLoss = (strike - stockPriceAtExpiry) * totalContracts * 100;
  const premiumCollected = avgPremiumSold * totalContracts * 100;
  return Math.round((premiumCollected - optionLoss) * 100) / 100;
}

type ExpiredOpenPosition = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  total_contracts: number;
  avg_premium_sold: number | null;
  status: string;
  opened_date: string;
  closed_date: string | null;
  notes: string | null;
  broker: string | null;
};


// Pulls a live Schwab chain and returns the stock price + put price at
// the position's strike. Used by runAutoExpire to bypass any stale
// position_snapshots row written before today's deploy. Returns nulls
// when the chain or contract isn't available — the classifier's
// deep-OTM rule (>5% pctFromStrike) handles a null option_price
// correctly, so partial data is still actionable.
export async function fetchFreshExpirySnapshot(
  symbol: string,
  strike: number,
  expiry: string,
): Promise<{ stock_price: number | null; option_price: number | null }> {
  const chain = await fetchChainSafe(symbol);
  if (!chain) return { stock_price: null, option_price: null };
  const stock_price =
    chain.underlying?.mark ??
    chain.underlying?.last ??
    chain.underlyingPrice ??
    null;
  const contract = pickPutContract(chain, strike, expiry);
  const option_price = contract?.mark ?? null;
  return { stock_price, option_price };
}

// Returns every position still flagged open whose expiry has either:
//   - strictly elapsed (expiry < today, ET calendar), OR
//   - is today AND market has closed (>= 4pm ET).
// Pre-close same-day positions stay open — they're surfaced via the
// row badge instead. The broker column is included so the
// confirmation modal can group rows by account.
export async function getExpiredPositions(): Promise<ExpiredOpenPosition[]> {
  const sb = createServerClient();
  const r = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,total_contracts,avg_premium_sold,status,opened_date,closed_date,notes,broker",
    )
    .eq("status", "open");
  const all = (r.data ?? []) as ExpiredOpenPosition[];
  const todayEt = todayEasternIso();
  const afterClose = isAfterMarketCloseET();
  return all.filter((p) => {
    if (p.expiry < todayEt) return true;
    if (p.expiry === todayEt && afterClose) return true;
    return false;
  });
}

// Classifies a single expired position based on its most recent
// position_snapshots row. Gating numbers are spec-defined:
//   stock > strike by >2% AND option price < $0.05 → auto_expire
//   otherwise → verify_assignment
// No snapshot at all → pending (can't decide without data).
export async function classifyExpiredPosition(
  position: { id: string; strike: number },
): Promise<{
  classification: ExpiryClassification;
  pctFromStrike: number | null;
  stockPrice: number | null;
  optionPrice: number | null;
}> {
  const sb = createServerClient();
  const s = await sb
    .from("position_snapshots")
    .select("stock_price,option_price,snapshot_time")
    .eq("position_id", position.id)
    .order("snapshot_time", { ascending: false })
    .limit(1);
  const snapshot = ((s.data ?? []) as Array<{
    stock_price: number | null;
    option_price: number | null;
  }>)[0] ?? null;
  const { classification, pctFromStrike } = classifyFromSnapshot(
    Number(position.strike),
    snapshot,
  );
  return {
    classification,
    pctFromStrike,
    stockPrice: snapshot?.stock_price ?? null,
    optionPrice: snapshot?.option_price ?? null,
  };
}

export async function autoExpirePosition(
  positionId: string,
): Promise<{ ok: boolean; realized_pnl: number; contracts_closed: number; reason?: string }> {
  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,total_contracts,avg_premium_sold,notes")
    .eq("id", positionId)
    .limit(1);
  const pos = ((posRes.data ?? []) as ExpiredOpenPosition[])[0];
  if (!pos) return { ok: false, realized_pnl: 0, contracts_closed: 0, reason: "not_found" };

  // Compute REMAINING contracts off the fill set rather than reading
  // total_contracts (which is the historical "ever opened" count and
  // over-counts after partial closes / rolls).
  const fillsRes = await sb
    .from("fills")
    .select("fill_type, contracts, premium, fill_date")
    .eq("position_id", positionId);
  const priorFills = ((fillsRes.data ?? []) as Fill[]) ?? [];
  const opened = priorFills
    .filter((f) => f.fill_type === "open")
    .reduce((s, f) => s + f.contracts, 0);
  const closedContracts = priorFills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  const remaining = Math.max(0, opened - closedContracts);

  if (remaining === 0) {
    // Already fully closed. Surface the existing realized_pnl as a
    // no-op so the caller can decide whether to flag this.
    return {
      ok: false,
      realized_pnl: 0,
      contracts_closed: 0,
      reason: "no_remaining_contracts",
    };
  }

  // Compute total realized P&L by augmenting fills with a synthetic
  // close at premium=0 for the expiring remainder. realizedPnl()
  // already handles the (sold − bought) × closedContracts × 100
  // math correctly across mixed-premium close fills.
  const augmentedFills: Fill[] = [
    ...priorFills,
    {
      fill_type: "close",
      contracts: remaining,
      premium: 0,
      fill_date: pos.expiry,
    },
  ];
  const realized_pnl = Math.round(realizedPnl(augmentedFills) * 100) / 100;

  // Pull pct-from-strike from the latest snapshot so the note has the
  // number that justified the auto-close (useful for later audit).
  const { pctFromStrike } = await classifyExpiredPosition(pos);
  const pctStr =
    pctFromStrike !== null ? `${(pctFromStrike * 100).toFixed(2)}%` : "unknown";
  const noteAdd = `Auto-expired worthless (${remaining} contract${remaining === 1 ? "" : "s"}). Stock ${pctStr} OTM at last snapshot.`;
  const notes = pos.notes ? `${pos.notes} | ${noteAdd}` : noteAdd;

  const u = await sb
    .from("positions")
    .update({
      status: "expired_worthless",
      realized_pnl,
      closed_date: pos.expiry,
      notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", positionId);
  if (u.error) {
    console.warn(`[expire] autoExpirePosition(${positionId}) failed: ${u.error.message}`);
    return { ok: false, realized_pnl, contracts_closed: remaining, reason: u.error.message };
  }

  try {
    await recordPositionOutcome(positionId);
  } catch (e) {
    console.warn(
      `[expire] recordPositionOutcome(${positionId}) threw: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { ok: true, realized_pnl, contracts_closed: remaining };
}

export async function recordAssignment(
  positionId: string,
  stockPriceAtExpiry: number,
): Promise<{ ok: boolean; realized_pnl: number; contracts_closed: number; reason?: string }> {
  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,total_contracts,avg_premium_sold,notes")
    .eq("id", positionId)
    .limit(1);
  const pos = ((posRes.data ?? []) as ExpiredOpenPosition[])[0];
  if (!pos) return { ok: false, realized_pnl: 0, contracts_closed: 0, reason: "not_found" };

  // Same remaining-from-fills logic as autoExpirePosition.
  const fillsRes = await sb
    .from("fills")
    .select("fill_type, contracts, premium, fill_date")
    .eq("position_id", positionId);
  const priorFills = ((fillsRes.data ?? []) as Fill[]) ?? [];
  const opened = priorFills
    .filter((f) => f.fill_type === "open")
    .reduce((s, f) => s + f.contracts, 0);
  const closedContracts = priorFills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  const remaining = Math.max(0, opened - closedContracts);
  if (remaining === 0) {
    return {
      ok: false,
      realized_pnl: 0,
      contracts_closed: 0,
      reason: "no_remaining_contracts",
    };
  }

  const strike = Number(pos.strike);
  const stockPrice = Number(stockPriceAtExpiry);

  // Option A accounting: the put closes with full premium retained
  // (synthetic close at $0, same as worthless). The market loss
  // doesn't live on the put — it carries forward as the stock
  // position's cost basis = strike. Stock unrealized P&L = (spot −
  // strike) × shares accounts for the entire assignment loss.
  // Avoids double-counting against realized_pnl on the put.
  const augmentedFills: Fill[] = [
    ...priorFills,
    {
      fill_type: "close",
      contracts: remaining,
      premium: 0,
      fill_date: pos.expiry,
    },
  ];
  const realized_pnl = Math.round(realizedPnl(augmentedFills) * 100) / 100;

  const noteAdd = `Assigned (${remaining} contract${remaining === 1 ? "" : "s"}). Stock at $${stockPrice.toFixed(2)} vs $${strike.toFixed(2)} strike. Shares received at assignment.`;
  const notes = pos.notes ? `${pos.notes} | ${noteAdd}` : noteAdd;

  const u = await sb
    .from("positions")
    .update({
      status: "assigned",
      realized_pnl,
      closed_date: pos.expiry,
      notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", positionId);
  if (u.error) {
    console.warn(`[expire] recordAssignment(${positionId}) failed: ${u.error.message}`);
    return { ok: false, realized_pnl, contracts_closed: remaining, reason: u.error.message };
  }

  try {
    await recordPositionOutcome(positionId);
  } catch (e) {
    console.warn(
      `[expire] recordPositionOutcome(${positionId}) threw: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { ok: true, realized_pnl, contracts_closed: remaining };
}

export type AutoExpiredSummary = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  realized_pnl: number;
};

export type PendingVerification = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  pctFromStrike: number | null;
  stockPrice: number | null;
  optionPrice: number | null;
  classification: ExpiryClassification;
};

// Every expired position (past or same-day after-close) the user
// must confirm in a modal before it's marked worthless. The modal
// uses pctFromStrike to label each row: comfortably OTM (>5%) vs
// within the assignment window (<=5%, where the user should verify
// against their broker before confirming).
//
// totalContracts is the REMAINING contract count (open fills minus
// close fills) — what the user actually still owes / will be assigned
// on. The DB column position.total_contracts is the historical "ever
// opened" count and would over-count a position that's been
// partially closed already.
export type PendingConfirmation = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  totalContracts: number;
  avgPremiumSold: number | null;
  pctFromStrike: number | null;
  stockPrice: number | null;
  optionPrice: number | null;
  broker: string | null;
};

export type AutoExpireReport = {
  auto_expired: AutoExpiredSummary[];
  needs_verification: PendingVerification[];
  pending: PendingVerification[];
  pending_confirmation: PendingConfirmation[];
  skipped: boolean;
  skipReason?: string;
};

// Orchestrator. Returns every expired position (past or same-day
// after-close) to the UI as a pending_confirmation row. No silent
// auto-close — the modal IS the protection, so no day-of-week gate
// is needed. The classifier output (and pctFromStrike) feeds the
// per-row label so the user sees which rows are clearly worthless
// vs which need an assignment check.
//
// Classification reads a FRESH chain rather than the latest
// position_snapshots row. Snapshots written earlier in the day may
// hold a future-expiry contract's price (a pre-fix bug in
// pickPutContract's fuzzy fallback) — re-fetching forces today's
// post-expiration view, which correctly returns null option_price
// for past-expiry contracts. The deep-OTM rule (>5%) closes the
// position from stock_price alone in that case.
export async function runAutoExpire(): Promise<AutoExpireReport> {
  const empty: AutoExpireReport = {
    auto_expired: [],
    needs_verification: [],
    pending: [],
    pending_confirmation: [],
    skipped: false,
  };

  let positions: ExpiredOpenPosition[];
  try {
    positions = await getExpiredPositions();
  } catch (e) {
    console.log(
      `[expire] ERROR getExpiredPositions: ${e instanceof Error ? e.message : e}`,
    );
    return { ...empty, skipped: true, skipReason: "getExpiredPositions failed" };
  }
  console.log(
    `[expire] found expired: ${JSON.stringify(positions.map((p) => `${p.symbol} ${p.strike}`))}`,
  );
  if (positions.length === 0) return empty;

  // Pull the full fill set for every expired position so we can
  // report REMAINING contracts (not the historical total_contracts
  // denormalized on the row, which over-counts after partial
  // closes). The modal uses this to size assignment + worthless
  // confirms correctly.
  const fillsByPosition = new Map<
    string,
    Array<{ fill_type: string; contracts: number; premium: number; fill_date: string }>
  >();
  {
    const sb = createServerClient();
    const fillRes = await sb
      .from("fills")
      .select("position_id, fill_type, contracts, premium, fill_date")
      .in(
        "position_id",
        positions.map((p) => p.id),
      );
    const fillRows = (fillRes.data ?? []) as Array<{
      position_id: string;
      fill_type: string;
      contracts: number;
      premium: number;
      fill_date: string;
    }>;
    for (const row of fillRows) {
      const arr = fillsByPosition.get(row.position_id) ?? [];
      arr.push({
        fill_type: row.fill_type,
        contracts: row.contracts,
        premium: row.premium,
        fill_date: row.fill_date,
      });
      fillsByPosition.set(row.position_id, arr);
    }
  }

  // Parallelize the per-position chain fetch — each is ~1-3s, 5 in
  // serial would chew most of the 60s route budget.
  const freshByPosition = new Map<
    string,
    { stock_price: number | null; option_price: number | null }
  >();
  await Promise.all(
    positions.map(async (p) => {
      try {
        const fresh = await fetchFreshExpirySnapshot(
          p.symbol,
          Number(p.strike),
          p.expiry,
        );
        const pct =
          fresh.stock_price !== null && Number(p.strike) > 0
            ? ((fresh.stock_price - Number(p.strike)) / Number(p.strike)) * 100
            : null;
        console.log(
          `[expire] fresh snapshot: ${JSON.stringify({
            symbol: p.symbol,
            strike: Number(p.strike),
            stockPrice: fresh.stock_price,
            optionPrice: fresh.option_price,
            pctFromStrike: pct !== null ? `${pct.toFixed(2)}%` : null,
          })}`,
        );
        freshByPosition.set(p.id, fresh);
      } catch (e) {
        console.log(
          `[expire] ERROR fetchFreshExpirySnapshot ${p.symbol} ${p.strike}: ${e instanceof Error ? e.message : e}`,
        );
        freshByPosition.set(p.id, { stock_price: null, option_price: null });
      }
    }),
  );

  const report: AutoExpireReport = { ...empty };
  for (const p of positions) {
    const fresh = freshByPosition.get(p.id) ?? {
      stock_price: null,
      option_price: null,
    };
    const { classification, pctFromStrike } = classifyFromSnapshot(
      Number(p.strike),
      fresh,
    );
    console.log(
      `[expire] classified: ${p.symbol} ${p.strike} → ${classification} (pct=${pctFromStrike !== null ? (pctFromStrike * 100).toFixed(2) + "%" : "—"})`,
    );
    const positionFills = fillsByPosition.get(p.id) ?? [];
    const opened = positionFills
      .filter((f) => f.fill_type === "open")
      .reduce((s, f) => s + f.contracts, 0);
    const closed = positionFills
      .filter((f) => f.fill_type === "close")
      .reduce((s, f) => s + f.contracts, 0);
    const remaining = Math.max(0, opened - closed);
    // Average open premium across all open fills (contracts-weighted).
    const openContractTotal = opened;
    const openDollarTotal = positionFills
      .filter((f) => f.fill_type === "open")
      .reduce((s, f) => s + f.premium * f.contracts, 0);
    const avgPremiumSold =
      openContractTotal > 0 ? openDollarTotal / openContractTotal : null;
    report.pending_confirmation.push({
      positionId: p.id,
      symbol: p.symbol,
      strike: Number(p.strike),
      expiry: p.expiry,
      totalContracts: remaining,
      avgPremiumSold,
      pctFromStrike,
      stockPrice: fresh.stock_price,
      optionPrice: fresh.option_price,
      broker: p.broker ?? null,
    });
  }

  return report;
}
