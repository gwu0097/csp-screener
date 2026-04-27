import { finnhubGet } from "../lib/earnings";

async function main() {
  // Probe insider-transactions full record + check for an alternate endpoint
  // that exposes role/title (the free /stock/insider-transactions doesn't).
  console.log("=== /stock/insider-transactions (BBY) raw ===");
  const tx = await finnhubGet<{ data?: unknown[] }>(
    "/stock/insider-transactions",
    { symbol: "BBY", from: "2026-03-01", to: "2026-04-26" },
  );
  const arr = (tx.data ?? []) as Array<Record<string, unknown>>;
  console.log("first row full keys + values:");
  if (arr[0]) console.log(JSON.stringify(arr[0], null, 2));

  // Try insider-sentiment as a side-channel — sometimes carries officer roles.
  console.log("\n=== /stock/insider-sentiment (BBY) ===");
  try {
    const s = await finnhubGet<unknown>("/stock/insider-sentiment", {
      symbol: "BBY",
      from: "2025-12-01",
      to: "2026-04-26",
    });
    console.log(JSON.stringify(s, null, 2));
  } catch (e) {
    console.log("error:", e instanceof Error ? e.message : e);
  }

  // Confirm `change` vs `share` semantics with mixed-direction transactions.
  console.log("\n=== change vs share for ACN ===");
  const acn = await finnhubGet<{ data?: Array<Record<string, unknown>> }>(
    "/stock/insider-transactions",
    { symbol: "ACN", from: "2026-03-01", to: "2026-04-26" },
  );
  for (const r of (acn.data ?? []).slice(0, 5)) {
    console.log(
      `  ${r.name} code=${r.transactionCode} change=${r.change} share=${r.share} price=${r.transactionPrice}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
