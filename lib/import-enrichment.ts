// Post-import enrichment that needs live market data: the close-time
// snapshot (one options chain per close) and entry-context stamping
// (VIX, spot, EM%, IV, delta per opened position), plus the trade-chain
// / campaign re-classification that reads the stamped entry price.
//
// runBulkCreate runs these inline for manual imports. The Schwab
// Account Data poll passes deferEnrichment so its request only writes
// fills — two polls hit Vercel's 60s limit with these on the request
// path (2026-10-20 9am and 1pm) — and the poll trigger then calls
// POST /api/schwab-account/enrich-imports, which finds the unfinished
// work itself (runDeferredEnrichment below). Discovery, not a hand-off
// list: a run that dies mid-way is picked up by the next one.
import { createServerClient } from "@/lib/supabase";
import type { Fill } from "@/lib/positions";
import { buildSnapshotRow, fetchChainWideSafe } from "@/lib/snapshots";
import { buildStampContext, stampEntryContext } from "@/lib/entry-context";
import { classifyUserChains, persistChains } from "@/lib/trade-chains";
import { classifyAndPersistCoveredCallChains } from "@/lib/covered-call-chains";
import { buildAndPersistCampaigns } from "@/lib/campaigns";
import {
  CLOSE_SNAPSHOTS_PER_REQUEST,
  STAMPS_PER_REQUEST,
  pickCloseBatch,
  pickStampBatch,
  stampCandidateCutoff,
} from "@/lib/import-enrichment-rules";

type Sb = ReturnType<typeof createServerClient>;

export type OpenedPositionMeta = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  openedDate: string;
};

