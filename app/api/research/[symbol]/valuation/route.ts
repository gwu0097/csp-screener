import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import {
  extractAnnualMetrics,
  getCIK,
  getCompanyFacts,
} from "@/lib/sec-edgar";
import {
  getModuleHistory,
  saveModule,
} from "@/lib/research-modules";
import { createServerClient } from "@/lib/supabase";
import {
  assertValidScenarios,
  buildHistorical,
  computeAllOutputs,
  diffCustomizedFields,
  effectiveTaxRate,
  recommendSystemInputs,
  type ScenarioSet,
  type ValuationModelOutput,
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
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalystOpinions: number | null;
  sharesOutstanding: number | null;
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
    targetMeanPrice: unwrapNumber(fd.targetMeanPrice),
    targetHighPrice: unwrapNumber(fd.targetHighPrice),
    targetLowPrice: unwrapNumber(fd.targetLowPrice),
    numberOfAnalystOpinions: unwrapNumber(fd.numberOfAnalystOpinions),
    sharesOutstanding: unwrapNumber(dks.sharesOutstanding),
    sector: typeof ap.sector === "string" ? (ap.sector as string) : null,
  };
}

// History orders newest-first so the version dropdown can show the
// freshest model at the top by default.
export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  try {
    const history = await getModuleHistory<ValuationModelOutput>(
      symbol,
      "valuation_model",
    );
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
    const annual = extractAnnualMetrics(facts, 5);
    const historical = buildHistorical(annual);
    if (historical.length === 0) {
      return NextResponse.json(
        {
          error:
            "No historical financials available — EDGAR returned no annual data for this symbol",
        },
        { status: 422 },
      );
    }

    const lastRow = [...historical].reverse()[0];
    const lastRevenue = lastRow.revenue ?? 0;
    if (lastRevenue <= 0) {
      return NextResponse.json(
        { error: "Most recent revenue is missing or non-positive" },
        { status: 422 },
      );
    }

    // Tax rate from prior-year P&L on the SEC raw rows so we don't need
    // to re-derive op income / net income from margins.
    const lastAnnual = [...annual].reverse()[0];
    const taxRate = effectiveTaxRate(
      lastAnnual?.netIncome ?? null,
      lastAnnual?.operatingIncome ?? null,
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

    const system = recommendSystemInputs({
      historical,
      forwardPE: yh.forwardPE,
      sector: yh.sector,
    });

    const ctx = {
      last_revenue: lastRevenue,
      shares_outstanding: sharesOutstanding,
      tax_rate: taxRate,
      current_price: currentPrice,
    };

    const system_outputs = computeAllOutputs(system, ctx);
    // First save: user inputs equal system, no customized fields yet.
    const user: ScenarioSet = {
      bear: { ...system.bear },
      base: { ...system.base },
      bull: { ...system.bull },
    };
    const outputs = computeAllOutputs(user, ctx);

    const output: ValuationModelOutput = {
      saved_at: new Date().toISOString(),
      current_price: currentPrice,
      shares_outstanding: sharesOutstanding,
      tax_rate: taxRate,
      last_revenue: lastRevenue,
      historical,
      system,
      user,
      customized_fields: [],
      outputs,
      system_outputs,
      analyst_target_mean: yh.targetMeanPrice,
      analyst_target_high: yh.targetHighPrice,
      analyst_target_low: yh.targetLowPrice,
      analyst_count: yh.numberOfAnalystOpinions,
      sector: yh.sector,
      forward_pe: yh.forwardPE,
    };

    const saved = await saveModule(symbol, "valuation_model", output);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[valuation] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/research/:symbol/valuation
// Body: { id: string, user: ScenarioSet }
// Recomputes outputs + customized_fields server-side from the submitted
// inputs and the existing model context (last_revenue / shares / tax /
// current_price stay frozen at first-save time so a model is reproducible
// across page loads).
export async function PATCH(
  req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const body = (await req.json()) as { id?: unknown; user?: unknown };
    const id = typeof body.id === "string" ? body.id : null;
    if (!id) {
      return NextResponse.json({ error: "Missing model id" }, { status: 400 });
    }
    assertValidScenarios(body.user);
    const userInputs = body.user;

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
      | { id: string; output: ValuationModelOutput; symbol: string; module_type: string }
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

    const ctx = {
      last_revenue: row.output.last_revenue,
      shares_outstanding: row.output.shares_outstanding,
      tax_rate: row.output.tax_rate,
      current_price: row.output.current_price,
    };
    const outputs = computeAllOutputs(userInputs, ctx);
    const customized_fields = diffCustomizedFields(userInputs, row.output.system);

    const nextOutput: ValuationModelOutput = {
      ...row.output,
      user: userInputs,
      outputs,
      customized_fields,
    };

    const upd = await sb
      .from("research_modules")
      .update({ output: nextOutput })
      .eq("id", row.id);
    if (upd.error) throw new Error(`update failed: ${upd.error.message}`);

    return NextResponse.json({
      module: {
        id: row.id,
        symbol,
        moduleType: "valuation_model" as const,
        output: nextOutput,
        runAt: row.output.saved_at,
        expiresAt: null,
        isExpired: false,
        isCustomized: customized_fields.length > 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[valuation] PATCH(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
