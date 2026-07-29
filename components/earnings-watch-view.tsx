"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { CrushHistoryTable } from "@/components/crush-history-table";
import { cn } from "@/lib/utils";

type Flag = { kind: string; label: string; description: string };

type HeldPosition = {
  positionType: "stock_long" | "stock_short" | "option";
  contracts: number;
  strike: number | null;
  expiry: string | null;
  costBasis: number | null;
  currentGainLossPct: number | null;
  avgPremiumSold: number | null;
};

// Portfolio watchlist membership = the user holds the stock. Distinct
// from HeldPosition (positions table — broker-imported options, or
// stock assigned from one, which DOES carry a real cost basis). No
// cost basis exists for a watchlist-only holding, so none is shown.
type PortfolioStockHolding = {
  allocation: "Large" | "Medium" | "Small" | null;
  notes: string | null;
};

type DownsideSummary = {
  worstDownsidePct: number | null;
  downCount: number;
  upCount: number;
  hardDownCount: number;
  survivesWorstDownside: boolean | null;
};

type DataQuality = {
  quartersUsed: number;
  unverifiedCount: number;
  thin: boolean;
  hasWarning: boolean;
};

type IvRichness = {
  label: "elevated" | "normal" | "low" | "unavailable";
  currentEmPct: number | null;
  historicalAvgEmPct: number | null;
  richnessRatio: number | null;
  note: string;
};

