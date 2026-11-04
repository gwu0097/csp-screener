import { NextRequest, NextResponse } from "next/server";
import { easternScreenWindow, getFinnhubCalendarRange, getSupplementalWhitelistEarnings } from "@/lib/earnings";
import { addDaysIso } from "@/lib/robinhood-calendar-validate";
import { loadLatestRhBatch } from "@/lib/robinhood-calendar-store";
import { loadSourceChoices } from "@/lib/earnings-source-choices";
import {
  mergeEarningsSources,
  rhBatchAvailability,
  type EarningsSourceCheck,
  type SourceChoice,
} from "@/lib/earnings-source-merge";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import { getWatchlistSymbols } from "@/lib/watchlist";
import { getIndustryClassification, type IndustryClass } from "@/lib/classification";
import {
  buildCandidateFromEarnings,
  isLikelyCommonEquity,
  runStageTwo,
  ScreenerResult,
} from "@/lib/screener";
import { resolveScreenerFilters } from "@/lib/screener-config";
import { getScreenerConfigOrDefault } from "@/lib/screener-configs-db";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stream A: filter-only "what's reporting today and is it worth
// scoring?" pass. Pipeline:
//   1. Finnhub earnings calendar ∪ latest Robinhood calendar batch
//      (lib/earnings-source-merge.ts) — each candidate carries a
//      source check the UI shows as a chip
//   2. ETF / blacklist filter
//   3. $70 price floor (Yahoo batch quotes)
//   4. Stage 2 quality floor (business simplicity + market cap +
//      analyst dispersion). Yahoo + Finnhub data only — no Schwab
//      calls. Drops bloat candidates so the table comes back tight.
//   5. Industry classification cached lookup (Yahoo fallback only
//      for whitelisted names).
// All option-chain math (Stage 1 crush, Stage 3+4 strike/premium,
// Pass 3 Perplexity, three-layer grade) runs via Run Analysis.
// Stream C (verify-chains) does a binary present/absent chain probe
// alongside this — orchestrated client-side.
//
// Stage 2 batches through Finnhub /stock/recommendation in chunks
// of 8 with a 250ms gap so we don't trip the free-tier 60/min rate
// limit on a fresh-cache day. Steady-state with cached market caps
// the whole pipeline runs in ~5-10s.
export const maxDuration = 60;
const STAGE2_BATCH = 8;
const STAGE2_BATCH_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const MAX_RESULTS = 20;

// Shown as the status line above the table.
export type CalendarSourcesStatus = {
  robinhood:
    | { status: "ok"; fetchedAt: string; rows: number }
    | { status: "unavailable"; fetchedAt: string | null; reason: string };
  finnhub: { status: "ok"; rows: number } | { status: "failed"; error: string };
};

