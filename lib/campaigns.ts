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
// Persistence has two tiers. Identity (which earnings event a chain
// belongs to) and decision context (strike deviation, analysis timing,
// exit reason, days held) are cached in the `campaigns` table and
// recomputed/overwritten every time buildAndPersistCampaigns runs for a
// campaign — cheap, DB-only, always kept in sync on write, never
// trusted as stale at read time. Reporting numbers that need a market-
// data fetch (breach) or that only make sense computed fresh (blended
// premium, timing spread) stay READ-time-only in getCampaignReport —
// same rationale as the 754d546 chain-P&L fix: caching those would go
// stale the moment a new fill lands on a still-open campaign.
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
// chain never splits across two campaigns. After membership is
// settled, recomputes decision context for every campaign touched this
// call — a campaign can gain members from more than one chain in the
// same pass (CRWV 2026-08-11's five strikes are five separate chains),
// so decision context is only correct once the whole loop below is
// done, not per-chain.
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

  const touchedCampaigns = new Map<string, { symbol: string; earningsDate: string }>();

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
    touchedCampaigns.set(campaignId, { symbol: symbol.toUpperCase(), earningsDate: resolved.row.earnings_date });
  }

  for (const [campaignId, { symbol: sym, earningsDate }] of Array.from(touchedCampaigns.entries())) {
    await persistDecisionContext(userId, campaignId, sym, earningsDate);
  }

  return result;
}

// ---- shared position/fill fetch + decision-context derivation ----

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
  created_at: string | null;
};

// A fill's fill_time is indistinguishable from import wall-clock — the
// pre-03559d3 bug signature — when it lands within this of its own
// created_at. Real broker times (parsed "Time Placed", or same-day live
// entries) are essentially always further apart than this; the only
// false-positive risk is a fill imported within seconds of real
// execution, which errs toward UNDER-trusting timing data, the safe
// direction.
const ESTIMATE_THRESHOLD_MS = 30_000;

export type DecisionContext = {
  blendedEntryStrike: number | null;
  referenceStrike: number | null;
  strikeDeviationDollars: number | null;
  strikeDeviationXEm: number | null;
  analysisCreatedAt: string | null;
  analysisSavedBeforeFirstFill: boolean | null;
  exitReason: "assigned" | "expired" | "closed_early" | "rolled" | "open" | null;
  daysHeldSessions: number | null;
  daysHeldIsEstimated: boolean | null;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
};

// Pure derivation over already-fetched rows — shared by
// persistDecisionContext (writes campaigns.*) and getCampaignReport
// (read-time report), so the two never compute this differently.
function deriveDecisionContext(
  positions: ReportPosition[],
  fills: ReportFill[],
  ra: { reference_strike: number | null; spot_at_analysis: number | null; em_pct_at_analysis: number | null; created_at: string } | null,
): DecisionContext {
  const options = positions.filter((p) => !isStock(p));
  const optionIds = new Set(options.map((p) => p.id));
  const openFills = fills.filter((f) => f.fill_type === "open" && optionIds.has(f.position_id));
  const strikeByPosition = new Map(options.map((p) => [p.id, Number(p.strike)]));

  // Blended entry STRIKE (not premium — that stays in getCampaignReport):
  // contract-weighted average strike across every opening fill. Where a
  // campaign has a ladder (CRWV 2026-08-11's 67-71), this is what
  // "the strike actually sold" means for a single deviation number.
  let blendedEntryStrike: number | null = null;
  if (openFills.length > 0) {
    const totalContracts = openFills.reduce((s, f) => s + Number(f.contracts), 0);
    const weightedStrike = openFills.reduce(
      (s, f) => s + (strikeByPosition.get(f.position_id) ?? 0) * Number(f.contracts),
      0,
    );
    blendedEntryStrike = totalContracts > 0 ? weightedStrike / totalContracts : null;
  }

  const referenceStrike = ra?.reference_strike ?? null;
  const spotAtAnalysis = ra?.spot_at_analysis ?? null;
  const emPctAtAnalysis = ra?.em_pct_at_analysis ?? null;
  const strikeDeviationDollars =
    blendedEntryStrike !== null && referenceStrike !== null ? blendedEntryStrike - referenceStrike : null;
  // x EM, same convention as chain-history/route.ts's xEmAtEntry:
  // deviation as a % of spot, divided by expected-move %.
  const strikeDeviationXEm =
    strikeDeviationDollars !== null && spotAtAnalysis !== null && spotAtAnalysis > 0 && emPctAtAnalysis !== null && emPctAtAnalysis > 0
      ? strikeDeviationDollars / spotAtAnalysis / emPctAtAnalysis
      : null;

  const openTimes = openFills.map((f) => f.fill_time).filter((t): t is string => !!t);
  const firstOpenAt = openTimes.length > 0 ? openTimes.slice().sort()[0] : null;
  const lastOpenAt = openTimes.length > 0 ? openTimes.slice().sort().pop()! : null;

  const analysisCreatedAt = ra?.created_at ?? null;
  const analysisSavedBeforeFirstFill =
    analysisCreatedAt && firstOpenAt ? analysisCreatedAt < firstOpenAt : null;

  const stillOpen = positions.some((p) => p.status === "open");
  // Exit reason: assignment dominates (worst/most consequential
  // outcome) regardless of how many legs. Otherwise, more than one
  // option leg in the campaign means at least one roll happened, so
  // the campaign's story is "rolled" even though the terminal leg
  // itself expired/closed. A single-leg campaign reports its own
  // terminal status directly. "closed_early" (bought back before
  // expiry/assignment) is the one category that can hide very
  // different management behind an identical "Clean / expired
  // worthless" read on a single-leg campaign, hence tracked separately
  // from "rolled" rather than folded into it.
  let exitReason: DecisionContext["exitReason"] = null;
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

  const start = positions.map((p) => p.opened_date).sort()[0];
  const end = stillOpen
    ? null
    : positions.map((p) => p.closed_date ?? p.opened_date).sort().pop() ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const daysHeldSessions = start ? tradingDaysBetween(start, end ?? today) : null;

  // Tainted if ANY fill (open or close) contributing to this campaign
  // has a fill_time indistinguishable from its own created_at — the
  // pre-03559d3 bug signature. daysHeldSessions itself is computed from
  // fill_date (always reliable, unaffected by the fill_time bug), but
  // this flag makes the pre-fix data distinguishable per the task's ask
  // rather than presenting every campaign's timing as equally trusted.
  // `fills` was already fetched scoped to this campaign's positions, so
  // every row here is relevant — no further filter needed.
  const daysHeldIsEstimated =
    fills.length > 0
      ? fills.some((f) => {
          if (!f.fill_time || !f.created_at) return true; // missing data can't be trusted either
          const delta = Math.abs(new Date(f.fill_time).getTime() - new Date(f.created_at).getTime());
          return delta < ESTIMATE_THRESHOLD_MS;
        })
      : null;

  return {
    blendedEntryStrike,
    referenceStrike,
    strikeDeviationDollars,
    strikeDeviationXEm,
    analysisCreatedAt,
    analysisSavedBeforeFirstFill,
    exitReason,
    daysHeldSessions,
    daysHeldIsEstimated,
    firstOpenAt,
    lastOpenAt,
  };
}

