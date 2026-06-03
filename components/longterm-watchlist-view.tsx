"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Allocation = "Large" | "Medium" | "Small";
type Action = "TAKE_PROFIT" | "DCA" | "CUT" | "HOLD";
type FlagKind =
  | "COMPOUNDER"
  | "TURNAROUND"
  | "VALUE_TRAP"
  | "STRETCHED"
  | "DEAD_WEIGHT"
  | "FALLING_KNIFE";

type Flag = {
  kind: FlagKind;
  label: string;
  description: string;
};

type Row = {
  id: string;
  symbol: string;
  allocation: Allocation;
  notes: string | null;
  created_at: string;
  updated_at: string;
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  twoHundredDayAverage: number | null;
  pctVs200dSma: number | null;
  momentum3mPct: number | null;
  return3yPct: number | null;
  vsSpy3yPct: number | null;
  buyZone: { low: number; high: number } | null;
  sellZone: { low: number; high: number } | null;
  flags: Flag[];
  action: Action;
  hasEncyclopedia: boolean;
};

type Alert = {
  kind: "big_move" | "falling_knife" | "extended";
  symbol: string;
  message: string;
  changePct: number | null;
  timeframeForCatalyst: "1d" | "1w" | "1m";
};

type CatalystResponse = {
  symbol: string;
  timeframe: "1d" | "1w" | "1m";
  change_pct: number | null;
  analysis: string | null;
  signal: string | null;
  cached: boolean;
  fetched_at: string;
};

type SortKey =
  | "price"
  | "changePct"
  | "momentum3mPct"
  | "return3yPct"
  | "vsSpy3yPct"
  | "pctVs200dSma"
  | "trailingPE"
  | "pegRatio"
  | "action";

type SortDir = "asc" | "desc";

const ACTION_SEVERITY: Record<Action, number> = {
  CUT: 3,
  TAKE_PROFIT: 2,
  DCA: 1,
  HOLD: 0,
};

