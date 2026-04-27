import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import { askPerplexityRaw } from "@/lib/perplexity";
import {
  getFinnhubInsiderTransactions,
  type FinnhubInsiderTx,
} from "@/lib/earnings";
import {
  getLatestModule,
  recomputeOverallGrade,
  saveModule,
  tryParseObject,
} from "@/lib/research-modules";
import { createServerClient } from "@/lib/supabase";

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

// ---------- Types ----------

type InsiderTx = {
  name: string;
  action: string;
  transactionCode: string;
  shares: number;
  price: number;
  date: string;
  type: "buy" | "sell";
  dollarValue: number;
};

type Holder = { name: string; pctHeld: number | null };

type Sentiment =
  | "very_bullish"
  | "bullish"
  | "mixed"
  | "neutral"
  | "bearish"
  | "very_bearish";

type AnalystConsensus = "strong_buy" | "buy" | "hold" | "sell" | "strong_sell";
type NetInsider = "strong_bullish" | "bullish" | "neutral" | "bearish";

type SentimentOutput = {
  sentiment_score: number; // 0-10
  insider: {
    transactions: InsiderTx[];
    executiveBuys: InsiderTx[];
    netSentiment: NetInsider;
    totalBuyValue: number;
    totalSellValue: number;
  };
  institutional: {
    ownershipPct: number | null;
    insiderOwnershipPct: number | null;
    shortPercentFloat: number | null;
    top5Holders: Holder[];
  };
  analyst: {
    consensus: AnalystConsensus | null;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    recentUpgrades: number;
    recentDowngrades: number;
    netUpgrades: number;
  };
  retail: {
    sentiment: "bullish" | "bearish" | "mixed" | "neutral";
    bullCase: string | null;
    bearCase: string | null;
    trend: "improving" | "deteriorating" | "stable";
    notableAnalystMoves: string | null;
    summary: string | null;
  };
  overallScore: Sentiment;
  scoreBreakdown: Array<{ label: string; earned: number; max: number; detail: string }>;
};

// ---------- Helpers ----------

const TX_LABEL: Record<string, string> = {
  P: "Purchase",
  S: "Sale",
  A: "Grant",
  M: "Option Exercise",
  F: "Tax Withhold",
  G: "Gift",
  D: "Disposition",
  X: "Option Expire",
  C: "Conversion",
};

function txLabel(code: string): string {
  return TX_LABEL[code] ?? (code || "—");
}

function unwrapNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
    return v as T;
  }
  return null;
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

// ---------- Insider classification ----------

function classifyInsider(rows: FinnhubInsiderTx[]): {
  transactions: InsiderTx[];
  executiveBuys: InsiderTx[];
  signal: NetInsider;
  totalBuyValue: number;
  totalSellValue: number;
} {
  const transactions: InsiderTx[] = rows.map((r) => {
    const shares = Math.abs(r.change);
    const price = r.transactionPrice;
    const code = r.transactionCode ?? "";
    return {
      name: r.name ?? "",
      action: txLabel(code),
      transactionCode: code,
      shares,
      price,
      date: r.transactionDate ?? r.filingDate ?? "",
      type: r.change > 0 ? "buy" : "sell",
      dollarValue: shares * price,
    };
  });
  // Real signal = open-market PURCHASE (P) — RSU grants (A) and option
  // exercises (M) are noise. Free Finnhub doesn't include officer
  // titles, so a $100K+ market purchase is the conviction proxy.
  const executiveBuys = transactions.filter(
    (t) => t.transactionCode === "P" && t.dollarValue >= 100_000,
  );
  let totalBuyValue = 0;
  let totalSellValue = 0;
  for (const t of transactions) {
    if (t.transactionCode === "P") totalBuyValue += t.dollarValue;
    else if (t.transactionCode === "S") totalSellValue += t.dollarValue;
  }
  let signal: NetInsider = "neutral";
  if (executiveBuys.length > 0) signal = "strong_bullish";
  else if (totalBuyValue > totalSellValue && totalBuyValue >= 50_000)
    signal = "bullish";
  else if (totalSellValue > totalBuyValue * 2 && totalSellValue > 0)
    signal = "bearish";
  return { transactions, executiveBuys, signal, totalBuyValue, totalSellValue };
}

