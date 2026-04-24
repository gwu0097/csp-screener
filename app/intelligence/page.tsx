"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Window = "today" | "week" | "month" | "ytd" | "all";

type EquityPoint = { date: string; symbol: string; trade_pnl: number; cumulative_pnl: number };

type TickerRanking = {
  symbol: string;
  trades: number;
  wins: number;
  win_rate: number;
  avg_roc: number | null;
  best_roc: number | null;
  top_grade: string | null;
  rec_aligned: number | null;
  rec_total: number | null;
  closed_trades: Array<{
    opened_date: string;
    closed_date: string | null;
    avg_premium_sold: number | null;
    realized_pnl: number | null;
    roc: number | null;
    grade: string | null;
  }>;
};

type PatternBucket = { key: string; trades: number; wins: number; win_rate: number; avg_roc: number | null };

type IntelligenceResponse = {
  window: Window;
  stats: {
    total_pnl: number;
    win_rate: number;
    wins: number;
    total_trades: number;
    avg_roc: number;
    expectancy: number;
    best_trade: { symbol: string; pnl: number; roc: number | null } | null;
    worst_trade: { symbol: string; pnl: number; roc: number | null } | null;
  };
  equity_curve: EquityPoint[];
  ticker_rankings: TickerRanking[];
  patterns: {
    enabled: boolean;
    total_closed: number;
    by_grade: PatternBucket[];
    by_day_of_week: PatternBucket[];
    by_vix_regime: PatternBucket[];
    calibration: { drift: boolean; summary: string };
    rec_accuracy: {
      close_correct: number;
      close_total: number;
      hold_correct: number;
      hold_total: number;
      overall_pct: number;
    } | null;
  };
  export_payload: unknown;
};

const WINDOW_OPTIONS: Array<{ value: Window; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All Time" },
];

