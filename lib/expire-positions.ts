// Auto-expire + assignment handling for positions that have passed
// their expiry date. Two paths:
//   - auto_expire: clearly OTM + near-zero premium at last snapshot →
//     close worthless, full premium kept.
//   - verify_assignment: too close to strike at last snapshot → leave
//     open, surface a warning in the UI, wait for user to confirm.
//
// Runs on Monday+ only — assignment notices don't clear until Monday
// morning for Friday expiries, so we can't auto-close anything over
// the weekend without risking a false "worthless" on a genuinely
// assigned position.
import { createServerClient } from "@/lib/supabase";
import { recordPositionOutcome } from "@/lib/post-earnings";

export type ExpiryClassification = "auto_expire" | "verify_assignment" | "pending";

// Pure classifier — inputs only, no DB. Exposed so tests can hit the
// rule logic in isolation and so classifyExpiredPosition stays a thin
// wrapper over a snapshot fetch.
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
  // Threshold set to < 0.15 (not < 0.05) because snapshots aren't
  // always taken at market close — an option at $0.13 mid-day on
  // expiry day with stock 2.4% OTM will decay to near-zero by close.
  // $0.15 accounts for the timing gap between snapshot and expiry.
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
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Returns every position still flagged open whose expiry date is
// strictly before today. Same-day (expiry === today) stays open —
// the position resolves at close; we only act the day after.
export async function getExpiredPositions(): Promise<ExpiredOpenPosition[]> {
  const sb = createServerClient();
  const r = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,total_contracts,avg_premium_sold,status,opened_date,closed_date,notes",
    )
    .eq("status", "open")
    .lt("expiry", todayIso());
  return (r.data ?? []) as ExpiredOpenPosition[];
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
): Promise<{ ok: boolean; realized_pnl: number; reason?: string }> {
  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,total_contracts,avg_premium_sold,notes")
    .eq("id", positionId)
    .limit(1);
  const pos = ((posRes.data ?? []) as ExpiredOpenPosition[])[0];
  if (!pos) return { ok: false, realized_pnl: 0, reason: "not_found" };

  const premium = Number(pos.avg_premium_sold ?? 0);
  const contracts = Number(pos.total_contracts ?? 0);
  const realized_pnl = computeAutoExpirePnl(premium, contracts);

  // Pull pct-from-strike from the latest snapshot so the note has the
  // number that justified the auto-close (useful for later audit).
  const { pctFromStrike } = await classifyExpiredPosition(pos);
  const pctStr =
    pctFromStrike !== null ? `${(pctFromStrike * 100).toFixed(2)}%` : "unknown";
  const noteAdd = `Auto-expired worthless. Stock ${pctStr} OTM at last snapshot.`;
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
    return { ok: false, realized_pnl, reason: u.error.message };
  }

  try {
    await recordPositionOutcome(positionId);
  } catch (e) {
    console.warn(
      `[expire] recordPositionOutcome(${positionId}) threw: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { ok: true, realized_pnl };
}

export async function recordAssignment(
  positionId: string,
  stockPriceAtExpiry: number,
): Promise<{ ok: boolean; realized_pnl: number; reason?: string }> {
  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,total_contracts,avg_premium_sold,notes")
    .eq("id", positionId)
    .limit(1);
  const pos = ((posRes.data ?? []) as ExpiredOpenPosition[])[0];
  if (!pos) return { ok: false, realized_pnl: 0, reason: "not_found" };

  const strike = Number(pos.strike);
  const contracts = Number(pos.total_contracts ?? 0);
  const premium = Number(pos.avg_premium_sold ?? 0);
  const realized_pnl = computeAssignmentPnl(
    strike,
    Number(stockPriceAtExpiry),
    premium,
    contracts,
  );

  const noteAdd = `Assigned. Stock at $${Number(stockPriceAtExpiry).toFixed(2)} vs $${strike.toFixed(2)} strike. Shares received at assignment.`;
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
    return { ok: false, realized_pnl, reason: u.error.message };
  }

  try {
    await recordPositionOutcome(positionId);
  } catch (e) {
    console.warn(
      `[expire] recordPositionOutcome(${positionId}) threw: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { ok: true, realized_pnl };
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

export type AutoExpireReport = {
  auto_expired: AutoExpiredSummary[];
  needs_verification: PendingVerification[];
  pending: PendingVerification[];
  skipped: boolean;
  skipReason?: string;
};

// Orchestrator. Weekend-gated (Sat/Sun return skipped) so we don't act
// before Monday assignment notices clear. Auto-closes clearly-worthless
// positions in place; returns the remaining (needs_verification +
// pending) positions for the UI to surface as warnings.
export async function runAutoExpire(): Promise<AutoExpireReport> {
  const empty: AutoExpireReport = {
    auto_expired: [],
    needs_verification: [],
    pending: [],
    skipped: false,
  };
  if (isWeekendUTC(new Date())) {
    return { ...empty, skipped: true, skipReason: "weekend" };
  }

  const positions = await getExpiredPositions();
  const report: AutoExpireReport = { ...empty };

  for (const p of positions) {
    const c = await classifyExpiredPosition(p);
    if (c.classification === "auto_expire") {
      const r = await autoExpirePosition(p.id);
      if (r.ok) {
        report.auto_expired.push({
          positionId: p.id,
          symbol: p.symbol,
          strike: Number(p.strike),
          expiry: p.expiry,
          realized_pnl: r.realized_pnl,
        });
      } else {
        // Treat as pending on failure so it surfaces in the UI and we
        // don't silently lose the position.
        report.pending.push({
          positionId: p.id,
          symbol: p.symbol,
          strike: Number(p.strike),
          expiry: p.expiry,
          pctFromStrike: c.pctFromStrike,
          stockPrice: c.stockPrice,
          optionPrice: c.optionPrice,
          classification: "pending",
        });
      }
    } else if (c.classification === "verify_assignment") {
      report.needs_verification.push({
        positionId: p.id,
        symbol: p.symbol,
        strike: Number(p.strike),
        expiry: p.expiry,
        pctFromStrike: c.pctFromStrike,
        stockPrice: c.stockPrice,
        optionPrice: c.optionPrice,
        classification: c.classification,
      });
    } else {
      report.pending.push({
        positionId: p.id,
        symbol: p.symbol,
        strike: Number(p.strike),
        expiry: p.expiry,
        pctFromStrike: c.pctFromStrike,
        stockPrice: c.stockPrice,
        optionPrice: c.optionPrice,
        classification: c.classification,
      });
    }
  }

  return report;
}
