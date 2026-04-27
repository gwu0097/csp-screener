"use client";

// Sentiment tab — runs the sentiment module and renders insiders,
// institutional ownership, analyst consensus, retail tone, and the
// 0-10 score breakdown.

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

type InsiderTx = {
  name: string;
  action: string;
  transactionCode: string;
  shares: number;
  price: number;
  date: string;
  type: "buy" | "sell";
  dollarValue: number;
};

type Holder = { name: string; pctHeld: number | null };

type SentimentOutput = {
  sentiment_score: number;
  insider: {
    transactions: InsiderTx[];
    executiveBuys: InsiderTx[];
    netSentiment: "strong_bullish" | "bullish" | "neutral" | "bearish";
    totalBuyValue: number;
    totalSellValue: number;
  };
  institutional: {
    ownershipPct: number | null;
    insiderOwnershipPct: number | null;
    shortPercentFloat: number | null;
    top5Holders: Holder[];
  };
  analyst: {
    consensus: "strong_buy" | "buy" | "hold" | "sell" | "strong_sell" | null;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    recentUpgrades: number;
    recentDowngrades: number;
    netUpgrades: number;
  };
  retail: {
    sentiment: "bullish" | "bearish" | "mixed" | "neutral";
    bullCase: string | null;
    bearCase: string | null;
    trend: "improving" | "deteriorating" | "stable";
    notableAnalystMoves: string | null;
    summary: string | null;
  };
  overallScore: string;
  scoreBreakdown: Array<{ label: string; earned: number; max: number; detail: string }>;
};

type Module = {
  id: string;
  symbol: string;
  output: SentimentOutput;
  runAt: string;
} | null;

function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const SENTIMENT_COLOR: Record<string, string> = {
  very_bullish: "text-emerald-300",
  bullish: "text-emerald-300",
  mixed: "text-amber-300",
  neutral: "text-zinc-400",
  bearish: "text-rose-300",
  very_bearish: "text-rose-300",
};

export function SentimentTab({ symbol }: { symbol: string }) {
  const [mod, setMod] = useState<Module>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/sentiment`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as { module?: Module; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMod(json.module ?? null);
    } catch (e) {
      console.warn("[sentiment] load failed:", e);
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
        `/api/research/${encodeURIComponent(symbol)}/sentiment`,
        { method: "POST", cache: "no-store" },
      );
      const json = (await res.json()) as { module?: Module; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMod(json.module ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run sentiment");
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
      {mod ? <Body data={mod.output} /> : null}
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
          Sentiment overview
        </span>
        {mod ? (
          <>
            <span className="text-foreground">
              Score:{" "}
              <span className="font-mono font-semibold">
                {mod.output.sentiment_score}/10
              </span>
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                SENTIMENT_COLOR[mod.output.overallScore] ?? ""
              } border-current/40 bg-current/10`}
            >
              {mod.output.overallScore.replace("_", " ")}
            </span>
            <span className="text-muted-foreground">
              · {fmtDate(mod.runAt)}
            </span>
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

function Body({ data }: { data: SentimentOutput }) {
  return (
    <div className="space-y-4">
      {data.retail.summary && (
        <p className="italic text-foreground/90">{data.retail.summary}</p>
      )}
      <InsiderBlock data={data.insider} />
      <InstitutionalBlock data={data.institutional} />
      <AnalystBlock data={data.analyst} />
      <RetailBlock data={data.retail} />
      <BreakdownBlock breakdown={data.scoreBreakdown} score={data.sentiment_score} />
    </div>
  );
}

// ---------- Insider ----------

