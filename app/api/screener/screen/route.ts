import { NextResponse } from "next/server";
import { getTodayEarnings } from "@/lib/earnings";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import { getWatchlistSymbols } from "@/lib/watchlist";
import { getIndustryClassification } from "@/lib/classification";
import {
  buildCandidateFromEarnings,
  evaluateStagesOneTwo,
  isLikelyCommonEquity,
  MIN_STOCK_PRICE,
  safeGetChain,
  ScreenContext,
  ScreenerResult,
} from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stages 1-2 screener: Finnhub earnings calendar + Schwab connection
// check + batch Yahoo prices + per-symbol classification across the
// watchlist. Hobby plan ceiling. A very large watchlist on a cold
// classifier cache can clip — partial results still render.
export const maxDuration = 60;

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
    droppedByEtf: string[];
    droppedByBlacklist: string[];
    droppedByPrice: string[];
    droppedByChain: string[];
    // Tickers passed through the weekly-chain check without verification
    // because Schwab returned null/error/empty. They're still in the
    // result set; downstream stages will retry the chain fetch.
    unverifiedChain?: string[];
  };
  error?: string;
};

export async function POST() {
  console.log(`[screen] handler called at ${new Date().toISOString()}`);

  const stats: ScreenResponse["stats"] = {
    finnhub: 0,
    afterEtfAndBlacklist: 0,
    afterPriceFilter: 0,
    afterChainFilter: 0,
    final: 0,
    droppedByEtf: [],
    droppedByBlacklist: [],
    droppedByPrice: [],
    droppedByChain: [],
    unverifiedChain: [],
  };

  try {
    const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));
    console.log(`[screen] schwab connected=${connected}`);

    const earnings = await getTodayEarnings();
    stats.finnhub = earnings.length;
    console.log(`[screen] earnings from Finnhub: ${earnings.length}`);
    if (earnings.length === 0) {
      console.warn(
        "[screen] Finnhub returned 0 eligible earnings for today-AMC or tomorrow-BMO. " +
          "Check [finnhub] and [earnings] log lines above for the exact URL, date window, and raw row breakdown.",
      );
    }

    const { whitelist, blacklist } = await getWatchlistSymbols();
    console.log(
      `[screen] watchlist: whitelist=${whitelist.size} blacklist=${blacklist.size}`,
    );

    // Step 2: hard kill ETFs + blacklist. Also narrow the timing type to BMO|AMC.
    // Whitelist tickers bypass the ETF/fund classifier (which has false
    // positives on legit common stock) but still get removed if explicitly
    // blacklisted.
    type Survivor = {
      symbol: string;
      date: string;
      timing: "BMO" | "AMC";
      isWhitelisted: boolean;
    };
    const survivors: Survivor[] = [];
    for (const e of earnings) {
      if (e.timing !== "AMC" && e.timing !== "BMO") continue;
      const upper = e.symbol.toUpperCase();
      if (blacklist.has(upper)) {
        stats.droppedByBlacklist.push(upper);
        continue;
      }
      const isWhitelisted = whitelist.has(upper);
      if (!isWhitelisted && !isLikelyCommonEquity(e.symbol)) {
        stats.droppedByEtf.push(upper);
        continue;
      }
      survivors.push({
        symbol: e.symbol,
        date: e.date,
        timing: e.timing as "BMO" | "AMC",
        isWhitelisted,
      });
    }
    stats.afterEtfAndBlacklist = survivors.length;
    console.log(
      `[screen] after ETF/blacklist: ${survivors.length} ` +
        `(dropped ETF=${stats.droppedByEtf.length}, blacklist=${stats.droppedByBlacklist.length})`,
    );

    // Step 3: fetch prices
    const prices = await getBatchPrices(survivors.map((s) => s.symbol));
    const priceHits = Object.values(prices).filter((p) => p > 0).length;
    console.log(
      `[screen] priced ${survivors.length} symbols, ${priceHits} with non-zero price`,
    );

    // Step 4: price floor. Whitelist tickers bypass the floor — the user has
    // explicitly opted them in and we trust that signal over a generic price cut.
    const afterPrice: Survivor[] = [];
    for (const s of survivors) {
      const p = prices[s.symbol.toUpperCase()] ?? 0;
      if (s.isWhitelisted || p >= MIN_STOCK_PRICE) {
        afterPrice.push(s);
      } else {
        stats.droppedByPrice.push(`${s.symbol.toUpperCase()}($${p.toFixed(2)})`);
      }
    }
    stats.afterPriceFilter = afterPrice.length;
    console.log(
      `[screen] after $${MIN_STOCK_PRICE} price floor: ${afterPrice.length} ` +
        `(dropped=${stats.droppedByPrice.length}; examples=${stats.droppedByPrice.slice(0, 6).join(",")})`,
    );

    // Step 5 (chain verification) was previously inline here — it now
    // lives in /api/screener/screen/verify-chains, called by the
    // client in batches of 10 with per-batch retry. Splitting it out
    // means a Schwab outage can no longer turn the screen into an
    // empty board: Stream A (this route) returns survivors as soon
    // as Finnhub + ETF/blacklist + price filters resolve, and the
    // client backfills chain-verification status into the displayed
    // table as each Stream C batch completes.
    type WithChain = Survivor & {
      expiry: string;
      price: number;
    };
    const afterChain: WithChain[] = afterPrice.map((row) => {
      const price = prices[row.symbol.toUpperCase()] ?? 0;
      const candidate = buildCandidateFromEarnings(
        { symbol: row.symbol, date: row.date, timing: row.timing },
        price,
      );
      return { ...row, expiry: candidate.expiry, price };
    });
    stats.afterChainFilter = afterChain.length;
    console.log(
      `[screen] chain verification deferred to /verify-chains stream — ` +
        `${afterChain.length} survivors forwarded to Stage 1+2`,
    );

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

      const chain = connected
        ? await safeGetChain(row.symbol, candidate.expiry, candidate.expiry)
        : null;

      const context: ScreenContext = {
        connected,
        chain,
        industryClass: cls.industry as ScreenContext["industryClass"],
        industryStatus,
        isWhitelisted,
      };

      const result = await evaluateStagesOneTwo(candidate, context);
      // Chain-verification status is filled in by the client after
      // /verify-chains batches complete. Initialize undefined so the
      // UI can distinguish "not yet checked" from "checked + absent".
      results.push(result);
    }

    results.sort((a, b) => (b.stageTwo?.score ?? -999) - (a.stageTwo?.score ?? -999));
    const final = results.slice(0, MAX_RESULTS);
    stats.final = final.length;

    console.log(
      `[screen] SUMMARY finnhub=${stats.finnhub} afterEtfBlacklist=${stats.afterEtfAndBlacklist} ` +
        `afterPrice(>=$${MIN_STOCK_PRICE})=${stats.afterPriceFilter} afterChain=${stats.afterChainFilter} ` +
        `(${stats.unverifiedChain?.length ?? 0} unverified) final=${stats.final} connected=${connected}`,
    );

    const response: ScreenResponse = {
      connected,
      screenedAt: new Date().toISOString(),
      results: final,
      prices,
      stats,
    };
    return NextResponse.json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[screen] handler failed:", msg, e instanceof Error ? e.stack : undefined);
    const response: ScreenResponse = {
      connected: false,
      screenedAt: new Date().toISOString(),
      results: [],
      prices: {},
      stats,
      error: msg,
    };
    return NextResponse.json(response, { status: 500 });
  }
}
