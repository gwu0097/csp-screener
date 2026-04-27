import { getOptionsChain } from "../lib/schwab";
import { pickPutContract } from "../lib/snapshots";

async function main() {
  // First: fetch chain with NO expiry filter and list everything available
  // for TSLA. This tells us whether 2026-04-26 actually exists or whether
  // our stored position.expiry is off by a day or two.
  console.log("=== TSLA full chain (no expiry filter) ===");
  const fullChain = await getOptionsChain("TSLA");
  const allKeys = Object.keys(fullChain.putExpDateMap ?? {});
  console.log(`put expiry keys (${allKeys.length}):`);
  for (const k of allKeys.slice(0, 20)) console.log(`  "${k}"`);

  console.log("\n=== AXP full chain ===");
  const axpChain = await getOptionsChain("AXP");
  const axpKeys = Object.keys(axpChain.putExpDateMap ?? {});
  console.log(`put expiry keys (${axpKeys.length}):`);
  for (const k of axpKeys.slice(0, 20)) console.log(`  "${k}"`);

  // Now attempt a filtered fetch for the Friday 2026-04-24 (likely the real expiry)
  console.log("\n=== TSLA filtered by 2026-04-24 (Friday) ===");
  const fri = await getOptionsChain("TSLA", "2026-04-24");
  const friKeys = Object.keys(fri.putExpDateMap ?? {});
  console.log(`put expiry keys (${friKeys.length}):`);
  for (const k of friKeys) console.log(`  "${k}"`);

  if (friKeys.length > 0) {
    const firstKey = friKeys[0];
    const strikes = fri.putExpDateMap[firstKey];
    const strikeKeys = Object.keys(strikes);
    const numeric = strikeKeys
      .map((k) => ({ k, n: Number(k) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n);
    console.log(`\nTSLA strikes near 347.5 (raw keys):`);
    for (const { k, n } of numeric.filter((x) => Math.abs(x.n - 347.5) <= 3)) {
      console.log(`  raw="${k}"  number=${n}`);
    }
    const tryA = String(Number(347.5));
    const tryB = (347.5).toFixed(2);
    console.log(`\nlookup attempts:`);
    console.log(`  strikes["${tryA}"] → ${strikes[tryA] ? "HIT" : "miss"}`);
    console.log(`  strikes["${tryB}"] → ${strikes[tryB] ? "HIT" : "miss"}`);
    const hit = pickPutContract(fri, 347.5, "2026-04-24");
    console.log(
      `pickPutContract(chain, 347.5, "2026-04-24") → ${
        hit ? `strike=${hit.strikePrice} delta=${hit.delta} iv=${hit.volatility}` : "NULL"
      }`,
    );
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
