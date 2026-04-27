"use client";

// Tooltip content factories for the valuation tab. Each helper takes
// the saved model (so it can interpolate the actual current numbers)
// and an optional scenario / extra context, and returns the body to
// render inside <TooltipContent>.

import { TooltipBody } from "@/components/valuation-label";
import {
  computeTier2Scenario,
  sectorPE,
  type DCFScenarioInputs,
  type ValuationModelV2,
} from "@/lib/valuation";

function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
function px(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}

function recentRevGrowths(model: ValuationModelV2): {
  last: number | null;
  avg3: number | null;
  peak: number | null;
  min: number | null;
} {
  const growths = model.historical
    .map((r) => r.rev_growth)
    .filter((g): g is number => g !== null);
  if (growths.length === 0)
    return { last: null, avg3: null, peak: null, min: null };
  const reversed = [...growths].reverse();
  const last3 = reversed.slice(0, 3);
  return {
    last: reversed[0] ?? null,
    avg3:
      last3.length > 0 ? last3.reduce((s, x) => s + x, 0) / last3.length : null,
    peak: Math.max(...growths),
    min: Math.min(...growths),
  };
}

function opMarginRange(model: ValuationModelV2): {
  min: number | null;
  max: number | null;
  current: number | null;
} {
  const margins = model.historical
    .map((r) => r.op_margin)
    .filter((m): m is number => m !== null);
  if (margins.length === 0)
    return { min: null, max: null, current: model.last_op_margin };
  return {
    min: Math.min(...margins),
    max: Math.max(...margins),
    current: model.last_op_margin,
  };
}

// ---------- Tier 1 ----------

export function tipRevGrowth(
  year: 1 | 2 | 3 | 4 | 5,
  model: ValuationModelV2,
): React.ReactNode {
  const r = recentRevGrowths(model);
  return (
    <TooltipBody
      intro={
        <>
          Revenue growth rate for year {year}. The chain is{" "}
          <span className="font-mono">
            Rev Y{year} = Rev Y{year - 1} × (1 + growth)
          </span>
          .
        </>
      }
      howToSet={
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <b>Bear:</b> recent lowest growth or analyst low estimate
          </li>
          <li>
            <b>Base:</b> analyst consensus / current trajectory
          </li>
          <li>
            <b>Bull:</b> historical peak growth or accelerating mix
          </li>
        </ul>
      }
      current={
        <>
          Last year YoY: {pct(r.last)} · 3yr avg: {pct(r.avg3)} · 5yr peak:{" "}
          {pct(r.peak)} · 5yr low: {pct(r.min)}
        </>
      }
      affects="Revenue Y → Operating Income → Net Income → EPS → Price Target"
    />
  );
}

export function tipOpMargin(model: ValuationModelV2): React.ReactNode {
  const r = opMarginRange(model);
  return (
    <TooltipBody
      intro="Operating profit as a % of revenue. Applied uniformly to all three projected years to derive Operating Income."
      howToSet={
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <b>Bear:</b> margin compression from competition / cost pressure
          </li>
          <li>
            <b>Base:</b> assume current margins hold
          </li>
          <li>
            <b>Bull:</b> operational leverage as revenue scales
          </li>
        </ul>
      }
      current={
        <>
          Current: {pct(r.current)} · 5yr range: {pct(r.min)} – {pct(r.max)}
        </>
      }
      affects="Operating Income Y3 → Net Income Y3 → EPS Y3 → Price Target"
    />
  );
}

export function tipTaxRate(model: ValuationModelV2): React.ReactNode {
  return (
    <TooltipBody
      intro="Effective tax rate applied to operating income to get net income. Applied per scenario."
      current={
        <>
          Derived from EDGAR (NI / pre-tax income): {pct(model.tax_rate)}
          <br />
          US federal corporate rate: 21%
        </>
      }
      affects="Net Income Y3 → EPS Y3 → Price Target. Also flows into After-tax Cost of Debt for the DCF."
    />
  );
}

export function tipShares(model: ValuationModelV2): React.ReactNode {
  return (
    <TooltipBody
      intro="Shares outstanding (in millions). EPS = Net Income ÷ Shares — higher shares means lower EPS at the same earnings."
      howToSet={
        <>
          If Yahoo&apos;s number looks wrong (recent buybacks not reflected, ADR
          adjustment, dual-class issue), override here.
        </>
      }
      current={
        <>
          From Yahoo defaultKeyStatistics.sharesOutstanding:{" "}
          {(model.shares_outstanding / 1e6).toFixed(1)}M
        </>
      }
      affects="EPS Y1/Y2/Y3 → Price Target. DCF: Equity Value ÷ Shares = Intrinsic Value."
    />
  );
}

