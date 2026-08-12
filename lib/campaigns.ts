// Campaign layer: groups trade chains that share one earnings decision.
//
// A trade chain (lib/trade-chains.ts) links positions by roll adjacency
// and assignment within one (symbol, broker) — it does NOT group
// deliberate same-session scale-ins at different strikes against the
// same print. CRWV 2026-08-11: five opens at 71/70/69/68 across one
// morning is one decision, but five separate chains (different
// strikes, no roll adjacency between them). A campaign sits above
// chains, keyed on (symbol, earnings_date) — the same key
// research_analyses and earnings_history already share.
//
// Deliberately thin persistence: only campaign IDENTITY (which
// earnings event a chain belongs to) is cached in the `campaigns`
// table and stamped onto positions.campaign_id. Every reporting number
// below (blended entry, strike ladder, timing spread, breach, exit
// reason, days held) is computed at READ time in getCampaignReport —
// same rationale as the 754d546 chain-P&L fix: a cached total goes
// stale the moment a new fill lands on a still-open campaign, or a
// later close resolves an exit reason. Identity doesn't have that
// problem — once a chain's earnings event is resolved, a later fill on
// the SAME chain still belongs to the SAME event.
import { createServerClient } from "@/lib/supabase";
import { classifyUserChains } from "@/lib/trade-chains";
import { safetyNumerator } from "@/lib/positions";
import { getHistoricalPrices } from "@/lib/yahoo";

type EarningsRow = { id: string; earnings_date: string };

function isStock(p: { position_type: string | null }): boolean {
  return p.position_type === "stock_long" || p.position_type === "stock_short";
}

export type ResolutionMethod = "fk" | "range" | "lookback";

// FK-first (an option member already stamped earnings_history_id by
// lib/entry-context.ts or lib/earnings-capture.ts), then a date-range
// match across the chain's hold window (earliest open -> latest
// expiry, same pattern chain-history/route.ts already uses read-only),
// then a lookback: the nearest earnings_history row up to 45 days
// BEFORE the chain's earliest open. The lookback exists for rolled
// continuations that re-enter well after the print — the chain's
// EARLIEST leg may not itself span earnings_date (e.g. a pre-market
// event on a day the chain's first leg opened later that session), so
// range matching alone misses it. This is what took the first
// resolution pass from 30 unresolved chains down to 15 of 269.
function resolveEarningsForChain(
  optionMembers: Array<{ opened_date: string; expiry: string; earnings_history_id: string | null }>,
  earningsRows: EarningsRow[],
  earningsById: Map<string, EarningsRow>,
): { row: EarningsRow; method: ResolutionMethod } | null {
  for (const m of optionMembers) {
    if (m.earnings_history_id) {
      const hit = earningsById.get(m.earnings_history_id);
      if (hit) return { row: hit, method: "fk" };
    }
  }
  if (optionMembers.length === 0) return null;
  const lo = optionMembers.map((m) => m.opened_date).sort()[0];
  const hi = optionMembers.map((m) => m.expiry).sort().pop()!;
  const rangeMatches = earningsRows
    .filter((r) => r.earnings_date >= lo && r.earnings_date <= hi)
    .sort((a, b) => a.earnings_date.localeCompare(b.earnings_date));
  if (rangeMatches[0]) return { row: rangeMatches[0], method: "range" };

  const floor = new Date(lo + "T00:00:00Z");
  floor.setUTCDate(floor.getUTCDate() - 45);
  const floorIso = floor.toISOString().slice(0, 10);
  const lookbackMatches = earningsRows
    .filter((r) => r.earnings_date >= floorIso && r.earnings_date < lo)
    .sort((a, b) => b.earnings_date.localeCompare(a.earnings_date));
  if (lookbackMatches[0]) return { row: lookbackMatches[0], method: "lookback" };
  return null;
}

export type CampaignBuildResult = {
  resolved: number;
  unresolved: number;
  unresolvedChains: Array<{ symbol: string; optionCount: number; firstOpen: string }>;
};