// Close-time snapshot: live IV/delta/theta for a position just closed.
// Best-effort — logs, never throws.
export async function captureCloseSnapshot(sb: Sb, userId: string, positionId: string): Promise<boolean> {
  try {
    const { data: posRow } = await sb
      .from("positions")
      .select(
        "id, symbol, strike, expiry, avg_premium_sold, opened_date, entry_stock_price, entry_em_pct, option_type, direction",
      )
      .eq("id", positionId)
      .eq("user_id", userId)
      .single();
    const position = posRow as {
      id: string;
      symbol: string;
      strike: number;
      expiry: string;
      avg_premium_sold: number | null;
      opened_date: string | null;
      entry_stock_price: number | null;
      entry_em_pct: number | null;
      option_type: "put" | "call" | null;
      direction: "short" | "long" | null;
    } | null;
    if (!position) return false;
    const { data: preFillsRaw } = await sb
      .from("fills")
      .select("fill_type, contracts, premium, fill_date")
      .eq("position_id", positionId)
      .eq("user_id", userId);
    const preFills = (preFillsRaw ?? []) as Fill[];
    const chain = await fetchChainWideSafe(
      position.symbol,
      position.expiry,
      position.option_type === "call" ? "call" : "put",
    );
    const snapshotRow = buildSnapshotRow(position, chain, preFills, {
      nowIso: new Date().toISOString(),
      closeSnapshot: true,
    });
    const { error: sErr } = await sb.from("position_snapshots").insert({ ...snapshotRow, user_id: userId });
    if (sErr) {
      console.warn(`[import-enrichment] close snapshot insert failed for ${position.symbol}: ${sErr.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      `[import-enrichment] close snapshot capture failed for ${positionId}: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

// Entry-context stamping for opened positions (nulls only — a richer
// tracked_tickers merge that already ran wins). Best-effort.
export async function stampOpenedPositions(userId: string, metas: OpenedPositionMeta[]): Promise<string[]> {
  const stamped: string[] = [];
  if (metas.length === 0) return stamped;
  try {
    const stampCtx = await buildStampContext();
    for (const meta of metas) {
      const r = await stampEntryContext(stampCtx, {
        id: meta.positionId,
        userId,
        symbol: meta.symbol,
        strike: meta.strike,
        expiry: meta.expiry,
        optionType: meta.optionType,
        openedDate: meta.openedDate,
      });
      stamped.push(meta.positionId);
      if (r.stamped.length > 0 || r.earningsLinked) {
        console.log(
          `[import-enrichment] entry context ${meta.symbol}: stamped=[${r.stamped.join(",")}] earningsLinked=${r.earningsLinked}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[import-enrichment] entry-context pass failed: ${e instanceof Error ? e.message : e}`);
  }
  return stamped;
}

// Trade-chain, covered-call chain and campaign re-classification for
// each symbol. User-confirmed rows are never clobbered. Runs after
// stamping so the deep-ITM test can use entry_stock_price.
export async function reclassifySymbols(userId: string, symbols: string[]): Promise<void> {
  for (const sym of symbols) {
    try {
      const chains = await classifyUserChains(userId, sym);
      await persistChains(chains, "auto", { skipConfirmed: true });
      const flagged = chains.filter((c) => c.tradeType !== "clean");
      if (flagged.length > 0) {
        console.log(
          `[import-enrichment] chain detection ${sym}: ${flagged.map((c) => `${c.tradeType} (${c.optionCount} legs, $${c.chainPnl})`).join("; ")}`,
        );
      }
    } catch (e) {
      console.warn(`[import-enrichment] chain detection failed for ${sym}: ${e instanceof Error ? e.message : e}`);
    }
    // Covered-call roll-chain linking — separate from the CSP chain
    // detection above (which excludes covered calls entirely; see
    // lib/covered-call-chains.ts's header).
    try {
      const result = await classifyAndPersistCoveredCallChains(userId, sym);
      if (result.chainsWritten > 0) {
        console.log(
          `[import-enrichment] covered-call chain detection ${sym}: ${result.chainsWritten} chain(s), ${result.membersUpdated} member(s) linked`,
        );
      }
    } catch (e) {
      console.warn(
        `[import-enrichment] covered-call chain detection failed for ${sym}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  // Campaign layer — after chain detection so a fill that just joined
  // an existing chain is folded into that chain's campaign.
  for (const sym of symbols) {
    try {
      const built = await buildAndPersistCampaigns(userId, sym);
      if (built.unresolved > 0) {
        console.log(`[import-enrichment] campaign resolution ${sym}: ${built.resolved} resolved, ${built.unresolved} unresolved`);
      }
    } catch (e) {
      console.warn(`[import-enrichment] campaign build failed for ${sym}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export type DeferredEnrichmentResult = {
  stamped: number;
  closeSnapshots: number;
  reclassified: string[];
  remaining: number;
};

// One bounded slice of deferred work, found from the data itself:
//  - option positions opened in the last STAMP_LOOKBACK_DAYS with no
//    entry_dte (stampEntryContext always writes it when expiry >=
//    opened date, so null means never stamped);
//  - close fills dated today whose position has no close snapshot
//    taken today (one per position per day, so a second partial close
//    the same day gets none — inline mode snapshots every close fill).
// Both are capped per call. `symbol` narrows all of it to one ticker and also re-runs chain /
// campaign classification for it (the poll names the symbols it
// touched; a scale-in onto an already-stamped position is otherwise
// invisible here). The caller re-invokes while `remaining` > 0.
export async function runDeferredEnrichment(
  userId: string,
  opts: { symbol?: string; limit?: number; todayUtc?: string },
): Promise<DeferredEnrichmentResult> {
  const sb = createServerClient();
  const today = opts.todayUtc ?? new Date().toISOString().slice(0, 10);
  const symbol = opts.symbol?.toUpperCase();

  // ---- close snapshots (today only — a snapshot is "live at close") ----
  let closeSnapshots = 0;
  let closesRemaining = 0;
  const closesRes = await sb
    .from("fills")
    .select("position_id")
    .eq("user_id", userId)
    .eq("fill_type", "close")
    .eq("fill_date", today);
  if (closesRes.error) throw new Error(`close-fill lookup failed: ${closesRes.error.message}`);
  let closedIds = Array.from(
    new Set(((closesRes.data ?? []) as Array<{ position_id: string }>).map((r) => r.position_id)),
  );
  if (closedIds.length > 0) {
    let posQ = sb
      .from("positions")
      .select("id")
      .eq("user_id", userId)
      .eq("position_type", "option")
      .in("id", closedIds);
    if (symbol) posQ = posQ.eq("symbol", symbol);
    const posRes = await posQ;
    if (posRes.error) throw new Error(`closed-position lookup failed: ${posRes.error.message}`);
    closedIds = ((posRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }
  if (closedIds.length > 0) {
    const snapsRes = await sb
      .from("position_snapshots")
      .select("position_id")
      .eq("user_id", userId)
      .eq("close_snapshot", true)
      .gte("snapshot_time", `${today}T00:00:00Z`)
      .in("position_id", closedIds);
    if (snapsRes.error) throw new Error(`close-snapshot lookup failed: ${snapsRes.error.message}`);
    const have = new Set(((snapsRes.data ?? []) as Array<{ position_id: string }>).map((r) => r.position_id));
    const picked = pickCloseBatch(closedIds, have, CLOSE_SNAPSHOTS_PER_REQUEST);
    closesRemaining = picked.remaining;
    for (const id of picked.batch) {
      if (await captureCloseSnapshot(sb, userId, id)) closeSnapshots += 1;
    }
  }

  // ---- entry-context stamps ----
  let candQ = sb
    .from("positions")
    .select("id,symbol,strike,expiry,option_type,opened_date")
    .eq("user_id", userId)
    .eq("position_type", "option")
    .is("entry_dte", null)
    .gte("opened_date", stampCandidateCutoff(today));
  if (symbol) candQ = candQ.eq("symbol", symbol);
  const candRes = await candQ.order("opened_date", { ascending: true }).limit(200);
  if (candRes.error) throw new Error(`stamp-candidate lookup failed: ${candRes.error.message}`);
  const candidates = (candRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    option_type: "put" | "call" | null;
    opened_date: string;
  }>;
  const { batch, remaining } = pickStampBatch(candidates, opts.limit ?? STAMPS_PER_REQUEST);
  await stampOpenedPositions(
    userId,
    batch.map((c) => ({
      positionId: c.id,
      symbol: c.symbol,
      strike: Number(c.strike),
      expiry: c.expiry,
      optionType: c.option_type === "call" ? "call" : "put",
      openedDate: c.opened_date,
    })),
  );

  const reclassified = Array.from(new Set([...(symbol ? [symbol] : []), ...batch.map((c) => c.symbol)]));
  await reclassifySymbols(userId, reclassified);

  return { stamped: batch.length, closeSnapshots, reclassified, remaining: remaining + closesRemaining };
}
