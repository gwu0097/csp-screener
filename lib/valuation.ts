// Valuation math — pure, no I/O. Two tiers share the same SharedContext
// (current price, shares, last revenue, etc.) so users can compare a
// quick P/E target against a full DCF intrinsic value without re-entering
// inputs.
//
// Tier 1 (P/E Multiple): bear/base/bull scenarios with rev growth, op
//   margin, exit P/E, tax rate, probability. Outputs include all
//   intermediate rows (rev y1/y2/y3, op income y3, net income y3,
//   eps y1/y2/y3, price target, return, implied mkt cap).
//
// Tier 2 (Full DCF): 5-year FCF projection with WACC built from Cost of
//   Equity (CAPM) + after-tax Cost of Debt; terminal value via Gordon
//   Growth or Exit Multiple; intrinsic value = (sum PV FCF + PV TV -
//   net debt) / shares.
//
// Comps: hardcoded peer list per Yahoo sector; the route fetches each
// peer's quote summary and we render a comparison table with median
// indicators.

import type { AnnualMetrics, DCFAnnualExtras } from "@/lib/sec-edgar";

export type ScenarioKey = "bear" | "base" | "bull";
export const SCENARIOS: ScenarioKey[] = ["bear", "base", "bull"];

// ---------- Tier 1: P/E Multiple ----------

export type ScenarioInputs = {
  rev_growth_y1: number;
  rev_growth_y2: number;
  rev_growth_y3: number;
  op_margin: number;
  exit_pe: number;
  tax_rate: number;
  probability: number;
};

export type ScenarioOutputs = {
  rev_y1: number;
  rev_y2: number;
  rev_y3: number;
  op_income_y3: number;
  net_income_y3: number;
  eps_y1: number;
  eps_y2: number;
  eps_y3: number;
  price_target: number;
  return_pct: number;
  implied_mkt_cap: number;
};

export type ScenarioSet = Record<ScenarioKey, ScenarioInputs>;
export type ScenarioOutputSet = Record<ScenarioKey, ScenarioOutputs>;
export type WeightedOutputs = {
  weighted_target: number;
  weighted_return_pct: number;
};

// ---------- Tier 2: DCF ----------

export type DCFTerminalMethod = "gordon" | "exit_multiple";

export type DCFScenarioInputs = {
  rev_growth_y1: number;
  rev_growth_y2: number;
  rev_growth_y3: number;
  rev_growth_y4: number;
  rev_growth_y5: number;
  fcf_margin: number;
  risk_free_rate: number;
  equity_risk_premium: number;
  beta: number;
  debt_to_total_capital: number;
  cost_of_debt_pretax: number;
  terminal_growth_rate: number;
  terminal_method: DCFTerminalMethod;
  exit_multiple: number;
  probability: number;
};

export type DCFFCFRow = {
  year: number;
  revenue: number;
  fcf_margin: number;
  fcf: number;
  discount_factor: number;
  pv_fcf: number;
};

export type DCFScenarioOutputs = {
  cost_of_equity: number;
  after_tax_cost_of_debt: number;
  wacc: number;
  fcf_projection: DCFFCFRow[];
  sum_pv_fcf: number;
  terminal_value: number;
  pv_terminal: number;
  enterprise_value: number;
  net_debt: number;
  equity_value: number;
  intrinsic_value: number;
  return_pct: number;
};

export type DCFScenarioSet = Record<ScenarioKey, DCFScenarioInputs>;
export type DCFScenarioOutputSet = Record<ScenarioKey, DCFScenarioOutputs>;

// ---------- Historical & shared context ----------

export type HistoricalRow = {
  year: number;
  revenue: number | null;
  rev_growth: number | null;
  gross_margin: number | null;
  op_margin: number | null;
  net_margin: number | null;
  eps: number | null;
};

export type FCFHistoryRow = {
  year: number;
  revenue: number | null;
  da: number | null;
  capex: number | null;
  ocf: number | null;
  fcf: number | null;
  fcf_margin: number | null;
};

export type CompRow = {
  ticker: string;
  current_price: number | null;
  trailing_pe: number | null;
  forward_pe: number | null;
  ev_to_ebitda: number | null;
  price_to_sales: number | null;
  return_on_equity: number | null;
  revenue_growth: number | null;
};

