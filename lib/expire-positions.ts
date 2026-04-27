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
import { fetchChainSafe, pickPutContract } from "@/lib/snapshots";

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
    skipped: false,
  };
  if (isWeekendUTC(new Date())) {
    console.log("[expire] weekend gate — skipping");
    return { ...empty, skipped: true, skipReason: "weekend" };
  }

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
    if (classification === "auto_expire") {
      let r: { ok: boolean; realized_pnl: number; reason?: string };
      try {
        r = await autoExpirePosition(p.id);
      } catch (e) {
        console.log(
          `[expire] ERROR autoExpirePosition ${p.symbol} ${p.strike}: ${e instanceof Error ? e.message : e}`,
        );
        r = { ok: false, realized_pnl: 0, reason: "threw" };
      }
      if (r.ok) {
        console.log(
          `[expire] auto-expired: ${p.symbol} ${p.strike} pnl=$${r.realized_pnl.toFixed(2)}`,
        );
        report.auto_expired.push({
          positionId: p.id,
          symbol: p.symbol,
          strike: Number(p.strike),
          expiry: p.expiry,
          realized_pnl: r.realized_pnl,
        });
      } else {
        console.log(
          `[expire] auto-expire FAILED: ${p.symbol} ${p.strike} reason=${r.reason ?? "unknown"}`,
        );
        report.pending.push({
          positionId: p.id,
          symbol: p.symbol,
          strike: Number(p.strike),
          expiry: p.expiry,
          pctFromStrike,
          stockPrice: fresh.stock_price,
          optionPrice: fresh.option_price,
          classification: "pending",
        });
      }
    } else if (classification === "verify_assignment") {
      report.needs_verification.push({
        positionId: p.id,
        symbol: p.symbol,
        strike: Number(p.strike),
        expiry: p.expiry,
        pctFromStrike,
        stockPrice: fresh.stock_price,
        optionPrice: fresh.option_price,
        classification,
      });
    } else {
      report.pending.push({
        positionId: p.id,
        symbol: p.symbol,
        strike: Number(p.strike),
        expiry: p.expiry,
        pctFromStrike,
        stockPrice: fresh.stock_price,
        optionPrice: fresh.option_price,
        classification,
      });
    }
  }

  return report;
}
