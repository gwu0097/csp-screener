// Universe & Themes, Phase A — shared enrichment for theme members.
// Read-only (cache-only) by design: displaying a theme's member table
// must not trigger a live fetch just because someone opened the page.
// Live validation/warming happens once, at add-time (see
// app/api/swings/universe/themes/[id]/members/route.ts).
import { createServerClient } from "./supabase";
import { getOrFetchDailyBars } from "./daily-bars-cache";
import { computeADRPercent, computeAvgDollarVolume } from "./indicators";
import { getOrRefreshSnapshot } from "./market-snapshot";
import { SWING_UNIVERSE } from "./stock-universe";

export type MemberEnrichment = {
  companyName: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  adr20Pct: number | null;
  // Phase C — same $10M/20-session floor the expansion hard filter
  // checks at suggestion time (see lib/theme-expansion.ts). Computed
  // here too so a pending suggestion still shows it on page reload,
  // after the one-time filter-run response is gone.
  avgDollarVolume20d: number | null;
};

const EMPTY_ENRICHMENT: MemberEnrichment = {
  companyName: null,
  price: null,
  marketCap: null,
  sector: null,
  adr20Pct: null,
  avgDollarVolume20d: null,
};

// Chunked to stay well under the PostgREST wrapper's read cap and keep
// URL length sane — same convention as the RS Pullback bulk pre-filter.
const CHUNK = 100;

async function bulkSnapshotFields(
  symbols: string[],
): Promise<Map<string, { companyName: string | null; price: number | null; marketCap: number | null }>> {
  const sb = createServerClient();
  const out = new Map<string, { companyName: string | null; price: number | null; marketCap: number | null }>();
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    try {
      const res = await sb
        .from("symbol_market_snapshot")
        .select("symbol,company_name,price,market_cap")
        .in("symbol", chunk);
      if (res.error || !res.data) continue;
      for (const row of res.data as Array<{
        symbol: string;
        company_name: string | null;
        price: number | null;
        market_cap: number | null;
      }>) {
        out.set(row.symbol, { companyName: row.company_name, price: row.price, marketCap: row.market_cap });
      }
    } catch {
      // best-effort — missing symbols just show blank enrichment
    }
  }
  return out;
}

async function bulkCachedSectors(symbols: string[]): Promise<Map<string, string>> {
  const sb = createServerClient();
  const out = new Map<string, string>();
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    try {
      const res = await sb.from("stock_profiles").select("symbol,sector").in("symbol", chunk);
      if (res.error || !res.data) continue;
      for (const row of res.data as Array<{ symbol: string; sector: string | null }>) {
        if (row.sector) out.set(row.symbol, row.sector);
      }
    } catch {
      // best-effort
    }
  }
  return out;
}

// ADR% and 20d avg dollar volume both derive from the same cached bars,
// so one bulk read serves both — no bulk "latest per symbol" query is
// available through this wrapper (see lib/swing-screener.ts's own bulk
// pre-filter for the same constraint), so this is sorted desc by
// trading_day with first-occurrence-per-symbol winning.
async function bulkBarsDerived(
  symbols: string[],
): Promise<Map<string, { adr20Pct: number | null; avgDollarVolume20d: number | null }>> {
  const sb = createServerClient();
  const out = new Map<string, { adr20Pct: number | null; avgDollarVolume20d: number | null }>();
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    try {
      const res = await sb
        .from("daily_bars_cache")
        .select("symbol,bars")
        .in("symbol", chunk)
        .order("trading_day", { ascending: false })
        .limit(chunk.length * 5);
      if (res.error || !res.data) continue;
      const seen = new Set<string>();
      for (const row of res.data as Array<{
        symbol: string;
        bars: Array<{ high: number; low: number; close: number; volume: number }>;
      }>) {
        if (seen.has(row.symbol)) continue;
        seen.add(row.symbol);
        out.set(row.symbol, {
          adr20Pct: computeADRPercent(row.bars, 20),
          avgDollarVolume20d: computeAvgDollarVolume(row.bars, 20),
        });
      }
    } catch {
      // best-effort
    }
  }
  return out;
}

