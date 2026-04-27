// Ad-hoc Finnhub earnings-history probe.
// Run: node --env-file=.env.local --import=tsx test-moves.ts
import { getFinnhubPastEarningsDates } from "./lib/earnings";
import { getHistoricalEarningsMovements } from "./lib/yahoo";

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? "";

async function stockEarnings(symbol: string) {
  const url = `${FINNHUB_BASE}/stock/earnings?symbol=${symbol}&token=${FINNHUB_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  return body as Array<{ period: string; actual: number | null; estimate: number | null; symbol?: string; quarter?: number }>;
}

async function main() {
  if (!FINNHUB_KEY) {
    console.error("FINNHUB_API_KEY not set");
    process.exit(1);
  }

  for (const sym of ["NOW", "TSLA"]) {
    console.log(`\n=== ${sym} via /calendar/earnings (current impl) ===`);
    const dates = await getFinnhubPastEarningsDates(sym);
    console.log(`${sym} count:`, dates.length);
    console.log(`${sym} dates:`, dates);

    console.log(`\n=== ${sym} via /stock/earnings (candidate) ===`);
    const rows = await stockEarnings(sym);
    console.log(`${sym} count:`, rows.length);
    console.log(`${sym} rows:`, rows);

    console.log(`\n=== ${sym} via getHistoricalEarningsMovements (pipeline actual) ===`);
    const moves = await getHistoricalEarningsMovements(sym);
    console.log(`${sym} moves count:`, moves.length);
    console.log(`${sym} moves:`, moves);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