export type CompsBlock = {
  peers: CompRow[];
  median: {
    trailing_pe: number | null;
    forward_pe: number | null;
    ev_to_ebitda: number | null;
    price_to_sales: number | null;
  };
};

export type ValuationModelV2 = {
  schema_version: 2;
  saved_at: string;

  // Frozen at first save so a re-opened version reproduces the same
  // numbers regardless of how prices have moved since.
  current_price: number;
  shares_outstanding: number; // editable globally per version
  last_revenue: number;
  last_op_margin: number;
  last_eps: number | null;
  forward_pe: number | null;
  trailing_pe: number | null;
  sector: string | null;
  tax_rate: number; // editable globally; both tiers consume it

  historical: HistoricalRow[];
  fcf_history: FCFHistoryRow[];
  da_pct_revenue: number;
  capex_pct_revenue: number;
  fcf_margin_avg: number;
  beta: number | null;
  total_debt: number;
  total_cash: number;
  net_debt: number;

  analyst_target_mean: number | null;
  analyst_target_high: number | null;
  analyst_target_low: number | null;
  analyst_count: number | null;

  tier1: {
    system: ScenarioSet;
    user: ScenarioSet;
    customized_fields: string[];
    outputs: ScenarioOutputSet & WeightedOutputs;
    system_outputs: ScenarioOutputSet & WeightedOutputs;
  };

  tier2: {
    system: DCFScenarioSet;
    user: DCFScenarioSet;
    customized_fields: string[];
    outputs: DCFScenarioOutputSet & WeightedDCFOutputs;
    system_outputs: DCFScenarioOutputSet & WeightedDCFOutputs;
  };

  comps: CompsBlock | null;

  // Optional metadata about where the EDGAR-sourced figures came from
  // and how they were normalized. Populated for foreign private
  // issuers (20-F / 40-F) reporting in non-USD currencies; absent on
  // older rows and on US-domestic filers (which always satisfy
  // currency='USD', taxonomy='us-gaap', formType='10-K' implicitly).
  reporting_currency?: string | null;
  fx_to_usd?: number | null;
  source_form?: string | null;
  source_taxonomy?: string | null;

  // Stock classification + growth-relevant Yahoo fields. The category
  // drives the Tier 1 exit-PE recommendation (growth → fwd PE bands,
  // value → sector PE bands, blend → trailing PE bands) and the
  // model-recommendation banner the UI shows above the tabs.
  category?: ValuationCategory | null;
  forward_eps?: number | null;
  revenue_growth_ttm?: number | null;
  earnings_growth_ttm?: number | null;
  // Analyst long-term EPS growth (5-year if available, else 1-year)
  // — the canonical PEG denominator. TTM earnings growth distorts on
  // turnaround names where the prior period was negative; this field
  // gives the projected sustainable rate.
  analyst_eps_growth_lt?: number | null;

  // Auto-computed assumptions from earnings_releases + EDGAR quarterly
  // data, used to seed the Tier 1 / Tier 2 rev_growth_y* defaults when
  // present. The UI surfaces these so the user can see exactly which
  // recent quarters drove the base case before overriding manually.
  // Both fields are absent on saved rows from before this auto-set
  // landed; the model still works — defaults fall back to the older
  // recommendTier1 logic in that case.
  growth_assumptions?: {
    baseCase: number; // decimal (0.25 = 25%)
    bearCase: number;
    bullCase: number;
    dataPoints: Array<{
      quarter: string;
      periodEnd: string;
      growth: number; // percent
      used: boolean;
      flagged?: string;
      source: "release" | "edgar";
    }>;
    method: string;
    source: "earnings_releases" | "edgar" | "blend";
  } | null;
  ttm_eps?: {
    ttmEps: number;
    quarters: Array<{
      quarter: string;
      eps: number;
      source: "release" | "edgar" | "derived";
    }>;
    method: string;
  } | null;
};

export type ValuationCategory = "growth" | "value" | "blend" | "pre_profit";

