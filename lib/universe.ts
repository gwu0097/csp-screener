// Universe & Themes, Phase A — shared enrichment for theme members.
// Read-only (cache-only) by design: displaying a theme's member table
// must not trigger a live fetch just because someone opened the page.
// Live validation/warming happens once, at add-time (see
// app/api/swings/universe/themes/[id]/members/route.ts).
import { createServerClient } from "./supabase";
import { getOrFetchDailyBars } from "./daily-bars-cache";
import { computeADRPercent } from "./indicators";
import { getOrRefreshSnapshot } from "./market-snapshot";

export type MemberEnrichment = {
  companyName: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  adr20Pct: number | null;
};

const EMPTY_ENRICHMENT: MemberEnrichment = {
  companyName: null,
  price: null,
  marketCap: null,
  sector: null,
  adr20Pct: null,
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

// ADR% has no bulk "latest per symbol" query available through this
// wrapper (see lib/swing-screener.ts's own bulk pre-filter for the same
// constraint) — sorted desc by trading_day, first occurrence per symbol
// wins.
async function bulkAdrPercent(symbols: string[]): Promise<Map<string, number>> {
  const sb = createServerClient();
  const out = new Map<string, number>();
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
      for (const row of res.data as Array<{ symbol: string; bars: Array<{ high: number; low: number; close: number }> }>) {
        if (seen.has(row.symbol)) continue;
        seen.add(row.symbol);
        const adr = computeADRPercent(row.bars, 20);
        if (adr !== null) out.set(row.symbol, adr);
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
  const [snapshots, sectors, adrs] = await Promise.all([
    bulkSnapshotFields(uniq),
    bulkCachedSectors(uniq),
    bulkAdrPercent(uniq),
  ]);
  for (const symbol of uniq) {
    const snap = snapshots.get(symbol);
    out.set(symbol, {
      companyName: snap?.companyName ?? EMPTY_ENRICHMENT.companyName,
      price: snap?.price ?? EMPTY_ENRICHMENT.price,
      marketCap: snap?.marketCap ?? EMPTY_ENRICHMENT.marketCap,
      sector: sectors.get(symbol) ?? EMPTY_ENRICHMENT.sector,
      adr20Pct: adrs.get(symbol) ?? EMPTY_ENRICHMENT.adr20Pct,
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
