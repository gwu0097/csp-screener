"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fmtDollars,
  fmtDollarsSigned,
  fmtPct,
  fmtPctSigned,
} from "@/lib/format";
import { EquityCurve, type EquityRange } from "@/components/equity-curve";
import type {
  RealizedTrade,
  JournalSummary,
  TickerRow,
  StrikeInsight,
  DayInsight,
  HoldInsight,
  EquityPoint,
} from "@/lib/journal";

type StatsResponse = {
  trades: RealizedTrade[];
  summary: JournalSummary;
  byTicker: TickerRow[];
  strikeInsight: StrikeInsight;
  dayInsight: DayInsight[];
  holdInsight: HoldInsight[];
  equityCurve: EquityPoint[];
  topWins: RealizedTrade[];
  topLosses: RealizedTrade[];
  recentTrades: RealizedTrade[];
};

type OpenPositionLite = { pnlDollars: number | null };
type PositionsResponse = { positions: OpenPositionLite[] };

type TickerSortKey = keyof Pick<
  TickerRow,
  "symbol" | "pnl" | "wins" | "losses" | "winRate" | "total" | "avgRocPct" | "avgHoldDays"
>;

export function JournalView() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [unrealized, setUnrealized] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<EquityRange>("3M");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, posRes] = await Promise.all([
        fetch("/api/journal/stats", { cache: "no-store" }),
        fetch("/api/positions/open?opportunityAvailable=false", { cache: "no-store" }),
      ]);
      const statsJson = (await statsRes.json()) as StatsResponse & { error?: string };
      if (!statsRes.ok || statsJson.error) {
        throw new Error(statsJson.error ?? `HTTP ${statsRes.status}`);
      }
      setStats(statsJson);
      if (posRes.ok) {
        const posJson = (await posRes.json()) as PositionsResponse;
        const total = (posJson.positions ?? []).reduce(
          (s, p) => s + (p.pnlDollars ?? 0),
          0,
        );
        setUnrealized(total);
      } else {
        setUnrealized(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load journal");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border bg-background/40 px-6 py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading journal…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
        <AlertTriangle className="mr-1.5 inline h-3 w-3" /> {error}
      </div>
    );
  }

  if (!stats) return null;

  const s = stats.summary;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Journal</h1>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* Primary P&L cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Today" value={s.realizedPnlToday} type="dollars" />
        <StatCard label="This week" value={s.realizedPnlWeek} type="dollars" />
        <StatCard label="This month" value={s.realizedPnlMonth} type="dollars" />
        <StatCard label="YTD" value={s.realizedPnlYtd} type="dollars" />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Win rate" value={s.winRate} type="pct" mono />
        <StatCard label="Avg win" value={s.avgWin} type="dollars" />
        <StatCard label="Avg loss" value={s.avgLoss} type="dollars" />
        <StatCard label="Expectancy / trade" value={s.expectancy} type="dollars" />
        <StatCard label="Realized all-time" value={s.realizedPnlAll} type="dollars" />
      </div>

      {/* ROC + unrealized */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Avg ROC" value={s.avgRocPct} type="pctSigned" mono />
        <StatCard label="Median ROC" value={s.medianRocPct} type="pctSigned" mono />
        <StatCard label="Best ROC" value={s.bestRocPct} type="pctSigned" mono positive />
        <StatCard label="Worst ROC" value={s.worstRocPct} type="pctSigned" mono negative />
        <StatCard label="Unrealized P&L" value={unrealized} type="dollars" />
      </div>

      {/* Equity curve */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Equity curve</h2>
          <div className="flex items-center gap-1 text-xs">
            {(["1W", "1M", "3M", "YTD", "ALL"] as EquityRange[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  "rounded px-2 py-1 border",
                  range === r
                    ? "border-foreground text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <EquityCurve points={stats.equityCurve} range={range} />
      </section>

      {/* By ticker */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">By ticker</h2>
        <TickerTable rows={stats.byTicker} />
      </section>

      {/* Insights */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Insights</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <StrikeCard insight={stats.strikeInsight} />
          <DayCard days={stats.dayInsight} />
          <HoldCard holds={stats.holdInsight} />
        </div>
      </section>

      {/* Top wins + losses */}
      <section className="grid gap-3 md:grid-cols-2">
        <TopTradesCard title="Top 5 wins" trades={stats.topWins} positive />
        <TopTradesCard title="Top 5 losses" trades={stats.topLosses} positive={false} />
      </section>

      {/* Recent trades */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recent trades</h2>
        <RecentTradesTable trades={stats.recentTrades} />
      </section>
    </div>
  );
}

// ----- Sub-components -----

type StatType = "dollars" | "pct" | "pctSigned";

function formatStatValue(v: number | null, type: StatType): string {
  if (v === null) return "—";
  if (type === "dollars") return fmtDollarsSigned(v);
  if (type === "pctSigned") return fmtPctSigned(v);
  return fmtPct(v);
}

function StatCard({
  label,
  value,
  type,
  mono,
  positive,
  negative,
}: {
  label: string;
  value: number | null;
  type: StatType;
  mono?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  let color = "text-foreground";
  if (positive) color = "text-emerald-300";
  else if (negative) color = "text-rose-300";
  else if (type !== "pct" && value !== null) color = value >= 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-lg", mono ? "font-mono" : "font-semibold", color)}>
        {formatStatValue(value, type)}
      </div>
    </div>
  );
}

function TickerTable({ rows }: { rows: TickerRow[] }) {
  const [sortKey, setSortKey] = useState<TickerSortKey>("pnl");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const diff = (av as number) - (bv as number);
      return dir === "asc" ? diff : -diff;
    });
    return copy;
  }, [rows, sortKey, dir]);

  function toggle(k: TickerSortKey) {
    if (k === sortKey) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setDir(k === "symbol" ? "asc" : "desc");
    }
  }

  const headers: Array<{ k: TickerSortKey; label: string }> = [
    { k: "symbol", label: "Symbol" },
    { k: "pnl", label: "P&L" },
    { k: "wins", label: "Wins" },
    { k: "losses", label: "Losses" },
    { k: "winRate", label: "Win rate" },
    { k: "total", label: "Trades" },
    { k: "avgRocPct", label: "Avg ROC" },
    { k: "avgHoldDays", label: "Avg hold" },
  ];

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-background/40 p-6 text-center text-xs text-muted-foreground">
        No closed trades yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs">
          <tr>
            {headers.map((h) => (
              <th
                key={h.k}
                className="cursor-pointer select-none px-3 py-2 hover:text-foreground"
                onClick={() => toggle(h.k)}
              >
                <span className="inline-flex items-center gap-1">
                  {h.label}
                  {sortKey === h.k &&
                    (dir === "asc" ? (
                      <ArrowUp className="h-3 w-3" />
                    ) : (
                      <ArrowDown className="h-3 w-3" />
                    ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.symbol} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{r.symbol}</td>
              <td className={cn("px-3 py-2 font-mono", r.pnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
                {fmtDollarsSigned(r.pnl)}
              </td>
              <td className="px-3 py-2">{r.wins}</td>
              <td className="px-3 py-2">{r.losses}</td>
              <td className="px-3 py-2 font-mono">{fmtPct(r.winRate)}</td>
              <td className="px-3 py-2">{r.total}</td>
              <td className="px-3 py-2 font-mono">{fmtPctSigned(r.avgRocPct)}</td>
              <td className="px-3 py-2">{r.avgHoldDays.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrikeCard({ insight }: { insight: StrikeInsight }) {
  const { x15, x20, recommendation } = insight;
  return (
    <InsightCard title="Strike level">
      <InsightRow label="2x EM" wr={x20.winRate} count={x20.count} />
      <InsightRow label="1.5x EM" wr={x15.winRate} count={x15.count} />
      <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
        {recommendation}
      </div>
    </InsightCard>
  );
}

function DayCard({ days }: { days: DayInsight[] }) {
  if (days.length === 0) {
    return <InsightCard title="Best day to trade"><span className="text-xs text-muted-foreground">Not enough data yet</span></InsightCard>;
  }
  const sorted = [...days].sort((a, b) => b.winRate - a.winRate);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return (
    <InsightCard title="Best day to trade">
      <InsightRow label={`Best: ${best.day}`} wr={best.winRate} count={best.count} />
      <InsightRow label={`Worst: ${worst.day}`} wr={worst.winRate} count={worst.count} />
    </InsightCard>
  );
}

function HoldCard({ holds }: { holds: HoldInsight[] }) {
  return (
    <InsightCard title="Hold duration">
      {holds.map((h) => (
        <InsightRow key={h.bucket} label={h.bucket} wr={h.winRate} count={h.count} />
      ))}
      <DurationTrend holds={holds} />
    </InsightCard>
  );
}

function DurationTrend({ holds }: { holds: HoldInsight[] }) {
  // "Each extra day held reduces win rate by ~X%" — the simplest comparable
  // slope is (same-day win rate − 2+ day win rate) / 2.
  const sd = holds.find((h) => h.bucket === "same-day");
  const two = holds.find((h) => h.bucket === "2+ days");
  if (!sd || !two || sd.count === 0 || two.count === 0) return null;
  const slope = (sd.winRate - two.winRate) / 2;
  if (Math.abs(slope) < 0.5) return null;
  return (
    <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
      → Each extra day held {slope > 0 ? "reduces" : "adds"} win rate by ~{Math.abs(slope).toFixed(1)}%
    </div>
  );
}

function InsightCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="mb-2 text-xs font-medium">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function InsightRow({ label, wr, count }: { label: string; wr: number; count: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">
        {count > 0 ? fmtPct(wr) : "—"}{" "}
        <span className="text-muted-foreground">({count} trade{count === 1 ? "" : "s"})</span>
      </span>
    </div>
  );
}

function TopTradesCard({
  title,
  trades,
  positive,
}: {
  title: string;
  trades: RealizedTrade[];
  positive: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="mb-2 text-xs font-medium">{title}</div>
      {trades.length === 0 ? (
        <div className="text-xs text-muted-foreground">None yet</div>
      ) : (
        <div className="space-y-1 text-xs">
          {trades.map((t, i) => (
            <div key={t.parentId + t.closedAt + i} className="flex items-center justify-between gap-2">
              <span>
                {t.symbol} ${t.strike} · {t.closedAt}
              </span>
              <span
                className={cn(
                  "font-mono",
                  positive ? "text-emerald-300" : "text-rose-300",
                )}
              >
                {fmtDollarsSigned(t.pnl)}{" "}
                <span className="text-muted-foreground">({fmtPctSigned(t.rocPct)})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentTradesTable({ trades }: { trades: RealizedTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-background/40 p-6 text-center text-xs text-muted-foreground">
        No closed trades yet
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left">
          <tr>
            <Th>Opened</Th>
            <Th>Closed</Th>
            <Th>Symbol</Th>
            <Th>Strike</Th>
            <Th>Expiry</Th>
            <Th>Broker</Th>
            <Th>Qty</Th>
            <Th>Sold</Th>
            <Th>Bought</Th>
            <Th>P&L</Th>
            <Th>ROC</Th>
            <Th>Outcome</Th>
            <Th>Hold (d)</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.parentId + t.closedAt + i} className="border-t border-border">
              <td className="px-3 py-2">{t.tradeDate}</td>
              <td className="px-3 py-2">{t.closedAt}</td>
              <td className="px-3 py-2 font-medium">{t.symbol}</td>
              <td className="px-3 py-2">{fmtDollars(t.strike)}</td>
              <td className="px-3 py-2">{t.expiry}</td>
              <td className="px-3 py-2">{t.broker}</td>
              <td className="px-3 py-2">{t.contracts}</td>
              <td className="px-3 py-2 font-mono">{fmtDollars(t.premiumSold)}</td>
              <td className="px-3 py-2 font-mono">{fmtDollars(t.premiumBought)}</td>
              <td className={cn("px-3 py-2 font-mono", t.pnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
                {fmtDollarsSigned(t.pnl)}
              </td>
              <td className="px-3 py-2 font-mono">{fmtPctSigned(t.rocPct)}</td>
              <td className="px-3 py-2">{t.outcome}</td>
              <td className="px-3 py-2">{t.holdDays}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-normal text-muted-foreground">{children}</th>;
}
