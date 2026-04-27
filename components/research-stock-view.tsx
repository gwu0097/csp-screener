"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  Loader2,
  RefreshCw,
  RotateCcw,
  Target,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ---------- Types mirrored from the API routes ----------

type StockInfo = {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapCategory: "large" | "mid" | "small" | null;
  currentPrice: number | null;
  priceChange1d: number | null;
  overallGrade: string | null;
  gradeReasoning: string | null;
  lastResearchedAt: string | null;
};

type ModuleEnvelope<T> = {
  id: string;
  symbol: string;
  moduleType: string;
  output: T;
  runAt: string;
  expiresAt: string | null;
  isExpired: boolean;
  isCustomized: boolean;
} | null;

type BusinessOverview = {
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  employees: number | null;
  website: string | null;
  longBusinessSummary: string | null;
  business_model: string | null;
  revenue_streams: string[];
  moat_type: string | null;
  moat_description: string | null;
  competitors: Array<{ name: string; ticker: string; comparison: string }>;
  growth_drivers: string[];
  management_notes: string | null;
  bull_summary: string | null;
  bear_summary: string | null;
};

type AnnualMetrics = {
  year: number;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  cash: number | null;
  debt: number | null;
};

type CurrentMetrics = {
  forwardPE: number | null;
  trailingPE: number | null;
  priceToBook: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  currentRatio: number | null;
  debtToEquity: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
};

type ScoreComponent = { label: string; earned: number; max: number; detail: string };

type FundamentalHealth = {
  cik: string | null;
  annual: AnnualMetrics[];
  current: CurrentMetrics;
  healthScore: number;
  scoreComponents: ScoreComponent[];
  scoreLabel: string;
};

type CatalystHorizon = "near_term" | "medium_term" | "long_term";

type CatalystEntry = {
  // Optional fields are absent on rows saved before catalyst accumulation
  // landed — render defensively.
  id?: string;
  title: string;
  type: string;
  horizon: CatalystHorizon;
  description: string;
  expected_date: string | null;
  impact_direction: "bullish" | "bearish" | "neutral";
  impact_magnitude: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  source_context: string | null;
  first_found_at?: string;
  last_confirmed_at?: string;
  scan_count?: number;
  dismissed?: boolean;
};

type CatalystScanner = {
  catalysts: CatalystEntry[];
  overall_catalyst_score: "rich" | "moderate" | "sparse";
  summary: string | null;
  next_earnings: { date: string; daysAway: number | null } | null;
};

// ---------- Formatters ----------