// Classifier — matches the spec the trader walked through with SPOT.
// Order matters: pre-profit catches negative-EPS / negative-NI cases
// AFTER the growth gate so a high-flying unprofitable growth name
// (RBLX, PLTR pre-2023, etc.) lands in 'growth' rather than
// 'pre_profit'. Inputs are decimal fractions (e.g. 0.20 for 20%).
//
// Growth gate is intentionally permissive — any of fwdPE > 25, revenue
// > 15%, or earnings > 20% is enough. SPOT (fwdPE 25.8, rev +6.8%,
// EPS +213% post-turnaround) misses on revenue growth alone but its
// earnings ramp clearly pegs it as growth, so the EPS gate catches it.
export function classifyStock(args: {
  forwardPE: number | null;
  revenueGrowthTTM: number | null;
  earningsGrowthTTM?: number | null;
  netIncome: number | null;
  eps: number | null;
}): ValuationCategory {
  const fp = args.forwardPE;
  const rg = args.revenueGrowthTTM;
  const eg = args.earningsGrowthTTM ?? null;
  const ni = args.netIncome;
  const eps = args.eps;
  const isGrowth =
    (typeof fp === "number" && fp > 25) ||
    (typeof rg === "number" && rg > 0.15) ||
    (typeof eg === "number" && eg > 0.2);
  if (isGrowth) return "growth";
  const isValue =
    typeof fp === "number" &&
    fp < 18 &&
    typeof rg === "number" &&
    rg < 0.1;
  if (isValue) return "value";
  const isPreProfit =
    (typeof ni === "number" && ni < 0) ||
    (typeof eps === "number" && eps < 0);
  if (isPreProfit) return "pre_profit";
  return "blend";
}

export type WeightedDCFOutputs = {
  weighted_target: number;
  weighted_return_pct: number;
};

// Backwards-compat: this is the v1 shape we shipped previously. Old
// research_modules rows have it; the UI normalises them on read.
export type ValuationModelV1 = {
  saved_at: string;
  current_price: number;
  shares_outstanding: number;
  tax_rate: number;
  last_revenue: number;
  historical: HistoricalRow[];
  system: {
    bear: V1Inputs;
    base: V1Inputs;
    bull: V1Inputs;
  };
  user: {
    bear: V1Inputs;
    base: V1Inputs;
    bull: V1Inputs;
  };
  customized_fields: string[];
  outputs: Record<ScenarioKey, V1Outputs> & WeightedOutputs;
  system_outputs: Record<ScenarioKey, V1Outputs> & WeightedOutputs;
  analyst_target_mean: number | null;
  analyst_target_high: number | null;
  analyst_target_low: number | null;
  analyst_count: number | null;
  sector: string | null;
  forward_pe: number | null;
};

type V1Inputs = {
  rev_growth_y1: number;
  rev_growth_y2: number;
  rev_growth_y3: number;
  op_margin: number;
  exit_pe: number;
  probability: number;
};
type V1Outputs = {
  rev_y1: number;
  rev_y2: number;
  rev_y3: number;
  eps_y3: number;
  price_target: number;
  return_pct: number;
};

export function isV2(o: unknown): o is ValuationModelV2 {
  return (
    !!o &&
    typeof o === "object" &&
    (o as { schema_version?: number }).schema_version === 2
  );
}

// ---------- Sector maps ----------

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

// Hardcoded peer lists. We pick by (sector, industry-ish vibe) — Yahoo's
// industry strings are too granular to key directly. Default falls back
// to a generic large-cap basket.
const PEER_LISTS: Record<string, string[]> = {
  // Apparel-flavoured consumer cyclical names — LULU-adjacent.
  "Consumer Cyclical": ["NKE", "ONON", "CROX", "VFC", "RL"],
  "Consumer Discretionary": ["NKE", "ONON", "CROX", "VFC", "RL"],
  Technology: ["MSFT", "GOOGL", "AAPL", "META", "AMZN"],
  Healthcare: ["JNJ", "PFE", "UNH", "MRK", "LLY"],
  "Financial Services": ["JPM", "BAC", "WFC", "GS", "MS"],
  Financials: ["JPM", "BAC", "WFC", "GS", "MS"],
  Energy: ["XOM", "CVX", "COP", "EOG", "SLB"],
  Industrials: ["GE", "HON", "CAT", "DE", "RTX"],
  "Real Estate": ["O", "AMT", "PLD", "SPG", "EQIX"],
  Utilities: ["NEE", "DUK", "SO", "AEP", "D"],
  "Basic Materials": ["LIN", "FCX", "NUE", "DOW", "APD"],
  Materials: ["LIN", "FCX", "NUE", "DOW", "APD"],
  "Communication Services": ["GOOGL", "META", "VZ", "T", "DIS"],
  Communication: ["GOOGL", "META", "VZ", "T", "DIS"],
  "Consumer Defensive": ["KO", "PEP", "PG", "WMT", "COST"],
  "Consumer Staples": ["KO", "PEP", "PG", "WMT", "COST"],
};

