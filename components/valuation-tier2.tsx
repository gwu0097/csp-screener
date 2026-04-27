"use client";

// Tier 2 — Full DCF model. Three input groups (revenue, profitability,
// discount rate), step-by-step FCF projection per scenario, terminal
// value, and a WACC × FCF margin sensitivity table around the base
// case. Same scenario layout as Tier 1.

import { useMemo } from "react";
import {
  computeTier2All,
  computeTier2Scenario,
  SCENARIOS,
  type DCFScenarioInputs,
  type DCFScenarioSet,
  type ScenarioKey,
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

type DCFField = keyof DCFScenarioInputs;

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

// Editable rows + intercalated calculated rows. We render groups
// separately so section labels stay readable.
type EditRow = {
  field: DCFField;
  label: string;
  cell: "pct" | "pe" | "beta" | "raw";
};

const REV_ROWS: EditRow[] = [
  { field: "rev_growth_y1", label: "Rev Growth Y1", cell: "pct" },
  { field: "rev_growth_y2", label: "Rev Growth Y2", cell: "pct" },
  { field: "rev_growth_y3", label: "Rev Growth Y3", cell: "pct" },
  { field: "rev_growth_y4", label: "Rev Growth Y4", cell: "pct" },
  { field: "rev_growth_y5", label: "Rev Growth Y5", cell: "pct" },
  { field: "terminal_growth_rate", label: "Terminal Growth", cell: "pct" },
];
const PROFIT_ROWS: EditRow[] = [
  { field: "fcf_margin", label: "FCF Margin", cell: "pct" },
];
const DISCOUNT_ROWS: EditRow[] = [
  { field: "risk_free_rate", label: "Risk-Free Rate", cell: "pct" },
  { field: "equity_risk_premium", label: "Equity Risk Premium", cell: "pct" },
  { field: "beta", label: "Beta", cell: "beta" },
  { field: "debt_to_total_capital", label: "Debt / Total Capital", cell: "pct" },
  { field: "cost_of_debt_pretax", label: "Cost of Debt (pre-tax)", cell: "pct" },
];

export function ValuationTier2({
  model,
  userInputs,
  editable,
  onChangeField,
  onChangeTerminalMethod,
}: {
  model: ValuationModelV2;
  userInputs: DCFScenarioSet;
  editable: boolean;
  onChangeField: (s: ScenarioKey, f: DCFField, v: number) => void;
  onChangeTerminalMethod: (s: ScenarioKey, m: "gordon" | "exit_multiple") => void;
}) {
  const ctx = useMemo(
    () => ({
      last_revenue: model.last_revenue,
      shares_outstanding: model.shares_outstanding,
      current_price: model.current_price,
      net_debt: model.net_debt,
      tax_rate: model.tax_rate,
    }),
    [
      model.last_revenue,
      model.shares_outstanding,
      model.current_price,
      model.net_debt,
      model.tax_rate,
    ],
  );

  const liveOutputs = useMemo(
    () => computeTier2All(userInputs, ctx),
    [userInputs, ctx],
  );

  const probSum =
    userInputs.bear.probability +
    userInputs.base.probability +
    userInputs.bull.probability;
  const probValid = Math.abs(probSum - 1) < 0.001;

  const customized = useMemo(() => {
    const set = new Set<string>();
    for (const s of SCENARIOS) {
      const numFields: DCFField[] = [
        "rev_growth_y1",
        "rev_growth_y2",
        "rev_growth_y3",
        "rev_growth_y4",
        "rev_growth_y5",
        "fcf_margin",
        "risk_free_rate",
        "equity_risk_premium",
        "beta",
        "debt_to_total_capital",
        "cost_of_debt_pretax",
        "terminal_growth_rate",
        "exit_multiple",
        "probability",
      ];
      for (const f of numFields) {
        const a = userInputs[s][f] as number;
        const b = model.tier2.system[s][f] as number;
        if (Math.abs(a - b) > 1e-6) set.add(`${s}.${f}`);
      }
      if (userInputs[s].terminal_method !== model.tier2.system[s].terminal_method) {
        set.add(`${s}.terminal_method`);
      }
    }
    return set;
  }, [userInputs, model.tier2.system]);

  return (
    <div className="space-y-4">
      <DCFContextStrip model={model} />

      <InputBlock title="Revenue projection" rows={REV_ROWS}
        userInputs={userInputs} system={model.tier2.system}
        editable={editable} onChange={onChangeField}
      />

      <InputBlock title="Profitability" rows={PROFIT_ROWS}
        userInputs={userInputs} system={model.tier2.system}
        editable={editable} onChange={onChangeField}
      />

      <DiscountBlock
        userInputs={userInputs}
        system={model.tier2.system}
        liveOutputs={liveOutputs}
        editable={editable}
        onChange={onChangeField}
      />

      <TerminalBlock
        userInputs={userInputs}
        system={model.tier2.system}
        editable={editable}
        onChangeField={onChangeField}
        onChangeTerminalMethod={onChangeTerminalMethod}
      />

      {/* Per-scenario step-by-step calculation */}
      <ScenarioCalcs liveOutputs={liveOutputs} model={model} />

      <ProbabilityRow
        userInputs={userInputs}
        system={model.tier2.system}
        editable={editable}
        onChange={onChangeField}
        probValid={probValid}
        probSum={probSum}
      />

      <WeightedTargetCard
        outputs={liveOutputs}
        userInputs={userInputs}
        currentPrice={model.current_price}
        showSystem={customized.size > 0}
        systemWeighted={model.tier2.system_outputs.weighted_target}
        analystMean={model.analyst_target_mean}
        analystHigh={model.analyst_target_high}
        analystLow={model.analyst_target_low}
        analystCount={model.analyst_count}
      />

      <DCFSensitivity
        baseInputs={userInputs.base}
        ctx={ctx}
      />
    </div>
  );
}

// ---------- Static context strip ----------

function DCFContextStrip({ model }: { model: ValuationModelV2 }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-border bg-background/40 p-2 text-xs sm:grid-cols-4">
      <KV label="Last Revenue" value={fmtBigDollars(model.last_revenue)} />
      <KV label="Net Debt" value={fmtBigDollars(model.net_debt)} />
      <KV label="Shares" value={`${(model.shares_outstanding / 1e6).toFixed(1)}M`} />
      <KV label="Tax Rate" value={fmtPct(model.tax_rate)} />
      <KV
        label="Avg FCF Margin (3y)"
        value={fmtPct(model.fcf_margin_avg)}
      />
      <KV label="D&A % Rev (3y)" value={fmtPct(model.da_pct_revenue)} />
      <KV label="Capex % Rev (3y)" value={fmtPct(model.capex_pct_revenue)} />
      <KV label="Beta (Yahoo)" value={model.beta !== null ? model.beta.toFixed(2) : "—"} />
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

// ---------- Input grids ----------

function InputBlock({
  title,
  rows,
  userInputs,
  system,
  editable,
  onChange,
}: {
  title: string;
  rows: EditRow[];
  userInputs: DCFScenarioSet;
  system: DCFScenarioSet;
  editable: boolean;
  onChange: (s: ScenarioKey, f: DCFField, v: number) => void;
}) {
  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
              {SCENARIOS.map((s) => (
                <th key={s} className="px-2 py-1 text-center">
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
            {rows.map((row) => (
              <tr key={row.field} className="border-t border-border">
                <td className="px-2 py-1 text-foreground">{row.label}</td>
                {SCENARIOS.map((s) => (
                  <td key={s} className="px-2 py-1 text-center">
                    <EditableCell
                      value={userInputs[s][row.field] as number}
                      systemValue={system[s][row.field] as number}
                      kind={row.cell}
                      editable={editable}
                      onCommit={(v) => onChange(s, row.field, v)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Discount-rate block also shows the calculated CoE / after-tax CoD /
// WACC rows so the user sees how WACC is built up.
function DiscountBlock({
  userInputs,
  system,
  liveOutputs,
  editable,
  onChange,
}: {
  userInputs: DCFScenarioSet;
  system: DCFScenarioSet;
  liveOutputs: ReturnType<typeof computeTier2All>;
  editable: boolean;
  onChange: (s: ScenarioKey, f: DCFField, v: number) => void;
}) {
  return (
    <div>
      <SectionLabel>Discount rate (WACC)</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
              {SCENARIOS.map((s) => (
                <th key={s} className="px-2 py-1 text-center">
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
            {DISCOUNT_ROWS.map((row, i) => (
              <RowAndPossibleCalc
                key={row.field}
                row={row}
                userInputs={userInputs}
                system={system}
                editable={editable}
                onChange={onChange}
                showCoEAfter={i === 2 /* after Beta */}
                liveOutputs={liveOutputs}
                showAfterTaxCoDAfter={i === 4 /* after CoD pre-tax */}
              />
            ))}
            <tr className="border-t border-border bg-emerald-500/[0.04]">
              <td className="px-2 py-1 font-semibold text-emerald-300">WACC</td>
              {SCENARIOS.map((s) => (
                <td key={s} className="px-2 py-1 text-center font-mono font-semibold text-emerald-200">
                  {fmtPct(liveOutputs[s].wacc, 2)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowAndPossibleCalc({
  row,
  userInputs,
  system,
  editable,
  onChange,
  showCoEAfter,
  showAfterTaxCoDAfter,
  liveOutputs,
}: {
  row: EditRow;
  userInputs: DCFScenarioSet;
  system: DCFScenarioSet;
  editable: boolean;
  onChange: (s: ScenarioKey, f: DCFField, v: number) => void;
  showCoEAfter: boolean;
  showAfterTaxCoDAfter: boolean;
  liveOutputs: ReturnType<typeof computeTier2All>;
}) {
  return (
    <>
      <tr className="border-t border-border">
        <td className="px-2 py-1 text-foreground">{row.label}</td>
        {SCENARIOS.map((s) => (
          <td key={s} className="px-2 py-1 text-center">
            <EditableCell
              value={userInputs[s][row.field] as number}
              systemValue={system[s][row.field] as number}
              kind={row.cell}
              editable={editable}
              onCommit={(v) => onChange(s, row.field, v)}
            />
          </td>
        ))}
      </tr>
      {showCoEAfter && (
        <tr className="border-t border-border">
          <td className="px-2 py-1 italic text-muted-foreground">
            Cost of Equity (RFR + β × ERP)
          </td>
          {SCENARIOS.map((s) => (
            <td key={s} className="px-2 py-1 text-center">
              <CalcCell value={liveOutputs[s].cost_of_equity} format="pct" />
            </td>
          ))}
        </tr>
      )}
      {showAfterTaxCoDAfter && (
        <tr className="border-t border-border">
          <td className="px-2 py-1 italic text-muted-foreground">
            After-tax Cost of Debt
          </td>
          {SCENARIOS.map((s) => (
            <td key={s} className="px-2 py-1 text-center">
              <CalcCell value={liveOutputs[s].after_tax_cost_of_debt} format="pct" />
            </td>
          ))}
        </tr>
      )}
    </>
  );
}

function TerminalBlock({
  userInputs,
  system,
  editable,
  onChangeField,
  onChangeTerminalMethod,
}: {
  userInputs: DCFScenarioSet;
  system: DCFScenarioSet;
  editable: boolean;
  onChangeField: (s: ScenarioKey, f: DCFField, v: number) => void;
  onChangeTerminalMethod: (s: ScenarioKey, m: "gordon" | "exit_multiple") => void;
}) {
  return (
    <div>
      <SectionLabel>Terminal value</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground"></th>
              {SCENARIOS.map((s) => (
                <th key={s} className="px-2 py-1 text-center">
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
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Method</td>
              {SCENARIOS.map((s) => (
                <td key={s} className="px-2 py-1 text-center">
                  <select
                    value={userInputs[s].terminal_method}
                    onChange={(e) =>
                      onChangeTerminalMethod(
                        s,
                        e.target.value as "gordon" | "exit_multiple",
                      )
                    }
                    disabled={!editable}
                    className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                  >
                    <option value="gordon">Gordon Growth</option>
                    <option value="exit_multiple">Exit Multiple</option>
                  </select>
                </td>
              ))}
            </tr>
            <tr className="border-t border-border">
              <td className="px-2 py-1 text-foreground">Exit Multiple (× FCF)</td>
              {SCENARIOS.map((s) => (
                <td key={s} className="px-2 py-1 text-center">
                  <EditableCell
                    value={userInputs[s].exit_multiple}
                    systemValue={system[s].exit_multiple}
                    kind="raw"
                    editable={editable && userInputs[s].terminal_method === "exit_multiple"}
                    onCommit={(v) => onChangeField(s, "exit_multiple", v)}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProbabilityRow({
  userInputs,
  system,
  editable,
  onChange,
  probValid,
  probSum,
}: {
  userInputs: DCFScenarioSet;
  system: DCFScenarioSet;
  editable: boolean;
  onChange: (s: ScenarioKey, f: DCFField, v: number) => void;
  probValid: boolean;
  probSum: number;
}) {
  return (
    <div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <tbody>
            <tr>
              <td className="px-2 py-1 text-foreground">Probability</td>
              {SCENARIOS.map((s) => (
                <td key={s} className="px-2 py-1 text-center">
                  <EditableCell
                    value={userInputs[s].probability}
                    systemValue={system[s].probability}
                    kind="pct"
                    editable={editable}
                    onCommit={(v) => onChange(s, "probability", v)}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {!probValid && (
        <div className="mt-1 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[11px] text-rose-300">
          Probabilities must sum to 100% (currently {fmtPct(probSum, 1)}).
        </div>
      )}
    </div>
  );
}

// ---------- Per-scenario calculation walkthrough ----------

function ScenarioCalcs({
  liveOutputs,
  model,
}: {
  liveOutputs: ReturnType<typeof computeTier2All>;
  model: ValuationModelV2;
}) {
  return (
    <div className="space-y-3">
      <SectionLabel>Step-by-step DCF (per scenario)</SectionLabel>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {SCENARIOS.map((s) => (
          <ScenarioColumn
            key={s}
            scenario={s}
            out={liveOutputs[s]}
            model={model}
          />
        ))}
      </div>
    </div>
  );
}

function ScenarioColumn({
  scenario,
  out,
  model,
}: {
  scenario: ScenarioKey;
  out: ReturnType<typeof computeTier2Scenario>;
  model: ValuationModelV2;
}) {
  return (
    <div className="rounded border border-border bg-background/40 p-2 text-[11px]">
      <div className="mb-1 flex items-center gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SCENARIO_PILL[scenario]}`}
        >
          {SCENARIO_LABEL[scenario]}
        </span>
        <span className="text-muted-foreground">WACC {fmtPct(out.wacc, 2)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="px-1 py-0.5 text-left font-medium">Y</th>
              <th className="px-1 py-0.5 text-right font-medium">Revenue</th>
              <th className="px-1 py-0.5 text-right font-medium">FCF</th>
              <th className="px-1 py-0.5 text-right font-medium">÷</th>
              <th className="px-1 py-0.5 text-right font-medium">PV</th>
            </tr>
          </thead>
          <tbody>
            {out.fcf_projection.map((r) => (
              <tr key={r.year} className="border-t border-border/60">
                <td className="px-1 py-0.5 font-mono">{r.year}</td>
                <td className="px-1 py-0.5 text-right font-mono">
                  {fmtBigDollars(r.revenue)}
                </td>
                <td className="px-1 py-0.5 text-right font-mono">
                  {fmtBigDollars(r.fcf)}
                </td>
                <td className="px-1 py-0.5 text-right font-mono text-muted-foreground">
                  ÷{r.discount_factor.toFixed(3)}
                </td>
                <td className="px-1 py-0.5 text-right font-mono">
                  {fmtBigDollars(r.pv_fcf)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1 space-y-0.5 border-t border-border pt-1">
        <Line label="Sum PV FCFs" value={fmtBigDollars(out.sum_pv_fcf)} />
        <Line label="Terminal Value" value={fmtBigDollars(out.terminal_value)} />
        <Line label="PV of TV" value={fmtBigDollars(out.pv_terminal)} />
        <Line label="Enterprise Value" value={fmtBigDollars(out.enterprise_value)} bold />
        <Line label="− Net Debt" value={fmtBigDollars(model.net_debt)} />
        <Line label="Equity Value" value={fmtBigDollars(out.equity_value)} bold />
        <Line label="÷ Shares" value={`${(model.shares_outstanding / 1e6).toFixed(1)}M`} />
        <Line
          label="Intrinsic Value"
          value={fmtPrice(out.intrinsic_value)}
          highlight
        />
        <Line
          label="Return"
          value={fmtSignedPct(out.return_pct, 1)}
          colorize={out.return_pct}
        />
      </div>
    </div>
  );
}

function Line({
  label,
  value,
  bold,
  highlight,
  colorize,
}: {
  label: string;
  value: string;
  bold?: boolean;
  highlight?: boolean;
  colorize?: number;
}) {
  let cls = "font-mono";
  if (bold) cls += " font-semibold";
  if (highlight) cls += " text-emerald-200";
  if (colorize !== undefined)
    cls += colorize >= 0 ? " text-emerald-300" : " text-rose-300";
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}

// ---------- Weighted target ----------

function WeightedTargetCard({
  outputs,
  userInputs,
  currentPrice,
  showSystem,
  systemWeighted,
  analystMean,
  analystHigh,
  analystLow,
  analystCount,
}: {
  outputs: ReturnType<typeof computeTier2All>;
  userInputs: DCFScenarioSet;
  currentPrice: number;
  showSystem: boolean;
  systemWeighted: number;
  analystMean: number | null;
  analystHigh: number | null;
  analystLow: number | null;
  analystCount: number | null;
}) {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/80">
        Weighted intrinsic value
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
            {SCENARIO_LABEL[s]} {fmtRoundPrice(outputs[s].intrinsic_value)} ×{" "}
            {fmtPct(userInputs[s].probability, 0)} ={" "}
            {fmtRoundPrice(outputs[s].intrinsic_value * userInputs[s].probability)}
          </div>
        ))}
      </div>
      {showSystem && (
        <div className="mt-2 text-[11px] text-amber-300/80">
          System weighted: {fmtRoundPrice(systemWeighted)}
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

// ---------- Sensitivity grid (WACC × FCF margin) ----------

function DCFSensitivity({
  baseInputs,
  ctx,
}: {
  baseInputs: DCFScenarioInputs;
  ctx: import("@/lib/valuation").Tier2Ctx;
}) {
  const fcfRows = [
    Math.max(0.02, baseInputs.fcf_margin - 0.04),
    Math.max(0.04, baseInputs.fcf_margin - 0.02),
    baseInputs.fcf_margin,
    baseInputs.fcf_margin + 0.02,
    baseInputs.fcf_margin + 0.04,
  ];
  // We want WACC ±2pp around base. Recover the implied component pieces
  // are tricky — easier to bracket on the WACC axis itself and inject
  // the perturbation into a clone of base inputs.
  const baseOut = computeTier2Scenario(baseInputs, ctx);
  const baseWACC = baseOut.wacc;
  const waccCols = [baseWACC - 0.02, baseWACC - 0.01, baseWACC, baseWACC + 0.01, baseWACC + 0.02];

  function scaleToTargetWACC(target: number, fcf: number): number {
    // Build a synthetic scenario at this fcf margin + target WACC by
    // tweaking risk_free_rate to hit the WACC. CoE = RFR + β·ERP.
    // WACC = E·(RFR + β·ERP) + D·CoD_after_tax. Solve for RFR.
    const D = baseInputs.debt_to_total_capital;
    const E = 1 - D;
    const cod_at = baseInputs.cost_of_debt_pretax * (1 - ctx.tax_rate);
    const beta = baseInputs.beta;
    const erp = baseInputs.equity_risk_premium;
    const rfr = (target - D * cod_at) / E - beta * erp;
    const inputs: DCFScenarioInputs = {
      ...baseInputs,
      fcf_margin: fcf,
      risk_free_rate: rfr,
    };
    const out = computeTier2Scenario(inputs, ctx);
    return out.intrinsic_value;
  }

  return (
    <div>
      <SectionLabel>Sensitivity: Intrinsic value by WACC × FCF margin</SectionLabel>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                FCF % \\ WACC
              </th>
              {waccCols.map((w, i) => (
                <th
                  key={i}
                  className="px-2 py-1 text-center font-medium text-muted-foreground"
                >
                  {(w * 100).toFixed(1)}%
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fcfRows.map((fcf, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-2 py-1 font-mono">{(fcf * 100).toFixed(1)}%</td>
                {waccCols.map((w, j) => {
                  const v = scaleToTargetWACC(w, fcf);
                  const isBaseCell = i === 2 && j === 2;
                  const cls = isBaseCell
                    ? "border border-emerald-500/60 bg-emerald-500/15 font-semibold text-emerald-200"
                    : "";
                  return (
                    <td
                      key={j}
                      className={`px-2 py-1 text-center font-mono ${cls}`}
                    >
                      {fmtRoundPrice(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Current price:{" "}
        <span className="text-foreground">{fmtPrice(ctx.current_price)}</span>
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
