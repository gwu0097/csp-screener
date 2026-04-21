import { getBatchQuotes, isSchwabConnected } from "@/lib/schwab";
import { getCurrentPrice } from "@/lib/yahoo";

// Unified batch price lookup. Prefers Schwab (one HTTP call for N symbols)
// when connected; otherwise falls back to Yahoo (parallel per-symbol).
// Returns { SYMBOL: price } — price is 0 for lookups that failed.
export async function getBatchPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const uniqueSymbols = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase())));

  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));

  if (connected) {
    try {
      const quotes = await getBatchQuotes(uniqueSymbols);
      const map: Record<string, number> = {};
      for (const sym of uniqueSymbols) {
        const entry = quotes[sym];
        const px = entry?.quote?.lastPrice ?? entry?.quote?.mark ?? entry?.quote?.closePrice ?? 0;
        map[sym] = typeof px === "number" && Number.isFinite(px) && px > 0 ? px : 0;
      }
      const hits = Object.values(map).filter((p) => p > 0).length;
      console.log(`[price] source=schwab symbols=${uniqueSymbols.length} hits=${hits}`);
      // If Schwab responded but nothing came back, treat as failure and try Yahoo.
      if (hits > 0) return map;
      console.warn("[price] schwab returned no usable prices, falling back to yahoo");
    } catch (e) {
      console.error("[price] schwab batch failed, falling back to yahoo:", e instanceof Error ? e.message : e);
    }
  }

  const entries = await Promise.all(
    uniqueSymbols.map(async (s) => {
      const p = await getCurrentPrice(s);
      return [s, typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0] as const;
    }),
  );
  const map = Object.fromEntries(entries);
  const hits = Object.values(map).filter((p) => p > 0).length;
  console.log(`[price] source=yahoo symbols=${uniqueSymbols.length} hits=${hits}`);
  return map;
}