export function tipExitPE(model: ValuationModelV2): React.ReactNode {
  const currentPE =
    model.last_eps && model.last_eps > 0
      ? model.current_price / model.last_eps
      : null;
  const sector = sectorPE(model.sector);
  return (
    <TooltipBody
      intro={
        <>
          The P/E multiple the market will assign to the stock in year 3.{" "}
          <b>Most subjective input</b> — the key question is what P/E this
          business deserves once it matures.
        </>
      }
      howToSet={
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <b>Bear:</b> multiple compression (growth disappoints)
          </li>
          <li>
            <b>Base:</b> sector-average multiple
          </li>
          <li>
            <b>Bull:</b> premium multiple for quality / growth
          </li>
        </ul>
      }
      current={
        <>
          Current P/E: {currentPE !== null ? `${currentPE.toFixed(1)}x` : "—"}{" "}
          · Sector avg ({model.sector ?? "—"}): {sector}x · Forward P/E:{" "}
          {px(model.forward_pe)}
        </>
      }
      affects="Price Target = EPS Y3 × Exit P/E. Most sensitive input after EPS itself."
    />
  );
}

export function tipProbability(): React.ReactNode {
  return (
    <TooltipBody
      intro="Your confidence in each scenario playing out. Probabilities must sum to 100%."
      howToSet={
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            Standard: <b>25 / 50 / 25</b>
          </li>
          <li>
            More bullish: <b>15 / 45 / 40</b>
          </li>
          <li>
            Genuinely uncertain: <b>33 / 34 / 33</b>
          </li>
        </ul>
      }
      affects="Weighted price target only — individual scenario targets unchanged."
    />
  );
}

// ---------- Tier 2 (DCF) ----------

export function tipFCFMargin(model: ValuationModelV2): React.ReactNode {
  const lastFCF = model.fcf_history[model.fcf_history.length - 1] ?? null;
  return (
    <TooltipBody
      intro={
        <>
          Free Cash Flow as % of revenue.{" "}
          <span className="font-mono">FCF = OCF − Capex</span>. Most important
          DCF input after WACC.
        </>
      }
      howToSet="FCF margin is usually LOWER than op margin because capex and working capital consume cash. Bull/bear typically diverge by 200-400bps."
      current={
        <>
          Last year: {pct(lastFCF?.fcf_margin ?? null)} · 3yr avg:{" "}
          {pct(model.fcf_margin_avg)}
        </>
      }
      affects="FCF Y1-Y5 → Sum of PV FCFs → Enterprise Value → Intrinsic Value"
    />
  );
}

export function tipRiskFreeRate(): React.ReactNode {
  return (
    <TooltipBody
      intro="The return on a risk-free investment — typically the 10-year US Treasury yield."
      howToSet="Use the current market rate. Lower RFR → lower WACC → higher valuation."
      current="10y Treasury hovers around 4–5% in 2026."
      affects="Cost of Equity = RFR + β × ERP → WACC → all discount factors → Intrinsic Value"
    />
  );
}

export function tipEquityRiskPremium(): React.ReactNode {
  return (
    <TooltipBody
      intro="Extra return investors demand for stocks vs risk-free bonds."
      current={
        <>Historical avg: 5.0–5.5% · Current market estimate: ~5.5%</>
      }
      affects="Cost of Equity → WACC. Higher ERP = higher discount = lower valuation."
    />
  );
}

export function tipBeta(model: ValuationModelV2): React.ReactNode {
  return (
    <TooltipBody
      intro={
        <>
          Volatility vs market.{" "}
          <span className="font-mono">β = 1.0</span> moves with the market;{" "}
          <span className="font-mono">&gt; 1.0</span> more volatile,{" "}
          <span className="font-mono">&lt; 1.0</span> less.
        </>
      }
      current={
        <>
          From Yahoo Finance: {model.beta !== null ? model.beta.toFixed(2) : "—"}
        </>
      }
      affects="Cost of Equity → WACC. Higher β = higher discount = lower DCF value."
    />
  );
}

