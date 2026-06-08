"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  LineChart,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------- Response shapes (minimal subsets) ----------
type Position = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  remainingContracts: number;
  pnlDollars: number | null;
  urgency: "EMERGENCY_CUT" | "CUT" | "MONITOR" | "HOLD";
  badgeLabel: string;
};
type PositionsResp = { positions: Position[] };
type WatchRow = {
  symbol: string;
  changePct: number | null;
  action: "CUT" | "TAKE_PROFIT" | "DCA" | "HOLD";
  flags: Array<{ kind: string; label: string }>;
};
type WatchResp = { watchlist: WatchRow[] };
type Tile = { price: number | null; changePct: number | null };
type MarketResp = {
  spy: Tile;
  qqq: Tile;
  xlk: Tile;
  iwf: Tile;
  tnx: Tile;
};

type Slot<T> = { status: "loading" | "ok" | "error"; data: T | null };
const LOADING: Slot<never> = { status: "loading", data: null };

// Long-horizon flags that qualify a row as an "active alert".
const ALERT_FLAGS = ["FALLING_KNIFE", "DEAD_WEIGHT", "STRETCHED", "VALUE_TRAP"];

// ---------- Date helpers (US Eastern, the market day) ----------
function easternToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function addDayStr(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
function prettyToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

// ---------- Formatters ----------
function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function pnlColor(n: number | null): string {
  if (n === null) return "text-muted-foreground";
  return n >= 0 ? "text-emerald-400" : "text-rose-400";
}

// ---------- Badge tones (exact spec hex) ----------
type Tone = "red" | "amber" | "green" | "neutral";
function toneFor(kind: string): Tone {
  const k = kind.toUpperCase();
  if (["CUT", "FALLING_KNIFE", "DEAD_WEIGHT", "EMERGENCY_CUT"].includes(k))
    return "red";
  if (["WATCH", "STRETCHED", "VALUE_TRAP", "MONITOR", "TAKE_PROFIT"].includes(k))
    return "amber";
  if (["DCA", "COMPOUNDER", "TURNAROUND"].includes(k)) return "green";
  return "neutral";
}
const TONE_STYLE: Record<Exclude<Tone, "neutral">, React.CSSProperties> = {
  red: { backgroundColor: "#FCEBEB", color: "#A32D2D" },
  amber: { backgroundColor: "#FAEEDA", color: "#854F0B" },
  green: { backgroundColor: "#EAF3DE", color: "#3B6D11" },
};
function Badge({ kind, label }: { kind: string; label: string }) {
  const tone = toneFor(kind);
  const cls =
    "inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide";
  if (tone === "neutral") {
    return (
      <span className={cn(cls, "bg-muted text-muted-foreground")}>{label}</span>
    );
  }
  return (
    <span className={cls} style={TONE_STYLE[tone]}>
      {label}
    </span>
  );
}

// ---------- Layout primitives ----------
function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card px-5 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  icon,
  children,
  right,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
        {icon}
        {children}
      </div>
      {right}
    </div>
  );
}

function MetricBox({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex-1 rounded-md bg-muted px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-xl font-medium", valueClass)}>{value}</div>
    </div>
  );
}

function SkeletonLines({ n = 3 }: { n?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted/60" />
      ))}
    </div>
  );
}

// Colored daily-change cell.
function ChangeCell({ pct }: { pct: number | null }) {
  return <span className={cn("font-mono", pnlColor(pct))}>{fmtPct(pct)}</span>;
}

