// Entry-context stamping — fires for EVERY option position at creation
// (trades/bulk-create Phase 2b), independent of the screener. This is
// what closes the audit's "23% entry-context coverage" gap: the
// tracked_tickers merge only covers trades screened, tracked, and
// imported within a day; this fills VIX / spot / EM% / IV / delta /
// DTE / market cap / earnings linkage for everything else.
//
// Fill-nulls-only: the tracked_tickers merge (richer — grades, news)
// runs first and anything it stamped is left untouched. Every source
// here is best-effort — a Schwab or Yahoo outage stamps what it can
// and leaves the rest null. Never throws.
import { createServerClient } from "@/lib/supabase";
import {
  getOptionsChain,
  isSchwabConnected,
  parseSchwabImpliedVol,
  parseSchwabOptionDelta,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "@/lib/schwab";
import { getOrRefreshSnapshot } from "@/lib/market-snapshot";
import { getMarketContext } from "@/lib/market";
import { getUpcomingEarnings } from "@/lib/earnings";
import { getHistoricalPrices } from "@/lib/yahoo";

// Same PT-anchored "today" bulk-create/fills routes already use for
// opened_date/fill_date — a position's own openedDate is stamped in
// this same calendar, so comparing against it here (not a UTC today)
// is what makes "is this a same-day trade" mean the same thing
// everywhere in the app.
function todayPst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function toIsoDate(d: unknown): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "string") return d.slice(0, 10);
  return "";
}

// Last real close ON OR BEFORE targetIso — never looks forward, since
// an entry value must reflect what was knowable at open, not what
// happened after. Same normalize/sort/scan idiom as
// fetchYahooPriceActionTimed's lastOnOrBefore in lib/encyclopedia.ts.
// Works for any Yahoo-recognized symbol, including "^VIX" — verified
// live against a real past date before writing this.
async function historicalCloseOnOrBefore(
  symbol: string,
  targetIso: string,
): Promise<number | null> {
  const target = new Date(targetIso + "T00:00:00Z");
  const from = new Date(target.getTime() - 6 * 86_400_000);
  const to = new Date(target.getTime() + 86_400_000);
  const bars = await getHistoricalPrices(symbol, from, to).catch(() => []);
  const normalized = bars
    .map((b) => ({
      iso: toIsoDate((b as { date?: unknown }).date),
      close: Number((b as { close?: unknown }).close ?? 0),
    }))
    .filter((b) => b.iso && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  let best: number | null = null;
  for (const b of normalized) {
    if (b.iso <= targetIso) best = b.close;
    else break;
  }
  return best;
}

export type EntryContextResult = {
  stamped: string[]; // column names written
  earningsLinked: boolean;
};

function daysBetweenIso(a: string, b: string): number {
  return Math.round(
    (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000,
  );
}

// ATM legs + the position's own contract from a both-legs chain.
function chainReadings(
  chain: SchwabOptionsChain,
  expiry: string,
  strike: number,
  optionType: "put" | "call",
): {
  spot: number | null;
  emPct: number | null;
  contractIv: number | null;
  contractDelta: number | null;
} {
  const out = {
    spot: null as number | null,
    emPct: null as number | null,
    contractIv: null as number | null,
    contractDelta: null as number | null,
  };
  const spot =
    chain.underlying?.mark ?? chain.underlying?.last ?? chain.underlyingPrice ?? null;
  if (!spot || spot <= 0) return out;
  out.spot = spot;

  const mapFor = (side: "put" | "call") =>
    (side === "put" ? chain.putExpDateMap : chain.callExpDateMap) ?? {};
  const strikesAt = (side: "put" | "call"): Record<string, SchwabOptionContract[]> => {
    const m = mapFor(side);
    const key = Object.keys(m).find((k) => k.startsWith(expiry));
    return key ? m[key] : {};
  };
  const contractAt = (
    side: "put" | "call",
    target: number,
  ): SchwabOptionContract | null => {
    const strikes = strikesAt(side);
    const keys = Object.keys(strikes)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n));
    if (keys.length === 0) return null;
    const nearest = keys.reduce((best, k) =>
      Math.abs(k - target) < Math.abs(best - target) ? k : best,
    );
    const arr =
      strikes[String(nearest)] ??
      strikes[nearest.toFixed(1)] ??
      strikes[nearest.toFixed(2)] ??
      [];
    // Only accept a genuine strike match for the position contract;
    // ATM lookups tolerate nearest.
    return arr[0] ?? null;
  };

  // Expected move from the ATM straddle (same math as the T0 capture).
  const atmPut = contractAt("put", spot);
  const atmCall = contractAt("call", spot);
  if (atmPut && atmCall && Number.isFinite(atmPut.mark) && Number.isFinite(atmCall.mark)) {
    out.emPct = (atmPut.mark + atmCall.mark) / spot;
  }

  // The position's own contract — IV and delta at its strike.
  const own = contractAt(optionType, strike);
  if (own && Math.abs(own.strikePrice - strike) < 0.51) {
    // parseSchwabImpliedVol (lib/schwab.ts) rejects Schwab's -999 "not
    // computable" sentinel and any other implausible value — same fix
    // as captureEarningsT0/T1 (lib/encyclopedia.ts) and ivPercent()
    // (lib/screener.ts), all now sharing this one validator so a -999
    // divided by 100 can't quietly become entry_iv on a new position.
    out.contractIv = parseSchwabImpliedVol(own.volatility);
    // parseSchwabOptionDelta rejects Schwab's sentinel fallback
    // (delta=1 regardless of put/call — a real put delta can never be
    // +1) and anything outside a real delta's plausible range — same
    // fix as lib/screener.ts's runStageFour.
    out.contractDelta = parseSchwabOptionDelta(own.delta, own.putCall);
  }
  return out;
}

