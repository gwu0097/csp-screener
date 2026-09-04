// Shared orchestration for local-only full-chain IV capture — used by
// both the daily T+1..T+20 runner and the T0/T1 companion capture.
// Local-only (imports lib/local-chain-store, which pulls in native
// duckdb) — never import this from app/.
import { getOptionsChain, getValidAccessToken, SchwabApiError } from "./schwab";
import { getCurrentPrice } from "./yahoo";
import { getMarketContext } from "./market";
import { sendDiscordAlert } from "./discord-alert";
import {
  writeChainChunk,
  writeOutcomeChunk,
  queryTodayOutcomeStats,
  type CapturePhase,
  type ChainStrikeRow,
  type OutcomeRow,
} from "./local-chain-store";
import { createThrottle } from "./schwab-throttle";
import { createServerClient } from "./supabase";
import { isSuppressed, recordPermanentFailure } from "./capture-suppression";
import { upsertHealthRollup, type OutstandingSymbol } from "./capture-health";

const CHUNK_SIZE = 25;
const THROTTLE_RPS = 1.8;
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const FAILURE_ALERT_THRESHOLD = 0.10;

export type CaptureCandidate = {
  symbol: string;
  earnings_date: string;
  earnings_history_id: string | null;
  trading_day_offset: number | null;
};

export type CaptureRunResult = {
  due: number;
  attempted: number;
  alreadyDoneToday: number;
  fired: number;
  errored: number;
  disconnected: number;
  suppressed: number;
  totalStrikes: number;
  aborted: "schwab_disconnected" | "no_candidates" | null;
};

// 429/5xx and network-level failures (fetch rejects before a response —
// timeouts, DNS, ECONNRESET) are transient: back off and retry. A 400
// on a chain fetch is Schwab telling us the symbol/params are invalid
// (delisted tickers return this consistently) — retrying it burns
// budget for a result that won't change. 401 is a dead access token —
// distinct from both, handled as its own bucket upstream.
type ErrorClass = "transient" | "permanent" | "auth";

function classifyError(e: unknown): ErrorClass {
  if (e instanceof SchwabApiError) {
    if (e.status === 401) return "auth";
    if (e.status === 429 || e.status >= 500) return "transient";
    return "permanent";
  }
  // fetch() itself rejecting (never got an HTTP response) is a network
  // blip, not a statement about the symbol — transient.
  return "transient";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ChainFetchResult =
  | { ok: true; chain: Awaited<ReturnType<typeof getOptionsChain>>; attempts: number }
  | { ok: false; error: unknown; attempts: number; errorClass: ErrorClass };

async function fetchChainWithRetry(
  symbol: string,
  acquire: () => Promise<void>,
  faultInjector?: (symbol: string, attempt: number) => Error | null,
): Promise<ChainFetchResult> {
  let lastErr: unknown;
  let lastClass: ErrorClass = "transient";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquire();
    try {
      if (faultInjector) {
        const injected = faultInjector(symbol, attempt);
        if (injected) throw injected;
      }
      const chain = await getOptionsChain(symbol, undefined, "ALL", 200);
      return { ok: true, chain, attempts: attempt };
    } catch (e) {
      lastErr = e;
      lastClass = classifyError(e);
      if (lastClass !== "transient" || attempt === MAX_ATTEMPTS) {
        return { ok: false, error: e, attempts: attempt, errorClass: lastClass };
      }
      const backoffMs = Math.round(500 * 2 ** (attempt - 1) + Math.random() * 250);
      console.log(
        `[retry] ${symbol} attempt ${attempt}/${MAX_ATTEMPTS} transient failure — backing off ${backoffMs}ms: ` +
          `${e instanceof Error ? e.message.slice(0, 140) : e}`,
      );
      await sleep(backoffMs);
    }
  }
  return { ok: false, error: lastErr, attempts: MAX_ATTEMPTS, errorClass: lastClass };
}