export function DashboardView() {
  const [positions, setPositions] = useState<Slot<PositionsResp>>(LOADING);
  const [watch, setWatch] = useState<Slot<WatchResp>>(LOADING);
  const [vix, setVix] = useState<Slot<number | null>>(LOADING);
  const [market, setMarket] = useState<Slot<MarketResp>>(LOADING);

  const [brief, setBrief] = useState<string | null>(null);
  const [briefAt, setBriefAt] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load<T>(
      url: string,
      set: (s: Slot<T>) => void,
      pick: (j: unknown) => T,
    ) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = (await res.json()) as unknown;
        if (!res.ok) throw new Error("bad status");
        if (alive) set({ status: "ok", data: pick(json) });
      } catch {
        if (alive) set({ status: "error", data: null });
      }
    }
    void load<PositionsResp>(
      "/api/positions/open",
      setPositions,
      (j) => j as PositionsResp,
    );
    void load<WatchResp>(
      "/api/longterm/watchlist",
      setWatch,
      (j) => j as WatchResp,
    );
    void load<number | null>(
      "/api/context/daily",
      setVix,
      (j) => (j as { market?: { vix?: number | null } }).market?.vix ?? null,
    );
    void load<MarketResp>(
      "/api/dashboard/market-context",
      setMarket,
      (j) => j as MarketResp,
    );
    void (async () => {
      try {
        const res = await fetch("/api/longterm/morning-brief", {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          brief: string | null;
          fetched_at: string | null;
        };
        if (alive && json.brief) {
          setBrief(json.brief);
          setBriefAt(json.fetched_at);
        }
      } catch {
        /* no cached brief */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const generateBrief = useCallback(async () => {
    setBriefLoading(true);
    setBriefError(null);
    try {
      const res = await fetch("/api/longterm/morning-brief", {
        method: "POST",
        cache: "no-store",
      });
      const json = (await res.json()) as {
        brief?: string;
        fetched_at?: string;
        error?: string;
      };
      if (!res.ok || !json.brief) throw new Error(json.error ?? "failed");
      setBrief(json.brief);
      setBriefAt(json.fetched_at ?? null);
    } catch (e) {
      setBriefError(
        e instanceof Error && e.message !== "failed"
          ? e.message
          : "Could not generate the brief. Try again.",
      );
    } finally {
      setBriefLoading(false);
    }
  }, []);

  const today = easternToday();
  const tomorrow = addDayStr(today);

  // ---------- Card 1 (CSP) ----------
  const pos = positions.data?.positions ?? [];
  const unrealized = pos.every((p) => p.pnlDollars === null)
    ? null
    : pos.reduce((s, p) => s + (p.pnlDollars ?? 0), 0);
  const expiringSoon = pos.filter(
    (p) => p.expiry === today || p.expiry === tomorrow,
  ).length;
  const needsAttn = pos.filter(
    (p) => p.urgency === "EMERGENCY_CUT" || p.urgency === "MONITOR",
  ).length;

  // ---------- Card 2 (alerts) ----------
  const wl = watch.data?.watchlist ?? [];
  function alertFlagOf(r: WatchRow) {
    for (const want of ALERT_FLAGS) {
      const f = r.flags.find((fl) => fl.kind.toUpperCase() === want);
      if (f) return f;
    }
    return null;
  }
  const alertRows = wl
    .map((r) => ({ row: r, flag: alertFlagOf(r) }))
    .filter((x) => x.flag !== null)
    .sort(
      (a, b) =>
        ALERT_FLAGS.indexOf(a.flag!.kind.toUpperCase()) -
        ALERT_FLAGS.indexOf(b.flag!.kind.toUpperCase()),
    );

  // ---------- Attention panel ----------
  const attention = pos
    .filter(
      (p) =>
        p.urgency === "EMERGENCY_CUT" ||
        p.urgency === "MONITOR" ||
        (p.pnlDollars !== null && p.pnlDollars < 0),
    )
    .sort((a, b) => {
      const order = { EMERGENCY_CUT: 0, CUT: 1, MONITOR: 2, HOLD: 3 };
      return order[a.urgency] - order[b.urgency];
    });

  // ---------- Top movers ----------
  const withChange = wl.filter((r) => r.changePct !== null);
  const byDesc = [...withChange].sort(
    (a, b) => (b.changePct ?? 0) - (a.changePct ?? 0),
  );
  const gainersOver = byDesc.filter((r) => (r.changePct ?? 0) > 5);
  const gainers = gainersOver.length > 0 ? gainersOver : byDesc.slice(0, 5);
  const byAsc = [...withChange].sort(
    (a, b) => (a.changePct ?? 0) - (b.changePct ?? 0),
  );
  const losersUnder = byAsc.filter((r) => (r.changePct ?? 0) < -5);
  const losers = losersUnder.length > 0 ? losersUnder : byAsc.slice(0, 5);

  function moverBadge(r: WatchRow) {
    const f = r.flags[0];
    if (f) return <Badge kind={f.kind} label={f.label} />;
    return <Badge kind={r.action} label={r.action.replace(/_/g, " ")} />;
  }

  function MoverRow({ r }: { r: WatchRow }) {
    return (
      <div className="flex items-center gap-2 py-1 text-sm">
        <span className="w-[50px] shrink-0 font-mono font-semibold">
          {r.symbol}
        </span>
        <span className="flex-1 truncate">{moverBadge(r)}</span>
        <span className="w-20 text-right">
          <ChangeCell pct={r.changePct} />
        </span>
      </div>
    );
  }

  // ---------- Market tiles ----------
  const m = market.data;
  const tnxYield =
    m?.tnx.price !== null && m?.tnx.price !== undefined ? m.tnx.price / 10 : null;

  return (
    <div className="space-y-4">
      {/* ---------- Header ---------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Morning Dashboard</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span>{prettyToday()}</span>
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
              VIX{" "}
              {vix.status === "loading"
                ? "…"
                : vix.data !== null && vix.data !== undefined
                  ? vix.data.toFixed(2)
                  : "—"}
            </span>
          </div>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-400"
        >
          Screen Today <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {/* ---------- ROW 1: three cards ---------- */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Card 1 — CSP Status (clickable) */}
        <Link href="/positions" className="group block">
          <Panel className="h-full transition-colors group-hover:border-foreground/30">
            <SectionHeader icon={<LineChart className="h-4 w-4" />}>
              CSP Status
            </SectionHeader>
            {positions.status === "loading" ? (
              <SkeletonLines n={4} />
            ) : positions.status === "error" ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <>
                <div className="flex gap-2">
                  <MetricBox label="Positions" value={pos.length} />
                  <MetricBox
                    label="Unrealized P&L"
                    value={fmtMoney(unrealized)}
                    valueClass={pnlColor(unrealized)}
                  />
                </div>
                <div className="mt-3 space-y-1 text-sm">
                  <div className="text-muted-foreground">
                    Expiring today + tmrw:{" "}
                    <span className="font-semibold text-foreground">
                      {expiringSoon}
                    </span>
                  </div>
                  {needsAttn > 0 ? (
                    <div className="font-medium text-rose-400">
                      {needsAttn} need{needsAttn === 1 ? "s" : ""} attention
                    </div>
                  ) : (
                    <div className="font-medium text-emerald-400">
                      All healthy ✓
                    </div>
                  )}
                </div>
              </>
            )}
          </Panel>
        </Link>

        {/* Card 2 — Long-term alerts (clickable) */}
        <Link href="/longterm/watchlist" className="group block">
          <Panel className="h-full transition-colors group-hover:border-foreground/30">
            <SectionHeader icon={<AlertTriangle className="h-4 w-4" />}>
              Long-term alerts
            </SectionHeader>
            {watch.status === "loading" ? (
              <SkeletonLines n={4} />
            ) : watch.status === "error" ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : alertRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active alerts.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {alertRows.slice(0, 4).map(({ row, flag }) => (
                    <div
                      key={row.symbol}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span className="w-[50px] shrink-0 font-mono font-semibold">
                        {row.symbol}
                      </span>
                      <Badge
                        kind={row.action}
                        label={row.action.replace(/_/g, " ")}
                      />
                      <span className="flex-1 truncate text-xs text-muted-foreground">
                        {flag!.label}
                      </span>
                      <span className="w-16 text-right">
                        <ChangeCell pct={row.changePct} />
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground">
                  {alertRows.length} active alert
                  {alertRows.length === 1 ? "" : "s"}
                  <ArrowRight className="h-3 w-3" /> view all
                </div>
              </>
            )}
          </Panel>
        </Link>

        {/* Card 3 — Market Context (no link) */}
        <Panel className="h-full">
          <SectionHeader icon={<LineChart className="h-4 w-4" />}>
            Market context
          </SectionHeader>
          {market.status === "loading" ? (
            <SkeletonLines n={4} />
          ) : market.status === "error" || !m ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <>
              <div className="flex gap-2">
                <MetricBox
                  label="SPY today"
                  value={fmtPct(m.spy.changePct)}
                  valueClass={pnlColor(m.spy.changePct)}
                />
                <MetricBox
                  label="QQQ today"
                  value={fmtPct(m.qqq.changePct)}
                  valueClass={pnlColor(m.qqq.changePct)}
                />
              </div>
              <div className="mt-3 space-y-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Tech (XLK)</span>
                  <ChangeCell pct={m.xlk.changePct} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Growth (IWF)</span>
                  <ChangeCell pct={m.iwf.changePct} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">10Y yield</span>
                  <span className={cn("font-mono", pnlColor(m.tnx.changePct))}>
                    {tnxYield !== null ? `${tnxYield.toFixed(2)}%` : "—"}
                  </span>
                </div>
              </div>
            </>
          )}
        </Panel>
      </div>

      {/* ---------- ROW 2: attention panel ---------- */}
      <Panel
        className={cn(
          attention.length > 0 && "border-rose-500/40",
        )}
      >
        {positions.status === "loading" ? (
          <SkeletonLines n={3} />
        ) : positions.status === "error" ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : attention.length === 0 ? (
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            All positions healthy ✓
          </div>
        ) : (
          <>
            <SectionHeader
              icon={<TriangleAlert className="h-4 w-4 text-rose-400" />}
            >
              <span className="text-rose-400">Positions needing attention</span>
            </SectionHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Symbol</th>
                    <th className="py-1.5 pr-3 font-medium">Strike</th>
                    <th className="py-1.5 pr-3 font-medium">Expiry</th>
                    <th className="py-1.5 pr-3 text-right font-medium">P&L</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {attention.map((p) => (
                    <tr key={p.id} className="border-t border-border/60">
                      <td className="py-1.5 pr-3 font-mono font-semibold">
                        {p.symbol}
                      </td>
                      <td className="py-1.5 pr-3 font-mono">${p.strike}</td>
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                        {p.expiry}
                      </td>
                      <td
                        className={cn(
                          "py-1.5 pr-3 text-right font-mono",
                          pnlColor(p.pnlDollars),
                        )}
                      >
                        {fmtMoney(p.pnlDollars)}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Badge
                          kind={p.urgency}
                          label={p.badgeLabel || p.urgency.replace(/_/g, " ")}
                        />
                      </td>
                      <td className="py-1.5">
                        <Link
                          href="/positions"
                          className="text-xs font-semibold text-rose-300 hover:text-rose-200"
                        >
                          Close →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>

      {/* ---------- ROW 3: two panels ---------- */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Left — Top movers today */}
        <Panel>
          <SectionHeader icon={<LineChart className="h-4 w-4" />}>
            Top movers today
          </SectionHeader>
          {watch.status === "loading" ? (
            <SkeletonLines n={5} />
          ) : watch.status === "error" ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : withChange.length === 0 ? (
            <p className="text-sm text-muted-foreground">No quotes today.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                  Gainers
                </div>
                {gainers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  gainers.map((r) => <MoverRow key={r.symbol} r={r} />)
                )}
              </div>
              <div className="border-t border-border/60" />
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-rose-400">
                  Losers
                </div>
                {losers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  losers.map((r) => <MoverRow key={r.symbol} r={r} />)
                )}
              </div>
            </div>
          )}
        </Panel>

        {/* Right — AI Morning Brief */}
        <Panel>
          <SectionHeader
            icon={<Brain className="h-4 w-4" />}
            right={
              <span className="text-[11px] text-muted-foreground">cached 4h</span>
            }
          >
            AI morning brief
          </SectionHeader>
          {briefError && (
            <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {briefError}
            </div>
          )}
          {brief ? (
            <div>
              <p
                className="text-foreground/90"
                style={{ fontSize: "13px", lineHeight: 1.6 }}
              >
                {brief}
              </p>
              <button
                type="button"
                onClick={() => void generateBrief()}
                disabled={briefLoading}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
              >
                {briefLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Regenerate
              </button>
              {briefAt && (
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {new Date(briefAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              )}
            </div>
          ) : briefLoading ? (
            <SkeletonLines n={3} />
          ) : (
            <button
              type="button"
              onClick={() => void generateBrief()}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-400"
            >
              <Brain className="h-4 w-4" />
              Generate Morning Brief
            </button>
          )}
        </Panel>
      </div>
    </div>
  );
}
