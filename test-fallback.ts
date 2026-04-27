// Verify the Finnhub-fallback gap scanner finds the right overnight move
// even when Yahoo's reportedDate would normally supply it. We call the
// Finnhub period helper + scan manually and print each inferred move so we
// can compare to the known-good Yahoo-sourced outcome.
import { getFinnhubEarningsPeriods } from "./lib/earnings";
import { getHistoricalPrices } from "./lib/yahoo";

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  for (const sym of ["NOW", "TSLA"]) {
    console.log(`\n=== ${sym} — Finnhub period fallback trace ===`);
    const periods = await getFinnhubEarningsPeriods(sym);
    if (periods.length === 0) continue;

    const oldestPeriod = periods[periods.length - 1];
    const from = new Date(new Date(oldestPeriod).getTime() - 10 * DAY_MS);
    const to = new Date(Date.now() + 5 * DAY_MS);
    const bars = (await getHistoricalPrices(sym, from, to)).sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );

    for (const qe of periods) {
      const qeMs = new Date(qe + "T00:00:00Z").getTime();
      const winStart = qeMs + 14 * DAY_MS;
      const winEnd = qeMs + 42 * DAY_MS;
      let best: { prev: (typeof bars)[number]; cur: (typeof bars)[number]; pct: number } | null = null;
      for (let i = 1; i < bars.length; i++) {
        const prev = bars[i - 1];
        const cur = bars[i];
        const t = cur.date.getTime();
        if (t < winStart || t > winEnd) continue;
        if (!(prev.close > 0)) continue;
        const pct = (cur.open - prev.close) / prev.close;
        if (!best || Math.abs(pct) > Math.abs(best.pct)) best = { prev, cur, pct };
      }
      if (best) {
        console.log(
          `  qe=${qe}: inferred ${best.prev.date.toISOString().slice(0, 10)}→${best.cur.date.toISOString().slice(0, 10)} (${(best.pct * 100).toFixed(2)}%)`,
        );
      } else {
        console.log(`  qe=${qe}: no gap in window`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