export async function runChainCapture(
  candidates: CaptureCandidate[],
  phase: CapturePhase,
  captureDate: string,
  opts?: {
    dryRun?: boolean;
    reconnectUrl?: string;
    alertLabel?: string;
    // Test hook: called before each real fetch attempt; return an Error
    // to simulate that attempt failing (e.g. a synthetic 429) instead of
    // hitting Schwab. Never set in production call sites.
    faultInjector?: (symbol: string, attempt: number) => Error | null;
  },
): Promise<CaptureRunResult> {
  const dryRun = opts?.dryRun === true;
  const reconnectUrl = opts?.reconnectUrl ?? "https://csp-screener.vercel.app/settings";
  const label = opts?.alertLabel ?? phase;
  const runStartedAt = new Date().toISOString();
  const sb = createServerClient();

  const result: CaptureRunResult = {
    due: candidates.length,
    attempted: 0,
    alreadyDoneToday: 0,
    fired: 0,
    errored: 0,
    disconnected: 0,
    suppressed: 0,
    totalStrikes: 0,
    aborted: null,
  };

  // Finalizes the day's rollup by re-reading the outcome log rather than
  // hand-summing counters — this is what makes a same-day retry pass
  // (which only processes what's still outstanding) produce a correct
  // cumulative rollup without double-counting the earlier invocation's
  // results.
  async function finalizeRollup(runFinishedAt: string | null): Promise<void> {
    if (dryRun) return;
    const { counts, completedSymbols } = await queryTodayOutcomeStats(phase, captureDate);
    const outstanding: OutstandingSymbol[] = candidates
      .filter((c) => !completedSymbols.has(c.symbol))
      .map((c) => ({
        symbol: c.symbol,
        earnings_history_id: c.earnings_history_id,
        earnings_date: c.earnings_date,
        trading_day_offset: c.trading_day_offset,
      }));
    await upsertHealthRollup(captureDate, phase, {
      due: candidates.length,
      fired: counts.fired ?? 0,
      errored: counts.errored ?? 0,
      suppressed: counts.suppressed ?? 0,
      missed: counts.missed ?? 0,
      schwab_disconnected: counts.schwab_disconnected ?? 0,
      outstanding,
      run_started_at: runStartedAt,
      run_finished_at: runFinishedAt,
    });

    // schwab_disconnected and errored are kept separate rather than
    // summed into one "failed" ratio — schwab_disconnected is a real
    // outage signal, but errored also catches permanent 400s (delisted/
    // invalid symbols per classifyError's comment above), a data-quality
    // condition that shouldn't read as an outage just because it landed
    // on the same day as a few bad tickers.
    const disconnectedCount = counts.schwab_disconnected ?? 0;
    const erroredCount = counts.errored ?? 0;
    if (candidates.length > 0 && disconnectedCount / candidates.length > FAILURE_ALERT_THRESHOLD) {
      await sendDiscordAlert(
        `🔴 ${label} capture: ${disconnectedCount}/${candidates.length} due symbols failed due to Schwab ` +
          `disconnection (${Math.round((disconnectedCount / candidates.length) * 100)}%) for ${captureDate}.\n` +
          `fired=${counts.fired ?? 0} errored=${erroredCount} disconnected=${disconnectedCount} ` +
          `suppressed=${counts.suppressed ?? 0}\nOutstanding: ${outstanding.length}`,
      );
    }
    if (candidates.length > 0 && erroredCount / candidates.length > FAILURE_ALERT_THRESHOLD) {
      await sendDiscordAlert(
        `🟡 ${label} capture: ${erroredCount}/${candidates.length} due symbols errored ` +
          `(${Math.round((erroredCount / candidates.length) * 100)}%) for ${captureDate} — often delisted/invalid ` +
          `symbols (permanent 400s), not necessarily an outage. Check the outcome log if this looks unusual.\n` +
          `fired=${counts.fired ?? 0} errored=${erroredCount} disconnected=${disconnectedCount} ` +
          `suppressed=${counts.suppressed ?? 0}\nOutstanding: ${outstanding.length}`,
        { mention: false },
      );
    }
  }

  let chunkIndex = 0;
  const outcomeRows: OutcomeRow[] = [];

  if (candidates.length === 0) {
    outcomeRows.push({
      symbol: null,
      earnings_history_id: null,
      earnings_date: null,
      capture_phase: phase,
      trading_day_offset: null,
      capture_date: captureDate,
      outcome: "skipped_no_earnings",
      error_message: null,
      strikes_written: 0,
      attempts: 0,
      recorded_at: new Date().toISOString(),
    });
    if (!dryRun) {
      await writeOutcomeChunk(outcomeRows, phase, runStartedAt, captureDate, 1);
      await upsertHealthRollup(captureDate, phase, {
        due: 0,
        fired: 0,
        errored: 0,
        suppressed: 0,
        missed: 0,
        schwab_disconnected: 0,
        outstanding: [],
        run_started_at: runStartedAt,
        run_finished_at: new Date().toISOString(),
      });
    }
    result.aborted = "no_candidates";
    return result;
  }

  let schwabOk = true;
  try {
    await getValidAccessToken();
  } catch {
    schwabOk = false;
  }

  if (!schwabOk) {
    const now = new Date().toISOString();
    for (const c of candidates) {
      outcomeRows.push({
        symbol: c.symbol,
        earnings_history_id: c.earnings_history_id,
        earnings_date: c.earnings_date,
        capture_phase: phase,
        trading_day_offset: c.trading_day_offset,
        capture_date: captureDate,
        outcome: "schwab_disconnected",
        error_message: "pre-check: getValidAccessToken failed",
        strikes_written: 0,
        attempts: 0,
        recorded_at: now,
      });
    }
    result.disconnected = candidates.length;
    if (!dryRun) {
      await writeOutcomeChunk(outcomeRows, phase, runStartedAt, captureDate, 1);
      await sendDiscordAlert(
        `⚠️ ${label} capture SKIPPED — Schwab disconnected.\n${candidates.length} symbols due, none captured.\nReconnect: ${reconnectUrl}`,
      );
      await finalizeRollup(now);
    }
    result.aborted = "schwab_disconnected";
    return result;
  }

  // Skip symbols already fired/suppressed earlier today (same-day retry
  // pass) — the outcome log itself is the persisted work queue, so this
  // needs no separate state file that could drift out of sync with it.
  const { completedSymbols: alreadyDoneToday } = dryRun
    ? { completedSymbols: new Set<string>() }
    : await queryTodayOutcomeStats(phase, captureDate);
  const toProcess = candidates.filter((c) => !alreadyDoneToday.has(c.symbol));
  result.alreadyDoneToday = candidates.length - toProcess.length;
  if (result.alreadyDoneToday > 0) {
    console.log(
      `[${label}] ${result.alreadyDoneToday}/${candidates.length} already fired/suppressed earlier today — skipping, processing ${toProcess.length}`,
    );
  }

  if (toProcess.length === 0) {
    console.log(`[${label}] nothing outstanding for ${captureDate} — all due symbols already completed today`);
    await finalizeRollup(new Date().toISOString());
    return result;
  }

  const marketCtx = await getMarketContext().catch(() => ({ vix: null, spyPrice: null, regime: null }));
  if (!dryRun) {
    try {
      const upsertRes = await sb
        .from("market_context")
        .upsert(
          { date: captureDate, vix: marketCtx.vix, spy_price: marketCtx.spyPrice, market_regime: marketCtx.regime },
          { onConflict: "date" },
        );
      if (upsertRes.error) console.warn("market_context upsert failed:", upsertRes.error.message);
    } catch (e) {
      console.warn("market_context upsert threw:", e);
    }
  }
  console.log(`[${label}] market context: vix=${marketCtx.vix} spy=${marketCtx.spyPrice} regime=${marketCtx.regime}`);

  const acquire = createThrottle(THROTTLE_RPS);
  let disconnectedAlertSent = false;
  let chainBuffer: ChainStrikeRow[] = [];
  let outcomeBuffer: OutcomeRow[] = [];
  let processed = 0;

  async function flush() {
    // Swap the buffers to fresh empty arrays SYNCHRONOUSLY, before any
    // await — not after the write completes. With CONCURRENCY>1, the
    // other worker keeps pushing while this write is in flight; if the
    // reset happened after the await (as an earlier version of this
    // function did), those concurrent pushes land in the array that's
    // mid-write (already serialized to disk via the synchronous
    // JSON.stringify inside writeParquet, so they're NOT in that
    // file), and then get silently discarded when the post-await reset
    // replaces the binding — a real lost-update race, confirmed
    // empirically (2 rows missing from a 303-item run, exactly
    // matching 2 chunks landing 1 row short). Swapping first means any
    // concurrent push always lands in the NEXT chunk's buffer instead.
    const chainToWrite = chainBuffer;
    const outcomeToWrite = outcomeBuffer;
    chainBuffer = [];
    outcomeBuffer = [];
    if (dryRun) return;
    chunkIndex += 1;
    const [chainPath, outcomePath] = await Promise.all([
      writeChainChunk(chainToWrite, phase, runStartedAt, captureDate, chunkIndex),
      writeOutcomeChunk(outcomeToWrite, phase, runStartedAt, captureDate, chunkIndex),
    ]);
    console.log(
      `[${label}] flushed chunk ${chunkIndex}: ${chainToWrite.length} chain rows -> ${chainPath ?? "(none)"}, ` +
        `${outcomeToWrite.length} outcome rows -> ${outcomePath ?? "(none)"}`,
    );
  }

  async function processOne(c: CaptureCandidate) {
    const capturedAt0 = new Date().toISOString();

    if (isSuppressed(c.symbol)) {
      outcomeBuffer.push({
        symbol: c.symbol,
        earnings_history_id: c.earnings_history_id,
        earnings_date: c.earnings_date,
        capture_phase: phase,
        trading_day_offset: c.trading_day_offset,
        capture_date: captureDate,
        outcome: "suppressed",
        error_message: "symbol on suppression list (repeated permanent failures) — Schwab call skipped",
        strikes_written: 0,
        attempts: 0,
        recorded_at: capturedAt0,
      });
      result.suppressed += 1;
      processed += 1;
      if (processed % CHUNK_SIZE === 0 || processed === toProcess.length) await flush();
      return;
    }

    const fetchResult = await fetchChainWithRetry(c.symbol, acquire, opts?.faultInjector);
    const capturedAt = new Date().toISOString();

    if (!fetchResult.ok) {
      const { error: e, attempts, errorClass } = fetchResult;
      const message = e instanceof Error ? e.message : String(e);
      const isAuthFailure = errorClass === "auth";
      if (errorClass === "permanent") {
        const entry = recordPermanentFailure(c.symbol, message);
        console.log(
          `[${label}] ${c.symbol} permanent failure #${entry.permanentFailures}` +
            (entry.suppressed ? ` — now suppressed` : ``),
        );
      }
      outcomeBuffer.push({
        symbol: c.symbol,
        earnings_history_id: c.earnings_history_id,
        earnings_date: c.earnings_date,
        capture_phase: phase,
        trading_day_offset: c.trading_day_offset,
        capture_date: captureDate,
        outcome: isAuthFailure ? "schwab_disconnected" : "errored",
        error_message: message,
        strikes_written: 0,
        attempts,
        recorded_at: capturedAt,
      });
      if (isAuthFailure) {
        result.disconnected += 1;
        if (!dryRun && !disconnectedAlertSent) {
          disconnectedAlertSent = true;
          await sendDiscordAlert(
            `⚠️ ${label} capture: Schwab disconnected mid-run at symbol ${c.symbol} (${processed + 1}/${toProcess.length} processed). Remaining symbols will log schwab_disconnected too.\nReconnect: ${reconnectUrl}`,
          );
        }
      } else {
        result.errored += 1;
      }
    } else {
      const chain = fetchResult.chain;
      const underlyingSchwab =
        chain.underlying?.mark ?? chain.underlying?.last ?? chain.underlyingPrice ?? null;
      const underlyingYahoo = await getCurrentPrice(c.symbol).catch(() => null);

      let strikesWritten = 0;
      for (const [side, map] of [
        ["PUT", chain.putExpDateMap],
        ["CALL", chain.callExpDateMap],
      ] as const) {
        for (const expKey of Object.keys(map ?? {})) {
          for (const strikeKey of Object.keys(map[expKey])) {
            for (const oc of map[expKey][strikeKey]) {
              chainBuffer.push({
                symbol: c.symbol,
                earnings_history_id: c.earnings_history_id,
                earnings_date: c.earnings_date,
                capture_phase: phase,
                trading_day_offset: c.trading_day_offset,
                capture_date: captureDate,
                captured_at: capturedAt,
                underlying_price_schwab: underlyingSchwab,
                underlying_price_yahoo: underlyingYahoo,
                vix: marketCtx.vix,
                option_type: side,
                strike: oc.strikePrice,
                expiration_date: oc.expirationDate?.slice(0, 10) ?? expKey.slice(0, 10),
                dte: oc.daysToExpiration ?? null,
                bid: oc.bid ?? null,
                ask: oc.ask ?? null,
                mark: oc.mark ?? null,
                last: oc.last ?? null,
                iv_pct: oc.volatility ?? null,
                delta: oc.delta ?? null,
                gamma: oc.gamma ?? null,
                theta: oc.theta ?? null,
                vega: oc.vega ?? null,
                open_interest: oc.openInterest ?? null,
                volume: oc.totalVolume ?? null,
                source: "schwab",
              });
              strikesWritten += 1;
            }
          }
        }
      }
      outcomeBuffer.push({
        symbol: c.symbol,
        earnings_history_id: c.earnings_history_id,
        earnings_date: c.earnings_date,
        capture_phase: phase,
        trading_day_offset: c.trading_day_offset,
        capture_date: captureDate,
        outcome: "fired",
        error_message: null,
        strikes_written: strikesWritten,
        attempts: fetchResult.attempts,
        recorded_at: capturedAt,
      });
      result.totalStrikes += strikesWritten;
      result.fired += 1;
    }
    processed += 1;
    if (processed % CHUNK_SIZE === 0 || processed === toProcess.length) {
      await flush();
      console.log(
        `[${label}] progress ${processed}/${toProcess.length} — fired=${result.fired} errored=${result.errored} ` +
          `disconnected=${result.disconnected} suppressed=${result.suppressed} strikes=${result.totalStrikes}`,
      );
    }
  }

  let next = 0;
  async function worker() {
    while (next < toProcess.length) {
      const i = next;
      next += 1;
      result.attempted += 1;
      await processOne(toProcess[i]);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toProcess.length) }, () => worker()));
  } finally {
    if (chainBuffer.length > 0 || outcomeBuffer.length > 0) {
      await flush();
    }
  }

  await finalizeRollup(new Date().toISOString());
  return result;
}