// ---------- Yahoo lookups ----------

type YahooSentimentBag = {
  ownershipPct: number | null;
  insiderOwnershipPct: number | null;
  shortPercentFloat: number | null;
  top5Holders: Holder[];
  analyst: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    recentUpgrades: number;
    recentDowngrades: number;
  };
};

async function fetchYahooBag(symbol: string): Promise<YahooSentimentBag> {
  let summary: Record<string, unknown> | null = null;
  try {
    summary = (await yf.quoteSummary(
      symbol,
      {
        modules: [
          "institutionOwnership",
          "majorHoldersBreakdown",
          "defaultKeyStatistics",
          "recommendationTrend",
          "upgradeDowngradeHistory",
        ],
      },
      MODULE_OPTS,
    )) as Record<string, unknown>;
  } catch {
    summary = null;
  }
  const dks = ((summary?.defaultKeyStatistics ?? {}) as Record<string, unknown>) ?? {};
  const mh = ((summary?.majorHoldersBreakdown ?? {}) as Record<string, unknown>) ?? {};
  const io = ((summary?.institutionOwnership ?? {}) as Record<string, unknown>) ?? {};
  const rt = ((summary?.recommendationTrend ?? {}) as Record<string, unknown>) ?? {};
  const udh = ((summary?.upgradeDowngradeHistory ?? {}) as Record<string, unknown>) ?? {};

  const ownership =
    unwrapNumber(mh.institutionsPercentHeld) ??
    unwrapNumber(mh.heldPercentInstitutions) ??
    null;
  const insiderOwn =
    unwrapNumber(mh.insidersPercentHeld) ??
    unwrapNumber(mh.heldPercentInsiders) ??
    null;
  const shortFloat = unwrapNumber(dks.shortPercentOfFloat);

  const ownersList = Array.isArray(io.ownershipList)
    ? (io.ownershipList as Array<Record<string, unknown>>)
    : [];
  const top5: Holder[] = ownersList.slice(0, 5).map((o) => ({
    name: typeof o.organization === "string" ? (o.organization as string) : "—",
    pctHeld: unwrapNumber(o.pctHeld),
  }));

  // Current period = trend[0] (Yahoo orders 0=current, 1=-1m, 2=-2m, 3=-3m).
  const trend = Array.isArray(rt.trend)
    ? (rt.trend as Array<Record<string, unknown>>)
    : [];
  const cur = trend[0] ?? {};
  const strongBuy = unwrapNumber(cur.strongBuy) ?? 0;
  const buy = unwrapNumber(cur.buy) ?? 0;
  const hold = unwrapNumber(cur.hold) ?? 0;
  const sell = unwrapNumber(cur.sell) ?? 0;
  const strongSell = unwrapNumber(cur.strongSell) ?? 0;

  // Upgrade / downgrade history — Yahoo returns rows with epoch
  // timestamps + action ("up"/"down"/"main"/"init"). Filter last 90 days.
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const history = Array.isArray(udh.history)
    ? (udh.history as Array<Record<string, unknown>>)
    : [];
  let recentUpgrades = 0;
  let recentDowngrades = 0;
  for (const row of history) {
    const epoch = unwrapNumber(row.epochGradeDate);
    if (epoch === null) continue;
    const ms = epoch < 1e12 ? epoch * 1000 : epoch;
    if (ms < cutoff) continue;
    const action = typeof row.action === "string" ? (row.action as string) : "";
    if (action === "up") recentUpgrades += 1;
    else if (action === "down") recentDowngrades += 1;
  }

  return {
    ownershipPct: ownership,
    insiderOwnershipPct: insiderOwn,
    shortPercentFloat: shortFloat,
    top5Holders: top5,
    analyst: {
      strongBuy,
      buy,
      hold,
      sell,
      strongSell,
      recentUpgrades,
      recentDowngrades,
    },
  };
}

