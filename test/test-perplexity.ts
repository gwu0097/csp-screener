// Smoke test for lib/perplexity.ts.
// Run: env -u GEMINI_API_KEY node --env-file=.env.local --import=tsx test/test-perplexity.ts
import { getEarningsNewsContext } from "../lib/perplexity";

async function main() {
  const key = process.env.PERPLEXITY_API_KEY ?? "";
  console.log(`PERPLEXITY_API_KEY present: ${!!key} (length=${key.length})`);

  const t0 = Date.now();
  const result = await getEarningsNewsContext("TSLA", "Tesla");
  console.log(`Elapsed: ${Date.now() - t0}ms`);
  console.log("\n=== result ===");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
