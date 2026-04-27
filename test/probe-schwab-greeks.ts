import { getOptionsChain } from "../lib/schwab";

async function main() {
  const chain = await getOptionsChain("INTC");
  const spot =
    chain.underlying?.mark ??
    chain.underlying?.last ??
    chain.underlyingPrice ??
    null;
  const expKeys = Object.keys(chain.putExpDateMap ?? {});
  console.log(`INTC spot=${spot} expiries=${expKeys.length}`);
  if (expKeys.length === 0) return;
  const firstExp = expKeys[0];
  const strikes = chain.putExpDateMap[firstExp];
  const rawKeys = Object.keys(strikes);
  console.log(`\nexpiry=${firstExp} strikeKeys(raw)=${rawKeys.slice(0, 10).join(",")}...`);
  console.log();

  // Show a handful of contracts across the chain (ATM, a couple OTM).
  const numericKeys = rawKeys
    .map((k) => ({ k, n: Number(k) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);

  const atmIdx =
    numericKeys.reduce(
      (bestIdx, x, i) =>
        Math.abs(x.n - (spot ?? 0)) < Math.abs(numericKeys[bestIdx].n - (spot ?? 0))
          ? i
          : bestIdx,
      0,
    );
  const pick = [
    Math.max(0, atmIdx - 2),
    Math.max(0, atmIdx - 1),
    atmIdx,
    Math.min(numericKeys.length - 1, atmIdx + 1),
    Math.min(numericKeys.length - 1, atmIdx + 2),
  ];

  console.log(
    "label    strike  mark    bid     ask     delta    gamma    theta    vega     volatility dte",
  );
  for (const i of pick) {
    const { k, n } = numericKeys[i];
    const arr = strikes[k];
    const c = arr?.[0];
    if (!c) continue;
    const label = i === atmIdx ? "ATM " : i < atmIdx ? "OTM " : "ITM ";
    console.log(
      `${label}  ${String(n).padEnd(7)} ${c.mark.toFixed(2).padEnd(7)} ${c.bid.toFixed(2).padEnd(7)} ${c.ask.toFixed(2).padEnd(7)} ${c.delta.toFixed(4).padEnd(8)} ${c.gamma.toFixed(4).padEnd(8)} ${c.theta.toFixed(4).padEnd(8)} ${c.vega.toFixed(4).padEnd(8)} ${c.volatility.toFixed(4).padEnd(9)}  ${c.daysToExpiration}`,
    );
  }

  // Also dump the raw contract JSON for one ATM contract so we see every
  // field Schwab actually returns.
  const atm = strikes[numericKeys[atmIdx].k][0];
  console.log("\n--- raw ATM contract ---");
  console.log(JSON.stringify(atm, null, 2));
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