function fmtMoney(n: number | null | undefined, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function gradeColor(g: string | null): string {
  if (g === "A") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (g === "B") return "bg-sky-500/20 text-sky-300 border-sky-500/40";
  if (g === "C") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (g === "F") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

function winRateColor(r: number): string {
  if (r >= 0.7) return "text-emerald-300";
  if (r >= 0.5) return "text-amber-300";
  return "text-rose-300";
}

export default function IntelligencePage() {
  const [window, setWindow] = useState<Window>("month");
  const [data, setData] = useState<IntelligenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/intelligence?window=${window}`, { cache: "no-store" });
        const json = (await res.json()) as IntelligenceResponse | { error: string };
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
        if (!cancelled) setData(json as IntelligenceResponse);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [window]);

  async function copyExport() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data.export_payload, null, 2));
      setCopyStatus("Intelligence JSON copied to clipboard");
      setTimeout(() => setCopyStatus(null), 3000);
    } catch {
      setCopyStatus("Copy failed — clipboard API unavailable");
      setTimeout(() => setCopyStatus(null), 3000);
    }
  }

  return (
    <div className="container mx-auto max-w-6xl space-y-8 py-6">
      <h1 className="text-2xl font-semibold">Intelligence</h1>

      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {loading && !data && (
        <div className="text-sm text-muted-foreground">Loading intelligence…</div>
      )}

      {data && (
        <>
          <PerformanceSection
            data={data}
            window={window}
            onWindowChange={setWindow}
          />
          <TickerRankingsSection
            rankings={data.ticker_rankings}
            expandedSymbol={expandedSymbol}
            onToggleSymbol={(s) => setExpandedSymbol((prev) => (prev === s ? null : s))}
          />
          <PatternIntelligenceSection patterns={data.patterns} />
          <ExportSection onCopy={copyExport} copyStatus={copyStatus} />
        </>
      )}
    </div>
  );
}

// ================== Section 1 ==================

function PerformanceSection({
  data,
  window,
  onWindowChange,
}: {
  data: IntelligenceResponse;
  window: Window;
  onWindowChange: (w: Window) => void;
}) {
  const { stats, equity_curve } = data;
  const pnlColor = stats.total_pnl >= 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Performance</h2>
        <div className="flex flex-wrap gap-1">
          {WINDOW_OPTIONS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => onWindowChange(w.value)}
              className={`rounded px-3 py-1 text-xs ${
                window === w.value
                  ? "bg-foreground text-background"
                  : "border border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Realized P&L">
          <span className={pnlColor}>{fmtMoney(stats.total_pnl, true)}</span>
        </StatCard>
        <StatCard label="Win Rate">
          <span>
            {stats.wins} / {stats.total_trades}{" "}
            <span className="text-xs text-muted-foreground">
              ({fmtPct(stats.win_rate, 0)})
            </span>
          </span>
        </StatCard>
        <StatCard label="Avg ROC / trade">{fmtPct(stats.avg_roc, 2)}</StatCard>
        <StatCard label="Expectancy / trade">
          <span className={stats.expectancy >= 0 ? "text-emerald-300" : "text-rose-300"}>
            {fmtMoney(stats.expectancy, true)}
          </span>
        </StatCard>
        <StatCard label="Best / Worst">
          <div className="space-y-1 text-xs">
            {stats.best_trade ? (
              <div>
                <span className="text-muted-foreground">Best:</span>{" "}
                {stats.best_trade.symbol}{" "}
                <span className="text-emerald-300">
                  {fmtMoney(stats.best_trade.pnl, true)}
                </span>{" "}
                <span className="text-muted-foreground">({fmtPct(stats.best_trade.roc, 2)})</span>
              </div>
            ) : (
              <div className="text-muted-foreground">Best: —</div>
            )}
            {stats.worst_trade ? (
              <div>
                <span className="text-muted-foreground">Worst:</span>{" "}
                {stats.worst_trade.symbol}{" "}
                <span className="text-rose-300">
                  {fmtMoney(stats.worst_trade.pnl, true)}
                </span>{" "}
                <span className="text-muted-foreground">({fmtPct(stats.worst_trade.roc, 2)})</span>
              </div>
            ) : (
              <div className="text-muted-foreground">Worst: —</div>
            )}
          </div>
        </StatCard>
      </div>

      <div className="rounded-md border border-border bg-background/40 p-3">
        <div className="mb-2 text-sm font-medium">Equity curve</div>
        {equity_curve.length < 2 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Not enough trades to display equity curve.
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equity_curve}>
                <defs>
                  <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.3} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 11 }} />
                <YAxis stroke="#71717a" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: "#18181b",
                    border: "1px solid #3f3f46",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#e4e4e7" }}
                  formatter={(value, name) => {
                    const n = typeof value === "number" ? value : Number(value);
                    if (name === "cumulative_pnl") return [fmtMoney(n, true), "Cumulative"];
                    if (name === "trade_pnl") return [fmtMoney(n, true), "Trade P&L"];
                    return [String(value), String(name)];
                  }}
                  labelFormatter={(label, payload) => {
                    const sym = (payload?.[0]?.payload as EquityPoint | undefined)?.symbol;
                    return sym ? `${label} · ${sym}` : label;
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cumulative_pnl"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#pnlGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{children}</div>
    </div>
  );
}

// ================== Section 2 ==================

function TickerRankingsSection({
  rankings,
  expandedSymbol,
  onToggleSymbol,
}: {
  rankings: TickerRanking[];
  expandedSymbol: string | null;
  onToggleSymbol: (s: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Capital Efficiency by Ticker</h2>
        <p className="text-xs text-muted-foreground">
          Sorted by average ROC — your best-performing setups
        </p>
      </div>
      {rankings.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          No closed trades yet. Rankings appear after your first closed position.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
                <TableHead className="text-right">Avg ROC</TableHead>
                <TableHead className="text-right">Best ROC</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Rec Accuracy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rankings.map((r) => (
                <TickerRow
                  key={r.symbol}
                  row={r}
                  expanded={expandedSymbol === r.symbol}
                  onToggle={() => onToggleSymbol(r.symbol)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function TickerRow({
  row,
  expanded,
  onToggle,
}: {
  row: TickerRanking;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow onClick={onToggle} className="cursor-pointer hover:bg-muted/20">
        <TableCell className="font-mono">{row.symbol}</TableCell>
        <TableCell className="text-right">{row.trades}</TableCell>
        <TableCell className={`text-right ${winRateColor(row.win_rate)}`}>
          {fmtPct(row.win_rate, 0)}
        </TableCell>
        <TableCell className="text-right">{fmtPct(row.avg_roc, 2)}</TableCell>
        <TableCell className="text-right">{fmtPct(row.best_roc, 2)}</TableCell>
        <TableCell>
          {row.top_grade ? (
            <span
              className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${gradeColor(row.top_grade)}`}
            >
              {row.top_grade}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right text-xs">
          {row.rec_total !== null && row.rec_total > 0
            ? `${row.rec_aligned}/${row.rec_total} correct`
            : "—"}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-background/40">
          <TableCell colSpan={7}>
            <div className="space-y-2 py-2">
              <div className="text-xs font-medium text-foreground">
                Closed trades for {row.symbol}
              </div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left">Opened</th>
                    <th className="text-left">Closed</th>
                    <th className="text-right">Premium</th>
                    <th className="text-right">P&L</th>
                    <th className="text-right">ROC</th>
                    <th className="text-left">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {row.closed_trades.map((t, i) => (
                    <tr key={i}>
                      <td>{t.opened_date}</td>
                      <td>{t.closed_date ?? "—"}</td>
                      <td className="text-right">{fmtMoney(t.avg_premium_sold)}</td>
                      <td
                        className={`text-right ${
                          t.realized_pnl !== null && t.realized_pnl >= 0
                            ? "text-emerald-300"
                            : "text-rose-300"
                        }`}
                      >
                        {fmtMoney(t.realized_pnl, true)}
                      </td>
                      <td className="text-right">{fmtPct(t.roc, 2)}</td>
                      <td>{t.grade ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ================== Section 3 ==================

function PatternIntelligenceSection({
  patterns,
}: {
  patterns: IntelligenceResponse["patterns"];
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Pattern Intelligence</h2>
      {!patterns.enabled ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          Pattern detection requires 10+ closed trades. You have {patterns.total_closed} so
          far — keep trading.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <GradePanel buckets={patterns.by_grade} calibration={patterns.calibration} />
          <DayOfWeekPanel buckets={patterns.by_day_of_week} />
          <VixRegimePanel buckets={patterns.by_vix_regime} />
          <CalibrationPanel buckets={patterns.by_grade} calibration={patterns.calibration} />
          {patterns.rec_accuracy && <RecAccuracyPanel accuracy={patterns.rec_accuracy} />}
        </div>
      )}
    </section>
  );
}

function bucketInterpBest(buckets: PatternBucket[]): PatternBucket | null {
  const valid = buckets.filter((b) => b.trades > 0);
  if (valid.length === 0) return null;
  return valid.reduce((best, b) => (b.win_rate > best.win_rate ? b : best));
}
function bucketInterpWorst(buckets: PatternBucket[]): PatternBucket | null {
  const valid = buckets.filter((b) => b.trades > 0);
  if (valid.length === 0) return null;
  return valid.reduce((worst, b) => (b.win_rate < worst.win_rate ? b : worst));
}

function PanelShell({
  title,
  interp,
  children,
}: {
  title: string;
  interp: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="h-48 w-full">{children}</div>
      <div className="mt-2 text-xs text-muted-foreground">{interp}</div>
    </div>
  );
}

function GradePanel({
  buckets,
  calibration,
}: {
  buckets: PatternBucket[];
  calibration: { drift: boolean; summary: string };
}) {
  const chartData = buckets.map((b) => ({
    key: b.key,
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const best = bucketInterpBest(buckets);
  const interp = calibration.drift
    ? "⚠ Grade B outperforms A — review what's different about your A-grade trades."
    : best
      ? `Grade ${best.key} setups are winning at ${Math.round(best.win_rate * 100)}% — screener is well-calibrated at that tier.`
      : "Not enough grade data yet.";
  const colorFor = (k: string) =>
    k === "A" ? "#10b981" : k === "B" ? "#3b82f6" : k === "C" ? "#f59e0b" : "#ef4444";
  return (
    <PanelShell title="Win rate by screener grade" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value) => [`${Math.round(Number(value))}%`, "Win rate"]}
          />
          <Bar dataKey="winPct">
            {chartData.map((d) => (
              <Cell key={d.key} fill={colorFor(d.key)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function DayOfWeekPanel({ buckets }: { buckets: PatternBucket[] }) {
  const chartData = buckets.map((b) => ({
    key: b.key,
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const best = bucketInterpBest(buckets);
  const worst = bucketInterpWorst(buckets);
  const interp =
    best && worst && best.key !== worst.key
      ? `${best.key} closes win at ${Math.round(best.win_rate * 100)}%. ${worst.key} closes at ${Math.round(worst.win_rate * 100)}% — consider your day-of-week exposure.`
      : "Need more varied-day closes to identify patterns.";
  return (
    <PanelShell title="Win rate by day of week (close)" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value) => [`${Math.round(Number(value))}%`, "Win rate"]}
          />
          <Bar dataKey="winPct" fill="#8b5cf6" />
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function VixRegimePanel({ buckets }: { buckets: PatternBucket[] }) {
  const chartData = buckets.map((b) => ({
    key: b.key.charAt(0).toUpperCase() + b.key.slice(1),
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const panic = buckets.find((b) => b.key === "panic");
  let interp = "VIX regime breakdown across closed trades.";
  if (panic && panic.trades > 0 && panic.trades < 5) {
    interp = `VIX Panic regime: ${panic.trades} trades, ${Math.round(panic.win_rate * 100)}% win rate. Sample too small to conclude — 5+ needed.`;
  } else if (panic && panic.trades >= 5 && panic.win_rate < 0.5) {
    interp = `⚠ VIX Panic: ${Math.round(panic.win_rate * 100)}% win rate over ${panic.trades} trades — you underperform in panic regimes.`;
  }
  const colorFor = (k: string) =>
    k === "calm" ? "#10b981" : k === "elevated" ? "#f59e0b" : "#ef4444";
  return (
    <PanelShell title="Win rate by VIX regime (entry)" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value) => [`${Math.round(Number(value))}%`, "Win rate"]}
          />
          <Bar dataKey="winPct">
            {chartData.map((d) => (
              <Cell key={d.key} fill={colorFor(d.key.toLowerCase())} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function CalibrationPanel({
  buckets,
  calibration,
}: {
  buckets: PatternBucket[];
  calibration: { drift: boolean; summary: string };
}) {
  const expected: Record<string, string> = { A: "High", B: "Medium", C: "Low", F: "Skip" };
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-sm font-medium">Was the screener right?</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left">Grade</th>
              <th className="text-right">Trades</th>
              <th className="text-right">Wins</th>
              <th className="text-right">Win Rate</th>
              <th className="text-right">Avg ROC</th>
              <th>Expected</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const mark =
                b.trades === 0
                  ? ""
                  : (b.key === "A" && b.win_rate >= 0.75) ||
                      (b.key === "B" && b.win_rate >= 0.6) ||
                      (b.key === "C" && b.win_rate >= 0.4) ||
                      b.key === "F"
                    ? "✓"
                    : "⚠";
              return (
                <tr key={b.key}>
                  <td>{b.key}</td>
                  <td className="text-right">{b.trades}</td>
                  <td className="text-right">{b.wins}</td>
                  <td className="text-right">
                    {b.trades > 0 ? `${Math.round(b.win_rate * 100)}%` : "—"}
                  </td>
                  <td className="text-right">{fmtPct(b.avg_roc, 2)}</td>
                  <td className="text-muted-foreground">
                    {expected[b.key]} {mark}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">{calibration.summary}</div>
    </div>
  );
}

function RecAccuracyPanel({
  accuracy,
}: {
  accuracy: NonNullable<IntelligenceResponse["patterns"]["rec_accuracy"]>;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-sm font-medium">Post-earnings recommendation accuracy</div>
      <div className="space-y-1 text-xs">
        <div>
          CLOSE recommendations:{" "}
          <span className="text-foreground">
            {accuracy.close_correct}/{accuracy.close_total} correct
          </span>
        </div>
        <div>
          HOLD recommendations:{" "}
          <span className="text-foreground">
            {accuracy.hold_correct}/{accuracy.hold_total} correct
          </span>
        </div>
        <div>
          Overall:{" "}
          <span className="text-foreground">{Math.round(accuracy.overall_pct * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

// ================== Section 4 ==================

function ExportSection({
  onCopy,
  copyStatus,
}: {
  onCopy: () => void;
  copyStatus: string | null;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">Export Intelligence</h2>
        <p className="text-xs text-muted-foreground">
          One-click JSON dump for pasting into Claude chat for deeper analysis
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={onCopy}>📋 Copy Intelligence JSON</Button>
        {copyStatus && <span className="text-xs text-emerald-300">{copyStatus}</span>}
      </div>
    </section>
  );
}