export function tipDebtToCapital(model: ValuationModelV2): React.ReactNode {
  const debt = model.total_debt;
  const cash = model.total_cash;
  return (
    <TooltipBody
      intro="The capital structure mix used to weight equity vs debt cost in WACC."
      howToSet="For most non-bank corps, 10–25% debt is typical. Use book values from the balance sheet, or market value of debt if available."
      current={
        <>
          Total debt: ${(debt / 1e9).toFixed(2)}B · Cash: $
          {(cash / 1e9).toFixed(2)}B · Net debt: $
          {(model.net_debt / 1e9).toFixed(2)}B
        </>
      }
      affects="WACC weighting between equity and debt costs."
    />
  );
}

export function tipCostOfDebt(): React.ReactNode {
  return (
    <TooltipBody
      intro="Pre-tax cost of debt — the company's average borrowing rate."
      howToSet="Estimate from interest expense ÷ avg debt balance, or use the yield on the company's longest-dated bonds. Multiply by (1 − tax) for the after-tax CoD that flows into WACC."
      affects="After-tax Cost of Debt → WACC."
    />
  );
}

export function tipTerminalGrowth(): React.ReactNode {
  return (
    <TooltipBody
      intro="Long-term growth rate AFTER year 5, forever. Drives 60–80% of DCF value."
      howToSet={
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            Conservative: <b>2.0–2.5%</b> (mature company)
          </li>
          <li>
            Standard: <b>3.0%</b> (nominal GDP growth)
          </li>
          <li>
            Aggressive: <b>3.5–4.0%</b> (still growing)
          </li>
        </ul>
      }
      warning={
        <>
          A 1pp change in terminal growth can move intrinsic value by 20–30%.
          Cannot exceed WACC — the math breaks down.
        </>
      }
      affects="Terminal Value → PV of Terminal Value → Enterprise Value → Intrinsic Value"
    />
  );
}

export function tipExitMultiple(): React.ReactNode {
  return (
    <TooltipBody
      intro="Used when Terminal Method = Exit Multiple. TV = FCF Y5 × this multiple."
      howToSet="Pick a multiple that reflects how the market values mature businesses in this sector. 10–15x FCF is typical; high-quality compounders can justify 18–25x."
      affects="Terminal Value (when method = Exit Multiple)."
    />
  );
}

export function tipTerminalMethod(): React.ReactNode {
  return (
    <TooltipBody
      intro="Two ways to size the terminal value at the end of year 5."
      howToSet={
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <b>Gordon Growth:</b> TV = FCF₅ × (1 + g) / (WACC − g). Assumes the
            company keeps growing forever at terminal-growth rate.
          </li>
          <li>
            <b>Exit Multiple:</b> TV = FCF₅ × multiple. Approximates a sale or
            steady-state P/FCF re-rate.
          </li>
        </ul>
      }
      affects="Terminal Value → PV of TV → Enterprise Value → Intrinsic Value."
    />
  );
}

// WACC tooltip uses live computed values from the base scenario so the
// formula is anchored to the actual numbers the user is looking at.
export function tipWACC(
  model: ValuationModelV2,
  baseInputs: DCFScenarioInputs,
): React.ReactNode {
  const out = computeTier2Scenario(baseInputs, {
    last_revenue: model.last_revenue,
    shares_outstanding: model.shares_outstanding,
    current_price: model.current_price,
    net_debt: model.net_debt,
    tax_rate: model.tax_rate,
  });
  const E = 1 - baseInputs.debt_to_total_capital;
  const D = baseInputs.debt_to_total_capital;
  return (
    <TooltipBody
      intro="Weighted Average Cost of Capital — the discount rate used to bring future cash flows back to present value."
      current={
        <>
          <div>
            CoE = {pct(baseInputs.risk_free_rate)} +{" "}
            {baseInputs.beta.toFixed(2)} ×{" "}
            {pct(baseInputs.equity_risk_premium)} ={" "}
            <b>{pct(out.cost_of_equity, 2)}</b>
          </div>
          <div>
            ACoD = {pct(baseInputs.cost_of_debt_pretax)} × (1 −{" "}
            {pct(model.tax_rate)}) ={" "}
            <b>{pct(out.after_tax_cost_of_debt, 2)}</b>
          </div>
          <div>
            WACC = {pct(E)} × {pct(out.cost_of_equity, 2)} + {pct(D)} ×{" "}
            {pct(out.after_tax_cost_of_debt, 2)} ={" "}
            <b>{pct(out.wacc, 2)}</b>
          </div>
        </>
      }
      affects="Higher WACC → more aggressive discounting → lower present values → lower intrinsic value. Most sensitive input in the DCF."
    />
  );
}