function fmtMoney(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(digits)}`;
}
function fmtBigDollars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}
function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}
function fmtRelDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function fmtCalendar(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function gradeClasses(g: string | null): string {
  if (g === "A") return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (g === "B") return "border-teal-500/40 bg-teal-500/15 text-teal-300";
  if (g === "C") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  if (g === "D") return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
}

function capLabel(c: StockInfo["marketCapCategory"]): string {
  if (c === "large") return "Large-cap";
  if (c === "mid") return "Mid-cap";
  if (c === "small") return "Small-cap";
  return "—";
}

// ---------- Top-level view ----------

export function ResearchStockView({ symbol }: { symbol: string }) {
  const [stock, setStock] = useState<StockInfo | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [overviewMod, setOverviewMod] = useState<ModuleEnvelope<BusinessOverview>>(null);
  const [healthMod, setHealthMod] = useState<ModuleEnvelope<FundamentalHealth>>(null);
  const [catalystMod, setCatalystMod] = useState<ModuleEnvelope<CatalystScanner>>(null);
  const [tab, setTab] = useState("overview");

  async function loadStock() {
    try {
      const res = await fetch(`/api/research/${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { stock?: StockInfo; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setStock(json.stock ?? null);
    } catch (e) {
      setStockError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  async function loadModule<T>(
    moduleSlug: string,
    setter: (m: ModuleEnvelope<T>) => void,
  ) {
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/${moduleSlug}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as {
        module?: ModuleEnvelope<T>;
        error?: string;
      };
      if (!res.ok) return;
      setter(json.module ?? null);
    } catch {
      /* swallow */
    }
  }

  useEffect(() => {
    loadStock();
    loadModule<BusinessOverview>("business-overview", setOverviewMod);
    loadModule<FundamentalHealth>("fundamental-health", setHealthMod);
    loadModule<CatalystScanner>("catalyst-scanner", setCatalystMod);
  }, [symbol]);

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/research"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          Back to Research
        </Link>
      </div>

      <Header stock={stock} symbol={symbol} stockError={stockError} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="overview">📋 Overview</TabsTrigger>
          <TabsTrigger value="catalysts">🎯 Catalysts</TabsTrigger>
          <TabsTrigger value="valuation">📊 Valuation</TabsTrigger>
          <TabsTrigger value="tenk">📄 10-K</TabsTrigger>
          <TabsTrigger value="risk">⚠️ Risk</TabsTrigger>
          <TabsTrigger value="sentiment">👥 Sentiment</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <BusinessOverviewCard
            symbol={symbol}
            mod={overviewMod}
            onRun={async () => {
              const res = await fetch(
                `/api/research/${encodeURIComponent(symbol)}/business-overview`,
                { method: "POST", cache: "no-store" },
              );
              if (res.ok) {
                const json = (await res.json()) as {
                  module: ModuleEnvelope<BusinessOverview>;
                };
                setOverviewMod(json.module);
                loadStock(); // refresh grade
              }
            }}
          />
          <FundamentalHealthCard
            symbol={symbol}
            mod={healthMod}
            onRun={async () => {
              const res = await fetch(
                `/api/research/${encodeURIComponent(symbol)}/fundamental-health`,
                { method: "POST", cache: "no-store" },
              );
              if (res.ok) {
                const json = (await res.json()) as {
                  module: ModuleEnvelope<FundamentalHealth>;
                };
                setHealthMod(json.module);
                loadStock();
              }
            }}
          />
        </TabsContent>

        <TabsContent value="catalysts" className="space-y-4">
          <CatalystScannerCard
            symbol={symbol}
            mod={catalystMod}
            onRun={async () => {
              const res = await fetch(
                `/api/research/${encodeURIComponent(symbol)}/catalyst-scanner`,
                { method: "POST", cache: "no-store" },
              );
              if (res.ok) {
                const json = (await res.json()) as {
                  module: ModuleEnvelope<CatalystScanner>;
                };
                setCatalystMod(json.module);
                loadStock();
              }
            }}
            onMutate={(updater) =>
              setCatalystMod((prev) =>
                prev ? { ...prev, output: updater(prev.output) } : prev,
              )
            }
          />
        </TabsContent>

        <TabsContent value="valuation">
          <ComingSoon
            title="Valuation Model"
            blurb="DCF + bear/base/bull scenarios with editable assumptions, plus historical valuation snapshots."
          />
        </TabsContent>
        <TabsContent value="tenk">
          <ComingSoon
            title="10-K Deep Read"
            blurb="Distilled risk factors, MD&A highlights, and segment financials from the latest annual filing."
          />
        </TabsContent>
        <TabsContent value="risk">
          <ComingSoon
            title="Risk Assessment"
            blurb="Scored risk inventory across regulatory, competitive, balance-sheet, and macro vectors."
          />
        </TabsContent>
        <TabsContent value="sentiment">
          <ComingSoon
            title="Sentiment"
            blurb="Retail + institutional sentiment, options skew, and social/news flow."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Header ----------

function Header({
  stock,
  symbol,
  stockError,
}: {
  stock: StockInfo | null;
  symbol: string;
  stockError: string | null;
}) {
  if (stockError) {
    return (
      <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
        Could not load {symbol}: {stockError}
      </div>
    );
  }
  if (!stock) {
    return (
      <div className="rounded border border-border bg-background/40 p-4 text-sm text-muted-foreground">
        Loading {symbol}…
      </div>
    );
  }
  const chgColor =
    stock.priceChange1d === null
      ? "text-muted-foreground"
      : stock.priceChange1d >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-mono text-2xl font-semibold text-foreground">
          {stock.symbol}
        </h1>
        <span className="text-sm text-muted-foreground">
          {stock.companyName ?? "—"}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">
          {fmtMoney(stock.currentPrice)}
        </span>
        <span className={chgColor}>
          {stock.priceChange1d === null
            ? "—"
            : `${stock.priceChange1d >= 0 ? "▲" : "▼"}${Math.abs(stock.priceChange1d).toFixed(2)}% today`}
        </span>
        <span>·</span>
        <span>{capLabel(stock.marketCapCategory)}</span>
        {stock.sector && (
          <>
            <span>·</span>
            <span>{stock.sector}</span>
          </>
        )}
        <span>·</span>
        <span>
          Overall grade:{" "}
          <span
            className={`ml-1 inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${gradeClasses(
              stock.overallGrade,
            )}`}
            title={stock.gradeReasoning ?? undefined}
          >
            {stock.overallGrade ?? "Not yet graded"}
          </span>
        </span>
        <span>·</span>
        <span>Last researched: {fmtRelDate(stock.lastResearchedAt)}</span>
      </div>
    </div>
  );
}

