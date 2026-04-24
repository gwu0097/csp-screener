"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Signal,
  Telescope,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Category = "momentum" | "recovery" | "theme" | "social";

type MarketCapCategory = "large" | "mid" | "small" | null;

type Candidate = {
  symbol: string;
  catalyst: string;
  sentiment: string;
  timeframe: string;
  thesis: string;
  confidence: string;
  risk: string;
  signal_basis: string;
  sources: string[];
  category: Category;
  theme?: string | null;
  theme_momentum?: string | null;
  company_name: string | null;
  current_price: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  forward_pe: number | null;
  analyst_target: number | null;
  price_change_pct: number | null;
  pct_from_52w_high: number | null;
  upside_to_target: number | null;
  fifty_day_ma: number | null;
  vs_50d_ma_pct: number | null;
  market_cap: number | null;
  market_cap_category: MarketCapCategory;
};

type DeepDive = {
  recent_news: string;
  fundamental_health: string;
  catalyst_credibility: "high" | "medium" | "low";
  catalyst_timeline: string;
  retail_sentiment: "bullish" | "bearish" | "mixed";
  institutional_activity: "buying" | "selling" | "neutral";
  technical_setup: "good_entry" | "extended" | "oversold";
  entry_comment: string;
  bear_case: string[];
  verdict: "HIGH" | "MEDIUM" | "LOW";
  verdict_reasoning: string;
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtRel(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

function confidenceClasses(c: string): string {
  if (c === "high") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (c === "medium") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (c === "low") return "bg-muted/40 text-muted-foreground border-border";
  return "bg-muted/40 text-muted-foreground border-border";
}

function sentimentClasses(s: string): string {
  if (s === "bullish") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (s === "bearish") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  if (s === "mixed") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

function themeMomentumClasses(m: string | null): string {
  if (m === "strong") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (m === "moderate") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (m === "fading") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

// Social/retail cards get a purple accent so they stand apart from
// the analyst-driven sections at a glance.
function categoryAccentClasses(cat: Category): string {
  if (cat === "social")
    return "border-violet-500/40 bg-violet-500/5";
  return "border-border bg-zinc-900/60";
}

// Pill colors for the category-source badge — matches the spec
// (momentum=blue, recovery=emerald, theme=orange, social=violet so
// the inline pill agrees with the social card's accent border).
function categoryBadgeClasses(cat: Category): string {
  if (cat === "momentum")
    return "bg-blue-500/20 text-blue-400 border-blue-500/40";
  if (cat === "recovery")
    return "bg-emerald-500/20 text-emerald-400 border-emerald-500/40";
  if (cat === "theme")
    return "bg-orange-500/20 text-orange-400 border-orange-500/40";
  return "bg-violet-500/20 text-violet-300 border-violet-500/40";
}

function categoryLabel(cat: Category): string {
  if (cat === "momentum") return "MOMENTUM";
  if (cat === "recovery") return "RECOVERY";
  if (cat === "theme") return "THEME";
  return "SOCIAL";
}

function marketCapPillClasses(cat: MarketCapCategory): string {
  if (cat === "large")
    return "bg-blue-500/20 text-blue-400 border-blue-500/40";
  if (cat === "mid")
    return "bg-teal-500/20 text-teal-300 border-teal-500/40";
  if (cat === "small")
    return "bg-orange-500/20 text-orange-400 border-orange-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

function marketCapLabel(cat: MarketCapCategory): string {
  if (cat === "large") return "Large-cap";
  if (cat === "mid") return "Mid-cap";
  if (cat === "small") return "Small-cap";
  return "";
}

// "↓ 58% from high" — drop sign + magnitude. Returns colored output for
// large drops (≥ 20% off) so recovery candidates pop. Returns "Near 52w
// high" muted when the price is within 10% of the high. null in between
// (don't render anything).
function fmtFromHigh(pct: number | null): { text: string; cls: string } | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct > -10) return { text: "Near 52w high", cls: "text-muted-foreground" };
  if (pct < -20) {
    const cls = pct < -40 ? "text-rose-300" : "text-amber-300";
    return { text: `↓ ${Math.abs(pct).toFixed(0)}% from high`, cls };
  }
  // -20 ≤ pct ≤ -10 — show the number but in muted tone
  return {
    text: `↓ ${Math.abs(pct).toFixed(0)}% from high`,
    cls: "text-muted-foreground",
  };
}

function fmt50dMA(pct: number | null): { text: string; cls: string } | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const cls = pct >= 0 ? "text-emerald-300" : "text-rose-300";
  const sign = pct >= 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(0)}% vs 50d MA`, cls };
}

// Extract a clean display domain from a full URL. Returns the input
// string if the parse fails so we still render *something* clickable
// instead of crashing the page. Perplexity occasionally returns
// non-URL strings (raw page titles, "indeed.com" without a scheme,
// etc.) and `new URL()` throws on those.
function domainOf(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) return "source";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Defensive normalizer for candidates loaded from the API. Earlier
// scans persisted to swing_scan_results don't have the newer fields
// (signal_basis, sources, market_cap_category, vs_50d_ma_pct,
// company_name); rendering against undefined would throw on the
// first .length / .slice / .map call. Run every payload through here
// at the boundary so the rest of the view can rely on the type.
function normalizeCandidate(raw: unknown): Candidate {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  const cat = r.category;
  const category: Category =
    cat === "momentum" || cat === "recovery" || cat === "theme" || cat === "social"
      ? cat
      : "momentum";
  const sources = Array.isArray(r.sources)
    ? (r.sources as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const mcc = r.market_cap_category;
  const market_cap_category: MarketCapCategory =
    mcc === "large" || mcc === "mid" || mcc === "small" ? mcc : null;
  return {
    symbol: str(r.symbol).toUpperCase(),
    catalyst: str(r.catalyst),
    sentiment: str(r.sentiment),
    timeframe: str(r.timeframe),
    thesis: str(r.thesis),
    confidence: str(r.confidence),
    risk: str(r.risk),
    signal_basis: str(r.signal_basis),
    sources,
    category,
    theme: typeof r.theme === "string" ? r.theme : null,
    theme_momentum:
      typeof r.theme_momentum === "string" ? r.theme_momentum : null,
    company_name: typeof r.company_name === "string" ? r.company_name : null,
    current_price: num(r.current_price),
    week_52_low: num(r.week_52_low),
    week_52_high: num(r.week_52_high),
    forward_pe: num(r.forward_pe),
    analyst_target: num(r.analyst_target),
    price_change_pct: num(r.price_change_pct),
    pct_from_52w_high: num(r.pct_from_52w_high),
    upside_to_target: num(r.upside_to_target),
    fifty_day_ma: num(r.fifty_day_ma),
    vs_50d_ma_pct: num(r.vs_50d_ma_pct),
    market_cap: num(r.market_cap),
    market_cap_category,
  };
}

function timeframeLabel(tf: string): string {
  if (tf === "1month") return "1 month";
  if (tf === "3months") return "3 months";
  if (tf === "6months") return "6 months";
  return tf;
}

function verdictClasses(v: DeepDive["verdict"]): string {
  if (v === "HIGH")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-200";
  if (v === "MEDIUM")
    return "border-amber-500/40 bg-amber-500/15 text-amber-200";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-200";
}

function technicalLabel(t: DeepDive["technical_setup"]): string {
  if (t === "good_entry") return "Good entry point";
  if (t === "oversold") return "Oversold";
  return "Extended";
}

export function SwingDiscoverView() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideasSymbols, setIdeasSymbols] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());

  // Deep-dive state. The modal renders whichever symbol is "active" and
  // looks up the cached payload (or shows a loading state if the fetch
  // is still in flight). Cache is keyed by symbol so re-opening the same
  // candidate is instant.
  const [deepDives, setDeepDives] = useState<Record<string, DeepDive>>({});
  const [deepDiveLoading, setDeepDiveLoading] = useState<Set<string>>(new Set());
  const [deepDiveError, setDeepDiveError] = useState<Record<string, string>>({});
  const [activeDeepDive, setActiveDeepDive] = useState<Candidate | null>(null);

  async function loadLatest() {
    setLoading(true);
    try {
      const res = await fetch("/api/swings/discover", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const raw = Array.isArray(json.candidates) ? json.candidates : [];
      setCandidates(raw.map(normalizeCandidate));
      setScannedAt(json.scanned_at ?? null);
    } catch (e) {
      console.warn("[swing-discover] load failed:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadIdeasSymbols() {
    try {
      const res = await fetch("/api/swings/ideas", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) return;
      const set = new Set<string>();
      for (const i of (json.ideas ?? []) as Array<{ symbol: string }>) {
        if (typeof i.symbol === "string") set.add(i.symbol.toUpperCase());
      }
      setIdeasSymbols(set);
    } catch {
      /* non-fatal */
    }
  }

  useEffect(() => {
    loadLatest();
    loadIdeasSymbols();
  }, []);

  async function runScan() {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/swings/discover", {
        method: "POST",
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const raw = Array.isArray(json.candidates) ? json.candidates : [];
      setCandidates(raw.map(normalizeCandidate));
      setScannedAt(json.scanned_at ?? new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function addToIdeas(c: Candidate) {
    setAdding((prev) => {
      const next = new Set(prev);
      next.add(c.symbol);
      return next;
    });
    setError(null);
    try {
      const res = await fetch("/api/swings/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          catalyst: c.catalyst || null,
          user_thesis: c.thesis || null,
          timeframe: c.timeframe,
          analyst_sentiment: c.sentiment === "neutral" ? null : c.sentiment,
          analyst_target: c.analyst_target,
          forward_pe: c.forward_pe,
          price_at_discovery: c.current_price,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setIdeasSymbols((prev) => {
        const next = new Set(prev);
        next.add(c.symbol);
        return next;
      });
    } catch (e) {
      setError(`Add ${c.symbol}: ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(c.symbol);
        return next;
      });
    }
  }

  async function openDeepDive(c: Candidate) {
    // Always show the modal immediately — if we have cached data the
    // body renders instantly; otherwise the modal shows a spinner while
    // the Perplexity call resolves.
    setActiveDeepDive(c);
    if (deepDives[c.symbol]) return;
    if (deepDiveLoading.has(c.symbol)) return;

    setDeepDiveLoading((prev) => {
      const next = new Set(prev);
      next.add(c.symbol);
      return next;
    });
    setDeepDiveError((prev) => {
      const next = { ...prev };
      delete next[c.symbol];
      return next;
    });
    try {
      const res = await fetch("/api/swings/discover/deep-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          companyName: c.company_name ?? "",
          catalyst: c.catalyst,
          current_price: c.current_price,
          week_52_low: c.week_52_low,
          week_52_high: c.week_52_high,
          forward_pe: c.forward_pe,
          analyst_target: c.analyst_target,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDeepDives((prev) => ({
        ...prev,
        [c.symbol]: json.deep_dive as DeepDive,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Deep dive failed";
      setDeepDiveError((prev) => ({ ...prev, [c.symbol]: msg }));
    } finally {
      setDeepDiveLoading((prev) => {
        const next = new Set(prev);
        next.delete(c.symbol);
        return next;
      });
    }
  }

  function closeDeepDive() {
    setActiveDeepDive(null);
  }

  const buckets = useMemo(() => {
    const byCategory: Record<Category, Candidate[]> = {
      momentum: [],
      recovery: [],
      theme: [],
      social: [],
    };
    for (const c of candidates) byCategory[c.category].push(c);
    return byCategory;
  }, [candidates]);

  const themeGroups = useMemo(() => {
    const groups = new Map<string, { momentum: string | null; items: Candidate[] }>();
    for (const c of buckets.theme) {
      const key = c.theme?.trim() || "Other themes";
      const g = groups.get(key) ?? { momentum: c.theme_momentum ?? null, items: [] };
      if (!g.momentum && c.theme_momentum) g.momentum = c.theme_momentum;
      g.items.push(c);
      groups.set(key, g);
    }
    return Array.from(groups.entries());
  }, [buckets.theme]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={runScan} disabled={scanning}>
          {scanning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Scanning…
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              Scan Now
            </>
          )}
        </Button>
        <span className="text-xs text-muted-foreground">
          {scanning
            ? "Four Perplexity queries + Yahoo enrichment — takes ~25-30s"
            : scannedAt
              ? `Last scanned: ${fmtRel(scannedAt)}`
              : "No scan run yet"}
        </span>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs text-rose-200 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading && candidates.length === 0 && !scanning ? (
        <div className="text-sm text-muted-foreground">Loading previous scan…</div>
      ) : candidates.length === 0 && !scanning ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          No scan results yet. Click &ldquo;Scan Now&rdquo; to run the AI catalyst
          scanner — it takes about 25-30 seconds.
        </div>
      ) : (
        (() => {
          const renderCard = (c: Candidate) => (
            <CandidateCard
              key={c.symbol}
              candidate={c}
              inIdeas={ideasSymbols.has(c.symbol)}
              adding={adding.has(c.symbol)}
              deepDiveLoading={deepDiveLoading.has(c.symbol)}
              onAdd={() => addToIdeas(c)}
              onOpenDeepDive={() => openDeepDive(c)}
            />
          );
          const counts = {
            all: candidates.length,
            momentum: buckets.momentum.length,
            recovery: buckets.recovery.length,
            theme: buckets.theme.length,
            social: buckets.social.length,
          };
          return (
            <Tabs defaultValue="momentum" className="space-y-4">
              <TabsList className="flex flex-wrap">
                <TabTrigger value="all" label="All" count={counts.all} />
                <TabTrigger
                  value="momentum"
                  label="Momentum"
                  count={counts.momentum}
                />
                <TabTrigger
                  value="recovery"
                  label="Recovery"
                  count={counts.recovery}
                />
                <TabTrigger value="theme" label="Themes" count={counts.theme} />
                <TabTrigger value="social" label="Social" count={counts.social} />
              </TabsList>

              <TabsContent value="all">
                <CardGrid>{candidates.map(renderCard)}</CardGrid>
              </TabsContent>

              <TabsContent value="momentum">
                {buckets.momentum.length === 0 ? (
                  <EmptyTab label="momentum candidates" />
                ) : (
                  <CardGrid>{buckets.momentum.map(renderCard)}</CardGrid>
                )}
              </TabsContent>

              <TabsContent value="recovery">
                {buckets.recovery.length === 0 ? (
                  <EmptyTab label="recovery candidates" />
                ) : (
                  <CardGrid>{buckets.recovery.map(renderCard)}</CardGrid>
                )}
              </TabsContent>

              <TabsContent value="theme">
                {themeGroups.length === 0 ? (
                  <EmptyTab label="theme candidates" />
                ) : (
                  <div className="space-y-5">
                    {themeGroups.map(([theme, group]) => (
                      <div key={theme} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{theme}</span>
                          {group.momentum && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${themeMomentumClasses(group.momentum)}`}
                            >
                              {group.momentum} momentum
                            </span>
                          )}
                        </div>
                        <CardGrid>{group.items.map(renderCard)}</CardGrid>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="social">
                {buckets.social.length === 0 ? (
                  <EmptyTab label="social/retail candidates" />
                ) : (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">
                      What retail traders and financial communities are talking
                      about — ahead of analyst consensus
                    </p>
                    <CardGrid>{buckets.social.map(renderCard)}</CardGrid>
                  </>
                )}
              </TabsContent>
            </Tabs>
          );
        })()
      )}

      <DeepDiveDrawer
        candidate={activeDeepDive}
        dive={activeDeepDive ? (deepDives[activeDeepDive.symbol] ?? null) : null}
        loading={
          activeDeepDive ? deepDiveLoading.has(activeDeepDive.symbol) : false
        }
        error={
          activeDeepDive ? (deepDiveError[activeDeepDive.symbol] ?? null) : null
        }
        inIdeas={
          activeDeepDive ? ideasSymbols.has(activeDeepDive.symbol) : false
        }
        adding={activeDeepDive ? adding.has(activeDeepDive.symbol) : false}
        onAdd={() => activeDeepDive && addToIdeas(activeDeepDive)}
        onClose={closeDeepDive}
      />
    </div>
  );
}

function TabTrigger({
  value,
  label,
  count,
}: {
  value: string;
  label: string;
  count: number;
}) {
  return (
    <TabsTrigger value={value} className="gap-2">
      <span>{label}</span>
      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium">
        {count}
      </span>
    </TabsTrigger>
  );
}

function EmptyTab({ label }: { label: string }) {
  return (
    <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
      No {label} in this scan.
    </div>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
  );
}

function CandidateCard({
  candidate: c,
  inIdeas,
  adding,
  deepDiveLoading,
  onAdd,
  onOpenDeepDive,
}: {
  candidate: Candidate;
  inIdeas: boolean;
  adding: boolean;
  deepDiveLoading: boolean;
  onAdd: () => void;
  onOpenDeepDive: () => void;
}) {
  let pctOfRange: number | null = null;
  if (
    c.current_price !== null &&
    c.week_52_low !== null &&
    c.week_52_high !== null &&
    c.week_52_high > c.week_52_low
  ) {
    const raw =
      ((c.current_price - c.week_52_low) / (c.week_52_high - c.week_52_low)) *
      100;
    pctOfRange = Math.max(0, Math.min(100, raw));
  }
  const changeColor =
    c.price_change_pct === null
      ? "text-muted-foreground"
      : c.price_change_pct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const upsideColor =
    c.upside_to_target === null
      ? "text-muted-foreground"
      : c.upside_to_target >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <div
      className={`flex flex-col rounded-md border p-3 text-xs ${categoryAccentClasses(c.category)}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-base font-semibold text-foreground">
          {c.symbol}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${categoryBadgeClasses(c.category)}`}
            title={
              c.category === "theme" && c.theme
                ? `Theme: ${c.theme}`
                : undefined
            }
          >
            {categoryLabel(c.category)}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidenceClasses(c.confidence)}`}
          >
            {c.confidence}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${sentimentClasses(c.sentiment)}`}
          >
            {c.sentiment}
          </span>
          {c.market_cap_category && (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${marketCapPillClasses(c.market_cap_category)}`}
            >
              {marketCapLabel(c.market_cap_category)}
            </span>
          )}
        </div>
      </div>

      {c.company_name && (
        <div className="mb-1 truncate text-[11px] text-muted-foreground">
          {c.company_name}
        </div>
      )}

      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-mono text-sm text-foreground">
          {fmtMoney(c.current_price)}
        </span>
        <span className={`text-[11px] ${changeColor}`}>
          {c.price_change_pct !== null
            ? `${c.price_change_pct >= 0 ? "▲" : "▼"} ${fmtPct(c.price_change_pct, 2)} today`
            : ""}
        </span>
      </div>

      {pctOfRange !== null && (
        <div className="mb-2">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{fmtMoney(c.week_52_low)}</span>
            <span>52w</span>
            <span>{fmtMoney(c.week_52_high)}</span>
          </div>
          <div className="relative mt-1 h-1.5 rounded-full bg-white/5">
            <div
              className="absolute top-0 h-full rounded-full bg-gradient-to-r from-rose-500/60 via-amber-500/60 to-emerald-500/60"
              style={{ width: `${pctOfRange}%` }}
            />
            <div
              className="absolute -top-1 h-3.5 w-0.5 bg-foreground"
              style={{ left: `calc(${pctOfRange}% - 1px)` }}
            />
          </div>
        </div>
      )}

      {/* Contextual signals: distance from 52w high + position vs 50-day MA.
          Both come from Yahoo enrichment; render whichever is available. */}
      {(fmtFromHigh(c.pct_from_52w_high) || fmt50dMA(c.vs_50d_ma_pct)) && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {(() => {
            const fh = fmtFromHigh(c.pct_from_52w_high);
            return fh ? <span className={fh.cls}>{fh.text}</span> : null;
          })()}
          {(() => {
            const ma = fmt50dMA(c.vs_50d_ma_pct);
            return ma ? <span className={ma.cls}>{ma.text}</span> : null;
          })()}
        </div>
      )}

      <div className="mb-2 grid grid-cols-3 gap-1 text-[11px]">
        <div>
          <div className="text-muted-foreground">Fwd P/E</div>
          <div className="text-foreground">
            {c.forward_pe !== null ? `${c.forward_pe.toFixed(1)}x` : "—"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Target</div>
          <div className="text-foreground">{fmtMoney(c.analyst_target)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Upside</div>
          <div className={upsideColor}>{fmtPct(c.upside_to_target, 0)}</div>
        </div>
      </div>

      {c.catalyst && (
        <div className="mb-1 italic text-muted-foreground">
          &ldquo;{c.catalyst}&rdquo;
        </div>
      )}
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Timeframe: {timeframeLabel(c.timeframe)}
        </span>
      </div>

      {c.risk && (
        <div className="mb-3 flex items-start gap-1 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
          <span>Risk: {c.risk}</span>
        </div>
      )}

      {(c.signal_basis || c.sources.length > 0) && (
        <div className="mb-3 space-y-1 text-[11px]">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Signal className="h-3 w-3 shrink-0 text-sky-300" />
            <span className="text-foreground/90">
              {c.signal_basis || "Signal source"}
            </span>
            {c.sources.length > 0 && (
              <>
                <span className="text-muted-foreground/60">•</span>
                <span>
                  {c.sources.length}{" "}
                  {c.sources.length === 1 ? "source" : "sources"}
                </span>
              </>
            )}
          </div>
          {c.sources.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {c.sources.slice(0, 3).map((src, i) => (
                <a
                  key={i}
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-muted-foreground hover:border-white/30 hover:text-foreground"
                >
                  {domainOf(src)}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-auto space-y-1.5">
        <div className="flex items-center gap-1">
          {inIdeas ? (
            <button
              type="button"
              disabled
              className="flex flex-1 items-center justify-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 py-1.5 text-[11px] font-medium text-emerald-300"
            >
              <CheckCircle2 className="h-3 w-3" />
              Already in Ideas
            </button>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              disabled={adding}
              className="flex flex-1 items-center justify-center gap-1 rounded border border-border bg-white/5 py-1.5 text-[11px] font-medium text-foreground hover:bg-white/10 disabled:opacity-50"
            >
              {adding ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="h-3 w-3" />
                  Add to Ideas
                </>
              )}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenDeepDive}
          className="flex w-full items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          {deepDiveLoading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Researching…
            </>
          ) : (
            <>
              <Telescope className="h-3 w-3" />
              Deep Dive
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function DeepDiveDrawer({
  candidate: c,
  dive,
  loading,
  error,
  inIdeas,
  adding,
  onAdd,
  onClose,
}: {
  candidate: Candidate | null;
  dive: DeepDive | null;
  loading: boolean;
  error: string | null;
  inIdeas: boolean;
  adding: boolean;
  onAdd: () => void;
  onClose: () => void;
}) {
  const open = c !== null;
  const changeColor =
    !c || c.price_change_pct === null
      ? "text-muted-foreground"
      : c.price_change_pct >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-full w-[55vw] flex-col gap-0 p-0 sm:max-w-none"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <SheetTitle className="flex flex-wrap items-baseline gap-2 text-lg">
              <span className="font-mono">{c?.symbol}</span>
              {c?.company_name && (
                <span className="truncate text-sm font-normal text-muted-foreground">
                  — {c.company_name}
                </span>
              )}
            </SheetTitle>
            {c && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-foreground">
                  {fmtMoney(c.current_price)}
                </span>
                <span className={changeColor}>
                  {c.price_change_pct !== null
                    ? `${c.price_change_pct >= 0 ? "▲" : "▼"} ${fmtPct(c.price_change_pct, 2)}`
                    : ""}
                </span>
                <span className="text-muted-foreground">|</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${categoryBadgeClasses(c.category)}`}
                >
                  {categoryLabel(c.category)}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidenceClasses(c.confidence)}`}
                >
                  {c.confidence}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${sentimentClasses(c.sentiment)}`}
                >
                  {c.sentiment}
                </span>
                {c.market_cap_category && (
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${marketCapPillClasses(c.market_cap_category)}`}
                  >
                    {marketCapLabel(c.market_cap_category)}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body — scrollable. text-base + leading-relaxed gives the panel
            a research-note feel rather than a tooltip. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 text-base">
          {loading && !dive && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin" />
              <span className="text-base">Researching {c?.symbol ?? ""}…</span>
              <span className="text-xs">
                Pulling recent news, fundamentals, sentiment, and bear case
              </span>
            </div>
          )}

          {!loading && !dive && error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
              {error}
            </div>
          )}

          {dive && (
            <div className="space-y-6">
              <DeepSection title="📰 Recent news">
                <p className="leading-relaxed text-foreground/90">
                  {dive.recent_news}
                </p>
              </DeepSection>

              <DeepSection title="💰 Fundamental health">
                <p className="leading-relaxed text-foreground/90">
                  {dive.fundamental_health}
                </p>
              </DeepSection>

              <DeepSection title="⚡ Catalyst">
                <div className="mb-2 flex flex-wrap gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Credibility:{" "}
                    <span className="font-medium uppercase text-foreground">
                      {dive.catalyst_credibility}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Timeline:{" "}
                    <span className="text-foreground">
                      {dive.catalyst_timeline}
                    </span>
                  </span>
                </div>
                {c?.catalyst && (
                  <p className="leading-relaxed text-foreground/90">
                    &ldquo;{c.catalyst}&rdquo;
                  </p>
                )}
              </DeepSection>

              <DeepSection title="👥 Sentiment">
                <div className="flex flex-wrap gap-6 text-sm">
                  <span className="text-muted-foreground">
                    Retail:{" "}
                    <span className="font-medium capitalize text-foreground">
                      {dive.retail_sentiment}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Institutional:{" "}
                    <span className="font-medium capitalize text-foreground">
                      {dive.institutional_activity}
                    </span>
                  </span>
                </div>
              </DeepSection>

              <DeepSection title="📊 Technical setup">
                <div className="text-foreground/90">
                  {technicalLabel(dive.technical_setup)}
                </div>
                {dive.entry_comment && (
                  <p className="mt-1 leading-relaxed text-muted-foreground">
                    {dive.entry_comment}
                  </p>
                )}
              </DeepSection>

              {dive.bear_case.length > 0 && (
                <DeepSection title="⚠ Bear case">
                  <ul className="list-disc space-y-1 pl-5 leading-relaxed text-foreground/90">
                    {dive.bear_case.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </DeepSection>
              )}

              <div
                className={`rounded border p-5 ${verdictClasses(dive.verdict)}`}
              >
                <div className="text-xs font-semibold uppercase tracking-wider">
                  Verdict: {dive.verdict} priority
                </div>
                {dive.verdict_reasoning && (
                  <p className="mt-2 text-base leading-relaxed">
                    {dive.verdict_reasoning}
                  </p>
                )}
              </div>

              {c && c.sources.length > 0 && (
                <DeepSection title="🔗 Sources">
                  <ol className="space-y-1.5 pl-5 text-sm leading-relaxed text-foreground/90">
                    {c.sources.map((src, i) => (
                      <li key={i} className="list-decimal">
                        <a
                          href={src}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sky-300 underline-offset-2 hover:underline"
                        >
                          <span className="font-medium">{domainOf(src)}</span>
                          <ExternalLink className="h-3 w-3 opacity-60" />
                        </a>
                        <div className="ml-1 truncate text-[11px] text-muted-foreground">
                          {src}
                        </div>
                      </li>
                    ))}
                  </ol>
                </DeepSection>
              )}
            </div>
          )}
        </div>

        {/* Footer — sticky */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {!inIdeas && c && (
            <Button
              onClick={onAdd}
              disabled={adding}
              variant="outline"
              size="sm"
            >
              {adding ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="mr-1 h-3 w-3" />
                  Add to Ideas
                </>
              )}
            </Button>
          )}
          {inIdeas && (
            <span className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              Already in Ideas
            </span>
          )}
          <Button onClick={onClose} variant="ghost" size="sm">
            <X className="mr-1 h-3 w-3" />
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DeepSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-base font-semibold tracking-wide text-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
