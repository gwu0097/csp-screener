// Universe & Themes, Phase C — Perplexity-assisted theme expansion with
// mandatory human review. Split into two stages to match the two API
// routes forced by Vercel's function time ceiling (a single call doing
// Perplexity + up to 40 quote/quoteSummary pairs + bar backfill would
// routinely exceed 60s):
//   1. runExpansionSuggest — one Perplexity call, returns raw suggestions.
//   2. filterAndQueueSuggestions — hard-filters ONE CHUNK of suggestions
//      (the caller chunks the up-to-40 list and calls this sequentially,
//      same discipline as the RS Pullback enrichment chunking) and
//      inserts survivors as review_status='pending' rows.
//
// Nothing in this file ever writes review_status='approved' — that only
// happens in the pending-review accept endpoint, after a human looks at
// the queue. A pending row is invisible to resolveUniverseSymbols (see
// lib/universe.ts) until then.
import { createServerClient } from "./supabase";
import { askPerplexityRaw } from "./perplexity";
import { getSymbolExpansionProfile } from "./yahoo";
import { backfillDailyBars } from "./swing-screener";
import { getOrFetchDailyBars } from "./daily-bars-cache";
import { getOrRefreshSnapshot } from "./market-snapshot";
import { computeADRPercent, computeAvgDollarVolume } from "./indicators";

export const MAX_SUGGESTIONS = 40;
const MIN_PRICE = 5;
const MIN_MARKET_CAP = 500_000_000;
const MIN_AVG_DOLLAR_VOLUME_20D = 10_000_000;

// Only these four get a real prompt — 'custom' has no structured
// relationship to expand from (see THEME_TYPES in
// components/swing-universe-view.tsx), so the caller must disable the
// expand button rather than send a request here.
const PROMPT_TEMPLATES: Record<string, string> = {
  supply_chain:
    "Who supplies critical components, materials, or services to [anchors] — and who supplies THEIR suppliers? Focus on second- and third-tier suppliers, not just the obvious first-tier names.",
  sector_comparable:
    "Beyond [anchors], what other publicly-traded companies compete for the same customer spend or end market? Focus on direct comparables, not loosely-related adjacent businesses.",
  policy_driven:
    "What other publicly-traded companies are exposed to the same regulatory, legislative, or government-spending catalyst driving [anchors] — benefiting or suffering from the same policy change?",
  macro_sensitive:
    "What other publicly-traded companies respond to the same macro variable (rates, a commodity, currency, a cyclical driver) that moves [anchors]?",
};

export function defaultExpansionPrompt(themeType: string | null | undefined): string | null {
  if (!themeType) return null;
  return PROMPT_TEMPLATES[themeType] ?? null;
}

export type ExpansionSuggestion = {
  symbol: string;
  companyName: string;
  rationale: string;
};

// Same parse convention as lib/swing-screener.ts's private tryParseObject
// (strip fences, fall back to the outermost {...} block) — duplicated
// rather than exported/shared since it's ~20 lines and this module has
// no other dependency on swing-screener's internals.
function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* swallow */
    }
  }
  return null;
}

function buildFullPrompt(
  template: string,
  anchors: Array<{ symbol: string; companyName: string | null }>,
  description: string | null,
  existingSymbols: string[],
): string {
  const anchorText =
    anchors.length > 0
      ? anchors.map((a) => `${a.symbol}${a.companyName ? ` (${a.companyName})` : ""}`).join(", ")
      : "the theme's members";
  const filled = template.replace(/\[anchors\]/g, anchorText);
  return `${filled}

Theme description: ${description ?? "(none provided)"}

Do NOT suggest any of these — they are already members of this theme: ${
    existingSymbols.length > 0 ? existingSymbols.join(", ") : "(none yet)"
  }.

Suggest up to ${MAX_SUGGESTIONS} publicly-traded, US-listed common stocks. For each, give the ticker, company name, and a one-sentence rationale tying it to the anchors above.

Return ONLY this JSON, no other text:
{
  "suggestions": [
    { "ticker": "XYZ", "companyName": "Example Corp", "rationale": "one sentence tying it to the anchors" }
  ]
}`;
}

