"use client";

// Tier 1 — P/E Multiple model. Shows every intermediate calculation so
// the math is verifiable: rev y1/y2/y3, op income y3, net income y3,
// EPS y1/y2/y3, price target, return, implied market cap.

import { useMemo, useState } from "react";
import {
  computeTier1All,
  SCENARIOS,
  type ScenarioInputs,
  type ScenarioKey,
  type ScenarioSet,
  type ValuationModelV2,
} from "@/lib/valuation";
import { CalcCell, CellLegend, EditableCell } from "@/components/valuation-cell";
import {
  fmtBigDollars,
  fmtPct,
  fmtPrice,
  fmtRoundPrice,
  fmtSignedPct,
} from "@/components/valuation-format";
import { LabelWithTooltip } from "@/components/valuation-label";
import {
  tipExitPE,
  tipOpMargin,
  tipProbability,
  tipRevGrowth,
  tipShares,
  tipTaxRate,
} from "@/components/valuation-tooltips";

type Field = keyof ScenarioInputs;

const SCENARIO_LABEL: Record<ScenarioKey, string> = {
  bear: "BEAR",
  base: "BASE",
  bull: "BULL",
};
const SCENARIO_PILL: Record<ScenarioKey, string> = {
  bear: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  base: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  bull: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
};

// Editable rows interleaved with calculated rows. order matters for the
// UI — revenue first, then profitability, then per-share, then P/E +
// targets.
type Row =
  | {
      kind: "edit";
      field: Field;
      label: string;
      cell: "pct" | "pe";
      help?: (m: ValuationModelV2) => React.ReactNode;
    }
  | {
      kind: "calc";
      label: string;
      format: "money" | "price" | "signedPct" | "round" | "pct";
      pick: (out: import("@/lib/valuation").ScenarioOutputs) => number;
    }
  | { kind: "section"; label: string };

const ROWS: Row[] = [
  { kind: "section", label: "REVENUE" },
  {
    kind: "edit",
    field: "rev_growth_y1",
    label: "Rev Growth Y1",
    cell: "pct",
    help: (m) => tipRevGrowth(1, m),
  },
  { kind: "calc", label: "Revenue Y1", format: "money", pick: (o) => o.rev_y1 },
  {
    kind: "edit",
    field: "rev_growth_y2",
    label: "Rev Growth Y2",
    cell: "pct",
    help: (m) => tipRevGrowth(2, m),
  },
  { kind: "calc", label: "Revenue Y2", format: "money", pick: (o) => o.rev_y2 },
  {
    kind: "edit",
    field: "rev_growth_y3",
    label: "Rev Growth Y3",
    cell: "pct",
    help: (m) => tipRevGrowth(3, m),
  },
  { kind: "calc", label: "Revenue Y3", format: "money", pick: (o) => o.rev_y3 },

  { kind: "section", label: "PROFITABILITY" },
  {
    kind: "edit",
    field: "op_margin",
    label: "Op Margin",
    cell: "pct",
    help: (m) => tipOpMargin(m),
  },
  { kind: "calc", label: "Operating Income Y3", format: "money", pick: (o) => o.op_income_y3 },
  {
    kind: "edit",
    field: "tax_rate",
    label: "Tax Rate",
    cell: "pct",
    help: (m) => tipTaxRate(m),
  },
  { kind: "calc", label: "Net Income Y3", format: "money", pick: (o) => o.net_income_y3 },

  { kind: "section", label: "PER SHARE" },
  { kind: "calc", label: "EPS Y1", format: "price", pick: (o) => o.eps_y1 },
  { kind: "calc", label: "EPS Y2", format: "price", pick: (o) => o.eps_y2 },
  { kind: "calc", label: "EPS Y3", format: "price", pick: (o) => o.eps_y3 },

  { kind: "section", label: "VALUATION" },
  {
    kind: "edit",
    field: "exit_pe",
    label: "Exit P/E",
    cell: "pe",
    help: (m) => tipExitPE(m),
  },
  { kind: "calc", label: "Price Target", format: "round", pick: (o) => o.price_target },
  { kind: "calc", label: "Return", format: "signedPct", pick: (o) => o.return_pct },
  { kind: "calc", label: "Implied Mkt Cap", format: "money", pick: (o) => o.implied_mkt_cap },

  {
    kind: "edit",
    field: "probability",
    label: "Probability",
    cell: "pct",
    help: () => tipProbability(),
  },
];

