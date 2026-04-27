import { fetchChainSafe, pickPutContract } from "../lib/snapshots";

async function main() {
  const cases: Array<{ symbol: string; strike: number; storedExpiry: string }> = [
    { symbol: "TSLA", strike: 347.5, storedExpiry: "2026-04-26" }, // Sunday
    { symbol: "AXP", strike: 312.5, storedExpiry: "2026-04-26" },
    { symbol: "AXP", strike: 310, storedExpiry: "2026-04-26" },
    // sanity: a correct Friday expiry should still hit cleanly
    { symbol: "INTC", strike: 68, storedExpiry: "2026-04-24" },
  ];

  for (const c of cases) {
    console.log(`\n=== ${c.symbol} strike=${c.strike} storedExpiry=${c.storedExpiry} ===`);
    const chain = await fetchChainSafe(c.symbol);
    if (!chain) {
      console.log("  chain null");
      continue;
    }
    const hit = pickPutContract(chain, c.strike, c.storedExpiry);
    if (hit) {
      console.log(
        `  HIT strike=${hit.strikePrice} delta=${hit.delta} theta=${hit.theta} volatility=${hit.volatility} mark=${hit.mark}`,
      );
    } else {
      console.log("  NULL");
    }
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