function consensusFor(a: YahooSentimentBag["analyst"]): AnalystConsensus | null {
  const total = a.strongBuy + a.buy + a.hold + a.sell + a.strongSell;
  if (total === 0) return null;
  const score =
    (a.strongBuy * 2 + a.buy * 1 + a.hold * 0 + a.sell * -1 + a.strongSell * -2) /
    total;
  if (score >= 1.5) return "strong_buy";
  if (score >= 0.5) return "buy";
  if (score >= -0.5) return "hold";
  if (score >= -1.5) return "sell";
  return "strong_sell";
}

// ---------- Perplexity retail ----------

function buildPrompt(symbol: string, companyName: string): string {
  return `Research current market sentiment for ${symbol} (${companyName}).

Find what retail investors and financial communities are saying RIGHT NOW:

1. What is the general retail sentiment on X/Twitter and Reddit about ${symbol}? Are they bullish, bearish, or mixed?
2. What are the main bull arguments retail investors are making?
3. What are the main bear arguments retail investors are making?
4. Has sentiment shifted recently? More bullish or bearish than 3 months ago?
5. What are analysts saying overall? Any notable recent upgrades or downgrades?

Return ONLY this JSON:
{
  "retail_sentiment": "bullish|bearish|mixed|neutral",
  "retail_bull_case": "1-2 sentences",
  "retail_bear_case": "1-2 sentences",
  "sentiment_trend": "improving|deteriorating|stable",
  "notable_analyst_moves": "1-2 sentences or null",
  "overall_sentiment_score": "very_bullish|bullish|mixed|bearish|very_bearish",
  "summary": "2-3 sentence overall sentiment picture"
}`;
}

async function getCompanyName(symbol: string): Promise<string> {
  const sb = createServerClient();
  const res = await sb
    .from("research_stocks")
    .select("company_name")
    .eq("symbol", symbol)
    .maybeSingle();
  const name = (res.data as { company_name: string | null } | null)?.company_name;
  return name ?? symbol;
}

// ---------- Score ----------

function scoreSentiment(
  insiderSignal: NetInsider,
  consensus: AnalystConsensus | null,
  netUpgrades: number,
  retail: SentimentOutput["retail"]["sentiment"],
  shortPct: number | null,
): { score: number; breakdown: SentimentOutput["scoreBreakdown"] } {
  const breakdown: SentimentOutput["scoreBreakdown"] = [];
  let score = 0;

  // Insider — strong_bullish (executive buys present) gets 2, plain
  // bullish gets 1.
  if (insiderSignal === "strong_bullish") {
    score += 2;
    breakdown.push({
      label: "Insider buying",
      earned: 2,
      max: 2,
      detail: "Executive open-market purchases (P-code, ≥$100K)",
    });
  } else if (insiderSignal === "bullish") {
    score += 1;
    breakdown.push({
      label: "Insider buying",
      earned: 1,
      max: 2,
      detail: "Net P-code buying but no large executive trade",
    });
  } else {
    breakdown.push({
      label: "Insider buying",
      earned: 0,
      max: 2,
      detail: insiderSignal === "bearish" ? "Net selling" : "No notable buying",
    });
  }

  // Analyst consensus.
  if (consensus === "buy" || consensus === "strong_buy") {
    score += 2;
    breakdown.push({
      label: "Analyst consensus",
      earned: 2,
      max: 2,
      detail: `Consensus: ${consensus.replace("_", " ")}`,
    });
  } else if (consensus === "hold") {
    score += 1;
    breakdown.push({
      label: "Analyst consensus",
      earned: 1,
      max: 2,
      detail: "Consensus: hold",
    });
  } else {
    breakdown.push({
      label: "Analyst consensus",
      earned: 0,
      max: 2,
      detail: consensus ? `Consensus: ${consensus.replace("_", " ")}` : "No coverage",
    });
  }

  // Net upgrades over the last 90 days.
  if (netUpgrades > 0) {
    score += 1;
    breakdown.push({
      label: "Recent rating moves",
      earned: 1,
      max: 1,
      detail: `Net +${netUpgrades} upgrades over 90 days`,
    });
  } else {
    breakdown.push({
      label: "Recent rating moves",
      earned: 0,
      max: 1,
      detail:
        netUpgrades < 0
          ? `Net ${netUpgrades} (more downgrades)`
          : "No net upgrades in last 90 days",
    });
  }

  // Retail sentiment.
  if (retail === "bullish") {
    score += 2;
    breakdown.push({
      label: "Retail sentiment",
      earned: 2,
      max: 2,
      detail: "Bullish on X/Reddit",
    });
  } else if (retail === "mixed") {
    score += 1;
    breakdown.push({
      label: "Retail sentiment",
      earned: 1,
      max: 2,
      detail: "Mixed retail sentiment",
    });
  } else {
    breakdown.push({
      label: "Retail sentiment",
      earned: 0,
      max: 2,
      detail: retail === "bearish" ? "Bearish retail tone" : "Neutral / quiet",
    });
  }

  // Short squeeze potential.
  if (shortPct !== null && shortPct > 0.15) {
    score += 1;
    breakdown.push({
      label: "Squeeze potential",
      earned: 1,
      max: 1,
      detail: `Short float ${(shortPct * 100).toFixed(1)}% (> 15%)`,
    });
  } else {
    breakdown.push({
      label: "Squeeze potential",
      earned: 0,
      max: 1,
      detail:
        shortPct !== null
          ? `Short float ${(shortPct * 100).toFixed(1)}%`
          : "No short data",
    });
  }

  return { score: Math.min(10, score), breakdown };
}