export type SuggestResult =
  | { ok: true; suggestions: ExpansionSuggestion[]; rawCount: number; truncated: boolean }
  | { ok: false; error: string };

// Single bounded Perplexity call — fits comfortably in one route's time
// budget (see askPerplexityRaw's own 45s internal timeout). Does not
// touch the database beyond what the caller does with promptOverride
// (persisting an edited prompt is the caller's job, in the API route,
// so this function stays a pure "call Perplexity, parse, return").
export async function runExpansionSuggest(opts: {
  themeType: string | null;
  promptOverride: string | null;
  anchors: Array<{ symbol: string; companyName: string | null }>;
  description: string | null;
  existingSymbols: string[];
}): Promise<SuggestResult> {
  const template = (opts.promptOverride ?? "").trim() || defaultExpansionPrompt(opts.themeType);
  if (!template) {
    return {
      ok: false,
      error: "This theme type has no expansion prompt — expansion is manual only for 'custom' themes.",
    };
  }
  const prompt = buildFullPrompt(template, opts.anchors, opts.description, opts.existingSymbols);
  const raw = await askPerplexityRaw(prompt, { label: "theme-expand", maxTokens: 4000, timeoutMs: 45_000 });
  if (!raw) {
    return { ok: false, error: "Perplexity request failed or timed out." };
  }
  const parsed = tryParseObject(raw.text);
  const list = parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  const seen = new Set<string>();
  const cleaned: ExpansionSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ticker = typeof o.ticker === "string" ? o.ticker.trim().toUpperCase() : "";
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    cleaned.push({
      symbol: ticker,
      companyName: typeof o.companyName === "string" && o.companyName.trim() ? o.companyName.trim() : ticker,
      rationale: typeof o.rationale === "string" ? o.rationale.trim() : "",
    });
  }
  const rawCount = cleaned.length;
  const truncated = rawCount > MAX_SUGGESTIONS;
  return { ok: true, suggestions: cleaned.slice(0, MAX_SUGGESTIONS), rawCount, truncated };
}

export type FilterVerdict = {
  symbol: string;
  companyName: string;
  rationale: string;
  status: "pending" | "rejected";
  rejectReason: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  avgDollarVolume20d: number | null;
  adr20Pct: number | null;
};

