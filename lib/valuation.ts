// Valuation model math — pure, no I/O. Used both by the API route on
// initial generation and by the UI on every keystroke for live recalc.
// Keep it deterministic so a server-recomputed model exactly matches
// what the user just saw on screen.

import type { AnnualMetrics } from "@/lib/sec-edgar";

export type ScenarioKey = "bear" | "base" | "bull";

export type ScenarioInputs = {
  rev_growth_y1: number;
  rev_growth_y2: number;
  rev_growth_y3: number;
  op_margin: number;
  exit_pe: number;
  probability: number;
};

export type ScenarioOutputs = {
  rev_y1: number;
  rev_y2: number;
  rev_y3: number;
  eps_y3: number;
  price_target: number;
  return_pct: number;
};

export type ScenarioSet = Record<ScenarioKey, ScenarioInputs>;
export type ScenarioOutputSet = Record<ScenarioKey, ScenarioOutputs>;

export type WeightedOutputs = {
  weighted_target: number;
  weighted_return_pct: number;
};

export type HistoricalRow = {
  year: number;
  revenue: number | null;
  rev_growth: number | null;
  gross_margin: number | null;
  op_margin: number | null;
  net_margin: number | null;
  eps: number | null;
};

export type ValuationModelOutput = {
  saved_at: string;
  current_price: number;
  shares_outstanding: number;
  tax_rate: number;
  last_revenue: number;
  historical: HistoricalRow[];
  system: ScenarioSet;
  user: ScenarioSet;
  customized_fields: string[];
  outputs: ScenarioOutputSet & WeightedOutputs;
  system_outputs: ScenarioOutputSet & WeightedOutputs;
  analyst_target_mean: number | null;
  analyst_target_high: number | null;
  analyst_target_low: number | null;
  analyst_count: number | null;
  sector: string | null;
  forward_pe: number | null;
};

// Yahoo's `sector` strings (which is what we'll have on hand). The spec's
// short labels are mapped through aliases so either form works.
const SECTOR_PE: Record<string, number> = {
  Technology: 28,
  "Consumer Cyclical": 22,
  "Consumer Discretionary": 22,
  Healthcare: 24,
  "Financial Services": 14,
  Financials: 14,
  Energy: 12,
  Industrials: 18,
  "Real Estate": 20,
  Utilities: 16,
  "Basic Materials": 18,
  Materials: 18,
  "Communication Services": 20,
  Communication: 20,
  "Consumer Defensive": 20,
  "Consumer Staples": 20,
};

export function sectorPE(sector: string | null | undefined): number {
  if (!sector) return 20;
  return SECTOR_PE[sector] ?? 20;
}

// Build a HistoricalRow per fiscal year from EDGAR's annual extract. The
// raw rows arrive ascending (oldest first); we keep that orientation here
// because the UI table reads left-to-right oldest → newest.
export function buildHistorical(annual: AnnualMetrics[]): HistoricalRow[] {
  const sorted = [...annual].sort((a, b) => a.year - b.year);
  return sorted.map((row, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    const revGrowth =
      prev && prev.revenue && row.revenue && prev.revenue > 0
        ? (row.revenue - prev.revenue) / prev.revenue
        : null;
    const grossMargin =
      row.revenue && row.grossProfit !== null && row.revenue > 0
        ? row.grossProfit / row.revenue
        : null;
    const opMargin =
      row.revenue && row.operatingIncome !== null && row.revenue > 0
        ? row.operatingIncome / row.revenue
        : null;
    const netMargin =
      row.revenue && row.netIncome !== null && row.revenue > 0
        ? row.netIncome / row.revenue
        : null;
    return {
      year: row.year,
      revenue: row.revenue,
      rev_growth: revGrowth,
      gross_margin: grossMargin,
      op_margin: opMargin,
      net_margin: netMargin,
      eps: row.eps,
    };
  });
}

