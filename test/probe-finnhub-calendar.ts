// Probe Finnhub /calendar/earnings behavior:
// (a) with symbol filter + historical window
// (b) without symbol filter + narrow window, then filter client-side
import { finnhubGet } from "../lib/earnings";

async function main() {
  console.log("=== (a) with symbol=TSLA, wide range ===");
  const a = await finnhubGet<{
    earningsCalendar?: Array<{ symbol: string; date: string; year?: number; quarter?: number; hour?: string }>;
  }>("/calendar/earnings", { symbol: "TSLA", from: "2024-01-01", to: "2026-04-24" });
  console.log(`  rows: ${a.earningsCalendar?.length ?? 0}`);
  for (const r of a.earningsCalendar ?? [])
    console.log(`    ${r.date}  Q${r.quarter}/${r.year}  hour=${r.hour}`);

  console.log("\n=== (b) no symbol, Q3 2025 window (2025-09-01..2025-11-30) ===");
  const b = await finnhubGet<{
    earningsCalendar?: Array<{ symbol: string; date: string; year?: number; quarter?: number; hour?: string }>;
  }>("/calendar/earnings", { from: "2025-09-01", to: "2025-11-30" });
  const all = b.earningsCalendar ?? [];
  console.log(`  total rows in window: ${all.length}`);
  for (const target of ["TSLA", "NOW", "AAPL"]) {
    const hits = all.filter((r) => r.symbol === target);
    console.log(`  ${target}: ${hits.length} hits`);
    for (const r of hits)
      console.log(`    ${r.date}  Q${r.quarter}/${r.year}  hour=${r.hour}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