// ---------- Module shell ----------

function ModuleHeader({
  title,
  cacheNote,
  module,
  onRun,
  rightSlot,
}: {
  title: string;
  cacheNote: string;
  module: ModuleEnvelope<unknown>;
  onRun: () => Promise<void>;
  rightSlot?: React.ReactNode;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        <div className="flex items-center gap-2">
          {rightSlot}
          <button
            type="button"
            onClick={async () => {
              setRunning(true);
              setError(null);
              try {
                await onRun();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Run failed");
              } finally {
                setRunning(false);
              }
            }}
            disabled={running}
            className="inline-flex items-center gap-1 rounded border border-border bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {module ? "Re-run" : "Run module"}
          </button>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {module ? (
          <>
            Last updated: {fmtRelDate(module.runAt)} · {cacheNote}
            {module.isExpired && (
              <span className="ml-1 text-amber-300">(cache expired)</span>
            )}
          </>
        ) : (
          <span>Not yet run · {cacheNote}</span>
        )}
      </div>
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------- Business Overview card ----------

function BusinessOverviewCard({
  mod,
  onRun,
}: {
  symbol: string;
  mod: ModuleEnvelope<BusinessOverview>;
  onRun: () => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-border bg-background/30 p-3">
      <ModuleHeader
        title="Business overview"
        cacheNote="30 day cache"
        module={mod}
        onRun={onRun}
      />
      <div className="mt-3">
        {!mod ? (
          <div className="rounded border border-dashed border-border bg-background/40 p-6 text-center text-xs text-muted-foreground">
            Click <span className="font-medium text-foreground">Run module</span>{" "}
            to pull company profile (Yahoo) and a structured business
            breakdown (Perplexity).
          </div>
        ) : (
          <BusinessOverviewBody data={mod.output} />
        )}
      </div>
    </div>
  );
}

function BusinessOverviewBody({ data }: { data: BusinessOverview }) {
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <DetailLine label="Sector" value={data.sector ?? "—"} />
        <DetailLine label="Industry" value={data.industry ?? "—"} />
        <DetailLine label="Market cap" value={fmtBigDollars(data.marketCap)} />
        <DetailLine label="Employees" value={fmtNumber(data.employees)} />
      </div>

      {data.business_model && (
        <Section title="Business model">
          <p className="text-foreground/90">{data.business_model}</p>
        </Section>
      )}
      {data.revenue_streams.length > 0 && (
        <Section title="Revenue streams">
          <div className="flex flex-wrap gap-1">
            {data.revenue_streams.map((s, i) => (
              <span
                key={i}
                className="rounded border border-border bg-white/5 px-1.5 py-0.5 text-[11px] text-foreground/90"
              >
                {s}
              </span>
            ))}
          </div>
        </Section>
      )}
      {(data.moat_type || data.moat_description) && (
        <Section title="Competitive moat">
          {data.moat_type && (
            <div className="mb-1 text-muted-foreground">
              Type:{" "}
              <span className="text-foreground/90 capitalize">
                {data.moat_type.replace(/_/g, " ")}
              </span>
            </div>
          )}
          {data.moat_description && (
            <p className="text-foreground/90">{data.moat_description}</p>
          )}
        </Section>
      )}
      {data.competitors.length > 0 && (
        <Section title="Top competitors">
          <ul className="space-y-1">
            {data.competitors.map((c, i) => (
              <li key={i} className="text-foreground/90">
                <span className="font-mono">{c.ticker || "—"}</span>
                {c.name && (
                  <>
                    {" "}
                    — <span className="text-muted-foreground">{c.name}</span>
                  </>
                )}
                {c.comparison && (
                  <>: <span className="text-muted-foreground">{c.comparison}</span></>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {data.growth_drivers.length > 0 && (
        <Section title="Growth drivers">
          <ul className="list-inside list-disc space-y-0.5 text-foreground/90">
            {data.growth_drivers.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </Section>
      )}
      {data.management_notes && (
        <Section title="Management">
          <p className="text-foreground/90">{data.management_notes}</p>
        </Section>
      )}
      {(data.bull_summary || data.bear_summary) && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2">
            <div className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
              <TrendingUp className="h-3 w-3" />
              Bulls say
            </div>
            <p className="text-foreground/90">{data.bull_summary ?? "—"}</p>
          </div>
          <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2">
            <div className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
              <TrendingDown className="h-3 w-3" />
              Bears say
            </div>
            <p className="text-foreground/90">{data.bear_summary ?? "—"}</p>
          </div>
        </div>
      )}
      {data.longBusinessSummary && (
        <Section title="Yahoo summary">
          <p className="text-[11px] text-muted-foreground">
            {data.longBusinessSummary}
          </p>
        </Section>
      )}
    </div>
  );
}

// ---------- Fundamental Health card ----------

function FundamentalHealthCard({
  mod,
  onRun,
}: {
  symbol: string;
  mod: ModuleEnvelope<FundamentalHealth>;
  onRun: () => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-border bg-background/30 p-3">
      <ModuleHeader
        title="Fundamental health"
        cacheNote="7 day cache"
        module={mod}
        onRun={onRun}
        rightSlot={
          mod ? (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                mod.output.healthScore >= 8
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : mod.output.healthScore >= 6
                    ? "border-teal-500/40 bg-teal-500/15 text-teal-300"
                    : mod.output.healthScore >= 4
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                      : "border-rose-500/40 bg-rose-500/15 text-rose-300"
              }`}
            >
              {mod.output.healthScore}/10
            </span>
          ) : null
        }
      />
      <div className="mt-3">
        {!mod ? (
          <div className="rounded border border-dashed border-border bg-background/40 p-6 text-center text-xs text-muted-foreground">
            Pulls 5 years of 10-K financials from SEC EDGAR + current ratios
            from Yahoo Finance.
          </div>
        ) : (
          <FundamentalHealthBody data={mod.output} />
        )}
      </div>
    </div>
  );
}

function trendCls(curr: number | null, prev: number | null): string {
  if (curr === null || prev === null || prev === 0) return "text-foreground/90";
  const delta = (curr - prev) / Math.abs(prev);
  if (delta > 0.02) return "text-emerald-300";
  if (delta < -0.02) return "text-rose-300";
  return "text-muted-foreground";
}

function FundamentalHealthBody({ data }: { data: FundamentalHealth }) {
  // Sort ascending so the table reads oldest → newest.
  const annual = [...data.annual].sort((a, b) => a.year - b.year);
  const c = data.current;
  return (
    <div className="space-y-3 text-xs">
      <Section title="Historical financials (SEC EDGAR)">
        {annual.length === 0 ? (
          <div className="text-muted-foreground">
            No annual filings returned from EDGAR (CIK lookup may have missed).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border/50">
                  <th className="px-1.5 py-1 text-left font-medium">Metric</th>
                  {annual.map((row) => (
                    <th key={row.year} className="px-1.5 py-1 text-right font-medium">
                      {row.year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <FinancialRow
                  label="Revenue"
                  values={annual.map((r) => r.revenue)}
                  format={fmtBigDollars}
                />
                <GrowthRow
                  label="Rev growth"
                  values={annual.map((r) => r.revenue)}
                />
                <MarginRow
                  label="Gross margin"
                  numerators={annual.map((r) => r.grossProfit)}
                  denominators={annual.map((r) => r.revenue)}
                />
                <MarginRow
                  label="Op margin"
                  numerators={annual.map((r) => r.operatingIncome)}
                  denominators={annual.map((r) => r.revenue)}
                />
                <MarginRow
                  label="Net margin"
                  numerators={annual.map((r) => r.netIncome)}
                  denominators={annual.map((r) => r.revenue)}
                />
                <FinancialRow
                  label="EPS"
                  values={annual.map((r) => r.eps)}
                  format={(n) => (n === null ? "—" : `$${n.toFixed(2)}`)}
                />
                <FinancialRow
                  label="Cash"
                  values={annual.map((r) => r.cash)}
                  format={fmtBigDollars}
                />
                <FinancialRow
                  label="Debt"
                  values={annual.map((r) => r.debt)}
                  format={fmtBigDollars}
                  invertTrend
                />
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Current metrics (Yahoo)">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          <DetailLine
            label="P/E (TTM)"
            value={c.trailingPE !== null ? `${c.trailingPE.toFixed(1)}x` : "—"}
          />
          <DetailLine
            label="Forward P/E"
            value={c.forwardPE !== null ? `${c.forwardPE.toFixed(1)}x` : "—"}
          />
          <DetailLine
            label="P/B"
            value={c.priceToBook !== null ? `${c.priceToBook.toFixed(1)}x` : "—"}
          />
          <DetailLine
            label="ROE"
            value={fmtPct(c.returnOnEquity)}
          />
          <DetailLine
            label="ROA"
            value={fmtPct(c.returnOnAssets)}
          />
          <DetailLine
            label="D/E"
            value={
              c.debtToEquity !== null
                ? (c.debtToEquity > 5
                    ? (c.debtToEquity / 100).toFixed(2)
                    : c.debtToEquity.toFixed(2))
                : "—"
            }
          />
          <DetailLine
            label="Current ratio"
            value={c.currentRatio !== null ? `${c.currentRatio.toFixed(2)}x` : "—"}
          />
          <DetailLine
            label="FCF"
            value={fmtBigDollars(c.freeCashflow)}
          />
          <DetailLine
            label="Op cashflow"
            value={fmtBigDollars(c.operatingCashflow)}
          />
        </div>
      </Section>

      <Section title={`Health scorecard — ${data.scoreLabel}`}>
        <div className="space-y-1">
          {data.scoreComponents.map((comp, i) => {
            const ok = comp.earned > 0;
            const partial = comp.earned > 0 && comp.earned < comp.max;
            const cls = ok
              ? partial
                ? "text-amber-300"
                : "text-emerald-300"
              : "text-muted-foreground";
            const icon = ok ? (partial ? "⚠" : "✓") : "✗";
            return (
              <div key={i} className="flex items-start gap-2">
                <span className={`mt-0.5 w-3 shrink-0 ${cls}`}>{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground/90">{comp.label}</span>
                    <span className={`font-mono ${cls}`}>
                      {comp.earned}/{comp.max}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {comp.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function FinancialRow({
  label,
  values,
  format,
  invertTrend,
}: {
  label: string;
  values: Array<number | null>;
  format: (n: number | null) => string;
  invertTrend?: boolean;
}) {
  return (
    <tr className="border-b border-border/30">
      <td className="px-1.5 py-1 text-muted-foreground">{label}</td>
      {values.map((v, i) => {
        const prev = i > 0 ? values[i - 1] : null;
        // For debt: lower is better, so flip the trend coloring.
        const trend = invertTrend ? trendCls(prev, v) : trendCls(v, prev);
        return (
          <td key={i} className={`px-1.5 py-1 text-right font-mono ${trend}`}>
            {format(v)}
          </td>
        );
      })}
    </tr>
  );
}

function GrowthRow({ label, values }: { label: string; values: Array<number | null> }) {
  return (
    <tr className="border-b border-border/30">
      <td className="px-1.5 py-1 text-muted-foreground">{label}</td>
      {values.map((v, i) => {
        const prev = i > 0 ? values[i - 1] : null;
        const growth =
          v !== null && prev !== null && prev !== 0 ? (v - prev) / prev : null;
        const cls =
          growth === null
            ? "text-muted-foreground"
            : growth > 0.05
              ? "text-emerald-300"
              : growth < 0
                ? "text-rose-300"
                : "text-foreground/90";
        return (
          <td key={i} className={`px-1.5 py-1 text-right font-mono ${cls}`}>
            {growth === null
              ? "—"
              : `${growth > 0 ? "+" : ""}${(growth * 100).toFixed(0)}%`}
          </td>
        );
      })}
    </tr>
  );
}

function MarginRow({
  label,
  numerators,
  denominators,
}: {
  label: string;
  numerators: Array<number | null>;
  denominators: Array<number | null>;
}) {
  const margins = numerators.map((n, i) => {
    const d = denominators[i];
    return n !== null && d !== null && d > 0 ? n / d : null;
  });
  return (
    <tr className="border-b border-border/30">
      <td className="px-1.5 py-1 text-muted-foreground">{label}</td>
      {margins.map((m, i) => {
        const prev = i > 0 ? margins[i - 1] : null;
        const cls = trendCls(m, prev);
        return (
          <td key={i} className={`px-1.5 py-1 text-right font-mono ${cls}`}>
            {m === null ? "—" : `${(m * 100).toFixed(1)}%`}
          </td>
        );
      })}
    </tr>
  );
}

// ---------- Catalyst Scanner card ----------

function CatalystScannerCard({
  symbol,
  mod,
  onRun,
  onMutate,
}: {
  symbol: string;
  mod: ModuleEnvelope<CatalystScanner>;
  onRun: () => Promise<void>;
  onMutate: (updater: (prev: CatalystScanner) => CatalystScanner) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background/30 p-3">
      <ModuleHeader
        title="Catalyst scanner"
        cacheNote="3 day cache"
        module={mod}
        onRun={onRun}
        rightSlot={
          mod ? (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                mod.output.overall_catalyst_score === "rich"
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : mod.output.overall_catalyst_score === "moderate"
                    ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                    : "border-zinc-500/40 bg-zinc-500/15 text-zinc-400"
              }`}
            >
              {mod.output.overall_catalyst_score}
            </span>
          ) : null
        }
      />
      <div className="mt-3 space-y-3 text-xs">
        {!mod ? (
          <div className="rounded border border-dashed border-border bg-background/40 p-6 text-center text-muted-foreground">
            Searches Perplexity for specific catalysts across the next 1–3
            years (near-term through long-term). Excludes regular quarterly
            earnings (those are tracked separately as risk events).
          </div>
        ) : (
          <CatalystBody symbol={symbol} data={mod.output} onMutate={onMutate} />
        )}
      </div>
    </div>
  );
}

type HorizonFilter = "all" | CatalystHorizon;
type DirectionFilter = "all" | "bullish" | "bearish";

function scoreFromCatalysts(
  catalysts: CatalystEntry[],
): "rich" | "moderate" | "sparse" {
  const active = catalysts.filter((c) => !c.dismissed).length;
  if (active >= 4) return "rich";
  if (active >= 2) return "moderate";
  return "sparse";
}

function CatalystBody({
  symbol,
  data,
  onMutate,
}: {
  symbol: string;
  data: CatalystScanner;
  onMutate: (updater: (prev: CatalystScanner) => CatalystScanner) => void;
}) {
  const [horizonFilter, setHorizonFilter] = useState<HorizonFilter>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [showDismissed, setShowDismissed] = useState(false);

  const dismissedCount = data.catalysts.filter((c) => c.dismissed).length;
  const filtered = data.catalysts.filter((c) => {
    if (!showDismissed && c.dismissed) return false;
    if (horizonFilter !== "all" && c.horizon !== horizonFilter) return false;
    if (directionFilter !== "all" && c.impact_direction !== directionFilter)
      return false;
    return true;
  });

  async function setDismissed(id: string, dismissed: boolean) {
    onMutate((prev) => {
      const nextCatalysts = prev.catalysts.map((c) =>
        c.id === id ? { ...c, dismissed } : c,
      );
      return {
        ...prev,
        catalysts: nextCatalysts,
        overall_catalyst_score: scoreFromCatalysts(nextCatalysts),
      };
    });
    try {
      await fetch(
        `/api/research/${encodeURIComponent(symbol)}/catalyst-scanner`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, dismissed }),
          cache: "no-store",
        },
      );
    } catch {
      /* swallow — UI already reflects the change; next page load will resync */
    }
  }

  return (
    <>
      {data.summary && (
        <p className="italic text-foreground/90">{data.summary}</p>
      )}
      {data.catalysts.length === 0 ? (
        <div className="rounded border border-dashed border-border bg-background/40 p-4 text-muted-foreground">
          No specific catalysts identified across the next 1–3 years. Insider
          activity and technical setup are the primary signals.
        </div>
      ) : (
        <>
          <CatalystFilters
            horizon={horizonFilter}
            direction={directionFilter}
            onHorizonChange={setHorizonFilter}
            onDirectionChange={setDirectionFilter}
          />
          {filtered.length === 0 ? (
            <div className="rounded border border-dashed border-border bg-background/40 p-3 text-center text-muted-foreground">
              No catalysts match the current filters.
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((c, i) => (
                <CatalystCard
                  key={c.id ?? i}
                  catalyst={c}
                  onDismiss={
                    c.id ? () => setDismissed(c.id as string, true) : undefined
                  }
                  onRestore={
                    c.id
                      ? () => setDismissed(c.id as string, false)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          {dismissedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowDismissed((v) => !v)}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {showDismissed
                ? `Hide dismissed (${dismissedCount})`
                : `Show dismissed (${dismissedCount})`}
            </button>
          )}
        </>
      )}
      {data.next_earnings && (
        <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-amber-200">
          <div className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide">
            <CalendarClock className="h-3 w-3" />
            Earnings risk event (not a catalyst)
          </div>
          <div>
            Next earnings:{" "}
            <span className="font-mono">{fmtCalendar(data.next_earnings.date)}</span>
            {data.next_earnings.daysAway !== null && (
              <> ({data.next_earnings.daysAway} days)</>
            )}
          </div>
          <div className="text-[11px] text-amber-200/80">
            Binary event during potential hold period. Size position
            accordingly or plan to exit before this date.
          </div>
        </div>
      )}
    </>
  );
}

function impactPillClasses(direction: CatalystEntry["impact_direction"]): string {
  if (direction === "bullish")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (direction === "bearish")
    return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-300";
}
function horizonPillClasses(h: CatalystHorizon): string {
  if (h === "near_term")
    return "border-blue-500/40 bg-blue-500/15 text-blue-300";
  if (h === "medium_term")
    return "border-teal-500/40 bg-teal-500/15 text-teal-300";
  return "border-purple-500/40 bg-purple-500/15 text-purple-300";
}
function horizonLabel(h: CatalystHorizon): string {
  if (h === "near_term") return "NEAR TERM (0–3M)";
  if (h === "medium_term") return "MEDIUM TERM (3–12M)";
  return "LONG TERM (1–3Y)";
}
function magnitudePillClasses(mag: CatalystEntry["impact_magnitude"]): string {
  if (mag === "high") return "border-purple-500/40 bg-purple-500/15 text-purple-300";
  if (mag === "medium") return "border-blue-500/40 bg-blue-500/15 text-blue-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
}
function confidencePillClasses(conf: CatalystEntry["confidence"]): string {
  if (conf === "high") return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (conf === "medium") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
}

function CatalystFilters({
  horizon,
  direction,
  onHorizonChange,
  onDirectionChange,
}: {
  horizon: HorizonFilter;
  direction: DirectionFilter;
  onHorizonChange: (h: HorizonFilter) => void;
  onDirectionChange: (d: DirectionFilter) => void;
}) {
  const horizonOpts: Array<{ value: HorizonFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "near_term", label: "Near Term" },
    { value: "medium_term", label: "Medium Term" },
    { value: "long_term", label: "Long Term" },
  ];
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {horizonOpts.map((o) => {
          const active = horizon === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onHorizonChange(o.value)}
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                active
                  ? "border-foreground/60 bg-foreground/10 text-foreground"
                  : "border-border bg-background/40 text-muted-foreground hover:bg-background/60"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(["bullish", "bearish"] as const).map((d) => {
          const active = direction === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onDirectionChange(active ? "all" : d)}
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                active
                  ? d === "bullish"
                    ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                    : "border-rose-500/60 bg-rose-500/20 text-rose-200"
                  : "border-border bg-background/40 text-muted-foreground hover:bg-background/60"
              }`}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CatalystCard({
  catalyst: c,
  onDismiss,
  onRestore,
}: {
  catalyst: CatalystEntry;
  onDismiss?: () => void;
  onRestore?: () => void;
}) {
  return (
    <div
      className={`relative rounded border border-border bg-white/[0.02] p-2 ${
        c.dismissed ? "opacity-50" : ""
      }`}
    >
      {c.dismissed && onRestore ? (
        <button
          type="button"
          onClick={onRestore}
          title="Restore catalyst"
          className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" /> Restore
        </button>
      ) : !c.dismissed && onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss catalyst"
          className="absolute right-1.5 top-1.5 rounded border border-transparent p-0.5 text-muted-foreground hover:border-border hover:bg-background/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <div className="mb-1 flex flex-wrap items-center gap-2 pr-7">
        <Target className="h-3.5 w-3.5 text-emerald-300" />
        <span className="font-medium text-foreground">{c.title}</span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${horizonPillClasses(c.horizon)}`}
        >
          {horizonLabel(c.horizon)}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${impactPillClasses(c.impact_direction)}`}
        >
          {c.impact_direction}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${magnitudePillClasses(c.impact_magnitude)}`}
        >
          {c.impact_magnitude} impact
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidencePillClasses(c.confidence)}`}
        >
          {c.confidence} conf
        </span>
      </div>
      {c.expected_date && (
        <div className="mb-1 text-[11px] text-muted-foreground">
          Expected: <span className="text-foreground">{c.expected_date}</span>
        </div>
      )}
      <p className="text-foreground/90">{c.description}</p>
      {c.source_context && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          <span className="font-medium">Source context:</span> {c.source_context}
        </div>
      )}
      {(c.first_found_at || c.scan_count) && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          {c.first_found_at && (
            <span>First found: {fmtRelDate(c.first_found_at)}</span>
          )}
          {c.scan_count !== undefined && (
            <span>
              Confirmed in {c.scan_count} {c.scan_count === 1 ? "scan" : "scans"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Shared bits ----------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/30 pb-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function ComingSoon({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
      <div className="text-lg font-medium">{title} — Coming Soon</div>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        {blurb}
      </p>
    </div>
  );
}
