"use client";

// Risk tab — runs the risk module and renders an impact × probability
// matrix, the per-risk list (sorted by severity), and recent 8-K
// filings from EDGAR.

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";

type RiskCategory =
  | "business"
  | "financial"
  | "management"
  | "sector"
  | "macro"
  | "valuation";
type Probability = "high" | "medium" | "low";
type Impact = "high" | "medium" | "low";

type Risk = {
  category: RiskCategory;
  title: string;
  description: string;
  probability: Probability;
  impact: Impact;
  priced_in: boolean;
  mitigation: string | null;
};

type EightK = {
  filing_date: string;
  description: string | null;
  url: string | null;
};

export type RiskOutput = {
  risks: Risk[];
  overall_risk_level: "high" | "medium" | "low";
  risk_score: number;
  biggest_risk: string | null;
  key_risk_to_monitor: string | null;
  summary: string | null;
  recent_8k_filings: EightK[];
};

type Module = {
  id: string;
  symbol: string;
  output: RiskOutput;
  runAt: string;
} | null;

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function severityScore(r: Risk): number {
  if (r.probability === "high" && r.impact === "high") return 3;
  if (r.probability === "high" && r.impact === "medium") return 2;
  if (r.probability === "medium" && r.impact === "high") return 2;
  return 1;
}

function severityClass(r: Risk): string {
  const s = severityScore(r);
  if (s === 3) return "border-rose-500/60 bg-rose-500/[0.06]";
  if (s === 2) return "border-amber-500/60 bg-amber-500/[0.05]";
  return "border-zinc-500/40 bg-background/40";
}

function levelPill(l: "high" | "medium" | "low"): string {
  if (l === "high") return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  if (l === "medium") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
}

const CATEGORY_LABEL: Record<RiskCategory, string> = {
  business: "BUSINESS",
  financial: "FINANCIAL",
  management: "MANAGEMENT",
  sector: "SECTOR",
  macro: "MACRO",
  valuation: "VALUATION",
};

export function RiskTab({ symbol }: { symbol: string }) {
  const [mod, setMod] = useState<Module>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/risk`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as { module?: Module; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMod(json.module ?? null);
    } catch (e) {
      console.warn("[risk] load failed:", e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/risk`,
        { method: "POST", cache: "no-store" },
      );
      const json = (await res.json()) as { module?: Module; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMod(json.module ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run risk module");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-background/30 p-3 text-xs">
      <Header
        loading={loading}
        running={running}
        mod={mod}
        onRun={run}
        error={error}
      />
      {mod ? <RiskBody data={mod.output} /> : null}
    </div>
  );
}

