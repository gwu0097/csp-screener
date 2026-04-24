"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Candidate = {
  symbol: string;
  catalyst: string;
  sentiment: string;
  timeframe: string;
  thesis: string;
  confidence: string;
  risk: string;
  category: "momentum" | "recovery" | "theme";
  theme?: string | null;
  theme_momentum?: string | null;
  current_price: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  forward_pe: number | null;
  analyst_target: number | null;
  price_change_pct: number | null;
  pct_from_52w_high: number | null;
  upside_to_target: number | null;
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

function timeframeLabel(tf: string): string {
  if (tf === "1month") return "1 month";
  if (tf === "3months") return "3 months";
  if (tf === "6months") return "6 months";
  return tf;
}

export function SwingDiscoverView() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideasSymbols, setIdeasSymbols] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());

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
      setError(
        `Add ${c.symbol}: ${e instanceof Error ? e.message : "failed"}`,
      );
    } finally {
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(c.symbol);
        return next;
      });
    }
  }

  const buckets = useMemo(() => {
    const byCategory: Record<"momentum" | "recovery" | "theme", Candidate[]> = {
      momentum: [],
      recovery: [],
      theme: [],
    };
    for (const c of candidates) byCategory[c.category].push(c);
    return byCategory;
  }, [candidates]);

  // Group theme candidates by their theme label so each theme gets its own
  // sub-header with momentum badge.
  const themeGroups = useMemo(() => {
    const groups = new Map<string, { momentum: string | null; items: Candidate[] }>();
    for (const c of buckets.theme) {
      const key = c.theme?.trim() || "Other themes";
      const g = groups.get(key) ?? {
        momentum: c.theme_momentum ?? null,
        items: [],
      };
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
            ? "Three Perplexity queries + Yahoo enrichment — takes ~15-20s"
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
          scanner — it takes about 20 seconds.
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
                    onAdd={() => addToIdeas(c)}
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
                    onAdd={() => addToIdeas(c)}
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
                          onAdd={() => addToIdeas(c)}
                        />
                      ))}
                    </CardGrid>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
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
  onAdd,
}: {
  candidate: Candidate;
  inIdeas: boolean;
  adding: boolean;
  onAdd: () => void;
}) {
  // 52-week position — percent of range the current price occupies.
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
    <div className="flex flex-col rounded-md border border-border bg-zinc-900/60 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
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

      <div className="mt-auto">
        {inIdeas ? (
          <button
            type="button"
            disabled
            className="flex w-full items-center justify-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 py-1.5 text-[11px] font-medium text-emerald-300"
          >
            <CheckCircle2 className="h-3 w-3" />
            Already in Ideas
          </button>
        ) : (
          <button
            type="button"
            onClick={onAdd}
            disabled={adding}
            className="flex w-full items-center justify-center gap-1 rounded border border-border bg-white/5 py-1.5 text-[11px] font-medium text-foreground hover:bg-white/10 disabled:opacity-50"
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
    </div>
  );
}
