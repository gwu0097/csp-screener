"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------- Response shapes (minimal subsets) ----------
type Position = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  remainingContracts: number;
  pnlDollars: number | null;
  urgency: "EMERGENCY_CUT" | "CUT" | "MONITOR" | "HOLD";
  badgeLabel: string;
};
type PositionsResp = {
  market: { vix: number | null };
  positions: Position[];
};
type WatchRow = {
  symbol: string;
  changePct: number | null;
  flags: Array<{ kind: string; label: string }>;
};
type WatchAlert = { kind: string; symbol: string; changePct: number | null };
type WatchResp = { watchlist: WatchRow[]; alerts: WatchAlert[] };
type EarningsItem = { symbol: string; date: string; timing: "BMO" | "AMC" };
type EarningsResp = {
  today: string;
  earnings: EarningsItem[];
  screenedSymbols: string[];
};

// ---------- Generic async slot ----------
type Slot<T> = { status: "loading" | "ok" | "error"; data: T | null };
const LOADING: Slot<never> = { status: "loading", data: null };

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
function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
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
function urgencyClasses(u: Position["urgency"]): string {
  switch (u) {
    case "EMERGENCY_CUT":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    case "CUT":
      return "bg-orange-500/15 text-orange-300 border-orange-500/30";
    case "MONITOR":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
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

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", valueClass)}>
        {value}
      </span>
    </div>
  );
}

// Clickable card shell — whole card links to its full page.
function LinkCard({
  href,
  title,
  icon,
  children,
}: {
  href: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className="group block">
      <Card className="h-full transition-colors group-hover:border-foreground/30">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {icon}
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">{children}</CardContent>
      </Card>
    </Link>
  );
}

