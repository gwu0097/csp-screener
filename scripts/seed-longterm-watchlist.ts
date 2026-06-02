// One-shot seed for long_term_watchlist. Run AFTER applying
// migrations/2026-06-01-add-longterm-watchlist.sql in Supabase. Pass
// --apply to actually write; default is dry-run that prints the plan.
// Inserts use ON CONFLICT (symbol) DO NOTHING semantics via per-row
// .insert + 23505 ignore, so re-running is safe.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.argv.includes("--apply");

type Allocation = "Large" | "Medium" | "Small";

const SEED: Array<{ symbol: string; allocation: Allocation }> = [
  // Large
  ...["META", "AMD", "GOOG", "MSFT", "AMZN", "NFLX", "CRM", "NOW", "NKE", "SHOP", "HOOD", "RKT", "CAKE"].map(
    (s) => ({ symbol: s, allocation: "Large" as Allocation }),
  ),
  // Medium
  ...["PLTR", "SOFI", "ELF", "PYPL", "INTU", "CELH", "BABA", "DIS", "TGT", "SPGI"].map((s) => ({
    symbol: s,
    allocation: "Medium" as Allocation,
  })),
  // Small
  ...["LYFT", "FUBO", "HNST", "FIGR", "LDI"].map((s) => ({
    symbol: s,
    allocation: "Small" as Allocation,
  })),
];

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  console.log(`Plan: insert ${SEED.length} symbols`);
  const byBucket: Record<Allocation, string[]> = { Large: [], Medium: [], Small: [] };
  for (const s of SEED) byBucket[s.allocation].push(s.symbol);
  for (const a of ["Large", "Medium", "Small"] as Allocation[]) {
    console.log(`  ${a.padEnd(7)} (${byBucket[a].length}): ${byBucket[a].join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nRe-run with `--apply` to write to long_term_watchlist.");
    return;
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of SEED) {
    const res = await sb
      .from("long_term_watchlist")
      .insert({ symbol: row.symbol, allocation: row.allocation });
    if (res.error) {
      if (res.error.code === "23505") {
        console.log(`  ${row.symbol.padEnd(6)} skipped (already present)`);
        skipped += 1;
        continue;
      }
      console.error(`  ${row.symbol.padEnd(6)} FAILED: ${res.error.message}`);
      failed += 1;
      continue;
    }
    console.log(`  ${row.symbol.padEnd(6)} inserted (${row.allocation})`);
    inserted += 1;
  }
  console.log(
    `\nDone. inserted=${inserted}  skipped=${skipped}  failed=${failed}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