export function ValuationTier1({
  model,
  userInputs,
  editable,
  onChangeField,
  onChangeShares,
  onChangeTaxRate,
}: {
  model: ValuationModelV2;
  userInputs: ScenarioSet;
  editable: boolean;
  onChangeField: (s: ScenarioKey, f: Field, v: number) => void;
  onChangeShares: (raw: number) => void;
  onChangeTaxRate: (rate: number) => void;
}) {
  const tier1Ctx = useMemo(
    () => ({
      last_revenue: model.last_revenue,
      shares_outstanding: model.shares_outstanding,
      current_price: model.current_price,
      // Mirrors the server-side ctx so the live preview matches the
      // saved outputs. EPS-anchor mode triggers off these.
      category: model.category ?? null,
      forward_eps: model.forward_eps ?? null,
      eps_growth_rate: model.analyst_eps_growth_lt ?? null,
    }),
    [
      model.last_revenue,
      model.shares_outstanding,
      model.current_price,
      model.category,
      model.forward_eps,
      model.analyst_eps_growth_lt,
    ],
  );
  const usingEpsAnchor =
    model.category === "growth" &&
    typeof model.forward_eps === "number" &&
    Number.isFinite(model.forward_eps) &&
    model.forward_eps > 0;
  const liveOutputs = useMemo(
    () => computeTier1All(userInputs, tier1Ctx),
    [userInputs, tier1Ctx],
  );

  const probSum =
    userInputs.bear.probability +
    userInputs.base.probability +
    userInputs.bull.probability;
  const probValid = Math.abs(probSum - 1) < 0.001;

  const customized = useMemo(() => {
    const set = new Set<string>();
    for (const s of SCENARIOS) {
      for (const f of [
        "rev_growth_y1",
        "rev_growth_y2",
        "rev_growth_y3",
        "op_margin",
        "exit_pe",
        "tax_rate",
        "probability",
      ] as Field[]) {
        if (Math.abs(userInputs[s][f] - model.tier1.system[s][f]) > 1e-6) {
          set.add(`${s}.${f}`);
        }
      }
    }
    return set;
  }, [userInputs, model.tier1.system]);

  return (
    <div className="space-y-4">
      <StartingPoint
        model={model}
        editable={editable}
        onChangeShares={onChangeShares}
        onChangeTaxRate={onChangeTaxRate}
      />

      <div>
        <SectionLabel>Projection</SectionLabel>
        <EpsAnchorNote
          usingEpsAnchor={usingEpsAnchor}
          forwardEps={model.forward_eps ?? null}
          analystGrowth={model.analyst_eps_growth_lt ?? null}
        />
        <CellLegend />
        <div className="overflow-x-auto rounded border border-border">
          <table className="min-w-full text-xs">
            <thead className="bg-background/60">
              <tr>
                <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
                {SCENARIOS.map((s) => (
                  <th
                    key={s}
                    className="px-2 py-1 text-center font-medium uppercase text-muted-foreground"
                  >
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SCENARIO_PILL[s]}`}
                    >
                      {SCENARIO_LABEL[s]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, idx) => {
                if (row.kind === "section") {
                  return (
                    <tr key={`s-${idx}`} className="border-t border-border bg-background/30">
                      <td
                        colSpan={4}
                        className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {row.label}
                      </td>
                    </tr>
                  );
                }
                if (row.kind === "calc") {
                  return (
                    <tr key={`c-${idx}`} className="border-t border-border">
                      <td className="px-2 py-1 italic text-muted-foreground">
                        {row.label}
                      </td>
                      {SCENARIOS.map((s) => (
                        <td key={s} className="px-2 py-1 text-center">
                          <CalcCell value={row.pick(liveOutputs[s])} format={row.format} />
                        </td>
                      ))}
                    </tr>
                  );
                }
                return (
                  <tr key={`e-${idx}`} className="border-t border-border">
                    <td className="px-2 py-1 text-foreground">
                      <LabelWithTooltip
                        label={row.label}
                        help={row.help?.(model)}
                      />
                    </td>
                    {SCENARIOS.map((s) => (
                      <td key={s} className="px-2 py-1 text-center">
                        <EditableCell
                          value={userInputs[s][row.field]}
                          systemValue={model.tier1.system[s][row.field]}
                          kind={row.cell}
                          editable={editable}
                          onCommit={(v) => onChangeField(s, row.field, v)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!probValid && (
          <div className="mt-1 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[11px] text-rose-300">
            Probabilities must sum to 100% (currently {fmtPct(probSum, 1)}).
          </div>
        )}
      </div>

      <WeightedTargetCard
        outputs={liveOutputs}
        userInputs={userInputs}
        currentPrice={model.current_price}
        showSystem={customized.size > 0}
        systemOutputs={model.tier1.system_outputs}
        analystMean={model.analyst_target_mean}
        analystHigh={model.analyst_target_high}
        analystLow={model.analyst_target_low}
        analystCount={model.analyst_count}
      />

      <SensitivityTable
        baseEps={liveOutputs.base.eps_y3}
        basePE={userInputs.base.exit_pe}
        currentPrice={model.current_price}
      />
    </div>
  );
}

function StartingPoint({
  model,
  editable,
  onChangeShares,
  onChangeTaxRate,
}: {
  model: ValuationModelV2;
  editable: boolean;
  onChangeShares: (v: number) => void;
  onChangeTaxRate: (v: number) => void;
}) {
  const currentPE =
    model.last_eps && model.last_eps > 0
      ? model.current_price / model.last_eps
      : null;
  return (
    <div>
      <SectionLabel>Starting point</SectionLabel>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-border bg-background/40 p-2 sm:grid-cols-3">
        <KV
          label="Base Revenue (TTM)"
          value={fmtBigDollars(model.last_revenue)}
          source="EDGAR/Yahoo"
        />
        <KV
          label="Current Op Margin"
          value={fmtPct(model.last_op_margin)}
          source="EDGAR"
        />
        <KV
          label={
            model.ttm_eps
              ? "Trailing EPS (TTM actuals)"
              : "Trailing EPS"
          }
          value={fmtPrice(model.last_eps ?? 0)}
          source={
            model.ttm_eps
              ? `${model.ttm_eps.method}`
              : "Yahoo"
          }
        />
        {model.forward_eps !== null && model.forward_eps !== undefined && (
          <KV
            label="Forward EPS (Y1)"
            value={fmtPrice(model.forward_eps)}
            source="analyst estimate"
          />
        )}
        <KV
          label="Current P/E"
          value={currentPE !== null ? `${currentPE.toFixed(1)}x` : "—"}
          source="derived"
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <LabelWithTooltip label="Tax Rate" help={tipTaxRate(model)} />
          </span>
          <EditableCell
            value={model.tax_rate}
            systemValue={model.tax_rate}
            kind="pct"
            editable={editable}
            onCommit={onChangeTaxRate}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <LabelWithTooltip label="Shares (M)" help={tipShares(model)} />
          </span>
          <EditableCell
            value={model.shares_outstanding}
            systemValue={model.shares_outstanding}
            kind="shares_m"
            editable={editable}
            onCommit={onChangeShares}
          />
        </div>
      </div>
      {model.forward_eps_derived && (
        <ForwardEpsPanel model={model} />
      )}
      {model.growth_assumptions && (
        <div className="mt-2 rounded border border-emerald-500/20 bg-emerald-500/[0.04] p-2 text-[10px]">
          <div className="mb-0.5 flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-emerald-300">
              Growth assumptions (auto-set)
            </span>
            <span className="font-mono text-foreground">
              bear {(model.growth_assumptions.bearCase * 100).toFixed(0)}% ·
              base {(model.growth_assumptions.baseCase * 100).toFixed(0)}% ·
              bull {(model.growth_assumptions.bullCase * 100).toFixed(0)}%
            </span>
          </div>
          <div className="text-muted-foreground">
            {model.growth_assumptions.method}
          </div>
          {model.growth_assumptions.dataPoints.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground/80">
              {model.growth_assumptions.dataPoints.map((p) => (
                <span
                  key={p.periodEnd}
                  className={p.used ? "" : "line-through opacity-60"}
                >
                  {p.quarter}{" "}
                  <span className="font-mono">
                    {p.growth >= 0 ? "+" : ""}
                    {p.growth.toFixed(0)}%
                  </span>
                  {p.flagged ? ` (${p.flagged})` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Independent forward EPS panel ----------
//
// Surfaces both the analyst consensus (model.forward_eps) and the
// system-derived estimate (model.forward_eps_derived) side-by-side
// with a per-quarter breakdown. Tier 1 outputs are still computed
// from analyst EPS for now — a follow-up will add a toggle that
// triggers a server-side recompute with the derived value. The
// divergence banner cues the user when the analyst figure is likely
// stale post-earnings.
function ForwardEpsPanel({ model }: { model: ValuationModelV2 }) {
  const [expanded, setExpanded] = useState(false);
  const fwd = model.forward_eps_derived;
  if (!fwd) return null;
  const analyst = fwd.analystEps ?? model.forward_eps ?? null;
  const divergencePct =
    analyst !== null && analyst !== 0
      ? (Math.abs(fwd.derivedEps - analyst) / Math.abs(analyst)) * 100
      : null;
  const divergent = divergencePct !== null && divergencePct >= 15;
  const confidenceColor =
    fwd.confidence === "high"
      ? "text-emerald-300"
      : fwd.confidence === "medium"
        ? "text-amber-300"
        : "text-muted-foreground";
  const basisLabel: Record<
    NonNullable<typeof fwd.quarters>[number]["basis"],
    string
  > = {
    actual: "✓ reported",
    mgmt_guided: "mgmt color",
    yoy_growth: "YoY-grown",
    flat: "flat",
  };
  return (
    <div className="mt-2 rounded border border-sky-500/30 bg-sky-500/[0.04] p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-300">
          Forward EPS
        </span>
        <span className={`text-[9px] uppercase tracking-wide ${confidenceColor}`}>
          confidence: {fwd.confidence}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-2 rounded border border-border/50 bg-background/40 px-2 py-1">
          <span className="text-muted-foreground">Analyst consensus</span>
          <span className="font-mono text-foreground">
            {analyst !== null ? `$${analyst.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1">
          <span className="text-sky-200">System derived</span>
          <span className="font-mono font-semibold text-sky-100">
            ${fwd.derivedEps.toFixed(2)}
          </span>
        </div>
      </div>
      {divergent && (
        <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-amber-200">
          ⚠️ Analyst consensus and derived estimate diverge by{" "}
          {divergencePct?.toFixed(0)}%. Analyst figure may not yet reflect
          the most recent earnings — consider sanity-checking against the
          per-quarter breakdown below.
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? "▾ Hide breakdown" : "▸ Show quarter breakdown"}
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 rounded border border-border bg-background/40 p-2">
          {fwd.quarters.map((q) => (
            <div
              key={q.quarter}
              className="flex justify-between gap-2 text-[10px]"
            >
              <span className="font-mono text-muted-foreground">
                {q.quarter}
              </span>
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-foreground">
                  ${q.estimate.toFixed(2)}
                </span>
                <span className="text-muted-foreground">
                  {basisLabel[q.basis]}
                </span>
              </span>
            </div>
          ))}
          <div className="mt-1 border-t border-border/50 pt-1 flex justify-between text-[10px]">
            <span className="font-semibold uppercase tracking-wide text-muted-foreground">
              Full year derived
            </span>
            <span className="font-mono font-semibold text-sky-200">
              ${fwd.derivedEps.toFixed(2)}
            </span>
          </div>
          <div className="mt-1 text-[9px] text-muted-foreground">
            {fwd.method}
          </div>
        </div>
      )}
      <div className="mt-1 text-[9px] text-muted-foreground">
        Tier 1 price targets currently use analyst consensus. Toggle
        to derived (coming soon) — for now, edit forward EPS in the
        scenario columns below if you want to use the derived value.
      </div>
    </div>
  );
}

function EpsAnchorNote({
  usingEpsAnchor,
  forwardEps,
  analystGrowth,
}: {
  usingEpsAnchor: boolean;
  forwardEps: number | null;
  analystGrowth: number | null;
}) {
  if (usingEpsAnchor && forwardEps !== null) {
    const g =
      typeof analystGrowth === "number" && analystGrowth > 0
        ? ` · compounded by analyst LT EPS growth ${(analystGrowth * 100).toFixed(1)}%`
        : "";
    return (
      <div className="mb-2 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1 text-[11px] text-emerald-200">
        📌 EPS anchored on analyst forward estimate{" "}
        <span className="font-mono font-semibold">${forwardEps.toFixed(2)}</span>
        {g} — more accurate for growth stocks than projecting from
        trailing EPS.
      </div>
    );
  }
  return (
    <div className="mb-2 rounded border border-border bg-background/40 px-2 py-1 text-[11px] text-muted-foreground">
      📌 EPS derived from revenue × margin × (1 − tax) / shares.
    </div>
  );
}

function KV({ label, value, source }: { label: string; value: string; source?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-foreground">{value}</span>
      {source && (
        <span className="text-[9px] text-muted-foreground/70">[{source}]</span>
      )}
    </div>
  );
}

function WeightedTargetCard({
  outputs,
  userInputs,
  currentPrice,
  showSystem,
  systemOutputs,
  analystMean,
  analystHigh,
  analystLow,
  analystCount,
}: {
  outputs: ReturnType<typeof computeTier1All>;
  userInputs: ScenarioSet;
  currentPrice: number;
  showSystem: boolean;
  systemOutputs: ReturnType<typeof computeTier1All>;
  analystMean: number | null;
  analystHigh: number | null;
  analystLow: number | null;
  analystCount: number | null;
}) {
  // Base case is the headline number — most traders anchor on it
  // when sizing positions, and the weighted average can mislead when
  // probabilities are unbalanced. Weighted moves to a secondary line
  // below the per-scenario list.
  const baseTarget = outputs.base.price_target;
  const baseReturn = outputs.base.return_pct;
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
        Price targets
      </div>
      <div className="mt-1 text-2xl font-bold text-foreground">
        {fmtRoundPrice(baseTarget)}{" "}
        <span
          className={`text-sm font-medium ${baseReturn >= 0 ? "text-emerald-300" : "text-rose-300"}`}
        >
          ({fmtSignedPct(baseReturn, 1)} from {fmtPrice(currentPrice)})
        </span>
        <span className="ml-2 rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-emerald-300">
          BASE
        </span>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[11px]">
        {SCENARIOS.map((s) => {
          const isBase = s === "base";
          return (
            <div
              key={s}
              className={isBase ? "text-foreground" : "text-muted-foreground"}
            >
              <span className={isBase ? "font-semibold" : ""}>
                {SCENARIO_LABEL[s]}
              </span>{" "}
              {fmtRoundPrice(outputs[s].price_target)} ×{" "}
              {fmtPct(userInputs[s].probability, 0)} ={" "}
              {fmtRoundPrice(outputs[s].price_target * userInputs[s].probability)}
            </div>
          );
        })}
      </div>
      <div className="mt-2 border-t border-emerald-500/20 pt-1.5 text-[11px] text-muted-foreground">
        Weighted: {fmtRoundPrice(outputs.weighted_target)}{" "}
        <span
          className={
            outputs.weighted_return_pct >= 0 ? "text-emerald-300/80" : "text-rose-300/80"
          }
        >
          ({fmtSignedPct(outputs.weighted_return_pct, 1)})
        </span>
      </div>
      {showSystem && (
        <div className="mt-2 text-[11px] text-amber-300/80">
          System weighted: {fmtRoundPrice(systemOutputs.weighted_target)}
        </div>
      )}
      {analystMean !== null && (
        <div className="mt-2 border-t border-emerald-500/20 pt-2 text-[11px] text-muted-foreground">
          Analyst consensus:{" "}
          <span className="text-foreground">{fmtRoundPrice(analystMean)}</span>
          {analystCount !== null && <> ({analystCount} analysts)</>}
          {analystLow !== null && analystHigh !== null && (
            <>
              {" "}
              · Range:{" "}
              <span className="text-foreground">
                {fmtRoundPrice(analystLow)} – {fmtRoundPrice(analystHigh)}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SensitivityTable({
  baseEps,
  basePE,
  currentPrice,
}: {
  baseEps: number;
  basePE: number;
  currentPrice: number;
}) {
  if (!Number.isFinite(baseEps) || baseEps <= 0) return null;
  const epsRows = [baseEps * 0.6, baseEps * 0.8, baseEps, baseEps * 1.2, baseEps * 1.4];
  const peCols = [
    Math.max(8, basePE * 0.7),
    Math.max(10, basePE * 0.9),
    basePE,
    basePE * 1.15,
    basePE * 1.4,
  ].map((x) => Math.round(x));
  return (
    <div>
      <SectionLabel>Sensitivity: Price target by EPS × P/E</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                EPS \\ P/E
              </th>
              {peCols.map((pe, i) => (
                <th
                  key={i}
                  className="px-2 py-1 text-center font-medium text-muted-foreground"
                >
                  {pe}x
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {epsRows.map((eps, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-2 py-1 font-mono">${eps.toFixed(2)}</td>
                {peCols.map((pe, j) => {
                  const target = eps * pe;
                  const isBaseCell = i === 2 && j === 2;
                  const cls = isBaseCell
                    ? "border border-emerald-500/60 bg-emerald-500/15 font-semibold text-emerald-200"
                    : "";
                  return (
                    <td
                      key={j}
                      className={`px-2 py-1 text-center font-mono ${cls}`}
                    >
                      {fmtRoundPrice(target)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {currentPrice > 0 && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Current price:{" "}
          <span className="text-foreground">{fmtPrice(currentPrice)}</span>
        </div>
      )}
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