const DEFAULT_PEERS = ["SPY", "QQQ", "IWM"];

export function peersForSector(sector: string | null | undefined): string[] {
  if (!sector) return DEFAULT_PEERS;
  return PEER_LISTS[sector] ?? DEFAULT_PEERS;
}

// ---------- Historical builders ----------

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

export function buildFCFHistory(
  annual: AnnualMetrics[],
  extras: DCFAnnualExtras[],
): FCFHistoryRow[] {
  const byYearRev = new Map<number, number | null>();
  for (const r of annual) byYearRev.set(r.year, r.revenue);
  const sorted = [...extras].sort((a, b) => a.year - b.year);
  return sorted.map((e) => {
    const rev = byYearRev.get(e.year) ?? null;
    const fcf =
      e.ocf !== null && e.capex !== null ? e.ocf - e.capex : null;
    const fcfMargin =
      fcf !== null && rev !== null && rev > 0 ? fcf / rev : null;
    return {
      year: e.year,
      revenue: rev,
      da: e.da,
      capex: e.capex,
      ocf: e.ocf,
      fcf,
      fcf_margin: fcfMargin,
    };
  });
}

function recentRevGrowths(historical: HistoricalRow[]): number[] {
  const growths = historical
    .map((r) => r.rev_growth)
    .filter((g): g is number => g !== null);
  return growths.reverse();
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function effectiveTaxRate(
  netIncome: number | null,
  opIncome: number | null,
): number {
  if (netIncome === null || opIncome === null || opIncome <= 0) return 0.21;
  const rate = 1 - netIncome / opIncome;
  if (!Number.isFinite(rate)) return 0.21;
  return Math.max(0.05, Math.min(0.4, rate));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- Tier 1 system recommendation ----------

export function recommendTier1(args: {
  historical: HistoricalRow[];
  forwardPE: number | null;
  trailingPE?: number | null;
  sector: string | null;
  taxRate: number;
  // Stock category — drives the Bear/Base/Bull exit-PE bands so a
  // growth name doesn't get crushed by sector-average expectations
  // and a value name doesn't get inflated bull cases. Caller passes
  // the classifier output from the route; falls back to the sector-
  // anchored defaults when omitted (the previous behavior).
  category?: ValuationCategory | null;
}): ScenarioSet {
  const growths = recentRevGrowths(args.historical);
  const lastYearRevGrowth = growths[0] ?? 0.05;
  const avgRevGrowth3yr = avg(growths.slice(0, 3));

  const last = [...args.historical].reverse()[0] ?? null;
  const currentOpMargin = last?.op_margin ?? 0.15;

  const currentPE = args.forwardPE ?? 20;
  const trailingPE = args.trailingPE ?? currentPE;
  const sectorAvg = sectorPE(args.sector);

  const bear_rev = Math.max(lastYearRevGrowth * 0.5, -0.05);
  const base_rev = lastYearRevGrowth;
  const bull_rev = Math.max(avgRevGrowth3yr, lastYearRevGrowth * 1.3);

  const bear_op = currentOpMargin - 0.02;
  const base_op = currentOpMargin;
  const bull_op = currentOpMargin + 0.03;

  // Exit-PE bands by category. Growth names anchor on forward PE
  // (the multiple the market is willing to pay for next-year earnings),
  // value names anchor on sector average (multiple is the regression-
  // to-mean lever), blend names anchor on trailing PE (no clear
  // narrative, just normalize toward where the stock has traded).
  // Pre-profit stocks have no clean PE anchor; fall through to the
  // forward-PE bands so the model still produces a number, but the
  // UI banner steers the user toward EV/Revenue.
  let bear_pe: number;
  let base_pe: number;
  let bull_pe: number;
  if (args.category === "growth" || args.category === "pre_profit") {
    bear_pe = currentPE * 0.6;
    base_pe = currentPE * 0.9;
    bull_pe = currentPE * 1.1;
  } else if (args.category === "value") {
    bear_pe = sectorAvg * 0.8;
    base_pe = sectorAvg * 1.0;
    bull_pe = sectorAvg * 1.2;
  } else if (args.category === "blend") {
    bear_pe = trailingPE * 0.6;
    base_pe = trailingPE * 0.85;
    bull_pe = trailingPE * 1.1;
  } else {
    // No category provided — preserve the prior behavior so callers
    // that haven't been updated still get the same numbers.
    bear_pe = Math.min(currentPE * 0.7, sectorAvg * 0.8);
    base_pe = sectorAvg;
    bull_pe = Math.max(currentPE * 1.2, sectorAvg * 1.3);
  }

  const mk = (rev: number, op: number, pe: number, prob: number): ScenarioInputs => ({
    rev_growth_y1: round4(rev),
    rev_growth_y2: round4(rev),
    rev_growth_y3: round4(rev),
    op_margin: round4(op),
    exit_pe: round2(pe),
    tax_rate: round4(args.taxRate),
    probability: prob,
  });

  return {
    bear: mk(bear_rev, bear_op, bear_pe, 0.25),
    base: mk(base_rev, base_op, base_pe, 0.5),
    bull: mk(bull_rev, bull_op, bull_pe, 0.25),
  };
}

// ---------- Tier 1 math ----------

export type Tier1Ctx = {
  last_revenue: number;
  shares_outstanding: number;
  current_price: number;
  // EPS-anchor mode (growth-stock branch). When category is 'growth'
  // AND forward_eps is positive, computeTier1Scenario uses
  // forward_eps as EPS Y1 directly and compounds by eps_growth_rate
  // (or the scenario's rev_growth_y* as fallback) instead of the
  // revenue × margin × (1−tax) chain. The chain is conservative for
  // turnaround / accelerating-margin names because it ignores the
  // analyst-forward beat already baked into Yahoo's earningsTrend.
  // Optional + back-compat — value/blend stocks fall through to the
  // existing revenue path.
  category?: ValuationCategory | null;
  forward_eps?: number | null;
  eps_growth_rate?: number | null;
};

// Whether ctx triggers the EPS-anchor path. Exposed so the UI can
// surface "EPS anchored on analyst forward estimate" copy without
// duplicating the rule.
export function shouldUseEpsAnchor(
  ctx: Pick<Tier1Ctx, "category" | "forward_eps">,
): boolean {
  return (
    ctx.category === "growth" &&
    typeof ctx.forward_eps === "number" &&
    Number.isFinite(ctx.forward_eps) &&
    ctx.forward_eps > 0
  );
}

export function computeTier1Scenario(
  inputs: ScenarioInputs,
  ctx: Tier1Ctx,
): ScenarioOutputs {
  const shares = ctx.shares_outstanding;
  const oneMinusTax = 1 - inputs.tax_rate;

  if (shouldUseEpsAnchor(ctx)) {
    // Growth path: anchor Y1 on forward EPS (analyst estimate),
    // compound by eps_growth_rate when present, else fall back to
    // the scenario's rev_growth_y* numbers per year.
    const epsG = ctx.eps_growth_rate;
    const useEpsG =
      typeof epsG === "number" && Number.isFinite(epsG) && epsG > 0;
    const g2 = useEpsG ? epsG! : inputs.rev_growth_y2;
    const g3 = useEpsG ? epsG! : inputs.rev_growth_y3;

    const eps_y1 = ctx.forward_eps as number;
    const eps_y2 = eps_y1 * (1 + g2);
    const eps_y3 = eps_y2 * (1 + g3);

    // Back-derive income + revenue so the projection table reads
    // consistently with EPS. shares × EPS = net income; / (1−tax) =
    // operating income; / op_margin = revenue. When shares or
    // op_margin are zero we still return zeros (matches the
    // existing chain's behavior in degenerate cases).
    const net_income_y1 = eps_y1 * shares;
    const net_income_y2 = eps_y2 * shares;
    const net_income_y3 = eps_y3 * shares;
    const op_income_y1 = oneMinusTax > 0 ? net_income_y1 / oneMinusTax : 0;
    const op_income_y2 = oneMinusTax > 0 ? net_income_y2 / oneMinusTax : 0;
    const op_income_y3 = oneMinusTax > 0 ? net_income_y3 / oneMinusTax : 0;
    const rev_y1 = inputs.op_margin > 0 ? op_income_y1 / inputs.op_margin : 0;
    const rev_y2 = inputs.op_margin > 0 ? op_income_y2 / inputs.op_margin : 0;
    const rev_y3 = inputs.op_margin > 0 ? op_income_y3 / inputs.op_margin : 0;

    const price_target = eps_y3 * inputs.exit_pe;
    const return_pct =
      ctx.current_price > 0
        ? (price_target - ctx.current_price) / ctx.current_price
        : 0;
    const implied_mkt_cap = price_target * shares;
    return {
      rev_y1,
      rev_y2,
      rev_y3,
      op_income_y3,
      net_income_y3,
      eps_y1,
      eps_y2,
      eps_y3,
      price_target,
      return_pct,
      implied_mkt_cap,
    };
  }

  // Default revenue × margin path (value / blend / pre_profit).
  const rev_y1 = ctx.last_revenue * (1 + inputs.rev_growth_y1);
  const rev_y2 = rev_y1 * (1 + inputs.rev_growth_y2);
  const rev_y3 = rev_y2 * (1 + inputs.rev_growth_y3);
  const op_income_y1 = rev_y1 * inputs.op_margin;
  const op_income_y2 = rev_y2 * inputs.op_margin;
  const op_income_y3 = rev_y3 * inputs.op_margin;
  const net_income_y1 = op_income_y1 * oneMinusTax;
  const net_income_y2 = op_income_y2 * oneMinusTax;
  const net_income_y3 = op_income_y3 * oneMinusTax;
  const eps_y1 = shares > 0 ? net_income_y1 / shares : 0;
  const eps_y2 = shares > 0 ? net_income_y2 / shares : 0;
  const eps_y3 = shares > 0 ? net_income_y3 / shares : 0;
  const price_target = eps_y3 * inputs.exit_pe;
  const return_pct =
    ctx.current_price > 0
      ? (price_target - ctx.current_price) / ctx.current_price
      : 0;
  const implied_mkt_cap = price_target * shares;
  return {
    rev_y1,
    rev_y2,
    rev_y3,
    op_income_y3,
    net_income_y3,
    eps_y1,
    eps_y2,
    eps_y3,
    price_target,
    return_pct,
    implied_mkt_cap,
  };
}

export function computeTier1All(
  scenarios: ScenarioSet,
  ctx: Tier1Ctx,
): ScenarioOutputSet & WeightedOutputs {
  const bear = computeTier1Scenario(scenarios.bear, ctx);
  const base = computeTier1Scenario(scenarios.base, ctx);
  const bull = computeTier1Scenario(scenarios.bull, ctx);
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

// ---------- Tier 2 (DCF) system recommendation ----------

export function recommendTier2(args: {
  historical: HistoricalRow[];
  fcfHistory: FCFHistoryRow[];
  beta: number | null;
  taxRate: number;
}): DCFScenarioSet {
  const growths = recentRevGrowths(args.historical);
  const lastYearRevGrowth = growths[0] ?? 0.05;
  const avgGrowth = avg(growths.slice(0, 3));

  const fcfMargins = args.fcfHistory
    .map((r) => r.fcf_margin)
    .filter((x): x is number => x !== null);
  const avgFcfMargin = fcfMargins.length > 0 ? avg(fcfMargins.slice(-3)) : 0.1;

  const beta = args.beta ?? 1.1;

  // Sensible defaults — RFR roughly tracks 10y treasury, ERP ~5-6%, CoD
  // proxy ~5%. Capital structure 85/15 is typical for non-bank corps.
  const RFR = 0.045;
  const ERP = 0.055;
  const COD = 0.05;
  const D_TC = 0.15;

  const mk = (
    rev: number,
    fcf: number,
    bD: number,
    g: number,
    prob: number,
  ): DCFScenarioInputs => ({
    rev_growth_y1: round4(rev),
    rev_growth_y2: round4(rev),
    rev_growth_y3: round4(rev),
    rev_growth_y4: round4(rev * 0.9),
    rev_growth_y5: round4(rev * 0.8),
    fcf_margin: round4(fcf),
    risk_free_rate: round4(RFR),
    equity_risk_premium: round4(ERP),
    beta: round2(bD),
    debt_to_total_capital: round4(D_TC),
    cost_of_debt_pretax: round4(COD),
    terminal_growth_rate: round4(g),
    terminal_method: "gordon",
    exit_multiple: 15,
    probability: prob,
  });

  const bear_rev = Math.max(lastYearRevGrowth * 0.5, -0.03);
  const base_rev = lastYearRevGrowth;
  const bull_rev = Math.max(avgGrowth, lastYearRevGrowth * 1.2);

  return {
    bear: mk(bear_rev, Math.max(0.05, avgFcfMargin - 0.03), beta * 1.1, 0.02, 0.25),
    base: mk(base_rev, Math.max(0.08, avgFcfMargin), beta, 0.03, 0.5),
    bull: mk(bull_rev, avgFcfMargin + 0.03, Math.max(0.7, beta * 0.9), 0.04, 0.25),
  };
}

// ---------- Tier 2 (DCF) math ----------

export type Tier2Ctx = {
  last_revenue: number;
  shares_outstanding: number;
  current_price: number;
  net_debt: number;
  tax_rate: number;
};

export function computeTier2Scenario(
  inputs: DCFScenarioInputs,
  ctx: Tier2Ctx,
): DCFScenarioOutputs {
  const cost_of_equity =
    inputs.risk_free_rate + inputs.beta * inputs.equity_risk_premium;
  const after_tax_cost_of_debt = inputs.cost_of_debt_pretax * (1 - ctx.tax_rate);
  const equityWeight = 1 - inputs.debt_to_total_capital;
  const wacc =
    equityWeight * cost_of_equity + inputs.debt_to_total_capital * after_tax_cost_of_debt;

  const growths = [
    inputs.rev_growth_y1,
    inputs.rev_growth_y2,
    inputs.rev_growth_y3,
    inputs.rev_growth_y4,
    inputs.rev_growth_y5,
  ];

  const projection: DCFFCFRow[] = [];
  let revenue = ctx.last_revenue;
  let cumulativeDiscount = 1;
  let sumPV = 0;
  for (let y = 1; y <= 5; y++) {
    revenue = revenue * (1 + growths[y - 1]);
    const fcf = revenue * inputs.fcf_margin;
    cumulativeDiscount *= 1 + wacc;
    const pv_fcf = fcf / cumulativeDiscount;
    sumPV += pv_fcf;
    projection.push({
      year: y,
      revenue,
      fcf_margin: inputs.fcf_margin,
      fcf,
      discount_factor: cumulativeDiscount,
      pv_fcf,
    });
  }

  const fcfY5 = projection[4].fcf;
  let terminal_value = 0;
  if (inputs.terminal_method === "gordon") {
    if (wacc > inputs.terminal_growth_rate + 1e-6) {
      terminal_value =
        (fcfY5 * (1 + inputs.terminal_growth_rate)) /
        (wacc - inputs.terminal_growth_rate);
    } else {
      // Pathological inputs (g >= WACC) — UI will warn; return 0 so the
      // intrinsic value collapses into "PV of FCFs only" rather than
      // exploding.
      terminal_value = 0;
    }
  } else {
    terminal_value = fcfY5 * inputs.exit_multiple;
  }
  const pv_terminal =
    cumulativeDiscount > 0 ? terminal_value / cumulativeDiscount : 0;

  const enterprise_value = sumPV + pv_terminal;
  const equity_value = enterprise_value - ctx.net_debt;
  const intrinsic_value =
    ctx.shares_outstanding > 0 ? equity_value / ctx.shares_outstanding : 0;
  const return_pct =
    ctx.current_price > 0
      ? (intrinsic_value - ctx.current_price) / ctx.current_price
      : 0;

  return {
    cost_of_equity,
    after_tax_cost_of_debt,
    wacc,
    fcf_projection: projection,
    sum_pv_fcf: sumPV,
    terminal_value,
    pv_terminal,
    enterprise_value,
    net_debt: ctx.net_debt,
    equity_value,
    intrinsic_value,
    return_pct,
  };
}

export function computeTier2All(
  scenarios: DCFScenarioSet,
  ctx: Tier2Ctx,
): DCFScenarioOutputSet & WeightedDCFOutputs {
  const bear = computeTier2Scenario(scenarios.bear, ctx);
  const base = computeTier2Scenario(scenarios.base, ctx);
  const bull = computeTier2Scenario(scenarios.bull, ctx);
  const weighted_target =
    bear.intrinsic_value * scenarios.bear.probability +
    base.intrinsic_value * scenarios.base.probability +
    bull.intrinsic_value * scenarios.bull.probability;
  const weighted_return_pct =
    ctx.current_price > 0
      ? (weighted_target - ctx.current_price) / ctx.current_price
      : 0;
  return { bear, base, bull, weighted_target, weighted_return_pct };
}

// ---------- Diff helpers ----------

export function diffTier1Customized(
  user: ScenarioSet,
  system: ScenarioSet,
): string[] {
  const out: string[] = [];
  const fields: Array<keyof ScenarioInputs> = [
    "rev_growth_y1",
    "rev_growth_y2",
    "rev_growth_y3",
    "op_margin",
    "exit_pe",
    "tax_rate",
    "probability",
  ];
  for (const s of SCENARIOS) {
    for (const f of fields) {
      if (Math.abs(user[s][f] - system[s][f]) > 1e-6) {
        out.push(`${s}.${f}`);
      }
    }
  }
  return out;
}

export function diffTier2Customized(
  user: DCFScenarioSet,
  system: DCFScenarioSet,
): string[] {
  const out: string[] = [];
  const numFields: Array<keyof DCFScenarioInputs> = [
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
  for (const s of SCENARIOS) {
    for (const f of numFields) {
      const a = user[s][f] as number;
      const b = system[s][f] as number;
      if (Math.abs(a - b) > 1e-6) out.push(`${s}.${f}`);
    }
    if (user[s].terminal_method !== system[s].terminal_method) {
      out.push(`${s}.terminal_method`);
    }
  }
  return out;
}

export function assertValidTier1(s: unknown): asserts s is ScenarioSet {
  if (!s || typeof s !== "object") throw new Error("scenarios must be an object");
  const obj = s as Record<string, unknown>;
  for (const k of SCENARIOS) {
    const v = obj[k];
    if (!v || typeof v !== "object") throw new Error(`${k}: missing`);
    const sc = v as Record<string, unknown>;
    for (const f of [
      "rev_growth_y1",
      "rev_growth_y2",
      "rev_growth_y3",
      "op_margin",
      "exit_pe",
      "tax_rate",
      "probability",
    ]) {
      const n = sc[f];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new Error(`${k}.${f}: not a finite number`);
      }
    }
  }
}

export function assertValidTier2(s: unknown): asserts s is DCFScenarioSet {
  if (!s || typeof s !== "object") throw new Error("dcf scenarios must be an object");
  const obj = s as Record<string, unknown>;
  for (const k of SCENARIOS) {
    const v = obj[k];
    if (!v || typeof v !== "object") throw new Error(`${k}: missing`);
    const sc = v as Record<string, unknown>;
    const numFields = [
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
      const n = sc[f];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new Error(`${k}.${f}: not a finite number`);
      }
    }
    const tm = sc.terminal_method;
    if (tm !== "gordon" && tm !== "exit_multiple") {
      throw new Error(`${k}.terminal_method: must be 'gordon' or 'exit_multiple'`);
    }
  }
}

// ---------- Comps median ----------

export function medianOf(nums: Array<number | null>): number | null {
  const xs = nums.filter((n): n is number => n !== null && Number.isFinite(n));
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