export async function enrichSymbols(symbols: string[]): Promise<Map<string, MemberEnrichment>> {
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const out = new Map<string, MemberEnrichment>();
  if (uniq.length === 0) return out;
  const [snapshots, sectors, barsDerived] = await Promise.all([
    bulkSnapshotFields(uniq),
    bulkCachedSectors(uniq),
    bulkBarsDerived(uniq),
  ]);
  for (const symbol of uniq) {
    const snap = snapshots.get(symbol);
    const derived = barsDerived.get(symbol);
    out.set(symbol, {
      companyName: snap?.companyName ?? EMPTY_ENRICHMENT.companyName,
      price: snap?.price ?? EMPTY_ENRICHMENT.price,
      marketCap: snap?.marketCap ?? EMPTY_ENRICHMENT.marketCap,
      sector: sectors.get(symbol) ?? EMPTY_ENRICHMENT.sector,
      adr20Pct: derived?.adr20Pct ?? EMPTY_ENRICHMENT.adr20Pct,
      avgDollarVolume20d: derived?.avgDollarVolume20d ?? EMPTY_ENRICHMENT.avgDollarVolume20d,
    });
  }
  return out;
}

// Live check that a ticker actually resolves, used ONLY at add-time (not
// for display enrichment, which stays cache-only). getOrRefreshSnapshot
// returns null when Yahoo has no data AND there's no stale cache to fall
// back to — the same signal lib/market-snapshot.ts's own refresh path
// uses to mean "this isn't a real symbol." Also warms daily_bars_cache
// so ADR% is populated on the very next page load instead of staying
// blank until some other feature happens to touch the same symbol.
export async function validateAndWarmSymbol(symbol: string): Promise<boolean> {
  const snap = await getOrRefreshSnapshot(symbol).catch(() => null);
  if (!snap || snap.price === null) return false;
  await getOrFetchDailyBars(symbol).catch(() => []);
  return true;
}

// ---------- Universe & Themes, Phase B — screener universe resolution ----------
//
// Turns a selector's choice (the index universe, specific themes, "all
// themes", or any combination) into the deduplicated symbol list the
// screener actually runs against. Read-only against themes/theme_members —
// this never mutates state, so it's safe to call on every selector change
// for the live resolved-count preview as well as at the start of a real
// run.

export type UniverseSelection = {
  includeIndex: boolean;
  themeIds: string[];
  allThemes: boolean;
};

export type ResolvedUniverse = {
  symbols: string[];
  themeNames: string[];
};

type ThemeRow = { id: string; name: string };
type MemberSymbolRow = { symbol: string };

export async function resolveUniverseSymbols(
  userId: string,
  selection: UniverseSelection,
): Promise<ResolvedUniverse> {
  const sb = createServerClient();
  const symbolSet = new Set<string>();
  if (selection.includeIndex) {
    for (const s of SWING_UNIVERSE) symbolSet.add(s.toUpperCase());
  }

  // Only active themes ever contribute — an archived theme's members
  // don't silently keep feeding the screener after the theme itself was
  // archived.
  let themeIds: string[] = [];
  let themeNames: string[] = [];
  if (selection.allThemes) {
    const res = await sb
      .from("themes")
      .select("id,name")
      .eq("user_id", userId)
      .eq("is_active", true);
    const rows = (res.data ?? []) as ThemeRow[];
    themeIds = rows.map((r) => r.id);
    themeNames = rows.map((r) => r.name);
  } else if (selection.themeIds.length > 0) {
    const res = await sb
      .from("themes")
      .select("id,name")
      .eq("user_id", userId)
      .eq("is_active", true)
      .in("id", selection.themeIds);
    const rows = (res.data ?? []) as ThemeRow[];
    themeIds = rows.map((r) => r.id);
    themeNames = rows.map((r) => r.name);
  }

  if (themeIds.length > 0) {
    // Only is_active AND review_status='approved' members participate —
    // is_active gates a deactivated member (Phase A); review_status
    // gates a Perplexity suggestion still awaiting human review (Phase
    // C, see migrations/2026-08-15-add-theme-expansion.sql). A pending
    // suggestion must never reach the screener.
    const res = await sb
      .from("theme_members")
      .select("symbol")
      .eq("user_id", userId)
      .eq("is_active", true)
      .eq("review_status", "approved")
      .in("theme_id", themeIds);
    const rows = (res.data ?? []) as MemberSymbolRow[];
    for (const r of rows) symbolSet.add(r.symbol.toUpperCase());
  }

  return {
    symbols: Array.from(symbolSet).sort(),
    themeNames: themeNames.sort((a, b) => a.localeCompare(b)),
  };
}