function recentRevGrowths(historical: HistoricalRow[]): number[] {
  // Skip nulls and reverse so most-recent comes first.
  const growths = historical
    .map((r) => r.rev_growth)
    .filter((g): g is number => g !== null);
  return growths.reverse();
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Effective tax rate from prior-year P&L. If the company posted a loss
// (op income ≤ 0) or the ratio is wild, fall back to the U.S. federal
// corporate rate so projections don't blow up.
export function effectiveTaxRate(
  netIncome: number | null,
  opIncome: number | null,
): number {
  if (netIncome === null || opIncome === null || opIncome <= 0) return 0.21;
  const rate = 1 - netIncome / opIncome;
  if (!Number.isFinite(rate)) return 0.21;
  return Math.max(0.05, Math.min(0.4, rate));
}

export function recommendSystemInputs(args: {
  historical: HistoricalRow[];
  forwardPE: number | null;
  sector: string | null;
}): ScenarioSet {
  const growths = recentRevGrowths(args.historical);
  const lastYearRevGrowth = growths[0] ?? 0.05;
  const avgRevGrowth3yr = avg(growths.slice(0, 3));
  // peakRevGrowth is part of the spec — used as an upper bound only.
  // We don't currently use it but keep for clarity if the recommend
  // logic gets richer later.

  const last = [...args.historical].reverse()[0] ?? null;
  const currentOpMargin = last?.op_margin ?? 0.15;

  const currentPE = args.forwardPE ?? 20;
  const sectorAvg = sectorPE(args.sector);

  const bear_rev = Math.max(lastYearRevGrowth * 0.5, -0.05);
  const base_rev = lastYearRevGrowth;
  const bull_rev = Math.max(avgRevGrowth3yr, lastYearRevGrowth * 1.3);

  const bear_op = currentOpMargin - 0.02;
  const base_op = currentOpMargin;
  const bull_op = currentOpMargin + 0.03;

  const bear_pe = Math.min(currentPE * 0.7, sectorAvg * 0.8);
  const base_pe = sectorAvg;
  const bull_pe = Math.max(currentPE * 1.2, sectorAvg * 1.3);

  const mk = (rev: number, op: number, pe: number, prob: number): ScenarioInputs => ({
    // y1/y2/y3 default to the same growth — the user adjusts the curve.
    // Round so the editable cells aren't full of float noise.
    rev_growth_y1: round4(rev),
    rev_growth_y2: round4(rev),
    rev_growth_y3: round4(rev),
    op_margin: round4(op),
    exit_pe: round2(pe),
    probability: prob,
  });

  return {
    bear: mk(bear_rev, bear_op, bear_pe, 0.25),
    base: mk(base_rev, base_op, base_pe, 0.5),
    bull: mk(bull_rev, bull_op, bull_pe, 0.25),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeScenarioOutputs(
  inputs: ScenarioInputs,
  ctx: {
    last_revenue: number;
    shares_outstanding: number;
    tax_rate: number;
    current_price: number;
  },
): ScenarioOutputs {
  const rev_y1 = ctx.last_revenue * (1 + inputs.rev_growth_y1);
  const rev_y2 = rev_y1 * (1 + inputs.rev_growth_y2);
  const rev_y3 = rev_y2 * (1 + inputs.rev_growth_y3);
  const op_income_y3 = rev_y3 * inputs.op_margin;
  const net_income_y3 = op_income_y3 * (1 - ctx.tax_rate);
  const eps_y3 =
    ctx.shares_outstanding > 0 ? net_income_y3 / ctx.shares_outstanding : 0;
  const price_target = eps_y3 * inputs.exit_pe;
  const return_pct =
    ctx.current_price > 0
      ? (price_target - ctx.current_price) / ctx.current_price
      : 0;
  return { rev_y1, rev_y2, rev_y3, eps_y3, price_target, return_pct };
}

export function computeAllOutputs(
  scenarios: ScenarioSet,
  ctx: {
    last_revenue: number;
    shares_outstanding: number;
    tax_rate: number;
    current_price: number;
  },
): ScenarioOutputSet & WeightedOutputs {
  const bear = computeScenarioOutputs(scenarios.bear, ctx);
  const base = computeScenarioOutputs(scenarios.base, ctx);
  const bull = computeScenarioOutputs(scenarios.bull, ctx);
  const weighted_target =
    bear.price_target * scenarios.bear.probability +
    base.price_target * scenarios.base.probability +
    bull.price_target * scenarios.bull.probability;
  const weighted_return_pct =
    ctx.current_price > 0
      ? (weighted_target - ctx.current_price) / ctx.current_price
      : 0;
  return { bear, base, bull, weighted_target, weighted_return_pct };
}

// Field paths follow `${scenario}.${field}` so customized_fields can be
// rendered cell-by-cell in the UI.
export function diffCustomizedFields(
  user: ScenarioSet,
  system: ScenarioSet,
): string[] {
  const out: string[] = [];
  const scenarios: ScenarioKey[] = ["bear", "base", "bull"];
  const fields: Array<keyof ScenarioInputs> = [
    "rev_growth_y1",
    "rev_growth_y2",
    "rev_growth_y3",
    "op_margin",
    "exit_pe",
    "probability",
  ];
  for (const s of scenarios) {
    for (const f of fields) {
      // Float wobble guard — anything within 1e-6 is "unchanged".
      if (Math.abs(user[s][f] - system[s][f]) > 1e-6) {
        out.push(`${s}.${f}`);
      }
    }
  }
  return out;
}

// Validates a scenario set submitted from the UI. Throws on shape errors
// so the route can return a 400 with a clear message instead of writing
// junk JSON.
export function assertValidScenarios(s: unknown): asserts s is ScenarioSet {
  if (!s || typeof s !== "object") throw new Error("scenarios must be an object");
  const obj = s as Record<string, unknown>;
  for (const k of ["bear", "base", "bull"] as const) {
    const v = obj[k];
    if (!v || typeof v !== "object") throw new Error(`${k}: missing`);
    const sc = v as Record<string, unknown>;
    for (const f of [
      "rev_growth_y1",
      "rev_growth_y2",
      "rev_growth_y3",
      "op_margin",
      "exit_pe",
      "probability",
    ]) {
      const n = sc[f];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new Error(`${k}.${f}: not a finite number`);
      }
    }
  }
}
