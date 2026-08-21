"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlarmClock,
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  LineChart,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EntrySignalBadge } from "@/components/swing-ideas-board";
import {
  BuyZoneDetailContent,
  useBuyZoneResearch,
  type BuyZoneRow,
} from "@/components/buy-zone-view";
import type { EarningsWatchRow } from "@/components/earnings-watch-view";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SchwabStatusBanner, SchwabAcctStatusBanner } from "@/components/schwab-status-banner";
import { CaptureHealthPanel, CrushCaptureHealthPanel, PriceIntegrityFlagsPanel, EarningsHistoryRejectionsPanel } from "@/components/capture-health-panel";

// Markdown body for the AI morning brief — mirrors the styling used for
// filing analyses (components/filing-analysis.tsx) without a typography plugin.
function BriefMarkdownBody({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "text-foreground/90",
        "[&_h1]:mt-3 [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-foreground",
        "[&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-foreground",
        "[&_h3]:mt-2 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-foreground",
        "[&_p]:my-1.5",
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5",
        "[&_strong]:font-semibold [&_strong]:text-foreground",
        "[&_a]:text-sky-300 [&_a]:underline",
        "[&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px]",
        "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
        "[&_hr]:my-3 [&_hr]:border-border",
      )}
      style={{ fontSize: "13px", lineHeight: 1.6 }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

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

type SwingIdeaLite = {
  id: string;
  symbol: string;
  status: string;
  catalyst: string | null;
  user_thesis: string | null;
  thesis: string | null;
  ai_summary: string | null;
  snapshot: { price: number | null; change_pct: number | null } | null;
  entry_signal: { signal: string; reason: string; score: number } | null;
  swing_score: number | null;
};
type SwingsResp = { ideas: SwingIdeaLite[] };

// BuyZoneRow imported from components/buy-zone-view — the dashboard
// modal reuses that page's exact detail component, which needs the
// full row shape (analyst fields, watchlist tags, etc), not a
// narrower dashboard-local subset.
type BuyZoneResp = { rows: BuyZoneRow[] };

// EarningsWatchRow imported from components/earnings-watch-view — this
// card reuses that page's own /api/analysis/earnings-watch endpoint
// rather than a parallel query, then filters client-side to Portfolio-
// watchlist holdings only (see the comment where earningsWeekHeld is
// derived below).
type EarningsWatchResp = { rows: EarningsWatchRow[] };

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
function isWeekendIso(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}
// The next trading session after `fromIso` — Monday after a Friday,
// not literally "tomorrow". Market holidays aren't accounted for
// (same scope as this codebase's other isWeekend-only helpers, e.g.
// schwab-status-banner.tsx) — only the weekend case matters for the
// earnings panel's "before the next open" deadline.
function nextTradingSessionIso(fromIso: string): string {
  let cursor = addDayStr(fromIso);
  while (isWeekendIso(cursor)) cursor = addDayStr(cursor);
  return cursor;
}
function weekdayNameFromIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}
// "Tomorrow" when the next session really is the next calendar day;
// otherwise the weekday name (e.g. a Friday's next session is Monday).
function nextSessionLabel(todayIso: string, sessionIso: string): string {
  return sessionIso === addDayStr(todayIso) ? "Tomorrow" : weekdayNameFromIso(sessionIso);
}
// True at or after 4:00pm ET — mirrors lib/expire-positions.ts's
// isAfterMarketCloseET (not imported: that module pulls the
// server-only supabase client into this client bundle, same reason
// this file's other date helpers are local mirrors rather than
// imports).
function isAfterMarketCloseET(d: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  })
    .format(d)
    .split(":")
    .map((s) => Number(s.trim()));
  const hour = parts[0];
  const minute = parts[1] ?? 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  if (hour > 16) return true;
  if (hour === 16 && minute >= 0) return true;
  return false;
}
// The session a name must report AGAINST to still be actionable right
// now: today, unless today's close has already passed (or today isn't
// a trading day at all), in which case the window has already rolled
// to the next trading session. Everything downstream anchors on this
// instead of literal "today" — that's what makes a BMO name die at
// the PREVIOUS session's close rather than lingering, muted, until it
// actually reports (see the panel's header comment for the concrete
// SHOP example this fixes).
function currentActionableSession(): string {
  const today = easternToday();
  if (isWeekendIso(today) || isAfterMarketCloseET()) {
    return nextTradingSessionIso(today);
  }
  return today;
}
// The AMC-side twin of nextSessionLabel: "Tonight" when the session
// in question IS today, otherwise the same relative-day naming
// (Tomorrow / weekday name) nextSessionLabel already uses.
function amcSessionLabel(todayIso: string, sessionIso: string): string {
  return sessionIso === todayIso ? "Tonight" : nextSessionLabel(todayIso, sessionIso);
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

// Single label:value pair with no box/padding — for the condensed
// CSP Status / Market Context strip, which needs several stats per
// row instead of one MetricBox each.
function CompactStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono font-semibold", valueClass)}>{value}</span>
    </div>
  );
}

