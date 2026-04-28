"use client";

// 10-K tab content — unified SEC filings view that surfaces the latest
// 8-K earnings release (extracted into structured fields), the recent
// 10-Q quarterlies pulled from the existing fundamental-health module,
// and an Annual Report (10-K) placeholder until Phase 2 ships the
// deep-read distillation.

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EarningsReleaseRow } from "@/app/api/research/[symbol]/earnings-releases/route";

type QuarterlyMetrics = {
  fiscalLabel: string;
  fiscalYear: number;
  fiscalQuarter: 1 | 2 | 3 | 4;
  periodEnd: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
};

type HealthModule = {
  output?: {
    quarterly?: QuarterlyMetrics[];
  } | null;
} | null;

function fmtMillions(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}B`;
  return `$${n.toFixed(0)}M`;
}

function fmtPct(n: number | null | undefined, signed = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = signed ? (n >= 0 ? "+" : "") : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00Z");
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00Z");
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function pctColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return "text-muted-foreground";
  }
  return n >= 0 ? "text-emerald-300" : "text-rose-300";
}

export function SecFilingsTab({
  symbol,
  healthMod,
  onRefreshHealth,
}: {
  symbol: string;
  healthMod: HealthModule;
  // Optional callback to re-run the fundamental-health POST and update
  // the parent's healthMod state. Drives the "Refresh" button next to
  // the Quarterly Reports header — needed when an EDGAR-side fix to
  // the extractor (e.g. the endYear keying patch) hasn't taken effect
  // for cached saved modules yet.
  onRefreshHealth?: () => Promise<void>;
}) {
  const [releases, setReleases] = useState<EarningsReleaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [refreshingHealth, setRefreshingHealth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/earnings-releases`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as
        | { releases: EarningsReleaseRow[] }
        | { error: string };
      if (!res.ok || !("releases" in json)) {
        setError("error" in json ? json.error : `HTTP ${res.status}`);
        return;
      }
      setReleases(json.releases);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  async function fetchLatest() {
    setFetching(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/fetch-8k`,
        { method: "POST", cache: "no-store" },
      );
      const json = (await res.json()) as
        | { ok: true; quarter: string; filingDate: string }
        | { error: string };
      if (!res.ok || !("ok" in json)) {
        setError("error" in json ? json.error : `HTTP ${res.status}`);
        return;
      }
      setMessage(`Loaded ${json.quarter} from 8-K filed ${fmtDate(json.filingDate)}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setFetching(false);
    }
  }

  // Quarterly (10-Q) data is reused from the existing fundamental-health
  // module — no extra API call. Newest first by periodEnd. If the
  // dates look wrong, the saved module pre-dates the endYear keying
  // patch — Refresh button at the section header re-runs the extractor.
  const quarterly = (healthMod?.output?.quarterly ?? [])
    .slice()
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  // Index for YoY revenue growth lookup — match (fiscalYear − 1, same
  // fiscalQuarter) to compute (current − prior) / prior.
  const quarterlyByKey = new Map(
    quarterly.map((q) => [`${q.fiscalYear}|${q.fiscalQuarter}`, q]),
  );

  return (
    <div className="space-y-4">
      {/* ---------- Earnings Releases (8-K) ---------- */}
      <section className="rounded-md border border-border bg-background/40 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Earnings releases (8-K)
            </div>
            <div className="text-[11px] text-muted-foreground/80">
              Quarterly results extracted from the press-release exhibit (99.1)
              of the most recent 8-K.
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void fetchLatest()}
            disabled={fetching}
          >
            {fetching ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Fetching…
              </>
            ) : (
              <>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Fetch latest 8-K
              </>
            )}
          </Button>
        </div>

        {message && (
          <div className="mb-2 rounded border border-emerald-500/40 bg-emerald-500/10 p-1.5 text-[11px] text-emerald-200">
            {message}
          </div>
        )}
        {error && (
          <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[11px] text-rose-200">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : releases.length === 0 ? (
          <div className="rounded border border-dashed border-border p-3 text-[11px] text-muted-foreground">
            No earnings releases stored for {symbol} yet. Click{" "}
            <span className="font-medium">Fetch latest 8-K</span> to pull the
            most recent press release from EDGAR.
          </div>
        ) : (
          <div className="space-y-2">
            {releases.map((r) => (
              <ReleaseCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </section>

      {/* ---------- Quarterly Reports (10-Q) ---------- */}
      <section className="rounded-md border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Quarterly reports (10-Q)
            </div>
            <div className="text-[11px] text-muted-foreground/80">
              Pulled from EDGAR companyfacts in the fundamental-health
              module. If the period-end dates look wrong, click Refresh to
              re-run the extractor.
            </div>
          </div>
          {onRefreshHealth && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refreshingHealth}
              onClick={async () => {
                setRefreshingHealth(true);
                setError(null);
                try {
                  await onRefreshHealth();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Refresh failed");
                } finally {
                  setRefreshingHealth(false);
                }
              }}
            >
              {refreshingHealth ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Refreshing…
                </>
              ) : (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh
                </>
              )}
            </Button>
          )}
        </div>
        {!healthMod?.output ? (
          <div className="text-[11px] text-muted-foreground">
            Run the Fundamental Health module to populate quarterly data.
          </div>
        ) : quarterly.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">
            No quarterly EDGAR data available for {symbol} (foreign filers
            typically only have annual data).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border/50">
                  <th className="px-1.5 py-1 text-left font-medium">Quarter</th>
                  <th className="px-1.5 py-1 text-right font-medium">Revenue</th>
                  <th className="px-1.5 py-1 text-right font-medium">
                    Rev growth
                  </th>
                  <th className="px-1.5 py-1 text-right font-medium">EPS</th>
                  <th className="px-1.5 py-1 text-right font-medium">
                    Period end
                  </th>
                </tr>
              </thead>
              <tbody>
                {quarterly.map((q) => {
                  const prior = quarterlyByKey.get(
                    `${q.fiscalYear - 1}|${q.fiscalQuarter}`,
                  );
                  const growth =
                    q.revenue !== null &&
                    prior?.revenue !== null &&
                    prior?.revenue !== undefined &&
                    prior.revenue > 0
                      ? (q.revenue - prior.revenue) / prior.revenue
                      : null;
                  return (
                    <tr key={q.periodEnd} className="border-b border-border/30">
                      <td className="px-1.5 py-1 font-mono">{q.fiscalLabel}</td>
                      <td className="px-1.5 py-1 text-right font-mono">
                        {q.revenue === null
                          ? "—"
                          : fmtMillions(q.revenue / 1_000_000)}
                      </td>
                      <td
                        className={`px-1.5 py-1 text-right font-mono ${
                          growth === null
                            ? "text-muted-foreground"
                            : growth >= 0
                              ? "text-emerald-300"
                              : "text-rose-300"
                        }`}
                      >
                        {growth === null
                          ? "—"
                          : `${growth >= 0 ? "+" : ""}${(growth * 100).toFixed(1)}%`}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono">
                        {q.eps === null ? "—" : `$${q.eps.toFixed(2)}`}
                      </td>
                      <td className="px-1.5 py-1 text-right font-mono text-muted-foreground">
                        {fmtMonthYear(q.periodEnd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-2 text-[10px] text-muted-foreground/80">
              Note: a 10-Q filing typically lands ~45 days after the quarter
              end. Q4 is reported on the 10-K instead of a separate 10-Q.
            </div>
          </div>
        )}
      </section>

      {/* ---------- Annual Report (10-K) ---------- */}
      <section className="rounded-md border border-border bg-background/40 p-3">
        <div className="mb-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Annual report (10-K)
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Deep read coming soon — risk factors, MD&amp;A highlights, and
          segment financials from the latest annual filing.
        </div>
      </section>
    </div>
  );
}

function ReleaseCard({ r }: { r: EarningsReleaseRow }) {
  const archiveHref =
    r.accession_number !== null
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=&CIK=${r.symbol}&type=8-K&dateb=&owner=include&count=10`
      : null;
  const km = (r.raw_metrics ?? {}) as Record<string, unknown>;
  // Adj EBITDA fallback when GAAP op_income isn't disclosed (common
  // for fintech / consumer issuers like HOOD that report
  // "Adjusted EBITDA (non-GAAP)" in the press release headline).
  const adjEbitda =
    typeof km.adj_ebitda === "number" ? (km.adj_ebitda as number) : null;
  const adjEbitdaGrowth =
    typeof km.adj_ebitda_growth_pct === "number"
      ? (km.adj_ebitda_growth_pct as number)
      : null;
  const useAdjEbitda = r.op_income === null && adjEbitda !== null;
  // Render raw_metrics inline but skip the keys we already surface in
  // the headline grid so the secondary line doesn't duplicate.
  const SUPPRESSED = new Set(["adj_ebitda", "adj_ebitda_growth_pct"]);
  const rawEntries = Object.entries(km)
    .filter(([k]) => !SUPPRESSED.has(k))
    .slice(0, 4);

  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">
          {r.quarter}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            Reported {fmtDate(r.reported_date)} · period end{" "}
            {fmtDate(r.period_end)}
          </span>
        </div>
        {archiveHref && (
          <a
            href={archiveHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            EDGAR
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] sm:grid-cols-4">
        <Stat label="Revenue" value={fmtMillions(r.revenue)} />
        <Stat
          label="Rev growth"
          value={fmtPct(r.revenue_growth_pct)}
          valueClass={pctColor(r.revenue_growth_pct)}
        />
        <Stat
          label="Net income"
          value={fmtMillions(r.net_income)}
          valueClass={
            r.net_income !== null && r.net_income < 0 ? "text-rose-300" : ""
          }
        />
        <Stat
          label="EPS (diluted)"
          value={r.eps_diluted === null ? "—" : `$${r.eps_diluted.toFixed(2)}`}
          valueClass={
            r.eps_diluted !== null && r.eps_diluted < 0 ? "text-rose-300" : ""
          }
        />
        {useAdjEbitda ? (
          <Stat
            label="Adj EBITDA"
            value={fmtMillions(adjEbitda)}
          />
        ) : (
          <Stat label="Op income" value={fmtMillions(r.op_income)} />
        )}
        {useAdjEbitda ? (
          <Stat
            label="EBITDA growth"
            value={fmtPct(adjEbitdaGrowth)}
            valueClass={pctColor(adjEbitdaGrowth)}
          />
        ) : (
          <Stat
            label="Op margin"
            value={fmtPct(r.op_margin_pct, false)}
            valueClass="text-foreground"
          />
        )}
        <Stat
          label="Net margin"
          value={fmtPct(r.net_margin_pct, false)}
          valueClass="text-foreground"
        />
        <Stat
          label="Source"
          value={r.source ?? "8-K"}
          valueClass="text-muted-foreground"
        />
      </div>

      {rawEntries.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          {rawEntries.map(([k, v]) => (
            <span key={k}>
              <span className="text-muted-foreground/70">
                {k.replace(/_/g, " ")}:
              </span>{" "}
              <span className="font-mono text-foreground/90">
                {typeof v === "number" ? v.toLocaleString() : String(v)}
              </span>
            </span>
          ))}
        </div>
      )}

      {r.guidance_notes && (
        <div className="mt-3 rounded border border-border/60 bg-background/40 p-2">
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Guidance
          </div>
          <div className="text-[11px] text-foreground/90">
            {r.guidance_notes}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={valueClass ?? "text-foreground"}>{value}</span>
    </div>
  );
}