async function fetchCampaignRows(
  sb: ReturnType<typeof createServerClient>,
  userId: string,
  campaignId: string,
  symbol: string,
  earningsDate: string,
): Promise<{ positions: ReportPosition[]; fills: ReportFill[]; ra: Parameters<typeof deriveDecisionContext>[2] } | null> {
  const posRes = await sb
    .from("positions")
    .select(
      "id,strike,expiry,status,position_type,option_type,opened_date,closed_date,realized_pnl,total_contracts,trade_type",
    )
    .eq("user_id", userId)
    .eq("campaign_id", campaignId);
  const positions = (posRes.data ?? []) as ReportPosition[];
  if (positions.length === 0) return null;

  const ids = positions.map((p) => p.id);
  const fillsRes = await sb
    .from("fills")
    .select("position_id,fill_type,contracts,premium,fill_date,fill_time,created_at")
    .in("position_id", ids);
  const fills = (fillsRes.data ?? []) as ReportFill[];

  const raRes = await sb
    .from("research_analyses")
    .select("reference_strike,spot_at_analysis,em_pct_at_analysis,created_at")
    .eq("symbol", symbol.toUpperCase())
    .eq("earnings_date", earningsDate)
    .maybeSingle();
  const ra = raRes.data as Parameters<typeof deriveDecisionContext>[2];

  return { positions, fills, ra };
}