// Runs the hard-filter pipeline over one chunk of suggestions and
// inserts survivors as review_status='pending' theme_members rows.
// Callers must chunk the suggestion list themselves and call this
// sequentially per chunk (never concurrently, and never alongside a
// screen run) — same discipline as backfillDailyBars' own caller
// contract.
export async function filterAndQueueSuggestions(opts: {
  userId: string;
  themeId: string;
  suggestions: ExpansionSuggestion[];
}): Promise<{ verdicts: FilterVerdict[] }> {
  const sb = createServerClient();
  const dedupedBySymbol = new Map<string, ExpansionSuggestion>();
  for (const s of opts.suggestions) {
    if (!dedupedBySymbol.has(s.symbol)) dedupedBySymbol.set(s.symbol, s);
  }
  const symbols = Array.from(dedupedBySymbol.keys());
  const verdicts: FilterVerdict[] = [];
  if (symbols.length === 0) return { verdicts };

  const blank = { price: null, marketCap: null, sector: null, avgDollarVolume20d: null, adr20Pct: null };
  function reject(s: ExpansionSuggestion, reason: string): FilterVerdict {
    return { symbol: s.symbol, companyName: s.companyName, rationale: s.rationale, status: "rejected", rejectReason: reason, ...blank };
  }

  // Cheap DB-only checks first: already a member (any review_status —
  // the unique(theme_id,symbol) constraint would reject the insert
  // anyway) or previously rejected for this theme.
  const [existingRes, rejectedRes] = await Promise.all([
    sb.from("theme_members").select("symbol").eq("theme_id", opts.themeId).eq("user_id", opts.userId).in("symbol", symbols),
    sb.from("theme_rejections").select("symbol").eq("theme_id", opts.themeId).eq("user_id", opts.userId).in("symbol", symbols),
  ]);
  const existingSet = new Set(((existingRes.data ?? []) as Array<{ symbol: string }>).map((r) => r.symbol));
  const rejectedSet = new Set(((rejectedRes.data ?? []) as Array<{ symbol: string }>).map((r) => r.symbol));

  // Symbols that pass every cheap + live-profile check, awaiting the
  // bars-derived liquidity check.
  const profileSurvivors: Array<{ s: ExpansionSuggestion; price: number; marketCap: number; sector: string | null }> = [];

  for (const symbol of symbols) {
    const s = dedupedBySymbol.get(symbol)!;
    if (existingSet.has(symbol)) {
      verdicts.push(reject(s, "already a member of this theme"));
      continue;
    }
    if (rejectedSet.has(symbol)) {
      verdicts.push(reject(s, "previously rejected for this theme"));
      continue;
    }
    const profile = await getSymbolExpansionProfile(symbol);
    if (!profile) {
      verdicts.push(reject(s, "symbol did not resolve via Yahoo"));
      continue;
    }
    if (profile.quoteType && profile.quoteType !== "EQUITY") {
      verdicts.push(reject(s, `not a common stock (quoteType=${profile.quoteType})`));
      continue;
    }
    if (profile.country && profile.country !== "United States") {
      verdicts.push(
        reject(
          s,
          `foreign-primary-listing heuristic: incorporated in ${profile.country} (imprecise signal — recoverable via manual add if this is wrong)`,
        ),
      );
      continue;
    }
    if (profile.price === null || profile.price < MIN_PRICE) {
      verdicts.push(reject(s, `price ${profile.price ?? "unknown"} below $${MIN_PRICE} floor`));
      continue;
    }
    if (profile.marketCap === null || profile.marketCap < MIN_MARKET_CAP) {
      verdicts.push(
        reject(
          s,
          `market cap ${profile.marketCap === null ? "unknown" : `$${(profile.marketCap / 1e6).toFixed(0)}M`} below $${MIN_MARKET_CAP / 1e6}M floor`,
        ),
      );
      continue;
    }
    profileSurvivors.push({ s, price: profile.price, marketCap: profile.marketCap, sector: profile.sector });
  }

  if (profileSurvivors.length > 0) {
    // Reuse the Phase B backfill path — most of these symbols sit
    // outside the index universe and have never been cached.
    await backfillDailyBars(profileSurvivors.map((p) => p.s.symbol));
    const toInsert: Array<{ symbol: string; notes: string | null }> = [];
    for (const { s, price, marketCap, sector } of profileSurvivors) {
      const bars = await getOrFetchDailyBars(s.symbol); // cache hit after the backfill above
      const avgDollarVol = computeAvgDollarVolume(bars, 20);
      const adr = computeADRPercent(bars, 20);
      if (avgDollarVol === null || avgDollarVol < MIN_AVG_DOLLAR_VOLUME_20D) {
        verdicts.push({
          symbol: s.symbol,
          companyName: s.companyName,
          rationale: s.rationale,
          status: "rejected",
          rejectReason: `20d avg $ volume ${avgDollarVol === null ? "unknown (insufficient bar history)" : `$${(avgDollarVol / 1e6).toFixed(1)}M`} below $${MIN_AVG_DOLLAR_VOLUME_20D / 1e6}M floor`,
          price,
          marketCap,
          sector,
          avgDollarVolume20d: avgDollarVol,
          adr20Pct: adr,
        });
        continue;
      }
      // Warm symbol_market_snapshot too, so an accepted member shows a
      // real price/company name immediately instead of blank until some
      // other feature happens to touch the symbol — same reasoning as
      // validateAndWarmSymbol's manual-add path.
      await getOrRefreshSnapshot(s.symbol).catch(() => null);
      verdicts.push({
        symbol: s.symbol,
        companyName: s.companyName,
        rationale: s.rationale,
        status: "pending",
        rejectReason: null,
        price,
        marketCap,
        sector,
        avgDollarVolume20d: avgDollarVol,
        adr20Pct: adr,
      });
      toInsert.push({ symbol: s.symbol, notes: s.rationale.trim() || null });
    }
    if (toInsert.length > 0) {
      const ins = await sb.from("theme_members").insert(
        toInsert.map((t) => ({
          theme_id: opts.themeId,
          user_id: opts.userId,
          symbol: t.symbol,
          is_anchor: false,
          source: "perplexity",
          review_status: "pending",
          notes: t.notes || null,
        })),
      );
      if (ins.error) {
        console.warn(`[theme-expansion] insert pending members failed: ${ins.error.message}`);
      }
    }
  }

  return { verdicts };
}

