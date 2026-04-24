"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Category = "momentum" | "recovery" | "theme" | "social";

type Candidate = {
  symbol: string;
  catalyst: string;
  sentiment: string;
  timeframe: string;
  thesis: string;
  confidence: string;
  risk: string;
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

  // Deep-dive state — keyed by symbol so each card holds its own panel
  // independently. `loading` is a Set of symbols currently being researched.
  const [deepDives, setDeepDives] = useState<Record<string, DeepDive>>({});
  const [deepDiveOpen, setDeepDiveOpen] = useState<Set<string>>(new Set());
  const [deepDiveLoading, setDeepDiveLoading] = useState<Set<string>>(new Set());
  const [deepDiveError, setDeepDiveError] = useState<Record<string, string>>({});

  async function loadLatest() {
    setLoading(true);
    try {
      const res = await fetch("/api/swings/discover", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCandidates((json.candidates ?? []) as Candidate[]);
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
      setCandidates((json.candidates ?? []) as Candidate[]);
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

  async function toggleDeepDive(c: Candidate) {
    // Open ↔ close. If we already have the data cached, just open.
    const isOpen = deepDiveOpen.has(c.symbol);
    if (isOpen) {
      setDeepDiveOpen((prev) => {
        const next = new Set(prev);
        next.delete(c.symbol);
        return next;
      });
      return;
    }

    if (deepDives[c.symbol]) {
      setDeepDiveOpen((prev) => {
        const next = new Set(prev);
        next.add(c.symbol);
        return next;
      });
      return;
    }

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
      setDeepDives((prev) => ({ ...prev, [c.symbol]: json.deep_dive as DeepDive }));
      setDeepDiveOpen((prev) => {
        const next = new Set(prev);
        next.add(c.symbol);
        return next;
      });
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
        <div className="space-y-8">
          {buckets.momentum.length > 0 && (
            <Section title="Momentum Plays">
              <CardGrid>
                {buckets.momentum.map((c) => (
                  <CandidateCard
                    key={c.symbol}
                    candidate={c}
                    inIdeas={ideasSymbols.has(c.symbol)}
                    adding={adding.has(c.symbol)}
                    deepDive={deepDives[c.symbol] ?? null}
                    deepDiveOpen={deepDiveOpen.has(c.symbol)}
                    deepDiveLoading={deepDiveLoading.has(c.symbol)}
                    deepDiveError={deepDiveError[c.symbol] ?? null}
                    onAdd={() => addToIdeas(c)}
                    onToggleDeepDive={() => toggleDeepDive(c)}
                  />
                ))}
              </CardGrid>
            </Section>
          )}

          {buckets.recovery.length > 0 && (
            <Section title="Recovery Plays">
              <CardGrid>
                {buckets.recovery.map((c) => (
                  <CandidateCard
                    key={c.symbol}
                    candidate={c}
                    inIdeas={ideasSymbols.has(c.symbol)}
                    adding={adding.has(c.symbol)}
                    deepDive={deepDives[c.symbol] ?? null}
                    deepDiveOpen={deepDiveOpen.has(c.symbol)}
                    deepDiveLoading={deepDiveLoading.has(c.symbol)}
                    deepDiveError={deepDiveError[c.symbol] ?? null}
                    onAdd={() => addToIdeas(c)}
                    onToggleDeepDive={() => toggleDeepDive(c)}
                  />
                ))}
              </CardGrid>
            </Section>
          )}

          {themeGroups.length > 0 && (
            <Section title="Sector Themes">
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
                    <CardGrid>
                      {group.items.map((c) => (
                        <CandidateCard
                          key={c.symbol}
                          candidate={c}
                          inIdeas={ideasSymbols.has(c.symbol)}
                          adding={adding.has(c.symbol)}
                          deepDive={deepDives[c.symbol] ?? null}
                          deepDiveOpen={deepDiveOpen.has(c.symbol)}
                          deepDiveLoading={deepDiveLoading.has(c.symbol)}
                          deepDiveError={deepDiveError[c.symbol] ?? null}
                          onAdd={() => addToIdeas(c)}
                          onToggleDeepDive={() => toggleDeepDive(c)}
                        />
                      ))}
                    </CardGrid>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {buckets.social.length > 0 && (
            <Section
              title="Social & Retail Momentum"
              subtitle="What retail traders and financial communities are talking about — ahead of analyst consensus"
            >
              <CardGrid>
                {buckets.social.map((c) => (
                  <CandidateCard
                    key={c.symbol}
                    candidate={c}
                    inIdeas={ideasSymbols.has(c.symbol)}
                    adding={adding.has(c.symbol)}
                    deepDive={deepDives[c.symbol] ?? null}
                    deepDiveOpen={deepDiveOpen.has(c.symbol)}
                    deepDiveLoading={deepDiveLoading.has(c.symbol)}
                    deepDiveError={deepDiveError[c.symbol] ?? null}
                    onAdd={() => addToIdeas(c)}
                    onToggleDeepDive={() => toggleDeepDive(c)}
                  />
                ))}
              </CardGrid>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
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
  deepDive,
  deepDiveOpen,
  deepDiveLoading,
  deepDiveError,
  onAdd,
  onToggleDeepDive,
}: {
  candidate: Candidate;
  inIdeas: boolean;
  adding: boolean;
  deepDive: DeepDive | null;
  deepDiveOpen: boolean;
  deepDiveLoading: boolean;
  deepDiveError: string | null;
  onAdd: () => void;
  onToggleDeepDive: () => void;
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
        <div className="flex items-center gap-1">
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
          <div className="mt-1 text-[10px] text-muted-foreground">
            at {Math.round(pctOfRange)}% of 52w range
          </div>
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
          onClick={onToggleDeepDive}
          disabled={deepDiveLoading}
          className="flex w-full items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-50"
        >
          {deepDiveLoading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Researching…
            </>
          ) : deepDiveOpen ? (
            <>
              <ChevronUp className="h-3 w-3" />
              Collapse
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              Deep Dive
            </>
          )}
        </button>
        {deepDiveError && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[10px] text-rose-300">
            {deepDiveError}
          </div>
        )}
      </div>

      {deepDiveOpen && deepDive && (
        <DeepDivePanel
          dive={deepDive}
          inIdeas={inIdeas}
          adding={adding}
          onAdd={onAdd}
          onCollapse={onToggleDeepDive}
        />
      )}
    </div>
  );
}

function DeepDivePanel({
  dive,
  inIdeas,
  adding,
  onAdd,
  onCollapse,
}: {
  dive: DeepDive;
  inIdeas: boolean;
  adding: boolean;
  onAdd: () => void;
  onCollapse: () => void;
}) {
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-background/60 p-3 text-[11px]">
      <DeepSection title="📰 Recent news">
        <p className="text-foreground/90">{dive.recent_news}</p>
      </DeepSection>

      <DeepSection title="💰 Fundamental health">
        <p className="text-foreground/90">{dive.fundamental_health}</p>
      </DeepSection>

      <DeepSection title="⚡ Catalyst">
        <div className="mb-1 flex flex-wrap gap-2 text-[10px]">
          <span className="text-muted-foreground">
            Credibility:{" "}
            <span className="font-medium uppercase text-foreground">
              {dive.catalyst_credibility}
            </span>
          </span>
          <span className="text-muted-foreground">
            Timeline:{" "}
            <span className="text-foreground">{dive.catalyst_timeline}</span>
          </span>
        </div>
      </DeepSection>

      <DeepSection title="👥 Sentiment">
        <div className="flex flex-wrap gap-3 text-[10px]">
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
          <div className="mt-1 text-muted-foreground">{dive.entry_comment}</div>
        )}
      </DeepSection>

      {dive.bear_case.length > 0 && (
        <DeepSection title="⚠ Bear case">
          <ul className="list-disc space-y-0.5 pl-4 text-foreground/90">
            {dive.bear_case.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </DeepSection>
      )}

      <div className={`rounded border p-2 ${verdictClasses(dive.verdict)}`}>
        <div className="text-[10px] font-semibold uppercase tracking-wider">
          Verdict: {dive.verdict} priority
        </div>
        {dive.verdict_reasoning && (
          <div className="mt-1 text-[11px]">{dive.verdict_reasoning}</div>
        )}
      </div>

      <div className="flex items-center gap-1">
        {!inIdeas && (
          <button
            type="button"
            onClick={onAdd}
            disabled={adding}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-border bg-white/5 py-1.5 text-[11px] font-medium text-foreground hover:bg-white/10 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add to Ideas
          </button>
        )}
        <button
          type="button"
          onClick={onCollapse}
          className="flex items-center justify-center gap-1 rounded border border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <ChevronUp className="h-3 w-3" />
          Collapse
        </button>
      </div>
    </div>
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
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