type Badge = {
  verdict: "CUT" | "TRIM" | "HOLD";
  severityScore: number;
  exposureScore: number;
  ivRichnessScore: number;
  composite: number;
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
  sizeTier: "small" | "medium" | "large" | null;
  downside: DownsideSummary;
  dataQuality: DataQuality;
  ivRichness: IvRichness;
  badge: Badge | null;
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtSignedFraction(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const pct = n * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function changeColor(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "text-muted-foreground";
  return n >= 0 ? "text-emerald-300" : "text-rose-300";
}

function badgeColor(verdict: Badge["verdict"] | null): string {
  if (verdict === "CUT") return "border-rose-500/40 bg-rose-500/10 text-rose-300";
  if (verdict === "TRIM") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (verdict === "HOLD") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
}

function badgeTextColor(verdict: Badge["verdict"] | null): string {
  if (verdict === "CUT") return "text-rose-300";
  if (verdict === "TRIM") return "text-amber-300";
  if (verdict === "HOLD") return "text-emerald-300";
  return "text-muted-foreground";
}

function ivRichnessColor(label: IvRichness["label"]): string {
  if (label === "elevated") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (label === "low") return "border-sky-500/40 bg-sky-500/10 text-sky-300";
  if (label === "normal") return "border-border bg-background text-muted-foreground";
  return "border-border bg-background text-muted-foreground/60";
}

const FLAG_BADGE: Record<string, string> = {
  COMPOUNDER: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  TURNAROUND: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  VALUE_TRAP: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  STRETCHED: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  DEAD_WEIGHT: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  FALLING_KNIFE: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

function daysLabel(d: number | null): string {
  if (d === null) return "—";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `${d}d`;
}

export function EarningsWatchView() {
  const [rows, setRows] = useState<EarningsWatchRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const [lookupInput, setLookupInput] = useState("");
  const [lookupRow, setLookupRow] = useState<EarningsWatchRow | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analysis/earnings-watch", { cache: "no-store" });
      const json = (await res.json()) as { rows?: EarningsWatchRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
      setLastRefreshedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const runLookup = useCallback(async (symbolOverride?: string) => {
    const symbol = (symbolOverride ?? lookupInput).trim().toUpperCase();
    if (!symbol) return;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const res = await fetch(`/api/analysis/earnings-watch?symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { row?: EarningsWatchRow; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setLookupRow(json.row ?? null);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Lookup failed");
      setLookupRow(null);
    } finally {
      setLookupLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupInput]);

  // Deep link from the dashboard's "Earnings this week" card
  // (/analysis/earnings-watch?symbol=X) — pre-fill and run the same
  // lookup a manual search would, so the full per-name context (the
  // whole point of following the link) is right there on arrival.
  const searchParams = useSearchParams();
  useEffect(() => {
    const sym = searchParams.get("symbol")?.trim().toUpperCase();
    if (!sym) return;
    setLookupInput(sym);
    void runLookup(sym);
    // Only ever re-run if the URL's symbol itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // After an inline earnings-history edit (via the embedded
  // CrushHistoryTable), the downside history / data-quality warning /
  // badge for that one row are stale until re-fetched — recomputation
  // isn't automatic, so this re-pulls just that symbol and patches it
  // in place wherever it's currently shown (default list and/or the
  // pinned lookup row).
  const reEvaluateSymbol = useCallback(async (symbol: string) => {
    const res = await fetch(`/api/analysis/earnings-watch?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
    });
    const json = (await res.json()) as { row?: EarningsWatchRow; error?: string };
    if (!res.ok || json.error || !json.row) return;
    const updated = json.row;
    setRows((prev) => (prev ? prev.map((r) => (r.symbol === updated.symbol ? updated : r)) : prev));
    setLookupRow((prev) => (prev && prev.symbol === updated.symbol ? updated : prev));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Earnings Watch</h1>
          <p className="text-base text-muted-foreground">
            Pre-earnings position review — for names on any watchlist reporting soon, whether to
            cut, hold, or trim before the print. Not a CSP screen: this doesn&apos;t look for new
            trades, it reviews what you already hold.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-base font-medium transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {lastRefreshedAt && (
            <span className="text-[11px] text-muted-foreground">
              Last refreshed{" "}
              {lastRefreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runLookup();
            }}
            placeholder="Look up any ticker…"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-sm outline-none focus:border-foreground/40"
          />
        </div>
        <button
          type="button"
          onClick={() => void runLookup()}
          disabled={lookupLoading || !lookupInput.trim()}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
        >
          {lookupLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Look up"}
        </button>
        {lookupError && <span className="text-sm text-rose-300">{lookupError}</span>}
        {lookupRow && (
          <span className="text-[11px] text-muted-foreground">
            Not filtered to 7 days — shown regardless of how far out {lookupRow.symbol}&apos;s
            report is.
          </span>
        )}
      </div>

      {lookupRow && (
        <div className="overflow-x-auto rounded-md border border-border bg-background/40">
          <table className="w-full min-w-[1100px] text-sm">
            <tbody>
              <EarningsWatchRowItem key={lookupRow.symbol} row={lookupRow} pinned onReEvaluate={reEvaluateSymbol} />
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-background/40">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="border-b border-border bg-background/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left">Symbol</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-right">Price</th>
              <th className="px-2 py-2 text-right">Change%</th>
              <th className="px-2 py-2 text-left">Reports</th>
              <th className="px-2 py-2 text-left">Lists</th>
              <th className="px-2 py-2 text-center">Held</th>
              <th className="px-2 py-2 text-right">Downside history</th>
              <th className="px-2 py-2 text-center">IV richness</th>
              <th className="px-2 py-2 text-center">Call</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows === null && (
              <tr>
                <td colSpan={10} className="px-2 py-8 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                </td>
              </tr>
            )}
            {!loading && rows && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-8 text-center text-muted-foreground">
                  No watchlist symbols report earnings in the next 7 days.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <EarningsWatchRowItem key={r.symbol} row={r} onReEvaluate={reEvaluateSymbol} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EarningsWatchRowItem({
  row,
  pinned,
  onReEvaluate,
}: {
  row: EarningsWatchRow;
  pinned?: boolean;
  onReEvaluate: (symbol: string) => Promise<void>;
}) {
  // Pinned (searched-for) rows start expanded — the whole point of a
  // lookup, including a deep link from the dashboard card, is to see
  // that name's detail immediately.
  const [expanded, setExpanded] = useState(!!pinned);

  return (
    <>
      <tr
        onClick={() => setExpanded((s) => !s)}
        className={cn(
          "cursor-pointer border-b border-border/40 hover:bg-background/60",
          pinned && "bg-background/50",
        )}
      >
        <td className="px-2 py-1.5 font-mono font-semibold">
          <span className="inline-flex items-center gap-1">
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {row.symbol}
          </span>
        </td>
        <td className="px-2 py-1.5 text-muted-foreground">{row.companyName ?? "—"}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(row.price)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", changeColor(row.changePct))}>
          {fmtPct(row.changePct)}
        </td>
        <td className="px-2 py-1.5">
          <div className="font-mono">{row.earningsDate ?? "unknown"}</div>
          <div className="text-[10px] text-muted-foreground">
            {daysLabel(row.daysUntilEarnings)}
            {row.earningsTiming && row.earningsTiming !== "unknown" ? ` · ${row.earningsTiming}` : ""}
          </div>
        </td>
        <td className="px-2 py-1.5">
          <span className="inline-flex flex-wrap items-center gap-1">
            {row.watchlistNames.length === 0 && (
              <span className="text-[10px] text-muted-foreground">not on a watchlist</span>
            )}
            {row.watchlistNames.map((name) => (
              <span
                key={name}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </span>
        </td>
        <td className="px-2 py-1.5 text-center">
          {row.held ? (
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center justify-center gap-1">
                {row.portfolioStockHolding && (
                  <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                    STOCK
                  </span>
                )}
                {row.heldPositions.some((p) => p.positionType === "option") && (
                  <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                    CSP
                  </span>
                )}
                {row.heldPositions.some((p) => p.positionType !== "option") && (
                  <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                    SHARES
                  </span>
                )}
              </div>
              {row.sizeTier && (
                <div className="text-[10px] capitalize text-muted-foreground">{row.sizeTier}</div>
              )}
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground">not held</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right">
          <div className="font-mono text-rose-300">{fmtSignedFraction(row.downside.worstDownsidePct)}</div>
          <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
            {row.dataQuality.quartersUsed}q used
            {row.dataQuality.hasWarning && <span title="Data quality warning — see details">⚠️</span>}
          </div>
        </td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-block rounded border px-2 py-0.5 text-[11px] font-medium capitalize",
              ivRichnessColor(row.ivRichness.label),
            )}
            title={row.ivRichness.note}
          >
            {row.ivRichness.label}
          </span>
        </td>
        <td className="px-2 py-1.5 text-center">
          {row.badge ? (
            <span
              className={cn(
                "inline-block rounded border px-2 py-0.5 font-mono text-[12px] font-semibold",
                badgeColor(row.badge.verdict),
              )}
              title={`Severity ${row.badge.severityScore}/4 + Exposure ${row.badge.exposureScore}/3 + IV ${row.badge.ivRichnessScore}/2 = ${row.badge.composite}/9 → ${row.badge.verdict}`}
            >
              {row.badge.verdict}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">not held</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-background/30">
          <td colSpan={10} className="px-3 py-3">
            <EarningsWatchDetail row={row} onReEvaluate={onReEvaluate} />
          </td>
        </tr>
      )}
    </>
  );
}

function EarningsWatchDetail({
  row,
  onReEvaluate,
}: {
  row: EarningsWatchRow;
  onReEvaluate: (symbol: string) => Promise<void>;
}) {
  const dq = row.dataQuality;
  const [reEvaluating, setReEvaluating] = useState(false);
  return (
    <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Downside history
        </div>
        <div className="space-y-1 rounded border border-border bg-background/60 p-2">
          <div>
            Worst historical downside move:{" "}
            <span className="font-mono text-rose-300">
              {fmtSignedFraction(row.downside.worstDownsidePct)}
            </span>
          </div>
          <div>
            {row.downside.downCount} of {row.downside.downCount + row.downside.upCount} quarters
            gapped down; {row.downside.hardDownCount} gapped down 7%+ (&quot;hard&quot;).
          </div>
          {dq.hasWarning && (
            <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-100">
              <div className="font-semibold uppercase tracking-wide text-amber-200">
                Data-quality warning
              </div>
              <div>
                {dq.quartersUsed} quarter{dq.quartersUsed === 1 ? "" : "s"} used
                {dq.quartersUsed < 3 && " — thin sample"}. {dq.unverifiedCount} of{" "}
                {dq.quartersUsed} come from unverified sources (perplexity/polygon-recalled, not
                live-captured — a confirmed hallucination exists: GLW Q2 2025 stored 11.8% vs a
                true ~6%). Treat the CUT/TRIM/HOLD call below with that in mind.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Position context
        </div>
        <div className="space-y-2 rounded border border-border bg-background/60 p-2">
          {!row.held && <div className="text-muted-foreground">Not currently held.</div>}
          {row.portfolioStockHolding && (
            <div className="border-b border-border/40 pb-2 last:border-0 last:pb-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                Stock holding — Portfolio watchlist
              </div>
              <div>
                Allocation:{" "}
                <span className="capitalize">{row.portfolioStockHolding.allocation ?? "unset"}</span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                No cost basis or share count is tracked for this holding — the watchlist only
                stores allocation and notes, so no gain/loss figure is shown here.
              </div>
              {row.portfolioStockHolding.notes && (
                <div className="mt-0.5 text-[11px] italic text-muted-foreground">
                  &quot;{row.portfolioStockHolding.notes}&quot;
                </div>
              )}
            </div>
          )}
          {row.heldPositions.map((p, i) => (
            <div key={i} className="border-b border-border/40 pb-2 last:border-0 last:pb-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">
                {p.positionType === "option" ? "Options position" : "Stock position"} — broker-tracked
              </div>
              {p.positionType === "option" ? (
                <div>
                  Short {p.strike}P × {p.contracts}, exp {p.expiry ?? "—"} — premium sold{" "}
                  {fmtMoney(p.avgPremiumSold)}
                </div>
              ) : (
                <div>
                  {p.positionType === "stock_long" ? "Long" : "Short"} {p.contracts} sh @ cost{" "}
                  {fmtMoney(p.costBasis)} —{" "}
                  <span className={changeColor(p.currentGainLossPct)}>
                    {fmtPct(p.currentGainLossPct, 1)}
                  </span>
                </div>
              )}
            </div>
          ))}
          {row.held && row.sizeTier && (
            <div className="pt-1 text-[11px] text-muted-foreground">
              Size tier: <span className="capitalize">{row.sizeTier}</span>{" "}
              {row.heldPositions.length > 0
                ? "(relative to your other open positions by notional — no portfolio-NAV figure exists to compare against instead)."
                : "(from the Portfolio watchlist's own allocation field — no notional exists to rank without a broker position)."}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Thesis flag (context only — never overrides the call below)
        </div>
        <div className="rounded border border-border bg-background/60 p-2">
          {!row.onPortfolioWatchlist && (
            <div className="text-muted-foreground">
              Not on the Portfolio watchlist — thesis flags only apply there.
            </div>
          )}
          {row.onPortfolioWatchlist && row.thesisFlags.length === 0 && (
            <div className="text-muted-foreground">No flag currently fires for this name.</div>
          )}
          {row.thesisFlags.map((f) => (
            <div key={f.kind} className="mb-1 last:mb-0">
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                  FLAG_BADGE[f.kind] ?? "border-border bg-background text-muted-foreground",
                )}
              >
                {f.label}
              </span>
              <span className="ml-1.5 text-[12px] text-muted-foreground">{f.description}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          IV richness — fact, not a hedge suggestion
        </div>
        <div className="rounded border border-border bg-background/60 p-2">
          <div>{row.ivRichness.note}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            This surfaces whether options pricing looks rich vs. this name&apos;s own norm. It is
            not a recommendation to sell calls or buy puts — hedging a long-term thesis by capping
            upside is your call to make, not this page&apos;s.
          </div>
        </div>
      </div>

      {row.badge && (
        <div className="space-y-2 md:col-span-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Why {row.badge.verdict}
          </div>
          <div className="rounded border border-border bg-background/60 p-2 font-mono text-[12px]">
            Downside severity {row.badge.severityScore}/4 + Position exposure{" "}
            {row.badge.exposureScore}/3 + IV richness {row.badge.ivRichnessScore}/2 ={" "}
            {row.badge.composite}/9 →{" "}
            <span className={cn("font-semibold", badgeTextColor(row.badge.verdict))}>
              {row.badge.verdict}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Composite ≥6 → CUT, ≥3 → TRIM, below → HOLD (max possible is 9). Purely mechanical
            from the three inputs above — the thesis flag never feeds this score.
          </div>
        </div>
      )}

      <div className="space-y-2 md:col-span-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Earnings history — same editable table as the CSP screener
          </div>
          <button
            type="button"
            onClick={async () => {
              setReEvaluating(true);
              try {
                await onReEvaluate(row.symbol);
              } finally {
                setReEvaluating(false);
              }
            }}
            disabled={reEvaluating}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
          >
            {reEvaluating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Re-evaluate from edits
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Editing a quarter&apos;s EM/Actual or its source tag here saves directly to the same
          data the CSP screener uses — it does not just affect this page. The downside history,
          data-quality warning, and CUT/TRIM/HOLD badge above are computed at page-load time, so
          click Re-evaluate after editing to pull them back in sync with what you just changed.
        </div>
        <div className="rounded border border-border bg-background/60 p-2">
          {row.earningsDate ? (
            <CrushHistoryTable
              events={null}
              todayEmPct={row.ivRichness.currentEmPct}
              todaySymbol={row.symbol}
              todayEarningsDate={row.earningsDate}
            />
          ) : (
            <div className="text-muted-foreground">
              No known upcoming earnings date for {row.symbol} — the editable history table needs
              one to anchor the pinned row.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
