import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import {
  convertAnnualToUsd,
  convertDCFExtrasToUsd,
  extractAnnualMetrics,
  extractDCFExtras,
  fetchFxToUsd,
  getCIK,
  getCompanyFacts,
  getReportingInfo,
} from "@/lib/sec-edgar";
import {
  getModuleHistory,
  recomputeOverallGrade,
  saveModule,
} from "@/lib/research-modules";
import { createServerClient } from "@/lib/supabase";
import {
  assertValidTier1,
  assertValidTier2,
  buildFCFHistory,
  buildHistorical,
  computeTier1All,
  computeTier2All,
  diffTier1Customized,
  diffTier2Customized,
  effectiveTaxRate,
  medianOf,
  peersForSector,
  recommendTier1,
  recommendTier2,
  type CompRow,
  type CompsBlock,
  type DCFScenarioSet,
  type ScenarioSet,
  type ValuationModelV2,
} from "@/lib/valuation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const yahooFinance = new (
  YahooFinance as unknown as new () => Record<string, unknown>
)();
type YFClient = {
  quote: (
    s: string,
    q?: Record<string, unknown>,
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
  quoteSummary: (
    s: string,
    o: { modules: string[] },
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};
const yf = yahooFinance as unknown as YFClient;
const MODULE_OPTS = { validateResult: false } as const;

function unwrapNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

type YahooBag = {
  currentPrice: number | null;
  forwardEps: number | null;
  trailingEps: number | null;
  forwardPE: number | null;
  trailingPE: number | null;
  totalRevenueTTM: number | null;
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalystOpinions: number | null;
  sharesOutstanding: number | null;
  impliedSharesOutstanding: number | null;
  floatShares: number | null;
  beta: number | null;
  totalDebt: number | null;
  totalCash: number | null;
  sector: string | null;
};

async function fetchYahooBag(symbol: string): Promise<YahooBag> {
  let summary: Record<string, unknown> | null = null;
  let quote: Record<string, unknown> | null = null;
  try {
    [summary, quote] = (await Promise.all([
      yf.quoteSummary(
        symbol,
        {
          modules: [
            "financialData",
            "defaultKeyStatistics",
            "summaryDetail",
            "assetProfile",
            "price",
          ],
        },
        MODULE_OPTS,
      ),
      yf.quote(symbol, undefined, MODULE_OPTS),
    ])) as [Record<string, unknown> | null, Record<string, unknown> | null];
  } catch {
    summary = null;
    quote = null;
  }
  const fd = ((summary?.financialData ?? {}) as Record<string, unknown>) ?? {};
  const dks = ((summary?.defaultKeyStatistics ?? {}) as Record<string, unknown>) ?? {};
  const sd = ((summary?.summaryDetail ?? {}) as Record<string, unknown>) ?? {};
  const ap = ((summary?.assetProfile ?? {}) as Record<string, unknown>) ?? {};
  const price = ((summary?.price ?? {}) as Record<string, unknown>) ?? {};

  const currentPrice =
    unwrapNumber(fd.currentPrice) ??
    unwrapNumber(price.regularMarketPrice) ??
    unwrapNumber((quote ?? {}).regularMarketPrice);

  return {
    currentPrice,
    forwardEps: unwrapNumber(dks.forwardEps),
    trailingEps: unwrapNumber(dks.trailingEps),
    forwardPE: unwrapNumber(sd.forwardPE) ?? unwrapNumber(dks.forwardPE),
    trailingPE: unwrapNumber(sd.trailingPE) ?? unwrapNumber(dks.trailingPE),
    totalRevenueTTM: unwrapNumber(fd.totalRevenue),
    targetMeanPrice: unwrapNumber(fd.targetMeanPrice),
    targetHighPrice: unwrapNumber(fd.targetHighPrice),
    targetLowPrice: unwrapNumber(fd.targetLowPrice),
    numberOfAnalystOpinions: unwrapNumber(fd.numberOfAnalystOpinions),
    sharesOutstanding: unwrapNumber(dks.sharesOutstanding),
    impliedSharesOutstanding: unwrapNumber(dks.impliedSharesOutstanding),
    floatShares: unwrapNumber(dks.floatShares),
    beta: unwrapNumber(dks.beta),
    totalDebt: unwrapNumber(fd.totalDebt),
    totalCash: unwrapNumber(fd.totalCash),
    sector: typeof ap.sector === "string" ? (ap.sector as string) : null,
  };
}

async function fetchPeerRow(ticker: string): Promise<CompRow> {
  try {
    const summary = (await yf.quoteSummary(
      ticker,
      {
        modules: [
          "financialData",
          "defaultKeyStatistics",
          "summaryDetail",
          "price",
        ],
      },
      MODULE_OPTS,
    )) as Record<string, unknown>;
    const fd = ((summary?.financialData ?? {}) as Record<string, unknown>) ?? {};
    const dks = ((summary?.defaultKeyStatistics ?? {}) as Record<string, unknown>) ?? {};
    const sd = ((summary?.summaryDetail ?? {}) as Record<string, unknown>) ?? {};
    const price = ((summary?.price ?? {}) as Record<string, unknown>) ?? {};
    return {
      ticker,
      current_price:
        unwrapNumber(fd.currentPrice) ?? unwrapNumber(price.regularMarketPrice),
      trailing_pe: unwrapNumber(sd.trailingPE) ?? unwrapNumber(dks.trailingPE),
      forward_pe: unwrapNumber(sd.forwardPE) ?? unwrapNumber(dks.forwardPE),
      ev_to_ebitda: unwrapNumber(dks.enterpriseToEbitda),
      price_to_sales:
        unwrapNumber(sd.priceToSalesTrailing12Months) ??
        unwrapNumber(dks.priceToSalesTrailing12Months),
      return_on_equity: unwrapNumber(fd.returnOnEquity),
      revenue_growth: unwrapNumber(fd.revenueGrowth),
    };
  } catch {
    return {
      ticker,
      current_price: null,
      trailing_pe: null,
      forward_pe: null,
      ev_to_ebitda: null,
      price_to_sales: null,
      return_on_equity: null,
      revenue_growth: null,
    };
  }
}

async function buildComps(
  symbol: string,
  sector: string | null,
): Promise<CompsBlock | null> {
  const peers = peersForSector(sector).filter((t) => t !== symbol);
  if (peers.length === 0) return null;
  const subject = await fetchPeerRow(symbol);
  const rows = await Promise.all(peers.map((t) => fetchPeerRow(t)));
  const all = [subject, ...rows];
  return {
    peers: all,
    median: {
      trailing_pe: medianOf(all.map((r) => r.trailing_pe)),
      forward_pe: medianOf(all.map((r) => r.forward_pe)),
      ev_to_ebitda: medianOf(all.map((r) => r.ev_to_ebitda)),
      price_to_sales: medianOf(all.map((r) => r.price_to_sales)),
    },
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  try {
    const history = await getModuleHistory<unknown>(symbol, "valuation_model");
    return NextResponse.json({ versions: history });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[valuation] GET(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const cik = await getCIK(symbol);
    const [facts, yh] = await Promise.all([
      cik ? getCompanyFacts(cik) : Promise.resolve(null),
      fetchYahooBag(symbol),
    ]);
    const rawAnnual = extractAnnualMetrics(facts, 5);
    const rawDcfExtras = extractDCFExtras(facts, 5);
    const reporting = getReportingInfo(facts);
    // Foreign private issuers (Spotify EUR/20-F, Novo DKK/20-F, Alibaba
    // CNY/20-F, etc.) come back in their native currency. Multiply
    // through a live FX rate so the rest of the model — Yahoo's USD
    // current price, USD analyst targets, USD comps — stays
    // dimensionally consistent. fxToUsd defaults to 1 when reporting
    // is already USD or the FX fetch fails.
    let fxToUsd = 1;
    if (reporting.currency && reporting.currency !== "USD") {
      const rate = await fetchFxToUsd(reporting.currency);
      if (rate && Number.isFinite(rate) && rate > 0) {
        fxToUsd = rate;
      } else {
        console.warn(
          `[valuation:${symbol}] FX ${reporting.currency}→USD fetch failed; surfacing native currency`,
        );
      }
    }
    const annual = convertAnnualToUsd(rawAnnual, fxToUsd);
    const dcfExtras = convertDCFExtrasToUsd(rawDcfExtras, fxToUsd);
    const historical = buildHistorical(annual);
    const fcfHistory = buildFCFHistory(annual, dcfExtras);
    if (historical.length === 0) {
      return NextResponse.json(
        { error: "EDGAR returned no annual data for this symbol" },
        { status: 422 },
      );
    }

    const lastAnnual = [...annual].reverse()[0];
    const lastRow = [...historical].reverse()[0];

    // Prefer Yahoo's TTM revenue (closer to "now") and fall back to the
    // most-recent annual figure when Yahoo doesn't have it.
    const lastRevenue =
      yh.totalRevenueTTM && yh.totalRevenueTTM > 0
        ? yh.totalRevenueTTM
        : lastRow.revenue ?? 0;
    if (lastRevenue <= 0) {
      return NextResponse.json(
        { error: "Most recent revenue is missing or non-positive" },
        { status: 422 },
      );
    }

    // TEMP debug — verify which Yahoo shares field we landed on. Spec
    // calls out that LULU's basic shares should be ~76M; keep this log
    // around until we've cross-checked a few names.
    console.log(
      `[valuation:${symbol}] shares raw — basic=${yh.sharesOutstanding} implied=${yh.impliedSharesOutstanding} float=${yh.floatShares}`,
    );

    const sharesOutstanding = yh.sharesOutstanding ?? 0;
    if (sharesOutstanding <= 0) {
      return NextResponse.json(
        { error: "Shares outstanding missing from Yahoo — cannot project EPS" },
        { status: 422 },
      );
    }

    const currentPrice = yh.currentPrice ?? 0;
    if (currentPrice <= 0) {
      return NextResponse.json(
        { error: "Current price missing from Yahoo" },
        { status: 422 },
      );
    }

    const taxRate = effectiveTaxRate(
      lastAnnual?.netIncome ?? null,
      lastAnnual?.operatingIncome ?? null,
    );

    // Sample sample of LULU at this point for sanity:
    //   revenue 11.1B, opMargin 19.9%, tax 21%, shares 76M
    //   net_income_y3 = 11.1B*1.05^3*0.199*0.79 ≈ 2.02B
    //   eps_y3 = 2.02B / 76M ≈ $26.6  ← matches a quick mental model
    console.log(
      `[valuation:${symbol}] EPS check — net_income proxy=${(
        lastRevenue * (lastRow.op_margin ?? 0.15) * (1 - taxRate)
      ).toFixed(0)} / shares=${sharesOutstanding} = $${(
        (lastRevenue * (lastRow.op_margin ?? 0.15) * (1 - taxRate)) /
        sharesOutstanding
      ).toFixed(2)}`,
    );

    const totalDebt = yh.totalDebt ?? 0;
    const totalCash = yh.totalCash ?? 0;
    const netDebt = totalDebt - totalCash;

    // Aggregates for the DCF system rec.
    const fcfMargins = fcfHistory
      .map((r) => r.fcf_margin)
      .filter((x): x is number => x !== null);
    const fcfMarginAvg =
      fcfMargins.length > 0
        ? fcfMargins.slice(-3).reduce((s, x) => s + x, 0) /
          Math.min(3, fcfMargins.length)
        : 0.1;
    const daRatios = fcfHistory
      .map((r) => (r.da !== null && r.revenue ? r.da / r.revenue : null))
      .filter((x): x is number => x !== null);
    const daPctRevenue =
      daRatios.length > 0
        ? daRatios.slice(-3).reduce((s, x) => s + x, 0) / Math.min(3, daRatios.length)
        : 0.03;
    const capexRatios = fcfHistory
      .map((r) => (r.capex !== null && r.revenue ? r.capex / r.revenue : null))
      .filter((x): x is number => x !== null);
    const capexPctRevenue =
      capexRatios.length > 0
        ? capexRatios.slice(-3).reduce((s, x) => s + x, 0) /
          Math.min(3, capexRatios.length)
        : 0.04;

    const tier1System: ScenarioSet = recommendTier1({
      historical,
      forwardPE: yh.forwardPE,
      sector: yh.sector,
      taxRate,
    });
    const tier2System: DCFScenarioSet = recommendTier2({
      historical,
      fcfHistory,
      beta: yh.beta,
      taxRate,
    });

    const tier1Ctx = {
      last_revenue: lastRevenue,
      shares_outstanding: sharesOutstanding,
      current_price: currentPrice,
    };
    const tier2Ctx = {
      last_revenue: lastRevenue,
      shares_outstanding: sharesOutstanding,
      current_price: currentPrice,
      net_debt: netDebt,
      tax_rate: taxRate,
    };

    const tier1User: ScenarioSet = JSON.parse(JSON.stringify(tier1System));
    const tier2User: DCFScenarioSet = JSON.parse(JSON.stringify(tier2System));

    const tier1Out = computeTier1All(tier1User, tier1Ctx);
    const tier1SysOut = computeTier1All(tier1System, tier1Ctx);
    const tier2Out = computeTier2All(tier2User, tier2Ctx);
    const tier2SysOut = computeTier2All(tier2System, tier2Ctx);

    const comps = await buildComps(symbol, yh.sector);

    const output: ValuationModelV2 = {
      schema_version: 2,
      saved_at: new Date().toISOString(),
      current_price: currentPrice,
      shares_outstanding: sharesOutstanding,
      last_revenue: lastRevenue,
      last_op_margin: lastRow.op_margin ?? 0,
      last_eps: yh.trailingEps,
      forward_pe: yh.forwardPE,
      trailing_pe: yh.trailingPE,
      sector: yh.sector,
      tax_rate: taxRate,
      historical,
      fcf_history: fcfHistory,
      da_pct_revenue: daPctRevenue,
      capex_pct_revenue: capexPctRevenue,
      fcf_margin_avg: fcfMarginAvg,
      beta: yh.beta,
      total_debt: totalDebt,
      total_cash: totalCash,
      net_debt: netDebt,
      analyst_target_mean: yh.targetMeanPrice,
      analyst_target_high: yh.targetHighPrice,
      analyst_target_low: yh.targetLowPrice,
      analyst_count: yh.numberOfAnalystOpinions,
      reporting_currency: reporting.currency,
      fx_to_usd: fxToUsd,
      source_form: reporting.formType,
      source_taxonomy: reporting.taxonomy,
      tier1: {
        system: tier1System,
        user: tier1User,
        customized_fields: [],
        outputs: tier1Out,
        system_outputs: tier1SysOut,
      },
      tier2: {
        system: tier2System,
        user: tier2User,
        customized_fields: [],
        outputs: tier2Out,
        system_outputs: tier2SysOut,
      },
      comps,
    };

    const saved = await saveModule(symbol, "valuation_model", output);
    await recomputeOverallGrade(symbol);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[valuation] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/research/:symbol/valuation
// Body: { id: string, tier1?: ScenarioSet, tier2?: DCFScenarioSet,
//         shares_outstanding?: number, tax_rate?: number }
// Whatever's present gets recomputed and merged into the row in place.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const body = (await req.json()) as {
      id?: unknown;
      tier1?: unknown;
      tier2?: unknown;
      shares_outstanding?: unknown;
      tax_rate?: unknown;
    };
    const id = typeof body.id === "string" ? body.id : null;
    if (!id) {
      return NextResponse.json({ error: "Missing model id" }, { status: 400 });
    }

    if (body.tier1 !== undefined) assertValidTier1(body.tier1);
    if (body.tier2 !== undefined) assertValidTier2(body.tier2);

    const sb = createServerClient();
    const fetched = await sb
      .from("research_modules")
      .select("id, output, symbol, module_type")
      .eq("id", id)
      .limit(1);
    if (fetched.error) {
      throw new Error(`fetch failed: ${fetched.error.message}`);
    }
    const row = (fetched.data ?? [])[0] as
      | { id: string; output: ValuationModelV2; symbol: string; module_type: string }
      | undefined;
    if (!row) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }
    if (row.symbol !== symbol || row.module_type !== "valuation_model") {
      return NextResponse.json(
        { error: "Model does not belong to this symbol" },
        { status: 400 },
      );
    }

    if ((row.output as { schema_version?: number }).schema_version !== 2) {
      return NextResponse.json(
        {
          error:
            "This is an old (v1) model — generate a New Version to enable editing in v2",
        },
        { status: 409 },
      );
    }

    const next: ValuationModelV2 = { ...row.output };

    if (typeof body.shares_outstanding === "number" && body.shares_outstanding > 0) {
      next.shares_outstanding = body.shares_outstanding;
    }
    if (
      typeof body.tax_rate === "number" &&
      body.tax_rate > 0 &&
      body.tax_rate < 1
    ) {
      next.tax_rate = body.tax_rate;
    }

    if (body.tier1 !== undefined) {
      next.tier1 = {
        ...next.tier1,
        user: body.tier1,
        customized_fields: diffTier1Customized(body.tier1, next.tier1.system),
      };
    }
    if (body.tier2 !== undefined) {
      next.tier2 = {
        ...next.tier2,
        user: body.tier2,
        customized_fields: diffTier2Customized(body.tier2, next.tier2.system),
      };
    }

    // Recompute outputs after any of the above. shares / tax_rate flow
    // into both tiers so we always recompute both, which is cheap.
    const tier1Ctx = {
      last_revenue: next.last_revenue,
      shares_outstanding: next.shares_outstanding,
      current_price: next.current_price,
    };
    const tier2Ctx = {
      last_revenue: next.last_revenue,
      shares_outstanding: next.shares_outstanding,
      current_price: next.current_price,
      net_debt: next.net_debt,
      tax_rate: next.tax_rate,
    };
    next.tier1.outputs = computeTier1All(next.tier1.user, tier1Ctx);
    next.tier1.system_outputs = computeTier1All(next.tier1.system, tier1Ctx);
    next.tier2.outputs = computeTier2All(next.tier2.user, tier2Ctx);
    next.tier2.system_outputs = computeTier2All(next.tier2.system, tier2Ctx);

    const upd = await sb
      .from("research_modules")
      .update({ output: next })
      .eq("id", row.id);
    if (upd.error) throw new Error(`update failed: ${upd.error.message}`);

    // User-edited assumptions can flip the weighted return, which feeds
    // into the overall grade. Recompute so the home-page grade pill
    // stays in sync after every edit.
    await recomputeOverallGrade(symbol);

    return NextResponse.json({
      module: {
        id: row.id,
        symbol,
        moduleType: "valuation_model" as const,
        output: next,
        runAt: next.saved_at,
        expiresAt: null,
        isExpired: false,
        isCustomized:
          next.tier1.customized_fields.length > 0 ||
          next.tier2.customized_fields.length > 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[valuation] PATCH(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
