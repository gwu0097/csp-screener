import { NextResponse } from "next/server";
import { getTodayEarnings } from "@/lib/earnings";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import { getWatchlistSymbols } from "@/lib/watchlist";
import { getIndustryClassification } from "@/lib/classification";
import {
  buildCandidateFromEarnings,
  chainHasWeeklyExpiry,
  evaluateStagesOneTwo,
  isLikelyCommonEquity,
  safeGetChain,
  ScreenContext,
  ScreenerResult,
} from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MIN_PRICE = 70;
const MAX_RESULTS = 20;
const YAHOO_FALLBACK_BUDGET = 10;

type ScreenResponse = {
  connected: boolean;
  screenedAt: string;
  results: ScreenerResult[];
  prices: Record<string, number>;
  stats: {
    finnhub: number;
    afterEtfAndBlacklist: number;
    afterPriceFilter: number;
    afterChainFilter: number;
    final: number;
  };
};

export async function POST() {
  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));

  const earnings = await getTodayEarnings();
  const { whitelist, blacklist } = await getWatchlistSymbols();

  const stats = {
    finnhub: earnings.length,
    afterEtfAndBlacklist: 0,
    afterPriceFilter: 0,
    afterChainFilter: 0,
    final: 0,
  };

  // Step 2: hard kill ETFs + blacklist. Also narrow the timing type to BMO|AMC.
  type Survivor = { symbol: string; date: string; timing: "BMO" | "AMC" };
  const survivors: Survivor[] = earnings
    .filter((e) => e.timing === "AMC" || e.timing === "BMO")
    .filter((e) => isLikelyCommonEquity(e.symbol))
    .filter((e) => !blacklist.has(e.symbol.toUpperCase()))
    .map((e) => ({ symbol: e.symbol, date: e.date, timing: e.timing as "BMO" | "AMC" }));
  stats.afterEtfAndBlacklist = survivors.length;

  // Step 3: fetch prices
  const prices = await getBatchPrices(survivors.map((s) => s.symbol));

  // Step 4: price floor
  const afterPrice = survivors.filter((s) => (prices[s.symbol.toUpperCase()] ?? 0) >= MIN_PRICE);
  stats.afterPriceFilter = afterPrice.length;

  // Step 5: chain check (only when Schwab connected — skip otherwise)
  type WithChain = (typeof afterPrice)[number] & { expiry: string; price: number };
  const afterChain: WithChain[] = [];
  for (const row of afterPrice) {
    const price = prices[row.symbol.toUpperCase()] ?? 0;
    const candidate = buildCandidateFromEarnings({ symbol: row.symbol, date: row.date, timing: row.timing }, price);
    if (!connected) {
      afterChain.push({ ...row, expiry: candidate.expiry, price });
      continue;
    }
    const chain = await safeGetChain(row.symbol, candidate.expiry, candidate.expiry);
    if (chain && chainHasWeeklyExpiry(chain, candidate.expiry)) {
      afterChain.push({ ...row, expiry: candidate.expiry, price });
    }
  }
  stats.afterChainFilter = afterChain.length;

  // Step 6 + 7: classify and score stages 1+2
  let yahooBudget = YAHOO_FALLBACK_BUDGET;
  const results: ScreenerResult[] = [];
  for (const row of afterChain) {
    const upper = row.symbol.toUpperCase();
    const cls = await getIndustryClassification(upper, { yahooAllowed: yahooBudget > 0 });
    if (cls.source === "yahoo") yahooBudget -= 1;

    const isWhitelisted = whitelist.has(upper);
    const industryStatus: "pass" | "fail" | "unknown" = isWhitelisted
      ? "pass"
      : cls.source === "unknown"
        ? "unknown"
        : cls.pass
          ? "pass"
          : "fail";

    const candidate = buildCandidateFromEarnings(
      { symbol: row.symbol, date: row.date, timing: row.timing },
      row.price,
    );

    // We already refetched the chain above; refetch cheaply via cache-less call
    // only when Schwab is connected. (Schwab SDK has no transport cache so this
    // is an extra call, but keeps the code simple.)
    const chain = connected ? await safeGetChain(row.symbol, candidate.expiry, candidate.expiry) : null;

    const context: ScreenContext = {
      connected,
      chain,
      industryClass: cls.industry as ScreenContext["industryClass"],
      industryStatus,
      isWhitelisted,
    };

    const result = await evaluateStagesOneTwo(candidate, context);
    results.push(result);
  }

  // Sort by Stage 2 score descending, cap at 20.
  results.sort((a, b) => (b.stageTwo?.score ?? -999) - (a.stageTwo?.score ?? -999));
  const final = results.slice(0, MAX_RESULTS);
  stats.final = final.length;

  console.log(
    `[screen] finnhub=${stats.finnhub} afterEtfBlacklist=${stats.afterEtfAndBlacklist} ` +
      `afterPrice(>=$${MIN_PRICE})=${stats.afterPriceFilter} afterChain=${stats.afterChainFilter} ` +
      `final=${stats.final} connected=${connected}`,
  );

  const response: ScreenResponse = {
    connected,
    screenedAt: new Date().toISOString(),
    results: final,
    prices,
    stats,
  };
  return NextResponse.json(response);
}
