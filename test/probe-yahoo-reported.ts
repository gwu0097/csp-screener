import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance();

async function main() {
  for (const sym of ["TSLA", "NOW"]) {
    console.log(`\n=== ${sym} ===`);
    try {
      const res = await yf.quoteSummary(sym, {
        modules: ["earnings", "earningsHistory"],
      });
      const quarterly = (res as unknown as {
        earnings?: { earningsChart?: { quarterly?: unknown[] } };
      }).earnings?.earningsChart?.quarterly;
      console.log(`  earnings.earningsChart.quarterly (${quarterly?.length ?? 0} entries):`);
      for (const q of (quarterly ?? []) as Array<Record<string, unknown>>)
        console.log(`    ${JSON.stringify(q)}`);
      const eh = (res as unknown as { earningsHistory?: { history?: unknown[] } }).earningsHistory?.history;
      console.log(`  earningsHistory.history (${eh?.length ?? 0} entries):`);
      for (const q of (eh ?? []).slice(0, 6) as Array<Record<string, unknown>>)
        console.log(`    ${JSON.stringify(q)}`);
    } catch (e) {
      console.log(`  failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
