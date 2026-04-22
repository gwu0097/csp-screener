"use client";

import { Briefcase, AlertTriangle } from "lucide-react";
import type { MarketContext } from "@/lib/market";

type Props = { market: MarketContext };

function regimeColor(regime: MarketContext["regime"]) {
  if (regime === "panic") return "text-rose-300";
  if (regime === "elevated") return "text-amber-300";
  return "text-emerald-300";
}

export function PositionsView({ market }: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 font-medium text-foreground">
            <Briefcase className="h-4 w-4" /> Positions
          </span>
          <span>
            VIX:{" "}
            <span className={regimeColor(market.regime)}>
              {market.vix !== null ? market.vix.toFixed(2) : "—"}
              {market.regime ? ` (${market.regime})` : ""}
            </span>
          </span>
          {market.spyPrice !== null && (
            <span>SPY: ${market.spyPrice.toFixed(2)}</span>
          )}
        </div>
      </div>

      {market.warning && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            market.regime === "panic"
              ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          <AlertTriangle className="mr-1.5 inline h-3 w-3" />
          {market.warning}
        </div>
      )}

      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-16 text-center">
        <Briefcase className="mb-3 h-10 w-10 text-muted-foreground" />
        <h2 className="mb-1 text-lg font-semibold">Positions coming next</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Screenshot import, live open positions with cut/hold recommendations, and partial
          close UX land in PR 2.
        </p>
      </div>
    </div>
  );
}