const FLAG_BADGE: Record<FlagKind, string> = {
  COMPOUNDER: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  TURNAROUND: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  VALUE_TRAP: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  STRETCHED: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  DEAD_WEIGHT: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  FALLING_KNIFE: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRatio(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function allocationBadge(a: Allocation): string {
  switch (a) {
    case "Large":
      return "border-sky-500/40 bg-sky-500/10 text-sky-300";
    case "Medium":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "Small":
      return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
  }
}

function pegColor(peg: number | null): string {
  if (peg === null || !Number.isFinite(peg)) return "text-muted-foreground";
  if (peg < 1.5) return "text-emerald-300";
  if (peg <= 2) return "text-amber-300";
  return "text-rose-300";
}

function actionLabel(a: Action): string {
  switch (a) {
    case "TAKE_PROFIT":
      return "🟡 Take Profit";
    case "DCA":
      return "🟢 DCA";
    case "CUT":
      return "🔴 Cut";
    case "HOLD":
      return "⚪ Hold";
  }
}

function actionBadge(a: Action): string {
  switch (a) {
    case "TAKE_PROFIT":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "DCA":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "CUT":
      return "border-rose-500/40 bg-rose-500/10 text-rose-300";
    case "HOLD":
      return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
  }
}

function alertBadgeClass(kind: Alert["kind"]): string {
  switch (kind) {
    case "big_move":
      return "border-sky-500/40 bg-sky-500/10 text-sky-200";
    case "falling_knife":
      return "border-rose-500/40 bg-rose-500/10 text-rose-200";
    case "extended":
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  }
}

function alertKindLabel(kind: Alert["kind"]): string {
  switch (kind) {
    case "big_move":
      return "BIG MOVE";
    case "falling_knife":
      return "FALLING KNIFE";
    case "extended":
      return "EXTENDED";
  }
}

// Visual 52-week range bar + buy/sell zone callouts below.
function FiftyTwoWeekBar({
  price,
  low,
  high,
  buyZone,
  sellZone,
}: {
  price: number | null;
  low: number | null;
  high: number | null;
  buyZone: { low: number; high: number } | null;
  sellZone: { low: number; high: number } | null;
}) {
  if (price === null || low === null || high === null || high <= low) {
    return <span className="text-muted-foreground">—</span>;
  }
  const fraction = Math.max(0, Math.min(1, (price - low) / (high - low)));
  const pctLeft = fraction * 100;
  return (
    <div className="flex flex-col items-stretch gap-0.5">
      <div className="relative h-2 w-28 overflow-hidden rounded bg-muted/30">
        <div
          className="absolute inset-y-0 left-0 bg-amber-500/50"
          style={{ width: `${pctLeft}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground"
          style={{ left: `${pctLeft}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-muted-foreground/70">
        <span>{low.toFixed(0)}</span>
        <span>{high.toFixed(0)}</span>
      </div>
      {buyZone && (
        <div className="text-[9px] text-emerald-300/90">
          Buy ${buyZone.low.toFixed(0)}–${buyZone.high.toFixed(0)}
        </div>
      )}
      {sellZone && (
        <div className="text-[9px] text-amber-300/90">
          Sell ${sellZone.low.toFixed(0)}–${sellZone.high.toFixed(0)}
        </div>
      )}
    </div>
  );
}

export function LongTermWatchlistView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/longterm/watchlist", { cache: "no-store" });
      const json = (await res.json()) as {
        watchlist?: Row[];
        alerts?: Alert[];
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setRows(json.watchlist ?? []);
      setAlerts(json.alerts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const alertGroups = useMemo(() => {
    const byKind: Record<Alert["kind"], Alert[]> = {
      big_move: [],
      falling_knife: [],
      extended: [],
    };
    for (const a of alerts) byKind[a.kind].push(a);
    return byKind;
  }, [alerts]);

  // Click-to-sort cycle: null → asc → desc → null.
  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  const sortedRows = useMemo<Row[] | null>(() => {
    if (!rows) return rows;
    if (!sort) return rows;
    const getter = (r: Row): number | null => {
      switch (sort.key) {
        case "price": return r.price;
        case "changePct": return r.changePct;
        case "momentum3mPct": return r.momentum3mPct;
        case "return3yPct": return r.return3yPct;
        case "vsSpy3yPct": return r.vsSpy3yPct;
        case "pctVs200dSma": return r.pctVs200dSma;
        case "trailingPE": return r.trailingPE;
        case "pegRatio": return r.pegRatio;
        case "action": return ACTION_SEVERITY[r.action];
      }
    };
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      // Nulls sink to the bottom regardless of direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sort.dir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sort]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Long-Term Portfolio
          </h1>
          <p className="text-sm text-muted-foreground">
            Allocation buckets + live valuation. Click any column header to sort.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setDigestOpen(true)}>
            <Newspaper className="mr-1 h-4 w-4" /> Weekly Digest
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Add Stock
          </Button>
        </div>
      </div>

      {toast && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {toast}
        </div>
      )}
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <AlertsPanel
        alerts={alerts}
        groups={alertGroups}
        open={alertsOpen}
        onToggle={() => setAlertsOpen((s) => !s)}
      />

      <div className="overflow-x-auto rounded-md border border-border bg-background/40">
        <table className="w-full min-w-[1400px] text-xs">
          <thead className="border-b border-border bg-background/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left">Symbol</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Allocation</th>
              <SortHeader label="Price" k="price" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="Change%" k="changePct" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="3M Mom" k="momentum3mPct" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="3Y Return" k="return3yPct" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="vs SPY" k="vsSpy3yPct" sort={sort} onSort={toggleSort} align="right" />
              <th className="px-2 py-2 text-center">52W Range</th>
              <SortHeader label="Trend (200d)" k="pctVs200dSma" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="P/E" k="trailingPE" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="PEG" k="pegRatio" sort={sort} onSort={toggleSort} align="right" />
              <th className="px-2 py-2 text-center">Flags</th>
              <SortHeader label="Action" k="action" sort={sort} onSort={toggleSort} align="center" />
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && rows === null && (
              <tr>
                <td colSpan={15} className="px-2 py-8 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                </td>
              </tr>
            )}
            {!loading && rows && rows.length === 0 && (
              <tr>
                <td colSpan={15} className="px-2 py-8 text-center text-muted-foreground">
                  No symbols yet. Use Add Stock to start.
                </td>
              </tr>
            )}
            {sortedRows?.map((r) => (
              <WatchRow
                key={r.id}
                row={r}
                onDelete={async () => {
                  if (!confirm(`Remove ${r.symbol} from the watchlist?`)) return;
                  try {
                    const res = await fetch(
                      `/api/longterm/watchlist?id=${encodeURIComponent(r.id)}`,
                      { method: "DELETE" },
                    );
                    const json = (await res.json()) as { ok?: boolean; error?: string };
                    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
                    setRows((prev) => (prev ? prev.filter((q) => q.id !== r.id) : prev));
                    setToast(`${r.symbol} removed.`);
                  } catch (e) {
                    setToast(e instanceof Error ? e.message : "Delete failed");
                  }
                }}
                onSaveNotes={async (notes) => {
                  try {
                    const res = await fetch("/api/longterm/watchlist", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: r.id, notes }),
                    });
                    const json = (await res.json()) as { row?: Row; error?: string };
                    if (!res.ok || json.error || !json.row) {
                      throw new Error(json.error ?? `HTTP ${res.status}`);
                    }
                    setRows((prev) =>
                      prev
                        ? prev.map((q) =>
                            q.id === r.id
                              ? { ...q, notes: json.row!.notes, updated_at: json.row!.updated_at }
                              : q,
                          )
                        : prev,
                    );
                    setToast("Notes saved.");
                  } catch (e) {
                    setToast(e instanceof Error ? e.message : "Save failed");
                  }
                }}
                onSetAllocation={async (allocation) => {
                  try {
                    const res = await fetch("/api/longterm/watchlist", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: r.id, allocation }),
                    });
                    const json = (await res.json()) as { row?: Row; error?: string };
                    if (!res.ok || json.error || !json.row) {
                      throw new Error(json.error ?? `HTTP ${res.status}`);
                    }
                    void refetch();
                    setToast(`${r.symbol} → ${allocation}.`);
                  } catch (e) {
                    setToast(e instanceof Error ? e.message : "Update failed");
                  }
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      <AddStockDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(symbol) => {
          setAddOpen(false);
          setToast(`${symbol} added.`);
          void refetch();
        }}
      />
      <WeeklyDigestDialog open={digestOpen} onClose={() => setDigestOpen(false)} />
    </div>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (k: SortKey) => void;
  align: "left" | "right" | "center";
}) {
  const active = sort?.key === k;
  return (
    <th
      className={cn(
        "cursor-pointer select-none px-2 py-2 hover:text-foreground",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
      )}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active &&
          (sort?.dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </span>
    </th>
  );
}

function AlertsPanel({
  alerts,
  groups,
  open,
  onToggle,
}: {
  alerts: Alert[];
  groups: Record<Alert["kind"], Alert[]>;
  open: boolean;
  onToggle: () => void;
}) {
  if (alerts.length === 0) return null;
  const ordered = (
    [
      { kind: "falling_knife", items: groups.falling_knife },
      { kind: "extended", items: groups.extended },
      { kind: "big_move", items: groups.big_move },
    ] as Array<{ kind: Alert["kind"]; items: Alert[] }>
  ).filter((g) => g.items.length > 0);
  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-background/60"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Signals & Alerts</span>
          <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {alerts.length} active
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3 text-xs">
          {ordered.map(({ kind, items }) => (
            <div key={kind} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {alertKindLabel(kind)} · {items.length}
              </div>
              <ul className="space-y-1">
                {items.map((a, i) => (
                  <li
                    key={`${a.kind}-${a.symbol}-${i}`}
                    className="rounded border border-border/60 bg-background/40 px-2 py-1.5"
                  >
                    <AlertItem alert={a} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AlertItem({ alert }: { alert: Alert }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CatalystResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAnalysis() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/longterm/catalyst?symbol=${encodeURIComponent(alert.symbol)}&timeframe=${alert.timeframeForCatalyst}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as CatalystResponse & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
              alertBadgeClass(alert.kind),
            )}
          >
            {alertKindLabel(alert.kind)}
          </span>
          <span>{alert.message}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {result ? null : (
            <button
              type="button"
              onClick={runAnalysis}
              disabled={running}
              className="rounded border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Run Analysis"
              )}
            </button>
          )}
          <Link
            href={`/longterm/research?symbol=${encodeURIComponent(alert.symbol)}`}
            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            Deep Research →
          </Link>
        </span>
      </div>
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
          {error}
        </div>
      )}
      {result && result.analysis && (
        <div className="rounded border border-border/60 bg-background/60 px-2 py-1.5 text-[11px] text-foreground/90">
          {result.signal && (
            <span className="mr-1 rounded border border-border bg-background px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {result.signal}
            </span>
          )}
          {result.analysis}
          {result.cached && (
            <div className="mt-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
              cached · {new Date(result.fetched_at).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WatchRow({
  row,
  onDelete,
  onSaveNotes,
  onSetAllocation,
}: {
  row: Row;
  onDelete: () => void;
  onSaveNotes: (notes: string) => void;
  onSetAllocation: (a: Allocation) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draftNotes, setDraftNotes] = useState(row.notes ?? "");
  const changeColor =
    row.changePct === null
      ? "text-muted-foreground"
      : row.changePct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const smaColor =
    row.pctVs200dSma === null
      ? "text-muted-foreground"
      : row.pctVs200dSma >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const momentumColor =
    row.momentum3mPct === null
      ? "text-muted-foreground"
      : row.momentum3mPct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const r3yColor =
    row.return3yPct === null
      ? "text-muted-foreground"
      : row.return3yPct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const vsSpyColor =
    row.vsSpy3yPct === null
      ? "text-muted-foreground"
      : row.vsSpy3yPct >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  const visibleFlags = row.flags.slice(0, 2);
  const overflowFlags = row.flags.slice(2);
  const flagsTooltip = row.flags
    .map((f) => `${f.label}: ${f.description}`)
    .join("\n\n");

  return (
    <>
      <tr
        onClick={() => setExpanded((s) => !s)}
        className="cursor-pointer border-b border-border/40 hover:bg-background/60"
      >
        <td className="px-2 py-1.5 font-mono font-semibold">
          {row.symbol}
          {row.hasEncyclopedia && <span className="ml-1 text-[10px]">📚</span>}
        </td>
        <td className="px-2 py-1.5 text-muted-foreground">{row.companyName ?? "—"}</td>
        <td className="px-2 py-1.5">
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              allocationBadge(row.allocation),
            )}
          >
            {row.allocation}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(row.price)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", changeColor)}>
          {fmtPct(row.changePct)}
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", momentumColor)}>
          {fmtPct(row.momentum3mPct)}
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", r3yColor)}>
          {fmtPct(row.return3yPct)}
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", vsSpyColor)}>
          {fmtPct(row.vsSpy3yPct)}
        </td>
        <td className="px-2 py-1.5 align-middle">
          <div className="flex items-center justify-center">
            <FiftyTwoWeekBar
              price={row.price}
              low={row.fiftyTwoWeekLow}
              high={row.fiftyTwoWeekHigh}
              buyZone={row.buyZone}
              sellZone={row.sellZone}
            />
          </div>
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", smaColor)}>
          {fmtPct(row.pctVs200dSma)}
        </td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtRatio(row.trailingPE)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", pegColor(row.pegRatio))}>
          {row.pegRatio !== null && Number.isFinite(row.pegRatio)
            ? row.pegRatio.toFixed(2)
            : "—"}
        </td>
        <td className="px-2 py-1.5 text-center" title={flagsTooltip || undefined}>
          {visibleFlags.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="inline-flex flex-wrap items-center justify-center gap-1">
              {visibleFlags.map((f) => (
                <span
                  key={f.kind}
                  className={cn(
                    "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap",
                    FLAG_BADGE[f.kind],
                  )}
                >
                  {f.label}
                </span>
              ))}
              {overflowFlags.length > 0 && (
                <span className="rounded border border-border bg-background px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  +{overflowFlags.length}
                </span>
              )}
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap",
              actionBadge(row.action),
            )}
            title="Action signal — see route.ts computeAction"
          >
            {actionLabel(row.action)}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="rounded p-1 text-muted-foreground hover:bg-rose-500/15 hover:text-rose-300"
            title="Remove from watchlist"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-background/30">
          <td colSpan={15} className="px-3 py-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Notes
                </span>
                <textarea
                  value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                  placeholder="Thesis, watch levels, exit triggers…"
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onSaveNotes(draftNotes)}
                    disabled={draftNotes === (row.notes ?? "")}
                  >
                    Save Notes
                  </Button>
                  {draftNotes !== (row.notes ?? "") && (
                    <button
                      type="button"
                      onClick={() => setDraftNotes(row.notes ?? "")}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </label>
              <div className="flex flex-col items-start gap-2">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Move to
                </span>
                <div className="flex gap-1">
                  {(["Large", "Medium", "Small"] as Allocation[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => onSetAllocation(a)}
                      disabled={a === row.allocation}
                      className={cn(
                        "rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
                        a === row.allocation
                          ? allocationBadge(a)
                          : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                      )}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddStockDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (symbol: string) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [allocation, setAllocation] = useState<Allocation>("Large");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSymbol("");
      setAllocation("Large");
      setNotes("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    const s = symbol.trim().toUpperCase();
    if (!s) {
      setError("Symbol required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/longterm/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: s,
          allocation,
          notes: notes.trim() || undefined,
        }),
      });
      const json = (await res.json()) as { row?: Row; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      onAdded(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add stock to watchlist</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-muted-foreground">Symbol</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. MSFT"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 uppercase"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Allocation</span>
            <select
              value={allocation}
              onChange={(e) => setAllocation(e.target.value as Allocation)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            >
              <option value="Large">Large</option>
              <option value="Medium">Medium</option>
              <option value="Small">Small</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
              placeholder="Thesis, target, watch levels…"
            />
          </label>
          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            <X className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1 h-3.5 w-3.5" />
            )}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Strip Perplexity citation markers like [1], [2][3] from analysis text.
function stripCitations(text: string): string {
  return text.replace(/\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

// Render text with **bold** markdown segments as real <strong> elements,
// after stripping citation markers.
function renderRichText(text: string): ReactNode {
  const cleaned = stripCitations(text);
  const parts = cleaned.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(part);
    if (m) {
      return (
        <strong key={i} className="font-semibold">
          {m[1]}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function WeeklyDigestDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  type Mover = {
    symbol: string;
    companyName: string | null;
    changePct: number;
    catalyst: string | null;
  };
  type Payload = {
    weekStart: string;
    weekEnd: string;
    upMovers: Mover[];
    downMovers: Mover[];
    cached: boolean;
    fetched_at: string;
  };
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDigest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/longterm/digest", { cache: "no-store" });
      const json = (await res.json()) as Payload & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load digest");
    } finally {
      setLoading(false);
    }
  }, []);

  const forceRefresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await fetch("/api/longterm/digest", { method: "DELETE", cache: "no-store" });
    } catch {
      // Best-effort cache clear; re-fetch below regardless.
    }
    await loadDigest();
  }, [loadDigest]);

  useEffect(() => {
    if (!open) return;
    void loadDigest();
  }, [open, loadDigest]);

  function renderMover(m: Mover) {
    const color = m.changePct >= 0 ? "text-emerald-300" : "text-rose-300";
    return (
      <li key={m.symbol} className="rounded border border-border bg-background/40 px-3 py-2 text-xs">
        <div className="flex items-baseline justify-between">
          <span className="font-mono font-semibold">{m.symbol}</span>
          <span className={cn("font-mono font-semibold", color)}>
            {m.changePct >= 0 ? "+" : ""}{m.changePct.toFixed(2)}%
          </span>
        </div>
        {m.companyName && (
          <div className="text-muted-foreground">{m.companyName}</div>
        )}
        {m.catalyst && (
          <p className="mt-1 text-[11px] text-foreground/80">{renderRichText(m.catalyst)}</p>
        )}
        <Link
          href={`/longterm/research?symbol=${encodeURIComponent(m.symbol)}`}
          className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          Deep Research →
        </Link>
      </li>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Weekly Digest</DialogTitle>
        </DialogHeader>
        {data?.cached && (
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Cached
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider"
              onClick={() => void forceRefresh()}
              disabled={loading}
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        )}
        {loading && (
          <div className="py-8 text-center">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
            <div className="mt-2 text-xs text-muted-foreground">
              Aggregating weekly movers + catalysts…
            </div>
          </div>
        )}
        {error && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}
        {data && !loading && (
          <div className="space-y-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Week of {data.weekStart} · {data.cached ? "cached" : "fresh"}
            </div>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-emerald-300">Top 3 Up</h3>
              <ul className="space-y-2">
                {data.upMovers.length === 0 ? (
                  <li className="text-xs text-muted-foreground">No data.</li>
                ) : (
                  data.upMovers.map(renderMover)
                )}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-rose-300">Top 3 Down</h3>
              <ul className="space-y-2">
                {data.downMovers.length === 0 ? (
                  <li className="text-xs text-muted-foreground">No data.</li>
                ) : (
                  data.downMovers.map(renderMover)
                )}
              </ul>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
