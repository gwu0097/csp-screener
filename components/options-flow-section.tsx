"use client";

// OPTIONS FLOW section in the expanded screener row. Renders the data
// stamped on stageThree.details.optionsFlow by runStagesThreeFour. Hides
// itself entirely when flow is null (chain fetch failed).

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OptionsFlow } from "@/lib/options-flow";

const TOOLTIP_COPY = `OPTIONS FLOW shows how traders are positioning before earnings.

P/C Ratio: put volume / call volume
  < 0.8 = more calls than puts (bullish flow)
  > 1.3 = more puts than calls (bearish flow)
  1.0–1.3 = neutral / balanced

Unusual activity: strikes where today's volume is 3× the open interest — these are new positions being opened, not existing trades changing hands.

Deep OTM put cluster: heavy put buying far below current price. Usually means institutions buying cheap tail-risk insurance before earnings — they don't expect a crash, just want protection.

For CSP sellers: unusual CALL activity at high strikes = smart money betting on upside (good for put sellers). Unusual PUT activity near your strike = someone buying protection at exactly where you're selling (adds context to your risk).`;

function biasBadgeCls(bias: OptionsFlow["flowBias"]): string {
  if (bias === "bullish")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (bias === "bearish")
    return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  return "border-zinc-500/30 bg-zinc-500/10 text-muted-foreground";
}

function noteCls(note: string): string {
  if (note === "tail hedge") return "text-rose-200";
  if (note === "ATM hedge") return "text-rose-300";
  if (note === "directional bet") return "text-emerald-300";
  if (note === "upside lottery") return "text-emerald-200";
  return "text-muted-foreground";
}

export function OptionsFlowSection({ flow }: { flow: OptionsFlow | null }) {
  if (!flow) return null;

  const unusual = flow.unusualStrikes.slice(0, 6);
  const cluster = flow.deepOtmPutCluster;
  const clusterElevated =
    cluster.pctOfTotalPutVolume > 25;
  const clusterCls = clusterElevated
    ? "border-amber-500/40 bg-amber-500/10"
    : "border-emerald-500/30 bg-emerald-500/[0.05]";

  const ys = flow.yourStrikeFlow;

  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Options flow</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label="What is options flow?"
            >
              <Info className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            className="max-w-sm whitespace-pre-line text-[11px] leading-snug"
          >
            {TOOLTIP_COPY}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* P/C ratio header card */}
      <div className="grid gap-3 rounded border border-border bg-background/60 p-2 md:grid-cols-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">P/C Ratio</span>
          <span className="font-mono text-sm font-semibold text-foreground">
            {flow.putCallRatio.toFixed(2)}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${biasBadgeCls(flow.flowBias)}`}
          >
            {flow.flowBias}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Put OI / Call OI</span>
          <span className="font-mono text-sm text-foreground">
            {flow.putCallOI.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center justify-end gap-3 text-[10px] text-muted-foreground">
          <span>
            Call vol{" "}
            <span className="font-mono text-foreground">
              {flow.callVolume.toLocaleString()}
            </span>
          </span>
          <span>
            Put vol{" "}
            <span className="font-mono text-foreground">
              {flow.putVolume.toLocaleString()}
            </span>
          </span>
        </div>
      </div>

      {/* Unusual activity */}
      <div className="mt-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Unusual activity (vol/OI &gt; 3×)
        </div>
        {unusual.length === 0 ? (
          <div className="rounded border border-border bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
            No strikes with unusual volume today.
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-border">
            <table className="min-w-full text-[11px]">
              <thead className="bg-background/60">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                    Type
                  </th>
                  <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                    Strike
                  </th>
                  <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                    Volume
                  </th>
                  <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                    OI
                  </th>
                  <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                    Ratio
                  </th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                    Note
                  </th>
                </tr>
              </thead>
              <tbody>
                {unusual.map((s) => {
                  const typeCls =
                    s.type === "call" ? "text-emerald-300" : "text-rose-300";
                  return (
                    <tr
                      key={`${s.type}-${s.strike}`}
                      className="border-t border-border"
                    >
                      <td
                        className={`px-2 py-1 font-mono font-semibold ${typeCls}`}
                      >
                        {s.type.toUpperCase()}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        ${s.strike}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.volume.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                        {s.oi.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.volOiRatio.toFixed(1)}×
                      </td>
                      <td
                        className={`px-2 py-1 text-[10px] ${noteCls(s.note)}`}
                      >
                        {s.note}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Your strike */}
      {ys && (
        <div className="mt-3 rounded border border-border bg-background/60 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Your strike{" "}
            <span className="font-mono text-foreground">${ys.strike}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span>
              Volume{" "}
              <span className="font-mono text-foreground">
                {ys.volume.toLocaleString()}
              </span>
            </span>
            <span className="text-muted-foreground">
              OI{" "}
              <span className="font-mono text-foreground">
                {ys.oi.toLocaleString()}
              </span>
            </span>
            <span className="text-muted-foreground">
              Ratio{" "}
              <span className="font-mono text-foreground">
                {ys.volOiRatio === null
                  ? "—"
                  : `${ys.volOiRatio.toFixed(1)}×`}
              </span>
            </span>
            <span className="text-muted-foreground">
              Mark{" "}
              <span className="font-mono text-foreground">
                ${ys.mark.toFixed(2)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Delta{" "}
              <span className="font-mono text-foreground">
                {ys.delta.toFixed(2)}
              </span>
            </span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground italic">
            {ys.interpretation}
          </div>
        </div>
      )}

      {/* Deep-OTM put cluster */}
      <div className={`mt-3 rounded border p-2 ${clusterCls}`}>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Deep OTM put cluster
        </div>
        <div className="text-[11px] text-foreground">
          <span className="font-semibold">
            {cluster.pctOfTotalPutVolume.toFixed(0)}%
          </span>{" "}
          of put volume between{" "}
          <span className="font-mono">${cluster.lowerStrike.toFixed(0)}</span>{" "}
          and{" "}
          <span className="font-mono">${cluster.upperStrike.toFixed(0)}</span>{" "}
          (1× to 2.5× EM below spot)
        </div>
        <div
          className={`mt-1 text-[10px] italic ${clusterElevated ? "text-amber-200" : "text-emerald-300/80"}`}
        >
          {clusterElevated
            ? "⚠️ "
            : "✓ "}
          {cluster.interpretation}
        </div>
      </div>
    </div>
  );
}
