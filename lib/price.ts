import { getBatchQuotes, isSchwabConnected } from "@/lib/schwab";
import { getPriceDebug, getCurrentPrice } from "@/lib/yahoo";
import { getFinnhubQuotePrice } from "@/lib/earnings";

const VERBOSE_SAMPLE_COUNT = 3;
const FINNHUB_DELAY_MS = 100; // stay under Finnhub free-tier 60/min

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Unified batch price lookup. Prefers Schwab (one HTTP call for N symbols)
// when connected; otherwise falls back to Yahoo (parallel per-symbol).
// Any symbol still priced at 0 after the primary source gets one more shot at
// Finnhub's /quote endpoint — a temporary debugging safety net until we
// understand why Yahoo returns $0 on Vercel.
//
// Returns { SYMBOL: price } — price is 0 for lookups that failed everywhere.
export async function getBatchPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const uniqueSymbols = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase())));
  console.log(
    `[price] node=${process.version} vercelRegion=${process.env.VERCEL_REGION ?? "n/a"} ` +
      `symbols=${uniqueSymbols.length}`,
  );

  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));

  const map: Record<string, number> = Object.fromEntries(uniqueSymbols.map((s) => [s, 0]));

  if (connected) {
    try {
      const quotes = await getBatchQuotes(uniqueSymbols);
      for (const sym of uniqueSymbols) {
        const entry = quotes[sym];
        const px = entry?.quote?.lastPrice ?? entry?.quote?.mark ?? entry?.quote?.closePrice ?? 0;
        map[sym] = typeof px === "number" && Number.isFinite(px) && px > 0 ? px : 0;
      }
      const hits = Object.values(map).filter((p) => p > 0).length;
      console.log(`[price] source=schwab symbols=${uniqueSymbols.length} hits=${hits}`);
      if (hits === 0) {
        console.warn("[price] schwab returned no usable prices, falling back to yahoo");
      }
    } catch (e) {
      console.error("[price] schwab batch failed, falling back to yahoo:", e instanceof Error ? e.message : e);
    }
  }

  // Yahoo pass — fills any symbol still at 0.
  const needYahoo = uniqueSymbols.filter((s) => !map[s] || map[s] === 0);
  if (needYahoo.length > 0) {
    await Promise.all(
      needYahoo.map(async (s, idx) => {
        if (idx < VERBOSE_SAMPLE_COUNT) {
          const debug = await getPriceDebug(s);
          const rawKeys = debug.raw ? Object.keys(debug.raw) : null;
          const priceFields = debug.raw
            ? {
                regularMarketPrice: debug.raw.regularMarketPrice,
                postMarketPrice: debug.raw.postMarketPrice,
                preMarketPrice: debug.raw.preMarketPrice,
                regularMarketPreviousClose: debug.raw.regularMarketPreviousClose,
                bid: debug.raw.bid,
                ask: debug.raw.ask,
                marketState: debug.raw.marketState,
                currency: debug.raw.currency,
                quoteType: debug.raw.quoteType,
                symbol: debug.raw.symbol,
                exchange: debug.raw.exchange,
              }
            : null;
          console.log(
            `[price] verbose(${s}): price=${debug.price} fieldUsed=${debug.fieldUsed} ` +
              `rawKeyCount=${rawKeys?.length ?? 0} rawKeys=${rawKeys ? JSON.stringify(rawKeys) : "null"}`,
          );
          console.log(`[price] verbose(${s}) priceFields:`, priceFields);
          map[s] = debug.price && debug.price > 0 ? debug.price : 0;
          return;
        }
        const p = await getCurrentPrice(s);
        map[s] = typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0;
      }),
    );
    const hitsAfterYahoo = Object.values(map).filter((p) => p > 0).length;
    console.log(
      `[price] source=yahoo attempted=${needYahoo.length} hitsAfterYahoo=${hitsAfterYahoo}/${uniqueSymbols.length}`,
    );
  }

  // Finnhub /quote fallback — fills any remaining zeros. Sequential with a
  // 100 ms gap between calls so we stay well under the free-tier 60/min cap.
  const zeros = uniqueSymbols.filter((s) => !map[s] || map[s] === 0);
  if (zeros.length > 0) {
    console.log(
      `[price] finnhub fallback: ${zeros.length} symbols still at 0, sequential with ${FINNHUB_DELAY_MS}ms gap`,
    );
    for (const s of zeros) {
      const fp = await getFinnhubQuotePrice(s);
      if (fp > 0) {
        map[s] = fp;
        console.log(`[price] finnhub rescued ${s}=$${fp.toFixed(2)}`);
      }
      await sleep(FINNHUB_DELAY_MS);
    }
    const finalHits = Object.values(map).filter((p) => p > 0).length;
    console.log(
      `[price] source=finnhub-fallback attempted=${zeros.length} finalHits=${finalHits}/${uniqueSymbols.length}`,
    );
  }

  return map;
}