export function DashboardView() {
  const [positions, setPositions] = useState<Slot<PositionsResp>>(LOADING);
  const [watch, setWatch] = useState<Slot<WatchResp>>(LOADING);
  const [earnings, setEarnings] = useState<Slot<EarningsResp>>(LOADING);
  const [vix, setVix] = useState<Slot<number | null>>(LOADING);

  // AI brief
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
    void load<EarningsResp>(
      "/api/dashboard/earnings",
      setEarnings,
      (j) => j as EarningsResp,
    );
    void load<number | null>(
      "/api/context/daily",
      setVix,
      (j) => (j as { market?: { vix?: number | null } }).market?.vix ?? null,
    );
    // Prefill any cached brief without spending a Perplexity call.
    void (async () => {
      try {
        const res = await fetch("/api/dashboard/morning-brief", {
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
        /* no cached brief — leave the generate button */
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
      const res = await fetch("/api/dashboard/morning-brief", {
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

  const today = earnings.data?.today ?? easternToday();
  const tomorrow = addDayStr(today);

  // ---------- Derived: Card 1 (CSP) ----------
  const pos = positions.data?.positions ?? [];
  const totalContracts = pos.reduce((s, p) => s + (p.remainingContracts || 0), 0);
  const unrealized = pos.every((p) => p.pnlDollars === null)
    ? null
    : pos.reduce((s, p) => s + (p.pnlDollars ?? 0), 0);
  const expiringSoon = pos.filter(
    (p) => p.expiry === today || p.expiry === tomorrow,
  ).length;
  const needsAttn = pos.filter(
    (p) => p.urgency === "EMERGENCY_CUT" || p.urgency === "MONITOR",
  ).length;

  // ---------- Derived: Card 2 (Long-Term) ----------
  const wl = watch.data?.watchlist ?? [];
  const alertList = watch.data?.alerts ?? [];
  const alertSymbols = Array.from(new Set(alertList.map((a) => a.symbol)));
  const changeBySymbol = new Map(wl.map((r) => [r.symbol, r.changePct]));
  const topAlerts = alertSymbols.slice(0, 3);

  // ---------- Derived: Card 3 + panels (earnings) ----------
  const earns = earnings.data?.earnings ?? [];
  const screened = new Set(earnings.data?.screenedSymbols ?? []);
  const reportingToday = earns.filter((e) => e.date === today);
  const reportingTomorrow = earns.filter((e) => e.date === tomorrow);
  const earnSoon = [...reportingToday, ...reportingTomorrow].slice(0, 4);
  // Next-3-days grouping for the upcoming panel.
  const upcomingDates = [today, tomorrow, addDayStr(tomorrow)];
  const earningsByDate = upcomingDates
    .map((d) => ({ date: d, items: earns.filter((e) => e.date === d) }))
    .filter((g) => g.items.length > 0);

  // ---------- Derived: Attention panel ----------
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

  // ---------- Derived: Long-term movers today ----------
  const movers = wl
    .filter((r) => r.changePct !== null && Math.abs(r.changePct) > 3)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));

  return (
    <div className="space-y-6">
      {/* ---------- Header ---------- */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Morning Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {prettyToday()} ·{" "}
          {vix.status === "loading" ? (
            <span className="text-muted-foreground/60">VIX …</span>
          ) : (
            <span>
              VIX{" "}
              <span className="font-mono font-semibold text-foreground">
                {vix.data !== null && vix.data !== undefined
                  ? vix.data.toFixed(2)
                  : "—"}
              </span>
            </span>
          )}
        </p>
      </div>

      {/* ---------- ROW 1: summary cards ---------- */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Card 1 — CSP Status */}
        <LinkCard
          href="/positions"
          title="CSP Status"
          icon={<TrendingUp className="h-4 w-4" />}
        >
          {positions.status === "loading" ? (
            <SkeletonLines n={5} />
          ) : positions.status === "error" ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="space-y-1.5">
              <Stat label="Open positions" value={pos.length} />
              <Stat label="Total contracts" value={totalContracts} />
              <Stat
                label="Unrealized P&L"
                value={fmtMoney(unrealized)}
                valueClass={pnlColor(unrealized)}
              />
              <Stat label="Expiring today + tmrw" value={expiringSoon} />
              <Stat
                label="Need attention"
                value={needsAttn}
                valueClass={needsAttn > 0 ? "text-amber-300" : undefined}
              />
            </div>
          )}
        </LinkCard>

        {/* Card 2 — Long-Term Alerts */}
        <LinkCard
          href="/longterm/watchlist"
          title="Long-Term Alerts"
          icon={<AlertTriangle className="h-4 w-4" />}
        >
          {watch.status === "loading" ? (
            <SkeletonLines n={5} />
          ) : watch.status === "error" ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="space-y-1.5">
              <Stat label="Watchlist names" value={wl.length} />
              <Stat
                label="Active alerts today"
                value={alertSymbols.length}
                valueClass={alertSymbols.length > 0 ? "text-amber-300" : undefined}
              />
              {topAlerts.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {topAlerts.map((sym) => {
                    const ch = changeBySymbol.get(sym) ?? null;
                    return (
                      <div
                        key={sym}
                        className="flex items-baseline justify-between text-xs"
                      >
                        <span className="font-mono font-semibold">{sym}</span>
                        <span className={cn("font-mono", pnlColor(ch))}>
                          {fmtPct(ch)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="pt-1 text-xs text-muted-foreground">
                  No alerts firing.
                </p>
              )}
            </div>
          )}
        </LinkCard>

        {/* Card 3 — Earnings Today/Tomorrow */}
        <LinkCard
          href="/"
          title="Earnings Today / Tmrw"
          icon={<CalendarDays className="h-4 w-4" />}
        >
          {earnings.status === "loading" ? (
            <SkeletonLines n={5} />
          ) : earnings.status === "error" ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="space-y-1.5">
              <Stat label="Reporting today" value={reportingToday.length} />
              <Stat label="Reporting tomorrow" value={reportingTomorrow.length} />
              <Stat label="Screened today" value={screened.size} />
              {earnSoon.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {earnSoon.map((e) => (
                    <span
                      key={`${e.symbol}-${e.date}`}
                      className="rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px] font-mono"
                    >
                      {e.symbol}
                      <span className="ml-1 text-muted-foreground">
                        {e.timing}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="pt-1 text-xs text-muted-foreground">
                  Nothing in the next two days.
                </p>
              )}
            </div>
          )}
        </LinkCard>
      </div>

      {/* ---------- ROW 2: attention panel ---------- */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Positions Needing Attention
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {positions.status === "loading" ? (
            <SkeletonLines n={3} />
          ) : positions.status === "error" ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              All positions healthy ✓
            </div>
          ) : (
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
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                            urgencyClasses(p.urgency),
                          )}
                        >
                          {p.badgeLabel || p.urgency.replace("_", " ")}
                        </span>
                      </td>
                      <td className="py-1.5">
                        <Link
                          href="/positions"
                          className="text-xs font-semibold text-rose-300 hover:text-rose-200"
                        >
                          CLOSE →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- ROW 3: two panels ---------- */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Left — Long-Term Movers Today */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Long-Term Movers Today
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {watch.status === "loading" ? (
              <SkeletonLines n={4} />
            ) : watch.status === "error" ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : movers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No significant moves today.
              </p>
            ) : (
              <div className="space-y-1.5">
                {movers.map((r) => (
                  <div
                    key={r.symbol}
                    className="flex items-center justify-between gap-2 border-t border-border/60 py-1.5 first:border-t-0 text-sm"
                  >
                    <span className="w-16 font-mono font-semibold">
                      {r.symbol}
                    </span>
                    <span
                      className={cn(
                        "w-20 font-mono",
                        pnlColor(r.changePct),
                      )}
                    >
                      {fmtPct(r.changePct)}
                    </span>
                    <span className="flex-1 truncate text-xs text-muted-foreground">
                      {r.flags[0]?.label ?? "—"}
                    </span>
                    <Link
                      href={`/longterm/research?symbol=${encodeURIComponent(r.symbol)}`}
                      className="shrink-0 rounded border border-border px-2 py-1 text-[11px] font-semibold hover:border-foreground/40 hover:text-foreground"
                    >
                      Run Analysis
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right — Upcoming Earnings */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Upcoming Earnings
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {earnings.status === "loading" ? (
              <SkeletonLines n={4} />
            ) : earnings.status === "error" ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : earningsByDate.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No earnings in the next 3 days.
              </p>
            ) : (
              <div className="space-y-3">
                {earningsByDate.map((g) => {
                  const shown = g.items.slice(0, 12);
                  const extra = g.items.length - shown.length;
                  return (
                    <div key={g.date}>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {shortDate(g.date)}
                        {g.date === today && " · Today"}
                      </div>
                      <div className="space-y-1">
                        {shown.map((e) => (
                          <div
                            key={`${e.symbol}-${e.date}`}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <span className="w-16 font-mono font-semibold">
                              {e.symbol}
                            </span>
                            <span className="w-12 text-xs text-muted-foreground">
                              {e.timing}
                            </span>
                            <span className="flex-1 text-xs">
                              {screened.has(e.symbol.toUpperCase()) ? (
                                <span className="text-emerald-400">
                                  ✓ screened
                                </span>
                              ) : (
                                <span className="text-muted-foreground/60">
                                  not screened
                                </span>
                              )}
                            </span>
                            <Link
                              href="/"
                              className="shrink-0 rounded border border-border px-2 py-1 text-[11px] font-semibold hover:border-foreground/40 hover:text-foreground"
                            >
                              Screen Now
                            </Link>
                          </div>
                        ))}
                        {extra > 0 && (
                          <p className="text-[11px] text-muted-foreground/60">
                            +{extra} more reporting
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- ROW 4: AI morning brief ---------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-4 w-4" />
            AI Morning Brief
          </CardTitle>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void generateBrief()}
            disabled={briefLoading}
          >
            {briefLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {brief ? "Regenerate" : "Generate Morning Brief"}
          </Button>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {briefError && (
            <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {briefError}
            </div>
          )}
          {brief ? (
            <div>
              <p className="text-sm leading-relaxed text-foreground/90">
                {brief}
              </p>
              {briefAt && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Generated{" "}
                  {new Date(briefAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}{" "}
                  · cached 4h
                </p>
              )}
            </div>
          ) : briefLoading ? (
            <SkeletonLines n={3} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Generate a quick overnight + pre-market summary for tech / growth
              and options traders.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
