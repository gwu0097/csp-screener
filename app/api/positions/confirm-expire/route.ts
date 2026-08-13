import { NextRequest, NextResponse } from "next/server";
import {
  autoExpirePosition,
  recordAssignment,
} from "@/lib/expire-positions";
import { reduceStockLotForCallAssignment } from "@/lib/positions";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// User-confirmed bulk close from the expire-confirmation modal.
//
// New body shape (preferred):
//   { items: [{ positionId, action: 'worthless' | 'assigned',
//               stockPrice?: number }] }
//
// Per-row action:
//   'worthless' → autoExpirePosition (status='expired_worthless',
//                  realized_pnl = full premium kept)
//   'assigned'  → recordAssignment(positionId, stockPrice). stockPrice
//                  must be a positive number; if missing we fall back
//                  to autoExpirePosition so we never silently
//                  mis-record a P&L.
//
// Legacy body shape (back-compat, single action):
//   { positionIds: string[] }  → all routed to autoExpirePosition.
//
// Per-row failures don't fail the whole batch — the response surfaces
// both successes and failures (see results[]).
export const maxDuration = 30;

type Item = {
  positionId?: unknown;
  action?: unknown;
  stockPrice?: unknown;
};

type Body = { positionIds?: unknown; items?: unknown };

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const items: Array<{
    positionId: string;
    action: "worthless" | "assigned";
    stockPrice: number | null;
  }> = [];

  if (Array.isArray(body.items)) {
    for (const raw of body.items as Item[]) {
      const positionId = typeof raw.positionId === "string" ? raw.positionId : "";
      const action =
        raw.action === "worthless" || raw.action === "assigned"
          ? raw.action
          : null;
      const stockPrice =
        typeof raw.stockPrice === "number" && Number.isFinite(raw.stockPrice)
          ? raw.stockPrice
          : null;
      if (positionId && action) items.push({ positionId, action, stockPrice });
    }
  } else if (Array.isArray(body.positionIds)) {
    for (const id of body.positionIds) {
      if (typeof id === "string") {
        items.push({ positionId: id, action: "worthless", stockPrice: null });
      }
    }
  }

  if (items.length === 0) {
    return NextResponse.json(
      { error: "items[] or positionIds[] required" },
      { status: 400 },
    );
  }

  // Ownership gate — autoExpirePosition / recordAssignment operate on
  // raw position ids, so verify every id belongs to this user before
  // mutating. Unowned ids surface as per-row failures (not_found),
  // matching the libs' own not_found shape.
  const sb = createServerClient();
  const ownedRes = await sb
    .from("positions")
    .select("id")
    .in(
      "id",
      items.map((i) => i.positionId),
    )
    .eq("user_id", userId);
  if (ownedRes.error) {
    return NextResponse.json({ error: ownedRes.error.message }, { status: 500 });
  }
  const ownedIds = new Set(
    ((ownedRes.data ?? []) as Array<{ id: string }>).map((r) => r.id),
  );

  const results = await Promise.all(
    items.map(async ({ positionId, action, stockPrice }) => {
      if (!ownedIds.has(positionId)) {
        return {
          positionId,
          action,
          ok: false,
          realized_pnl: 0,
          contracts_closed: 0,
          stock_price_used: null,
          reason: "not_found",
        };
      }
      try {
        if (action === "assigned" && stockPrice !== null && stockPrice > 0) {
          const r = await recordAssignment(positionId, stockPrice, userId);
          return {
            positionId,
            action: "assigned" as const,
            ok: r.ok,
            realized_pnl: r.realized_pnl,
            contracts_closed: r.contracts_closed,
            stock_price_used: stockPrice,
            reason: r.reason,
            optionType: r.optionType,
          };
        }
        // assigned without a stockPrice → no safe way to compute
        // assignment P&L. Fall back to expire-worthless so we don't
        // silently produce a wrong number; the user will see this
        // row as expired_worthless and can correct manually.
        const r = await autoExpirePosition(positionId, userId);
        return {
          positionId,
          action:
            action === "assigned"
              ? ("worthless_fallback" as const)
              : ("worthless" as const),
          ok: r.ok,
          realized_pnl: r.realized_pnl,
          contracts_closed: r.contracts_closed,
          stock_price_used: null,
          reason: r.reason,
        };
      } catch (e) {
        return {
          positionId,
          action,
          ok: false,
          realized_pnl: 0,
          contracts_closed: 0,
          stock_price_used: null,
          reason: e instanceof Error ? e.message : "threw",
        };
      }
    }),
  );

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalPnl = ok.reduce((s, r) => s + r.realized_pnl, 0);
  const expiredCount = ok.filter(
    (r) => r.action === "worthless" || r.action === "worthless_fallback",
  ).length;
  const assignedCount = ok.filter((r) => r.action === "assigned").length;

  // For every successful assignment, look up the option's symbol /
  // strike / etc. so the UI can render the stock-prompt rows. The
  // CONTRACTS count comes from result.contracts_closed (computed off
  // remaining = opened − prior_closes inside recordAssignment) — NOT
  // from total_contracts on the row, which is the historical "ever
  // opened" count and over-counts after partial closes / rolls.
  //
  // Puts and calls diverge from here: a put assignment means BUYING
  // shares — `assignments[]` feeds the existing AssignmentStockPromptModal,
  // which creates a new stock_long position (unchanged). A call
  // assignment means shares are CALLED AWAY — the opposite direction —
  // so instead of prompting to create shares, this reduces an existing
  // stock_long lot for that symbol right here (reduceStockLotForCallAssignment,
  // the same shared rule mark-assigned/route.ts uses for the early-
  // assignment button) and reports the outcome in `calledAway[]`
  // rather than opening a stock-creation prompt.
  const assignedResults = ok.filter((r) => r.action === "assigned");
  const contractsByPosition = new Map<string, number>();
  const optionTypeByPosition = new Map<string, "put" | "call">();
  for (const r of assignedResults) {
    contractsByPosition.set(r.positionId, r.contracts_closed ?? 0);
    optionTypeByPosition.set(r.positionId, r.optionType === "call" ? "call" : "put");
  }
  const assignedIds = assignedResults.map((r) => r.positionId);
  type AssignmentDetail = {
    positionId: string;
    symbol: string;
    broker: string | null;
    strike: number;
    contracts: number;
    avgPremiumSold: number | null;
    costBasis: number;
    shares: number;
    expiry: string;
  };
  type CalledAwayDetail = {
    positionId: string;
    symbol: string;
    strike: number;
    contracts: number;
    shares: number;
    expiry: string;
    stockLotAdjusted: boolean;
    note: string;
  };
  const assignments: AssignmentDetail[] = [];
  const calledAway: CalledAwayDetail[] = [];
  if (assignedIds.length > 0) {
    const detailRes = await sb
      .from("positions")
      .select("id,symbol,broker,strike,expiry,avg_premium_sold")
      .in("id", assignedIds)
      .eq("user_id", userId);
    type Row = {
      id: string;
      symbol: string;
      broker: string | null;
      strike: number;
      expiry: string;
      avg_premium_sold: number | null;
    };
    for (const row of (detailRes.data ?? []) as Row[]) {
      const strike = Number(row.strike);
      const contracts = contractsByPosition.get(row.id) ?? 0;
      const shares = contracts * 100;
      const optionType = optionTypeByPosition.get(row.id) ?? "put";
      const avgPremium =
        row.avg_premium_sold !== null ? Number(row.avg_premium_sold) : null;
      if (optionType === "call") {
        const reduced = await reduceStockLotForCallAssignment(
          sb,
          userId,
          row.symbol,
          shares,
          strike,
          row.expiry,
          avgPremium ?? 0,
        );
        calledAway.push({
          positionId: row.id,
          symbol: row.symbol,
          strike,
          contracts,
          shares,
          expiry: row.expiry,
          stockLotAdjusted: reduced.ok,
          note: reduced.ok
            ? `${shares} shares sold @ $${strike.toFixed(2)}`
            : reduced.reason === "no_lot"
              ? `No single tracked stock lot covers ${shares} shares — use Sell Shares if you track this position's stock.`
              : reduced.reason === "ambiguous_lot"
                ? `Multiple stock lots could cover ${shares} shares — use Sell Shares to pick the right one.`
                : `Stock lot couldn't be updated (${reduced.detail ?? "unknown error"}) — use Sell Shares to record it.`,
        });
        continue;
      }
      // Display-only preview of what create-from-assignment will
      // actually store: premium reduces cost basis. The put's
      // realized_pnl doesn't get zeroed until create-from-assignment
      // runs (the user may dismiss this modal without creating the
      // stock row, and the put should keep its full-premium P&L until
      // there's a stock leg to carry it instead).
      const costBasis =
        avgPremium !== null
          ? Math.round((strike - avgPremium) * 100) / 100
          : strike;
      assignments.push({
        positionId: row.id,
        symbol: row.symbol,
        broker: row.broker ?? null,
        strike,
        contracts,
        avgPremiumSold: avgPremium,
        costBasis,
        shares,
        expiry: row.expiry,
      });
    }
  }

  return NextResponse.json({
    expiredCount,
    assignedCount,
    failedCount: failed.length,
    totalRealizedPnl: Math.round(totalPnl * 100) / 100,
    results,
    assignments,
    calledAway,
  });
}