function Header({
  loading,
  running,
  mod,
  onRun,
  error,
}: {
  loading: boolean;
  running: boolean;
  mod: Module;
  onRun: () => void;
  error: string | null;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Risk assessment
        </span>
        {mod ? (
          <>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${levelPill(mod.output.overall_risk_level)}`}
            >
              {mod.output.overall_risk_level}
            </span>
            <span className="text-foreground">
              <span className="font-mono">{mod.output.risk_score}</span> pts
            </span>
            <span className="text-muted-foreground">· {fmtDate(mod.runAt)}</span>
          </>
        ) : (
          !loading && (
            <span className="text-muted-foreground">Not yet run.</span>
          )
        )}
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={running}
        className="inline-flex items-center gap-1 rounded border border-border bg-background/40 px-2 py-1 text-xs hover:bg-background/60 disabled:opacity-60"
      >
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
        {mod ? "Re-run" : "Run module"}
      </button>
      {error && (
        <div className="basis-full rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}

export function RiskBody({ data }: { data: RiskOutput }) {
  const sorted = useMemo(
    () => [...data.risks].sort((a, b) => severityScore(b) - severityScore(a)),
    [data.risks],
  );
  return (
    <div className="space-y-4">
      {data.summary && <p className="italic text-foreground/90">{data.summary}</p>}
      {(data.biggest_risk || data.key_risk_to_monitor) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.biggest_risk && (
            <div className="rounded border border-rose-500/30 bg-rose-500/[0.05] p-2 text-[11px]">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-300/80">
                Biggest risk
              </div>
              <div className="mt-0.5 text-foreground">{data.biggest_risk}</div>
            </div>
          )}
          {data.key_risk_to_monitor && (
            <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] p-2 text-[11px]">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-300/80">
                Key signal to monitor
              </div>
              <div className="mt-0.5 text-foreground">
                {data.key_risk_to_monitor}
              </div>
            </div>
          )}
        </div>
      )}
      <RiskMatrix risks={data.risks} />
      <RiskList risks={sorted} />
      <EightKBlock filings={data.recent_8k_filings} />
    </div>
  );
}

// ---------- Matrix ----------

function RiskMatrix({ risks }: { risks: Risk[] }) {
  // Group by (impact, probability) cell.
  const cells = new Map<string, Risk[]>();
  for (const r of risks) {
    const key = `${r.impact}|${r.probability}`;
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(r);
  }

  const probs: Probability[] = ["low", "medium", "high"];
  const impacts: Impact[] = ["high", "medium", "low"]; // top → high

  function cellCls(impact: Impact, prob: Probability): string {
    const high =
      (impact === "high" && (prob === "high" || prob === "medium")) ||
      (impact === "medium" && prob === "high");
    const med =
      (impact === "high" && prob === "low") ||
      (impact === "medium" && prob === "medium") ||
      (impact === "low" && prob === "high");
    if (high) return "bg-rose-500/15 border-rose-500/30";
    if (med) return "bg-amber-500/10 border-amber-500/30";
    return "bg-emerald-500/5 border-emerald-500/20";
  }

  return (
    <div>
      <SectionLabel>Risk matrix</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
              {probs.map((p) => (
                <th
                  key={p}
                  className="px-2 py-1 text-center font-medium uppercase text-muted-foreground"
                >
                  Prob {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {impacts.map((imp) => (
              <tr key={imp} className="border-t border-border">
                <td className="bg-background/60 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Impact {imp}
                </td>
                {probs.map((p) => {
                  const arr = cells.get(`${imp}|${p}`) ?? [];
                  return (
                    <td
                      key={p}
                      className={`min-w-[7rem] border-l border-border px-2 py-2 align-top ${cellCls(imp, p)}`}
                    >
                      {arr.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground/60">
                          —
                        </span>
                      ) : (
                        <div className="space-y-1">
                          {arr.map((r, i) => (
                            <div
                              key={i}
                              title={r.description}
                              className="cursor-help truncate rounded border border-foreground/20 bg-background/60 px-1.5 py-0.5 text-[10px] text-foreground"
                            >
                              ● {r.title}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- List ----------

function RiskList({ risks }: { risks: Risk[] }) {
  if (risks.length === 0) {
    return (
      <div className="rounded border border-dashed border-border bg-background/40 p-3 text-muted-foreground">
        No risks identified.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <SectionLabel>Risks ({risks.length})</SectionLabel>
      {risks.map((r, i) => (
        <RiskCard key={i} risk={r} />
      ))}
    </div>
  );
}

function RiskCard({ risk: r }: { risk: Risk }) {
  return (
    <div className={`rounded border p-2 ${severityClass(r)}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-foreground">⚠️</span>
        <span className="font-medium text-foreground">{r.title}</span>
        <span className="rounded border border-border bg-background/60 px-1 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
          {CATEGORY_LABEL[r.category]}
        </span>
        <span className="text-[10px] text-muted-foreground">
          Prob:{" "}
          <span className="font-semibold uppercase text-foreground">
            {r.probability}
          </span>{" "}
          · Impact:{" "}
          <span className="font-semibold uppercase text-foreground">
            {r.impact}
          </span>
        </span>
        {r.priced_in ? (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-300">
            priced in
          </span>
        ) : (
          <span className="rounded border border-rose-500/40 bg-rose-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-rose-300">
            not priced in
          </span>
        )}
      </div>
      <p className="text-foreground/90">{r.description}</p>
      {r.mitigation && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          <span className="font-semibold">Mitigation:</span> {r.mitigation}
        </div>
      )}
    </div>
  );
}

// ---------- 8-K ----------

function EightKBlock({ filings }: { filings: EightK[] }) {
  if (filings.length === 0) return null;
  return (
    <div>
      <SectionLabel>Recent 8-K filings (90 days)</SectionLabel>
      <div className="rounded border border-border bg-background/40">
        {filings.map((f, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-[11px] last:border-0"
          >
            <div className="flex flex-col">
              <span className="font-mono text-foreground">{fmtDate(f.filing_date)}</span>
              {f.description && (
                <span className="text-[10px] text-muted-foreground">
                  {f.description}
                </span>
              )}
            </div>
            {f.url && (
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-emerald-300 hover:underline"
              >
                EDGAR <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