// Link the position to the earnings event it spans, creating the
// earnings_history stub from the Finnhub calendar when the event isn't
// ingested yet (T0 capture would create it anyway at 15:45 ET on report
// day — this just makes the spine exist from the moment of entry).
// upcomingBySymbol: pre-fetched calendar shared across one import batch.
async function linkEarningsEvent(
  positionId: string,
  symbol: string,
  openedDate: string,
  expiry: string,
  upcomingBySymbol: Map<string, { date: string }>,
): Promise<boolean> {
  const sb = createServerClient();

  // Nearest already-ingested event the trade spans.
  const evRes = await sb
    .from("earnings_history")
    .select("id,earnings_date")
    .eq("symbol", symbol)
    .gte("earnings_date", openedDate)
    .lte("earnings_date", expiry)
    .order("earnings_date", { ascending: true })
    .limit(1);
  let eventId = ((evRes.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;

  // Not ingested yet — check the calendar and create the stub.
  if (!eventId) {
    const cal = upcomingBySymbol.get(symbol);
    if (cal && cal.date >= openedDate && cal.date <= expiry) {
      // 2026-08-19 Phase A fix: "entry-context" was retired by Step 1's
      // provenance migration — this upsert has been failing
      // unconditionally since (remapped to the value Step 1 already
      // reserved for this path). This branch only ever runs when no
      // existing row was found above, so it's always a real insert.
      await sb.from("earnings_history").upsert(
        {
          symbol,
          earnings_date: cal.date,
          data_source: "entry_context_stub",
          date_confidence: "unknown",
          is_complete: false,
        },
        { onConflict: "symbol,earnings_date" },
      );
      const re = await sb
        .from("earnings_history")
        .select("id")
        .eq("symbol", symbol)
        .eq("earnings_date", cal.date)
        .limit(1);
      eventId = ((re.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
    }
  }
  if (!eventId) return false;

  const upd = await sb
    .from("positions")
    .update({ earnings_history_id: eventId })
    .eq("id", positionId)
    .is("earnings_history_id", null);
  return !upd.error;
}

// Batch-shared context so one import with N positions fetches VIX and
// the earnings calendar once. Create with buildStampContext() per
// bulk-create call.
export type StampContext = {
  vix: number | null;
  schwabConnected: boolean;
  upcomingBySymbol: Map<string, { date: string }>;
};

export async function buildStampContext(): Promise<StampContext> {
  const [marketCtx, connected, upcoming] = await Promise.all([
    getMarketContext().catch(() => ({ vix: null })),
    isSchwabConnected()
      .then((r) => r.connected)
      .catch(() => false),
    getUpcomingEarnings(14).catch(() => []),
  ]);
  const upcomingBySymbol = new Map<string, { date: string }>();
  for (const e of upcoming) {
    const sym = e.symbol.toUpperCase();
    // Keep the earliest upcoming event per symbol.
    if (!upcomingBySymbol.has(sym)) upcomingBySymbol.set(sym, { date: e.date });
  }
  return { vix: (marketCtx as { vix: number | null }).vix ?? null, schwabConnected: connected, upcomingBySymbol };
}

export async function stampEntryContext(
  ctx: StampContext,
  position: {
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    optionType: "put" | "call";
    openedDate: string;
    userId: string;
  },
): Promise<EntryContextResult> {
  const result: EntryContextResult = { stamped: [], earningsLinked: false };
  const sb = createServerClient();
  const symbol = position.symbol.toUpperCase();
  // The whole point of this fix: entry context is "as of when the
  // position was actually opened," not "as of whenever this stamp
  // happens to run." A same-day trade's open date IS today, so this
  // branch changes nothing for the common case — it's a live fetch
  // either way, just via the same code path as before. A backdated
  // import (a rebuild, a delayed import, a re-run after a data fix)
  // takes the other branch and never touches a live/current source.
  const isSameDay = position.openedDate === todayPst();

  try {
    // Current values — only null fields get written, so the richer
    // tracked_tickers merge (which runs before this) always wins.
    const cur = await sb
      .from("positions")
      .select(
        "entry_vix,entry_stock_price,entry_em_pct,entry_iv,entry_delta,entry_dte,entry_market_cap,earnings_history_id",
      )
      .eq("id", position.id)
      .eq("user_id", position.userId)
      .limit(1);
    const row = ((cur.data ?? []) as Array<Record<string, unknown>>)[0];
    if (!row) return result;

    const patch: Record<string, number> = {};

    // Pure calendar math, no market-data dependency either way — already
    // correctly computed from openedDate, not "today." Unaffected by
    // this fix, included here unchanged.
    if (row.entry_dte === null || row.entry_dte === undefined) {
      const dte = daysBetweenIso(position.expiry, position.openedDate);
      if (dte >= 0) patch.entry_dte = dte;
    }

    const needVix = row.entry_vix === null || row.entry_vix === undefined;
    const needPrice = row.entry_stock_price === null || row.entry_stock_price === undefined;
    const needCap = row.entry_market_cap === null || row.entry_market_cap === undefined;
    const needEm = row.entry_em_pct === null || row.entry_em_pct === undefined;
    const needIv = row.entry_iv === null || row.entry_iv === undefined;
    const needDelta = row.entry_delta === null || row.entry_delta === undefined;

    if (isSameDay) {
      // ---- unchanged: same-day trade, live sources are correct ----
      if (needVix && ctx.vix !== null) patch.entry_vix = ctx.vix;

      // Yahoo snapshot: spot fallback + market cap.
      let snapshotPrice: number | null = null;
      if (needPrice || needCap) {
        const snap = await getOrRefreshSnapshot(symbol, 30).catch(() => null);
        snapshotPrice = snap?.price ?? null;
        if (needCap && snap?.market_cap != null && Number.isFinite(snap.market_cap)) {
          patch.entry_market_cap = snap.market_cap;
        }
      }

      // Schwab chain: EM%, contract IV + delta, best spot.
      let chainSpot: number | null = null;
      if (ctx.schwabConnected && (needEm || needIv || needDelta || needPrice)) {
        try {
          const chain = await getOptionsChain(symbol, position.expiry, "ALL");
          const r = chainReadings(chain, position.expiry, Number(position.strike), position.optionType);
          chainSpot = r.spot;
          if (needEm && r.emPct !== null) patch.entry_em_pct = r.emPct;
          if (needIv && r.contractIv !== null) patch.entry_iv = r.contractIv;
          if (needDelta && r.contractDelta !== null) patch.entry_delta = r.contractDelta;
        } catch (e) {
          console.warn(
            `[entry-context] chain(${symbol}, ${position.expiry}) failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      if (needPrice) {
        const price = chainSpot ?? snapshotPrice;
        if (price !== null && Number.isFinite(price)) patch.entry_stock_price = price;
      }
    } else {
      // ---- backdated: historical sources only, or null — never a
      // live/current value standing in for a past date. Price and VIX
      // both have a real historical daily-bar source (Yahoo), so those
      // get sourced properly. EM% / IV / delta need a historical OPTIONS
      // CHAIN — Schwab only serves the current chain, and the paid
      // historical-options source was cancelled (same reason
      // fetch-em-history's implied-move backfill was discontinued) — a
      // past date's chain genuinely isn't obtainable, so these stay
      // null rather than being approximated from today's chain. Same
      // reasoning for market cap: Yahoo's daily bars are OHLCV only, no
      // historical shares-outstanding series to compute an as-of cap.
      if (needPrice) {
        const price = await historicalCloseOnOrBefore(symbol, position.openedDate);
        if (price !== null) patch.entry_stock_price = price;
      }
      if (needVix) {
        const vix = await historicalCloseOnOrBefore("^VIX", position.openedDate);
        if (vix !== null) patch.entry_vix = vix;
      }
    }

    if (Object.keys(patch).length > 0) {
      const upd = await sb
        .from("positions")
        .update(patch)
        .eq("id", position.id)
        .eq("user_id", position.userId);
      if (upd.error) {
        console.warn(`[entry-context] update(${symbol}) failed: ${upd.error.message}`);
      } else {
        result.stamped = Object.keys(patch);
      }
    }

    // Trade→event spine at the moment of entry.
    if (row.earnings_history_id === null || row.earnings_history_id === undefined) {
      result.earningsLinked = await linkEarningsEvent(
        position.id,
        symbol,
        position.openedDate,
        position.expiry,
        ctx.upcomingBySymbol,
      );
    }
  } catch (e) {
    console.warn(
      `[entry-context] stamp(${symbol}) threw: ${e instanceof Error ? e.message : e}`,
    );
  }
  return result;
}