// ---------- Routes ----------

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const mod = await getLatestModule<SentimentOutput>(symbol, "sentiment");
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
    const companyName = await getCompanyName(symbol);

    // Insider + Yahoo + Perplexity in parallel.
    const [insiderRows, yh, raw] = await Promise.all([
      getFinnhubInsiderTransactions(symbol, 90).catch(() => [] as FinnhubInsiderTx[]),
      fetchYahooBag(symbol),
      askPerplexityRaw(buildPrompt(symbol, companyName), {
        label: `research-sentiment:${symbol}`,
        maxTokens: 1200,
      }).catch(() => null),
    ]);

    const insider = classifyInsider(insiderRows);
    const consensus = consensusFor(yh.analyst);
    const netUpgrades = yh.analyst.recentUpgrades - yh.analyst.recentDowngrades;

    const parsed = raw?.text ? tryParseObject(raw.text) : null;
    const retailEnum =
      asEnum(parsed?.retail_sentiment, [
        "bullish",
        "bearish",
        "mixed",
        "neutral",
      ] as const) ?? "neutral";
    const retail: SentimentOutput["retail"] = {
      sentiment: retailEnum,
      bullCase: asStr(parsed?.retail_bull_case),
      bearCase: asStr(parsed?.retail_bear_case),
      trend:
        asEnum(parsed?.sentiment_trend, [
          "improving",
          "deteriorating",
          "stable",
        ] as const) ?? "stable",
      notableAnalystMoves: asStr(parsed?.notable_analyst_moves),
      summary: asStr(parsed?.summary),
    };
    const overallScore: Sentiment =
      asEnum(parsed?.overall_sentiment_score, [
        "very_bullish",
        "bullish",
        "mixed",
        "neutral",
        "bearish",
        "very_bearish",
      ] as const) ?? "neutral";

    const { score, breakdown } = scoreSentiment(
      insider.signal,
      consensus,
      netUpgrades,
      retail.sentiment,
      yh.shortPercentFloat,
    );

    const output: SentimentOutput = {
      sentiment_score: score,
      insider: {
        transactions: insider.transactions,
        executiveBuys: insider.executiveBuys,
        netSentiment: insider.signal,
        totalBuyValue: insider.totalBuyValue,
        totalSellValue: insider.totalSellValue,
      },
      institutional: {
        ownershipPct: yh.ownershipPct,
        insiderOwnershipPct: yh.insiderOwnershipPct,
        shortPercentFloat: yh.shortPercentFloat,
        top5Holders: yh.top5Holders,
      },
      analyst: {
        consensus,
        ...yh.analyst,
        netUpgrades,
      },
      retail,
      overallScore,
      scoreBreakdown: breakdown,
    };

    const saved = await saveModule(symbol, "sentiment", output);
    await recomputeOverallGrade(symbol);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sentiment] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