// Recomputes decision context for one campaign and writes it onto the
// campaigns row. Called from buildAndPersistCampaigns after membership
// settles; also safe to call standalone (e.g. from a backfill/repair
// script) since it re-derives everything from current positions/fills,
// never from a previous campaigns row value.
export async function persistDecisionContext(
  userId: string,
  campaignId: string,
  symbol: string,
  earningsDate: string,
): Promise<DecisionContext | null> {
  const sb = createServerClient();
  const data = await fetchCampaignRows(sb, userId, campaignId, symbol, earningsDate);
  if (!data) return null;
  const ctx = deriveDecisionContext(data.positions, data.fills, data.ra);
  await sb
    .from("campaigns")
    .update({
      strike_deviation_dollars: ctx.strikeDeviationDollars,
      strike_deviation_x_em: ctx.strikeDeviationXEm,
      analysis_saved_before_first_fill: ctx.analysisSavedBeforeFirstFill,
      exit_reason: ctx.exitReason,
      days_held_sessions: ctx.daysHeldSessions,
      days_held_is_estimated: ctx.daysHeldIsEstimated,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  return ctx;
}

// ---- read-time reporting ----

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
  exitReason: DecisionContext["exitReason"];
  daysHeldSessions: number | null;
  daysHeldIsEstimated: boolean | null;
  stillOpen: boolean;
  referenceStrike: number | null;
  blendedEntryStrike: number | null;
  strikeDeviationDollars: number | null;
  strikeDeviationXEm: number | null;
  analysisCreatedAt: string | null;
  analysisSavedBeforeFirstFill: boolean | null;
  openFillCount: number;
  positionCount: number;
};

// Full report for one campaign, computed fresh from current positions +
// fills — nothing here is trusted from a cached column except the
// decision-context fields, which campaigns.* stores but this
// recomputes anyway (deriveDecisionContext is cheap; recomputing keeps
// this function correct even if called before a persist happens to
// have run). `symbol` and `earningsDate` come from the campaigns row;
// the caller fetches that row (or looks it up by id) before calling
// this.
export async function getCampaignReport(
  userId: string,
  campaignId: string,
  symbol: string,
  earningsDate: string,
  resolutionMethod: ResolutionMethod,
): Promise<CampaignReport | null> {
  const sb = createServerClient();
  const data = await fetchCampaignRows(sb, userId, campaignId, symbol, earningsDate);
  if (!data) return null;
  const { positions, fills } = data;
  const ctx = deriveDecisionContext(positions, fills, data.ra);

  const options = positions.filter((p) => !isStock(p));
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

  const timingSpreadSeconds =
    ctx.firstOpenAt && ctx.lastOpenAt
      ? Math.round((new Date(ctx.lastOpenAt).getTime() - new Date(ctx.firstOpenAt).getTime()) / 1000)
      : null;

  const tradeType = mostSevereType(options.map((p) => p.trade_type ?? "clean"));

  const realizedPnl =
    Math.round(positions.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) * 100) / 100;

  const stillOpen = positions.some((p) => p.status === "open");
  const today = new Date().toISOString().slice(0, 10);

  // Breach: worst daily cushion between underlying and each leg's own
  // strike across its hold, using daily-bar low/high (no intraday
  // series stored anywhere) — same method chain-history/route.ts
  // already uses per-chain, applied per-leg here and OR'd across the
  // campaign. Market-data fetch — this is why breach stays read-time
  // only, never persisted onto campaigns.
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
    firstOpenAt: ctx.firstOpenAt,
    lastOpenAt: ctx.lastOpenAt,
    timingSpreadSeconds,
    tradeType,
    breached,
    netRecovered,
    realizedPnl,
    exitReason: ctx.exitReason,
    daysHeldSessions: ctx.daysHeldSessions,
    daysHeldIsEstimated: ctx.daysHeldIsEstimated,
    stillOpen,
    referenceStrike: ctx.referenceStrike,
    blendedEntryStrike: ctx.blendedEntryStrike,
    strikeDeviationDollars: ctx.strikeDeviationDollars,
    strikeDeviationXEm: ctx.strikeDeviationXEm,
    analysisCreatedAt: ctx.analysisCreatedAt,
    analysisSavedBeforeFirstFill: ctx.analysisSavedBeforeFirstFill,
    openFillCount: openFills.length,
    positionCount: positions.length,
  };
}

// Risk Score's "prior documented loss on this ticker" contribution
// (lib/risk-score.ts) — event-scoped, replacing the earlier
// tickerTradeCount/tickerWinRate read (any terminal position on the
// symbol, including swing trades and non-earnings CSPs). campaigns rows
// only ever exist for a chain that resolved to an earnings_history
// match (see resolveEarningsForChain / buildAndPersistCampaigns — an
// unresolved chain never gets a campaign_id), so `campaigns.symbol = X`
// alone already means "on an earnings event for that symbol"; this
// only needs to additionally restrict to CSP legs (short puts) and sum
// realized_pnl per campaign to find one that nets negative.
export async function hasPriorCspEarningsLoss(userId: string, symbol: string): Promise<boolean> {
  const sb = createServerClient();
  const campRes = await sb
    .from("campaigns")
    .select("id")
    .eq("user_id", userId)
    .eq("symbol", symbol.toUpperCase());
  const campaignIds = ((campRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (campaignIds.length === 0) return false;

  const posRes = await sb
    .from("positions")
    .select("campaign_id,realized_pnl,option_type,direction")
    .eq("user_id", userId)
    .in("campaign_id", campaignIds)
    .eq("option_type", "put");
  const positions = (posRes.data ?? []) as Array<{
    campaign_id: string;
    realized_pnl: number | null;
    option_type: "put" | "call" | null;
    direction: "long" | "short" | null;
  }>;

  const pnlByCampaign = new Map<string, number>();
  for (const p of positions) {
    // Missing direction = pre-migration row = implicitly short (every
    // pre-03559d3 row was a CSP) — same convention app/api/positions/
    // open/route.ts already applies.
    if ((p.direction ?? "short") !== "short") continue;
    pnlByCampaign.set(p.campaign_id, (pnlByCampaign.get(p.campaign_id) ?? 0) + Number(p.realized_pnl ?? 0));
  }
  return Array.from(pnlByCampaign.values()).some((pnl) => pnl < 0);
}
