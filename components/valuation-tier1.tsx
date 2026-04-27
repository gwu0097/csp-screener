"use client";

// Tier 1 — P/E Multiple model. Shows every intermediate calculation so
// the math is verifiable: rev y1/y2/y3, op income y3, net income y3,
// EPS y1/y2/y3, price target, return, implied market cap.

import { useMemo } from "react";
import {
  computeTier1All,
  SCENARIOS,
  type ScenarioInputs,
  type ScenarioKey,
  type ScenarioSet,
  type ValuationModelV2,
} from "@/lib/valuation";
import { CalcCell, EditableCell } from "@/components/valuation-cell";
import {
  fmtBigDollars,
  fmtPct,
  fmtPrice,
  fmtRoundPrice,
  fmtSignedPct,
} from "@/components/valuation-format";

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
  | { kind: "edit"; field: Field; label: string; cell: "pct" | "pe" }
  | { kind: "calc"; label: string; format: "money" | "price" | "signedPct" | "round" | "pct"; pick: (out: import("@/lib/valuation").ScenarioOutputs) => number }
  | { kind: "section"; label: string };

const ROWS: Row[] = [
  { kind: "section", label: "REVENUE" },
  { kind: "edit", field: "rev_growth_y1", label: "Rev Growth Y1", cell: "pct" },
  { kind: "calc", label: "Revenue Y1", format: "money", pick: (o) => o.rev_y1 },
  { kind: "edit", field: "rev_growth_y2", label: "Rev Growth Y2", cell: "pct" },
  { kind: "calc", label: "Revenue Y2", format: "money", pick: (o) => o.rev_y2 },
  { kind: "edit", field: "rev_growth_y3", label: "Rev Growth Y3", cell: "pct" },
  { kind: "calc", label: "Revenue Y3", format: "money", pick: (o) => o.rev_y3 },

  { kind: "section", label: "PROFITABILITY" },
  { kind: "edit", field: "op_margin", label: "Op Margin", cell: "pct" },
  { kind: "calc", label: "Operating Income Y3", format: "money", pick: (o) => o.op_income_y3 },
  { kind: "edit", field: "tax_rate", label: "Tax Rate", cell: "pct" },
  { kind: "calc", label: "Net Income Y3", format: "money", pick: (o) => o.net_income_y3 },

  { kind: "section", label: "PER SHARE" },
  { kind: "calc", label: "EPS Y1", format: "price", pick: (o) => o.eps_y1 },
  { kind: "calc", label: "EPS Y2", format: "price", pick: (o) => o.eps_y2 },
  { kind: "calc", label: "EPS Y3", format: "price", pick: (o) => o.eps_y3 },

  { kind: "section", label: "VALUATION" },
  { kind: "edit", field: "exit_pe", label: "Exit P/E", cell: "pe" },
  { kind: "calc", label: "Price Target", format: "round", pick: (o) => o.price_target },
  { kind: "calc", label: "Return", format: "signedPct", pick: (o) => o.return_pct },
  { kind: "calc", label: "Implied Mkt Cap", format: "money", pick: (o) => o.implied_mkt_cap },

  { kind: "edit", field: "probability", label: "Probability", cell: "pct" },
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
    }),
    [model.last_revenue, model.shares_outstanding, model.current_price],
  );
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
                    <td className="px-2 py-1 text-foreground">{row.label}</td>
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
        <KV label="Current EPS" value={fmtPrice(model.last_eps ?? 0)} source="Yahoo" />
        <KV
          label="Current P/E"
          value={currentPE !== null ? `${currentPE.toFixed(1)}x` : "—"}
          source="derived"
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Tax Rate
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
            Shares (M)
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
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
        Weighted price target
      </div>
      <div className="mt-1 text-2xl font-bold text-foreground">
        {fmtRoundPrice(outputs.weighted_target)}{" "}
        <span
          className={`text-sm font-medium ${outputs.weighted_return_pct >= 0 ? "text-emerald-300" : "text-rose-300"}`}
        >
          ({fmtSignedPct(outputs.weighted_return_pct, 1)} from {fmtPrice(currentPrice)})
        </span>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
        {SCENARIOS.map((s) => (
          <div key={s}>
            {SCENARIO_LABEL[s]} {fmtRoundPrice(outputs[s].price_target)} ×{" "}
            {fmtPct(userInputs[s].probability, 0)} ={" "}
            {fmtRoundPrice(outputs[s].price_target * userInputs[s].probability)}
          </div>
        ))}
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