function netLabel(s: SentimentOutput["insider"]["netSentiment"]): {
  label: string;
  cls: string;
} {
  if (s === "strong_bullish")
    return { label: "STRONG BULLISH", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" };
  if (s === "bullish")
    return { label: "BULLISH", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" };
  if (s === "bearish")
    return { label: "BEARISH", cls: "border-rose-500/40 bg-rose-500/15 text-rose-300" };
  return { label: "NEUTRAL", cls: "border-zinc-500/40 bg-zinc-500/15 text-zinc-400" };
}

function InsiderBlock({ data }: { data: SentimentOutput["insider"] }) {
  const { label, cls } = netLabel(data.netSentiment);
  return (
    <div>
      <SectionLabel>Smart money (insiders)</SectionLabel>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>
          {label}
        </span>
        <span className="text-muted-foreground">
          {fmtMoney(data.totalBuyValue)} purchased ·{" "}
          {fmtMoney(data.totalSellValue)} sold ·{" "}
          {data.executiveBuys.length} exec{data.executiveBuys.length === 1 ? "" : "s"} buying
        </span>
      </div>
      {data.transactions.length === 0 ? (
        <div className="rounded border border-dashed border-border bg-background/40 p-3 text-muted-foreground">
          No insider transactions in the last 90 days.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="min-w-full text-[11px]">
            <thead className="bg-background/60">
              <tr>
                <th className="px-2 py-1 text-left font-medium text-muted-foreground">Insider</th>
                <th className="px-2 py-1 text-left font-medium text-muted-foreground">Action</th>
                <th className="px-2 py-1 text-right font-medium text-muted-foreground">Shares</th>
                <th className="px-2 py-1 text-right font-medium text-muted-foreground">Price</th>
                <th className="px-2 py-1 text-right font-medium text-muted-foreground">Value</th>
                <th className="px-2 py-1 text-right font-medium text-muted-foreground">Date</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.slice(0, 20).map((t, i) => {
                const buy = t.type === "buy" && t.transactionCode === "P";
                const sell = t.type === "sell" && t.transactionCode === "S";
                const cls = buy ? "text-emerald-300" : sell ? "text-rose-300" : "";
                return (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1 text-foreground">{t.name}</td>
                    <td className={`px-2 py-1 ${cls}`}>{t.action}</td>
                    <td className="px-2 py-1 text-right font-mono">
                      {t.shares.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      ${t.price.toFixed(2)}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono ${cls}`}>
                      {fmtMoney(t.dollarValue)}
                    </td>
                    <td className="px-2 py-1 text-right text-muted-foreground">
                      {fmtDate(t.date)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Institutional ----------

function InstitutionalBlock({ data }: { data: SentimentOutput["institutional"] }) {
  return (
    <div>
      <SectionLabel>Institutional ownership</SectionLabel>
      <div className="grid grid-cols-2 gap-2 rounded border border-border bg-background/40 p-2 text-[11px] sm:grid-cols-3">
        <KV label="Inst. owned" value={fmtPct(data.ownershipPct)} />
        <KV label="Insider owned" value={fmtPct(data.insiderOwnershipPct)} />
        <KV label="Short float" value={fmtPct(data.shortPercentFloat)} />
      </div>
      {data.top5Holders.length > 0 && (
        <div className="mt-2 rounded border border-border bg-background/30">
          <div className="border-b border-border px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
            Top holders
          </div>
          {data.top5Holders.map((h, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-2 py-1 text-[11px] last:rounded-b last:border-0"
            >
              <span className="truncate text-foreground">{h.name}</span>
              <span className="font-mono text-muted-foreground">
                {fmtPct(h.pctHeld)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-foreground">{value}</div>
    </div>
  );
}

// ---------- Analyst ----------

function AnalystBlock({ data }: { data: SentimentOutput["analyst"] }) {
  const total =
    data.strongBuy + data.buy + data.hold + data.sell + data.strongSell;
  const segments: Array<{ key: string; n: number; cls: string; label: string }> = [
    { key: "sb", n: data.strongBuy, cls: "bg-emerald-500/80", label: "Strong Buy" },
    { key: "b", n: data.buy, cls: "bg-emerald-500/50", label: "Buy" },
    { key: "h", n: data.hold, cls: "bg-zinc-500/60", label: "Hold" },
    { key: "s", n: data.sell, cls: "bg-rose-500/50", label: "Sell" },
    { key: "ss", n: data.strongSell, cls: "bg-rose-500/80", label: "Strong Sell" },
  ];
  return (
    <div>
      <SectionLabel>Analyst consensus</SectionLabel>
      {total === 0 ? (
        <div className="rounded border border-dashed border-border bg-background/40 p-3 text-muted-foreground">
          No analyst coverage on file.
        </div>
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded border border-border">
            {segments.map((s) => {
              const w = total > 0 ? (s.n / total) * 100 : 0;
              if (w === 0) return null;
              return (
                <div
                  key={s.key}
                  className={s.cls}
                  style={{ width: `${w}%` }}
                  title={`${s.label}: ${s.n}`}
                />
              );
            })}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {segments.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className={`inline-block h-2 w-2 ${s.cls}`} /> {s.label}: {s.n}
              </span>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-foreground">
            Current:{" "}
            <span className="font-semibold uppercase">
              {data.consensus ? data.consensus.replace("_", " ") : "—"}
            </span>{" "}
            · Recent (90d): +{data.recentUpgrades} upgrade
            {data.recentUpgrades === 1 ? "" : "s"}, −{data.recentDowngrades}{" "}
            downgrade{data.recentDowngrades === 1 ? "" : "s"}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Retail ----------

function RetailBlock({ data }: { data: SentimentOutput["retail"] }) {
  return (
    <div>
      <SectionLabel>Retail sentiment</SectionLabel>
      <div className="rounded border border-border bg-background/40 p-2 text-[11px]">
        <div className="text-foreground">
          Overall:{" "}
          <span className="font-semibold uppercase">{data.sentiment}</span>{" "}
          → {data.trend}
        </div>
        {data.bullCase && (
          <div className="mt-1">
            🐂 <span className="font-semibold text-emerald-300">Bulls:</span>{" "}
            <span className="text-foreground">{data.bullCase}</span>
          </div>
        )}
        {data.bearCase && (
          <div className="mt-1">
            🐻 <span className="font-semibold text-rose-300">Bears:</span>{" "}
            <span className="text-foreground">{data.bearCase}</span>
          </div>
        )}
        {data.notableAnalystMoves && (
          <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/[0.05] p-1.5 text-[10px] text-amber-200">
            <span className="font-semibold uppercase">Notable: </span>
            {data.notableAnalystMoves}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Score breakdown ----------

function BreakdownBlock({
  breakdown,
  score,
}: {
  breakdown: SentimentOutput["scoreBreakdown"];
  score: number;
}) {
  return (
    <div>
      <SectionLabel>Sentiment score breakdown ({score}/10)</SectionLabel>
      <div className="rounded border border-border bg-background/40">
        {breakdown.map((b, i) => {
          const pass = b.earned === b.max;
          const partial = b.earned > 0 && b.earned < b.max;
          const icon = pass ? "✅" : partial ? "⚠️" : "✗";
          return (
            <div
              key={i}
              className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-[11px] last:border-0"
            >
              <div className="flex flex-col">
                <span className="text-foreground">
                  {icon} {b.label}{" "}
                  <span className="font-mono text-muted-foreground">
                    {b.earned}/{b.max}
                  </span>
                </span>
                <span className="text-[10px] text-muted-foreground">{b.detail}</span>
              </div>
            </div>
          );
        })}
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