export type ReviewOutcome = { symbol: string; ok: boolean; error?: string };

// Promotes pending suggestions to full members. Scoped to
// review_status='pending' at the query level — this is the one
// destructive-adjacent path in the feature, and it must never be able to
// touch an already-approved (e.g. manually-added) member even if a
// stray id reaches it from a bulk call.
export async function acceptPendingMembers(
  userId: string,
  themeId: string,
  memberIds: string[],
): Promise<ReviewOutcome[]> {
  const sb = createServerClient();
  const out: ReviewOutcome[] = [];
  for (const id of memberIds) {
    const res = await sb
      .from("theme_members")
      .update({ review_status: "approved" })
      .eq("id", id)
      .eq("theme_id", themeId)
      .eq("user_id", userId)
      .eq("review_status", "pending")
      .select("symbol")
      .maybeSingle();
    if (res.error || !res.data) {
      out.push({ symbol: id, ok: false, error: res.error?.message ?? "not a pending suggestion" });
      continue;
    }
    out.push({ symbol: (res.data as { symbol: string }).symbol, ok: true });
  }
  return out;
}

// Rejects pending suggestions: writes theme_rejections FIRST, then
// deletes the theme_members row — in that order, so a failure partway
// through leaves a re-rejectable pending row rather than a symbol that
// silently resurfaces on the next expansion run (theme_rejections is the
// sole source of truth expansion checks against).
export async function rejectPendingMembers(
  userId: string,
  themeId: string,
  items: Array<{ memberId: string; reason?: string | null }>,
): Promise<ReviewOutcome[]> {
  const sb = createServerClient();
  const out: ReviewOutcome[] = [];
  for (const { memberId, reason } of items) {
    const memberRes = await sb
      .from("theme_members")
      .select("id,symbol")
      .eq("id", memberId)
      .eq("theme_id", themeId)
      .eq("user_id", userId)
      .eq("review_status", "pending")
      .maybeSingle();
    if (memberRes.error || !memberRes.data) {
      out.push({ symbol: memberId, ok: false, error: memberRes.error?.message ?? "not a pending suggestion" });
      continue;
    }
    const symbol = (memberRes.data as { symbol: string }).symbol;
    const rejIns = await sb.from("theme_rejections").insert({
      theme_id: themeId,
      user_id: userId,
      symbol,
      reason: reason && reason.trim() ? reason.trim() : null,
    });
    if (rejIns.error) {
      out.push({ symbol, ok: false, error: rejIns.error.message });
      continue;
    }
    const del = await sb
      .from("theme_members")
      .delete()
      .eq("id", memberId)
      .eq("theme_id", themeId)
      .eq("user_id", userId)
      .eq("review_status", "pending");
    if (del.error) {
      // theme_rejections already has the row — future expansion runs
      // won't re-suggest this symbol even though the stale pending row
      // lingers in theme_members until manually cleaned up.
      out.push({ symbol, ok: false, error: `rejection recorded but member row cleanup failed: ${del.error.message}` });
      continue;
    }
    out.push({ symbol, ok: true });
  }
  return out;
}