// Resolve + persist campaign membership for one user's chains on one
// symbol. Best-effort per chain — a resolution failure on one chain
// doesn't block the rest. Stamps campaign_id onto EVERY member of a
// resolved chain (options AND linked stock legs) in one pass so a
// chain never splits across two campaigns.
export async function buildAndPersistCampaigns(
  userId: string,
  symbol: string,
): Promise<CampaignBuildResult> {
  const sb = createServerClient();
  const result: CampaignBuildResult = { resolved: 0, unresolved: 0, unresolvedChains: [] };
  const chains = await classifyUserChains(userId, symbol);
  if (chains.length === 0) return result;

  const allIds = chains.flatMap((c) => c.members.map((m) => m.id));
  const extraRes = await sb
    .from("positions")
    .select("id,earnings_history_id")
    .in("id", allIds);
  const earningsIdByPosition = new Map(
    ((extraRes.data ?? []) as Array<{ id: string; earnings_history_id: string | null }>).map((r) => [
      r.id,
      r.earnings_history_id,
    ]),
  );

  const ehRes = await sb
    .from("earnings_history")
    .select("id,earnings_date")
    .eq("symbol", symbol.toUpperCase());
  const earningsRows = (ehRes.data ?? []) as EarningsRow[];
  const earningsById = new Map(earningsRows.map((r) => [r.id, r]));

  for (const chain of chains) {
    const options = chain.members.filter((m) => !isStock(m));
    // Orphan stock lots aren't campaigns on their own — same rule
    // chain-history/route.ts already applies to chain display.
    if (options.length === 0) continue;

    const optionMembers = options.map((m) => ({
      opened_date: m.opened_date,
      expiry: m.expiry,
      earnings_history_id: earningsIdByPosition.get(m.id) ?? null,
    }));
    const resolved = resolveEarningsForChain(optionMembers, earningsRows, earningsById);
    if (!resolved) {
      result.unresolved += 1;
      result.unresolvedChains.push({
        symbol,
        optionCount: options.length,
        firstOpen: options.map((m) => m.opened_date).sort()[0],
      });
      continue;
    }
    result.resolved += 1;

    const campRes = await sb
      .from("campaigns")
      .upsert(
        {
          user_id: userId,
          symbol: symbol.toUpperCase(),
          earnings_date: resolved.row.earnings_date,
          resolution_method: resolved.method,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,symbol,earnings_date" },
      )
      .select("id")
      .limit(1);
    const campaignId = ((campRes.data ?? [])[0] as { id: string } | undefined)?.id;
    if (!campaignId) {
      // Upsert raced or failed silently (e.g. transient network error) —
      // don't count as resolved if nothing got stamped.
      result.resolved -= 1;
      result.unresolved += 1;
      continue;
    }

    for (const m of chain.members) {
      await sb.from("positions").update({ campaign_id: campaignId }).eq("id", m.id);
    }
  }
  return result;
}

// ---- read-time reporting ----

function tradingDaysBetween(fromIso: string, toIso: string): number {
  let count = 0;
  const cur = new Date(fromIso + "T00:00:00Z");
  const end = new Date(toIso + "T00:00:00Z");
  while (cur <= end) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return Math.max(0, count - 1);
}

// Most-severe-wins when a campaign's member chains disagree on type —
// recovery_play contamination is exactly why the exclusion in
// personalStats exists, so it dominates a milder rolled/clean chain in
// the same campaign.
const TYPE_SEVERITY: Record<string, number> = { clean: 0, rolled: 1, recovery_play: 2 };
function mostSevereType(types: string[]): string {
  let best = "clean";
  for (const t of types) {
    if ((TYPE_SEVERITY[t] ?? 0) > (TYPE_SEVERITY[best] ?? 0)) best = t;
  }
  return best;
}

export type CampaignReport = {
  campaignId: string;
  symbol: string;
  earningsDate: string;
  resolutionMethod: ResolutionMethod;
  blendedEntry: number | null;
  totalContracts: number;
  totalPremium: number;
  strikeLow: number | null;
  strikeHigh: number | null;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  timingSpreadSeconds: number | null;
  tradeType: string;
  breached: boolean;
  netRecovered: boolean;
  realizedPnl: number;
  exitReason: "assigned" | "expired" | "closed_early" | "rolled" | "open" | null;
  daysHeldSessions: number | null;
  stillOpen: boolean;
  referenceStrike: number | null;
  strikeDeviation: number | null;
  analysisCreatedAt: string | null;
  analysisSavedBeforeFirstFill: boolean | null;
  openFillCount: number;
  positionCount: number;
};

type ReportPosition = {
  id: string;
  strike: number;
  expiry: string;
  status: string;
  position_type: string | null;
  option_type: "put" | "call" | null;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  total_contracts: number | null;
  trade_type: string | null;
};

type ReportFill = {
  position_id: string;
  fill_type: "open" | "close";
  contracts: number;
  premium: number;
  fill_date: string;
  fill_time: string | null;
};

// Full report for one campaign, computed fresh from current positions +
// fills — nothing here is trusted from a cached column. `symbol` and
// `earningsDate` come from the campaigns row; the caller fetches that
// row (or looks it up by id) before calling this.
export async function getCampaignReport(
  userId: string,
  campaignId: string,
  symbol: string,
  earningsDate: string,
  resolutionMethod: ResolutionMethod,
): Promise<CampaignReport | null> {
  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select(
      "id,strike,expiry,status,position_type,option_type,opened_date,closed_date,realized_pnl,total_contracts,trade_type",
    )
    .eq("user_id", userId)
    .eq("campaign_id", campaignId);
  const positions = (posRes.data ?? []) as ReportPosition[];
  if (positions.length === 0) return null;

  const options = positions.filter((p) => !isStock(p));
  const ids = positions.map((p) => p.id);
  const fillsRes = await sb
    .from("fills")
    .select("position_id,fill_type,contracts,premium,fill_date,fill_time")
    .in("position_id", ids);
  const fills = (fillsRes.data ?? []) as ReportFill[];
  const optionIds = new Set(options.map((p) => p.id));
  const openFills = fills.filter((f) => f.fill_type === "open" && optionIds.has(f.position_id));

  let blendedEntry: number | null = null;
  let totalContracts = 0;
  let totalPremium = 0;
  if (openFills.length > 0) {
    totalContracts = openFills.reduce((s, f) => s + Number(f.contracts), 0);
    totalPremium = openFills.reduce((s, f) => s + Number(f.premium) * Number(f.contracts), 0);
    blendedEntry = totalContracts > 0 ? totalPremium / totalContracts : null;
    totalPremium = totalPremium * 100;
  }

  const strikes = options.map((p) => Number(p.strike));
  const strikeLow = strikes.length > 0 ? Math.min(...strikes) : null;
  const strikeHigh = strikes.length > 0 ? Math.max(...strikes) : null;

  // fill_time is import wall-clock for any position imported before the
  // bulk-create timePlaced fix — treat as an upper/lower bound, not a
  // precise timestamp, for historical rows. Real per-fill execution
  // time only exists going forward once that fix is live.
  const openTimes = openFills.map((f) => f.fill_time).filter((t): t is string => !!t);
  const firstOpenAt = openTimes.length > 0 ? openTimes.sort()[0] : null;
  const lastOpenAt = openTimes.length > 0 ? openTimes.slice().sort().pop()! : null;
  const timingSpreadSeconds =
    firstOpenAt && lastOpenAt
      ? Math.round((new Date(lastOpenAt).getTime() - new Date(firstOpenAt).getTime()) / 1000)
      : null;

  const tradeType = mostSevereType(options.map((p) => p.trade_type ?? "clean"));

  const realizedPnl =
    Math.round(positions.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) * 100) / 100;

  const stillOpen = positions.some((p) => p.status === "open");
  const start = positions.map((p) => p.opened_date).sort()[0];
  const end = stillOpen
    ? null
    : positions.map((p) => p.closed_date ?? p.opened_date).sort().pop() ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const daysHeldSessions = start ? tradingDaysBetween(start, end ?? today) : null;

  // Breach: worst daily cushion between underlying and each leg's own
  // strike across its hold, using daily-bar low/high (no intraday
  // series stored anywhere) — same method chain-history/route.ts
  // already uses per-chain, applied per-leg here and OR'd across the
  // campaign.
  let breached = false;
  if (options.length > 0) {
    const fetchLo = options.map((p) => p.opened_date).sort()[0];
    const fetchHi = options.map((p) => p.closed_date ?? today).sort().pop()!;
    const bars = await getHistoricalPrices(
      symbol,
      new Date(fetchLo + "T00:00:00Z"),
      new Date(new Date(fetchHi + "T00:00:00Z").getTime() + 86_400_000),
    ).catch(() => []);
    for (const p of options) {
      const holdLo = p.opened_date;
      const holdHi = p.closed_date ?? today;
      const optionType = p.option_type ?? "put";
      for (const bar of bars) {
        const iso = bar.date.toISOString().slice(0, 10);
        if (iso < holdLo || iso > holdHi) continue;
        const extreme = optionType === "call" ? bar.high : bar.low;
        const cushion = safetyNumerator(extreme, Number(p.strike), optionType);
        if (cushion < 0) {
          breached = true;
          break;
        }
      }
      if (breached) break;
    }
  }
  const netRecovered = breached && realizedPnl > 0;

  // Exit reason: assignment dominates (worst/most consequential
  // outcome) regardless of how many legs. Otherwise, more than one
  // option leg in the campaign means at least one roll happened, so
  // the campaign's story is "rolled" even though the terminal leg
  // itself expired/closed. A single-leg campaign reports its own
  // terminal status directly.
  let exitReason: CampaignReport["exitReason"] = null;
  if (stillOpen) {
    exitReason = "open";
  } else if (options.some((p) => p.status === "assigned")) {
    exitReason = "assigned";
  } else if (options.length > 1) {
    exitReason = "rolled";
  } else if (options[0]?.status === "expired_worthless") {
    exitReason = "expired";
  } else if (options[0]?.status === "closed") {
    exitReason = "closed_early";
  }

  // opened_date is date-only, so same-day scale-ins (the exact case
  // this feature exists for — CRWV 2026-08-11 across five strikes)
  // otherwise tie and fall back to arbitrary fetch order. Break the tie
  // with each leg's own earliest open fill_time when available — still
  // subject to the same historical-import-clustering caveat as
  // firstOpenAt/lastOpenAt above, but strictly better than an arbitrary
  // order for picking which strike the "the strike rule was built on"
  // (chain-history/route.ts's own phrase) actually was.
  const firstFillByPosition = new Map<string, string>();
  for (const f of openFills) {
    if (!f.fill_time) continue;
    const cur = firstFillByPosition.get(f.position_id);
    if (!cur || f.fill_time < cur) firstFillByPosition.set(f.position_id, f.fill_time);
  }
  const anchor =
    options
      .slice()
      .sort((a, b) => {
        const byDate = a.opened_date.localeCompare(b.opened_date);
        if (byDate !== 0) return byDate;
        const ta = firstFillByPosition.get(a.id) ?? "";
        const tb = firstFillByPosition.get(b.id) ?? "";
        return ta.localeCompare(tb);
      })[0] ?? null;
  const anchorStrike = anchor ? Number(anchor.strike) : null;

  const raRes = await sb
    .from("research_analyses")
    .select("reference_strike,created_at")
    .eq("symbol", symbol.toUpperCase())
    .eq("earnings_date", earningsDate)
    .maybeSingle();
  const ra = raRes.data as { reference_strike: number | null; created_at: string } | null;
  const referenceStrike = ra?.reference_strike ?? null;
  const strikeDeviation =
    anchorStrike !== null && referenceStrike !== null ? anchorStrike - referenceStrike : null;
  const analysisCreatedAt = ra?.created_at ?? null;
  const analysisSavedBeforeFirstFill =
    analysisCreatedAt && firstOpenAt ? analysisCreatedAt < firstOpenAt : null;

  return {
    campaignId,
    symbol: symbol.toUpperCase(),
    earningsDate,
    resolutionMethod,
    blendedEntry,
    totalContracts,
    totalPremium: Math.round(totalPremium * 100) / 100,
    strikeLow,
    strikeHigh,
    firstOpenAt,
    lastOpenAt,
    timingSpreadSeconds,
    tradeType,
    breached,
    netRecovered,
    realizedPnl,
    exitReason,
    daysHeldSessions,
    stillOpen,
    referenceStrike,
    strikeDeviation,
    analysisCreatedAt,
    analysisSavedBeforeFirstFill,
    openFillCount: openFills.length,
    positionCount: positions.length,
  };
}
