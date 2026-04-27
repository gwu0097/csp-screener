import { NextRequest, NextResponse } from "next/server";
import { getTodayEarnings } from "@/lib/earnings";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import { getWatchlistSymbols } from "@/lib/watchlist";
import { getIndustryClassification } from "@/lib/classification";
import {
  buildCandidateFromEarnings,
  evaluateStagesOneTwo,
  safeGetChain,
  ScreenContext,
  ScreenerResult,
} from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Watchlist apply runs the same stage-1-2 path as the screener
// (Finnhub + Schwab + per-symbol classification + Yahoo fallbacks).
// Hobby plan ceiling.
export const maxDuration = 60;

const YAHOO_FALLBACK_BUDGET = 10;

type Body = { currentSymbols?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const currentSymbols: string[] = Array.isArray(body.currentSymbols)
    ? (body.currentSymbols.filter((s) => typeof s === "string") as string[]).map((s) => s.toUpperCase())
    : [];

  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));
  const { whitelist, blacklist } = await getWatchlistSymbols();
  const currentSet = new Set(currentSymbols);

  // Symbols in the current list that are now blacklisted get removed.
  const removed: string[] = currentSymbols.filter((s) => blacklist.has(s));

  // Survivors after blacklist removal.
  const survivorsFromCurrent = currentSymbols.filter((s) => !blacklist.has(s));

  // Whitelist candidates not already in the list and not blacklisted.
  const whitelistCandidates = Array.from(whitelist).filter(
    (s) => !currentSet.has(s) && !blacklist.has(s),
  );

  // Filter whitelist candidates to those with earnings today-AMC / tomorrow-BMO.
  // That's the only gate besides blacklist — whitelist tickers bypass the ETF
  // check, price floor, and weekly-chain kill. Chain is still fetched so
  // Stage 3/4 have data when the user clicks Run Analysis, but a missing chain
  // no longer removes the ticker from the board.
  const earnings = await getTodayEarnings();
  const earningsMap = new Map(earnings.map((e) => [e.symbol.toUpperCase(), e]));
  const additionEntries = whitelistCandidates
    .map((s) => earningsMap.get(s))
    .filter((e): e is NonNullable<typeof e> => !!e);

  // Fetch prices for potential additions + all existing survivors, in one batch.
  const priceSymbols = Array.from(
    new Set<string>([...survivorsFromCurrent, ...additionEntries.map((e) => e.symbol.toUpperCase())]),
  );
  const allPrices = await getBatchPrices(priceSymbols);

  const added: ScreenerResult[] = [];
  let yahooBudget = YAHOO_FALLBACK_BUDGET;
  for (const e of additionEntries) {
    const upper = e.symbol.toUpperCase();
    const price = allPrices[upper] ?? 0;
    const candidate = buildCandidateFromEarnings(
      { symbol: e.symbol, date: e.date, timing: e.timing as "BMO" | "AMC" },
      price,
    );
    const chain = connected
      ? await safeGetChain(e.symbol, candidate.expiry, candidate.expiry)
      : null;

    const cls = await getIndustryClassification(upper, { yahooAllowed: yahooBudget > 0 });
    if (cls.source === "yahoo") yahooBudget -= 1;

    // Whitelist override — treat as passing regardless of classifier result.
    const industryStatus: "pass" | "fail" | "unknown" = "pass";

    const context: ScreenContext = {
      connected,
      chain,
      industryClass: cls.industry as ScreenContext["industryClass"],
      industryStatus,
      isWhitelisted: true,
    };

    const result = await evaluateStagesOneTwo(candidate, context);
    added.push(result);
  }

  // updatedPrices covers every symbol on the post-mutation list.
  const finalSymbols = Array.from(
    new Set<string>([...survivorsFromCurrent, ...added.map((r) => r.symbol)]),
  );
  const updatedPrices: Record<string, number> = {};
  for (const sym of finalSymbols) {
    updatedPrices[sym] = allPrices[sym] ?? 0;
  }

  console.log(
    `[apply-watchlist] current=${currentSymbols.length} removed=${removed.length} ` +
      `whitelistCandidates=${whitelistCandidates.length} added=${added.length}`,
  );

  return NextResponse.json({ added, removed, updatedPrices });
}