type ScreenResponse = {
  connected: boolean;
  calendarSources?: CalendarSourcesStatus;
  screenedAt: string;
  configId?: string;
  configName?: string;
  results: ScreenerResult[];
  prices: Record<string, number>;
  stats: {
    finnhub: number;
    // In-window candidates after the Finnhub ∪ Robinhood merge, and how
    // many came only from Robinhood.
    merged?: number;
    robinhoodOnly?: string[];
    afterEtfAndBlacklist: number;
    afterPriceFilter: number;
    afterMcapFloor: number;
    afterQualityFilter: number;
    afterChainFilter: number;
    final: number;
    droppedByEtf: string[];
    droppedByBlacklist: string[];
    droppedByPrice: string[];
    droppedByMcap: string[];
    droppedByQuality: string[];
    droppedByChain: string[];
    // Tickers passed through the weekly-chain check without verification
    // because Schwab returned null/error/empty. They're still in the
    // result set; downstream stages will retry the chain fetch.
    unverifiedChain?: string[];
    // Whitelist symbols the bulk Finnhub calendar pull missed (e.g. ADRs
    // filed under a foreign primary listing) but a per-symbol fallback
    // query confirmed do have earnings in today's window.
    whitelistSupplemented: string[];
  };
  error?: string;
};

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  console.log(`[screen] handler called at ${new Date().toISOString()}`);

  // The selected named screener drives every gate below. Falls back
  // to the CSP Earnings preset when no configId is passed or the row
  // is gone. resolveScreenerFilters() backfills any missing filter
  // keys, so a partial custom config still screens sanely.
  const cfg = await getScreenerConfigOrDefault(
    req.nextUrl.searchParams.get("configId"),
  );
  const f = resolveScreenerFilters(cfg);
  console.log(
    `[screen] config="${cfg.id}" (${cfg.name}) → priceFloor=$${f.priceFloor} ` +
      `mcap>=$${f.minMarketCapBillions}B tier>=${f.minMarketCapTier} ` +
      `weeklyChain=${f.requireWeeklyChain}`,
  );

  const stats: ScreenResponse["stats"] = {
    finnhub: 0,
    merged: 0,
    robinhoodOnly: [],
    afterEtfAndBlacklist: 0,
    afterPriceFilter: 0,
    afterMcapFloor: 0,
    afterQualityFilter: 0,
    afterChainFilter: 0,
    final: 0,
    droppedByEtf: [],
    droppedByBlacklist: [],
    droppedByPrice: [],
    droppedByMcap: [],
    droppedByQuality: [],
    droppedByChain: [],
    unverifiedChain: [],
    whitelistSupplemented: [],
  };

  try {
    const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));
    console.log(`[screen] schwab connected=${connected}`);

    const { whitelist, blacklist } = await getWatchlistSymbols(userId);
    console.log(
      `[screen] watchlist: whitelist=${whitelist.size} blacklist=${blacklist.size}`,
    );

    const { today, tomorrow } = easternScreenWindow();

    // Finnhub over a wider range than the window (yesterday..today+3) so
    // a date Robinhood disagrees on is still there to compare. A failed
    // Finnhub call is reported, not turned into an empty calendar.
    let finnhubStatus: CalendarSourcesStatus["finnhub"];
    let bulkEarnings: Awaited<ReturnType<typeof getFinnhubCalendarRange>> = [];
    try {
      bulkEarnings = await getFinnhubCalendarRange(addDaysIso(today, -1), addDaysIso(today, 3));
      finnhubStatus = { status: "ok", rows: bulkEarnings.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[screen] Finnhub calendar failed: ${msg}`);
      finnhubStatus = { status: "failed", error: msg };
    }
    const inWindow = (e: { date: string; timing: string }) =>
      (e.date === today && e.timing === "AMC") ||
      (e.date === tomorrow && e.timing === "BMO") ||
      (e.timing === "unknown" && (e.date === today || e.date === tomorrow));
    stats.finnhub = bulkEarnings.filter(inWindow).length;
    console.log(`[screen] earnings from Finnhub (bulk, ${today}..+3): ${bulkEarnings.length} rows, ${stats.finnhub} in window`);

    // Whitelist symbols the bulk calendar pull missed — e.g. ADRs
    // Finnhub files under a foreign primary listing (TSM -> 2330.TW)
    // never surface in the bulk range query at all. A whitelist entry
    // is an explicit user opt-in, so check each missing one directly by
    // symbol rather than silently dropping it.
    const bulkSymbols = new Set(bulkEarnings.map((e) => e.symbol.toUpperCase()));
    const missingWhitelist = Array.from(whitelist).filter((s) => !bulkSymbols.has(s));
    const supplemental =
      missingWhitelist.length > 0
        ? await getSupplementalWhitelistEarnings(missingWhitelist)
        : [];
    stats.whitelistSupplemented = supplemental.map((e) => e.symbol.toUpperCase());
    if (supplemental.length > 0) {
      console.log(
        `[screen] whitelist supplemental earnings found: ${stats.whitelistSupplemented.join(", ")}`,
      );
    }

    // Robinhood batch (courier-fed) + this user's saved conflict choices.
    const rhLoaded = await loadLatestRhBatch();
    const rhBatch = rhLoaded.status === "ok" ? rhLoaded.batch : null;
    const now = new Date();
    const rhAvail = rhBatchAvailability(rhBatch, now, today, tomorrow);
    const robinhoodStatus: CalendarSourcesStatus["robinhood"] =
      rhLoaded.status === "error"
        ? { status: "unavailable", fetchedAt: rhLoaded.fetchedAt, reason: `read failed: ${rhLoaded.message}` }
        : rhAvail.available && rhBatch
          ? { status: "ok", fetchedAt: rhBatch.fetchedAt, rows: rhBatch.rows.length }
          : { status: "unavailable", fetchedAt: rhBatch?.fetchedAt ?? null, reason: rhAvail.available ? "unknown" : rhAvail.reason };
    if (robinhoodStatus.status === "unavailable") {
      console.warn(`[screen] Robinhood calendar unavailable — Finnhub-only: ${robinhoodStatus.reason}`);
    }
    let choices: SourceChoice[] = [];
    try {
      choices = await loadSourceChoices(userId);
    } catch (e) {
      console.warn(`[screen] source choices unavailable: ${e instanceof Error ? e.message : e}`);
    }

    const merged = mergeEarningsSources({
      finnhub: [...bulkEarnings, ...supplemental].map((e) => ({ symbol: e.symbol, date: e.date, timing: e.timing })),
      robinhood: rhBatch,
      choices,
      today,
      tomorrow,
      now,
    });
    stats.merged = merged.length;
    stats.robinhoodOnly = merged.filter((m) => m.check.kind === "robinhood_only").map((m) => m.symbol);
    console.log(
      `[screen] merged calendar: ${merged.length} in window ` +
        `(robinhood=${robinhoodStatus.status}, rhOnly=${stats.robinhoodOnly.length}, ` +
        `disagree=${merged.filter((m) => m.check.kind === "dates_disagree").length}, ` +
        `timingProvisional=${merged.filter((m) => m.check.timingProvisional).length})`,
    );
    if (merged.length === 0) {
      console.warn(
        "[screen] 0 eligible earnings for today-AMC or tomorrow-BMO from either calendar. " +
          "Check [finnhub], [earnings] and [screen] Robinhood lines above.",
      );
    }

    // Step 2: hard kill ETFs + blacklist. Whitelist tickers bypass the
    // ETF/fund classifier (which has false positives on legit common
    // stock) but still get removed if explicitly blacklisted. The merge
    // already resolved each symbol to one in-window BMO/AMC date.
    type Survivor = {
      symbol: string;
      date: string;
      timing: "BMO" | "AMC";
      isWhitelisted: boolean;
      check: EarningsSourceCheck;
    };
    const survivors: Survivor[] = [];
    for (const e of merged) {
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
        timing: e.timing,
        isWhitelisted,
        check: e.check,
      });
    }
    stats.afterEtfAndBlacklist = survivors.length;
    console.log(
      `[screen] after ETF/blacklist: ${survivors.length} ` +
        `(dropped ETF=${stats.droppedByEtf.length}, blacklist=${stats.droppedByBlacklist.length})`,
    );

    // Step 3: fetch prices
    const provisional = new Set(survivors.filter((s) => s.check.timingProvisional).map((s) => s.symbol.toUpperCase()));
    const prices = await getBatchPrices(survivors.map((s) => s.symbol), {
      finnhubFallback: (sym) => !provisional.has(sym),
    });
    const priceHits = Object.values(prices).filter((p) => p > 0).length;
    console.log(
      `[screen] priced ${survivors.length} symbols, ${priceHits} with non-zero price`,
    );

    // Step 4: price floor. Whitelist tickers bypass the floor — the user has
    // explicitly opted them in and we trust that signal over a generic price cut.
    const afterPrice: Survivor[] = [];
    for (const s of survivors) {
      const p = prices[s.symbol.toUpperCase()] ?? 0;
      if (s.isWhitelisted || p >= f.priceFloor) {
        afterPrice.push(s);
      } else {
        stats.droppedByPrice.push(`${s.symbol.toUpperCase()}($${p.toFixed(2)})`);
      }
    }
    stats.afterPriceFilter = afterPrice.length;
    console.log(
      `[screen] after $${f.priceFloor} price floor: ${afterPrice.length} ` +
        `(dropped=${stats.droppedByPrice.length}; examples=${stats.droppedByPrice.slice(0, 6).join(",")})`,
    );

    // Step 5: Stage 2 quality floor. Computes business simplicity +
    // market cap tier + analyst dispersion per survivor (Yahoo +
    // Finnhub data only — NO Schwab). Drops anything that fails the
    // floor unless whitelisted (runStageTwo forces pass=true for
    // whitelisted names, so the drop branch only fires on
    // non-whitelisted candidates that genuinely fail).
    //
    // Industry classification piggy-backs on the same per-symbol
    // async block so we don't pay for it twice (cached lookup +
    // optional Yahoo fallback for whitelisted unknowns).
    type Scored = Survivor & {
      price: number;
      cls: { industry: string; source: string; pass: boolean };
      industryStatus: "pass" | "fail" | "unknown";
    };
    const t0 = Date.now();
    const scored: Scored[] = [];
    for (let i = 0; i < afterPrice.length; i += STAGE2_BATCH) {
      const batch = afterPrice.slice(i, i + STAGE2_BATCH);
      const verdicts = await Promise.all(
        batch.map(async (row) => {
          const upper = row.symbol.toUpperCase();
          const price = prices[upper] ?? 0;
          let cls = await getIndustryClassification(upper, {
            yahooAllowed: false,
          });
          // Yahoo fallback for ANY symbol whose static map + cache miss —
          // not just whitelisted names. Stamping "industry: unknown" on a
          // legit common stock was purely an artifact of the old gate.
          if (cls.source === "unknown") {
            cls = await getIndustryClassification(upper, { yahooAllowed: true });
          }
          const industryStatus: "pass" | "fail" | "unknown" = row.isWhitelisted
            ? "pass"
            : cls.source === "unknown"
              ? "unknown"
              : cls.pass
                ? "pass"
                : "fail";
          const industryPenalty =
            row.isWhitelisted ||
            industryStatus === "pass" ||
            industryStatus === "unknown"
              ? 0
              : -2;
          const candidate = buildCandidateFromEarnings(
            { symbol: row.symbol, date: row.date, timing: row.timing },
            price,
          );
          const stageTwo = await runStageTwo(
            candidate,
            cls.industry as IndustryClass,
            {
              industryPenalty,
              isWhitelisted: row.isWhitelisted,
              minMarketCapTier: f.minMarketCapTier,
            },
          );
          return { row, price, cls, industryStatus, stageTwo };
        }),
      );
      for (const v of verdicts) {
        const upper = v.row.symbol.toUpperCase();
        const mcapB = v.stageTwo.details.marketCapBillions;
        // Hard mcap floor — independent of Stage 2 score. Whitelisted
        // names bypass (the user explicitly opted them in).
        const meetsHardMcapFloor =
          v.row.isWhitelisted ||
          (mcapB !== null && mcapB >= f.minMarketCapBillions);
        if (!meetsHardMcapFloor) {
          stats.droppedByMcap.push(
            `${upper}(${mcapB === null ? "null" : `$${mcapB}B`})`,
          );
          continue;
        }
        // Stage 2 quality gate — tier floor comes from the active
        // config (<= 0 disables it). Whitelisted bypass handled
        // inside runStageTwo.
        if (!v.stageTwo.pass) {
          stats.droppedByQuality.push(
            `${upper}(${mcapB === null ? "null" : `$${mcapB}B`})`,
          );
          continue;
        }
        scored.push({
          symbol: v.row.symbol,
          date: v.row.date,
          timing: v.row.timing,
          isWhitelisted: v.row.isWhitelisted,
          check: v.row.check,
          price: v.price,
          cls: v.cls,
          industryStatus: v.industryStatus,
        });
      }
      if (i + STAGE2_BATCH < afterPrice.length) {
        await sleep(STAGE2_BATCH_DELAY_MS);
      }
    }
    stats.afterMcapFloor = afterPrice.length - stats.droppedByMcap.length;
    stats.afterQualityFilter = scored.length;
    console.log(
      `[screen] Stage 2 quality floor: ${scored.length} pass / ` +
        `${stats.droppedByMcap.length} dropped @ <$${f.minMarketCapBillions}B / ` +
        `${stats.droppedByQuality.length} dropped @ Stage 2 ` +
        `in ${Date.now() - t0}ms`,
    );

    // Step 6 (chain verification) was previously inline here — it now
    // lives in /api/screener/screen/verify-chains, called by the
    // client in batches with per-batch retry. Splitting it out means
    // a Schwab outage can't turn the screen into an empty board:
    // Stream A returns survivors as soon as filters + Stage 2 quality
    // resolve, and the client backfills chain-verification status
    // into the displayed table as each Stream C batch completes.
    stats.afterChainFilter = scored.length;
    console.log(
      `[screen] chain verification deferred to /verify-chains stream — ` +
        `${scored.length} survivors forwarded`,
    );

    // Step 7: build candidate shells. Stage 1 / Stage 3 / Stage 4 +
    // three-layer grade are deferred to Run Analysis; this route's
    // job is "what's reporting today and worth scoring?". Each row
    // returns with stageThree / stageFour null and recommendation =
    // "Needs analysis", which the UI already handles.
    const results: ScreenerResult[] = scored.map((row) => {
      const candidate = buildCandidateFromEarnings(
        { symbol: row.symbol, date: row.date, timing: row.timing },
        row.price,
      );
      return {
        symbol: candidate.symbol,
        price: candidate.price,
        earningsDate: candidate.earningsDate,
        earningsTiming: candidate.earningsTiming,
        daysToExpiry: candidate.daysToExpiry,
        expiry: candidate.expiry,
        expirySource: "weekly",
        stoppedAt: null,
        // stageOne is required on the type — placeholder lets the UI
        // distinguish "screen-only row" from a fully-graded one
        // without a schema change. Run Analysis overwrites it.
        stageOne: {
          pass: row.industryStatus !== "fail",
          reason: "deferred to Run Analysis",
          details: { industry: row.cls.industry ?? "" },
        },
        stageTwo: null,
        stageThree: null,
        stageFour: null,
        recommendation: "Needs analysis",
        errors: [],
        isWhitelisted: row.isWhitelisted,
        industryStatus: row.industryStatus,
        spreadTooWide: false,
        threeLayer: null,
        earningsSourceCheck: row.check,
      };
    });

    // Stable order by symbol — Run Analysis will re-sort by score
    // once grades land.
    results.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const final = results.slice(0, MAX_RESULTS * 6);
    stats.final = final.length;

    console.log(
      `[screen] SUMMARY finnhub=${stats.finnhub} merged=${stats.merged} afterEtfBlacklist=${stats.afterEtfAndBlacklist} ` +
        `afterPrice(>=$${f.priceFloor})=${stats.afterPriceFilter} ` +
        `afterMcap(>=$${f.minMarketCapBillions}B)=${stats.afterMcapFloor} ` +
        `afterQuality=${stats.afterQualityFilter} afterChain=${stats.afterChainFilter} ` +
        `(${stats.unverifiedChain?.length ?? 0} unverified) final=${stats.final} connected=${connected}`,
    );

    const response: ScreenResponse = {
      connected,
      calendarSources: { robinhood: robinhoodStatus, finnhub: finnhubStatus },
      screenedAt: new Date().toISOString(),
      configId: cfg.id,
      configName: cfg.name,
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