// Per-section open/closed state, persisted across reloads — same
// localStorage pattern used elsewhere for sticky UI preferences:
// read once at mount via a lazy useState
// initializer, write through on every toggle. Keyed per section so
// each one remembers its own state independently. A first visit (no
// stored value yet) falls back to `defaultOpen`.
//
// Only used by sections that are genuinely optional — Positions
// Needing Attention and the earnings panel are NOT wrapped in this
// component at all, specifically so they can never be hidden by a
// stale collapse state from a previous visit.
const LS_SECTION_PREFIX = "dashboard_section_open_";
function getSectionOpen(key: string, defaultOpen: boolean): boolean {
  if (typeof window === "undefined") return defaultOpen;
  try {
    const raw = localStorage.getItem(LS_SECTION_PREFIX + key);
    if (raw === null) return defaultOpen;
    return raw === "1";
  } catch {
    return defaultOpen;
  }
}
function setSectionOpen(key: string, open: boolean) {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_SECTION_PREFIX + key, open ? "1" : "0");
    }
  } catch {
    /* quota / privacy */
  }
}

// The toggle target is only the icon+title+chevron; `right` (a "View
// all →" link on some sections) stays independently clickable and
// never toggles collapse.
function CollapsibleSection({
  storageKey,
  icon,
  title,
  defaultOpen,
  collapsedSummary,
  right,
  children,
}: {
  storageKey: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  defaultOpen: boolean;
  collapsedSummary?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpenState] = useState(() => getSectionOpen(storageKey, defaultOpen));
  function setOpen(next: boolean) {
    setOpenState(next);
    setSectionOpen(storageKey, next);
  }
  return (
    <Panel>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
            {icon}
            {title}
          </span>
          {!open && collapsedSummary && (
            <span className="text-[11px] normal-case tracking-normal text-muted-foreground/80">
              {collapsedSummary}
            </span>
          )}
        </button>
        {right}
      </div>
      {open && <div className="mt-3">{children}</div>}
    </Panel>
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
  const [swings, setSwings] = useState<Slot<SwingsResp>>(LOADING);
  const [buyZone, setBuyZone] = useState<Slot<BuyZoneResp>>(LOADING);
  const [buyZoneModalRow, setBuyZoneModalRow] = useState<BuyZoneRow | null>(null);
  const buyZoneResearch = useBuyZoneResearch();
  const [earningsWeek, setEarningsWeek] = useState<Slot<EarningsWatchResp>>(LOADING);
  // null = no manual choice yet, use the computed default below (which
  // depends on earningsUrgent.length — not knowable at mount before
  // earningsWeek has loaded, so this can't be a lazy useState initializer).
  const [manualShowAllEarnings, setManualShowAllEarnings] = useState<boolean | null>(null);
  const router = useRouter();

  const [brief, setBrief] = useState<string | null>(null);
  const [briefAt, setBriefAt] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  // Data is fresh at mount; the global Refresh button updates this.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(
    () => new Date(),
  );
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Global refresh: force-refresh every cached snapshot, then re-pull the
  // snapshot-backed panels + positions. Does NOT touch the AI brief (own
  // Regenerate button, 4h cache) or Perplexity catalysts (24h cache).
  // Silent — keeps showing current data until the new data swaps in, so
  // panels don't flash skeletons; the spinning button is the indicator.
  const doGlobalRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      // Positions don't depend on the snapshot — fetch alongside the force-refresh.
      const positionsP = fetch("/api/positions/open", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setPositions({ status: "ok", data: j as PositionsResp }))
        .catch(() => {});
      // Force-refresh all cached snapshots first so the panels below read fresh data.
      await fetch("/api/market/snapshot/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
        cache: "no-store",
      }).catch(() => {});
      await Promise.all([
        fetch("/api/longterm/watchlist", { cache: "no-store" })
          .then((r) => r.json())
          .then((j) => setWatch({ status: "ok", data: j as WatchResp }))
          .catch(() => {}),
        fetch("/api/dashboard/market-context", { cache: "no-store" })
          .then((r) => r.json())
          .then((j) => setMarket({ status: "ok", data: j as MarketResp }))
          .catch(() => {}),
        fetch("/api/swings/ideas", { cache: "no-store" })
          .then((r) => r.json())
          .then((j) => setSwings({ status: "ok", data: j as SwingsResp }))
          .catch(() => {}),
        fetch("/api/analysis/buy-zone", { cache: "no-store" })
          .then((r) => r.json())
          .then((j) => setBuyZone({ status: "ok", data: j as BuyZoneResp }))
          .catch(() => {}),
        fetch("/api/analysis/earnings-watch", { cache: "no-store" })
          .then((r) => r.json())
          .then((j) => setEarningsWeek({ status: "ok", data: j as EarningsWatchResp }))
          .catch(() => {}),
        fetch("/api/context/daily", { cache: "no-store" })
          .then((r) => r.json())
          .then((j) =>
            setVix({
              status: "ok",
              data:
                (j as { market?: { vix?: number | null } }).market?.vix ?? null,
            }),
          )
          .catch(() => {}),
        positionsP,
      ]);
      setLastRefreshedAt(new Date());
    } finally {
      setIsRefreshing(false);
    }
  }, []);

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
    void load<SwingsResp>(
      "/api/swings/ideas",
      setSwings,
      (j) => j as SwingsResp,
    );
    void load<BuyZoneResp>(
      "/api/analysis/buy-zone",
      setBuyZone,
      (j) => j as BuyZoneResp,
    );
    void load<EarningsWatchResp>(
      "/api/analysis/earnings-watch",
      setEarningsWeek,
      (j) => j as EarningsWatchResp,
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
  // Named inline on the CSP Status stat strip so the count answers
  // "which ones" without making the user look at the panel below —
  // deliberately the same set (see the Panel below), just above ~4
  // names a comma list would break the compact strip, so it falls
  // back to the bare count there.
  const attentionSymbols = Array.from(new Set(attention.map((p) => p.symbol)));

  // ---------- Top movers ----------
  const withChange = wl.filter((r) => r.changePct !== null);
  const byDesc = [...withChange].sort(
    (a, b) => (b.changePct ?? 0) - (a.changePct ?? 0),
  );
  // Always show at least 5: take everyone past the threshold, but never
  // fewer than the top/bottom 5 — so a quiet day still fills the panel
  // with the next-best performers.
  const gainersOver = byDesc.filter((r) => (r.changePct ?? 0) > 5).length;
  const gainers = byDesc.slice(0, Math.max(5, gainersOver));
  const byAsc = [...withChange].sort(
    (a, b) => (a.changePct ?? 0) - (b.changePct ?? 0),
  );
  const losersUnder = byAsc.filter((r) => (r.changePct ?? 0) < -5).length;
  const losers = byAsc.slice(0, Math.max(5, losersUnder));

  function moverBadge(r: WatchRow) {
    const f = r.flags[0];
    if (f) return <Badge kind={f.kind} label={f.label} />;
    return <Badge kind={r.action} label={r.action.replace(/_/g, " ")} />;
  }

  function MoverRow({ r }: { r: WatchRow }) {
    return (
      <div className="flex items-center gap-2 py-1 text-base">
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

  // ---------- Swing watch ----------
  const swingIdeas = swings.data?.ideas ?? [];
  const swingCandidates = swingIdeas.filter(
    (i) => i.status === "setup_ready" || i.status === "entered",
  );
  const byScore = (a: SwingIdeaLite, b: SwingIdeaLite) =>
    (b.swing_score ?? -1) - (a.swing_score ?? -1);
  // Top 10 by score, but always include every Entered idea.
  const swingShownMap = new Map<string, SwingIdeaLite>();
  for (const i of [...swingCandidates].sort(byScore).slice(0, 10)) {
    swingShownMap.set(i.id, i);
  }
  for (const i of swingCandidates) {
    if (i.status === "entered") swingShownMap.set(i.id, i);
  }
  const swingShown = Array.from(swingShownMap.values()).sort(byScore);

  function swingThesis(i: SwingIdeaLite): string {
    const t = (i.catalyst || i.user_thesis || i.thesis || i.ai_summary || "").trim();
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }

  // ---------- Buy Zone top 5 ----------
  const buyZoneTop5 = [...(buyZone.data?.rows ?? [])]
    .sort((a, b) => b.buyZoneComposite - a.buyZoneComposite)
    .slice(0, 5);

  // ---------- Earnings this week (held names only) ----------
  // "Held" here means Portfolio watchlist membership specifically — the
  // same signal Earnings Watch itself uses for that concept — not the
  // page's broader `held` (which also flips true from an options
  // position alone). A name on Prospects or another non-Portfolio list
  // is a candidate, not something this card is about.
  //
  // The endpoint sorts by day only — within a day it doesn't separate
  // BMO from AMC, so a BMO name (already reported before today's open)
  // and an AMC name (still reporting tonight) looked identical. Sort
  // by (date, session-within-day) instead: BMO is earliest in its day,
  // AMC latest, unknown/DMH timing in between.
  function sessionRank(timing: EarningsWatchRow["earningsTiming"]): number {
    if (timing === "BMO") return 0;
    if (timing === "AMC") return 2;
    return 1;
  }
  const earningsWeekHeld = (earningsWeek.data?.rows ?? [])
    .filter((r) => r.portfolioStockHolding !== null)
    .sort((a, b) => {
      const dateCmp = (a.earningsDate ?? "9999-99-99").localeCompare(b.earningsDate ?? "9999-99-99");
      if (dateCmp !== 0) return dateCmp;
      return sessionRank(a.earningsTiming) - sessionRank(b.earningsTiming);
    });
  // The expanded section groups by DEADLINE ("reports before the next
  // market open"), not by calendar date — and drops a name the moment
  // its last chance to act has passed, not when it prints. AMC on the
  // current actionable session is live until that session's close;
  // BMO on the NEXT session is also live until that same close (you
  // act today, ahead of tomorrow's open) — both die together the
  // instant that close passes. Concretely: SHOP reporting BMO
  // Wednesday morning was only ever actionable Tuesday, so it's dead
  // (off the panel entirely) from Tuesday's close onward — Wednesday
  // morning is too late, not the moment it becomes stale. There is no
  // "reported, muted" state anymore — a BMO name's own report date is
  // never inside its actionable window, so it can only ever be either
  // upcoming (next-session BMO) or already dead.
  const todayIsoStr = easternToday();
  const actionSessionIsoStr = currentActionableSession();
  const nextSessionIsoStr = nextTradingSessionIso(actionSessionIsoStr);
  const isUrgentEarningsRow = (r: EarningsWatchRow) =>
    (r.earningsDate === actionSessionIsoStr && r.earningsTiming === "AMC") ||
    (r.earningsDate === nextSessionIsoStr && r.earningsTiming === "BMO");
  // AMC dies once its own date is behind the current session; BMO
  // dies once its date is on or behind the current session (its
  // actionable window was the session BEFORE its date). Timings
  // outside AMC/BMO (DMH/unknown) aren't covered by this deadline
  // rule — unchanged, they just fall through to "later this week".
  const isDeadEarningsRow = (r: EarningsWatchRow) => {
    if (!r.earningsDate) return false;
    if (r.earningsTiming === "AMC") return r.earningsDate < actionSessionIsoStr;
    if (r.earningsTiming === "BMO") return r.earningsDate <= actionSessionIsoStr;
    return false;
  };
  const earningsUrgent = earningsWeekHeld.filter(isUrgentEarningsRow);
  const earningsLater = earningsWeekHeld.filter(
    (r) => !isUrgentEarningsRow(r) && !isDeadEarningsRow(r),
  );
  // Default: collapsed if the urgent set already has rows to show
  // (later names sit behind the toggle); expanded automatically if
  // there's nothing urgent, so the panel never looks empty with
  // everything hidden.
  const showAllEarnings = manualShowAllEarnings ?? earningsUrgent.length === 0;
  const earningsRowsToShow = showAllEarnings ? [...earningsUrgent, ...earningsLater] : earningsUrgent;

  // ---------- Market tiles ----------
  const m = market.data;
  // Yahoo returns ^TNX already as the yield percentage (e.g. 4.54), not
  // basis points — display the raw value.
  const tnxYield =
    m?.tnx.price !== null && m?.tnx.price !== undefined ? m.tnx.price : null;

  return (
    <div className="space-y-4">
      <SchwabStatusBanner />
      <SchwabAcctStatusBanner />
      <CaptureHealthPanel />
      <CrushCaptureHealthPanel />
      <PriceIntegrityFlagsPanel />
      <EarningsHistoryRejectionsPanel />
      {/* ---------- Header ---------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Morning Dashboard</h1>
          <div className="mt-1 flex items-center gap-2 text-base text-muted-foreground">
            <span>{prettyToday()}</span>
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-sm text-foreground">
              VIX{" "}
              {vix.status === "loading"
                ? "…"
                : vix.data !== null && vix.data !== undefined
                  ? vix.data.toFixed(2)
                  : "—"}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void doGlobalRefresh()}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-base font-medium transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </button>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-4 py-2 text-base font-semibold text-white transition-colors hover:bg-indigo-400"
            >
              Screen Today <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          {lastRefreshedAt && (
            <span className="text-[11px] text-muted-foreground">
              Last refreshed{" "}
              {lastRefreshedAt.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>

      {/* ---------- Condensed glance stats: CSP / Market / Long-term ----------
          Always visible (not collapsible — this is quick-glance data),
          but dense: one compact row per card instead of large padded
          MetricBoxes, so this whole strip stays short and doesn't push
          the attention panel / today's earnings below the fold. */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Card 1 — CSP Status (clickable) */}
        <Link href="/positions" className="group block">
          <Panel className="h-full py-3 transition-colors group-hover:border-foreground/30">
            <SectionHeader icon={<LineChart className="h-4 w-4" />}>
              CSP Status
            </SectionHeader>
            {positions.status === "loading" ? (
              <SkeletonLines n={2} />
            ) : positions.status === "error" ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <div className="space-y-1">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <CompactStat label="Positions" value={pos.length} />
                  <CompactStat
                    label="Unrealized"
                    value={fmtMoney(unrealized)}
                    valueClass={pnlColor(unrealized)}
                  />
                  <CompactStat label="Expiring ≤2d" value={expiringSoon} />
                </div>
                {attention.length > 0 ? (
                  <div className="text-sm font-medium text-rose-400">
                    {attention.length} need{attention.length === 1 ? "s" : ""} attention
                    {attentionSymbols.length <= 4 && `: ${attentionSymbols.join(", ")}`}
                  </div>
                ) : (
                  <div className="text-sm font-medium text-emerald-400">All healthy ✓</div>
                )}
              </div>
            )}
          </Panel>
        </Link>

        {/* Card 2 — Market Context (no link) */}
        <Panel className="h-full py-3">
          <SectionHeader icon={<LineChart className="h-4 w-4" />}>
            Market context
          </SectionHeader>
          {market.status === "loading" ? (
            <SkeletonLines n={2} />
          ) : market.status === "error" || !m ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <CompactStat
                label="SPY"
                value={fmtPct(m.spy.changePct)}
                valueClass={pnlColor(m.spy.changePct)}
              />
              <CompactStat
                label="QQQ"
                value={fmtPct(m.qqq.changePct)}
                valueClass={pnlColor(m.qqq.changePct)}
              />
              <CompactStat
                label="XLK"
                value={fmtPct(m.xlk.changePct)}
                valueClass={pnlColor(m.xlk.changePct)}
              />
              <CompactStat
                label="IWF"
                value={fmtPct(m.iwf.changePct)}
                valueClass={pnlColor(m.iwf.changePct)}
              />
              <CompactStat
                label="10Y"
                value={tnxYield !== null ? `${tnxYield.toFixed(2)}%` : "—"}
                valueClass={pnlColor(m.tnx.changePct)}
              />
            </div>
          )}
        </Panel>

        {/* Card 3 — Long-term alerts (clickable) */}
        <Link href="/longterm/watchlist" className="group block">
          <Panel className="h-full py-3 transition-colors group-hover:border-foreground/30">
            <SectionHeader icon={<AlertTriangle className="h-4 w-4" />}>
              Long-term alerts
            </SectionHeader>
            {watch.status === "loading" ? (
              <SkeletonLines n={2} />
            ) : watch.status === "error" ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : alertRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active alerts.</p>
            ) : (
              <>
                <div className="space-y-1">
                  {alertRows.slice(0, 3).map(({ row, flag }) => (
                    <div key={row.symbol} className="flex items-center gap-2 text-sm">
                      <span className="w-[42px] shrink-0 font-mono font-semibold">
                        {row.symbol}
                      </span>
                      <Badge kind={row.action} label={row.action.replace(/_/g, " ")} />
                      <span className="flex-1 truncate text-xs text-muted-foreground">
                        {flag!.label}
                      </span>
                      <span className="w-14 text-right text-xs">
                        <ChangeCell pct={row.changePct} />
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground">
                  {alertRows.length} active alert
                  {alertRows.length === 1 ? "" : "s"}
                  <ArrowRight className="h-3 w-3" /> view all
                </div>
              </>
            )}
          </Panel>
        </Link>
      </div>

      {/* ---------- Positions needing attention (always visible) ---------- */}
      <Panel
        className={cn(
          attention.length > 0 && "border-rose-500/40",
        )}
      >
        {positions.status === "loading" ? (
          <SkeletonLines n={3} />
        ) : positions.status === "error" ? (
          <p className="text-base text-muted-foreground">—</p>
        ) : attention.length === 0 ? (
          <div className="flex items-center gap-2 text-base font-medium text-emerald-400">
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
              <table className="w-full text-base">
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
                          className="text-sm font-semibold text-rose-300 hover:text-rose-200"
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

      {/* ---------- Earnings this week (always visible, non-collapsible) ----------
          One panel, not two. Rows still actionable right now — AMC on
          the current actionable session and BMO on the session after
          it, both live until that session's close — always render
          inline; anything whose window has already closed is dropped
          from the panel entirely, not just muted (see
          isDeadEarningsRow above). The rest of the week sits behind an
          in-panel "show more" toggle — never a second section, and
          never hidden entirely when nothing is urgent (see
          earningsRowsToShow). */}
      <Panel className={cn(earningsUrgent.length > 0 && "border-amber-500/40")}>
        <SectionHeader
          icon={<AlarmClock className="h-4 w-4 text-amber-400" />}
          right={
            <Link
              href="/analysis/earnings-watch"
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              View all →
            </Link>
          }
        >
          <span className={earningsUrgent.length > 0 ? "text-amber-300" : undefined}>
            Earnings this week — held names
          </span>
        </SectionHeader>
        {earningsWeek.status === "loading" ? (
          <SkeletonLines n={2} />
        ) : earningsWeek.status === "error" ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : earningsUrgent.length === 0 && earningsLater.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Portfolio watchlist names report earnings this week.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Symbol</th>
                    <th className="py-1.5 pr-3 font-medium">{earningsUrgent.length > 0 ? "Status" : "Reports"}</th>
                    <th className="py-1.5 pr-3 font-medium">Allocation</th>
                    <th className="py-1.5 pr-3 font-medium">Options</th>
                    <th className="py-1.5 text-right font-medium">Call</th>
                  </tr>
                </thead>
                <tbody>
                  {earningsRowsToShow.map((r) => {
                    // AMC on the action session and BMO on the next
                    // session are the only two ways into earningsUrgent
                    // now (see isUrgentEarningsRow above) — both are
                    // equally "act now", not one live/one reported. The
                    // muted "already reported" state is gone: a BMO
                    // name's own report date is never inside its
                    // actionable window, so it either shows here as
                    // upcoming or it's already been dropped entirely.
                    const isAmcOnSession =
                      r.earningsDate === actionSessionIsoStr && r.earningsTiming === "AMC";
                    const isNextSessionBmo =
                      r.earningsDate === nextSessionIsoStr && r.earningsTiming === "BMO";
                    const isUrgent = isAmcOnSession || isNextSessionBmo;
                    return (
                      <tr
                        key={r.symbol}
                        onClick={() => router.push(`/analysis/earnings-watch?symbol=${r.symbol}`)}
                        className={cn(
                          "cursor-pointer border-t border-border/60 hover:bg-background/60",
                          isUrgent && "bg-amber-500/[0.06]",
                        )}
                      >
                        <td className="py-1.5 pr-3 font-mono font-semibold">{r.symbol}</td>
                        <td className="py-1.5 pr-3">
                          {isUrgent ? (
                            <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
                              {isAmcOnSession
                                ? `${amcSessionLabel(todayIsoStr, actionSessionIsoStr)} · AMC`
                                : `${nextSessionLabel(todayIsoStr, nextSessionIsoStr)} · BMO`}
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">
                              {r.earningsDate ?? "—"}
                              {r.earningsTiming && r.earningsTiming !== "unknown" ? ` (${r.earningsTiming})` : ""}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-[11px] capitalize text-muted-foreground">
                          {r.portfolioStockHolding?.allocation ?? "—"}
                        </td>
                        <td className="py-1.5 pr-3">
                          {r.heldPositions.some((p) => p.positionType === "option") ? (
                            <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                              Open CSP
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">stock only</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right">
                          {r.badge ? <Badge kind={r.badge.verdict} label={r.badge.verdict} /> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {earningsUrgent.length > 0 && earningsLater.length > 0 && (
              <button
                type="button"
                onClick={() => setManualShowAllEarnings(!showAllEarnings)}
                className="mt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                {showAllEarnings ? "Show fewer ▲" : `${earningsLater.length} more this week ▼`}
              </button>
            )}
          </>
        )}
      </Panel>

      {/* ---------- Swing watch ---------- */}
      <CollapsibleSection
        storageKey="swing-watch"
        icon={<Activity className="h-4 w-4" />}
        title="Swing watch"
        defaultOpen={false}
        collapsedSummary={swingCandidates.length > 0 ? `— ${swingCandidates.length} candidates` : undefined}
        right={
          <Link
            href="/swings/ideas"
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            View all →
          </Link>
        }
      >
        {swings.status === "loading" ? (
          <SkeletonLines n={3} />
        ) : swings.status === "error" ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : swingShown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No swing ideas yet — add ideas in Swings → Ideas
          </p>
        ) : (
          <div className="space-y-1">
            {swingShown.map((i) => {
              const chg = i.snapshot?.change_pct ?? null;
              const stageBlue = i.status === "entered";
              return (
                <div
                  key={i.id}
                  className="flex items-center gap-2 border-t border-border/60 py-1.5 text-sm first:border-t-0"
                >
                  <span className="w-14 shrink-0 font-mono font-semibold">
                    {i.symbol}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium",
                      stageBlue
                        ? "border-sky-500/40 bg-sky-500/15 text-sky-300"
                        : "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {stageBlue ? "Entered" : "Setup Ready"}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs">
                    {i.snapshot?.price !== null && i.snapshot?.price !== undefined
                      ? `$${i.snapshot.price.toFixed(2)}`
                      : "—"}
                  </span>
                  <span
                    className={cn(
                      "w-16 shrink-0 text-right font-mono text-xs",
                      pnlColor(chg),
                    )}
                  >
                    {fmtPct(chg)}
                  </span>
                  <span className="shrink-0">
                    {i.entry_signal && (
                      <EntrySignalBadge
                        signal={i.entry_signal.signal}
                        title={i.entry_signal.reason}
                      />
                    )}
                  </span>
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {swingThesis(i)}
                  </span>
                  <Link
                    href="/swings/ideas"
                    className="shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground"
                  >
                    View →
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>

      {/* ---------- Buy Zone top 5 ---------- */}
      <CollapsibleSection
        storageKey="buy-zone"
        icon={<Crosshair className="h-4 w-4" />}
        title="Buy Zone — top 5"
        defaultOpen={true}
        collapsedSummary={buyZoneTop5.length > 0 ? `— ${buyZoneTop5.length} names` : undefined}
        right={
          <Link
            href="/analysis/buy-zone"
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            View all →
          </Link>
        }
      >
        {buyZone.status === "loading" ? (
          <SkeletonLines n={3} />
        ) : buyZone.status === "error" ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : buyZoneTop5.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No watchlist symbols yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Symbol</th>
                  <th className="py-1.5 pr-3 text-right font-medium">RSI</th>
                  <th className="py-1.5 pr-3 font-medium">MACD</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Change%</th>
                  <th className="py-1.5 text-right font-medium">Buy Zone</th>
                </tr>
              </thead>
              <tbody>
                {buyZoneTop5.map((r) => (
                  <tr
                    key={r.symbol}
                    onClick={() => setBuyZoneModalRow(r)}
                    className="cursor-pointer border-t border-border/60 hover:bg-background/60"
                  >
                    <td className="py-1.5 pr-3 font-mono font-semibold">{r.symbol}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {r.rsi14 !== null && Number.isFinite(r.rsi14) ? r.rsi14.toFixed(0) : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-[11px] capitalize text-muted-foreground">
                      {r.buyZoneMacdStatus}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <ChangeCell pct={r.changePct} />
                    </td>
                    <td className="py-1.5 text-right font-mono font-semibold">
                      {r.buyZoneComposite.toFixed(1)}/10
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleSection>

      <Dialog open={buyZoneModalRow !== null} onOpenChange={(o) => !o && setBuyZoneModalRow(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          {buyZoneModalRow && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono">
                  {buyZoneModalRow.symbol}
                  {buyZoneModalRow.companyName ? (
                    <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">
                      {buyZoneModalRow.companyName}
                    </span>
                  ) : null}
                </DialogTitle>
              </DialogHeader>
              <BuyZoneDetailContent
                row={buyZoneModalRow}
                research={buyZoneResearch.research[buyZoneModalRow.symbol] ?? null}
                loading={buyZoneResearch.researchLoading.has(buyZoneModalRow.symbol)}
                error={buyZoneResearch.researchError[buyZoneModalRow.symbol] ?? null}
                onResearch={() => void buyZoneResearch.loadResearch(buyZoneModalRow.symbol)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- Collapsible row: Top movers + AI brief ---------- */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Left — Top movers today */}
        <CollapsibleSection
          storageKey="top-movers"
          icon={<LineChart className="h-4 w-4" />}
          title="Top movers today"
          defaultOpen={false}
          collapsedSummary={
            withChange.length > 0 ? `— ${gainers.length} up, ${losers.length} down` : undefined
          }
        >
          {watch.status === "loading" ? (
            <SkeletonLines n={5} />
          ) : watch.status === "error" ? (
            <p className="text-base text-muted-foreground">—</p>
          ) : withChange.length === 0 ? (
            <p className="text-base text-muted-foreground">No quotes today.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                  Gainers
                </div>
                {gainers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">—</p>
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
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  losers.map((r) => <MoverRow key={r.symbol} r={r} />)
                )}
              </div>
            </div>
          )}
        </CollapsibleSection>

        {/* Right — AI Morning Brief */}
        <CollapsibleSection
          storageKey="ai-brief"
          icon={<Brain className="h-4 w-4" />}
          title="AI morning brief"
          defaultOpen={false}
          collapsedSummary={brief ? "— ready" : undefined}
          right={<span className="text-[11px] text-muted-foreground">cached 4h</span>}
        >
          {briefError && (
            <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {briefError}
            </div>
          )}
          {brief ? (
            <div>
              <BriefMarkdownBody text={brief} />
              <button
                type="button"
                onClick={() => void generateBrief()}
                disabled={briefLoading}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-semibold hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
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
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-4 py-2 text-base font-semibold text-white transition-colors hover:bg-indigo-400"
            >
              <Brain className="h-4 w-4" />
              Generate Morning Brief
            </button>
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}
