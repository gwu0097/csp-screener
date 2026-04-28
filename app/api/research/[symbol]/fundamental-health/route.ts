import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import {
  convertAnnualToUsd,
  extractAnnualMetrics,
  fetchFxToUsd,
  getCIK,
  getCompanyFacts,
  getReportingInfo,
  type AnnualMetrics,
} from "@/lib/sec-edgar";
import {
  getLatestModule,
  recomputeOverallGrade,
  saveModule,
} from "@/lib/research-modules";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const yahooFinance = new (
  YahooFinance as unknown as new () => Record<string, unknown>
)();
type YFClient = {
  quoteSummary: (
    s: string,
    o: { modules: string[] },
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};
const yf = yahooFinance as unknown as YFClient;
const MODULE_OPTS = { validateResult: false } as const;

type CurrentMetrics = {
  forwardPE: number | null;
  trailingPE: number | null;
  priceToBook: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  currentRatio: number | null;
  debtToEquity: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
};

type ScoreComponent = {
  label: string;
  earned: number;
  max: number;
  detail: string;
};

type FundamentalHealth = {
  cik: string | null;
  annual: AnnualMetrics[];
  current: CurrentMetrics;
  healthScore: number; // 0-10
  scoreComponents: ScoreComponent[];
  scoreLabel: string; // "Healthy fundamentals" | etc.
};

function unwrapNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

async function fetchCurrentMetrics(symbol: string): Promise<CurrentMetrics> {
  let summary: Record<string, unknown> | null = null;
  try {
    summary = (await yf.quoteSummary(
      symbol,
      { modules: ["financialData", "defaultKeyStatistics", "summaryDetail"] },
      MODULE_OPTS,
    )) as Record<string, unknown>;
  } catch {
    summary = null;
  }
  const fd = ((summary?.financialData ?? {}) as Record<string, unknown>) ?? {};
  const dks = ((summary?.defaultKeyStatistics ?? {}) as Record<string, unknown>) ?? {};
  const sd = ((summary?.summaryDetail ?? {}) as Record<string, unknown>) ?? {};
  return {
    forwardPE: unwrapNumber(sd.forwardPE) ?? unwrapNumber(dks.forwardPE),
    trailingPE: unwrapNumber(sd.trailingPE) ?? unwrapNumber(dks.trailingPE),
    priceToBook: unwrapNumber(dks.priceToBook),
    revenueGrowth: unwrapNumber(fd.revenueGrowth),
    earningsGrowth: unwrapNumber(fd.earningsGrowth),
    currentRatio: unwrapNumber(fd.currentRatio),
    debtToEquity: unwrapNumber(fd.debtToEquity),
    returnOnEquity: unwrapNumber(fd.returnOnEquity),
    returnOnAssets: unwrapNumber(fd.returnOnAssets),
    freeCashflow: unwrapNumber(fd.freeCashflow),
    operatingCashflow: unwrapNumber(fd.operatingCashflow),
  };
}

// Compute the health score per spec — every check shows up in the
// scoreComponents array so the UI can render a transparent breakdown.
function computeHealth(
  annual: AnnualMetrics[],
  current: CurrentMetrics,
): { score: number; components: ScoreComponent[]; label: string } {
  const components: ScoreComponent[] = [];

  // Sort ascending so [last] is most recent and [last-1] is prior year.
  const recent = [...annual].sort((a, b) => a.year - b.year);
  const last = recent[recent.length - 1] ?? null;
  const prev = recent[recent.length - 2] ?? null;
  const prev2 = recent[recent.length - 3] ?? null;

  const lastRev = last?.revenue ?? null;
  const prevRev = prev?.revenue ?? null;
  const prev2Rev = prev2?.revenue ?? null;
  const revGrowth =
    lastRev !== null && prevRev !== null && prevRev > 0
      ? (lastRev - prevRev) / prevRev
      : null;
  const prevRevGrowth =
    prevRev !== null && prev2Rev !== null && prev2Rev > 0
      ? (prevRev - prev2Rev) / prev2Rev
      : null;

  // +2 if revenue growing >10%, +1 if 0-10%
  if (revGrowth !== null) {
    const earned = revGrowth > 0.1 ? 2 : revGrowth > 0 ? 1 : 0;
    components.push({
      label: "Revenue growth",
      earned,
      max: 2,
      detail:
        earned === 2
          ? `+${(revGrowth * 100).toFixed(1)}% YoY (>10% threshold)`
          : earned === 1
            ? `+${(revGrowth * 100).toFixed(1)}% YoY (positive but <10%)`
            : `${(revGrowth * 100).toFixed(1)}% YoY (declining)`,
    });
  } else {
    components.push({
      label: "Revenue growth",
      earned: 0,
      max: 2,
      detail: "Insufficient annual data to compute",
    });
  }

  // Operating margin trend: +2 expanding, +1 stable (<2pp move).
  const lastOpMargin =
    lastRev !== null && last?.operatingIncome !== null && lastRev > 0
      ? (last.operatingIncome as number) / lastRev
      : null;
  const prevOpMargin =
    prevRev !== null && prev?.operatingIncome !== null && prevRev > 0
      ? (prev.operatingIncome as number) / prevRev
      : null;
  if (lastOpMargin !== null && prevOpMargin !== null) {
    const delta = lastOpMargin - prevOpMargin;
    const earned = delta > 0.005 ? 2 : Math.abs(delta) <= 0.02 ? 1 : 0;
    components.push({
      label: "Operating margin trend",
      earned,
      max: 2,
      detail: `${(lastOpMargin * 100).toFixed(1)}% (vs ${(prevOpMargin * 100).toFixed(1)}% prior, ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp)`,
    });
  } else {
    components.push({
      label: "Operating margin trend",
      earned: 0,
      max: 2,
      detail: "Insufficient annual data",
    });
  }

  // Free cash flow positive: +2
  if (current.freeCashflow !== null) {
    const earned = current.freeCashflow > 0 ? 2 : 0;
    components.push({
      label: "Free cash flow",
      earned,
      max: 2,
      detail:
        earned > 0
          ? `Positive $${(current.freeCashflow / 1e9).toFixed(2)}B TTM`
          : `Negative $${(Math.abs(current.freeCashflow) / 1e9).toFixed(2)}B TTM`,
    });
  } else {
    components.push({
      label: "Free cash flow",
      earned: 0,
      max: 2,
      detail: "No FCF data from Yahoo",
    });
  }

  // Debt/equity < 1.0: +1
  if (current.debtToEquity !== null) {
    // Yahoo reports debt/equity sometimes as a ratio (e.g. 0.48) and
    // sometimes as a percentage (e.g. 48). Normalize.
    const de =
      current.debtToEquity > 5 ? current.debtToEquity / 100 : current.debtToEquity;
    const earned = de < 1.0 ? 1 : 0;
    components.push({
      label: "Debt level",
      earned,
      max: 1,
      detail:
        earned > 0
          ? `D/E ${de.toFixed(2)} — conservative balance sheet`
          : `D/E ${de.toFixed(2)} — leveraged`,
    });
  } else {
    components.push({
      label: "Debt level",
      earned: 0,
      max: 1,
      detail: "No D/E data from Yahoo",
    });
  }

  // Revenue growth accelerating: +1
  if (revGrowth !== null && prevRevGrowth !== null) {
    const earned = revGrowth > prevRevGrowth ? 1 : 0;
    components.push({
      label: "Revenue acceleration",
      earned,
      max: 1,
      detail:
        earned > 0
          ? `Growth accelerating (${(revGrowth * 100).toFixed(1)}% vs ${(prevRevGrowth * 100).toFixed(1)}% prior year)`
          : `Growth not accelerating (${(revGrowth * 100).toFixed(1)}% vs ${(prevRevGrowth * 100).toFixed(1)}% prior year)`,
    });
  } else {
    components.push({
      label: "Revenue acceleration",
      earned: 0,
      max: 1,
      detail: "Need 3 years of data to compute",
    });
  }

  // EPS growing YoY: +1
  if (last?.eps !== null && prev?.eps !== null && last && prev) {
    const earned = (last.eps as number) > (prev.eps as number) ? 1 : 0;
    components.push({
      label: "EPS growth",
      earned,
      max: 1,
      detail:
        earned > 0
          ? `EPS $${(last.eps as number).toFixed(2)} (vs $${(prev.eps as number).toFixed(2)} prior)`
          : `EPS $${(last.eps as number).toFixed(2)} (vs $${(prev.eps as number).toFixed(2)} prior — declining)`,
    });
  } else {
    components.push({
      label: "EPS growth",
      earned: 0,
      max: 1,
      detail: "Insufficient annual EPS data",
    });
  }

  const score = components.reduce((s, c) => s + c.earned, 0);
  const label =
    score >= 8
      ? "Strong fundamentals"
      : score >= 6
        ? "Healthy fundamentals"
        : score >= 4
          ? "Mixed fundamentals"
          : "Weak fundamentals";
  return { score: Math.min(10, score), components, label };
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const mod = await getLatestModule<FundamentalHealth>(symbol, "fundamental_health");
  return NextResponse.json({ module: mod });
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
    const facts = cik ? await getCompanyFacts(cik) : null;
    const rawAnnual = extractAnnualMetrics(facts, 5);
    const reporting = getReportingInfo(facts);
    // Foreign filers report in their native currency under ifrs-full.
    // Convert annual figures into USD so YoY ratios + comparison
    // against Yahoo's USD `current` block stay coherent. fxToUsd=1
    // when reporting is already USD.
    let fxToUsd = 1;
    if (reporting.currency && reporting.currency !== "USD") {
      const rate = await fetchFxToUsd(reporting.currency);
      if (rate && Number.isFinite(rate) && rate > 0) fxToUsd = rate;
    }
    const annual = convertAnnualToUsd(rawAnnual, fxToUsd);
    const current = await fetchCurrentMetrics(symbol);
    const { score, components, label } = computeHealth(annual, current);

    const output: FundamentalHealth = {
      cik,
      annual,
      current,
      healthScore: score,
      scoreComponents: components,
      scoreLabel: label,
    };

    const saved = await saveModule(symbol, "fundamental_health", output);
    await recomputeOverallGrade(symbol);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fundamental-health] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
