import { NextRequest, NextResponse } from "next/server";
import {
  autoExpirePosition,
  recordAssignment,
} from "@/lib/expire-positions";

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

  const results = await Promise.all(
    items.map(async ({ positionId, action, stockPrice }) => {
      try {
        if (action === "assigned" && stockPrice !== null && stockPrice > 0) {
          const r = await recordAssignment(positionId, stockPrice);
          return {
            positionId,
            action: "assigned" as const,
            ok: r.ok,
            realized_pnl: r.realized_pnl,
            stock_price_used: stockPrice,
            reason: r.reason,
          };
        }
        // assigned without a stockPrice → no safe way to compute
        // assignment P&L. Fall back to expire-worthless so we don't
        // silently produce a wrong number; the user will see this
        // row as expired_worthless and can correct manually.
        const r = await autoExpirePosition(positionId);
        return {
          positionId,
          action:
            action === "assigned"
              ? ("worthless_fallback" as const)
              : ("worthless" as const),
          ok: r.ok,
          realized_pnl: r.realized_pnl,
          stock_price_used: null,
          reason: r.reason,
        };
      } catch (e) {
        return {
          positionId,
          action,
          ok: false,
          realized_pnl: 0,
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

  return NextResponse.json({
    expiredCount,
    assignedCount,
    failedCount: failed.length,
    totalRealizedPnl: Math.round(totalPnl * 100) / 100,
    results,
  });
}
