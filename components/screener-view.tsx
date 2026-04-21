"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ScreenerResult } from "@/lib/screener";
import { LogTradeDialog } from "@/components/log-trade-dialog";

type Props = {
  connected: boolean;
};

type RunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; results: ScreenerResult[]; errors: string[]; ranAt: Date }
  | { status: "error"; message: string };

function recColor(rec: ScreenerResult["recommendation"]) {
  switch (rec) {
    case "Strong - Take the trade":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    case "Marginal - Size smaller":
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    case "Skip":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-slate-700/30 text-slate-300";
  }
}

function gradeColor(grade: string | null | undefined) {
  if (!grade) return "text-muted-foreground";
  if (grade === "A") return "text-emerald-300";
  if (grade === "B") return "text-sky-300";
  if (grade === "C") return "text-amber-300";
  return "text-rose-300";
}

function fmtNum(n: number | null | undefined, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function ScreenerView({ connected }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [logRow, setLogRow] = useState<ScreenerResult | null>(null);

  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }));

  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const isEarningsSeason = isLikelyEarningsSeason(new Date());

  async function runScreener() {
    setState({ status: "loading" });
    setExpanded({});
    try {
      const res = await fetch("/api/screener", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { errors?: string[] }).errors?.[0] ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { results: ScreenerResult[]; errors: string[] };
      setState({
        status: "ready",
        results: json.results ?? [],
        errors: json.errors ?? [],
        ranAt: new Date(),
      });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : "Screener failed" });
    }
  }

  const isLoading = state.status === "loading";
  const results = state.status === "ready" ? state.results : [];
  const errors = state.status === "ready" ? state.errors : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{today}</span>
          <Badge variant={isEarningsSeason ? "default" : "secondary"}>
            {isEarningsSeason ? "Earnings season" : "Off-cycle"}
          </Badge>
          <Badge variant={connected ? "default" : "destructive"}>
            Schwab: {connected ? "connected" : "disconnected"}
          </Badge>
          {state.status === "ready" && (
            <span className="text-xs text-muted-foreground">
              Last run: {state.ranAt.toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!connected && (
            <Button asChild variant="default">
              <a href="/api/auth/schwab">Connect Schwab</a>
            </Button>
          )}
          <Button
            variant={state.status === "idle" ? "default" : "outline"}
            disabled={isLoading}
            onClick={runScreener}
            size={state.status === "idle" ? "default" : "default"}
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            {isLoading ? "Running…" : state.status === "ready" ? "Run again" : "Run Screener"}
          </Button>
        </div>
      </div>

      {!connected && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          Schwab is not connected. The screener will still run Stage 1 and Stage 2 on industry/quality, but
          options-based stages require Schwab market data.
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> Screener failed
          </div>
          <div>{state.message}</div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> Partial data
          </div>
          <ul className="list-inside list-disc space-y-0.5">
            {errors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {state.status === "idle" && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-16 text-center">
          <Play className="mb-3 h-10 w-10 text-muted-foreground" />
          <h2 className="mb-1 text-lg font-semibold">Ready when you are</h2>
          <p className="mb-6 max-w-md text-sm text-muted-foreground">
            The screener pulls today&apos;s and tomorrow&apos;s earnings, runs all four scoring stages, and
            returns a ranked list. It takes a few seconds.
          </p>
          <Button size="lg" onClick={runScreener}>
            <Play className="mr-2 h-4 w-4" />
            Run Screener
          </Button>
        </div>
      )}

      {state.status === "loading" && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-background/40 px-6 py-16 text-center">
          <Loader2 className="mb-3 h-10 w-10 animate-spin text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            Fetching earnings calendar, options chains, and historical moves…
          </div>
        </div>
      )}

      {state.status === "ready" && (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Earnings</TableHead>
                <TableHead>DTE</TableHead>
                <TableHead>Crush</TableHead>
                <TableHead>Opp.</TableHead>
                <TableHead>Strike</TableHead>
                <TableHead>Premium</TableHead>
                <TableHead>Delta</TableHead>
                <TableHead>Spread</TableHead>
                <TableHead>Recommendation</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.length === 0 && (
                <TableRow>
                  <TableCell colSpan={13} className="py-10 text-center text-sm text-muted-foreground">
                    No qualifying earnings today or tomorrow.
                  </TableCell>
                </TableRow>
              )}
              {results.map((r) => {
                const id = `${r.symbol}-${r.earningsDate}`;
                const open = !!expanded[id];
                const actionable =
                  r.recommendation === "Strong - Take the trade" ||
                  r.recommendation === "Marginal - Size smaller";
                return (
                  <>
                    <TableRow key={id} className="cursor-pointer" onClick={() => toggle(id)}>
                      <TableCell>
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </TableCell>
                      <TableCell className="font-medium">{r.symbol}</TableCell>
                      <TableCell>${fmtNum(r.price)}</TableCell>
                      <TableCell className="text-xs">
                        {r.earningsDate} <span className="text-muted-foreground">· {r.earningsTiming}</span>
                      </TableCell>
                      <TableCell>{r.daysToExpiry}</TableCell>
                      <TableCell className={cn("font-mono", gradeColor(r.stageThree?.crushGrade))}>
                        {r.stageThree?.crushGrade ?? "—"}
                      </TableCell>
                      <TableCell className={cn("font-mono", gradeColor(r.stageFour?.opportunityGrade))}>
                        {r.stageFour?.opportunityGrade ?? "—"}
                      </TableCell>
                      <TableCell>{r.stageFour?.suggestedStrike ? `$${fmtNum(r.stageFour.suggestedStrike)}` : "—"}</TableCell>
                      <TableCell>{r.stageFour?.premium !== null && r.stageFour?.premium !== undefined ? `$${fmtNum(r.stageFour.premium)}` : "—"}</TableCell>
                      <TableCell>{fmtNum(r.stageFour?.delta ?? null, 3)}</TableCell>
                      <TableCell>{r.stageFour?.bidAskSpreadPct !== null && r.stageFour?.bidAskSpreadPct !== undefined ? `${fmtNum(r.stageFour.bidAskSpreadPct, 1)}%` : "—"}</TableCell>
                      <TableCell>
                        <span className={cn("rounded-md border px-2 py-0.5 text-xs", recColor(r.recommendation))}>
                          {r.recommendation}
                        </span>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {actionable && r.stageFour?.suggestedStrike ? (
                          <Button size="sm" variant="secondary" onClick={() => setLogRow(r)}>
                            Log trade
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow key={`${id}-detail`}>
                        <TableCell colSpan={13} className="bg-muted/30">
                          <ExpandedDetail r={r} />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {logRow && (
        <LogTradeDialog
          row={logRow}
          open={!!logRow}
          onOpenChange={(o) => !o && setLogRow(null)}
          onSuccess={() => {
            setLogRow(null);
            // Trade log is separate from the screener run; refresh /history if we're there.
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function ExpandedDetail({ r }: { r: ScreenerResult }) {
  return (
    <div className="grid gap-4 p-3 md:grid-cols-4">
      <StageCard title="Stage 1 · Hard filters" pass={r.stageOne.pass} summary={r.stageOne.reason}>
        {Object.entries(r.stageOne.details).map(([k, v]) => (
          <Row key={k} k={k} v={String(v ?? "—")} />
        ))}
      </StageCard>

      <StageCard
        title="Stage 2 · Quality"
        pass={r.stageTwo?.pass ?? false}
        summary={r.stageTwo ? `${r.stageTwo.score}/9 — ${r.stageTwo.reason}` : "not reached"}
      >
        {r.stageTwo && (
          <>
            <Row k="Business simplicity" v={`${r.stageTwo.details.businessSimplicity}/3`} />
            <Row k="Market cap tier" v={`${r.stageTwo.details.marketCapTier}/3`} />
            <Row k="Analyst dispersion" v={`${r.stageTwo.details.analystDispersion}/3`} />
            <Row k="Overhang penalty" v={String(r.stageTwo.details.activeOverhangPenalty)} />
            <Row k="Market cap" v={r.stageTwo.details.marketCapBillions ? `$${r.stageTwo.details.marketCapBillions.toFixed(1)}B` : "—"} />
            <Row k="Industry class" v={r.stageTwo.details.industryClass} />
          </>
        )}
      </StageCard>

      <StageCard
        title="Stage 3 · Crush"
        pass={r.stageThree?.pass ?? false}
        summary={r.stageThree ? `${r.stageThree.score}/25 — grade ${r.stageThree.crushGrade} (threshold ${r.stageThree.threshold})` : "not reached"}
      >
        {r.stageThree && (
          <>
            <Row k="Historical move" v={`${r.stageThree.details.historicalMoveScore}/8`} />
            <Row k="Consistency" v={`${r.stageThree.details.consistencyScore}/4`} />
            <Row k="Term structure" v={`${r.stageThree.details.termStructureScore}/5`} />
            <Row k="IV edge" v={`${r.stageThree.details.ivEdgeScore}/4`} />
            <Row k="Surprise reliability" v={`${r.stageThree.details.surpriseScore}/4`} />
            <Row k="Median move" v={r.stageThree.details.medianHistoricalMovePct !== null ? `${(r.stageThree.details.medianHistoricalMovePct * 100).toFixed(2)}%` : "—"} />
            <Row k="EM" v={r.stageThree.details.expectedMovePct !== null ? `${(r.stageThree.details.expectedMovePct * 100).toFixed(2)}%` : "—"} />
            <Row k="Weekly IV" v={r.stageThree.details.weeklyIv !== null ? `${(r.stageThree.details.weeklyIv * 100).toFixed(1)}%` : "—"} />
            <Row k="Monthly IV" v={r.stageThree.details.monthlyIv !== null ? `${(r.stageThree.details.monthlyIv * 100).toFixed(1)}%` : "—"} />
            <Row k="30d realized" v={r.stageThree.details.realizedVol30d !== null ? `${(r.stageThree.details.realizedVol30d * 100).toFixed(1)}%` : "—"} />
          </>
        )}
      </StageCard>

      <StageCard
        title="Stage 4 · Opportunity"
        pass={(r.stageFour?.score ?? 0) >= 8}
        summary={r.stageFour ? `${r.stageFour.score}/20 — grade ${r.stageFour.opportunityGrade}` : "not reached"}
      >
        {r.stageFour && (
          <>
            <Row k="Premium yield" v={`${r.stageFour.details.premiumYieldScore}/8 (${r.stageFour.premiumYieldPct !== null ? r.stageFour.premiumYieldPct.toFixed(2) + "%" : "—"})`} />
            <Row k="Delta" v={`${r.stageFour.details.deltaScore}/6 (${r.stageFour.delta ?? "—"})`} />
            <Row k="Spread" v={`${r.stageFour.details.spreadScore}/6 (${r.stageFour.bidAskSpreadPct !== null ? r.stageFour.bidAskSpreadPct + "%" : "—"})`} />
            <Row k="Contract" v={r.stageFour.details.contractSymbol ?? "—"} />
          </>
        )}
      </StageCard>
    </div>
  );
}

function StageCard({ title, pass, summary, children }: { title: string; pass: boolean; summary: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-medium text-foreground">{title}</div>
        <span className={cn("rounded border px-1.5 py-0.5", pass ? "border-emerald-500/40 text-emerald-300" : "border-rose-500/40 text-rose-300")}>
          {pass ? "pass" : "fail"}
        </span>
      </div>
      <div className="mb-2 text-muted-foreground">{summary}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono text-foreground">{v}</span>
    </div>
  );
}

function isLikelyEarningsSeason(d: Date): boolean {
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  // Peak windows: mid-Jan–mid-Feb, mid-Apr–mid-May, mid-Jul–mid-Aug, mid-Oct–mid-Nov.
  const in15to15 = (m1: number, m2: number) => {
    if (month === m1 && day >= 15) return true;
    if (month === m2 && day <= 15) return true;
    return false;
  };
  return in15to15(1, 2) || in15to15(4, 5) || in15to15(7, 8) || in15to15(10, 11);
}
